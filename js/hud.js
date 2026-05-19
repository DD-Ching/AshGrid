// ============ HUD (R8 refactor) ============
// All HUD rendering pulled out of the big inline script. Includes:
//   • Top-level renderHUD() driver — runs the 6-card layout via the
//     panel cache, pause button, narrow-fallback bar, mode chip, etc.
//   • drawMinimapPanel() — the bottom-right tactical map.
//   • renderHUDOverlays() — death recap dimming, low-HP vignette, hit-
//     flash, hurt-direction glow, kill streak, mode label flash.
//   • getModeLabel() · drawHUDPanel() — shared HUD primitives.
//   • Panel cache machinery (R6+): _hudCacheCanvas, _hudInitCache,
//     _hudComputeRegions, _hudDrawCachedPanels, _hudLastCachedMode.
//   • Six 6-zone card draw helpers (Phase 106 dark compact):
//     _hud_drawCard, _hud_drawMissionCard, _hud_drawSquadDots,
//     _hud_drawModeChip, _hud_drawScoreBlock, _hud_drawVitalsCard,
//     _hud_drawActionBar, _hud_drawMinimapLegend.
//
// HUD_AD_TOP / HUD_AD_BOTTOM stay in index.html (declared at ~line 2503)
// because resize() at script-init reads them — they need to exist before
// hud.js loads. The HUD code here references them at CALL time.
//
// External deps (resolved at call-time via classic-script globals):
//   ctx · COLORS · W / H · WORLD · player · enemies · allies · drone ·
//   fpv · game · camera · mouse · keys · bullets · enemyBullets ·
//   muzzleFlashes · damagePopups · explosions · soundEvents · wreckages ·
//   mission · currentMap · MISSIONS · MAPS · STRUCTURE_DEFS ·
//   ARENA_SEED_MAX · ARENA_SEED_GAP · CHASSIS · CHASSIS_FPV_COUNT ·
//   T · mapName · getOperatorName · touchInput · _mpIsActive · _mpState ·
//   _mpRenderHUD · _hud_canvasInsetFrame · drawDefenseShop · renderDeath-
//   Recap · _mpRenderNetDebug · drawObjectiveCompass · etc.
//   (_updateRespawnAdSlot / _updateFrameAdSlots moved to js/ad_slots.js
//   in R11 Step 3; renderHUD still calls them by name — they're globals
//   across the classic-script load. _updateSideAdSlots removed Phase 131b
//   alongside the deleted #sideAdLeft / #sideAdRight DOM.)

function renderHUD() {
  // Full HUD: HP / ammo / minimap / mission / energy all visible.
  const showMin = true, showMsn = true;
  // Hit flash — Phase 67: ease-out curve (t²) so the flash punches IN
  // then bleeds OFF gently, instead of a linear ramp that pops sharply.
  if (game.hitFlash > 0) {
    const _hfT = game.hitFlash / 12;
    const _hfA = _hfT * _hfT * 0.35;   // squared decay
    ctx.fillStyle = `rgba(200, 38, 28, ${_hfA})`;
    ctx.fillRect(0, 0, W(), H());
  }
  // Phase 67 — death fade overlay (slow black wash on KIA, eases back on
  // respawn). Drawn FIRST so subsequent HUD still reads on top.
  if (game._deathFade > 0.01) {
    ctx.fillStyle = `rgba(0, 0, 0, ${game._deathFade})`;
    ctx.fillRect(0, 0, W(), H());
  }
  // Phase 67 — scene fade (lobby transition). Full black opacity at 1.0.
  if (game._sceneFade > 0.01) {
    ctx.fillStyle = `rgba(0, 0, 0, ${game._sceneFade})`;
    ctx.fillRect(0, 0, W(), H());
  }
  // Phase 104 — standalone MP chip removed; MP peers + room name are
  // integrated into the new top-right Score Block (see _hud_drawScoreBlock).
  // Phase 20c: kill feed + scoreboard (no-op when MP inactive).
  if (typeof _mpRenderHUD === 'function') _mpRenderHUD();

  // Phase 104 / 105 — 6-zone HUD draw + offscreen panel cache.
  // _hudDrawCachedPanels() runs ALL six cream-card helpers (mission /
  // squad / mode / score / vitals / action) once every 6 ticks (10 Hz)
  // and blits cached pixels in between. On narrow viewports (< 560)
  // we fall back to a single compact mission card here + a slim HP/
  // ammo bar at the bottom (drawn later); no caching for the narrow
  // path because there's only ~1 panel of work.
  const _narrow = W() < 560;
  const _missionW = _narrow ? 180 : 232;
  if (_narrow) {
    _hud_drawMissionCard(14, 14, _missionW, 92);
    game._squadChipRects = null;
  } else {
    _hudDrawCachedPanels();
  }
  // Pause button — drawn every tick on top of the (possibly cached)
  // mission card so its 'II' button stays interactive. Same hit-rect
  // size and position as before.
  let _isMpModeForBtn = false;
  try { _isMpModeForBtn = new URLSearchParams(location.search).get('mp') === '1'; } catch (e) {}
  if (_isMpModeForBtn) {
    game._pauseBtnRect = null;
  } else {
    const _pbX = 14 + _missionW - 22, _pbY = 18, _pbW = 16, _pbH = 16;
    ctx.fillStyle = 'rgba(200, 38, 28, 0.85)';
    ctx.fillRect(_pbX, _pbY, _pbW, _pbH);
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('II', _pbX + _pbW / 2, _pbY + 13);
    ctx.textAlign = 'left';
    game._pauseBtnRect = { x: _pbX, y: _pbY, w: _pbW, h: _pbH };
  }

  // Respawn countdown overlay — when player is dead in NN mode and waiting
  // for the 5-second respawn timer to elapse. Big "重生中 N" text + ring.
  if (game._nnMode && !player.alive && player._respawnAt != null) {
    const ticksLeft = Math.max(0, player._respawnAt - game.time);
    const sLeft = Math.ceil(ticksLeft / 60);
    const fracLeft = ticksLeft / (5 * 60);
    const cx = W() / 2, cy = H() / 2;
    // Dim backdrop
    ctx.fillStyle = 'rgba(20, 18, 24, 0.55)';
    ctx.fillRect(0, 0, W(), H());
    // Tag
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.red;
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(T('—  阵亡  ·  重生中  —', '—  KIA  ·  RESPAWNING  —'), cx, cy - 110);
    // Killer info
    if (player._killer) {
      ctx.fillStyle = COLORS.cream;
      ctx.font = 'bold 12px sans-serif';
      const killerName = player._killer.callsign || T('敌方', 'ENEMY');
      const wpn = player._killerWeapon ? ` (${player._killerWeapon})` : '';
      ctx.globalAlpha = 0.85;
      ctx.fillText(`${T('击杀者 / KILLED BY', 'KILLED BY')}  ${killerName}${wpn}`, cx, cy - 88);
      ctx.globalAlpha = 1;
    }
    // Big countdown number
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 140px sans-serif';
    ctx.fillText(`${sLeft}`, cx, cy + 30);
    // Ring around it (drains as time passes)
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, cy - 10, 100, -Math.PI/2, -Math.PI/2 + Math.PI*2 * fracLeft);
    ctx.stroke();
    // Hint
    ctx.fillStyle = COLORS.cream;
    ctx.font = '11px sans-serif';
    ctx.globalAlpha = 0.7;
    ctx.fillText(T('在出生点重新部署 / RESPAWN AT BLUE BASE', 'RESPAWN AT BLUE BASE'), cx, cy + 80);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }
  // Phase 82 — static respawn ad slot. Shown during the respawn countdown
  // wait (both 5s buffed and 15s default). User '無論如何, 活的五秒鐘
  // 一定會有靜態的廣告. 十五秒鐘也是靜態的廣告'. The 30s VIDEO ad (Phase
  // 60 ad-revive) is still gated on the Watch Ad button click; this slot
  // is the PASSIVE static display that always runs during the wait.
  if (typeof _updateRespawnAdSlot === 'function') _updateRespawnAdSlot();
  // Phase 107 — top/bottom outer ad-frame strips
  if (typeof _updateFrameAdSlots === 'function') _updateFrameAdSlots();

  // Mission objective panel + off-screen compass. Suppress when the HTML
  // end-card is up — the canvas-drawn MATCH RESULT block would otherwise
  // overlap the HTML overlay (the user reported '兩個視窗會重疊').
  // Cached _nnEndCardEl skips the 60-Hz getElementById call.
  if (!_nnEndCardEl) _nnEndCardEl = document.getElementById('nnEndCard');
  const _endCard = _nnEndCardEl;
  const _endCardVisible = _endCard && _endCard.style.display === 'flex';
  // FTUE: hide mission objective panel + compass while tutorial is
  // active. Reveal driven by the per-step `reveal.mission` flag — no
  // step in the current list sets it, so the panel + compass stay
  // dark for all 12 steps and come back when ftue.active flips false.
  if (mission && mission.renderHUD && !_endCardVisible && showMsn) mission.renderHUD();
  if (mission && (game.mode === 'tactical' || game.mode === 'command') && showMsn) drawObjectiveCompass();

  // Phase 104 — BOTTOM-LEFT Vitals Card + BOTTOM-CENTER Action Bar.
  // Vitals stacks ARMOR (heavy only) / HP / SEED INTEGRITY + AIM ASSIST
  // chip; Action Bar is the 6-cell R F Q E B G strip (resolves the old
  // 'G grenade vs G recruit' ambiguity by adopting F as primary frag key).
  const _hudNarrow = W() < 560;
  if (_hudNarrow) {
    // Compact fallback for narrow viewports — single slim panel with
    // HP / Ammo only. Keeps phones playable while desktops get the full
    // 6-zone layout. Uses the old draw shapes inline since the helpers
    // assume ≥ 290 px width.
    const _bW = Math.max(280, W() - 40);
    const _bX = 20, _bH = 54, _bY = H() - _bH - 12;
    drawHUDPanel(_bX, _bY, _bW, _bH, null);
    const _hpw = 120;
    ctx.fillStyle = COLORS.creamDark;
    ctx.fillRect(_bX + 12, _bY + 22, _hpw, 18);
    ctx.fillStyle = player.hp > 30 ? '#C8261C' : '#7A2A22';
    ctx.fillRect(_bX + 12, _bY + 22, _hpw * Math.max(0, player.hp) / player.maxHp, 18);
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`HP ${Math.max(0, Math.floor(player.hp))}/${player.maxHp}`, _bX + 18, _bY + 36);
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`${player.ammo}/${player.reserve}`, _bX + 12 + _hpw + 20, _bY + 36);
  }
  // Phase 105 — desktop branch: vitals card + action bar are now drawn
  // inside _hudDrawCachedPanels() (called near the top of renderHUD) so
  // they get the 10 Hz panel cache treatment. Nothing to do here.

  // FTUE: minimap reveal is driven by reveal.minimap on the current step
  // (set true on the 'place' step). Before that we still need to call
  // drawDefenseShop (radial + build pill) AND renderHUDOverlays
  // (crosshair / kill-streak chip / death recap), so we early-return
  // through them without drawing the minimap panel.
  if (!showMin) {
    if (game._nnMode && !game._buildShopDrawnThisFrame) {
      drawDefenseShop();
    }
    game._buildShopDrawnThisFrame = false;
    renderHUDOverlays();
    renderDeathRecap();
    // Phase 1 net-audit — opt-in overlay (?netdebug=1). After death recap
    // so it stays visible during respawn countdowns.
    if (typeof _mpRenderNetDebug === 'function') _mpRenderNetDebug();
    return;
  }
  // Mini-map (bottom-right) — collapsible. Click the small toggle in the
  // top-right corner of its panel to fold it down to a 70×26 "MAP ▲" tab.
  // Phase 75 — three-tier minimap size so a 375px portrait phone gets a
  // 100×100 minimap (was 130×130 = 35% of viewport width = too dominant).
  // Wide stays at 180×180.
  const _narrowMM = W() < 500;
  const _tinyMM = W() < 400;
  const mw = _tinyMM ? 100 : (_narrowMM ? 130 : 180);
  const mh = mw;
  // Phase 107 — bottom inset for outer ad strip
  const mx = W() - mw - 16, my = H() - mh - 16;
  if (game._minimapCollapsed) {
    const tw = 70, th = 26;
    const tx = W() - tw - 16, ty = H() - th - 16;
    ctx.fillStyle = 'rgba(232, 228, 216, 0.92)';
    ctx.fillRect(tx, ty, tw, th);
    ctx.strokeStyle = COLORS.black;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tx, ty, tw, th);
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('MAP ▲', tx + tw/2, ty + 17);
    ctx.textAlign = 'left';
    game._minimapToggleRect = { x: tx, y: ty, w: tw, h: th };
  } else {
    drawMinimapPanel(mx, my, mw, mh);
    // Phase 104 — small legend strip under the minimap (YOU / ENEMY /
    // ALLY / OBJ) so first-time players parse the marker colours.
    if (W() >= 560) _hud_drawMinimapLegend(mx, my, mw, mh);
  }
  // Build status pill + radial picker — render in every NN mode (defense
  // factory's renderHUD also calls drawDefenseShop, guard against double-
  // call by checking if we already rendered it this frame).
  if (game._nnMode && !game._buildShopDrawnThisFrame) {
    drawDefenseShop();
  }
  game._buildShopDrawnThisFrame = false;
  renderHUDOverlays();
  // Death recap sits on top of the HUD so it dims everything behind it.
  renderDeathRecap();
  // Phase 1 net-audit — opt-in overlay (?netdebug=1). Drawn LAST, after
  // even the death recap's top strip, so it stays visible while dead.
  if (typeof _mpRenderNetDebug === 'function') _mpRenderNetDebug();
}

// Full minimap panel — extracted so renderHUD can early-skip when collapsed
// without bailing out of the whole HUD pass.
function drawMinimapPanel(mx, my, mw, mh) {
  const mapLabel = currentMap ? `${mapName(currentMap)} · MAP` : 'MAP';
  drawHUDPanel(mx, my, mw, mh, mapLabel);
  // Collapse toggle in the panel's top-right corner (small ▼)
  const tgX = mx + mw - 22, tgY = my + 4, tgW = 18, tgH = 18;
  ctx.fillStyle = 'rgba(200, 38, 28, 0.85)';
  ctx.fillRect(tgX, tgY, tgW, tgH);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('▼', tgX + tgW/2, tgY + 13);
  ctx.textAlign = 'left';
  game._minimapToggleRect = { x: tgX, y: tgY, w: tgW, h: tgH };

  const mapPad = 12;
  const mapX = mx + mapPad, mapY = my + 30;
  const mapW = mw - mapPad*2, mapH = mh - 40;
  ctx.fillStyle = COLORS.cream;
  ctx.fillRect(mapX, mapY, mapW, mapH);
  ctx.strokeStyle = COLORS.black;
  ctx.lineWidth = 1;
  ctx.strokeRect(mapX, mapY, mapW, mapH);

  // In NN mode, scope the minimap to the NN_ARENA box (the red border) instead
  // of the full 3200x3200 world — units only live in the arena, so the rest is
  // empty white space that wastes screen.
  const useArena = game._nnMode;
  const srcOx = useArena ? NN_ARENA.x0 : 0;
  const srcOy = useArena ? NN_ARENA.y0 : 0;
  const srcW  = useArena ? NN_ARENA.w  : WORLD.w;
  const srcH  = useArena ? NN_ARENA.h  : WORLD.h;
  const sx = mapW / srcW, sy = mapH / srcH;
  // World→minimap conversion. Origin is shifted by srcOx/srcOy so units in
  // NN_ARENA at (0..1200) map across the full minimap, not just the upper-left.
  const wx = wx0 => mapX + (wx0 - srcOx) * sx;
  const wy = wy0 => mapY + (wy0 - srcOy) * sy;

  // Routes (color by type)
  for (const r of routes) {
    let col = COLORS.creamDark, alpha = 0.7;
    if (r.type === 'main') col = COLORS.red;
    else if (r.type === 'side') { col = COLORS.gray; alpha = 0.5; }
    else if (r.type === 'vertical') col = COLORS.red;
    else if (r.type === 'vehicle') col = COLORS.black;
    else if (r.type === 'drone') { col = COLORS.red; alpha = 0.4; }
    ctx.fillStyle = col;
    ctx.globalAlpha = alpha;
    ctx.fillRect(wx(r.x), wy(r.y), Math.max(1, r.w*sx), Math.max(1, r.h*sy));
  }
  ctx.globalAlpha = 1;

  // Buildings
  ctx.fillStyle = COLORS.lightGray;
  for (const b of buildings) {
    ctx.fillRect(wx(b.x), wy(b.y), Math.max(1, b.w*sx), Math.max(1, b.h*sy));
  }
  // Low covers (mid gray)
  ctx.fillStyle = COLORS.creamDark;
  for (const lc of lowCovers) {
    ctx.fillRect(wx(lc.x), wy(lc.y), Math.max(1, lc.w*sx), Math.max(1, lc.h*sy));
  }
  // Overheads (dark)
  ctx.fillStyle = COLORS.black;
  for (const o of overheads) {
    ctx.fillRect(wx(o.x), wy(o.y), Math.max(1, o.w*sx), Math.max(1, o.h*sy));
  }
  // Landmark — big star/circle
  for (const lm of landmarks) {
    ctx.fillStyle = COLORS.red;
    if (lm.r) {
      ctx.beginPath();
      ctx.arc(wx(lm.x), wy(lm.y), Math.max(4, lm.r*sx*0.9), 0, Math.PI*2);
      ctx.fill();
      ctx.strokeStyle = COLORS.black;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (lm.w) {
      const w = Math.max(8, lm.w*sx*0.5), h = Math.max(8, lm.h*sx*0.5);
      ctx.fillRect(wx(lm.x) - w/2, wy(lm.y) - h/2, w, h);
    }
  }
  // Mission objectives — drawn BEFORE allies/player so they sit visually
  // 'under' the moving units. Yellow ring = active objective. Without this
  // the minimap had no indication of where the relay / hive / UGV / capture
  // zones live, so players got disoriented (user report: '中繼站遊戲中心
  // 卻是在地圖外'). The objective lives at world center but is invisible
  // on the minimap unless we draw it explicitly.
  if (typeof collectMissionWaypoints === 'function') {
    const waypoints = collectMissionWaypoints();
    for (const wp of waypoints) {
      const dx = wx(wp.x), dy = wy(wp.y);
      // Pulse so it's visually distinct from buildings/landmarks
      const pulse = 0.6 + 0.4 * Math.sin(game.time * 0.08);
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.fillStyle = wp.color || COLORS.red;
      ctx.beginPath();
      ctx.arc(dx, dy, 5, 0, Math.PI*2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = COLORS.black;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(dx, dy, 5, 0, Math.PI*2);
      ctx.stroke();
      // Outer glow ring (always visible, no pulse)
      ctx.strokeStyle = wp.color || COLORS.red;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(dx, dy, 9, 0, Math.PI*2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }
  // Allies (cream squares)
  for (const a of allies) {
    if (!a.alive) continue;
    ctx.fillStyle = COLORS.creamDark;
    ctx.fillRect(wx(a.x) - 3, wy(a.y) - 3, 6, 6);
    ctx.strokeStyle = COLORS.black;
    ctx.lineWidth = 0.5;
    ctx.strokeRect(wx(a.x) - 3, wy(a.y) - 3, 6, 6);
  }
  // Player
  ctx.fillStyle = COLORS.black;
  ctx.fillRect(wx(player.x) - 3, wy(player.y) - 3, 6, 6);
  // Player view direction
  ctx.strokeStyle = COLORS.black;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(wx(player.x), wy(player.y));
  ctx.lineTo(wx(player.x) + Math.cos(player.angle)*10, wy(player.y) + Math.sin(player.angle)*10);
  ctx.stroke();
  // Enemies — only show those CURRENTLY visible to the friendly team (full
  // alpha) OR seen recently (faded memory). Minimap must NOT leak enemy
  // positions ahead of the friendly team's actual line of sight, even in
  // NN mode where the arena is small.
  ctx.fillStyle = COLORS.red;
  for (const e of enemies) {
    if (!e.alive) continue;
    if (e._lastSeen == null || game.time - e._lastSeen > 180) continue;
    ctx.globalAlpha = e._lastSeen === game.time ? 1 : 0.4;
    ctx.fillRect(wx(e.x) - 2, wy(e.y) - 2, 4, 4);
  }
  ctx.globalAlpha = 1;
  for (const d of enemyDrones) {
    if (!d.alive) continue;
    if (d._lastSeen == null || game.time - d._lastSeen > 180) continue;
    ctx.globalAlpha = d._lastSeen === game.time ? 1 : 0.4;
    ctx.beginPath();
    ctx.arc(wx(d.x), wy(d.y), 2, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Drone
  if (drone.deployed) {
    ctx.fillStyle = COLORS.black;
    ctx.beginPath();
    ctx.arc(wx(drone.x), wy(drone.y), 3, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = COLORS.black;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(wx(drone.x), wy(drone.y), drone.visionRadius*sx, 0, Math.PI*2);
    ctx.stroke();
  }
  // FPV
  if (fpv.active) {
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(wx(fpv.x) - 2, wy(fpv.y) - 2, 4, 4);
  }
}

// Continuation of renderHUD: mode overlays, crosshair, message banner, dead
// overlay. Pulled out so the minimap-collapse path can short-circuit cleanly
// without bailing on these.
function renderHUDOverlays() {
  // Low-HP vignette — pulsing red edges that close in as HP drops, paired
  // with the heartbeat audio. Only renders once HP drops below 45%.
  if (player.alive && player.maxHp > 0) {
    const hpFrac = player.hp / player.maxHp;
    if (hpFrac < 0.45) {
      const intensity = Math.max(0, Math.min(1, (0.45 - hpFrac) / 0.30));
      // Pulse roughly with heartbeat tempo so visual + audio stay in sync.
      // Period eases from 1s @ 45% HP → 0.45s @ <15% HP.
      const periodMs = 1000 - intensity * 550;
      const phase = (Date.now() % periodMs) / periodMs;
      const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
      const w = W(), h = H();
      ctx.save();
      const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2,
                                            w / 2, h / 2, Math.max(w, h) * 0.7);
      grad.addColorStop(0, 'rgba(200, 38, 28, 0)');
      grad.addColorStop(0.6, `rgba(200, 38, 28, ${0.10 * intensity * (0.6 + pulse * 0.4)})`);
      grad.addColorStop(1, `rgba(120, 10, 10, ${0.55 * intensity * (0.5 + pulse * 0.5)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  // Kill-streak chip — flashes for 1.5s after each chain kill (≥2). Shows
  // multiplier (x2 / x3 / ...) + "KILL STREAK" label, fades out at the end.
  if (player._killStreak >= 2 && (player._killStreakFlashUntil || 0) > game.time) {
    const remaining = (player._killStreakFlashUntil || 0) - game.time;
    const t = Math.min(1, remaining / 90);
    const fade = t < 0.2 ? (t / 0.2) : 1;
    ctx.save();
    ctx.globalAlpha = fade;
    const cw = 220, ch = 50;
    const cx = W() / 2, cy = 130;
    const x = cx - cw / 2, y = cy - ch / 2;
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(x, y, cw, ch);
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`× ${player._killStreak}`, cx - 50, y + 35);
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(T('连杀 / KILL STREAK', 'KILL STREAK'), cx + 22, y + 22);
    ctx.font = 'bold 10px monospace';
    ctx.fillText(`+${player._killStreak * 25} BONUS`, cx + 22, y + 38);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  // Directional hurt indicator — red glow on the edge facing the damage
  // source. Phase 67: exponential decay (×0.94/frame) so the indicator
  // lingers longer at lower intensities — feels like the damage echoes
  // away instead of a linear cut-off. Alpha curve also eased (t²) so the
  // glow ramps in soft, not slamming on at full strength.
  if (player._hurtIntensity > 0.01) {
    const intensity = player._hurtIntensity;
    const eased    = intensity * intensity;     // ease-out alpha
    const ang = player._hurtAngle || 0;
    const cx = W()/2, cy = H()/2;
    const edge = 80;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const ox = cx + dx * Math.max(W(), H());
    const oy = cy + dy * Math.max(W(), H());
    const grad = ctx.createRadialGradient(ox, oy, edge, ox, oy, Math.max(W(), H()));
    grad.addColorStop(0, `rgba(200, 38, 28, ${eased * 0.55})`);
    grad.addColorStop(1, 'rgba(200, 38, 28, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W(), H());
    player._hurtIntensity = intensity * 0.94;
  } else {
    player._hurtIntensity = 0;
  }

  // Pawn-swap toast — small top-center chip, fades the last 30% of its life.
  // Replaces the giant center-screen "接管 BRAVO" banner that used to block
  // view while rapid-switching.
  if (game._swapToast && game._swapToast.ttl > 0) {
    const tot = 75;
    const t = game._swapToast.ttl / tot;
    const alpha = t < 0.3 ? (t / 0.3) : 1;     // fade out at end
    ctx.save();
    ctx.globalAlpha = alpha;
    // On narrow viewports the status panel only goes to y=96 (height 80) so
    // place the toast below at y=104. Wide screens keep the original y=88.
    const _ntoast = W() < 500;
    const tw = 220, th = 26;
    const tx = W() / 2 - tw / 2, ty = _ntoast ? 104 : 88;
    ctx.fillStyle = 'rgba(20, 18, 24, 0.85)';
    ctx.fillRect(tx, ty, tw, th);
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tx, ty, tw, th);
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(game._swapToast.text, W() / 2, ty + 17);
    ctx.textAlign = 'left';
    ctx.restore();
    game._swapToast.ttl--;
  }

  // Mode-specific overlays
  if (game.mode === 'fpv') renderFPVOverlay();
  if (game.mode === 'drone') renderDroneOverlay();
  if (game._cmdOpen || game.mode === 'command') renderCommandOverlay();

  // Crosshair — shown in every mode including FPV. When aim-assist is locked
  // the reticle DOES NOT follow the mouse — it sticks to the predicted lead
  // position so the player sees exactly where the bullet is going (mouse is
  // just an input cue at that point, not a misleading aim indicator).
  let cxX = mouse.x, cxY = mouse.y, locked = false;
  if (player._aimAssistLockedAt) {
    const wp = player._aimAssistLockedAt;
    const dx = wp.x - camera.x, dy = wp.y - camera.y;
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation);
    cxX = (dx * c - dy * s) * camera.scale + W() / 2;
    cxY = (dx * s + dy * c) * camera.scale + H() / 2;
    locked = true;
  }
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = locked ? 2 : 1.5;
  ctx.beginPath();
  ctx.moveTo(cxX - 14, cxY); ctx.lineTo(cxX - 5, cxY);
  ctx.moveTo(cxX + 5, cxY); ctx.lineTo(cxX + 14, cxY);
  ctx.moveTo(cxX, cxY - 14); ctx.lineTo(cxX, cxY - 5);
  ctx.moveTo(cxX, cxY + 5); ctx.lineTo(cxX, cxY + 14);
  ctx.stroke();
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(cxX - 1, cxY - 1, 2, 2);
  if (locked) {
    // Lock corner brackets so the player can tell the reticle is "stuck"
    ctx.lineWidth = 2;
    ctx.beginPath();
    const r = 18;
    ctx.moveTo(cxX - r, cxY - r + 6); ctx.lineTo(cxX - r, cxY - r); ctx.lineTo(cxX - r + 6, cxY - r);
    ctx.moveTo(cxX + r, cxY - r + 6); ctx.lineTo(cxX + r, cxY - r); ctx.lineTo(cxX + r - 6, cxY - r);
    ctx.moveTo(cxX - r, cxY + r - 6); ctx.lineTo(cxX - r, cxY + r); ctx.lineTo(cxX - r + 6, cxY + r);
    ctx.moveTo(cxX + r, cxY + r - 6); ctx.lineTo(cxX + r, cxY + r); ctx.lineTo(cxX + r - 6, cxY + r);
    ctx.stroke();
    // Acquisition pulse: ring snaps in from outside on first lock frame
    const pulse = player._aimAssistLockPulse || 0;
    if (pulse > 0) {
      const t = pulse / 14;        // 1 → 0
      ctx.save();
      ctx.globalAlpha = t;
      ctx.lineWidth = 2 + t * 2;
      ctx.beginPath();
      ctx.arc(cxX, cxY, 24 + (1 - t) * 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    // "LOCK" tag + tiny screen-space cursor dot (so player still sees mouse)
    ctx.fillStyle = COLORS.red;
    ctx.font = 'bold 9px monospace';
    ctx.fillText('LOCK', cxX + 22, cxY - 14);
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ---- Build-phase ghost preview (between waves in survival) ----
  if (game._buildPhase && game._buildPhase.active && game._buildPhase.left > 0 && player.alive) {
    // Project mouse to world, project back to screen for ghost rect
    const wp = screenToWorld(mouse.x, mouse.y);
    const SIZE = 60;
    const cx = Math.max(NN_ARENA.x0, Math.min(NN_ARENA.x0 + NN_ARENA.w - SIZE, wp.x - SIZE / 2));
    const cy = Math.max(NN_ARENA.y0, Math.min(NN_ARENA.y0 + NN_ARENA.h - SIZE, wp.y - SIZE / 2));
    // Inverse of screenToWorld for the rect corners
    const dx0 = cx - camera.x, dy0 = cy - camera.y;
    const dx1 = (cx + SIZE) - camera.x, dy1 = (cy + SIZE) - camera.y;
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation);
    const proj = (rx, ry) => ({
      x: (rx * c - ry * s) * camera.scale + W() / 2,
      y: (rx * s + ry * c) * camera.scale + H() / 2,
    });
    const p00 = proj(dx0, dy0), p11 = proj(dx1, dy1);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(p00.x, p00.y, p11.x - p00.x, p11.y - p00.y);
    ctx.fillStyle = 'rgba(232, 228, 216, 0.25)';
    ctx.fillRect(p00.x, p00.y, p11.x - p00.x, p11.y - p00.y);
    ctx.setLineDash([]);
    ctx.restore();
    // HUD banner top-center + "watch ad for +2 covers" button below
    ctx.save();
    const bw = 240, bh = 28;
    const bx = W() / 2 - bw / 2, by = 60;
    ctx.fillStyle = 'rgba(200, 38, 28, 0.9)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${T('建造阶段', 'BUILD PHASE')} · ${T('剩', '')}${game._buildPhase.left}${T(' 块', ' left')}`, W() / 2, by + 18);
    ctx.textAlign = 'left';
    ctx.restore();
    // Ad-to-extend button below the banner (only if not already extended)
    if (!game._buildPhase._adExtended) {
      ctx.save();
      const abY = by + bh + 4, abH = 22;
      ctx.fillStyle = 'rgba(20, 18, 24, 0.85)';
      ctx.fillRect(bx, abY, bw, abH);
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, abY, bw, abH);
      ctx.fillStyle = COLORS.cream;
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(T('看广告 +2 块 · +5s 时间 ▶', 'WATCH AD · +2 BLOCKS · +5s ▶'), W() / 2, abY + 15);
      ctx.textAlign = 'left';
      ctx.restore();
      game._buildPhaseAdRect = { x: bx, y: abY, w: bw, h: abH };
    } else {
      game._buildPhaseAdRect = null;
    }
    // Skip-wave button — only shown when mission says it's currently allowed.
    // Stacks below the +2-cover ad button. One use per round, decoupled from
    // the cover-extend ad so the player can use both in the same build phase.
    if (mission && typeof mission.canSkipWave === 'function' && mission.canSkipWave()) {
      ctx.save();
      const adH2 = 22;
      const adY2 = by + bh + 4 + (game._buildPhase._adExtended ? 0 : (22 + 4));
      ctx.fillStyle = 'rgba(20, 18, 24, 0.85)';
      ctx.fillRect(bx, adY2, bw, adH2);
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, adY2, bw, adH2);
      ctx.fillStyle = COLORS.cream;
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(T('看广告 跳过下一波 · +补给 ▶', 'WATCH AD · SKIP NEXT WAVE ▶'), W() / 2, adY2 + 15);
      ctx.textAlign = 'left';
      ctx.restore();
      game._skipWaveAdRect = { x: bx, y: adY2, w: bw, h: adH2 };
    } else {
      game._skipWaveAdRect = null;
    }
  } else {
    game._buildPhaseAdRect = null;
    game._skipWaveAdRect = null;
  }

  // ---- Touch overlay: virtual sticks + action buttons ----
  if (touchInput.enabled && game.state === 'playing' && !game._paused) {
    const _nb = W() < 500;
    // Suggested resting positions for the thumbs — drawn faintly when no
    // touch is active so the player knows where they can put their fingers.
    const moveAnchor = { x: _nb ? 90 : 130, y: H() - (_nb ? 160 : 200) };
    const aimAnchor  = { x: W() - (_nb ? 90 : 130), y: H() - (_nb ? 160 : 200) };
    const drawGhost = (a) => {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = COLORS.cream;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(a.x, a.y, TOUCH_STICK_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    };
    if (!touchInput.moveTouch) drawGhost(moveAnchor);
    if (!touchInput.aimTouch)  drawGhost(aimAnchor);
    const drawStick = (s) => {
      if (!s) return;
      const len = Math.hypot(s.dx, s.dy);
      const k = Math.min(1, len / TOUCH_STICK_RADIUS);
      const tx = s.anchorX + (len > 0 ? (s.dx / len) * TOUCH_STICK_RADIUS * k : 0);
      const ty = s.anchorY + (len > 0 ? (s.dy / len) * TOUCH_STICK_RADIUS * k : 0);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = COLORS.cream;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.anchorX, s.anchorY, TOUCH_STICK_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = COLORS.red;
      ctx.beginPath();
      ctx.arc(tx, ty, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    drawStick(touchInput.moveTouch);
    drawStick(touchInput.aimTouch);

    // Action buttons — split between BOTTOM-LEFT (G grenade, big, easy left-
    // thumb tap during a fight) and MID-RIGHT (Q/E/V/R column near the right
    // thumb's aim-stick rest). Replaces the old top-right 5-button column
    // that forced the right thumb to leave its aim grip.
    const BTN_SIZE = _nb ? 44 : 52;
    const BTN_GAP  = _nb ? 6  : 8;
    // G grenade — standalone left-side button, slightly larger
    const gSize = _nb ? 60 : 68;
    const gx = 24, gy = H() - gSize - 90;
    ctx.save();
    ctx.fillStyle = 'rgba(20, 18, 24, 0.7)';
    ctx.fillRect(gx, gy, gSize, gSize);
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 2;
    ctx.strokeRect(gx, gy, gSize, gSize);
    ctx.fillStyle = COLORS.cream;
    ctx.font = `bold ${_nb ? 18 : 22}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('G', gx + gSize/2, gy + (_nb ? 28 : 32));
    ctx.font = `bold ${_nb ? 9 : 10}px sans-serif`;
    ctx.fillText(T('手雷', 'GRENADE'), gx + gSize/2, gy + (_nb ? 46 : 52));
    ctx.textAlign = 'left';
    ctx.restore();
    game._touchActionButtons = [{ id: 'g', x: gx, y: gy, w: gSize, h: gSize }];
    // Right-side column: Q / E / V / R / X + B (defense only). Phase 76
    // adds X (swap weapon) since mobile players don't have a keyboard
    // shortcut — they were stuck on their lobby weapon for the whole
    // match.
    const buttons = [
      { id: 'q', label: 'Q',   sub: 'UAV' },
      { id: 'e', label: 'E',   sub: 'FPV' },
      { id: 'v', label: 'V',   sub: '助', active: !!player._aimAssist },
      { id: 'r', label: 'R',   sub: '弹' },
      { id: 'x', label: 'X',   sub: T('换', 'SWAP') },
    ];
    if (game._nnMode) {
      buttons.push({ id: 'b', label: 'B', sub: T('建', 'BUILD'), active: buildMode.active });
    }
    const colH = buttons.length * BTN_SIZE + (buttons.length - 1) * BTN_GAP;
    let bx = W() - BTN_SIZE - 12;
    let by = Math.round(H() / 2 - colH / 2);
    const _labelF = _nb ? 'bold 14px sans-serif' : 'bold 18px sans-serif';
    const _subF   = _nb ? 'bold 7px sans-serif'  : 'bold 9px sans-serif';
    const _labelY = _nb ? 22 : 26;
    const _subY   = _nb ? 35 : 44;
    for (const b of buttons) {
      ctx.save();
      ctx.fillStyle = b.active ? COLORS.red : 'rgba(20, 18, 24, 0.65)';
      ctx.fillRect(bx, by, BTN_SIZE, BTN_SIZE);
      ctx.strokeStyle = b.active ? COLORS.red : COLORS.cream;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, BTN_SIZE, BTN_SIZE);
      ctx.fillStyle = COLORS.cream;
      ctx.font = _labelF;
      ctx.textAlign = 'center';
      ctx.fillText(b.label, bx + BTN_SIZE / 2, by + _labelY);
      ctx.font = _subF;
      ctx.fillText(b.sub, bx + BTN_SIZE / 2, by + _subY);
      ctx.textAlign = 'left';
      ctx.restore();
      game._touchActionButtons.push({ id: b.id, x: bx, y: by, w: BTN_SIZE, h: BTN_SIZE });
      by += BTN_SIZE + BTN_GAP;
    }
  } else {
    game._touchActionButtons = null;
  }

  // Center message — banner. If a mission is active and the message is fresh,
  // also include the mission objective so the player has a brief in their face.
  if (game.message) {
    ctx.save();
    let alpha = Math.min(1, game.messageTime / 30);
    if (buildMode && buildMode.radialOpen) alpha *= 0.18;   // don't cover the build radial
    ctx.globalAlpha = alpha;
    const showObj = mission && mission.objective && game.messageTime > 60;
    const msgW = Math.max(520, game.message.length * 18);
    const msgH = showObj ? 86 : 56;
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(W()/2 - msgW/2, H()/2 - msgH/2, msgW, msgH);
    ctx.fillStyle = COLORS.black;
    ctx.fillRect(W()/2 - msgW/2 + 6, H()/2 - msgH/2 + 6, msgW, msgH);
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(game.message, W()/2 + 6, H()/2 - msgH/2 + 36);
    if (showObj) {
      ctx.fillStyle = COLORS.cream;
      ctx.font = '13px monospace';
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillText(`${T('目标', 'Goal')}: ${mission.objective}`, W()/2 + 6, H()/2 - msgH/2 + 64);
    }
    ctx.textAlign = 'left';
    ctx.restore();
  }

  // Player dead overlay (campaign / non-NN modes only — NN mode draws its own
  // respawn-countdown overlay above; this one would obscure it)
  if (!player.alive && game.state === 'playing' && !game._nnMode) {
    ctx.fillStyle = 'rgba(200, 38, 28, 0.45)';
    ctx.fillRect(0, 0, W(), H());
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(T('单元失联', 'UNIT LOST'), W()/2, H()/2);
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('UNIT 0451 — SIGNAL LOST', W()/2, H()/2 + 28);
    ctx.textAlign = 'left';
  }

}

function getModeLabel() {
  switch(game.mode) {
    case 'tactical': return T('俯视战术 TOP-DOWN', 'TOP-DOWN TACTICAL');
    case 'drone': return T('无人机 UAV-RECON', 'UAV RECON');
    case 'fpv': return T('FPV 自杀无人机 KAMIKAZE', 'FPV KAMIKAZE');
    case 'command': return T('指挥俯瞰 COMMAND', 'COMMAND VIEW');
  }
  return '';
}

function drawHUDPanel(x, y, w, h, label) {
  ctx.fillStyle = 'rgba(232, 228, 216, 0.94)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = COLORS.black;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(x, y, 4, h);
  if (label) {
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(label, x + 12, y + 18);
    ctx.fillRect(x + 12, y + 22, 28, 1);
  }
}

// ============ HUD: PANEL CACHE (Phase 105) ============
// The six Phase-104 panels are heavy (~150 fillText/fillRect ops/frame).
// Their data ticks slowly — HP/score/ammo all change at < 5 Hz of player
// input. Cache the panels to an offscreen canvas every 6 ticks (10 Hz)
// and blit on the in-between ticks. User: '這邊不用很高的刷新頻率對不對,
// 我們可以省, 把高的 FPS 放在重點的部分就好'.
//
// What STAYS at full 60 Hz:
//   game world / projectiles / units / animations / minimap markers /
//   hit-flash / death recap / mp kill feed / mp scoreboard /
//   pause-button hit rect / squad-chip click hit rects (rebuilt at 10 Hz
//   though — chips don't move, only callsign/HP change).
// What runs at 10 Hz (cached):
//   mission status card, squad strip, mode chip, score block, vitals
//   card, action bar.
//
// Strategy: on refresh tick render helpers onto MAIN canvas as normal,
// then drawImage the 6 region rects FROM main canvas INTO an offscreen
// cache. On non-refresh ticks, drawImage the cached regions back onto
// main canvas (skipping all helper draws). Game world under the opaque
// cream fills is hidden anyway, so the 10 Hz lag inside those rects is
// invisible; outside them everything stays at 60 Hz.

let _hudCacheCanvas = null;
let _hudCacheCtx = null;
let _hudPanelLastTick = -9999;
const _HUD_PANEL_INTERVAL = 6;   // ticks (10 Hz at TICK_HZ=60)
let _hudCacheRegions = [];

function _hudComputeRegions() {
  // Phase 106 sizes + Phase 107 outer ad-frame Y offsets.

  _hudCacheRegions = [
    { x: 12,          y: 12,         w: 236,                       h: 114 },  // mission card
    { x: 12,          y: 132,        w: 32,                        h: 162 },  // squad dots column
    { x: W()/2 - 102, y: 10,         w: 204,                       h: 28  },  // mode chip
    { x: W() - 248,   y: 12,         w: 236,                       h: 114 },  // score block
    { x: 12,          y: H() - 164,  w: 304,                       h: 152 },  // vitals card
    { x: 326,         y: H() - 100,  w: Math.max(420, W() - 600),  h: 86  },  // action bar
  ];
}

function _hudInitCache() {
  if (!_hudCacheCanvas) {
    _hudCacheCanvas = document.createElement('canvas');
    _hudCacheCtx = _hudCacheCanvas.getContext('2d');
  }
  if (_hudCacheCanvas.width !== W() || _hudCacheCanvas.height !== H()) {
    _hudCacheCanvas.width = W();
    _hudCacheCanvas.height = H();
    _hudPanelLastTick = -9999;   // force fresh snapshot at new viewport size
    _hudComputeRegions();
  }
}

// Drives all six cached panels. Called from renderHUD on viewports
// wide enough for the full layout (≥ 560 px). Returns true on refresh
// ticks so callers know the helpers ran fresh (squad-chip click rects
// were rebuilt this frame).
function _hudDrawCachedPanels() {
  _hudInitCache();
  const tick = (typeof game !== 'undefined') ? game.time : 0;
  if (tick < _hudPanelLastTick) _hudPanelLastTick = -9999;
  // Phase 107 — TAB / Q / E swap into a different camera mode (tactical,
  // drone, fpv, command) should refresh the mode chip in the same render
  // frame instead of waiting up to 6 ticks for the next cache tick.
  if (typeof game !== 'undefined' && game.mode !== _hudLastCachedMode) {
    _hudLastCachedMode = game.mode;
    _hudPanelLastTick = -9999;
  }
  const refresh = (tick - _hudPanelLastTick) >= _HUD_PANEL_INTERVAL;
  if (refresh) {
    _hudPanelLastTick = tick;
    // Phase 106 sizes + Phase 107 outer ad-frame Y offsets.
  
    _hud_drawMissionCard(14, 14, 232, 110);
    _hud_drawSquadDots(14, 134);                   // 5 × 26 + 4 × 6 = 154 tall
    _hud_drawModeChip();
    _hud_drawScoreBlock(W() - 14 - 232, 14, 232, 110);
    const _hasArmor = player._chassis === 'heavy' && player.maxArmor > 0;
    const _vRows = 1 + (_hasArmor ? 1 : 0) + (game._nnMode ? 1 : 0);
    const _vCardH = 26 + _vRows * 21 + 20;             // header + bars + chip
    _hud_drawVitalsCard(14, H() - _vCardH - 12, 300, _vCardH);
    const _aX = 14 + 300 + 12;
    const _aW = Math.max(420, W() - _aX - 270);
    _hud_drawActionBar(_aX, H() - 86 - 12, _aW, 86);
    // Snapshot the 6 regions from main canvas → offscreen cache.
    _hudCacheCtx.clearRect(0, 0, _hudCacheCanvas.width, _hudCacheCanvas.height);
    for (const r of _hudCacheRegions) {
      if (r.w <= 0 || r.h <= 0) continue;
      _hudCacheCtx.drawImage(canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    }
  } else {
    // Non-refresh tick — blit cached HUD region pixels back onto main.
    for (const r of _hudCacheRegions) {
      if (r.w <= 0 || r.h <= 0) continue;
      ctx.drawImage(_hudCacheCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    }
  }
  return refresh;
}

// Phase 108 / 124 — HUD_AD_TOP is the OUTER FRAME THICKNESS at the top
// (HUD_AD_BOTTOM = 0 since Phase 124 collapsed bottom into top). The
// canvas itself is resized (in resize() above) so its top sits at
// y = HUD_AD_TOP px, leaving the strip completely empty above it.
// The #frameAdTop DOM div sits in that empty zone; if no ad is loaded,
// the body's dark #0A0A0E shows through. HUD draws no longer offset by
// these — y = 0 inside the canvas is already below the top strip.

// Tracks game.mode across cached frames so a TAB-press (tactical ↔
// command etc.) invalidates the cache instantly instead of waiting up
// to 6 ticks for the next refresh — user: '按下Tab的時候的那個模式也
// 要切換, 不要讓全部卡在一起'.
let _hudLastCachedMode = null;

// ============ HUD: PHASE 106 DARK COMPACT ============
// Phase 104 introduced the 6-zone HUD with cream cards; Phase 106 swaps
// them to a dark / charcoal palette (matching the V-07 sample card in
// the user's mockup), tightens dimensions ~25%, and replaces the wide
// Squad Status strip with five tiny HP-fill circles on the far left.
// User: '能不能像图片这样用暗色系... 不要到处都很亮... 队友载具的槽位
// 不用了那么大... 五颗球, 五个圈圈在最左侧'.
//
// Style: dark card body + red left stripe + slim red border, red /
// cream headers, segmented bars unchanged. G/G ambiguity still resolved
// the Phase-104 way (F = FRAG, G = RECRUIT).

function _hud_drawCard(x, y, w, h) {
  // Dark charcoal card with red left stripe + slim red border.
  ctx.fillStyle = 'rgba(20, 22, 28, 0.94)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(200, 38, 28, 0.85)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(x, y, 3, h);
}

function _hud_drawMissionCard(x, y, w, h) {
  _hud_drawCard(x, y, w, h);
  // Header: MSN · <map name>
  ctx.fillStyle = COLORS.red;
  ctx.font = 'bold 9px sans-serif';
  ctx.fillText('MSN', x + 12, y + 18);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 11px sans-serif';
  const _mapNm = (typeof mapName === 'function') ? mapName(currentMap) : 'ARENA';
  ctx.fillText(`· ${(_mapNm || 'ARENA').toUpperCase()}`, x + 36, y + 18);
  // Stage
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText(`STAGE ${game.wave || 1}/${MISSIONS.length}`, x + 12, y + 36);
  // Objective
  const obj = game._nnMode ? 'RECRUIT' : 'ELIMINATE';
  ctx.fillStyle = COLORS.cream;
  ctx.font = '10px sans-serif';
  ctx.fillText(`OBJECTIVE: ${obj}`, x + 12, y + 52);
  // Enemies + Squad
  const _remaining = enemies.filter(e=>e.alive).length
                   + (typeof enemyDrones !== 'undefined' ? enemyDrones.filter(d=>d.alive).length : 0);
  const _sqAlive = allies.filter(a=>a.alive).length;
  ctx.fillStyle = COLORS.red;
  ctx.font = 'bold 10px sans-serif';
  ctx.fillText(`ENEMIES ${_remaining}`, x + 12, y + 72);
  ctx.fillStyle = '#aaa';
  ctx.fillText(`SQUAD ${_sqAlive}/${allies.length}`, x + 12 + 90, y + 72);
  // Phase 107 — SEED gameplay temporarily removed from the HUD; the
  // mission card no longer shows a 'SEED GATE: READY [G]' line. The
  // POWER bar (formerly SEED) lives in the vitals card and the
  // recruit-ready chip is the green G cell in the action bar.
}

function _hud_drawSquadDots(x, y) {
  // 5 small HP-fill circles, vertical column. Each: dark backing disc +
  // red bottom-up fill = ally HP%, red ring outline when alive (grey
  // when dead/empty), slot number centered. Self (slot 1) is non-
  // clickable; slots 2-5 push click rects for pawn-swap input.
  game._squadChipRects = [];
  const d = 26, gap = 6;
  const _touchPad = (typeof touchInput !== 'undefined' && touchInput.enabled) ? 6 : 0;
  const rows = [{
    label: '1', alive: player.alive,
    hp: Math.max(0, Math.floor(player.hp)), maxHp: player.maxHp, isSelf: true,
  }];
  for (let i = 0; i < 4; i++) {
    const a = allies[i];
    rows.push(a ? {
      label: `${i+2}`, alive: a.alive,
      hp: a.alive ? Math.max(0, Math.floor(a.hp)) : 0,
      maxHp: a.maxHp || 100, allyIdx: i,
    } : { label: `${i+2}`, alive: false, hp: 0, maxHp: 100, empty: true });
  }
  for (let r = 0; r < 5; r++) {
    const row = rows[r];
    const cx = x + d/2;
    const cy = y + r * (d + gap) + d/2;
    const hpFrac = row.alive && row.maxHp > 0 ? row.hp / row.maxHp : 0;
    // Dark backing disc
    ctx.fillStyle = 'rgba(20, 22, 28, 0.92)';
    ctx.beginPath();
    ctx.arc(cx, cy, d/2, 0, Math.PI*2);
    ctx.fill();
    // HP fill — clipped to inner disc, fills bottom-up
    if (row.alive && hpFrac > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, d/2 - 2, 0, Math.PI*2);
      ctx.clip();
      const fillH = (d - 4) * hpFrac;
      ctx.fillStyle = hpFrac > 0.3 ? '#C8261C' : '#7A2A22';
      ctx.fillRect(cx - d/2, cy + d/2 - fillH - 2, d, fillH);
      ctx.restore();
    }
    // Ring outline
    ctx.strokeStyle = row.alive ? COLORS.red : '#555';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, d/2, 0, Math.PI*2);
    ctx.stroke();
    // Number
    ctx.fillStyle = row.alive ? COLORS.cream : '#777';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(row.label, cx, cy + 4);
    ctx.textAlign = 'left';
    // Click rect (not self, not empty)
    if (!row.empty && !row.isSelf) {
      game._squadChipRects.push({
        x: cx - d/2 - _touchPad, y: cy - d/2 - _touchPad,
        w: d + _touchPad*2, h: d + _touchPad*2,
        allyIdx: row.allyIdx, alive: row.alive,
      });
    }
  }
}

function _hud_drawModeChip() {
  if (W() < 560) return;
  const lbl = getModeLabel() || 'TACTICAL';
  const cw = 200, ch = 22;
  const cx = W()/2 - cw/2, cy = 12;
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(cx, cy, cw, 1.5);
  ctx.fillStyle = 'rgba(20, 22, 28, 0.92)';
  ctx.fillRect(cx, cy + 2, cw, ch);
  ctx.strokeStyle = 'rgba(200, 38, 28, 0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(cx + 0.5, cy + 2.5, cw - 1, ch - 1);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(lbl.toUpperCase(), W()/2, cy + 17);
  ctx.textAlign = 'left';
}

function _hud_drawScoreBlock(x, y, w, h) {
  _hud_drawCard(x, y, w, h);
  ctx.fillStyle = COLORS.red;
  ctx.font = 'bold 9px sans-serif';
  ctx.fillText('SCORE', x + 12, y + 18);
  const sShown = (game._scoreDisplay != null)
    ? Math.floor(game._scoreDisplay)
    : (game.score || 0);
  ctx.fillStyle = COLORS.red;
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(`${sShown}`, x + 12, y + 50);
  const kills = game.killCount || 0;
  const deaths = game.deaths || 0;
  const mins = Math.floor((game.time || 0) / 3600);
  const secs = Math.floor(((game.time || 0) / 60) % 60);
  const tStr = `${mins}:${secs < 10 ? '0' + secs : secs}`;
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 9px monospace';
  ctx.fillText(`K ${kills}   D ${deaths}   T ${tStr}`, x + 12, y + 72);
  ctx.fillStyle = '#777';
  ctx.font = '9px monospace';
  let mpStr;
  if (typeof _mpIsActive === 'function' && _mpIsActive()) {
    const visible = _mpState ? _mpState.remotePlayers.size + 1 : 1;
    const peers = (_mpState && _mpState.room && _mpState.room.getPeers)
      ? Object.keys(_mpState.room.getPeers()).length + 1
      : visible;
    const roomLbl = (_mpState && _mpState.roomName) ? _mpState.roomName.slice(0, 12) : 'room';
    mpStr = `MP · ${peers} · ${roomLbl.toUpperCase()}`;
  } else {
    mpStr = 'SOLO · NN ARENA';
  }
  ctx.fillText(mpStr, x + 12, y + h - 10);
}

function _hud_drawVitalsCard(x, y, w, h) {
  _hud_drawCard(x, y, w, h);
  // Header
  ctx.fillStyle = COLORS.red;
  ctx.font = 'bold 10px sans-serif';
  const chassisLbl = (player._chassis || 'humanoid').toUpperCase();
  ctx.fillText(`V-07 · ${chassisLbl}`, x + 12, y + 18);
  const barX = x + 12, barW = w - 24, barH = 11;
  let by = y + 34;
  // ARMOR (heavy only)
  if (player._chassis === 'heavy' && player.maxArmor > 0) {
    ctx.fillStyle = '#aaa';
    ctx.font = 'bold 8px monospace';
    ctx.fillText('ARMOR', barX, by - 1);
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.floor(player.armor)}/${player.maxArmor}`, barX + barW, by - 1);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(barX, by, barW, barH);
    ctx.fillStyle = '#42B7E8';
    ctx.fillRect(barX, by, barW * Math.max(0, player.armor) / player.maxArmor, barH);
    by += barH + 10;
  }
  // HP (with damage trail)
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 8px monospace';
  ctx.fillText('HP', barX, by - 1);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.max(0, Math.floor(player.hp))}/${player.maxHp}`, barX + barW, by - 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(barX, by, barW, barH);
  const _hpTrail = (player._hpTrail != null) ? player._hpTrail : player.hp;
  if (_hpTrail > player.hp + 0.5) {
    ctx.fillStyle = '#F2402E';
    ctx.fillRect(barX, by, barW * Math.max(0, _hpTrail) / player.maxHp, barH);
  }
  ctx.fillStyle = player.hp > player.maxHp * 0.3 ? '#C8261C' : '#7A1A14';
  ctx.fillRect(barX, by, barW * Math.max(0, player.hp) / player.maxHp, barH);
  by += barH + 10;
  // POWER bar (Phase 107 — formerly SEED INTEGRITY. The SEED-as-recruit-
  // gate gameplay is temporarily shelved, so the bar is now branded
  // 'POWER' and the recruit-gate notch is removed. The underlying
  // player._seed value still ticks since the action bar 'G RECRUIT'
  // cell uses it for ready/lock, but it's not shown as a hard threshold
  // on this bar anymore.)
  if (game._nnMode) {
    const sv = Math.floor(player._seed || 0);
    const sFrac = Math.max(0, Math.min(1, sv / ARENA_SEED_MAX));
    ctx.fillStyle = '#aaa';
    ctx.font = 'bold 8px monospace';
    ctx.fillText('POWER', barX, by - 1);
    ctx.textAlign = 'right';
    ctx.fillText(`${sv}/${ARENA_SEED_MAX}`, barX + barW, by - 1);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(barX, by, barW, barH);
    ctx.fillStyle = '#E67A2C';
    ctx.fillRect(barX, by, barW * sFrac, barH);
    by += barH + 10;
  }
  // AIM ASSIST chip
  const chipY = y + h - 12;
  ctx.fillStyle = '#888';
  ctx.font = 'bold 8px sans-serif';
  ctx.fillText('AIM ASSIST', barX, chipY);
  ctx.fillStyle = player._aimAssist ? '#3CD46A' : '#444';
  ctx.beginPath();
  ctx.arc(barX + 68, chipY - 3, 3.5, 0, Math.PI*2);
  ctx.fill();
  ctx.fillStyle = player._aimAssist ? '#3CD46A' : '#777';
  ctx.font = 'bold 8px sans-serif';
  ctx.fillText(player._aimAssist ? 'ON' : 'OFF', barX + 78, chipY);
  ctx.fillStyle = '#666';
  ctx.font = '8px monospace';
  ctx.fillText('(V)', barX + 104, chipY);
}

function _hud_drawActionBar(x, y, w, h) {
  // 6 dark cells: R / F / Q / E / B / G
  const cellW = Math.floor(w / 6);
  const _gOver = game._nnMode && (player._seed || 0) > ARENA_SEED_GAP;
  const cells = [
    { hk: 'R', name: 'RELOAD',  big: `${player.ammo}`,         sub: `/${player.reserve}` },
    { hk: 'F', name: 'FRAG',    big: `${player.grenades}`,     sub: `/${player.maxGrenades}` },
    { hk: 'Q', name: 'UAV',     big: `${drone.battery.toFixed(0)}`, sub: '%' },
    { hk: 'E', name: 'FPV',     big: `${fpv.available}`,       sub: `/${fpv.max}` },
    { hk: 'B', name: 'BUILD',   big: 'READY', sub: null },
    { hk: 'G', name: 'RECRUIT', big: _gOver ? 'READY' : 'LOCK', sub: null },
  ];
  // Dark panel
  ctx.fillStyle = 'rgba(20, 22, 28, 0.94)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(200, 38, 28, 0.85)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(x, y, 3, h);
  for (let i = 0; i < 6; i++) {
    const cx = x + i * cellW;
    if (i > 0) {
      ctx.fillStyle = 'rgba(200, 38, 28, 0.25)';
      ctx.fillRect(cx, y + 6, 1, h - 12);
    }
    const c = cells[i];
    // Hotkey badge (red)
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(cx + 10, y + 8, 16, 16);
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(c.hk, cx + 18, y + 20);
    ctx.textAlign = 'left';
    // Name
    ctx.fillStyle = '#aaa';
    ctx.font = 'bold 9px sans-serif';
    ctx.fillText(c.name, cx + 30, y + 20);
    // Big value
    if (c.big === 'READY' || c.big === 'LOCK' || c.big === 'LOCKED') {
      ctx.fillStyle = (c.big === 'READY') ? '#3CD46A' : '#666';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(c.big, cx + 12, y + 44);
    } else {
      ctx.fillStyle = COLORS.cream;
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText(c.big, cx + 12, y + 48);
      if (c.sub) {
        ctx.fillStyle = '#888';
        ctx.font = 'bold 9px monospace';
        const _bw = ctx.measureText(c.big).width;
        ctx.fillText(c.sub, cx + 16 + _bw, y + 48);
      }
    }
    // Per-cell extras
    if (i === 0) {
      if (player.reloading) {
        const _rt = (player.reloadTime || 0) / 80;
        const _rtEase = 1 - _rt * _rt;
        ctx.fillStyle = COLORS.red;
        ctx.fillRect(cx + 12, y + h - 10, (cellW - 24) * _rtEase, 2);
      } else {
        ctx.fillStyle = '#666';
        ctx.font = '8px monospace';
        ctx.fillText('MAG', cx + 12, y + h - 6);
      }
    }
    if (i === 1) {
      for (let g = 0; g < (player.maxGrenades || 0); g++) {
        ctx.fillStyle = g < player.grenades ? COLORS.red : '#444';
        ctx.beginPath();
        ctx.arc(cx + 16 + g * 9, y + h - 8, 2.5, 0, Math.PI*2);
        ctx.fill();
      }
    }
    if (i === 2) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(cx + 12, y + h - 10, cellW - 24, 3);
      ctx.fillStyle = drone.battery > 30 ? '#C8261C' : '#7A2A22';
      ctx.fillRect(cx + 12, y + h - 10, (cellW - 24) * (drone.battery / drone.maxBattery), 3);
    }
    if (i === 3) {
      for (let f = 0; f < fpv.max; f++) {
        ctx.fillStyle = f < fpv.available ? '#C8261C' : '#444';
        ctx.fillRect(cx + 12 + f * 10, y + h - 10, 7, 6);
      }
    }
  }
}

function _hud_drawMinimapLegend(mx, my, mw, mh) {
  const ly = my + mh + 2;
  if (ly + 14 > H()) return;
  ctx.font = 'bold 8px monospace';
  ctx.fillStyle = '#C8261C';
  ctx.beginPath(); ctx.arc(mx + 12, ly + 7, 2.5, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#aaa';
  ctx.fillText('YOU', mx + 20, ly + 10);
  ctx.fillStyle = '#777';
  ctx.beginPath(); ctx.arc(mx + 52, ly + 7, 2, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = '#aaa';
  ctx.fillText('ENEMY', mx + 58, ly + 10);
  ctx.strokeStyle = '#aaa';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(mx + 96, ly + 7, 2.5, 0, Math.PI*2); ctx.stroke();
  ctx.fillStyle = '#aaa';
  ctx.fillText('ALLY', mx + 103, ly + 10);
  ctx.strokeRect(mx + 130, ly + 4, 6, 6);
  ctx.fillText('OBJ', mx + 140, ly + 10);
}
