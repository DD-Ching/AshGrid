// ============ LOW-HP DANGER VIGNETTE (Phase 152) ============
// Stakes / drama, not reward juice. When you're nearly dead there was only
// radio chatter — nothing you FELT. This pulses a red screen-edge vignette that
// ramps (and beats faster) as HP falls below 35%, so a clutch moment reads as a
// clutch moment. Edges only, transparent in the centre, so the action stays
// clear. Drawn UNDER the HUD (the opaque corner panels sit on top).
//
// Self-contained, screen-space, read-only (player.hp). Classic-script.
// Declares global: renderDangerVignette().
// External deps (call-time): game · player · ctx · W · H

const _DANGER_TH = 0.35;     // vignette starts when hp drops under this fraction

function renderDangerVignette() {
  if (typeof game === 'undefined' || game.state !== 'playing') return;
  if (typeof player === 'undefined' || !player || !player.alive) return;
  const maxHp = player.maxHp || 100;
  const frac = (player.hp || 0) / maxHp;
  if (frac >= _DANGER_TH) return;

  const intensity = Math.min(1, (_DANGER_TH - frac) / _DANGER_TH);  // 0 → 1 as hp drops to 0
  // Heartbeat — beats faster and harder the worse it gets.
  const speed = 0.12 + intensity * 0.20;
  const pulse = 0.55 + 0.45 * Math.sin((game.time || 0) * speed);
  const a = intensity * pulse * 0.46;                               // cap edge alpha

  const w = W(), h = H();
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.30,
                                     w / 2, h / 2, Math.max(w, h) * 0.62);
  g.addColorStop(0, 'rgba(200, 30, 25, 0)');
  g.addColorStop(1, `rgba(200, 30, 25, ${a})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// Phase 155 — register as a screen-space layer UNDER the HUD (was hand-wired in
// render()). allocsPerFrame:true flags that this builds a CanvasGradient every
// frame while HP < 35% — visible here so a future pass can cache it.
if (typeof registerFxLayer === 'function') {
  registerFxLayer({ id: 'danger-vignette', space: 'overlay-under-hud',
                    draw: renderDangerVignette, allocsPerFrame: true });
}
