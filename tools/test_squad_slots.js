// AshGrid squad-slot roster test (Phase 184f) — guards getSquadSlots in
// js/hud.js, the single MP-aware roster behind the user's squad complaints
// ('最多上線就是五個', '隊友存在但槽位只有一個', the 2+-human over-count).
//
// Invariants:
//   • SOLO: counts live allies[], capped at ARENA_SQUAD_CAP-1 (you + 4 = 5);
//   • MP: counts ONLY my recruits — a team-0 bot whose _recruitedBy is another
//     player's id, or the un-recruited neutral team-0 spawns (rby 0), are
//     EXCLUDED (this is the 184f fix: the server now serializes _recruitedBy so
//     the filter stops falling through to 'all team-0');
//   • MP back-compat: if _recruitedBy is missing (pre-184f server/peer), fall
//     back to counting team-0 (don't hide the squad entirely);
//   • dead members never counted; the cap holds in both modes.
//
// Loads hud.js in a vm with a permissive sandbox (only the few globals
// getSquadSlots reads are meaningful). Run by the pre-commit hook + CI gate.
//   node tools/test_squad_slots.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'hud.js'), 'utf8');

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); };

// Build a sandbox where getSquadSlots sees the given MP/SOLO state. Unknown
// globals resolve to undefined (Proxy) so the rest of hud.js loads without a
// full browser. ARENA_SQUAD_CAP=5 → maxMembers=4.
function load(over) {
  const base = {
    Math, JSON, Date, console, isNaN, isFinite, parseInt, parseFloat,
    Object, Array, String, Number, Boolean,
    ARENA_SQUAD_CAP: 5,
    _mpIsActive: () => false,
    _mpState: null,
    allies: undefined,
  };
  Object.assign(base, over || {});
  const sb = new Proxy(base, {
    has: () => true,
    get: (t, k) => (k in t ? t[k] : undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  vm.runInContext(src, vm.createContext(sb));
  return sb;
}

console.log('Squad-slot roster test — getSquadSlots (hud.js):');

// 0. loads + exported
{
  const sb = load();
  check(typeof sb.getSquadSlots === 'function', 'hud.js loads + getSquadSlots defined');
}

// 1. SOLO: counts live allies, caps at 4 (you+4=5), skips dead.
{
  const allies = [
    { alive: true, hp: 80, maxHp: 100 },
    { alive: false, hp: 0, maxHp: 100 },   // dead → skip
    { alive: true, hp: 50, maxHp: 100 },
  ];
  const sb = load({ _mpIsActive: () => false, allies });
  const out = sb.getSquadSlots();
  check(out.length === 2, 'SOLO: 2 live allies counted (dead skipped) — got ' + out.length);
  check(out[0].allyIdx === 0 && out[1].allyIdx === 2, 'SOLO: entries carry real allies index for pawn-swap');
}

// 2. SOLO cap: 6 live allies → capped at 4.
{
  const allies = Array.from({ length: 6 }, () => ({ alive: true, hp: 100, maxHp: 100 }));
  const sb = load({ _mpIsActive: () => false, allies });
  check(sb.getSquadSlots().length === 4, 'SOLO: capped at ARENA_SQUAD_CAP-1 = 4');
}

// 3. MP: count only MY recruits. mine=2, teammate's=1, neutral(rby 0)=1.
{
  const ME = 'conn-me', MATE = 'conn-mate';
  const remoteBots = new Map(Object.entries({
    a: { alive: true, team: 0, hp: 90, maxHp: 100, _recruitedBy: ME },
    b: { alive: true, team: 0, hp: 70, maxHp: 100, _recruitedBy: MATE },  // teammate's → exclude
    c: { alive: true, team: 0, hp: 60, maxHp: 100, _recruitedBy: ME },
    d: { alive: true, team: 0, hp: 50, maxHp: 100, _recruitedBy: 0 },     // neutral spawn → exclude
    e: { alive: true, team: 1, hp: 50, maxHp: 100, _recruitedBy: 0 },     // enemy → exclude
    f: { alive: false, team: 0, hp: 0, maxHp: 100, _recruitedBy: ME },    // my dead recruit → exclude
  }));
  const sb = load({ _mpIsActive: () => true, _mpState: { myId: ME, remoteBots } });
  const out = sb.getSquadSlots();
  check(out.length === 2, 'MP: only MY 2 live recruits counted (teammate/neutral/enemy/dead excluded) — got ' + out.length);
  check(out.every(s => s.allyIdx === undefined), 'MP: entries omit allyIdx (server-owned, no pawn-swap)');
}

// 4. MP back-compat: pre-184f peers omit _recruitedBy → fall back to team-0.
{
  const remoteBots = new Map(Object.entries({
    a: { alive: true, team: 0, hp: 90, maxHp: 100 },   // no _recruitedBy
    b: { alive: true, team: 0, hp: 70, maxHp: 100 },
    c: { alive: true, team: 1, hp: 70, maxHp: 100 },   // enemy → still excluded by team
  }));
  const sb = load({ _mpIsActive: () => true, _mpState: { myId: 'conn-me', remoteBots } });
  check(sb.getSquadSlots().length === 2, 'MP back-compat: missing _recruitedBy → counts team-0 (no squad blackout)');
}

// 5. MP cap holds: 9 of my recruits → capped at 4.
{
  const ME = 'conn-me';
  const remoteBots = new Map(
    Array.from({ length: 9 }, (_, i) => [String(i), { alive: true, team: 0, hp: 100, maxHp: 100, _recruitedBy: ME }])
  );
  const sb = load({ _mpIsActive: () => true, _mpState: { myId: ME, remoteBots } });
  check(sb.getSquadSlots().length === 4, 'MP: capped at 4 recruits (you+4=5)');
}

if (problems.length === 0) { console.log('OK — squad roster: SOLO + MP-recruits-only filter + cap all hold.'); process.exit(0); }
console.error('\nFAIL — squad roster broken:');
for (const p of problems) console.error('  ✗ ' + p);
process.exit(1);
