// ============================================================
// Phase 2 — Shared physics + arena constants (CLIENT copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// server/party/sim/constants.js. Only the bottom export
// boilerplate differs.
//
// Why this exists: every magic number that affects gameplay physics
// or net-syncable state needs ONE definition both sides can read.
// Pre-Phase-2, the server had its own copies (PLAYER_RADIUS=14,
// FIRE_COOLDOWN=6 etc.) while the client had others — sometimes
// equal, sometimes not. Drift in any of them is desync.
//
// Constants live by what they describe:
//   PHYSICS_*   pure motion (speed, radius, friction-style stuff)
//   FIRE_*      shooting rules
//   ARENA_*     world bounds + spawn anchors
//   TIMING_*    tick rates + lifetimes
//
// Use `SIM.<NAME>` (classic-script side, via window.SIM) or import
// from `./sim/constants.js` (server ESM side).

(function() {
  'use strict';

  // ─ PHYSICS ────────────────────────────────────────────────
  const PLAYER_SPEED_PER_TICK  = 5.6;         // 30 Hz server tick
  const PLAYER_SPEED_PER_FRAME = 2.8;         // 60 fps client frame; 2× per-tick == per-second match
  const SPRINT_SPEED_MUL       = 1.65;
  const PLAYER_RADIUS          = 14;
  const PLAYER_HP_MAX          = 100;
  const SPAWN_INVULN_TICKS     = 90;          // 3 s at 30 Hz

  // ─ TIMING ─────────────────────────────────────────────────
  const TICK_HZ                = 30;
  const TICK_MS                = 1000 / TICK_HZ;
  const FRAME_HZ               = 60;
  const FRAME_MS               = 1000 / FRAME_HZ;
  const SNAPSHOT_EVERY_TICKS   = 2;           // broadcast at ~15 Hz
  // Two frames per tick — used by client-side prediction integration
  // (one input → two frames of per-frame motion ≡ one tick of per-tick).
  const FRAMES_PER_TICK        = FRAME_HZ / TICK_HZ;

  // ─ FIRE / RELOAD ──────────────────────────────────────────
  // Weapon-specific overrides live in sim/weapons.js. These are the
  // fallback defaults used when a weapon doesn't pin its own value.
  const DEFAULT_FIRE_CD_TICKS  = 6;           // 5 shots/sec at 30 Hz
  const DEFAULT_BULLET_DAMAGE  = 25;
  const DEFAULT_BULLET_SPEED   = 14;          // px/tick — matches server's pre-Phase-2 hardcode
  const DEFAULT_BULLET_LIFE    = 60;          // ticks
  const BULLET_SPAWN_OFFSET    = 18;          // muzzle distance from unit center

  // ─ ARENA ──────────────────────────────────────────────────
  const NN_ARENA_W             = 1800;
  const NN_ARENA_H             = 1800;
  const NN_ARENA_PAD           = 50;          // server-side margin to avoid spawning IN a wall

  // ─ PUBLIC SURFACE ─────────────────────────────────────────
  const API = {
    PLAYER_SPEED_PER_TICK,
    PLAYER_SPEED_PER_FRAME,
    SPRINT_SPEED_MUL,
    PLAYER_RADIUS,
    PLAYER_HP_MAX,
    SPAWN_INVULN_TICKS,
    TICK_HZ,
    TICK_MS,
    FRAME_HZ,
    FRAME_MS,
    SNAPSHOT_EVERY_TICKS,
    FRAMES_PER_TICK,
    DEFAULT_FIRE_CD_TICKS,
    DEFAULT_BULLET_DAMAGE,
    DEFAULT_BULLET_SPEED,
    DEFAULT_BULLET_LIFE,
    BULLET_SPAWN_OFFSET,
    NN_ARENA_W,
    NN_ARENA_H,
    NN_ARENA_PAD,
  };

  if (typeof window !== 'undefined') {
    window.SIM = window.SIM || {};
    Object.assign(window.SIM, API);
  }
})();
