// ============ INPUT MODULE (R2 refactor) ============
// Owns all WRITES to the global `mouse` state + the canvas-inset
// coordinate translation. Reads of `mouse.x` / `mouse.y` / `mouse.down`
// stay direct (they're cheap and pervasive); WRITES funnel through
// here so the per-frame trigger edge stays consistent.
//
// Background: before R2, ~9 different sites mutated `mouse.down` or
// `mouse._wasDown` (mousedown / mouseup / mousemove handlers in
// index.html, weapons.js swap fix, pawn_swap.js, pause.js,
// nn_deathmatch.js auto-swap). Phase 110c → 111c oscillated twice on
// the right fix because every site had its own assumptions about the
// trigger state. Now there is exactly one place to read about how the
// trigger state evolves: this file.
//
// External deps (resolved at call-time via globals):
//   mouse  — declared in index.html (`const mouse = { x, y, worldX,
//            worldY, down }`). We mutate its fields, never replace it.
//   HUD_AD_TOP — declared in index.html (outer-ad-frame thickness,
//            currently 60 px). Used to translate window-coord clientY
//            into canvas-coord Y after Phase 108b inset the canvas.
//
// Public API (window.Input):
//
//   Pointer state ──────────────────────────────────────────────────
//     onMouseMove(e)          mousemove handler entry. Stores
//                             {x, y} in canvas coords on `mouse`.
//                             Returns {x, y} for the caller to use
//                             for downstream world-space lookups.
//     onMouseDown()           Mark the left button pressed; also
//                             implies a fresh rising edge for semi-
//                             auto weapons. Returns the same {x, y}
//                             as the most-recent mousemove.
//     onMouseUp()             Mark the left button released.
//     translateClientY(cy)    Raw helper: clientY → canvas-coord Y.
//
//   Trigger primitives (called from non-input code paths) ─────────
//     releaseTrigger()        mouse.down=false AND _wasDown=false.
//                             Used by pawn-swap + auto-swap-on-death
//                             so the new pilot needs a fresh click
//                             before they start firing.
//     resetTriggerEdge()      _wasDown=false only. Used by weapon
//                             swap — keeps mouse.down (so an auto
//                             gun keeps firing across swap) but lets
//                             a semi-auto pick up the held trigger
//                             as a rising edge.
//
//   Frame book-keeping ────────────────────────────────────────────
//     tickFrameEnd()          Snapshots mouse.down → mouse._wasDown.
//                             Called once at the end of each
//                             update() pass.

(function() {
  'use strict';

  function _resolveMouse() {
    return (typeof mouse !== 'undefined') ? mouse : null;
  }
  function _hudAdTop() {
    return (typeof HUD_AD_TOP !== 'undefined') ? HUD_AD_TOP : 0;
  }

  function translateClientY(cy) {
    return cy - _hudAdTop();
  }

  function onMouseMove(e) {
    const m = _resolveMouse();
    if (!m) return null;
    m.x = e.clientX;
    m.y = e.clientY - _hudAdTop();
    return { x: m.x, y: m.y };
  }

  function onMouseDown() {
    const m = _resolveMouse();
    if (!m) return null;
    m.down = true;
    // Rising edge is implicit: _wasDown was set at last tickFrameEnd
    // from the previous frame's mouse.down. The fire trigger checks
    // (mouse.down && !mouse._wasDown) for semi-auto, which evaluates
    // correctly so long as we don't pre-set _wasDown here.
    return { x: m.x, y: m.y };
  }

  function onMouseUp() {
    const m = _resolveMouse();
    if (!m) return;
    m.down = false;
  }

  function releaseTrigger() {
    const m = _resolveMouse();
    if (!m) return;
    m.down = false;
    m._wasDown = false;
  }

  function resetTriggerEdge() {
    const m = _resolveMouse();
    if (!m) return;
    // KEEP mouse.down (so held auto-fire keeps firing); only clear the
    // 'previous-frame' snapshot so semi-auto sees a rising edge.
    m._wasDown = false;
  }

  function tickFrameEnd() {
    const m = _resolveMouse();
    if (!m) return;
    // Phase 126 — preserve the rising-edge for semi-auto across the
    // post-spawn invuln window. Without this guard, canFire() returns
    // false during invuln (Phase 21 no-spawn-camp rule) but tickFrameEnd
    // still snapshots `_wasDown = mouse.down = true`. When invuln expires,
    // semi-auto's rising-edge check `(mouse.down && !mouse._wasDown)` is
    // already false (the held trigger was "consumed" by the gate) and
    // the player can't fire until they release + re-click.
    //
    // Showed up loud after Phase 125 because that fix made the invuln
    // window a reliable 3 s where it used to race down to <1 s.
    // User: '武器有機率切換之後無法發射!'
    //
    // Skipping the snapshot while invuln means _wasDown stays at whatever
    // value it had when invuln started — typically false right after
    // swap (Input.resetTriggerEdge cleared it). When invuln expires the
    // first fire sees `(true && !false) = true` → semi-auto fires once,
    // tickFrameEnd then runs normally and the next-frame _wasDown=true
    // gates the held trigger as expected.
    if (typeof PlayerLifecycle !== 'undefined'
        && PlayerLifecycle.isPlayerInvuln
        && PlayerLifecycle.isPlayerInvuln()) {
      return;
    }
    m._wasDown = m.down;
  }

  window.Input = {
    onMouseMove,
    onMouseDown,
    onMouseUp,
    translateClientY,
    releaseTrigger,
    resetTriggerEdge,
    tickFrameEnd,
  };
})();
