// ============ WOLF FRENZY (Phase 188N) — "越殺越強" killstreak scaling ==========
// The Wolf chassis SNOWBALLS: every kill in the streak window (player._killStreak,
// incremented in bullets.js on a 4 s window, reset on death) ramps the wolf's MOVE
// speed AND fire-rate, so a wolf on a tear turns into a blur ("大招機器狼要隨著連殺
// 累計越來越強 — 移動 與射擊速度"). The dash (Space) stays its signature; this is the
// always-on escalation layered on top.
//
// Chassis-EXCLUSIVE (wolf only) + flag-gated behind game._classes, so every other
// chassis and the classes-off path are byte-identical (the helpers return the
// identity 1.0). SOLO-only: _killStreak is client-side state, and MP movement is
// cMul-corrected + MP fire is server-authoritative (server fireCdTicks), so a
// client-only buff would rubber-band online — in MP these return 1.0 → no effect.
//
// Tunables live in BALANCE.wolf (frenzy* keys) — see the root tunables map.
// Classic-script globals: wolfFrenzySteps · wolfFrenzySpeedMul · wolfFrenzyFireCdMul.
// Deps (call-time): game · player · BALANCE · _mpIsActive.

(function () {
  'use strict';

  function _on() {
    return typeof game !== 'undefined' && game && game._classes
        && typeof player !== 'undefined' && player
        && player._chassis === 'wolf' && player.alive
        && !(typeof _mpIsActive === 'function' && _mpIsActive());   // SOLO-only
  }
  // Single source of truth for the frenzy tunables: BALANCE.wolf (js/balance.js). Returns
  // null if BALANCE isn't loaded yet → callers no-op (no duplicated default literals here).
  function _cfg() {
    return (typeof BALANCE === 'object' && BALANCE && BALANCE.wolf) ? BALANCE.wolf : null;
  }

  // Effective frenzy steps: 0 at streak ≤ 1 (no combo yet → no buff), then +1 per
  // extra kill, capped at frenzyMaxSteps. Returns 0 whenever the buff doesn't apply
  // (not wolf / classes-off / dead / MP / no tunables) so every call site no-ops there.
  function _steps() {
    if (!_on()) return 0;
    const C = _cfg();
    if (!C || !(C.frenzyMaxSteps > 0)) return 0;
    // DECAY — the streak counter (bullets.js) only rewrites on a kill or on death; it does
    // NOT zero when the 4 s chain window lapses. Treat an expired window as no streak so the
    // frenzy FADES when you stop killing (matches "連殺 = a 4 s chain"), instead of lingering
    // at full power until death. Reads the same KS_WINDOW global bullets.js increments on.
    const win  = (typeof KS_WINDOW === 'number') ? KS_WINDOW : 240;
    const last = (typeof player._lastKillTick === 'number') ? player._lastKillTick : -1e9;
    if (game.time - last >= win) return 0;
    const ks = (typeof player._killStreak === 'number') ? player._killStreak : 0;
    const s = ks - 1;
    return s <= 0 ? 0 : (s > C.frenzyMaxSteps ? C.frenzyMaxSteps : s);
  }
  window.wolfFrenzySteps = _steps;

  // Move-speed multiplier (≥ 1). Folded into the player's speedMul each frame.
  window.wolfFrenzySpeedMul = function () {
    const s = _steps();
    if (s <= 0) return 1;
    return 1 + s * _cfg().frenzySpeedStep;
  };

  // Fire-COOLDOWN multiplier (≤ 1 → shorter cooldown → faster fire). Applied to
  // w.fireCd at the single consumeShot chokepoint (weapon_state.js). Clamped so it
  // never drops below frenzyFireFloor (a hard cap on the RoF gain).
  window.wolfFrenzyFireCdMul = function () {
    const s = _steps();
    if (s <= 0) return 1;
    const C = _cfg();
    const mul = 1 - s * C.frenzyFireStep;
    return mul < C.frenzyFireFloor ? C.frenzyFireFloor : mul;
  };
})();
