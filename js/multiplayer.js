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
const MP_REMOTE_LERP    = 0.35;      // remote player smoothing rate
const MP_BULLET_LERP    = 0.5;       // remote bullet smoothing rate (faster — bullets move fast)

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
  // ─ players ─
  const seenIds = new Set();
  for (const sp of snap.players) {
    seenIds.add(sp.id);
    if (sp.id === _mpState.myId) {
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
      // Remote player — store target for interpolation
      let rp = _mpState.remotePlayers.get(sp.id);
      if (!rp) {
        rp = {
          x: sp.x, y: sp.y,
          targetX: sp.x, targetY: sp.y,
          angle: sp.angle,
          hp: sp.hp, alive: sp.alive,
          name: sp.name, invuln: !!sp.invuln,
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

function _mpHandleHit(data) {
  // Only act if we're the victim (server already updated authoritative HP via snapshot)
  if (data.victim !== _mpState.myId) return;
  if (typeof game !== 'undefined') game.hitFlash = Math.max(game.hitFlash || 0, 6);
  if (typeof playSfx === 'function') playSfx('hit', { vol: 0.4 });
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

  // Local player got killed?
  if (data.victim === _mpState.myId && typeof player !== 'undefined') {
    if (typeof _lbBumpDeath === 'function') _lbBumpDeath();
    player.alive = false;
    player._killer = { callsign: shooterName };
    player._killerWeapon = data.weapon;
    if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
      game._teamWipe.blue.wipedSince = game.time;
      game._teamWipe.blue.respawnAt  = game.time + 180; // matches server RESPAWN_TICKS
    }
    if (typeof triggerDeathRecap === 'function') triggerDeathRecap();
  }
  // Local player got the kill?
  if (data.shooter === _mpState.myId) {
    if (typeof _lbBumpKill === 'function') _lbBumpKill();
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
  let dx = 0, dy = 0;
  if (typeof keys !== 'undefined') {
    if (keys['d'] || keys['arrowright']) dx += 1;
    if (keys['a'] || keys['arrowleft'])  dx -= 1;
    if (keys['s'] || keys['arrowdown'])  dy += 1;
    if (keys['w'] || keys['arrowup'])    dy -= 1;
  }
  const angle = player.angle || 0;
  // Fire if mouse held and player alive (server will gate on cooldown).
  const fire = !!(typeof mouse !== 'undefined' && mouse.down && player.alive);

  const seq = ++_mpState.localInputSeq;
  const input = {
    type: 'input',
    seq, dx, dy, angle, fire,
    name: (typeof getOperatorName === 'function') ? getOperatorName() : 'PLAYER',
  };
  _mpSendRaw(input);

  // Phase 38 prediction — index.html's per-frame WASD code IS our
  // prediction. We just record the input here so reconciliation can
  // replay any unacked inputs from the server's confirmed position.
  _mpState.pendingInputs.push({ seq, dx, dy, angle, fire });

  // Cap the pendingInputs queue so it doesn't grow forever during net loss
  if (_mpState.pendingInputs.length > 120) {
    _mpState.pendingInputs.splice(0, _mpState.pendingInputs.length - 120);
  }
}

// Smooth remote players toward their last snapshot target.
function _mpTickRemote() {
  if (!_mpState.enabled) return;
  for (const [id, rp] of _mpState.remotePlayers) {
    if (id === _mpState.myId) continue;
    if (rp.targetX != null) rp.x += (rp.targetX - rp.x) * MP_REMOTE_LERP;
    if (rp.targetY != null) rp.y += (rp.targetY - rp.y) * MP_REMOTE_LERP;
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

// Render remote players (server-known, smoothed)
function _mpRenderRemote() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined' || typeof drawHumanoid !== 'function') return;
  for (const [id, rp] of _mpState.remotePlayers) {
    if (id === _mpState.myId) continue;
    if (!rp.alive) continue;
    ctx.save();
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

// Render server-owned bullets
function _mpRenderRemoteBullets() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined') return;
  for (const b of _mpState.remoteBullets.values()) {
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

// HUD: kill feed + scoreboard (unchanged from Phase 33).
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
