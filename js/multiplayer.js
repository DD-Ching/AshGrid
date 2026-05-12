// ============ MULTIPLAYER (Trystero / WebRTC P2P) ============
// Phase 20a — minimum viable PvP. Lazy-loads Trystero from esm.sh, joins a
// room over Firebase RTDB signalling, then peer-to-peer broadcasts the
// player's position / angle / name 20 times per second. Remote players are
// rendered with interpolation. No combat yet (Phase 20b will add bullets +
// HP + death). User: '我是想要像 Wings.io 一樣 · 大家可以互相打 · 這是我想要
// 的這個遊戲的核心'.
//
// Activation: append ?mp=1 to the URL. Optional ?room=foo to coordinate
// with friends. Without ?mp=1 the file does nothing (single-player mode
// keeps working identically).
//
// Cost model: Firebase free tier handles the signalling exchange only —
// once two peers connect, all gameplay traffic flows P2P. So 8-player
// .io match = effectively zero infrastructure cost.
//
// Classic-script. Declares globally:
//   _mpState · _mpConnect() · _mpSendInput() · _mpTickRemote()
//   _mpRenderRemote() · _mpIsActive() · _mpPeerCount()
//
// External deps (resolved at call-time):
//   player · COLORS · ctx · drawHumanoid · getOperatorName · T ·
//   showSwapToast

const MP_FIREBASE_URL = 'https://ashgo-1bfec-default-rtdb.asia-southeast1.firebasedatabase.app';
const MP_DEFAULT_ROOM = 'ashgrid-main';
const MP_ROOM_CAP        = 20;        // Phase 27: rollover threshold per user
                                      // '20-30 才會開第二間 · 以下都希望
                                      // 他們能遇到 · 不要平行世界'
const MP_PRESENCE_TTL_MS = 30000;     // peers without a heartbeat in 30s
                                      // are treated as gone for matchmaking
const MP_HEARTBEAT_MS    = 10000;     // PUT /rooms/<room>/<peer> every 10s
// Trystero was renamed: trystero/firebase → @trystero-p2p/firebase. The old
// path throws 'Importing from "trystero/firebase" is deprecated' on the
// latest release. We also PIN the version (@0.24.0) because esm.sh's
// floating "latest" rewrites broke the nested /idb/ import chain in this
// project — surfacing as 'Failed to fetch dynamically imported module' or
// 'does not provide an export named u' bundling errors. The pinned URL
// resolves all nested imports cleanly and lets the browser cache the bundle.
const MP_TRYSTERO_CDN = 'https://esm.sh/@trystero-p2p/firebase@0.24.0';
const MP_SEND_HZ      = 20;          // position broadcasts per second per peer
const MP_LERP_K       = 0.25;        // remote interpolation rate

const _mpState = {
  enabled:        false,
  roomName:       null,
  room:           null,
  send:           null,
  sendFire:       null,
  sendKill:       null,
  myId:           null,
  remotePlayers:  new Map(),         // peerId → { x, y, targetX, targetY, angle, name }
  lastSendAt:     0,
  loadError:      null,
};
// Phase 20b — remote bullets fired by other peers. Each entry is a bullet
// the *other* side sees flying; the local player is the only entity it can
// damage (we don't propagate hits to NN bots — those run independently on
// each client). Tick + render alongside the normal bullets[] array.
const _mpRemoteBullets = [];
// Phase 20c — kill feed + peer scoreboard. Map: peerId → kill count.
const _mpScoreboard = new Map();
const _mpKillFeed = [];               // [{ killer, victim, weapon, at }, ...]
// Phase 24 — emotes + pings. Emotes are a chat-bubble char that floats
// over the sender for ~3 sec. Pings are world-coord markers that pulse
// for ~4 sec so squad mates can call out a position without typing.
// Both go P2P via Trystero so latency is human-fast.
const MP_EMOTES = ['GG', 'LOL', 'GO!', '!', '?'];
let _mpMyEmoteIdx = 0;
let _mpLastEmoteAt = 0;
let _mpLastPingAt = 0;
const _mpPings = [];                  // [{ x, y, peerId, life, maxLife }]

function _mpIsActive() { return !!_mpState.enabled; }
function _mpPeerCount() { return _mpState.enabled ? (_mpState.remotePlayers.size + 1) : 0; }

// Phase 27 — auto-matchmaking. Pick the smallest room number that's
// under MP_ROOM_CAP so everyone clusters in one room until traffic
// justifies a second. URL ?room= overrides this entirely (private games).
async function _mpPickRoom() {
  try {
    const r = await fetch(`${MP_FIREBASE_URL}/rooms.json`);
    if (!r.ok) return MP_DEFAULT_ROOM;
    const data = (await r.json()) || {};
    const now = Date.now();
    const counts = {};
    for (const [roomName, peers] of Object.entries(data)) {
      let alive = 0;
      for (const p of Object.values(peers || {})) {
        if (p && p.ts && (now - p.ts) < MP_PRESENCE_TTL_MS) alive++;
      }
      counts[roomName] = alive;
    }
    // Default room first — everyone funnels there until it hits MP_ROOM_CAP.
    if ((counts[MP_DEFAULT_ROOM] || 0) < MP_ROOM_CAP) return MP_DEFAULT_ROOM;
    // Roll over to ashgrid-2, ashgrid-3, ... — first non-full room wins.
    let n = 2;
    while ((counts[`ashgrid-${n}`] || 0) >= MP_ROOM_CAP) {
      n++;
      if (n > 50) break;        // sanity stop
    }
    return `ashgrid-${n}`;
  } catch (e) {
    return MP_DEFAULT_ROOM;
  }
}

async function _mpConnect() {
  if (_mpState.enabled) return;
  // Activation gate. ?mp=1 in URL is the opt-in. Single-player path is
  // 100% untouched when the flag is absent.
  const params = new URLSearchParams(location.search);
  if (params.get('mp') !== '1') return;
  // Phase 27: auto-pick room when URL doesn't specify one, so all
  // unrouted MP players land in the same room until it fills.
  const roomName = params.get('room') || await _mpPickRoom();
  _mpState.roomName = roomName;
  // Lazy ESM import — Trystero is ESM-only and brings firebase as a
  // dependency. esm.sh handles transitive deps so this single import
  // pulls everything in. Browser cache makes subsequent matches instant.
  let joinRoom, selfId;
  try {
    console.log('[mp] loading Trystero from CDN…');
    const trystero = await import(MP_TRYSTERO_CDN);
    joinRoom = trystero.joinRoom;
    selfId = trystero.selfId;       // module-level in @trystero-p2p (was room.selfId in old API)
  } catch (e) {
    _mpState.loadError = String(e);
    console.error('[mp] failed to load Trystero:', e);
    if (typeof showSwapToast === 'function') {
      showSwapToast('多人連線失敗 · MP load failed');
    }
    return;
  }
  console.log('[mp] joining room:', roomName, 'via', MP_FIREBASE_URL);
  try {
    _mpState.room = joinRoom({ appId: MP_FIREBASE_URL }, roomName);
  } catch (e) {
    _mpState.loadError = String(e);
    console.error('[mp] joinRoom failed:', e);
    return;
  }
  _mpState.myId = selfId;
  // ─── Action channels ──────────────────────────────────────────────
  // 'pos'   — broadcast player position (Phase 20a)
  // 'fire'  — broadcast a shot the moment it leaves the barrel (Phase 20b)
  // 'kill'  — broadcast death event so peers can update kill feed + score
  //           (Phase 20c). Each `makeAction` returns [send, receive].
  const [sendPos, getPos] = _mpState.room.makeAction('pos');
  _mpState.send = sendPos;
  getPos((data, peerId) => {
    if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return;
    let rp = _mpState.remotePlayers.get(peerId);
    if (!rp) {
      rp = {
        x: data.x, y: data.y,
        targetX: data.x, targetY: data.y,
        angle: data.angle || 0,
        name: data.name || ('U' + peerId.slice(0, 4)),
      };
      _mpState.remotePlayers.set(peerId, rp);
    }
    rp.targetX = data.x;
    rp.targetY = data.y;
    rp.angle = data.angle || 0;
    if (data.name) rp.name = String(data.name).slice(0, 12);
  });
  // Phase 20b — fire action. A peer broadcasts the shot once + each
  // receiver spawns the bullet locally with the same params. Only the
  // local player can be hit (in _mpTickRemoteBullets) so we don't get
  // double-counting if 3 peers all see the same bullet.
  const [sendFire, getFire] = _mpState.room.makeAction('fire');
  _mpState.sendFire = sendFire;
  getFire((data, peerId) => {
    if (!data || typeof data.x !== 'number' || typeof data.angle !== 'number') return;
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
  });
  // Phase 20c — kill action. Victim broadcasts on death so every peer
  // can pop the kill feed + bump the shooter's score.
  const [sendKill, getKill] = _mpState.room.makeAction('kill');
  _mpState.sendKill = sendKill;
  getKill((data, peerId) => {
    if (!data || !data.shooterId) return;
    _mpScoreboard.set(data.shooterId, (_mpScoreboard.get(data.shooterId) || 0) + 1);
    const shooterName = (_mpState.remotePlayers.get(data.shooterId)?.name)
                     || (data.shooterId === _mpState.myId ? (typeof getOperatorName === 'function' ? getOperatorName() : 'YOU') : data.shooterId.slice(0, 6));
    const victimName = (_mpState.remotePlayers.get(peerId)?.name) || peerId.slice(0, 6);
    _mpKillFeed.push({ killer: shooterName, victim: victimName, weapon: data.weapon || 'RIFLE', at: Date.now() });
    // Trim to last 6 lines
    if (_mpKillFeed.length > 6) _mpKillFeed.splice(0, _mpKillFeed.length - 6);
  });
  // Phase 24 — emote + ping channels. Emote sets a chat-bubble on the
  // remote player's state; ping pushes a marker to _mpPings. Both are
  // throttled on the SEND side (_mpTriggerEmote / _mpTriggerPing) so a
  // spam-click can't flood the room.
  const [sendEmote, getEmote] = _mpState.room.makeAction('emote');
  const [sendPing,  getPing]  = _mpState.room.makeAction('ping');
  _mpState.sendEmote = sendEmote;
  _mpState.sendPing  = sendPing;
  getEmote((data, peerId) => {
    if (!data) return;
    const rp = _mpState.remotePlayers.get(peerId);
    if (!rp) return;
    const idx = (typeof data.idx === 'number') ? data.idx : 0;
    rp.emote = {
      char: MP_EMOTES[((idx % MP_EMOTES.length) + MP_EMOTES.length) % MP_EMOTES.length] || '?',
      until: Date.now() + 3000,
    };
  });
  getPing((data, peerId) => {
    if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return;
    _mpPings.push({ x: data.x, y: data.y, peerId, life: 240, maxLife: 240 });
  });
  _mpState.room.onPeerJoin((peerId) => {
    console.log('[mp] peer joined:', peerId);
    if (typeof showSwapToast === 'function') {
      showSwapToast('▸ 玩家加入 ' + peerId.slice(0, 6));
    }
  });
  _mpState.room.onPeerLeave((peerId) => {
    console.log('[mp] peer left:', peerId);
    _mpState.remotePlayers.delete(peerId);
    _mpScoreboard.delete(peerId);
  });
  _mpState.enabled = true;
  if (typeof showSwapToast === 'function') {
    showSwapToast('▶ 多人連線 · room: ' + roomName);
  }
  // Phase 27 — start presence heartbeat so other clients' room picker
  // sees us. First beat fires immediately so a player who joins right
  // after this one already counts us.
  _mpStartPresence();
}

// Presence heartbeat — write { name, ts } into /rooms/<room>/<peer>
// every MP_HEARTBEAT_MS. Stale entries (older than MP_PRESENCE_TTL_MS)
// are filtered out by _mpPickRoom so a crashed tab doesn't pin a slot.
let _mpPresenceTimer = null;
function _mpPresenceUrl() {
  if (!_mpState.myId || !_mpState.roomName) return null;
  return `${MP_FIREBASE_URL}/rooms/${encodeURIComponent(_mpState.roomName)}/${encodeURIComponent(_mpState.myId)}.json`;
}
async function _mpHeartbeat() {
  const url = _mpPresenceUrl();
  if (!url) return;
  try {
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: (typeof getOperatorName === 'function') ? getOperatorName().slice(0, 12) : 'PLAYER',
        ts: Date.now(),
      }),
    });
  } catch (e) {/* network blip — try again next interval */}
}
function _mpStartPresence() {
  if (_mpPresenceTimer) clearInterval(_mpPresenceTimer);
  _mpHeartbeat();
  _mpPresenceTimer = setInterval(_mpHeartbeat, MP_HEARTBEAT_MS);
}
// Cleanup on tab close. `keepalive: true` lets the request complete
// even after the page is unloading. We DELETE the presence entry so
// the next room picker doesn't count us as 'alive'.
window.addEventListener('pagehide', () => {
  if (_mpPresenceTimer) { clearInterval(_mpPresenceTimer); _mpPresenceTimer = null; }
  const url = _mpPresenceUrl();
  if (url) {
    try { fetch(url, { method: 'DELETE', keepalive: true }); } catch {}
  }
});

// Per-frame: throttled to MP_SEND_HZ so the room doesn't get spammed at
// 60 fps. Position is rounded to 1u + angle to 3 decimals so each message
// stays small (under 80 bytes) — Trystero will chunk if needed but small
// payloads keep mobile data usage tiny.
function _mpSendInput() {
  if (!_mpState.enabled || !_mpState.send) return;
  if (typeof player === 'undefined' || !player.alive) return;
  const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  if (now - _mpState.lastSendAt < (1000 / MP_SEND_HZ)) return;
  _mpState.lastSendAt = now;
  try {
    _mpState.send({
      x: Math.round(player.x),
      y: Math.round(player.y),
      angle: Number((player.angle || 0).toFixed(3)),
      name: (typeof getOperatorName === 'function') ? getOperatorName() : 'PLAYER',
    });
  } catch (e) {
    // Trystero throws if the peer connection drops mid-flight; quietly
    // swallow — next tick will retry, onPeerLeave drops the entry.
  }
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
// read as "another player" (vs cream-allied / red-enemy distinction).
// In Phase 20b we'll team-color them.
function _mpRenderRemote() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined' || typeof drawHumanoid !== 'function') return;
  for (const rp of _mpState.remotePlayers.values()) {
    ctx.save();
    drawHumanoid(rp.x, rp.y, rp.angle || 0, 0, COLORS.red, true, { _chassis: 'humanoid' });
    // Name + chevron
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(rp.name || '?', rp.x, rp.y - 22);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

// ─── Phase 20b: fire broadcast + remote bullet tick ──────────────
// Called from index.html fire() after the local shot is queued. We send
// one packet per shot (not per pellet) — receivers reconstruct pellets
// from the seed-rng (already deterministic enough for "looks the same").
function _mpBroadcastFire(payload) {
  if (!_mpState.enabled || !_mpState.sendFire) return;
  try {
    _mpState.sendFire({
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
  } catch (e) {/* peer drop mid-fire — quiet retry next tick */}
}
// Called once per game tick from updatePlayer (right after updateBullets
// so the local-bullet pass is done). Moves each remote bullet, checks if
// it hits the local player, and applies damage. The local player is
// authoritative for their own HP — we send a 'kill' broadcast when our
// HP drops to 0 so the shooter (and everyone else) sees the kill feed.
function _mpTickRemoteBullets() {
  if (!_mpState.enabled) return;
  if (typeof player === 'undefined') return;
  for (let i = _mpRemoteBullets.length - 1; i >= 0; i--) {
    const b = _mpRemoteBullets[i];
    b.x += b.vx; b.y += b.vy; b.life--;
    if (b.life <= 0) { _mpRemoteBullets.splice(i, 1); continue; }
    // Hit local player?
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
        // Broadcast death so peers update kill feed + score. Trystero does
        // NOT echo a sender's own message back, so ALSO bump locally —
        // otherwise the victim never sees their own death recorded.
        if (_mpState.sendKill) {
          try { _mpState.sendKill({ shooterId: b.shooterId, weapon: b.weapon }); } catch {}
        }
        _mpScoreboard.set(b.shooterId, (_mpScoreboard.get(b.shooterId) || 0) + 1);
        _mpKillFeed.push({
          killer: _mpState.remotePlayers.get(b.shooterId)?.name || 'PEER',
          victim: (typeof getOperatorName === 'function') ? getOperatorName() : 'YOU',
          weapon: b.weapon || 'RIFLE',
          at: Date.now(),
        });
        if (_mpKillFeed.length > 6) _mpKillFeed.splice(0, _mpKillFeed.length - 6);
        // Death-recap context.
        if (typeof player._killer === 'undefined') player._killer = null;
        player._killer = { callsign: (_mpState.remotePlayers.get(b.shooterId)?.name) || 'ENEMY' };
        player._killerWeapon = b.weapon;
        // Phase 26: sync game._teamWipe.blue so death-recap's countdown
        // ticks visibly ('沒有廣告的時候 那倒數計時應該也要繼續') instead
        // of being stuck on RESPAWN IN 0s. The 180-tick (3-sec) matches
        // the setTimeout below so they expire together.
        if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
          game._teamWipe.blue.wipedSince = game.time;
          game._teamWipe.blue.respawnAt = game.time + 180;
        }
        // Auto-respawn after 3 sec — drop at the blue spawn anchor with
        // a fresh 3-sec invuln (Phase 21 default).
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
  // Phase 26: clear the team-wipe flag we set on death so the death-recap
  // countdown dismisses cleanly + the next death starts a fresh timer.
  if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
    game._teamWipe.blue.wipedSince = null;
    game._teamWipe.blue.respawnAt = null;
  }
  // Phase 20e: pick a respawn anchor far from any remote player so the
  // shooter can't death-camp the spawn point. Prefer the anchor in
  // game._nnSpawnBlueList that's furthest from every alive remote;
  // fall back to game._nnSpawnBlue or arena centre.
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
    // 3-layer streak matching the local bullet aesthetic
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
// Phase 20c — render kill feed in the top-right and a small scoreboard
// in the top-left when MP is active. Both throttled so they don't fight
// existing HUD elements.
function _mpRenderHUD() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined') return;
  // Trim kill feed entries older than 5 sec
  const now = Date.now();
  for (let i = _mpKillFeed.length - 1; i >= 0; i--) {
    if (now - _mpKillFeed[i].at > 5000) _mpKillFeed.splice(i, 1);
  }
  // Kill feed (right-edge, under the MP indicator)
  ctx.save();
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'right';
  let y = 38;
  for (const k of _mpKillFeed) {
    const age = (now - k.at) / 5000;
    ctx.globalAlpha = Math.max(0.3, 1 - age);
    ctx.fillStyle = COLORS.black;
    const line = `${k.killer} » ${k.victim}`;
    ctx.fillText(line, W() - 18, y);
    y += 16;
  }
  ctx.globalAlpha = 1;
  // Scoreboard (top-left, below the existing status panel)
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

// ─── Phase 24: emotes + pings ─────────────────────────────────────
// Both work in single-player too (your own bubble renders locally for
// feedback) but only broadcast to peers when MP is active. 1-sec emote
// cooldown / 1.5-sec ping cooldown so a key-spam can't flood the room.
function _mpTriggerEmote() {
  const now = Date.now();
  if (now - _mpLastEmoteAt < 1000) return;
  _mpLastEmoteAt = now;
  const idx = _mpMyEmoteIdx;
  _mpMyEmoteIdx = (_mpMyEmoteIdx + 1) % MP_EMOTES.length;
  if (typeof player !== 'undefined') {
    player._emote = { char: MP_EMOTES[idx], until: Date.now() + 3000 };
  }
  if (_mpState.enabled && _mpState.sendEmote) {
    try { _mpState.sendEmote({ idx }); } catch (e) {}
  }
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
  if (_mpState.enabled && _mpState.sendPing) {
    try { _mpState.sendPing({ x: Math.round(wx), y: Math.round(wy) }); } catch (e) {}
  }
  if (typeof playSfx === 'function') playSfx('countdown', { vol: 0.35, freq: 880 });
  if (typeof showSwapToast === 'function') showSwapToast('▶ PING');
}
// Tick pings every frame from updatePlayer so their life counts down.
function _mpTickPings() {
  for (let i = _mpPings.length - 1; i >= 0; i--) {
    _mpPings[i].life--;
    if (_mpPings[i].life <= 0) _mpPings.splice(i, 1);
  }
}
// Render in world space (before HUD). Pings: expanding red ring + center
// dot. Local-player emote: bubble. Remote-player emotes: same bubble over
// each remote.
function _mpRenderPings() {
  if (typeof ctx === 'undefined') return;
  for (const p of _mpPings) {
    const t = p.life / p.maxLife;             // 1 → 0
    const expand = (1 - t) * 50;              // 0 → 50u outward
    ctx.save();
    ctx.globalAlpha = 0.85 * t;
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14 + expand, 0, Math.PI * 2);
    ctx.stroke();
    // Inner ring (pulses inversely so it reads as a 'bounce')
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.5 * t;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6 + expand * 0.4, 0, Math.PI * 2);
    ctx.stroke();
    // Center dot
    ctx.globalAlpha = t;
    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
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
    // Bubble background — cream, with a small tail pointing down
    ctx.fillStyle = COLORS.cream;
    ctx.fillRect(bx, by, w, 26);
    // Tail (triangle)
    ctx.beginPath();
    ctx.moveTo(x - 6, by + 26);
    ctx.lineTo(x + 6, by + 26);
    ctx.lineTo(x,     by + 34);
    ctx.closePath();
    ctx.fill();
    // Border
    ctx.strokeStyle = COLORS.black;
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, w, 26);
    // Char
    ctx.fillStyle = COLORS.black;
    ctx.textAlign = 'center';
    ctx.fillText(char, x, by + 19);
    ctx.restore();
  };
  // Local player emote
  if (typeof player !== 'undefined' && player.alive && player._emote && Date.now() < player._emote.until) {
    drawBubble(player.x, player.y, player._emote.char);
  }
  // Remote players
  for (const rp of _mpState.remotePlayers.values()) {
    if (rp.emote && Date.now() < rp.emote.until) {
      drawBubble(rp.x, rp.y, rp.emote.char);
    }
  }
}

// Boot once the page is ready. Defer 1 sec so the rest of the engine
// has time to set up (player, getOperatorName, etc.) before we wire MP
// in. Single-player matches that never see ?mp=1 are unaffected.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => { _mpConnect().catch(e => console.error('[mp] connect threw:', e)); }, 1000);
});
