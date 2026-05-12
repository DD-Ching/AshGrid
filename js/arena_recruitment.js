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
const ARENA_SED_RANGE      = 220;      // px
const ARENA_SQUAD_CAP      = 5;        // hard cap on bots you own at once

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
function _arenaTrySEDConvert() {
  if (!player || !player.alive) return false;
  if (_arenaAliveSquadCount() >= ARENA_SQUAD_CAP) return false;
  let best = null, bestD = ARENA_SED_RANGE;
  for (const e of enemies) {
    if (!e || !e.alive) continue;
    const d = Math.hypot(e.x - player.x, e.y - player.y);
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
