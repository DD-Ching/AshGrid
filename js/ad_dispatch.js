// js/ad_dispatch.js — R11 Step 1
// =========================================================================
// SINGLE PUBLIC API for rewarded ads + PROVIDER REGISTRY.
//
// Replaces the Phase ≤120 "override war":
//   ad_stubs.js     defined  window.requestRewardedAd
//   crazygames.js   overwrote it once SDK_READY fired
//   gamemonetize.js overwrote it AGAIN once SDK_READY fired
//   → last-loaded-with-ready-SDK wins, depending on load order + SDK race.
//
// Made bugs like Phase 120 (first-watch no-fill) a nightmare to trace —
// caller couldn't tell which layer actually fired its callback.
//
// New design:
//   1. THIS file owns window.requestRewardedAd. Nothing else writes to it.
//   2. SDK adapters (gamemonetize.js, crazygames.js) call registerAdProvider
//      once their SDK confirms ready, instead of overriding the global.
//   3. requestRewardedAd dispatches by FIXED PRIORITY (independent of load
//      order or SDK race): crazygames > gamemonetize > built-in stub.
//   4. Built-in stub grants the reward after 500 ms — used in dev or when
//      no SDK loads (Cloudflare Pages cold start, local file://, SDK
//      blocked by adblocker, etc.). Matches the Phase 120 intent
//      ("don't punish player for our network problems").
//
// Classic-script. Declares globally:
//   window.registerAdProvider(name, showFn)   · SDK adapters register here
//   window.requestRewardedAd(rewardId, cb)    · single call site for callers
//
// External deps: none (pure plumbing — no game / AUDIO / T / showSwapToast).

(function() {
  'use strict';

  // Registered providers, keyed by name. Each value: { name, show }.
  const _providers = {};

  // Fixed dispatch priority — does NOT depend on load order. CrazyGames
  // historically pays higher CPM where it's the host platform; on
  // ashgrid.io (Cloudflare Pages) CG never registers, GM takes over.
  // Built-in stub is the last-resort fallback (no SDK loaded at all).
  const PROVIDER_PRIORITY = ['crazygames', 'gamemonetize'];

  function _log(msg) { try { console.log('[ad_dispatch]', msg); } catch (e) {} }

  function _selectProvider() {
    for (const name of PROVIDER_PRIORITY) {
      if (_providers[name]) return _providers[name];
    }
    return null;
  }

  // Built-in fallback when no real SDK provider is registered. Grants the
  // reward fail-open after 500 ms so the dev / no-SDK / adblocked path
  // doesn't punish the player. Same UX as the legacy ad_stubs.js stub.
  function _runStubReward(cb) {
    _log('no provider — stub fast-grant after 500ms');
    setTimeout(function() { try { cb && cb(true); } catch (e) {} }, 500);
  }

  // ─── Public: SDK adapter registers itself ───────────────────────────
  // showFn signature: function(innerCb, opts) where innerCb(earned: bool).
  // opts: { rewarded: true, rewardId: string } — provider can ignore.
  function registerAdProvider(name, showFn) {
    if (!name || typeof showFn !== 'function') {
      console.warn('[ad_dispatch] registerAdProvider needs (name:string, showFn:function)');
      return;
    }
    if (!PROVIDER_PRIORITY.includes(name)) {
      console.warn('[ad_dispatch] unknown provider "' + name + '" — add to PROVIDER_PRIORITY first');
      return;
    }
    _providers[name] = { name: name, show: showFn };
    _log('registered provider: ' + name);
  }

  // ─── Public: callers ask for a rewarded ad ──────────────────────────
  // cb(earned: bool, meta: { rewardId, amount }) — fires exactly once.
  // rewardId is opaque-to-dispatch tag used by callers for their own
  // analytics ("revive" / "respawn_buff" / "build_phase_extend" today).
  function requestRewardedAd(rewardId, cb) {
    const provider = _selectProvider();
    const wrapped = function(ok) {
      if (cb) try { cb(!!ok, { rewardId: rewardId, amount: 1 }); } catch (e) {}
    };
    if (!provider) {
      _runStubReward(wrapped);
      return;
    }
    _log('dispatch (' + rewardId + ') → ' + provider.name);
    try {
      provider.show(wrapped, { rewarded: true, rewardId: rewardId });
    } catch (e) {
      console.warn('[ad_dispatch] provider ' + provider.name + ' threw — falling back to stub', e);
      _runStubReward(wrapped);
    }
  }

  // Expose
  window.registerAdProvider = registerAdProvider;
  window.requestRewardedAd  = requestRewardedAd;
})();
