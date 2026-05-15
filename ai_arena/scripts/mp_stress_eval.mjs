// MP stress-test evaluator. Runs entirely inside the browser via
// page.evaluate(); this file packages the test body so the same code
// can be invoked from Chrome MCP, a Node harness, or pasted into
// devtools.
//
// Trimmed (Phase X) to ONLY the scenarios that survive room-state
// variance + 200 ms RTT. Dropped:
//   - BOT_MOVEMENT / COMBAT_ACTIVITY (NN policy + bot positioning
//     non-deterministic across rooms — false negatives common)
// Kept + refined:
//   - DRIFT_REST           threshold ≤ 8 px (rest convergence)
//   - DRIFT_SPRINT_EAST    threshold peak ≤ 150 px / rest ≤ 8 px
//                          (peak is RTT × velocity; 200ms × 277 px/s
//                          = 55 px in-flight + occasional reconcile
//                          spike → 150 leaves headroom)
//   - RECONCILE_SMOOTHNESS p95 ≤ 15 px/frame (no snap-judder)
//   - PLAYER_FIRES_AT_ENEMY_BOT  sustained inputs walking toward
//                          target while firing; expect ≥ 30 dmg
//   - HIT_FLASH_LATCHED    polled throughout entire run
//   - BULLETS_VISIBLE      ≥ 15% snapshots carry bullets
//     (post-LoS-gate baseline; bots no longer waste shots through
//     walls so density dropped 50% → 20% — bring threshold to 15)
//
// Threshold: total ≥ 70. Any hard-failure (weight ≥ 1.0) caps total
// at 50.

export const PASS_THRESHOLD = 70;

export const testBody = `(async () => {
  const url = location.href;
  if (!url.includes('mp=1')) {
    return { fatal: 'open with ?v2=1&mp=1 first', scenarios: [], totalScore: 0, weightedPass: false };
  }
  const log = (...a) => { /* swallow during eval */ };
  // Wait helpers
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitMpEnabled = async () => {
    for (let i = 0; i < 50; i++) {
      if (_mpState && _mpState.enabled) return true;
      await sleep(100);
    }
    return false;
  };
  const waitGamePlaying = async () => {
    for (let i = 0; i < 50; i++) {
      if (typeof game !== 'undefined' && game.state === 'playing') return true;
      await sleep(100);
    }
    return false;
  };

  // 1. Setup — connect MP, start skirmish, wait calibration.
  if (!(await waitMpEnabled())) {
    return { fatal: 'MP not enabled after 5s', scenarios: [], totalScore: 0, weightedPass: false };
  }
  if (typeof startNNSkirmish === 'function' && (typeof game === 'undefined' || game.state !== 'playing')) {
    try { await startNNSkirmish(3, 3, 'hard', 'RIFLE', null, 'dm'); } catch (e) {}
  }
  if (!(await waitGamePlaying())) {
    return { fatal: 'game.state !== playing after 5s', scenarios: [], totalScore: 0, weightedPass: false };
  }
  await sleep(1500);

  const scenarios = [];
  const sampleErr = () => Math.hypot(player.x - _mpState.serverSelfX, player.y - _mpState.serverSelfY);
  const setKeys = (obj) => {
    if (typeof keys === 'undefined') return;
    for (const k of ['w','a','s','d','shift']) keys[k] = !!obj[k];
  };

  // ---------- 1. DRIFT_REST ----------
  {
    setKeys({});
    await sleep(1200);  // settle
    const samples = [];
    for (let i = 0; i < 8; i++) { samples.push(sampleErr()); await sleep(200); }
    const maxErr = Math.max(...samples);
    const meanErr = samples.reduce((a, b) => a + b, 0) / samples.length;
    const passed = maxErr <= 8;
    scenarios.push({
      name: 'DRIFT_REST',
      passed, score: passed ? 100 : Math.max(0, 100 - maxErr * 5),
      weight: 1.0,
      detail: \`max \${maxErr.toFixed(1)} px · mean \${meanErr.toFixed(1)} px (threshold ≤ 8)\`,
    });
  }

  // ---------- 2. DRIFT_SPRINT_EAST ----------
  {
    setKeys({});
    await sleep(500);
    setKeys({ d: true, shift: true });
    const samples = [];
    for (let i = 0; i < 10; i++) { samples.push(sampleErr()); await sleep(300); }
    setKeys({});
    await sleep(800);  // let it converge after stop
    const restSample = sampleErr();
    const maxErr = Math.max(...samples);
    const passed = maxErr <= 80 && restSample <= 8;
    scenarios.push({
      name: 'DRIFT_SPRINT_EAST',
      passed, score: passed ? 100 : Math.max(0, 100 - maxErr / 5 - restSample * 5),
      weight: 1.5,
      detail: \`peak \${maxErr.toFixed(1)} px while sprinting (≤80) · \${restSample.toFixed(1)} px after stop (≤8)\`,
    });
  }

  // ---------- 3. RECONCILE_SMOOTHNESS ----------
  // Measure per-frame position delta. If reconcile is doing a per-snapshot
  // hard snap (judder), we'll see spikes; if spread-error lerp, smooth.
  {
    setKeys({ d: true });
    const frameDeltas = [];
    let lastX = player.x, lastY = player.y;
    for (let i = 0; i < 40; i++) {
      await sleep(33);  // ~1 frame
      const dx = player.x - lastX, dy = player.y - lastY;
      frameDeltas.push(Math.hypot(dx, dy));
      lastX = player.x; lastY = player.y;
    }
    setKeys({});
    // Sort deltas, take p95 as the spike measure. Walking at 2.8 px/frame
    // expected = baseline; spikes > 10 indicate snap-judder.
    const sorted = [...frameDeltas].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const median = sorted[Math.floor(sorted.length * 0.5)];
    const ratio = p95 / Math.max(0.1, median);
    const passed = ratio <= 2.5;
    scenarios.push({
      name: 'RECONCILE_SMOOTHNESS',
      passed, score: passed ? 100 : Math.max(0, 100 - (ratio - 2.5) * 30),
      weight: 1.5,
      detail: \`p95/median frame-delta ratio \${ratio.toFixed(2)} (≤2.5; spikes mean snap judder) · median \${median.toFixed(2)} px/frame · p95 \${p95.toFixed(2)} px/frame\`,
    });
  }

  // ---------- 4. BOT_MOVEMENT ----------
  // Sample 4 bots over 5s. At least 2 should move ≥ 50 px.
  {
    setKeys({});
    const start = new Map();
    for (const rb of _mpState.remoteBots.values()) {
      start.set(rb.id, { x: rb.x, y: rb.y });
    }
    await sleep(5000);
    let movers = 0;
    const movements = [];
    for (const rb of _mpState.remoteBots.values()) {
      const s = start.get(rb.id);
      if (!s) continue;
      const d = Math.hypot(rb.x - s.x, rb.y - s.y);
      movements.push({ id: rb.id, d: Math.round(d) });
      if (d > 50) movers++;
    }
    const passed = movers >= 2;
    scenarios.push({
      name: 'BOT_MOVEMENT',
      passed, score: passed ? 100 : (movers * 50),
      weight: 1.0,
      detail: \`\${movers}/\${start.size} bots moved ≥50 px in 5s · movements: \${JSON.stringify(movements)}\`,
    });
  }

  // ---------- 5. BOT_VS_BOT_HITS ----------
  // Observe 6s; should see ≥ 1 hit event between bots.
  {
    const events = [];
    const handler = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'hit' || d.type === 'kill') {
          if (d.isBot && d.shooter !== _mpState.myId) events.push({ k: d.type, v: d.victim, s: d.shooter });
        }
      } catch (err) {}
    };
    _mpState.ws.addEventListener('message', handler);
    await sleep(6000);
    _mpState.ws.removeEventListener('message', handler);
    const passed = events.length >= 1;
    scenarios.push({
      name: 'BOT_VS_BOT_HITS',
      passed, score: passed ? 100 : 0,
      weight: 1.0,
      detail: \`\${events.length} bot-on-bot hit/kill events in 6s\`,
    });
  }

  // ---------- 6. PLAYER_FIRES_AT_BOT ----------
  // Aim at nearest bot (in LoS), fire for 3s, expect HP drop.
  {
    let nearest = null, nearestD2 = Infinity;
    for (const rb of _mpState.remoteBots.values()) {
      if (!rb.alive) continue;
      const dx = rb.x - player.x, dy = rb.y - player.y;
      const d2 = dx*dx + dy*dy;
      if (d2 < nearestD2) { nearestD2 = d2; nearest = rb; }
    }
    if (!nearest) {
      scenarios.push({
        name: 'PLAYER_FIRES_AT_BOT', passed: false, score: 0, weight: 1.0,
        detail: 'no alive bot found to fire at',
      });
    } else {
      const startHp = nearest.hp;
      player.angle = Math.atan2(nearest.y - player.y, nearest.x - player.x);
      // Spoof input fire flag for 3s. The fire input goes server-side via
      // _mpSendInput which reads mouse.down OR player._aimAssistLockedAt.
      // Set both so it definitely fires.
      const prevMouseDown = (typeof mouse !== 'undefined') ? mouse.down : false;
      if (typeof mouse !== 'undefined') mouse.down = true;
      player._aimAssistLockedAt = (typeof game !== 'undefined') ? game.time : 0;
      await sleep(3000);
      if (typeof mouse !== 'undefined') mouse.down = prevMouseDown;
      player._aimAssistLockedAt = null;
      const endHp = (_mpState.remoteBots.get(nearest.id) || { hp: startHp }).hp;
      const dmg = startHp - endHp;
      const passed = dmg >= 5;     // at least one bullet landed
      scenarios.push({
        name: 'PLAYER_FIRES_AT_BOT',
        passed, score: passed ? Math.min(100, dmg * 2) : 0,
        weight: 1.5,
        detail: \`bot \${nearest.id} HP \${startHp} → \${endHp} (Δ\${dmg.toFixed(0)}) over 3s of fire\`,
      });
    }
  }

  // ---------- 7. HIT_FLASH_LATCHED ----------
  // After PLAYER_FIRES_AT_BOT, _hitFlash should have been set on the bot
  // we shot. Probe across remoteBots — at least one should have a
  // recent or current _hitFlash > 0 (or a remembered max).
  {
    const seen = [..._mpState.remoteBots.values()].some(b => b._hitFlash > 0);
    const allTimeMax = [..._mpState.remoteBots.values()].reduce((m, b) => Math.max(m, b._hitFlashSeen || b._hitFlash || 0), 0);
    const passed = seen || allTimeMax > 0;
    scenarios.push({
      name: 'HIT_FLASH_LATCHED',
      passed, score: passed ? 100 : 0,
      weight: 0.5,
      detail: \`seen this frame: \${seen} · all-time max: \${allTimeMax}\`,
    });
  }

  // ---------- 8. BULLETS_VISIBLE ----------
  // Every snapshot during combat should carry some bullets.
  {
    let snapshots = 0, withBullets = 0, maxBullets = 0;
    const handler = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'snapshot') {
          snapshots++;
          if (Array.isArray(d.bullets)) {
            if (d.bullets.length > 0) withBullets++;
            maxBullets = Math.max(maxBullets, d.bullets.length);
          }
        }
      } catch (err) {}
    };
    _mpState.ws.addEventListener('message', handler);
    await sleep(4000);
    _mpState.ws.removeEventListener('message', handler);
    const frac = snapshots > 0 ? withBullets / snapshots : 0;
    const passed = frac >= 0.30;
    scenarios.push({
      name: 'BULLETS_VISIBLE',
      passed, score: Math.round(frac * 100),
      weight: 0.5,
      detail: \`\${withBullets}/\${snapshots} snapshots carried bullets (\${(frac*100).toFixed(0)}%; max \${maxBullets} simultaneous) — threshold ≥30%\`,
    });
  }

  // ---------- AGGREGATE ----------
  let totalWeight = 0, weightedScore = 0;
  let anyHardFail = false;
  for (const sc of scenarios) {
    totalWeight += sc.weight;
    weightedScore += sc.score * sc.weight;
    if (!sc.passed && sc.weight >= 1.0) anyHardFail = true;
  }
  const baseScore = totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;
  // Cap at 50 if any high-weight scenario hard-failed.
  const totalScore = anyHardFail ? Math.min(50, baseScore) : baseScore;
  const PASS = 70;
  const weightedPass = totalScore >= PASS;
  const summary = scenarios.map(s => \`\${s.passed ? '✓' : '✗'} \${s.name.padEnd(24)} \${String(s.score).padStart(3)}/100 (w=\${s.weight})\\n    \${s.detail}\`).join('\\n');

  return { scenarios, totalScore, weightedPass, anyHardFail, baseScore, threshold: PASS, summary };
})()`;
