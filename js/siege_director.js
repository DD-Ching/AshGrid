// ============ SIEGE DIRECTOR — data-driven timeline (Phase 188B) ============
// THE control interface for the 守城 / SIEGE mode. The whole run is described by
// SIEGE_SCRIPT below — a declarative TIMELINE of cues. To change pacing, what
// enters and WHEN (進場時間), the story beats (劇情), camera (運鏡), day/night +
// weather (背景), or the factors introduced — you EDIT THE DATA here, not the
// engine. Adding/moving a beat = one line. That's the whole point: later edits
// are cheap and never tangled.
//
// A cue = { day, at, kind, ...params }
//   day  — which Day it belongs to (1,2,3,…)
//   at   — seconds into that day to fire
//   kind — one of the handlers in _SIEGE_CUE (spawn / tod / weather / camera /
//          beat). Add a new kind = add one entry to _SIEGE_CUE; the runtime
//          dispatches generically, so the timeline language is open-ended.
//
// Handlers are THIN wrappers over existing systems (enemy spawn, TOD palette,
// shake, toast) — the director is a SEQUENCER, never a re-implementation. Days
// beyond the script escalate procedurally (endless survival) via _siegeProcDay.
//
// Classic-script globals: SIEGE_SCRIPT · updateSiegeDirector() · _siegeDayLabel()
// Deps (call-time): game · player · enemies · _arenaSpawnFactoryBot ·
//   pickBiasedSpawn · TOD · triggerShake · showSwapToast · T.

// ── Tunables (the "knobs" — change feel here) ───────────────────────────────
const SIEGE_TICKS_PER_SEC = 60;   // sim ticks per script-second (the tick-second unit)
const SIEGE_DAY_GAP_SEC   = 8;    // calm between days (build / heal / breathe)
const SIEGE_CLEAR_GRACE   = 2;    // sec after the last cue before a day can end
const SIEGE_TANK_BREACH_DMG = 2.2; // wall HP a tank chews per tick while touching it (坦克轰墙)

// ── THE TIMELINE (edit this to author the siege) ────────────────────────────
const SIEGE_SCRIPT = [
  // ── DAY 1 — dawn, an infantry probe to learn the fort ──
  { day: 1, at: 0,  kind: 'tod',     name: 'dawn' },
  { day: 1, at: 0,  kind: 'weather', w: 'clear' },
  { day: 1, at: 0,  kind: 'beat',    zh: '第 1 天 · 黎明 · 守住堡壘', en: 'DAY 1 · DAWN · HOLD THE FORT' },
  { day: 1, at: 2,  kind: 'spawn',   unit: 'infantry', n: 4 },
  { day: 1, at: 18, kind: 'spawn',   unit: 'infantry', n: 5 },
  { day: 1, at: 34, kind: 'spawn',   unit: 'infantry', n: 6 },

  // ── DAY 2 — dusk, wind, the first ARMOUR ──
  { day: 2, at: 0,  kind: 'tod',     name: 'dusk' },
  { day: 2, at: 0,  kind: 'weather', w: 'wind' },
  { day: 2, at: 0,  kind: 'beat',    zh: '第 2 天 · 黃昏 · 裝甲逼近', en: 'DAY 2 · DUSK · ARMOUR INBOUND' },
  { day: 2, at: 3,  kind: 'spawn',   unit: 'infantry', n: 6 },
  { day: 2, at: 13, kind: 'camera',  fx: 'shake', mag: 7, dur: 16 },   // 運鏡 — the tank arrives
  { day: 2, at: 14, kind: 'spawn',   unit: 'tank',     n: 1 },
  { day: 2, at: 14, kind: 'camera',  fx: 'focus', on: 'tank', dur: 50 },   // 運鏡 — armour reveal
  { day: 2, at: 22, kind: 'beat',    zh: '無人機!保持移動', en: 'DRONES! KEEP MOVING' },
  { day: 2, at: 23, kind: 'drone',   n: 3 },                       // first drone probe — forces kiting
  { day: 2, at: 30, kind: 'spawn',   unit: 'infantry', n: 6 },

  // ── DAY 3 — night, storm, tanks + a crush ──
  { day: 3, at: 0,  kind: 'tod',     name: 'night' },
  { day: 3, at: 0,  kind: 'weather', w: 'storm' },
  { day: 3, at: 0,  kind: 'beat',    zh: '第 3 天 · 夜 · 風暴突襲', en: 'DAY 3 · NIGHT · STORM ASSAULT' },
  { day: 3, at: 2,  kind: 'spawn',   unit: 'infantry', n: 8 },
  { day: 3, at: 15, kind: 'camera',  fx: 'shake', mag: 8, dur: 18 },
  { day: 3, at: 16, kind: 'spawn',   unit: 'tank',     n: 2 },
  { day: 3, at: 16, kind: 'camera',  fx: 'focus', on: 'tank', dur: 50 },   // 運鏡 — twin armour reveal
  { day: 3, at: 10, kind: 'drone',   n: 4 },                       // drone SWARM — sustained pressure
  { day: 3, at: 26, kind: 'drone',   n: 5 },
  { day: 3, at: 34, kind: 'spawn',   unit: 'infantry', n: 8 },
];
const SIEGE_SCRIPT_MAX_DAY = SIEGE_SCRIPT.reduce((m, c) => Math.max(m, c.day), 0);

// ── Cue handlers (the verbs the timeline can use; add a kind = add an entry) ──
const _SIEGE_CUE = {
  spawn(c) {
    const n = c.n || 1;
    for (let i = 0; i < n; i++) {
      const sp = (typeof pickBiasedSpawn === 'function') ? pickBiasedSpawn('nnArena') : null;
      if (!sp || typeof _arenaSpawnFactoryBot !== 'function') continue;
      _arenaSpawnFactoryBot('red', sp.x, sp.y);
      if (c.unit === 'tank') _siegeMakeTank(enemies[enemies.length - 1]);
    }
  },
  // 無人機群 — spawn N kamikaze drones (they track the player + detonate, and are
  // shootable: hp 18, fast + turning, so downing them is a skill "chance" and a
  // swarm forces kiting/迂迴, even inside the fort). Reuses spawnDroneEnemy.
  drone(c) {
    const n = c.n || 1;
    for (let i = 0; i < n; i++) {
      if (typeof spawnDroneEnemy === 'function') spawnDroneEnemy(c.from ? { droneBias: c.from } : null);
    }
  },
  tod(c)     { if (typeof TOD !== 'undefined' && c.name) TOD.setTOD(c.name); },
  weather(c) { if (typeof game !== 'undefined') game._siegeWeather = c.w || 'clear'; },
  // 運鏡 — camera cues. fx:'shake' = impact; fx:'focus' = a brief cinematic
  // look-at (sets game._cineFocus; the top-priority 'siegeCine' CAMERA_MODE glides
  // there + back). Focus target: explicit {x,y}, or on:'tank'/'enemies' (the
  // centroid of that threat), else the player. dur is in ticks (~60 ≈ 1s).
  camera(c) {
    if (c.fx === 'shake') { if (typeof triggerShake === 'function') triggerShake(c.mag || 6, c.dur || 14); return; }
    if (c.fx === 'focus') {
      const pt = _siegeFocusPoint(c);
      if (pt && typeof game !== 'undefined') {
        const sc = (c.scale != null) ? c.scale : (typeof camera !== 'undefined' ? camera.scale : 1);
        game._cineFocus = { x: pt.x, y: pt.y, scale: sc, until: (game.time || 0) + (c.dur || 60) };
      }
    }
  },
  beat(c)    {
    if (typeof showSwapToast === 'function') {
      const zh = (typeof getLang === 'function' && getLang() === 'zh');
      showSwapToast(zh ? (c.zh || c.en || '') : (c.en || c.zh || ''));
    }
  },
};

// Promote a freshly-spawned red bot into a TANK: slow, big, high HP. Marked
// _isTank so render + (later) wall-breaking can special-case it. Stats are knobs.
function _siegeMakeTank(e) {
  if (!e) return;
  e._isTank = true;
  e.maxHp = (e.maxHp || 100) * 6;
  e.hp = e.maxHp;
  e.radius = (e.radius || 13) * 2.0;
  e._speedMul = 0.5;                 // slow crawl (read by enemy_ai if present; harmless else)
  e._weapon = (typeof WEAPONS !== 'undefined' && WEAPONS.ROCKET) ? WEAPONS.ROCKET : e._weapon;
  e.callsign = 'TANK';
}

// 坦克轰墙 — a tank touching a fort wall chews through it (reuses the destructible
// buildings[] model: bullets already splice buildings at hp<=0; this lets a tank
// pressed against a wall punch a hole even when its rocket isn't aimed there).
function _siegeTankBreach() {
  if (typeof enemies === 'undefined' || !enemies || typeof buildings === 'undefined' || !buildings) return;
  for (const e of enemies) {
    if (!e || !e.alive || !e._isTank) continue;
    const r = e.radius || 26;
    for (let bi = buildings.length - 1; bi >= 0; bi--) {
      const b = buildings[bi];
      if (b.kind !== 'building') continue;
      // AABB-vs-circle proximity (tank centre within r of the wall rect).
      const cx = Math.max(b.x, Math.min(e.x, b.x + b.w));
      const cy = Math.max(b.y, Math.min(e.y, b.y + b.h));
      if ((e.x - cx) ** 2 + (e.y - cy) ** 2 > r * r) continue;
      b.hp -= SIEGE_TANK_BREACH_DMG;
      if (b.hp <= 0) {
        if (typeof createExplosion === 'function') createExplosion(b.x + b.w / 2, b.y + b.h / 2, 'small');
        buildings.splice(bi, 1);       // hole punched (collision + render gap)
        if (typeof triggerShake === 'function') triggerShake(5, 10);
      }
    }
  }
}

// Resolve a 'camera focus' cue's target point: explicit {x,y}; else the centroid
// of the threat (on:'tank' → tanks only, else all enemies + drones); else player.
function _siegeFocusPoint(c) {
  if (typeof c.x === 'number' && typeof c.y === 'number') return { x: c.x, y: c.y };
  const wantTank = (c.on === 'tank');
  let sx = 0, sy = 0, n = 0;
  if (typeof enemies !== 'undefined' && enemies) for (const e of enemies) {
    if (!e || !e.alive) continue;
    if (wantTank && !e._isTank) continue;
    sx += e.x; sy += e.y; n++;
  }
  if (!wantTank && typeof enemyDrones !== 'undefined' && enemyDrones) for (const d of enemyDrones) {
    if (d && d.alive) { sx += d.x; sy += d.y; n++; }
  }
  if (n) return { x: sx / n, y: sy / n };
  if (typeof player !== 'undefined' && player) return { x: player.x, y: player.y };
  return null;
}

// ── Runtime ─────────────────────────────────────────────────────────────────
function _siegeAliveEnemies() {
  let n = 0;
  if (typeof enemies !== 'undefined' && enemies) for (const e of enemies) if (e && e.alive && !e._koStunned) n++;
  // Drones count too — a Day isn't "held" while the swarm is still in the air.
  if (typeof enemyDrones !== 'undefined' && enemyDrones) for (const d of enemyDrones) if (d && d.alive) n++;
  return n;
}
function _siegeDayLabel() {   // for the HUD / end-card ("survived N days")
  return (typeof game !== 'undefined' && game._siegeDay) ? game._siegeDay : 1;
}
// Days past the authored script: escalate procedurally so the run is endless.
function _siegeProcDay(day) {
  const inf = 6 + day * 2;
  const tanks = Math.max(1, Math.floor((day - SIEGE_SCRIPT_MAX_DAY) / 2) + 1);
  const drones = 3 + (day - SIEGE_SCRIPT_MAX_DAY);   // swarm grows each day
  const cues = [
    { day, at: 0,  kind: 'tod',     name: (day % 2 ? 'night' : 'dusk') },
    { day, at: 0,  kind: 'weather', w: 'storm' },
    { day, at: 0,  kind: 'beat',    zh: '第 ' + day + ' 天 · 死守', en: 'DAY ' + day + ' · LAST STAND' },
    { day, at: 2,  kind: 'spawn',   unit: 'infantry', n: inf },
    { day, at: 10, kind: 'drone',   n: drones },
    { day, at: 16, kind: 'camera',  fx: 'shake', mag: 8, dur: 16 },
    { day, at: 17, kind: 'spawn',   unit: 'tank',     n: tanks },
    { day, at: 17, kind: 'camera',  fx: 'focus', on: 'tank', dur: 50 },
    { day, at: 26, kind: 'drone',   n: drones + 2 },
    { day, at: 34, kind: 'spawn',   unit: 'infantry', n: inf },
  ];
  return cues;
}

function _siegeCuesForDay(day) {
  return (day <= SIEGE_SCRIPT_MAX_DAY) ? SIEGE_SCRIPT.filter(c => c.day === day) : _siegeProcDay(day);
}
function _siegeStartDay(day) {
  game._siegeDay = day;
  game._siegeT = 0;
  game._siegeDayCues = _siegeCuesForDay(day);
  game._siegeFired = new Array(game._siegeDayCues.length).fill(false);
  game._siegeGapUntil = 0;
}

// Called once per sim tick from update() when game._siege.
function updateSiegeDirector() {
  if (typeof game === 'undefined' || !game._siege || game.state !== 'playing') return;
  if (typeof player !== 'undefined' && player && !player.alive) return;   // run ending — no new spawns
  if (game._siegeDay == null) _siegeStartDay(1);
  _siegeTankBreach();   // 坦克轰墙 — tanks chew through fort walls on contact

  // In the calm gap between days, just count down.
  if (game._siegeGapUntil && game._siegeT < game._siegeGapUntil) {
    game._siegeT += 1 / SIEGE_TICKS_PER_SEC;
    return;
  }
  if (game._siegeGapUntil && game._siegeT >= game._siegeGapUntil) {
    _siegeStartDay(game._siegeDay + 1);
    return;
  }

  game._siegeT += 1 / SIEGE_TICKS_PER_SEC;

  // Fire any due cues for the current day.
  const cues = game._siegeDayCues;
  let lastAt = 0;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].at > lastAt) lastAt = cues[i].at;
    if (!game._siegeFired[i] && game._siegeT >= cues[i].at) {
      game._siegeFired[i] = true;
      try { const h = _SIEGE_CUE[cues[i].kind]; if (h) h(cues[i]); } catch (e) { /* one bad cue can't kill the loop */ }
    }
  }

  // Day complete → enter the calm gap → next day. Conditions: every cue fired,
  // the grace window passed, and the field is cleared.
  const allFired = game._siegeFired.every(Boolean);
  if (allFired && game._siegeT >= lastAt + SIEGE_CLEAR_GRACE && _siegeAliveEnemies() === 0) {
    game._siegeGapUntil = game._siegeT + SIEGE_DAY_GAP_SEC;
    if (typeof showSwapToast === 'function') {
      const zh = (typeof getLang === 'function' && getLang() === 'zh');
      showSwapToast(zh ? ('▶ 第 ' + game._siegeDay + ' 天 守住了 · 整備') : ('▶ DAY ' + game._siegeDay + ' HELD · REGROUP'));
    }
  }
}

// ── Weather VISUAL (背景的改變) — a cheap screen-space overlay the 'weather' cue
// drives via game._siegeWeather. rain/storm = diagonal streaks; storm adds an
// occasional lightning flash. Registered as an FX layer (under the HUD).
function renderSiegeWeather() {
  if (typeof game === 'undefined' || !game._siege || game.state !== 'playing') return;
  const w = game._siegeWeather;
  if (w !== 'rain' && w !== 'storm' && w !== 'wind') return;
  if (typeof ctx === 'undefined' || !ctx) return;
  const W_ = (typeof W === 'function') ? W() : 800, H_ = (typeof H === 'function') ? H() : 600;
  const t = (typeof game.time === 'number') ? game.time : 0;
  ctx.save();
  // WIND — faint fast near-horizontal dust streaks (lighter than rain), no flash.
  if (w === 'wind') {
    ctx.strokeStyle = 'rgba(200, 195, 175, 0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 30; i++) {
      const seed = i * 51.7;
      const x = (seed * 17 + t * 34) % (W_ + 60) - 30;
      const y = (seed * 37) % H_;
      ctx.moveTo(x, y); ctx.lineTo(x - 18, y + 2);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }
  // Rain streaks — count + slant scale with intensity. Phase-scrolled by game.time.
  const count = (w === 'storm') ? 90 : 55;
  ctx.strokeStyle = 'rgba(170, 190, 210, 0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const seed = i * 73.13;
    const x = (seed * 13 + t * 9) % (W_ + 40) - 20;
    const y = (seed * 29 + t * 26) % (H_ + 40) - 20;
    ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 14);
  }
  ctx.stroke();
  // Storm: a brief lightning flash on a slow pseudo-random cadence.
  if (w === 'storm') {
    const f = Math.sin(t * 0.013) * Math.sin(t * 0.071);   // sparse peaks
    if (f > 0.985) { ctx.fillStyle = 'rgba(230,240,255,' + ((f - 0.985) / 0.015 * 0.35).toFixed(3) + ')'; ctx.fillRect(0, 0, W_, H_); }
  }
  ctx.restore();
}
if (typeof registerFxLayer === 'function') {
  registerFxLayer({ id: 'siege-weather', space: 'overlay-under-hud', draw: renderSiegeWeather });
}

// 防守关卡 indicator — a persistent top-center "DAY N" pill so the player always
// sees which siege stage they're on + the live threat (or the regroup countdown
// in the calm gap). The day beats are transient toasts; this is the always-on
// readout. Registered over the HUD.
function renderSiegeHud() {
  if (typeof game === 'undefined' || !game._siege || game.state !== 'playing') return;
  if (typeof ctx === 'undefined' || !ctx) return;
  const day = game._siegeDay || 1;
  const zh = (typeof getLang === 'function' && getLang() === 'zh');
  const inGap = !!(game._siegeGapUntil && game._siegeT < game._siegeGapUntil);
  const main = zh ? ('守城 · 第 ' + day + ' 天') : ('SIEGE · DAY ' + day);
  let sub, subCol;
  if (inGap) {
    const left = Math.max(0, Math.ceil((game._siegeGapUntil - game._siegeT) || 0));
    sub = zh ? ('整備 · 下一波 ' + left + 's') : ('REGROUP · NEXT ' + left + 's');
    subCol = '#5FD6A0';
  } else {
    const alive = _siegeAliveEnemies();
    sub = zh ? ('威脅 ' + alive) : ('THREAT ' + alive);
    subCol = '#E6B22C';
  }
  const W_ = (typeof W === 'function') ? W() : 800;
  const cx = W_ / 2, y = 2, h = 30;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = 'bold 14px sans-serif';
  const tw = Math.max(140, ctx.measureText(main).width + 44);
  const cream = (typeof COLORS !== 'undefined' && COLORS.cream) ? COLORS.cream : '#F2E9D0';
  const red = (typeof COLORS !== 'undefined' && COLORS.red) ? COLORS.red : '#C8261C';
  ctx.fillStyle = 'rgba(16,14,20,0.82)'; ctx.fillRect(cx - tw / 2, y, tw, h);
  ctx.fillStyle = red; ctx.fillRect(cx - tw / 2, y, 3, h);
  ctx.strokeStyle = cream; ctx.lineWidth = 1; ctx.strokeRect(cx - tw / 2 + 0.5, y + 0.5, tw - 1, h - 1);
  ctx.fillStyle = cream; ctx.fillText(main, cx, y + 13);
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = subCol; ctx.fillText(sub, cx, y + 25);
  ctx.restore();
}
if (typeof registerFxLayer === 'function') {
  registerFxLayer({ id: 'siege-hud', space: 'overlay-over-hud', draw: renderSiegeHud });
}
