// Phase 184e smoke — verify the server sizes per-chassis maxHp from input.hMul.
// Connects clients (sequentially) to a local `partykit dev` server, each sends
// an `input` with a different hMul (heavy 1.8, wolf 0.70, humanoid none/1.0,
// over-cap 9.0→clamp 3×), collects snapshots for a fixed window, then asserts
// the SETTLED maxHp / hp (not the first snapshot — on a cold room the first
// snapshot is the pre-input spawn default).
//
//   node tools_smoke_chassis_hp.cjs [ws://localhost:1999]
//
// Exit 0 = all assertions pass. Exit 1 = a mismatch (printed).
const WS = require('ws');
const HOST = process.argv[2] || 'ws://localhost:1999';
const ROOM = 'smoke-184e';
const URL = `${HOST}/parties/main/${ROOM}`;

// chassis under test → expected maxHp (HP_MAX=100) + maxArmor. null hMul/aMax =
// don't send the field (humanoid default). Heavy carries armour 60; over-cap
// exercises both clamps (hMul 3×, aMax ARMOR_MAX_CAP 500).
const CASES = [
  { name: 'heavy',    hMul: 1.8,  aMax: 60,   expMax: 180, expArmor: 60  },
  { name: 'wolf',     hMul: 0.70, aMax: 0,    expMax: 70,  expArmor: 0   },
  { name: 'humanoid', hMul: null, aMax: null, expMax: 100, expArmor: 0   },
  { name: 'clamp-hi', hMul: 9.0,  aMax: 9999, expMax: 300, expArmor: 500 },  // clamps: hMul→3×, aMax→500
];

function runCase(c) {
  return new Promise((resolve) => {
    const ws = new WS(URL);
    let myId = null;
    const seen = { maxHp: null, hp: null, maxArmor: null, armor: null };
    let done = false;
    const finish = (detail) => {
      if (done) return; done = true;
      try { ws.close(); } catch {}
      const ok = (seen.maxHp === c.expMax) && (seen.maxArmor === c.expArmor)
              && (seen.hp != null && seen.hp <= seen.maxHp);
      resolve({ name: c.name, ok, detail: ok ? '' : (detail || `got maxHp=${seen.maxHp} maxArmor=${seen.maxArmor} hp=${seen.hp}, expected maxHp=${c.expMax} maxArmor=${c.expArmor}`), seen });
    };
    // Collect for a fixed 2.5s window (many 20Hz ticks → the resize definitely
    // applies, even on a cold first connection) and assert the SETTLED values.
    const timer = setTimeout(() => finish('window elapsed'), 2500);

    ws.on('open', () => {
      const input = { type: 'input', dx: 0, dy: 0, angle: 0, fire: false, seq: 1, vT: 0 };
      if (c.hMul != null) input.hMul = c.hMul;
      if (c.aMax != null) input.aMax = c.aMax;
      const send = () => { try { ws.send(JSON.stringify(input)); } catch {} };
      send();
      const iv = setInterval(send, 200);
      ws.once('close', () => clearInterval(iv));
    });

    ws.on('message', (buf) => {
      let d; try { d = JSON.parse(buf.toString()); } catch { return; }
      if (d.type === 'welcome') { myId = d.id; return; }
      if (d.type !== 'snapshot' || !Array.isArray(d.players)) return;
      const me = d.players.find(p => p.id === myId);
      if (!me) return;
      if (typeof me.maxHp === 'number')    seen.maxHp    = me.maxHp;   // keep latest
      if (typeof me.hp === 'number')       seen.hp       = me.hp;
      if (typeof me.maxArmor === 'number') seen.maxArmor = me.maxArmor;
      if (typeof me.armor === 'number')    seen.armor    = me.armor;
      // Early-out once both ceilings have settled.
      if (seen.maxHp === c.expMax && seen.maxArmor === c.expArmor) { clearTimeout(timer); finish(''); }
    });
    ws.on('error', (e) => finish('ws error: ' + e.message));
  });
}

(async () => {
  console.log('smoke 184e → ' + URL);
  let allOk = true;
  for (const c of CASES) {
    const r = await runCase(c);
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${r.name.padEnd(9)} hMul=${String(c.hMul).padEnd(5)} aMax=${String(c.aMax).padEnd(5)} → maxHp=${r.seen.maxHp} armor=${r.seen.maxArmor} hp=${r.seen.hp}` + (r.detail ? `  (${r.detail})` : ''));
    if (!r.ok) allOk = false;
  }
  console.log(allOk ? 'ALL PASS' : 'SOME FAILED');
  process.exit(allOk ? 0 : 1);
})();
