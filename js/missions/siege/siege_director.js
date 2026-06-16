// ============ SIEGE — director runtime (the cue SEQUENCER) ============
// updateSiegeDirector() reads SIEGE_SCRIPT (siege_script.js) + DIRECTOR_PARAMS,
// runs the night/phase/grace/dawn state machine, and dispatches each cue through
// the generic _SIEGE_CUE table to ONE clean engine call. The DIRECTOR also EMITS
// cues into this same pipeline (Phase 7 procedural / adaptive), so authored and
// emergent content share one schema. Ticked from the siege mission factory's
// update() (not a global loop hook) so the subsystem is self-contained.
//
// Timing: driven off game.time deltas with the established *84 convention (sim
// ticks/sec) — NO new time unit (cardinal rule #2). Cue `at` is in seconds.
//
// Classic-script globals: updateSiegeDirector() · _SIEGE_CUE · _siegeMakeTank() ·
//   _siegeTankBreach() · _siegeCueKinds() · _siegeFireCue() (test accessors)
// Call-time deps: game · enemies · enemyDrones · buildings · player · TOD ·
//   triggerShake · showSwapToast · getLang · addEnergy · createExplosion ·
//   _arenaSpawnFactoryBot · spawnDroneEnemy · siegeFort · siegeSeg · siegeGateAnchor ·
//   SIEGE_SCRIPT · DIRECTOR_PARAMS · SIEGE_LOG_ENTRIES · SIEGE_FORT · camera

// ── Tunables ─────────────────────────────────────────────────────────────────
const SIEGE_TPS         = 84;    // sim ticks per script-second (reuses the *84 convention)
const SIEGE_DAY_GAP_SEC = 8;     // calm gap between nights (build / heal / breathe)
const SIEGE_CLEAR_GRACE = 3;     // sec after the last cue before a night may auto-end
const SIEGE_TANK_BREACH_DMG = 2.2; // wall HP a breacher chews per tick on contact (坦克轰墙)

// ── i18n toast helper ────────────────────────────────────────────────────────
function _siegeToast(zh, en, ttl) {
  if (typeof showSwapToast !== 'function') return;
  const txt = (typeof T === 'function') ? T(zh || en || '', en || zh || '') : (en || zh || '');
  showSwapToast(txt, ttl || 150);
}

// ── Geometry helpers for camera + spawns ─────────────────────────────────────
// Fort centre (the Heart) — the single source the camera / spawn / garrison
// helpers resolve through, with the arena-centre fallback before the fort builds.
function _siegeCenter() {
  const f = (typeof siegeFort === 'function') ? siegeFort() : null;
  if (f && f.center) return f.center;
  const ax = (typeof NN_ARENA !== 'undefined') ? NN_ARENA.x0 : 0;
  const ay = (typeof NN_ARENA !== 'undefined') ? NN_ARENA.y0 : 0;
  return { x: ax + 900, y: ay + 900 };
}
function _siegeGatePoint(dir) {
  const c = _siegeCenter();
  const R = (typeof SIEGE_FORT !== 'undefined') ? SIEGE_FORT.curtainR : 340;
  const m = { N: { x: c.x, y: c.y - R }, S: { x: c.x, y: c.y + R },
              E: { x: c.x + R, y: c.y }, W: { x: c.x - R, y: c.y } };
  return m[dir] || c;
}
function _siegeCameraPoint(on) {
  if (on && typeof on === 'object' && typeof on.x === 'number') return on;
  if (on === 'core') return _siegeCenter();
  if (typeof on === 'string' && on.indexOf('gate-') === 0) return _siegeGatePoint(on.slice(5));
  if (on === 'tank' || on === 'swarm') {
    let sx = 0, sy = 0, n = 0;
    if (on === 'tank' && typeof enemies !== 'undefined') {
      for (const e of enemies) if (e && e.alive && e._siegeBreacher) { sx += e.x; sy += e.y; n++; }
    } else if (typeof enemyDrones !== 'undefined') {
      for (const d of enemyDrones) if (d && d.alive) { sx += d.x; sy += d.y; n++; }
    }
    if (n) return { x: sx / n, y: sy / n };
  }
  if (typeof player !== 'undefined' && player) return { x: player.x, y: player.y };
  return { x: 900, y: 900 };
}
// Resolve a cue's gate token to a concrete N/E/S/W.
function _siegeResolveGate(g) {
  const s = game._siege;
  if (g === 'telegraphed') return (s && s.intent && s.intent.gate) || 'N';
  if (g === 'adaptive') return (typeof _siegeWeakestGate === 'function') ? _siegeWeakestGate() : 'N';
  return g || 'N';
}

// ── Breacher tanks (the star threat) + terrain mutation (更改地形) ────────────
// Promote a freshly-spawned red bot into a wall-breaking tank. Slow, huge, ×6 HP,
// rocket-armed. Uses normal NN AI (crawls toward the player at the fort centre);
// _siegeTankBreach grinds whatever fort wall it contacts on the way in.
function _siegeMakeTank(e, c) {
  if (!e) return;
  const walker = !!(c && c.unit === 'walker');
  e._isTank = true;
  e._siegeBreacher = true;
  e.maxHp = (e.maxHp || 80) * (walker ? 9 : 6);
  e.hp = e.maxHp;
  e.radius = (e.radius || 13) * (walker ? 2.4 : 2.0);
  e._speedMul = walker ? 0.30 : 0.45;     // slow crawl (read by enemy_ai; harmless else)
  if (typeof WEAPONS !== 'undefined' && WEAPONS.ROCKET) e._weapon = WEAPONS.ROCKET;
  e.callsign = walker ? 'WALKER' : 'TANK';
  // Track the live breacher count so _siegeTankBreach can skip its scan when none
  // exist (the common case — tanks are 1-5 units a few nights of the run).
  if (game._siege) game._siege._breacherCount = (game._siege._breacherCount || 0) + 1;
}

// Splice a named wall segment out of buildings[] → a PERMANENT gap.
function _siegeSpliceSeg(seg) {
  if (!seg || typeof buildings === 'undefined') return;
  const i = buildings.indexOf(seg);
  if (i >= 0) {
    buildings.splice(i, 1);
    if (typeof createExplosion === 'function') createExplosion(seg.x + seg.w / 2, seg.y + seg.h / 2, 'small');
    if (typeof buildCoverPoints === 'function') { try { buildCoverPoints(); } catch (e) {} }
  }
}

// Per-tick: every breacher tank touching a (non-indestructible) fort wall chews
// its HP; at hp<=0 the segment splices → a permanent hole + breach FX + a half-
// second camera punch so the player SEES their fort change.
function _siegeTankBreach() {
  if (typeof enemies === 'undefined' || !enemies || typeof buildings === 'undefined' || !buildings) return;
  const s = game._siege;
  if (s && s._breacherCount === 0) return;             // no live tanks → skip the per-tick scan
  let live = 0;
  for (const e of enemies) {
    if (!e || !e.alive || !e._siegeBreacher) continue;
    live++;
    const r = (e.radius || 26) + 6;
    for (let bi = buildings.length - 1; bi >= 0; bi--) {
      const b = buildings[bi];
      if (!b || !b._siegeWall || b._siegeIndestructible) continue;
      const cx = Math.max(b.x, Math.min(e.x, b.x + b.w));
      const cy = Math.max(b.y, Math.min(e.y, b.y + b.h));
      if ((e.x - cx) ** 2 + (e.y - cy) ** 2 > r * r) continue;
      b.hp -= SIEGE_TANK_BREACH_DMG;
      if (b.hp <= 0) {
        const px = b.x + b.w / 2, py = b.y + b.h / 2;
        if (typeof createExplosion === 'function') createExplosion(px, py, 'small');
        buildings.splice(bi, 1);                         // permanent gap (collision + render)
        if (typeof triggerShake === 'function') triggerShake(5, 12);
        const sc = (typeof camera !== 'undefined' ? camera.scale : 1) * 0.95;
        game._cineFocus = { x: px, y: py, scale: sc, until: (game.time || 0) + 40 };  // breach punch
        if (typeof buildCoverPoints === 'function') { try { buildCoverPoints(); } catch (e2) {} }
      }
    }
  }
  if (s) s._breacherCount = live;                       // recount for next tick's early-out
}

// ── THE CUE DISPATCH TABLE — the timeline's complete vocabulary ───────────────
const _SIEGE_CUE = {
  beat(c)    { _siegeToast(c.zh, c.en, c.ttl || 160); },
  goal(c)    { if (game._siege) game._siege.goal = { zh: c.zh || '', en: c.en || '' }; },
  tod(c)     { if (typeof TOD !== 'undefined' && c.name) TOD.setTOD(c.name); },
  weather(c) { if (game._siege) game._siege.weather = c.w || 'clear'; },

  telegraph(c) {
    const gate = _siegeResolveGate(c.gate);
    if (game._siege) {
      game._siege.intent = { gate, threat: c.threat || 'mass',
        until: (game.time || 0) + (c.dur || 8) * SIEGE_TPS };
      game._siege.phase = 'telegraph';
    }
  },

  spawn(c) {
    const n = c.n || 1;
    const gate = _siegeResolveGate(c.gate);
    for (let i = 0; i < n; i++) {
      const a = (typeof siegeGateAnchor === 'function') ? siegeGateAnchor(gate) : { x: 900, y: 500 };
      const jx = a.x + (Math.random() - 0.5) * 130;
      const jy = a.y + (Math.random() - 0.5) * 130;
      if (typeof _arenaSpawnFactoryBot !== 'function') continue;
      _arenaSpawnFactoryBot('red', jx, jy);
      const e = enemies[enemies.length - 1];
      if (e && (c.unit === 'tank' || c.unit === 'walker')) _siegeMakeTank(e, c);
    }
    if (game._siege) game._siege.phase = 'assault';
  },

  drone(c) {
    const n = c.n || 1;
    for (let i = 0; i < n; i++) {
      if (typeof spawnDroneEnemy === 'function') {
        spawnDroneEnemy(c.from ? { droneBias: 'overhead' } : null);
      }
    }
  },

  camera(c) {
    if (c.fx === 'shake') {
      if (typeof triggerShake === 'function') triggerShake(c.mag || 6, c.dur || 14);
      return;
    }
    if (c.fx === 'focus') {
      const pt = _siegeCameraPoint(c.on);
      if (pt) {
        const sc = (c.scale != null) ? c.scale : (typeof camera !== 'undefined' ? camera.scale : 1);
        game._cineFocus = { x: pt.x, y: pt.y, scale: sc, until: (game.time || 0) + (c.dur || 60) };
      }
    }
  },

  terrain(c) {
    const seg = (typeof siegeSeg === 'function')
      ? siegeSeg(c.op === 'opengate' ? ('gateLeaf' + (c.target || 'N')) : c.target) : null;
    if (!seg) return;
    if (c.op === 'breach' || c.op === 'opengate') { seg.hp = 0; _siegeSpliceSeg(seg); }
    else if (c.op === 'reinforce') { seg.hp = c.hp || seg.maxHp || 600; }
  },

  wall(c) {
    const seg = (typeof siegeSeg === 'function') ? siegeSeg(c.seg) : null;
    if (!seg) return;
    if (c.breach) { seg.hp = 0; _siegeSpliceSeg(seg); }
    else if (c.hp != null) seg.hp = c.hp;
  },

  conduit(c) {
    const f = (typeof siegeFort === 'function') ? siegeFort() : null;
    const pt = (f && f.armory) ? { x: f.armory.x, y: f.armory.y } : _siegeCameraPoint('core');
    const n = c.n || 3;
    for (let i = 0; i < n; i++) {
      if (typeof _arenaSpawnFactoryBot !== 'function') break;
      _arenaSpawnFactoryBot('red', pt.x + (Math.random() - 0.5) * 220, pt.y + (Math.random() - 0.5) * 220);
    }
  },

  objective(c) { if (game._siege) game._siege.chargeRate = c.rate; },

  lull(c) { if (game._siege) game._siege.phase = 'lull'; },

  dawn(c) { _siegeDawn(c); },

  log(c) { _siegeLogUnlock(c.entry); },

  proc(c) { if (typeof _siegeProcEmit === 'function') _siegeProcEmit(c); },  // Phase 7
};

// Test accessors.
function _siegeCueKinds() { return Object.keys(_SIEGE_CUE); }
function _siegeFireCue(c) { const h = _SIEGE_CUE[c.kind]; if (h) h(c); }

// ── Operator log unlock ──────────────────────────────────────────────────────
function _siegeLogUnlock(id) {
  if (!id) return;
  try {
    const store = (typeof localStorage !== 'undefined') ? localStorage : null;
    const raw = store ? (store.getItem('ag.logsRead') || '') : '';
    const set = new Set(raw ? raw.split(',') : []);
    if (set.has(id)) return;
    set.add(id);
    if (store) store.setItem('ag.logsRead', Array.from(set).join(','));
    const e = (typeof SIEGE_LOG_ENTRIES !== 'undefined') ? SIEGE_LOG_ENTRIES[id] : null;
    if (e) _siegeToast('📓 ' + (e.title_zh || ''), '📓 ' + (e.title_en || ''), 200);
  } catch (e) {}
}

// ── Dawn — salvage payout, regroup gap, or final-night WIN ────────────────────
function _siegeDawn(c) {
  const s = game._siege;
  if (!s) return;
  s.phase = 'dawn';
  if (typeof TOD !== 'undefined') TOD.setTOD('dawn');
  const salvage = c.salvage || 0;
  if (salvage) { if (typeof addEnergy === 'function') addEnergy(salvage); s.salvage = (s.salvage || 0) + salvage; }
  const finalNight = (typeof DIRECTOR_PARAMS !== 'undefined' && DIRECTOR_PARAMS.finalDawnNight) || 5;
  if (s.night >= finalNight) {
    s._won = true;
    _siegeLogUnlock('dawn_holds');
    _siegeToast('破曉守住了', 'DAWN HOLDS', 260);
  } else {
    s._gapUntil = (game.time || 0) + (c.windowSec || SIEGE_DAY_GAP_SEC) * SIEGE_TPS;
    _siegeToast('▶ 第 ' + s.night + ' 夜 守住了 · 整備 ' + (c.windowSec || SIEGE_DAY_GAP_SEC) + 's',
                '▶ NIGHT ' + s.night + ' HELD · REGROUP ' + (c.windowSec || SIEGE_DAY_GAP_SEC) + 's', 200);
  }
}

// ── Night assembly + the state machine ───────────────────────────────────────
function _siegeCuesForNight(n) {
  const authored = (typeof SIEGE_SCRIPT !== 'undefined')
    ? SIEGE_SCRIPT.filter(c => c.night === n) : [];
  if (authored.length) return authored.slice().sort((a, b) => (a.at || 0) - (b.at || 0));
  if (typeof _siegeProcNight === 'function') return _siegeProcNight(n);   // Phase 7
  return [];
}
function _siegeStartNight(n) {
  const s = game._siege;
  s.night = n;
  s.phase = 'lull';
  s.phaseStart = (game.time || 0);
  s.t = 0;
  s._gapUntil = 0;
  s.intent = null;
  s._nightCues = _siegeCuesForNight(n);
  s._cuesFired = new Array(s._nightCues.length).fill(false);
}

// Memoized per tick — both updateSiegeDirector and _siegeTickAutopilot can ask in
// the same update() pass; cache so the enemies[]+drones scan runs at most once.
let _siegeFieldClearTick = -1, _siegeFieldClearVal = true;
function _siegeFieldClear() {
  const now = (typeof game !== 'undefined' && game.time != null) ? game.time : 0;
  if (_siegeFieldClearTick === now) return _siegeFieldClearVal;
  _siegeFieldClearTick = now;
  let clear = true;
  if (typeof enemies !== 'undefined' && enemies) for (const e of enemies) if (e && e.alive && !e._koStunned) { clear = false; break; }
  if (clear && typeof enemyDrones !== 'undefined' && enemyDrones) for (const d of enemyDrones) if (d && d.alive) { clear = false; break; }
  _siegeFieldClearVal = clear;
  return clear;
}

// Ticked once per sim tick from the siege mission factory's update().
function updateSiegeDirector() {
  const s = game._siege;
  if (!s || typeof s !== 'object') return;
  if (game.state !== 'playing') return;
  if (s._won || s._failed) return;

  _siegeTankBreach();                       // 坦克轰墙 — tanks chew walls every tick

  if (s.night === 0) { _siegeStartNight(1); return; }       // boot → Night 1

  // Inter-night calm gap (set by the dawn cue / auto-end).
  if (s._gapUntil) {
    if ((game.time || 0) < s._gapUntil) return;
    _siegeStartNight(s.night + 1);
    return;
  }

  const t = ((game.time || 0) - s.phaseStart) / SIEGE_TPS;
  s.t = t;

  // Fire due cues for the current night.
  const cues = s._nightCues || [];
  let lastAt = 0;
  for (let i = 0; i < cues.length; i++) {
    if ((cues[i].at || 0) > lastAt) lastAt = cues[i].at || 0;
    if (!s._cuesFired[i] && t >= (cues[i].at || 0)) {
      s._cuesFired[i] = true;
      try { const h = _SIEGE_CUE[cues[i].kind]; if (h) h(cues[i]); } catch (e) { /* one bad cue can't kill the loop */ }
    }
  }

  // Expire the INTENT telegraph.
  if (s.intent && (game.time || 0) >= s.intent.until) s.intent = null;

  // Fallback auto-end (for nights without a dawn cue, e.g. early proc): every cue
  // fired + grace elapsed + the field cleared → open the regroup gap. The dawn
  // cue is the canonical gap-opener; whichever sets _gapUntil first wins.
  const allFired = s._cuesFired.length === 0 || s._cuesFired.every(Boolean);
  if (!s._gapUntil && allFired && t >= lastAt + SIEGE_CLEAR_GRACE && _siegeFieldClear()) {
    s._gapUntil = (game.time || 0) + SIEGE_DAY_GAP_SEC * SIEGE_TPS;
  }
}

// ── Garrison lives · weld · salvage · armory · autopilot (Phase 5) ────────────
// The no-respawn hard-ask, made POSITIONAL: your lineup is a garrison of N bodies
// tied to a PLACE (the Heart), not a respawn timer. No ad-revive, no timed respawn.
const SIEGE_GARRISON_CAP    = 5;     // max lives bankable via recruit / armory
const SIEGE_AUTOPILOT_GRACE = 10;    // sec the fort fights undefended (last body down)
const SIEGE_WELD_REACH      = 160;   // px — how near a breach the builder welds
const SIEGE_WELD_RATE       = 3.0;   // wall HP restored per tick while welding
const SIEGE_WELD_COST_PER   = 0.05;  // energy per HP welded (cheap — fort reserve)

// Wake the next garrison body AT the Heart — a positional setback (yanked from the
// breach you were plugging back to centre), not a respawn. Spends one life.
function _siegeGarrisonWake() {
  const s = game._siege;
  if (!s || s.livesLeft <= 0) return false;
  s.livesLeft--;
  s.autopilot = false;
  const h = _siegeCenter();
  if (typeof PlayerLifecycle !== 'undefined') {
    PlayerLifecycle.reviveAtSpawn({ x: h.x, y: h.y + 55, invulnTicks: 180 });
  } else if (typeof player !== 'undefined' && player) {
    player.alive = true; player.hp = player.maxHp || 100;
    player.x = h.x; player.y = h.y + 55; player._respawnAt = null;
    player._invulnUntil = (game.time || 0) + 180;
  }
  _siegeToast('喚醒駐軍 · 退守核心 (剩 ' + s.livesLeft + ')',
              'GARRISON WAKES · pulled back to the Heart (' + s.livesLeft + ' left)', 170);
  return true;
}

// Recruit a downed enemy OR hold the Armory → bank a life (the only mid-run roster
// growth; makes recruitment load-bearing). Capped.
function _siegeAddGarrisonLife() {
  const s = game._siege;
  if (!s || s.livesLeft >= SIEGE_GARRISON_CAP) return;
  s.livesLeft++;
  _siegeToast('駐軍 +1 · 剩 ' + s.livesLeft, 'GARRISON +1 · ' + s.livesLeft + ' bodies', 150);
}

// death_decider's siege entry: wake a garrison body, or drop into AUTOPILOT.
function _siegeTryRevive() {
  const s = game._siege;
  if (!s) return 'wiped';
  if (s.livesLeft > 0) { _siegeGarrisonWake(); return 'revived'; }
  s.autopilot = true;
  s.autopilotUntil = (game.time || 0) + SIEGE_AUTOPILOT_GRACE * SIEGE_TPS;
  _siegeToast('駐軍耗盡 · 自動防禦 · 核心無人守',
              'GARRISON DOWN · AUTOPILOT · the Heart stands alone', 220);
  return 'autopilot';
}

// Factory-update hook: resolve AUTOPILOT. The fort holds the burst (field clear /
// reached the regroup gap) → the whole garrison wakes (the fort held without you —
// triumphant). Grace expires still overwhelmed → the run ends (garrison-extinct-
// with-no-hold secondary fail). Heart-dead is caught by isFailed directly.
function _siegeTickAutopilot() {
  const s = game._siege;
  if (!s || !s.autopilot) return;
  const f = (typeof siegeFort === 'function') ? siegeFort() : null;
  const h = f ? f.heart : null;
  if (h && h.hp <= 0) { s._failed = true; return; }
  const held = _siegeFieldClear() || s._gapUntil > 0 || s.phase === 'dawn';
  if (held) {
    s.livesLeft = Math.max(1, s.garrisonSize || 3);
    _siegeGarrisonWake();
    _siegeToast('堡壘守住了 · 駐軍甦醒', 'THE FORT HELD · the garrison wakes', 240);
    return;
  }
  if ((game.time || 0) >= s.autopilotUntil) s._failed = true;   // couldn't hold → loss
}

// Armory capture — the siege factory doesn't run nn_deathmatch's _tickFactories,
// so siege owns its capture loop. Holding the captureR flips it blue; an owned
// Armory periodically produces a life (factory production = earned lives).
function _siegeTickArmory() {
  const s = game._siege;
  if (!s) return;
  const f = (typeof siegeFort === 'function') ? siegeFort() : null;
  const arm = f ? f.armory : null;
  if (!arm) return;
  const FD = (typeof STRUCTURE_DEFS !== 'undefined') ? STRUCTURE_DEFS['factory'] : null;
  const R = (FD && FD.captureR) || 90;
  const need = (FD && FD.captureTicks) || 300;
  const prod = (FD && FD.productionTicks) || 1800;
  if (arm._team === 'blue') {
    if ((game.time || 0) >= (arm._nextProductionAt || 0)) {
      arm._nextProductionAt = (game.time || 0) + prod;
      _siegeAddGarrisonLife();
    }
    return;
  }
  let inside = false;
  if (typeof player !== 'undefined' && player && player.alive
      && Math.hypot(player.x - arm.x, player.y - arm.y) < R) inside = true;
  if (!inside && typeof allies !== 'undefined') for (const a of allies) {
    if (a && a.alive && Math.hypot(a.x - arm.x, a.y - arm.y) < R) { inside = true; break; }
  }
  if (inside) {
    arm._captureProgress = (arm._captureProgress || 0) + 1;
    if (arm._captureProgress >= need) {
      arm._team = 'blue';
      arm._captureProgress = 0;
      arm._nextProductionAt = (game.time || 0) + prod;
      _siegeAddGarrisonLife();
      _siegeToast('▶ 軍械庫已奪取', '▶ ARMORY CAPTURED', 180);
    }
  } else if (arm._captureProgress > 0) {
    arm._captureProgress = Math.max(0, arm._captureProgress - 0.5);
  }
}

// Weld — restore the nearest damaged/destroyed siege wall within reach of the
// player; re-pushes a fully-collapsed segment back into buildings[] (the registry
// keeps the seg object after a splice, so 'rebuild the breach' is just hp + re-add).
function _siegeWeld() {
  if (typeof player === 'undefined' || !player || !player.alive) return false;
  const f = (typeof siegeFort === 'function') ? siegeFort() : null;
  if (!f || !f.segs) return false;
  let best = null, bestD = SIEGE_WELD_REACH;
  for (const id in f.segs) {
    const seg = f.segs[id];
    if (!seg || seg._siegeIndestructible) continue;
    if (seg.hp >= (seg.maxHp || seg.hp)) continue;          // intact — skip
    const cx = seg.x + seg.w / 2, cy = seg.y + seg.h / 2;
    const d = Math.hypot(player.x - cx, player.y - cy);
    if (d < bestD) { best = seg; bestD = d; }
  }
  if (!best) return false;
  if (typeof canAffordEnergy === 'function' && !canAffordEnergy(SIEGE_WELD_COST_PER)) return false;
  const before = best.hp;
  best.hp = Math.min(best.maxHp || best.hp, best.hp + SIEGE_WELD_RATE);
  if (before <= 0 && best.hp > 0 && typeof buildings !== 'undefined' && buildings.indexOf(best) < 0) {
    buildings.push(best);                                    // rebuild a collapsed segment
    if (typeof buildCoverPoints === 'function') { try { buildCoverPoints(); } catch (e) {} }
  }
  if (typeof spendEnergy === 'function') spendEnergy((best.hp - before) * SIEGE_WELD_COST_PER);
  return true;
}

// Passive weld during the calm — a builder near a breach mends it (no new UI; the
// "weld at dawn" loop). Builder-only under chassis-classes.
function _siegeTickWeld() {
  const s = game._siege;
  if (!s || (s.phase !== 'lull' && s.phase !== 'dawn')) return;
  if (typeof game !== 'undefined' && game._classes && typeof player !== 'undefined'
      && player && player._chassis && player._chassis !== 'humanoid') return;
  _siegeWeld();
}

// Player-death poll for the siege factory (siege uses its own factory, not
// nn_deathmatch's poll). killPlayer (bullets.js/combat_helpers.js) flips alive on
// lethal damage; this routes the death to garrison-wake / autopilot exactly once.
function _siegeUpdateDeath() {
  const s = game._siege;
  if (!s || s._won || s._failed) return;
  if (typeof player === 'undefined' || !player) return;
  if (!player.alive && player._respawnAt == null && !s.autopilot) {
    if (typeof handleLocalDeath === 'function') handleLocalDeath({ x: player.x, y: player.y });
    else if (typeof _siegeTryRevive === 'function') _siegeTryRevive();
  }
}

// ── Adaptive director — procedural Night 6+ + weakest-gate targeting (Phase 7) ─
// The gate whose curtain ring is most worn (lowest remaining HP fraction) — the
// director aims your least-repaired seam. Reads the fort registry (which keeps a
// segment's object even after it splices, so a collapsed side scores 0).
function _siegeWeakestGate() {
  const f = (typeof siegeFort === 'function') ? siegeFort() : null;
  if (!f || !f.segs) return 'N';
  const have = { N: 0, E: 0, S: 0, W: 0 }, max = { N: 0, E: 0, S: 0, W: 0 };
  for (const id in f.segs) {
    const seg = f.segs[id];
    if (!seg) continue;
    if (seg._siegeRing !== 'curtain' && seg._siegeRing !== 'gate') continue;
    let g = null;
    if (id.indexOf('N') >= 0) g = 'N';
    else if (id.indexOf('E') >= 0) g = 'E';
    else if (id.indexOf('S') >= 0) g = 'S';
    else if (id.indexOf('W') >= 0) g = 'W';
    if (!g) continue;
    max[g] += (seg.maxHp || 1);
    have[g] += Math.max(0, seg.hp || 0);
  }
  let best = 'N', bestFrac = Infinity;
  for (const g of ['N', 'E', 'S', 'W']) {
    const frac = max[g] > 0 ? have[g] / max[g] : 0;
    if (frac < bestFrac) { bestFrac = frac; best = g; }
  }
  return best;
}

// One-way-ish DDA — scales pressure UP when the player is dominating (full Heart
// + full garrison), never below the baseline floor when they're bleeding.
function _siegePerfMultiplier() {
  const P = (typeof DIRECTOR_PARAMS !== 'undefined') ? DIRECTOR_PARAMS : {};
  const range = P.perfMultiplier || [0.9, 1.6];
  const f = (typeof siegeFort === 'function') ? siegeFort() : null;
  const heart = f ? f.heart : null;
  const hpFrac = heart ? Math.max(0, Math.min(1, heart.hp / (heart.maxHp || 1200))) : 1;
  const s = game._siege || {};
  const lifeFrac = Math.max(0, Math.min(1, (s.livesLeft || 0) / SIEGE_GARRISON_CAP));
  const perf = 0.6 * hpFrac + 0.4 * lifeFrac;     // 0 struggling … 1 dominating
  return range[0] + (range[1] - range[0]) * perf;
}

// Night 6+ — compose a cue list from DIRECTOR_PARAMS + the '_proc' SIEGE_SCRIPT
// row, recombining the established threats at rising intensity (endless). Emits
// into the SAME cue pipeline the authored nights use (telegraph→spawn→drone→dawn).
function _siegeProcNight(n) {
  const P = (typeof DIRECTOR_PARAMS !== 'undefined') ? DIRECTOR_PARAMS : {};
  const proc = (typeof SIEGE_SCRIPT !== 'undefined') ? SIEGE_SCRIPT.find(c => c.night === '_proc') : null;
  const droneBase = (proc && proc.droneBase) || 8;
  const winSec = (proc && proc.windowSec) || 24;
  const over = Math.max(0, n - ((P.procFrom || 6) - 1));   // 1,2,3… from Night 6
  const mult = _siegePerfMultiplier();
  const tanks = Math.max(1, Math.min(5, Math.round((1 + over * 0.6) * mult)));
  const drones = Math.max(P.droneFloor || 3, Math.round((droneBase + over * 2) * mult));
  const sappers = Math.max(6, Math.round((6 + over * 2) * mult));
  const cues = [
    { night: n, at: 0,  kind: 'tod',       name: (n % 2 ? 'night' : 'dusk') },
    { night: n, at: 0,  kind: 'weather',   w: 'storm' },
    { night: n, at: 0,  kind: 'goal',      zh: '長夜 · 死守', en: 'THE LONG NIGHT · hold' },
    { night: n, at: 1,  kind: 'beat',      zh: '第 ' + n + ' 夜 · 長夜', en: 'NIGHT ' + n + ' · THE LONG NIGHT' },
    { night: n, at: 3,  kind: 'telegraph', gate: 'adaptive', dur: 5, threat: 'armour' },
    { night: n, at: 4,  kind: 'spawn',     unit: 'tank',   n: tanks, gate: 'adaptive' },
    { night: n, at: 6,  kind: 'spawn',     unit: 'sapper', n: Math.ceil(sappers / 2), gate: 'adaptive' },
    { night: n, at: 9,  kind: 'drone',     n: drones, target: 'core' },
    { night: n, at: 12, kind: 'camera',    fx: 'shake', mag: 6, dur: 16 },
  ];
  if (n >= (P.splitAfterNight || 4)) {
    cues.push({ night: n, at: 14, kind: 'telegraph', gate: 'adaptive', dur: 4, threat: 'mass' });
    cues.push({ night: n, at: 15, kind: 'spawn', unit: 'sapper', n: Math.floor(sappers / 2), gate: 'adaptive' });
  }
  if (n >= 7) cues.push({ night: n, at: 18, kind: 'spawn', unit: 'walker', n: 1, gate: 'adaptive' });
  cues.push({ night: n, at: Math.max(34, 26 + over), kind: 'dawn',
              windowSec: Math.max(16, winSec - over), salvage: 220 + n * 15 });
  return cues;
}
