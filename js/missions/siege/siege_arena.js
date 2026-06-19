// ============ SIEGE — BASTION-7 ARENA (purpose-built fort) ============
// "The Long Night at Bastion-7." A concentric fort the player DEFENDS — the
// spine of the 守城 redesign (SIEGE_BLUEPRINT §5). NOT survival_fort (a left-
// half east-facing bunker, wrong shape for a 360° siege).
//
// The engine's generic buildNNArenaVariant() loop strips any custom id off a
// wall (addBuilding only carries kind/accent/colour), so the fort can't be
// authored as plain variant data and still expose NAMED, breachable segments
// (curtainN / innerN / keep…) that the director + breacher-tanks target by id.
// So the geometry is built by buildSiegeFort() — it calls addBuilding /
// structure-push directly and STAMPS `_segId` onto each created buildings[]
// entry (the same buildings[buildings.length-1] trick the old _siegeMakeTank
// used), returning a fort REGISTRY (named segments + gate anchors + Heart +
// Armory + murder-hole footings). The siege mission factory's setupStructures()
// calls buildSiegeFort(); the variant's walls() stays empty.
//
// Coordinates are arena-relative (NN_ARENA origin x0,y0 added at place time;
// x0=y0=0 today). Arena is 1800×1800, centre (900,900) = the Heart.
//
// Classic-script globals declared here:
//   buildSiegeFort()  siegeFort()  siegeSeg(id)  siegeGateAnchor(dir)
//   _siegeFortSegIds()  (test accessor)  + the siege_bastion NN_MAP_VARIANTS entry
// Call-time deps: NN_ARENA · buildings · addBuilding · addLowCover · game ·
//   STRUCTURE_DEFS · COLORS · buildCoverPoints · addOverhead · addLandmark

// ── Fort tunables (all HP / radius knobs in one place) ───────────────────────
const SIEGE_FORT = {
  cx: 900, cy: 900,                 // arena centre = the Heart
  curtainHp:   160,                 // OUTER CURTAIN — fragile, MEANT to fall fast under a mass
  gateLeafHp:  110,                 // NORTH GATE leaf — weakest, weldable shut
  innerHp:     380,                 // INNER WALL — the real line (holds longer, but yields)
  keepHp:      700,                 // INNER KEEP — bunker-grade last fallback (the last stand)
  heartHp:    1200,                 // REACTOR CORE / the HEART (lose condition)
  armoryHp:    500,                 // ARMORY (factory — clamps to 1, never dies)
  curtainR:    340,                 // half-extent of the outer curtain square
  innerR:      200,                 // half-extent of the inner wall square
  keepR:        90,                 // half-extent of the inner keep square
  curtainT:     24,                 // wall thickness
  innerT:       28,
  keepT:        24,
};

// Module-level fort registry (also stored on game._siege.fort when present).
let _siegeFort = null;

function siegeFort() { return _siegeFort; }

// Find a named wall segment in buildings[] by exact id, then logical alias,
// then prefix (so a director cue target:'curtainN' resolves to the gate-leaf
// or the first north-curtain segment). Returns the live building object or null.
function siegeSeg(id) {
  if (!id || typeof buildings === 'undefined' || !buildings) return null;
  const _ALIAS = { curtainN: 'gateLeafN', innerN: 'innerN_w', innerE: 'innerE_n',
                   innerS: 'innerS_w', innerW: 'innerW_n', curtainE: 'curtainE_n',
                   curtainS: 'curtainS_w', curtainW: 'curtainW_n' };
  const want = _ALIAS[id] || id;
  let exact = null, prefix = null;
  for (const b of buildings) {
    if (!b || !b._segId) continue;
    if (b._segId === want) { exact = b; break; }
    if (!prefix && (b._segId === id || b._segId.indexOf(id) === 0)) prefix = b;
  }
  return exact || prefix || null;
}

// Just-outside-the-gate anchor for red spawns / director bias (N/E/S/W).
function siegeGateAnchor(dir) {
  if (_siegeFort && _siegeFort.gateAnchors && _siegeFort.gateAnchors[dir]) {
    return _siegeFort.gateAnchors[dir];
  }
  // Fallback to arena edges if the fort hasn't built yet.
  const x0 = (typeof NN_ARENA !== 'undefined') ? NN_ARENA.x0 : 0;
  const y0 = (typeof NN_ARENA !== 'undefined') ? NN_ARENA.y0 : 0;
  const c = { N: { x: 900, y: 500 }, E: { x: 1300, y: 900 },
              S: { x: 900, y: 1300 }, W: { x: 500, y: 900 } }[dir] || { x: 900, y: 500 };
  return { x: x0 + c.x, y: y0 + c.y };
}

// Test accessor — every stamped segment id currently in buildings[].
function _siegeFortSegIds() {
  if (typeof buildings === 'undefined' || !buildings) return [];
  return buildings.filter(b => b && b._segId).map(b => b._segId);
}

// ── THE CONSTRUCTOR — build the concentric fort into the world arrays ─────────
// Returns the fort registry; also stores it on game._siege.fort (if game._siege
// is the siege state object) and the module-level _siegeFort.
function buildSiegeFort() {
  if (typeof buildings === 'undefined' || typeof addBuilding !== 'function') return null;
  const F = SIEGE_FORT;
  const x0 = (typeof NN_ARENA !== 'undefined') ? NN_ARENA.x0 : 0;
  const y0 = (typeof NN_ARENA !== 'undefined') ? NN_ARENA.y0 : 0;
  const cx = F.cx, cy = F.cy;
  const gray   = (typeof COLORS !== 'undefined' && COLORS.gray) ? COLORS.gray : '#3A3A3A';
  const charred = '#2A2520';                 // scorched dark — the fort reads as burnt-out ruins (廢墟)
  const accentC = (typeof COLORS !== 'undefined' && COLORS.red) ? COLORS.red : '#C8261C';

  const segs = {};
  const footings = [];

  // seg(): place a named, breachable building wall + stamp _segId on it.
  function seg(id, x, y, w, h, hp, opts) {
    opts = opts || {};
    addBuilding(x0 + x, y0 + y, w, h, opts.color || charred,
                { kind: opts.kind || 'building', accent: !!opts.accent, hp });
    const b = buildings[buildings.length - 1];
    if (b) {
      b._segId = id;
      b._siegeWall = true;
      b._siegeRing = opts.ring || null;       // 'curtain' | 'inner' | 'keep' | 'gate'
      if (opts.weldable) b._siegeWeldable = true;
      if (opts.indestructible) b._siegeIndestructible = true;
      if (opts.gateLeaf) b._siegeGateLeaf = true;
      segs[id] = b;
    }
    return b;
  }
  // pillar(): indestructible cover gate-post (flanks the north gate).
  function pillar(id, x, y, w, h) {
    if (typeof addLowCover !== 'function') return;
    const col = (typeof COLORS !== 'undefined' && COLORS.creamDark) ? COLORS.creamDark : '#8A7E63';
    addLowCover(x0 + x, y0 + y, w, h, col, { kind: 'crate' });
    const lc = (typeof lowCovers !== 'undefined' && lowCovers.length)
      ? lowCovers[lowCovers.length - 1] : null;
    if (lc) { lc._segId = id; lc._siegeIndestructible = true; }
  }
  // footing(): a record of where the player can drop a turret/tesla (murder-hole).
  function footing(x, y, kind) {
    footings.push({ x: x0 + x, y: y0 + y, kind: kind || 'turret', filled: false });
  }

  // ── OUTER CURTAIN (radius 340) — low HP, meant to fall; named gaps ──────────
  // North side with the wide NORTH GATE (weldable gate-leaf between two pillars).
  {
    const r = F.curtainR, t = F.curtainT, hp = F.curtainHp;
    const L = cx - r, R = cx + r, T = cy - r, B = cy + r;
    const gateHalf = 60;            // north gate gap half-width (120 wide)
    // North wall: left seg + GATE-LEAF (weldable) + right seg
    seg('curtainN_w', L, T, (cx - gateHalf) - L, t, hp, { ring: 'curtain' });
    seg('curtainN_e', cx + gateHalf, T, R - (cx + gateHalf), t, hp, { ring: 'curtain' });
    seg('gateLeafN',  cx - gateHalf, T, gateHalf * 2, t, F.gateLeafHp,
        { ring: 'gate', weldable: true, gateLeaf: true, accent: true, color: accentC });
    pillar('gatePostNW', cx - gateHalf - 14, T - 12, 16, t + 24);
    pillar('gatePostNE', cx + gateHalf - 2,  T - 12, 16, t + 24);

    // East side with the narrow EAST POSTERN (50 gap, no leaf — a kill-funnel).
    const postHalf = 25;
    seg('curtainE_n', R - t, T, t, (cy - postHalf) - T, hp, { ring: 'curtain' });
    seg('curtainE_s', R - t, cy + postHalf, t, B - (cy + postHalf), hp, { ring: 'curtain' });

    // West side with the WEST SALLY PORT (70 gap — your sortie exit).
    const sallyHalf = 35;
    seg('curtainW_n', L, T, t, (cy - sallyHalf) - T, hp, { ring: 'curtain' });
    seg('curtainW_s', L, cy + sallyHalf, t, B - (cy + sallyHalf), hp, { ring: 'curtain' });

    // South side with the permanent SOUTH COLLAPSE (140 gap, pre-broken hole).
    const collapseHalf = 70;
    seg('curtainS_w', L, B - t, (cx - collapseHalf) - L, t, hp, { ring: 'curtain' });
    seg('curtainS_e', cx + collapseHalf, B - t, R - (cx + collapseHalf), t, hp, { ring: 'curtain' });
  }

  // ── INNER WALL (radius 200) — high HP, the real line; 4 murder-holes ────────
  {
    const r = F.innerR, t = F.innerT, hp = F.innerHp;
    const L = cx - r, R = cx + r, T = cy - r, B = cy + r;
    const mh = 30;                  // murder-hole half-gap (60 wide)
    // North
    seg('innerN_w', L, T, (cx - mh) - L, t, hp, { ring: 'inner' });
    seg('innerN_e', cx + mh, T, R - (cx + mh), t, hp, { ring: 'inner' });
    footing(cx, T + t + 18, 'turret');
    // South
    seg('innerS_w', L, B - t, (cx - mh) - L, t, hp, { ring: 'inner' });
    seg('innerS_e', cx + mh, B - t, R - (cx + mh), t, hp, { ring: 'inner' });
    footing(cx, B - t - 18, 'turret');
    // West
    seg('innerW_n', L, T, t, (cy - mh) - T, hp, { ring: 'inner' });
    seg('innerW_s', L, cy + mh, t, B - (cy + mh), hp, { ring: 'inner' });
    footing(L + t + 18, cy, 'tesla');
    // East
    seg('innerE_n', R - t, T, t, (cy - mh) - T, hp, { ring: 'inner' });
    seg('innerE_s', R - t, cy + mh, t, B - (cy + mh), hp, { ring: 'inner' });
    footing(R - t - 18, cy, 'tesla');
    // murder-hole lips (low cover) just inside each gap
    if (typeof addLowCover === 'function') {
      const lip = (lx, ly) => addLowCover(x0 + lx - 18, y0 + ly - 8, 36, 16,
        (typeof COLORS !== 'undefined' && COLORS.creamDark) ? COLORS.creamDark : '#8A7E63',
        { kind: 'sandbag' });
      lip(cx, T + t + 6); lip(cx, B - t - 6); lip(L + t + 6, cy); lip(R - t - 6, cy);
    }
  }

  // ── INNER KEEP (radius 90) — bunker-grade box round the Heart, S door ───────
  {
    const r = F.keepR, t = F.keepT, hp = F.keepHp;
    const L = cx - r, R = cx + r, T = cy - r, B = cy + r;
    const doorHalf = 28;            // keep door (S) — a one-tile plug
    seg('keepN', L, T, r * 2, t, hp, { ring: 'keep' });
    seg('keepW', L, T, t, r * 2, hp, { ring: 'keep' });
    seg('keepE', R - t, T, t, r * 2, hp, { ring: 'keep' });
    seg('keepS_w', L, B - t, (cx - doorHalf) - L, t, hp, { ring: 'keep' });
    seg('keepS_e', cx + doorHalf, B - t, R - (cx + doorHalf), t, hp, { ring: 'keep' });
  }

  // ── COURTYARD RUINS — rubble piles + cracked/scorched ground + drifting debris
  //    (廢墟/斷垣殘壁), all procedural (no sprite assets). Deterministic so the fort
  //    is identical every run. ──────────────────────────────────────────────────
  if (typeof addLowCover === 'function') {
    const rubCol = (typeof COLORS !== 'undefined' && COLORS.creamDark) ? COLORS.creamDark : '#8A7E63';
    const rub = (rx, ry, sz) => { sz = sz || 22; addLowCover(x0 + rx - sz, y0 + ry - sz, sz * 2, sz * 2, rubCol, { kind: 'crate' }); };
    rub(cx - 250, cy - 250); rub(cx + 250, cy - 250); rub(cx - 250, cy + 250); rub(cx + 250, cy + 250);
    rub(cx, cy - 270); rub(cx, cy + 270);
    rub(cx - 90, cy - 110, 16); rub(cx + 95, cy - 130, 18); rub(cx - 130, cy + 85, 15);
    rub(cx + 115, cy + 120, 17); rub(cx - 45, cy + 30, 14); rub(cx + 55, cy - 55, 16);
  }
  if (typeof addTheme === 'function') {
    try {
      const black = (typeof COLORS !== 'undefined' && COLORS.black) ? COLORS.black : '#1A1A1A';
      addTheme({ kind: 'rect', x: x0 + cx - 150, y: y0 + cy - 150, w: 300, h: 300, color: black, alpha: 0.10 });
      for (let i = 0; i < 9; i++) {
        const a0 = (Math.PI * 2 / 9) * i;
        addTheme({ kind: 'arc-stroke', cx: x0 + cx, cy: y0 + cy, r: 150 + (i % 3) * 55, a0, a1: a0 + 0.4, color: 'rgba(0,0,0,0.14)' });
      }
    } catch (e) { /* theme shapes are decorative */ }
  }
  if (typeof addDecoration === 'function') {
    try {
      const dcol = (typeof COLORS !== 'undefined' && COLORS.creamDark) ? COLORS.creamDark : '#8A7E63';
      for (let i = 0; i < 22; i++) {
        const ang = i * 2.39996;                 // golden-angle spread (deterministic)
        const dd = 70 + (i * 37 % 230);
        addDecoration(x0 + cx + Math.cos(ang) * dd, y0 + cy + Math.sin(ang) * dd,
                      (i % 2 ? 'triangle' : 'square'), 4 + (i % 4) * 3, dcol, 0.18 + (i % 3) * 0.06, ang);
      }
    } catch (e) { /* debris is decorative */ }
  }

  // ── CATWALKS — visual high-ground ringing the inner wall (optional) ─────────
  if (typeof addOverhead === 'function') {
    try {
      addOverhead(x0 + cx - F.innerR, y0 + cy - F.innerR, F.innerR * 2, 14, { kind: 'catwalk' });
      addOverhead(x0 + cx - F.innerR, y0 + cy + F.innerR - 14, F.innerR * 2, 14, { kind: 'catwalk' });
    } catch (e) { /* overhead is decorative — never block the fort on it */ }
  }

  // ── STRUCTURES: the HEART (spawn-relay) + the ARMORY (factory) ──────────────
  game._structures = game._structures || [];
  let heart = null, armory = null;
  if (typeof STRUCTURE_DEFS !== 'undefined' && STRUCTURE_DEFS['spawn-relay']) {
    heart = {
      kind: 'spawn-relay', x: x0 + cx, y: y0 + cy,
      hp: F.heartHp, maxHp: F.heartHp, size: STRUCTURE_DEFS['spawn-relay'].size,
      _isSpawnRelay: true, _isHeart: true, _team: 'blue',
      fireCd: 0, _placedAt: (game && game.time) || 0,
    };
    game._structures.push(heart);
  }
  if (typeof STRUCTURE_DEFS !== 'undefined' && STRUCTURE_DEFS['factory']) {
    armory = {
      kind: 'factory', x: x0 + cx + 150, y: y0 + cy,   // east side of the courtyard
      hp: F.armoryHp, maxHp: F.armoryHp, size: STRUCTURE_DEFS['factory'].size,
      _isFactory: true, _isArmory: true, _team: 'neutral',
      _captureProgress: 0, _captureBy: null, _nextProductionAt: 0,
      fireCd: 0, _placedAt: (game && game.time) || 0,
    };
    game._structures.push(armory);
  }
  if (typeof addLandmark === 'function') {
    try { addLandmark({ x: x0 + cx + 150, y: y0 + cy, kind: 'arena', name: 'ARMORY' }); }
    catch (e) { /* landmark is decorative */ }
  }

  // Regenerate cover points so NN pathing accounts for the fort walls (the
  // generic buildCoverPoints() ran during world-gen before this fort existed).
  if (typeof buildCoverPoints === 'function') { try { buildCoverPoints(); } catch (e) {} }

  _siegeFort = {
    heart, armory, segs, footings,
    center: { x: x0 + cx, y: y0 + cy },
    playerSpawn: { x: x0 + cx, y: y0 + cy + 55 },   // just south of the Heart, in the keep
    gateAnchors: {
      N: { x: x0 + cx,       y: y0 + cy - 400 },
      E: { x: x0 + cx + 400, y: y0 + cy },
      S: { x: x0 + cx,       y: y0 + cy + 400 },
      W: { x: x0 + cx - 400, y: y0 + cy },
    },
  };
  if (game && game._siege && typeof game._siege === 'object') game._siege.fort = _siegeFort;
  return _siegeFort;
}

// ── Register the siege_bastion map variant (geometry built by buildSiegeFort
//    from the factory's setupStructures(); walls() stays empty so the generic
//    loop places nothing). modes:['siege'] only. ───────────────────────────────
if (typeof NN_MAP_VARIANTS !== 'undefined') {
  NN_MAP_VARIANTS.push({
    id: 'siege_bastion', name: '巴斯提昂-7 BASTION-7',
    walls: () => [],
    spawn: { blue: { x: 900, y: 955 }, red: { x: 900, y: 500 } },
    modes: ['siege'],
  });
}
