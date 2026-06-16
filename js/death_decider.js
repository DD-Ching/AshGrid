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

    // Phase 137 — MP auto-swap RE-ENABLED, now safe.
    //
    // Why this works after Phase 133.3 failed:
    // Phase 133.3's chain-loop guard (shouldSkipSnapshotFallback) wasn't
    // the actual problem. The real problem was that reconcile in
    // multiplayer.js cleared its ignore window on server ACK (line 337
    // pre-Phase-136). After client auto-swap → broadcast → server
    // disagreed (server-side bots aren't player-owned) → ACK arrived →
    // ignore window cleared → reconcile yanked player back to original
    // dead spot. That's the "ghost vehicle drag" the user reported.
    //
    // Phase 136 introduced MpReconcile.setForcedIgnoreWindow(ticks) — a
    // HARD ignore window the ACK path explicitly cannot clear. Setting
    // 60 ticks here means reconcile is locked off for 1 full second
    // post-swap, long enough for either (a) server to converge or (b)
    // the player to manually press 1-5 if they don't like the auto-pick.
    //
    // SP NN-mode unchanged — auto-swap was always the rule there since
    // there's no authoritative server.
    // SIEGE — no respawn. Your garrison (a positional roster of lives) wakes at
    // the Heart; an empty roster drops the fort into AUTOPILOT. Takes priority
    // over the survival auto-swap below so death is a positional setback (yanked
    // back to centre), never an in-place body-hop. Gated on the state object.
    if (typeof game !== 'undefined' && game._siege && typeof _siegeTryRevive === 'function') {
      const r = _siegeTryRevive();
      _lastAutoSwapAt = _now();
      return r;
    }

    const _isMP = (typeof _mpIsActive === 'function' && _mpIsActive());
    if (typeof tryAutoSwapToClosestAlly === 'function'
        && tryAutoSwapToClosestAlly()) {
      _lastAutoSwapAt = _now();
      if (_isMP && typeof MpReconcile !== 'undefined') {
        // Hard window: reconcile disabled for 60 ticks regardless of
        // server ACK. Soft window is also set by swapPlayerToAlly →
        // MpReconcile.setIgnoreWindow(Infinity), but that one gets
        // cleared by the ACK path; this forced window is the durable
        // safety net.
        MpReconcile.setForcedIgnoreWindow(60);
      }
      return 'swapped';
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
      game._teamWipe.blue.respawnRequested = false;   // Phase 183 — a FRESH wipe needs a FRESH SPACE
      game._teamWipe.blue.respawnAt  = _now() + ticks;
      // Phase 179 — ALSO stamp wall-clock deadlines so the countdown display +
      // the revive condition agree in real seconds. The OTHER wipe trigger
      // (_checkTeamWipe, Phase 92) already does this; this path (player dies
      // last → wipe) previously left them unset, so display + revive fell back
      // to tick-based game.time, which drifts vs real time at the 84-tick sim
      // rate ("看廣告/復活的時間盤算感覺怪怪的"). Same unit as Phase 92
      // (1000/60 ms per game-second tick) — global timing unchanged.
      game._teamWipe.blue.wipedAtMs   = Date.now();
      game._teamWipe.blue.respawnAtMs = Date.now() + ticks * (1000 / 60);
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
