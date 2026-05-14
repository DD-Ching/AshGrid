// ============================================================
// Phase 2 — Sim module smoke test (Node-runnable).
// ============================================================
//
// Run:  node ai_arena/scripts/test_sim.mjs
//
// Exercises server/party/sim/*.js modules directly (ESM imports).
// The client-side mirrors (js/sim/*.js classic scripts) are diffed
// for parity by ai_arena/scripts/check_sim_parity.sh, so this test
// covers them transitively — if it passes here AND parity passes,
// the browser side has equivalent behaviour.
//
// Goals:
//   1. Each weapon's bullet spawns at the muzzle in the right direction.
//   2. advanceBullet integrates position + decrements life deterministically.
//   3. bulletVsCircle correctly detects hits on a stationary target.
//   4. SHOTGUN spawns the right number of pellets with bounded spread.
//   5. SNIPER deals 100 damage (one-shot rule).
//   6. ROCKET carries isRocket + blastR + blastDmg fields.
//   7. simStepPerTick honours sprint × wMul × cMul (regression guard).

import * as bullet from '../../server/party/sim/bullet.js';
import * as weapons from '../../server/party/sim/weapons.js';
import * as movement from '../../server/party/sim/movement.js';
import * as constants from '../../server/party/sim/constants.js';

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failed++;
  }
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

console.log('--- constants -----------------------------------------------');
assert(constants.PLAYER_SPEED_PER_TICK === 5.6,        'PLAYER_SPEED_PER_TICK=5.6');
assert(constants.PLAYER_SPEED_PER_FRAME === 2.8,       'PLAYER_SPEED_PER_FRAME=2.8');
assert(constants.SPRINT_SPEED_MUL === 1.65,            'SPRINT_SPEED_MUL=1.65');
assert(constants.FRAMES_PER_TICK === 2,                'FRAMES_PER_TICK=2 (60fps / 30Hz)');
assert(constants.PLAYER_RADIUS === 14,                 'PLAYER_RADIUS=14');

console.log('\n--- weapons -------------------------------------------------');
for (const id of ['SMG', 'RIFLE', 'LMG', 'SNIPER', 'SHOTGUN', 'ROCKET']) {
  const w = weapons.getWeaponSim(id);
  assert(w && typeof w.damage === 'number', `${id} has a damage value`);
  assert(typeof w.bulletSpeed === 'number',  `${id} has bulletSpeed`);
  assert(typeof w.bulletLife === 'number',   `${id} has bulletLife`);
  assert(typeof w.fireCdTicks === 'number',  `${id} has fireCdTicks`);
}
assert(weapons.getWeaponSim('SNIPER').damage === 100, 'SNIPER damage = 100 (one-shot rule)');
assert(weapons.getWeaponSim('SHOTGUN').pellets === 11, 'SHOTGUN pellets = 11');
assert(weapons.getWeaponSim('ROCKET').isRocket === true, 'ROCKET.isRocket = true');
assert(weapons.getWeaponSim('ROCKET').blastR === 110, 'ROCKET.blastR = 110');
assert(weapons.getWeaponSim('NONEXISTENT').damage === weapons.getWeaponSim('RIFLE').damage,
       'unknown weapon id falls back to RIFLE');

console.log('\n--- bullet spawn ------------------------------------------');
// Aim east (+X). Bullet should fly east. Pellets count matches weapon.
const rifle = { ...weapons.getWeaponSim('RIFLE'), weaponId: 'RIFLE' };
const shooter = { x: 100, y: 200, id: 1, team: 0 };
const bs1 = bullet.spawnBulletsFromUnit(shooter, rifle, 0);
assert(bs1.length === 1,                                'RIFLE spawns 1 bullet');
assert(bs1[0].vx > 0 && near(bs1[0].vy, 0, 1e-3),        'RIFLE bullet flies +X when angle=0');
assert(bs1[0].life === rifle.bulletLife,                 'RIFLE bullet inherits weapon bulletLife');
assert(bs1[0].damage === rifle.damage,                   'RIFLE bullet inherits weapon damage');
assert(bs1[0].weaponId === 'RIFLE',                      'RIFLE bullet carries weaponId');
assert(bs1[0].x > shooter.x,                             'RIFLE bullet spawns ahead of shooter');

const shotgun = { ...weapons.getWeaponSim('SHOTGUN'), weaponId: 'SHOTGUN' };
const bs2 = bullet.spawnBulletsFromUnit(shooter, shotgun, 0);
assert(bs2.length === 11,                                'SHOTGUN spawns 11 pellets');
// All pellets fly roughly east, but with per-pellet jitter inside ±spread/2.
let maxAng = 0;
for (const p of bs2) {
  const a = Math.atan2(p.vy, p.vx);
  if (Math.abs(a) > maxAng) maxAng = Math.abs(a);
}
assert(maxAng <= shotgun.spread / 2 + 1e-6,             `SHOTGUN pellet jitter ≤ spread/2 (max=${maxAng.toFixed(4)})`);

const rocket = { ...weapons.getWeaponSim('ROCKET'), weaponId: 'ROCKET' };
const bs3 = bullet.spawnBulletsFromUnit(shooter, rocket, 0);
assert(bs3.length === 1,                                 'ROCKET spawns 1 projectile');
assert(bs3[0].isRocket === true,                         'ROCKET projectile carries isRocket');

console.log('\n--- bullet step --------------------------------------------');
const b4 = bullet.spawnBulletsFromUnit({ x: 0, y: 0, id: 1, team: 0 },
                                      { ...rifle, weaponId: 'RIFLE' }, 0)[0];
const startX = b4.x;
const startLife = b4.life;
bullet.advanceBullet(b4, 1);
assert(near(b4.x - startX, rifle.bulletSpeed, 1e-6),     `advanceBullet(1) moves by bulletSpeed (${rifle.bulletSpeed})`);
assert(b4.life === startLife - 1,                         'advanceBullet(1) decrements life by 1');
bullet.advanceBullet(b4, 0.5);
assert(near(b4.life, startLife - 1.5, 1e-6),              'advanceBullet(0.5) is fractional');

console.log('\n--- bullet vs circle ---------------------------------------');
// Bullet at (100, 200) with vx=10 vy=0 (so prev was 90,200). Target circle
// at (95, 200) r=14 — segment-vs-circle should report hit.
const bHit = { x: 100, y: 200, vx: 10, vy: 0, life: 30 };
assert(bullet.bulletVsCircle(bHit, 95, 200, 14) === true,  'bulletVsCircle: hit when target is on segment');
// Target 50 units below — should miss.
assert(bullet.bulletVsCircle(bHit, 95, 250, 14) === false, 'bulletVsCircle: miss when far off-segment');
// Glancing hit at the edge of the segment.
assert(bullet.bulletVsCircle(bHit, 102, 200, 14) === true, 'bulletVsCircle: hit ahead of bullet within radius');

console.log('\n--- bullet vs AABB -----------------------------------------');
assert(bullet.bulletVsAABB({ x: 50, y: 50 }, 40, 40, 20, 20) === true, 'bulletVsAABB: inside');
assert(bullet.bulletVsAABB({ x: 10, y: 10 }, 40, 40, 20, 20) === false, 'bulletVsAABB: outside');

console.log('\n--- movement (sprint × mul regression guard) --------------');
// At rest, full input W (dy=-1), no sprint, no muls → 5.6 px/tick north.
const m1 = movement.simStepPerTick({ x: 0, y: 0, weaponSpeedMul: 1, chassisSpeedMul: 1 },
                                   { dx: 0, dy: -1, sprint: 0 });
assert(near(m1.x, 0) && near(m1.y, -5.6),                'plain N step = -5.6 y');
// With sprint, 5.6 × 1.65 = 9.24.
const m2 = movement.simStepPerTick({ x: 0, y: 0, weaponSpeedMul: 1, chassisSpeedMul: 1 },
                                   { dx: 0, dy: -1, sprint: 1 });
assert(near(m2.y, -9.24, 1e-6),                          'sprint N step = -9.24 y');
// With wolf chassis (1.5) + sprint, 5.6 × 1.5 × 1.65 = 13.86.
const m3 = movement.simStepPerTick({ x: 0, y: 0, weaponSpeedMul: 1, chassisSpeedMul: 1.5 },
                                   { dx: 0, dy: -1, sprint: 1 });
assert(near(m3.y, -13.86, 1e-6),                         'wolf+sprint N step = -13.86 y');
// Heavy chassis (0.72) + LMG (0.85) + sprint: 5.6 × 0.72 × 0.85 × 1.65.
const m4 = movement.simStepPerTick({ x: 0, y: 0, weaponSpeedMul: 0.85, chassisSpeedMul: 0.72 },
                                   { dx: 0, dy: -1, sprint: 1 });
assert(near(m4.y, -5.65488, 1e-5),                       'heavy+LMG+sprint N step ≈ -5.655 y');
// Diagonal NE input normalises to unit length.
const m5 = movement.simStepPerTick({ x: 0, y: 0, weaponSpeedMul: 1, chassisSpeedMul: 1 },
                                   { dx: 1, dy: -1, sprint: 0 });
const speed = Math.hypot(m5.x, m5.y);
assert(near(speed, 5.6, 1e-6),                           'diagonal step magnitude == per-tick speed');

console.log('\n=============================================================');
if (failed === 0) {
  console.log('✓ All sim tests passed.');
  process.exit(0);
} else {
  console.log(`✗ ${failed} assertion(s) failed.`);
  process.exit(1);
}
