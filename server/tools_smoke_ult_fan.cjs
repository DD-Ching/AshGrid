// Phase 188N smoke — verify the server's heavy-ULTIMATE burst FAN is CONCENTRATED
// (ULT_FAN_MAX cap), i.e. it matches js/heavy_arsenal.js after the deploy. Connects one
// client, spawns its player, then sends an `ultimateBurst` of N RIFLEs at angle 0 and
// measures the spawned bullets' velocity angles. With the cap, the whole volley stays
// within ±ULT_FAN_MAX (+ a little weapon spread); WITHOUT it, N guns fan to
// (N-1)/2 * ULT_FAN_STEP rad (e.g. 24 guns → ±1.61 rad). Asserts the measured half-fan
// is well under the uncapped value, proving the deployed server concentrates the volley.
//
//   node tools_smoke_ult_fan.cjs [wss://ashgrid-mp.dd-ching.partykit.dev]
//
// Exit 0 = fan is concentrated. Exit 1 = too wide (cap not live) or no bullets seen.
const WS = require('ws');
const HOST = process.argv[2] || 'wss://ashgrid-mp.dd-ching.partykit.dev';
const ROOM = 'smoke-188n-ultfan';
const URL = `${HOST}/parties/main/${ROOM}`;

const N = 24;                       // guns in the burst (≤ ULT_BURST_MAX 50)
const ULT_FAN_STEP = 0.14;          // mirror of the server/client const
const ULT_FAN_MAX  = 0.45;          // mirror of the server/client const
const UNCAPPED_HALF = (N - 1) / 2 * ULT_FAN_STEP;       // ≈1.61 rad if the cap were absent
const PASS_LIMIT = ULT_FAN_MAX + 0.12;                  // cap + spread/quantization headroom (0.57)

function run() {
  return new Promise((resolve) => {
    const ws = new WS(URL);
    let myId = null;
    let maxDev = 0;
    let seen = 0;
    let done = false;
    const finish = (detail) => {
      if (done) return; done = true;
      try { ws.close(); } catch {}
      const ok = seen >= Math.ceil(N * 0.6) && maxDev <= PASS_LIMIT;
      resolve({ ok, seen, maxDev, detail });
    };
    const timer = setTimeout(() => finish('window elapsed'), 8000);

    ws.on('open', () => {
      const input = { type: 'input', dx: 0, dy: 0, angle: 0, fire: false, seq: 1, vT: 0 };
      const send = () => { try { ws.send(JSON.stringify(input)); } catch {} };
      send();
      const iv = setInterval(() => { input.seq++; send(); }, 100);
      ws.once('close', () => clearInterval(iv));
      // Warm up (a cold room needs the player to spawn + settle), then fire the
      // full-arsenal burst at angle 0. Retry across the ULT_COOLDOWN (~1 s) so an
      // early shot on a cold room doesn't make the smoke flaky.
      const burst = () => { try { ws.send(JSON.stringify({ type: 'ultimateBurst', weapons: Array(N).fill('RIFLE'), angle: 0 })); } catch {} };
      for (const t of [1500, 2800, 4100]) setTimeout(burst, t);
    });

    ws.on('message', (buf) => {
      let d; try { d = JSON.parse(buf.toString()); } catch { return; }
      if (d.type === 'welcome') { myId = d.id; return; }
      if (d.type !== 'snapshot' || !Array.isArray(d.bullets)) return;
      for (const b of d.bullets) {
        if (b.spawn !== 1 || b.s !== myId || typeof b.vx !== 'number') continue;
        const ang = Math.atan2(b.vy, b.vx);     // baseAngle 0 → ang is the off-aim deviation
        const dev = Math.abs(ang);
        if (dev > maxDev) maxDev = dev;
        seen++;
      }
      if (seen >= N) { clearTimeout(timer); finish(''); }
    });
    ws.on('error', (e) => finish('ws error: ' + e.message));
  });
}

(async () => {
  console.log('smoke 188N (ult-fan concentration) → ' + URL);
  const r = await run();
  console.log(`  bullets seen: ${r.seen}/${N}   measured half-fan: ${r.maxDev.toFixed(3)} rad`);
  console.log(`  cap ULT_FAN_MAX=${ULT_FAN_MAX} (pass ≤ ${PASS_LIMIT.toFixed(2)})   uncapped would be ≈${UNCAPPED_HALF.toFixed(2)} rad`);
  if (r.ok) { console.log('PASS — heavy ultimate fan is concentrated on the deployed server.'); process.exit(0); }
  console.error('FAIL — ' + (r.detail || `half-fan ${r.maxDev.toFixed(3)} > ${PASS_LIMIT.toFixed(2)} or too few bullets (${r.seen}/${N})`));
  process.exit(1);
})();
