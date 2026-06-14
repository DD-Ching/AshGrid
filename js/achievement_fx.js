// ============ ACHIEVEMENT UNLOCK FLOURISH (Phase 184n) ============
// Game-feel / juice. Achievements already exist (js/achievements.js — 12 unlocks,
// hand-drawn SVG icons, localised titles) but an unlock only surfaced as a small
// SILENT corner toast (showSwapToast). That's deliberately quiet — the owner has
// repeatedly killed the "ding-dong" unlock SOUND — but it gave the player almost
// no PAYOFF for earning a record. This adds a tasteful, SILENT, animated unlock
// CARD: the achievement's own SVG icon + "ACHIEVEMENT UNLOCKED" + the title,
// sliding in at the top, holding, then fading. No sound, no balance change, pure
// feedback — same category as js/killstreak_fx.js.
//
// Self-contained + additive: unlockAchievement() (achievements.js) calls the
// global _achievementFxEnqueue(a); we queue + draw. Multiple unlocks (e.g. the
// match-end multi-unlock) play in sequence. Kill switch: game._achvFx === false.
//
// Classic-script. Declares globals:
//   _achievementFxEnqueue(achievement)   — enqueue a card (called from achievements.js)
//   updateAchievementFx()                — per sim-tick: age the card, advance the queue
//   renderAchievementFx()                — per-frame read-only draw (registered FX layer)
// External deps (call-time): game · ctx · W · H · COLORS · getLang · Image.
// Loads AFTER the FX-layer system (registerFxLayer) — placed right after
// js/killstreak_fx.js in index.html, same as the other overlay-over-hud layers.

(function () {
  'use strict';

  const TTL = 220;                 // ticks the card stays (~2.6s at the sim rate)
  const MAX_QUEUE = 6;             // cap so a match-end burst can't backlog forever
  const queue = [];
  let current = null;              // { title, img, ttl, maxTtl }

  // Rasterise an SVG string to an Image once, on enqueue, so the per-frame draw
  // is a cheap drawImage. Self-contained SVGs (no external refs) → safe as a
  // data-URI; we only drawImage (never read back), so canvas-taint is moot.
  function _svgToImage(svg) {
    try {
      const img = new Image();
      img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      return img;
    } catch (e) { return null; }
  }

  // Called by achievements.js unlockAchievement(). `a` is an ACHIEVEMENTS entry.
  window._achievementFxEnqueue = function (a) {
    if (!a) return;
    const zh = (typeof getLang === 'function' && getLang() === 'zh');
    queue.push({
      title: zh ? (a.title_zh || a.title_en || '') : (a.title_en || ''),
      label: zh ? '成就解鎖' : 'ACHIEVEMENT UNLOCKED',
      img: a.icon ? _svgToImage(a.icon) : null,
    });
    while (queue.length > MAX_QUEUE) queue.shift();   // drop oldest if flooded
  };

  // ── State tick — once per sim step (called from update()) ─────────────────
  window.updateAchievementFx = function () {
    if (typeof game === 'undefined' || !game) { current = null; queue.length = 0; return; }
    // kill switch + 184u: clear when not in a live match (mirrors updateRecruitFx)
    // so a card active at match-end can't leak into the next match's opening frames.
    if (game._achvFx === false || game.state !== 'playing') { current = null; queue.length = 0; return; }
    if (!current && queue.length) {
      const q = queue.shift();
      current = { title: q.title, label: q.label, img: q.img, ttl: TTL, maxTtl: TTL };
    }
    if (current && --current.ttl <= 0) current = null;
  };

  // ── Read-only draw — once per render frame (registered FX layer) ──────────
  window.renderAchievementFx = function () {
    const c = current;
    if (!c || typeof ctx === 'undefined' || !ctx) return;
    if (typeof game !== 'undefined' && game && game._achvFx === false) return;
    const w = (typeof W === 'function') ? W() : 800;
    const t = c.ttl / c.maxTtl;                      // 1 → 0
    // Slide DOWN + pop in over the first ~16%; hold; slide up + fade the last ~26%.
    const inP  = Math.min(1, (1 - t) / 0.16);
    const outP = t < 0.26 ? (t / 0.26) : 1;          // 1 → 0 during the tail
    const ease = (p) => 1 - Math.pow(1 - p, 3);      // ease-out cubic
    const alpha = (inP < 1 ? inP : 1) * outP;
    if (alpha <= 0) return;

    const CW = 332, CH = 72;                          // card size
    const cx = w / 2;
    const yRest = 16;                                 // resting top margin
    const yIn  = -CH - 10;                            // start above the top edge
    const slideIn  = yIn + (yRest - yIn) * ease(Math.min(1, inP));
    const slideOut = yRest - (1 - outP) * 26;         // drift up slightly as it fades
    const y = (inP < 1) ? slideIn : slideOut;
    const x = cx - CW / 2;

    const cream = (typeof COLORS !== 'undefined' && COLORS.cream) ? COLORS.cream : '#F2E9D0';
    const red   = (typeof COLORS !== 'undefined' && COLORS.red)   ? COLORS.red   : '#C8261C';

    ctx.save();
    ctx.globalAlpha = alpha;
    // Card body — dark slab + cream border + a red accent spine on the left.
    ctx.fillStyle = 'rgba(16, 14, 20, 0.93)';
    ctx.fillRect(x, y, CW, CH);
    ctx.fillStyle = red;
    ctx.fillRect(x, y, 4, CH);                        // accent spine
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cream;
    ctx.strokeRect(x + 0.5, y + 0.5, CW - 1, CH - 1);

    // Icon frame (left).
    const pad = 10, iconSz = CH - pad * 2;
    const ix = x + 14, iy = y + pad;
    ctx.strokeStyle = 'rgba(242, 233, 208, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ix - 0.5, iy - 0.5, iconSz + 1, iconSz + 1);
    if (c.img && c.img.complete && c.img.naturalWidth > 0) {
      try { ctx.drawImage(c.img, ix, iy, iconSz, iconSz); } catch (e) {}
    } else {
      // Fallback glyph: a small red diamond if the SVG hasn't decoded.
      ctx.fillStyle = red;
      ctx.beginPath();
      ctx.moveTo(ix + iconSz / 2, iy + 6);
      ctx.lineTo(ix + iconSz - 6, iy + iconSz / 2);
      ctx.lineTo(ix + iconSz / 2, iy + iconSz - 6);
      ctx.lineTo(ix + 6, iy + iconSz / 2);
      ctx.closePath();
      ctx.fill();
    }

    // Text block (right of icon).
    const tx = ix + iconSz + 14;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    // Label line — small, red, tracked.
    ctx.font = 'bold 10px monospace';
    ctx.fillStyle = red;
    ctx.fillText(c.label, tx, y + 26);
    // Title — bold cream.
    ctx.font = 'bold 19px sans-serif';
    ctx.fillStyle = cream;
    let title = c.title || '';
    // Trim overly long titles to fit the card width.
    const maxW = x + CW - tx - 12;
    if (ctx.measureText(title).width > maxW) {
      while (title.length > 1 && ctx.measureText(title + '…').width > maxW) title = title.slice(0, -1);
      title += '…';
    }
    ctx.fillText(title, tx, y + 50);
    // Thin progress-style underline that wipes in with the card.
    ctx.fillStyle = 'rgba(242, 233, 208, 0.25)';
    ctx.fillRect(tx, y + 58, maxW * (inP < 1 ? ease(inP) : 1), 2);
    ctx.restore();
  };

  // Register as a screen-space layer OVER the HUD (same space as killstreak).
  if (typeof registerFxLayer === 'function') {
    registerFxLayer({ id: 'achievement-unlock', space: 'overlay-over-hud', draw: window.renderAchievementFx });
  }
})();
