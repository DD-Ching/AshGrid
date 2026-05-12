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

function _mpIsActive() { return !!_mpState.enabled; }
function _mpPeerCount() { return _mpState.enabled ? (_mpState.remotePlayers.size + 1) : 0; }

async function _mpConnect() {
  if (_mpState.enabled) return;
  // Activation gate. ?mp=1 in URL is the opt-in. Single-player path is
  // 100% untouched when the flag is absent.
  const params = new URLSearchParams(location.search);
  if (params.get('mp') !== '1') return;
  const roomName = params.get('room') || MP_DEFAULT_ROOM;
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
}

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
        // Broadcast death so remote peers pop the kill feed + bump the
        // shooter's score. Trystero does NOT echo a sender's own message
        // back to them, so we ALSO update the local scoreboard / feed
        // ourselves — otherwise the victim's view would never see their
        // own death recorded.
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
        // Mirror the death-recap path for ad-revive flow.
        if (typeof player._killer === 'undefined') player._killer = null;
        player._killer = { callsign: (_mpState.remotePlayers.get(b.shooterId)?.name) || 'ENEMY' };
        player._killerWeapon = b.weapon;
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
  // Pick a spawn anchor. Prefer game._nnSpawnBlue (set per match in
  // startNNSkirmish); fall back to arena centre.
  const sp = (typeof game !== 'undefined') && game._nnSpawnBlue;
  if (sp) { player.x = sp.x; player.y = sp.y; }
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

// Boot once the page is ready. Defer 1 sec so the rest of the engine
// has time to set up (player, getOperatorName, etc.) before we wire MP
// in. Single-player matches that never see ?mp=1 are unaffected.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => { _mpConnect().catch(e => console.error('[mp] connect threw:', e)); }, 1000);
});
