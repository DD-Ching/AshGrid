// ============ ARENA RECRUIT — ONLINE MP (Phase 159) ============
// The arena's core loop is kill → wound → walk up → G → the enemy JOINS
// your squad (see project_arena_recruitment memory). It was fully wired in
// SOLO (js/arena_recruitment.js, scans enemies[]) but completely DEAD online:
// server bots live in _mpState.remoteBots and human opponents in
// remotePlayers — NEITHER is in enemies[] — so the SOLO G-key handler found
// zero targets in MP and the whole progression loop was unreachable on the
// .io product.
//
// This file is the MP half: it finds the nearest recruitable enemy bot in
// remoteBots, mirrors the SOLO live-target gates locally for instant feel,
// and sends a 'recruit' message. The server (server/party/server.js) is
// authoritative — it re-checks every gate, flips bot.team → 0 (which rides
// the existing snapshot delta), and broadcasts 'recruitOk' so every client
// fires the SED-convert VFX. We do NOT optimistically flip team here; the
// recruitOk handler in multiplayer.js does that, keeping the server the one
// source of truth (a rejected recruit just looks like "nothing happened",
// same silent-fail as SOLO).
//
// Classic-script. Declares one global:
//   _arenaTryRecruitMP() → bool   (true = recruit requested, skip grenade)
//
// Reuses SOLO constants from arena_recruitment.js: ARENA_TOUCH_BUFFER,
// ARENA_SEED_GAP, ARENA_HP_GATE. Depends on _mpState + _mpSendRaw from
// multiplayer.js (resolved at call time, so load order is not critical).

function _arenaTryRecruitMP() {
  // Online only — in SOLO _mpState.enabled is false and we fall through to
  // the SOLO _arenaTrySEDConvert path in the G dispatcher.
  if (typeof _mpState === 'undefined' || !_mpState.enabled) return false;
  if (typeof player === 'undefined' || !player || !player.alive) return false;
  if (!_mpState.remoteBots || _mpState.remoteBots.size === 0) return false;

  // Phase 184g — chassis-as-classes recruit, MP mirror of SOLO
  // arena_recruitment._arenaTrySEDConvert (flag-gated game._classes, off by
  // default). Two regimes, picked the SAME way on both sides; the server
  // re-validates via _recruitGateOk using the cls+klass we send.
  //   classes-on: HUMANOID (builder) ONLY; eligibility = bot weaker than me
  //               (rb.hp < player.hp); SEED gate dropped. Wolf/heavy don't
  //               recruit (wolf devours — that MP path is a later phase).
  //   classes-off: legacy SEED + wound<50% (byte-identical to pre-184g).
  const classesBuilder = (typeof game !== 'undefined' && game._classes)
    && (!player._chassis || player._chassis === 'humanoid');
  if ((typeof game !== 'undefined' && game._classes) && !classesBuilder) return false;  // non-builder doesn't recruit under classes

  // Phase 184h — recruit ENERGY cost, MP mirror of SOLO _arenaTrySEDConvert
  // (招降 '损耗能量, 慢慢恢复'). classes-on only; energy is the per-client
  // game._energy pool (the same one that gates building in MP, so it accrues
  // here too). Gate up-front like SOLO; spend optimistically on send below (a
  // server reject is rare since we mirror its gates). Legacy recruit stays free
  // (no cost in the pre-184h online path → unchanged).
  const _recruitCost = (classesBuilder && typeof BALANCE === 'object' && BALANCE.ability)
    ? (BALANCE.ability.recruit || 0) : 0;
  if (_recruitCost > 0 && typeof canAffordEnergy === 'function' && !canAffordEnergy(_recruitCost)) return false;

  // SEED gate (skill differential) — legacy only. Bots are seed 0, so we just
  // need our own seed above the gap. Bail early; this is also why the HUD
  // 'G RECRUIT' prompt only lights up once player._seed > ARENA_SEED_GAP.
  const mySeed = player._seed || 0;
  if (!classesBuilder && mySeed <= ARENA_SEED_GAP) return false;

  // Squad cap — parity with the SOLO ARENA_SQUAD_CAP (=5) ceiling
  // (arena_recruitment.js:172). Without it, MP recruiting is unbounded and one
  // player can permanently flip the whole shared server bot pool, draining the
  // endless arena for everyone. The server re-enforces this authoritatively
  // (per-recruiter count); this is the instant-feel client gate. In the common
  // solo-vs-bots room all team-0 bots are ours; a busy PvP room is bounded by
  // the server cap regardless.
  if (_mpAliveSquadCount() >= ARENA_SQUAD_CAP) return false;

  const myR = player.radius || 13;
  let best = null, bestD = Infinity;
  for (const rb of _mpState.remoteBots.values()) {
    if (!rb.alive) continue;
    if (rb.team === 0) continue;                  // already ours — skip
    const targetR = rb.radius || 14;
    const reach = myR + targetR + ARENA_TOUCH_BUFFER;   // ~106px, same as SOLO
    const dx = rb.x - player.x, dy = rb.y - player.y;
    const d = Math.hypot(dx, dy);
    if (d > reach) continue;
    // HP gate — classes: bot weaker than me; legacy: wounded below half (maxHp 100).
    if (typeof rb.hp === 'number') {
      if (classesBuilder) { if (rb.hp >= (player.hp || 1)) continue; }
      else if (rb.hp >= 100 * ARENA_HP_GATE) continue;
    }
    if (d < bestD) { bestD = d; best = rb; }
  }
  if (!best) return false;

  // Fire the request. Server validates + broadcasts recruitOk (handled in
  // multiplayer.js). Optimistically consume the G press so it doesn't also
  // throw a grenade, matching the SOLO "G recruited → no frag" behaviour.
  // Send the RAW float seed (not Math.floor): the client gate above compares
  // the raw value to ARENA_SEED_GAP, and so does the server. Flooring made a
  // seed of 10.7 pass the client gate (10.7 > 10) but become 10 on the wire,
  // which the server rejected (10 <= 10) — a ~1s dead zone right at the gate
  // boundary where the lit 'G RECRUIT' prompt silently did nothing.
  // cls+klass tell the server which gate to re-validate. Only sent meaningfully
  // under classes; legacy recruits omit them (server takes the legacy branch).
  // 184k — the energy is SPENT on the server's recruitOk confirmation (in
  // multiplayer.js), NOT here: an optimistic spend lost 40 energy on a server
  // reject (HP-boundary / reach-lag race). The canAffordEnergy gate above still
  // blocks requesting while broke; spend-on-success matches SOLO _arenaTrySEDConvert.
  _mpSendRaw(classesBuilder
    ? { type: 'recruit', botId: best.id, seed: mySeed, cls: 1, klass: 'builder' }
    : { type: 'recruit', botId: best.id, seed: mySeed });
  return true;
}

// Phase 184i — wolf DEVOUR (處決吸血), MP mirror of SOLO _arenaTryDevour. The
// Charger's G executes a weaker enemy BOT (remoteBots, not enemies[]): sends an
// executeRequest; the server validates + vanishes the bot + grants the HP
// lifesteal (authoritative), then broadcasts executeOk where every client fires
// the VFX and the devourer gains the energy steal. Flag-gated (wolf +
// game._classes) so it no-ops for other chassis / classes-off / SOLO.
//   _arenaTryDevourMP() → bool (true = request sent, consume G; skip recruit/grenade)
function _arenaTryDevourMP() {
  if (typeof _mpState === 'undefined' || !_mpState.enabled) return false;
  if (typeof player === 'undefined' || !player || !player.alive) return false;
  if (!(typeof game !== 'undefined' && game._classes)) return false;
  if (player._chassis !== 'wolf') return false;
  if (!_mpState.remoteBots || _mpState.remoteBots.size === 0) return false;

  const myR = player.radius || 13;
  const myHp = player.hp || 1;
  let best = null, bestD = Infinity;
  for (const rb of _mpState.remoteBots.values()) {
    if (!rb.alive) continue;
    if (rb.team === 0) continue;                  // friendly — can't devour your own
    const reach = myR + (rb.radius || 14) + ARENA_TOUCH_BUFFER;   // ~106px, same as SOLO
    const dx = rb.x - player.x, dy = rb.y - player.y;
    const d = Math.hypot(dx, dy);
    if (d > reach) continue;
    if (typeof rb.hp === 'number' && rb.hp >= myHp) continue;     // must be WEAKER than me
    if (d < bestD) { bestD = d; best = rb; }
  }
  if (!best) return false;
  // Server validates + applies the HP lifesteal + broadcasts executeOk (handled
  // in multiplayer.js — VFX for all, energy steal for the devourer). No
  // optimistic team/hp flip here; the server is the one source of truth.
  _mpSendRaw({ type: 'executeRequest', botId: best.id });
  return true;
}

// Phase 188 — MP HEAVY SEIZE (处决抢夺), the heavy's G online — mirror of the wolf
// devour but kind:'seize' (server executes the bot WITHOUT the hp lifesteal; the
// seizer's consumable loot is granted client-side on executeOk). Same weaker +
// reach gate. Self-gates to heavy + classes + online.
function _arenaTryHeavySeizeMP() {
  if (typeof _mpState === 'undefined' || !_mpState.enabled) return false;
  if (typeof player === 'undefined' || !player || !player.alive) return false;
  if (!(typeof game !== 'undefined' && game._classes)) return false;
  if (player._chassis !== 'heavy') return false;
  if (!_mpState.remoteBots || _mpState.remoteBots.size === 0) return false;
  const myR = player.radius || 13;
  const myHp = player.hp || 1;
  let best = null, bestD = Infinity;
  for (const rb of _mpState.remoteBots.values()) {
    if (!rb.alive || rb.team === 0) continue;
    const reach = myR + (rb.radius || 14) + ARENA_TOUCH_BUFFER;
    const d = Math.hypot(rb.x - player.x, rb.y - player.y);
    if (d > reach) continue;
    if (typeof rb.hp === 'number' && rb.hp >= myHp) continue;
    if (d < bestD) { bestD = d; best = rb; }
  }
  if (!best) return false;
  _mpSendRaw({ type: 'executeRequest', botId: best.id, kind: 'seize' });
  return true;
}
