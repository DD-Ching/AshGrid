// ============================================================
// Phase 2 — Shared physics + arena constants (SERVER copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// js/sim/constants.js. Only the bottom export boilerplate differs.
//
// See js/sim/constants.js for the full design comment.

// Phase 4 — server tick rate 30 Hz → 60 Hz. Per-tick speed constants
// halve, per-tick duration constants double, so all gameplay values
// stay constant in seconds / pixels-per-second / range-in-pixels.
// PER_TICK now equals PER_FRAME at 60 Hz.
const PLAYER_SPEED_PER_TICK  = 2.8;        // was 5.6
const PLAYER_SPEED_PER_FRAME = 2.8;
const SPRINT_SPEED_MUL       = 1.65;
const PLAYER_RADIUS          = 14;
const PLAYER_HP_MAX          = 100;
const SPAWN_INVULN_TICKS     = 180;        // was 90 — 3 s @ 60 Hz

const TICK_HZ                = 60;         // was 30
const TICK_MS                = 1000 / TICK_HZ;
const FRAME_HZ               = 60;
const FRAME_MS               = 1000 / FRAME_HZ;
const SNAPSHOT_EVERY_TICKS   = 2;          // 60/2 = 30 Hz broadcast (was 30/2 = 15)
const FRAMES_PER_TICK        = FRAME_HZ / TICK_HZ;

const DEFAULT_FIRE_CD_TICKS  = 12;         // was 6 — 200 ms @ 60 Hz
const DEFAULT_BULLET_DAMAGE  = 25;
const DEFAULT_BULLET_SPEED   = 7;          // was 14 — half px/tick @ 60 Hz
const DEFAULT_BULLET_LIFE    = 120;        // was 60 — 2 s @ 60 Hz
const BULLET_SPAWN_OFFSET    = 18;

const NN_ARENA_W             = 1800;
const NN_ARENA_H             = 1800;
const NN_ARENA_PAD           = 50;

export {
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
