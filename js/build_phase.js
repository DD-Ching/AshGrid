// ============ BUILD PHASE — free cover placement (Phase 161) ============
// Revives the orphaned build-loop dead code. The producer (game._buildPhase)
// was cut by the arena-mp fork (commit 3613df3), leaving placeBuildBlock
// undefined while index.html / hud.js / touch_input.js still referenced it —
// so the whole between-wave fortify UI was invisible and unreachable.
//
// This file restores placeBuildBlock (recovered from cdf2853 + i18n). The
// PRODUCER that opens/closes game._buildPhase lives in the mission factory
// (js/missions/nn_deathmatch.js) — it opens a periodic fortify window in SOLO
// arena play. MP is server-authoritative, so the build phase is SOLO-only
// (a client-placed cover would desync the authoritative world).
//
// game._buildPhase shape (read by hud.js / touch_input.js / index.html):
//   { active:bool, left:int, _adExtended:bool, _skipUsed:bool, endsAt:tick }
//
// Classic-script. Declares two globals:
//   placeBuildBlock(screenX, screenY)   — place one free cover, decrement left.
//   extendBuildPhaseViaAd()             — rewarded-ad "+2 covers · +5s" extend.
//
// Deps (all globals, resolved at call time): screenToWorld (camera.js),
// addLowCover (world_gen.js), NN_ARENA (maps.js), COLORS, playSfx,
// showSwapToast, T, requestRewardedAd (ad_dispatch.js), mission.

function placeBuildBlock(screenX, screenY) {
  if (!game._buildPhase || game._buildPhase.left <= 0) return;
  const wp = screenToWorld(screenX, screenY);
  const SIZE = 60, PAD = 30;
  // clamp to the arena interior so a cover can't be dropped in the wall margin
  const cx = Math.max(NN_ARENA.x0 + PAD, Math.min(NN_ARENA.x0 + NN_ARENA.w - SIZE - PAD, wp.x - SIZE / 2));
  const cy = Math.max(NN_ARENA.y0 + PAD, Math.min(NN_ARENA.y0 + NN_ARENA.h - SIZE - PAD, wp.y - SIZE / 2));
  addLowCover(cx, cy, SIZE, SIZE, COLORS.creamDark, { kind: 'crate' });
  game._buildPhase.left--;
  if (typeof playSfx === 'function') playSfx('reload', { vol: 0.5 });
  if (typeof showSwapToast === 'function') {
    showSwapToast(T('放置掩體 · 剩餘 ' + game._buildPhase.left,
                    'COVER PLACED · ' + game._buildPhase.left + ' left'));
  }
}

// Rewarded-ad "+2 covers · +5s" extend, fired by the build-phase ad button.
// Single owner of this block — the mouse (index.html) and touch (touch_input.js)
// handlers both inlined an identical copy, so the Phase 162 300→420-tick fix had
// to land twice. Folds in the `requestRewardedAd` existence guard the touch
// caller used to omit (it would have thrown if the ad dispatcher were absent;
// the mouse caller already guarded, so this is behaviour-preserving there).
function extendBuildPhaseViaAd() {
  if (!game._buildPhase || game._buildPhase._adExtended) return;
  if (typeof requestRewardedAd !== 'function') return;
  game._buildPhase._adExtended = true;
  requestRewardedAd('build_phase_extend', (ok) => {
    // null-guard: the build-phase auto-close timer can null game._buildPhase
    // while this ad is on screen, so the dismiss path must re-check it too
    // (the success branch below already does).
    if (!ok) { if (game._buildPhase) game._buildPhase._adExtended = false; return; }
    if (game._buildPhase) {
      game._buildPhase.left += 2;
      showSwapToast(T(`+2 掩体 · 时间延长 5s`, `+2 covers · +5s timer`));
    }
    if (mission && typeof mission._extendBreather === 'function') {
      mission._extendBreather(420);   // +5 s at 84 ticks/s
    }
  });
}
