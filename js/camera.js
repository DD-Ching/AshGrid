// ============ CAMERA ============
// Top-down camera with priority-table mode selection. CAMERA_MODES is
// a list of { when, apply } pairs scanned per frame; the first match wins.
// Adding a new camera state (e.g. UAV scout, FPV chase, command overview)
// = new row in CAMERA_MODES, no if/else cascade edits.
//
// Classic-script. Declares globally:
//   camera (object — { x, y, scale, targetScale, rotation, targetRotation })
//   CAMERA_MODES (priority list)
//   updateCamera() · screenToWorld(sx, sy)
//
// External deps: game · player · drone · fpv · _ftueCameraScale ·
//   _radialKindUnderCursor · buildMode · W · H

const camera = { x: 0, y: 0, scale: 1, targetScale: 1, rotation: 0, targetRotation: 0 };

// Camera mode priority table — the FIRST entry whose `when()` returns true
// wins. Order matters: editor beats everything; FTUE override beats default
// tactical; default tactical is the catch-all at the bottom.
//
// Previously updateCamera was a 5-branch if/else cascade with an
// `if (game.mode === 'tactical') { _ftueCameraScale() }` patch tacked on
// at the end. Adding a new mode meant inserting a branch in the middle
// and carefully reordering, easy to break.
const CAMERA_MODES = [
  { id: 'editor',
    when:     () => game.state === 'editor',
    target:   () => ({ x: NN_ARENA.x0 + NN_ARENA.w / 2, y: NN_ARENA.y0 + NN_ARENA.h / 2 }),
    scale:    () => Math.min(W() / (NN_ARENA.w + 200), H() / (NN_ARENA.h + 200)),
    rotation: () => 0 },
  { id: 'drone',
    when:     () => game.mode === 'drone' && drone.deployed,
    target:   () => drone,
    scale:    () => 0.85,
    rotation: () => 0 },
  { id: 'fpv',
    when:     () => game.mode === 'fpv' && fpv.active,
    target:   () => fpv,
    scale:    () => 1.3,
    rotation: () => -fpv.angle - Math.PI / 2 },
  { id: 'command',
    when:     () => game.mode === 'command',
    target:   () => player,
    scale:    () => 0.42,
    rotation: () => 0 },
  // FTUE override — only when in tactical mode AND a script registered a
  // cameraScaleTarget. Beats the catch-all so the prologue's 0.55 / 0.65
  // / 0.7 / 0.32 zoom-ramp wins over the default 1.0.
  { id: 'ftue',
    when:     () => game.mode === 'tactical'
                  && typeof _ftueCameraScale === 'function'
                  && _ftueCameraScale() != null,
    target:   () => player,
    scale:    () => _ftueCameraScale(),
    rotation: () => 0 },
  // Default — covers tactical mode in normal NN matches.
  { id: 'tactical',
    when:     () => true,
    target:   () => player,
    scale:    () => 1,
    rotation: () => 0 },
];

function updateCamera() {
  // Walk the priority table; first match wins.
  let mode = null;
  for (const m of CAMERA_MODES) { if (m.when()) { mode = m; break; } }
  // Catch-all guarantees mode is never null, but be defensive.
  if (!mode) mode = CAMERA_MODES[CAMERA_MODES.length - 1];
  const target = mode.target();
  camera.targetScale    = mode.scale();
  camera.targetRotation = mode.rotation();
  camera.scale += (camera.targetScale - camera.scale) * 0.1;
  let rotDiff = camera.targetRotation - camera.rotation;
  while (rotDiff > Math.PI) rotDiff -= Math.PI*2;
  while (rotDiff < -Math.PI) rotDiff += Math.PI*2;
  camera.rotation += rotDiff * 0.15;

  camera.x = target.x;
  camera.y = target.y;
}

function screenToWorld(sx, sy) {
  const mx = (sx - W()/2) / camera.scale;
  const my = (sy - H()/2) / camera.scale;
  const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation);
  return {
    x: mx*c + my*s + camera.x,
    y: -mx*s + my*c + camera.y,
  };
}
