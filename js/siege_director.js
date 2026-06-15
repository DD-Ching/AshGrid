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
  { day: 2, at: 30, kind: 'spawn',   unit: 'infantry', n: 6 },

  // ── DAY 3 — night, storm, tanks + a crush ──
  { day: 3, at: 0,  kind: 'tod',     name: 'night' },
  { day: 3, at: 0,  kind: 'weather', w: 'storm' },
  { day: 3, at: 0,  kind: 'beat',    zh: '第 3 天 · 夜 · 風暴突襲', en: 'DAY 3 · NIGHT · STORM ASSAULT' },
  { day: 3, at: 2,  kind: 'spawn',   unit: 'infantry', n: 8 },
  { day: 3, at: 15, kind: 'camera',  fx: 'shake', mag: 8, dur: 18 },
  { day: 3, at: 16, kind: 'spawn',   unit: 'tank',     n: 2 },
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
  tod(c)     { if (typeof TOD !== 'undefined' && c.name) TOD.setTOD(c.name); },
  weather(c) { if (typeof game !== 'undefined') game._siegeWeather = c.w || 'clear'; },
  camera(c)  { if (c.fx === 'shake' && typeof triggerShake === 'function') triggerShake(c.mag || 6, c.dur || 14); },
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

// ── Runtime ─────────────────────────────────────────────────────────────────
function _siegeAliveEnemies() {
  if (typeof enemies === 'undefined' || !enemies) return 0;
  let n = 0; for (const e of enemies) if (e && e.alive && !e._koStunned) n++;
  return n;
}
function _siegeDayLabel() {   // for the HUD / end-card ("survived N days")
  return (typeof game !== 'undefined' && game._siegeDay) ? game._siegeDay : 1;
}
// Days past the authored script: escalate procedurally so the run is endless.
function _siegeProcDay(day) {
  const inf = 6 + day * 2;
  const tanks = Math.max(1, Math.floor((day - SIEGE_SCRIPT_MAX_DAY) / 2) + 1);
  const cues = [
    { day, at: 0,  kind: 'tod',     name: (day % 2 ? 'night' : 'dusk') },
    { day, at: 0,  kind: 'weather', w: 'storm' },
    { day, at: 0,  kind: 'beat',    zh: '第 ' + day + ' 天 · 死守', en: 'DAY ' + day + ' · LAST STAND' },
    { day, at: 2,  kind: 'spawn',   unit: 'infantry', n: inf },
    { day, at: 16, kind: 'camera',  fx: 'shake', mag: 8, dur: 16 },
    { day, at: 17, kind: 'spawn',   unit: 'tank',     n: tanks },
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
