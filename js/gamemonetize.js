// ============ GAMEMONETIZE SDK ADAPTER (R1: thin) ============
// Phase 73 — ad backend for builds running OUTSIDE the CrazyGames portal
// (ashgrid.io, dev.ashgrid.pages.dev, anywhere on .pages.dev, localhost,
// any other partner site that mirrors the game). Same wrapper surface as
// js/crazygames.js so the rest of the codebase (death_recap.js,
// crazyNoteDeath in index.html, etc.) doesn't care which network is live.
//
// R1 refactor — this file is now a THIN adapter around the GM SDK:
//   • loads + configures the SDK script
//   • forwards SDK_READY / SDK_GAME_PAUSE / SDK_GAME_START events to
//     window.adState (js/ad_state.js, which owns the actual FSM)
//   • exports the legacy crazyAd_* / gm* wrapper functions so existing
//     callsites in index.html + death_recap.js need no changes.
//
// All reward gating, overlay UI, audio mute, retry logic, the 5-state
// FSM, and the 15-s placeholder timer live in js/ad_state.js. See its
// header for the state diagram. Bugs around reward gating belong there;
// this file just speaks SDK.
//
// HOW TO ACTIVATE REAL ADS:
//   1. Sign up at https://gamemonetize.com/ → Add new game
//   2. Copy your gameId (looks like 'e7e3ee04b96a4d568e0d9e95b56f4c12')
//   3. Replace GM_GAME_ID below
//   4. git push → live in ~60 sec
//
// While GM_GAME_ID is empty the wrapper installs in DEV MODE — ad calls
// log to console + fire the success callback after a short delay so the
// Phase 60 ad-revive flow + UI continue to work end-to-end. Useful for
// local testing without pulling production ad inventory.
//
// Classic-script. Declares globally (window-level so death_recap.js +
// index.html see them):
//   crazyAd_midgame  · crazyAd_rewarded · crazyNoteDeath
//   crazyEvent_gameplayStart · crazyEvent_gameplayStop · crazyEvent_happytime
//   crazyEvent_loadingStop · isCrazyReady · gmPreroll · gmEndMatch
//   (and crazyMp_* shims that no-op outside the CG portal)
//
// External deps: location · game · console · window.adState

(function() {
  'use strict';

  // ─── Configuration ────────────────────────────────────────────────
  // Phase 81 — AshGrid's GameMonetize gameId.
  // Registered at https://gamemonetize.com/dashboard
  // Revenue routes to ddchingm513kj@gmail.com PayPal once payable balance
  // reaches the $100/month threshold.
  const GM_GAME_ID = 'pvjqfc42w9qdarpjdi0r21a0wpe3s77w';

  // Throttle: floor on time between consecutive midgame interstitials.
  // Rewarded ads bypass this throttle since the player explicitly chose
  // to watch one (Phase 60 ad-revive button).
  const MIN_AD_INTERVAL_MS = 90 * 1000;

  // ─── Hostname gate ────────────────────────────────────────────────
  // Skip this module entirely if we're inside the CrazyGames portal —
  // crazygames.js owns ads in that environment (higher RPM, native
  // inventory). Detected by hostname AND a fallback URL flag for local
  // testing.
  const onCrazyGames =
    (typeof location !== 'undefined' && /crazygames\.com$/.test(location.hostname)) ||
    (typeof location !== 'undefined' && /[?&]crazyGames=1\b/.test(location.search));
  if (onCrazyGames) {
    console.log('[gamemonetize] CrazyGames host detected → standing down (CG SDK active)');
    return;
  }

  let _ready          = false;
  let _lastAdAt       = 0;
  let _deathCount     = 0;
  let _prerollFired   = false;
  const _devMode      = !GM_GAME_ID;

  // ─── Load GM SDK (only when configured) ───────────────────────────
  if (_devMode) {
    console.log('[gamemonetize] DEV MODE — no GM_GAME_ID set. Ad calls succeed without playing real ads. Edit js/gamemonetize.js to enable real ads on ashgrid.io.');
    _ready = true;
  } else {
    // GM SDK reads window.SDK_OPTIONS at load time.
    window.SDK_OPTIONS = {
      gameId: GM_GAME_ID,
      onEvent: function(event) {
        if (!event || !event.name) return;
        switch (event.name) {
          case 'SDK_READY':
            _ready = true;
            console.log('[gamemonetize] SDK ready');
            // Preload rewarded ad inventory so the first 'Watch Ad' click
            // plays instantly (no 1-2 s network wait).
            try {
              if (window.sdk && typeof window.sdk.preloadAd === 'function') {
                window.sdk.preloadAd('rewarded');
              }
            } catch (e) {}
            // Override the ad_stubs.js `requestRewardedAd` stub (which
            // just simulates 500 ms + always succeeds) with the real GM
            // showAd(rewarded) path. This wires the green 'WATCH AD ·
            // REVIVE' button in death_recap.js to an actual sdk.show-
            // Banner() call via showAd → adState.requestRewarded.
            try {
              if (typeof window.requestRewardedAd === 'function'
                  && !window._requestRewardedAd_gm_wired) {
                window._requestRewardedAd_stub = window.requestRewardedAd;
                window.requestRewardedAd = function(rewardId, cb) {
                  showAd(function(ok) {
                    if (cb) try { cb(ok, { rewardId, amount: 1 }); } catch (e) {}
                  }, { rewarded: true });
                };
                window._requestRewardedAd_gm_wired = true;
                console.log('[gamemonetize] requestRewardedAd → adState wired');
              }
            } catch (e) {}
            break;
          case 'SDK_GAME_PAUSE':
            // GM signals: real ad iframe is about to / has started playing.
            // Delegate state changes (pause game, mute audio, hide
            // placeholder overlay, mark playStartedAt) to ad_state.
            if (window.adState) {
              try { window.adState.onSdkPause(); } catch (e) { console.warn('[gamemonetize] onSdkPause threw', e); }
            } else {
              // Fallback if ad_state.js failed to load.
              if (typeof game !== 'undefined') game._paused = true;
            }
            break;
          case 'SDK_GAME_START':
            // GM signals: ad ended (full play, skip, or close). Delegate
            // reward decision + cleanup to ad_state.
            if (window.adState) {
              try { window.adState.onSdkStart(); } catch (e) { console.warn('[gamemonetize] onSdkStart threw', e); }
            } else {
              if (typeof game !== 'undefined') game._paused = false;
            }
            break;
        }
      },
    };
    const s = document.createElement('script');
    s.src = 'https://api.gamemonetize.com/sdk.js';
    s.async = true;
    s.onerror = () => {
      console.warn('[gamemonetize] SDK script failed to load — falling back to dev mode');
      _ready = true;        // dev-mode fallback so callbacks still fire
    };
    document.head.appendChild(s);
  }

  // ─── showAd thin wrapper ──────────────────────────────────────────
  // Routes rewarded requests through adState (the FSM); calls sdk.show-
  // Banner() to actually invoke GM's ad iframe. Dev-mode fast-path just
  // simulates a 1.5-s ad + cb(true) so the rest of the UI flow still
  // works without a live GM connection.
  function showAd(cb, opts) {
    const isRewarded = !!(opts && opts.rewarded);
    const now = Date.now();
    if (!isRewarded && now - _lastAdAt < MIN_AD_INTERVAL_MS) {
      // Throttled midgame — silently skip, no callback failure.
      return;
    }
    _lastAdAt = now;

    if (_devMode) {
      console.log(`[gamemonetize] dev-mode ad (${isRewarded ? 'rewarded' : 'midgame'}) — simulating 1.5s`);
      if (cb) setTimeout(() => cb(true), 1500);
      return;
    }

    if (isRewarded) {
      // Queue the FSM (overlay + reward gate + timers all owned by ad_state).
      if (window.adState && typeof window.adState.requestRewarded === 'function') {
        window.adState.requestRewarded(cb);
      } else {
        // Hard fallback if ad_state didn't load.
        console.warn('[gamemonetize] window.adState missing — granting reward fail-open');
        if (cb) setTimeout(() => cb(true), 1500);
        return;
      }
    }
    // Actually trigger the GM ad iframe. PAUSE / START events flow back
    // through SDK_OPTIONS.onEvent → ad_state.onSdkPause / onSdkStart.
    try {
      if (window.sdk && typeof window.sdk.showBanner === 'function') {
        window.sdk.showBanner();
      } else if (typeof window.sdk_showBanner === 'function') {
        window.sdk_showBanner();
      }
    } catch (e) {
      console.warn('[gamemonetize] showBanner threw:', e);
      // Surface the failure to the FSM so it doesn't sit in LOADING forever.
      if (isRewarded && window.adState) {
        try { window.adState.onSdkStart(); } catch (e2) {}
      } else if (cb) {
        cb(false);
      }
    }
  }

  // ─── Override the CrazyGames wrapper surface ──────────────────────
  // Same function names so every existing call site routes through GM
  // transparently. Phase 84: midgame is a NO-OP (was fullscreen video,
  // now removed per user request — passive impressions handled by the
  // respawn banner). Rewarded is the ONLY fullscreen path; only fires
  // when player clicks 'Watch Ad' → 30-min respawn buff in return.
  window.crazyAd_midgame   = ()   => { /* no-op: no fullscreen passive */ };
  window.crazyAd_rewarded  = (cb) => showAd(cb, { rewarded: true });

  // Phase 102 — GM-specific exports.
  //
  // gmPreroll(): fires ONCE per page session, on the first 'ENTER ARENA'
  // click. GM's verification flow watches for at least one showBanner()
  // call during the iframe-load probe; without it activation is rejected.
  // Best-practice location per GM blog: 'Play button'. Throttle bypass —
  // this counts as the FIRST ad, not a midgame.
  // Phase 108 — caller in index.html is currently commented out per user
  // request ('在我第一次點進遊戲的時候, 他出現一個全屏廣告'). Function
  // is kept defined for GM activation re-verification if needed later.
  window.gmPreroll = function() {
    if (_prerollFired) return;
    _prerollFired = true;
    if (_devMode) {
      console.log('[gamemonetize] dev-mode preroll — would showBanner() on first match');
      return;
    }
    try {
      if (window.sdk && typeof window.sdk.showBanner === 'function') {
        window.sdk.showBanner();
        _lastAdAt = Date.now();
      }
    } catch (e) {
      console.warn('[gamemonetize] preroll showBanner threw:', e);
    }
  };

  // gmEndMatch(): fires a midgame interstitial at match end (win/lose).
  // Respects MIN_AD_INTERVAL_MS so back-to-back short matches don't
  // double-ad. Per GM blog this is the second-best inventory location
  // after the Play button. Phase 108 — caller in index.html is commented
  // out per user request ('我看完這個廣告, 我就死掉了').
  window.gmEndMatch = function() {
    const now = Date.now();
    if (now - _lastAdAt < MIN_AD_INTERVAL_MS) return;
    _lastAdAt = now;
    if (_devMode) {
      console.log('[gamemonetize] dev-mode end-match — would showBanner()');
      return;
    }
    try {
      if (window.sdk && typeof window.sdk.showBanner === 'function') {
        window.sdk.showBanner();
      }
    } catch (e) {
      console.warn('[gamemonetize] end-match showBanner threw:', e);
    }
  };

  // Phase 84 — death counter kept for analytics, but does NOT trigger
  // fullscreen video ads. User '不是全螢幕的, 視窗那種靜態的, 全螢幕是
  // 主動要看的話'. Passive impressions come from the 300x250 respawn
  // banner (Phase 82). Fullscreen video is gated entirely on the player
  // clicking 'Watch Ad' (rewarded path via crazyAd_rewarded).
  window.crazyNoteDeath = () => { _deathCount++; };

  // Event functions become no-ops outside the CG portal. They're called
  // from index.html for gameplay-state telemetry; GM doesn't need them.
  window.crazyEvent_gameplayStart = () => {};
  window.crazyEvent_gameplayStop  = () => {};
  window.crazyEvent_happytime     = () => {};
  window.crazyEvent_loadingStop   = () => {};

  // Instant-multiplayer wrappers — GM doesn't have an equivalent, so
  // these no-op. MP rooms still work (PartyKit handles routing); only
  // the "share invite link via portal" UX is unavailable here.
  window.crazyMp_getInviteRoom = () => null;
  window.crazyMp_updateRoom    = () => {};
  window.crazyMp_leftRoom      = () => {};
  window.crazyMp_inviteLink    = () => null;

  window.isCrazyReady = () => _ready;
})();
