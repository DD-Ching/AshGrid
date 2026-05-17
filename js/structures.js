// ============ STRUCTURES (Defense + Arena build) ============
// Player-built modules that fight, generate energy, extend vision, etc.
// Each structure is { kind, x, y, hp, maxHp, ...kindFields } and lives in
// game._structures. Bullets / grenades damage them via the same hit loop
// as units; render adds them to the world pass; defense mission ticks
// their behaviour. Costs deduct from game._energy at place time.
//
// Bundles 4 logical sub-concerns that share state:
//   STRUCTURE_DEFS table + helpers (isWallKind, getStructureCost, place, ...)
//   POWER GRID (recomputePowerGrid)
//   MODULE UPGRADES + per-frame behaviour tick (updateStructures, turret /
//     mine / tesla / EMP / camera / smoke / drone-bay / medstation / etc.)
//   BUILD MODE (buildMode state + toggleBuildMode + exitBuildMode +
//     _canBuildPlace + _snapAndCheckPlace + _editorLineCells)
//   AIRSTRIKES (callAirstrike + updateAirstrikes — adjacent helpers)
//
// Classic-script. Declares globally (highlights, ~30+ symbols total):
//   STRUCTURE_DEFS · STRUCTURE_ORDER · WALL_KINDS · isWallKind
//   getStructureCost · canAffordStructure · placeStructure
//   bulletHitStructure · cameraCanSee · recomputePowerGrid
//   UPGRADE_TIERS · _moduleStat · _moduleUpgradeCost · upgradeNearestModule
//   updateStructures · callAirstrike · updateAirstrikes
//   buildMode · toggleBuildMode · exitBuildMode
//   _canBuildPlace · _snapAndCheckPlace · _editorLineCells (+ helpers)
//
// External deps: game · player · mouse · enemies · allies · bullets ·
//   explosions · screenToWorld · COLORS · WORLD · NN_ARENA · emitSound ·
//   createExplosion · spawnDamagePopup · playSfx · showSwapToast · T

// Player-built modules that fight, generate energy, extend vision, etc.
// Each structure is { kind, x, y, hp, maxHp, ...kindFields } and lives in
// game._structures. Bullets / grenades damage them via the same hit loop
// as units; render adds them to the world pass; defense mission ticks
// their behaviour. Costs deduct from game._energy at place time.
const STRUCTURE_DEFS = {
  // Phase 3B: spawn relay — pre-placed per team at match start. While
  // alive, that team's respawn timer is 5 sec; once destroyed, 20 sec.
  // Not buildable (cost: -1 keeps it out of the radial). Big HP buffer
  // (300) so killing it takes deliberate effort: ~10 LMG hits or 4
  // grenades. _team set at world-gen time.
  'spawn-relay': {
    cost: -1, hp: 450, size: 44, blocks: true, blocksLOS: false,    // was 300
    label: () => T('重生中繼', 'SPAWN RELAY'),
  },
  // Phase 3C: capturable factory — neutral at match start. Standing
  // inside captureR for captureTicks (5 sec) flips ownership to your
  // team. While owned, spawns +1 ally for that team every productionTicks
  // (30 sec) up to ARENA_SQUAD_CAP (5). Contested (both teams in radius)
  // pauses the capture timer. _team: 'neutral' | 'blue' | 'red'.
  // Phase 12: blue-owned factory ALSO acts as a power source for built
  // needsPower modules in powerR. Without a generator nearby, turrets
  // were dead weight on the player's first match — capturing a factory
  // now drops a free 280u power radius so the loop "fight → capture →
  // build turret on top" actually works. Red/neutral factories give no
  // power (gated in recomputePowerGrid by _team).
  'factory': {
    cost: -1, hp: 500, size: 60, blocks: true, blocksLOS: false,
    captureR: 90, captureTicks: 5 * 60, productionTicks: 30 * 60,
    powerSource: true, powerR: 280,
    label: () => T('機器工廠', 'BOT FACTORY'),
  },
  // 3-tier cover ladder (all line-drag-able). Phase 8 (user feedback
  // '太容易被摧毀, 沒什麼價值'): all built structures ~2× HP so spending
  // energy on cover/turrets/etc. is actually worth it.
  //  cover  — cheap, half-height, doesn't block line-of-sight
  //  wall   — balanced, blocks both bullets + LoS
  //  bunker — expensive, very tanky, blocks both
  cover: {
    cost: 18, hp: 120, size: 30, blocks: true, blocksLOS: false,    // was 60
    label: () => T('掩体', 'COVER'),
  },
  wall: {
    cost: 30, hp: 220, size: 30, blocks: true, blocksLOS: true,     // was 100
    label: () => T('牆', 'WALL'),
  },
  bunker: {
    cost: 70, hp: 500, size: 30, blocks: true, blocksLOS: true,     // was 260
    label: () => T('堡垒', 'BUNKER'),
  },
  turret: {
    cost: 100, hp: 160, size: 50, blocks: false, blocksLOS: false,  // was 80
    range: 380, fireCd: 60, dmg: 25,
    needsPower: true,           // dies if no generator can reach it
    ammoPerShot: 3,             // each shot drains game._energy by this much
    label: () => T('判決砲塔 VERDICT', 'VERDICT TURRET'),
  },
  generator: {
    cost: 80, hp: 120, size: 50, blocks: false, blocksLOS: false,   // was 50
    energyPerSec: 1.0,
    powerSource: true,          // emits power; powerR = how far power radiates
    powerR: 200,
    label: () => T('種子反應爐 SEED REACTOR', 'SEED REACTOR'),
  },
  camera: {
    cost: 60, hp: 90, size: 40, blocks: false, blocksLOS: false,    // was 40
    visionR: 360,
    needsPower: true,           // unpowered = no vision feed
    label: () => T('審計鏡 AUDIT LENS', 'AUDIT LENS'),
  },
  bot: {
    cost: 180, hp: 0, size: 0, blocks: false, blocksLOS: false,  // not a structure once placed
    isUnitSpawner: true,
    label: () => T('同盟審計單位 ALLY', 'ALLIED AUDIT UNIT'),
  },
  terminal: {
    cost: 200, hp: 140, size: 50, blocks: false, blocksLOS: false,  // was 60
    airstrikeCd: 1800,    // 30s between airstrikes
    needsPower: true,
    label: () => T('審計台 AUDIT CONSOLE', 'AUDIT CONSOLE'),
  },
  // Mine: invisible (to enemies; faint to player) — detonates when an enemy
  // enters TRIGGER_R. Phase 63: bumped dmg 70 → 130 + blastR 110 → 140 per
  // user '讓它傷害高一點'; bulletImmune so the only way to clear a hostile
  // mine is the G-key defuse (defuseTicks = 5s). Cost stays at 40 — high
  // damage is balanced by the slow defuse counter, not by build cost.
  mine: {
    cost: 40, hp: 9999, size: 24, blocks: false, blocksLOS: false,
    bulletImmune: true, defuseTicks: 5 * 60,
    triggerR: 30, blastR: 140, dmg: 130,
    label: () => T('地雷', 'MINE'),
  },
  // Trip-mine: places a hair-trigger that explodes when ANY enemy crosses
  // within TRIGGER_R of a 60u-extended line in front of the structure. Wider
  // arc than the mine, slightly higher damage, same defuse rules.
  tripmine: {
    cost: 70, hp: 9999, size: 28, blocks: false, blocksLOS: false,
    bulletImmune: true, defuseTicks: 5 * 60,
    triggerR: 50, blastR: 170, dmg: 150,
    label: () => T('诡雷', 'TRIPMINE'),
  },
  // Sensor: passive — pings enemies in radius onto the minimap (no damage).
  // Cheap intel, easy to destroy. Useful behind walls to scout the next wave.
  sensor: {
    cost: 30, hp: 70, size: 30, blocks: false, blocksLOS: false,    // was 30
    pingR: 320,
    label: () => T('診斷感測器 DIAGNOSTIC', 'DIAGNOSTIC SENSOR'),
  },
  // Smoke emitter: every 6s spawns a smoke cloud that blocks line-of-sight
  // for 5s in 140u radius. Tactical — denies enemy NN aim through it.
  smoke: {
    cost: 70, hp: 110, size: 36, blocks: false, blocksLOS: false,   // was 50
    emitCd: 360, cloudLife: 300, cloudR: 140,
    label: () => T('靜默雲 STATIC', 'STATIC CLOUD'),
  },
  // Tesla coil: every fireCd ticks finds the nearest enemy in range, blasts
  // it for primary damage, then chains the bolt to up to 3 more enemies
  // within `chainR` of the previous target. No LoS check on chain hops —
  // electricity arcs around cover. Visually a stack of lightning lines that
  // fade over ~10 ticks.
  tesla: {
    cost: 140, hp: 150, size: 38, blocks: false, blocksLOS: false,  // was 70
    range: 300, fireCd: 90, dmg: 30, chainR: 110, chainDmg: [22, 16, 10], chainMax: 3,
    needsPower: true,
    ammoPerShot: 5,
    label: () => T('切斷線圈 SEVERANCE', 'SEVERANCE COIL'),
  },
  // EMP pylon: every emitCd ticks, stuns all enemies in pulseR for stunTicks
  // — they freeze in place + don't fire. No damage, pure crowd control.
  // Pairs with rocket / tesla as the burst payoff.
  emp: {
    cost: 130, hp: 130, size: 36, blocks: false, blocksLOS: false,  // was 60
    emitCd: 240, pulseR: 220, stunTicks: 180,
    needsPower: true,
    ammoPerShot: 8,
    label: () => T('LUMEN 抑制器', 'LUMEN SUPPRESSOR'),
  },
  // Med station: every healCd ticks heals each ally in radius healR for
  // healAmt. Doesn't heal the player's own structures (they need rockets
  // killing the things shooting at them, not patches). Cheap support.
  medstation: {
    cost: 100, hp: 110, size: 32, blocks: false, blocksLOS: false,  // was 50
    healCd: 60, healR: 200, healAmt: 4,
    needsPower: true,
    label: () => T('修復場 REPAIR FIELD', 'REPAIR FIELD'),
  },
  // Drone bay: every spawnCd, launches a mini autonomous FPV drone that
  // homes on the nearest enemy + detonates on contact. Drones live in
  // game._autoDrones, ticked + rendered separately.
  dronebay: {
    cost: 200, hp: 170, size: 38, blocks: false, blocksLOS: false,  // was 80
    spawnCd: 360, droneHp: 30, droneSpeed: 5, droneDmg: 40, droneBlastR: 60,
    needsPower: true,
    label: () => T('審計蜂群 SWARM', 'AUDITOR SWARM'),
  },
};
const STRUCTURE_ORDER = ['cover', 'wall', 'bunker', 'turret', 'generator', 'camera', 'bot', 'terminal',
                         'mine', 'tripmine', 'sensor', 'smoke', 'tesla', 'emp', 'medstation', 'dronebay'];

function getStructureCost(kind) { return STRUCTURE_DEFS[kind]?.cost || 0; }
// Cover-archetype kinds (cover/wall/bunker) all support drag-line placement
// because they're modular building blocks. Other modules are single-place.
const WALL_KINDS = new Set(['cover', 'wall', 'bunker']);
function isWallKind(kind) { return WALL_KINDS.has(kind); }
function canAffordStructure(kind) { return (game._energy || 0) >= getStructureCost(kind); }

// Place a structure at world (wx, wy). For combat-bot it instead spawns an
// NN ally directly (one-time use, no persistent module). Returns true on
// success. Caller checks build-mode + line-of-sight as needed.
function placeStructure(kind, wx, wy) {
  const def = STRUCTURE_DEFS[kind]; if (!def) return false;
  if (!canAffordStructure(kind)) {
    showSwapToast(T(`能源不足 (需 ${def.cost})`, `Insufficient energy (need ${def.cost})`));
    return false;
  }
  // Combat bot: spawn a fresh NN ally on the spot (joins blue team).
  if (kind === 'bot') {
    const callsignPool = ['BRAVO','CHARLIE','DELTA','ECHO','FOXTROT','GOLF','HOTEL','INDIA'];
    const usedCs = new Set(allies.map(a => a.callsign));
    const callsign = callsignPool.find(c => !usedCs.has(c)) || ('U' + (allies.length));
    const w = WEAPONS[_lobby.weapon] || WEAPONS.RIFLE;
    allies.push({
      callsign, offsetX: 0, offsetY: 0,
      x: wx, y: wy,
      angle: 0, gunAngle: 0, gunRecoil: 0,
      swayPhase: Math.random() * Math.PI * 2, walkPhase: 0,
      hp: 80, maxHp: 80,
      alive: true, radius: 13,
      speed: 2.5, fireCd: 0,
      weaponId: _lobby.weapon || 'RIFLE',
      _weapon: w,
      _nnDifficulty: _lobby.difficulty || 'elite',
      target: null, lookPhase: 0, team: 0,
      _useNN: true, _nnFireCd: 0, _nnRecentDmg: 0, _nnLastSeenTick: -9999,
      _respawnAt: null, _invulnUntil: game.time + 60,
      _deployed: true,
    });
    game._energy -= def.cost;
    showSwapToast(T(`部署 ${callsign}`, `Deployed ${callsign}`));
    playSfx('reload', { vol: 0.6 });
    return true;
  }
  // Normal structure
  game._structures = game._structures || [];
  // Phase 43: in MP, generate a sid that the server will agree on. Both
  // sides keep the same id so the local optimistic copy and the server's
  // authoritative entry refer to the same wall — and any later
  // structureHit / structureGone events from the server can patch THIS
  // entry by sid lookup. In SP the sid is just bookkeeping.
  const sid = (typeof _mpNextSid === 'function') ? _mpNextSid() : 0;
  const s = {
    sid,
    kind, x: wx, y: wy, hp: def.hp, maxHp: def.hp,
    fireCd: 0, airstrikeCd: 0, _placedAt: game.time,
  };
  game._structures.push(s);
  game._energy -= def.cost;
  // Phase 43: in MP, tell the server we built this so it can enforce
  // collision + accept damage from other players' bullets/grenades, and
  // broadcast to other clients so they see the wall too.
  if (typeof _mpIsActive === 'function' && _mpIsActive()
      && typeof _mpBroadcastBuild === 'function') {
    _mpBroadcastBuild(sid, kind, wx, wy);
  }
  showSwapToast(T(`部署 ${def.label()}`, `Deployed ${def.label()}`));
  // FTUE: first placement advances step 4 → step 5 (streak training)
  // Cumulative build counter — feeds the ARCHITECT achievement
  try {
    const total = (parseInt(localStorage.getItem('ag.buildCount') || '0', 10) || 0) + 1;
    localStorage.setItem('ag.buildCount', String(total));
    if (total >= 50) unlockAchievement('build_50');
  } catch (e) {}
  playSfx('reload', { vol: 0.5 });
  return true;
}

// ============ POWER GRID ============
// Generators emit power within powerR (default 200u). Wall-lines act as
// conductors — power propagates along touching wall-line endpoints.
// Modules with needsPower=true require a route back to a generator
// (either directly inside genR, or via a chain of wall-lines).
// Recomputed twice per second (every 30 ticks) — graph BFS over the
// current set of structures + walls.
function _wallEndpoints(w) {
  return [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }];
}
function _wallsTouch(a, b) {
  const r = (a.thickness + b.thickness) / 2 + 4;
  for (const pa of _wallEndpoints(a)) for (const pb of _wallEndpoints(b)) {
    if (Math.hypot(pa.x - pb.x, pa.y - pb.y) <= r) return true;
  }
  return false;
}
function _wallNearPoint(w, px, py, padBeyondLine) {
  const r = _segPointDist(px, py, w.x1, w.y1, w.x2, w.y2);
  return r.dist <= w.thickness / 2 + padBeyondLine;
}
// ============ MODULE UPGRADES ============
// Each placed module has `tier` 1..3. Higher tiers cost energy + visibly
// boost stats (more HP, more dmg, lower cooldown). Pressing U near a
// placed module triggers `upgradeNearestModule()` which picks the
// closest one within 80u and bumps it if the player can afford it.
const UPGRADE_TIERS = {
  // tier index → { cost (% of base), hpMul, dmgMul, fireCdMul, label }
  // Base entry tier=1 is implicit (1.0 across the board, no cost).
  2: { costPct: 0.6, hpMul: 1.5, dmgMul: 1.5, fireCdMul: 0.85, label: 'II' },
  3: { costPct: 1.2, hpMul: 2.0, dmgMul: 2.0, fireCdMul: 0.70, label: 'III' },
};
function _moduleStat(s, key) {
  const def = STRUCTURE_DEFS[s.kind];
  if (!def) return 0;
  // 'maxHp' reads from def.hp (definitions store base hp, not maxHp)
  const base = key === 'maxHp' ? def.hp : def[key];
  const t = s.tier || 1;
  if (t === 1) return base;
  const mul = UPGRADE_TIERS[t];
  if (!mul) return base;
  if (key === 'dmg' || key === 'chainDmg') return Array.isArray(base) ? base.map(d => d * mul.dmgMul) : base * mul.dmgMul;
  if (key === 'fireCd' || key === 'emitCd' || key === 'healCd' || key === 'spawnCd') return Math.round(base * mul.fireCdMul);
  if (key === 'maxHp') return Math.round(base * mul.hpMul);
  return base;
}
function _moduleUpgradeCost(s) {
  const def = STRUCTURE_DEFS[s.kind];
  if (!def) return Infinity;
  const next = (s.tier || 1) + 1;
  const tier = UPGRADE_TIERS[next];
  if (!tier) return Infinity;          // already at max
  return Math.round(def.cost * tier.costPct);
}
function upgradeNearestModule() {
  if (!game._structures || game._structures.length === 0) return false;
  const lang = (typeof getLang === 'function' && getLang() === 'zh') ? 'zh' : 'en';
  // Pick nearest non-passive module within 80u of the player
  let best = null, bestD = 80;
  for (const s of game._structures) {
    if (s.hp <= 0) continue;
    if (s.kind === 'mine' || s.kind === 'tripmine' || s.kind === 'cover' ||
        s.kind === 'wall' || s.kind === 'bunker') continue;   // passive / structural skip
    const d = Math.hypot(s.x - player.x, s.y - player.y);
    if (d < bestD) { best = s; bestD = d; }
  }
  if (!best) {
    showSwapToast(lang === 'zh' ? '附近沒有可升級的模塊' : 'No upgradable module nearby');
    return false;
  }
  const next = (best.tier || 1) + 1;
  const cost = _moduleUpgradeCost(best);
  if (!isFinite(cost)) {
    showSwapToast(lang === 'zh' ? '模塊已達 III 級' : 'Module at max tier');
    return false;
  }
  if ((game._energy || 0) < cost) {
    showSwapToast(lang === 'zh' ? `能源不足 (需 ${cost}⚡)` : `Need ${cost}⚡`);
    return false;
  }
  game._energy -= cost;
  best.tier = next;
  // Bump current HP by the same ratio so an upgraded module isn't half-dead
  const newMaxHp = _moduleStat(best, 'maxHp') || best.maxHp;
  const ratio = best.maxHp ? best.hp / best.maxHp : 1;
  best.maxHp = newMaxHp;
  best.hp = Math.round(newMaxHp * ratio);
  const def = STRUCTURE_DEFS[best.kind];
  showSwapToast(`${def.label()} → ${UPGRADE_TIERS[next].label}  -${cost}⚡`);
  if (typeof playRadioBeep === 'function') playRadioBeep(990, 0.12);
  return true;
}

function recomputePowerGrid() {
  const structs = game._structures || [];
  for (const s of structs) s._powered = false;
  for (const w of wallLines)  w._powered = false;
  // Phase 12: any STRUCTURE_DEFS entry with powerSource=true is a source.
  // Generators (player-built) always count; factories only count when
  // owned by blue (captured) so the player gets a free power radius as
  // a reward for capture. Each source uses its own powerR field.
  const gens = structs.filter(s => {
    const def = STRUCTURE_DEFS[s.kind];
    if (!def || !def.powerSource || s.hp <= 0) return false;
    if (s._isFactory) return s._team === 'blue';
    return true;
  });
  if (gens.length === 0) return;
  const liveWalls = wallLines.filter(w => w.hp > 0);
  const queue = [];
  for (const g of gens) {
    const R = STRUCTURE_DEFS[g.kind]?.powerR || 200;
    g._powered = true;
    for (const w of liveWalls) {
      if (w._powered) continue;
      const r = _segPointDist(g.x, g.y, w.x1, w.y1, w.x2, w.y2);
      if (r.dist <= R) { w._powered = true; queue.push(w); }
    }
  }
  while (queue.length) {
    const w = queue.shift();
    for (const w2 of liveWalls) {
      if (w2._powered) continue;
      if (_wallsTouch(w, w2)) { w2._powered = true; queue.push(w2); }
    }
  }
  const WIRE_REACH = 60;
  for (const s of structs) {
    if (STRUCTURE_DEFS[s.kind]?.powerSource || s.hp <= 0) continue;
    if (!STRUCTURE_DEFS[s.kind]?.needsPower) { s._powered = true; continue; }
    for (const g of gens) {
      const R = STRUCTURE_DEFS[g.kind]?.powerR || 200;
      if (Math.hypot(g.x - s.x, g.y - s.y) <= R) { s._powered = true; break; }
    }
    if (s._powered) continue;
    for (const w of liveWalls) {
      if (!w._powered) continue;
      if (_wallNearPoint(w, s.x, s.y, WIRE_REACH)) { s._powered = true; break; }
    }
  }
}

function updateStructures() {
  if (!game._structures) return;
  if (game.time % 30 === 0) recomputePowerGrid();
  for (let i = game._structures.length - 1; i >= 0; i--) {
    const s = game._structures[i];
    const def = STRUCTURE_DEFS[s.kind];
    if (!def) { game._structures.splice(i, 1); continue; }
    // Phase 3C: factories never die — they're territory objectives. Clamp
    // HP at min 1 and let bullets pass through visually (still soaks them
    // so attackers feel agency).
    if (s._isFactory && s.hp <= 0) { s.hp = 1; }
    if (s.hp <= 0) {
      // Death FX + remove
      createExplosion(s.x, s.y, 'small');
      game._structures.splice(i, 1);
      continue;
    }
    // Power gate — needsPower modules without a route to a generator
    // sit dormant this frame. Passive modules (mine/sensor/smoke) ignore.
    if (def.needsPower && !s._powered) continue;
    // Generator: tick energy
    if (s.kind === 'generator') {
      game._energy = Math.min(999, (game._energy || 0) + (def.energyPerSec / 60));
    }
    // Turret: scan + fire (also drains game._energy as ammo)
    if (s.kind === 'turret') {
      if (s.fireCd > 0) s.fireCd--;
      if (s.fireCd <= 0) {
        let best = null, bestD = def.range;
        for (const e of enemies) {
          if (!e.alive) continue;
          // Phase 116 — turrets skip KO-stunned (white) enemies too —
          // they're the recruit-via-G target, not for auto-fire.
          if (e._koStunned) continue;
          const d = Math.hypot(e.x - s.x, e.y - s.y);
          if (d < bestD && lineOfSight(s.x, s.y, e.x, e.y)) { best = e; bestD = d; }
        }
        const ammoCost = def.ammoPerShot || 3;
        if (best && (game._energy || 0) >= ammoCost) {
          game._energy -= ammoCost;
          const a = Math.atan2(best.y - s.y, best.x - s.x);
          s.gunAngle = a;
          // Spawn a bullet from the turret — damage scales with tier
          bullets.push({
            x: s.x + Math.cos(a) * 18, y: s.y + Math.sin(a) * 18,
            vx: Math.cos(a) * 18, vy: Math.sin(a) * 18,
            life: 36, dmg: _moduleStat(s, 'dmg'), team: 0,
            fromTurret: true, fromUnit: null, weaponName: T('炮塔', 'turret'),
          });
          s.fireCd = _moduleStat(s, 'fireCd');
          playSfx('shoot', { vol: 0.3, src: { x: s.x, y: s.y } });
        }
      }
    }
    // Terminal: tick airstrike CD
    if (s.kind === 'terminal') {
      if (s.airstrikeCd > 0) s.airstrikeCd--;
    }
    // Mine: detonate when enemy enters trigger radius
    if (s.kind === 'mine' || s.kind === 'tripmine') {
      const tr = def.triggerR;
      let triggered = false;
      for (const e of enemies) {
        if (!e.alive) continue;
        if (Math.hypot(e.x - s.x, e.y - s.y) < tr) { triggered = true; break; }
      }
      if (triggered) {
        // AOE damage to all enemies in blast radius
        createExplosion(s.x, s.y, 'big');
        playSfx('death', { vol: 0.6 });
        emitSound(s.x, s.y, 1200, false);
        for (const e of enemies) {
          if (!e.alive) continue;
          const d = Math.hypot(e.x - s.x, e.y - s.y);
          if (d < def.blastR) {
            const dmg = Math.round(def.dmg * (1 - d / def.blastR));
            e.hp -= dmg;
            if (e.hp <= 0) { e.alive = false; e.hp = 0; createExplosion(e.x, e.y, 'small'); }
          }
        }
        s.hp = 0;     // mark for cleanup next tick
      }
    }
    // Sensor: every 30 ticks, mark enemies in range as "pinged" so the
    // minimap reveals them this round. Persistent until they leave radius.
    if (s.kind === 'sensor') {
      if ((game.time + i) % 30 === 0) {
        for (const e of enemies) {
          if (!e.alive) continue;
          if (Math.hypot(e.x - s.x, e.y - s.y) < def.pingR) {
            e._sensorPingUntil = game.time + 60;
          }
        }
      }
    }
    // Smoke emitter: every emitCd ticks, spawn a smoke cloud at this spot
    if (s.kind === 'smoke') {
      if (s.emitCd === undefined) s.emitCd = 60;
      if (s.emitCd > 0) s.emitCd--;
      if (s.emitCd <= 0) {
        game._smokeClouds = game._smokeClouds || [];
        game._smokeClouds.push({
          x: s.x, y: s.y, r: def.cloudR, life: def.cloudLife, maxLife: def.cloudLife,
        });
        s.emitCd = def.emitCd;
      }
    }
    // Drone bay: spawns a homing mini-FPV every spawnCd. The drone lives
    // in game._autoDrones until it hits an enemy or its life runs out.
    if (s.kind === 'dronebay') {
      if (s.spawnCd === undefined) s.spawnCd = 60;
      if (s.spawnCd > 0) s.spawnCd--;
      if (s.spawnCd <= 0) {
        const target = enemies.find(e => e.alive);
        if (target) {
          game._autoDrones = game._autoDrones || [];
          game._autoDrones.push({
            x: s.x, y: s.y, vx: 0, vy: 0,
            hp: def.droneHp, speed: def.droneSpeed,
            dmg: def.droneDmg, blastR: def.droneBlastR,
            life: 360, target,
          });
          s.spawnCd = def.spawnCd;
          playSfx('reload', { vol: 0.4, src: { x: s.x, y: s.y } });
        } else {
          s.spawnCd = 30;
        }
      }
    }
    // EMP pylon: periodic stun pulse. Marks every enemy in pulseR with
    // _stunUntil so the NN dispatcher skips them. Visual: spawn an
    // expanding ring entry in game._empPulses; render fades it out.
    if (s.kind === 'emp') {
      if (s.emitCd === undefined) s.emitCd = 90;
      if (s.emitCd > 0) s.emitCd--;
      const ammoCost = def.ammoPerShot || 8;
      if (s.emitCd <= 0 && (game._energy || 0) >= ammoCost) {
        let stunned = 0;
        for (const e of enemies) {
          if (!e.alive) continue;
          if (Math.hypot(e.x - s.x, e.y - s.y) < def.pulseR) {
            e._stunUntil = game.time + def.stunTicks;
            stunned++;
          }
        }
        if (stunned > 0) {
          game._energy -= ammoCost;
          game._empPulses = game._empPulses || [];
          game._empPulses.push({ x: s.x, y: s.y, r: def.pulseR, life: 30, maxLife: 30 });
          playSfx('reload', { vol: 0.4, src: { x: s.x, y: s.y } });
        }
        s.emitCd = def.emitCd;
      }
    }
    // Med station: heals every ally (incl. player) inside healR each healCd.
    if (s.kind === 'medstation') {
      if (s.healCd === undefined) s.healCd = 30;
      if (s.healCd > 0) s.healCd--;
      if (s.healCd <= 0) {
        const heal = (u) => {
          if (!u.alive) return;
          if (Math.hypot(u.x - s.x, u.y - s.y) > def.healR) return;
          if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + def.healAmt);
        };
        if (player) heal(player);
        for (const a of allies) heal(a);
        s.healCd = def.healCd;
      }
    }
    // Tesla coil: chain lightning. Find nearest enemy in range, zap it +
    // hop the bolt to up to chainMax more enemies within chainR of the
    // previous hit. Each chain visualises as one persistent lightning
    // segment in game._teslaBolts (rendered + faded for ~12 ticks).
    if (s.kind === 'tesla') {
      if (s.fireCd > 0) s.fireCd--;
      const teslaAmmo = def.ammoPerShot || 5;
      if (s.fireCd <= 0 && (game._energy || 0) >= teslaAmmo) {
        let primary = null, primaryD = def.range;
        for (const e of enemies) {
          if (!e.alive) continue;
          if (e._invulnUntil != null && game.time < e._invulnUntil) continue;
          const d = Math.hypot(e.x - s.x, e.y - s.y);
          if (d < primaryD && lineOfSight(s.x, s.y, e.x, e.y)) { primary = e; primaryD = d; }
        }
        if (primary) {
          game._energy -= teslaAmmo;
          const teslaDmg = _moduleStat(s, 'dmg');
          const teslaCdNew = _moduleStat(s, 'fireCd');
          game._teslaBolts = game._teslaBolts || [];
          // Primary zap — damage scales with tier
          primary.hp -= teslaDmg;
          spawnDamagePopup(primary.x, primary.y - 14, teslaDmg, primary.hp <= 0);
          if (primary.hp <= 0 && primary.alive) {
            primary.alive = false; game.score += 100; game.killCount++;
            createExplosion(primary.x, primary.y, 'small');
          }
          game._teslaBolts.push({ x1: s.x, y1: s.y, x2: primary.x, y2: primary.y, life: 14 });
          // Chain hops
          let prev = primary;
          const hit = new Set([primary]);
          for (let h = 0; h < def.chainMax; h++) {
            let next = null, nextD = def.chainR;
            for (const e of enemies) {
              if (!e.alive || hit.has(e)) continue;
              const d = Math.hypot(e.x - prev.x, e.y - prev.y);
              if (d < nextD) { next = e; nextD = d; }
            }
            if (!next) break;
            const dmg = def.chainDmg[h] || def.chainDmg[def.chainDmg.length - 1];
            next.hp -= dmg;
            spawnDamagePopup(next.x, next.y - 14, dmg, next.hp <= 0);
            if (next.hp <= 0 && next.alive) {
              next.alive = false; game.score += 100; game.killCount++;
              createExplosion(next.x, next.y, 'small');
            }
            game._teslaBolts.push({ x1: prev.x, y1: prev.y, x2: next.x, y2: next.y, life: 14 });
            hit.add(next);
            prev = next;
          }
          s.fireCd = teslaCdNew;
          playSfx('shoot', { vol: 0.4, src: { x: s.x, y: s.y } });
        }
      }
    }
  }
  // Tick smoke clouds + clean up
  if (game._smokeClouds) {
    for (let i = game._smokeClouds.length - 1; i >= 0; i--) {
      const c = game._smokeClouds[i];
      c.life--;
      if (c.life <= 0) game._smokeClouds.splice(i, 1);
    }
  }
  // Tick tesla bolts (visual decay only — damage already applied at fire time)
  if (game._teslaBolts) {
    for (let i = game._teslaBolts.length - 1; i >= 0; i--) {
      game._teslaBolts[i].life--;
      if (game._teslaBolts[i].life <= 0) game._teslaBolts.splice(i, 1);
    }
  }
  // Tick EMP pulse rings (visual only)
  if (game._empPulses) {
    for (let i = game._empPulses.length - 1; i >= 0; i--) {
      game._empPulses[i].life--;
      if (game._empPulses[i].life <= 0) game._empPulses.splice(i, 1);
    }
  }
  // Tick auto drones (drone bay): home on target + detonate on contact
  if (game._autoDrones) {
    for (let i = game._autoDrones.length - 1; i >= 0; i--) {
      const d = game._autoDrones[i];
      d.life--;
      // Re-target if current is dead
      if (!d.target || !d.target.alive) {
        d.target = enemies.find(e => e.alive);
      }
      if (d.target) {
        const dx = d.target.x - d.x, dy = d.target.y - d.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 24) {
          // Detonate: AOE damage
          createExplosion(d.x, d.y, 'small');
          playSfx('death', { vol: 0.4, src: { x: d.x, y: d.y } });
          for (const e of enemies) {
            if (!e.alive) continue;
            const ed = Math.hypot(e.x - d.x, e.y - d.y);
            if (ed < d.blastR) {
              const dmg = Math.round(d.dmg * (1 - ed / d.blastR));
              e.hp -= dmg;
              if (e.hp <= 0 && e.alive) {
                e.alive = false; game.score += 100; game.killCount++;
                createExplosion(e.x, e.y, 'small');
              }
            }
          }
          game._autoDrones.splice(i, 1);
          continue;
        }
        // Home — soft steering toward target
        const ux = dx / (dist || 1), uy = dy / (dist || 1);
        d.vx = d.vx * 0.85 + ux * d.speed * 0.4;
        d.vy = d.vy * 0.85 + uy * d.speed * 0.4;
        d.x += d.vx; d.y += d.vy;
      } else {
        // No target — fly forward then expire
        d.x += d.vx; d.y += d.vy;
      }
      if (d.life <= 0 || d.hp <= 0) game._autoDrones.splice(i, 1);
    }
  }
  // Tick footprints
  if (game._footprints) {
    for (let i = game._footprints.length - 1; i >= 0; i--) {
      game._footprints[i].life--;
      if (game._footprints[i].life <= 0) game._footprints.splice(i, 1);
    }
  }
}

// Camera structures extend shared vision — used by line-of-sight checks for
// auto-aim and minimap reveal. Returns true if any friendly camera (or
// normal blue unit) can see (sx, sy).
function cameraCanSee(sx, sy) {
  if (!game._structures) return false;
  for (const s of game._structures) {
    if (s.kind !== 'camera' || s.hp <= 0) continue;
    const def = STRUCTURE_DEFS.camera;
    if (Math.hypot(sx - s.x, sy - s.y) <= def.visionR) {
      if (lineOfSight(s.x, s.y, sx, sy)) return true;
    }
  }
  return false;
}

// Damage closest structure on bullet hit. Called from updateBullets when
// the bullet enters a structure's bbox. Returns true if hit was absorbed.
function bulletHitStructure(b) {
  if (!game._structures) return false;
  for (let i = 0; i < game._structures.length; i++) {
    const s = game._structures[i];
    const def = STRUCTURE_DEFS[s.kind]; if (!def || s.hp <= 0) continue;
    const r = def.size / 2;
    if (Math.abs(b.x - s.x) <= r && Math.abs(b.y - s.y) <= r) {
      // Friendly fire on own structures: skip (player + own turret bullets)
      if (b.team === 0) continue;
      s.hp -= b.dmg || 12;
      spawnDamagePopup && spawnDamagePopup(b.x, b.y, b.dmg || 12, false);
      return true;
    }
  }
  return false;
}

// Trigger an airstrike at world (wx, wy) — costs 0 energy, but consumes a
// terminal's cooldown. Drops 4 explosions in a 180u cluster after a 1.2s
// telegraph so enemies can scatter.
function callAirstrike(wx, wy) {
  if (!game._structures) return false;
  const term = game._structures.find(s => s.kind === 'terminal' && s.hp > 0 && s.airstrikeCd <= 0);
  if (!term) {
    showSwapToast(T('终端冷却中或已损毁', 'Terminal on cooldown / destroyed'));
    return false;
  }
  term.airstrikeCd = STRUCTURE_DEFS.terminal.airstrikeCd;
  showSwapToast(T('空中支援呼叫中…', 'Air support inbound…'));
  // Telegraph: red ground markers for ~1.2s, then 4 explosions
  game._airstrikes = game._airstrikes || [];
  game._airstrikes.push({ x: wx, y: wy, t: 0, fired: false });
  return true;
}

function updateAirstrikes() {
  if (!game._airstrikes) return;
  for (let i = game._airstrikes.length - 1; i >= 0; i--) {
    const a = game._airstrikes[i];
    a.t++;
    if (a.t >= 72 && !a.fired) {
      a.fired = true;
      // 4 explosions in a cross pattern
      const offsets = [[0,0],[100,80],[-100,80],[0,-110]];
      for (const [ox, oy] of offsets) {
        const ex = a.x + ox, ey = a.y + oy;
        createExplosion(ex, ey, 'big');
        // Phase 111 — airstrike booms use the new boom kind.
        emitSound(ex, ey, 1500, false, false, null, 'boom');
        // Damage all enemies in radius
        for (const e of enemies) {
          if (!e.alive) continue;
          const d = Math.hypot(e.x - ex, e.y - ey);
          if (d < 130) {
            e.hp -= Math.round(70 * (1 - d / 130));
            if (e.hp <= 0) { e.alive = false; e.hp = 0; createExplosion(e.x, e.y, 'small'); }
          }
        }
      }
      playSfx('death', { vol: 0.7 });
    }
    if (a.t >= 90) game._airstrikes.splice(i, 1);
  }
}

// Build mode toggle state. Picks one of STRUCTURE_ORDER and shows a
// preview at cursor. While in build mode, mouse-click places; build
// mode auto-disables on Esc / right-click.
const buildMode = { active: false, radialOpen: false, kind: 'wall', radialCat: null };
// Three-state build flow: OFF → RADIAL_OPEN → PLACING. B walks the cycle
// forward; Esc bails out anywhere. Activating from OFF opens the radial
// straight away so the user can pick a module without an extra click.
function toggleBuildMode() {
  // Building works in any in-match state — skirmish + campaign both. Was
  // gated on game._nnMode which made B a no-op in campaign even though
  // initMission already seeds _energy / _structures for missions with a
  // setupStructures hook. User: '建造模式輪盤不見'.
  if (game.state !== 'playing') {
    showSwapToast(T('未在战场中', 'Not on the battlefield'));
    return;
  }
  // Lazy-init the build economy so B works in campaign missions that
  // didn't pre-seed via setupStructures (convoy / blackbox / capture /
  // breach / hive). Player gets a starting 100⚡ on first press.
  if (game._energy == null) game._energy = 100;
  if (!game._structures) game._structures = [];
  if (!buildMode.active) {
    // CLOSED → open wheel
    buildMode.active = true;
    buildMode.radialOpen = true;
    // FTUE: opening the build radial advances step 3 → step 4 (place one)
  } else if (buildMode.radialOpen) {
    // WHEEL OPEN → close wheel; if a kind is already armed, stay in
    // placing mode (so the player can re-place after a wheel preview).
    // If no kind picked yet, exit cleanly.
    if (buildMode.kind) {
      buildMode.radialOpen = false;
    } else {
      exitBuildMode();
    }
  } else {
    // PLACING-MODE ARMED → next B exits entirely. Per user feedback
    // ('我不想要一直在待放置的階段...再按一次 B 就是回去正常的選項'),
    // pressing B a third time is the cancel/exit, not "reopen wheel".
    // To re-pick a different module: exit, then press B again to open.
    exitBuildMode();
  }
  buildMode._dragStart = null;
  buildMode._dragEnd   = null;
}
function exitBuildMode() {
  buildMode.active = false;
  buildMode.radialOpen = false;
  buildMode._dragStart = null;
  buildMode._dragEnd   = null;
}

// ============ BUILD PLACEMENT HELPERS (deduped) ============
// Build-mode constants. Magic numbers used to be inline at every callsite,
// which made it brittle to tune (changing 200 → 240 px reach meant
// hunting 4 places). Centralised here.
const BUILD_REACH_PX = 200;
const BUILD_SNAP_PX  = 30;
// arena-mp: these constants + the Bresenham line walker were defined inside
// the (now-cut) Map Editor module, but drag-to-line wall PREVIEW + PLACE in
// build mode still relies on them. Restored here so wall drag doesn't throw
// 'ReferenceError: _editorLineCells is not defined' on every render.
const EDITOR_BLOCK = 60;     // editor used 60u snap; build mode passes finer step
const EDITOR_WALL_STEP = 18; // ~18u wall thickness; kept for any remaining refs

// Bresenham cell-walker from (ax,ay) to (bx,by) snapped to `step`. Used by
// build mode's drag-line wall preview + placement so a long drag ghosts (and
// then places) a continuous line of wall segments rather than just endpoints.
function _editorLineCells(ax, ay, bx, by, step) {
  const s = step || EDITOR_BLOCK;
  const cells = [];
  let x0 = Math.round(ax / s), y0 = Math.round(ay / s);
  const x1 = Math.round(bx / s), y1 = Math.round(by / s);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let safety = 4096;
  while (safety-- > 0) {
    cells.push({ cx: x0 * s, cy: y0 * s });
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 <  dx) { err += dx; y0 += sy; }
  }
  return cells;
}

// Single source of truth for "is the player allowed to place / interact
// with the build wheel right now?". Used by mouse + touch + render.
// Keeps the predicate honest: any new gate (e.g. a future
// game._buildLock) only updates this one place.
function _canBuildPlace() {
  return buildMode.active
      && game.state === 'playing'
      && !game._paused
      && game.mode === 'tactical';     // §A.4 — UAV / FPV view doesn't place
}

// Snap a screen pixel to the build grid + check it's within reach of the
// player. Returns null if out of reach or player is dead. Otherwise an
// object the caller can place at: { gx, gy }. Toast-on-fail is opt-in via
// `withToast`. Used by mouse + touch + FTUE wall-placement watcher so
// they can't drift apart.
function _snapAndCheckPlace(screenX, screenY, withToast) {
  if (!player || !player.alive) return null;
  const wp = screenToWorld(screenX, screenY);
  const gx = Math.round(wp.x / BUILD_SNAP_PX) * BUILD_SNAP_PX;
  const gy = Math.round(wp.y / BUILD_SNAP_PX) * BUILD_SNAP_PX;
  if (Math.hypot(gx - player.x, gy - player.y) > BUILD_REACH_PX) {
    if (withToast && typeof showSwapToast === 'function') {
      showSwapToast(T('太远 · 走近一点', 'Too far · step closer'));
    }
    return null;
  }
  return { gx, gy };
}
