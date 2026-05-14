// ============ DEFENSE BUILD UI (radial-in-radial + status pill) ============
// Phase 70: two-tier radial. Inner ring = 5 category wedges. Outer ring =
// sub-items fan for whichever category the cursor is hovering OR the user
// committed (clicked). Reference image: hierarchical radial menu where
// expanded slice fans out into a partial outer ring.
//
// Status pill — bottom-center, current structure + cost + hint.
//
// Classic-script. Declares globally:
//   RADIAL_R_INNER · RADIAL_R_INNER_OUT · RADIAL_R_OUTER_IN · RADIAL_R_OUTER
//   BUILD_CATEGORIES
//   _radialGeom() · _radialPickAt(sx, sy) · _radialKindUnderCursor(sx, sy)
//   drawDefenseStatusPill() · drawDefenseShop() · drawBuildRadial()
//
// External deps: buildMode · game · player · STRUCTURE_DEFS
//   canAffordStructure · _snapAndCheckPlace · ctx · W · H · T · _r · mouse

// ─── Geometry ──────────────────────────────────────────────────────────
// Inner ring (categories) — closer to center, smaller.
// Outer ring (sub-items) — only renders for hovered/committed category.
// Visual gap between rings sells the "tier" hierarchy.
const RADIAL_R_INNER     = 65;
const RADIAL_R_INNER_OUT = 125;
const RADIAL_R_OUTER_IN  = 145;
const RADIAL_R_OUTER     = 215;

// ─── Categories ────────────────────────────────────────────────────────
// 5 categories at 72° each. Order matters — visually goes clockwise from
// 12 o'clock. `kinds` order = sub-item layout within the outer fan.
const BUILD_CATEGORIES = [
  { id: 'barrier', color: '#6B6B6B',
    label: () => T('屏障',  'BARRIER'),
    kinds: ['cover', 'wall', 'bunker'] },
  { id: 'offense', color: '#C8261C',
    label: () => T('武裝',  'OFFENSE'),
    kinds: ['turret', 'tesla', 'mine', 'tripmine'] },
  { id: 'power',   color: '#FFD24A',
    label: () => T('電力',  'POWER'),
    kinds: ['generator', 'terminal', 'dronebay'] },
  { id: 'support', color: '#42B7E8',
    label: () => T('支援',  'SUPPORT'),
    kinds: ['medstation', 'smoke', 'emp'] },
  { id: 'recon',   color: '#65BFA3',
    label: () => T('偵察',  'RECON'),
    kinds: ['camera', 'sensor', 'bot'] },
];

function _radialGeom() {
  return {
    cx: W() / 2, cy: H() / 2,
    rInIn:  RADIAL_R_INNER,
    rInOut: RADIAL_R_INNER_OUT,
    rOutIn: RADIAL_R_OUTER_IN,
    rOutOut:RADIAL_R_OUTER,
  };
}

// Pick at cursor — returns one of:
//   {type: 'cat',  id, idx}   — cursor in an inner category wedge
//   {type: 'kind', id, catId} — cursor in outer wedge of hovered/committed cat
//   null                       — cursor in dead zone (center hole, gap, outside)
function _radialPickAt(sx, sy) {
  const g = _radialGeom();
  const dx = sx - g.cx, dy = sy - g.cy;
  const d = Math.hypot(dx, dy);

  // Angle normalised so 0 = 12 o'clock, growing clockwise.
  let theta = Math.atan2(dy, dx) + Math.PI / 2;
  if (theta < 0) theta += Math.PI * 2;
  if (theta >= Math.PI * 2) theta -= Math.PI * 2;

  const NCAT = BUILD_CATEGORIES.length;
  const catStep = (Math.PI * 2) / NCAT;
  const catIdx = Math.floor((theta + catStep / 2) / catStep) % NCAT;
  const cat = BUILD_CATEGORIES[catIdx];

  // ─ Inner ring: pure category pick (always available while radial is open)
  if (d >= g.rInIn && d <= g.rInOut) {
    return { type: 'cat', id: cat.id, idx: catIdx };
  }

  // ─ Outer ring: only meaningful if there's a category to expand. The
  //   active category comes from EITHER the cursor hovering the inner
  //   wedge OR a previously committed click (buildMode.radialCat). We
  //   accept the second so the player can move from inner→outer without
  //   the wedge collapsing when their cursor crosses the visual gap.
  if (d >= g.rOutIn && d <= g.rOutOut) {
    const activeId = buildMode.radialCat;
    if (!activeId) return null;
    const exp = BUILD_CATEGORIES.find(c => c.id === activeId);
    if (!exp) return null;
    const expIdx = BUILD_CATEGORIES.indexOf(exp);
    const expCenter = expIdx * catStep;
    // Outer fan range slightly wider than the inner wedge so sub-items
    // have breathing room. Half range = catStep/2 + 14° padding.
    const halfRange = catStep / 2 + 0.25;
    // Angular offset from the expanded cat's center, in (-π, π].
    let rel = theta - expCenter;
    if (rel > Math.PI) rel -= Math.PI * 2;
    if (rel < -Math.PI) rel += Math.PI * 2;
    if (Math.abs(rel) > halfRange) return null;
    const subCount = exp.kinds.length;
    const subStep = (halfRange * 2) / subCount;
    const subIdx = Math.max(0, Math.min(subCount - 1,
      Math.floor((rel + halfRange) / subStep)));
    return { type: 'kind', id: exp.kinds[subIdx], catId: exp.id };
  }

  return null;
}

// Back-compat shim. Old call sites (index.html mousedown) used the simple
// kind-or-null contract; new flow uses _radialPickAt directly.
function _radialKindUnderCursor(sx, sy) {
  const pick = _radialPickAt(sx, sy);
  return (pick && pick.type === 'kind') ? pick.id : null;
}

function drawDefenseShop() {
  if (!game._structures) game._structures = [];
  game._buildShopDrawnThisFrame = true;
  drawDefenseStatusPill();
  if (buildMode.active && buildMode.radialOpen) drawBuildRadial();
}

function drawDefenseStatusPill() {
  const def = STRUCTURE_DEFS[buildMode.kind];
  if (!def) return;
  if (!buildMode.active) return;
  const cur = Math.floor(game._energy || 0);
  const can = canAffordStructure(buildMode.kind);
  const W_ = W(), H_ = H();
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
  const NCAT = BUILD_CATEGORIES.length;
  const catStep = (Math.PI * 2) / NCAT;
  const hovered = _radialPickAt(mouse.x, mouse.y);

  // Phase 70b — auto-pin radialCat on inner-ring hover. User bug:
  // '從A的游標滑到H2的中間,經過那個空格,游標立刻消失,選項立刻消失'.
  // The 20u gap between inner and outer rings was a dead zone — cursor
  // crossing it killed `hovered`, the fan resolved to `buildMode.radialCat`
  // (null because no click had happened), and the outer items vanished
  // mid-swipe. Fix: hovering an inner wedge AUTO-COMMITS radialCat. Once
  // committed it stays through the gap; only hovering a DIFFERENT inner
  // cat swaps it. Clicking inner is now a no-op (cat is already pinned).
  if (hovered && hovered.type === 'cat' && buildMode.radialCat !== hovered.id) {
    buildMode.radialCat = hovered.id;
  }
  const previewCatId = buildMode.radialCat;

  ctx.save();
  // Dim backdrop — gameplay underneath stays readable but recedes.
  ctx.fillStyle = 'rgba(20, 18, 24, 0.55)';
  ctx.fillRect(0, 0, W(), H());

  // ─── Inner ring: category wedges ──────────────────────────────────
  for (let i = 0; i < NCAT; i++) {
    const cat = BUILD_CATEGORIES[i];
    const ws = -Math.PI / 2 + (i - 0.5) * catStep;
    const we = -Math.PI / 2 + (i + 0.5) * catStep;
    const isHover     = (hovered && hovered.type === 'cat' && hovered.id === cat.id);
    const isCommitted = (buildMode.radialCat === cat.id);
    const isActive    = isHover || isCommitted;

    ctx.beginPath();
    ctx.moveTo(g.cx + Math.cos(ws) * g.rInIn, g.cy + Math.sin(ws) * g.rInIn);
    ctx.arc(g.cx, g.cy, g.rInIn, ws, we, false);
    ctx.lineTo(g.cx + Math.cos(we) * g.rInOut, g.cy + Math.sin(we) * g.rInOut);
    ctx.arc(g.cx, g.cy, g.rInOut, we, ws, true);
    ctx.closePath();
    ctx.fillStyle = isHover
      ? cat.color
      : (isCommitted ? 'rgba(60, 56, 64, 0.95)' : 'rgba(40, 38, 44, 0.88)');
    ctx.fill();
    ctx.strokeStyle = isActive ? COLORS.cream : 'rgba(232, 228, 216, 0.55)';
    ctx.lineWidth = isActive ? 2 : 1;
    ctx.stroke();

    // Label centered in the wedge.
    const mid = -Math.PI / 2 + i * catStep;
    const lr = (g.rInIn + g.rInOut) / 2;
    const lx = g.cx + Math.cos(mid) * lr;
    const ly = g.cy + Math.sin(mid) * lr;
    ctx.fillStyle = COLORS.cream;
    ctx.font = isActive ? 'bold 13px sans-serif' : 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(cat.label(), lx, ly + 1);
    // Mini count chip: '▾ 3', '▾ 4' etc — signals there's something inside.
    ctx.font = '8px monospace';
    ctx.fillStyle = 'rgba(232, 228, 216, 0.65)';
    ctx.fillText(`▾ ${cat.kinds.length}`, lx, ly + 13);
    ctx.textAlign = 'left';
  }

  // ─── Outer ring: sub-items fan for the previewed/committed category ─
  if (previewCatId) {
    const exp = BUILD_CATEGORIES.find(c => c.id === previewCatId);
    if (exp) {
      const expIdx = BUILD_CATEGORIES.indexOf(exp);
      const expCenter = -Math.PI / 2 + expIdx * catStep;
      const halfRange = catStep / 2 + 0.25;
      const subCount = exp.kinds.length;
      const subStep = (halfRange * 2) / subCount;

      for (let s = 0; s < subCount; s++) {
        const kind = exp.kinds[s];
        const def = STRUCTURE_DEFS[kind]; if (!def) continue;
        const can = canAffordStructure(kind);
        const ws = expCenter - halfRange + s * subStep;
        const we = expCenter - halfRange + (s + 1) * subStep;
        const isSubHover = (hovered && hovered.type === 'kind' && hovered.id === kind);

        ctx.beginPath();
        ctx.moveTo(g.cx + Math.cos(ws) * g.rOutIn, g.cy + Math.sin(ws) * g.rOutIn);
        ctx.arc(g.cx, g.cy, g.rOutIn, ws, we, false);
        ctx.lineTo(g.cx + Math.cos(we) * g.rOutOut, g.cy + Math.sin(we) * g.rOutOut);
        ctx.arc(g.cx, g.cy, g.rOutOut, we, ws, true);
        ctx.closePath();
        ctx.fillStyle = isSubHover
          ? exp.color
          : (can ? 'rgba(50, 46, 54, 0.92)' : 'rgba(50, 46, 54, 0.50)');
        ctx.fill();
        ctx.strokeStyle = isSubHover ? COLORS.cream : 'rgba(232, 228, 216, 0.55)';
        ctx.lineWidth = isSubHover ? 2 : 1;
        ctx.stroke();

        // Sub-item label + cost. Strip leading bilingual block from labels
        // ('LUMEN 抑制器' → 'LUMEN') to keep the wedge tight.
        const mid = (ws + we) / 2;
        const lr = (g.rOutIn + g.rOutOut) / 2;
        const lx = g.cx + Math.cos(mid) * lr;
        const ly = g.cy + Math.sin(mid) * lr;
        const lbl = def.label().split(' ')[0];
        ctx.fillStyle = isSubHover ? COLORS.cream : (can ? COLORS.cream : COLORS.gray);
        ctx.font = isSubHover ? 'bold 11px sans-serif' : 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(lbl, lx, ly - 3);
        ctx.font = '9px monospace';
        ctx.fillStyle = isSubHover ? COLORS.cream : (can ? '#FFD24A' : COLORS.gray);
        ctx.fillText(`${def.cost}⚡`, lx, ly + 10);
        ctx.textAlign = 'left';
      }
    }
  }

  // ─── Center disc: energy readout + hint ───────────────────────────
  ctx.fillStyle = 'rgba(20, 18, 24, 0.95)';
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.rInIn - 4, 0, Math.PI * 2);
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
