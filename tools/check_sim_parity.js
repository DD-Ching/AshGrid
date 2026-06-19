#!/usr/bin/env node
/* eslint-disable */
// ============ SOLO/MP SIM PARITY CHECK (Phase 143) ============
// SOLO (client, 60 fps) and MP (server, server-authoritative) each carry their
// OWN copy of the weapon physics + the NN observation layout. If they drift,
// MP prediction desyncs and "did online get the same numbers?" becomes a
// recurring doubt. This asserts the two stay in lock-step:
//
//   1. WEAPONS — client js/weapons.js (60 fps) must equal the server's
//      _BASE_30HZ baseline (server/party/sim/weapons.js) rescaled by 60/30:
//        damage / spread / pellets / blast* : identical (tick-independent)
//        fireCd      = base.fireCdTicks * 2
//        bulletSpeed = base.bulletSpeed / 2
//        bulletLife  = base.bulletLife  * 2
//   2. OBS_DIM — client OBS_DIM must equal the server buildObs() output length.
//
// Exit 1 on any mismatch (CI / pre-commit gate). No dependencies.
//
// Loading the two worlds: the server is ESM (server/package.json type:module)
// → dynamic import(). The client js/weapons.js is a classic browser script
// that assumes a `window` global → run it in a vm sandbox and lift out WEAPONS.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CLIENT_HZ = 60, BASE_HZ = 30, F = CLIENT_HZ / BASE_HZ;   // 2

const problems = [];
const fail = (msg) => problems.push(msg);

// ── Load the client WEAPONS table out of the classic script ───────────────
function loadClientWeapons() {
  const src = fs.readFileSync(path.join(ROOT, 'js/weapons.js'), 'utf8')
            + '\n;globalThis.__weaponsOut = WEAPONS;';
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'js/weapons.js' });
  return sandbox.__weaponsOut;
}

// ── Read the client OBS_DIM (the NN config table) ──
// Phase 185 — the NN object moved from index.html's inline script into
// js/nn_loader.js; read it there, with index.html as a fallback for safety.
function loadClientObsDim() {
  for (const rel of ['js/nn_loader.js', 'index.html']) {
    try {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const m = src.match(/OBS_DIM:\s*(\d+)/);
      if (m) return parseInt(m[1], 10);
    } catch (e) { /* try next */ }
  }
  return null;
}

function near(a, b) { return Math.abs(a - b) < 1e-9; }

(async () => {
  const client = loadClientWeapons();
  const { _BASE_30HZ, getWeaponSim } = await import(
    'file://' + path.join(ROOT, 'server/party/sim/weapons.js')
  );

  // ── 1. Weapon parity ─────────────────────────────────────────────────────
  let checked = 0;
  for (const [id, base] of Object.entries(_BASE_30HZ)) {
    const c = client[id];
    if (!c) { fail(`weapon ${id}: present in server _BASE_30HZ but missing in client WEAPONS`); continue; }
    checked++;
    const expect = {
      damage:      base.damage,
      spread:      base.spread,
      pellets:     base.pellets != null ? base.pellets : 1,
      fireCd:      base.fireCdTicks * F,
      bulletSpeed: base.bulletSpeed / F,
      bulletLife:  base.bulletLife * F,
    };
    const got = {
      damage:      c.damage,
      spread:      c.spread,
      pellets:     c.pellets != null ? c.pellets : 1,
      fireCd:      c.fireCd,
      bulletSpeed: c.bulletSpeed,
      bulletLife:  c.bulletLife,
    };
    for (const k of Object.keys(expect)) {
      if (!near(got[k], expect[k]))
        fail(`weapon ${id}.${k}: client=${got[k]} but server baseline implies ${expect[k]}`);
    }
    // Rocket AOE fields are tick-independent → must be identical.
    if (base.isRocket) {
      for (const k of ['blastR', 'blastDmg', 'structDmgMul']) {
        if (!near(c[k], base[k]))
          fail(`weapon ${id}.${k}: client=${c[k]} server=${base[k]}`);
      }
    }
  }
  console.log(`Weapon parity: checked ${checked} weapons against the 30-Hz baseline.`);

  // ── 2. Obs dimension parity ──────────────────────────────────────────────
  const clientDim = loadClientObsDim();
  const { buildObs } = await import(
    'file://' + path.join(ROOT, 'server/party/sim/nn_obs.js')
  );
  // Run buildObs on an empty world — the enemy/teammate loops are skipped, so
  // it just walks the layout to the end and returns the length.
  const me = { x: 0, y: 0, angle: 0, alive: true, hp: 100, _recentDmg: 0, _fireCd: 0 };
  const buf = new Float32Array(256);
  let serverDim = null;
  try { serverDim = buildObs(me, [], [], buf, false); }
  catch (e) { fail(`server buildObs() threw: ${e.message}`); }

  if (clientDim == null) fail('could not find client OBS_DIM in index.html');
  if (serverDim != null && clientDim != null && serverDim !== clientDim)
    fail(`OBS_DIM mismatch: client=${clientDim} server buildObs len=${serverDim}`);
  console.log(`Obs parity: client OBS_DIM=${clientDim}, server buildObs len=${serverDim}.`);

  // ── 3. Arena recruit constants parity (client ↔ server) ──────────────────
  // Every recruit gate lives as a const literal on BOTH sides of the network
  // boundary (client js/arena_recruitment.js, server server/party/server.js).
  // If any drift, the client lights "▶ G RECRUIT" for a recruit the server then
  // silently rejects — the exact dead-zone class Phase 163's seed-floor fix
  // chased. Regex each out and assert equality. (SEED_GAP + SQUAD_CAP since
  // Phase 163; HP_GATE + TOUCH_BUFFER named server-side + locked in Phase 166.)
  const constOf = (relPath, name) => {
    const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*(-?\\d+(?:\\.\\d+)?)'));
    return m ? parseFloat(m[1]) : null;
  };
  for (const name of ['ARENA_SEED_GAP', 'ARENA_SQUAD_CAP', 'ARENA_HP_GATE', 'ARENA_TOUCH_BUFFER']) {
    const cv = constOf('js/arena_recruitment.js', name);
    const sv = constOf('server/party/server.js', name);
    if (cv == null) fail(`${name}: not found in js/arena_recruitment.js`);
    if (sv == null) fail(`${name}: not found in server/party/server.js`);
    if (cv != null && sv != null && cv !== sv)
      fail(`${name} mismatch: client=${cv} server=${sv}`);
  }
  console.log('Arena recruit parity: SEED_GAP + SQUAD_CAP + HP_GATE + TOUCH_BUFFER checked client↔server.');

  // ── 4. Heavy ULTIMATE fan-step parity (client ↔ server) ──────────────────
  // The heavy 大招 spawns its all-weapons fan twice: a client _mpGhost burst
  // (js/heavy_arsenal.js — instant visual) and the authoritative server burst
  // (server/party/server.js ultimateBurst). Both splay barrels by ULT_FAN_STEP
  // radians; if the two literals drift, the ghost fan and the real bullets
  // diverge. Bind them (184m — both were a bare 0.14 with no guard).
  {
    const cv = constOf('js/heavy_arsenal.js', 'ULT_FAN_STEP');
    const sv = constOf('server/party/server.js', 'ULT_FAN_STEP');
    if (cv == null) fail('ULT_FAN_STEP: not found in js/heavy_arsenal.js');
    if (sv == null) fail('ULT_FAN_STEP: not found in server/party/server.js');
    if (cv != null && sv != null && cv !== sv) fail(`ULT_FAN_STEP mismatch: client=${cv} server=${sv}`);
    else if (cv != null) console.log(`Heavy ultimate fan parity: ULT_FAN_STEP=${cv} checked client↔server.`);
    // 188N — the fan is also CAPPED by ULT_FAN_MAX so a big arsenal stays concentrated;
    // if the two caps drift, the client ghost cone and the authoritative cone diverge.
    const cm = constOf('js/heavy_arsenal.js', 'ULT_FAN_MAX');
    const sm = constOf('server/party/server.js', 'ULT_FAN_MAX');
    if (cm == null) fail('ULT_FAN_MAX: not found in js/heavy_arsenal.js');
    if (sm == null) fail('ULT_FAN_MAX: not found in server/party/server.js');
    if (cm != null && sm != null && cm !== sm) fail(`ULT_FAN_MAX mismatch: client=${cm} server=${sm}`);
    else if (cm != null) console.log(`Heavy ultimate fan cap parity: ULT_FAN_MAX=${cm} checked client↔server.`);
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  if (problems.length === 0) { console.log('OK — SOLO and MP sim are in lock-step.'); process.exit(0); }
  console.error('\nFAIL — sim parity drift:');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
})().catch(e => { console.error('parity check crashed:', e); process.exit(2); });
