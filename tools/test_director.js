// AshGrid adaptive-director smoke test (Phase 176) — guards the SOLO one-way DDA
// in js/adaptive_director.js. The whole point of the feature is "只往上,越強越
// 聰明,不會變簡單", so the load-bearing invariant is: at baseline it is a no-op
// (byte-identical spawns), and it can only ever UPGRADE — never make a spawn
// easier than its roll. This test loads the real module in a vm and asserts that.
//
// Self-contained (no browser/network).  node tools/test_director.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'adaptive_director.js'), 'utf8');
const HIGH = ['elite', 'sharpshooter', 'warrior'];
const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); };

// Build a sandbox; capture the onUnitDeath callback the module registers at load.
function load(over) {
  let deathCb = null;
  const sb = {
    window: {}, Math, console: { log() {} },
    game: { _nnMode: true, time: 0 },        // SOLO NN mode, fixed time (no decay)
    player: { team: 0 },
    _mpState: { enabled: false },
    WEAPONS: { LMG: {}, SNIPER: {}, RIFLE: {} },
    onUnitDeath: (cb) => { deathCb = cb; },
  };
  Object.assign(sb, over || {});
  vm.runInContext(src, vm.createContext(sb));
  return { sb, death: (u) => deathCb && deathCb(u), api: sb.window };
}

console.log('Adaptive-director smoke test — one-way SOLO DDA:');

// 0. Exports present.
{
  const { api } = load();
  check(typeof api.directorPickStyle === 'function', 'directorPickStyle exported');
  check(typeof api.directorPickWeapon === 'function', 'directorPickWeapon exported');
  check(typeof api.directorHeat === 'function', 'directorHeat exported');
}

// 1. Baseline (heat 0): byte-identical to old spawn — always returns the default.
{
  const { api } = load();
  check(api.directorHeat() === 0, 'fresh heat is 0 (baseline)');
  let allDefault = true;
  for (let i = 0; i < 200; i++) if (api.directorPickStyle('elite') !== 'elite') allDefault = false;
  check(allDefault, 'heat 0 → directorPickStyle ALWAYS returns the passed default (no-op)');
  check(api.directorPickStyle(null) === null, 'heat 0 → null default stays null (wave bots unchanged)');
  check(api.directorPickWeapon('humanoid', 'elite', 'RIFLE') === 'RIFLE', 'heat 0 → weapon unchanged');
}

// 2. Dominating → heat rises and saturates; every pick then UPGRADES.
{
  const { api, death } = load();
  for (let i = 0; i < 10; i++) death({ team: 1 });   // 10 enemy kills × 0.12 → clamps to 1
  check(api.directorHeat() === 1, 'enough enemy kills saturate heat to 1');
  let allHigh = true;
  for (let i = 0; i < 200; i++) if (!HIGH.includes(api.directorPickStyle('elite'))) allHigh = false;
  check(allHigh, 'heat 1 → every override is a HIGH (smart) style — never easier');
  // one-way proof: the override set is exactly the smart styles, never defensive/cqb
  const seen = new Set(); for (let i = 0; i < 500; i++) seen.add(api.directorPickStyle('elite'));
  check([...seen].every(s => HIGH.includes(s)), 'overrides ⊆ {elite,sharpshooter,warrior} (never downgrades)');
}

// 3. Player death bleeds heat back toward baseline, but never below 0 (one-way floor).
{
  const { api, death } = load();
  for (let i = 0; i < 10; i++) death({ team: 1 });   // heat → 1
  death({ team: 0, __isPlayer: true });               // not the player ref → ally bleed
  const { sb, death: d2, api: a2 } = load();
  for (let i = 0; i < 10; i++) d2({ team: 1 });
  d2(sb.player);                                       // the actual player object → big bleed
  check(a2.directorHeat() < 1 && a2.directorHeat() > 0, 'player death bleeds heat below max but above 0');
  for (let i = 0; i < 20; i++) d2(sb.player);          // pile on deaths
  check(a2.directorHeat() === 0, 'heat floors at 0 — never negative (baseline is the easiest it gets)');
}

// 4. MP / non-SOLO → fully disabled (no-op) regardless of heat.
{
  const { sb, api, death } = load({ _mpState: { enabled: true } });
  for (let i = 0; i < 10; i++) death({ team: 1 });
  check(api.directorPickStyle('elite') === 'elite', 'MP (_mpState.enabled) → director is a no-op');
  sb.game._nnMode = false;
  check(api.directorPickStyle('cqb') === 'cqb', 'non-NN mode → director is a no-op');
}

if (problems.length === 0) { console.log('OK — adaptive director is baseline-safe and strictly one-way.'); process.exit(0); }
console.error('\nFAIL — director invariant broken:');
for (const p of problems) console.error('  ✗ ' + p);
process.exit(1);
