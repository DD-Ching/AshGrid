// ============ SIEGE smoke test (tools/test_siege.js) ============
// Loads the js/missions/siege/* classic-script files into a single vm context
// (concatenated, so top-level const/let share one lexical scope exactly as the
// browser's shared global environment does) and asserts the siege subsystem's
// invariants. Grows phase-by-phase: every assertion guards on the symbol it
// needs, so the suite covers whatever siege files currently exist.
//
//   Phase 1: buildSiegeFort() builds the concentric fort — named segments, HP
//            tiers, the Heart (spawn-relay) + Armory (factory).
//   Phase 3: the _SIEGE_CUE table is EXHAUSTIVE for SIEGE_SCRIPT + director
//            advances night/phase.
//   Phase 4: a breacher tank pressed to a named wall drains its HP + a breach
//            splices the segment.
//   Phase 7: isComplete fires at the final-night dawn; proc emits valid cues.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SIEGE_DIR = path.join(__dirname, '..', 'js', 'missions', 'siege');
// Dependency order (script data first, then arena, then director that uses it).
const FILES = ['siege_script.js', 'siege_arena.js', 'siege_director.js',
               'siege_mission.js', 'siege_fx.js'];

function loadSrc() {
  let src = '';
  const present = [];
  for (const f of FILES) {
    const p = path.join(SIEGE_DIR, f);
    if (fs.existsSync(p)) { src += '\n;// ==== ' + f + ' ====\n' + fs.readFileSync(p, 'utf8'); present.push(f); }
  }
  return { src, present };
}

function makeSandbox(extra) {
  const buildings = [], lowCovers = [], structures = [], enemies = [], enemyDrones = [], allies = [];
  const sb = {
    Math, JSON, Array, Object, Number, String, Date,
    console: { log() {}, error() {}, warn() {} },
    window: {},
    NN_ARENA: { x0: 0, y0: 0, w: 1800, h: 1800 },
    buildings, lowCovers, enemies, enemyDrones, allies,
    addBuilding(x, y, w, h, color, opts) {
      opts = opts || {};
      const hp = opts.hp != null ? opts.hp : 220;
      buildings.push({ x, y, w, h, color, kind: opts.kind || 'building', accent: !!opts.accent, hp, maxHp: hp });
    },
    addLowCover(x, y, w, h, color, opts) {
      opts = opts || {};
      lowCovers.push({ x, y, w, h, color, kind: (opts && opts.kind) || 'cover', hp: 100, maxHp: 100 });
    },
    addOverhead() {}, addLandmark() {},
    buildCoverPoints() {},
    _fxLayers: [],
    registerFxLayer(layer) { sb._fxLayers.push(layer); },
    STRUCTURE_DEFS: {
      'spawn-relay': { cost: -1, hp: 450, size: 44, blocks: true, blocksLOS: false, label: () => 'SPAWN RELAY' },
      factory: { cost: -1, hp: 500, size: 60, blocks: true, captureR: 90, captureTicks: 300, productionTicks: 1800, label: () => 'BOT FACTORY' },
    },
    COLORS: { gray: '#3A3A3A', red: '#C8261C', creamDark: '#8A7E63', cream: '#F2E9D0' },
    NN_MAP_VARIANTS: [],
    MISSION_FACTORIES: {},
    game: { time: 0, state: 'playing', _structures: structures },
    player: { x: 900, y: 955, alive: true, hp: 100, maxHp: 100 },
    T: (zh, en) => en, getLang: () => 'en',
    showSwapToast() {}, triggerShake() {},
    TOD: { setTOD() { return true; } },
    _arenaSpawnFactoryBot(team, x, y) { const e = { team: team === 'blue' ? 0 : 1, x, y, hp: 80, maxHp: 80, radius: 13, alive: true }; enemies.push(e); return e; },
    spawnDroneEnemy() { const d = { x: 900, y: 900, hp: 18, maxHp: 18, alive: true }; enemyDrones.push(d); return d; },
    pickBiasedSpawn() { return { x: 900, y: 500 }; },
    createExplosion() {},
    WEAPONS: { ROCKET: { name: 'RPG', damage: 80, isRocket: true, blastR: 110 } },
    W: () => 800, H: () => 600,
    camera: { x: 900, y: 900, scale: 1 },
    addEnergy() {}, spendEnergy() { return true; }, canAffordEnergy() { return true; },
    ctx: null,
  };
  sb.window.MISSION_FACTORIES = sb.MISSION_FACTORIES;
  Object.assign(sb, extra || {});
  sb.global = sb; sb.globalThis = sb;
  return sb;
}

const problems = [];
function check(cond, msg) {
  if (!cond) { problems.push(msg); console.error('  ✗ ' + msg); }
  else console.log('  ✓ ' + msg);
}

const { src, present } = loadSrc();
if (!src) { console.error('FAIL: no siege source files found in ' + SIEGE_DIR); process.exit(1); }
console.log('Siege smoke test — loaded: ' + present.join(', '));

// ───────────────────────── PHASE 1 — arena / fort ──────────────────────────
console.log('\n[fort] buildSiegeFort + named segments + Heart/Armory:');
{
  const sb = makeSandbox();
  sb.game._siege = {};                       // arena stores fort on game._siege.fort
  vm.runInContext(src, vm.createContext(sb));

  check(typeof sb.buildSiegeFort === 'function', 'buildSiegeFort() is exported');
  if (typeof sb.buildSiegeFort === 'function') {
    const fort = sb.buildSiegeFort();
    check(!!fort, 'buildSiegeFort() returns a fort registry');

    // siege_bastion variant registered, siege-only
    const variant = sb.NN_MAP_VARIANTS.find(v => v.id === 'siege_bastion');
    check(!!variant, 'siege_bastion variant registered in NN_MAP_VARIANTS');
    check(variant && Array.isArray(variant.modes) && variant.modes.length === 1 && variant.modes[0] === 'siege',
      "siege_bastion is modes:['siege'] only");

    // Heart — spawn-relay, hp 1200, the lose-condition object
    check(fort && fort.heart && fort.heart.kind === 'spawn-relay', 'Heart is a spawn-relay structure');
    check(fort && fort.heart && fort.heart.hp === 1200, 'Heart hp is 1200');
    check(fort && fort.heart && fort.heart._isHeart === true, 'Heart is flagged _isHeart');
    check(sb.game._structures.indexOf(fort && fort.heart) >= 0, 'Heart is pushed into game._structures');

    // Armory — factory, capturable
    check(fort && fort.armory && fort.armory.kind === 'factory', 'Armory is a factory structure');
    check(fort && fort.armory && fort.armory._isArmory === true, 'Armory is flagged _isArmory');

    // Named, breachable segments exist with the right HP tiers
    const ids = sb._siegeFortSegIds();
    const want = ['gateLeafN', 'curtainN_w', 'curtainN_e', 'curtainE_n', 'curtainS_w',
                  'innerN_w', 'innerE_n', 'innerS_w', 'innerW_n', 'keepN', 'keepS_w'];
    for (const id of want) check(ids.indexOf(id) >= 0, 'segment "' + id + '" exists');

    const byId = (id) => sb.buildings.find(b => b._segId === id);
    check(byId('gateLeafN') && byId('gateLeafN').hp === 200, 'north gate-leaf hp 200 (weakest, weldable)');
    check(byId('gateLeafN') && byId('gateLeafN')._siegeWeldable === true, 'gate-leaf is weldable');
    check(byId('curtainN_w') && byId('curtainN_w').hp === 350, 'outer curtain hp 350 (meant to fall)');
    check(byId('innerN_w') && byId('innerN_w').hp === 600, 'inner wall hp 600 (the real line)');
    check(byId('keepN') && byId('keepN').hp === 700, 'keep hp 700 (bunker-grade)');

    // Gate anchors for director-biased spawns
    check(fort && fort.gateAnchors && fort.gateAnchors.N && fort.gateAnchors.E
       && fort.gateAnchors.S && fort.gateAnchors.W, 'gate anchors N/E/S/W present');

    // Murder-hole build footings
    check(fort && Array.isArray(fort.footings) && fort.footings.length >= 4, 'at least 4 murder-hole footings');

    // siegeSeg() resolves a logical cue target to a live segment
    check(typeof sb.siegeSeg === 'function' && sb.siegeSeg('curtainN') === byId('gateLeafN'),
      "siegeSeg('curtainN') resolves to the gate-leaf");
    check(sb.siegeSeg('innerN') === byId('innerN_w'), "siegeSeg('innerN') resolves to inner-north");
  }
}

// ───────────── PHASE 2 — mission factory contract + lose/win ────────────────
if (/MISSION_FACTORIES\.siege/.test(src)) {
  console.log('\n[factory] MISSION_FACTORIES.siege contract:');
  const sb = makeSandbox();
  vm.runInContext(src, vm.createContext(sb));
  check(typeof sb._siegeInitState === 'function', '_siegeInitState() exported');
  check(sb.MISSION_FACTORIES && typeof sb.MISSION_FACTORIES.siege === 'function',
    'MISSION_FACTORIES.siege registered');
  if (sb.MISSION_FACTORIES && typeof sb.MISSION_FACTORIES.siege === 'function') {
    sb.game._siege = sb._siegeInitState();
    const m = sb.MISSION_FACTORIES.siege({});
    check(m && m.playerSpawn && typeof m.playerSpawn.x === 'number',
      'factory exposes a playerSpawn (the Heart)');
    check(Array.isArray(m.teamKills) && m.teamKills.length === 2, 'teamKills [blue,red] present');
    check(typeof m.setupStructures === 'function' && typeof m.update === 'function'
       && typeof m.isComplete === 'function' && typeof m.isFailed === 'function'
       && typeof m.renderHUD === 'function', 'required factory methods present');

    m.setupStructures();
    const h = sb.siegeFort() && sb.siegeFort().heart;
    check(!!h, 'setupStructures() builds the fort (Heart present)');
    check(m.isFailed() === false, 'isFailed() false while Heart alive');
    if (h) { h.hp = 0; check(m.isFailed() === true, 'isFailed() true when Heart hp→0'); h.hp = 1200; }

    check(m.isComplete() === false, 'isComplete() false before win');
    sb.game._siege._won = true;
    check(m.isComplete() === true, 'isComplete() true when game._siege._won');
    sb.game._siege._won = false;

    // update() must not throw with a bare arena (no director yet)
    let threw = false; try { m.update(); } catch (e) { threw = true; }
    check(!threw, 'update() runs without throwing');
  }
}

// ──────────── PHASE 3 — cue table exhaustive + director advances ────────────
if (/_siegeCueKinds/.test(src)) {
  console.log('\n[director] cue table exhaustiveness + night/phase advance:');
  const sb = makeSandbox();
  vm.runInContext(src, vm.createContext(sb));
  if (typeof sb._siegeCueKinds === 'function' && typeof sb._siegeScriptCueKinds === 'function') {
    const handlers = new Set(sb._siegeCueKinds());
    for (const k of sb._siegeScriptCueKinds()) check(handlers.has(k), 'cue kind "' + k + '" has a _SIEGE_CUE handler');
  }
  if (typeof sb.updateSiegeDirector === 'function' && typeof sb._siegeInitState === 'function') {
    sb.game._siege = sb._siegeInitState();
    sb.game.state = 'playing';
    sb.game.time = 0;
    sb.buildSiegeFort();
    sb.updateSiegeDirector();                                   // night 0 → 1
    check(sb.game._siege.night === 1, 'director boots into Night 1');
    check(Array.isArray(sb.game._siege._nightCues) && sb.game._siege._nightCues.length > 0, 'Night 1 cues loaded');

    sb.game.time = 84 * 2;                                      // t ≈ 2s — at:0/1/2 cues fire
    sb.updateSiegeDirector();
    check(sb.game._siege.goal && /NORTH/.test(sb.game._siege.goal.en), 'goal cue fired (HOLD THE NORTH GATE)');

    sb.game.time = 84 * 7;                                      // past the at:6 spawn
    sb.updateSiegeDirector();
    check(sb.enemies.length >= 4, 'spawn cue spawned ≥4 sappers');
    check(sb.game._siege.phase === 'assault', 'phase advanced to assault');

    sb.enemies.length = 0;                                      // field clears
    sb.game.time = 84 * 70;                                     // past the at:62 dawn cue
    sb.updateSiegeDirector();
    check(sb.game._siege._gapUntil > 0, 'dawn cue opened the regroup gap');

    sb.game.time = sb.game._siege._gapUntil + 1;                // past the gap
    sb.updateSiegeDirector();
    check(sb.game._siege.night === 2, 'director advanced to Night 2');
  }
}

// ──────────── PHASE 4 — breacher tanks + terrain mutation (更改地形) ──────────
if (/_siegeTankBreach/.test(src)) {
  console.log('\n[terrain] breacher tank drains named wall + breach splices:');
  const sb = makeSandbox();
  vm.runInContext(src, vm.createContext(sb));
  if (typeof sb._siegeTankBreach === 'function') {
    sb.game._siege = sb._siegeInitState();
    sb.buildSiegeFort();
    const seg = sb.buildings.find(b => b._segId === 'curtainN_w');
    check(!!seg, 'curtainN_w present for breach test');
    if (seg) {
      const hp0 = seg.hp;
      const tank = { x: seg.x + seg.w / 2, y: seg.y + seg.h / 2, alive: true, hp: 480, maxHp: 480, radius: 26, team: 1, _siegeBreacher: true };
      sb.enemies.push(tank);
      sb._siegeTankBreach();
      check(seg.hp < hp0, 'breacher tank drains wall HP on contact');
      for (let i = 0; i < 500 && sb.buildings.indexOf(seg) >= 0; i++) sb._siegeTankBreach();
      check(sb.buildings.indexOf(seg) < 0, 'wall splices from buildings[] at hp≤0 (permanent gap)');
    }
    const eSeg = sb.buildings.find(b => b._segId === 'curtainE_n');
    check(!!eSeg, 'curtainE_n present');
    if (eSeg && typeof sb._siegeFireCue === 'function') {
      sb._siegeFireCue({ kind: 'terrain', op: 'breach', target: 'curtainE_n' });
      check(sb.buildings.indexOf(eSeg) < 0, "terrain op:'breach' splices the named segment");
    }
    // indestructible gate-posts never breach
    const post = sb.lowCovers.find(c => c._siegeIndestructible);
    check(!!post, 'indestructible gate-post exists (never breaches)');
  }
}

// ──────────── PHASE 5 — garrison lives / weld / armory / autopilot ──────────
if (/_siegeTryRevive/.test(src)) {
  console.log('\n[garrison] lives / weld / autopilot:');
  const sb = makeSandbox();
  vm.runInContext(src, vm.createContext(sb));
  sb.game._siege = sb._siegeInitState();
  sb.game.state = 'playing'; sb.game.time = 1000;
  sb.buildSiegeFort();
  const heart = sb.siegeFort().center;

  // garrison-wake AT the Heart on death (positional setback)
  sb.game._siege.livesLeft = 2;
  sb.player.alive = false;
  check(sb._siegeTryRevive() === 'revived', '_siegeTryRevive wakes a garrison body when lives remain');
  check(sb.game._siege.livesLeft === 1, 'garrison life decremented on wake');
  check(sb.player.alive === true, 'player revived');
  check(Math.hypot(sb.player.x - heart.x, sb.player.y - heart.y) < 130, 'player woke AT the Heart');

  // recruit / armory banks a life (capped)
  sb._siegeAddGarrisonLife('recruit');
  check(sb.game._siege.livesLeft === 2, 'recruit/armory banks a garrison life');
  sb.game._siege.livesLeft = 5;            // at cap
  sb._siegeAddGarrisonLife('recruit');
  check(sb.game._siege.livesLeft === 5, 'garrison life capped at 5');

  // weld restores a damaged wall + rebuilds a collapsed one
  sb.game._energy = 500;
  const seg = sb.siegeFort().segs['curtainN_w'];
  seg.hp = 50;
  sb.player.alive = true; sb.player.x = seg.x + seg.w / 2; sb.player.y = seg.y + seg.h / 2;
  const before = seg.hp;
  sb._siegeWeld();
  check(seg.hp > before, 'weld restores wall HP');
  const idx = sb.buildings.indexOf(seg); if (idx >= 0) sb.buildings.splice(idx, 1);
  seg.hp = 0;
  for (let k = 0; k < 5; k++) sb._siegeWeld();
  check(sb.buildings.indexOf(seg) >= 0 && seg.hp > 0, 'weld rebuilds a collapsed segment (re-pushed to buildings[])');

  // AUTOPILOT — 0 lives → autopilot; field clear → garrison wakes (no loss)
  const sbA = makeSandbox(); vm.runInContext(src, vm.createContext(sbA));
  sbA.game._siege = sbA._siegeInitState(); sbA.game.state = 'playing'; sbA.game.time = 1000;
  sbA.buildSiegeFort();
  sbA.game._siege.livesLeft = 0; sbA.player.alive = false;
  check(sbA._siegeTryRevive() === 'autopilot', '0 lives → AUTOPILOT');
  check(sbA.game._siege.autopilot === true, 'autopilot flag set');
  sbA.enemies.length = 0;                  // field clears → the fort holds
  sbA._siegeTickAutopilot();
  check(sbA.game._siege._failed === false, 'fort held without you (field clear) → not a loss');
  check(sbA.game._siege.autopilot === false, 'autopilot resolved → garrison woke');

  // AUTOPILOT — grace expires while still overwhelmed → loss (garrison-extinct)
  const sbB = makeSandbox(); vm.runInContext(src, vm.createContext(sbB));
  sbB.game._siege = sbB._siegeInitState(); sbB.game.state = 'playing'; sbB.game.time = 1000;
  sbB.buildSiegeFort();
  sbB.game._siege.livesLeft = 0; sbB.player.alive = false;
  sbB._siegeTryRevive();
  sbB.enemies.push({ alive: true, x: 900, y: 900, hp: 80 });   // still under assault
  sbB.game._siege.phase = 'assault'; sbB.game._siege._gapUntil = 0;
  sbB.game.time = sbB.game._siege.autopilotUntil + 1;          // grace expired
  sbB._siegeTickAutopilot();
  check(sbB.game._siege._failed === true, 'autopilot grace expired while overwhelmed → loss');
}

// ──────────── PHASE 6 — FX layers register + self-gate on game._siege ───────
if (/siege-weather/.test(src)) {
  console.log('\n[fx] FX layers register + self-gate on game._siege:');
  const sb = makeSandbox();
  sb.game._siege = null;
  vm.runInContext(src, vm.createContext(sb));
  const ids = sb._fxLayers.map(l => l.id);
  check(ids.indexOf('siege-weather') >= 0, 'siege-weather FX layer registered');
  check(ids.indexOf('siege-hud') >= 0, 'siege-hud FX layer registered');
  const wl = sb._fxLayers.find(l => l.id === 'siege-weather');
  if (wl && typeof wl.when === 'function') {
    sb.game._siege = null;
    check(wl.when() === false, 'siege FX inert when game._siege is null (other modes byte-identical)');
    sb.game._siege = sb._siegeInitState();
    check(wl.when() === true, 'siege FX active when game._siege is set');
  }
}

// ──────────── PHASE 7 — final-night WIN + procedural composer ───────────────
if (/_siegeProcNight/.test(src)) {
  console.log('\n[endgame] final-night WIN + procedural Night 6+:');
  const sb = makeSandbox();
  vm.runInContext(src, vm.createContext(sb));
  sb.game._siege = sb._siegeInitState();
  sb.game.state = 'playing'; sb.game.time = 0;
  sb.buildSiegeFort();
  const m = sb.MISSION_FACTORIES.siege({});

  sb.game._siege.night = 5;
  sb._siegeFireCue({ kind: 'dawn', windowSec: 40, salvage: 0 });
  check(sb.game._siege._won === true, 'final-night dawn sets _won (DAWN HOLDS)');
  check(m.isComplete() === true, 'isComplete() true at final-night dawn');

  const handlers = new Set(sb._siegeCueKinds());
  const proc6 = sb._siegeProcNight(6);
  check(Array.isArray(proc6) && proc6.length > 0, '_siegeProcNight(6) returns a cue list');
  check(proc6.every(c => c.night === 6 && handlers.has(c.kind)), 'all proc cues have valid kind + night');
  const proc9 = sb._siegeProcNight(9);
  const sappers = (arr) => arr.filter(c => c.kind === 'spawn' && c.unit === 'sapper').reduce((s, c) => s + (c.n || 0), 0);
  check(sappers(proc9) >= sappers(proc6), 'proc escalates infantry pressure with the night number');
  check(proc9.some(c => c.unit === 'walker'), 'proc fields a SIEGE-WALKER on the late nights');
  check(['N', 'E', 'S', 'W'].indexOf(sb._siegeWeakestGate()) >= 0, '_siegeWeakestGate returns a real gate');
}

// ───────────────────────── result ──────────────────────────
if (problems.length === 0) {
  console.log('\nOK — siege invariants hold (' + present.length + ' file(s)).');
  process.exit(0);
}
console.error('\nFAIL — ' + problems.length + ' problem(s):');
for (const p of problems) console.error('  ✗ ' + p);
process.exit(1);
