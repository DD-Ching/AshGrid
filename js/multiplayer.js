// ============ MULTIPLAYER (PartyKit / Cloudflare Workers + DO) ============
// Phase 33 — pivot from Trystero P2P to a relay server on Cloudflare
// Workers + Durable Objects (via PartyKit). The Trystero v0.24 firebase
// strategy refused to complete its SDP exchange step (3 peers announced
// to /__trystero__/<room> but ZERO per-peer inboxes ever populated),
// and downgrading to v0.21.4 didn't help either. After 5 phases of
// firefighting NAT / TURN / version regressions we decided P2P was the
// wrong tool for an .io-style realtime PvP: wings.io itself uses an
// authoritative server, not P2P. So do agar / slither / krunker.
//
// Architecture now:
//   - One Durable Object per room (PartyKit handles the mapping).
//   - Each browser opens a WebSocket to wss://<host>/parties/main/<room>.
//   - PartyKit assigns a stable connection.id which we use as the peer's
//     selfId — replaces Trystero's selfId.
//   - The server (server/party/server.js) is a broadcast relay: every
//     message a client sends gets fanned out to the other connections
//     in the same room, tagged with the sender's id.
//   - Same message shape as before (pos / fire / kill / emote / ping)
//     so the rendering side and the local game logic don't change.
//   - No NAT traversal, no TURN, no STUN, no Trystero quirks.
//     Either you can open a WebSocket or you can't — and you can.
//
// Activation: append ?mp=1 to the URL. Optional ?room=foo to coordinate
// with friends. Without ?mp=1 the file does nothing (single-player mode
// keeps working identically).
//
// Cost: Cloudflare Workers Free = 100k req/day + 13ms CPU per req.
// Durable Objects Free = 1M req/mo + 400k GB-s. For an .io hobby game
// that handles dozens of concurrent rooms this is effectively infinite.
//
// Classic-script. Declares globally:
//   _mpState · _mpConnect() · _mpSendInput() · _mpTickRemote()
//   _mpTickRemoteBullets() · _mpTickPings() · _mpRenderRemote()
//   _mpRenderRemoteBullets() · _mpRenderHUD() · _mpRenderEmotes()
//   _mpRenderPings() · _mpIsActive() · _mpPeerCount()
//   _mpBroadcastFire() · _mpTriggerEmote() · _mpTriggerPing()
//   _mpRespawnLocalPlayer()
//   MP_EMOTES
//
// External deps (resolved at call-time):
//   player · COLORS · ctx · drawHumanoid · getOperatorName · _lbBumpDeath
//   showSwapToast · NN_ARENA · game

// Resolution order for the PartyKit host:
//   1. ?ws=<host> URL param (test against a different deploy)
//   2. window.MP_PARTYKIT_HOST (paste into console for quick swaps)
//   3. localhost auto-detect for `npx partykit dev` workflow
//   4. PRODUCTION_HOST constant — edit this AFTER your first deploy.
//
// First-time setup: see server/README.md. The TL;DR is:
//   cd server && npm install
//   npx partykit login          # one-time, opens a browser
//   npx partykit deploy         # prints the URL — paste into below
const PRODUCTION_HOST = 'ashgrid-mp.dd-ching.partykit.dev';   // TODO: replace after deploy
const MP_SEND_HZ = 20;
const MP_LERP_K  = 0.25;

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
  roomName:       null,
  ws:             null,
  myId:           null,
  remotePlayers:  new Map(),     // peerId → { x, y, targetX, targetY, angle, name, emote? }
  lastSendAt:     0,
  reconnectTimer: null,
  reconnectDelay: 1000,
  loadError:      null,
  // Surface-area shim: index.html reads `_mpState.room.getPeers()` to
  // count connected peers. With Trystero gone, expose a tiny adapter
  // that returns the same shape ({peerId: connection}).
  get room() {
    return {
      getPeers: () => {
        const out = {};
        for (const id of _mpState.remotePlayers.keys()) out[id] = true;
        return out;
      },
    };
  },
};
// Remote bullets fired by other peers. Each entry is a bullet the
// *other* side sees flying; the local player is the only entity it
// can damage. Same shape as before so the rendering + collision
// code didn't have to change.
const _mpRemoteBullets = [];
// Kill feed + peer scoreboard.
const _mpScoreboard = new Map();
const _mpKillFeed = [];
// Emotes + pings.
const MP_EMOTES = ['GG', 'LOL', 'GO!', '!', '?'];
let _mpMyEmoteIdx = 0;
let _mpLastEmoteAt = 0;
let _mpLastPingAt = 0;
const _mpPings = [];

function _mpIsActive() { return !!_mpState.enabled; }
function _mpPeerCount() { return _mpState.enabled ? (_mpState.remotePlayers.size + 1) : 0; }

async function _mpConnect() {
  if (_mpState.enabled) return;
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
    _mpState.loadError = String(e);
    console.error('[mp] WebSocket constructor threw:', e);
    if (typeof showSwapToast === 'function') {
      showSwapToast('多人連線失敗 · ' + String(e).slice(0, 40));
    }
    return;
  }
  _mpState.ws = ws;
  ws.addEventListener('open', () => {
    console.log('[mp] WebSocket open');
    _mpState.reconnectDelay = 1000;  // reset backoff
    if (typeof showSwapToast === 'function') {
      showSwapToast('▶ 多人連線 · room: ' + _mpState.roomName);
    }
  });
  ws.addEventListener('message', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (!data || typeof data !== 'object') return;
    _mpHandleMessage(data);
  });
  ws.addEventListener('error', (e) => {
    console.error('[mp] WebSocket error:', e);
  });
  ws.addEventListener('close', (e) => {
    console.warn('[mp] WebSocket closed · code:', e.code, '· reason:', e.reason);
    _mpState.enabled = false;
    _mpState.ws = null;
    _mpState.remotePlayers.clear();
    // Reconnect with exponential backoff (cap 30s) so a server-side
    // restart or transient network blip doesn't kill the session.
    const delay = Math.min(30000, _mpState.reconnectDelay);
    _mpState.reconnectDelay = Math.min(30000, _mpState.reconnectDelay * 1.5);
    _mpState.reconnectTimer = setTimeout(() => _mpOpen(url), delay);
  });
}

function _mpHandleMessage(data) {
  switch (data.type) {
    case 'welcome': {
      _mpState.myId = data.id;
      _mpState.enabled = true;
      console.log('[mp] welcomed as', _mpState.myId, '· existing peers:', data.peers || []);
      // Start presence so the first heartbeat fires.
      _mpSendInputForce();
      break;
    }
    case 'join': {
      console.log('[mp] peer joined:', data.id);
      if (typeof showSwapToast === 'function') {
        showSwapToast('▸ 玩家加入 ' + String(data.id).slice(0, 6));
      }
      break;
    }
    case 'leave': {
      console.log('[mp] peer left:', data.id);
      _mpState.remotePlayers.delete(data.id);
      _mpScoreboard.delete(data.id);
      break;
    }
    case 'pos': {
      const peerId = data.from;
      if (!peerId) return;
      let rp = _mpState.remotePlayers.get(peerId);
      if (!rp) {
        rp = {
          x: data.x, y: data.y,
          targetX: data.x, targetY: data.y,
          angle: data.angle || 0,
          name: data.name || ('U' + peerId.slice(0, 4)),
        };
        _mpState.remotePlayers.set(peerId, rp);
        console.log('[mp/data] first pos from peer', peerId.slice(0, 6),
          '@', Math.round(data.x), Math.round(data.y), '· name:', rp.name);
      }
      rp.targetX = data.x;
      rp.targetY = data.y;
      rp.angle = data.angle || 0;
      if (data.name) rp.name = String(data.name).slice(0, 12);
      break;
    }
    case 'fire': {
      const peerId = data.from;
      const pellets = Math.max(1, Math.min(12, data.pellets || 1));
      const spreadMul = data.spreadMul || 1;
      const spread = data.spread || 0;
      const speed = data.speed || 14;
      const life = data.life || 60;
      for (let i = 0; i < pellets; i++) {
        const a = data.angle + (Math.random() - 0.5) * spread * spreadMul;
        _mpRemoteBullets.push({
          x: data.x + Math.cos(a) * 18,
          y: data.y + Math.sin(a) * 18,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life, damage: data.damage || 25,
          shooterId: peerId,
          weapon: data.weapon || 'RIFLE',
          isRocket: !!data.isRocket,
          blastR: data.blastR, blastDmg: data.blastDmg,
        });
      }
      break;
    }
    case 'kill': {
      // `data.from` = the victim; `data.shooterId` = who killed them.
      if (!data.shooterId) return;
      _mpScoreboard.set(data.shooterId, (_mpScoreboard.get(data.shooterId) || 0) + 1);
      const shooterName = (_mpState.remotePlayers.get(data.shooterId)?.name)
        || (data.shooterId === _mpState.myId
              ? (typeof getOperatorName === 'function' ? getOperatorName() : 'YOU')
              : String(data.shooterId).slice(0, 6));
      const victimName = (_mpState.remotePlayers.get(data.from)?.name) || String(data.from).slice(0, 6);
      _mpKillFeed.push({ killer: shooterName, victim: victimName, weapon: data.weapon || 'RIFLE', at: Date.now() });
      if (_mpKillFeed.length > 6) _mpKillFeed.splice(0, _mpKillFeed.length - 6);
      break;
    }
    case 'emote': {
      const peerId = data.from;
      const rp = _mpState.remotePlayers.get(peerId);
      if (!rp) return;
      const idx = (typeof data.idx === 'number') ? data.idx : 0;
      rp.emote = {
        char: MP_EMOTES[((idx % MP_EMOTES.length) + MP_EMOTES.length) % MP_EMOTES.length] || '?',
        until: Date.now() + 3000,
      };
      break;
    }
    case 'ping': {
      const peerId = data.from;
      if (typeof data.x !== 'number' || typeof data.y !== 'number') return;
      _mpPings.push({ x: data.x, y: data.y, peerId, life: 240, maxLife: 240 });
      break;
    }
  }
}

function _mpSendRaw(payload) {
  const ws = _mpState.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (e) {
    // socket closed mid-flight — onclose will fire and reconnect
  }
}

// Per-frame throttled position send.
function _mpSendInput() {
  if (!_mpState.enabled) return;
  if (typeof player === 'undefined' || !player.alive) return;
  const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  if (now - _mpState.lastSendAt < (1000 / MP_SEND_HZ)) return;
  _mpState.lastSendAt = now;
  _mpSendInputForce();
}
function _mpSendInputForce() {
  if (typeof player === 'undefined' || !player.alive) return;
  _mpSendRaw({
    type: 'pos',
    x: Math.round(player.x),
    y: Math.round(player.y),
    angle: Number((player.angle || 0).toFixed(3)),
    name: (typeof getOperatorName === 'function') ? getOperatorName() : 'PLAYER',
  });
}

// Interpolate remote positions toward their latest snapshot so they
// glide between updates instead of teleporting every 50ms.
function _mpTickRemote() {
  if (!_mpState.enabled) return;
  for (const rp of _mpState.remotePlayers.values()) {
    if (rp.targetX != null) rp.x += (rp.targetX - rp.x) * MP_LERP_K;
    if (rp.targetY != null) rp.y += (rp.targetY - rp.y) * MP_LERP_K;
  }
}

// Render remote players. Uses drawHumanoid with COLORS.red so remotes
// read as "another player".
function _mpRenderRemote() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined' || typeof drawHumanoid !== 'function') return;
  for (const rp of _mpState.remotePlayers.values()) {
    ctx.save();
    drawHumanoid(rp.x, rp.y, rp.angle || 0, 0, COLORS.red, true, { _chassis: 'humanoid' });
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(rp.name || '?', rp.x, rp.y - 22);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

// Broadcast fire — called from index.html fire() after the local shot
// is queued. One packet per shot (not per pellet).
function _mpBroadcastFire(payload) {
  if (!_mpState.enabled) return;
  _mpSendRaw({
    type: 'fire',
    x: Math.round(payload.x),
    y: Math.round(payload.y),
    angle: Number((payload.angle || 0).toFixed(3)),
    speed: payload.speed,
    damage: payload.damage,
    life: payload.life,
    spread: payload.spread,
    pellets: payload.pellets,
    spreadMul: payload.spreadMul,
    weapon: payload.weapon,
    isRocket: payload.isRocket,
    blastR: payload.blastR,
    blastDmg: payload.blastDmg,
  });
}

// Tick remote bullets and resolve hits on the local player.
function _mpTickRemoteBullets() {
  if (!_mpState.enabled) return;
  if (typeof player === 'undefined') return;
  for (let i = _mpRemoteBullets.length - 1; i >= 0; i--) {
    const b = _mpRemoteBullets[i];
    b.x += b.vx; b.y += b.vy; b.life--;
    if (b.life <= 0) { _mpRemoteBullets.splice(i, 1); continue; }
    if (!player.alive) continue;
    const pInvuln = player._invulnUntil != null && (typeof game !== 'undefined') && game.time < player._invulnUntil;
    if (pInvuln) continue;
    const d = Math.hypot(b.x - player.x, b.y - player.y);
    if (d < (player.radius || 14)) {
      if (typeof _applyDamageToUnit === 'function') {
        _applyDamageToUnit(player, b.damage);
      } else {
        player.hp -= b.damage;
      }
      if (typeof game !== 'undefined') game.hitFlash = Math.max(game.hitFlash || 0, 6);
      if (player.hp <= 0 && player.alive) {
        player.alive = false;
        if (typeof _lbBumpDeath === 'function') _lbBumpDeath();
        // Broadcast death so peers update kill feed + score. The server
        // tags this with our id (from), so receivers know who died.
        _mpSendRaw({ type: 'kill', shooterId: b.shooterId, weapon: b.weapon });
        // Also bump locally (server doesn't echo our own message back).
        _mpScoreboard.set(b.shooterId, (_mpScoreboard.get(b.shooterId) || 0) + 1);
        _mpKillFeed.push({
          killer: _mpState.remotePlayers.get(b.shooterId)?.name || 'PEER',
          victim: (typeof getOperatorName === 'function') ? getOperatorName() : 'YOU',
          weapon: b.weapon || 'RIFLE',
          at: Date.now(),
        });
        if (_mpKillFeed.length > 6) _mpKillFeed.splice(0, _mpKillFeed.length - 6);
        if (typeof player._killer === 'undefined') player._killer = null;
        player._killer = { callsign: (_mpState.remotePlayers.get(b.shooterId)?.name) || 'ENEMY' };
        player._killerWeapon = b.weapon;
        // Sync death-recap countdown so the visible timer ticks.
        if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
          game._teamWipe.blue.wipedSince = game.time;
          game._teamWipe.blue.respawnAt = game.time + 180;
        }
        setTimeout(_mpRespawnLocalPlayer, 3000);
        if (typeof triggerDeathRecap === 'function') triggerDeathRecap();
      }
      _mpRemoteBullets.splice(i, 1);
    }
  }
}

function _mpRespawnLocalPlayer() {
  if (typeof player === 'undefined') return;
  player.alive = true;
  player.hp = player.maxHp;
  player.ammo = player.maxAmmo;
  player.reserve = Math.max(player.reserve || 0, 120);
  player.reloading = false;
  if (typeof game !== 'undefined') player._invulnUntil = game.time + 180;
  if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
    game._teamWipe.blue.wipedSince = null;
    game._teamWipe.blue.respawnAt = null;
  }
  // Pick a respawn anchor far from any remote player to dodge spawn-camp.
  let anchors = (typeof game !== 'undefined') ? (game._nnSpawnBlueList || []) : [];
  if (!Array.isArray(anchors) || anchors.length === 0) {
    if (typeof game !== 'undefined' && game._nnSpawnBlue) anchors = [game._nnSpawnBlue];
  }
  if (anchors.length === 0) {
    if (typeof game !== 'undefined' && typeof NN_ARENA !== 'undefined') {
      anchors = [{ x: NN_ARENA.x0 + NN_ARENA.w / 2, y: NN_ARENA.y0 + NN_ARENA.h / 2 }];
    }
  }
  let best = anchors[0], bestScore = -Infinity;
  for (const a of anchors) {
    let minD = Infinity;
    for (const rp of _mpState.remotePlayers.values()) {
      const d = Math.hypot(rp.x - a.x, rp.y - a.y);
      if (d < minD) minD = d;
    }
    if (minD === Infinity) minD = 9999;
    if (minD > bestScore) { bestScore = minD; best = a; }
  }
  if (best) { player.x = best.x; player.y = best.y; }
  if (typeof dismissDeathRecap === 'function') dismissDeathRecap();
}

function _mpRenderRemoteBullets() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined') return;
  for (const b of _mpRemoteBullets) {
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
    ctx.beginPath();
    ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Kill feed + scoreboard HUD.
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
        : (_mpState.remotePlayers.get(pid)?.name || pid.slice(0, 6));
      ctx.fillText(`${name.padEnd(12, ' ').slice(0, 12)} ${kills}`, 24, sy + 12);
      sy += 14;
    }
  }
  ctx.restore();
  ctx.textAlign = 'left';
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
  for (const rp of _mpState.remotePlayers.values()) {
    if (rp.emote && Date.now() < rp.emote.until) {
      drawBubble(rp.x, rp.y, rp.emote.char);
    }
  }
}

// Boot once the page is ready.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => { _mpConnect().catch(e => console.error('[mp] connect threw:', e)); }, 1000);
});

// Clean up on tab close so the server's onClose fires immediately.
window.addEventListener('pagehide', () => {
  if (_mpState.ws) {
    try { _mpState.ws.close(1000, 'pagehide'); } catch {}
  }
  if (_mpState.reconnectTimer) clearTimeout(_mpState.reconnectTimer);
});
