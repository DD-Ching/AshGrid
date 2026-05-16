// ============ DRONE / FPV CONTROL ============
// Q = toggle UAV (recon drone, shared vision), E = launch FPV (kamikaze
// drone), R = start reload. The drone / fpv state objects live in the
// main script's STATE section; these functions drive their lifecycle.
//
// Classic-script. Declares globally:
//   toggleDrone() · launchFPV() · startReload()
//
// External deps: drone · fpv · player · playerWeapon · mouse ·
//   screenToWorld · playSfx · createExplosion

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
