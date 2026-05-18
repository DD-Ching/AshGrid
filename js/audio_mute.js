// ============ AUDIO MUTE STACK (R14) =======================================
// Centralised audio mute with two distinct concerns:
//
//   USER PREFERENCE (persistent)
//     The player's explicit mute choice. Persisted to localStorage. Set by
//     the pause-menu mute button + CrazyGames portal settings event. Survives
//     reloads. Wins over the transient stack — if user said muted, it's muted.
//
//   TRANSIENT SOURCES (stack)
//     Code-driven temporary mutes. Each source name is unique:
//       'ad'             — rewarded ad playing (ad_state.js)
//       'cg_external'    — could be used for SDK-managed transient mutes
//     Audio is muted iff (user preference == muted) OR (stack size > 0).
//
// Why this matters: pre-R14, the audio system had FOUR independent writers
// to AUDIO.muted with no priority queue. Most common silent failure:
//   1. Ad starts → ad_state.js does `setAudioMuted(true)` + saves
//      `_audioMutedByAd = true` so unmute later knows to revert
//   2. User toggles pause-menu mute OFF (audio plays during ad — bug!)
//   3. Ad ends → `setAudioMuted(false)` because _audioMutedByAd was true,
//      now audio plays correctly post-ad
// Or the mirror: user mutes during ad → _audioMutedByAd flag goes stale →
// audio comes back on after the ad even though user wanted it off.
//
// R14 fixes both by tracking sources independently. setAudioMuted is kept
// as a back-compat shim that delegates to AudioMute.setUserMuted (the
// user-preference path), so old callsites still work.
//
// Classic-script. Declares globally:
//   window.AudioMute = {
//     setUserMuted(muted), isUserMuted(),                  · persistent
//     requestMute(source), releaseMute(source),            · transient stack
//     getActiveSources(),                                  · debug
//     isCurrentlyMuted(),                                  · effective state
//   }
//
// External deps (call-time):
//   AUDIO (from audio/positional.js — AUDIO.master.gain.value, AUDIO.volume)
//   localStorage

(function() {
  'use strict';

  const STORAGE_KEY = 'ag.muted';

  // ─── State ───────────────────────────────────────────────────────────
  // Persistent user preference. Restored from localStorage on script init
  // so a reload mid-mute doesn't surprise the player with sound. Default
  // false — audio on by default.
  let _userMuted = false;
  try {
    _userMuted = (localStorage.getItem(STORAGE_KEY) === '1');
  } catch (e) {}

  // Stack of transient mute requesters. Set so re-requests from the same
  // source are idempotent (calling requestMute('ad') twice = one entry).
  const _transientSources = new Set();

  // ─── Internal: apply to AUDIO object ─────────────────────────────────
  // The CANONICAL low-level write. Does NOT persist to localStorage —
  // only setUserMuted touches storage, so transient mutes don't bleed
  // into the user's saved preference.
  function _applyToAudio() {
    const muted = _userMuted || _transientSources.size > 0;
    if (typeof AUDIO !== 'undefined') {
      AUDIO.muted = muted;
      if (AUDIO.master) AUDIO.master.gain.value = muted ? 0 : AUDIO.volume;
    }
  }

  // ─── Public: persistent user preference ──────────────────────────────
  function setUserMuted(muted) {
    _userMuted = !!muted;
    try { localStorage.setItem(STORAGE_KEY, _userMuted ? '1' : '0'); } catch (e) {}
    _applyToAudio();
  }
  function isUserMuted() {
    return _userMuted;
  }

  // ─── Public: transient mute sources ──────────────────────────────────
  function requestMute(source) {
    if (typeof source !== 'string' || !source) return;
    _transientSources.add(source);
    _applyToAudio();
  }
  function releaseMute(source) {
    if (typeof source !== 'string' || !source) return;
    _transientSources.delete(source);
    _applyToAudio();
  }
  function getActiveSources() {
    return Array.from(_transientSources);
  }
  function isCurrentlyMuted() {
    return _userMuted || _transientSources.size > 0;
  }

  // ─── Init: ensure AUDIO.muted reflects restored user preference ──────
  // audio/positional.js does this same restore at script init, but R14
  // runs after positional.js so we re-apply with our combined logic in
  // case any sources got requested during the boot window.
  _applyToAudio();

  window.AudioMute = {
    setUserMuted,
    isUserMuted,
    requestMute,
    releaseMute,
    getActiveSources,
    isCurrentlyMuted,
  };
})();
