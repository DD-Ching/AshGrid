// AshGrid killcam smoke test (Phase 179) — guards js/replay_buffer.js +
// js/killcam.js, the death-replay + press-SPACE-respawn layer. The load-bearing
// invariants (this code sits on top of the most bug-prone subsystem):
//   • replay_buffer records ONLY in SOLO NN while alive; no-op in MP / non-NN /
//     dead; caps the ring; assigns a stable per-unit __replayId; a respawn edge
//     starts a clean history.
//   • killcam stays 'off' while alive and in MP; only arms on a SOLO death wait;
//     press-SPACE NEVER revives directly — it only collapses the EXISTING
//     respawn deadline (player.alive must stay false after requestRespawn) and
//     latches so it can't re-trigger before the revive lands.
//
// Self-contained (no browser/network).  node tools/test_killcam.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const bufSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'replay_buffer.js'), 'utf8');
const camSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'killcam.js'), 'utf8');

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); };
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// A no-op canvas 2D context: any method call is a no-op, any property is r/w.
function makeCtx() {
  return new Proxy({}, {
    get(t, p) { return (p in t) ? t[p] : function () {}; },
    set(t, p, v) { t[p] = v; return true; },
  });
}

// Build a shared vm context where `window` IS the global object, so a module's
// `window.X = …` and another module's bare `X` reference the same binding.
function makeSandbox(over) {
  const sb = {
    Math, console: { log() {} },
    Date,                       // killcam/buffer use Date.now()
    W: () => 1280, H: () => 720,
    ctx: makeCtx(),
    COLORS: { red: '#C8261C', cream: '#E8E4D8', black: '#000' },
    T: (zh, en) => en,
    _fxLayers: [],
    registerFxLayer(layer) { sb._fxLayers.push(layer); },
    game: { _nnMode: true, time: 0, _paused: false, _teamWipe: { blue: {} } },
    _mpState: { enabled: false },
    player: { x: 100, y: 100, alive: true, angle: 0, radius: 12 },
    allies:  [{ x: 120, y: 100, alive: true, angle: 0, radius: 12 }],
    enemies: [{ x: 300, y: 100, alive: true, angle: Math.PI, radius: 12 }],
    bullets: [{ x: 200, y: 100 }],
  };
  sb.window = sb;
  Object.assign(sb, over || {});
  const ctx = vm.createContext(sb);
  vm.runInContext(bufSrc, ctx);
  vm.runInContext(camSrc, ctx);
  return sb;
}

console.log('Killcam smoke test — replay buffer + death-replay/respawn layer:');

// 0. Exports present + FX layer registered.
{
  const sb = makeSandbox();
  check(typeof sb.replayBufferTick === 'function', 'replayBufferTick exported');
  check(sb.ReplayBuffer && typeof sb.ReplayBuffer.frames === 'function', 'ReplayBuffer.frames exported');
  check(typeof sb.killcamCanRespawn === 'function', 'killcamCanRespawn exported');
  check(typeof sb.killcamRequestRespawn === 'function', 'killcamRequestRespawn exported');
  check(sb._fxLayers.some(l => l.id === 'killcam' && l.space === 'overlay-over-hud'),
        'killcam registered an over-HUD FX layer');
}

// 1. Replay buffer records in SOLO NN while alive, caps, tags stable ids.
{
  const sb = makeSandbox();
  for (let i = 0; i < 40; i++) sb.replayBufferTick();
  check(sb.ReplayBuffer.size() > 0, 'records frames in SOLO NN while alive');
  check(sb.player.__replayId != null, 'assigns a stable __replayId to the player');
  check(sb.enemies[0].__replayId != null, 'assigns a stable __replayId to enemies');
  // CAP is ~67 frames; 40 ticks / SAMPLE_EVERY(4) ≈ 10 frames → under cap, but
  // hammer it to prove the ring is bounded.
  for (let i = 0; i < 4000; i++) sb.replayBufferTick();
  check(sb.ReplayBuffer.size() <= 80, 'ring buffer stays bounded under load (' + sb.ReplayBuffer.size() + ')');
}

// 2. Replay buffer is a no-op in MP / non-NN / dead.
{
  const mp = makeSandbox({ _mpState: { enabled: true } });
  for (let i = 0; i < 40; i++) mp.replayBufferTick();
  check(mp.ReplayBuffer.size() === 0, 'MP (_mpState.enabled) → buffer records nothing');

  const non = makeSandbox();
  non.game._nnMode = false;
  for (let i = 0; i < 40; i++) non.replayBufferTick();
  check(non.ReplayBuffer.size() === 0, 'non-NN mode → buffer records nothing');

  const dead = makeSandbox();
  dead.player.alive = false;
  for (let i = 0; i < 40; i++) dead.replayBufferTick();
  check(dead.ReplayBuffer.size() === 0, 'dead player → buffer frozen (records nothing)');
}

// 3. Respawn edge starts a clean history.
{
  const sb = makeSandbox();
  for (let i = 0; i < 40; i++) sb.replayBufferTick();
  check(sb.ReplayBuffer.size() > 0, 'pre-death history exists');
  sb.player.alive = false;
  sb.replayBufferTick();                 // freeze
  sb.player.alive = true;                // respawn edge
  sb.replayBufferTick();                 // should reset on the rising edge
  check(sb.ReplayBuffer.size() === 0, 'dead→alive edge clears the previous life\'s frames');
}

// helper: drive the registered killcam FX layer once (mirrors render_frame.js).
function draw(sb) { sb._fxLayers.find(l => l.id === 'killcam').draw(); }
function killCam(sb) {
  // put the player into a SOLO team-wipe death wait with a known killer.
  for (let i = 0; i < 40; i++) sb.replayBufferTick();     // fill history first
  sb.player.alive = false;
  sb.player._lastDeathX = 100; sb.player._lastDeathY = 100;
  sb.player._respawnAt = sb.game.time + 900;
  sb.player._killer = { callsign: 'REAPER', x: 300, y: 100, __replayId: sb.enemies[0].__replayId };
  sb.player._killerWeapon = 'SNIPER';
  sb.game._teamWipe.blue.wipedSince = 1;
}

// 4. Killcam stays OFF while alive.
{
  const sb = makeSandbox();
  draw(sb);
  check(sb.KillCam.phase() === 'off', 'alive → killcam phase off');
  check(sb.killcamCanRespawn() === false, 'alive → cannot respawn');
}

// 5. Killcam never arms in MP even on a death wait (SOLO-first).
{
  const sb = makeSandbox({ _mpState: { enabled: true } });
  killCam(sb);
  draw(sb);
  check(sb.KillCam.phase() === 'off', 'MP death wait → killcam stays off (SOLO-only)');
  check(sb.killcamCanRespawn() === false, 'MP → cannot trigger killcam respawn');
}

// 6. SOLO death → killcam arms; press-SPACE is the ONLY mutation and never revives.
{
  const sb = makeSandbox();
  killCam(sb);
  draw(sb);
  check(sb.KillCam.phase() === 'playing', 'SOLO death wait → killcam enters playing');
  check(sb.killcamCanRespawn() === false, 'cannot skip before the minimum view time');
  // early SPACE is refused AND must not touch the respawn deadline
  const r0 = sb.killcamRequestRespawn();
  check(r0 === false, 'early requestRespawn() refused');
  check(sb.game._teamWipe.blue.respawnAtMs == null, 'refused request does NOT mutate the deadline');

  // accumulate >MIN_SKIP_MS of playback (small steps so the 120 ms gap-clamp
  // doesn't cap them), then SPACE should be allowed.
  for (let i = 0; i < 11; i++) { sleep(100); draw(sb); }
  check(sb.killcamCanRespawn() === true, 'after minimum view time → can respawn');

  const aliveBefore = sb.player.alive;
  const ok = sb.killcamRequestRespawn();
  check(ok === true, 'requestRespawn() succeeds once allowed');
  check(sb.player.alive === aliveBefore && sb.player.alive === false,
        'requestRespawn() does NOT revive directly (alive stays false)');
  check(typeof sb.game._teamWipe.blue.respawnAtMs === 'number'
        && sb.game._teamWipe.blue.respawnAtMs <= Date.now(),
        'requestRespawn() collapses the wall-clock deadline to now');
  check(sb.player._respawnAt === sb.game.time, 'requestRespawn() collapses the per-player tick deadline');
  check(sb.KillCam.phase() === 'off', 'requestRespawn() hands control back (phase off)');

  // latch: a follow-up frame while still dead must NOT re-arm the killcam.
  draw(sb);
  check(sb.KillCam.phase() === 'off', 'latched — does not re-trigger before the revive lands');
}

if (problems.length === 0) { console.log('OK — killcam buffer + replay/respawn layer hold their invariants.'); process.exit(0); }
console.error('\nFAIL — killcam invariant broken:');
for (const p of problems) console.error('  ✗ ' + p);
process.exit(1);
