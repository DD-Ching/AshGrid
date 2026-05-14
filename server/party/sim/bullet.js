// ============================================================
// Phase 2 — Shared bullet sim (SERVER copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// js/sim/bullet.js. Only the bottom export boilerplate differs.
//
// See js/sim/bullet.js for the full design comment.

import { BULLET_SPAWN_OFFSET } from './constants.js';

function _spawnOneBullet(unit, weapon, angle, spread) {
  const w = weapon;
  const ang = (typeof spread === 'number')
    ? angle + (Math.random() - 0.5) * spread
    : angle;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  return {
    x:  unit.x + cos * BULLET_SPAWN_OFFSET,
    y:  unit.y + sin * BULLET_SPAWN_OFFSET,
    vx: cos * w.bulletSpeed,
    vy: sin * w.bulletSpeed,
    life: w.bulletLife,
    damage: w.damage,
    weaponId: weapon.weaponId,
    fromUnitId: unit.id != null ? unit.id : null,
    fromAlly: !!(unit.team === 0 && !unit.isPlayer),
    isRocket: !!w.isRocket,
  };
}

function spawnBulletsFromUnit(unit, weapon, angle) {
  const n = (weapon.pellets | 0) || 1;
  if (n === 1) return [_spawnOneBullet(unit, weapon, angle, 0)];
  const spread = weapon.spread || 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = _spawnOneBullet(unit, weapon, angle, spread);
  return out;
}

function advanceBullet(b, dt) {
  const k = (typeof dt === 'number') ? dt : 1;
  b.x += b.vx * k;
  b.y += b.vy * k;
  b.life -= k;
  return b;
}

function bulletVsCircle(b, cx, cy, r) {
  const prevX = b.x - b.vx;
  const prevY = b.y - b.vy;
  const segVx = b.x - prevX, segVy = b.y - prevY;
  const segL2 = segVx * segVx + segVy * segVy;
  let t = 0;
  if (segL2 > 0) {
    t = ((cx - prevX) * segVx + (cy - prevY) * segVy) / segL2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
  }
  const px = prevX + segVx * t;
  const py = prevY + segVy * t;
  const dx = px - cx, dy = py - cy;
  return (dx * dx + dy * dy) <= r * r;
}

function bulletVsAABB(b, ax, ay, aw, ah) {
  return b.x >= ax && b.x <= ax + aw && b.y >= ay && b.y <= ay + ah;
}

export {
  spawnBulletsFromUnit,
  advanceBullet,
  bulletVsCircle,
  bulletVsAABB,
};
