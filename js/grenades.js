// ============ GRENADES ============
// Player hand-grenades — parabolic toss to mouse cursor with friction
// deceleration, then 1.5s fuse, then radial explosion.
//
// Classic-script. Declares globally:
//   grenades (array — live in-flight grenades)
//   GRENADE_FUSE · GRENADE_RADIUS · GRENADE_DAMAGE_MAX
//   GRENADE_THROW_MAX · GRENADE_THROW_MIN · GRENADE_FRICTION
//   throwGrenade() · updateGrenades() · explodeGrenade(g)
//
// External deps (resolved at call-time):
//   player · mouse · enemies · allies · buildings · lowCovers · explosions
//   screenToWorld · playSfx · isLOSClear · damageEnemy · damageAlly
//   spawnDamagePopup · createExplosion · emitSound · soundEvents

const grenades = [];
const GRENADE_FUSE       = 90;     // 1.5s @ 60fps
const GRENADE_RADIUS     = 130;    // explosion radius (units)
const GRENADE_DAMAGE_MAX = 90;     // dmg at center; falls off linearly to 0 at edge
const GRENADE_THROW_MAX  = 1050;   // max throw distance — 2.5× longer reach
const GRENADE_THROW_MIN  = 80;     // min — clicking right next to you still goes a bit out
const GRENADE_FRICTION   = 0.92;   // velocity decay per frame after release

function throwGrenade() {
  if (!player.alive) return;
  if (player.grenades <= 0) { playSfx('empty_click', { vol: 0.4 }); return; }
  player.grenades--;
  const wp = screenToWorld(mouse.x, mouse.y);
  const dx = wp.x - player.x, dy = wp.y - player.y;
  const targetDist = Math.max(GRENADE_THROW_MIN,
                              Math.min(GRENADE_THROW_MAX, Math.hypot(dx, dy)));
  const a = Math.atan2(dy, dx);
  // Initial velocity tuned so friction (0.92) decays it to ~0 right at targetDist
  // sum of geometric series: v0 / (1 - 0.92) = v0 / 0.08 = ~12.5×v0 traveled
  const v0 = targetDist * 0.10;
  grenades.push({
    x: player.x + Math.cos(a) * 16,
    y: player.y + Math.sin(a) * 16,
    vx: Math.cos(a) * v0,
    vy: Math.sin(a) * v0,
    fuse: GRENADE_FUSE,
  });
  playSfx('reload', { vol: 0.5 });
}

function updateGrenades() {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.x += g.vx; g.y += g.vy;
    g.vx *= GRENADE_FRICTION; g.vy *= GRENADE_FRICTION;
    // Stop if it hits a wall (push out along the face it actually entered
    // through — using the previous position to disambiguate corner hits, so
    // a grenade nicking the bottom-left corner doesn't teleport to the
    // far side of the building).
    for (const b of buildings) {
      if (g.x > b.x && g.x < b.x + b.w && g.y > b.y && g.y < b.y + b.h) {
        const px = g.x - g.vx, py = g.y - g.vy;
        const wasL = px <= b.x;
        const wasR = px >= b.x + b.w;
        const wasT = py <= b.y;
        const wasB = py >= b.y + b.h;
        let bestDist = Infinity, sx = g.x, sy = g.y;
        const tryFace = (cond, dist, nx, ny) => {
          if (cond && dist < bestDist) { bestDist = dist; sx = nx; sy = ny; }
        };
        tryFace(wasL, g.x - b.x,           b.x - 0.5, g.y);
        tryFace(wasR, (b.x + b.w) - g.x,   b.x + b.w + 0.5, g.y);
        tryFace(wasT, g.y - b.y,           g.x, b.y - 0.5);
        tryFace(wasB, (b.y + b.h) - g.y,   g.x, b.y + b.h + 0.5);
        // Fallback: started inside (rare) — pick shallowest penetration overall.
        if (bestDist === Infinity) {
          tryFace(true, g.x - b.x,         b.x - 0.5, g.y);
          tryFace(true, (b.x + b.w) - g.x, b.x + b.w + 0.5, g.y);
          tryFace(true, g.y - b.y,         g.x, b.y - 0.5);
          tryFace(true, (b.y + b.h) - g.y, g.x, b.y + b.h + 0.5);
        }
        g.x = sx; g.y = sy;
        g.vx = 0; g.vy = 0;
        break;
      }
    }
    g.fuse--;
    if (g.fuse <= 0) { explodeGrenade(g); grenades.splice(i, 1); }
  }
}

function explodeGrenade(g) {
  createExplosion(g.x, g.y, 'big');
  playSfx('death', { vol: 0.6 });
  // Phase 111 — grenade uses the layered 'boom' synthesis path.
  emitSound(g.x, g.y, 1500, false, false, null, 'boom');
  // Shake intensity scales with proximity to player
  if (player.alive) {
    const d = Math.hypot(player.x - g.x, player.y - g.y);
    const closeness = Math.max(0, 1 - d / 220);
    if (closeness > 0) triggerShake(8 * closeness, 18);
  }
  const targets = [player, ...allies, ...enemies];
  for (const u of targets) {
    if (!u.alive) continue;
    // Spawn invuln also blocks grenade damage
    if (u._invulnUntil != null && game.time < u._invulnUntil) continue;
    const d = Math.hypot(u.x - g.x, u.y - g.y);
    if (d > GRENADE_RADIUS) continue;
    // Optional: walls between explosion and target absorb damage (use lineOfSight as proxy)
    const blocked = !lineOfSight(g.x, g.y, u.x, u.y);
    const dmg = Math.round(GRENADE_DAMAGE_MAX * (1 - d / GRENADE_RADIUS) * (blocked ? 0.35 : 1));
    if (dmg <= 0) continue;
    u.hp -= dmg;
    if (u === player) {
      game.hitFlash = 16;
      playSfx('hit');
    }
    if (u.hp <= 0 && u.alive) {
      u.hp = 0; u.alive = false;
      createExplosion(u.x, u.y, 'small');
      if (u === player) playSfx('death');
    }
  }
  // Phase 43: explosions also damage built structures.
  //
  // Single-player parity bug fix: previously bulletHitStructure existed but
  // was never called, AND grenades never iterated game._structures. Result:
  // built walls were invincible — you could trap yourself behind your own
  // bunker with no way out (user report: '不會說我會自己把自己搞住').
  //
  // In MP, structures are server-authoritative, so we send an explosion
  // request and let the server apply damage + broadcast structureHit / Gone
  // events. In SP, apply damage directly here.
  const inMp = (typeof _mpIsActive === 'function') && _mpIsActive();
  if (inMp && typeof _mpBroadcastExplosion === 'function') {
    _mpBroadcastExplosion(g.x, g.y, GRENADE_RADIUS, GRENADE_DAMAGE_MAX);
  } else if (typeof game !== 'undefined' && Array.isArray(game._structures)) {
    for (let i = game._structures.length - 1; i >= 0; i--) {
      const s = game._structures[i];
      if (s.hp <= 0) continue;
      const dd = Math.hypot(s.x - g.x, s.y - g.y);
      if (dd > GRENADE_RADIUS) continue;
      const sdmg = Math.max(1, Math.round(GRENADE_DAMAGE_MAX * (1 - dd / GRENADE_RADIUS)));
      s.hp -= sdmg;
      if (s.hp <= 0) {
        createExplosion(s.x, s.y, 'small');
        game._structures.splice(i, 1);
      }
    }
  }
}
