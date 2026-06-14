// ============ GEOMETRY (Phase 185 — extracted from index.html) ============
// Pure 2D math helpers, lifted verbatim out of the index.html inline monolith
// as the first behaviour-preserving modularization step (see the recon map).
// No state, no game refs — just geometry — so they relocate cleanly. Loaded as
// a classic <script> before everything else, so these stay global exactly as
// when they were inline; every existing call site is unchanged.
//
// Classic-script. Declares globally:
//   _segPointDist(px,py,x1,y1,x2,y2) → {dist,cx,cy,t}   point→segment (clamped)
//   _segSegHits(ax1,ay1,ax2,ay2,bx1,by1,bx2,by2) → bool segment∩segment
//   _pointInCapsule(px,py,x1,y1,x2,y2,pad) → bool        point in fat segment
//   isInsideRect(x,y,rect) → bool                        point in rect (exclusive)
//   _hitRect(rect,x,y) → bool                            point in rect (inclusive)

function _segPointDist(px, py, x1, y1, x2, y2) {
  // Returns closest distance + the projected point on the segment (clamped
  // 0..1). Used by collision (entity vs wall) and bullet hits.
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.0001) {
    return { dist: Math.hypot(px - x1, py - y1), cx: x1, cy: y1, t: 0 };
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), cx, cy, t };
}
function _segSegHits(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
  const d = (ax2 - ax1) * (by2 - by1) - (ay2 - ay1) * (bx2 - bx1);
  if (Math.abs(d) < 1e-9) return false;       // parallel
  const ta = ((bx1 - ax1) * (by2 - by1) - (by1 - ay1) * (bx2 - bx1)) / d;
  const tb = ((bx1 - ax1) * (ay2 - ay1) - (by1 - ay1) * (ax2 - ax1)) / d;
  return ta >= 0 && ta <= 1 && tb >= 0 && tb <= 1;
}
// 184r — removed dead _pointInCapsule() (zero call sites; capsule hit tests use
// _segPointDist directly at the live call sites).

function isInsideRect(x, y, r) {
  return x > r.x && x < r.x+r.w && y > r.y && y < r.y+r.h;
}

function _hitRect(r, x, y) {
  return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}
