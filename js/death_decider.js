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

    // Phase 134 (rollback) — restore Phase 129c-rev semantics.
    // The brief Phase 133.3 re-enable of MP auto-swap caused a ghost-
    // vehicle drag-back regression — user took control of an ally body
    // but the server didn't agree (NN-driven bots are server-side, the
    // client can't authoritatively claim one), so reconcile kept
    // dragging the player back to the original dead slot's last position.
    //
    // SP NN-mode auto-swap stays — works fine there since there's no
    // authoritative server. MP path falls through to the recap-with-
    // alive-allies branch below, which the death recap UI renders
    // as a swap-hint instead of a countdown.
    const _isMP = (typeof _mpIsActive === 'function' && _mpIsActive());
    if (!_isMP
        && typeof tryAutoSwapToClosestAlly === 'function'
        && tryAutoSwapToClosestAlly()) {
      _lastAutoSwapAt = _now();
      return 'swapped';
    }

    // MP + at least one alive ally → skip countdown / wipedSince so
    // the death-recap renders the AUTO-SWAP HINT branch instead of
    // the WIPED countdown + ad CTA. Player presses 1-5 manually to
    // swap; server still drives respawn at the original slot if they
    // don't act.
    if (_isMP) {
      const _anyAllyAlive = (typeof allies !== 'undefined' && allies)
        ? allies.some(a => a && a.alive)
        : false;
      if (_anyAllyAlive) return 'mp-ally-alive';
    }

    // No swap target → full team-wipe path.
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
