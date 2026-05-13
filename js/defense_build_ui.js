// ============ DEFENSE BUILD UI (radial + status pill) ============
// Status pill — bottom-center, current structure + cost + hint.
// Radial menu — screen-centered ring of wedges, click to pick a kind.
//
// Classic-script. Declares globally:
//   RADIAL_R_INNER · RADIAL_R_OUTER (constants)
//   _radialGeom() · _radialKindUnderCursor(sx, sy)
//   drawDefenseStatusPill() · drawDefenseShop() · drawBuildRadial()
//   renderBuildPreview() · drawBuildPreviewSpot() · etc.
//
// External deps: buildMode · game · player · STRUCTURE_DEFS · STRUCTURE_ORDER
//   canAffordStructure · _snapAndCheckPlace · ctx · W · H · T · _r · mouse

// Status pill — bottom-center, current structure + cost + hint.
// Radial menu — screen-centered ring of wedges, click to pick a kind.
const RADIAL_R_INNER = 70;
const RADIAL_R_OUTER = 200;
function _radialGeom() {
  return { cx: W() / 2, cy: H() / 2, rIn: RADIAL_R_INNER, rOut: RADIAL_R_OUTER };
}
function _radialKindUnderCursor(sx, sy) {
  const g = _radialGeom();
  const dx = sx - g.cx, dy = sy - g.cy;
  const d = Math.hypot(dx, dy);
  if (d < g.rIn || d > g.rOut + 30) return null;
  const N = STRUCTURE_ORDER.length;
  const step = (Math.PI * 2) / N;
  let theta = Math.atan2(dy, dx) + Math.PI / 2;
  if (theta < 0) theta += Math.PI * 2;
  const idx = Math.floor((theta + step / 2) / step) % N;
  return STRUCTURE_ORDER[idx];
}
function drawDefenseShop() {
  // No buildReady gate (was hiding radial in non-NN modes — arena always
  // allows build). Ensure _structures array exists.
  if (!game._structures) game._structures = [];
  game._buildShopDrawnThisFrame = true;
  drawDefenseStatusPill();
  if (buildMode.active && buildMode.radialOpen) drawBuildRadial();
}
function drawDefenseStatusPill() {
  const def = STRUCTURE_DEFS[buildMode.kind];
  if (!def) return;
  // Idle build pill removed from gameplay — it's a HINT pill that just
  // told the player "press B to build", and it crowded the bottom of the
  // play area every frame. User: '左下角的文字訊息會一直擋住重要的遊戲版面'.
  // Press-B opens the radial picker regardless; the pill only shows
  // while build mode is ACTIVELY engaged so the player sees energy +
  // place/exit hints during placement.
  if (!buildMode.active) return;
  const cur = Math.floor(game._energy || 0);
  const can = canAffordStructure(buildMode.kind);
  const W_ = W(), H_ = H();
  // Narrower pill now that the verbose hint text is gone (was 240).
  const pillW = 220, pillH = 32;
  const x = W_ / 2 - pillW / 2;
  const y = H_ - pillH - 16;
  ctx.save();
  ctx.fillStyle = 'rgba(200, 38, 28, 0.92)';
  ctx.fillRect(x, y, pillW, pillH);
  ctx.strokeStyle = COLORS.cream;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, pillW, pillH);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${def.label()}`, x + 10, y + 14);
  ctx.font = '9px monospace';
  ctx.fillStyle = can ? '#FFD24A' : COLORS.gray;
  ctx.fillText(`${def.cost}⚡ / ${cur}⚡`, x + 10, y + 26);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(buildMode.radialOpen
    ? T('选择模块', 'Pick a module')
    : T('左键放置 · Esc 退出', 'L-click place · Esc exit'),
    x + pillW - 10, y + 20);
  ctx.textAlign = 'left';
  ctx.restore();
}
function drawBuildRadial() {
  const g = _radialGeom();
  const N = STRUCTURE_ORDER.length;
  const step = (Math.PI * 2) / N;
  const hovered = _radialKindUnderCursor(mouse.x, mouse.y);
  ctx.save();
  ctx.fillStyle = 'rgba(20, 18, 24, 0.55)';
  ctx.fillRect(0, 0, W(), H());
  for (let i = 0; i < N; i++) {
    const kind = STRUCTURE_ORDER[i];
    const def = STRUCTURE_DEFS[kind];
    const can = canAffordStructure(kind);
    const wedgeStart = -Math.PI / 2 + (i - 0.5) * step;
    const wedgeEnd   = -Math.PI / 2 + (i + 0.5) * step;
    const isHover = hovered === kind;
    ctx.beginPath();
    ctx.moveTo(g.cx + Math.cos(wedgeStart) * g.rIn, g.cy + Math.sin(wedgeStart) * g.rIn);
    ctx.arc(g.cx, g.cy, g.rIn, wedgeStart, wedgeEnd, false);
    ctx.lineTo(g.cx + Math.cos(wedgeEnd) * g.rOut, g.cy + Math.sin(wedgeEnd) * g.rOut);
    ctx.arc(g.cx, g.cy, g.rOut, wedgeEnd, wedgeStart, true);
    ctx.closePath();
    ctx.fillStyle = isHover
      ? 'rgba(200, 38, 28, 0.85)'
      : (can ? 'rgba(40, 38, 44, 0.92)' : 'rgba(40, 38, 44, 0.55)');
    ctx.fill();
    ctx.strokeStyle = COLORS.cream;
    ctx.lineWidth = isHover ? 2 : 1;
    ctx.stroke();
    const mid = -Math.PI / 2 + i * step;
    const lr = (g.rIn + g.rOut) / 2;
    const lx = g.cx + Math.cos(mid) * lr;
    const ly = g.cy + Math.sin(mid) * lr;
    ctx.fillStyle = isHover ? COLORS.cream : (can ? COLORS.cream : COLORS.gray);
    ctx.font = isHover ? 'bold 13px sans-serif' : 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(def.label(), lx, ly - 4);
    ctx.font = '10px monospace';
    ctx.fillStyle = isHover ? COLORS.cream : (can ? '#FFD24A' : COLORS.gray);
    ctx.fillText(`${def.cost}⚡`, lx, ly + 12);
    ctx.textAlign = 'left';
  }
  ctx.fillStyle = 'rgba(20, 18, 24, 0.92)';
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.rIn - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.cream;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = '#FFD24A';
  ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.floor(game._energy || 0)}⚡`, g.cx, g.cy - 2);
  ctx.fillStyle = COLORS.cream;
  ctx.font = '9px sans-serif';
  ctx.fillText(T('能源', 'ENERGY'), g.cx, g.cy + 14);
  ctx.font = '8px sans-serif';
  ctx.fillStyle = COLORS.gray;
  ctx.fillText(T('B / Esc 关闭', 'B / Esc close'), g.cx, g.cy + 28);
  ctx.textAlign = 'left';
  ctx.restore();
}

