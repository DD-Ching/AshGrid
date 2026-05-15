// AshGrid authoritative game server (Phase 36+37+38).
//
// Wings.io-style: server holds the world's truth, ticks at 30Hz,
// broadcasts snapshots at 20Hz. Clients send INPUT (not positions);
// server applies inputs in order, simulates everything, broadcasts
// the result. Hit detection, HP, deaths — all decided here. No more
// "I shot him but he didn't die" desyncs.
//
// Cloudflare Durable Objects via PartyKit. Tick uses setInterval
// inside the DO instance — Cloudflare bills this against the room's
// owner; a room with no players idles cheaply because we tear down
// the interval in onClose-when-empty.
//
// Protocol (JSON over WebSocket):
//
//   client → server
//     {type: 'input', seq, dx, dy, angle, fire, t?, vT?, name?}
//         seq = monotonic input number (used for reconciliation)
//         dx, dy = move vector in [-1, 1]
//         angle = facing radians (for fire direction)
//         fire = bool (held)
//         t   = client's Date.now() at send time (echoed in snapshot for RTT)
//         vT  = view tick — latest snapshot tick the client has rendered.
//               Used by lag compensation: when fire=true the server rewinds
//               targets to (vT − interp delay) and tests the bullet against
//               their position at that historic tick. Honours "favor the
//               shooter" — shots aimed at where the shooter SAW the target
//               land, even if the target moved during the input's flight.
//     {type: 'emote', idx}            (transient, just relayed)
//     {type: 'ping', x, y}            (transient, just relayed)
//     {type: 'build', sid, kind, x, y}    (Phase 43)
//         Place a built structure. sid is client-generated so both sides
//         agree on identity from frame zero (server uses sid verbatim).
//     {type: 'explosionRequest', x, y, r, dmg}    (Phase 43)
//         Apply AOE damage to structures within radius. Used by client-
//         spawned grenades / FPV / airstrikes (those weapons are still
//         client-only; this lets them touch server-authoritative walls).
//
//   server → client
//     {type: 'welcome', id, tick, structures}   (sent once on connect)
//         Phase 43: structures = full snapshot of currently-built walls so
//         late joiners see what others have built.
//     {type: 'snapshot', tick, players, bullets, sT}
//         sT = server Date.now() at broadcast time (for snapshot interp clock sync)
//         players: [{id, x, y, angle, hp, alive, name, lastInputSeq, invuln, t}]
//             t = echoed client timestamp for own player only (used for RTT)
//         bullets: [{id, x, y, vx, vy, s}]    s = shooter id (short)
//     {type: 'hit', victim, shooter, hp, weapon, x, y, lc?}   (event)
//         x, y = world coordinates where the bullet landed (used by the
//                client to spawn blood / damage popup at the right spot)
//         lc   = 1 if the hit was lag-compensated (resolved at fire time
//                against historic position rather than physics-based bullet
//                hit-test). Clients can use it for diagnostic display.
//     {type: 'kill', shooter, victim, weapon, x, y, lc?}       (event)
//     {type: 'wallHit', x, y, kind}                            (event)
//         Phase 41: bullet stopped on a wall/cover. kind = 'building' |
//         'cover'. Client spawns an impact spark (createExplosion 'small').
//     {type: 'structureAdd', s}                                (Phase 43)
//         Another player (or you) just built `s`. Client mirrors into
//         game._structures using `s.sid` as the identity key.
//     {type: 'structureHit', sid, hp, x, y}                    (Phase 43)
//         Built structure took damage. x,y = impact point (for spark).
//     {type: 'structureGone', sid, x, y}                       (Phase 43)
//         Structure was destroyed. Client removes from game._structures
//         and spawns a small explosion at (x, y).
//     {type: 'leave', id}
//     {type: 'emote'|'ping', from, ...}
//
// All deterministic constants live up here so the client can match
// movement feel exactly under prediction.

// Phase 1 — shared movement sim. The same logic lives in
// js/sim/movement.js (classic-script copy for the browser). Logic must
// stay byte-identical between the two; ai_arena/scripts/check_sim_parity.sh
// diffs them in pre-commit.
import { simStepPerTick as simStepPerTickV2 } from './sim/movement.js';
// Phase 2 — shared weapon table + bullet sim.
import { getWeaponSim } from './sim/weapons.js';
import { spawnBulletsFromUnit } from './sim/bullet.js';
// Phase 3c — server-side NN inference. Pure-JS forward pass + obs
// builder, no onnxruntime dependency. createNet() runs once at module
// load with the elite policy's weights (one of 11 trained checkpoints;
// the others can be hot-swapped via _NN_NET if we expose a difficulty
// dial later).
import { createNet } from './sim/nn_runtime.js';
import { buildObs } from './sim/nn_obs.js';
import _NN_WEIGHTS_ELITE from './sim/nn_weights_elite.js';
const _NN_NET = createNet(_NN_WEIGHTS_ELITE);
// 9 move directions matching the PPO model's action layout.
// action = moveDir * 2 + fireBit  →  moveDir = action >> 1, fire = action & 1
//   0 = idle, 1..8 = N, NE, E, SE, S, SW, W, NW.
const _NN_MOVE_DIRS = [
  [ 0,  0],   // 0 idle
  [ 0, -1],   // 1 N
  [ 1, -1],   // 2 NE
  [ 1,  0],   // 3 E
  [ 1,  1],   // 4 SE
  [ 0,  1],   // 5 S
  [-1,  1],   // 6 SW
  [-1,  0],   // 7 W
  [-1, -1],   // 8 NW
];
// When the bot's team is 1 (red, spawning right side), we feed the
// policy a horizontally-mirrored obs so it sees "blue on the left"
// like training, then mirror the resulting MOVE direction back. Maps
// E↔W (3↔7), NE↔NW (2↔8), SE↔SW (4↔6). Fire bit and N/S/idle stay.
const _NN_MIRROR_MOVE = [0, 1, 8, 7, 6, 5, 4, 3, 2];
const _NN_OBS_BUF = new Float32Array(65);

// Phase 4 → Phase 4b — server tick rate 30 Hz → 100 Hz (was 60 Hz). CF/
// PartyKit on Workers has tons of CPU headroom and the player wins
// compound: input→action latency drops to 0-10 ms (was 0-16 ms at 60 Hz,
// 0-33 ms at 30 Hz), lag-comp granularity 3.3× over the original.
//
// All per-tick constants rescale via TICK_FACTOR = TICK_HZ / 30:
//   - SPEED constants (px/tick)   ÷ TICK_FACTOR  → same px/sec
//   - DURATION constants (ticks)  × TICK_FACTOR  → same wall-time
//
// Non-integer factor (3.333) means some derived tick counts are floats
// (e.g. bot _fireCd = wsim.fireCdTicks | 0 already truncates; lag-comp
// uses Math.round). Doesn't affect game balance.
const TICK_HZ           = 100;
const TICK_FACTOR       = TICK_HZ / 30;     // 3.333 — multiplier vs the 30-Hz baseline
const TICK_MS           = 1000 / TICK_HZ;
// Snapshot every 3 ticks @ 100 Hz = 33.3 Hz broadcast — close to the
// 30 Hz set in Phase 3.1. Network pacing stays the same while sim
// granularity bumps 1.67× (60 Hz → 100 Hz).
const SNAPSHOT_EVERY    = 3;          // 3 ticks @ 100Hz = 33Hz broadcast
const PLAYER_RADIUS     = 14;
const PLAYER_SPEED      = 5.6 / TICK_FACTOR;   // 2.8 — half of 30-Hz baseline
const ARENA_W           = 1800;
const ARENA_H           = 1800;
const ARENA_PAD         = 50;         // wall margin
// Phase 3.3 — 8 bots. NN inference is ~32 µs per bot × 60 Hz = ~15 ms
// CPU/sec — still <50% of the 16 ms tick budget at 60 Hz.
const NN_BOTS_INITIAL   = 8;
// Phase 4 — half per-tick speed so 60 Hz × half = same 135 px/sec bot
// velocity as before.
const BOT_SPEED_PER_TICK = 4.5 / TICK_FACTOR;  // 2.25
const BOT_RESPAWN_TICKS = 5 * TICK_HZ;     // 5 s
const HP_MAX            = 100;
const INVULN_TICKS      = 3 * TICK_HZ;     // 3 s spawn protection
// Phase 60: respawn time is ad-buffable (DEFAULT_SEC / BUFFED_SEC in
// js/respawn_buff.js). Both phrased in seconds × TICK_HZ so changing
// TICK_HZ doesn't drift the player-visible countdown.
const RESPAWN_TICKS_DEFAULT = 15 * TICK_HZ;  // 15 s
const RESPAWN_TICKS_BUFFED  = 5  * TICK_HZ;  // 5 s
const FIRE_COOLDOWN     = 6 * TICK_FACTOR;   // 12 ticks @ 60Hz = 200 ms = ~5 shots/sec
const BULLET_SPEED      = 14 / TICK_FACTOR;  // 7 — half of 30-Hz baseline
const BULLET_LIFE       = 60 * TICK_FACTOR;  // 120 ticks @ 60Hz = 2 s
const BULLET_DAMAGE     = 25;
const BULLET_OFFSET     = 18;         // spawn distance from player center

// Phase 40: lag compensation ("favor the shooter"). Server keeps a rolling
// per-player position history. When a fire input arrives, we know which
// snapshot tick the shooter was rendering (input.vT) and we know the client
// was interpolating 100ms in the past (LAG_INTERP_OFFSET ticks). We rewind
// each candidate target to that historic position and check if the bullet's
// path through the next `lagTicks` ticks would intersect it. If so, register
// an instant hit — the bullet "should have hit because the shooter aimed at
// where they saw the target." This is what Counter-Strike, Valorant, Quake3,
// Source engine, and basically every modern competitive shooter does.
//
// Trade-off: a target who just dodged behind cover (none in this arena, but
// future-proofing) might still take damage from a shot fired before they
// dodged. That's the "I died around the corner" complaint, and it's the
// cost of fairness for the shooter. The alternative — only counting hits
// that land on the target's current position — punishes high-ping players
// disproportionately. CS-style favor-the-shooter is the established norm.
const HISTORY_TICKS     = 1 * TICK_HZ;       // 1 s of position history per player
const LAG_INTERP_OFFSET = 3 * TICK_FACTOR;   // 6 ticks @ 60Hz = 100 ms — matches client interp
const LAG_COMP_MAX      = 18 * TICK_FACTOR;  // 36 ticks @ 60Hz = 600 ms cap — beyond this
                                             //   prediction is not trustworthy.

// Phase 41: server-side wall data for the "industrial" arena. Mirrors the
// procedural map in /js/missions/nn_arena_variants.js (the 'industrial'
// variant). MP mode forces this map for all rooms (Phase 22→29). Both the
// shape AND the coordinates have to match the client byte-for-byte so that
// what the player sees on their screen is exactly what the server enforces
// for collision — otherwise we get the corner-clip / phasing artifacts that
// were the whole reason for moving to an authoritative server in the first
// place.
//
// Shape: { x, y, w, h, kind: 'building' | 'cover' }
//   building → blocks player movement AND bullets
//   cover    → walk-through but blocks bullets (waist-high crates)
function _buildIndustrialMap() {
  const out = [];
  const T = 22;       // wall thickness
  const D = 90;       // door opening width
  // Hollow rectangular building with optional door gaps. Each `doors.side`
  // is the door's center coordinate on the opposite axis.
  const wall = (x1, y1, x2, y2, doors) => {
    const d = doors || {};
    if (d.top != null) {
      out.push({ x: x1, y: y1, w: d.top - D/2 - x1, h: T, kind: 'building' });
      out.push({ x: d.top + D/2, y: y1, w: x2 - (d.top + D/2), h: T, kind: 'building' });
    } else out.push({ x: x1, y: y1, w: x2 - x1, h: T, kind: 'building' });
    if (d.bottom != null) {
      out.push({ x: x1, y: y2 - T, w: d.bottom - D/2 - x1, h: T, kind: 'building' });
      out.push({ x: d.bottom + D/2, y: y2 - T, w: x2 - (d.bottom + D/2), h: T, kind: 'building' });
    } else out.push({ x: x1, y: y2 - T, w: x2 - x1, h: T, kind: 'building' });
    if (d.left != null) {
      out.push({ x: x1, y: y1, w: T, h: d.left - D/2 - y1, kind: 'building' });
      out.push({ x: x1, y: d.left + D/2, w: T, h: y2 - (d.left + D/2), kind: 'building' });
    } else out.push({ x: x1, y: y1, w: T, h: y2 - y1, kind: 'building' });
    if (d.right != null) {
      out.push({ x: x2 - T, y: y1, w: T, h: d.right - D/2 - y1, kind: 'building' });
      out.push({ x: x2 - T, y: d.right + D/2, w: T, h: y2 - (d.right + D/2), kind: 'building' });
    } else out.push({ x: x2 - T, y: y1, w: T, h: y2 - y1, kind: 'building' });
  };
  // 8 warehouses on a 3×3 grid (centre = open plaza w/ factory).
  wall( 120,  120,  480,  480, { bottom: 300,  right: 300 });
  wall( 720,  120, 1080,  480, { bottom: 900,  left: 300, right: 300 });
  wall(1320,  120, 1680,  480, { bottom: 1500, left: 300 });
  wall( 120,  720,  480, 1080, { top: 300,    bottom: 300, right: 900 });
  wall(1320,  720, 1680, 1080, { top: 1500,   bottom: 1500, left: 900 });
  wall( 120, 1320,  480, 1680, { top: 300,    right: 1500 });
  wall( 720, 1320, 1080, 1680, { top: 900,    left: 1500, right: 1500 });
  wall(1320, 1320, 1680, 1680, { top: 1500,   left: 1500 });
  // Interior partitions (one per warehouse) — short stubs splitting each
  // warehouse into two rooms.
  out.push({ x:  150, y:  300, w: 190, h: T,   kind: 'building' }); // NW horiz
  out.push({ x:  900, y:  150, w: T,   h: 190, kind: 'building' }); // N  vert
  out.push({ x: 1460, y:  300, w: 190, h: T,   kind: 'building' }); // NE horiz
  out.push({ x:  150, y:  900, w: 190, h: T,   kind: 'building' }); // W  horiz
  out.push({ x: 1460, y:  900, w: 190, h: T,   kind: 'building' }); // E  horiz
  out.push({ x:  150, y: 1500, w: 190, h: T,   kind: 'building' }); // SW horiz
  out.push({ x:  900, y: 1500, w: T,   h: 150, kind: 'building' }); // S  vert
  out.push({ x: 1460, y: 1500, w: 190, h: T,   kind: 'building' }); // SE horiz
  // Interior crates — 50×50, one per warehouse room.
  const interior = [
    [ 200, 200], [ 380, 400],   [ 800, 200], [ 980, 400],
    [1400, 200], [1580, 400],   [ 200, 800], [ 380, 1000],
    [1400, 800], [1580, 1000],  [ 200, 1400],[ 380, 1600],
    [ 800, 1400],[ 980, 1600],  [1400, 1400],[1580, 1600],
  ];
  for (const [cx, cy] of interior) {
    out.push({ x: cx - 25, y: cy - 25, w: 50, h: 50, kind: 'cover' });
  }
  // Alley crates — 40×40, sit mid-alley so lanes aren't pure sniper sightlines.
  const alleys = [
    [ 600,  220], [ 600,  380],  [1200,  220], [1200,  380],
    [ 600, 1420], [ 600, 1580],  [1200, 1420], [1200, 1580],
    [ 220,  600], [ 380,  600],  [1420,  600], [1580,  600],
    [ 220, 1200], [ 380, 1200],  [1420, 1200], [1580, 1200],
  ];
  for (const [cx, cy] of alleys) {
    out.push({ x: cx - 20, y: cy - 20, w: 40, h: 40, kind: 'cover' });
  }
  // Plaza crates — 4 around the central factory for sightline breaks.
  const plaza = [[760, 760], [1040, 760], [760, 1040], [1040, 1040]];
  for (const [cx, cy] of plaza) {
    out.push({ x: cx - 25, y: cy - 25, w: 50, h: 50, kind: 'cover' });
  }
  return out;
}
const _MAP_OBSTACLES = _buildIndustrialMap();
const _MAP_BUILDINGS = _MAP_OBSTACLES.filter(o => o.kind === 'building');
const _MAP_COVERS    = _MAP_OBSTACLES.filter(o => o.kind === 'cover');

// Push entity (circle) out of any axis-aligned building rectangle it overlaps.
// Mirrors client-side `pushOutOfBuildings`. Cheap O(N) — N ≈ 50 obstacles
// for industrial; runs once per player per tick, cost is negligible.
function _pushOutOfWalls(p, radius) {
  for (const b of _MAP_BUILDINGS) {
    // Closest point on the AABB to the circle centre.
    const cx = p.x < b.x ? b.x : (p.x > b.x + b.w ? b.x + b.w : p.x);
    const cy = p.y < b.y ? b.y : (p.y > b.y + b.h ? b.y + b.h : p.y);
    const dx = p.x - cx, dy = p.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= radius * radius) continue;
    if (d2 > 0.0001) {
      // Outside the AABB but penetrating the inflated capsule — push
      // perpendicularly outward.
      const d = Math.sqrt(d2);
      const push = radius - d + 0.5;
      p.x += (dx / d) * push;
      p.y += (dy / d) * push;
    } else {
      // Centre is INSIDE the rectangle (e.g. spawned inside, or pushed in
      // by a chain of inputs). Eject through the nearest edge.
      const left   = p.x - b.x;
      const right  = (b.x + b.w) - p.x;
      const top    = p.y - b.y;
      const bottom = (b.y + b.h) - p.y;
      const m = Math.min(left, right, top, bottom);
      if (m === left)        p.x = b.x - radius - 0.5;
      else if (m === right)  p.x = b.x + b.w + radius + 0.5;
      else if (m === top)    p.y = b.y - radius - 0.5;
      else                   p.y = b.y + b.h + radius + 0.5;
    }
  }
}

// Test whether a bullet's centre is inside any obstacle (building OR cover).
// Returns the obstacle hit or null. Buildings AND covers stop bullets — covers
// are waist-high, bullets pass over only in the truly-airborne sense which we
// don't model, so the safe assumption is "if the line of fire intersects a
// crate, the bullet stops on the crate." Same as single-player.
function _bulletInWall(b) {
  for (const obs of _MAP_OBSTACLES) {
    if (b.x >= obs.x && b.x <= obs.x + obs.w &&
        b.y >= obs.y && b.y <= obs.y + obs.h) {
      return obs;
    }
  }
  return null;
}

// Line-of-sight check: returns true iff a straight line from (ax,ay) to
// (bx,by) is clear of every building. Used by bot aim selection so bots
// don't keep firing at an enemy who walked behind a wall (the user-
// reported '敵人還是穿牆攻擊' bug: server bots had a cone-only obs path
// with no wall test, so they'd pick a hidden target as `nearestE` and
// keep spawning bullets that just got eaten by _bulletInWall one tick
// later — wasted CPU + visual confusion).
//
// Implementation: parametric ray-AABB step at 16 px increments. For a
// 1800-px arena and bullet ranges ≤ 1100 the worst case is ~70 samples
// per check, called once per alive bot per tick (4 bots × 30 Hz = 120/s).
// Cheap.
function _hasLineOfSight(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return true;
  const STEP = 16;
  const n = Math.ceil(dist / STEP);
  const nx = dx / n, ny = dy / n;
  let px = ax, py = ay;
  for (let i = 1; i < n; i++) {
    px += nx; py += ny;
    for (const w of _MAP_BUILDINGS) {
      if (px >= w.x && px <= w.x + w.w && py >= w.y && py <= w.y + w.h) {
        return false;
      }
    }
  }
  return true;
}

// Test whether a candidate spawn is too close to any building (within
// PLAYER_RADIUS + small margin). Used by the spawn picker so respawning
// players never appear half-clipped through a wall.
function _spawnClearOfWalls(x, y) {
  const r = PLAYER_RADIUS + 6;
  for (const b of _MAP_BUILDINGS) {
    if (x >= b.x - r && x <= b.x + b.w + r &&
        y >= b.y - r && y <= b.y + b.h + r) return false;
  }
  return true;
}

// Phase 43: built structures. Mirrors the subset of STRUCTURE_DEFS the
// server actually needs to enforce — HP for damage, size for collision,
// blocks for whether bullets/players stop on it. Other client-side fields
// (turret range, generator power, etc.) the server doesn't simulate; they
// live purely on each client's update loop. Kinds we don't list get
// rejected at build time so a malformed/spoofed kind can't crash anything.
const _BUILD_DEFS = {
  cover:   { hp: 120, size: 30, blocks: true,  blocksLOS: false },
  wall:    { hp: 220, size: 30, blocks: true,  blocksLOS: true  },
  bunker:  { hp: 500, size: 30, blocks: true,  blocksLOS: true  },
  turret:  { hp: 160, size: 50, blocks: false, blocksLOS: false },
  generator:{ hp: 120, size: 50, blocks: false, blocksLOS: false },
  camera:  { hp:  90, size: 40, blocks: false, blocksLOS: false },
  terminal:{ hp: 140, size: 50, blocks: false, blocksLOS: false },
  mine:    { hp:   1, size: 24, blocks: false, blocksLOS: false },
  tripmine:{ hp:   1, size: 28, blocks: false, blocksLOS: false },
  sensor:  { hp:  70, size: 30, blocks: false, blocksLOS: false },
  smoke:   { hp: 110, size: 36, blocks: false, blocksLOS: false },
  tesla:   { hp: 150, size: 38, blocks: false, blocksLOS: false },
  emp:     { hp: 130, size: 36, blocks: false, blocksLOS: false },
  medstation:{ hp: 110, size: 32, blocks: false, blocksLOS: false },
  dronebay:{ hp: 170, size: 38, blocks: false, blocksLOS: false },
};

// Push entity (circle) out of any structure rectangle it overlaps. Same
// AABB push-out as _pushOutOfWalls; structures live in `this.structures`
// (instance-side) so this helper is a method, not a free fn.
function _pushOutOfStructure(p, radius, s) {
  const def = _BUILD_DEFS[s.kind]; if (!def || !def.blocks) return;
  const half = def.size / 2;
  const ax = s.x - half, ay = s.y - half;
  const bx = s.x + half, by = s.y + half;
  const cx = p.x < ax ? ax : (p.x > bx ? bx : p.x);
  const cy = p.y < ay ? ay : (p.y > by ? by : p.y);
  const dx = p.x - cx, dy = p.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 >= radius * radius) return;
  if (d2 > 0.0001) {
    const d = Math.sqrt(d2);
    const push = radius - d + 0.5;
    p.x += (dx / d) * push;
    p.y += (dy / d) * push;
  } else {
    const left   = p.x - ax;
    const right  = bx - p.x;
    const top    = p.y - ay;
    const bottom = by - p.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left)        p.x = ax - radius - 0.5;
    else if (m === right)  p.x = bx + radius + 0.5;
    else if (m === top)    p.y = ay - radius - 0.5;
    else                   p.y = by + radius + 0.5;
  }
}

// Test whether a bullet is inside a structure (used for bullet-vs-structure
// hit checks). Treat all structures as solid rectangles for projectile
// purposes regardless of their `blocks` flag — a bullet should still hit a
// turret even though players can walk past it (would be weird if rifle
// rounds passed through a 50px metal box).
function _bulletInStructure(b, structures) {
  for (const s of structures.values()) {
    if (s.hp <= 0) continue;
    const def = _BUILD_DEFS[s.kind]; if (!def) continue;
    const half = def.size / 2;
    if (b.x >= s.x - half && b.x <= s.x + half &&
        b.y >= s.y - half && b.y <= s.y + half) return s;
  }
  return null;
}

export default class AshGridRoom {
  constructor(party) {
    this.party = party;
    this.players = new Map();          // peerId → player state
    this.bullets = [];                 // [{id, x, y, vx, vy, life, damage, shooterId, weapon}]
    this.nextBulletId = 1;
    this.tickCount = 0;
    this.lastSnapshotTick = -SNAPSHOT_EVERY;
    this._tickHandle = null;
    // Phase 43: player-built structures, keyed by client-generated sid.
    // Server is authoritative for HP + collision; client behaviours (turret
    // firing, generator power, etc.) still run client-side. New joiners get
    // the full structure list in their welcome message so they see
    // everything that's already on the field.
    this.structures = new Map();       // sid → {sid, kind, x, y, hp, maxHp, owner}
    // Server-side NN bots. The room spawns NN_BOTS_INITIAL bots lazily on
    // the first input from any player; they tick on every server frame
    // and ship in every snapshot. PPO inference runs via the pure-JS
    // forward pass in server/party/sim/nn_runtime.js.
    this.bots = new Map();             // botId → {id, team, x, y, angle, hp, alive, _patrolUntilTick}
    this.nextBotId = 10001;            // offset so bot ids don't collide with peer ids
    this.simBotsEnabled = false;       // flipped true on first input arrival
  }

  // Phase 3 — spawn the initial server-side bot squad. Random positions
  // inside the arena, alternating teams. Idempotent (no-op if already
  // populated).
  _ensureServerBots() {
    if (this.bots.size > 0) return;
    const N = NN_BOTS_INITIAL;
    for (let i = 0; i < N; i++) {
      const team = i % 2;              // alternate teams
      const angle = Math.random() * Math.PI * 2;
      const x = ARENA_PAD + 80 + Math.random() * (ARENA_W - 2 * ARENA_PAD - 160);
      const y = ARENA_PAD + 80 + Math.random() * (ARENA_H - 2 * ARENA_PAD - 160);
      const id = this.nextBotId++;
      this.bots.set(id, {
        id,
        team,
        x, y,
        angle,
        hp: HP_MAX,
        maxHp: HP_MAX,
        alive: true,
        // Phase 3c — NN inference state (mirrors what nn_obs reads):
        //   _fireCd:     ticks left on weapon cooldown (set on fire)
        //   _recentDmg:  ticks since last bullet hit (used in obs)
        _fireCd: 0,
        _recentDmg: 0,
        // (patrol fields kept for back-compat but unused in 3c+)
        _patrolDir: angle,
        _patrolUntilTick: 0,
      });
    }
    console.log(`[phase3] spawned ${N} server-side bots`);
  }

  // Phase 3c — bot tick using real ONNX-equivalent inference. For each
  // alive bot, build a 65-dim observation, run it through the pure-JS
  // PPO policy, decode the 18-class action into (moveDir, fire), and
  // apply it. No more random walk — bots actually engage targets they
  // see + retreat from low HP per the trained policy.
  _tickBots() {
    if (!this.simBotsEnabled) return;
    // Phase 3f — respawn lifecycle. A dead bot's _respawnAt is set
    // when its hp hits 0 in the bullet-vs-bot collision path. After
    // BOT_RESPAWN_TICKS pass, we re-roll position + reset hp. This
    // keeps the arena populated without needing the legacy mission-
    // factory wave system (that one ports to server in a later phase).
    for (const b of this.bots.values()) {
      if (b.alive) continue;
      if (b._respawnAt == null || this.tickCount < b._respawnAt) continue;
      b.x = ARENA_PAD + 80 + Math.random() * (ARENA_W - 2 * ARENA_PAD - 160);
      b.y = ARENA_PAD + 80 + Math.random() * (ARENA_H - 2 * ARENA_PAD - 160);
      b.angle = Math.random() * Math.PI * 2;
      b.hp = HP_MAX;
      b.alive = true;
      b._respawnAt = null;
      b._fireCd = 0;
      b._recentDmg = 0;
    }

    // Build the two team rosters once per tick. Players are all team 0
    // for now (no factions on the human side yet); team-0 bots count
    // as friendlies for the player + each other, team-1 bots are reds.
    const team0 = [];
    const team1 = [];
    for (const b of this.bots.values()) {
      if (!b.alive) continue;
      if (b.team === 0) team0.push(b); else team1.push(b);
    }
    for (const p of this.players.values()) {
      if (p.alive) team0.push(p);
    }

    for (const b of this.bots.values()) {
      if (!b.alive) continue;
      const friendlies = (b.team === 0) ? team0 : team1;
      const enemies    = (b.team === 0) ? team1 : team0;
      const flipX = (b.team === 1);   // team-1 mirrored to match training

      // Phase 3-followup — AIM before OBS. Original code set angle to
      // movement direction; the NN cone-of-vision (140° in obs) then
      // missed enemies behind the walking direction, so is_visible
      // was 0 every tick and the policy never picked fire=1.
      //
      // Mirror the client behaviour: lerp the bot's "head" toward the
      // nearest enemy each tick (~18% per tick = full alignment over
      // ~0.5 s). NN obs now sees the enemy in cone, picks fire when
      // the policy says to. Bullet aim direction is set precisely on
      // the fire path below (lead-aim).
      //
      // Wall-aware: only pick targets the bot has line-of-sight to.
      // Without this, bots keep aiming at + spawning bullets toward an
      // enemy who walked behind a building (user '敵人還是穿牆攻擊').
      // The bullets got eaten by _bulletInWall one tick later but the
      // visual silhouette of the bot would still pivot toward the
      // hidden enemy + the OBS cone-of-vision was reading them as
      // visible. Now we skip blocked targets entirely.
      let nearestE = null, nearestD2 = Infinity;
      for (const e of enemies) {
        if (!e.alive) continue;
        const ddx = e.x - b.x, ddy = e.y - b.y;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 >= nearestD2) continue;
        if (!_hasLineOfSight(b.x, b.y, e.x, e.y)) continue;
        nearestD2 = d2; nearestE = e;
      }
      const NN_AIM_RANGE2 = 1100 * 1100;     // detect a little past view range
      if (nearestE && nearestD2 < NN_AIM_RANGE2) {
        const desired = Math.atan2(nearestE.y - b.y, nearestE.x - b.x);
        let dAng = desired - b.angle;
        while (dAng > Math.PI)  dAng -= Math.PI * 2;
        while (dAng < -Math.PI) dAng += Math.PI * 2;
        b.angle += dAng * (0.22 / TICK_FACTOR);   // Phase 4: 0.11 @ 60Hz so the time
                                                  // constant of the aim-lerp stays the
                                                  // same in seconds (~0.5 s to converge)
      }

      buildObs(b, friendlies, enemies, _NN_OBS_BUF, flipX);
      const action = _NN_NET.argmax(_NN_OBS_BUF);
      let moveDir = action >> 1;       // 0..8
      const fire  = action & 1;        // 0|1
      if (flipX) moveDir = _NN_MIRROR_MOVE[moveDir];

      const [dx, dy] = _NN_MOVE_DIRS[moveDir] || [0, 0];
      if (dx !== 0 || dy !== 0) {
        // Normalize diagonal (1,1) → magnitude 1
        const mag = Math.hypot(dx, dy);
        const nx = b.x + (dx / mag) * BOT_SPEED_PER_TICK;
        const ny = b.y + (dy / mag) * BOT_SPEED_PER_TICK;
        // Phase 4b — clamp to arena + push out of buildings. User
        // '直接看到穿牆的': server-side bots used to phase straight
        // through walls because we only clamped to ARENA bounds, never
        // checked _MAP_BUILDINGS. Now they bounce identically to how
        // the client renders walls. Same _pushOutOfWalls helper used
        // by players; bot radius is the same 14 px.
        b.x = clamp(nx, ARENA_PAD, ARENA_W - ARENA_PAD);
        b.y = clamp(ny, ARENA_PAD, ARENA_H - ARENA_PAD);
        _pushOutOfWalls(b, PLAYER_RADIUS);
        // NOTE: angle stays pointed at enemy (set above), NOT at the
        // move direction. The bot is now a strafing shooter — moves
        // diagonally while head tracks the target. Looks much more
        // alive than the old "always facing the way you walk" model.
      }
      // (no extra idle-aim block — angle was already updated above)

      // Decrement bot's fire cooldown (used as the gate below + obs feature).
      if (b._fireCd > 0) b._fireCd--;
      if (b._recentDmg > 0) b._recentDmg--;

      // Fire — bot spawns a server bullet at its muzzle, weapon-aware
      // via the shared bullet sim. Default RIFLE for all bots in Phase
      // 3c; weapon variety will come from the recruit / chassis path.
      //
      // We use the precise target angle (atan2 to the nearest enemy
      // we picked above) instead of b.angle, so even mid-strafe the
      // shot lands where intended. b.angle gets snapped to the same
      // value here so the bullet visual matches the muzzle.
      if (fire && b._fireCd <= 0 && nearestE) {
        const aim = Math.atan2(nearestE.y - b.y, nearestE.x - b.x);
        b.angle = aim;
        const wsim = getWeaponSim('RIFLE');
        const newBullets = spawnBulletsFromUnit(
          { x: b.x, y: b.y, id: b.id, team: b.team },
          { ...wsim, weaponId: 'RIFLE' },
          aim,
        );
        for (const bb of newBullets) {
          bb.id = this.nextBulletId++;
          bb.shooterId = b.id;
          bb.shooterIsBot = true;
          bb.weapon = 'RIFLE';
          bb.fromTeam = b.team;
          this.bullets.push(bb);
        }
        b._fireCd = wsim.fireCdTicks | 0;
      }
    }
  }

  // Lazy-start the tick. We don't burn CPU when nobody's connected.
  _ensureTicking() {
    if (this._tickHandle) return;
    this._tickHandle = setInterval(() => this.tick(), TICK_MS);
  }
  _maybeStopTicking() {
    if (this.players.size > 0) return;
    if (!this._tickHandle) return;
    clearInterval(this._tickHandle);
    this._tickHandle = null;
    this.bullets.length = 0;            // wipe stale bullets between sessions
    this.tickCount = 0;
    this.lastSnapshotTick = -SNAPSHOT_EVERY;
  }

  onConnect(conn) {
    const spawn = this._pickSpawn();
    const p = {
      id: conn.id,
      x: spawn.x, y: spawn.y, angle: 0,
      hp: HP_MAX,
      alive: true,
      fireCdUntil: 0,
      invulnUntil: this.tickCount + INVULN_TICKS,
      respawnAt: 0,
      name: 'PLAYER',
      // Phase 60: client-driven buff flag — set from every input message
      // by reading the player's localStorage `ag.respawnBuffUntil`. Used
      // when the player dies to decide how long until respawn.
      respawnBuffActive: false,
      // input applied next tick. vT = view tick (latest snapshot tick the
      // client has rendered). Used by lag-comp to rewind targets.
      input: { dx: 0, dy: 0, angle: 0, fire: false, seq: 0, vT: 0 },
      lastInputSeq: 0,
      // Echoed back in snapshot so client can compute RTT.
      lastInputT: 0,
      // Phase 40: rolling position history for lag compensation.
      // Push current pos at the START of every tick so [0] is always
      // the freshest. Cap at HISTORY_TICKS entries.
      history: [],
    };
    this.players.set(conn.id, p);
    this._ensureTicking();
    // Phase 2 net-audit — reset _lastNameSentTick for ALL existing players
    // so the next broadcast snapshot includes every name. The new joiner
    // sees identifiable peers on tick 1 instead of waiting up to 30 ticks
    // (1 s) for the next periodic name refresh.
    for (const other of this.players.values()) {
      other._lastNameSentTick = 0;
    }

    conn.send(JSON.stringify({
      type: 'welcome',
      id: conn.id,
      tick: this.tickCount,
      arena: { w: ARENA_W, h: ARENA_H },
      // Phase 43: rehydrate the new client with every structure currently
      // on the field. Without this, late joiners can walk through walls
      // others built before they connected.
      structures: [...this.structures.values()],
    }));
    // Snapshot will reach the new client on the next broadcast cycle.
    this.party.broadcast(JSON.stringify({ type: 'join', id: conn.id }), [conn.id]);
  }

  onMessage(message, sender) {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    if (!data || typeof data !== 'object') return;
    const p = this.players.get(sender.id);
    if (!p) return;

    if (data.type === 'input') {
      // Stash the latest input. We apply it on the next tick.
      p.input.dx    = clamp(num(data.dx), -1, 1);
      p.input.dy    = clamp(num(data.dy), -1, 1);
      p.input.angle = num(data.angle);
      p.input.fire  = !!data.fire;
      p.input.seq   = num(data.seq) | 0;
      // Server-side NN bots — spawned lazily on the FIRST input from any
      // player in the room. Bots persist until the room empties (matches
      // single-room shared-arena semantics).
      if (!this.simBotsEnabled) {
        this.simBotsEnabled = true;
        this._ensureServerBots();
      }
      // Phase 40: client tells us which snapshot tick it was rendering when
      // it pressed fire. We use this to rewind targets to that tick for the
      // lag-comp hit check. Default to current tick if absent (no rewind).
      p.input.vT    = num(data.vT) | 0;
      if (p.input.seq > p.lastInputSeq) p.lastInputSeq = p.input.seq;
      // Stamp the freshest client timestamp; echoed back in snapshot for RTT.
      if (typeof data.t === 'number' && data.t > p.lastInputT) p.lastInputT = data.t;
      if (data.name) p.name = String(data.name).slice(0, 12);
      // Phase 60: latest buff state from client. Cheap to overwrite every
      // input — server only reads this on death (~once per 5–15s per player)
      // so cost is the boolean parse, not the dispatch.
      if (typeof data.buffActive === 'boolean') p.respawnBuffActive = data.buffActive;
      return;
    }
    if (data.type === 'emote' || data.type === 'ping') {
      // Transient peer-to-peer — server just relays.
      data.from = sender.id;
      this.party.broadcast(JSON.stringify(data), [sender.id]);
      return;
    }
    // Phase 43: build request. Client sends a sid it generated locally so
    // both sides agree on identity from frame zero (the client's optimistic
    // local copy and the server's authoritative entry share an id).
    if (data.type === 'build') {
      const kind = String(data.kind || '');
      const def = _BUILD_DEFS[kind];
      if (!def) return;                 // unknown kind — silently drop
      const x = num(data.x), y = num(data.y);
      if (x < 0 || x > ARENA_W || y < 0 || y > ARENA_H) return;
      const sid = num(data.sid) | 0;
      if (!sid || this.structures.has(sid)) return;  // duplicate or missing sid
      // Reject placement INSIDE a static map building — would lock players in.
      for (const b of _MAP_BUILDINGS) {
        if (x >= b.x - 4 && x <= b.x + b.w + 4 &&
            y >= b.y - 4 && y <= b.y + b.h + 4) return;
      }
      const s = {
        sid, kind, x, y,
        hp: def.hp, maxHp: def.hp,
        owner: sender.id,
      };
      this.structures.set(sid, s);
      // Echo to ALL — including the originator. Their client treats the
      // duplicate as a no-op (already in local list), but the round-trip
      // confirms server accepted the build, and other clients see it for
      // the first time.
      this.party.broadcast(JSON.stringify({ type: 'structureAdd', s }));
      return;
    }
    // Phase 43: explosion request from a client. Used for grenades / FPV /
    // airstrikes — server validates and applies AOE damage to structures
    // (and broadcasts hit/gone events). Bullets damage structures via the
    // tick path; this exists for the explicit AOE weapons whose lifecycle
    // lives on the client.
    if (data.type === 'explosionRequest') {
      const x = num(data.x), y = num(data.y);
      const r = clamp(num(data.r), 10, 400);
      const dmg = clamp(num(data.dmg), 1, 500);
      this._applyExplosionToStructures(x, y, r, dmg);
      return;
    }
    // Unknown types ignored (forward-compat).
  }

  // Server-authoritative AOE damage to structures. Falloff is linear from
  // 100% at centre to ~20% at edge so a grenade right next to a wall does
  // far more than one that grazes it. Removes the structure outright if HP
  // drops to 0 — broadcasts 'structureGone' (clients spawn an impact spark
  // at the demolished position).
  _applyExplosionToStructures(x, y, radius, dmg) {
    for (const s of [...this.structures.values()]) {
      if (s.hp <= 0) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d > radius) continue;
      const fall = Math.max(0.2, 1 - d / radius);
      const applied = Math.max(1, Math.round(dmg * fall));
      s.hp -= applied;
      if (s.hp <= 0) {
        this.structures.delete(s.sid);
        this.party.broadcast(JSON.stringify({
          type: 'structureGone', sid: s.sid, x: s.x, y: s.y,
        }));
      } else {
        this.party.broadcast(JSON.stringify({
          type: 'structureHit', sid: s.sid, hp: s.hp, x: s.x, y: s.y,
        }));
      }
    }
  }

  onClose(conn) {
    this.players.delete(conn.id);
    this.party.broadcast(JSON.stringify({ type: 'leave', id: conn.id }));
    this._maybeStopTicking();
  }

  // ─── Tick ──────────────────────────────────────────────────────────
  tick() {
    // Phase 1 net-audit — time the tick body. Average over the last 30
    // samples (≈ 1 s) is attached to every snapshot as `_dbg.tickMs` so
    // a client overlay can show server CPU pressure. Cheap: 2 Date.now()
    // calls + 1 unshift per tick.
    const _tickStart = Date.now();
    this.tickCount++;

    // 1. Apply inputs + advance players
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.tickCount >= p.respawnAt) this._respawn(p);
        continue;
      }
      const inp = p.input;
      // Movement: shared simStepPerTick (wings.io-style), honours sprint
      // + weapon/chassis multipliers carried per-input (wMul, cMul). Server
      // and client agree byte-for-byte; missing fields default to 1.0 so
      // older clients still get sane motion.
      const out = simStepPerTickV2(
        {
          x: p.x, y: p.y,
          weaponSpeedMul:  (typeof inp.wMul === 'number') ? inp.wMul : 1.0,
          chassisSpeedMul: (typeof inp.cMul === 'number') ? inp.cMul : 1.0,
        },
        inp
      );
      const nx = out.x, ny = out.y;
      // Server-authoritative collision: clamp to arena + push out of walls
      // and player-built structures. _MAP_BUILDINGS / _MAP_OBSTACLES come
      // from _buildIndustrialMap() which matches the client's industrial
      // map anchors exactly. Without these, players slipped through walls
      // server-side (user '穿牆') and bullets stopped on walls one-sided.
      p.x = clamp(nx, ARENA_PAD, ARENA_W - ARENA_PAD);
      p.y = clamp(ny, ARENA_PAD, ARENA_H - ARENA_PAD);
      _pushOutOfWalls(p, PLAYER_RADIUS);
      for (const s of this.structures.values()) {
        _pushOutOfStructure(p, PLAYER_RADIUS, s);
      }
      p.angle = inp.angle;
      // Phase 40: record this tick's position into the per-player history
      // BEFORE the lag-comp check below (so the shooter's own position is
      // stamped, but more importantly so other players' history is fresh
      // when the next shooter looks up their position). Cap at HISTORY_TICKS.
      p.history.push({ tick: this.tickCount, x: p.x, y: p.y });
      if (p.history.length > HISTORY_TICKS) p.history.shift();
      // Fire (if cooldown done)
      if (inp.fire && this.tickCount >= p.fireCdUntil) {
        this._spawnBullet(p);
        // Weapon-specific fire cooldown — SNIPER (25 ticks) shouldn't fire
        // as fast as SMG (2 ticks). Defaults to RIFLE when wId missing.
        const wsim = getWeaponSim(inp.wId || 'RIFLE');
        let cd = wsim.fireCdTicks | 0;
        if (cd < 1) cd = 1;
        p.fireCdUntil = this.tickCount + cd;
        // Phase 40: lag compensation. If the shooter's view tick says they
        // were aiming at where a target USED to be, register an instant hit.
        // Falls back to the normal physics-based hit check if no lag-comp
        // hit is found (target wasn't on the bullet's projected path).
        this._lagCompHitCheck(p, inp.vT);
      }
    }

    // 2. Advance bullets + hit detection
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx; b.y += b.vy; b.life--;
      if (b.life <= 0 ||
          b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H) {
        this.bullets.splice(i, 1);
        continue;
      }
      // Phase 41: bullet vs wall. Check before player collision so a bullet
      // that crosses both a wall AND a player (rare with 14px/tick steps but
      // possible at glancing angles) gets consumed by the wall — matches the
      // single-player wallLines + buildings hit-check ordering, where the
      // wall claims the bullet first.
      const obs = _bulletInWall(b);
      if (obs) {
        // Spark at the bullet's current position. Sent as a single event
        // (not part of the snapshot) so the visual fires immediately on the
        // client; snapshot rate is too slow for a sub-frame impact effect.
        this.party.broadcast(JSON.stringify({
          type: 'wallHit', x: round1(b.x), y: round1(b.y), kind: obs.kind,
        }));
        this.bullets.splice(i, 1);
        continue;
      }
      // Phase 43: bullet vs built structure. Damage the structure, broadcast
      // hit (or removal if HP drops to 0). Same single-bullet-stops-on-first
      // behaviour as walls. Static map walls are indestructible (just stop
      // bullets); built structures take damage and can be removed.
      const struct = _bulletInStructure(b, this.structures);
      if (struct) {
        // Phase 2 — structure damage uses the bullet's own damage value
        // (weapon-aware after Phase 2 spawn), with a multiplier when
        // the weapon profile flags one (ROCKET deals 4× to structures).
        // Pre-Phase-2 all bullets dealt flat 25 to walls regardless of
        // weapon; RPG couldn't 2-shot a 220-hp wall.
        let structDmg = (typeof b.damage === 'number') ? b.damage : BULLET_DAMAGE;
        if (b.weapon) {
          const wsim = getWeaponSim(b.weapon);
          if (wsim.structDmgMul) structDmg *= wsim.structDmgMul;
        }
        struct.hp -= structDmg;
        if (struct.hp <= 0) {
          this.structures.delete(struct.sid);
          this.party.broadcast(JSON.stringify({
            type: 'structureGone', sid: struct.sid, x: struct.x, y: struct.y,
          }));
        } else {
          this.party.broadcast(JSON.stringify({
            type: 'structureHit', sid: struct.sid, hp: struct.hp,
            x: round1(b.x), y: round1(b.y),
          }));
        }
        this.bullets.splice(i, 1);
        continue;
      }
      // Players are circles of PLAYER_RADIUS. Phase 51: use SWEPT
      // collision (segment from previous-tick position to current
      // position vs. circle) instead of point-in-circle. Bullet step
      // is BULLET_SPEED=14 and player radius is also 14 — point-in-
      // circle let glancing shots tunnel past players in a single tick
      // (the previous sample sits >14 away, the current sample also
      // sits >14 away, but the segment between them grazes through the
      // player). User: '子彈直接穿過敵人 也沒有有效的傷害'.
      let consumed = false;
      const prevX = b.x - b.vx, prevY = b.y - b.vy;
      const sx = b.x - prevX, sy = b.y - prevY;        // segment vector
      const segLen2 = sx * sx + sy * sy;                // |seg|²
      const r2 = PLAYER_RADIUS * PLAYER_RADIUS;
      for (const p of this.players.values()) {
        if (!p.alive || p.id === b.shooterId) continue;
        if (this.tickCount < p.invulnUntil) continue;
        // Project player position onto the bullet segment, clamp to [0,1].
        let t = 0;
        if (segLen2 > 0) {
          t = ((p.x - prevX) * sx + (p.y - prevY) * sy) / segLen2;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
        }
        const cx = prevX + sx * t, cy = prevY + sy * t;
        const dx = p.x - cx, dy = p.y - cy;
        if (dx * dx + dy * dy < r2) {
          p.hp -= b.damage;
          consumed = true;
          // Phase 2 — rocket AOE on direct hit. The wsim profile sets
          // isRocket + blastR + blastDmg; every player within blastR of
          // the impact (excluding the just-hit primary victim, who
          // already took b.damage) takes blastDmg. Mirrors the legacy
          // client-side detonateRocket() radial scan but runs on server
          // so MP rockets actually deal AOE — pre-Phase-2 server treated
          // them as flat 25-damage rifle rounds.
          if (b.isRocket && b.weapon) {
            const wsim = getWeaponSim(b.weapon);
            const blastR = wsim.blastR || 0;
            const blastDmg = wsim.blastDmg || 0;
            if (blastR > 0 && blastDmg > 0) {
              const blastR2 = blastR * blastR;
              for (const q of this.players.values()) {
                if (q === p) continue;
                if (!q.alive) continue;
                if (this.tickCount < q.invulnUntil) continue;
                const qdx = q.x - b.x, qdy = q.y - b.y;
                if (qdx * qdx + qdy * qdy <= blastR2) {
                  q.hp -= blastDmg;
                  this.party.broadcast(JSON.stringify({
                    type: 'hit', victim: q.id, shooter: b.shooterId,
                    hp: Math.max(0, q.hp), weapon: b.weapon,
                    x: round1(b.x), y: round1(b.y),
                  }));
                  if (q.hp <= 0) {
                    q.alive = false;
                    q.respawnAt = this.tickCount + (q.respawnBuffActive
                      ? RESPAWN_TICKS_BUFFED
                      : RESPAWN_TICKS_DEFAULT);
                    this.party.broadcast(JSON.stringify({
                      type: 'kill', shooter: b.shooterId, victim: q.id, weapon: b.weapon,
                      x: round1(b.x), y: round1(b.y),
                    }));
                  }
                }
              }
            }
          }
          this.party.broadcast(JSON.stringify({
            type: 'hit', victim: p.id, shooter: b.shooterId,
            hp: Math.max(0, p.hp), weapon: b.weapon,
            // Include impact coords so client can spawn blood / damage popup
            // at the right spot without guessing from the player's lerped pos.
            x: round1(b.x), y: round1(b.y),
          }));
          if (p.hp <= 0) {
            p.alive = false;
            p.respawnAt = this.tickCount + (p.respawnBuffActive
              ? RESPAWN_TICKS_BUFFED
              : RESPAWN_TICKS_DEFAULT);
            this.party.broadcast(JSON.stringify({
              type: 'kill', shooter: b.shooterId, victim: p.id, weapon: b.weapon,
              x: round1(p.x), y: round1(p.y),
            }));
          }
          break;
        }
      }
      // Phase 3d — bullet vs server-side bots. Same swept-segment logic
      // as player collision. Friendly-fire avoided by skipping bots on
      // the shooter's team (bot-vs-bot would still trigger for opposite
      // teams; bullets from team-0 humans hit team-1 bots, etc.).
      if (!consumed) {
        const botR2 = 14 * 14;          // bot body radius same as player
        for (const bot of this.bots.values()) {
          if (!bot.alive) continue;
          if (bot.id === b.shooterId) continue;
          // Friendly-fire skip: bot bullets carry fromTeam; player
          // bullets do not (player team = 0 implicitly).
          const shooterTeam = (b.fromTeam != null) ? b.fromTeam : 0;
          if (shooterTeam === bot.team) continue;
          let t = 0;
          if (segLen2 > 0) {
            t = ((bot.x - prevX) * sx + (bot.y - prevY) * sy) / segLen2;
            if (t < 0) t = 0; else if (t > 1) t = 1;
          }
          const cx = prevX + sx * t, cy = prevY + sy * t;
          const dx = bot.x - cx, dy = bot.y - cy;
          if (dx * dx + dy * dy < botR2) {
            bot.hp -= b.damage;
            bot._recentDmg = 90 * TICK_FACTOR;       // 1.5s 'under fire' for the obs feature
            consumed = true;
            this.party.broadcast(JSON.stringify({
              type: 'hit', victim: bot.id, shooter: b.shooterId,
              hp: Math.max(0, bot.hp), weapon: b.weapon || 'RIFLE',
              x: round1(b.x), y: round1(b.y),
              isBot: 1,                // marker so client kill-feed can label
            }));
            if (bot.hp <= 0) {
              bot.alive = false;
              bot._respawnAt = this.tickCount + BOT_RESPAWN_TICKS;
              this.party.broadcast(JSON.stringify({
                type: 'kill', shooter: b.shooterId, victim: bot.id,
                weapon: b.weapon || 'RIFLE',
                x: round1(bot.x), y: round1(bot.y),
                isBot: 1,
              }));
            }
            break;
          }
        }
      }
      if (consumed) this.bullets.splice(i, 1);
    }

    // Phase 3c — bots step using real PPO inference.
    this._tickBots();

    // 3. Snapshot every SNAPSHOT_EVERY ticks (≈ 15Hz)
    if (this.tickCount - this.lastSnapshotTick >= SNAPSHOT_EVERY) {
      this.lastSnapshotTick = this.tickCount;
      this._broadcastSnapshot();
    }

    // Phase 1 net-audit — record tick duration. Window of 30 samples
    // (≈ 1 s) is averaged at snapshot time, attached as `_dbg.tickMs`.
    const _tickMs = Date.now() - _tickStart;
    if (!this._tickTimeWindow) this._tickTimeWindow = [];
    this._tickTimeWindow.push(_tickMs);
    if (this._tickTimeWindow.length > 30) this._tickTimeWindow.shift();
  }

  _spawnBullet(p) {
    // Weapon-aware bullets via the shared sim. Snipers one-shot, shotguns
    // spread, LMG rapid-fires. Weapon id arrives via input.wId; missing
    // value defaults to RIFLE for safety.
    const wid = (p.input && typeof p.input.wId === 'string') ? p.input.wId : 'RIFLE';
    const wsim = getWeaponSim(wid);
    const newBullets = spawnBulletsFromUnit(
      { x: p.x, y: p.y, id: p.id, team: 0 },
      { ...wsim, weaponId: wid },
      p.angle,
    );
    for (const b of newBullets) {
      b.id = this.nextBulletId++;
      b.shooterId = p.id;
      b.weapon = wid;
      this.bullets.push(b);
    }
  }

  // Phase 40: look up a player's position at a specific tick from history.
  // Returns the closest sample to `tick` (or null if history is empty).
  // We DON'T interpolate between samples here — the ticks we care about
  // are integer-aligned with our snapshot cadence, and the history is
  // dense enough that the closest sample is within 1 tick (33ms). Linear
  // search backward is O(HISTORY_TICKS) = O(30); fine in the hot path.
  _historicalPos(player, tick) {
    const h = player.history;
    if (h.length === 0) return null;
    // Walk backwards from newest to find the sample with tick ≤ requested.
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i].tick <= tick) return h[i];
    }
    // Requested tick is older than our oldest sample — return the oldest.
    return h[0];
  }

  // Phase 40 — lag-compensated hit check at fire time.
  //
  // Model: "favor the shooter." The shooter pressed fire while looking at a
  // snapshot from tick `viewTick`. Their client was rendering remote players
  // at tick `viewTick - LAG_INTERP_OFFSET` (the snapshot interpolation buffer
  // delays everyone by ~100ms for smooth motion). So when checking whether
  // their bullet was aimed at a real target, we rewind every other player
  // to that historic tick.
  //
  // We then walk the bullet forward from its spawn point for `lagTicks`
  // steps. At each step, if the bullet's position is inside any rewound
  // target's circle, we register an instant hit. The bullet is removed
  // (so the normal physics-based hit check downstream doesn't double-count)
  // and a 'hit' / 'kill' event broadcasts immediately.
  //
  // No-op when:
  //   • viewTick is 0 or absent (legacy client, no rewind requested)
  //   • lagTicks <= 0 (shooter is fully caught up, no need)
  //   • lagTicks > LAG_COMP_MAX (shooter is too laggy to favor honestly)
  //   • no targets are within the swept bullet path at their historic pos
  _lagCompHitCheck(shooter, viewTick) {
    if (!viewTick) return;
    const lagTicks = Math.min(
      LAG_COMP_MAX,
      Math.max(0, this.tickCount - viewTick + LAG_INTERP_OFFSET)
    );
    if (lagTicks <= 0) return;

    const targetTick = this.tickCount - lagTicks;
    const ax = Math.cos(shooter.angle);
    const ay = Math.sin(shooter.angle);
    const bx0 = shooter.x + ax * BULLET_OFFSET;
    const by0 = shooter.y + ay * BULLET_OFFSET;
    const r2  = PLAYER_RADIUS * PLAYER_RADIUS;

    let bestVictim = null;
    let bestStep   = Infinity;

    for (const target of this.players.values()) {
      if (target.id === shooter.id) continue;
      if (!target.alive) continue;
      if (this.tickCount < target.invulnUntil) continue;

      const hist = this._historicalPos(target, targetTick);
      if (!hist) continue;

      // Sweep the bullet forward `lagTicks` steps and see if any of those
      // SEGMENTS (not just sample points) intersects the historic target
      // circle. Phase 51: discrete sampling let glancing shots tunnel
      // past — the bullet jumps 14px per step and PLAYER_RADIUS is also
      // 14, so a path skimming the circle could land >14px away on both
      // ends of a step but cross the circle in between. Switch to the
      // standard "closest point on segment to point" test, same as the
      // per-tick collision check below.
      let stepHit = -1;
      for (let step = 0; step < lagTicks; step++) {
        const ax0 = bx0 + ax * BULLET_SPEED * step;
        const ay0 = by0 + ay * BULLET_SPEED * step;
        const sxv = ax * BULLET_SPEED, syv = ay * BULLET_SPEED;
        const segLen2 = sxv * sxv + syv * syv;
        let t = 0;
        if (segLen2 > 0) {
          t = ((hist.x - ax0) * sxv + (hist.y - ay0) * syv) / segLen2;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
        }
        const cx = ax0 + sxv * t, cy = ay0 + syv * t;
        const dx = hist.x - cx, dy = hist.y - cy;
        if (dx * dx + dy * dy < r2) { stepHit = step; break; }
      }
      if (stepHit >= 0 && stepHit < bestStep) {
        bestStep   = stepHit;
        bestVictim = target;
      }
    }

    if (!bestVictim) return;

    // Resolve the hit. Apply damage, broadcast events, remove the bullet
    // we just spawned (it's the last entry in this.bullets) so the
    // physics-based hit check downstream doesn't re-trigger.
    //
    // Phase 2 — damage + weapon now come from the just-spawned bullet
    // (which carries the weapon-aware profile from spawnBulletsFromUnit)
    // instead of the legacy flat BULLET_DAMAGE + 'RIFLE'. Pre-Phase-2,
    // SNIPER's 100-damage one-shot rule didn't apply on lag-comp hits —
    // server stamped 25 damage regardless and the kill resolved as
    // RIFLE in the kill feed. User '我打中他他沒死' for sniper kills.
    const lastBullet = this.bullets[this.bullets.length - 1];
    const lcDmg    = (lastBullet && typeof lastBullet.damage === 'number') ? lastBullet.damage : BULLET_DAMAGE;
    const lcWeapon = (lastBullet && lastBullet.weapon) ? lastBullet.weapon : 'RIFLE';
    bestVictim.hp -= lcDmg;
    if (this.bullets.length > 0) this.bullets.pop();
    // Phase 41: include impact coords for client-side blood/popup placement.
    // Use the historic position (where the shooter SAW them) so the spark
    // appears at the visually-correct spot.
    const histVictim = this._historicalPos(bestVictim, this.tickCount - 1);
    const impactX = histVictim ? histVictim.x : bestVictim.x;
    const impactY = histVictim ? histVictim.y : bestVictim.y;
    this.party.broadcast(JSON.stringify({
      type: 'hit', victim: bestVictim.id, shooter: shooter.id,
      hp: Math.max(0, bestVictim.hp), weapon: lcWeapon,
      x: round1(impactX), y: round1(impactY),
      lc: 1,    // marker: this hit was lag-compensated (clients can stat it)
    }));
    if (bestVictim.hp <= 0) {
      bestVictim.alive = false;
      bestVictim.respawnAt = this.tickCount + (bestVictim.respawnBuffActive
        ? RESPAWN_TICKS_BUFFED
        : RESPAWN_TICKS_DEFAULT);
      this.party.broadcast(JSON.stringify({
        type: 'kill', shooter: shooter.id, victim: bestVictim.id,
        weapon: 'RIFLE', lc: 1,
        x: round1(impactX), y: round1(impactY),
      }));
    }
  }

  _respawn(p) {
    const spawn = this._pickSpawn();
    p.x = spawn.x; p.y = spawn.y;
    p.hp = HP_MAX;
    p.alive = true;
    p.invulnUntil = this.tickCount + INVULN_TICKS;
    // Phase 40: wipe history on respawn. Otherwise a lag-comp lookup right
    // after respawn could pull a sample from "before the player died at
    // their old position," letting bullets fired before the respawn still
    // count against the new spawn. The first few ticks after respawn the
    // player is invulnerable anyway (INVULN_TICKS), so any lag-comp hit
    // would be rejected by the invuln check — but better to defend in depth.
    p.history.length = 0;
  }

  // Pick a spawn point that (1) is clear of walls/buildings and (2)
  // maximises distance from existing players. Sample up to 32 candidates.
  // Anti-spawn-camp + anti-spawn-in-wall.
  //
  // Phase 41: rejection-sample on _spawnClearOfWalls. If we can't find a
  // wall-free spot in 32 tries (basically impossible in industrial — most
  // of the arena is open street + plaza), fall back to the canonical
  // industrial spawn anchors (W and E alley centres from the variant def).
  _pickSpawn() {
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < 32; i++) {
      const cand = {
        x: 200 + Math.random() * (ARENA_W - 400),
        y: 200 + Math.random() * (ARENA_H - 400),
      };
      if (!_spawnClearOfWalls(cand.x, cand.y)) continue;
      let minD = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - cand.x, p.y - cand.y);
        if (d < minD) minD = d;
      }
      if (minD === Infinity) minD = 9999;
      if (minD > bestScore) { bestScore = minD; best = cand; }
    }
    if (best) return best;
    // Last-ditch fallback — industrial map's named spawn anchors. These are
    // hand-tuned to be wall-free, so they're guaranteed safe.
    const fallbacks = [{ x: 580, y: 900 }, { x: 1220, y: 900 }];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  _broadcastSnapshot() {
    // Phase 3.2 — per-receiver snapshot with AOI bullet culling.
    //
    // Players + bots are still broadcast to everyone (small N; players
    // need minimap dots / kill-feed names + bots are highest-value
    // entities for combat awareness). Bullets, in contrast, can spike to
    // 50+ in a busy room and are useless if they're >1200 px from the
    // receiver's player (off-screen at normal zoom). Culling per receiver
    // can cut snapshot size 40-60% in heavy combat. CPU cost: one
    // O(bullets) pass per connected client per tick — at 8 bullets × 20
    // players × 30 Hz = 4800 dist-checks/sec = sub-ms.
    //
    // Old clients receive their unchanged-shape snapshot (just fewer
    // bullet entries), so no protocol break.
    const sT = Date.now();
    const tick = this.tickCount;

    // Build the SHARED player array once (same for every receiver — the
    // Phase 2 invuln/name throttling still applies).
    const playerEntries = [];
    for (const p of this.players.values()) {
      const entry = {
        id: p.id,
        x: round1(p.x),
        y: round1(p.y),
        angle: round3(p.angle),
        hp: p.hp,
        alive: p.alive,
        lastInputSeq: p.lastInputSeq,
        t: p.lastInputT || 0,
      };
      if (this.tickCount < p.invulnUntil) entry.invuln = true;
      const nameStale = (this.tickCount - (p._lastNameSentTick || 0)) >= TICK_HZ;   // 1 s
      const nameChanged = p.name !== p._lastSentName;
      if (nameStale || nameChanged) {
        entry.name = p.name;
        p._lastNameSentTick = this.tickCount;
        p._lastSentName = p.name;
      }
      playerEntries.push(entry);
    }

    // Build full bullets list once (cheap shape transform) — culled per
    // receiver below.
    const allBullets = this.bullets.map(b => ({
      id: b.id,
      x: round1(b.x),
      y: round1(b.y),
      vx: round1(b.vx),
      vy: round1(b.vy),
      s: b.shooterId,
    }));

    // Bots: still shared. 4-12 entities, all combat-relevant. Sharing
    // saves N×bots serialization work.
    const botEntries = this.simBotsEnabled
      ? [...this.bots.values()].map(b => ({
          id: b.id,
          team: b.team,
          x: round1(b.x),
          y: round1(b.y),
          angle: round3(b.angle),
          hp: b.hp,
          alive: b.alive,
        }))
      : [];

    // Server-side debug stats. Same for every receiver. Old clients
    // ignore the unknown field.
    let dbg = null;
    if (this._tickTimeWindow && this._tickTimeWindow.length > 0) {
      let sum = 0;
      for (const v of this._tickTimeWindow) sum += v;
      dbg = {
        tickMs:  +(sum / this._tickTimeWindow.length).toFixed(2),
        tickPk:  Math.max(...this._tickTimeWindow),
        players: this.players.size,
        bullets: this.bullets.length,
        bots:    this.bots.size,
      };
    }

    // AOI radius squared (compare to dist² to skip the sqrt).
    const AOI = 1200;
    const AOI2 = AOI * AOI;

    // Iterate connections — if the runtime gives us getConnections() we
    // use it for per-receiver custom snapshots; otherwise fall back to
    // broadcast (old PartyKit / unknown runtime).
    const conns = (typeof this.party.getConnections === 'function')
      ? this.party.getConnections()
      : null;
    if (!conns) {
      // Fallback: broadcast same snapshot to everyone (no AOI cull).
      const snap = { type: 'snapshot', tick, sT, players: playerEntries, bullets: allBullets, bots: botEntries };
      if (dbg) snap._dbg = dbg;
      this.party.broadcast(JSON.stringify(snap));
      return;
    }

    for (const conn of conns) {
      const me = this.players.get(conn.id);
      let bullets;
      if (!me || !me.alive || allBullets.length === 0) {
        // Dead / pre-game / no bullets in flight — send everything.
        bullets = allBullets;
      } else {
        bullets = [];
        const mx = me.x, my = me.y;
        for (const b of allBullets) {
          const dx = b.x - mx, dy = b.y - my;
          if (dx * dx + dy * dy <= AOI2) bullets.push(b);
        }
      }
      const snap = { type: 'snapshot', tick, sT, players: playerEntries, bullets, bots: botEntries };
      if (dbg) snap._dbg = dbg;
      try { conn.send(JSON.stringify(snap)); } catch (e) {}
    }
  }
}

function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
function num(n) { return typeof n === 'number' && isFinite(n) ? n : 0; }
function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }
