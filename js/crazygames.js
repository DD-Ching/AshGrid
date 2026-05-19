// ============ CRAZY GAMES SDK (Phase 2 launch wiring) ============
// Loads the Crazy Games SDK v3 + exposes thin wrappers the rest of the
// codebase calls. On their portal these fire real ads + game-event
// telemetry; in local dev the SDK shows a dev-mode overlay and ads return
// 'started' / 'finished' without actually playing anything, so the game
// stays playable.
//
// Classic-script. Declares globally:
//   crazyEvent_gameplayStart() · crazyEvent_gameplayStop() ·
//   crazyEvent_happytime() · crazyAd_midgame() · crazyNoteDeath() ·
//   isCrazyReady()
//
// R11 Step 1: rewarded ads go through window.requestRewardedAd
// (owned by js/ad_dispatch.js). This module registers itself with the
// dispatch as the 'crazygames' provider on SDK_READY.
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
  // Phase 130 — pending-call stash. Phase 54 MP integration fires
  // updateRoom / inviteLink on the welcome packet, which can arrive
  // BEFORE sdk.init() resolves (`_ready === false`) → silent no-op,
  // CG QA panel never sees the call, "Update multiplayer room" /
  // "Invite Link" requirement gates stay un-lit. Stash the last set
  // of args here and drain after _ready flips so the SDK sees them
  // exactly once when it's ready to listen.
  let _pendingRoomUpdate = null;   // {roomName, maxPlayers, hasFreeSlot}
  let _pendingInviteLink = null;   // roomName string

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
    // Phase 73: hostname gate. Only init the CG SDK when we're actually
    // running inside CrazyGames (or testing with ?crazyGames=1). On
    // self-hosted builds (ashgrid.io, dev.ashgrid.pages.dev) the
    // GameMonetize SDK takes over via js/gamemonetize.js. Without this
    // gate the CG SDK would still attempt to fetch their CDN even though
    // ads can't be served outside their portal.
    const onCG = /crazygames\.com$/.test(location.hostname)
              || /[?&]crazyGames=1\b/.test(location.search);
    if (!onCG) {
      console.log('[crazygames] not on CG portal — skipping SDK init (gamemonetize.js handles ads)');
      return;
    }
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
      // R11 Step 1 — register as an ad provider instead of overwriting
      // window.requestRewardedAd. Dispatch + priority lives in
      // js/ad_dispatch.js; CG sits at the top of the priority table so
      // it wins on the CrazyGames portal automatically.
      if (typeof window.registerAdProvider === 'function') {
        window.registerAdProvider('crazygames', rewarded);
      }
      // If the page already signaled "fully loaded" before our async init
      // resolved, fire loadingStop now so we don't get stuck on the
      // CrazyGames loader.
      if (window._crazyGameReady) loadingStop();
      // Phase 130 — drain any Phase 54 MP-side calls that arrived before
      // _ready flipped. Without this drain, an MP welcome that beats the
      // SDK init promise leaves updateRoom + inviteLink unexecuted for
      // the lifetime of the session, breaking CG QA's MP requirement.
      if (_pendingRoomUpdate) {
        const p = _pendingRoomUpdate;
        _pendingRoomUpdate = null;
        try {
          _sdk.game.updateRoom({
            roomName: String(p.roomName || ''),
            maxPlayers: Number(p.maxPlayers) || 20,
            hasFreeSlot: !!p.hasFreeSlot,
          });
        } catch (e) {}
      }
      if (_pendingInviteLink) {
        const rn = _pendingInviteLink;
        _pendingInviteLink = null;
        try { _sdk.game.inviteLink({ roomName: String(rn) }); } catch (e) {}
      }
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
            // R14 — CG portal mute toggle is a USER-driven preference
            // change, not a transient mute. Route through AudioMute's
            // user-pref path so it persists to localStorage and coexists
            // cleanly with any in-flight transient mutes (e.g. ad).
            if (typeof AudioMute !== 'undefined') {
              AudioMute.setUserMuted(!audioOn);
            } else if (typeof window.setAudioMuted === 'function') {
              window.setAudioMuted(!audioOn);
            }
          });
        }
      } catch (e) {}
      // Phase 54 — Instant Multiplayer integration. The CrazyGames portal
      // generates invite links like `crazygames.com/game/ashgrid?invite={
      // "roomName":"abc"}` — when a friend opens one, the SDK fires
      // addJoinRoomListener with that data and we should jump to the room.
      // Required by the QA gate: 'Multiplayer requirements · Reload with
      // Instant Multiplayer'.
      try {
        if (sdk.game && typeof sdk.game.addJoinRoomListener === 'function') {
          sdk.game.addJoinRoomListener((data) => {
            const roomName = data && data.roomName;
            if (!roomName) return;
            // Mid-game invite — reload with the new room so MP connects fresh.
            // (Trying to re-handshake the live socket without reload caused
            // ghost peers in earlier phases.)
            try {
              const p = new URLSearchParams(location.search);
              p.set('mp', '1');
              p.set('room', String(roomName));
              try { sessionStorage.setItem('ag.autoEnter', '1'); } catch (e) {}
              location.search = p.toString();
            } catch (e) {}
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
  // SDK v3 has no `sadtime()`; death telemetry rides on `noteDeath()` for
  // the midgame-ad cadence, which is the only signal we actually use.

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
  // R11 Step 1: this is the function REGISTERED with ad_dispatch as the
  // 'crazygames' provider. Reward semantics decided by caller (revive, etc).
  function rewarded(cb) {
    if (!_ready) {
      // SDK never finished init (CG portal unreachable). Fail-open so the
      // dispatch's caller still gets a reward — matches Phase 120 intent.
      setTimeout(() => cb && cb(true), 500);
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

  // -------- Phase 54: Instant Multiplayer wrappers --------
  // Synchronous read of the invite-room param the portal stuffs into our
  // launch URL when a friend's invite link is opened. Returns null when
  // not invited (normal direct lobby visit) or when SDK isn't ready yet
  // (caller should treat null as "no invite").
  function getInviteRoom() {
    if (!_ready) return null;
    try { return _sdk.game.getInviteParam('roomName') || null; }
    catch (e) { return null; }
  }
  // Tell the portal which room we're in + how full it is, so it can
  // surface 'join friend' affordances and refresh invite links. Call
  // after the MP welcome arrives + on every peer-join / peer-leave.
  function updateMpRoom(roomName, maxPlayers, hasFreeSlot) {
    if (!_ready) {
      // Phase 130 — stash for init() drain. Overwrite any prior pending
      // entry (only the LATEST room state matters; intermediate joins are
      // already obsolete by the time the SDK is ready).
      _pendingRoomUpdate = { roomName, maxPlayers, hasFreeSlot };
      return;
    }
    try {
      _sdk.game.updateRoom({
        roomName: String(roomName || ''),
        maxPlayers: Number(maxPlayers) || 20,
        hasFreeSlot: !!hasFreeSlot,
      });
    } catch (e) {}
  }
  // Call when the local player leaves an MP room (back to lobby / mode
  // switch). Lets the portal stop listing them as "in room X."
  function leftMpRoom() {
    if (!_ready) return;
    try { _sdk.game.leftRoom(); } catch (e) {}
  }
  // Build a shareable invite URL for the current room. Returns a string
  // synchronously (SDK builds it from the host frame). Null if SDK isn't
  // ready or the call throws.
  function getInviteLink(roomName) {
    if (!_ready) {
      // Phase 130 — stash for init() drain. Caller can't synchronously
      // get a URL pre-_ready (the SDK is what builds it from host frame),
      // but the call itself is what CG QA tracks for the "Invite Link"
      // requirement gate — so deferring the SDK invocation still earns
      // the green dot once init resolves.
      _pendingInviteLink = String(roomName || '');
      return null;
    }
    try { return _sdk.game.inviteLink({ roomName: String(roomName) }); }
    catch (e) { return null; }
  }

  // -------- Exports --------
  window.crazyEvent_loadingStop   = loadingStop;
  window.crazyEvent_gameplayStart = gameplayStart;
  window.crazyEvent_gameplayStop  = gameplayStop;
  window.crazyMp_getInviteRoom    = getInviteRoom;
  window.crazyMp_updateRoom       = updateMpRoom;
  window.crazyMp_leftRoom         = leftMpRoom;
  window.crazyMp_inviteLink       = getInviteLink;
  window.crazyEvent_happytime     = happytime;
  window.crazyAd_midgame          = midgame;
  // R11 Step 1: crazyAd_rewarded removed — rewarded path goes through
  // window.requestRewardedAd (ad_dispatch.js → 'crazygames' provider).
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
