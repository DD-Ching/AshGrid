// ============ GAMEMONETIZE SDK (self-hosted ad path) ============
// Phase 73 — ad backend for builds running OUTSIDE the CrazyGames portal
// (ashgrid.io, dev.ashgrid.pages.dev, anywhere on .pages.dev, localhost,
// any other partner site that mirrors the game). Same wrapper surface as
// js/crazygames.js so the rest of the codebase (death_recap.js,
// crazyNoteDeath in index.html, etc.) doesn't care which network is live.
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
//   crazyEvent_loadingStop · isCrazyReady
//   (and crazyMp_* shims that no-op outside the CG portal)
//
// External deps: location · game · console

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

  let _ready = false;
  let _lastAdAt = 0;
  let _deathCount = 0;
  let _pendingAdCb = null;       // fired when ad ACTUALLY finishes
  let _adPlayStartedAt = 0;      // wall-clock ms when ad started playing
  const _devMode = !GM_GAME_ID;

  // ─── Load GM SDK (only when configured) ───────────────────────────
  if (_devMode) {
    console.log('[gamemonetize] DEV MODE — no GM_GAME_ID set. Ad calls will succeed without playing real ads. Edit js/gamemonetize.js to enable real ads on ashgrid.io.');
    _ready = true;          // dev-mode is "ready" instantly
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
            // Phase 88 — preload rewarded ad immediately so the
            // first 'Watch Ad' click plays instantly (no 1-2s
            // network wait). User '按了之後就馬上跳出'.
            try {
              if (window.sdk && typeof window.sdk.preloadAd === 'function') {
                window.sdk.preloadAd('rewarded');
              }
            } catch (e) {}
            break;
          case 'SDK_GAME_START':
            // Ad finished — resume gameplay.
            if (typeof game !== 'undefined') game._paused = false;
            // Phase 89 — fire the pending reward callback NOW (when
            // the ad actually finished), not 1.5s after it started.
            // User '不應該選在看長時間視頻的時候直接復活, 應該要等
            // 到視頻結束才復活'.
            if (_pendingAdCb) {
              try { _pendingAdCb(true); } catch (e) {}
              _pendingAdCb = null;
            }
            break;
          case 'SDK_GAME_PAUSE':
            // Ad about to play — pause gameplay so the player doesn't
            // get shot while watching a 15s mid-roll.
            if (typeof game !== 'undefined') game._paused = true;
            _adPlayStartedAt = Date.now();
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

  // ─── Show ad ──────────────────────────────────────────────────────
  // The SDK exposes either sdk_showBanner() (global) or sdk.showBanner()
  // depending on version. Try both. cb fires success after a short delay
  // so the Phase 60 revive button completes its UI sequence.
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

    try {
      // Phase 91 — simplified to match GM SDK v3 docs (verified via their
      // GitHub README). GM exposes ONLY sdk.showBanner() (misnamed — it's
      // actually the video interstitial / rewarded slot). No sdk.showAd
      // method, no callback parameter. Completion comes via the
      // SDK_GAME_START event in onEvent.
      //
      // Pattern: stash cb in _pendingAdCb, call showBanner(), and let
      // SDK_GAME_START fire the cb. SDK_GAME_START fires on ANY ad
      // outcome (watched / skipped / errored / blocked) — that's GM's
      // design. Reward is granted as long as the ad request was served.
      // Failsafe: 30-second timer in case GM events never fire (e.g.
      // ad blocker, network failure) so the player isn't stuck.
      _pendingAdCb = cb || null;
      if (window.sdk && typeof window.sdk.showBanner === 'function') {
        window.sdk.showBanner();
      } else if (typeof window.sdk_showBanner === 'function') {
        window.sdk_showBanner();
      } else {
        console.warn('[gamemonetize] SDK not exposing showBanner — dev fallback');
        if (_pendingAdCb) {
          setTimeout(() => {
            if (_pendingAdCb) { _pendingAdCb(true); _pendingAdCb = null; }
          }, 500);
        }
        return;
      }
      // Phase 91 failsafe — if no SDK_GAME_START event arrives within
      // 30 seconds, assume the ad didn't load (blocker, no fill, etc.)
      // and grant the reward anyway so the player isn't trapped on the
      // death screen forever. 30s is longer than any real ad to avoid
      // double-firing.
      setTimeout(() => {
        if (_pendingAdCb) {
          console.warn('[gamemonetize] SDK_GAME_START did not arrive within 30s — failsafe firing reward');
          _pendingAdCb(true);
          _pendingAdCb = null;
          // Resume game in case SDK_GAME_PAUSE fired but no resume.
          if (typeof game !== 'undefined') game._paused = false;
        }
      }, 30000);
    } catch (e) {
      console.warn('[gamemonetize] showBanner threw:', e);
      if (cb) cb(false);
    }
  }

  // ─── Override the CrazyGames wrapper surface ──────────────────────
  // Same function names so every existing call site routes through GM
  // transparently. Phase 84: midgame is a NO-OP (was fullscreen video,
  // now removed per user request — passive impressions handled by the
  // respawn banner). Rewarded is the ONLY fullscreen path; only fires
  // when player clicks 'Watch Ad' → 30-min respawn buff in return.
  window.crazyAd_midgame   = ()  => { /* no-op: no fullscreen passive */ };
  window.crazyAd_rewarded  = (cb) => showAd(cb, { rewarded: true });

  // Phase 84 — death counter kept for analytics, but does NOT trigger
  // fullscreen video ads. User '不是全螢幕的, 視窗那種靜態的, 全螢幕是
  // 主動要看的話'. Passive impressions come from the 300x250 respawn
  // banner (Phase 82) which already shows on every death. Fullscreen
  // video is gated entirely on the player clicking 'Watch Ad' (rewarded
  // path via crazyAd_rewarded), which gives them the 30-min respawn
  // buff in return.
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
