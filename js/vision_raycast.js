// ============ VISION RAYCASTING ============
// Ray vs axis-aligned rect helpers used by the cone-of-vision system.
// Casts rays from a viewer toward target points, returning intersection
// distance or Infinity. Builds the convex visionPoly + enemyVisionPoly
// each frame from the cones the renderer uses for fog-of-war.
//
// Classic-script. Declares globally:
//   rayRect(x0, y0, dx, dy, rect) → distance along ray
//   isLOSClear(x0, y0, x1, y1) → boolean
//   isVisibleToFriendly(wx, wy) · isVisibleToEnemy(wx, wy)
//   computeVisionPolys() · etc.
//
// External deps: buildings · overheads · visionRays · visionPoly ·
//   enemyVisionPoly · player · enemies · allies · VIEW · ENEMY_VIEW

// Ray vs axis-aligned rect — returns t (distance along ray) or Infinity if no hit.
function rayRect(x0, y0, dx, dy, rect) {
  const invX = dx === 0 ? Infinity : 1 / dx;
  const invY = dy === 0 ? Infinity : 1 / dy;
  const tx1 = (rect.x - x0) * invX;
  const tx2 = (rect.x + rect.w - x0) * invX;
  const ty1 = (rect.y - y0) * invY;
  const ty2 = (rect.y + rect.h - y0) * invY;
  const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2));
  const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2));
  if (tmax < 0 || tmin > tmax) return Infinity;
  return tmin > 0 ? tmin : Infinity;
}

// Cast a ray from (x0, y0) in direction angle, up to maxDist; returns the hit point.
function castVisionRay(x0, y0, angle, maxDist, blockers) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let best = maxDist;
  for (const b of blockers) {
    const t = rayRect(x0, y0, dx, dy, b);
    if (t < best) best = t;
  }
  return { x: x0 + dx * best, y: y0 + dy * best, t: best };
}

// Build a fan-shaped visibility polygon from origin (numRays + 2 verts).
function buildVisionPoly(out, ox, oy, faceAngle, arc, range) {
  out.length = 0;
  out.push({ x: ox, y: oy });
  const half = arc / 2;
  // Cull to nearby blockers for perf — only buildings/lowCovers within (range + diagonal) bounding circle.
  const cull = range + 200;
  const blockers = [];
  for (const b of buildings) {
    const cx = b.x + b.w/2, cy = b.y + b.h/2;
    if (Math.hypot(cx - ox, cy - oy) - Math.hypot(b.w, b.h)/2 < cull) blockers.push(b);
  }
  for (const lc of lowCovers) {
    const cx = lc.x + lc.w/2, cy = lc.y + lc.h/2;
    if (Math.hypot(cx - ox, cy - oy) - Math.hypot(lc.w, lc.h)/2 < cull) blockers.push(lc);
  }
  for (let i = 0; i <= visionRays; i++) {
    const t = i / visionRays;
    const a = faceAngle - half + arc * t;
    const hit = castVisionRay(ox, oy, a, range, blockers);
    out.push(hit);
  }
}

// Wrap (target - current) into [-PI, PI]. Used to drive damped rotations.
function angDiff(target, current) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  return d;
}

function angleInCone(srcAngle, arc, ox, oy, tx, ty) {
  const a = Math.atan2(ty - oy, tx - ox);
  let d = a - srcAngle;
  while (d > Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  return Math.abs(d) <= arc / 2;
}

// True if any friendly (player or alive ally) can see (x, y) right now.
// Vision = inside their cone + within range + clear line-of-sight.
// Used to CULL enemy/drone/enemy-bullet rendering: outside any friendly cone,
// the player has no perceptual evidence of where enemies are.
const FPV_VIEW_RANGE = 600;
const FPV_VIEW_RANGE_SQ = FPV_VIEW_RANGE * FPV_VIEW_RANGE;
const FPV_VIEW_ARC = Math.PI * (150 / 180);   // 150° front cone
function isVisibleToFriendly(x, y) {
  if (player.alive) {
    const dx = x - player.x, dy = y - player.y;
    const d2 = dx*dx + dy*dy;
    if (d2 < VIEW.range * VIEW.range
        && angleInCone(player.angle, effectiveArc(Math.sqrt(d2)), player.x, player.y, x, y)
        && lineOfSight(player.x, player.y, x, y)) return true;
  }
  for (const a of allies) {
    if (!a.alive) continue;
    const dx = x - a.x, dy = y - a.y;
    const d2 = dx*dx + dy*dy;
    if (d2 < VIEW.range * VIEW.range
        && angleInCone(a.angle, effectiveArc(Math.sqrt(d2)), a.x, a.y, x, y)
        && lineOfSight(a.x, a.y, x, y)) return true;
  }
  // Recon drone — 360° circular vision, sees over walls (it's flying high).
  // EXCEPT: if the target is currently inside a forest canopy block, the
  // tree cover blocks aerial vision — combat there has to be ground-only.
  if (drone.deployed) {
    const dx = x - drone.x, dy = y - drone.y;
    if (dx*dx + dy*dy < drone.visionRadius * drone.visionRadius) {
      let blockedByCanopy = false;
      for (const lc of lowCovers) {
        if (!lc.canopy) continue;
        if (x > lc.x && x < lc.x + lc.w && y > lc.y && y < lc.y + lc.h) {
          blockedByCanopy = true; break;
        }
      }
      if (!blockedByCanopy) return true;
    }
  }
  // FPV kamikaze drone — narrow 150° forward cone (it's a fast strike asset,
  // not a recon platform) at 600u range. Sees over walls like the UAV does.
  if (fpv.active) {
    const dx = x - fpv.x, dy = y - fpv.y;
    const d2 = dx*dx + dy*dy;
    if (d2 < FPV_VIEW_RANGE_SQ
        && angleInCone(fpv.angle, FPV_VIEW_ARC, fpv.x, fpv.y, x, y)) return true;
  }
  return false;
}
