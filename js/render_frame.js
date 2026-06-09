// ============ FRAME OWNER + FX LAYER REGISTRY (Phase 155) ============
// Anti-regression structure. The per-frame draw used to live as render() in
// index.html, and every "juice" phase (147/148/152) hand-edited a typeof-guarded
// FX line straight into it — with nobody reviewing per-frame allocation cost or
// world-vs-screen ordering. That's how a stack of full-screen gradient fills
// crept into the hot path (the movement-jank investigation).
//
// Now there is ONE owner: renderFrame(). Cosmetic FX no longer touch it — each
// FX module calls registerFxLayer({...}) and renderFrame() dispatches the layers
// at the right slot. A layer that allocates every frame must declare
// allocsPerFrame:true, so the cost is visible at the registration site instead
// of hidden inside render().
//
// Classic-script. Loads BEFORE the FX modules (they register at load time) and
// before the inline loop() that calls renderFrame(). Declares globally:
//   FX_LAYERS · registerFxLayer(layer) · runFxLayers(space) · renderFrame()
// External deps (call-time): ctx · game · camera · player · buildMode · W · H ·
//   COLORS · renderWorld · renderEditorOverlay · renderFootprints ·
//   renderSpawnBeacons · renderStructures · renderSmokeClouds · renderTeslaBolts ·
//   renderEMPPulses · renderAutoDrones · renderWeaponDrops · renderAirstrikes ·
//   renderBuildPreview · renderHUD

// space: 'world'            → drawn inside the camera transform (world coords)
//        'overlay-under-hud'→ screen-space, before renderHUD (HUD sits on top)
//        'overlay-over-hud' → screen-space, after renderHUD (on top of HUD)
const FX_LAYERS = [];

function registerFxLayer(layer) {
  if (!layer || typeof layer.draw !== 'function') return;
  FX_LAYERS.push({
    id:    layer.id || ('fx' + FX_LAYERS.length),
    space: layer.space || 'overlay-over-hud',
    when:  (typeof layer.when === 'function') ? layer.when : () => true,
    draw:  layer.draw,
    allocsPerFrame: !!layer.allocsPerFrame,
  });
}

// Run every registered layer for one slot, in registration order (so the draw
// order matches the old hand-wired sequence). A layer's own draw() may still
// early-return for its gating (e.g. the danger vignette only paints under 35% HP).
function runFxLayers(space) {
  for (let i = 0; i < FX_LAYERS.length; i++) {
    const L = FX_LAYERS[i];
    if (L.space !== space) continue;
    try { if (L.when()) L.draw(); } catch (e) { /* one bad FX layer must not kill the frame */ }
  }
}

// The single per-frame draw owner (was render() in index.html). Order preserved
// exactly: clear → shake → world transform → world draws → restore → under-HUD
// FX → HUD → over-HUD FX.
function renderFrame() {
  // Canvas-clear MUST be dark per FTUE/01 §A.4.1 ('幾乎不會有白色得底色').
  // COLORS.sky is TOD-tinted so the off-arena strip reads as sky-at-this-hour.
  ctx.fillStyle = (typeof COLORS.sky !== 'undefined') ? COLORS.sky : COLORS.floor;
  ctx.fillRect(0, 0, W(), H());

  // Camera shake — small screen-space jitter; the world transform stays clean.
  let shakeX = 0, shakeY = 0;
  if (game.shakeMag > 0.05) {
    shakeX = (Math.random() - 0.5) * 2 * game.shakeMag;
    shakeY = (Math.random() - 0.5) * 2 * game.shakeMag;
  }

  ctx.save();
  ctx.translate(W() / 2 + shakeX, H() / 2 + shakeY);
  ctx.scale(camera.scale, camera.scale);
  ctx.rotate(camera.rotation);
  ctx.translate(-camera.x, -camera.y);

  renderWorld();
  if (game.state === 'editor') renderEditorOverlay();
  // Player-built structures + airstrike telegraphs in defense mode
  renderFootprints();
  renderSpawnBeacons();
  renderStructures();
  renderSmokeClouds();
  renderTeslaBolts();
  renderEMPPulses();
  renderAutoDrones();
  // Phase 140 — dropped weapons + their pickup ring (world-space).
  if (typeof renderWeaponDrops === 'function') renderWeaponDrops();
  renderAirstrikes();
  // Build-mode placement preview — only while placing (not while the radial
  // picker is on top of the world).
  if (buildMode.active && !buildMode.radialOpen
      && game.state === 'playing' && !game._paused) renderBuildPreview();
  // World-space FX layers (e.g. future world juice) draw inside the transform.
  runFxLayers('world');
  ctx.restore();

  // Screen-space FX UNDER the HUD (low-HP danger vignette) — opaque HUD panels
  // sit on top so they stay readable.
  runFxLayers('overlay-under-hud');
  if (game.state !== 'editor') renderHUD();
  // Screen-space FX OVER the HUD (killstreak banner, then recruit banner).
  runFxLayers('overlay-over-hud');
}
