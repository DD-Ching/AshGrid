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
const MP_TRYSTERO_CDN = 'https://esm.sh/trystero@0.21.5/firebase';
const MP_SEND_HZ      = 20;          // position broadcasts per second per peer
const MP_LERP_K       = 0.25;        // remote interpolation rate

const _mpState = {
  enabled:        false,
  roomName:       null,
  room:           null,
  send:           null,
  myId:           null,
  remotePlayers:  new Map(),         // peerId → { x, y, targetX, targetY, angle, name }
  lastSendAt:     0,
  loadError:      null,
};

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
  let joinRoom;
  try {
    console.log('[mp] loading Trystero from CDN…');
    const trystero = await import(MP_TRYSTERO_CDN);
    joinRoom = trystero.joinRoom;
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
  _mpState.myId = _mpState.room.selfId;
  // 'pos' action — position broadcast. Other actions ('fire', 'hit', 'kill')
  // arrive in Phase 20b. makeAction returns [send, receive].
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
  _mpState.room.onPeerJoin((peerId) => {
    console.log('[mp] peer joined:', peerId);
    if (typeof showSwapToast === 'function') {
      showSwapToast('▸ 玩家加入 ' + peerId.slice(0, 6));
    }
  });
  _mpState.room.onPeerLeave((peerId) => {
    console.log('[mp] peer left:', peerId);
    _mpState.remotePlayers.delete(peerId);
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

// Boot once the page is ready. Defer 1 sec so the rest of the engine
// has time to set up (player, getOperatorName, etc.) before we wire MP
// in. Single-player matches that never see ?mp=1 are unaffected.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => { _mpConnect().catch(e => console.error('[mp] connect threw:', e)); }, 1000);
});
