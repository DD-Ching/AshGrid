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

// 184r — removed the dead ray-cone fog subsystem (rayRect / castVisionRay /
// buildVisionPoly). Its only consumer was drawSharedVisionFog() in
// render_overlays.js, which was itself never called — the whole chain was
// orphaned. The live fog-of-war path uses isVisibleToFriendly (below). Kept
// angDiff + angleInCone (used by isVisibleToFriendly and others).

// Wrap (target - current) into [-PI, PI]. Used to drive damped rotations.
function angDiff(target, current) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  return d;
}

function angleInCone(srcAngle, arc, ox, oy, tx, ty) {
  // 184r — reuse the sibling angDiff() wrap (byte-identical to the old inline
  // while-loops) instead of duplicating it.
  const d = angDiff(Math.atan2(ty - oy, tx - ox), srcAngle);
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
  // VIEW lives in index.html (loads after this file), so square it at call time
  // (runtime), not module-load — once per call instead of once per viewer below.
  const rangeSq = VIEW.range * VIEW.range;
  if (player.alive) {
    const dx = x - player.x, dy = y - player.y;
    const d2 = dx*dx + dy*dy;
    if (d2 < rangeSq
        && angleInCone(player.angle, effectiveArc(Math.sqrt(d2)), player.x, player.y, x, y)
        && lineOfSight(player.x, player.y, x, y)) return true;
  }
  for (const a of allies) {
    if (!a.alive) continue;
    const dx = x - a.x, dy = y - a.y;
    const d2 = dx*dx + dy*dy;
    if (d2 < rangeSq
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
