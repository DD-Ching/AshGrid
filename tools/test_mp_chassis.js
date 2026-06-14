// AshGrid MP chassis-damage parity test (Phase 184e) — guards the server's
// _applyChassisDamage, the authoritative mirror of the client js/chassis.js
// _applyDamageToUnit. The server was chassis-blind on DEFENCE (flat dmg → hp),
// so a heavy's armour buffer and a wolf's dash damage-cut were SOLO-only — the
// same '多人跟單人不同步' class of bug as the pre-184e-1 HP cap.
//
// Invariants (must match chassis.js exactly):
//   • non-heavy, non-dashing → FULL damage to hp (byte-identical to `hp -= dmg`);
//   • wolf DASH (input.dashActive) → incoming damage ×0.30, BEFORE armour/HP;
//   • heavy ARMOUR > 0 → drains armour first; overflow bleeds to hp at 0.65;
//   • heavy ARMOUR = 0 → damage bleeds to hp at 0.65 (still tankier than humanoid);
//   • DASH then ARMOUR compose (dash cut applies, then the armour buffer).
//
// Pure rule, imported from the REAL server module (ESM) — no room/socket needed.
//   node tools/test_mp_chassis.js
(async () => {
  const problems = [];
  const approx = (a, b) => Math.abs(a - b) < 1e-9;
  const check = (cond, msg) => { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); };

  console.log('MP chassis-damage parity test — _applyChassisDamage (server):');

  let dmgFn, gateFn;
  try {
    const mod = await import('../server/party/server.js');
    dmgFn = mod._applyChassisDamage;
    gateFn = mod._recruitGateOk;
  } catch (e) {
    console.error('FAIL — could not import server module:', e && e.message);
    process.exit(1);
  }
  check(typeof dmgFn === 'function', '_applyChassisDamage exported from server.js');
  if (typeof dmgFn !== 'function') { process.exit(1); }

  const BLEED = 0.65, DASH = 0.30;
  // mk(maxArmor, armor, dash) → a fake server player at full hp 100/180.
  const mk = (maxArmor = 0, armor = 0, dash = 0, hp = 100) =>
    ({ hp, maxHp: hp, maxArmor, armor, _armorLastHurtTick: -999, alive: true, input: { dashActive: dash } });

  // 1) humanoid: full damage, no armour touched.
  let p = mk(0, 0, 0);
  let dealt = dmgFn(p, 25, 1000);
  check(approx(p.hp, 75) && approx(dealt, 25), 'humanoid: 25 dmg → hp 75, full damage (legacy identity)');

  // 2) wolf dash: 100 dmg → 30 effective on hp.
  p = mk(0, 0, 1);
  dmgFn(p, 100, 1000);
  check(approx(p.hp, 70), 'wolf dash: 100 dmg → 30 to hp (×0.30), hp 70');

  // 3) heavy armour absorb (no bleed): 40 dmg vs 60 armour → armour 20, hp full.
  p = mk(60, 60, 0, 180);
  dmgFn(p, 40, 1000);
  check(approx(p.armor, 20) && approx(p.hp, 180), 'heavy: 40 dmg fully absorbed by armour (armour 60→20, hp 180)');

  // 4) heavy armour overflow bleed: armour 20, take 50 → 20 absorbed, 30 overflow
  //    bleeds 0.65 = 19.5 hp.
  dmgFn(p, 50, 1001);
  check(approx(p.armor, 0) && approx(p.hp, 180 - 30 * BLEED),
    'heavy: overflow past armour bleeds 0.65 (armour→0, hp 180→' + (180 - 30 * BLEED) + ')');

  // 5) heavy armour depleted: further 10 dmg bleeds 0.65 = 6.5 hp (no armour left).
  const hpBefore = p.hp;
  dmgFn(p, 10, 1002);
  check(approx(p.hp, hpBefore - 10 * BLEED), 'heavy: armour=0 still bleeds 0.65 (10 dmg → 6.5 hp)');

  // 6) dash + heavy compose: dash cuts 100→30 first, then armour 60 absorbs all 30.
  p = mk(60, 60, 1, 180);
  dmgFn(p, 100, 1000);
  check(approx(p.armor, 30) && approx(p.hp, 180),
    'dash+heavy compose: 100 →(dash) 30 →(armour) armour 60→30, hp untouched');

  // 7) records last-hurt tick on a heavy hit (drives the regen delay).
  p = mk(60, 60, 0, 180);
  dmgFn(p, 10, 4242);
  check(p._armorLastHurtTick === 4242, 'heavy hit stamps _armorLastHurtTick (regen delay clock)');

  // 8) guards: zero / negative / null damage are no-ops.
  p = mk(0, 0, 0);
  check(dmgFn(p, 0, 1) === 0 && p.hp === 100, 'zero damage → no-op');
  check(dmgFn(p, -5, 1) === 0 && p.hp === 100, 'negative damage → no-op');
  check(dmgFn(null, 25, 1) === 0, 'null player → no-op (no throw)');

  // ── Phase 184g — _recruitGateOk (HP/SEED eligibility, both regimes) ──
  check(typeof gateFn === 'function', '_recruitGateOk exported from server.js');
  if (typeof gateFn === 'function') {
    // classes-on humanoid (builder): weaker-than-me wins, SEED irrelevant.
    check(gateFn(true, 40, 100, 100, 0) === true,  'classes: bot weaker than me (40<100) → recruitable, SEED ignored');
    check(gateFn(true, 100, 100, 100, 0) === false, 'classes: bot equal hp (100<100 false) → rejected');
    check(gateFn(true, 90, 100, 100, 999) === true, 'classes: high SEED irrelevant — only hp matters');
    check(gateFn(true, 80, 100, 70, 999) === false, 'classes: bot stronger than my current hp (80<70 false) → rejected');
    // legacy: wounded < 50% AND SEED > gap (ARENA_SEED_GAP=10).
    check(gateFn(false, 40, 100, 100, 20) === true,  'legacy: wounded<50% (40) + SEED 20 → recruitable');
    check(gateFn(false, 60, 100, 100, 20) === false, 'legacy: not wounded enough (60>=50) → rejected');
    check(gateFn(false, 40, 100, 100, 10) === false, 'legacy: SEED == gap (10) → rejected (strict >)');
    check(gateFn(false, 40, 100, 100, 0) === false,  'legacy: SEED 0 (a bot recruiting) → rejected');
  }

  if (problems.length === 0) { console.log('OK — MP chassis-damage routing matches client chassis.js (armour + dash + bleed) + recruit gate.'); process.exit(0); }
  console.error('\nFAIL — MP chassis-damage rule broken:');
  for (const pr of problems) console.error('  ✗ ' + pr);
  process.exit(1);
})();
