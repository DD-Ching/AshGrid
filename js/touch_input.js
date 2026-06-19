// ============ TOUCH INPUT (mobile) ============
// Detect touch device once at load. Touch overlays (virtual sticks +
// action buttons) only render when this is true, so desktop is unchanged.
//
// Classic-script. Declares globally:
//   touchInput (object — { enabled, moveTouch, aimTouch })
//   TOUCH_STICK_RADIUS · TOUCH_STICK_DEAD (constants)
//   _touchHitButton(x, y) · _touchTriggerAction(id)
//   The IIFE at the bottom auto-attaches touchstart/move/end/cancel
//   listeners when touchInput.enabled — same as before extraction.
//
// External deps (resolved at call-time):
//   game · player · buildMode · isWallKind · screenToWorld
//   placeBuildBlock · _hitRect · togglePause · setAudioMuted ·
//   exitMatchToMenu · _radialKindUnderCursor · _snapAndCheckPlace ·
//   placeStructure · _editorCellAtScreen · _editorPlaceCell ·
//   _editorLineCells · _editorPlaceLine · swapPlayerToAlly ·
//   shareSurvivalRun · mission · showSwapToast · T

const touchInput = {
  enabled: ('ontouchstart' in window) || (navigator.maxTouchPoints > 0),
  moveTouch: null,    // { id, anchorX, anchorY, dx, dy } — left half drag
  aimTouch: null,     // same shape — right half drag
};
const TOUCH_STICK_RADIUS = 60;
const TOUCH_STICK_DEAD = 6;

function _touchHitButton(x, y) {
  if (!game._touchActionButtons) return null;
  for (const b of game._touchActionButtons) {
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id;
  }
  return null;
}
function _touchTriggerAction(id) {
  if (game._paused) {
    if (id === 'pause') togglePause();
    return;
  }
  if (game.state !== 'playing') return;
  switch (id) {
    case 'q':     toggleDrone(); break;
    case 'e':     launchFPV(); break;
    case 'g':     throwGrenade(); break;
    case 'r':
      // 188N — R is the Heavy chassis's weapon-switch (重裝專屬): cycle the stockpiled
      // arsenal's active gun. heavyCycleWeapon self-gates (heavy + classes + >1 type)
      // and returns false otherwise → normal reload. Mirrors the desktop r binding
      // (key_bindings.js) so the touch action-bar isn't switch-blind for the Heavy.
      if (typeof heavyCycleWeapon === 'function' && heavyCycleWeapon()) break;
      startReload();
      break;
    case 'v':
      player._aimAssist = !player._aimAssist;
      try { localStorage.setItem('ag.aimAssist', player._aimAssist ? '1' : '0'); } catch (err) {}
      break;
    case 'b':     toggleBuildMode(); break;
    // Phase 140 — manual weapon swap removed (one pawn = one weapon; pick up a
    // killed enemy's dropped gun instead). The 'x' button no longer exists in
    // the mobile action bar (see hud.js), so this case is gone.
    case 'pause': togglePause(); break;
  }
}

if (touchInput.enabled) {
  // Phase 77 — CRITICAL BUG FIX. This file loads from <head> at line ~52,
  // but `player` is defined inside the inline script at line 2343 (much
  // later in load order). The ORIGINAL `player._aimAssist = true` here
  // threw ReferenceError on mobile → IIFE aborted BEFORE
  // addEventListener attached → touch listeners never wired → no movement,
  // no aim, nothing on phones. Desktop never saw this because
  // touchInput.enabled === false skipped the whole block.
  //
  // Fix: defer the player-state default into DOMContentLoaded (when the
  // inline script has finished running). Touch listeners still attach
  // immediately so we never miss an early gesture.
  if (typeof document !== 'undefined') {
    const _initAimAssist = () => {
      if (typeof player === 'undefined') return;
      if (localStorage.getItem('ag.aimAssist') == null) {
        player._aimAssist = true;
        try { localStorage.setItem('ag.aimAssist', '1'); } catch (e) {}
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _initAimAssist, { once: true });
    } else {
      _initAimAssist();
    }
  }
  // Prevent the page from scrolling / pinch-zooming under our gestures. This file
  // loads in <head>, where document.body is still null — the bare assignment
  // threw "Cannot read properties of null (reading 'style')" and aborted the
  // touch-handler setup below it (pre-existing since the original extraction;
  // bit mobile, where <body> parse timing varies). Defer to DOM-ready so it
  // actually applies once body exists.
  const _setTouchAction = () => { if (document.body) document.body.style.touchAction = 'none'; };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _setTouchAction, { once: true });
  } else {
    _setTouchAction();
  }

  const onStart = (e) => {
    // Phase 108b — canvas is CSS-offset HUD_AD_TOP px from window top
    // (outer ad-frame reserve). Translate every touch.clientY to canvas
    // Y once at the top so every downstream _hitRect against canvas-
    // coord rects (pause / squad / build / revive / share) hits cleanly.
    // Without this every canvas-drawn button on mobile misses by 60 px.
    const _adTop = (typeof HUD_AD_TOP !== 'undefined') ? HUD_AD_TOP : 0;
    for (const t of e.changedTouches) {
      const _tx = t.clientX;
      const _ty = t.clientY - _adTop;
      // 1) Action buttons (top-right)
      const btn = _touchHitButton(_tx, _ty);
      if (btn) { _touchTriggerAction(btn); continue; }
      // 2) Pause overlay buttons (when paused)
      if (game._paused) {
        if (_hitRect(game._pauseResumeRect, _tx, _ty)) togglePause();
        else if (_hitRect(game._pauseGfxRect, _tx, _ty)) { if (typeof setPerfMode === 'function') setPerfMode(!(typeof _PERF_MODE !== 'undefined' && _PERF_MODE)); }
        else if (_hitRect(game._pauseMuteRect, _tx, _ty)) setAudioMuted(!AUDIO.muted);
        else if (_hitRect(game._pauseExitRect, _tx, _ty)) exitMatchToMenu();
        continue;
      }
      // 3) HUD pause button (top-left)
      if (_hitRect(game._pauseBtnRect, _tx, _ty)) {
        togglePause(); continue;
      }
      // 4) Squad chip swap
      if (game._squadChipRects) {
        let hit = false;
        for (const c of game._squadChipRects) {
          if (c.alive && _hitRect(c, _tx, _ty)) {
            swapPlayerToAlly(c.allyIdx);
            hit = true; break;
          }
        }
        if (hit) continue;
      }
      // 4a) Defense radial picker — Phase 76: two-tier aware. Uses the
      // new _radialPickAt so a tap on an inner category EXPANDS its
      // outer fan (pins radialCat), and a tap on the outer wedge
      // selects + closes. Old version called the kind-only shim, so
      // touching inner returned null → radial slammed shut and the
      // player could never reach the sub-items.
      if (_canBuildPlace() && buildMode.radialOpen) {
        const pick = (typeof _radialPickAt === 'function')
          ? _radialPickAt(_tx, _ty)
          : null;
        if (pick && pick.type === 'kind') {
          buildMode.kind = pick.id;
          buildMode.radialOpen = false;
          buildMode.radialCat = null;
          showSwapToast(`${T('已选', 'Selected')}: ${STRUCTURE_DEFS[pick.id].label()}`);
        } else if (pick && pick.type === 'cat') {
          buildMode.radialCat = pick.id;
          // Don't close — fan stays open, wait for outer tap.
        } else {
          // Tap on backdrop / dead zone — soft-cancel.
          buildMode.radialOpen = false;
          buildMode.radialCat = null;
        }
        hit = true;
        continue;
      }
      // 4a2) Defense placing-mode tap — single helper does snap + reach.
      if (_canBuildPlace() && !buildMode.radialOpen) {
        const cell = _snapAndCheckPlace(_tx, _ty, true);
        if (cell) {
          const { gx, gy } = cell;
          if (isWallKind(buildMode.kind)) {
            buildMode._dragStart = { gx, gy };
            buildMode._dragEnd   = { gx, gy };
          }
          placeStructure(buildMode.kind, gx, gy);
        }
        hit = true;
        continue;
      }
      // 4b) Survival revive CTA — rewarded-ad on tap
      if (_hitRect(game._reviveBtnRect, _tx, _ty)) {
        if (mission && typeof mission.tryRevive === 'function') mission.tryRevive();
        continue;
      }
      // 4b2) Survival share-run on tap
      if (_hitRect(game._shareRunBtnRect, _tx, _ty)) {
        if (mission && typeof mission.getRunSummary === 'function') {
          shareSurvivalRun(mission.getRunSummary());
        }
        continue;
      }
      // 4c2) Build-phase skip-wave button
      if (_hitRect(game._skipWaveAdRect, _tx, _ty)) {
        if (mission && typeof mission.trySkipWave === 'function') mission.trySkipWave();
        continue;
      }
      // 4c) Build-phase ad-extend button
      if (_hitRect(game._buildPhaseAdRect, _tx, _ty)) {
        if (typeof extendBuildPhaseViaAd === 'function') extendBuildPhaseViaAd();
        continue;
      }
      // 5a) BUILD PHASE: between-wave cover placement takes precedence
      if (game._buildPhase && game._buildPhase.active && game._buildPhase.left > 0) {
        placeBuildBlock(_tx, _ty);
        continue;
      }
      // 5b) Otherwise: stick assignment by screen half
      if (t.clientX < window.innerWidth / 2) {
        if (!touchInput.moveTouch) {
          touchInput.moveTouch = { id: t.identifier, anchorX: t.clientX, anchorY: t.clientY, dx: 0, dy: 0 };
        }
      } else {
        if (!touchInput.aimTouch) {
          touchInput.aimTouch = { id: t.identifier, anchorX: t.clientX, anchorY: t.clientY, dx: 0, dy: 0 };
        }
      }
    }
    e.preventDefault();
  };
  const onMove = (e) => {
    for (const t of e.changedTouches) {
      if (touchInput.moveTouch && touchInput.moveTouch.id === t.identifier) {
        touchInput.moveTouch.dx = t.clientX - touchInput.moveTouch.anchorX;
        touchInput.moveTouch.dy = t.clientY - touchInput.moveTouch.anchorY;
      }
      if (touchInput.aimTouch && touchInput.aimTouch.id === t.identifier) {
        touchInput.aimTouch.dx = t.clientX - touchInput.aimTouch.anchorX;
        touchInput.aimTouch.dy = t.clientY - touchInput.aimTouch.anchorY;
      }
    }
    // Defense wall drag: update preview end while finger is held down on
    // the canvas, mirroring the mousemove path.
    if (buildMode.active && isWallKind(buildMode.kind) && buildMode._dragStart
        && !buildMode.radialOpen && game.state === 'playing' && !game._paused) {
      const t = e.changedTouches[0];
      if (t) {
        // Phase 108b — translate touch Y to canvas coord before screenToWorld
        const _adTop = (typeof HUD_AD_TOP !== 'undefined') ? HUD_AD_TOP : 0;
        const wp = screenToWorld(t.clientX, t.clientY - _adTop);
        const SNAP = 30;
        const gx = Math.round(wp.x / SNAP) * SNAP;
        const gy = Math.round(wp.y / SNAP) * SNAP;
        buildMode._dragEnd = { gx, gy };
      }
    }
    e.preventDefault();
  };
  const onEnd = (e) => {
    for (const t of e.changedTouches) {
      if (touchInput.moveTouch && touchInput.moveTouch.id === t.identifier) {
        touchInput.moveTouch = null;
      }
      if (touchInput.aimTouch && touchInput.aimTouch.id === t.identifier) {
        touchInput.aimTouch = null;
      }
    }
    // Defense wall drag-release: commit the Bresenham line on touchend
    // (same path as the mouseup handler) so the user can stretch + lift.
    if (buildMode.active && isWallKind(buildMode.kind) && buildMode._dragStart && buildMode._dragEnd) {
      const a = buildMode._dragStart, b = buildMode._dragEnd;
      if (a.gx !== b.gx || a.gy !== b.gy) {
        const cells = _editorLineCells(a.gx, a.gy, b.gx, b.gy, 30);
        const kind = buildMode.kind;
        for (let i = 1; i < cells.length; i++) {
          const c = cells[i];
          const occupied = (game._structures || []).some(s =>
            isWallKind(s.kind) && s.hp > 0 && s.x === c.cx && s.y === c.cy);
          if (occupied) continue;
          if (!canAffordStructure(kind)) {
            showSwapToast(T('能源不足', 'Out of energy'));
            break;
          }
          placeStructure(kind, c.cx, c.cy);
        }
      }
      buildMode._dragStart = null;
      buildMode._dragEnd   = null;
    }
    e.preventDefault();
  };
  window.addEventListener('touchstart',  onStart, { passive: false });
  window.addEventListener('touchmove',   onMove,  { passive: false });
  window.addEventListener('touchend',    onEnd,   { passive: false });
  window.addEventListener('touchcancel', onEnd,   { passive: false });
}
