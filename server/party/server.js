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
const TICK_HZ           = 200;
const TICK_FACTOR       = TICK_HZ / 30;     // 6.667 — multiplier vs the 30-Hz baseline
const TICK_MS           = 1000 / TICK_HZ;
// Snapshot every 6 ticks @ 200 Hz = 33.3 Hz broadcast — keep network
// pacing constant while simulation runs 6.67× the original 30 Hz.
const SNAPSHOT_EVERY    = 6;          // 6 ticks @ 200Hz = 33Hz broadcast
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
// R+1 — AFK respawn gate. If a dead player hasn't sent any input in this
// many ticks at the moment their respawn timer fires, hold them in the
// dead state. They'll respawn on the FIRST input after they return.
// User: '讓別人死亡的時候復活, 如果他不在頁面中的話, 那他就不該進場,
// 不會以第三方會感覺看到一個有一個無敵的人一直在朝一個地方開槍'.
// 3 s threshold = browsers throttle background tabs to ≥ 1 input/s so
// 3 s is safely past 'tab is hidden' without falsely flagging brief
// network hiccups on the focused tab.
const AFK_RESPAWN_MAX_TICKS = 3 * TICK_HZ; // 3 s
// Phase 180 — pure respawn-eligibility rule, shared by the auto AFK-gate path
// (tick loop) and the explicit requestRespawn handler, and unit-tested in
// tools/test_mp_respawn.js (no room instance needed). A dead player may respawn
// once the timer has elapsed AND we've seen recent activity (idleTicks under the
// AFK gate). The request path passes idleTicks=0 — the request itself proves the
// player is present, which is the whole point of "press SPACE → 返回房間".
export function _respawnDecision(alive, tickCount, respawnAt, idleTicks, afkMaxTicks) {
  if (alive) return false;
  if (tickCount < respawnAt) return false;
  return idleTicks < afkMaxTicks;
}
const HP_MAX            = 100;
const INVULN_TICKS      = 3 * TICK_HZ;     // 3 s spawn protection
// Phase 60: respawn time is ad-buffable (DEFAULT_SEC / BUFFED_SEC in
// js/respawn_buff.js). Both phrased in seconds × TICK_HZ so changing
// TICK_HZ doesn't drift the player-visible countdown.
const RESPAWN_TICKS_DEFAULT = 15 * TICK_HZ;  // 15 s
const RESPAWN_TICKS_BUFFED  = 5  * TICK_HZ;  // 5 s
// Arena recruit gates — authoritative server copies of the client constants in
// js/arena_recruitment.js (ARENA_SEED_GAP / ARENA_SQUAD_CAP / ARENA_HP_GATE /
// ARENA_TOUCH_BUFFER). Kept as named constants (not bare literals) so a balance
// change is one grep-able edit on each side; the 'recruit' message handler is
// the only consumer. tools/check_sim_parity.js asserts all four match client.
const ARENA_SEED_GAP     = 10;   // min recruiter-SEED differential (bots are seed 0)
const ARENA_SQUAD_CAP    = 5;    // max live recruited bots per player
const ARENA_HP_GATE      = 0.5;  // target HP must be below maxHp * gate to recruit
const ARENA_TOUCH_BUFFER = 80;   // px added to radii sum (~106px reach)
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
const HISTORY_TICKS     = TICK_HZ;           // 1 s of position history per player
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

// Phase 182 (MP port) — server-side anti-clump steering, mirroring the SOLO
// js/npc_director.js npcSteerMoveDir. The trained PPO policy never learned
// spacing and biases toward a map corner; this layers boids SEPARATION + arena
// EDGE/CORNER repulsion onto the bot's chosen 8-dir move so online bots spread
// out instead of all piling into the bottom-right ('全部都在地圖的右下角').
// Pure function of (bot, chosen moveDir, its team roster); returns an adjusted
// moveDir (0..8). When the bot is idle (moveDir 0) it only nudges if there's
// real pressure (cornered / crowded), so open-field idle-aim is preserved.
// EDGE_W 1.6 (vs the client's 1.25 base) because the server has no per-role
// edgeAvoid multiplier — a single flat value sized so a bot heading straight at
// a wall turns infield ~64px out, decisively breaking the corner pile-up.
const _STEER = { SEP_R: 78, SEP_W: 1.35, EDGE_R: 170, EDGE_W: 1.6, MOVE_W: 1.0, IDLE_GATE: 0.45 };
function _quantizeBotDir(dx, dy, fallback) {
  const m = Math.hypot(dx, dy);
  if (m < 1e-4) return fallback || 0;
  const nx = dx / m, ny = dy / m;
  let best = fallback || 1, bestDot = -Infinity;
  for (let d = 1; d <= 8; d++) {
    const v = _NN_MOVE_DIRS[d];
    // _NN_MOVE_DIRS diagonals are un-normalized ([1,1]); normalize per-dir so
    // a cardinal target doesn't tie-bias toward an adjacent diagonal.
    const vm = Math.hypot(v[0], v[1]) || 1;
    const dot = nx * (v[0] / vm) + ny * (v[1] / vm);
    if (dot > bestDot) { bestDot = dot; best = d; }
  }
  return best;
}
export function _steerBotMoveDir(b, moveDir, friendlies) {
  const base = _NN_MOVE_DIRS[moveDir] || [0, 0];
  let sx = 0, sy = 0;
  // separation — push off teammates closer than SEP_R
  const R2 = _STEER.SEP_R * _STEER.SEP_R;
  for (const m of friendlies) {
    if (m === b || !m.alive) continue;
    const ddx = b.x - m.x, ddy = b.y - m.y;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 > R2 || d2 < 1e-3) continue;
    const d = Math.sqrt(d2);
    const w = (1 - d / _STEER.SEP_R);
    sx += (ddx / d) * w; sy += (ddy / d) * w;
  }
  sx *= _STEER.SEP_W; sy *= _STEER.SEP_W;
  // edge / corner repulsion — bounds are [ARENA_PAD, ARENA_W-ARENA_PAD] etc.
  const ER = _STEER.EDGE_R, ew = _STEER.EDGE_W;
  const lx = b.x - ARENA_PAD, rx = (ARENA_W - ARENA_PAD) - b.x;
  const ty = b.y - ARENA_PAD, by = (ARENA_H - ARENA_PAD) - b.y;
  if (lx < ER) sx += (1 - lx / ER) * ew;
  if (rx < ER) sx -= (1 - rx / ER) * ew;
  if (ty < ER) sy += (1 - ty / ER) * ew;
  if (by < ER) sy -= (1 - by / ER) * ew;
  if (moveDir === 0) {
    // idle: only step if cornered / crowded enough to matter, so a bot holding
    // position in the open to aim+fire isn't forced to wander.
    if (Math.hypot(sx, sy) < _STEER.IDLE_GATE) return 0;
    return _quantizeBotDir(sx, sy, 0);
  }
  return _quantizeBotDir(base[0] * _STEER.MOVE_W + sx, base[1] * _STEER.MOVE_W + sy, moveDir);
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

      // Phase 4d — subsystem rate. NN decision-making at 30 Hz (every
      // NN_DECISION_EVERY ticks) instead of TICK_HZ. Bots cache their
      // last action and re-use it on intermediate ticks for movement /
      // fire. Aim-lerp + physics + collision still update at full
      // TICK_HZ so the bot's silhouette + bullets stay smooth.
      //
      // Why this is correct: NN was being asked for a NEW decision
      // every ~5 ms @ 200 Hz, but decisions only need to update ~33 ms
      // (humans can't see decisions changing faster). 8 bots × 32 µs ×
      // 200 Hz = 51 ms CPU/sec ⇒ 8 × 32 µs × 30 Hz = 7.7 ms CPU/sec.
      // 84% less NN CPU with zero player-visible difference.
      const NN_DECISION_EVERY = Math.max(1, Math.round(TICK_HZ / 30));
      // Stagger bots across ticks so we don't compute 8 NN forwards on
      // the same tick — spreads cost smoothly.
      const _nnDue = ((this.tickCount + (b.id | 0)) % NN_DECISION_EVERY) === 0;
      let action, moveDir, fire;
      if (_nnDue || b._lastAction == null) {
        buildObs(b, friendlies, enemies, _NN_OBS_BUF, flipX);
        action = _NN_NET.argmax(_NN_OBS_BUF);
        moveDir = action >> 1;
        fire = action & 1;
        if (flipX) moveDir = _NN_MIRROR_MOVE[moveDir];
        // Wander fallback: each bot picks its own RANDOM waypoint and
        // walks toward it. Re-pick when reached (within 60 px) or after
        // 10 s expiry (in case wedged against a wall). User reported
        // even after the first wander attempt, all bots clumped left
        // — root cause: the previous `b.id * 7 + tickCount>>7` formula
        // gave EVERY bot the same direction at any given moment because
        // tickCount>>7 dominates and modulo arithmetic on sequential ids
        // produces a tight cluster of values. Real randomness fixes it.
        if (moveDir === 0 && !nearestE) {
          const needNewWp = b._wpX == null
                         || (b._wpExpire != null && this.tickCount >= b._wpExpire)
                         || Math.hypot(b.x - b._wpX, b.y - b._wpY) < 60;
          if (needNewWp) {
            for (let tries = 0; tries < 8; tries++) {
              const wx = ARENA_PAD + 80 + Math.random() * (ARENA_W - 2 * ARENA_PAD - 160);
              const wy = ARENA_PAD + 80 + Math.random() * (ARENA_H - 2 * ARENA_PAD - 160);
              if (!_spawnClearOfWalls(wx, wy)) continue;
              b._wpX = wx; b._wpY = wy;
              break;
            }
            if (b._wpX == null) { b._wpX = ARENA_W / 2; b._wpY = ARENA_H / 2; }
            b._wpExpire = this.tickCount + 10 * TICK_HZ;     // 10 s
          }
          // 8-way move closest to the desired waypoint direction.
          const ang = Math.atan2(b._wpY - b.y, b._wpX - b.x);
          let bestDir = 1, bestDot = -Infinity;
          for (let d = 1; d <= 8; d++) {
            const [vx, vy] = _NN_MOVE_DIRS[d];
            const m = Math.hypot(vx, vy);
            const dot = (vx / m) * Math.cos(ang) + (vy / m) * Math.sin(ang);
            if (dot > bestDot) { bestDot = dot; bestDir = d; }
          }
          moveDir = bestDir;
        }
        b._lastAction = { moveDir, fire };
      } else {
        moveDir = b._lastAction.moveDir;
        fire = b._lastAction.fire;
      }

      // Phase 182 (MP port) — anti-clump steering on EVERY tick (not just NN-
      // decision ticks) so the cached moveDir can't re-pile bots into a corner
      // between decisions. Separation + edge/corner repulsion; fire bit
      // untouched (a steered bot still shoots its target).
      moveDir = _steerBotMoveDir(b, moveDir, friendlies);

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
      // R+1 — last tick we received an input. Seeded to current tick on
      // join so new players (whose respawnAt is also 0) can spawn right
      // away. Updated on every onMessage('input') in this.tickCount units.
      lastInputTickAt: this.tickCount,
      // HitTel-1 — per-player switch for verbose per-shot logging. Off
      // by default; client toggles via {type:'hitdebug', on:true} when
      // running with ?hitdebug=1 in the URL. Used to diagnose 'why didn't
      // my MG bullets register' reports.
      hitDebug: false,
      name: 'PLAYER',
      // Phase 60: client-driven buff flag — set from every input message
      // by reading the player's localStorage `ag.respawnBuffUntil`. Used
      // when the player dies to decide how long until respawn.
      respawnBuffActive: false,
      // input applied next tick. vT = view tick (latest snapshot tick the
      // client has rendered). Used by lag-comp to rewind targets.
      // Phase 129d — sprint/wMul/cMul/wId/rMul now persisted from each
      // input (previously they were ignored: per-tick read fell back to
      // 1.0 / 'RIFLE' defaults, breaking chassis speed + sprint + heavy/
      // wolf radius scaling on the server side. Wolf-chassis users felt
      // continuous drag-back because client moved at 2.48× while server
      // moved at 1.0×).
      input: { dx: 0, dy: 0, angle: 0, fire: false, seq: 0, vT: 0,
               sprint: 0, wMul: 1.0, cMul: 1.0, rMul: 1.0, wId: 'RIFLE' },
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
      // Phase 129d — per-input loadout. These were sent by the client
      // since the v2 input refactor but NEVER persisted server-side —
      // per-tick reads (simStepPerTickV2 args + fire dispatch) saw
      // `inp.wMul === undefined` and silently fell back to 1.0 / 'RIFLE'.
      // Net effect: server moved everyone at humanoid speed regardless
      // of chassis / sprint / weapon — wolf chassis felt "dragged back"
      // because client ran at 1.5× and server reconciled to 1.0×.
      if (typeof data.sprint !== 'undefined') p.input.sprint = data.sprint ? 1 : 0;
      if (typeof data.wMul === 'number')      p.input.wMul   = data.wMul;
      if (typeof data.cMul === 'number')      p.input.cMul   = data.cMul;
      if (typeof data.rMul === 'number')      p.input.rMul   = data.rMul;
      if (typeof data.wId  === 'string')      p.input.wId    = data.wId;
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
      // R+1 — server-tick stamp for AFK respawn gate. Uses our own
      // tickCount (not client wall-clock) so it's robust to clock skew.
      p.lastInputTickAt = this.tickCount;
      if (data.name) p.name = String(data.name).slice(0, 12);
      // Phase 60: latest buff state from client. Cheap to overwrite every
      // input — server only reads this on death (~once per 5–15s per player)
      // so cost is the boolean parse, not the dispatch.
      if (typeof data.buffActive === 'boolean') p.respawnBuffActive = data.buffActive;
      return;
    }
    if (data.type === 'requestRespawn') {
      // Phase 180 — server-authoritative "返回房間". The client sends this when
      // the player presses SPACE on the death screen (and as an anti-soft-lock
      // grace fallback). Mark them active (satisfies the AFK gate), then respawn
      // if the timer has elapsed. The client NEVER self-revives — it waits for
      // the next snapshot's alive=true (mp_reconcile _tryRespawnLocal). No-op
      // while alive or before the timer. Also accept the buff flag here since a
      // dead client stopped sending 'input' (so it couldn't update it).
      if (!p.alive) {
        if (typeof data.buffActive === 'boolean') p.respawnBuffActive = data.buffActive;
        // Phase 180d — re-derive the deadline from the ORIGINAL death tick + the
        // (possibly just-updated) buff, so an ad watched AFTER death actually
        // shortens the in-flight respawn instead of being ignored (respawnAt was
        // locked at kill time with the buff state as it was then).
        if (p.killedAtTick != null) {
          p.respawnAt = p.killedAtTick + (p.respawnBuffActive
            ? RESPAWN_TICKS_BUFFED : RESPAWN_TICKS_DEFAULT);
        }
        p.lastInputTickAt = this.tickCount;
        if (_respawnDecision(p.alive, this.tickCount, p.respawnAt, 0, AFK_RESPAWN_MAX_TICKS)) {
          this._respawn(p);
        }
      }
      return;
    }
    if (data.type === 'emote' || data.type === 'ping') {
      // Transient peer-to-peer — server just relays.
      data.from = sender.id;
      this.party.broadcast(JSON.stringify(data), [sender.id]);
      return;
    }
    if (data.type === 'hitdebug') {
      // HitTel-1 — per-player verbose shot logging toggle. Client opts in
      // with ?hitdebug=1 in the URL. Logs land in the PartyKit server
      // console (visible via `partykit tail`).
      const on = !!data.on;
      p.hitDebug = on;
      console.log(`[hitdebug] ${p.id} (${p.name}) ${on ? 'ON' : 'OFF'}`);
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
    // Phase 102 — pawn-swap request. Client sends after a local swap so
    // server-side player position matches. Without this the server keeps
    // simulating the player at the OLD position; reconcile would snap
    // the client back ('B會瞬移到A這邊 我切換過可能0.5秒之後 這個B載具
    // 會瞬移到A載具這邊' — user diagnosed correctly). Validation:
    //   • target must be inside arena
    //   • if targetBotId given, the bot must exist, be alive, same team
    //   • optional: consume the bot (server-side death, no respawn)
    if (data.type === 'swap') {
      const x = num(data.x), y = num(data.y);
      if (x < ARENA_PAD || x > ARENA_W - ARENA_PAD) return;
      if (y < ARENA_PAD || y > ARENA_H - ARENA_PAD) return;
      // Optional bot consumption — if the swap targets a server bot,
      // mark it dead so two entities don't stack at the same position.
      const botId = num(data.botId) | 0;
      if (botId) {
        const bot = this.bots.get(botId);
        if (!bot) return;                         // unknown bot id — reject
        if (!bot.alive) return;                   // already dead — reject
        if (bot.team !== 0) return;               // wrong team — reject
        bot.alive = false;
        bot.hp = 0;
        bot._respawnAt = this.tickCount + BOT_RESPAWN_TICKS;
      }
      // Move the player. Wipe input vector so the queued WASD from
      // pre-swap doesn't drag them off the new spot. Clear lag-comp
      // history so the next hit-check doesn't rewind into the old
      // location. Grant spawn-protection so they can't be insta-killed
      // by a peer who was already tracking the old position.
      p.x = x;
      p.y = y;
      p.input.dx = 0; p.input.dy = 0;
      p.history.length = 0;
      p.invulnUntil = this.tickCount + INVULN_TICKS;
      // Broadcast a 'swap' event so peers can render the teleport as
      // a discrete event (and skip the smoothing buffer for this player).
      this.party.broadcast(JSON.stringify({
        type: 'swap', id: sender.id, x, y, botId: botId || 0,
      }));
      return;
    }
    // Phase 159: arena recruitment (online). Mirrors the SOLO live-target
    // path in js/arena_recruitment.js (_arenaConvertEnemyToAlly): a player
    // who walks up to a wounded enemy bot and presses G converts it onto
    // their team. Server is authoritative — it re-checks every gate so a
    // spoofed/optimistic client can't force a recruit. The team flip rides
    // the existing snapshot delta (curBots sends `team` on change), and the
    // explicit recruitOk event lets every client fire the SED-convert VFX.
    //   gates (same as SOLO live path):
    //     • recruiter alive
    //     • bot exists, alive, currently enemy (team 1)
    //     • within touch reach (myR + botR + buffer ≈ 106px)
    //     • bot hp < 50% maxHp
    //     • recruiterSeed - botSeed > ARENA_SEED_GAP (10); bot seed = 0
    if (data.type === 'recruit') {
      if (!p.alive) return;
      const botId = num(data.botId) | 0;
      const bot = this.bots.get(botId);
      if (!bot || !bot.alive) return;            // unknown / dead — reject
      if (bot.team === 0) return;                // already friendly — reject
      const reach = 13 + 14 + ARENA_TOUCH_BUFFER;   // myR + botR + buffer
      const dd = Math.hypot(bot.x - p.x, bot.y - p.y);
      if (dd > reach) return;                     // out of touch range — reject
      if (bot.hp >= (bot.maxHp || HP_MAX) * ARENA_HP_GATE) return;   // not wounded enough
      const recruiterSeed = num(data.seed) || 0;
      if (recruiterSeed <= ARENA_SEED_GAP) return;   // SEED gate — bots are seed 0
      // Squad cap — parity with SOLO (arena_recruitment.js). Count this
      // player's live recruits and reject at the ceiling, so one player can't
      // permanently flip the whole shared bot pool and drain the arena for
      // everyone in the room.
      let _mySquad = 0;
      for (const b of this.bots.values()) {
        if (b.alive && b.team === 0 && b._recruitedBy === sender.id) _mySquad++;
      }
      if (_mySquad >= ARENA_SQUAD_CAP) return;
      // ── apply the SOLO conversion, server-side ──
      bot.team = 0;
      bot.hp = Math.max((bot.maxHp || HP_MAX) * 0.5, 30);
      bot._respawnAt = null;
      bot._recruitedBy = sender.id;
      if (!bot.callsign) bot.callsign = 'R-' + botId;
      this.party.broadcast(JSON.stringify({
        type: 'recruitOk', botId, newTeam: 0,
        recruiter: sender.id, callsign: bot.callsign,
      }));
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
    // Phase 5 — drop the per-receiver delta-compression state so we
    // don't leak memory on reconnect storms.
    if (this._recvState) this._recvState.delete(conn.id);
    this.party.broadcast(JSON.stringify({ type: 'leave', id: conn.id }));
    this._maybeStopTicking();
  }

  // ─── Tick ──────────────────────────────────────────────────────────
  tick() {
    // Phase 1 net-audit — time the tick body. Average over the last 30
    // samples (≈ 1 s) is attached to every snapshot as `_dbg.tickMs` so
    // a client overlay can show server CPU pressure.
    //
    // Phase 4b: switch Date.now() (1 ms resolution) → performance.now()
    // when available (µs resolution on CF Workers / Node). At 100 Hz tick
    // individual ticks complete in <1 ms — Date.now() rounded them all
    // to 0. perf.now() reveals real fractional cost.
    const _now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const _tickStart = _now;
    this.tickCount++;

    // 1. Apply inputs + advance players
    for (const p of this.players.values()) {
      if (!p.alive) {
        // R+1 — AFK gate (now via the shared _respawnDecision rule). Only auto-
        // respawn if the client has shown a recent heartbeat (input within
        // AFK_RESPAWN_MAX_TICKS); otherwise hold them dead until they return.
        // Phase 180 — the explicit requestRespawn handler is the player-driven
        // path; this stays as the auto fallback.
        const idleTicks = this.tickCount - (p.lastInputTickAt | 0);
        if (_respawnDecision(p.alive, this.tickCount, p.respawnAt, idleTicks, AFK_RESPAWN_MAX_TICKS)) {
          this._respawn(p);
        }
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
      // Phase 129d — chassis-aware collision radius. Wolf (rMul 0.78 →
      // 11px) was being pushed out at humanoid 14px → continuous tug
      // back from walls. Heavy (rMul 1.20 → 17px) was clipping into
      // walls on client because server used the smaller 14px push-out.
      const _pRadius = Math.round(PLAYER_RADIUS * (p.input.rMul || 1.0));
      _pushOutOfWalls(p, _pRadius);
      for (const s of this.structures.values()) {
        _pushOutOfStructure(p, _pRadius, s);
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
        if (p.hitDebug) {
          const b = this.bullets[this.bullets.length - 1];
          if (b) b._dbgShooter = p.id;
          console.log(`[hitdebug] t${this.tickCount} ${p.id} FIRE wId=${inp.wId || 'RIFLE'} bid=${b && b.id}`);
        }
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
        if (b._dbgShooter) console.log(`[hitdebug] t${this.tickCount} bid=${b.id} EXPIRED life<=0 or OOB`);
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
        if (b._dbgShooter) console.log(`[hitdebug] t${this.tickCount} bid=${b.id} WALL @(${b.x.toFixed(0)},${b.y.toFixed(0)}) kind=${obs.kind}`);
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
        if (b._dbgShooter) console.log(`[hitdebug] t${this.tickCount} bid=${b.id} STRUCT sid=${struct.sid} hp=${struct.hp}`);
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
      for (const p of this.players.values()) {
        if (!p.alive || p.id === b.shooterId) continue;
        if (this.tickCount < p.invulnUntil) continue;
        // Phase 129d — per-target chassis radius. Wolf (rMul 0.78) was
        // hit using humanoid 14px → wolves took bullets that visually
        // missed by 3px on the client side. Heavy (rMul 1.20) was the
        // reverse — bullets visually striking the body sometimes missed
        // server-side because the hit circle was undersized.
        const _tR = PLAYER_RADIUS * (p.input.rMul || 1.0);
        const r2 = _tR * _tR;
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
          if (b._dbgShooter) console.log(`[hitdebug] t${this.tickCount} bid=${b.id} PLAYER victim=${p.id} dmg=${b.damage} → hp=${p.hp}`);
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
                    q.killedAtTick = this.tickCount;   // Phase 180d — buff-after-death recompute
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
            p.killedAtTick = this.tickCount;   // Phase 180d — buff-after-death recompute
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
    const _tickEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const _tickMs = _tickEnd - _tickStart;
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

    let bestVictim = null;
    let bestStep   = Infinity;

    for (const target of this.players.values()) {
      if (target.id === shooter.id) continue;
      if (!target.alive) continue;
      if (this.tickCount < target.invulnUntil) continue;
      // Phase 129d — per-target chassis radius (see r2 site above).
      const _tR = PLAYER_RADIUS * (target.input.rMul || 1.0);
      const r2 = _tR * _tR;

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
    if (shooter.hitDebug) console.log(`[hitdebug] t${this.tickCount} LAGCOMP shooter=${shooter.id} victim=${bestVictim.id} dmg=${lcDmg} → hp=${bestVictim.hp}`);
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
      bestVictim.killedAtTick = this.tickCount;   // Phase 180d — buff-after-death recompute
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
    // Phase 5 — DELTA COMPRESSION per receiver.
    //
    // Each receiver gets only the FIELDS that changed since the last
    // snapshot we sent them. Per-receiver state (`this._recvState`) holds
    // the last-known position/hp/etc. so we can diff against it.
    //
    // Field-level rules per entity:
    //   Players  — id always; lastInputSeq + t always (change every tick);
    //              x/y/angle/hp/alive/invuln/name only when changed.
    //   Bullets  — id + x + y always; vx/vy/s + spawn flag only on first
    //              appearance for that receiver. Removed bullets reported
    //              once in `removedBullets`.
    //   Bots     — id always; x/y/angle/hp/alive/team only when changed.
    //              team is sent once on first appearance.
    //
    // Empty diffs (only `id`) are dropped from the snapshot — keeps the
    // payload minimal when entities are idle.
    //
    // First snapshot to a receiver is a "keyframe" — full state for every
    // entity. Subsequent are deltas.
    //
    // CPU cost: O(entities × receivers) diff work per tick. At 8 bots + 4
    // players + 20 bullets × 20 receivers × 33 Hz = ~21k field-compares/
    // sec. Sub-ms. Bandwidth saved: 40-60 % in typical play, more idle.
    //
    // Also retains Phase 3.2's AOI bullet culling — bullets > 1200 px
    // from a receiver are still skipped entirely (not in delta or
    // removedBullets — client treats them as off-radar and they're picked
    // up again automatically once back in range, via keyframe-style send
    // because the receiver's state won't have them tracked).
    const sT = Date.now();
    const tick = this.tickCount;

    // Lazy-init the receiver-state map.
    if (!this._recvState) this._recvState = new Map();

    // Pre-build CURRENT entity records (one allocation, reused across
    // diffs). These are the "full" representations; the diff routine
    // emits a subset of fields.
    const curPlayers = [];
    for (const p of this.players.values()) {
      const includeName = (this.tickCount - (p._lastNameSentTick || 0)) >= TICK_HZ
                       || p.name !== p._lastSentName;
      if (includeName) {
        p._lastNameSentTick = this.tickCount;
        p._lastSentName = p.name;
      }
      curPlayers.push({
        id: p.id,
        x: round1(p.x),
        y: round1(p.y),
        angle: round3(p.angle),
        hp: p.hp,
        alive: p.alive,
        invuln: this.tickCount < p.invulnUntil,
        name: p.name,
        _includeName: includeName,            // hint for diff path
        lastInputSeq: p.lastInputSeq,
        t: p.lastInputT || 0,
      });
    }
    const curBullets = this.bullets.map(b => ({
      id: b.id,
      x: round1(b.x),
      y: round1(b.y),
      vx: round1(b.vx),
      vy: round1(b.vy),
      s: b.shooterId,
    }));
    const curBots = this.simBotsEnabled
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

    const AOI = 1200, AOI2 = AOI * AOI;

    const conns = (typeof this.party.getConnections === 'function')
      ? this.party.getConnections()
      : null;
    if (!conns) {
      // No per-connection API — fall back to broadcast WITHOUT deltas.
      const snap = { type: 'snapshot', tick, sT, players: curPlayers, bullets: curBullets, bots: curBots };
      if (dbg) snap._dbg = dbg;
      this.party.broadcast(JSON.stringify(snap));
      return;
    }

    for (const conn of conns) {
      // Get-or-init the receiver state.
      let state = this._recvState.get(conn.id);
      if (!state) {
        state = { players: new Map(), bullets: new Map(), bots: new Map() };
        this._recvState.set(conn.id, state);
      }
      const me = this.players.get(conn.id);

      // ── Players: diff fields ──────────────────────────────────────
      const playerDeltas = [];
      for (const p of curPlayers) {
        const last = state.players.get(p.id);
        const out = { id: p.id, lastInputSeq: p.lastInputSeq, t: p.t };
        if (!last || last.x !== p.x) out.x = p.x;
        if (!last || last.y !== p.y) out.y = p.y;
        if (!last || last.angle !== p.angle) out.angle = p.angle;
        if (!last || last.hp !== p.hp) out.hp = p.hp;
        if (!last || last.alive !== p.alive) out.alive = p.alive;
        if (!last || last.invuln !== p.invuln) {
          if (p.invuln) out.invuln = true;     // omit when false (saves bytes)
          else if (last && last.invuln) out.invuln = false;
        }
        if (p._includeName || !last) out.name = p.name;
        playerDeltas.push(out);
        // Save the FULL state (not just delta) so next tick's diff has
        // ground truth.
        state.players.set(p.id, { x: p.x, y: p.y, angle: p.angle, hp: p.hp, alive: p.alive, invuln: p.invuln });
      }

      // ── Bullets: per-receiver AOI cull + delta for known bullets ──
      // Currently visible bullet ids — used to compute `removed`.
      const visibleBulletIds = new Set();
      const bulletDeltas = [];
      const mx = me ? me.x : 0;
      const my = me ? me.y : 0;
      const useAoi = !!(me && me.alive);
      for (const b of curBullets) {
        if (useAoi) {
          const dx = b.x - mx, dy = b.y - my;
          if (dx * dx + dy * dy > AOI2) continue;       // skip — out of view
        }
        visibleBulletIds.add(b.id);
        const last = state.bullets.get(b.id);
        if (!last) {
          // First appearance for this receiver — full record (acts as keyframe).
          bulletDeltas.push({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, s: b.s, spawn: 1 });
        } else if (last.x !== b.x || last.y !== b.y) {
          // Position update only.
          bulletDeltas.push({ id: b.id, x: b.x, y: b.y });
        }
        // else: completely unchanged → not in delta at all (extremely rare for bullets)
        state.bullets.set(b.id, { x: b.x, y: b.y });
      }
      // Bullets previously tracked by this receiver but NOT visible now
      // are either out-of-AOI (silently drop tracking so they re-keyframe
      // when they come back in) or actually gone (server.bullets dropped
      // them). Distinguish by checking if id is still in this.bullets.
      const livingBulletIds = new Set();
      for (const b of this.bullets) livingBulletIds.add(b.id);
      const removedBullets = [];
      for (const id of state.bullets.keys()) {
        if (visibleBulletIds.has(id)) continue;
        if (!livingBulletIds.has(id)) removedBullets.push(id);   // truly gone
        state.bullets.delete(id);                                // either way drop tracking
      }

      // ── Bots: diff fields ─────────────────────────────────────────
      const botDeltas = [];
      for (const b of curBots) {
        const last = state.bots.get(b.id);
        const out = { id: b.id };
        if (!last || last.team !== b.team) out.team = b.team;   // team is "permanent" — sent on keyframe
        if (!last || last.x !== b.x) out.x = b.x;
        if (!last || last.y !== b.y) out.y = b.y;
        if (!last || last.angle !== b.angle) out.angle = b.angle;
        if (!last || last.hp !== b.hp) out.hp = b.hp;
        if (!last || last.alive !== b.alive) out.alive = b.alive;
        // Drop fully-idle bots (only id) — client keeps last-known state.
        if (Object.keys(out).length > 1) botDeltas.push(out);
        state.bots.set(b.id, { team: b.team, x: b.x, y: b.y, angle: b.angle, hp: b.hp, alive: b.alive });
      }

      const snap = {
        type: 'snapshot', tick, sT,
        players: playerDeltas,
        bullets: bulletDeltas,
        bots: botDeltas,
      };
      if (removedBullets.length) snap.removedBullets = removedBullets;
      if (dbg) snap._dbg = dbg;
      try { conn.send(JSON.stringify(snap)); } catch (e) {}
    }
  }
}

function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
function num(n) { return typeof n === 'number' && isFinite(n) ? n : 0; }
function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }
