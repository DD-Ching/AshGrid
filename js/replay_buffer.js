// ============ REPLAY BUFFER — SOLO killcam ring buffer (Phase 179) ==========
// Records a lightweight world snapshot every few sim ticks into a fixed-size
// ring buffer so the killcam (js/killcam.js) can replay the last ~3 s leading
// up to the player's death — the "不要死不瞑目 / 谁干掉了你" ask. SOLO NN-mode
// only: in MP the local frame isn't authoritative and opponents live in
// remotePlayers (not enemies[]), so a faithful replay would need server history
// we don't keep. The MP killcam (later phase) will reuse this module's contract
// fed from a different source.
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

  function _solo() {
    return (typeof game !== 'undefined' && game && game._nnMode)
        && (typeof _mpState === 'undefined' || !_mpState || !_mpState.enabled);
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
    if (!_solo()) return;
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

    // Gather allies (team 0) + enemies (team 1), keep the nearest MAX_UNITS so a
    // big arena doesn't blow the snapshot up.
    const near = [];
    const _al = (typeof allies  !== 'undefined' && allies)  ? allies  : [];
    const _en = (typeof enemies !== 'undefined' && enemies) ? enemies : [];
    for (const a of _al) { if (!a) continue; const dx = a.x - px, dy = a.y - py; near.push({ u: a, team: 0, d: dx * dx + dy * dy }); }
    for (const e of _en) { if (!e) continue; const dx = e.x - px, dy = e.y - py; near.push({ u: e, team: 1, d: dx * dx + dy * dy }); }
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
