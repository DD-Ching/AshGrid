// AshGrid reconcile smoke test (Phase 175) — guards the MP self-reconcile layer
// (js/mp_reconcile.js: MpReconcile.handleSelfSnapshot + reconcilePosition). This
// is the most regression-prone code in the repo (Phases 59/125/128/129c/133.3:
// rubber-banding, stuck-in-place, infinite die/respawn, ghost-vehicle) and CI's
// syntax + parity checks can't catch a behaviour break in it. Added when Phase
// 174 moved the snapshot pipeline out of multiplayer.js — this asserts the
// relocated module loads and the pipeline's contract behaviours still hold.
//
// Self-contained: loads mp_reconcile.js in a vm with stubbed globals (no
// network, no PartyKit, no browser). Run by the pre-commit hook + CI gate.
//   node tools/test_reconcile.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'mp_reconcile.js'), 'utf8');

const problems = [];
function check(cond, msg) { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); }

// Fresh sandbox each scenario so state doesn't leak between assertions.
function makeSandbox(over) {
  const calls = [];
  const sb = {
    window: {}, console: { log: (...a) => calls.push('log:' + a.join(' ')) },
    Math, Infinity, undefined,
    player: { x: 100, y: 100, hp: 100, alive: true, _killedAtTime: 0, _invulnUntil: 0,
              _reconcileErr: null, _killer: null },
    game: { time: 1000 },
    MP_PLAYER_SPEED: 5.6,
    _mpState: { serverSelfX: 100, serverSelfY: 100, serverSelfHp: 100, serverSelfAlive: true,
                serverSelfInvuln: false, pendingInputs: [], rttMs: 0, rttSmoothed: 0 },
    getRespawnSeconds: () => 5,
    _mpRespawnLocalPlayer: () => calls.push('respawnLocal'),
    PlayerLifecycle: { justRespawned: () => false },
    handleLocalDeath: (p) => calls.push('handleLocalDeath@' + p.x + ',' + p.y),
    shouldSkipSnapshotFallback: () => false,
    triggerShake: () => calls.push('shake'),
    triggerDeathRecap: () => calls.push('deathRecap'),
    _calls: calls,
  };
  Object.assign(sb, over || {});
  vm.runInContext(src, vm.createContext(sb));
  return sb;
}

console.log('Reconcile smoke test — MpReconcile.handleSelfSnapshot:');

// 0. Module exports the moved pipeline entrypoint.
let mr;
{ const sb = makeSandbox(); mr = sb.window.MpReconcile; }
check(mr && typeof mr.handleSelfSnapshot === 'function', 'module loads + handleSelfSnapshot exported');
check(mr && typeof mr.reconcilePosition === 'function', 'reconcilePosition still exported');

// 1. Normal snapshot: RTT computed; acked inputs dropped, unacked kept; no snap.
{
  const sb = makeSandbox();
  sb._mpState.pendingInputs = [{ seq: 4, dx: 1, dy: 0 }, { seq: 5, dx: 1, dy: 0 }];
  sb.window.MpReconcile.handleSelfSnapshot(
    { id: 1, t: 900, x: 100, y: 100, hp: 100, alive: true, lastInputSeq: 4 }, 1000);
  check(sb._mpState.rttMs === 100, 'RTT = now - sp.t (1000-900=100)');
  check(sb._mpState.pendingInputs.length === 1 && sb._mpState.pendingInputs[0].seq === 5,
        'inputs <= lastInputSeq dropped, later kept');
}

// 2. Big position error (>150u) → instant snap to server pos.
{
  const sb = makeSandbox();
  sb.window.MpReconcile.handleSelfSnapshot({ id: 1, x: 500, y: 500, lastInputSeq: 99 }, 1000);
  check(sb.player.x === 500 && sb.player.y === 500, '>150u error snaps player to server pos');
}

// 3. Small error (<3u) → dead zone, no move.
{
  const sb = makeSandbox();
  sb.player.x = 100; sb.player.y = 100;
  sb.window.MpReconcile.handleSelfSnapshot({ id: 1, x: 102, y: 100, lastInputSeq: 99 }, 1000);
  check(sb.player.x === 100 && sb.player.y === 100, '<3u error is a dead zone (no reconcile move)');
}

// 4. Synth-kill: alive locally, server says dead, not just-respawned → death path.
{
  const sb = makeSandbox();
  sb.window.MpReconcile.handleSelfSnapshot({ id: 1, x: 500, y: 500, alive: false, lastInputSeq: 99 }, 1000);
  check(sb._calls.some(c => c.startsWith('handleLocalDeath')) && sb._calls.includes('deathRecap'),
        'server-dead while locally-alive triggers synth-kill death path');
}

// 5. Post-respawn guard blocks the synth-kill (no death within the window).
{
  const sb = makeSandbox({ PlayerLifecycle: { justRespawned: () => true } });
  sb.window.MpReconcile.handleSelfSnapshot({ id: 1, x: 100, y: 100, alive: false, lastInputSeq: 99 }, 1000);
  check(!sb._calls.some(c => c.startsWith('handleLocalDeath')),
        'justRespawned window suppresses stale "dead" packet (no infinite die/respawn)');
}

// 6. HP sync takes min(local, server); invuln pin honors explicit true.
{
  const sb = makeSandbox();
  sb.player.hp = 80;
  sb.window.MpReconcile.handleSelfSnapshot({ id: 1, x: 100, y: 100, alive: true, hp: 40, invuln: true, lastInputSeq: 99 }, 1000);
  check(sb.player.hp === 40, 'hp synced to min(local 80, server 40) = 40');
  check(sb.player._invulnUntil === Infinity, 'explicit invuln:true pins shield');
}

if (problems.length === 0) { console.log('OK — reconcile pipeline contract holds.'); process.exit(0); }
console.error('\nFAIL — reconcile regression:');
for (const p of problems) console.error('  ✗ ' + p);
process.exit(1);
