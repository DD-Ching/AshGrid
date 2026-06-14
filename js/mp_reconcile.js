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
//   • reconcilePosition(...)         the actual reconcile decision (pure fn)
//   • tickSpreadError()              per-frame error bleed
//   • handleSelfSnapshot(sp, nowMs)  the full per-snapshot SELF pipeline
//     (Phase 174: RTT · serverSelf merge · dead↔alive · input-drop ·
//      position reconcile · hp/invuln sync — moved here from multiplayer.js)
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
//   game · player — used by the ignore-window + reconcile-decision core.
//   reconcilePosition itself is pure (Phase 173: serverX/Y + pendingInputs +
//   speed are caller-passed args). The Phase 174 handleSelfSnapshot pipeline
//   additionally reads _mpState (serverSelf*/pendingInputs/rtt — the MP state
//   hub) and calls MP_PLAYER_SPEED · getRespawnSeconds · _mpRespawnLocalPlayer ·
//   PlayerLifecycle · handleLocalDeath · shouldSkipSnapshotFallback ·
//   triggerShake · triggerDeathRecap (all live in other classic-script files).

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

  // ─── Snapshot self-pipeline (Phase 174 — moved verbatim from multiplayer.js)
  // The per-snapshot pipeline for the LOCAL player. Order is visible in
  // handleSelfSnapshot below, not buried in a 250-line monolith. Lives here so
  // MpReconcile owns ALL of layer-3 (the reconcile concern) in one file.
  // serverSelf*/pendingInputs stay on _mpState (the MP state hub); these helpers
  // read them cross-file exactly as the multiplayer.js originals did. Cross-module
  // calls (_mpRespawnLocalPlayer, handleLocalDeath, PlayerLifecycle, FX hooks)
  // all resolve at call-time, so load order vs multiplayer.js is irrelevant.

  function _updateRtt(sp, nowMs) {
    // RTT (ping). sp.t is the freshest input timestamp the server has
    // received from us; round-trip = now - that. EMA-smooth at 0.2 so a
    // single packet hiccup doesn't strobe the quality dot.
    if (typeof sp.t === 'number' && sp.t > 0) {
      const rtt = Math.max(0, nowMs - sp.t);
      _mpState.rttMs = rtt;
      _mpState.rttSmoothed = _mpState.rttSmoothed === 0
        ? rtt
        : _mpState.rttSmoothed * 0.8 + rtt * 0.2;
    }
  }

  function _mergeServerSelfFields(sp) {
    // Phase 5 — delta compression: only-overwrite when defined.
    // Missing field = "server says no change, keep last value."
    if (sp.x      !== undefined) _mpState.serverSelfX      = sp.x;
    if (sp.y      !== undefined) _mpState.serverSelfY      = sp.y;
    if (sp.angle  !== undefined) _mpState.serverSelfAngle  = sp.angle;
    if (sp.hp     !== undefined) _mpState.serverSelfHp     = sp.hp;
    if (sp.alive  !== undefined) _mpState.serverSelfAlive  = sp.alive;
    if (sp.invuln !== undefined) _mpState.serverSelfInvuln = !!sp.invuln;
  }

  function _tryRespawnLocal() {
    // Phase 59: dead→alive transition. _mpRespawnLocalPlayer() was defined
    // but had NO caller until this hook — nothing connected the server's
    // respawn snapshot back to player.alive=true, which was the user's
    // '死掉瞬間復活的bug' (actually opposite — visually felt 'instant'
    // because no UI marked the dead window).
    // Guard: only fire if (1) locally dead AND server says alive AND
    // (2) actually died via kill handler (_killedAtTime set) AND
    // (3) the buff/default respawn window elapsed (Phase 60: client gate
    // tied to getRespawnSeconds() so the UI countdown's full duration is
    // honored before respawn fires).
    if (typeof player === 'undefined') return;
    if (player.alive || !_mpState.serverSelfAlive) return;
    if (!player._killedAtTime) return;
    const _t = (typeof game !== 'undefined' && game.time) ? game.time : 0;
    const _minDeadFrames = (typeof getRespawnSeconds === 'function')
      ? getRespawnSeconds() * 60
      : 90;
    if ((_t - player._killedAtTime) >= _minDeadFrames) {
      _mpRespawnLocalPlayer();
    }
  }

  function _trySynthKill() {
    // Phase X — alive→dead safety net. User '有時候被幹掉我就會變成
    // 停在原地不能動,然後就動了會回去': the 'kill' event got lost in
    // transit so _mpHandleKill never fired; client kept player.alive=true
    // while server-side they were dead, reconcile snapped them back every
    // snapshot = stuck-in-place. Now the snapshot itself drives the dead
    // transition when the event was missed.
    if (typeof player === 'undefined') return;
    if (!player.alive || _mpState.serverSelfAlive !== false) return;
    // Phase 128 — post-respawn protection. Phase 125 made
    // _mpRespawnLocalPlayer client-authoritative (force alive=true when
    // client UI countdown ends), but the snapshot's "you're dead" packets
    // from the server's gap-state are still in flight. Without this guard
    // this block kills the freshly-respawned player → respawn timer
    // restarts → infinite die/respawn loop. Same 180-tick window the
    // hp/invuln sync uses.
    if (typeof PlayerLifecycle !== 'undefined' && PlayerLifecycle.justRespawned(180)) {
      return;   // server still catching up; ignore stale "dead" packet
    }
    // Killer telemetry default ('?') before the state transition so the
    // death-recap UI has something to render.
    if (!player._killer) player._killer = { callsign: '?' };
    // Phase 129c → Phase 133.3 — delegate to handleLocalDeath
    // (now lives in js/death_decider.js).
    //
    // CHAIN-LOOP GUARD: this snapshot-fallback fires every tick the
    // server still thinks we're dead. If we already auto-swapped to an
    // ally locally, the server doesn't know yet (server is authoritative
    // for the original player slot's respawn) — so a re-entry here would
    // chain-swap to ANOTHER ally on top of our existing swap. The Phase
    // 129c bug ("莫名其妙接管不知哪來的載具") was exactly this loop.
    //
    // Ask death_decider whether we just auto-swapped; if yes, skip. The
    // kill-event path above doesn't need this guard (each kill message
    // is a fresh discrete death; snapshot is the periodic re-check).
    if (typeof shouldSkipSnapshotFallback === 'function'
        && shouldSkipSnapshotFallback()) {
      console.log('[mp] snapshot-fallback skipped — recent auto-swap (chain-loop guard)');
      return;
    }
    if (typeof handleLocalDeath === 'function') {
      handleLocalDeath({ x: player.x, y: player.y });
    }
    if (typeof triggerShake === 'function') triggerShake(8, 18);
    if (typeof triggerDeathRecap === 'function') triggerDeathRecap();
    console.log('[mp] alive→dead via snapshot (kill event was lost)');
  }

  function _dropProcessedInputs(sp) {
    // Drop inputs the server has already processed. lastInputSeq is
    // ALWAYS in every snapshot (never delta-omitted) since it changes
    // every tick — but guard anyway.
    if (sp.lastInputSeq != null) {
      _mpState.pendingInputs = _mpState.pendingInputs.filter(i => i.seq > sp.lastInputSeq);
    }
  }

  function _syncSelfHpAndInvuln(sp) {
    if (typeof player === 'undefined') return;
    // Phase 125 / R12 — post-respawn protection window. After
    // _mpRespawnLocalPlayer fires, server can still send stale packets
    // from the gap-damage period (server respawned earlier than client
    // UI countdown, server-side player took damage in the gap, "you're
    // dead" / "hp=0" packets still in flight). Block those rewrites for
    // 180 ticks so the freshly-respawned player keeps alive=true +
    // hp=max + invuln shield intact.
    const _justRespawned = (typeof PlayerLifecycle !== 'undefined')
                           && PlayerLifecycle.justRespawned(180);
    // HP has TWO writers because NN bots live client-only (see fire()
    // ghost-bullet note in index.html). min(local, server) picks the
    // lower of:
    //   • local hp (NN bullet just hit us — server doesn't know)
    //   • server hp (MP bullet hit us — server is authoritative)
    // Both kinds of damage stay durable across snapshots. Respawn — where
    // server hp jumps low→max — is handled by _mpRespawnLocalPlayer which
    // snaps local hp explicitly, bypassing this min().
    if (typeof sp.hp === 'number' && !_justRespawned) {
      player.hp = Math.min(
        (typeof player.hp === 'number') ? player.hp : sp.hp,
        sp.hp
      );
    }
    // Phase 184e — heavy ARMOUR sync. Same two-writer reasoning as hp: local
    // (client-only NN bullet drained player.armor via _applyDamageToUnit) vs
    // server (MP bullet drained the authoritative p.armor). min() keeps both
    // kinds of armour loss durable; respawn (server armour low→full) is handled
    // by the justRespawned guard like hp. Only meaningful for a heavy (maxArmor>0).
    if (typeof sp.armor === 'number' && !_justRespawned
        && typeof player.maxArmor === 'number' && player.maxArmor > 0) {
      player.armor = Math.min(
        (typeof player.armor === 'number') ? player.armor : sp.armor,
        sp.armor
      );
    }
    // Invuln pin: server is authoritative for spawn protection.
    // Phase 5: only act when sp.invuln is EXPLICITLY in the snapshot —
    // undefined means delta has no change, leave _invulnUntil alone.
    // Phase 125: also skip during the post-respawn window — server's
    // "invuln expired" packet from the gap shouldn't reset the freshly-
    // granted client-side shield.
    if (!_justRespawned) {
      if (sp.invuln === true) {
        player._invulnUntil = Infinity;
      } else if (sp.invuln === false && player._invulnUntil === Infinity) {
        player._invulnUntil = 0;
      }
    }
  }

  // Ordered self-snapshot pipeline (was multiplayer.js:_mpHandleSelfSnapshot).
  // Order matters: RTT first (timing); merge serverSelf BEFORE reconcile
  // (reconcile reads serverSelfX/Y); dead↔alive transitions BEFORE hp/invuln
  // sync (the latter is guarded by justRespawned, which the former sets up).
  function handleSelfSnapshot(sp, nowMs) {
    _updateRtt(sp, nowMs);
    _mergeServerSelfFields(sp);
    _tryRespawnLocal();
    _trySynthKill();
    _dropProcessedInputs(sp);
    reconcilePosition(_mpState.serverSelfX, _mpState.serverSelfY,
                      _mpState.pendingInputs, MP_PLAYER_SPEED);
    _syncSelfHpAndInvuln(sp);
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
    handleSelfSnapshot,
  };
})();
