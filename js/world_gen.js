// ============ WORLD GEN ============
// Per-match world construction: clears state, picks a map from MAPS,
// runs its build() to spawn buildings/covers/trees/routes, sets player
// spawn, populates landmark cache, etc.
//
// Classic-script. Declares globally (~20 functions):
//   generateWorld(mapIndex) · clearWorld()
//   addBuilding / addLowCover / addOverhead / addRoute / addLandmark /
//   addDecoration / addThemeShape / addTree / addNetworkNode
//   buildCoverPoints() · isWalkable(x, y, r) · etc.
//
// External deps: WORLD · MAPS · currentMap · buildings · lowCovers ·
//   overheads · routes · landmarks · themeShapes · decorations · trees ·
//   networkNodes · enemies · allies · player

function generateWorld(mapIndex) {
  clearWorld();
  currentMap = MAPS[mapIndex % MAPS.length];
  currentMap.build();
  buildCoverPoints();
  // Move player to map's spawn
  if (currentMap.playerSpawn) {
    player.x = currentMap.playerSpawn.x;
    player.y = currentMap.playerSpawn.y;
  } else {
    player.x = WORLD.w/2; player.y = WORLD.h/2;
  }
}

// Generate cover positions adjacent to every full obstacle and every low cover.
// Each point sits ~32u outside the obstacle on one of its four sides;
// soldiers stand here to put the obstacle between them and a threat.
function buildCoverPoints() {
  coverPoints.length = 0;
  const offset = 32;
  const sources = [...buildings, ...lowCovers];
  for (const r of sources) {
    const cx = r.x + r.w/2, cy = r.y + r.h/2;
    coverPoints.push({ x: cx,             y: r.y - offset,    ownerCx: cx, ownerCy: cy });
    coverPoints.push({ x: cx,             y: r.y + r.h+offset,ownerCx: cx, ownerCy: cy });
    coverPoints.push({ x: r.x - offset,   y: cy,              ownerCx: cx, ownerCy: cy });
    coverPoints.push({ x: r.x+r.w+offset, y: cy,              ownerCx: cx, ownerCy: cy });
  }
}

// Find the best cover from `threat` reachable from (myX, myY).
// "Best" = nearest cover point such that the obstacle blocks LoS from threat.
// Returns null if no cover available.
function findCover(myX, myY, threatX, threatY, maxDist = 600) {
  let best = null, bestD = Infinity;
  for (const cp of coverPoints) {
    const d = Math.hypot(cp.x - myX, cp.y - myY);
    if (d < 24 || d > maxDist) continue;
    // Cover only counts if the obstacle actually breaks LoS from the threat.
    if (lineOfSight(threatX, threatY, cp.x, cp.y)) continue;
    // Tiny penalty for cover already in front of (closer to) threat than us
    const tDist = Math.hypot(cp.x - threatX, cp.y - threatY);
    const myDist = Math.hypot(myX - threatX, myY - threatY);
    const score = d + Math.max(0, myDist - tDist) * 0.5;
    if (score < bestD) { best = cp; bestD = score; }
  }
  return best;
}

// "Peek angle" from a cover point: the direction perpendicular to the cover's
// shielded direction, so the unit can step out a half-step to fire.
function peekOffset(cp, threatX, threatY) {
  // Vector from cover to threat (the dir we want to peek along)
  const a = Math.atan2(threatY - cp.y, threatX - cp.x);
  // We don't actually move into the obstacle; offset slightly toward threat
  return { x: cp.x + Math.cos(a)*18, y: cp.y + Math.sin(a)*18 };
}

// Phase 135.2 — staggered spawn queue. In NN Arena bias the spawns get
// queued with fireAt timestamps so they trickle in over SPAWN_WINDOW
// instead of dumping the whole wave on a single frame. tickPendingNNSpawns
// (called from the nn_deathmatch mission tick) drains the queue. For
// non-NN biases (campaign etc.) we still spawn immediately — the visual
// problem ("一堆從同樣地方走出來") was specific to nnArena spawn pattern.
const SPAWN_WINDOW_TICKS = 5 * 60;   // 5 s of staggered arrivals
function spawnWave(n) {
  const cfg = currentMap.spawn;
  const numSoldiers = cfg.soldierBase + (n - 1) * cfg.soldierPerWave;
  const numDrones   = cfg.droneBase   + (n - 1) * cfg.dronePerWave;
  const stagger = (cfg.bias === 'nnArena');
  if (!stagger) {
    for (let i = 0; i < numSoldiers; i++) spawnSoldier(cfg);
    for (let i = 0; i < numDrones; i++) spawnDroneEnemy(cfg);
    return;
  }
  // NN Arena: enqueue with per-unit delays so the spawn feels like a
  // multi-direction skirmish rather than a single batch dropping in.
  if (!game._pendingNNSpawns) game._pendingNNSpawns = [];
  const total = numSoldiers + numDrones;
  const now = (typeof game !== 'undefined' && game.time != null) ? game.time : 0;
  for (let i = 0; i < numSoldiers; i++) {
    const delay = (total > 1 ? (i / Math.max(1, total - 1)) : 0) * SPAWN_WINDOW_TICKS;
    game._pendingNNSpawns.push({ type: 'soldier', fireAt: now + delay, cfg });
  }
  for (let i = 0; i < numDrones; i++) {
    const delay = ((numSoldiers + i) / Math.max(1, total - 1)) * SPAWN_WINDOW_TICKS;
    game._pendingNNSpawns.push({ type: 'drone', fireAt: now + delay, cfg });
  }
}

// Drain ready-to-fire spawns from the queue. Called from
// js/missions/nn_deathmatch.js per-tick. Safe no-op when queue empty.
function tickPendingNNSpawns() {
  const q = game._pendingNNSpawns;
  if (!q || q.length === 0) return;
  const now = game.time;
  // Walk backwards so splice doesn't shift unprocessed entries.
  for (let i = q.length - 1; i >= 0; i--) {
    const p = q[i];
    if (now >= p.fireAt) {
      if (p.type === 'soldier') spawnSoldier(p.cfg);
      else if (p.type === 'drone') spawnDroneEnemy(p.cfg);
      q.splice(i, 1);
    }
  }
}

function pickBiasedSpawn(bias) {
  // Returns {x, y} biased to the map's combat rhythm.
  const lm = landmarks[0];
  const r = () => Math.random();
  switch (bias) {
    case 'landmarkRing': {
      if (lm) {
        const a = r() * Math.PI*2;
        const dist = (lm.r || 240) + 200 + r()*200;
        return { x: lm.x + Math.cos(a)*dist, y: lm.y + Math.sin(a)*dist };
      }
      break;
    }
    case 'gantry': {
      // Spawn along the long edges (under elevated rails)
      const top = r() < 0.5;
      return { x: 200 + r()*(WORLD.w-400), y: top ? WORLD.h*0.20 : WORLD.h*0.80 };
    }
    case 'corridor': {
      // Container alleys — spawn along horizontal alley lines
      const alley = Math.floor(r()*4);
      return { x: WORLD.w*0.30 + r()*WORLD.w*0.60, y: 320 + alley*180 + r()*40 };
    }
    case 'nodes': {
      // Around capture nodes
      if (lm && lm.capturePoints) {
        const n = lm.capturePoints[Math.floor(r()*lm.capturePoints.length)];
        const a = r()*Math.PI*2;
        const d = 120 + r()*120;
        return { x: n.x + Math.cos(a)*d, y: n.y + Math.sin(a)*d };
      }
      break;
    }
    case 'pad': {
      // Around the map's hex pads — sparse ground enemies on open
      const a = r() * Math.PI*2;
      const d = 800 + r()*400;
      return { x: WORLD.w/2 + Math.cos(a)*d, y: WORLD.h*0.40 + Math.sin(a)*d };
    }
    case 'ringFromPlayer': {
      // Skirmish: 700-1100u from the player on a random arc — close enough to
      // be inside their detection range, but with maze cover between them.
      const a = r() * Math.PI*2;
      const d = 700 + r()*400;
      return { x: player.x + Math.cos(a)*d, y: player.y + Math.sin(a)*d };
    }
    case 'nnArena': {
      // Phase 135.1 — distribute enemy spawns across all 4 arena edges.
      // Was: every enemy stacked on the right edge at 4 fixed y-positions
      // → user report '一堆從同樣的地方走出來,走向同一個地方'. Now each
      // enemy goes to a different edge round-robin (N→E→S→W→N...) with a
      // random position along that edge. Position inset from corners so
      // squads don't converge on the same diagonal approach line, and
      // inset from edge so they're inside the NN_ARENA clamp (visible
      // from frame 1, no "stuck on edge" clamp tug).
      const INSET_FROM_CORNER = 220;
      const INSET_FROM_EDGE   = 40;
      // Combined count (live + pending) so the round-robin index keeps
      // incrementing even while Phase 135.2's queued spawns are pending.
      const pendingN = (typeof game !== 'undefined' && game._pendingNNSpawns)
        ? game._pendingNNSpawns.length : 0;
      const idx  = enemies.length + pendingN;
      const edge = idx % 4;                // 0=N, 1=E, 2=S, 3=W
      const t    = r();
      const aw = NN_ARENA.w, ah = NN_ARENA.h;
      const x0 = NN_ARENA.x0, y0 = NN_ARENA.y0;
      let x, y;
      switch (edge) {
        case 0:   // North
          x = x0 + INSET_FROM_CORNER + t * (aw - 2 * INSET_FROM_CORNER);
          y = y0 + INSET_FROM_EDGE;
          break;
        case 1:   // East
          x = x0 + aw - INSET_FROM_EDGE;
          y = y0 + INSET_FROM_CORNER + t * (ah - 2 * INSET_FROM_CORNER);
          break;
        case 2:   // South
          x = x0 + INSET_FROM_CORNER + t * (aw - 2 * INSET_FROM_CORNER);
          y = y0 + ah - INSET_FROM_EDGE;
          break;
        default:  // West
          x = x0 + INSET_FROM_EDGE;
          y = y0 + INSET_FROM_CORNER + t * (ah - 2 * INSET_FROM_CORNER);
      }
      return { x, y };
    }
  }
  // Default: ring around player
  const a = r() * Math.PI*2;
  const d = 700 + r()*500;
  return { x: player.x + Math.cos(a)*d, y: player.y + Math.sin(a)*d };
}

function spawnSoldier(cfg) {
  let x, y, ok = false, tries = 0;
  while (!ok && tries < 50) {
    const p = pickBiasedSpawn(cfg ? cfg.soldierBias : null);
    x = p.x; y = p.y;
    if (x < 50 || x > WORLD.w-50 || y < 50 || y > WORLD.h-50) { tries++; continue; }
    ok = true;
    for (const b of buildings) {
      if (x > b.x-20 && x < b.x+b.w+20 && y > b.y-20 && y < b.y+b.h+20) { ok = false; break; }
    }
    // Don't spawn too close to player
    if (Math.hypot(x - player.x, y - player.y) < 380) ok = false;
    tries++;
  }
  if (!ok) { x = player.x + 700; y = player.y; }
  // Defensive defaults — partial cfg (e.g. {soldierBias:'…'} alone) should
  // still produce finite stats. Previously soldierSpeedMul=undefined → NaN
  // speed → enemies with NaN positions stuck invisible after one tick.
  const speedMul = (cfg && cfg.soldierSpeedMul != null) ? cfg.soldierSpeedMul : 1;
  const fast = !!(cfg && cfg.soldierFireFast);
  // NN-merge + roster variety: campaign enemies pull random chassis / NN
  // style / weapon from weighted pools. User: '戰役中的角色、載具、武器…
  // 多樣一點,不用全部都一樣'. Pools below tilt toward standard humanoid
  // riflemen (the baseline threat) but mix in fast wolves, heavy LMG
  // gunners, sharpshooters with snipers, etc. Each soldier still carries
  // _useNN: true so nnTick drives them; chassis multiplier shapes hp /
  // speed / hitbox via applyChassisToUnit.
  const chassisRoll = Math.random();
  const chassisId = chassisRoll < 0.65 ? 'humanoid'
                  : chassisRoll < 0.88 ? 'wolf'
                  :                      'heavy';
  // Style pick — biased toward 'elite' but with variety. Skip 'tactical'
  // (it falls back to elite weights anyway) so we don't waste a slot.
  const styleRoll = Math.random();
  const nnStyle = styleRoll < 0.40 ? 'elite'
                : styleRoll < 0.62 ? 'warrior'
                : styleRoll < 0.80 ? 'sharpshooter'
                : styleRoll < 0.92 ? 'defensive'
                :                    'cqb';
  // Weapon — wolves get fast/light, heavies get LMG/SHOTGUN, riflemen
  // anything from the standard pool.
  let weaponId;
  if (chassisId === 'wolf')        weaponId = (Math.random() < 0.6 ? 'SMG' : 'SHOTGUN');
  else if (chassisId === 'heavy')  weaponId = (Math.random() < 0.7 ? 'LMG' : 'SHOTGUN');
  else                              weaponId = pickRandomNNWeaponId();   // RIFLE / SMG / LMG / SNIPER / SHOTGUN
  // Sharpshooters always get SNIPER (their style trained on it)
  if (nnStyle === 'sharpshooter')  weaponId = 'SNIPER';
  if (nnStyle === 'cqb' && chassisId !== 'heavy') weaponId = (Math.random() < 0.7 ? 'SMG' : 'SHOTGUN');
  const enemyDef = {
    x, y,
    angle: 0, gunAngle: 0, gunRecoil: 0, swayPhase: Math.random()*Math.PI*2,
    fireCd: (fast ? 30 : 60) + Math.random()*60,
    fireRate: fast ? 32 : 50,
    alive: true,
    walkPhase: Math.random() * Math.PI * 2,
    team: 1,
    _weapon: WEAPONS[weaponId] || WEAPONS.RIFLE,
    _useNN: true, _nnFireCd: 0, _nnRecentDmg: 0, _nnLastSeenTick: -9999,
    _nnDifficulty: nnStyle,
    _respawnAt: null,
    callsign: 'R' + (Math.random().toString(36).slice(2,5).toUpperCase()),
  };
  // Chassis stats — applyChassisToUnit sets _chassis, speed, hp, maxHp,
  // radius. Base values tuned for skirmish (speed 2.5, hp 80, radius 13).
  applyChassisToUnit(enemyDef, chassisId, 2.5 * speedMul, 80, 13);
  enemies.push(enemyDef);
}

function spawnDroneEnemy(cfg) {
  let x, y;
  const bias = cfg ? cfg.droneBias : null;
  if (bias === 'overhead' && overheads.length) {
    const o = overheads[Math.floor(Math.random()*overheads.length)];
    x = o.x + Math.random()*o.w;
    y = o.y + Math.random()*o.h;
  } else if (bias === 'hive' && landmarks[0]) {
    const lm = landmarks[0];
    const a = Math.random()*Math.PI*2;
    const d = (lm.r || 200) + 80 + Math.random()*200;
    x = lm.x + Math.cos(a)*d;
    y = lm.y + Math.sin(a)*d;
  } else if (bias === 'open') {
    x = 200 + Math.random()*(WORLD.w-400);
    y = 100 + Math.random()*(WORLD.h-200);
  } else {
    const a = Math.random() * Math.PI * 2;
    const d = 600 + Math.random() * 400;
    x = player.x + Math.cos(a)*d;
    y = player.y + Math.sin(a)*d;
  }
  x = Math.max(60, Math.min(WORLD.w-60, x));
  y = Math.max(60, Math.min(WORLD.h-60, y));
  enemyDrones.push({
    x, y,
    hp: 18, maxHp: 18,
    radius: 11,
    alive: true,
    angle: Math.atan2(player.y - y, player.x - x),
    // Phase 7 (user feedback '飛得更快 ... 更痛'):
    //   speed       3.4+0.8  → 5.5+1.5  (now 5.5–7.0; ~70% faster)
    //   turnRate    0.034    → 0.046   (slightly more tracking — harder to dodge)
    //   explodeR    55       → 100     (~82% bigger blast — area-denial threat)
    //   explodeDmg  35       → 75      (>2× pain; still survivable at full HP via falloff)
    speed: 5.5 + Math.random()*1.5,
    turnRate: 0.046,
    armed: true,
    hoverPhase: Math.random()*Math.PI*2,
    explodeRadius: 100,
    explodeDamage: 75,
  });
}


// ============ WORLD GEN HELPERS (R7 refactor) ============
// 9 add* helpers moved here from index.html (4559-4627) where they
// were intermingled with rendering, HUD, and combat code. Each helper
// just pushes one entry onto a corresponding state array declared in
// index.html (buildings / lowCovers / overheads / routes / landmarks /
// themeShapes / decorations / networkNodes / wallLines). Resolution
// happens at call time via classic-script globals, so this file can
// load before those arrays exist as long as the helpers aren't
// CALLED until after the main inline script runs (which is when
// generateWorld() → currentMap.build() fires).
//
// HP fallback comes from COVER_HP_BY_KIND, declared in index.html at
// ~line 4549 (right before where these helpers used to live). Same
// call-time-resolution rule applies.

function addBuilding(x, y, w, h, color, opts={}) {
  const baseHp = COVER_HP_BY_KIND[opts.kind || 'building'] || 220;
  const hp = opts.hp != null ? opts.hp : baseHp;
  buildings.push({ x, y, w, h, color: color || COLORS.gray, shadow: opts.shadow !== false, accent: !!opts.accent, kind: opts.kind || 'building', hp, maxHp: hp });
}
function addWallLine(x1, y1, x2, y2, opts={}) {
  const thickness = opts.thickness != null ? opts.thickness : 18;
  const baseHp    = COVER_HP_BY_KIND[opts.kind || 'building'] || 220;
  const hp        = opts.hp != null ? opts.hp : baseHp;
  wallLines.push({
    x1, y1, x2, y2, thickness,
    kind: opts.kind || 'building',
    color: opts.color || COLORS.gray,
    hp, maxHp: hp,
    blocksLOS: opts.blocksLOS !== false,
  });
}
function addLowCover(x, y, w, h, color, opts={}) {
  const baseHp = COVER_HP_BY_KIND[opts.kind || 'cover'] || 100;
  const hp = opts.hp != null ? opts.hp : baseHp;
  lowCovers.push({ x, y, w, h, color: color || COLORS.lightGray, kind: opts.kind || 'cover', canopy: !!opts.canopy, hp, maxHp: hp });
}
function addOverhead(x, y, w, h, color, opts={}) {
  overheads.push({ x, y, w, h, color: color || COLORS.black, kind: opts.kind || 'catwalk' });
}
function addRoute(x, y, w, h, type, opts={}) {
  routes.push({ x, y, w, h, angle: opts.angle || 0, type, style: opts.style || 'solid', label: opts.label || '' });
}
function addLandmark(obj) { landmarks.push(obj); }
function addTheme(shape) { themeShapes.push(shape); }
function addDecoration(x, y, type, size, color, opacity, angle) {
  decorations.push({ x, y, type, size, color, opacity, angle });
}
function addNode(x, y) { networkNodes.push({ x, y, pulse: Math.random()*Math.PI*2 }); }
