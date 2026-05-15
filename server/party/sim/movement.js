// ============================================================
// Phase 1 — Shared player movement simulation (SERVER copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// js/sim/movement.js (the client-side classic-script mirror). The
// only difference between the two files is the boilerplate at the
// bottom — the client attaches to `window.SIM`; this one uses ESM
// `export` statements consumed by PartyKit / esbuild.
//
// See js/sim/movement.js for the full design comment.

// Phase 4 — server tick rate doubled 30 Hz → 60 Hz. Per-tick speed halved
// to keep px/sec constant. PER_TICK now equals PER_FRAME because both
// the client's render frame and the server's tick share the 60 Hz beat.
const PLAYER_SPEED_PER_TICK  = 2.8;   // was 5.6 at 30 Hz tick
const PLAYER_SPEED_PER_FRAME = 2.8;   // unchanged — client per-frame stays 60 fps
const SPRINT_SPEED_MUL       = 1.65;
const PLAYER_RADIUS          = 14;

function normalizeMove(dx, dy) {
  const mag = Math.hypot(dx, dy);
  if (mag > 1) return { dx: dx / mag, dy: dy / mag };
  return { dx: dx, dy: dy };
}

function computeSpeedMul(input, weaponSpeedMul, chassisSpeedMul) {
  const sprintMul = (input && input.sprint) ? SPRINT_SPEED_MUL : 1.0;
  const wpnMul    = (typeof weaponSpeedMul  === 'number') ? weaponSpeedMul  : 1.0;
  const chsMul    = (typeof chassisSpeedMul === 'number') ? chassisSpeedMul : 1.0;
  return sprintMul * wpnMul * chsMul;
}

function simStepPerTick(state, input) {
  const n = normalizeMove(input.dx, input.dy);
  const mul = computeSpeedMul(input, state.weaponSpeedMul, state.chassisSpeedMul);
  return {
    x: state.x + n.dx * PLAYER_SPEED_PER_TICK * mul,
    y: state.y + n.dy * PLAYER_SPEED_PER_TICK * mul,
    moved: n.dx !== 0 || n.dy !== 0,
  };
}

function simStepPerFrame(state, input) {
  const n = normalizeMove(input.dx, input.dy);
  const mul = computeSpeedMul(input, state.weaponSpeedMul, state.chassisSpeedMul);
  return {
    x: state.x + n.dx * PLAYER_SPEED_PER_FRAME * mul,
    y: state.y + n.dy * PLAYER_SPEED_PER_FRAME * mul,
    moved: n.dx !== 0 || n.dy !== 0,
  };
}

export {
  PLAYER_SPEED_PER_TICK,
  PLAYER_SPEED_PER_FRAME,
  SPRINT_SPEED_MUL,
  PLAYER_RADIUS,
  normalizeMove,
  computeSpeedMul,
  simStepPerTick,
  simStepPerFrame,
};
