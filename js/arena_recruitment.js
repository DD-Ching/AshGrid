// ============ ARENA RECRUITMENT ============
// "Kill an enemy → chance they become your ally" is the arena-mp progression
// hook. Two paths:
//   • Passive (auto): each natural enemy kill rolls ARENA_RECRUIT_CHANCE.
//     If hit, the corpse is "revived" as a blue ally with same chassis +
//     weapon + NN brain (so they fight on your side at the level they
//     fought against you).
//   • Active (G key): _arenaTrySEDConvert() finds the nearest live enemy
//     within ARENA_SED_RANGE and converts deterministically. Costs a
//     grenade slot (caller falls back to throwGrenade if no target).
//
// Squad cap keeps the screen readable + preserves death stakes (lose your
// army when you die). User intent: '我想要有些 npc 被幹掉會變自己人'.
//
// Classic-script. Declares globally:
//   ARENA_RECRUIT_CHANCE · ARENA_SED_RANGE · ARENA_SQUAD_CAP (constants)
//   _arenaAliveSquadCount() · _arenaConvertEnemyToAlly(e)
//   _arenaTrySEDConvert() · _arenaTickRecruitment()
//
// External deps (resolved at call-time):
//   player · allies · enemies · game.time
//   showSwapToast() · playRadioStatic() · T()

// Phase 9 (user feedback '不會自動招降, 招降一定要靠手動的'):
// passive natural-kill recruit is OFF. The G-key path (gated by HP / range
// / SEED / human-piloted — see _arenaTrySEDConvert below) is now the
// ONLY way to recruit. Keep the constant at 0 (don't delete) so the
// passive-tick function still exists and tracks deaths for cleanup, just
// never converts.
const ARENA_RECRUIT_CHANCE = 0;        // was 0.25 — passive recruit disabled
const ARENA_SED_RANGE      = 220;      // px — kept for back-compat; the
                                       // active gate is ARENA_TOUCH_RANGE
const ARENA_SQUAD_CAP      = 5;        // hard cap on bots you own at once

// ---- Phase 4: SEED mechanic ----
// SEED is a per-unit experience number 0–100. Rises +1/sec while the unit
// is HUMAN-piloted and alive; AI bots stay at 0 forever (they never tick).
// SEED follows the BODY through pawn-swap: when you swap out, the ex-op
// slot keeps the SEED you built up (in case you swap back). When you swap
// IN, you inherit the target ally's SEED (usually 0 since it was AI).
//
// Active recruit (G key) requires FOUR gates — all must pass:
//   1. Distance ≤ (myR + targetR + buffer) ≈ touching (was 220 px)
//   2. Target HP < maxHp * ARENA_HP_GATE (must damage NPC to half first)
//   3. (my SEED) - (target SEED) > ARENA_SEED_GAP (skill differential)
//   4. !target._humanPiloted (human-piloted units are IMMUNE — silent fail
//      so the player can't tell whether failure was the SEED/HP/range
//      gate or because the target is a human; that ambiguity IS the design
//      tension when PvP arrives)
//
// Passive 25% natural-kill recruit (`_arenaTickRecruitment`) is unchanged.
const ARENA_SEED_MAX       = 100;      // hard cap
const ARENA_SEED_PER_SEC   = 1;        // rise rate when human-piloted+alive
const ARENA_SEED_GAP       = 10;       // minimum SEED differential to recruit
const ARENA_HP_GATE        = 0.5;      // target HP must be below maxHp * gate
const ARENA_TOUCH_BUFFER   = 5;        // px added to radii sum for touch range

// _arenaTickSeed — per-frame, called from the main update loop right next
// to _arenaTickRecruitment. Raises SEED on every unit currently flagged
// _humanPiloted. In solo NN that's only `player`; PvP just plugs more.
function _arenaTickSeed() {
  const inc = ARENA_SEED_PER_SEC / 60;
  if (player && player.alive && player._humanPiloted) {
    player._seed = Math.min(ARENA_SEED_MAX, (player._seed || 0) + inc);
  }
  // Forward-compat (PvP): if any ally / enemy is human-piloted, tick them too.
  for (const a of allies) {
    if (a && a.alive && a._humanPiloted && a !== player) {
      a._seed = Math.min(ARENA_SEED_MAX, (a._seed || 0) + inc);
    }
  }
  for (const e of enemies) {
    if (e && e.alive && e._humanPiloted) {
      e._seed = Math.min(ARENA_SEED_MAX, (e._seed || 0) + inc);
    }
  }
}

function _arenaAliveSquadCount() {
  let n = 0;
  for (const a of allies) if (a && a.alive && a._arenaRecruit) n++;
  return n;
}

// Phase 18: KO-stunned state. Enemy hp <= 0 the first time enters '_koStunned'
// instead of dying — they freeze in place (no AI, no fire, untargetable by
// bullets / aim-assist), turn pale-white, and wait for the player to walk up
// and press G to convert them into a squad ally. If the player ignores them,
// they auto-die after ARENA_STUN_TICKS. The flow ('我一開始要一個人 · 敵人會
// 自動加 · 我只能靠招降 · 第一次不會爆掉 · 變白色等著你去周旋 · 然後變成正常
// 友軍'). Skipping the SEED diff gate is the whole point of stun — by the time
// you've KO'd them, you've earned the recruit.
const ARENA_STUN_TICKS = 25 * 60;   // 25 sec window to walk over and press G
function _stunEnemyKO(e) {
  if (!e || e._koStunned || !e.alive) return false;
  e._koStunned = true;
  e._koStunnedAt = (typeof game !== 'undefined' && game.time) || 0;
  e.hp = Math.max(5, Math.round((e.maxHp || 80) * 0.05));
  // Cancel any inflight intent. NN-controlled units share the dispatcher
  // skip via _koStunned check; legacy FSM units share the same flag.
  e.target = null;
  e._nnFireCd = 999999;
  e.attackTarget = null;
  e.alerted = 0;
  if (typeof showSwapToast === 'function' && e.callsign) {
    // Only toast on stuns of named units — anonymous fillers get quiet.
    showSwapToast(T('▸ ' + e.callsign + ' 中立化 · 走近按 G 招降',
                    '▸ ' + e.callsign + ' NEUTRALIZED · walk up + G to recruit'));
  }
  return true;
}
// Helper for caller sites that want to express "did the kill stun or finish?":
// returns true if the unit was stunned (KO'd alive), false if already stunned
// (caller should let it die for real).
function _tryStunOrKill(e) {
  if (!e || !e.alive) return false;
  if (!e._koStunned) {
    _stunEnemyKO(e);
    return true;     // STUNNED — caller does NOT count as kill
  }
  return false;      // already stunned — caller treats as REAL kill
}

// Convert one enemy unit into a player ally. Caller is responsible for the
// kill-vs-recruit decision; this function just flips the team and bookkeeping.
// Recruit counter — gives sequential callsigns to converts so HUD chips read.
let _arenaRecruitCount = 0;
function _arenaConvertEnemyToAlly(e) {
  if (!e) return false;
  // Phase 18: convert clears the KO-stun flag so the new ally rejoins
  // bullets / AI / aim-assist normally.
  e._koStunned = false;
  e._koStunnedAt = null;
  const idx = enemies.indexOf(e);
  if (idx >= 0) enemies.splice(idx, 1);
  // Assign a callsign if missing (raw NN enemies often have none)
  if (!e.callsign) {
    _arenaRecruitCount = (_arenaRecruitCount + 1) | 0;
    e.callsign = 'R-' + _arenaRecruitCount;
  }
  // Flip team + HP restore so they don't immediately re-die
  e.team = 0;
  e.alive = true;
  e.hp = Math.max(e.maxHp * 0.5, 30);
  // Reset state machine bits that targeted player
  e.target = null;
  e._nnFireCd = 0; e._nnRecentDmg = 0; e._nnLastSeenTick = -9999;
  e._respawnAt = null;
  // Brief spawn invuln so the new ally doesn't get cleaned up by stray bullets
  e._invulnUntil = (game.time || 0) + 90;
  // Tag so HUD / squad-chip / death-on-cap logic can recognize recruits
  e._arenaRecruit = true;
  // Phase 4: ensure SEED bookkeeping exists. Converted enemies keep their
  // accumulated SEED (almost always 0 for raw AI bots) and are explicitly
  // NOT human-piloted (NN drives them once they're on your team).
  if (typeof e._seed !== 'number') e._seed = 0;
  e._humanPiloted = false;
  allies.push(e);
  // Feedback
  if (typeof showSwapToast === 'function') {
    showSwapToast(T('▸ 招降 · ' + (e.callsign || 'UNIT'),
                    '▸ RECRUITED · ' + (e.callsign || 'UNIT')));
  }
  if (typeof playRadioStatic === 'function') playRadioStatic(0.55, 0.45);
  return true;
}

// G-key handler. Returns true if we converted (so the dispatcher skips grenade).
// Phase 18: TWO recruit paths now:
//   (a) STUNNED targets — player walks up to a KO-stunned enemy (white, frozen)
//       and presses G. Only the touch-range gate applies; HP and SEED gates
//       are skipped (you already earned the recruit by knocking them down).
//   (b) LIVE targets — the original four-gate path: touch range + HP < 50%
//       + SEED gap > 10 + not human-piloted. Kept as a 'finisher' for players
//       with high SEED who want to skip the stun-recruit loop entirely.
// Failure modes still look identical to the player so they can't deduce why
// a recruit missed.
function _arenaTrySEDConvert() {
  if (!player || !player.alive) return false;
  if (_arenaAliveSquadCount() >= ARENA_SQUAD_CAP) return false;
  const mySeed = player._seed || 0;
  const myR = player.radius || 13;
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    if (!e || !e.alive) continue;
    // Gate 4 — human-piloted targets are immune (silent fail). Forward-compat
    // for PvP; in solo NN no enemy is ever flagged human, so this is a no-op.
    if (e._humanPiloted) continue;
    // Gate 1 — touch range. Hard requirement for BOTH paths.
    const targetR = e.radius || 13;
    const touchD = myR + targetR + ARENA_TOUCH_BUFFER;
    const d = Math.hypot(e.x - player.x, e.y - player.y);
    if (d > touchD) continue;
    // Path (a): KO-stunned → skip HP + SEED gates, recruit immediately.
    if (e._koStunned) {
      if (d < bestD) { bestD = d; best = e; }
      continue;
    }
    // Path (b): live enemy — original gates apply.
    const maxHp = e.maxHp || 80;
    if (e.hp >= maxHp * ARENA_HP_GATE) continue;
    const targetSeed = e._seed || 0;
    if (mySeed - targetSeed <= ARENA_SEED_GAP) continue;
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return false;
  return _arenaConvertEnemyToAlly(best);
}

// Phase 6B: recycle a recruit into build energy. Picks the LOWEST-SEED
// alive squad bot (so newly-conscripted noobs get scrapped first, your
// veterans stay on the field), removes them, and credits the player with
// ARENA_RECYCLE_ENERGY. Returns true when something was actually scrapped.
//
// Why lowest-SEED: scrapping a high-SEED ally would feel terrible — that
// SEED took match-time to build. Bots you just recruited from kills have
// _seed=0 and are the natural candidates for conversion. Forms a soft
// loop: kill → recruit → discard weakest for energy → build.
const ARENA_RECYCLE_ENERGY = 60;          // energy refund per recycle
const ARENA_RECYCLE_KEEP_LAST = 1;        // never recycle below this many bots
function _arenaTryRecycle() {
  if (!player || !player.alive) return false;
  // Find all alive recruits, sort by SEED ascending — lowest first
  const pool = [];
  for (let i = 0; i < allies.length; i++) {
    const a = allies[i];
    if (a && a.alive && a._arenaRecruit && !a._humanPiloted) pool.push({ a, i });
  }
  if (pool.length <= ARENA_RECYCLE_KEEP_LAST) {
    if (typeof showSwapToast === 'function') {
      showSwapToast(T('▸ 沒有可回收的隊員', '▸ NO ALLY TO RECYCLE'));
    }
    return false;
  }
  pool.sort((p, q) => (p.a._seed || 0) - (q.a._seed || 0));
  const victim = pool[0].a;
  const idx = pool[0].i;
  // Remove from allies, mark as harvested
  allies.splice(idx, 1);
  // Credit energy
  if (typeof game !== 'undefined') {
    game._energy = Math.min(999, (game._energy || 0) + ARENA_RECYCLE_ENERGY);
  }
  // Feedback
  if (typeof showSwapToast === 'function') {
    const name = victim.callsign || 'UNIT';
    const seedTxt = Math.floor(victim._seed || 0);
    showSwapToast(T(`♺ 回收 · ${name} (SEED ${seedTxt}) → +${ARENA_RECYCLE_ENERGY} ⚡`,
                    `♺ RECYCLED · ${name} (SEED ${seedTxt}) → +${ARENA_RECYCLE_ENERGY} ⚡`));
  }
  if (typeof playRadioStatic === 'function') playRadioStatic(0.40, 0.30);
  // Small visual cue at the victim's last position — re-use explosion fx
  // if available so the player sees WHERE the bot disappeared from.
  if (typeof createExplosion === 'function') {
    createExplosion(victim.x, victim.y, 'small');
  }
  return true;
}

// Phase 3C: spawn a fresh NN bot for a captured factory. Called from
// nn_deathmatch's _tickFactories when an owned factory's productionTicks
// elapses. Spawned bot inherits the team's standard NN brain at the
// faction's spawn anchor. Squad cap respected for blue (the player's
// squad); red is uncapped because it's the AI side.
function _arenaSpawnFactoryBot(team, x, y) {
  if (team === 'blue' && _arenaAliveSquadCount() >= ARENA_SQUAD_CAP) return;
  // Stand off the factory center a bit so we don't telefrag the player.
  const angle = Math.random() * Math.PI * 2;
  const dist = 70 + Math.random() * 30;
  const sx = x + Math.cos(angle) * dist;
  const sy = y + Math.sin(angle) * dist;
  const wid = (typeof pickRandomNNWeaponId === 'function') ? pickRandomNNWeaponId() : 'RIFLE';
  const chassisId = (typeof CHASSIS_ORDER !== 'undefined')
    ? CHASSIS_ORDER[Math.floor(Math.random() * CHASSIS_ORDER.length)] : 'humanoid';
  const u = {
    x: sx, y: sy, angle: team === 'red' ? Math.PI : 0,
    fireCd: 0, fireRate: 50, radius: 13,
    alive: true, walkPhase: Math.random() * Math.PI * 2,
    speed: 2.5,
    hp: 80, maxHp: 80,
    team: team === 'blue' ? 0 : 1,
    _weapon: (typeof WEAPONS !== 'undefined' && WEAPONS[wid]) || (typeof WEAPONS !== 'undefined' ? WEAPONS.RIFLE : null),
    _useNN: true, _nnFireCd: 0, _nnRecentDmg: 0, _nnLastSeenTick: -9999,
    _respawnAt: null,
    _invulnUntil: (game.time || 0) + 60,
    _arenaFactoryBot: true,
    callsign: (team === 'blue' ? 'F-' : 'R-F-') + (++_arenaRecruitCount),
    // Phase 4: factory bots start at SEED 0 (AI-piloted from the moment they spawn).
    _seed: 0,
    _humanPiloted: false,
  };
  if (typeof applyChassisToUnit === 'function') {
    applyChassisToUnit(u, chassisId, 2.5, 80, 13);
  }
  if (team === 'blue') {
    u._arenaRecruit = true;
    allies.push(u);
    if (typeof showSwapToast === 'function') {
      showSwapToast(T('▶ 工廠生產 · ' + u.callsign, '▶ FACTORY PRODUCED · ' + u.callsign));
    }
  } else {
    enemies.push(u);
  }
}

// Per-frame sweep: when an enemy dies naturally, roll for recruitment.
// We watch for the transition (alive: true → false) by tagging deaths with
// `_arenaDeathSeen` so we only roll once per death.
function _arenaTickRecruitment() {
  if (_arenaAliveSquadCount() >= ARENA_SQUAD_CAP) {
    // Still flag deaths so we don't roll later when there's room
    for (const e of enemies) if (e && !e.alive && !e._arenaDeathSeen) e._arenaDeathSeen = true;
    return;
  }
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e || e._arenaDeathSeen) continue;
    if (e.alive) continue;
    e._arenaDeathSeen = true;
    if (Math.random() < ARENA_RECRUIT_CHANCE) {
      _arenaConvertEnemyToAlly(e);
    }
  }
}
