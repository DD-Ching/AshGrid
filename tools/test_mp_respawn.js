// AshGrid MP respawn-authority smoke test (Phase 180) — guards the load-bearing
// server rule for "請求 → 權威 → 返回房間": _respawnDecision in
// server/party/server.js, the single source of truth shared by the auto AFK-gate
// path and the explicit requestRespawn handler.
//
// Invariants:
//   • never respawn while alive;
//   • never respawn before the timer (tickCount < respawnAt);
//   • AUTO path: respawn only when recently active (idleTicks < afkMax) — an
//     AFK / tabbed-out player is HELD (R+1);
//   • REQUEST path (press SPACE): passes idleTicks=0, so once the timer has
//     elapsed it ALWAYS respawns — the request itself proves presence and
//     bypasses the AFK hold. This is what makes press-SPACE bring you back.
//
// Imports the REAL server module (ESM) via dynamic import — no room instance
// needed, the rule is pure.   node tools/test_mp_respawn.js
(async () => {
  const problems = [];
  const check = (cond, msg) => { if (!cond) problems.push(msg); else console.log('  ✓ ' + msg); };

  console.log('MP respawn-authority smoke test — _respawnDecision (server):');

  let dec;
  try {
    const mod = await import('../server/party/server.js');
    dec = mod._respawnDecision;
  } catch (e) {
    console.error('FAIL — could not import server module:', e && e.message);
    process.exit(1);
  }
  check(typeof dec === 'function', '_respawnDecision exported from server.js');

  const AFK = 600;   // 3 s @ 200 Hz (AFK_RESPAWN_MAX_TICKS)

  // alive → never respawn
  check(dec(true, 9999, 100, 0, AFK) === false, 'alive → never respawns');

  // dead, before timer → no respawn
  check(dec(false, 50, 100, 0, AFK) === false, 'dead but timer not elapsed → no respawn');
  check(dec(false, 99, 100, 0, AFK) === false, 'dead, one tick short of timer → no respawn');

  // AUTO path (idle gate)
  check(dec(false, 100, 100, 10, AFK) === true,  'dead + timer up + recently active → auto respawn');
  check(dec(false, 100, 100, AFK + 1, AFK) === false, 'dead + timer up + AFK (idle>gate) → held, no auto respawn');
  check(dec(false, 100, 100, AFK, AFK) === false, 'idle == gate → held (strict <)');

  // REQUEST path (idleTicks = 0): always returns true once eligible, even if the
  // auto path would have held them as AFK.
  check(dec(false, 100, 100, 0, AFK) === true, 'request (idle=0) + timer up → respawn (bypasses AFK hold)');
  check(dec(false, 5000, 100, 0, AFK) === true, 'request long after timer → still respawns');
  check(dec(false, 100, 200, 0, AFK) === false, 'request before timer → refused (authority gates the wait)');
  check(dec(true, 5000, 100, 0, AFK) === false, 'request while alive → no-op');

  if (problems.length === 0) { console.log('OK — MP respawn authority rule holds (auto AFK-gate + press-SPACE bypass).'); process.exit(0); }
  console.error('\nFAIL — MP respawn rule broken:');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
})();
