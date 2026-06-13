// ============ KILLCAM — death replay + press-SPACE respawn (Phase 179) ======
// "不要死不瞑目": when the player actually dies out (SOLO NN team-wipe → real
// respawn wait), play a short stylised replay of the last ~2.6 s ending at the
// kill, with a "被 X 擊殺 · WEAPON" banner, then let them press SPACE to redeploy
// (auto-falls back to the existing respawn timer if they don't).
//
// DESIGN — layer ON TOP, never inside the respawn state machine. The death /
// respawn / ad code is the most bug-prone area in the game (Phase 122/125/129c/
// 136). So this module:
//   • READS state only (player.alive / _killer / _respawnAt / game._teamWipe).
//   • Draws as a single over-HUD FX layer (covers the existing UI during the
//     replay; hands back to it for the respawn wait).
//   • The ONLY state it writes is on press-SPACE: it collapses the EXISTING
//     respawn deadline to "now" so the canonical revive path (nn_deathmatch.js
//     _reviveTeam / per-unit revive) fires early. It never calls reviveAtSpawn
//     itself.
//   • SOLO-first: gated to SOLO NN mode. MP reuses the contract in a later phase.
//
// It also needs no camera.js change — the replay is drawn with a self-contained
// top-down transform centred on the kill, over a backdrop.
//
// Classic-script. Loads AFTER render_frame.js (registerFxLayer) + death_recap.js.
// Declares globally:
//   KillCam = { phase(), active(), canRespawn(), requestRespawn(), _debugStart() }
//   killcamCanRespawn()      true when SPACE should redeploy (for key_bindings)
//   killcamRequestRespawn()  collapse the respawn deadline to now (press SPACE)
//   killcamBlocking()        true while the replay backdrop is covering the UI
//
// Deps (call-time): game · player · ReplayBuffer · W · H · ctx · COLORS · T/_r.

(function () {
  'use strict';

  const PLAY_MS     = 2600;   // replay playback length
  const MIN_SKIP_MS = 800;    // must see at least this much before SPACE works
  const DT_CLAMP    = 120;    // cap per-frame clock delta (absorbs ad/pause gaps)

  let _phase     = 'off';     // 'off' | 'playing' | 'done'
  let _elapsedMs = 0;
  let _lastMs    = 0;
  let _requested = false;     // press-SPACE latch: block re-trigger until revived

  // Captured at start so the view never jitters mid-replay.
  let _shot      = [];        // frame refs copied from ReplayBuffer
  let _killerName = '';
  let _weapon     = '';
  let _killerId   = null;
  let _cx = 0, _cy = 0, _scale = 1;
  let _vx = 0, _vy = 0, _kx = 0, _ky = 0;

  // ── helpers ──────────────────────────────────────────────────────────
  function _t(zh, en) {
    if (typeof T === 'function') return T(zh, en);
    if (typeof _r === 'function') return _r(zh, en);
    return zh;
  }
  function _col(name, fallback) {
    return (typeof COLORS !== 'undefined' && COLORS[name]) ? COLORS[name] : fallback;
  }
  function _solo() {
    return (typeof game !== 'undefined' && game && game._nnMode)
        && (typeof _mpState === 'undefined' || !_mpState || !_mpState.enabled);
  }
  function _isDead() {
    return typeof player !== 'undefined' && player && !player.alive;
  }
  function _inRespawnWait() {
    // Real "dead out" wait: blue team-wiped OR a per-player respawn timer is set.
    const tw = (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue
                && game._teamWipe.blue.wipedSince);
    const perPlayer = (typeof player !== 'undefined' && player && player._respawnAt != null);
    return !!(tw || perPlayer);
  }
  function _now() { return Date.now(); }

  // ── lifecycle ────────────────────────────────────────────────────────
  function _begin() {
    _shot = (typeof ReplayBuffer !== 'undefined' && ReplayBuffer.frames)
      ? ReplayBuffer.frames().slice() : [];
    const k = (typeof player !== 'undefined') ? player._killer : null;
    _killerName = (k && k.callsign) || _t('敵方', 'ENEMY');
    _weapon     = (typeof player !== 'undefined' && player._killerWeapon) || '';
    _killerId   = (k && k.__replayId != null) ? k.__replayId : null;

    const vx = (player._lastDeathX != null) ? player._lastDeathX : player.x;
    const vy = (player._lastDeathY != null) ? player._lastDeathY : player.y;
    let kx = vx, ky = vy;
    if (k && typeof k.x === 'number' && typeof k.y === 'number') { kx = k.x; ky = k.y; }
    _vx = vx; _vy = vy; _kx = kx; _ky = ky;
    _cx = (vx + kx) / 2; _cy = (vy + ky) / 2;
    const span = Math.max(420, Math.hypot(kx - vx, ky - vy) * 2.4 + 240);
    _scale = Math.min(W(), H()) / span;
    _scale = Math.max(0.35, Math.min(1.8, _scale));

    _elapsedMs = 0;
    _lastMs = _now();
    _phase = 'playing';
  }

  function _update() {
    // Alive again (auto-revive, pawn-swap, or our own press-SPACE landed) →
    // reset everything incl. the press-SPACE latch.
    if (!_isDead()) {
      _requested = false;
      if (_phase !== 'off') _phase = 'off';
      return;
    }

    if (_phase === 'off') {
      // `_requested` blocks a 1-frame re-trigger flash between pressing SPACE
      // and the revive actually landing next sim tick.
      if (!_requested && _solo() && _inRespawnWait()
          && (typeof player !== 'undefined') && player._killer) {
        _begin();
      }
      return;
    }

    // advance the playback clock; freeze it while an ad/pause is up so the
    // replay resumes where it left off instead of skipping ahead.
    const now = _now();
    const dt = Math.min(DT_CLAMP, now - _lastMs);
    _lastMs = now;
    if (typeof game === 'undefined' || !game._paused) _elapsedMs += dt;

    if (_phase === 'playing' && _elapsedMs >= PLAY_MS) _phase = 'done';
  }

  // ── world→screen for the captured view ───────────────────────────────
  function _sx(wx) { return W() / 2 + (wx - _cx) * _scale; }
  function _sy(wy) { return H() / 2 + (wy - _cy) * _scale; }

  function _frameAt(frac) {
    const n = _shot.length;
    if (n === 0) return null;
    let i = Math.floor(frac * (n - 1));
    if (i < 0) i = 0; if (i > n - 1) i = n - 1;
    return _shot[i];
  }

  function _drawUnit(u) {
    const sx = _sx(u.x), sy = _sy(u.y);
    const isKiller = (_killerId != null && u.id === _killerId);
    const isPlayer = !!u.p;
    const r = Math.max(4, (u.r || 12) * _scale);
    ctx.globalAlpha = u.dead ? 0.35 : 1;
    // body
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = (u.team === 0) ? '#4DA6FF' : '#E0392A';
    ctx.fill();
    // facing tick
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(u.a) * r * 1.7, sy + Math.sin(u.a) * r * 1.7);
    ctx.stroke();
    // highlight rings + labels for the two principals
    if (isPlayer) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = _col('cream', '#E8E4D8');
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(sx, sy, r + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = _col('cream', '#E8E4D8');
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(_t('你', 'YOU'), sx, sy - r - 9);
    } else if (isKiller) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#FF5A3C';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(sx, sy, r + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#FF5A3C';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(_killerName, sx, sy - r - 9);
    }
    ctx.globalAlpha = 1;
  }

  function _renderReplay(W_, H_) {
    const frac = Math.min(1, _elapsedMs / PLAY_MS);
    const f = _frameAt(frac);

    // kill-line (killer → you), pulsing, drawn under the markers
    ctx.save();
    const pulse = 0.4 + 0.35 * Math.sin(_elapsedMs * 0.012);
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#FF5A3C';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(_sx(_kx), _sy(_ky));
    ctx.lineTo(_sx(_vx), _sy(_vy));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    if (!f) {
      // No buffered frames (died too early) — static markers so it's not blank.
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#E0392A';
      ctx.beginPath(); ctx.arc(_sx(_kx), _sy(_ky), 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4DA6FF';
      ctx.beginPath(); ctx.arc(_sx(_vx), _sy(_vy), 12, 0, Math.PI * 2); ctx.fill();
      return;
    }

    // bullets (neutral tracers)
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = _col('cream', '#E8E4D8');
    for (let i = 0; i < f.bullets.length; i++) {
      const b = f.bullets[i];
      ctx.fillRect(_sx(b.x) - 1.5, _sy(b.y) - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
    // units — non-principals first, principals last (drawn on top)
    for (let i = 0; i < f.units.length; i++) {
      const u = f.units[i];
      if (u.p || (_killerId != null && u.id === _killerId)) continue;
      _drawUnit(u);
    }
    for (let i = 0; i < f.units.length; i++) {
      const u = f.units[i];
      if (u.p || (_killerId != null && u.id === _killerId)) _drawUnit(u);
    }
    // Phase 180d — killer was never sampled into the buffer (distant / sniper /
    // turret stayed outside the nearest-MAX_UNITS window) so it has no moving
    // marker to ring. Draw a STATIC killer marker at its known final position
    // (the kill-line endpoint) so '谁干掉了你' — ring + name — is always shown.
    if (_killerId == null) {
      const ksx = _sx(_kx), ksy = _sy(_ky);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#E0392A';
      ctx.beginPath(); ctx.arc(ksx, ksy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#FF5A3C';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ksx, ksy, 15, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#FF5A3C';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(_killerName, ksx, ksy - 22);
    }
  }

  function _renderBanner(W_, H_) {
    // top strip — KILLED BY card
    const stripH = 58;
    ctx.fillStyle = 'rgba(18, 8, 8, 0.92)';
    ctx.fillRect(0, 0, W_, stripH);
    ctx.fillStyle = _col('red', '#C8261C');
    ctx.fillRect(0, stripH - 3, W_, 3);
    ctx.textAlign = 'left';
    ctx.fillStyle = _col('red', '#C8261C');
    ctx.font = 'bold 10px monospace';
    ctx.fillText(_t('擊殺回放 // KILLCAM', 'KILLCAM // REPLAY'), 22, 20);
    ctx.fillStyle = _col('cream', '#E8E4D8');
    ctx.font = 'bold 22px sans-serif';
    const wpn = _weapon ? ('  ·  ' + _weapon) : '';
    ctx.fillText(_t('被 ', 'KILLED BY ') + _killerName + wpn, 22, 46);
  }

  function _renderProgress(W_, H_) {
    const frac = Math.min(1, _elapsedMs / PLAY_MS);
    const barW = Math.min(360, W_ - 80);
    const x = (W_ - barW) / 2, y = H_ - 40, h = 5;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(x, y, barW, h);
    ctx.fillStyle = _col('red', '#C8261C');
    ctx.fillRect(x, y, barW * frac, h);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(232,228,216,0.85)';
    ctx.font = 'bold 10px monospace';
    const canSkip = _elapsedMs >= MIN_SKIP_MS;
    ctx.fillText(canSkip ? _t('▶ 空白鍵 跳過 / 復活', '▶ SPACE to skip / respawn')
                         : _t('回放中…', 'REPLAY…'),
                 W_ / 2, y - 8);
  }

  function _renderRespawnHint(W_, H_) {
    // 'done' phase: the existing recap / countdown UI is visible underneath;
    // add only a single pulsing redeploy prompt above the bottom hint strip.
    const pulse = 0.65 + 0.35 * Math.sin(_now() * 0.006);
    ctx.textAlign = 'center';
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#3FE63F';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(_t('▶ 按空白鍵復活', '▶ PRESS SPACE TO RESPAWN'), W_ / 2, H_ / 2 + 120);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  function _render() {
    const W_ = W(), H_ = H();
    ctx.save();
    if (_phase === 'playing') {
      ctx.fillStyle = 'rgba(8, 6, 10, 0.84)';
      ctx.fillRect(0, 0, W_, H_);
      _renderReplay(W_, H_);
      _renderBanner(W_, H_);
      _renderProgress(W_, H_);
    } else if (_phase === 'done') {
      _renderRespawnHint(W_, H_);
    }
    ctx.restore();
  }

  // single entry from the FX registry — runs every rendered frame
  function _fxDraw() {
    // Phase 180a fix — stay fully out of the way while paused (pause menu / ad
    // overlay): don't arm, advance, or paint, so the killcam never flashes
    // over/under the pause overlay. The playback clock resumes on unpause.
    if (typeof game !== 'undefined' && game._paused) return;
    _update();
    if (_phase === 'off') return;
    _render();
  }

  // ── public: press-SPACE redeploy (P-C) ───────────────────────────────
  function killcamCanRespawn() {
    if (!_solo() || !_isDead()) return false;
    if (_phase === 'done') return true;
    if (_phase === 'playing' && _elapsedMs >= MIN_SKIP_MS) return true;
    return false;
  }

  function killcamRequestRespawn() {
    if (!killcamCanRespawn()) return false;
    // Collapse the EXISTING respawn deadline to now so the canonical revive
    // path fires next tick. We never revive directly.
    const now = _now();
    if (typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue
        && game._teamWipe.blue.wipedSince) {
      game._teamWipe.blue.respawnAtMs = now;          // wall-clock revive (nn_deathmatch:438)
      game._teamWipe.blue.respawnAt   = game.time;    // tick fallback
    }
    if (typeof player !== 'undefined' && player && player._respawnAt != null) {
      player._respawnAt = game.time;                  // per-player revive (nn_deathmatch:583)
    }
    _requested = true;   // latch: don't re-arm the killcam before the revive lands
    _phase = 'off';
    return true;
  }

  function killcamBlocking() { return _phase === 'playing'; }

  // Register the over-HUD layer if the registry is present (it always is post
  // render_frame.js, but guard so this file is safe to load anywhere).
  if (typeof registerFxLayer === 'function') {
    registerFxLayer({
      id: 'killcam',
      space: 'overlay-over-hud',
      when: () => true,           // _fxDraw self-gates (cheap when off)
      draw: _fxDraw,
      allocsPerFrame: false,
    });
  }

  window.killcamCanRespawn     = killcamCanRespawn;
  window.killcamRequestRespawn = killcamRequestRespawn;
  window.killcamBlocking       = killcamBlocking;
  window.KillCam = {
    phase:          () => _phase,
    active:         () => _phase !== 'off',
    canRespawn:     killcamCanRespawn,
    requestRespawn: killcamRequestRespawn,
  };
})();
