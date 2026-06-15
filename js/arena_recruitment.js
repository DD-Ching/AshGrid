// ============ ARENA RECRUITMENT ============
// "Kill an enemy → they become your ally" is the arena-mp progression hook.
// Recruitment is fully MANUAL (G key): _arenaTrySEDConvert() finds the
// nearest live enemy within touch range and converts if HP/SEED gates pass.
// Costs a grenade slot (caller falls back to throwGrenade if no target).
//
// Squad cap keeps the screen readable + preserves death stakes (lose your
// army when you die). User intent: '我想要有些 npc 被幹掉會變自己人' +
// '不會自動招降, 招降一定要靠手動的'.
//
// Classic-script. Declares globally:
//   ARENA_SED_RANGE · ARENA_SQUAD_CAP (constants)
//   _arenaAliveSquadCount() · _arenaConvertEnemyToAlly(e)
//   _arenaTrySEDConvert()
//
// External deps (resolved at call-time):
//   player · allies · enemies · game.time
//   showSwapToast() · playRadioStatic() · T()

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
//   1. Distance ≤ (myR + targetR + ARENA_TOUCH_BUFFER). Effective reach
//      ≈ 106 px — close enough to feel deliberate, loose enough to not
//      require pixel-perfect alignment.
//   2. Target HP < maxHp * ARENA_HP_GATE (must damage NPC to half first)
//   3. (my SEED) - (target SEED) > ARENA_SEED_GAP (skill differential)
//   4. !target._humanPiloted (human-piloted units are IMMUNE — silent fail
//      so the player can't tell whether failure was the SEED/HP/range
//      gate or because the target is a human; that ambiguity IS the design
//      tension when PvP arrives)
const ARENA_SEED_MAX       = 100;      // hard cap
const ARENA_SEED_PER_SEC   = 1;        // rise rate when human-piloted+alive
const ARENA_SEED_GAP       = 10;       // minimum SEED differential to recruit
const ARENA_HP_GATE        = 0.5;      // target HP must be below maxHp * gate
const ARENA_TOUCH_BUFFER   = 80;       // px added to radii sum (~106px reach)

// _arenaTickSeed — per-frame, called from the main update loop. Raises
// SEED on every unit currently flagged _humanPiloted. In solo NN that's
// only `player`; PvP just plugs more.
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
  // Phase 148 — celebrate the core-loop beat: green call-out + new SQUAD ×N
  // + a rising sting (see js/recruit_fx.js).
  if (typeof triggerRecruitFx === 'function') triggerRecruitFx(e.callsign || 'UNIT');
  return true;
}

// Phase 184c — Wolf/Dog DEVOUR (處決吸血). The Charger's G is NOT recruit: it
// EXECUTES a weaker live enemy (target.hp < player.hp + touch range) — the enemy
// vanishes (no squad slot) and the dog LIFESTEALS its hp + energy. Flag-gated
// (game._classes) + wolf-only; self-gates so the G dispatcher tries it first and
// no-ops for other chassis / when classes off / in MP (enemies[] empty there).
function _arenaTryDevour() {
  if (!player || !player.alive) return false;
  if (!(typeof game !== 'undefined' && game._classes)) return false;
  if (player._chassis !== 'wolf') return false;
  const myR = player.radius || 13;
  const myHp = player.hp || 1;
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    if (!e || !e.alive || e._humanPiloted) continue;
    const touchD = myR + (e.radius || 13) + ARENA_TOUCH_BUFFER;
    const d = Math.hypot(e.x - player.x, e.y - player.y);
    if (d > touchD) continue;
    if (e.hp >= myHp) continue;            // must be WEAKER than me
    if (d < bestD) { bestD = d; best = e; }
  }
  if (!best) return false;
  // Execute + lifesteal: vanish (no squad slot), steal ~half the victim's max HP.
  const stolenHp = Math.max(20, Math.round((best.maxHp || 80) * 0.5));
  const bx = best.x, by = best.y;
  best.alive = false;
  best._koStunned = false;
  const idx = enemies.indexOf(best);
  if (idx >= 0) enemies.splice(idx, 1);
  player.hp = Math.min(player.maxHp || 100, (player.hp || 0) + stolenHp);
  // Phase 186 — devour now ACCUMULATES energy-regen RATE (累加能量回复速度) instead of
  // a flat +25 energy: each successful devour adds a stack (capped), read by the
  // energy-regen loop (mission_runtime.js). Stacks reset at match start.
  const _cap = (typeof BALANCE === 'object' && BALANCE.wolf) ? (BALANCE.wolf.devourRegenStackCap || 10) : 10;
  if (typeof game !== 'undefined') game._wolfRegenStacks = Math.min(_cap, (game._wolfRegenStacks || 0) + 1);
  const _stacks = (typeof game !== 'undefined') ? (game._wolfRegenStacks || 0) : 0;
  if (typeof createExplosion === 'function') createExplosion(bx, by, 'small');
  if (typeof playRadioStatic === 'function') playRadioStatic(0.55, 0.45);
  if (typeof triggerRecruitFx === 'function') triggerRecruitFx('DEVOUR');
  if (typeof showSwapToast === 'function') {
    showSwapToast(T('▸ 吞噬 · +' + stolenHp + ' 血 · 能量回复 ×' + _stacks,
                    '▸ DEVOUR · +' + stolenHp + ' HP · regen ×' + _stacks));
  }
  return true;
}

// Phase 187 — ONE shared per-chassis G-execute cue, so the on-screen prompt, the
// action-bar cell, and the actual G handler can never drift ("prompt says G but
// nothing happens"). Returns null when classes off / dead / no eligible target,
// else { kind, lz, le, target, affordable }. Eligibility mirrors the three G
// handlers exactly: weaker (hp < player.hp) + touch range + !_humanPiloted.
// Builder also needs recruit energy + to be under the squad cap. Cached per tick
// (HUD + world render both call it every frame).
let _execCueTick = -1, _execCueVal = null;
function _arenaExecuteInfo() {
  const now = (typeof game !== 'undefined' && game) ? game.time : 0;
  if (now === _execCueTick) return _execCueVal;
  _execCueTick = now;
  _execCueVal = _computeExecuteInfo();
  return _execCueVal;
}
function _computeExecuteInfo() {
  if (!(typeof game !== 'undefined' && game._classes)) return null;
  if (typeof player === 'undefined' || !player || !player.alive) return null;
  const chassis = player._chassis || 'humanoid';
  let kind, lz, le, needEnergy = 0;
  if (chassis === 'humanoid') {
    kind = 'recruit'; lz = '招降'; le = 'RECRUIT';
    needEnergy = (typeof BALANCE === 'object' && BALANCE.ability) ? (BALANCE.ability.recruit || 0) : 0;
  } else if (chassis === 'wolf')  { kind = 'devour'; lz = '吞噬'; le = 'DEVOUR'; }
  else if (chassis === 'heavy')   { kind = 'seize';  lz = '夺取'; le = 'SEIZE';  }
  else return null;
  const myR = player.radius || 13, myHp = player.hp || 1;
  const buf = (typeof ARENA_TOUCH_BUFFER === 'number') ? ARENA_TOUCH_BUFFER : 80;
  let best = null, bestD = Infinity;
  if (typeof enemies !== 'undefined' && enemies) {
    for (const e of enemies) {
      if (!e || !e.alive || e._humanPiloted) continue;
      const d = Math.hypot(e.x - player.x, e.y - player.y);
      if (d > myR + (e.radius || 13) + buf) continue;
      if (e.hp >= myHp) continue;
      if (d < bestD) { bestD = d; best = e; }
    }
  }
  if (!best && typeof _mpState !== 'undefined' && _mpState && _mpState.remoteBots) {
    for (const rb of _mpState.remoteBots.values()) {
      if (!rb || !rb.alive || rb.team === 0) continue;
      const d = Math.hypot(rb.x - player.x, rb.y - player.y);
      if (d > myR + (rb.radius || 14) + buf) continue;
      if (typeof rb.hp === 'number' && rb.hp >= myHp) continue;
      if (d < bestD) { bestD = d; best = rb; }
    }
  }
  // Builder also gates on squad cap (the recruit handler bails there too).
  let capped = false;
  if (kind === 'recruit' && typeof ARENA_SQUAD_CAP === 'number') {
    const sq = (typeof _mpAliveSquadCount === 'function')
      ? _mpAliveSquadCount()
      : ((typeof allies !== 'undefined' && allies) ? allies.filter(a => a && a.alive).length : 0);
    capped = sq >= ARENA_SQUAD_CAP;
  }
  const affordable = (needEnergy <= 0 || (game._energy || 0) >= needEnergy) && !capped;
  return { kind, lz, le, target: best, affordable, needEnergy };
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

  // Phase 184b — chassis-as-classes recruit (flag-gated `game._classes`; default
  // OFF so live behaviour is unchanged until the whole redesign is ready to flip
  // on — test with game._classes=true). NEW rule (2026-06-14 decisions):
  //   • only the BUILDER (humanoid) recruits to the squad (wolf G = execute,
  //     184c; other chassis fall through to grenade);
  //   • eligibility is simply target.hp < player.hp — any LIVE enemy weaker than
  //     you, no stun/反白 step, no hp<50%, no SEED gap;
  //   • costs BALANCE.ability.recruit energy.
  if (typeof game !== 'undefined' && game._classes) {
    if (player._chassis && player._chassis !== 'humanoid') return false;
    const cost = (typeof BALANCE === 'object' && BALANCE.ability) ? (BALANCE.ability.recruit || 0) : 0;
    if (cost > 0 && (game._energy || 0) < cost) return false;
    const myR = player.radius || 13;
    const myHp = player.hp || 1;
    let best = null, bestD = Infinity;
    for (const e of enemies) {
      if (!e || !e.alive || e._humanPiloted) continue;
      const touchD = myR + (e.radius || 13) + ARENA_TOUCH_BUFFER;
      const d = Math.hypot(e.x - player.x, e.y - player.y);
      if (d > touchD) continue;
      if (e.hp >= myHp) continue;                 // must be WEAKER than me
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) return false;
    const ok = _arenaConvertEnemyToAlly(best);
    if (ok && cost > 0) game._energy = Math.max(0, (game._energy || 0) - cost);
    return ok;
  }

  // ── legacy path (classes flag off) — unchanged Phase 18 behaviour ──
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
const ARENA_RECYCLE_ENERGY = BALANCE.energy.recycleRefund;          // energy refund per recycle
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
    addEnergy(ARENA_RECYCLE_ENERGY);
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
    // Phase 176 — adaptive director: wave reinforcements escalate as the player
    // dominates (SOLO one-way DDA). Baseline leaves _nnDifficulty unset → the
    // global default brain, exactly as before; only an UPGRADE sets it, so this
    // is a no-op at rest / when the director is absent / in MP.
    if (typeof directorPickStyle === 'function') {
      const up = directorPickStyle(null);
      if (up) {
        u._nnDifficulty = up;
        if (typeof directorPickWeapon === 'function') {
          const w2 = directorPickWeapon(chassisId, up, wid);
          if (w2 && typeof WEAPONS !== 'undefined' && WEAPONS[w2]) u._weapon = WEAPONS[w2];
        }
      }
    }
    enemies.push(u);
  }
}

