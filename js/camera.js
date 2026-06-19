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
  // SIEGE cinematic FOCUS (運鏡). The siege director's `camera focus` cue + the
  // breach punch set game._cineFocus = { x, y, scale, until }; this top-priority
  // mode lerps the view there for a beat (the dd>60 ease below glides in + back to
  // the player when it expires). Gated on game._siege so it's inert in every other
  // mode (the only writers of _cineFocus are siege cues / the tank-breach).
  { id: 'siegeCine',
    when:     () => typeof game !== 'undefined' && game._siege && game._cineFocus
                    && typeof game.time === 'number' && game.time < game._cineFocus.until,
    target:   () => ({ x: game._cineFocus.x, y: game._cineFocus.y }),
    scale:    () => game._cineFocus.scale || camera.scale,
    rotation: () => 0 },
  { id: 'editor',
    when:     () => game.state === 'editor',
    target:   () => ({ x: NN_ARENA.x0 + NN_ARENA.w / 2, y: NN_ARENA.y0 + NN_ARENA.h / 2 }),
    scale:    () => Math.min(W() / (NN_ARENA.w + 200), H() / (NN_ARENA.h + 200)),
    rotation: () => 0 },
  // mpDead — player is dead in MP arena. Pull the camera to an arena-wide
  // overview so the player feels they've LEFT the field while waiting for
  // respawn, instead of being stuck staring at their own corpse from the
  // kill spot. User: '我只是看著地圖而已,我就是完全離開了這個地方,
  // 時間到的時候我才回來'. Outranks drone/fpv/command so the view doesn't
  // stay glued to whatever vehicle was active when we died.
  { id: 'mpDead',
    when:     () => typeof _mpState !== 'undefined' && _mpState && _mpState.enabled
                    && typeof player !== 'undefined' && !player.alive
                    && game.state === 'playing',
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
    target:   () => _playerFollowTarget(),
    scale:    () => 0.42,
    rotation: () => 0 },
  // (arena-mp: FTUE camera override stripped — _ftueCameraScale was a
  // no-op stub; the prologue's zoom-ramp is gone.)
  // Default — covers tactical mode in normal NN matches.
  { id: 'tactical',
    when:     () => true,
    target:   () => _playerFollowTarget(),
    scale:    () => 1,
    rotation: () => 0 },
];

// Phase 154 — follow the player's interpolated DRAW position (computed in
// loop() each frame) so the camera scrolls smoothly between 84 Hz sim ticks
// instead of snapping to each quantized step. Falls back to the raw sim
// position before the first interpolated frame is ready.
function _playerFollowTarget() {
  return {
    x: (player._drawX != null ? player._drawX : player.x),
    y: (player._drawY != null ? player._drawY : player.y),
  };
}

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

  // Phase 67 — position lerp. Mode-aware:
  //   • normal tactical: snap (responsive, no input lag)
  //   • big delta (mode switch, respawn teleport): lerp to absorb the jump
  // Threshold 60u — well past any normal movement step (player moves
  // ~3u/frame). Anything over that is a teleport-class change so easing
  // it in is preferable to a hard cut.
  const dx = target.x - camera.x;
  const dy = target.y - camera.y;
  const dd = Math.hypot(dx, dy);
  if (dd > 60) {
    camera.x += dx * 0.18;
    camera.y += dy * 0.18;
  } else {
    camera.x = target.x;
    camera.y = target.y;
  }
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
