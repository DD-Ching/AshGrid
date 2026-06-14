// ============ EXPLOSIONS + WRECKAGE FX (Phase 185 — extracted from index.html) =
// Explosion spawn + AOE damage, the per-frame explosion/popup tick, and the
// burning-wreckage lifecycle (spawn/tick/render). Lifted verbatim out of the
// index.html inline monolith (behaviour-preserving). Classic-script globals —
// every caller (bullets.js, grenades.js, drone_fpv.js, mp_reconcile.js,
// world_render.js, the update loop) is unchanged. The STATE arrays it uses
// (explosions/wreckages/muzzleFlashes/damagePopups/WRECKAGE_*) stay inline and
// resolve as runtime globals.
//
// Declares globally: createExplosion · updateExplosions · spawnWreckage ·
//   tickWreckageSpawn · updateWreckages · renderWreckages.
// Deps (call-time globals): enemies · enemyDrones · game · killUnit ·
//   _tryStunOrKill · ctx · COLORS · explosions/wreckages/muzzleFlashes/
//   damagePopups · WRECKAGE_CFG · WRECKAGE_MAX.

function createExplosion(x, y, size) {
  // Phase 110d — added 'huge' tier for FPV kamikaze detonations. User:
  // '自殺無人機的爆炸半徑更大, 範圍更廣, 傷害更強, 也可以摧毀建築物
  // (我說的是我再加蓋的, 不要原本的)'. Radius 90 → 140, AOE 80 → 120,
  // and 'huge' is the ONLY size that also damages user-built structures
  // (game._structures). Stone arena walls + original-map terrain stay
  // untouched per user.
  const radius = size === 'huge' ? 140 : size === 'big' ? 90 : size === 'medium' ? 65 : 35;
  const numParts = size === 'huge' ? 32 : size === 'big' ? 24 : size === 'medium' ? 14 : 7;
  // Phase 17: per-particle stable colour. Previously particles flickered
  // 50/50 between black and red on every frame — looked like a single
  // colour blur. Now each particle picks its colour once at birth from a
  // weighted palette that reads as fire: hot cream/yellow core sparks
  // (15%), vivid orange-red flame (45%), constructivist red embers (25%),
  // black ash smoke (15%). User feedback: '爆炸的火焰要鮮紅一點 · 不要全部
  // 都一個顏色'.
  const pickParticleColor = () => {
    const r = Math.random();
    if (r < 0.15) return '#FFDC9A';        // hot cream-yellow spark
    if (r < 0.60) return '#F2402E';        // vivid orange-red flame
    if (r < 0.85) return '#C8261C';        // constructivist red ember
    return '#1A1A1A';                      // black ash
  };
  explosions.push({
    x, y, radius, life: 35, maxLife: 35,
    particles: Array.from({length: numParts}, () => ({
      x: 0, y: 0,
      vx: (Math.random()-0.5)*10,
      vy: (Math.random()-0.5)*10,
      size: 3 + Math.random()*8,
      angle: Math.random()*Math.PI*2,
      color: pickParticleColor(),
    })),
  });
  if (size !== 'small') {
    const aoeDmg = size === 'huge' ? 120 : size === 'big' ? 80 : 60;
    for (const e of enemies) {
      if (!e.alive) continue;
      if (Math.hypot(e.x-x, e.y-y) < radius) {
        // 184o — chassis gateway so a heavy enemy's armour absorbs explosion AOE.
        if (typeof _applyDamageToUnit === 'function') _applyDamageToUnit(e, aoeDmg);
        else e.hp -= aoeDmg;
        if (e.hp <= 0) {
          // Phase 18: first KO → stun + freeze, second KO → real death.
          if (typeof _tryStunOrKill === 'function' && _tryStunOrKill(e)) {
            // stunned, no kill credit yet
          } else {
            killUnit(e, { source: 'aoe' });   // alive=false + score 100 + lb bump
          }
        }
      }
    }
    for (const d of enemyDrones) {
      if (!d.alive) continue;
      if (Math.hypot(d.x-x, d.y-y) < radius) {
        d.hp -= aoeDmg;
        if (d.hp <= 0) { d.alive = false; game.score += 150; game.killCount++; }
      }
    }
    // Phase 110d — 'huge' tier (FPV kamikaze) also chews through any
    // player-built structures inside the blast. 200 dmg per hit one-shots
    // basic walls and 2-shots reinforced ones. Smaller sizes leave
    // structures alone so a stray grenade doesn't trash someone's base.
    if (size === 'huge' && typeof game !== 'undefined' && game._structures) {
      for (const s of game._structures) {
        if (!s || s.hp <= 0) continue;
        if (Math.hypot(s.x - x, s.y - y) < radius) {
          s.hp -= 200;
        }
      }
    }
  }
}

function updateExplosions() {
  for (let i = explosions.length-1; i >= 0; i--) {
    const e = explosions[i];
    e.life--;
    for (const p of e.particles) {
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.94; p.vy *= 0.94;
    }
    if (e.life <= 0) explosions.splice(i, 1);
  }
  for (let i = muzzleFlashes.length-1; i >= 0; i--) {
    muzzleFlashes[i].life--;
    if (muzzleFlashes[i].life <= 0) muzzleFlashes.splice(i, 1);
  }
  for (let i = damagePopups.length-1; i >= 0; i--) {
    const p = damagePopups[i];
    p.y += p.vy;
    p.vy *= 0.96;
    p.life--;
    if (p.life <= 0) damagePopups.splice(i, 1);
  }
}

// ============ Phase 62 — BURNING WRECKAGE ============
// Visual marker for KIA chassis units. User: '會有燃燒死亡的殘骸 然後慢慢
// 淡出 火光慢慢變小'. Glow shrinks + dims linearly with remaining life;
// blackened silhouette fades only in the last 33% so the body is visible
// for most of the burn. Ember sparks spawn proportional to heat, rise +
// drift, fade as their own short life ticks out.
//
// Performance budget: WRECKAGE_MAX=20 active bodies, each capped at 10
// concurrent embers → ~200 micro draws per frame at worst. Cheaper than a
// single createExplosion.

function spawnWreckage(x, y, chassis) {
  if (wreckages.length >= WRECKAGE_MAX) wreckages.shift();
  const safeChassis = (chassis && WRECKAGE_CFG[chassis]) ? chassis : 'humanoid';
  const cfg = WRECKAGE_CFG[safeChassis];
  wreckages.push({
    x, y,
    chassis: safeChassis,
    life: cfg.life,
    maxLife: cfg.life,
    // Random rotation so a stacked KIA pile doesn't look like a stamped grid.
    angle: Math.random() * Math.PI * 2,
    embers: [],
    nextEmberAt: 0,
    cfg,
  });
}

// Hook: walk allies + enemies once per frame. Newly-dead chassis units get
// a wreckage; bodies that respawn clear the flag so a second death later
// in the match spawns a fresh one. Single-place hook so we don't have to
// touch every `alive = false` site individually.
function tickWreckageSpawn() {
  if (typeof allies !== 'undefined') {
    for (const u of allies) {
      if (u.alive) { u._wreckageDone = false; continue; }
      if (!u._wreckageDone) {
        spawnWreckage(u.x, u.y, u._chassis);
        u._wreckageDone = true;
      }
    }
  }
  if (typeof enemies !== 'undefined') {
    for (const u of enemies) {
      if (u.alive) { u._wreckageDone = false; continue; }
      if (!u._wreckageDone) {
        spawnWreckage(u.x, u.y, u._chassis);
        u._wreckageDone = true;
      }
    }
  }
}

function updateWreckages() {
  const now = (typeof game !== 'undefined' && game.time) ? game.time : 0;
  for (let i = wreckages.length - 1; i >= 0; i--) {
    const w = wreckages[i];
    w.life--;
    if (w.life <= 0) { wreckages.splice(i, 1); continue; }
    const heat = w.life / w.maxLife;
    // Phase 111 — burning crackle audio. Each wreckage schedules its own
    // crackle pops; volume scales with heat × distance attenuation so a
    // fresh kill near the player is loud, embers across the map are
    // quiet, and the whole thing tapers off as the fire dies. User:
    // '接近快燃盡的這個遺殘還會從大自然燃燒聲會越來越小嘛, 然後越來越
    // 遠的話也會越來越小嘛'. Sound emission gated on the AUDIO context
    // being unlocked (handled inside playPositionalSound).
    if (heat > 0.08 && now >= (w.nextCrackleAt || 0)
        && typeof playPositionalSound === 'function') {
      // Intensity 700 = ~ wreckage 'earshot' range (player won't hear
      // wrecks > 700 u away, which matches the camera-visible area).
      // volMul = heat^1.3 so cooling crackles fade fast (sounds like the
      // fire actually dying, not just getting quieter on a flat line).
      playPositionalSound(w.x, w.y, 700, 'crackle', false,
        { volMul: Math.pow(heat, 1.3) });
      // Re-schedule: 0.8-2.5 s interval, longer as it cools. Per-wreck
      // jitter so 5 simultaneous wrecks don't crackle in sync.
      const intervalTicks = Math.round((50 + Math.random() * 100) / Math.max(0.15, heat));
      w.nextCrackleAt = now + intervalTicks;
    }
    // Ember spawn: rate scales with heat (more sparks while hot, sparse as
    // it cools). Cap at 10 concurrent embers per wreck for perf.
    if (heat > 0.05 && now >= w.nextEmberAt && w.embers.length < 10) {
      w.embers.push({
        ox: (Math.random() - 0.5) * w.cfg.silSize * 0.8,
        oy: 0,
        vx: (Math.random() - 0.5) * 0.8,
        vy: -0.4 - Math.random() * 0.7,
        life: 30 + Math.random() * 25,
        maxLife: 55,
        color: Math.random() < 0.6 ? '#F2402E' : '#FFDC9A',
      });
      // Interval: smaller when emberRateMax is HIGHER (chunkier chassis
      // throws more sparks) and smaller while hot (more sparks at peak
      // burn, slowing to a trickle as it cools). Hard min 2 to avoid
      // ember-spam on a single frame.
      const interval = Math.max(2, Math.round(20 / (w.cfg.emberRateMax * Math.max(0.1, heat))));
      w.nextEmberAt = now + interval;
    }
    // Tick embers — slight gravity so they arc instead of rocketing straight.
    for (let j = w.embers.length - 1; j >= 0; j--) {
      const eb = w.embers[j];
      eb.ox += eb.vx;
      eb.oy += eb.vy;
      eb.vy += 0.02;
      eb.life--;
      if (eb.life <= 0) w.embers.splice(j, 1);
    }
  }
}

function renderWreckages() {
  for (const w of wreckages) {
    const heat = w.life / w.maxLife;
    // Silhouette only fades in the last 33% — body visible for most of burn.
    const silA = Math.min(1, heat * 1.5) * 0.85;
    ctx.save();
    ctx.translate(w.x, w.y);
    ctx.rotate(w.angle);

    // Radial glow (largest + brightest at peak heat; shrinks + dims as it
    // cools). Skip the gradient entirely once nearly out — saves the cost
    // when 10+ wreckages are simultaneously fading.
    const glowR = w.cfg.glowR * (0.45 + 0.55 * heat);
    const glowA = w.cfg.glowAlpha * heat;
    if (glowA > 0.02) {
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
      grad.addColorStop(0,   `rgba(255, 110, 30, ${glowA})`);
      grad.addColorStop(0.5, `rgba(200, 38, 28, ${glowA * 0.5})`);
      grad.addColorStop(1,   'rgba(200, 38, 28, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Chassis silhouette — blackened, with a warm tint while still hot
    // (cools toward pure ash as heat → 0).
    if (silA > 0.05) {
      const warm = Math.round(20 + 40 * heat);
      ctx.fillStyle = `rgba(${warm}, ${Math.round(warm * 0.6)}, ${Math.round(warm * 0.4)}, ${silA})`;
      if (w.chassis === 'wolf') {
        // Low-slung oval — quadruped silhouette flattened to the ground.
        ctx.beginPath();
        ctx.ellipse(0, 0, 12, 5, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (w.chassis === 'heavy') {
        // Boxy chassis + a hot inner core that pulses while the burn is
        // young (heavy carries more reactor fuel; lingers brighter longer).
        ctx.fillRect(-10, -10, 20, 20);
        if (heat > 0.2) {
          ctx.fillStyle = `rgba(242, 64, 46, ${heat * 0.65})`;
          ctx.fillRect(-4, -4, 8, 8);
        }
      } else {
        // humanoid: torso slab + head dropped to one side ('slumped').
        ctx.fillRect(-7, -4, 14, 8);
        ctx.beginPath();
        ctx.arc(-9, 1, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Ember sparks — small drifting dots, hex colour converted to rgba
    // inline so we can fade with life. Tiny 2×2 fillRect is faster than
    // arc() for sub-3px particles.
    for (const eb of w.embers) {
      const ea = eb.life / eb.maxLife;
      const hex = eb.color;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${ea})`;
      ctx.fillRect(eb.ox - 1, eb.oy - 1, 2, 2);
    }

    ctx.restore();
  }
}
