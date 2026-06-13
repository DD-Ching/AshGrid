// ============ REPLAY BUFFER — killcam ring buffer (Phase 179 / 180e MP) ======
// Records a lightweight world snapshot every few sim ticks into a fixed-size
// ring buffer so the killcam (js/killcam.js) can replay the last ~3 s leading
// up to the player's death — the "不要死不瞑目 / 谁干掉了你" ask. NN mode (SOLO
// or MP). SOLO samples enemies[]; MP samples the interpolated remotePlayers /
// remoteBots (opponents don't live in enemies[] under MP). Player + allies are
// sampled in both. It's a local visual replay only — not authoritative.
//
// Behaviour-preserving: records ONLY. The single write to game state is a hidden
// stable `__replayId` tag on units so the killcam can follow the SAME body
// across frames even as array order changes (units splice out on death). Nothing
// else in the codebase reads __replayId.
//
// Off the hot path: a snapshot is a handful of plain objects every SAMPLE_EVERY
// ticks, capped to the nearest MAX_UNITS units + MAX_BULLETS bullets around the
// player. ~67 frames × ~28 small objects ≈ a few KB resident.
//
// Classic-script. Declares globally:
//   replayBufferTick()   record one snapshot; no-op unless SOLO NN & alive.
//                        Hook once per sim tick from update().
//   ReplayBuffer = { frames(), size(), reset() }
//
// Deps (resolved at call time): game · player · allies · enemies · bullets ·
//   _mpState.

(function () {
  'use strict';

  const SAMPLE_EVERY = 4;     // ~21 Hz at the 84 Hz sim tick — smooth, light
  const SECONDS      = 3;     // history window the killcam can show
  const CAP          = Math.ceil((84 / SAMPLE_EVERY) * SECONDS) + 4;  // ~67 frames
  const MAX_UNITS    = 28;    // nearest-to-player cap per frame
  const MAX_BULLETS  = 48;

  const _frames = [];         // ring: { ms, units:[…], bullets:[{x,y}] }
  let _frame    = 0;
  let _nextId   = 1;
  let _wasAlive = false;      // edge-detect respawn → start a clean history

  function _nnOn() {
    return (typeof game !== 'undefined' && game && game._nnMode);
  }
  function _mp() {
    return (typeof _mpState !== 'undefined' && _mpState && _mpState.enabled);
  }

  // Stable per-unit id (lazy). Hidden field — no game logic reads it.
  function _idOf(u) {
    if (u.__replayId == null) u.__replayId = _nextId++;
    return u.__replayId;
  }

  function _pushUnit(arr, u, team, isPlayer) {
    arr.push({
      id:   _idOf(u),
      x:    u.x,
      y:    u.y,
      a:    (u.viewAngle != null ? u.viewAngle : (u.angle || 0)),
      team: team,                 // 0 = blue (player side), 1 = red
      p:    isPlayer ? 1 : 0,
      r:    u.radius || 12,
      dead: u.alive ? 0 : 1,
    });
  }

  function replayBufferTick() {
    if (!_nnOn()) return;
    if (typeof player === 'undefined' || !player) return;
    // On the dead→alive edge (respawn / pawn-swap), drop the previous life's
    // frames so the NEXT killcam never shows a stale pre-respawn replay.
    if (player.alive && !_wasAlive) reset();
    _wasAlive = !!player.alive;
    // Freeze the buffer the instant the player dies so it preserves the last
    // ~3 s ENDING at the death moment instead of being overwritten by the
    // post-death idle frames (the killcam reads it next).
    if (!player.alive) return;
    if ((++_frame % SAMPLE_EVERY) !== 0) return;

    const px = player.x, py = player.y;
    const units = [];
    _pushUnit(units, player, 0, true);

    // Gather allies (team 0) + opponents (team 1), keep the nearest MAX_UNITS so
    // a big arena doesn't blow the snapshot up. SOLO opponents live in enemies[];
    // MP opponents are the interpolated remotePlayers / remoteBots (NOT enemies[]).
    const near = [];
    const _al = (typeof allies !== 'undefined' && allies) ? allies : [];
    for (const a of _al) { if (!a) continue; const dx = a.x - px, dy = a.y - py; near.push({ u: a, team: 0, d: dx * dx + dy * dy }); }
    if (_mp()) {
      const _addFoe = (u) => {
        if (!u || typeof u.x !== 'number' || typeof u.y !== 'number') return;
        const dx = u.x - px, dy = u.y - py; near.push({ u, team: 1, d: dx * dx + dy * dy });
      };
      if (_mpState.remotePlayers && _mpState.remotePlayers.forEach) _mpState.remotePlayers.forEach(_addFoe);
      if (_mpState.remoteBots && _mpState.remoteBots.forEach) _mpState.remoteBots.forEach(_addFoe);
    } else {
      const _en = (typeof enemies !== 'undefined' && enemies) ? enemies : [];
      for (const e of _en) { if (!e) continue; const dx = e.x - px, dy = e.y - py; near.push({ u: e, team: 1, d: dx * dx + dy * dy }); }
    }
    near.sort((m, n) => m.d - n.d);
    for (let i = 0; i < near.length && units.length < MAX_UNITS; i++) {
      _pushUnit(units, near[i].u, near[i].team, false);
    }

    // Bullets — position only; the killcam draws them as neutral tracers.
    const bsrc = (typeof bullets !== 'undefined' && Array.isArray(bullets)) ? bullets : [];
    const bout = [];
    for (let i = 0; i < bsrc.length && bout.length < MAX_BULLETS; i++) {
      const b = bsrc[i];
      if (b) bout.push({ x: b.x, y: b.y });
    }

    if (_frames.length >= CAP) _frames.shift();
    _frames.push({ ms: Date.now(), units, bullets: bout });
  }

  function reset() { _frames.length = 0; _frame = 0; }

  window.replayBufferTick = replayBufferTick;
  window.ReplayBuffer = {
    frames: () => _frames,
    size:   () => _frames.length,
    reset:  reset,
  };
})();
