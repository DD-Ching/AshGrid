// ============ DRONE / FPV CONTROL ============
// Q = toggle UAV (recon drone, shared vision), E = launch FPV (kamikaze
// drone), R = start reload. The drone / fpv state objects live in the
// main script's STATE section; these functions drive their lifecycle.
//
// Classic-script. Declares globally:
//   toggleDrone() · launchFPV() · startReload()
//   updateDroneControl() · updateFPV() · _detonateFPV()   (Phase 185 — moved
//     here from the index.html inline monolith; per-frame drone/FPV steering)
//
// External deps: drone · fpv · FPV_SPEED_* · player · playerWeapon · keys ·
//   mouse · touchInput · TOUCH_* · WORLD · game · enemies · enemyDrones ·
//   _mpState · screenToWorld · playSfx · createExplosion · triggerShake ·
//   emitSound · showMessage · T  (all resolved at call time)

function toggleDrone() {
  if (!drone.deployed) {
    drone.deployed = true;
    drone.x = player.x;
    drone.y = player.y - 40;
    drone._anchorX = drone.x;
    drone._anchorY = drone.y;
    drone._hoverPhase = Math.random() * Math.PI * 2;
    game.mode = 'drone';
    showMessage(T('UAV 已部署', 'UAV deployed'), 60);
  } else {
    game.mode = (game.mode === 'drone') ? 'tactical' : 'drone';
  }
}

function launchFPV() {
  if (fpv.active) return;
  if (fpv.available <= 0) { showMessage(T('FPV 已耗尽', 'FPV depleted'), 60); return; }
  fpv.active = true;
  fpv.available--;
  fpv.x = player.x + Math.cos(player.angle)*40;
  fpv.y = player.y + Math.sin(player.angle)*40;
  fpv.angle = player.angle;
  fpv.trail = [];
  // Phase 9: reset speed ramp so each launch starts slow + controllable.
  fpv.speed = (typeof FPV_SPEED_START !== 'undefined') ? FPV_SPEED_START : 3;
  fpv._launchTick = game.time;
  game.mode = 'fpv';
  showMessage(T('FPV 自杀无人机已发射 · 空白鍵手動引爆',
                'FPV kamikaze launched · SPACE = detonate'), 90);
}

// R3: reload owned by js/weapon_state.js. This wrapper stays so
// key_bindings.js (R key) doesn't need to change its callsite.
function startReload() {
  if (window.WeaponState && WeaponState.beginReload) {
    WeaponState.beginReload();
    return;
  }
  // Fallback if weapon_state.js failed to load.
  if (player.reloading || player.ammo >= player.maxAmmo || player.reserve <= 0) return;
  player.reloading = true;
  player.reloadTime = playerWeapon.reloadFrames || 80;
  playSfx('reload');
}

// ── Per-frame drone/FPV steering (Phase 185 — moved verbatim from index.html) ──

function updateDroneControl() {
  let mx = 0, my = 0;
  if (keys['w']) my -= 1;
  if (keys['s']) my += 1;
  if (keys['a']) mx -= 1;
  if (keys['d']) mx += 1;
  if (touchInput.moveTouch) {
    const tdx = touchInput.moveTouch.dx, tdy = touchInput.moveTouch.dy;
    const len = Math.hypot(tdx, tdy);
    if (len > TOUCH_STICK_DEAD) {
      const k = Math.min(1, len / TOUCH_STICK_RADIUS);
      mx += (tdx / len) * k;
      my += (tdy / len) * k;
    }
  }
  // Anchor model: the anchor is where the pilot WANTS the drone. Input
  // moves the anchor; the visible drone position is anchor + a small
  // oscillating offset so it always microbobs like a real quadcopter
  // holding station. When you let go of input the anchor freezes — the
  // drone keeps weaving around it ±3u instead of jittering further away.
  if (drone._anchorX == null) { drone._anchorX = drone.x; drone._anchorY = drone.y; }
  if (drone._hoverPhase == null) drone._hoverPhase = Math.random() * Math.PI * 2;
  if (mx || my) {
    const len = Math.hypot(mx, my);
    drone._anchorX += mx/len * drone.speed;
    drone._anchorY += my/len * drone.speed;
  }
  drone._anchorX = Math.max(20, Math.min(WORLD.w-20, drone._anchorX));
  drone._anchorY = Math.max(20, Math.min(WORLD.h-20, drone._anchorY));
  const t = game.time;
  const ph = drone._hoverPhase;
  // Two non-harmonic sines (different freqs / phases) draw a Lissajous-y
  // oval ~3u wide. Plus a fast micro-jitter half a unit either side.
  const offX = Math.sin(t * 0.040 + ph) * 3.0
             + Math.sin(t * 0.18  + ph * 2.3) * 0.6;
  const offY = Math.cos(t * 0.031 + ph + 1.3) * 2.6
             + Math.cos(t * 0.21  + ph * 1.7) * 0.6;
  drone.x = drone._anchorX + offX;
  drone.y = drone._anchorY + offY;
  // No battery drain — UAV stays up as long as the player keeps it out.
}

function updateFPV() {
  if (!fpv.active) return;
  // Phase 19: turn rate falls with the speed ramp. Fresh launch is
  // 0.075 (close to old 0.08), committed dive drops to 0.025 — so the
  // pilot can still steer around obstacles in the first 2 sec, but a
  // maxed-out drone can't U-turn out of a wall it's about to hit.
  const _rampT = Math.min(1, Math.max(0, (game.time - (fpv._launchTick || 0)) / FPV_RAMP_TICKS));
  if (game.mode === 'fpv') {
    const wp = screenToWorld(mouse.x, mouse.y);
    const target = Math.atan2(wp.y - fpv.y, wp.x - fpv.x);
    let diff = target - fpv.angle;
    while (diff > Math.PI) diff -= Math.PI*2;
    while (diff < -Math.PI) diff += Math.PI*2;
    // Phase X — turn-rate floor raised so the maxed-out drone can still
    // correct course before slamming a wall. Was 0.025 at full ramp →
    // now 0.050. Launch rate also slightly higher (0.075 → 0.085) for
    // crisper initial steering. Trade-off: drone feels less like a
    // "committed missile" but user '太難操控' wins over realism.
    const turnRate = 0.085 - 0.035 * _rampT;
    fpv.angle += diff * turnRate;
  }
  // Phase 9: speed ramps from FPV_SPEED_START → FPV_SPEED_MAX over
  // FPV_RAMP_TICKS frames, so the launch is controllable and the
  // committed dive ramps up later. Eased linearly for simplicity.
  fpv.speed = FPV_SPEED_START + (FPV_SPEED_MAX - FPV_SPEED_START) * _rampT;
  fpv.x += Math.cos(fpv.angle) * fpv.speed;
  fpv.y += Math.sin(fpv.angle) * fpv.speed;
  fpv.trail.push({ x: fpv.x, y: fpv.y, life: 25 });
  for (let i = fpv.trail.length-1; i >= 0; i--) {
    fpv.trail[i].life--;
    if (fpv.trail[i].life <= 0) fpv.trail.splice(i, 1);
  }
  // User '自殺式無人機要像是Q無人機一樣不受牆壁限制 要靠撞到人或是空白鍵':
  // FPV passes through walls / buildings / overheads like the UAV — only
  // a person-hit OR manual SPACE detonate ends the run. World bounds clamp
  // (like UAV) instead of detonating, so the drone can't fly off forever.
  let exploded = false;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (Math.hypot(fpv.x-e.x, fpv.y-e.y) < e.radius+10) { exploded = true; break; }
  }
  if (!exploded) for (const d of enemyDrones) {
    if (!d.alive) continue;
    if (Math.hypot(fpv.x-d.x, fpv.y-d.y) < d.radius+10) { exploded = true; break; }
  }
  // MP hit: enemy server bots (team 1) + remote humans. Without this the
  // FPV is useless online — would fly past MP targets and only trigger on
  // SPACE. Damage still propagates via _mpBroadcastExplosion → server AOE.
  if (!exploded && typeof _mpState !== 'undefined' && _mpState.enabled) {
    if (_mpState.remoteBots) {
      for (const rb of _mpState.remoteBots.values()) {
        if (!rb.alive || rb.team === 0) continue;
        if (Math.hypot(fpv.x-rb.x, fpv.y-rb.y) < (rb.radius || 14)+10) { exploded = true; break; }
      }
    }
    if (!exploded && _mpState.remotePlayers) {
      for (const [pid, rp] of _mpState.remotePlayers) {
        if (!rp || !rp.alive || pid === _mpState.myId) continue;
        if (Math.hypot(fpv.x-rp.x, fpv.y-rp.y) < (rp.radius || 14)+10) { exploded = true; break; }
      }
    }
  }
  if (fpv.x < 20) fpv.x = 20;
  if (fpv.x > WORLD.w-20) fpv.x = WORLD.w-20;
  if (fpv.y < 20) fpv.y = 20;
  if (fpv.y > WORLD.h-20) fpv.y = WORLD.h-20;
  if (exploded) _detonateFPV(false);
}

// Phase 9: shared FPV detonation path. `manual=true` when triggered by the
// space-key handler (lets the player blow up early on demand without
// needing an impact condition).
function _detonateFPV(manual) {
  if (!fpv.active) return;
  // Phase 110d — escalated from 'big' → 'huge' (140-radius blast,
  // 120 AOE dmg, also vaporises any player-built structures inside the
  // radius). User: '自殺無人機的爆炸半徑更大, 範圍更廣, 傷害更強, 也
  // 可以摧毀建築物'.
  createExplosion(fpv.x, fpv.y, 'huge');
  if (typeof triggerShake === 'function') triggerShake(8);
  // Phase 111 — boom audio kind (sub-bass sweep + crash + debris tail).
  if (typeof emitSound === 'function') emitSound(fpv.x, fpv.y, 1700, false, false, null, 'boom');
  fpv.active = false;
  if (game.mode === 'fpv') game.mode = 'tactical';
  showMessage(T(`FPV ${manual ? '手動引爆' : '命中'} · 剩余 ${fpv.available}`,
                `FPV ${manual ? 'MANUAL DETONATE' : 'HIT'} · ${fpv.available} left`), 60);
}
