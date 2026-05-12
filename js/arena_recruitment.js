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

const ARENA_RECRUIT_CHANCE = 0.25;     // natural kill conversion roll
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

// Convert one enemy unit into a player ally. Caller is responsible for the
// kill-vs-recruit decision; this function just flips the team and bookkeeping.
// Recruit counter — gives sequential callsigns to converts so HUD chips read.
let _arenaRecruitCount = 0;
function _arenaConvertEnemyToAlly(e) {
  if (!e) return false;
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
// Four gates: touch range, HP < 50%, SEED gap > 10, target not human-piloted.
// Failure modes look identical to the player — they can't deduce why a recruit
// missed (range / HP / SEED / human-piloted). That ambiguity is intentional.
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
    // Gate 1 — touch range (radii sum + tiny buffer). Hard requirement.
    const targetR = e.radius || 13;
    const touchD = myR + targetR + ARENA_TOUCH_BUFFER;
    const d = Math.hypot(e.x - player.x, e.y - player.y);
    if (d > touchD) continue;
    // Gate 2 — NPC must be damaged below the HP gate. "招降要先打殘".
    const maxHp = e.maxHp || 80;
    if (e.hp >= maxHp * ARENA_HP_GATE) continue;
    // Gate 3 — SEED differential. Player must out-skill the target by GAP.
    const targetSeed = e._seed || 0;
    if (mySeed - targetSeed <= ARENA_SEED_GAP) continue;
    // All four gates pass. Tie-break by nearest in case multiple eligible.
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return false;
  return _arenaConvertEnemyToAlly(best);
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
