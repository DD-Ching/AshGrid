// ============ DEATH RECAP ============
// On player death, capture the kill context + flag the renderer to draw a
// full-screen "OPERATOR DOWN" overlay for ~2.5s (auto-dismiss). The overlay
// is visual only — pawn-swap (1-4) still works underneath so the player can
// jump bodies during the recap if they want to skip it.
//
// Classic-script. Declares globally:
//   _deathRecap (object — { active, killerCallsign, weaponLabel, distance, t })
//   triggerDeathRecap(killer, weaponLabel) · dismissDeathRecap()
//   renderDeathRecap()
//
// External deps: player · game · ctx · W · H · _r · COLORS ·
//   getOperatorName · drawHUDPanel

// On player death, capture the kill context + flag the renderer to draw a
// full-screen "OPERATOR DOWN" overlay for ~2.5s (auto-dismiss). The overlay
// is visual only — pawn-swap (1-4) still works underneath so the player can
// jump bodies during the recap if they want to skip it.
const _deathRecap = {
  active: false,
  startTick: 0,
  durationTicks: 150,         // 2.5s @ 60 TPS
  killer: null,
  killerCallsign: '',
  killerWeapon: '',
  killerX: 0, killerY: 0,
  victimX: 0, victimY: 0,
  distance: 0,
  lastHits: [],               // {dmg, weapon} for the 3 most recent hits
};
function triggerDeathRecap() {
  // Skip in non-NN modes (campaign hands its own end card; killcam noise)
  if (!game._nnMode) return;
  _deathRecap.active = true;
  _deathRecap.startTick = game.time;
  const k = player._killer;
  _deathRecap.killer = k;
  _deathRecap.killerCallsign = (k && k.callsign) || _r('敵方', 'ENEMY');
  _deathRecap.killerWeapon  = player._killerWeapon || '';
  _deathRecap.killerX = k ? k.x : player.x;
  _deathRecap.killerY = k ? k.y : player.y;
  _deathRecap.victimX = player.x;
  _deathRecap.victimY = player.y;
  _deathRecap.distance = k ? Math.hypot(k.x - player.x, k.y - player.y) : 0;
  // Snapshot last few damage events from the recent damage log if we have one
  _deathRecap.lastHits = (player._recentHits || []).slice(-3);
}
function dismissDeathRecap() { _deathRecap.active = false; }

function renderDeathRecap() {
  if (!_deathRecap.active) return;
  const elapsed = game.time - _deathRecap.startTick;
  if (elapsed >= _deathRecap.durationTicks) { _deathRecap.active = false; return; }
  const t = elapsed / _deathRecap.durationTicks;
  const fade = t < 0.15 ? (t / 0.15) : (t > 0.85 ? (1 - t) / 0.15 : 1);

  // Top strip + bottom hint instead of a full-screen blocker. The world
  // stays visible underneath so pawn-swap (1-4) can target a live ally
  // without the player guessing where everyone is. User: '不應該直接擋住
  // 介面,不然的話我在切換它自動切換人員的時候會不會直接擋住,沒有辦法玩'.
  const W_ = W(), H_ = H();
  ctx.save();
  ctx.globalAlpha = fade;

  // ---- Top strip: black bar with red accent rail + key data ----
  const stripH = 64;
  ctx.fillStyle = `rgba(20, 8, 8, 0.92)`;
  ctx.fillRect(0, 0, W_, stripH);
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(0, stripH - 4, W_, 4);
  // CRT scanlines on the strip only
  ctx.fillStyle = 'rgba(0, 0, 0, 0.20)';
  for (let y = 0; y < stripH; y += 4) ctx.fillRect(0, y, W_, 2);
  // Subtle red flicker corner
  if ((game.time & 6) < 3) {
    ctx.fillStyle = `rgba(200, 38, 28, 0.18)`;
    ctx.fillRect(0, 0, W_, 4);
  }
  // 'SIGNAL LOST' eyebrow — GREY VECTOR: cycle archived, not just death
  ctx.fillStyle = COLORS.red;
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  const _cyc = (typeof getCycleNum === 'function') ? getCycleNum() : 347;
  ctx.fillText(_r(`連結中斷 // CYCLE #${_cyc} ARCHIVED`,
                  `NEURAL LINK SEVERED // CYCLE #${_cyc} ARCHIVED`), 24, 18);
  // OPERATOR DOWN big
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(_r('V-07 倒下 — Mote 在等', 'V-07 DOWN — MOTE IS WAITING'), 24, 48);
  // Killer card on the right side of the strip
  const dist = Math.round(_deathRecap.distance);
  const weaponStr = _deathRecap.killerWeapon ? `${_deathRecap.killerWeapon} · ` : '';
  const killerLine = `${_r('被', 'BY')} ${_deathRecap.killerCallsign} · ${weaponStr}${dist}u`;
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.cream;
  ctx.fillText(killerLine, W_ - 24, 28);
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = COLORS.red;
  ctx.fillText(_r('代號 · ' + getOperatorName(), 'CALLSIGN · ' + getOperatorName()), W_ - 24, 46);

  // ---- Bottom hint bar — strong red CTA telling the player WHAT TO DO ----
  // Pulses so it draws the eye, can't be missed mid-firefight. Bigger text
  // (16px bold) per user feedback '下面這個文字組線內容要更強勢一點'.
  const pulse = 0.7 + 0.3 * Math.sin(game.time * 0.18);
  const hintH = 56;
  ctx.fillStyle = `rgba(200, 38, 28, ${0.85 * pulse})`;
  ctx.fillRect(0, H_ - hintH, W_, hintH);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    _r('▼ 按 1-4 接管隊友身體 · 操作員不會等死 ▼',
       '▼ PRESS 1-4 TO TAKE OVER A TEAMMATE · YOU DON\'T SIT OUT ▼'),
    W_ / 2, H_ - hintH / 2 + 6,
  );
  ctx.textAlign = 'left';
  ctx.restore();
}
