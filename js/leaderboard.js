// ============ LEADERBOARD (Phase 23) ============
// Persistent global ranking backed by Firebase Realtime Database. Counters
// (kills / deaths / best streak / matches) live in localStorage too so the
// player's progress never goes backwards on a network blip, and we push the
// latest snapshot to Firebase ~every 8 seconds (debounced) plus on
// beforeunload for a clean tail.
//
// No SDK — REST API only. PUT for upsert, GET for read; rules stay
// '.read: true / .write: true' (same as MP signalling — public, no
// auth, no secrets). The leaderboard is client-authoritative (anyone CAN
// post fake numbers) but that's an acceptable v1 trade for an .io with
// no monetary stakes. When/if revenue starts, swap to Cloud Functions +
// per-uuid sign-off.
//
// Classic-script. Declares globally:
//   _lbStats · _lbBumpKill() · _lbBumpDeath() · _lbBumpMatch() ·
//   _lbReportStreak(n) · _lbFetchTop(limit) · _lbMyUuid()
//
// External deps: getOperatorName (resolved at call-time)

const LB_FIREBASE_URL    = 'https://ashgo-1bfec-default-rtdb.asia-southeast1.firebasedatabase.app';
const LB_STORAGE_KEY     = 'ag.lbStats';
const LB_UUID_KEY        = 'ag.playerId';
const LB_PUSH_THROTTLE_MS = 8000;
const LB_FETCH_CACHE_MS  = 30000;   // refresh top list at most every 30 s

const _lbStats = {
  uuid:        null,
  kills:       0,
  deaths:      0,
  bestStreak:  0,
  matches:     0,
  lastSeen:    0,
};
let _lbLastPushAt = 0;
let _lbPushTimer  = null;
let _lbTopCache   = null;
let _lbTopFetchedAt = 0;

(function _lbInit() {
  try {
    let uuid = localStorage.getItem(LB_UUID_KEY);
    if (!uuid) {
      uuid = 'p' + Math.random().toString(36).slice(2, 10)
                 + Date.now().toString(36).slice(-4);
      localStorage.setItem(LB_UUID_KEY, uuid);
    }
    _lbStats.uuid = uuid;
    const saved = JSON.parse(localStorage.getItem(LB_STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      _lbStats.kills      = +saved.kills      || 0;
      _lbStats.deaths     = +saved.deaths     || 0;
      _lbStats.bestStreak = +saved.bestStreak || 0;
      _lbStats.matches    = +saved.matches    || 0;
      _lbStats.lastSeen   = +saved.lastSeen   || 0;
    }
  } catch (e) {/* localStorage disabled — leaderboard runs in-memory only */}
})();

function _lbMyUuid() { return _lbStats.uuid; }
function _lbCurrentName() {
  return (typeof getOperatorName === 'function') ? getOperatorName() : '0451';
}

function _lbSaveLocal() {
  try { localStorage.setItem(LB_STORAGE_KEY, JSON.stringify(_lbStats)); }
  catch (e) {}
}

function _lbBumpKill() {
  _lbStats.kills += 1;
  _lbStats.lastSeen = Date.now();
  _lbSaveLocal();
  _lbSchedulePush();
}
function _lbBumpDeath() {
  _lbStats.deaths += 1;
  // Phase 104 — also tick a per-match death counter so the new HUD
  // Score Block can show 'DEATHS N' alongside KILLS / TIME. Reset to 0
  // alongside game.killCount in the match-start paths.
  if (typeof game !== 'undefined') game.deaths = (game.deaths || 0) + 1;
  _lbStats.lastSeen = Date.now();
  _lbSaveLocal();
  _lbSchedulePush();
}
function _lbBumpMatch() {
  _lbStats.matches += 1;
  _lbStats.lastSeen = Date.now();
  _lbSaveLocal();
  _lbSchedulePush();
}
function _lbReportStreak(s) {
  if (s > _lbStats.bestStreak) {
    _lbStats.bestStreak = s;
    _lbSaveLocal();
    _lbSchedulePush();
  }
}

// Debounce + throttle: every bump kicks a deferred push, but we never push
// more than once per LB_PUSH_THROTTLE_MS. The trailing push catches the
// last few kills in a streak so the player's count stays consistent.
function _lbSchedulePush() {
  if (_lbPushTimer) return;
  const elapsed = Date.now() - _lbLastPushAt;
  const delay = Math.max(200, LB_PUSH_THROTTLE_MS - elapsed);
  _lbPushTimer = setTimeout(() => {
    _lbPushTimer = null;
    _lbPushNow();
  }, delay);
}

async function _lbPushNow() {
  if (!_lbStats.uuid) return;
  const payload = {
    name:       _lbCurrentName().slice(0, 12),
    kills:      _lbStats.kills,
    deaths:     _lbStats.deaths,
    bestStreak: _lbStats.bestStreak,
    matches:    _lbStats.matches,
    lastSeen:   Date.now(),
  };
  _lbLastPushAt = Date.now();
  try {
    await fetch(`${LB_FIREBASE_URL}/leaderboard/${encodeURIComponent(_lbStats.uuid)}.json`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('[lb] push failed', e);
  }
}

// Fetch top N by kills. Cached for 30 s so the lobby render doesn't hit
// Firebase on every frame; the cache is invalidated when the player
// returns to the lobby (callers can pass force=true).
async function _lbFetchTop(limit = 20, force = false) {
  if (!force && _lbTopCache && (Date.now() - _lbTopFetchedAt < LB_FETCH_CACHE_MS)) {
    return _lbTopCache;
  }
  try {
    const r = await fetch(`${LB_FIREBASE_URL}/leaderboard.json`);
    if (!r.ok) return [];
    const data = (await r.json()) || {};
    const arr = Object.entries(data).map(([uuid, v]) => ({
      uuid,
      name:       (v && v.name) || '?',
      kills:      (v && +v.kills)      || 0,
      deaths:     (v && +v.deaths)     || 0,
      bestStreak: (v && +v.bestStreak) || 0,
      matches:    (v && +v.matches)    || 0,
      kd:         (v && v.deaths > 0)  ? (v.kills / v.deaths) : (v && +v.kills) || 0,
    }));
    // Sort by kills desc, tie-break by K/D, then by streak. Drops anyone
    // with 0 kills (fresh / abandoned UUIDs) so the list stays alive.
    const ranked = arr.filter(e => e.kills > 0).sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (b.kd    !== a.kd)    return b.kd    - a.kd;
      return b.bestStreak - a.bestStreak;
    }).slice(0, limit);
    _lbTopCache = ranked;
    _lbTopFetchedAt = Date.now();
    return ranked;
  } catch (e) {
    console.warn('[lb] fetch top failed', e);
    return _lbTopCache || [];
  }
}

// Tail push on page hide so the last few kills of a session don't get
// stuck waiting for the debounced timer. `pagehide` fires reliably on
// mobile Safari where `beforeunload` doesn't.
window.addEventListener('pagehide', () => {
  if (_lbPushTimer) { clearTimeout(_lbPushTimer); _lbPushTimer = null; }
  _lbPushNow();
});
window.addEventListener('beforeunload', () => {
  if (_lbPushTimer) { clearTimeout(_lbPushTimer); _lbPushTimer = null; }
  _lbPushNow();
});
