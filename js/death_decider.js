// ============ DEATH DECIDER (Phase 133.3 extraction) ============
// Single decision site for "player just died → auto-swap to ally or
// schedule respawn?" Previously lived inline in pawn_swap.js with the
// SP/MP branching tangled into the same function, plus an implicit
// reliance on _respawnAt / alive flags to prevent re-entry that broke
// down on the MP snapshot-fallback path (Phase 129c chain loop).
//
// Now there's exactly one place to read the rule, and it tracks its own
// timestamp state explicitly. MP snapshot-fallback callers ask
// shouldSkipSnapshotFallback() before re-entering — that's the
// chain-loop guard, and it lives in this module's state instead of
// being implicit in lifecycle flags.
//
// Classic-script. Declares globally:
//   handleLocalDeath(deathPos)        single death-event entry
//   shouldSkipSnapshotFallback()      guard for MP snapshot-driven
//                                     re-entry (returns true while we're
//                                     within AUTOSWAP_GUARD_TICKS of a
//                                     successful auto-swap)
//   DeathDecider                      { lastAutoSwapAt, lastDeathAt }
//
// External deps (resolved at call-time via globals):
//   game · player · allies · _mpIsActive · PlayerLifecycle ·
//   tryAutoSwapToClosestAlly · getRespawnSeconds

(function() {
  'use strict';

  // Frames between auto-swap and "safe to re-trigger". MP server snapshot
  // can arrive several ticks after our local swap; until ~60 ticks later
  // the snapshot still says we're dead, and re-firing handleLocalDeath
  // would chain-swap to another ally → infinite loop (Phase 129c bug:
  // '剛開始還單獨載具時被幹掉, 莫名其妙接管不知哪來的載具, 且無法
  // 動彈被再度擊殺, 在莫名其妙接管').
  //
  // 60 ticks = 1 second @ 60Hz. Long enough to absorb 1-2 snapshot
  // round-trips from a 20Hz PartyKit server. Short enough that a
  // legitimate second death (e.g., the player swapped to ally and
  // ally got immediately hit) still routes through the normal path.
  const AUTOSWAP_GUARD_TICKS = 60;

  let _lastAutoSwapAt = -9999;
  let _lastDeathAt    = -9999;

  function _now() {
    return (typeof game !== 'undefined' && game.time != null) ? game.time : 0;
  }

  // Chain-loop guard. Snapshot-fallback callers in multiplayer.js ask
  // this BEFORE re-entering handleLocalDeath. True while we're within
  // AUTOSWAP_GUARD_TICKS of a successful auto-swap — the server's
  // "you're still dead" snapshot just hasn't caught up yet, ignore it.
  // Kill-event path doesn't need this guard (each is a fresh death).
  function shouldSkipSnapshotFallback() {
    return (_now() - _lastAutoSwapAt) < AUTOSWAP_GUARD_TICKS;
  }

  function handleLocalDeath(deathPos) {
    _lastDeathAt = _now();

    if (typeof PlayerLifecycle !== 'undefined') {
      PlayerLifecycle.killPlayer(deathPos);
    }

    // Phase 133.3 — MP auto-swap RE-ENABLED with chain-loop guard.
    // The Phase 129c-rev unconditional disable made MP solo deaths
    // ALWAYS show the WIPED countdown even when squad bots were alive,
    // violating the user rule: "if a teammate is alive, no respawn
    // countdown + no ad CTA — only auto-swap into their slot".
    //
    // The chain-loop bug Phase 129c-rev was trying to avoid is now
    // handled at the multiplayer.js snapshot-fallback caller via
    // shouldSkipSnapshotFallback(). First death event → auto-swap +
    // stamp timestamp. Subsequent snapshot-fallback re-entries within
    // AUTOSWAP_GUARD_TICKS are filtered at the caller, breaking the
    // loop without needing server-side changes.
    if (typeof tryAutoSwapToClosestAlly === 'function'
        && tryAutoSwapToClosestAlly()) {
      _lastAutoSwapAt = _now();
      return 'swapped';
    }

    // No swap target — fall through to the team-wipe / countdown path.
    // Both SP and MP land here when no ally is alive locally.
    const respawnSec = (typeof getRespawnSeconds === 'function')
      ? getRespawnSeconds() : 3;
    const ticks = Math.round(respawnSec * 60);
    if (typeof PlayerLifecycle !== 'undefined') {
      PlayerLifecycle.scheduleRespawn(ticks);
    }
    if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
      game._teamWipe.blue.wipedSince = _now();
      game._teamWipe.blue.respawnAt  = _now() + ticks;
    }
    return 'wiped';
  }

  // ─── Exports ──────────────────────────────────────────────────────
  window.handleLocalDeath          = handleLocalDeath;
  window.shouldSkipSnapshotFallback = shouldSkipSnapshotFallback;
  window.DeathDecider = {
    get lastAutoSwapAt() { return _lastAutoSwapAt; },
    get lastDeathAt()    { return _lastDeathAt; },
    get guardTicks()     { return AUTOSWAP_GUARD_TICKS; },
  };
})();
