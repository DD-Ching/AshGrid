// ============ AD-REWARDED RESPAWN BUFF (Phase 60) ============
// Watching a ~15-second rewarded ad grants a 30-minute "fast respawn" buff:
// respawn time drops 15s → 5s (÷3, per user '復活時間除以三'). State persists
// across reloads via localStorage so a player can watch once at session start
// and enjoy the faster respawn through their full play session.
//
// Used by:
//   • multiplayer.js  — kill handler reads getRespawnSeconds() to set the
//                       per-player respawn countdown (player._respawnAt) and
//                       the team-wipe overlay countdown.
//   • death_recap.js  — renders the "WATCH AD · 30 MIN BUFF" button + the
//                       buff status badge in the recap top strip.
//   • main HUD        — small badge top-right when buff is active.
//
// MP NOTE: the SERVER's RESPAWN_TICKS is also bumped to 15s in
// server/party/server.js so the actual revival timing matches what the UI
// shows. Client sends `buffActive` in its input payload; server uses 5s ticks
// for buffed players. Both must agree or the dead→alive transition stalls.
//
// Classic-script. Declares globally:
//   window.isRespawnBuffed()         · returns boolean
//   window.getRespawnSeconds()       · returns 15 or 5
//   window.getRespawnBuffMsLeft()    · ms until buff expires (0 if expired)
//   window.applyRespawnBuff()        · activate buff for DURATION_MS
//   window.RESPAWN_BUFF_CONFIG       · DEFAULT_SEC / BUFFED_SEC / DURATION_*

(function() {
  'use strict';

  const DEFAULT_SEC = 15;
  const BUFFED_SEC  = 5;
  const DURATION_MS = 30 * 60 * 1000;   // 30 minutes
  const KEY = 'ag.respawnBuffUntil';

  function getBuffUntilMs() {
    try {
      const v = parseInt(localStorage.getItem(KEY) || '0', 10);
      return isNaN(v) ? 0 : v;
    } catch (e) { return 0; }
  }
  function setBuffUntilMs(ts) {
    try { localStorage.setItem(KEY, String(ts)); } catch (e) {}
  }

  window.isRespawnBuffed = function() {
    return Date.now() < getBuffUntilMs();
  };
  window.getRespawnSeconds = function() {
    return window.isRespawnBuffed() ? BUFFED_SEC : DEFAULT_SEC;
  };
  window.getRespawnBuffMsLeft = function() {
    return Math.max(0, getBuffUntilMs() - Date.now());
  };
  window.applyRespawnBuff = function() {
    setBuffUntilMs(Date.now() + DURATION_MS);
  };

  window.RESPAWN_BUFF_CONFIG = {
    DEFAULT_SEC:  DEFAULT_SEC,
    BUFFED_SEC:   BUFFED_SEC,
    DURATION_MS:  DURATION_MS,
    DURATION_MIN: DURATION_MS / 60000,
  };
})();
