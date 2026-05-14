// ============================================================
// Phase 2 — Shared physics + arena constants (SERVER copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// js/sim/constants.js. Only the bottom export boilerplate differs.
//
// See js/sim/constants.js for the full design comment.

const PLAYER_SPEED_PER_TICK  = 5.6;
const PLAYER_SPEED_PER_FRAME = 2.8;
const SPRINT_SPEED_MUL       = 1.65;
const PLAYER_RADIUS          = 14;
const PLAYER_HP_MAX          = 100;
const SPAWN_INVULN_TICKS     = 90;

const TICK_HZ                = 30;
const TICK_MS                = 1000 / TICK_HZ;
const FRAME_HZ               = 60;
const FRAME_MS               = 1000 / FRAME_HZ;
const SNAPSHOT_EVERY_TICKS   = 2;
const FRAMES_PER_TICK        = FRAME_HZ / TICK_HZ;

const DEFAULT_FIRE_CD_TICKS  = 6;
const DEFAULT_BULLET_DAMAGE  = 25;
const DEFAULT_BULLET_SPEED   = 14;
const DEFAULT_BULLET_LIFE    = 60;
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
