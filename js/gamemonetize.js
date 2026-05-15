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

  // Phase 101 — reward gate. If a rewarded ad closes (SDK_GAME_START)
  // before MIN_REWARD_PLAY_MS elapsed, the player did not "earn" the
  // buff. Set to 12s — most GM interstitials run 15-30s with the SKIP
  // button enabled at ~3s, so watching ≥12s == genuinely consumed the
  // ad even if they hit SKIP near the end. User '讓玩家挼提前跳開就
  // 沒有獎勵'.
  const MIN_REWARD_PLAY_MS = 12 * 1000;

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
  // Phase 101 — tracks whether a REAL ad is currently on screen (true
  // between SDK_GAME_PAUSE and SDK_GAME_START). The 15-s placeholder
  // timeout uses this to decide whether to take over: if a real ad is
  // playing when our timer fires, defer to SDK_GAME_START. If no real
  // ad ever served (publisher pending / no fill), our timer grants
  // the reward.
  let _adReallyPlaying = false;
  let _adPlayStartedAt = 0;      // wall-clock ms when ad started playing
  // Phase 102 — track audio mute state at ad start so we can RESTORE on
  // ad end without nuking the user's manual mute preference. Without
  // this, the GM verification would fail: GM explicitly forbids game
  // audio playing during ads ('background audio through video
  // advertisements is forbidden' — README), so we MUST mute on PAUSE.
  let _audioMutedByAd = false;
  // Phase 102 — preroll guard. GM verifier expects at least one
  // sdk.showBanner() call to fire during the activation flow. Best
  // location per GM blog: first time the player presses Play. Use
  // _prerollFired so we only fire it once per page session.
  let _prerollFired = false;
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
            // Phase 102 — restore audio. Only un-mute if WE were the one
            // who muted on PAUSE; otherwise the user had it manually
            // muted and we shouldn't override their preference.
            try {
              if (_audioMutedByAd && typeof setAudioMuted === 'function') {
                setAudioMuted(false);
              }
              _audioMutedByAd = false;
            } catch (e) {}
            // Phase 101 — early-skip detection. GM fires SDK_GAME_START on
            // ALL three close paths: full-play, user-skip, and ad-error.
            // Previously we always granted the reward (cb(true)), which
            // meant a player could hit "SKIP" at second 3 and still get
            // the 30-min buff. User '讓玩家挼提前跳開就沒有獎勵'.
            //
            // New rule: must have watched ≥ MIN_REWARD_PLAY_MS of the
            // ad (12 s default) to earn the buff. Below threshold →
            // cb(false), which death_recap's caller treats as "no
            // revive, retry allowed" (resets adReviveUsed flag).
            // Also hides our 15-s placeholder overlay early so the
            // player gets back to the death-recap screen instead of
            // staring at our countdown after they already skipped.
            _adReallyPlaying = false;
            if (typeof _hideAdPlayOverlay === 'function') _hideAdPlayOverlay();
            if (_pendingAdCb) {
              const elapsedMs = Date.now() - (_adPlayStartedAt || 0);
              const earned = elapsedMs >= MIN_REWARD_PLAY_MS;
              if (!earned) {
                console.log(`[gamemonetize] ad skipped at ${(elapsedMs / 1000).toFixed(1)}s (<${MIN_REWARD_PLAY_MS / 1000}s) — no reward`);
                if (typeof showSwapToast === 'function') {
                  try { showSwapToast('▶ 提前跳過 — 沒有獎勵'); } catch (e) {}
                }
              }
              try { _pendingAdCb(earned); } catch (e) {}
              _pendingAdCb = null;
            }
            break;
          case 'SDK_GAME_PAUSE':
            // Ad about to play — pause gameplay so the player doesn't
            // get shot while watching a 15s mid-roll.
            if (typeof game !== 'undefined') game._paused = true;
            // Phase 102 — MUST mute audio during ads (GM rule: game
            // audio during ads is forbidden; #1 cause of verification
            // failure). Save current mute state so we restore — not
            // wipe — the user's manual mute preference on ad end.
            try {
              if (typeof AUDIO !== 'undefined' && typeof setAudioMuted === 'function') {
                _audioMutedByAd = !AUDIO.muted;  // we only need to restore if WE muted
                setAudioMuted(true);
              }
            } catch (e) {}
            _adPlayStartedAt = Date.now();
            _adReallyPlaying = true;
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

  // ─── Ad-mode overlay (Phase 95) ───────────────────────────────────
  // Shows the #adPlayOverlay element for 15 seconds with a 15→0 countdown
  // and pauses gameplay. Used when the player clicks 'Watch Ad' so they
  // get an honest ad-watching window even if GameMonetize hasn't approved
  // the publisher site yet (no real ad fill → SDK_GAME_START fires
  // instantly = 'click → instant revive' which the user flagged as broken
  // UX: '按了之後馬上復活...我沒有看到廣告'). When GM does start serving
  // real inventory, the GM iframe sits above this overlay (its z-index is
  // 10000+; ours is 9000) so the placeholder is hidden by the real ad.
  let _adOverlayTimer = null;
  function _showAdPlayOverlay() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('adPlayOverlay');
    if (!el) return;
    el.style.display = 'flex';
    if (typeof game !== 'undefined') game._paused = true;
    let remaining = 15;
    const cdEl    = document.getElementById('adPlayCountdown');
    const trailEl = document.getElementById('adPlayCountdownTrail');
    if (cdEl)    cdEl.textContent    = String(remaining);
    if (trailEl) trailEl.textContent = String(remaining);
    if (_adOverlayTimer) clearInterval(_adOverlayTimer);
    _adOverlayTimer = setInterval(() => {
      remaining -= 1;
      if (remaining < 0) remaining = 0;
      if (cdEl)    cdEl.textContent    = String(remaining);
      if (trailEl) trailEl.textContent = String(remaining);
      if (remaining <= 0) {
        clearInterval(_adOverlayTimer);
        _adOverlayTimer = null;
      }
    }, 1000);
  }
  function _hideAdPlayOverlay() {
    if (typeof document !== 'undefined') {
      const el = document.getElementById('adPlayOverlay');
      if (el) el.style.display = 'none';
    }
    if (_adOverlayTimer) {
      clearInterval(_adOverlayTimer);
      _adOverlayTimer = null;
    }
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
      // Phase 95 — rewarded paths show our OWN 15-second 'ad-playing'
      // overlay so the player gets a consistent ad-mode experience
      // regardless of whether GameMonetize actually serves a real ad
      // (publisher site approval pending → no fill → SDK_GAME_START
      // would fire instantly = 'click button → revive immediately'
      // which the user reported as broken UX).
      // User: '應該就要有一種模式 進入幾秒鐘的廣告模式 那個時候你不會
      // 在場上'.
      //
      // Flow:
      //   1. show #adPlayOverlay (fullscreen, pauses gameplay)
      //   2. start 15s countdown
      //   3. ALSO call GM showBanner() — if a real ad loads, it overlays
      //      on top of our placeholder (z-index 10000+ vs our 9000)
      //   4. After 15s elapses, hide overlay, resume game, fire cb
      _pendingAdCb = cb || null;
      if (isRewarded) {
        _showAdPlayOverlay();
        try {
          if (window.sdk && typeof window.sdk.showBanner === 'function') {
            window.sdk.showBanner();
          } else if (typeof window.sdk_showBanner === 'function') {
            window.sdk_showBanner();
          }
        } catch (e2) { /* GM not ready — our overlay still runs */ }
        // 15-second placeholder timeout. Fires reward + resume ONLY if
        // no real ad is currently on screen — otherwise defer to
        // SDK_GAME_START which has the precise elapsed-time signal for
        // the early-skip gate. Without this guard, a slow-loading real
        // ad would get cb(true) granted at t=15s while still playing
        // at t=20s, defeating the no-skip rule.
        setTimeout(() => {
          if (_adReallyPlaying) {
            // Real ad onscreen; let SDK_GAME_START decide.
            return;
          }
          _hideAdPlayOverlay();
          if (_pendingAdCb) {
            try { _pendingAdCb(true); } catch (e3) {}
            _pendingAdCb = null;
          }
          if (typeof game !== 'undefined') game._paused = false;
        }, 15000);
        return;
      }
      // Non-rewarded (midgame, etc) — currently a no-op surface but
      // keep the showBanner attempt for future use.
      if (window.sdk && typeof window.sdk.showBanner === 'function') {
        window.sdk.showBanner();
      } else if (typeof window.sdk_showBanner === 'function') {
        window.sdk_showBanner();
      }
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

  // Phase 102 — GM-specific exports.
  //
  // gmPreroll(): fires ONCE per page session, on the first 'ENTER ARENA'
  // click. GM's verification flow watches for at least one showBanner()
  // call during the iframe-load probe; without it activation is rejected.
  // Best-practice location per GM blog: 'Play button'. Throttle bypass —
  // this counts as the FIRST ad, not a midgame.
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
  // after the Play button.
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
