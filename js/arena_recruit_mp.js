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

  // SEED gate (skill differential) — bots are seed 0, so we just need our
  // own seed above the gap. Bail early; this is also why the HUD 'G RECRUIT'
  // prompt only lights up once player._seed > ARENA_SEED_GAP.
  const mySeed = player._seed || 0;
  if (mySeed - 0 <= ARENA_SEED_GAP) return false;

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
    // HP gate — must wound the bot below half first (bot maxHp = 100).
    if (typeof rb.hp === 'number' && rb.hp >= 100 * ARENA_HP_GATE) continue;
    if (d < bestD) { bestD = d; best = rb; }
  }
  if (!best) return false;

  // Fire the request. Server validates + broadcasts recruitOk (handled in
  // multiplayer.js). Optimistically consume the G press so it doesn't also
  // throw a grenade, matching the SOLO "G recruited → no frag" behaviour.
  _mpSendRaw({ type: 'recruit', botId: best.id, seed: Math.floor(mySeed) });
  return true;
}
