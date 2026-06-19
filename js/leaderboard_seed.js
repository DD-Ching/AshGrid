// ============ LEADERBOARD SEED (Phase 139b) ============
// The live Firebase board is currently 100% dev test data — every row is
// named "0451" (the default callsign in leaderboard.js:_lbCurrentName). An
// all-same-name board on the title screen reads as broken / a prototype —
// the exact opposite of the "feels like real players" goal that drove the
// bot-name work. This module makes the board ALWAYS look like a populated,
// believable ranked ladder:
//
//   • SANITIZE — drop the default-callsign pollution ("0451…") so dev test
//     data doesn't fill the board. The local player's OWN row is preserved
//     even if they kept the default name (so real progress still shows).
//   • SEED — a stable roster of .io-style human handles (reusing pickBotName)
//     with a plausible long-tail kill curve, so the board is never empty.
//   • BLEND — genuine real entries (custom names) win over seeds on a name
//     collision and out-rank them by real kill count, so as real players
//     arrive they naturally take over the board.
//
// SCOPE: presentation only. No Firebase writes, no gameplay coupling. The
// roster is generated ONCE per session (cached) so it stays stable across
// the 30s auto-refresh + the manual REFRESH button (no distracting reshuffle).
//
// Classic-script. Declares globally:
//   lbSeedRoster()                       → cached believable competitor array
//   _lbDisplayList(realTop, myUuid, n)   → sanitized + blended + sorted top-n
//
// External deps (resolved at call-time): pickBotName (js/bot_names.js)
(function() {
  'use strict';

  // Junk = the dev test pollution: default-callsign names. Anything starting
  // "0451" (the default operator id) is treated as not-a-real-player.
  function _isJunkName(name) {
    if (!name) return true;
    const n = String(name).trim();
    if (n === '' || n === '?') return true;
    if (/^0451/i.test(n)) return true;
    return false;
  }

  function _kdOf(e) {
    if (e.kd != null) return e.kd;
    return (e.deaths > 0) ? (e.kills / e.deaths) : e.kills;
  }

  // Believable ranked ladder: a fixed [kills, K/D] shape (so #1 always
  // dominates and the tail tapers like a real active board) paired with
  // session-varied human handles.
  let _roster = null;
  function lbSeedRoster() {
    if (_roster) return _roster;
    const pick = (typeof pickBotName === 'function')
      ? pickBotName
      : (function () { let i = 0; return () => 'rookie' + (++i); })();
    const SHAPE = [
      [1840, 2.9], [1655, 3.4], [1490, 2.1], [1322, 4.1], [1198, 1.8],
      [1067, 2.6], [ 944, 3.0], [ 861, 1.5], [ 770, 2.2], [ 689, 3.7],
      [ 612, 1.9], [ 548, 2.4], [ 470, 1.3], [ 405, 2.8], [ 351, 1.6],
      [ 288, 2.0], [ 233, 1.1], [ 187, 2.5],
    ];
    const used = new Set();
    _roster = SHAPE.map(function (row, i) {
      const kills = row[0], kd = row[1];
      let nm = pick(), guard = 0;
      while (used.has(nm.toLowerCase()) && guard++ < 10) nm = pick();
      used.add(nm.toLowerCase());
      const deaths = Math.max(1, Math.round(kills / kd));
      return {
        uuid:       '_seed_' + i,   // never collides with a real player uuid
        name:       nm,
        kills:      kills,
        deaths:     deaths,
        bestStreak: Math.max(3, Math.round(kd * 4)),
        matches:    Math.max(5, Math.round(kills / 18)),
        kd:         kd,
        _seed:      true,
      };
    });
    return _roster;
  }

  // Merge sanitized-real + seed, dedupe by name (real wins), sort by kills
  // then K/D, take top N. Seeds carry synthetic uuids so the render's
  // "this is me" highlight never falsely fires on a seed row.
  function _lbDisplayList(realTop, myUuid, limit) {
    limit = limit || 20;
    const real = (realTop || []).filter(function (e) {
      return (myUuid && e.uuid === myUuid) || !_isJunkName(e.name);
    });
    const byName = new Map();
    lbSeedRoster().forEach(function (e) { byName.set(String(e.name).toLowerCase(), e); });
    real.forEach(function (e) { byName.set(String(e.name).toLowerCase(), e); });
    // opt R12 — pin the LOCAL player's real progress (getGlobalStats) as a YOU row
    // so the board is a genuine progression hook (your kills climb the ladder),
    // not 100% strangers, even before any server sync. Merge with any existing
    // real row (take the higher kills) and stamp _you/uuid so the render highlights.
    try {
      if (typeof getGlobalStats === 'function') {
        var gs = getGlobalStats();
        var youName = (typeof getOperatorName === 'function') ? getOperatorName() : 'YOU';
        var youKey = String(youName).toLowerCase();
        if (!_isJunkName(youName) || (gs.totalKills || 0) > 0) {
          var existing = byName.get(youKey);
          var kills = Math.max(gs.totalKills || 0, existing ? existing.kills : 0);
          var deaths = Math.max(1, Math.round(kills / 1.6));
          byName.set(youKey, {
            uuid: (existing && existing.uuid) || myUuid || '_you_local',
            name: youName, kills: kills, deaths: deaths,
            bestStreak: gs.bestStreak || (existing && existing.bestStreak) || 0,
            matches: gs.matchesPlayed || 0,
            kd: deaths > 0 ? kills / deaths : kills, _you: true,
          });
        }
      }
    } catch (e) {}
    return [...byName.values()].sort(function (a, b) {
      if (b.kills !== a.kills) return b.kills - a.kills;
      return _kdOf(b) - _kdOf(a);
    }).slice(0, limit);
  }

  window.lbSeedRoster = lbSeedRoster;
  window._lbDisplayList = _lbDisplayList;
})();
