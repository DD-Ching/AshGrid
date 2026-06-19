// AshGrid wolf-frenzy test (Phase 188N) — guards js/wolf_frenzy.js, the killstreak
// "越殺越強" buff (wolfFrenzySteps / wolfFrenzySpeedMul / wolfFrenzyFireCdMul).
//
// Why a test (tools/CLAUDE.md): wolf_frenzy is a flag-GUARDED behaviour (game._classes
// + wolf + alive + SOLO), and its whole contract is "return the identity (0 steps / 1.0
// mul) whenever the buff must not apply, so the old path stays byte-identical". That
// contract has no other guard. Invariants asserted:
//   • IDENTITY (steps 0, speedMul 1, fireCdMul 1) when: classes off · not wolf · dead ·
//     MP (_mpIsActive) · no combo (streak ≤ 1) · streak window LAPSED (decay).
//   • SCALING: steps = clamp(killStreak-1, 0, frenzyMaxSteps); speedMul = 1+steps·step;
//     fireCdMul = max(1-steps·fireStep, fireFloor) — all read from BALANCE.wolf.
//   • DECAY: a stale streak (game.time - _lastKillTick ≥ KS_WINDOW) yields 0 steps even
//     when _killStreak is still high (the buff fades when you stop killing).
//   • The four frenzy tunables actually exist in js/balance.js (single-source guard).
//
// Loads wolf_frenzy.js in a vm with a permissive sandbox, feeding the REAL tunable
// values parsed out of js/balance.js. Run by the pre-commit hook + CI gate.
//   node tools/test_wolf_frenzy.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'wolf_frenzy.js'), 'utf8');
const balSrc = fs.readFileSync(path.join(ROOT, 'js', 'balance.js'), 'utf8');

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// Parse the real frenzy tunables from balance.js so the test tracks the single source.
function bal(key) {
  const m = balSrc.match(new RegExp(key + ':\\s*([0-9.]+)'));
  return m ? parseFloat(m[1]) : undefined;
}
const WOLF = {
  frenzyMaxSteps:  bal('frenzyMaxSteps'),
  frenzySpeedStep: bal('frenzySpeedStep'),
  frenzyFireStep:  bal('frenzyFireStep'),
  frenzyFireFloor: bal('frenzyFireFloor'),
};
const KS_WINDOW = 240;

// Build a sandbox where the helpers see the given game/player/MP state. window points
// at the sandbox so `window.X = …` exports land where we can read them back.
function load(over) {
  const base = {
    Math, JSON, console, Object, Array, Number, Boolean,
    KS_WINDOW,
    BALANCE: { wolf: Object.assign({}, WOLF) },
    _mpIsActive: () => false,
    game: { _classes: true, time: 1000 },
    player: { _chassis: 'wolf', alive: true, _killStreak: 0, _lastKillTick: 1000 },
  };
  if (over) {
    if (over.game)   Object.assign(base.game, over.game);
    if (over.player) Object.assign(base.player, over.player);
    if (over._mpIsActive) base._mpIsActive = over._mpIsActive;
    if ('BALANCE' in over) base.BALANCE = over.BALANCE;   // honor an explicit undefined
  }
  const sb = new Proxy(base, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  base.window = sb;
  vm.runInContext(src, vm.createContext(sb));
  return sb;
}

console.log('Wolf-frenzy test — js/wolf_frenzy.js:');

// 0. balance.js single-source: the four tunables exist + are sane.
check(WOLF.frenzyMaxSteps > 0 && WOLF.frenzySpeedStep > 0 && WOLF.frenzyFireStep > 0
      && WOLF.frenzyFireFloor > 0 && WOLF.frenzyFireFloor <= 1,
      'balance.js defines frenzyMaxSteps/SpeedStep/FireStep/FireFloor (single source)');

// 1. loads + exports the three globals.
{
  const sb = load();
  check(typeof sb.wolfFrenzySteps === 'function'
     && typeof sb.wolfFrenzySpeedMul === 'function'
     && typeof sb.wolfFrenzyFireCdMul === 'function',
     'wolf_frenzy.js loads + exports steps/speedMul/fireCdMul');
}

// Helper: assert a sandbox is in full IDENTITY (no buff).
function expectIdentity(sb, label) {
  check(sb.wolfFrenzySteps() === 0, label + ': steps 0');
  check(sb.wolfFrenzySpeedMul() === 1, label + ': speedMul 1.0');
  check(sb.wolfFrenzyFireCdMul() === 1, label + ': fireCdMul 1.0');
}

// 2. full streak in-window → full frenzy (this is the ON baseline the rest contrasts).
{
  const sb = load({ player: { _killStreak: 7, _lastKillTick: 1000 }, game: { time: 1000 } });
  const expSteps = WOLF.frenzyMaxSteps;                                   // clamp(7-1, .., 6) = 6
  const expSpeed = 1 + expSteps * WOLF.frenzySpeedStep;
  const expFire  = Math.max(WOLF.frenzyFireFloor, 1 - expSteps * WOLF.frenzyFireStep);
  check(sb.wolfFrenzySteps() === expSteps, 'streak 7 → steps clamped to frenzyMaxSteps (' + expSteps + ')');
  check(near(sb.wolfFrenzySpeedMul(), expSpeed), 'streak 7 → speedMul = ' + expSpeed.toFixed(3));
  check(near(sb.wolfFrenzyFireCdMul(), expFire), 'streak 7 → fireCdMul = ' + expFire.toFixed(3) + ' (floored)');
}

// 3. mid streak in-window → partial scaling.
{
  const sb = load({ player: { _killStreak: 3, _lastKillTick: 1000 }, game: { time: 1000 } });
  check(sb.wolfFrenzySteps() === 2, 'streak 3 → 2 steps');
  check(near(sb.wolfFrenzySpeedMul(), 1 + 2 * WOLF.frenzySpeedStep), 'streak 3 → speedMul = ' + (1 + 2 * WOLF.frenzySpeedStep).toFixed(3));
  check(near(sb.wolfFrenzyFireCdMul(), 1 - 2 * WOLF.frenzyFireStep), 'streak 3 → fireCdMul = ' + (1 - 2 * WOLF.frenzyFireStep).toFixed(3));
}

// 4. IDENTITY — no combo yet (streak 1 → 0 steps).
expectIdentity(load({ player: { _killStreak: 1, _lastKillTick: 1000 }, game: { time: 1000 } }), 'streak 1');

// 5. IDENTITY — classes OFF (byte-identical for the legacy / classes-off path).
expectIdentity(load({ game: { _classes: false, time: 1000 }, player: { _killStreak: 7, _lastKillTick: 1000 } }), 'classes off');

// 6. IDENTITY — not the wolf chassis (chassis-exclusive).
expectIdentity(load({ player: { _chassis: 'heavy', _killStreak: 7, _lastKillTick: 1000 } }), 'heavy chassis');

// 7. IDENTITY — dead.
expectIdentity(load({ player: { alive: false, _killStreak: 7, _lastKillTick: 1000 } }), 'dead');

// 8. IDENTITY — MP (server-authoritative; client buff must be inert online).
expectIdentity(load({ _mpIsActive: () => true, player: { _killStreak: 7, _lastKillTick: 1000 } }), 'MP active');

// 9. DECAY — high streak but the 4 s window has lapsed → 0 steps (buff fades).
{
  const sb = load({ player: { _killStreak: 7, _lastKillTick: 1000 }, game: { time: 1000 + KS_WINDOW } });
  expectIdentity(sb, 'streak window lapsed');
}

// 10. boundary — exactly at the window edge still decays (>= KS_WINDOW), one tick inside does not.
{
  const lapsed = load({ player: { _killStreak: 7, _lastKillTick: 1000 }, game: { time: 1000 + KS_WINDOW } });
  check(lapsed.wolfFrenzySteps() === 0, 'window edge (Δ === KS_WINDOW) → decayed to 0');
  const inside = load({ player: { _killStreak: 7, _lastKillTick: 1000 }, game: { time: 1000 + KS_WINDOW - 1 } });
  check(inside.wolfFrenzySteps() === WOLF.frenzyMaxSteps, 'one tick inside window → still full frenzy');
}

// 11. IDENTITY — BALANCE absent (no tunables → graceful no-op, no NaN).
{
  const sb = load({ BALANCE: undefined, player: { _killStreak: 7, _lastKillTick: 1000 } });
  expectIdentity(sb, 'BALANCE missing');
}

if (problems.length === 0) { console.log('OK — wolf frenzy: identity-when-off, scaling, decay all hold.'); process.exit(0); }
console.error('\nFAIL — wolf frenzy broken:');
for (const p of problems) console.error('  ✗ ' + p);
process.exit(1);
