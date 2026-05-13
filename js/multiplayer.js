// ============ MULTIPLAYER (PartyKit + authoritative server) ============
// Phase 36+37+38 — server-side game loop with client-side prediction +
// reconciliation. Wings.io / agar.io / krunker.io architecture.
//
// Server (server/party/server.js) holds the world. Ticks at 30Hz,
// broadcasts snapshots at ~15Hz. Client sends INPUTS (move vector +
// fire flag), gets back the world state. Hits, deaths, respawns —
// all decided server-side. No more "I shot him but he didn't die"
// desync.
//
// Client work in this file:
//   1. Read keyboard/mouse → assemble {dx, dy, angle, fire, seq}
//   2. Send via WebSocket at 30Hz
//   3. PREDICT — apply own input locally for instant response
//   4. RECONCILE — when snapshot arrives, snap to server state, then
//      replay all inputs since lastInputSeq the server confirmed
//   5. Render remote players + bullets directly from snapshot
//   6. Apply hit/kill events for HUD + death recap
//
// Protocol (mirrors server.js):
//   client→server  {type:'input', seq, dx, dy, angle, fire, name?}
//   server→client  {type:'welcome', id, tick, arena}
//   server→client  {type:'snapshot', tick, players, bullets}
//   server→client  {type:'hit', victim, shooter, hp, weapon}
//   server→client  {type:'kill', shooter, victim, weapon}
//   server→client  {type:'leave', id}
//
// Resolution order for the PartyKit host:
//   1. ?ws=<host> URL param   (test against another deploy)
//   2. window.MP_PARTYKIT_HOST (paste in console for quick swap)
//   3. localhost auto-detect  (npx partykit dev workflow)
//   4. PRODUCTION_HOST below  (set after first npx partykit deploy)

const PRODUCTION_HOST = 'ashgrid-mp.dd-ching.partykit.dev';

// Movement constants — server is at 30Hz × 5.6 px/tick = ~168 px/sec.
// index.html's local movement runs at 60Hz × player.speed (≈2.8) = ~168 px/sec.
// Both agree on apparent velocity. Reconciliation just snaps to server
// truth when our local prediction drifts. We DON'T re-apply movement
// in _mpSendInput — index.html already does that per frame; doing it
// here too would double-move us.
const MP_PLAYER_SPEED   = 5.6;       // server px-per-tick (for reconciliation replay)
const MP_INPUT_HZ       = 30;        // input send rate (matches tick rate)
const MP_INPUT_PERIOD   = 1000 / MP_INPUT_HZ;
const MP_REMOTE_LERP    = 0.35;      // legacy lerp rate (only used pre-buffer fill)
const MP_BULLET_LERP    = 0.5;       // remote bullet smoothing rate (faster — bullets move fast)

// Phase 39: snapshot interpolation. Industry-standard approach (Valve, id Software,
// wings.io). Render remote entities `MP_INTERP_DELAY` ms in the past, finding the
// pair of snapshots that bracket that render time and interpolating between them.
// Result: constant-velocity smooth motion instead of easing-toward-target jitter.
// Trade-off: remote players appear ~100ms behind their actual server position.
// That's invisible to the eye at this latency and is what every multiplayer FPS
// from Quake3 onward does. Hit detection is server-side, so the visual lag never
// affects "did I hit them" — server already settled that.
const MP_INTERP_DELAY   = 100;       // ms — render remotes this far in the past
const MP_BUFFER_KEEP    = 1000;      // ms — discard buffer entries older than this

// RTT (round-trip-time, "ping") thresholds for the connection-quality dot.
const MP_PING_GREEN     = 80;        // ≤ green
const MP_PING_YELLOW    = 200;       // ≤ yellow, > red

function _mpResolveHost() {
  try {
    const params = new URLSearchParams(location.search);
    const q = params.get('ws');
    if (q) return q;
  } catch (e) {}
  if (typeof window !== 'undefined' && window.MP_PARTYKIT_HOST) {
    return String(window.MP_PARTYKIT_HOST);
  }
  if (typeof location !== 'undefined' &&
      (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    return 'localhost:1999';
  }
  return PRODUCTION_HOST;
}

const _mpState = {
  enabled:        false,
  ws:             null,
  myId:           null,
  serverTick:     0,
  roomName:       null,
  // Server-known player snapshots, keyed by peerId. The local player is
  // also in here under our own myId; we use it for reconciliation.
  // Remote entries get smoothed via lerp toward target.
  remotePlayers:  new Map(),       // peerId → {x, y, targetX, targetY, angle, hp, alive, name, invuln}
  // Server-owned bullets (id keyed). We forward-extrapolate between
  // snapshots so they don't visually jitter.
  remoteBullets:  new Map(),       // bulletId → {x, y, vx, vy, s, lastSnapshotAt}
  // Client prediction queue. Each entry is {seq, dx, dy, angle, fire}.
  // We replay these (in order, > server's lastInputSeq) every snapshot
  // so the local player position stays "ahead" of the server.
  pendingInputs:  [],
  localInputSeq:  0,
  lastSendAt:     0,
  reconnectTimer: null,
  reconnectDelay: 1000,
  // Snapshot of server-confirmed local-player position so we can rewind
  // and replay-from-here on reconciliation.
  serverSelfX:    0,
  serverSelfY:    0,
  serverSelfAngle:0,
  serverSelfHp:   100,
  serverSelfAlive:true,
  serverSelfInvuln:false,
  // Phase 39 — RTT (round-trip) latency in ms. Updated whenever we receive
  // a snapshot whose self-entry echoes back a `t` we sent. EMA smoothed so
  // a single jitter spike doesn't make the connection-quality dot flicker.
  rttMs:          0,
  rttSmoothed:    0,
  // Last server-clock value seen in a snapshot. Used by the interpolation
  // renderer to translate a render time (now − INTERP_DELAY) into a
  // server-clock time it can search the buffer with.
  serverClockOffset: 0,        // serverClock − performance.now() at receive
  // Tick rate measurement for debug HUD: snapshot count over the last 1s.
  snapshotsRecvTimes: [],
  // Phase 40 — count lag-compensated outcomes (when WE were the shooter).
  // Surfaced in the F3 debug overlay so the user can see how often the
  // server is favoring them.
  lcHitsAsShooter: 0,
  totalHitsAsShooter: 0,
  // Surface-area shim used by HUD code in index.html.
  get room() {
    return {
      getPeers: () => {
        const out = {};
        for (const id of _mpState.remotePlayers.keys()) {
          if (id !== _mpState.myId) out[id] = true;
        }
        return out;
      },
    };
  },
};

// Backward-compat shims so the existing index.html call sites still work.
const _mpRemoteBullets = [];          // mirror of remoteBullets, list form for render loop
const _mpScoreboard = new Map();
const _mpKillFeed = [];
const MP_EMOTES = ['GG', 'LOL', 'GO!', '!', '?'];
let _mpMyEmoteIdx = 0;
let _mpLastEmoteAt = 0;
let _mpLastPingAt = 0;
const _mpPings = [];

function _mpIsActive() { return !!_mpState.enabled; }
function _mpPeerCount() {
  if (!_mpState.enabled) return 0;
  // remotePlayers includes self; count is just its size.
  return _mpState.remotePlayers.size;
}

async function _mpConnect() {
  if (_mpState.enabled || _mpState.ws) return;
  const params = new URLSearchParams(location.search);
  if (params.get('mp') !== '1') return;
  const roomName = params.get('room') || 'ashgrid-main';
  _mpState.roomName = roomName;

  const host = _mpResolveHost();
  const proto = (host.startsWith('localhost') || host.startsWith('127.0.0.1'))
    ? 'ws' : 'wss';
  const url = `${proto}://${host}/parties/main/${encodeURIComponent(roomName)}`;
  _mpOpen(url);
}

function _mpOpen(url) {
  console.log('[mp] connecting to', url);
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('[mp] WebSocket constructor threw:', e);
    if (typeof showSwapToast === 'function') {
      showSwapToast('多人連線失敗 · ' + String(e).slice(0, 40));
    }
    return;
  }
  _mpState.ws = ws;
  ws.addEventListener('open', () => {
    console.log('[mp] WebSocket open');
    _mpState.reconnectDelay = 1000;
    if (typeof showSwapToast === 'function') {
      showSwapToast('▶ 多人連線 · room: ' + _mpState.roomName);
    }
  });
  ws.addEventListener('message', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data && typeof data === 'object') _mpHandleMessage(data);
  });
  ws.addEventListener('error', (e) => {
    console.error('[mp] WebSocket error:', e);
  });
  ws.addEventListener('close', (e) => {
    console.warn('[mp] WebSocket closed · code:', e.code, '· reason:', e.reason);
    _mpState.enabled = false;
    _mpState.ws = null;
    _mpState.remotePlayers.clear();
    _mpState.remoteBullets.clear();
    _mpRemoteBullets.length = 0;
    const delay = Math.min(30000, _mpState.reconnectDelay);
    _mpState.reconnectDelay = Math.min(30000, _mpState.reconnectDelay * 1.5);
    _mpState.reconnectTimer = setTimeout(() => _mpOpen(url), delay);
  });
}

function _mpHandleMessage(data) {
  switch (data.type) {
    case 'welcome':
      _mpState.myId      = data.id;
      _mpState.serverTick = data.tick || 0;
      _mpState.enabled   = true;
      console.log('[mp] welcomed as', _mpState.myId, '· tick:', _mpState.serverTick);
      break;
    case 'join':
      console.log('[mp] peer joined:', data.id);
      if (typeof showSwapToast === 'function') {
        showSwapToast('▸ 玩家加入 ' + String(data.id).slice(0, 6));
      }
      break;
    case 'leave':
      _mpState.remotePlayers.delete(data.id);
      _mpScoreboard.delete(data.id);
      console.log('[mp] peer left:', data.id);
      break;
    case 'snapshot':
      _mpHandleSnapshot(data);
      break;
    case 'hit':
      _mpHandleHit(data);
      break;
    case 'kill':
      _mpHandleKill(data);
      break;
    case 'wallHit':
      // Phase 41: server says a bullet stopped on a wall/cover. Spawn the
      // same impact spark single-player uses (small explosion w/ embers).
      // Gated by visibility — no spark for hits beyond our cone, otherwise
      // we'd hear / see invisible shots which is a wallhack-tier info leak.
      if (typeof createExplosion === 'function'
          && typeof data.x === 'number' && typeof data.y === 'number') {
        const visible = (typeof isVisibleToFriendly === 'function')
          ? isVisibleToFriendly(data.x, data.y) : true;
        if (visible) createExplosion(data.x, data.y, 'small');
      }
      break;
    case 'emote': {
      const rp = _mpState.remotePlayers.get(data.from);
      if (!rp) return;
      const idx = (typeof data.idx === 'number') ? data.idx : 0;
      rp.emote = {
        char: MP_EMOTES[((idx % MP_EMOTES.length) + MP_EMOTES.length) % MP_EMOTES.length] || '?',
        until: Date.now() + 3000,
      };
      break;
    }
    case 'ping':
      if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
      _mpPings.push({ x: data.x, y: data.y, peerId: data.from, life: 240, maxLife: 240 });
      break;
  }
}

// Apply a snapshot. The local player's position gets reconciled —
// we snap to the server's authoritative position, then re-apply every
// input we sent that hasn't been acknowledged yet (seq > lastInputSeq).
function _mpHandleSnapshot(snap) {
  _mpState.serverTick = snap.tick;
  // Phase 39: track snapshot receive times for the debug HUD's tick-rate readout.
  const nowMs = Date.now();
  const sList = _mpState.snapshotsRecvTimes;
  sList.push(nowMs);
  while (sList.length > 0 && nowMs - sList[0] > 2000) sList.shift();
  // Lock in the server clock offset on every snapshot so interpolation has a
  // stable shared time base. `sT` is the server's Date.now() at broadcast.
  if (typeof snap.sT === 'number') {
    _mpState.serverClockOffset = snap.sT - performance.now();
  }
  // ─ players ─
  const seenIds = new Set();
  for (const sp of snap.players) {
    seenIds.add(sp.id);
    if (sp.id === _mpState.myId) {
      // RTT (ping). sp.t is the freshest input timestamp the server has
      // received from us; round-trip = now - that. EMA-smooth at 0.2 so a
      // single packet hiccup doesn't strobe the quality dot.
      if (typeof sp.t === 'number' && sp.t > 0) {
        const rtt = Math.max(0, nowMs - sp.t);
        _mpState.rttMs = rtt;
        _mpState.rttSmoothed = _mpState.rttSmoothed === 0
          ? rtt
          : _mpState.rttSmoothed * 0.8 + rtt * 0.2;
      }
      // Reconcile the local player
      _mpState.serverSelfX     = sp.x;
      _mpState.serverSelfY     = sp.y;
      _mpState.serverSelfAngle = sp.angle;
      _mpState.serverSelfHp    = sp.hp;
      _mpState.serverSelfAlive = sp.alive;
      _mpState.serverSelfInvuln = !!sp.invuln;
      // Drop inputs the server has already processed
      _mpState.pendingInputs = _mpState.pendingInputs.filter(i => i.seq > sp.lastInputSeq);
      // Replay remaining inputs from the server's confirmed position
      let predX = sp.x, predY = sp.y;
      for (const inp of _mpState.pendingInputs) {
        let dx = inp.dx, dy = inp.dy;
        const mag = Math.hypot(dx, dy);
        if (mag > 1) { dx /= mag; dy /= mag; }
        predX += dx * MP_PLAYER_SPEED;
        predY += dy * MP_PLAYER_SPEED;
      }
      // Push to local player object (smoothed if delta is small, snap if large)
      if (typeof player !== 'undefined') {
        const dx = predX - player.x, dy = predY - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 80) {
          // Big snap (teleport, respawn, lag spike) → take server truth
          player.x = predX; player.y = predY;
        } else {
          // Smooth toward predicted server-corrected position
          player.x += dx * 0.3;
          player.y += dy * 0.3;
        }
        // HP / alive always trust server
        player.hp = sp.hp;
        // alive is more nuanced — we let the local death-recap state
        // machine drive 'alive' to keep its UI sequence intact. We just
        // sync the kill/respawn signals via 'kill' events below.
        player._invulnUntil = sp.invuln ? Infinity : (player._invulnUntil || 0);
      }
    } else {
      // Remote player — push this sample into a timestamped buffer so the
      // renderer can interpolate between past samples instead of easing
      // toward a moving target. `targetX/targetY` are kept for back-compat
      // (legacy lerp fallback when buffer is too sparse).
      let rp = _mpState.remotePlayers.get(sp.id);
      if (!rp) {
        rp = {
          x: sp.x, y: sp.y,
          targetX: sp.x, targetY: sp.y,
          angle: sp.angle,
          hp: sp.hp, alive: sp.alive,
          name: sp.name, invuln: !!sp.invuln,
          buffer: [],   // [{t, x, y, angle}]  t = server clock at broadcast
        };
        _mpState.remotePlayers.set(sp.id, rp);
        console.log('[mp/data] first snapshot of peer', sp.id.slice(0, 6),
          '@', Math.round(sp.x), Math.round(sp.y), '· name:', sp.name);
      }
      rp.targetX = sp.x;
      rp.targetY = sp.y;
      rp.angle   = sp.angle;
      rp.hp      = sp.hp;
      rp.alive   = sp.alive;
      rp.invuln  = !!sp.invuln;
      if (sp.name) rp.name = sp.name;
      // Buffer the sample. Server clock is the authoritative timeline so
      // multiple players' interpolations stay aligned to one another.
      const sampleT = (typeof snap.sT === 'number') ? snap.sT : nowMs;
      rp.buffer.push({ t: sampleT, x: sp.x, y: sp.y, angle: sp.angle });
      // Discard samples older than the keep-window so the buffer stays
      // bounded under long sessions.
      const cutoff = sampleT - MP_BUFFER_KEEP;
      while (rp.buffer.length > 0 && rp.buffer[0].t < cutoff) rp.buffer.shift();
    }
  }
  // Drop peers no longer in snapshot
  for (const id of [..._mpState.remotePlayers.keys()]) {
    if (id !== _mpState.myId && !seenIds.has(id)) {
      _mpState.remotePlayers.delete(id);
    }
  }
  // ─ bullets ─
  _mpState.remoteBullets.clear();
  _mpRemoteBullets.length = 0;
  for (const b of snap.bullets) {
    const bl = { id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, s: b.s, lastT: performance.now() };
    _mpState.remoteBullets.set(b.id, bl);
    _mpRemoteBullets.push(bl);
  }
}

// Phase 39: shooter-side hit feedback. When the server reports a hit and the
// shooter is us, we flash a brief "✕" on the crosshair (Counter-Strike style)
// and ping a confirmation tone. This is the visual signal every modern shooter
// gives — without it, you fire into the void and only learn you landed shots
// when the score ticks up. Decoupled from local prediction: the server is the
// only authority that says "yes, that bullet landed," so this is also the only
// place that ever flashes the marker.
let _mpHitMarker = { until: 0, kind: 'hit' };  // kind: 'hit' | 'kill'
function _mpHandleHit(data) {
  // Phase 41: server now sends impact coords; fall back to remote pos if
  // event is from older deploy (dev still in flight).
  const ix = (typeof data.x === 'number') ? data.x : null;
  const iy = (typeof data.y === 'number') ? data.y : null;
  // Victim-side: flash red, screen shake, play hit sound, blood spray.
  if (data.victim === _mpState.myId) {
    if (typeof game !== 'undefined') game.hitFlash = Math.max(game.hitFlash || 0, 12);
    if (typeof playSfx === 'function') playSfx('hit', { vol: 0.4 });
    // Phase 41: screen shake scales with damage. Single-player parity
    // (index.html: triggerShake(min(6, b.damage * 0.25), 8) on player hit).
    if (typeof triggerShake === 'function') {
      triggerShake(Math.min(6, 25 * 0.25), 8);
    }
    // Floating damage popup at the impact point so we know which side took it.
    if (typeof spawnDamagePopup === 'function' && ix != null && iy != null) {
      spawnDamagePopup(ix, iy, 25, false);
    }
    return;
  }
  // Shooter-side: hitmarker on the crosshair + damage popup at victim.
  if (data.shooter === _mpState.myId) {
    _mpHitMarker = { until: Date.now() + 180, kind: 'hit' };
    if (typeof playSfx === 'function') playSfx('beep', { vol: 0.25, freq: 1320 });
    // Phase 41: floating "-25" at the victim — single-player has this for
    // every hit on enemies. Anchored to impact coords, not victim's lerped
    // pos, so it stays put while the body drifts.
    if (typeof spawnDamagePopup === 'function' && ix != null && iy != null) {
      spawnDamagePopup(ix, iy, 25, false);
    }
    // Phase 40 telemetry: track lag-compensated vs physics hits so the F3
    // overlay can show the favor-the-shooter rate.
    _mpState.totalHitsAsShooter++;
    if (data.lc) _mpState.lcHitsAsShooter++;
  }
}

function _mpHandleKill(data) {
  // Update kill feed + scoreboard
  _mpScoreboard.set(data.shooter, (_mpScoreboard.get(data.shooter) || 0) + 1);
  const shooterName = (data.shooter === _mpState.myId)
    ? (typeof getOperatorName === 'function' ? getOperatorName() : 'YOU')
    : (_mpState.remotePlayers.get(data.shooter)?.name || String(data.shooter).slice(0, 6));
  const victimName = (data.victim === _mpState.myId)
    ? (typeof getOperatorName === 'function' ? getOperatorName() : 'YOU')
    : (_mpState.remotePlayers.get(data.victim)?.name || String(data.victim).slice(0, 6));
  _mpKillFeed.push({ killer: shooterName, victim: victimName, weapon: data.weapon || 'RIFLE', at: Date.now() });
  if (_mpKillFeed.length > 6) _mpKillFeed.splice(0, _mpKillFeed.length - 6);

  // Phase 41: death explosion — visible to ALL players, anchored at the
  // victim's last known position. Server includes x,y in the kill event;
  // fall back to the remote's lerped pos if absent (older server build).
  let dx = data.x, dy = data.y;
  if (typeof dx !== 'number' || typeof dy !== 'number') {
    if (data.victim === _mpState.myId && typeof player !== 'undefined') {
      dx = player.x; dy = player.y;
    } else {
      const rp = _mpState.remotePlayers.get(data.victim);
      if (rp) { dx = rp.x; dy = rp.y; }
    }
  }
  if (typeof createExplosion === 'function' && typeof dx === 'number') {
    createExplosion(dx, dy, 'big');
  }
  if (typeof playSfx === 'function') playSfx('death', { vol: 0.5 });

  // Local player got killed?
  if (data.victim === _mpState.myId && typeof player !== 'undefined') {
    if (typeof _lbBumpDeath === 'function') _lbBumpDeath();
    player.alive = false;
    player._killer = { callsign: shooterName };
    player._killerWeapon = data.weapon;
    if (typeof triggerShake === 'function') triggerShake(8, 18);
    if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
      game._teamWipe.blue.wipedSince = game.time;
      game._teamWipe.blue.respawnAt  = game.time + 180; // matches server RESPAWN_TICKS
    }
    if (typeof triggerDeathRecap === 'function') triggerDeathRecap();
  }
  // Local player got the kill? Fattest hitmarker variant + confirm tone +
  // KILL popup at victim.
  if (data.shooter === _mpState.myId) {
    if (typeof _lbBumpKill === 'function') _lbBumpKill();
    _mpHitMarker = { until: Date.now() + 350, kind: 'kill' };
    if (typeof playSfx === 'function') playSfx('beep', { vol: 0.4, freq: 1760 });
    if (typeof spawnDamagePopup === 'function' && typeof dx === 'number') {
      spawnDamagePopup(dx, dy, 0, true);  // `true` = kill flag → "KILL" label
    }
  }
}

function _mpSendRaw(payload) {
  const ws = _mpState.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch (e) {}
}

// Per-frame: gather input, send to server, locally predict.
// Called from index.html's game loop. We throttle to MP_INPUT_HZ.
function _mpSendInput() {
  if (!_mpState.enabled) return;
  if (typeof player === 'undefined') return;
  const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  if (now - _mpState.lastSendAt < MP_INPUT_PERIOD) return;
  _mpState.lastSendAt = now;

  // Read raw movement input from the keys[] global (index.html maintains it).
  // Phase 41: while piloting the drone (Q) or FPV (E), WASD belongs to the
  // aerial vehicle, NOT the avatar. If we still send those keys as player
  // movement, the server moves the avatar in the same direction — and since
  // it doesn't (yet) know walls, the avatar can be shoved through warehouses
  // toward wherever the drone is heading. User report: '長按某個方向 我就
  // 會瞬移到那個牆壁的另外一端'. Fix: zero the move vector for those modes.
  // The avatar still RECEIVES inputs (fire/angle still matter if we want to
  // shoot from inside the drone — currently we don't, but harmless to send).
  let dx = 0, dy = 0;
  const droneOrFpv = (typeof game !== 'undefined' &&
                      (game.mode === 'drone' || game.mode === 'fpv'));
  if (typeof keys !== 'undefined' && !droneOrFpv) {
    if (keys['d'] || keys['arrowright']) dx += 1;
    if (keys['a'] || keys['arrowleft'])  dx -= 1;
    if (keys['s'] || keys['arrowdown'])  dy += 1;
    if (keys['w'] || keys['arrowup'])    dy -= 1;
  }
  const angle = player.angle || 0;
  // Fire if mouse held and player alive (server will gate on cooldown).
  // Also gated on drone/FPV: while piloting we don't want avatar fire to
  // double-tap (drone has its own weapon, avatar is meant to be passive).
  const fire = !!(typeof mouse !== 'undefined' && mouse.down && player.alive
                  && !droneOrFpv);

  const seq = ++_mpState.localInputSeq;
  const input = {
    type: 'input',
    seq, dx, dy, angle, fire,
    // Phase 39: client wall-clock at send time. Server stamps the freshest
    // value onto our own player snapshot entry; we read it back to compute
    // RTT (no extra round-trip required — piggybacks on inputs).
    t: Date.now(),
    // Phase 40: latest snapshot tick we've rendered. The server reads this
    // on `fire` inputs to rewind targets to where we saw them, so a bullet
    // we aimed correctly at the time still lands even if the target moved
    // during the input's flight to the server. Standard lag-compensation.
    vT: _mpState.serverTick | 0,
    name: (typeof getOperatorName === 'function') ? getOperatorName() : 'PLAYER',
  };
  _mpSendRaw(input);

  // Phase 41: visual fire feedback. Server owns the bullet (we don't push
  // into the local `bullets` array in MP) but the muzzle flash is purely
  // cosmetic and tied to the ACT of firing, not the bullet object. Spawn it
  // here, throttled to match server's FIRE_COOLDOWN (6 ticks @ 30Hz =
  // 200ms), so visual cadence matches what the server actually accepts.
  // Without this, MP players fire silently and feel "muffled" — the user
  // wanted offline-grade fidelity.
  if (fire && typeof muzzleFlashes !== 'undefined') {
    const nowFire = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (nowFire - (_mpState._lastMuzzleAt || 0) >= 200) {
      _mpState._lastMuzzleAt = nowFire;
      const ax = Math.cos(angle), ay = Math.sin(angle);
      muzzleFlashes.push({
        x: player.x + ax * 22, y: player.y + ay * 22,
        angle, life: 5,
      });
      // Tiny audio feedback (single-player has this for player.fire too).
      if (typeof playSfx === 'function') playSfx('shoot', { vol: 0.35 });
    }
  }

  // Phase 38 prediction — index.html's per-frame WASD code IS our
  // prediction. We just record the input here so reconciliation can
  // replay any unacked inputs from the server's confirmed position.
  _mpState.pendingInputs.push({ seq, dx, dy, angle, fire });

  // Cap the pendingInputs queue so it doesn't grow forever during net loss
  if (_mpState.pendingInputs.length > 120) {
    _mpState.pendingInputs.splice(0, _mpState.pendingInputs.length - 120);
  }
}

// Phase 39 — per-frame remote interpolation from the timestamped buffer.
// Renders each remote player at (server-clock now − MP_INTERP_DELAY), finding
// the pair of buffered samples that bracket that render time and lerping
// linearly between them. This is the Quake/Source/wings.io approach and
// produces straight-line motion at the network's actual rate.
//
// Fallbacks:
//   • If the buffer has no usable bracket (just-joined, packet loss, render
//     time newer than newest sample), fall back to legacy lerp-toward-target.
//   • Angle uses simple lerp (NOT shortest-arc) — players rotate often enough
//     that wraparound jitter is barely perceptible at the snapshot rate.
function _mpTickRemote() {
  if (!_mpState.enabled) return;
  const offset = _mpState.serverClockOffset;
  const renderT = (offset !== 0)
    ? performance.now() + offset - MP_INTERP_DELAY
    : null;
  for (const [id, rp] of _mpState.remotePlayers) {
    if (id === _mpState.myId) continue;
    const buf = rp.buffer;
    let used = false;
    if (renderT != null && buf && buf.length >= 2) {
      // Find the latest sample with t ≤ renderT (a) and the earliest with
      // t > renderT (b). Linear search from the back is O(buf.length) but
      // buf is small (~15 entries for 1s @ 15Hz).
      let a = null, b = null;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].t <= renderT) { a = buf[i]; b = buf[i + 1] || null; break; }
      }
      if (a && b) {
        const span = Math.max(1, b.t - a.t);
        const t = Math.max(0, Math.min(1, (renderT - a.t) / span));
        rp.x = a.x + (b.x - a.x) * t;
        rp.y = a.y + (b.y - a.y) * t;
        rp.angle = a.angle + (b.angle - a.angle) * t;
        used = true;
      } else if (a && !b) {
        // Only a "past" sample exists — extrapolate would risk overshoot,
        // so just hold at the latest known position.
        rp.x = a.x; rp.y = a.y; rp.angle = a.angle;
        used = true;
      }
    }
    if (!used) {
      // Legacy fallback: ease toward last known target.
      if (rp.targetX != null) rp.x += (rp.targetX - rp.x) * MP_REMOTE_LERP;
      if (rp.targetY != null) rp.y += (rp.targetY - rp.y) * MP_REMOTE_LERP;
    }
  }
}

// Bullets advance using their snapshot velocity between snapshots.
// Each snapshot resets to authoritative pos; in-between we just glide.
function _mpTickRemoteBullets() {
  if (!_mpState.enabled) return;
  for (const b of _mpState.remoteBullets.values()) {
    b.x += b.vx;
    b.y += b.vy;
  }
}

// Render remote players. Phase 41: gated on `isVisibleToFriendly()` so an
// opponent across the map isn't visible just because the server sent their
// position. This is the same fairness rule single-player uses for AI enemies.
// Players outside the cone get a fading silhouette for ~3s (matches single-
// player's _lastSeen mechanic) — gives memory of "I just saw them dart in"
// without being a wallhack.
function _mpRenderRemote() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined' || typeof drawHumanoid !== 'function') return;
  const now = (typeof game !== 'undefined') ? game.time : 0;
  for (const [id, rp] of _mpState.remotePlayers) {
    if (id === _mpState.myId) continue;
    if (!rp.alive) continue;
    let alpha = 0;
    const visible = (typeof isVisibleToFriendly === 'function')
      ? isVisibleToFriendly(rp.x, rp.y) : true;
    if (visible) {
      rp._lastSeen = now;
      alpha = 1;
    } else if (rp._lastSeen != null && now - rp._lastSeen < 180) {
      // 3-second fade-out (180 frames @ 60fps), matches single-player.
      alpha = Math.max(0.18, 1 - (now - rp._lastSeen) / 180);
    }
    if (alpha === 0) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    drawHumanoid(rp.x, rp.y, rp.angle || 0, 0, COLORS.red, true, { _chassis: 'humanoid' });
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(rp.name || '?', rp.x, rp.y - 22);
    if (rp.invuln) {
      ctx.strokeStyle = COLORS.cream;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(rp.x, rp.y, 18, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

// Render server-owned bullets. Phase 41: vision-gated. Bullets outside our
// cone are invisible — same rule as single-player. Otherwise a hidden enemy
// shooting from across the map shows tracer streams pointing at their exact
// position, defeating the vision system.
function _mpRenderRemoteBullets() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined') return;
  for (const b of _mpState.remoteBullets.values()) {
    if (typeof isVisibleToFriendly === 'function' && !isVisibleToFriendly(b.x, b.y)) continue;
    ctx.strokeStyle = '#1A1A1A';
    ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - b.vx * 0.45, b.y - b.vy * 0.45);
    ctx.stroke();
    ctx.strokeStyle = COLORS.red; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - b.vx * 0.45, b.y - b.vy * 0.45);
    ctx.stroke();
    ctx.fillStyle = COLORS.red;
    ctx.beginPath(); ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2); ctx.fill();
  }
}

// HUD: kill feed + scoreboard + Phase 39 additions (hit marker, ping dot,
// optional debug overlay).
function _mpRenderHUD() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined') return;
  const now = Date.now();
  for (let i = _mpKillFeed.length - 1; i >= 0; i--) {
    if (now - _mpKillFeed[i].at > 5000) _mpKillFeed.splice(i, 1);
  }
  ctx.save();
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'right';
  let y = 38;
  for (const k of _mpKillFeed) {
    const age = (now - k.at) / 5000;
    ctx.globalAlpha = Math.max(0.3, 1 - age);
    ctx.fillStyle = COLORS.black;
    ctx.fillText(`${k.killer} » ${k.victim}`, W() - 18, y);
    y += 16;
  }
  ctx.globalAlpha = 1;
  if (_mpScoreboard.size > 0) {
    const entries = [..._mpScoreboard.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    let sy = H() - 20 - entries.length * 14;
    ctx.fillStyle = 'rgba(232, 228, 216, 0.85)';
    ctx.fillRect(18, sy - 14, 180, entries.length * 14 + 18);
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('SCORE', 24, sy - 2);
    for (const [pid, kills] of entries) {
      const name = (pid === _mpState.myId)
        ? (typeof getOperatorName === 'function' ? getOperatorName() : 'YOU')
        : (_mpState.remotePlayers.get(pid)?.name || String(pid).slice(0, 6));
      ctx.fillText(`${name.padEnd(12, ' ').slice(0, 12)} ${kills}`, 24, sy + 12);
      sy += 14;
    }
  }
  // ─── Phase 39: hit marker on the crosshair when our bullet just landed.
  // 'hit' kind = small red ✕ for 180ms. 'kill' kind = bigger red ✕ for 350ms.
  // Drawn in screen space because the crosshair lives at the mouse position.
  if (_mpHitMarker.until > now && typeof mouse !== 'undefined') {
    const left = _mpHitMarker.until - now;
    const dur  = _mpHitMarker.kind === 'kill' ? 350 : 180;
    const t    = Math.max(0, Math.min(1, left / dur));
    const size = (_mpHitMarker.kind === 'kill' ? 14 : 9) * (0.7 + 0.3 * t);
    ctx.save();
    ctx.globalAlpha = 0.55 + 0.45 * t;
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = _mpHitMarker.kind === 'kill' ? 3 : 2.2;
    ctx.lineCap = 'round';
    const cx = mouse.x, cy = mouse.y;
    ctx.beginPath();
    ctx.moveTo(cx - size, cy - size); ctx.lineTo(cx - 3, cy - 3);
    ctx.moveTo(cx + size, cy - size); ctx.lineTo(cx + 3, cy - 3);
    ctx.moveTo(cx - size, cy + size); ctx.lineTo(cx - 3, cy + 3);
    ctx.moveTo(cx + size, cy + size); ctx.lineTo(cx + 3, cy + 3);
    ctx.stroke();
    ctx.restore();
  }
  // ─── Phase 39: connection quality dot top-right under the kill feed.
  // Green ≤ 80ms, yellow ≤ 200ms, red beyond. WS not OPEN → grey ring.
  // Smoothed RTT used so the colour doesn't strobe on noisy links.
  const wsOpen = _mpState.ws && _mpState.ws.readyState === 1;
  const rtt = Math.round(_mpState.rttSmoothed || 0);
  let dotColor = '#888';
  if (wsOpen) {
    dotColor = rtt <= MP_PING_GREEN ? '#3aa54a'
             : rtt <= MP_PING_YELLOW ? '#d4a020'
             : '#c44';
  }
  ctx.save();
  ctx.fillStyle = dotColor;
  ctx.beginPath(); ctx.arc(W() - 18, 22, 5, 0, Math.PI * 2); ctx.fill();
  if (wsOpen && rtt > 0) {
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${rtt}ms`, W() - 28, 26);
  }
  ctx.restore();
  // ─── Phase 39: optional debug overlay (toggle with F3) — Minecraft/Krunker
  // convention. Shows ping, server tick, snapshot rate, peers, buffer depth
  // for the first remote. Useful when triaging "is it my net or the server".
  if (typeof game !== 'undefined' && game._mpDebug) {
    const sList = _mpState.snapshotsRecvTimes;
    const snapHz = sList.length >= 2
      ? (1000 * (sList.length - 1) / Math.max(1, sList[sList.length - 1] - sList[0])).toFixed(1)
      : '–';
    const firstRemote = [..._mpState.remotePlayers.entries()].find(([id]) => id !== _mpState.myId);
    const bufLen = firstRemote ? (firstRemote[1].buffer ? firstRemote[1].buffer.length : 0) : 0;
    const lcRate = _mpState.totalHitsAsShooter > 0
      ? `${Math.round(100 * _mpState.lcHitsAsShooter / _mpState.totalHitsAsShooter)}%`
      : '–';
    const lines = [
      `MP DEBUG  (F3 to hide)`,
      `ping       ${rtt}ms  (raw ${Math.round(_mpState.rttMs || 0)}ms)`,
      `tick       ${_mpState.serverTick}`,
      `snap rate  ${snapHz} Hz`,
      `peers      ${_mpState.remotePlayers.size}`,
      `pendIn     ${_mpState.pendingInputs.length}`,
      `buf[0]     ${bufLen} samples`,
      `lag-comp   ${_mpState.lcHitsAsShooter}/${_mpState.totalHitsAsShooter}  (${lcRate})`,
      `room       ${_mpState.roomName}`,
    ];
    ctx.save();
    ctx.fillStyle = 'rgba(20, 20, 20, 0.78)';
    ctx.fillRect(W() - 222, 38, 204, lines.length * 14 + 12);
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    let dy = 52;
    for (const ln of lines) { ctx.fillText(ln, W() - 214, dy); dy += 14; }
    ctx.restore();
  }
  ctx.restore();
  ctx.textAlign = 'left';
}

// Fire is now server-side. _mpBroadcastFire is a no-op kept as a shim
// so existing index.html call sites don't need to be deleted.
function _mpBroadcastFire(/* payload */) { /* no-op — server handles firing */ }

// Respawn handler — when server says we respawned, the snapshot will
// flip alive=true. Local recap UI is driven by server's 'kill' event +
// snapshot's alive flag.
function _mpRespawnLocalPlayer() {
  if (typeof player === 'undefined') return;
  // The server already reset our state. Reflect that locally.
  player.alive = _mpState.serverSelfAlive;
  player.hp = _mpState.serverSelfHp;
  player.x = _mpState.serverSelfX;
  player.y = _mpState.serverSelfY;
  player.ammo = player.maxAmmo;
  player.reserve = Math.max(player.reserve || 0, 120);
  player.reloading = false;
  if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
    game._teamWipe.blue.wipedSince = null;
    game._teamWipe.blue.respawnAt = null;
  }
  if (typeof dismissDeathRecap === 'function') dismissDeathRecap();
}

// ─── Emotes + pings ─────────────────────────────────────────────────
function _mpTriggerEmote() {
  const now = Date.now();
  if (now - _mpLastEmoteAt < 1000) return;
  _mpLastEmoteAt = now;
  const idx = _mpMyEmoteIdx;
  _mpMyEmoteIdx = (_mpMyEmoteIdx + 1) % MP_EMOTES.length;
  if (typeof player !== 'undefined') {
    player._emote = { char: MP_EMOTES[idx], until: Date.now() + 3000 };
  }
  if (_mpState.enabled) _mpSendRaw({ type: 'emote', idx });
  if (typeof playSfx === 'function') playSfx('reload', { vol: 0.25, freq: 1100 });
}
function _mpTriggerPing(wx, wy) {
  const now = Date.now();
  if (now - _mpLastPingAt < 1500) return;
  _mpLastPingAt = now;
  _mpPings.push({
    x: wx, y: wy,
    peerId: _mpState.myId || 'local',
    life: 240, maxLife: 240,
  });
  if (_mpState.enabled) _mpSendRaw({ type: 'ping', x: Math.round(wx), y: Math.round(wy) });
  if (typeof playSfx === 'function') playSfx('countdown', { vol: 0.35, freq: 880 });
  if (typeof showSwapToast === 'function') showSwapToast('▶ PING');
}
function _mpTickPings() {
  for (let i = _mpPings.length - 1; i >= 0; i--) {
    _mpPings[i].life--;
    if (_mpPings[i].life <= 0) _mpPings.splice(i, 1);
  }
}
function _mpRenderPings() {
  if (typeof ctx === 'undefined') return;
  for (const p of _mpPings) {
    const t = p.life / p.maxLife;
    const expand = (1 - t) * 50;
    ctx.save();
    ctx.globalAlpha = 0.85 * t;
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, 14 + expand, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5 * t;
    ctx.beginPath(); ctx.arc(p.x, p.y, 6 + expand * 0.4, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = t;
    ctx.fillStyle = COLORS.red;
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}
function _mpRenderEmotes() {
  if (typeof ctx === 'undefined') return;
  const drawBubble = (x, y, char) => {
    ctx.save();
    ctx.font = 'bold 16px sans-serif';
    const w = Math.max(40, ctx.measureText(char).width + 20);
    const bx = x - w / 2, by = y - 64;
    ctx.fillStyle = COLORS.cream;
    ctx.fillRect(bx, by, w, 26);
    ctx.beginPath();
    ctx.moveTo(x - 6, by + 26); ctx.lineTo(x + 6, by + 26); ctx.lineTo(x, by + 34);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = COLORS.black; ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, w, 26);
    ctx.fillStyle = COLORS.black;
    ctx.textAlign = 'center';
    ctx.fillText(char, x, by + 19);
    ctx.restore();
  };
  if (typeof player !== 'undefined' && player.alive && player._emote && Date.now() < player._emote.until) {
    drawBubble(player.x, player.y, player._emote.char);
  }
  for (const [id, rp] of _mpState.remotePlayers) {
    if (id === _mpState.myId) continue;
    if (rp.emote && Date.now() < rp.emote.until) {
      drawBubble(rp.x, rp.y, rp.emote.char);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => { _mpConnect().catch(e => console.error('[mp] connect threw:', e)); }, 1000);
});
window.addEventListener('pagehide', () => {
  if (_mpState.ws) {
    try { _mpState.ws.close(1000, 'pagehide'); } catch {}
  }
  if (_mpState.reconnectTimer) clearTimeout(_mpState.reconnectTimer);
});
