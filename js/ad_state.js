// ============ AD LIFECYCLE STATE MACHINE (R1 refactor) ============
// Explicit FSM for the rewarded-ad reward flow.
//
// Previous design: gamemonetize.js held 5 boolean / timestamp flags
// (_pendingAdCb, _didReallyPause, _adReallyPlaying, _adPlayStartedAt,
// _audioMutedByAd) plus two timers (load + placeholder countdown). Every
// SDK event handler mutated them inline and every fix had to consider
// every other handler's expectations. Phase 112 ('strict reward gate')
// was the third bug fix in that file in a single week.
//
// New design (R1): all reward logic lives here as a five-state FSM. The
// SDK adapter (gamemonetize.js) just forwards events and observes state.
// death_recap.js calls requestRewarded() and waits for cb(earned).
//
// States + transitions:
//
//   IDLE
//     │ requestRewarded(cb) → set overlay 'loading' + pause game
//     ▼
//   LOADING ─── onSdkPause()    ──► PLAYING
//     │
//     │ (loadTimeout, no PAUSE in 4 s) → fall back to local placeholder
//     ▼
//   COUNTDOWN ─ onSdkPause()    ──► PLAYING   (rare: late fill)
//     │
//     │ (countdownExpire, 15 s)      → finalize(TRUE) — Phase 120 lenient
//     │ onSdkStart() (no fill)       → finalize(false, '暫無廣告')
//     ▼
//   PLAYING ── onSdkStart()     ──► check elapsed vs MIN_REWARD_PLAY_MS
//                                   → finalize(earned)
//
//   Any state ── any onSdkStart without prior PAUSE in this request
//                ──► finalize(false, '暫無廣告') (no reward freebie)
//
// Public API (window.adState):
//   requestRewarded(cb)   → start ad flow; cb fires once with (earned: bool)
//   onSdkPause()          → SDK_GAME_PAUSE event arrived
//   onSdkStart()          → SDK_GAME_START event arrived
//   getState()            → current FSM state string (for debug)
//   isAdActive()          → !== 'IDLE' (any in-flight)
//
// Constants exported:
//   MIN_REWARD_PLAY_MS = 12000     // minimum ad watch time for reward
//
// External deps: AUDIO · setAudioMuted · showSwapToast · game · T (all
// optional via typeof guards so this module can load before they exist).
// DOM deps: #adPlayOverlay, #adPlayCountdown, #adPlayCountdownTrail.

(function() {
  'use strict';

  // Phase 121 — lowered 12s → 8s. Real GM ads commonly run 10-15s; smoke
  // test on localhost showed a fully-played Google video ad clocking at
  // 11.8s (FIRST_QUARTILE→COMPLETE), tripped 12s gate, earned=false, no
  // buff. The gate's purpose is to deny ACTIVE SKIPS (user closes ad
  // overlay early), and 8s is enough to ensure the player saw a real ad
  // start playing rather than the SDK-close happening on a no-fill race.
  const MIN_REWARD_PLAY_MS    = 8 * 1000;
  const LOAD_TIMEOUT_MS       = 4 * 1000;
  const PLACEHOLDER_DURATION  = 15;        // seconds

  const S = {
    IDLE:      'IDLE',
    LOADING:   'LOADING',
    COUNTDOWN: 'COUNTDOWN',
    PLAYING:   'PLAYING',
  };

  let _state            = S.IDLE;
  let _pendingCb        = null;
  let _adPlayStartedAt  = 0;
  let _loadTimer        = null;
  let _countdownTimer   = null;
  let _countdownExpiry  = null;
  let _audioMutedByAd   = false;

  function _log(msg) { try { console.log('[ad_state]', msg); } catch (e) {} }
  function _transition(next) {
    _log(`${_state} → ${next}`);
    _state = next;
  }

  function _clearTimers() {
    if (_loadTimer)       { clearTimeout(_loadTimer);        _loadTimer       = null; }
    if (_countdownTimer)  { clearInterval(_countdownTimer);  _countdownTimer  = null; }
    if (_countdownExpiry) { clearTimeout(_countdownExpiry);  _countdownExpiry = null; }
  }

  // ─── Overlay DOM (private) ──────────────────────────────────────
  function _overlayShowLoading() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('adPlayOverlay');
    if (!el) return;
    el.style.display = 'flex';
    const cd    = document.getElementById('adPlayCountdown');
    const trail = document.getElementById('adPlayCountdownTrail');
    if (cd)    cd.textContent    = '…';
    if (trail) trail.textContent = 'loading';
  }

  function _overlayStartCountdown(durationSec) {
    const cd    = document.getElementById && document.getElementById('adPlayCountdown');
    const trail = document.getElementById && document.getElementById('adPlayCountdownTrail');
    let remaining = durationSec;
    if (cd)    cd.textContent    = String(remaining);
    if (trail) trail.textContent = String(remaining);
    if (_countdownTimer) clearInterval(_countdownTimer);
    _countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining < 0) remaining = 0;
      if (cd)    cd.textContent    = String(remaining);
      if (trail) trail.textContent = String(remaining);
      if (remaining <= 0) {
        clearInterval(_countdownTimer);
        _countdownTimer = null;
      }
    }, 1000);
  }

  function _overlayHide() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('adPlayOverlay');
    if (el) el.style.display = 'none';
  }

  // ─── Audio mute (GM requires no game audio during ads) ──────────
  // R14 — was inline `setAudioMuted(true)` + a `_audioMutedByAd` flag to
  // remember whether to restore. The flag-based design got confused if
  // the user toggled their persistent mute preference during an ad (the
  // flag went stale → ad-end unmute either erased the user's preference
  // OR left audio unmuted while user wanted it off). AudioMute's
  // user-pref + transient-stack split makes the user preference and the
  // ad's transient request independent.
  function _muteForAd() {
    if (typeof AudioMute !== 'undefined') {
      AudioMute.requestMute('ad');
    } else if (typeof setAudioMuted === 'function') {
      // Fallback if R14 didn't load — old behaviour
      _audioMutedByAd = (typeof AUDIO !== 'undefined') && !AUDIO.muted;
      if (_audioMutedByAd) setAudioMuted(true);
    }
  }
  function _unmuteAfterAd() {
    if (typeof AudioMute !== 'undefined') {
      AudioMute.releaseMute('ad');
    } else if (_audioMutedByAd && typeof setAudioMuted === 'function') {
      setAudioMuted(false);
      _audioMutedByAd = false;
    }
  }

  // ─── Reward finalisation — single exit path ─────────────────────
  function _finalize(earned, toastMsg) {
    _overlayHide();
    _clearTimers();
    _unmuteAfterAd();
    if (typeof game !== 'undefined') game._paused = false;
    if (_pendingCb) {
      if (!earned && toastMsg && typeof showSwapToast === 'function') {
        try { showSwapToast(toastMsg); } catch (e) {}
      }
      try { _pendingCb(earned); } catch (e) {}
      _pendingCb = null;
    }
    _adPlayStartedAt = 0;
    _transition(S.IDLE);
  }

  // ─── Public API ─────────────────────────────────────────────────
  function requestRewarded(cb) {
    if (_state !== S.IDLE) {
      _log('requestRewarded ignored — state is ' + _state);
      if (cb) try { cb(false); } catch (e) {}
      return false;
    }
    _pendingCb       = cb || null;
    _adPlayStartedAt = 0;
    _audioMutedByAd  = false;
    _transition(S.LOADING);
    _overlayShowLoading();
    if (typeof game !== 'undefined') game._paused = true;
    _loadTimer = setTimeout(() => {
      _loadTimer = null;
      if (_state !== S.LOADING) return;
      // No SDK_GAME_PAUSE in the load window — assume GM has no fill.
      // Run the local placeholder countdown so the UX is consistent;
      // when it expires we'll deny the reward (no real ad watched).
      _transition(S.COUNTDOWN);
      _overlayStartCountdown(PLACEHOLDER_DURATION);
      _countdownExpiry = setTimeout(() => {
        _countdownExpiry = null;
        if (_state === S.COUNTDOWN) {
          // Phase 120 — placeholder-only path now grants the reward.
          //
          // Old behaviour (Phase 112 strict gate): no GM fill in the 4 s
          // load window → COUNTDOWN → 15 s placeholder → finalize(false)
          // with "暫無廣告 · 再試一次" toast. Designed to prevent freebies
          // when no real ad served.
          //
          // Reality on ashgrid.io: GM rarely has inventory preloaded by
          // the FIRST death of a session (preloadAd('rewarded') fires on
          // SDK_READY but ashgrid.io got 0/1 fill rate during the first
          // ~30 s of a fresh load). So every player's first WATCH AD
          // click hit this branch and lost their respawn buff. User:
          // '第一次看完廣告並不會有直接這個獎勵,並沒有發放復活5秒鐘的獎勵'.
          //
          // New contract: the visible 15 s ad-mode IS the deal. If the
          // player sat through it (couldn't dismiss — no skip button),
          // grant the reward whether or not a real ad served. No fraud
          // window: 15 s wait per click, buff lasts 30 min, so spam-
          // clicking just re-extends an already-active buff. Real-ad
          // path (onSdkStart, line below) keeps its 12 s MIN_REWARD_PLAY
          // gate to discourage real-ad skips.
          _log('countdown expired with no fill — granting reward (Phase 120 lenient)');
          _finalize(true);
        }
      }, PLACEHOLDER_DURATION * 1000);
    }, LOAD_TIMEOUT_MS);
    return true;
  }

  function onSdkPause() {
    // Real ad starting. Transition into PLAYING regardless of where we are
    // (LOADING normally; COUNTDOWN if GM filled late). Drop the placeholder.
    if (_state === S.IDLE) {
      // Pre-roll / midgame ad that wasn't requested via requestRewarded.
      // Still want to mute audio + pause game.
      _muteForAd();
      if (typeof game !== 'undefined') game._paused = true;
      _adPlayStartedAt = Date.now();
      _transition(S.PLAYING);
      return;
    }
    _clearTimers();
    _overlayHide();
    _muteForAd();
    _adPlayStartedAt = Date.now();
    _transition(S.PLAYING);
    if (typeof game !== 'undefined') game._paused = true;
  }

  function onSdkStart() {
    // Ad finished (real ad ended OR GM dropped without serving).
    if (_state === S.PLAYING) {
      const elapsed = Date.now() - _adPlayStartedAt;
      const earned  = elapsed >= MIN_REWARD_PLAY_MS;
      _log(`PLAYING → close, elapsed=${(elapsed/1000).toFixed(1)}s earned=${earned}`);
      _finalize(earned, earned ? null : '▶ 提前跳過 — 沒有獎勵');
      return;
    }
    if (_state === S.LOADING || _state === S.COUNTDOWN) {
      // SDK_GAME_START fired WITHOUT a preceding SDK_GAME_PAUSE → no real
      // ad ever played. Refuse the reward (this used to be the freebie
      // bug — Phase 112's _didReallyPause flag, now an explicit state).
      _log(`${_state} → close, no real ad played`);
      _finalize(false, '▶ 暫無廣告 · 再試一次');
      return;
    }
    // IDLE — stray event, ignore.
  }

  function getState()   { return _state; }
  function isAdActive() { return _state !== S.IDLE; }

  // Expose globally for SDK adapter (gamemonetize.js) and callers.
  window.adState = {
    requestRewarded,
    onSdkPause,
    onSdkStart,
    getState,
    isAdActive,
    MIN_REWARD_PLAY_MS,
  };
})();
