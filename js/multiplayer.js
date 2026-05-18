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
const MP_INTERP_DELAY   = 150;       // ms — render remotes this far in the past (Phase 59: was 100, bumped to absorb snapshot jitter that surfaced as 'stutter on W↔S toggle' — every extra 50ms gives the interpolator one more snapshot of cushion at 30Hz tick rate, still imperceptible)
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
  // Phase 5 (re-add) — server-side NN bots, mirrored from snap.bots. Same
  // delta-compression rules as players: first-seen entries carry full
  // state, subsequent only changed fields. Render path in index.html
  // draws each via drawHumanoid; without this Map, server bots fire
  // bullets but the shooter silhouette never appears — user '隱形單位
  // 在設獨特的子彈'.
  remoteBots:     new Map(),       // botId → {id, team, x, y, targetX, targetY, angle, hp, alive, _walkPhase, _visibleUntil}
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
  // Phase 1 (network audit) — bandwidth counters. Each entry is
  // { t: Date.now(), bytes: N }. Window-pruned at read time. Cheap; one
  // push per ws message. Used by _mpRenderNetDebug behind ?netdebug=1.
  bytesRxWindow:   [],
  bytesTxWindow:   [],
  // Last snapshot size + server-attached _dbg payload (server tick time
  // etc). Filled by _mpHandleMessage on every 'snapshot' frame.
  lastSnapBytes:   0,
  lastServerDbg:   null,
  // Frame-time samples. Filled by the per-frame raf-driven sampler that
  // _mpRenderNetDebug installs lazily on first use.
  frameTimeWindow: [],
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
// Phase 54 — push current room state to the CrazyGames Instant Multiplayer
// SDK. Fires on welcome, peer-join, and peer-leave so the portal's
// 'rejoin friend's room' link stays accurate. Safe no-op outside the
// CrazyGames iframe.
const _MP_ROOM_CAP = 20;
function _mpReportRoomToCrazy() {
  if (typeof crazyMp_updateRoom !== 'function') return;
  if (!_mpState.enabled || !_mpState.roomName) return;
  const filled = _mpState.remotePlayers.size;     // includes self
  const hasFreeSlot = filled < _MP_ROOM_CAP;
  crazyMp_updateRoom(_mpState.roomName, _MP_ROOM_CAP, hasFreeSlot);
}

async function _mpConnect() {
  if (_mpState.enabled || _mpState.ws) return;
  const params = new URLSearchParams(location.search);
  if (params.get('mp') !== '1') return;
  // Phase 54 — Instant Multiplayer: a friend's invite link gives the
  // CrazyGames SDK a roomName via getInviteParam. Honour it over the URL
  // ?room= param + over the auto-match default. The portal already
  // surfaced 'join your friend' when they shared the link; if we didn't
  // honour the param we'd dump them into a different room.
  const inviteRoom = (typeof crazyMp_getInviteRoom === 'function')
    ? crazyMp_getInviteRoom() : null;
  const roomName = inviteRoom || params.get('room') || 'ashgrid-main';
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
    // HitTel-1 — opt-in per-shot logging on the server. Enable via
    // ?hitdebug=1 in the URL. Server logs land in `partykit tail`.
    try {
      const params = new URLSearchParams(location.search);
      if (params.get('hitdebug') === '1') {
        _mpSendRaw({ type: 'hitdebug', on: true });
        console.log('[mp] hitdebug enabled — bullet outcomes logged on server');
      }
    } catch (e) {}
  });
  ws.addEventListener('message', (e) => {
    // Phase 1 net-audit — measure inbound bytes BEFORE parse so the count
    // reflects raw wire traffic. ev.data may be a string or ArrayBuffer;
    // length covers both safely. Sliding 2-second window so the overlay's
    // KB/s readout responds quickly without long-tail averaging.
    const _len = (typeof e.data === 'string') ? e.data.length : (e.data && e.data.byteLength) || 0;
    if (_len) _mpState.bytesRxWindow.push({ t: Date.now(), bytes: _len });
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data && typeof data === 'object') {
      // Track snapshot size + server-attached debug payload so the overlay
      // can render server-tick-time alongside client metrics.
      if (data.type === 'snapshot') {
        _mpState.lastSnapBytes = _len;
        if (data._dbg) _mpState.lastServerDbg = data._dbg;
      }
      _mpHandleMessage(data);
    }
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
      // Phase 43 — rehydrate built structures from server's authoritative
      // snapshot. Wipe local PLAYER-BUILT entries first (anything with a
      // sid — those mirror server state and will re-broadcast through
      // structureAdd) but PRESERVE NN-mode-only fixtures (factory,
      // spawn-relay) that the server doesn't track. Earlier we wiped the
      // whole array, which on MP welcome silently destroyed the factory
      // the user expected to see at arena centre. Bug: '工廠不見了'.
      if (Array.isArray(data.structures) && typeof game !== 'undefined') {
        const localOnly = (game._structures || []).filter(s =>
          s && (s._isFactory || s._isSpawnRelay)
        );
        game._structures = localOnly;
        for (const s of data.structures) _mpAdoptStructure(s);
      }
      // Phase 54 — tell CrazyGames Instant Multiplayer about our room so
      // the portal can surface 'join your friend' affordances + refresh
      // invite links. Cap at 20 (matches our Phase 27 auto-pick max).
      _mpReportRoomToCrazy();
      break;
    case 'join':
      console.log('[mp] peer joined:', data.id);
      if (typeof showSwapToast === 'function') {
        showSwapToast('▸ 玩家加入 ' + String(data.id).slice(0, 6));
      }
      _mpReportRoomToCrazy();
      break;
    case 'leave':
      _mpState.remotePlayers.delete(data.id);
      _mpScoreboard.delete(data.id);
      console.log('[mp] peer left:', data.id);
      _mpReportRoomToCrazy();
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
    case 'swap':
      // Phase 102 — server confirmed a pawn-swap. For the LOCAL player
      // (data.id === myId) this is just an ACK; our local _mpIgnoreReconcileUntil
      // can now end early since the server is in sync with the swap target.
      // For REMOTE peers, teleport their interpolated render position so
      // the swap looks instant on every screen (instead of a 0.5 s slide
      // while the snapshot buffer catches up).
      if (data.id === _mpState.myId) {
        if (typeof player !== 'undefined') {
          player._mpIgnoreReconcileUntil = 0;     // server now agrees with us
        }
      } else {
        const rp = _mpState.remotePlayers.get(data.id);
        if (rp) {
          rp.x = data.x; rp.y = data.y;
          rp.samples = [{ t: Date.now(), x: data.x, y: data.y, angle: rp.angle, alive: rp.alive }];
        }
      }
      // If a server bot was consumed by this swap, mirror server-side
      // death locally so we stop rendering it. Server's next snapshot
      // would do this anyway but acting on the broadcast feels instant.
      if (data.botId && _mpState.remoteBots && _mpState.remoteBots.has(data.botId)) {
        const rb = _mpState.remoteBots.get(data.botId);
        rb.alive = false;
        rb.hp = 0;
      }
      break;
    case 'wallHit':
      // Phase 44: NO explosion. Single-player regular bullets just vanish
      // when they hit a wall (only rockets detonate on impact, see
      // detonateRocket). The Phase 41 createExplosion('small') here was
      // wrong — user reported bullets-hit-wall feels like every shot is a
      // grenade. Drop the spark; the bullet's absence in the next snapshot
      // is the only feedback needed (it just disappears).
      break;
    case 'structureAdd':
      // Phase 43: server broadcasted a new built structure. Skip if we
      // already have it (the originator's optimistic local copy will
      // match by sid; receivers add fresh).
      _mpAdoptStructure(data.s);
      break;
    case 'structureHit':
      // Sync HP from server. Phase 44: no spark for non-destroying hits —
      // matches single-player where bullets damaging a wall don't explode.
      // The HP-bar visual on the structure is the feedback. Keep the
      // structureGone spark below since destruction IS a real event with
      // a single-player parity (structures.js line 401: createExplosion
      // 'small' on wall death).
      if (typeof game !== 'undefined' && Array.isArray(game._structures)) {
        const s = game._structures.find(x => x.sid === data.sid);
        if (s) s.hp = data.hp;
      }
      break;
    case 'structureGone':
      // Server destroyed a structure (HP <= 0). Remove from local + spawn
      // a confirmation spark. Single-player parity: the structures.js tick
      // also does createExplosion('small') when HP hits 0.
      if (typeof game !== 'undefined' && Array.isArray(game._structures)) {
        const idx = game._structures.findIndex(x => x.sid === data.sid);
        if (idx >= 0) game._structures.splice(idx, 1);
      }
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
      // Phase 5 — delta compression: only-overwrite when defined.
      // Missing field = "server says no change, keep last value."
      if (sp.x      !== undefined) _mpState.serverSelfX      = sp.x;
      if (sp.y      !== undefined) _mpState.serverSelfY      = sp.y;
      if (sp.angle  !== undefined) _mpState.serverSelfAngle  = sp.angle;
      if (sp.hp     !== undefined) _mpState.serverSelfHp     = sp.hp;
      if (sp.alive  !== undefined) _mpState.serverSelfAlive  = sp.alive;
      if (sp.invuln !== undefined) _mpState.serverSelfInvuln = !!sp.invuln;
      // Phase 59: dead→alive transition. _mpRespawnLocalPlayer() was defined
      // but had NO caller — nothing connected the server's respawn snapshot
      // back to player.alive=true, which was the user's '死掉瞬間復活的bug'
      // (actually opposite — visually felt 'instant' because no UI marked
      //  the dead window, then state ended up resyncing some other path).
      // Guard: only fire if (1) we were locally dead AND server says alive
      // AND (2) we actually died via the kill handler (_killedAtTime set)
      // AND (3) the buff/default respawn window elapsed — Phase 60 wires
      // the client gate to getRespawnSeconds() so the UI countdown's full
      // duration is honored before respawn fires (server also bumped to
      // match so this doesn't stall waiting for a late server snapshot).
      // Use the (potentially-just-updated) serverSelfAlive so a delta-only
      // snapshot that omits `alive` still works.
      if (typeof player !== 'undefined' && !player.alive && _mpState.serverSelfAlive) {
        const _t = (typeof game !== 'undefined' && game.time) ? game.time : 0;
        const _minDeadFrames = (typeof getRespawnSeconds === 'function')
          ? getRespawnSeconds() * 60
          : 90;
        if (player._killedAtTime && (_t - player._killedAtTime) >= _minDeadFrames) {
          _mpRespawnLocalPlayer();
        }
      }
      // Phase X — alive→dead safety net. User '有時候被幹掉我就會變成
      // 停在原地不能動,然後就動了會回去': the 'kill' event got lost in
      // transit so _mpHandleKill never fired; client kept player.alive=
      // true while server-side they were dead, server rejected their
      // movement inputs, client per-frame integration pushed them ahead,
      // reconcile snapped them back every snapshot = stuck-in-place.
      // Now the snapshot itself drives the dead transition when the
      // event was missed. Synthesize minimal kill metadata so the death
      // recap UI still works; killer name shows as '?' since we never
      // got the kill event.
      if (typeof player !== 'undefined' && player.alive && _mpState.serverSelfAlive === false) {
        const _respawnFrames = (typeof getRespawnSeconds === 'function')
          ? getRespawnSeconds() * 60 : 180;
        // Synthesize minimal kill metadata for the death-recap UI before
        // the state transition — killer shows as '?' since we never got
        // the kill event.
        if (!player._killer) player._killer = { callsign: '?' };
        // R12 — canonical dead transition + schedule respawn timer.
        // alive=false, hp=0, _killedAtTime, _lastDeathX/Y, _lbBumpDeath
        // all flow through PlayerLifecycle.killPlayer; the respawn
        // countdown is scheduled separately so SP NN's auto-swap path
        // can still skip it for itself (irrelevant here in MP).
        if (typeof PlayerLifecycle !== 'undefined') {
          PlayerLifecycle.killPlayer({ x: player.x, y: player.y });
          PlayerLifecycle.scheduleRespawn(_respawnFrames);
        }
        if (typeof triggerShake === 'function') triggerShake(8, 18);
        if (typeof triggerDeathRecap === 'function') triggerDeathRecap();
        console.log('[mp] alive→dead via snapshot (kill event was lost)');
      }
      // Drop inputs the server has already processed. lastInputSeq is
      // ALWAYS in every snapshot (never delta-omitted) since it changes
      // every tick — but guard anyway.
      if (sp.lastInputSeq != null) {
        _mpState.pendingInputs = _mpState.pendingInputs.filter(i => i.seq > sp.lastInputSeq);
      }
      // Replay remaining inputs from the server's confirmed position.
      // Use the merged serverSelf coords so delta snapshots (no x/y this
      // tick) replay against last-known authoritative position.
      //
      // Phase X — apply the SAME per-input multipliers as the server's
      // tick math: sprint × weapon × chassis. Without this, wolf sprint
      // (1.5 × 1.65 = 2.475×) replay was using flat 5.6 px/input while
      // the server moved 5.6 × 2.475 ≈ 13.86 px/input → predX behind
      // truth by ~8 px per pending input → reconcile pulled client
      // back at every 33 Hz snapshot = the visible "走路忽快忽慢" tug.
      // Now replay matches server step exactly; reconcile dist stays
      // sub-pixel in steady state.
      let predX = _mpState.serverSelfX, predY = _mpState.serverSelfY;
      for (const inp of _mpState.pendingInputs) {
        let dx = inp.dx, dy = inp.dy;
        const mag = Math.hypot(dx, dy);
        if (mag > 1) { dx /= mag; dy /= mag; }
        const sprintMul = inp.sprint ? 1.65 : 1.0;       // matches SPRINT_SPEED_MUL
        const wpnMul    = (typeof inp.wMul === 'number') ? inp.wMul : 1.0;
        const chsMul    = (typeof inp.cMul === 'number') ? inp.cMul : 1.0;
        const mul = sprintMul * wpnMul * chsMul;
        predX += dx * MP_PLAYER_SPEED * mul;
        predY += dy * MP_PLAYER_SPEED * mul;
      }
      // Push to local player object — Phase 80 spread-error reconcile.
      // User '權威必須存在! 聯機不能本地! 想辦法在遊玩時不跳針'. Phase 78's
      // "skip reconcile if alone" was wrong: server authority must stay.
      //
      // Real fix: instead of applying the position correction as a 30%-per-
      // snapshot lerp (visibly snaps the player ~10 times per second), we
      // accumulate the error into player._reconcileErr and DRIBBLE it out
      // over many frames in the main update loop. 8%/frame at 60 fps =
      // error halves every 8 frames (~130 ms) — well below the human
      // perception threshold for position drift.
      //
      // Server still wins authority:
      //   • all corrections move us TOWARD server position
      //   • big errors (>150u: teleport, respawn, lag spike) snap instantly
      //   • cheating impossible since server owns hit detection + damage
      //
      // Dead zone (<3px) silenced entirely so 1-2px snapshot noise never
      // triggers any visible jitter.
      if (typeof player !== 'undefined') {
        const dx = predX - player.x, dy = predY - player.y;
        const dist = Math.hypot(dx, dy);
        // Phase 83 — honour _mpIgnoreReconcileUntil. Pawn-swap sets it
        // to game.time + 90 ticks; during that window we skip ALL
        // position reconciliation so the swap actually sticks visually
        // until client inputs catch the server up.
        const _ignoreReconcile = (game?.time || 0) < (player._mpIgnoreReconcileUntil || 0);
        if (_ignoreReconcile) {
          player._reconcileErr = null;
        } else if (dist > 150) {
          // Big snap — teleport / respawn / lag spike.
          player.x = predX; player.y = predY;
          player._reconcileErr = null;
        } else if (dist < 3) {
          // Inside dead zone — server agrees with us, nothing to do.
        } else {
          // Spread-error reconcile (Phase 80).
          player._reconcileErr = { dx, dy };
        }
        // Phase 125 / R12 — post-respawn protection window. After
        // _mpRespawnLocalPlayer fires, server can still send stale
        // packets from the gap-damage period (server respawned earlier
        // than client UI countdown, server-side player took damage in
        // the gap, "you're dead" / "hp=0" packets are still in flight).
        // Block those rewrites for 180 ticks so the freshly-respawned
        // player keeps alive=true + hp=max + invuln shield intact.
        const _justRespawned = (typeof PlayerLifecycle !== 'undefined')
                               && PlayerLifecycle.justRespawned(180);
        // HP has TWO writers because NN bots live client-only (see fire()
        // ghost-bullet note in index.html). min(local, server) picks the
        // lower of:
        //   • local hp (NN bullet just hit us — server doesn't know)
        //   • server hp (MP bullet hit us — server is authoritative)
        // Both kinds of damage stay durable across snapshots. Respawn —
        // where server hp jumps low→max — is handled by
        // _mpRespawnLocalPlayer which snaps local hp explicitly, bypassing
        // this min(). The trade-off this loses: simultaneous NN+MP damage
        // in the same tick collapses to whichever is lower. Acceptable
        // for casual .io play; would need delta-based reconciliation if
        // we ever moved NN inference server-side.
        if (typeof sp.hp === 'number' && !_justRespawned) {
          player.hp = Math.min(
            (typeof player.hp === 'number') ? player.hp : sp.hp,
            sp.hp
          );
        }
        // alive is more nuanced — we let the local death-recap state
        // machine drive 'alive' to keep its UI sequence intact. We just
        // sync the kill/respawn signals via 'kill' events below.
        // Invuln pin: server is authoritative for spawn protection.
        // Phase 5: only act when sp.invuln is EXPLICITLY in the snapshot
        // — undefined means delta has no change, leave _invulnUntil alone.
        // Phase 125: also skip during the post-respawn window — server's
        // "invuln expired" packet from the gap shouldn't reset the
        // freshly-granted client-side shield.
        if (!_justRespawned) {
          if (sp.invuln === true) {
            player._invulnUntil = Infinity;
          } else if (sp.invuln === false && player._invulnUntil === Infinity) {
            player._invulnUntil = 0;
          }
        }
      }
    } else {
      // Remote player — push this sample into a timestamped buffer so the
      // renderer can interpolate between past samples instead of easing
      // toward a moving target.
      //
      // Phase 5 — server delta compression: this entry may carry only a
      // subset of fields (the ones that changed since OUR last snapshot).
      // First appearance for a new receiver IS a keyframe though, so
      // `rp` creation reads sp.* safely. Subsequent updates: only-
      // overwrite when defined.
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
      if (sp.x !== undefined) rp.targetX = sp.x;
      if (sp.y !== undefined) rp.targetY = sp.y;
      if (sp.angle !== undefined) rp.angle = sp.angle;
      if (sp.hp !== undefined) rp.hp = sp.hp;
      if (sp.alive !== undefined) rp.alive = sp.alive;
      if (sp.invuln !== undefined) rp.invuln = !!sp.invuln;
      if (sp.name) rp.name = sp.name;
      // Buffer the sample. With delta compression, push the MERGED state
      // (using rp's just-updated values), not raw sp.x — sp.x may be
      // undefined if the player didn't move this tick.
      const sampleT = (typeof snap.sT === 'number') ? snap.sT : nowMs;
      rp.buffer.push({ t: sampleT, x: rp.targetX, y: rp.targetY, angle: rp.angle });
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
  // Phase 5 — bullet delta. Server sends a full record {id,x,y,vx,vy,s,spawn:1}
  // on first appearance (or after AOI re-entry), thereafter just {id,x,y}.
  // Bullets that ended this tick are explicitly listed in
  // snap.removedBullets so we can drop them without the old "not in
  // seenIds → remove" cleanup (which would now wrongly delete bullets
  // that simply had no delta this tick).
  const nowPerf = performance.now();
  if (Array.isArray(snap.bullets)) {
    for (const b of snap.bullets) {
      if (b.spawn === 1 || !_mpState.remoteBullets.has(b.id)) {
        // First-appearance keyframe — full record.
        const bl = { id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, s: b.s, lastT: nowPerf };
        _mpState.remoteBullets.set(b.id, bl);
      } else {
        // Position-only delta — update existing bullet, keep vx/vy/s.
        const bl = _mpState.remoteBullets.get(b.id);
        if (b.x !== undefined) bl.x = b.x;
        if (b.y !== undefined) bl.y = b.y;
        bl.lastT = nowPerf;
      }
    }
  }
  if (Array.isArray(snap.removedBullets)) {
    for (const id of snap.removedBullets) _mpState.remoteBullets.delete(id);
  }
  // Stale-bullet TTL safety net: if a bullet hasn't been mentioned in a
  // snapshot for over 500 ms it's probably gone (e.g. we missed the
  // removedBullets event due to packet loss). Defense against orphan
  // bullets sitting forever on the client.
  for (const [id, bl] of _mpState.remoteBullets) {
    if (nowPerf - bl.lastT > 500) _mpState.remoteBullets.delete(id);
  }
  // Re-build the legacy list mirror for index.html's render loop.
  _mpRemoteBullets.length = 0;
  for (const bl of _mpState.remoteBullets.values()) _mpRemoteBullets.push(bl);

  // ─ bots ─ (Phase 5-aware delta merge)
  // snap.bots entries: keyframe carries full state, deltas only fields
  // that changed. Apply only-when-defined. targetX/Y lerped toward in
  // the render loop in index.html (lerpK=0.45) for smooth interpolation
  // between the 30 Hz snapshots.
  if (Array.isArray(snap.bots)) {
    for (const sb of snap.bots) {
      let rb = _mpState.remoteBots.get(sb.id);
      if (!rb) {
        // Keyframe — full state. Server is required to send a keyframe
        // on first appearance for a receiver, so the team/etc. fields
        // are present.
        rb = {
          id: sb.id, team: sb.team,
          x: sb.x, y: sb.y,
          targetX: sb.x, targetY: sb.y,
          angle: sb.angle, hp: sb.hp, alive: sb.alive,
          _walkPhase: 0,
        };
        _mpState.remoteBots.set(sb.id, rb);
      } else {
        if (sb.team !== undefined) rb.team = sb.team;
        if (sb.x !== undefined) rb.targetX = sb.x;
        if (sb.y !== undefined) rb.targetY = sb.y;
        if (sb.angle !== undefined) rb.angle = sb.angle;
        if (sb.hp !== undefined) rb.hp = sb.hp;
        if (sb.alive !== undefined) rb.alive = sb.alive;
      }
    }
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
    if (typeof playSfx === 'function') playSfx('hit', { vol: 0.55 });
    // Phase 41: screen shake scales with damage. Single-player parity
    // (index.html: triggerShake(min(6, b.damage * 0.25), 8) on player hit).
    if (typeof triggerShake === 'function') {
      triggerShake(Math.min(6, 25 * 0.25), 8);
    }
    // Phase 68 — MP parity for the Phase 67 directional hurt indicator.
    // SP sets _hurtAngle + _hurtIntensity at the bullet-vs-player site
    // (index.html line ~6785). MP damage is server-authoritative so the
    // local bullet collision never runs — we have to set the indicator
    // here from the impact coords the server already broadcast.
    if (typeof player !== 'undefined' && typeof ix === 'number' && typeof iy === 'number') {
      player._hurtAngle = Math.atan2(iy - player.y, ix - player.x);
      player._hurtIntensity = Math.min(1, (player._hurtIntensity || 0) + 0.6);
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
  // Phase 65 — burning wreckage on MP kills too (parity with NN-mode kills).
  // remotePlayers don't carry a _chassis field yet (server snapshot doesn't
  // broadcast it), so remote victims default to humanoid. Local player gets
  // its own _chassis. Either way the user sees the same smoldering effect
  // as in single-player.
  if (typeof spawnWreckage === 'function' && typeof dx === 'number') {
    let chassis = 'humanoid';
    if (data.victim === _mpState.myId && typeof player !== 'undefined') {
      chassis = player._chassis || 'humanoid';
    } else {
      const rp = _mpState.remotePlayers.get(data.victim);
      if (rp && rp.chassis) chassis = rp.chassis;
    }
    spawnWreckage(dx, dy, chassis);
  }
  // Phase 64 — softened kill cue + smaller volume (user '擊殺的声音太大').
  if (typeof playSfx === 'function') playSfx('death', { vol: 0.32 });

  // Local player got killed?
  if (data.victim === _mpState.myId && typeof player !== 'undefined') {
    // Phase X — duplicate-kill guard. Once we're already dead, a second
    // 'kill' event for us would re-stamp _killedAtTime + _respawnAt and
    // restart the countdown from 15 s — exactly the bug the user described
    // ('唯一復活時間一到又馬上開始重新倒數,這令人崩潰'). Server-side hit
    // detection skips dead players so duplicates shouldn't happen, but stray
    // broadcasts (catch-up after lag, AOE explosion echoes) can still arrive.
    // Drop them here so the death/respawn cycle stays clean.
    if (!player.alive) return;
    if (typeof _lbBumpDeath === 'function') _lbBumpDeath();
    player.alive = false;
    player._killer = { callsign: shooterName };
    player._killerWeapon = data.weapon;
    // Phase 59: set _respawnAt + _killedAtTime so (a) the dead-state
    // countdown overlay at index.html:9546 actually renders (was checking
    // player._respawnAt != null and that was never set on MP death → user
    // saw 'instant respawn' because no UI marked the 3s window), and (b)
    // the snapshot dead→alive transition above has a death-time anchor
    // to gate against insta-flip races.
    //
    // Phase 60: respawn duration is buffable via 'watch ad' rewarded video.
    // Default 15s, buff active 5s (÷3, 30 min duration). Server-side
    // RESPAWN_TICKS bumped to match (see server/party/server.js). Both
    // sides must agree or dead→alive transition will stall.
    const _gt = (typeof game !== 'undefined' && game.time) ? game.time : 0;
    const _respawnFrames = (typeof getRespawnSeconds === 'function')
      ? getRespawnSeconds() * 60
      : 180;
    player._respawnAt = _gt + _respawnFrames;
    player._killedAtTime = _gt;
    if (typeof triggerShake === 'function') triggerShake(8, 18);
    if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
      game._teamWipe.blue.wipedSince = game.time;
      game._teamWipe.blue.respawnAt  = game.time + _respawnFrames;
    }
    if (typeof triggerDeathRecap === 'function') triggerDeathRecap();
  }
  // Local player got the kill? Fattest hitmarker variant + confirm tone +
  // KILL popup at victim.
  if (data.shooter === _mpState.myId) {
    if (typeof _lbBumpKill === 'function') _lbBumpKill();
    // Phase 68 — MP parity for the Phase 66 score count-up animation.
    // SP kill handler at index.html:6418/6540 increments game.score+100
    // and game.killCount+1 on every kill. MP was only bumping the
    // leaderboard, so the smoothing tick (`_scoreDisplay` lerps toward
    // `game.score`) had nothing to chase — number never moved in PvP.
    if (typeof game !== 'undefined') {
      game.score = (game.score || 0) + 100;
      game.killCount = (game.killCount || 0) + 1;
    }
    _mpHitMarker = { until: Date.now() + 350, kind: 'kill' };
    if (typeof spawnDamagePopup === 'function' && typeof dx === 'number') {
      spawnDamagePopup(dx, dy, 0, true);  // `true` = kill flag → "KILL" label
    }
  }
}

function _mpSendRaw(payload) {
  const ws = _mpState.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Phase 1 net-audit — stringify once, count its length, send the same
  // buffer. Same single JSON.stringify cost we had before; +1 array push
  // for the bandwidth window. Cheap.
  let json;
  try { json = JSON.stringify(payload); } catch (e) { return; }
  try { ws.send(json); } catch (e) { return; }
  _mpState.bytesTxWindow.push({ t: Date.now(), bytes: json.length });
}

// Per-frame: gather input, send to server, locally predict.
// Called from index.html's game loop. We throttle to MP_INPUT_HZ.
function _mpSendInput() {
  if (!_mpState.enabled) return;
  if (typeof player === 'undefined') return;
  // Phase X — don't transmit movement / fire intent while locally dead.
  // Server already ignores inputs for dead players (server.js:882), so this
  // is purely about keeping the dead-state isolation clean: no possibility
  // of the avatar twitching mid-respawn from late-arriving inputs, no wasted
  // bandwidth. User: '死掉之後就不要再跟這個東西有關聯了'.
  if (!player.alive) return;
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
  // Fire condition. Three triggers:
  //   (1) mouse held — manual fire
  //   (2) Phase 44: aim-assist HARD LOCK — when aim-assist has snapped
  //       onto a target (player._aimAssistLockedAt is set), single-player
  //       sets autoFireFromLock=true and fires automatically (index.html
  //       line 5799). MP needs the same trigger or aim-assist feels broken
  //       — user just sees the reticle snap but no shots come out.
  //   (3) Phase 51: drone mode now ALLOWS fire (Phase 41 was wrong —
  //       drone is recon-only with no weapon, so blocking fire while the
  //       player is using the drone for sight made the avatar uselessly
  //       passive: aim-assist locked but nothing came out, exactly the
  //       bug the user reported '無人機看到敵人 我也看到敵人 自動射擊
  //       結果子彈直接穿過敵人'). FPV stays blocked because the FPV is
  //       a one-shot kamikaze with its own SPACE-detonate input — adding
  //       avatar fire on top would just waste ammo.
  const aimAssistLock = !!(player._aimAssistLockedAt);
  const fire = !!(typeof mouse !== 'undefined'
                  && (mouse.down || aimAssistLock)
                  && player.alive
                  && game.mode !== 'fpv');

  // Per-input loadout snapshot: sprint flag + weapon/chassis speed
  // multipliers + weapon id. Server uses these in its tick math so its
  // movement byte-matches the client's per-frame integration. Without
  // these the server defaults to 1.0 / no-sprint → server runs ~25 %
  // slower than client when sprinting on a wolf chassis → reconcile
  // tugs client back every snapshot → user '機器狼移動 衝刺時不順'.
  const sprint = !!(typeof player !== 'undefined' && player.sprinting);
  const wMul = (typeof playerWeapon !== 'undefined' && playerWeapon && typeof playerWeapon.speedMul === 'number')
    ? playerWeapon.speedMul : 1.0;
  const cMul = (typeof player !== 'undefined' && typeof player._chassisSpeedMul === 'number')
    ? player._chassisSpeedMul : 1.0;
  let wId = 'RIFLE';
  if (typeof WEAPONS !== 'undefined' && typeof playerWeapon !== 'undefined' && playerWeapon) {
    if (playerWeapon === WEAPONS.RIFLE)        wId = 'RIFLE';
    else if (playerWeapon === WEAPONS.SMG)     wId = 'SMG';
    else if (playerWeapon === WEAPONS.LMG)     wId = 'LMG';
    else if (playerWeapon === WEAPONS.SNIPER)  wId = 'SNIPER';
    else if (playerWeapon === WEAPONS.SHOTGUN) wId = 'SHOTGUN';
    else if (playerWeapon === WEAPONS.ROCKET)  wId = 'ROCKET';
    else {
      for (const k of Object.keys(WEAPONS)) {
        if (WEAPONS[k] === playerWeapon) { wId = k; break; }
      }
    }
  }

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
    // Phase 60: ad-rewarded respawn buff flag. Server reads this on death to
    // decide RESPAWN_TICKS (default 15s vs buffed 5s). Cheap to send every
    // input (1 boolean); avoids needing a dedicated 'buff-state' message.
    buffActive: (typeof isRespawnBuffed === 'function') ? isRespawnBuffed() : false,
    // Per-tick loadout (see big comment above).
    sprint: sprint ? 1 : 0,
    wMul, cMul, wId,
  };
  _mpSendRaw(input);

  // Muzzle flash + 'shoot' SFX are NOT spawned here. The local fire()
  // function in index.html runs every frame and handles muzzleFlashes,
  // applyRecoil, playSfx('shoot') — that's the canonical visual/audio
  // path for our own gun. We just stamp `fire: true` into the input
  // packet so the server spawns the network-authoritative bullet.

  // Phase 38 prediction — index.html's per-frame WASD code IS our
  // prediction. We just record the input here so reconciliation can
  // replay any unacked inputs from the server's confirmed position.
  _mpState.pendingInputs.push({ seq, dx, dy, angle, fire, sprint, wMul, cMul });

  // Cap the pendingInputs queue so it doesn't grow forever during net loss
  if (_mpState.pendingInputs.length > 120) {
    _mpState.pendingInputs.splice(0, _mpState.pendingInputs.length - 120);
  }
}

// Phase 80 — per-frame error-spread reconcile. Bleeds player._reconcileErr
// out at 8%/frame so the position drift from snapshot reconciliation is
// invisible (~130ms half-life) but server-truth is still authoritative.
// Called from the main update loop in index.html.
function _mpTickReconcile() {
  if (!_mpState.enabled || typeof player === 'undefined') return;
  const err = player._reconcileErr;
  if (!err) return;
  const RATE = 0.08;
  const stepX = err.dx * RATE;
  const stepY = err.dy * RATE;
  player.x += stepX;
  player.y += stepY;
  err.dx -= stepX;
  err.dy -= stepY;
  // Snap to clean when error is well under 1px so we don't sit on the
  // ledger forever doing arithmetic on dust.
  if (Math.abs(err.dx) < 0.15 && Math.abs(err.dy) < 0.15) {
    player._reconcileErr = null;
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
    // Capture pre-update position for walkPhase increment (matches single-
    // player's per-frame "if moving, advance walkPhase" behaviour).
    const prevX = rp.x, prevY = rp.y;
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
    // Phase 42: drive walkPhase off measured displacement so the leg-swing
    // animation actually plays for remote players (single-player parity).
    // The threshold (>0.5px/frame) ignores sub-pixel jitter from interp.
    const moved = Math.hypot(rp.x - prevX, rp.y - prevY);
    if (moved > 0.5) {
      rp.walkPhase = (rp.walkPhase || 0) + 0.18;
    }
  }
}

// Bullets advance using their snapshot velocity between snapshots.
// Each snapshot resets to authoritative pos; in-between we glide forward.
//
// Phase 44 fix: divide vx/vy by 2 per frame. Rationale:
//   • Server bullets move at BULLET_SPEED=14 px PER SERVER TICK
//   • Server ticks at 30Hz → 14 * 30 = 420 px/sec server-true velocity
//   • Client renders at ~60fps. If we naively did `b.x += b.vx` per frame,
//     we'd get 14 * 60 = 840 px/sec — DOUBLE the actual server speed.
//   • Result was bullets visually rocketing forward then snapping BACK
//     to authoritative position when each snapshot arrived. User report:
//     '子彈看起來像特效一樣 然後也不是很久'.
//   • At vx/2 per frame: 7 * 60 = 420 px/sec → exactly matches server.
//     Bullet appears as a continuous straight line of motion with no jump.
function _mpTickRemoteBullets() {
  if (!_mpState.enabled) return;
  for (const b of _mpState.remoteBullets.values()) {
    b.x += b.vx * 0.5;
    b.y += b.vy * 0.5;
  }
}

// Render remote players. Phase 46: NO vision gate — always render remote
// players. The Phase 41 isVisibleToFriendly + _lastSeen fade was causing
// the user-reported '掩體外的人 即便進入同掩體 也看不到掩體內人' bug:
// two players in the same warehouse couldn't see each other because a
// partition wall or interior crate blocked LoS, even though they were
// 200 px apart in the same room.
//
// Vision cones are a single-player anti-AI mechanic (lets you sneak past
// NN bots). In PvP it's just friction — wings.io / surviv.io / krunker
// all show all opponents on screen and trust the player's own awareness.
// Aim-assist still gates on LoS (you can't auto-lock through a wall),
// which keeps a small reward for staying behind cover without making the
// player invisible.
function _mpRenderRemote() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined' || typeof drawHumanoid !== 'function') return;
  // Phase 47: human players must read as DISTINCT from wild NPCs at a
  // glance. User: '敵人玩家看起來必須跟野生npc有所差異'. Four stacked cues:
  //   1. brighter body (redBright vs NPC's flat red)
  //   2. pulsing cream foot-halo (suppressed during spawn invuln, which
  //      already has its own ring at radius 18 — avoid double-ring)
  //   3. downward ▼ chevron floating above with gentle bob — universally
  //      read as "player marker" in .io / MOBA UIs
  //   4. HP bar mirroring NPC bar (same width/offset) so existing muscle
  //      memory still works
  const t = (typeof game !== 'undefined' && game.time) ? game.time : 0;
  const bob = Math.sin(t * 0.08) * 1.5;
  const haloAlpha = 0.30 + 0.20 * Math.abs(Math.sin(t * 0.08));
  for (const [id, rp] of _mpState.remotePlayers) {
    if (id === _mpState.myId) continue;
    if (!rp.alive) continue;
    ctx.save();
    // Foot halo BEFORE chassis so the body sits on top.
    if (!rp.invuln) {
      ctx.globalAlpha = haloAlpha;
      ctx.strokeStyle = COLORS.cream;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(rp.x, rp.y, 19, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Phase 42: parity with single-player enemy render (index.html:7878):
    //   drawHumanoid(e.x, e.y, e.angle, e.walkPhase, _bodyColor, true, e)
    // Pass walkPhase so legs swing while moving. Phase 47 swaps the body
    // colour to redBright so MP players read brighter than NPCs.
    drawHumanoid(rp.x, rp.y, rp.angle || 0, rp.walkPhase || 0, COLORS.redBright, true, rp);
    // HP bar — matches NPC bar at index.html:7910 (30×3 @ y-26).
    const hp = (typeof rp.hp === 'number') ? rp.hp : 100;
    if (hp < 100) {
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(rp.x - 15, rp.y - 22, 30, 3);
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(rp.x - 15, rp.y - 22, 30 * Math.max(0, hp) / 100, 3);
    }
    // Name label — sits between chevron and HP bar.
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(rp.name || '?', rp.x, rp.y - 28);
    // ▼ chevron above the name (filled cream, black outline so it stays
    // readable on every TOD).
    const cy = rp.y - 44 + bob;
    ctx.fillStyle = COLORS.cream;
    ctx.strokeStyle = COLORS.black;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(rp.x - 5, cy);
    ctx.lineTo(rp.x + 5, cy);
    ctx.lineTo(rp.x,     cy + 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (rp.invuln) {
      ctx.strokeStyle = COLORS.cream;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(rp.x, rp.y, 18, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

// Render server-owned bullets. Phase 42 (post-Phase-41): mirror the latest
// single-player bullet style verbatim (index.html:7720-7767):
//   • 3-layer streak — black outline (4px) + bright core (2px) + head dot
//   • Streak length 2.2× velocity (matches single-player's tracer length —
//     the old 0.45× I used was a stripped-down stub from Phase 33's relay
//     prototype, not the polished version)
//   • Player bullets use COLORS.cream (the "white" look the user noted as
//     missing), enemy bullets use COLORS.redBright. We discriminate by
//     comparing the bullet's shooter id against our own.
//   • Phase 46: NO vision gate (consistent with _mpRenderRemote dropping
//     the same gate). Players are always visible now, so hiding tracers
//     would be inconsistent — and tracers are the main signal that
//     "someone over there is shooting."
function _mpRenderRemoteBullets() {
  if (!_mpState.enabled) return;
  if (typeof ctx === 'undefined') return;
  ctx.lineCap = 'round';
  const enemyColor = (typeof COLORS !== 'undefined' && COLORS.redBright) || '#E63329';
  const blackColor = (typeof COLORS !== 'undefined' && COLORS.black) || '#1A1A1A';
  for (const b of _mpState.remoteBullets.values()) {
    // Skip server-echoes of our OWN bullets — those are rendered locally
    // by the main bullet draw loop (predicted at 60 fps so they feel
    // snappy). Server's echo arrives ~RTT/2 late and would either show
    // as a twin tracer (Phase 51 bug) or, if we suppress local rendering
    // instead, make our bullets feel slower than NN bullets — which IS
    // the bug user reported: '敵人NPC的子彈都超級快, 我們的都超級慢'.
    if (b.s === _mpState.myId) continue;
    const coreColor = enemyColor;
    const tx = b.x - b.vx * 2.2;
    const ty = b.y - b.vy * 2.2;
    // Outline (dark, wider) — readable on bright TODs.
    ctx.strokeStyle = blackColor;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y); ctx.lineTo(tx, ty);
    ctx.stroke();
    // Bright core — readable on dark TODs.
    ctx.strokeStyle = coreColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y); ctx.lineTo(tx, ty);
    ctx.stroke();
    // Head dot.
    ctx.fillStyle = coreColor;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = 'butt';
  ctx.lineWidth = 1;
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

// Phase 43 — built-structure sync helpers.
//
// Generate a sid that's globally unique-ish without coordination. We use the
// myId fragment (hex chars) plus a monotonic counter — millions of sids
// before any collision risk, and even then duplicates would just be ignored
// by the server's `if (this.structures.has(sid)) return` guard.
let _mpNextSidCounter = 1;
function _mpNextSid() {
  if (!_mpState.myId) return Math.floor(Math.random() * 0x7fffffff);
  // First 8 hex chars of myId as numeric prefix, then counter — fits in i32.
  const prefix = parseInt(_mpState.myId.replace(/-/g, '').slice(0, 6), 16) & 0x7fff;
  const c = (_mpNextSidCounter++) & 0xffff;
  return (prefix << 16) | c;
}

// Adopt a server-broadcast structure into the local game._structures array.
// Idempotent: if the sid already exists locally (the originator's optimistic
// copy), update HP and return without inserting. Otherwise push a fresh
// entry. The local entry needs the same shape as a single-player-built one
// (kind, x, y, hp, maxHp, fireCd, _placedAt) so the existing render +
// behaviour code can treat it identically.
function _mpAdoptStructure(s) {
  if (typeof game === 'undefined') return;
  game._structures = game._structures || [];
  const existing = game._structures.find(x => x.sid === s.sid);
  if (existing) {
    existing.hp = s.hp;
    existing.maxHp = s.maxHp;
    return;
  }
  game._structures.push({
    sid: s.sid, kind: s.kind, x: s.x, y: s.y,
    hp: s.hp, maxHp: s.maxHp,
    fireCd: 0, airstrikeCd: 0,
    _placedAt: (typeof game !== 'undefined' && game.time) || 0,
    _mpOwner: s.owner,
  });
}

// Send a build request to the server. Caller owns the sid (so its local
// optimistic add and the server's broadcast match by id).
function _mpBroadcastBuild(sid, kind, x, y) {
  if (!_mpState.enabled) return;
  _mpSendRaw({ type: 'build', sid, kind, x, y });
}

// Send an explosion request to the server. Server applies AOE damage to
// structures (player damage is still client-side because grenades are
// client-only). Used by explodeGrenade / detonateRocket / _detonateFPV when
// MP is active so built walls actually take damage from explosions.
function _mpBroadcastExplosion(x, y, radius, dmg) {
  if (!_mpState.enabled) return;
  _mpSendRaw({ type: 'explosionRequest', x, y, r: radius, dmg });
}

// Phase 102 — pawn-swap broadcast. Tell the authoritative server WHERE
// the local player just teleported so it stops simulating us at the old
// position. Without this, the next snapshot reconciles us back to A
// ('權威伺服器認為我上一秒在哪裡,下一秒在哪裡,然後他把我補償回去了').
// `botId` is optional — when swapping to a server-spawned NN bot, pass
// its id so server consumes that bot (kills it server-side, schedules
// respawn) and we don't end up with two entities stacked at the target.
function _mpBroadcastSwap(x, y, botId) {
  if (!_mpState.enabled) return;
  _mpSendRaw({ type: 'swap', x: Math.round(x), y: Math.round(y), botId: botId || 0 });
}

// Respawn handler — when server says we respawned, the snapshot will
// flip alive=true. Local recap UI is driven by server's 'kill' event +
// snapshot's alive flag.
function _mpRespawnLocalPlayer() {
  if (typeof player === 'undefined') return;
  // R12 — delegate the canonical respawn state writes to PlayerLifecycle.
  // It handles alive/hp/ammo/invuln/_lastRespawnAt/_respawnAt/_killedAtTime/
  // _mpIgnoreReconcileUntil + dismissDeathRecap atomically. Phase 125
  // semantics preserved: client-authoritative alive=true + hp=max (we
  // pass NO hp opt so reviveAtSpawn defaults to maxHp), server-authoritative
  // x/y (spawn point); 3 s shield + 180-tick snapshot protection window
  // start now. See js/player_lifecycle.js header for the contract.
  if (typeof PlayerLifecycle === 'undefined') return;
  PlayerLifecycle.reviveAtSpawn({
    x: _mpState.serverSelfX,
    y: _mpState.serverSelfY,
  });
  // Phase X — locally enforce 3 s spawn protection. Server already grants
  // INVULN_TICKS = 3s and stamps sp.invuln=true on the snapshot, but delta
  // compression can omit it on subsequent ticks, and the NN-bot bullets that
  // live client-only would otherwise be able to one-shot the freshly-spawned
  // player before the snapshot syncs. User: '我就是完全離開了這個地方,
  // 時間到的時候我才回來' — coming back must feel safe, not pre-killed.
  //
  // Phase 122 — was `Math.max(player._invulnUntil || 0, _gt + 180)` which
  // looked defensive but had a race: while dead, snapshot handler sets
  // _invulnUntil = Infinity (sp.invuln === true). Math.max(Infinity, _gt+180)
  // = Infinity, sticking the "while dead" pin onto the live player. Server
  // then sends sp.invuln === false to drop the pin → snapshot handler
  // clears _invulnUntil to 0 → spawn shield is GONE the same tick respawn
  // completed. User: '15s 倒數內莫名提前進場 倒致計時結束馬上死亡'.
  // Explicit grant: ignore prior state, give EXACTLY 3 s from now.
  // Team-wipe state is non-player-specific (whole squad's countdown) so
  // it stays inline here — PlayerLifecycle is single-unit scope. Clearing
  // these mirrors what the dead→alive transition expects: the team-wipe
  // overlay dismisses + future kill events can re-arm wipedSince fresh.
  if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue) {
    game._teamWipe.blue.wipedSince = null;
    game._teamWipe.blue.respawnAt = null;
  }
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

// ============================================================
// Phase 1 NETWORK AUDIT — opt-in instrumentation overlay
// ============================================================
//
// Renders a top-right panel with live bandwidth + tick + entity metrics
// when ?netdebug=1 is in the URL. Zero gameplay impact: the data lives
// in window-pruned arrays that already get pushed every send/recv, and
// the render only fires when the flag is on.
//
// Sources:
//   bytesRxWindow / bytesTxWindow  — pushed from ws.onmessage / _mpSendRaw
//   snapshotsRecvTimes             — pre-existing, already maintained
//   lastSnapBytes                  — set by 'snapshot' branch in handler
//   lastServerDbg                  — server-attached {tickMs, ...} payload
//   frameTimeWindow                — sampled by an rAF loop we install
//                                    on first overlay invocation
//
// Cost when flag is OFF: 2 array pushes per ws message (sub-µs each).
// Cost when flag is ON: ~25 fillText calls per frame in the corner.

const _MP_NETDEBUG = (() => {
  try { return new URLSearchParams(location.search).get('netdebug') === '1'; }
  catch (e) { return false; }
})();
let _mpNetDebugFrameSamplerInstalled = false;
function _mpInstallFrameSampler() {
  if (_mpNetDebugFrameSamplerInstalled) return;
  _mpNetDebugFrameSamplerInstalled = true;
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    _mpState.frameTimeWindow.push({ t: now, ms: now - last });
    last = now;
    // Cap window at 120 entries (~2 s @ 60 fps).
    if (_mpState.frameTimeWindow.length > 120) _mpState.frameTimeWindow.shift();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function _mpRenderNetDebug() {
  if (!_MP_NETDEBUG) return;
  if (typeof ctx === 'undefined') return;
  _mpInstallFrameSampler();
  // Prune bandwidth windows to last 2 s.
  const nowMs = Date.now();
  const prune = (arr) => {
    while (arr.length > 0 && nowMs - arr[0].t > 2000) arr.shift();
  };
  prune(_mpState.bytesRxWindow);
  prune(_mpState.bytesTxWindow);
  prune(_mpState.snapshotsRecvTimes && _mpState.snapshotsRecvTimes._objWindow || []);
  // Sum bytes in window.
  let rxBytes = 0, txBytes = 0;
  for (const e of _mpState.bytesRxWindow) rxBytes += e.bytes;
  for (const e of _mpState.bytesTxWindow) txBytes += e.bytes;
  // Snapshot rate.
  const sList = _mpState.snapshotsRecvTimes;
  const snapsLast2s = sList.length;
  // Per-frame stats.
  let frameP50 = 0, frameP95 = 0;
  if (_mpState.frameTimeWindow.length > 5) {
    const arr = _mpState.frameTimeWindow.map(s => s.ms).sort((a, b) => a - b);
    frameP50 = arr[Math.floor(arr.length * 0.5)];
    frameP95 = arr[Math.floor(arr.length * 0.95)];
  }
  // Entity counts.
  const remoteP = _mpState.remotePlayers.size;
  const remoteB = _mpState.remoteBullets.size;
  const remoteN = _mpState.remoteBots ? _mpState.remoteBots.size : 0;
  // Server dbg.
  const sdbg = _mpState.lastServerDbg || {};

  // Render panel top-right. AshGrid's ctx has a scale(DPR, DPR) baked in
  // so all drawing code uses CSS-pixel coordinates — drawing N CSS pixels
  // costs N×DPR canvas-backing pixels automatically. Do NOT multiply by
  // DPR here; that double-scales and pushes the panel off-screen.
  const W = 290, lh = 14, pad = 8;
  const fontPx = 11;
  const lines = [
    ['NET DEBUG · ?netdebug=1', '#FFD24A'],
    ['rtt  ' + Math.round(_mpState.rttSmoothed) + ' ms · ' +
      (_mpState.rttSmoothed < MP_PING_GREEN ? 'good' :
       _mpState.rttSmoothed < MP_PING_YELLOW ? 'ok' : 'bad'), '#E8E4D8'],
    ['snap ' + (snapsLast2s / 2).toFixed(1) + ' Hz · ' + (_mpState.lastSnapBytes||0) + ' B/snap', '#E8E4D8'],
    ['rx   ' + (rxBytes / 2 / 1024).toFixed(2) + ' KB/s', '#E8E4D8'],
    ['tx   ' + (txBytes / 2 / 1024).toFixed(2) + ' KB/s', '#E8E4D8'],
    ['frame ' + frameP50.toFixed(1) + ' ms · p95 ' + frameP95.toFixed(1), '#E8E4D8'],
    ['────────', '#7A7A7A'],
    ['peers ' + remoteP + ' · bullets ' + remoteB + ' · bots ' + remoteN, '#E8E4D8'],
    ['pending in ' + _mpState.pendingInputs.length, '#E8E4D8'],
    ['────────', '#7A7A7A'],
    // Budget = 1000 / server tick rate. We can't know the server's rate
    // directly here, but the server's tick# advance rate ≈ snap rate ×
    // SNAPSHOT_EVERY. For ?netdebug=1 display we just show the absolute
    // tick-ms and let the user infer load — anything under 1 ms is fine
    // for any tick rate up to ~500 Hz.
    ['srv tick ' + (sdbg.tickMs != null ? sdbg.tickMs.toFixed(2) : '?') + ' ms (lower is better)', '#E8E4D8'],
    ['srv tick pk ' + (sdbg.tickPk != null ? sdbg.tickPk.toFixed(2) : '?') + ' ms', '#E8E4D8'],
    ['srv tick# ' + (_mpState.serverTick||0), '#E8E4D8'],
  ];
  const H = lines.length * lh + pad * 2;
  // CSS-pixel coordinates throughout (ctx is pre-scaled by DPR). Use
  // canvas.clientWidth — the visible CSS width — instead of canvas.width
  // (the backing-buffer width, DPR × CSS) so right-align stays correct.
  const cssW = (typeof canvas !== 'undefined' && canvas.clientWidth) || 1200;
  const X = cssW - W - 10;
  // Y offset clears the top strip used by the operator-info HUD AND the
  // death-recap 64-px strip — those draw at Y < 70 CSS-px and would
  // cover the overlay otherwise.
  const Y = 80;
  ctx.save();
  ctx.fillStyle = 'rgba(20,20,28,0.82)';
  ctx.fillRect(X, Y, W, H);
  ctx.strokeStyle = '#FFD24A';
  ctx.lineWidth = 1;
  ctx.strokeRect(X + 0.5, Y + 0.5, W, H);
  ctx.font = 'bold ' + fontPx + 'px monospace';
  ctx.textAlign = 'left';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = lines[i][1];
    ctx.fillText(lines[i][0], X + pad, Y + pad + lh * (i + 1) - 3);
  }
  ctx.restore();
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
