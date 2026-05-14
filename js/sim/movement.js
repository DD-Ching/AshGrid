// ============================================================
// Phase 1 — Shared player movement simulation (CLIENT copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// server/party/sim/movement.js (the server-side ESM mirror). The
// only difference between the two files is the boilerplate at the
// bottom that exports the API — this one attaches to `window.SIM`
// for classic <script> tag usage; the server one uses ESM `export`.
//
// Why two files instead of one ES module: the browser side of
// AshGrid uses classic <script> tags throughout (see index.html
// <head>), and mixing classic + module scripts complicates load
// order. Server (PartyKit + esbuild) needs ESM. So we duplicate
// and police via the `ai_arena/scripts/check_sim_parity.sh` diff
// check (run in pre-commit / CI).
//
// Goal: bit-for-bit identical movement on server tick and client
// prediction. Same input + same starting state → same final
// position. This is what kills bug #4 (rubber-band when sprinting,
// when using a heavy weapon, when on a fast chassis).
//
// === API ===
//   SIM.PLAYER_SPEED_PER_TICK   5.6   (server, 30 Hz authority)
//   SIM.PLAYER_SPEED_PER_FRAME  2.8   (client, 60 fps prediction)
//   SIM.SPRINT_SPEED_MUL        1.65
//   SIM.PLAYER_RADIUS           14
//
//   SIM.normalizeMove(dx, dy) → {dx, dy} (unit-length or smaller)
//
//   SIM.computeSpeedMul(input, weaponSpeedMul, chassisSpeedMul) → number
//     Returns sprintMul × weaponMul × chassisMul.
//
//   SIM.simStepPerTick(state, input) → {x, y, moved}
//     One 30Hz server tick of movement. Caller does wall pushout.
//
//   SIM.simStepPerFrame(state, input) → {x, y, moved}
//     One 60fps client frame of movement. Half of a tick.
//
// === Input shape ===
//   { dx, dy, sprint }
//   dx, dy:   -1..+1, raw key intent (NOT normalized — function does it)
//   sprint:   0 | 1, whether the player is sprinting this tick/frame
//
// === State shape (read-only) ===
//   { x, y, weaponSpeedMul, chassisSpeedMul }
//   weaponSpeedMul:   typically 0.85–1.20 from WEAPONS table
//   chassisSpeedMul:  typically 0.80–1.30 from CHASSIS table
//   Optional both default to 1.0 if undefined.

(function() {
  'use strict';

  const PLAYER_SPEED_PER_TICK  = 5.6;
  const PLAYER_SPEED_PER_FRAME = 2.8;
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

  const API = {
    PLAYER_SPEED_PER_TICK,
    PLAYER_SPEED_PER_FRAME,
    SPRINT_SPEED_MUL,
    PLAYER_RADIUS,
    normalizeMove,
    computeSpeedMul,
    simStepPerTick,
    simStepPerFrame,
  };

  if (typeof window !== 'undefined') {
    window.SIM = window.SIM || {};
    Object.assign(window.SIM, API);
  }
})();
