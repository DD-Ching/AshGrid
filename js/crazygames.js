// ============ CRAZY GAMES SDK (Phase 2 launch wiring) ============
// Loads the Crazy Games SDK v3 + exposes thin wrappers the rest of the
// codebase calls. On their portal these fire real ads + game-event
// telemetry; in local dev the SDK shows a dev-mode overlay and ads return
// 'started' / 'finished' without actually playing anything, so the game
// stays playable.
//
// Classic-script. Declares globally:
//   crazyEvent_gameplayStart() · crazyEvent_gameplayStop() ·
//   crazyEvent_happytime() · crazyEvent_sadtime() ·
//   crazyAd_midgame() · crazyAd_rewarded(cb) · isCrazyReady()
//
// We also OVERRIDE the existing requestRewardedAd() stub (defined in
// ad_stubs.js) once the SDK loads, so any existing rewarded-ad callsite
// in the codebase upgrades automatically when shipped on the portal.
//
// External deps: showSwapToast (optional, for dev-mode feedback)
//
// Crazy Games developer docs: https://docs.crazygames.com/sdk/

(function() {
  'use strict';

  let _ready = false;
  let _sdk = null;
  // How often to roll a midgame interstitial. Crazy Games' guidance is one
  // per 2-3 min of play; we tie ours to player deaths since this is an
  // endless mode (no rounds). Show roughly every 5th death.
  const MIDGAME_AD_EVERY_N_DEATHS = 5;
  let _deathCountForAds = 0;
  // Throttle: never show two interstitials within this many ms (SDK enforces
  // its own minimum but we don't want to spam if a player dies in bursts).
  const MIDGAME_MIN_INTERVAL_MS = 90 * 1000;
  let _lastMidgameAt = 0;

  // -------- Loader --------
  function loadSDK() {
    return new Promise((resolve) => {
      // Already loaded?
      if (window.CrazyGames && window.CrazyGames.SDK) {
        return resolve(window.CrazyGames.SDK);
      }
      const s = document.createElement('script');
      s.src = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
      s.async = true;
      s.onload = () => {
        if (window.CrazyGames && window.CrazyGames.SDK) {
          resolve(window.CrazyGames.SDK);
        } else {
          console.warn('[crazygames] SDK script loaded but window.CrazyGames missing');
          resolve(null);
        }
      };
      s.onerror = () => {
        // Local dev without internet, or on a host that can't reach the CDN.
        // We just stay in stub mode — the game still runs.
        console.log('[crazygames] SDK CDN unreachable, staying in stub mode');
        resolve(null);
      };
      document.head.appendChild(s);
    });
  }

  // -------- Init --------
  async function init() {
    const sdk = await loadSDK();
    if (!sdk) return;
    try {
      await sdk.init();
      _sdk = sdk;
      _ready = true;
      console.log('[crazygames] SDK ready (env: ' + (sdk.environment || 'unknown') + ')');
      // Phase 53 — REQUIRED by CrazyGames cert: signal that the SDK has
      // booted so the portal's loader can advance + ad inventory can warm
      // up. Real SDK method is `loadingStart()` (Phase 52 used the wrong
      // name `sdkGameLoadingStart` — silently no-op'd through the try).
      try { _sdk.game.loadingStart(); } catch (e) {}
      // Override the local stub with the real rewarded-ad path once we're
      // wired. Any existing caller using requestRewardedAd() now gets a
      // real ad on the portal, dev-mode overlay locally.
      if (typeof window.requestRewardedAd === 'function') {
        window._requestRewardedAd_stub = window.requestRewardedAd;
        window.requestRewardedAd = function(rewardId, cb) {
          crazyAd_rewarded((ok) => cb && cb(ok, { rewardId, amount: 1 }));
        };
      }
      // If the page already signaled "fully loaded" before our async init
      // resolved, fire loadingStop now so we don't get stuck on the
      // CrazyGames loader.
      if (window._crazyGameReady) loadingStop();
      // Phase 53 — wire SDK audio-mute events into our setAudioMuted().
      // The CrazyGames portal header has a mute toggle that posts a
      // settings-change event into the iframe whenever the user flips it.
      // Real surface: sdk.game.addSettingsChangeListener(settings => …)
      // where `settings.audio` is true/false. Honoring this lets us tick
      // 'supports CrazyGames muting audio through SDK' on the upload form.
      try {
        if (sdk.game && typeof sdk.game.addSettingsChangeListener === 'function') {
          sdk.game.addSettingsChangeListener((settings) => {
            const audioOn = (settings && typeof settings.audio === 'boolean')
              ? settings.audio : true;
            if (typeof window.setAudioMuted === 'function') {
              window.setAudioMuted(!audioOn);
            }
          });
        }
      } catch (e) {}
    } catch (e) {
      console.warn('[crazygames] init failed', e);
    }
  }
  // Called by index.html the moment the start screen is interactive (game
  // boot is complete, scripts parsed, listeners attached). CrazyGames uses
  // this to dismiss its own loader + start serving preroll ads.
  function loadingStop() {
    window._crazyGameReady = true;
    if (!_ready) return;   // init() will replay the call when SDK lands
    try { _sdk.game.loadingStop(); } catch (e) {}
  }

  // -------- Game events (telemetry) --------
  // Per docs: call these on actual gameplay boundaries so Crazy can place
  // ads at moments that don't interrupt the player.
  function gameplayStart() {
    if (!_ready) return;
    try { _sdk.game.gameplayStart(); } catch (e) {}
  }
  function gameplayStop() {
    if (!_ready) return;
    try { _sdk.game.gameplayStop(); } catch (e) {}
  }
  function happytime() {
    if (!_ready) return;
    try { _sdk.game.happytime(); } catch (e) {}
  }
  // Phase 53: SDK v3 has no `sadtime()` — only `happytime()`. The wrapper
  // stays so the death-path call site doesn't break, but we just no-op.
  // Death telemetry still goes through `noteDeath()` for the midgame ad
  // cadence, which is the actually useful signal.
  function sadtime() { /* no-op in v3 */ }

  // -------- Ads --------
  // Midgame interstitial — fired on schedule (every Nth death). Returns
  // void; the ad is fire-and-forget (Crazy resolves after user closes it).
  function midgame() {
    if (!_ready) return;
    const now = Date.now();
    if (now - _lastMidgameAt < MIDGAME_MIN_INTERVAL_MS) return;
    _lastMidgameAt = now;
    try {
      _sdk.ad.requestAd('midgame').catch(() => {});
    } catch (e) {}
  }
  // Rewarded — pass `cb(true)` on completion, `cb(false)` on dismiss / no fill.
  // Used by `requestRewardedAd` override above. Reward semantics decided by
  // caller (revive, etc).
  function rewarded(cb) {
    if (!_ready) {
      // No SDK yet — fall through to whatever stub was previously installed.
      if (typeof window._requestRewardedAd_stub === 'function') {
        window._requestRewardedAd_stub('rewarded', cb);
      } else {
        setTimeout(() => cb && cb(true), 500);
      }
      return;
    }
    try {
      _sdk.ad.requestAd('rewarded').then(
        () => cb && cb(true),
        () => cb && cb(false)
      );
    } catch (e) { cb && cb(false); }
  }

  // Death counter — caller increments after each player death; we fire
  // a midgame interstitial every N deaths.
  function noteDeath() {
    _deathCountForAds++;
    if (_deathCountForAds % MIDGAME_AD_EVERY_N_DEATHS === 0) {
      midgame();
    }
  }

  // -------- Exports --------
  window.crazyEvent_loadingStop   = loadingStop;
  window.crazyEvent_gameplayStart = gameplayStart;
  window.crazyEvent_gameplayStop  = gameplayStop;
  window.crazyEvent_happytime     = happytime;
  window.crazyEvent_sadtime       = sadtime;
  window.crazyAd_midgame          = midgame;
  window.crazyAd_rewarded         = rewarded;
  window.crazyNoteDeath           = noteDeath;
  window.isCrazyReady             = () => _ready;

  // Kick off async init. Don't block page load — other modules run before
  // SDK is ready and their calls just no-op until init completes.
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
