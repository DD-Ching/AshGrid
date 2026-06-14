// ============ COMBAT HELPERS (Phase 185 — extracted from index.html) ========
// Per-frame AI/combat geometry shared by the player, NN units, allies + modules:
// LoS, building/wall push-out, footprints, nearest-visible-friendly, kamikaze
// drone splash, sound-event tick, and NN-shotgun anti-kamikaze. Lifted verbatim
// from the inline monolith (behaviour-preserving). Classic-script globals — all
// callers (enemy_ai/squad/bullets/structures/vision/update loop) unchanged.
//
// Declares globally: lineOfSight · emitFootprint · pushOutOfBuildings ·
//   nearestVisibleFriendly · kamikazeExplode · updateSoundEvents ·
//   _tickShotgunAntiKamikaze (+ SHOTGUN_ANTI_DRONE_* consts).
// Deps (call-time globals): wallLines · _segSegHits · _segPointDist ·
//   _pointInCapsule · buildings · lowCovers · game · STRUCTURE_DEFS · player ·
//   allies · enemies · enemyDrones · angleInCone · createExplosion · emitSound ·
//   triggerShake · _applyDamageToUnit · PlayerLifecycle · mission · soundEvents ·
//   WEAPONS · muzzleFlashes · playSfx.

function lineOfSight(x1, y1, x2, y2) {
  // Wall-line LoS — exact segment-segment intersect, no marching needed.
  if (wallLines.length) {
    for (const w of wallLines) {
      if (!w.blocksLOS || w.hp <= 0) continue;
      if (_segSegHits(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2)) return false;
    }
  }
  // 184q — hoist the structure/smoke lists out of the 28-step march (they don't
  // change within one call) and skip the whole sub-scan when empty (the common
  // case). Behaviour-identical; just avoids re-resolving game._structures /
  // _smokeClouds + an empty-loop setup 28× per LoS check (a very hot path).
  const structs = (game._structures && game._structures.length) ? game._structures : null;
  const smoke   = (game._smokeClouds && game._smokeClouds.length) ? game._smokeClouds : null;
  const steps = 28;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x1 + (x2-x1)*t, y = y1 + (y2-y1)*t;
    for (const b of buildings) {
      if (x > b.x && x < b.x+b.w && y > b.y && y < b.y+b.h) return false;
    }
    for (const lc of lowCovers) {
      if (x > lc.x && x < lc.x+lc.w && y > lc.y && y < lc.y+lc.h) return false;
    }
    // Player-built walls block sight too
    if (structs) {
      for (const s of structs) {
        if (s.hp <= 0) continue;
        const def = STRUCTURE_DEFS[s.kind];
        if (!def || !def.blocksLOS) continue;
        const r = def.size / 2;
        if (x > s.x - r && x < s.x + r && y > s.y - r && y < s.y + r) return false;
      }
    }
    // Smoke clouds block sight at near-full opacity in the middle, fading
    // at the edges. Approximation: any sample point within 0.85×R blocks.
    if (smoke) {
      for (const c of smoke) {
        const fade = c.life / c.maxLife;
        if (fade < 0.15) continue;            // dissipating — let through
        const blockR = c.r * 0.85;
        if (Math.hypot(x - c.x, y - c.y) < blockR) return false;
      }
    }
  }
  return true;
}

// Footprint tracker — every N ticks while a unit is moving in defense mode,
// drop a fading print at its position. Player can see ALL prints (incl.
// enemies') for tactical recon. Enemies don't react to them — purely UX.
// Was previously gated to defense mode only — now fires in every NN mode
// (and campaign) because the player asked '以前不是還有足跡嗎'.
function emitFootprint(unit) {
  game._footprints = game._footprints || [];
  game._footprints.push({
    x: unit.x, y: unit.y,
    angle: unit.angle || 0,
    team: unit.team || 0,
    life: 240, maxLife: 240,
  });
  // Cap to 240 to stop unbounded growth in long matches; oldest evicts first.
  if (game._footprints.length > 240) game._footprints.shift();
}

function pushOutOfBuildings(ent, radius) {
  for (const b of buildings) {
    if (ent.x > b.x - radius && ent.x < b.x+b.w+radius &&
        ent.y > b.y - radius && ent.y < b.y+b.h+radius) {
      const cx = b.x + b.w/2, cy = b.y + b.h/2;
      const ddx = ent.x - cx, ddy = ent.y - cy;
      const overlapX = (b.w/2 + radius) - Math.abs(ddx);
      const overlapY = (b.h/2 + radius) - Math.abs(ddy);
      if (overlapX < overlapY) ent.x += ddx > 0 ? overlapX : -overlapX;
      else ent.y += ddy > 0 ? overlapY : -overlapY;
    }
  }
  // Wall-line push-out: project the entity onto each segment, push it
  // perpendicular if it overlaps the capsule (segment ± thickness/2).
  for (const w of wallLines) {
    if (w.hp <= 0) continue;
    const pad = w.thickness / 2 + radius;
    const r = _segPointDist(ent.x, ent.y, w.x1, w.y1, w.x2, w.y2);
    if (r.dist < pad) {
      const dx = ent.x - r.cx, dy = ent.y - r.cy;
      const d = Math.hypot(dx, dy) || 1;
      const push = pad - r.dist;
      ent.x += (dx / d) * push;
      ent.y += (dy / d) * push;
    }
  }
  // Phase 10A (user feedback '建造了很多東西 ... 牆壁 ... 沒有辦法穿越'):
  // player-built structures in game._structures were NEVER blocking
  // movement before — you could walk through your own walls. Iterate
  // and push out for every structure whose def.blocks is true. Same
  // AABB technique as the buildings[] loop. Skips dead (hp<=0) so
  // destroyed walls don't ghost-block.
  if (typeof game !== 'undefined' && game._structures && typeof STRUCTURE_DEFS !== 'undefined') {
    for (const s of game._structures) {
      const def = STRUCTURE_DEFS[s.kind];
      if (!def || !def.blocks || s.hp <= 0) continue;
      const r = def.size / 2;
      if (ent.x > s.x - r - radius && ent.x < s.x + r + radius &&
          ent.y > s.y - r - radius && ent.y < s.y + r + radius) {
        const ddx = ent.x - s.x, ddy = ent.y - s.y;
        const overlapX = (r + radius) - Math.abs(ddx);
        const overlapY = (r + radius) - Math.abs(ddy);
        if (overlapX < overlapY) ent.x += ddx > 0 ? overlapX : -overlapX;
        else ent.y += ddy > 0 ? overlapY : -overlapY;
      }
    }
  }
}

// Returns the nearest friendly (player or ally) the source can SEE right now (cone + LoS).
function nearestVisibleFriendly(sx, sy, sAngle, range, arc) {
  let best = null, bestD = Infinity;
  if (player.alive) {
    const d = Math.hypot(player.x - sx, player.y - sy);
    if (d < range && angleInCone(sAngle, arc, sx, sy, player.x, player.y)
        && lineOfSight(sx, sy, player.x, player.y)) {
      best = player; bestD = d;
    }
  }
  for (const a of allies) {
    if (!a.alive) continue;
    const d = Math.hypot(a.x - sx, a.y - sy);
    if (d < range && angleInCone(sAngle, arc, sx, sy, a.x, a.y)
        && lineOfSight(sx, sy, a.x, a.y)) {
      if (d < bestD) { best = a; bestD = d; }
    }
  }
  return best;
}


function kamikazeExplode(d) {
  d.alive = false;
  // Phase 7: 'big' (radius 90 / dmg 80) replaces 'medium' so the visual
  // matches the wider blast logic. createExplosion also auto-damages any
  // enemies / enemyDrones in the radius (friendly fire — fine for kamikaze).
  createExplosion(d.x, d.y, 'big');
  emitSound(d.x, d.y, 700, false);
  // Camera kick + lower-pitched boom so the player FEELS the hit.
  if (typeof triggerShake === 'function') triggerShake(4.5);
  emitSound(d.x, d.y, 380, false);
  // Damage friendlies in radius
  // Phase 117 — respect 3s spawn invuln. User reported '復活之後瞬間就
  // 死掉的體驗' — an enemy kamikaze drone in mid-flight at the moment
  // they died would still be airborne when their respawn invuln
  // started, then explode on them inside the 3s window and bypass the
  // shield because this damage path never checked invuln. Bullets (in
  // bullets.js:456) and rocket AOE both gate on invuln; this drone-
  // splash path was the odd one out.
  const pInvuln = player._invulnUntil != null && game.time < player._invulnUntil;
  if (player.alive && !pInvuln) {
    const pd = Math.hypot(player.x - d.x, player.y - d.y);
    if (pd < d.explodeRadius) {
      const dmg = Math.round(d.explodeDamage * (1 - pd / d.explodeRadius));
      _applyDamageToUnit(player, dmg);
      game.hitFlash = 28;
      if (player.hp <= 0 && player.alive) {
        // R12 — canonical state transition. Phase 117's Phase 122-style
        // inline writes (alive=false, hp=0, _lbBumpDeath, _lastDeathX/Y)
        // now collapse into PlayerLifecycle.killPlayer; the centralised
        // invuln gate in _applyDamageToUnit (Phase 122) already kept this
        // block from firing under the spawn-shield window, but defensively
        // we also gate on `player.alive` so a re-trigger from the same
        // splash on a dead player no-ops.
        if (typeof PlayerLifecycle !== 'undefined') {
          PlayerLifecycle.killPlayer({ x: player.x, y: player.y });
        }
        createExplosion(player.x, player.y, 'big');
        // Player death — onMissionFailed handles retry/campaign-end
      }
    }
  }
  for (const a of allies) {
    if (!a.alive) continue;
    const ad = Math.hypot(a.x - d.x, a.y - d.y);
    if (ad < d.explodeRadius) {
      const dmg = Math.round(d.explodeDamage * (1 - ad / d.explodeRadius));
      _applyDamageToUnit(a, dmg);
      if (a.hp <= 0) { a.alive = false; }
    }
  }
  // Mission-owned damageable entity in radius (UGV / heavy / relay)
  if (mission && mission.onExplosion) mission.onExplosion(d.x, d.y, d.explodeRadius, d.explodeDamage);
}

function updateSoundEvents() {
  for (let i = soundEvents.length - 1; i >= 0; i--) {
    soundEvents[i].life--;
    if (soundEvents[i].life <= 0) soundEvents.splice(i, 1);
  }
}

// Phase 10C (user feedback '自殺無人機是會被散彈槍打下來的'): when an NN
// unit is wielding SHOTGUN and a live kamikaze drone is in range + roughly
// in front, low per-frame chance to fire at it. Player's manual shotgun
// ALREADY hits drones (the bullets→enemyDrones loop in updateBullets), so
// this just adds the AI flair — squadmates / NN enemies with shotguns will
// "look up" and pop at incoming drones. Chance is low so it's not a hard
// counter — drones still get through, just slightly less often near SGs.
const SHOTGUN_ANTI_DRONE_RANGE       = 280;          // px
const SHOTGUN_ANTI_DRONE_CONE        = Math.PI / 2.5;// ~72° front arc
const SHOTGUN_ANTI_DRONE_FIRE_CHANCE = 0.025;        // ~1 shot/1.3s while drone in view
const SHOTGUN_ANTI_DRONE_HIT_CHANCE  = 0.55;         // 55% per shot — 1 hit drops 18 HP drone
function _tickShotgunAntiKamikaze() {
  if (!enemyDrones || enemyDrones.length === 0) return;
  const SG = (typeof WEAPONS !== 'undefined') ? WEAPONS.SHOTGUN : null;
  if (!SG) return;
  const candidates = [];
  for (const a of allies) candidates.push(a);
  for (const e of enemies) candidates.push(e);
  for (const u of candidates) {
    if (!u || !u.alive) continue;
    if (u._weapon !== SG) continue;
    let best = null, bestD = SHOTGUN_ANTI_DRONE_RANGE;
    for (const d of enemyDrones) {
      if (!d.alive) continue;
      const dx = d.x - u.x, dy = d.y - u.y;
      const dist = Math.hypot(dx, dy);
      if (dist > bestD) continue;
      let aDiff = Math.atan2(dy, dx) - (u.angle || 0);
      while (aDiff > Math.PI) aDiff -= Math.PI * 2;
      while (aDiff < -Math.PI) aDiff += Math.PI * 2;
      if (Math.abs(aDiff) > SHOTGUN_ANTI_DRONE_CONE) continue;
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (!best) continue;
    if (Math.random() > SHOTGUN_ANTI_DRONE_FIRE_CHANCE) continue;
    // Fire FX — muzzle flash pointed at drone
    if (typeof muzzleFlashes !== 'undefined') {
      muzzleFlashes.push({
        x: u.x, y: u.y,
        angle: Math.atan2(best.y - u.y, best.x - u.x),
        life: 5,
      });
    }
    if (typeof playSfx === 'function') playSfx('shoot', { freq: 410, vol: 0.5 });
    // Roll for hit. Pellet damage = SG.damage (18). Drone HP 18 = 1 hit drops.
    if (Math.random() < SHOTGUN_ANTI_DRONE_HIT_CHANCE) {
      best.hp -= SG.damage;
      if (best.hp <= 0) {
        best.alive = false;
        if (typeof createExplosion === 'function') createExplosion(best.x, best.y, 'small');
        game.score += 50;
        game.killCount++;
      }
    }
  }
}
