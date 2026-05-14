// ============================================================
// Phase 2 — Shared bullet sim (CLIENT copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// server/party/sim/bullet.js. Only the bottom export boilerplate
// differs.
//
// Pure helpers — no side effects, no DOM, no socket access. Caller
// owns the bullet arrays and is responsible for splicing dead ones,
// playing VFX on hit events, etc.
//
// === Bullet shape ===
//   {
//     x, y,           current position
//     vx, vy,         velocity in units/tick (NOT per-frame; client
//                     callers must use /2 when advancing per-frame)
//     life,           ticks remaining
//     damage,
//     weaponId,       'SMG' | 'RIFLE' | ... | 'ROCKET'
//     fromUnitId,     who fired (player id or bot id; null if env)
//     isRocket?,      copied from weapon profile
//     fromAlly?,      cached for VFX tinting
//   }
//
// === Spawn ===
//   SIM.spawnBulletsFromUnit(unit, weapon, angle, opts) → Bullet[]
//     Returns 1..N bullets (N = weapon.pellets) at the muzzle, with
//     per-pellet spread already applied. `unit` is the shooter ({x, y,
//     id, team}). `angle` is the aim direction (radians). `opts` may
//     carry overrides like { isAlly, jitterSeed }.
//
// === Step / collide ===
//   SIM.advanceBullet(b, dt = 1)        — mutates b.x/y/life by dt ticks
//   SIM.bulletVsCircle(b, c, radius)    — bool, swept-circle vs circle
//   SIM.bulletVsAABB(b, aabb)           — bool, point-in-rect test
//
// Swept-circle vs circle uses prev→cur segment so a fast bullet
// doesn't tunnel through a stationary target on a single tick.

(function() {
  'use strict';

  function _spawnOneBullet(unit, weapon, angle, spread) {
    const w = weapon;
    const ang = (typeof spread === 'number')
      ? angle + (Math.random() - 0.5) * spread
      : angle;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const off = (typeof window !== 'undefined' && window.SIM && window.SIM.BULLET_SPAWN_OFFSET) || 18;
    return {
      x:  unit.x + cos * off,
      y:  unit.y + sin * off,
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

  // Swept-circle vs circle: bullet has moved (vx, vy) over the last
  // dt window; check if the closest approach to (cx, cy) within that
  // segment is less than r. Avoids tunneling.
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

  const API = {
    spawnBulletsFromUnit,
    advanceBullet,
    bulletVsCircle,
    bulletVsAABB,
  };

  if (typeof window !== 'undefined') {
    window.SIM = window.SIM || {};
    Object.assign(window.SIM, API);
  }
})();
