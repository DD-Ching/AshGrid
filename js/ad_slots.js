// ============ AD SLOT DOM TOGGLING (R11 Step 3) ===========================
// Centralised show/hide logic for the in-game ad slot DOM nodes. Each
// function caches its element lookups, runs a per-frame state check, and
// only writes `display:` when it changes (idempotent — cheap to call at
// 60 fps from the HUD render driver).
//
// Slots NOT handled here:
//   • pauseAdSlot     → toggled in js/pause.js (drawPauseOverlay)
//   • lobbyAdSlot     → static CSS visibility (always shown while lobby)
//   • loadingAdSlot   → static CSS visibility (always shown while loading)
//   • nnEndCard       → not an ad slot; toggled by the inline renderer
//                        in index.html (the cached _nnEndCardEl reference
//                        stays in index.html alongside other inline state)
//
// Classic-script. Declares globally:
//   _respawnAdSlotEl · _respawnAdLeftFlankEl · _respawnAdRightFlankEl
//   _frameAdTopEl
//   _updateRespawnAdSlot() · _updateFrameAdSlots()
//
// External deps (resolved at call time):
//   document · game (game._nnMode / _teamWipe.blue.wipedSince / state) ·
//   touchInput.enabled · window.innerWidth/innerHeight
//
// Callers: js/hud.js renderHUD calls both per frame.
//
// Phase 131b — _updateSideAdSlots() removed alongside the underlying
// #sideAdLeft / #sideAdRight DOM. Those rails had been force-hidden every
// frame since Phase 106; the DOM nodes (with their Adsterra script tags)
// are now deleted entirely so the network impressions stop firing too.

// ─── Death-overlay respawn ad slot ─────────────────────────────────────
//
// Three nodes coordinated together:
//   #respawnAdSlot          centre 336×280 + flanking 970×250 (Phase 100/101)
//   #respawnAdLeftFlank     left  336×280 (Phase 103, wide viewports only)
//   #respawnAdRightFlank    right 336×280 (Phase 103)
//
// Phase 87 — gated on TEAM WIPE only (not individual death).
// User '每一次死都會有廣告 應該是每一次全軍覆沒'. Single deaths now
// get NO ad; the banner only appears when the whole blue squad goes
// down — a real 'all hands' moment that justifies the interruption.
let _respawnAdSlotEl = null;
let _respawnAdLeftFlankEl  = null;
let _respawnAdRightFlankEl = null;
function _updateRespawnAdSlot() {
  if (!_respawnAdSlotEl) _respawnAdSlotEl = document.getElementById('respawnAdSlot');
  const slot = _respawnAdSlotEl;
  if (!slot) return;
  const teamWiped = typeof game !== 'undefined'
    && game._nnMode
    && game._teamWipe
    && game._teamWipe.blue
    && game._teamWipe.blue.wipedSince != null;
  const isMobile = (typeof touchInput !== 'undefined') && touchInput.enabled;
  // Phase 180a fix — hold the ad billboard back while the killcam replay is
  // covering the screen, so it appears AFTER the replay (death → killcam → ad)
  // instead of punching a DOM iframe through the replay (廣告牆擋住回放).
  const killcamUp = (typeof killcamBlocking === 'function') && killcamBlocking();
  slot.style.display = (teamWiped && !isMobile && !killcamUp) ? 'block' : 'none';
  // Phase 102 (6/x) — gate the secondary 970×250 billboard on viewport
  // height. A portal-embed iframe is typically 1280×720; the full stack
  // (336×280 + 970×250 + labels + gaps ≈ 572 px) plus top/bottom strips
  // leaves no room for the green REVIVE button — user '綠按鈕被徹底
  // 擋住了'. Below 850 px tall we drop the billboard and keep just
  // the Large Rect, leaving ~470 px of vertical room which the
  // DOM-anchored button (death_recap.js) can land cleanly below.
  const secondary = document.getElementById('respawnAdSecondary');
  if (secondary) {
    secondary.style.display = (!killcamUp && window.innerHeight >= 850) ? 'block' : 'none';
  }
  // Phase 103 — flanking 336×280 slots beside the center rect. Gated on
  // viewport ≥ 1720 px wide (each flank lives at center ± [515..851] px,
  // so anything narrower would clip them into the HUD or off-screen).
  // Portal-embed iframes ~1280 wide → fall back to just the center slot.
  if (!_respawnAdLeftFlankEl)  _respawnAdLeftFlankEl  = document.getElementById('respawnAdLeftFlank');
  if (!_respawnAdRightFlankEl) _respawnAdRightFlankEl = document.getElementById('respawnAdRightFlank');
  const wideEnough = window.innerWidth >= 1720;
  const flankWant = (teamWiped && !isMobile && wideEnough && !killcamUp) ? 'block' : 'none';
  if (_respawnAdLeftFlankEl  && _respawnAdLeftFlankEl.style.display  !== flankWant) _respawnAdLeftFlankEl.style.display  = flankWant;
  if (_respawnAdRightFlankEl && _respawnAdRightFlankEl.style.display !== flankWant) _respawnAdRightFlankEl.style.display = flankWant;
}

// ─── Outer ad frame (top strip only since Phase 124) ────────────────────
//
// Phase 107 introduced top + bottom permanent ad frame strips at the
// viewport edges. Phase 124 collapsed the bottom strip into a denser
// top strip (now 90 px tall with 3 ad tiles: 468×60 / 728×90 / 468×60)
// to save 30 px of HUD vertical inset. Only the top strip toggles now;
// the bottom DOM node was removed from index.html.
//
// Strip is shown ONLY during active play (not lobby, not paused, not
// death overlay) so the player isn't looking at ads while the game is
// not running. Mobile skips the frame entirely — the action column and
// bottom HP bar are already cramped, can't afford to lose 90 more px.
let _frameAdTopEl = null;
function _updateFrameAdSlots() {
  if (!_frameAdTopEl) _frameAdTopEl = document.getElementById('frameAdTop');
  if (!_frameAdTopEl) return;
  const playing = (typeof game !== 'undefined') && game.state === 'playing';
  const isMobile = (typeof touchInput !== 'undefined') && touchInput.enabled;
  const want = (playing && !isMobile) ? 'flex' : 'none';
  if (_frameAdTopEl.style.display !== want) _frameAdTopEl.style.display = want;
}
