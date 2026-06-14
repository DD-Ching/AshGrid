// AshGrid NPC-director smoke test (Phase 182) — guards js/npc_director.js, the
// additive believability layer (separation/edge-repulsion, interest-point goal
// selection, roles, corner fail-safe, event flinch). Pure-ish: every function
// reads stubbed globals, no browser/network.   node tools/test_npc_director.js
//
// Invariants (what keeps NPCs from clumping in the corner like 'scrap metal'):
//   • SEPARATION: a bot told to move toward a teammate it's piled onto is
//     steered AWAY instead.
//   • EDGE/CORNER repulsion: a bot told to walk into a wall/corner is steered
//     back infield.
//   • GOAL selection never returns a corner/edge point (clamped + interior bias)
//     and is null when disabled (caller falls back).
//   • FAIL-SAFE fires for an edge-wedged, no-progress combat bot; not for a
//     center bot or one still making progress.
//   • Roles are assigned, varied, and carry personality noise.
//   • Kill switch: game._npcAI=false makes steer/goal no-ops.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'npc_director.js'), 'utf8');

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); };

function makeCtx() {
  return new Proxy({}, { get(t, p) { return (p in t) ? t[p] : function () {}; }, set(t, p, v) { t[p] = v; return true; } });
}
const S = Math.SQRT1_2;
const MOVE_DIRS = [[0, 0], [0, -1], [S, -S], [1, 0], [S, S], [0, 1], [-S, S], [-1, 0], [-S, -S]];

function makeSandbox(over) {
  const sb = {
    Math, console: { log() {} },
    WeakSet,
    ctx: makeCtx(),
    registerFxLayer() {},
    NN: { MOVE_DIRS },
    NN_ARENA: { x0: 0, y0: 0, w: 1800, h: 1800 },
    game: { time: 0, _npcAI: true },
    allies: [],
    enemies: [],
    player: { x: 900, y: 900, alive: true, team: 0, radius: 14 },
    coverPoints: [{ x: 900, y: 700 }, { x: 700, y: 900 }],
    explosions: [],
    location: { search: '' },
  };
  sb.window = sb;
  Object.assign(sb, over || {});
  const ctx = vm.createContext(sb);
  vm.runInContext(src, ctx);
  return sb;
}

console.log('NPC-director smoke test — separation / edge / goal / fail-safe / roles:');

// 0. Exports.
{
  const sb = makeSandbox();
  check(typeof sb.npcSteerMoveDir === 'function', 'npcSteerMoveDir exported');
  check(typeof sb.npcPickGoal === 'function', 'npcPickGoal exported');
  check(typeof sb.npcCombatFailsafe === 'function', 'npcCombatFailsafe exported');
  check(typeof sb.npcDirectorTick === 'function', 'npcDirectorTick exported');
  check(sb.NpcDirector && typeof sb.NpcDirector._quantize === 'function', 'NpcDirector + _quantize exported');
  // quantize sanity
  check(sb.NpcDirector._quantize(1, 0, 0) === 3, '_quantize(+x) → East(3)');
  check(sb.NpcDirector._quantize(0, -1, 0) === 1, '_quantize(-y) → North(1)');
  check(sb.NpcDirector._quantize(-1, 0, 0) === 7, '_quantize(-x) → West(7)');
}

// 1. Roles assigned + varied + personality noise.
{
  const sb = makeSandbox();
  const seen = {};
  let noiseVaries = false, lastNoise = null, allAssigned = true;
  for (let i = 0; i < 60; i++) {
    const u = { x: 900, y: 900, alive: true, team: 1, radius: 14 };
    sb.npcRole(u);
    if (u._npcRole == null) allAssigned = false;
    seen[u._npcRole] = 1;
    if (lastNoise != null && u._npcNoise !== lastNoise) noiseVaries = true;
    lastNoise = u._npcNoise;
  }
  check(allAssigned, 'role assigned on first call for every unit');
  check(Object.keys(seen).length >= 2, 'roles vary across a squad (got: ' + Object.keys(seen).join(',') + ')');
  check(noiseVaries, 'personality noise differs between units');
  // stable: second call returns same role
  const u = { x: 0, y: 0, alive: true, team: 1 }; const r1 = sb.npcRole(u); const r2 = sb.npcRole(u);
  check(r1 === r2, 'role is stable per unit');
}

// 2. SEPARATION — base move toward a piled-on mate is steered away (center, no edge).
{
  const sb = makeSandbox();
  const unit = { x: 900, y: 900, alive: true, team: 1, radius: 14, _npcRole: 'flanker', _npcNoise: 1 };
  const mate = { x: 908, y: 900, alive: true, team: 1, radius: 14 };
  sb.enemies = [unit, mate];
  // base moveDir = East(3) = straight toward the mate
  const out = sb.npcSteerMoveDir(unit, 3, sb.enemies);
  check(out === 7, 'separation steers AWAY from a piled-on mate (East→West), got ' + out);
}

// 3. EDGE repulsion — base move into the right wall is steered back infield.
{
  const sb = makeSandbox();
  const unit = { x: 1755, y: 900, alive: true, team: 1, radius: 14, _npcRole: 'holder', _npcNoise: 1 };
  sb.enemies = [unit];
  const out = sb.npcSteerMoveDir(unit, 3, sb.enemies);   // East = into the wall
  check(out !== 3, 'edge repulsion refuses to walk into the right wall (not East), got ' + out);
  const v = MOVE_DIRS[out];
  check(v[0] <= 0, 'edge repulsion steers leftward / infield (x<=0)');
}

// 4. CORNER repulsion — base move into the bottom-right corner is steered to NW.
{
  const sb = makeSandbox();
  const unit = { x: 1760, y: 1760, alive: true, team: 1, radius: 14, _npcRole: 'holder', _npcNoise: 1 };
  sb.enemies = [unit];
  const out = sb.npcSteerMoveDir(unit, 4, sb.enemies);   // SE = into the corner
  check(out === 8, 'corner repulsion steers out of bottom-right corner (SE→NW), got ' + out);
}

// 5. GOAL selection — never a corner/edge point; null when disabled.
{
  const sb = makeSandbox();
  const unit = { x: 900, y: 900, alive: true, team: 1, radius: 14, _npcRole: 'holder', _npcNoise: 1 };
  sb.enemies = [unit];
  let minEdge = Infinity, allInside = true;
  for (let i = 0; i < 80; i++) {
    const g = sb.npcPickGoal(unit);
    if (!g) { allInside = false; break; }
    const ed = sb.NpcDirector._edgeDist(g.x, g.y);
    if (ed < minEdge) minEdge = ed;
  }
  check(allInside, 'pickGoal always returns a goal for an enabled unit');
  check(minEdge >= 110, 'pickGoal never returns a corner/edge point (min edge dist ' + Math.round(minEdge) + ' >= 110)');

  const off = makeSandbox({ game: { time: 0, _npcAI: false } });
  const u2 = { x: 900, y: 900, alive: true, team: 1 };
  check(off.npcPickGoal(u2) === null, 'pickGoal returns null when game._npcAI=false (caller falls back)');
  check(off.npcSteerMoveDir(u2, 3, []) === 3, 'steer is a no-op when game._npcAI=false');
}

// 6. FAIL-SAFE — edge-wedged + no progress → patrol; center / moving → not.
{
  const sb = makeSandbox();
  const unit = { x: 30, y: 900, alive: true, team: 1, radius: 14 };   // wedged on the left wall
  check(sb.npcCombatFailsafe(unit) === false, 'first call only seeds the progress ref (false)');
  sb.game.time = 200;                                                 // > FS_WINDOW(150)
  check(sb.npcCombatFailsafe(unit) === true, 'edge-wedged + no progress over the window → fail-safe TRUE');

  const sb2 = makeSandbox();
  const c = { x: 900, y: 900, alive: true, team: 1, radius: 14 };      // center, not near an edge
  sb2.npcCombatFailsafe(c); sb2.game.time = 200;
  check(sb2.npcCombatFailsafe(c) === false, 'center bot with no progress → NOT a fail-safe (only corners)');

  const sb3 = makeSandbox();
  const mv = { x: 30, y: 900, alive: true, team: 1, radius: 14 };
  sb3.npcCombatFailsafe(mv); sb3.game.time = 200; mv.x = 30; mv.y = 1100;  // moved 200px (>56)
  check(sb3.npcCombatFailsafe(mv) === false, 'edge bot still making progress → NOT a fail-safe');
}

// 6b. PATROL skips edge-repulsion so wall-near goals/cover stay reachable (#2),
//     but COMBAT still gets repelled out of the corner.
{
  const sb = makeSandbox();
  const wallBot = { x: 1740, y: 900, alive: true, team: 1, radius: 14, _npcRole: 'holder', _npcNoise: 1 };
  sb.enemies = [wallBot];
  wallBot._aiMode = 'patrol';
  check(sb.npcSteerMoveDir(wallBot, 3, sb.enemies) === 3,
        'patrol: edge-repulsion skipped so a bot can reach a wall-near goal (East stays East)');
  wallBot._aiMode = 'combat';
  check(sb.npcSteerMoveDir(wallBot, 3, sb.enemies) !== 3,
        'combat: edge-repulsion still turns a bot out of the wall');
}

// 6c. FAIL-SAFE must NOT fire while a live VISIBLE enemy exists (#5) and must
//     reseed (not fire) on a STALE anchor / fresh combat entry (#7).
{
  const seen = makeSandbox();
  seen.nnNearestVisibleEnemy = () => ({ x: 50, y: 900, alive: true });   // a live target
  const u = { x: 30, y: 900, alive: true, team: 1, radius: 14 };
  seen.npcCombatFailsafe(u, []); seen.game.time = 200;
  check(seen.npcCombatFailsafe(u, []) === false,
        'fail-safe holds off while a VISIBLE enemy is present (no fire-stutter)');

  const stale = makeSandbox();
  const s = { x: 30, y: 900, alive: true, team: 1, radius: 14 };
  stale.game.time = 50;
  s._npcProg = { x: 30, y: 900, t: -1000 };   // stale anchor (gap 1050 >> FS_WINDOW*1.5)
  check(stale.npcCombatFailsafe(s) === false,
        'fail-safe reseeds on a stale anchor (fresh combat entry) instead of firing');
  check(s._npcProg.t === 50, 'stale anchor was reseeded to now');
}

// 6d. ROLE re-rolls + clears volatile state on TEAM CHANGE (recruit) (#6).
{
  const sb = makeSandbox();
  const u = { x: 100, y: 100, alive: true, team: 1 };
  sb.npcRole(u);
  u._npcFlee = { x: 0, y: 0, until: 9999 };
  u._npcProg = { x: 100, y: 100, t: 5 };
  const teamWas = u._npcRoleTeam;
  u.team = 0;                              // recruited → flips side
  sb.npcRole(u);
  check(u._npcRoleTeam === 0, 'role re-bound to the new team on recruit');
  check(u._npcFlee === null && u._npcProg === null, 'volatile NPC state cleared on team change');
  check(teamWas === 1, 'role was originally bound to the enemy team');
}

// 7. EVENT flinch — a nearby blast marks a timid bot to flee; dedups per blast.
{
  const sb = makeSandbox({ Math: Object.assign(Object.create(Math), { random: () => 0 }) });
  const bot = { x: 920, y: 900, alive: true, team: 1, radius: 14, _useNN: true, _npcRole: 'holder', _npcNoise: 1 };
  sb.enemies = [bot];
  sb.explosions = [{ x: 900, y: 900 }];
  sb.npcDirectorTick();
  check(bot._npcFlee && bot._npcFlee.until > 0, 'nearby explosion makes a timid NPC flinch (sets _npcFlee)');
  const untilFirst = bot._npcFlee.until;
  bot._npcFlee = null;
  sb.npcDirectorTick();   // same blast object → already seen → no re-flinch
  check(bot._npcFlee == null, 'each blast reacts only once (WeakSet dedup)');
}

if (problems.length === 0) { console.log('OK — NPC director: separation + edge/corner repulsion + interest goals + fail-safe + roles + flinch hold.'); process.exit(0); }
console.error('\nFAIL — NPC director invariant broken:');
for (const p of problems) if (p) console.error('  ✗ ' + p);
process.exit(1);
