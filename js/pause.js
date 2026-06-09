// ============ PAUSE ============
// togglePause + auto-pause on tab-hidden + the pause overlay renderer
// (drawPauseOverlay with resume/mute/exit hit-rect bars).
//
// Classic-script. Declares globally:
//   togglePause() · drawPauseOverlay() · drawCrosshair (lives here too)
//
// External deps: game · mouse · ctx · W · H · COLORS · T · AUDIO ·
//   setAudioMuted · exitMatchToMenu · _hitRect

// Phase 34/35 — pause is meaningless in MP. The server keeps ticking and
// every other player keeps shooting whether you tab away or not. Wings.io
// works the same way. We short-circuit ALL pause entry points (manual
// toggle, visibility change, blur) when MP MODE is intended.
//
// Phase 35 fix: gate on the URL `?mp=1` flag, NOT on _mpState.enabled.
// Reason: _mpState.enabled is only true AFTER the server's welcome
// message arrives. If the WS handshake is mid-flight or the server is
// briefly unreachable, _mpIsActive() returns false and pause re-arms —
// which surprises the user ("我選了 MULTI 為什麼 Esc 還會暫停?"). The
// intent is fixed by the URL flag from the moment the page loads, so
// we use that as the gate. If MP server is genuinely down the user
// still cannot pause (the world is "paused" effectively because they
// have no peers anyway).
function _isMpMode() {
  try {
    return new URLSearchParams(location.search).get('mp') === '1';
  } catch (e) {
    return false;
  }
}
function togglePause() {
  if (game.state !== 'playing') return;
  if (_isMpMode()) return;
  game._paused = !game._paused;
  // R2 — drop any held trigger through Input so resume needs a fresh click
  if (game._paused) {
    if (typeof Input !== 'undefined' && Input.releaseTrigger) {
      Input.releaseTrigger();
    } else if (typeof mouse !== 'undefined') {
      mouse.down = false;
    }
  }
  // Phase 100 — show/hide the right-side pause ad banner.
  // Display-toggle keeps the iframe alive (GM doesn't have to re-fetch
  // a fresh ad every pause); we just visually hide/show it.
  try {
    const _padSlot = document.getElementById('pauseAdSlot');
    if (_padSlot) _padSlot.style.display = game._paused ? 'block' : 'none';
  } catch (e) {}
}
// Auto-pause when the tab loses focus or becomes hidden — single-player
// only. In MP you stay alive (and shootable) while the tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (_isMpMode()) return;
  if (document.hidden && game.state === 'playing' && !game._paused) togglePause();
});
window.addEventListener('blur', () => {
  if (_isMpMode()) return;
  if (game.state === 'playing' && !game._paused) togglePause();
});
function drawPauseOverlay() {
  // Dim backdrop
  ctx.fillStyle = 'rgba(20, 18, 24, 0.78)';
  ctx.fillRect(0, 0, W(), H());
  // Card
  const cw = 520, ch = 480;
  const cx = W() / 2, cy = H() / 2;
  const x = cx - cw / 2, y = cy - ch / 2;
  ctx.fillStyle = COLORS.cream;
  ctx.fillRect(x, y, cw, ch);
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = 4;
  ctx.strokeRect(x, y, cw, ch);
  // Red corner tab
  ctx.fillStyle = COLORS.black;
  ctx.fillRect(x + cw - 80, y - 4, 80, 8);
  // Title
  ctx.fillStyle = COLORS.red;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(T('单 元 0451 · 暂 停 / PAUSED', 'UNIT 0451 · PAUSED'), x + 24, y + 26);
  ctx.fillStyle = COLORS.black;
  ctx.font = 'bold 36px sans-serif';
  ctx.fillText(T('暂停', 'PAUSED'), x + 24, y + 70);
  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = COLORS.gray;
  ctx.fillText(T('快捷键 / KEY MAP', 'KEY MAP'), x + 24, y + 92);
  // Two-column shortcut list
  const cats = [
    [T('移动 MOVE', 'MOVE'), [
      ['WASD',  T('移动 / 飞行', 'Move / fly')],
      ['Shift', T('冲刺 SPRINT', 'Sprint')],
      [T('鼠标', 'Mouse'),  T('瞄准', 'Aim')],
      [T('左键', 'L-click'), T('射击', 'Fire')],
      ['V',     T('自动瞄准 AIM-ASSIST', 'Aim-assist')],
    ]],
    [T('装备 GEAR', 'GEAR'), [
      ['R',     T('装填弹药', 'Reload')],
      [T('踩武器', 'Step on'), T('踩敌人掉落的枪换武器', 'Pick up dropped weapon')],
      ['G',     T('投掷手雷', 'Throw grenade')],
      ['Q',     T('UAV 无人机', 'UAV recon')],
      ['E',     T('FPV 自杀无人机', 'FPV kamikaze')],
      ['B',     T('建造模式 BUILD', 'Build mode')],
      ['U',     T('升级附近模块', 'Upgrade nearby module')],
    ]],
    [T('指挥 COMMAND', 'COMMAND'), [
      ['Tab',   T('战术指挥视角', 'Command view')],
      ['1-7',   T('指挥下令 (集合/进攻/掩护…)', 'Squad orders (rally/attack/cover…)')],
      ['1-4',   T('接管队友 (非指挥时)', 'Pawn-swap (outside command view)')],
    ]],
    [T('系统 SYSTEM', 'SYSTEM'), [
      ['Esc/P', T('暂停 / 继续', 'Pause / resume')],
      ['Enter', T('结算后再来一场', 'Replay after match end')],
      [T('退出', 'Exit'), T('从下方按钮回主菜单', 'Use button below')],
    ]],
  ];
  let colX = x + 24, colY = y + 116;
  const COL_W = (cw - 48) / 2;
  for (let ci = 0; ci < cats.length; ci++) {
    const [title, items] = cats[ci];
    const isRight = ci % 2 === 1;
    const cxx = isRight ? x + 24 + COL_W : x + 24;
    let cyy = colY + Math.floor(ci / 2) * 168;
    ctx.fillStyle = COLORS.red;
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(title, cxx, cyy);
    ctx.font = '12px sans-serif';
    cyy += 14;
    for (const [k, label] of items) {
      ctx.fillStyle = COLORS.black;
      ctx.font = 'bold 12px monospace';
      ctx.fillText(k, cxx, cyy + 12);
      ctx.fillStyle = COLORS.gray;
      ctx.font = '11px sans-serif';
      ctx.fillText(label, cxx + 56, cyy + 12);
      cyy += 18;
    }
  }
  // Bottom action bar: [ Resume (red) ] [ GFX ] [ Mute ] [ Exit (cream w/ red border) ]
  const barY = y + ch - 38;
  const gap = 8;
  const totalW = cw - 48 - gap * 3;
  const resumeW = Math.floor(totalW * 0.46);
  const gfxW    = Math.floor(totalW * 0.18);
  const muteW   = Math.floor(totalW * 0.18);
  const exitW   = totalW - resumeW - gfxW - muteW;
  const resumeX = x + 24;
  const gfxX    = resumeX + resumeW + gap;
  const muteX   = gfxX + gfxW + gap;
  const exitX   = muteX + muteW + gap;

  ctx.fillStyle = COLORS.red;
  ctx.fillRect(resumeX, barY, resumeW, 28);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(T('按 Esc 继续 · RESUME', 'Esc · RESUME'), resumeX + resumeW / 2, barY + 18);

  // GFX quality toggle (Phase 153) — PERF (filled) caps DPR at 1.5 to claw back
  // frame-time on weak/HiDPI machines; HQ (hollow) keeps full-res crisp text.
  const _perfOn = (typeof _PERF_MODE !== 'undefined') && _PERF_MODE;
  ctx.fillStyle = _perfOn ? COLORS.black : COLORS.cream;
  ctx.fillRect(gfxX, barY, gfxW, 28);
  ctx.strokeStyle = COLORS.black;
  ctx.lineWidth = 2;
  ctx.strokeRect(gfxX, barY, gfxW, 28);
  ctx.fillStyle = _perfOn ? COLORS.cream : COLORS.black;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(_perfOn ? T('⚡ 流畅', '⚡ PERF') : T('✦ 高清', '✦ HQ'), gfxX + gfxW / 2, barY + 18);

  // Mute toggle — filled black w/ cream icon when muted, hollow when audible
  ctx.fillStyle = AUDIO.muted ? COLORS.black : COLORS.cream;
  ctx.fillRect(muteX, barY, muteW, 28);
  ctx.strokeStyle = COLORS.black;
  ctx.lineWidth = 2;
  ctx.strokeRect(muteX, barY, muteW, 28);
  ctx.fillStyle = AUDIO.muted ? COLORS.cream : COLORS.black;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(AUDIO.muted ? T('🔇 静音', '🔇 MUTE') : T('🔊 声音', '🔊 SOUND'), muteX + muteW / 2, barY + 18);

  ctx.fillStyle = COLORS.cream;
  ctx.fillRect(exitX, barY, exitW, 28);
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = 2;
  ctx.strokeRect(exitX, barY, exitW, 28);
  ctx.fillStyle = COLORS.red;
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText(T('退出 · EXIT', 'EXIT'), exitX + exitW / 2, barY + 18);
  ctx.textAlign = 'left';

  game._pauseResumeRect = { x: resumeX, y: barY, w: resumeW, h: 28 };
  game._pauseGfxRect    = { x: gfxX,    y: barY, w: gfxW,    h: 28 };
  game._pauseMuteRect   = { x: muteX,   y: barY, w: muteW,   h: 28 };
  game._pauseExitRect   = { x: exitX,   y: barY, w: exitW,   h: 28 };

  // Stylized cursor drawn on top of the pause overlay. The OS cursor is now
  // visible globally (body cursor: default), so this is purely cosmetic —
  // the red ring + crosshair sells the "system halted" pause aesthetic.
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.red;
  ctx.fillStyle = COLORS.cream;
  ctx.beginPath();
  ctx.arc(mouse.x, mouse.y, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(mouse.x, mouse.y, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(mouse.x - 14, mouse.y); ctx.lineTo(mouse.x - 6, mouse.y);
  ctx.moveTo(mouse.x + 6, mouse.y); ctx.lineTo(mouse.x + 14, mouse.y);
  ctx.moveTo(mouse.x, mouse.y - 14); ctx.lineTo(mouse.x, mouse.y - 6);
  ctx.moveTo(mouse.x, mouse.y + 6); ctx.lineTo(mouse.x, mouse.y + 14);
  ctx.stroke();
  ctx.restore();
}
