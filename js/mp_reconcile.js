// ============ MP RECONCILE (Phase 136 extraction) ============
// Single owner for the multiplayer position-reconcile state machine.
// Before this module, reconcile state was scattered:
//
//   pawn_swap.js          writes  player._mpIgnoreReconcileUntil = Infinity
//   pawn_swap.js          writes  player._mpIgnoreReconcileUntil = Infinity
//   player_lifecycle.js   writes  player._mpIgnoreReconcileUntil = 0
//   multiplayer.js (ACK)  writes  player._mpIgnoreReconcileUntil = 0
//   multiplayer.js (read) reads   player._mpIgnoreReconcileUntil
//
// FIVE write sites, each with its own assumption about timing. The Phase
// 133.3 ghost-vehicle bug was caused by ACK clearing the ignore window
// before the swap stabilized — the server's "you're at the dead spot"
// reconcile took over and dragged the player back to the original spawn.
// Phase 129c-rev disabled MP auto-swap entirely as a band-aid.
//
// This module enforces a single-owner contract:
//   • setIgnoreWindow(ticks)         soft ignore — server ACK can clear
//   • setForcedIgnoreWindow(ticks)   hard ignore — even ACK can't clear
//   • shouldIgnore()                 true while EITHER window is open
//   • onServerAck()                  attempt to soft-clear (no-op if hard
//                                    is still open)
//   • clearAll()                     explicit clear (used by respawn)
//   • reconcilePosition(...)         the actual reconcile decision
//   • tickSpreadError()              per-frame error bleed
//
// The forced window is the new safety primitive that didn't exist before
// — it's what enables Phase 137's safe MP auto-swap (set forced=60 ticks
// after swap, even if server insists we're dead, we hold the swap visual
// stable for 1 second).
//
// Classic-script. Declares globally:
//   MpReconcile                       the public API
//
// State stored on `player` object for backward compat with old code that
// still reads player._mpIgnoreReconcileUntil directly (e.g. debug logs):
//   player._mpIgnoreReconcileUntil    soft window deadline (game.time)
//   player._mpForcedIgnoreUntil       hard window deadline (game.time)
//   player._reconcileErr              { dx, dy } pending error to spread
//
// External deps (resolved at call-time via globals):
//   game · player   (Phase 173: reconcilePosition's _mpState.serverSelfX/Y +
//   pendingInputs + MP_PLAYER_SPEED reads became caller-passed args, so the
//   module no longer reaches into _mpState at all)

(function() {
  'use strict';

  function _now() {
    return (typeof game !== 'undefined' && game.time != null) ? game.time : 0;
  }

  function _player() {
    return (typeof player !== 'undefined') ? player : null;
  }

  // ─── Ignore windows ────────────────────────────────────────────────

  // Soft ignore: typical post-swap protection. Cleared by server ACK
  // (since the ACK means server agrees with our new position).
  function setIgnoreWindow(ticks) {
    const p = _player();
    if (!p) return;
    const deadline = (ticks === Infinity) ? Infinity : _now() + ticks;
    // Don't shrink an existing wider window.
    if ((p._mpIgnoreReconcileUntil || 0) < deadline) {
      p._mpIgnoreReconcileUntil = deadline;
    }
  }

  // Hard ignore: even if server ACKs, we refuse reconcile for this many
  // ticks. Phase 137 safe MP auto-swap will use this so reconcile can't
  // drag the player back to the dead spot just because server's ACK
  // contained position data from before the swap fully synced.
  function setForcedIgnoreWindow(ticks) {
    const p = _player();
    if (!p) return;
    const deadline = (ticks === Infinity) ? Infinity : _now() + ticks;
    if ((p._mpForcedIgnoreUntil || 0) < deadline) {
      p._mpForcedIgnoreUntil = deadline;
    }
  }

  function shouldIgnore() {
    const p = _player();
    if (!p) return false;
    const t = _now();
    return t < (p._mpIgnoreReconcileUntil || 0)
        || t < (p._mpForcedIgnoreUntil || 0);
  }

  // Server ACK arrived. Soft-clear the soft window unless the forced
  // window is still open (in which case we trust the local intent over
  // the server's view).
  function onServerAck() {
    const p = _player();
    if (!p) return;
    const t = _now();
    if (t < (p._mpForcedIgnoreUntil || 0)) return;  // honor hard window
    p._mpIgnoreReconcileUntil = 0;
  }

  // Explicit clear (used by reviveAtSpawn — fresh body, no pending
  // ignore state from the previous incarnation).
  function clearAll() {
    const p = _player();
    if (!p) return;
    p._mpIgnoreReconcileUntil = 0;
    p._mpForcedIgnoreUntil    = 0;
    p._reconcileErr           = null;
  }

  // ─── Reconcile decision ────────────────────────────────────────────

  // Phase 80 spread-error reconcile, extracted verbatim from
  // multiplayer.js:_mpReconcileSelfPosition. Replays unacked inputs
  // from server's authoritative position; bleeds any residual error
  // over multiple frames instead of snapping per snapshot.
  //
  //   • ignore window active   → silently drop error
  //   • big error (>150u)      → instant snap (teleport/respawn/lag)
  //   • small error (<3u)      → dead zone, no-op
  //   • else                   → accumulate to _reconcileErr for tick bleed
  //
  // Args (all caller-passed — Phase 173 made this a pure function of its
  // inputs; the multiplayer.js caller forwards the same _mpState fields it
  // always did, so behaviour is unchanged):
  //   serverX, serverY  server-authoritative self pos (was _mpState.serverSelfX/Y)
  //   pendingInputs     unacked client inputs to replay (was _mpState.pendingInputs)
  //   speed             per-input base movement (MP_PLAYER_SPEED in multiplayer.js)
  function reconcilePosition(serverX, serverY, pendingInputs, speed) {
    const p = _player();
    if (!p) return;

    let predX = serverX;
    let predY = serverY;
    if (typeof predX !== 'number' || typeof predY !== 'number') return;

    // Re-apply unacked inputs with the same multipliers the server
    // applied. Mismatched multipliers were the Phase X 'wolf-sprint
    // rubber-banding' bug.
    const inputs = pendingInputs || [];
    for (const inp of inputs) {
      let dx = inp.dx, dy = inp.dy;
      const mag = Math.hypot(dx, dy);
      if (mag > 1) { dx /= mag; dy /= mag; }
      const sprintMul = inp.sprint ? 1.65 : 1.0;
      const wpnMul    = (typeof inp.wMul === 'number') ? inp.wMul : 1.0;
      const chsMul    = (typeof inp.cMul === 'number') ? inp.cMul : 1.0;
      const mul = sprintMul * wpnMul * chsMul;
      predX += dx * speed * mul;
      predY += dy * speed * mul;
    }

    const dx = predX - p.x;
    const dy = predY - p.y;
    const dist = Math.hypot(dx, dy);

    if (shouldIgnore()) {
      p._reconcileErr = null;
      return;
    }
    if (dist > 150) {
      // Big jump (teleport / respawn / huge lag). Snap immediately —
      // anything > 150u is well past "interpolation" range.
      p.x = predX;
      p.y = predY;
      p._reconcileErr = null;
      return;
    }
    if (dist < 3) {
      // Dead zone — server agrees with us closely enough, nothing to fix.
      return;
    }
    // Accumulate for per-frame bleed (tickSpreadError consumes this).
    p._reconcileErr = { dx, dy };
  }

  // Per-frame error bleed. Multiplayer.js:_mpTickReconcileError previously
  // owned this — extracted verbatim. Called from the main game loop.
  function tickSpreadError() {
    const p = _player();
    if (!p) return;
    const err = p._reconcileErr;
    if (!err) return;
    // 8% per frame ≈ ~150ms half-life @ 60Hz. Smooth on the eye.
    const STEP = 0.08;
    const stepX = err.dx * STEP;
    const stepY = err.dy * STEP;
    p.x += stepX;
    p.y += stepY;
    err.dx -= stepX;
    err.dy -= stepY;
    if (Math.hypot(err.dx, err.dy) < 0.5) {
      p._reconcileErr = null;
    }
  }

  // ─── Exports ──────────────────────────────────────────────────────
  window.MpReconcile = {
    setIgnoreWindow,
    setForcedIgnoreWindow,
    shouldIgnore,
    onServerAck,
    clearAll,
    reconcilePosition,
    tickSpreadError,
  };
})();
