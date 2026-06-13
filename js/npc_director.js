// ============ NPC DIRECTOR (Phase 182) — ADDITIVE NPC believability layer ====
// Goal: NPCs feel purposeful, spread out, and a little alive — WITHOUT replacing
// the existing PPO/NN brain, the patrol/combat state machine, or pathfinding.
// Everything here is a thin LAYER that the existing js/enemy_ai.js calls into:
//
//   • npcSteerMoveDir(unit, moveDir, friendlies)
//       Steering on top of the chosen 8-dir move: boids SEPARATION + arena
//       EDGE/CORNER repulsion + brief event FLINCH. Replaces the old weak
//       Phase-97 anti-clump nudge. Returns an adjusted moveDir (1..8).
//   • npcPickGoal(unit)
//       A Utility-AI / interest-point GOAL-SELECTION layer in front of the
//       random patrol picker: scores candidate destinations by role, crowd
//       capacity, edge-avoidance and objective. Returns {x,y} or null (caller
//       then falls back to its own picker).
//   • npcCombatFailsafe(unit, hostile)
//       Drains the "stuck in a corner pretending to fight" state: a combat bot
//       wedged near an edge with no progress is sent back to patrol so the
//       anti-corner picker pulls it back infield.
//   • npcDirectorTick()
//       Cheap global tick (called from nnTick): light AI-director event scan —
//       nearby explosions make timid NPCs flinch away (memory-lite reaction).
//   • npcRole(unit) — lazy per-unit role (rusher/flanker/holder/scout) +
//       personality noise. Drives the weights above so not every bot is the same.
//
// DESIGN PRINCIPLES (per the brief): additive only, no big refactor, no deps,
// no per-frame expensive search, staggered re-evaluation (callers already stagger
// via per-unit retarget timers + every-other-frame nnTick), reuse existing world
// data (coverPoints, NN_ARENA, allies/enemies/player). SOLO-first: this wires
// into js/enemy_ai.js (client bots). MP server bots (server/party/server.js) are
// a separate stack — a follow-up port, NOT touched here.
//
// KILL SWITCH / ROLLBACK: every call site in enemy_ai.js is `typeof`-guarded AND
// gated on `game._npcAI !== false`. Set `game._npcAI = false` (or delete the one
// <script src="js/npc_director.js"> tag) → the engine falls back to its previous
// behaviour exactly. Debug overlay: add `?aidebug=1` to the URL (or set
// `game._npcDebug = true`) to see each NPC's role · mode · goal.
//
// Classic-script. Declares globally: npcRole, npcSteerMoveDir, npcPickGoal,
// npcCombatFailsafe, npcDirectorTick, NpcDirector.
// Deps (call-time, all guarded): game · NN_ARENA · NN.MOVE_DIRS · allies ·
//   enemies · player · coverPoints · explosions · clampToArenaX/Y · ctx ·
//   registerFxLayer.

(function () {
  'use strict';

  // ── tunables ─────────────────────────────────────────────────────────
  const CFG = {
    // steering
    MOVE_W:   1.00,   // weight of the brain's chosen direction (anchor)
    SEP_R:    78,     // separation radius (px) — push off teammates closer than this
    SEP_W:    1.35,   // separation strength
    EDGE_R:   170,    // start repelling when within this of an arena edge
    EDGE_W:   1.25,   // edge/corner repulsion strength (×role.edgeAvoid)
    FLEE_W:   1.60,   // event-flinch repulsion strength
    FLEE_TICKS: 28,   // how long a flinch lasts (~0.45s)
    // goal selection
    CAP_R:    150,    // "capacity": teammates within this of a candidate crowd it
    CAP_PEN:  1.6,    // score penalty per crowding teammate
    EDGE_CAP: 420,    // cap interior-distance reward so midfield isn't over-valued
    GOAL_PAD: 130,    // keep candidate goals this far off the arena wall
    // fail-safe
    FS_WINDOW: 150,   // ticks (~2.5s) to measure progress over
    FS_MIN_MOVE: 56,  // <this much net movement in the window = "stuck"
    FS_EDGE:   150,   // only fail-safe when wedged within this of an edge
    // event reaction
    REACT_R:  150,    // explosion → NPCs within this may flinch
  };

  // Roles: weights for the interest-point scorer + steering + reaction.
  // edgeAvoid scales EDGE_W; wEdge/wSpread/wFoe/wCover weight the goal score;
  // flinch is the chance to flinch from a nearby blast (personality).
  const ROLES = {
    rusher:  { edgeAvoid: 0.75, wEdge: 0.6, wSpread: 0.8, wFoe:  1.5, wCover: 0.0, flinch: 0.20 },
    flanker: { edgeAvoid: 1.00, wEdge: 1.0, wSpread: 1.3, wFoe:  0.7, wCover: 0.3, flinch: 0.30, perp: true },
    holder:  { edgeAvoid: 1.35, wEdge: 1.5, wSpread: 1.0, wFoe:  0.2, wCover: 1.3, flinch: 0.60 },
    scout:   { edgeAvoid: 1.10, wEdge: 1.1, wSpread: 1.5, wFoe: -0.7, wCover: 0.2, flinch: 0.70, explore: true },
  };
  const ROLE_KEYS  = Object.keys(ROLES);
  // spawn distribution (sums ~1): a squad reads as a mix, not a clone army.
  const ROLE_PICK = [
    { k: 'holder',  p: 0.30 },
    { k: 'flanker', p: 0.27 },
    { k: 'rusher',  p: 0.25 },
    { k: 'scout',   p: 0.18 },
  ];
  const ROLE_COLORS = { rusher: '#FF6B3C', flanker: '#FFD24A', holder: '#54C8FF', scout: '#7CFF8A' };

  // standard 9-dir table fallback (matches NN.MOVE_DIRS: 0 idle, 1..8 =
  // N,NE,E,SE,S,SW,W,NW in screen coords where +y is down).
  const S = Math.SQRT1_2;
  const DEFAULT_DIRS = [
    [0, 0], [0, -1], [S, -S], [1, 0], [S, S], [0, 1], [-S, S], [-1, 0], [-S, -S],
  ];

  // ── helpers ──────────────────────────────────────────────────────────
  function _g() { return (typeof game !== 'undefined') ? game : null; }
  function _on() { const g = _g(); return !g || g._npcAI !== false; }   // on by default
  function _now() { const g = _g(); return (g && g.time != null) ? g.time : 0; }
  function _arena() {
    return (typeof NN_ARENA !== 'undefined' && NN_ARENA)
      ? NN_ARENA : { x0: 0, y0: 0, w: 1800, h: 1800 };
  }
  function _dirs() {
    return (typeof NN !== 'undefined' && NN && NN.MOVE_DIRS) ? NN.MOVE_DIRS : DEFAULT_DIRS;
  }
  function _alive(arr) { return (typeof arr !== 'undefined' && Array.isArray(arr)) ? arr : []; }
  function _clampX(v) {
    if (typeof clampToArenaX === 'function') return clampToArenaX(v, CFG.GOAL_PAD, CFG.GOAL_PAD);
    const a = _arena(); return Math.max(a.x0 + CFG.GOAL_PAD, Math.min(a.x0 + a.w - CFG.GOAL_PAD, v));
  }
  function _clampY(v) {
    if (typeof clampToArenaY === 'function') return clampToArenaY(v, CFG.GOAL_PAD, CFG.GOAL_PAD);
    const a = _arena(); return Math.max(a.y0 + CFG.GOAL_PAD, Math.min(a.y0 + a.h - CFG.GOAL_PAD, v));
  }
  // distance from a point to the nearest arena edge.
  function _edgeDist(x, y) {
    const a = _arena();
    return Math.min(x - a.x0, (a.x0 + a.w) - x, y - a.y0, (a.y0 + a.h) - y);
  }
  // teammates of a unit (player-team includes the player).
  function _mates(unit) {
    if (unit && unit.team === 0) {
      const out = _alive(allies).slice();
      if (typeof player !== 'undefined' && player && player.alive && player !== unit) out.push(player);
      return out;
    }
    return _alive(enemies);
  }
  function _foes(unit) {
    if (unit && unit.team === 0) return _alive(enemies);
    const out = _alive(allies).slice();
    if (typeof player !== 'undefined' && player && player.alive) out.push(player);
    return out;
  }
  function _centroid(list) {
    let cx = 0, cy = 0, n = 0;
    for (const u of list) { if (u && u.alive) { cx += u.x; cy += u.y; n++; } }
    return n ? { x: cx / n, y: cy / n, n } : null;
  }

  // quantize a desired vector to the nearest of the 8 move dirs (1..8).
  function _quantize(dx, dy, fallback) {
    const m = Math.hypot(dx, dy);
    if (m < 1e-4) return fallback || 0;
    const nx = dx / m, ny = dy / m;
    const dirs = _dirs();
    let best = fallback || 1, bestDot = -Infinity;
    for (let d = 1; d <= 8; d++) {
      const v = dirs[d] || DEFAULT_DIRS[d];
      const dot = nx * v[0] + ny * v[1];
      if (dot > bestDot) { bestDot = dot; best = d; }
    }
    return best;
  }

  // ── roles ────────────────────────────────────────────────────────────
  function npcRole(unit) {
    if (!unit) return ROLES.holder;
    if (!unit._npcRole) {
      let r = Math.random(), pick = 'holder';
      for (const e of ROLE_PICK) { if (r < e.p) { pick = e.k; break; } r -= e.p; }
      unit._npcRole = pick;
      // personality noise: ±15% private jitter so two same-role bots still differ.
      unit._npcNoise = 0.85 + Math.random() * 0.30;
    }
    return ROLES[unit._npcRole] || ROLES.holder;
  }

  // ── steering: separation + edge/corner repulsion + event flinch ───────
  // Anchors on the brain's chosen direction; biases it; re-quantizes to 8-dir.
  function npcSteerMoveDir(unit, moveDir, friendlies) {
    if (!_on() || !unit || moveDir === 0) return moveDir;
    const role = npcRole(unit);
    const noise = unit._npcNoise || 1;
    const dirs = _dirs();
    const base = dirs[moveDir] || DEFAULT_DIRS[moveDir] || [0, 0];
    let bx = base[0], by = base[1];
    let sx = 0, sy = 0;

    // boids SEPARATION — push off teammates that are too close (kills pile-ups).
    const mates = Array.isArray(friendlies) ? friendlies : _mates(unit);
    const R2 = CFG.SEP_R * CFG.SEP_R;
    for (const m of mates) {
      if (m === unit || !m || !m.alive) continue;
      const dx = unit.x - m.x, dy = unit.y - m.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > R2 || d2 < 1e-3) continue;
      const d = Math.sqrt(d2);
      const w = (1 - d / CFG.SEP_R);
      sx += (dx / d) * w; sy += (dy / d) * w;
    }
    sx *= CFG.SEP_W; sy *= CFG.SEP_W;

    // EDGE / CORNER repulsion — the core anti-"all bots in the bottom-right" fix.
    const a = _arena();
    const ew = CFG.EDGE_W * (role.edgeAvoid || 1) * noise;
    const ER = CFG.EDGE_R;
    const lx = unit.x - a.x0, rx = (a.x0 + a.w) - unit.x;
    const ty = unit.y - a.y0, by2 = (a.y0 + a.h) - unit.y;
    if (lx < ER)  sx += (1 - lx / ER)  * ew;   // near left  → push right (+x)
    if (rx < ER)  sx -= (1 - rx / ER)  * ew;   // near right → push left  (-x)
    if (ty < ER)  sy += (1 - ty / ER)  * ew;   // near top   → push down  (+y)
    if (by2 < ER) sy -= (1 - by2 / ER) * ew;   // near bottom→ push up    (-y)

    // EVENT FLINCH — brief panic away from a recent nearby blast (memory-lite).
    if (unit._npcFlee && _now() < unit._npcFlee.until) {
      const dx = unit.x - unit._npcFlee.x, dy = unit.y - unit._npcFlee.y;
      const d = Math.hypot(dx, dy) || 1;
      sx += (dx / d) * CFG.FLEE_W; sy += (dy / d) * CFG.FLEE_W;
    }

    const rxv = bx * CFG.MOVE_W + sx;
    const ryv = by * CFG.MOVE_W + sy;
    return _quantize(rxv, ryv, moveDir);
  }

  // ── interest-point GOAL SELECTION (utility AI) ────────────────────────
  // Returns a scored patrol/positioning goal, or null to let the caller fall
  // back. Only runs on retarget (rare, already staggered) so cost is trivial.
  function npcPickGoal(unit) {
    if (!_on() || !unit) return null;
    const a = _arena();
    const role = npcRole(unit);
    const noise = unit._npcNoise || 1;
    const mates = _mates(unit);
    const foeC = _centroid(_foes(unit));

    // ---- candidate destinations (cheap, ~7) ----
    const cands = [];
    const randPt = () => ({ x: _clampX(a.x0 + Math.random() * a.w), y: _clampY(a.y0 + Math.random() * a.h) });
    const centerPt = () => {
      const cx = a.x0 + a.w / 2, cy = a.y0 + a.h / 2;
      const ang = Math.random() * Math.PI * 2, rad = Math.random() * a.w * 0.32;
      return { x: _clampX(cx + Math.cos(ang) * rad), y: _clampY(cy + Math.sin(ang) * rad) };
    };
    cands.push(randPt(), randPt(), centerPt(), centerPt());
    // cover points (holders love these)
    if (typeof coverPoints !== 'undefined' && coverPoints.length) {
      for (let i = 0; i < 2; i++) {
        const cp = coverPoints[(Math.random() * coverPoints.length) | 0];
        if (cp) cands.push({ x: _clampX(cp.x), y: _clampY(cp.y), cover: true });
      }
    }
    // objective-targeted candidate around the enemy centroid
    if (foeC) {
      if (role.explore) {
        // scout: head somewhere FAR from the fight to flank/recon
        const ang = Math.atan2(foeC.y - (a.y0 + a.h / 2), foeC.x - (a.x0 + a.w / 2)) + Math.PI;
        cands.push({ x: _clampX(foeC.x + Math.cos(ang) * 600), y: _clampY(foeC.y + Math.sin(ang) * 600) });
      } else if (role.perp) {
        // flanker: step to the side of the line from us to the enemy mass
        const ang = Math.atan2(foeC.y - unit.y, foeC.x - unit.x) + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2;
        const d = 280 + Math.random() * 220;
        cands.push({ x: _clampX(foeC.x + Math.cos(ang) * d), y: _clampY(foeC.y + Math.sin(ang) * d) });
      } else {
        // rusher: push toward the enemy mass
        const ang = Math.random() * Math.PI * 2, d = 160 + Math.random() * 180;
        cands.push({ x: _clampX(foeC.x + Math.cos(ang) * d), y: _clampY(foeC.y + Math.sin(ang) * d) });
      }
    }

    // ---- score each candidate ----
    let best = null, bestScore = -Infinity;
    for (const c of cands) {
      let s = Math.random() * 0.4 * noise;
      // (1) interior preference — strongly penalize corners/edges
      s += Math.min(_edgeDist(c.x, c.y), CFG.EDGE_CAP) / 100 * (role.wEdge || 1);
      // (2) capacity / crowd penalty — avoid where teammates already are
      let crowd = 0;
      for (const m of mates) {
        if (m === unit || !m || !m.alive) continue;
        if (Math.hypot(c.x - m.x, c.y - m.y) < CFG.CAP_R) crowd++;
        // (3) anti-herd vs their CHOSEN targets
        const t = m._patrolTarget;
        if (t) s += Math.min(Math.hypot(c.x - t.x, c.y - t.y), 300) / 100 * 0.25 * (role.wSpread || 1);
      }
      s -= crowd * CFG.CAP_PEN * (role.wSpread || 1);
      // (4) anti-pattern vs own last goal
      if (unit._patrolTarget) s += Math.min(Math.hypot(c.x - unit._patrolTarget.x, c.y - unit._patrolTarget.y), 250) / 120;
      // (5) role objective vs the enemy mass
      if (foeC && role.wFoe) {
        const df = Math.hypot(c.x - foeC.x, c.y - foeC.y);
        // wFoe>0 → closer is better; wFoe<0 → farther is better (scout)
        s += (role.wFoe > 0 ? (1 - Math.min(df, 900) / 900) : (Math.min(df, 900) / 900)) * Math.abs(role.wFoe) * 2.0;
      }
      // (6) cover affinity
      if (c.cover) s += (role.wCover || 0) * 1.5;
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best) { best._reason = role === ROLES.holder ? 'hold' : (role.perp ? 'flank' : role.explore ? 'scout' : 'push'); }
    return best;
  }

  // ── combat fail-safe: drain corner-wedged "scrap metal" ───────────────
  function npcCombatFailsafe(unit, hostile) {
    if (!_on() || !unit) return false;
    const t = _now();
    let ref = unit._npcProg;
    if (!ref) { unit._npcProg = { x: unit.x, y: unit.y, t }; return false; }
    if (t - ref.t < CFG.FS_WINDOW) return false;
    const moved = Math.hypot(unit.x - ref.x, unit.y - ref.y);
    const nearEdge = _edgeDist(unit.x, unit.y) < CFG.FS_EDGE;
    unit._npcProg = { x: unit.x, y: unit.y, t };   // reset window
    // Wedged against an edge AND barely moved over ~2.5s → it's stuck in a
    // corner. Hand it to patrol; the anti-corner picker pulls it back infield.
    return nearEdge && moved < CFG.FS_MIN_MOVE;
  }

  // ── light AI-director event scan (called from nnTick) ─────────────────
  const _seenFx = (typeof WeakSet !== 'undefined') ? new WeakSet() : null;
  function _flinchNear(x, y, radius) {
    const r2 = radius * radius;
    const apply = (u) => {
      if (!u || !u.alive || !u._useNN) return;
      const dx = u.x - x, dy = u.y - y;
      if (dx * dx + dy * dy > r2) return;
      const role = npcRole(u);
      if (Math.random() < (role.flinch || 0.3)) {
        u._npcFlee = { x, y, until: _now() + CFG.FLEE_TICKS };
      }
    };
    for (const e of _alive(enemies)) apply(e);
    for (const a of _alive(allies)) apply(a);
  }
  function npcDirectorTick() {
    if (!_on()) return;
    // explosions[] is short-lived; a WeakSet dedups so each blast reacts once.
    if (_seenFx && typeof explosions !== 'undefined' && Array.isArray(explosions)) {
      for (const ex of explosions) {
        if (!ex || typeof ex.x !== 'number' || _seenFx.has(ex)) continue;
        _seenFx.add(ex);
        _flinchNear(ex.x, ex.y, CFG.REACT_R);
      }
    }
  }

  // ── debug overlay (?aidebug=1 or game._npcDebug) ──────────────────────
  function _npcDebugOn() {
    const g = _g();
    if (g && g._npcDebug) return true;
    try { return typeof location !== 'undefined' && /[?&]aidebug=1/.test(location.search); }
    catch (e) { return false; }
  }
  function _npcDebugDraw() {
    if (!_npcDebugOn() || typeof ctx === 'undefined') return;
    const list = [];
    for (const e of _alive(enemies)) if (e && e.alive && e._useNN) list.push(e);
    for (const a of _alive(allies)) if (a && a.alive && a._useNN) list.push(a);
    ctx.save();
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    for (const u of list) {
      const roleName = u._npcRole || '?';
      const col = ROLE_COLORS[roleName] || '#fff';
      if (u._patrolTarget) {
        ctx.globalAlpha = 0.45; ctx.strokeStyle = col; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(u.x, u.y); ctx.lineTo(u._patrolTarget.x, u._patrolTarget.y); ctx.stroke();
        ctx.globalAlpha = 0.9; ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(u._patrolTarget.x, u._patrolTarget.y, 4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.fillStyle = col;
      ctx.fillText(roleName + '·' + (u._aiMode || '?'), u.x, u.y - (u.radius || 14) - 6);
    }
    ctx.restore();
  }
  if (typeof registerFxLayer === 'function') {
    registerFxLayer({
      id: 'npc-debug',
      space: 'world',
      when: () => _npcDebugOn(),
      draw: _npcDebugDraw,
      allocsPerFrame: false,
    });
  }

  // ── exports ──────────────────────────────────────────────────────────
  window.npcRole           = npcRole;
  window.npcSteerMoveDir   = npcSteerMoveDir;
  window.npcPickGoal       = npcPickGoal;
  window.npcCombatFailsafe = npcCombatFailsafe;
  window.npcDirectorTick   = npcDirectorTick;
  window.NpcDirector = {
    CFG, ROLES,
    role: npcRole, steer: npcSteerMoveDir, pickGoal: npcPickGoal,
    failsafe: npcCombatFailsafe, tick: npcDirectorTick,
    _quantize, _edgeDist,
  };
})();
