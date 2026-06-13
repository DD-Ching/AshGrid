// ============ PLAYER RECORDER — behaviour-cloning capture (Phase 177) ========
// Step 1 of "真·模仿你" (C): record what YOU do as (observation, action) pairs in
// the SAME 65-dim / 18-action format the NN bots train on, so a future ai_arena
// behaviour-cloning run can train a "plays like you" model. This file is JUST the
// recorder + export — no training, and zero change to how bots think today.
//
// Why it's clean here: nnBuildObs(me, …) is generic — it builds the same 65-dim
// observation for the player as for a bot (every NN-only field it reads is guarded
// with `|| 0` / `> 0`), and the player's move+fire decodes into the same
// action = moveDir*2 + fire space. So a recorded sample is drop-in BC training data.
//
// OFF by default (privacy + per-tick cost). Toggle F9 · export Shift+F9 · ?rec=1
// auto-starts. SOLO only (in MP the local frame isn't the authoritative sim).
//
// Classic-script. Declares globally:
//   playerRecorderTick()     called once per sim tick from update(); no-op unless
//                            recording AND SOLO NN mode AND player alive
//   playerRecorderToggle(f)  start/stop (bound to F9)
//   playerRecorderExport()   download the dataset as JSON (bound to Shift+F9)
//   PlayerRecorder = { on, count() }
//
// Deps (resolved at call time): game · player · allies · enemies · mouse · NN ·
// nnBuildObs · _mpState · showSwapToast · T · document · location · Blob/URL.

(function () {
  'use strict';

  const SAMPLE_EVERY = 4;     // ~21 Hz at the 84 Hz sim tick — dense but light
  const CAP = 60000;          // ring buffer (~48 min @ 21 Hz); oldest dropped
  const _buf = [];            // [{ o: [65 floats], a: int 0..17 }]
  let _on = false;
  let _frame = 0;
  let _scratch = null;        // reused Float32Array for nnBuildObs output

  function _solo() {
    return (typeof game !== 'undefined' && game && game._nnMode)
        && (typeof _mpState === 'undefined' || !_mpState || !_mpState.enabled);
  }

  // Snap the player's actual displacement THIS tick (player.x − _prevX, set at the
  // top of update()) to the nearest of the NN's 9 move directions (0 = idle).
  function _encodeMoveDir() {
    const px = (player._prevX != null) ? player._prevX : player.x;
    const py = (player._prevY != null) ? player._prevY : player.y;
    const dx = player.x - px, dy = player.y - py;
    if ((dx * dx + dy * dy) < 0.25) return 0;        // < 0.5px → idle
    const dirs = NN.MOVE_DIRS;
    const inv = 1 / Math.hypot(dx, dy);
    const nx = dx * inv, ny = dy * inv;
    let best = 1, bestDot = -Infinity;
    for (let d = 1; d < dirs.length; d++) {           // d=0 is idle, skip
      const dot = nx * dirs[d][0] + ny * dirs[d][1];
      if (dot > bestDot) { bestDot = dot; best = d; }
    }
    return best;
  }

  function playerRecorderTick() {
    if (!_on || !_solo()) return;
    if (typeof player === 'undefined' || !player || !player.alive) return;
    if (typeof nnBuildObs !== 'function' || typeof NN === 'undefined') return;
    if ((++_frame % SAMPLE_EVERY) !== 0) return;
    if (!_scratch) _scratch = new Float32Array(NN.OBS_DIM);
    // Player is team 0 → no X-flip; friendlies = allies, hostiles = enemies.
    nnBuildObs(player,
      (typeof allies !== 'undefined' ? allies : []),
      (typeof enemies !== 'undefined' ? enemies : []),
      _scratch, false);
    const fire = (typeof mouse !== 'undefined' && mouse && mouse.down) ? 1 : 0;
    const action = _encodeMoveDir() * 2 + fire;
    if (_buf.length >= CAP) _buf.shift();
    _buf.push({ o: Array.from(_scratch), a: action });
  }

  function playerRecorderToggle(force) {
    _on = (typeof force === 'boolean') ? force : !_on;
    const msg = _on ? ('● REC · ' + _buf.length + ' samples')
                    : ('■ REC OFF · ' + _buf.length + ' captured');
    if (typeof showSwapToast === 'function') showSwapToast(typeof T === 'function' ? T(msg, msg) : msg);
    return _on;
  }

  function playerRecorderExport() {
    const payload = {
      format: 'ashgrid-bc-v1',
      obs_dim: (typeof NN !== 'undefined' && NN.OBS_DIM) || 65,
      action_dim: (typeof NN !== 'undefined' && NN.ACTION_DIM) || 18,
      note: 'player (obs,action) trace for behaviour cloning; action = moveDir*2 + fire',
      count: _buf.length,
      samples: _buf,
    };
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'ashgrid_player_trace_' + _buf.length + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { /* export is best-effort */ }
    return _buf.length;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'F9') {
        e.preventDefault();
        if (e.shiftKey) playerRecorderExport(); else playerRecorderToggle();
      }
    });
    try {
      if (typeof location !== 'undefined' && /[?&]rec=1\b/.test(location.search)) _on = true;
    } catch (e) {}
  }

  window.PlayerRecorder = {
    get on() { return _on; },
    count: () => _buf.length,
    last:  () => (_buf.length ? _buf[_buf.length - 1] : null),  // debug peek
  };
  window.playerRecorderTick = playerRecorderTick;
  window.playerRecorderToggle = playerRecorderToggle;
  window.playerRecorderExport = playerRecorderExport;
})();
