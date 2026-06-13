// AshGrid MP ad-revive authority test (Phase 181) — guards the load-bearing
// rule behind the user's '按下看廣告之後會立刻復活,然後復活之後我卻沒有辦法
// 移動,前後左右移動會被拉回去,然後馬上死掉' rubber-band bug.
//
// Invariants (death_recap.js _adRevivePlayer):
//   • MP  → NEVER locally revives. It applies the respawn buff then sends the
//     server requestRespawn (server-authoritative 'return to the room'); the
//     local player stays dead (alive=false) until the server's snapshot flips
//     it. A local alive=true in MP is exactly the reconcile-yank death class.
//   • SOLO → DOES revive locally (no authority): _arenaRevivePlayerOnly /
//     _arenaReviveTeam / PlayerLifecycle.reviveAtSpawn.
//   • The green button re-arms every death (triggerDeathRecap clears the
//     adReviveUsed in-flight latch) so it never vanishes for the rest of a
//     long MP match after a single watch.
//
// Self-contained vm sandbox (no browser/network).  node tools/test_mp_ad_revive.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'death_recap.js'), 'utf8');

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); };

function makeCtx() {
  return new Proxy({}, {
    get(t, p) { return (p in t) ? t[p] : function () {}; },
    set(t, p, v) { t[p] = v; return true; },
  });
}

// Build a sandbox where `window` IS the global so death_recap's top-level
// function declarations become callable context globals.
function makeSandbox(over) {
  const calls = { mpRequest: 0, applyBuff: 0, arenaTeam: 0, arenaPlayerOnly: 0, reviveAtSpawn: 0, toast: 0 };
  const sb = {
    Math, console: { log() {} }, Date,
    document: { getElementById: () => null },
    W: () => 1280, H: () => 720,
    ctx: makeCtx(),
    COLORS: { red: '#C8261C', cream: '#E8E4D8', black: '#000' },
    _r: (zh, en) => en,
    getOperatorName: () => 'V-07',
    getCycleNum: () => 1,
    isRespawnBuffed: () => false,
    applyRespawnBuff: () => { calls.applyBuff++; },
    requestRewardedAd: (type, cb) => cb(true),     // ad always succeeds
    showSwapToast: () => { calls.toast++; },
    _mpRequestRespawn: () => { calls.mpRequest++; return true; },
    PlayerLifecycle: { reviveAtSpawn: () => { calls.reviveAtSpawn++; sb.player.alive = true; } },
    player: { x: 100, y: 100, alive: true, _killer: { callsign: 'REAPER' }, _killerWeapon: 'RIFLE', _recentHits: [] },
    allies: [],
    game: {
      _nnMode: true, time: 0,
      _teamWipe: { blue: { wipedSince: 1, respawnAt: 900, respawnAtMs: 0 } },
      _arenaReviveTeam: () => { calls.arenaTeam++; sb.player.alive = true; },
      _arenaRevivePlayerOnly: () => { calls.arenaPlayerOnly++; sb.player.alive = true; },
    },
    _calls: calls,
  };
  sb.window = sb;
  Object.assign(sb, over || {});
  const ctx = vm.createContext(sb);
  vm.runInContext(src, ctx);
  return sb;
}

console.log('MP ad-revive authority test — death_recap _adRevivePlayer:');

// 0. Exports present.
{
  const sb = makeSandbox();
  check(typeof sb._adRevivePlayer === 'function', '_adRevivePlayer declared');
  check(typeof sb.triggerDeathRecap === 'function', 'triggerDeathRecap declared');
}

// 1. MP — kills the dead player locally? NO. Asks the server, stays dead.
{
  const sb = makeSandbox({ _mpIsActive: () => true });
  sb.player.alive = false;
  sb.triggerDeathRecap();          // re-arm (clears adReviveUsed latch)
  sb._adRevivePlayer();
  check(sb._calls.mpRequest === 1, 'MP → sends server requestRespawn');
  check(sb._calls.applyBuff === 1, 'MP → applies respawn buff (so request carries buffActive)');
  check(sb.player.alive === false, 'MP → player STAYS DEAD (no local revive → no reconcile yank)');
  check(sb._calls.arenaTeam === 0 && sb._calls.arenaPlayerOnly === 0 && sb._calls.reviveAtSpawn === 0,
        'MP → NO local revive path is taken');
}

// 2. SOLO — no authority, so it DOES revive locally.
{
  const sb = makeSandbox({ _mpIsActive: () => false });
  sb.player.alive = false;
  sb.triggerDeathRecap();
  sb._adRevivePlayer();
  check(sb._calls.mpRequest === 0, 'SOLO → never touches the server path');
  check(sb.player.alive === true, 'SOLO → player revives locally');
  check(sb._calls.arenaPlayerOnly === 1 || sb._calls.arenaTeam === 1 || sb._calls.reviveAtSpawn === 1,
        'SOLO → a local revive path fired');
}

// 3. Re-arm: the button works again on a LATER death (latch reset per death).
{
  const sb = makeSandbox({ _mpIsActive: () => true });
  sb.player.alive = false;
  sb.triggerDeathRecap(); sb._adRevivePlayer();        // first death → 1 request
  // a second click on the SAME death is swallowed by the in-flight latch
  sb._adRevivePlayer();
  check(sb._calls.mpRequest === 1, 'same-death double-click swallowed (in-flight guard)');
  // next death re-arms
  sb.player.alive = false;
  sb.triggerDeathRecap(); sb._adRevivePlayer();
  check(sb._calls.mpRequest === 2, 'later death re-arms the watch-ad button (no permanent latch)');
}

// 4. Ad FAILURE must not consume the offer (player can retry).
{
  const sb = makeSandbox({ _mpIsActive: () => true, requestRewardedAd: (t, cb) => cb(false) });
  sb.player.alive = false;
  sb.triggerDeathRecap();
  sb._adRevivePlayer();                                  // ad fails
  check(sb._calls.mpRequest === 0, 'failed ad → no respawn request');
  sb.requestRewardedAd = (t, cb) => cb(true);            // now it works
  sb._adRevivePlayer();                                  // retry same death
  check(sb._calls.mpRequest === 1, 'failed ad did NOT consume the offer (retry works)');
}

if (problems.length === 0) { console.log('OK — MP ad-revive is server-authoritative; SOLO revives locally; button re-arms.'); process.exit(0); }
console.error('\nFAIL — MP ad-revive rule broken:');
for (const p of problems) console.error('  ✗ ' + p);
process.exit(1);
