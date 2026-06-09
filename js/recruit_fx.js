// ============ RECRUIT CELEBRATION (Phase 148) ============
// The arena's core loop is kill → KO → walk up → G → the enemy JOINS your
// squad. That conversion is THE progression beat (see project_arena_recruitment
// memory), but it only got a small toast + radio static. This makes it land:
// a green call-out with the new SQUAD ×N count (the "my army is growing"
// dopamine) + a rising 3-note sting. Pure feedback — the conversion logic in
// arena_recruitment.js is untouched; it just calls triggerRecruitFx() after
// pushing the new ally.
//
// Self-contained, screen-space, sits below the killstreak banner so the two
// never collide. Classic-script. Declares globals:
//   triggerRecruitFx(name) · renderRecruitFx()
// External deps (call-time): game · allies · ctx · W · H · COLORS · T ·
//   getLang · playRadioBeep

let _rfxBanner = null;            // { name, squad, ttl, maxTtl }
// Phase 156 — TTL ticked in updateRecruitFx() (84 Hz sim step), not render(), so
// it lasts the same wall-time on any display. 118 ticks ≈ 1.4s at 84 Hz — a beat
// longer than the killstreak banner; it's a milestone.
const _RFX_TTL = 118;

function triggerRecruitFx(name) {
  const squad = (typeof allies !== 'undefined' && Array.isArray(allies))
    ? allies.filter(a => a && a.alive).length : 0;
  _rfxBanner = { name: name || 'UNIT', squad, ttl: _RFX_TTL, maxTtl: _RFX_TTL };
  // Rising arpeggio — a positive "joined up" sting, distinct from the kill beep.
  if (typeof playRadioBeep === 'function') {
    playRadioBeep(600, 0.16);
    setTimeout(() => { if (typeof playRadioBeep === 'function') playRadioBeep(780, 0.16); }, 85);
    setTimeout(() => { if (typeof playRadioBeep === 'function') playRadioBeep(960, 0.18); }, 170);
  }
}

// State mutation — once per sim tick (called from update()): age the banner so
// its lifetime is display-independent.
function updateRecruitFx() {
  if (typeof game !== 'undefined' && game.state !== 'playing') { _rfxBanner = null; return; }
  if (_rfxBanner && --_rfxBanner.ttl <= 0) _rfxBanner = null;
}

// Read-only draw — once per render frame (no state mutation).
function renderRecruitFx() {
  if (typeof game !== 'undefined' && game.state !== 'playing') return;
  const b = _rfxBanner;
  if (!b || typeof ctx === 'undefined') return;

  const t = b.ttl / b.maxTtl;                          // 1 → 0
  const inP = Math.min(1, (1 - t) / 0.20);             // pop-in over first 20%
  const scale = inP < 1 ? (1.4 - 0.4 * inP) : 1.0;
  const alpha = t > 0.30 ? 1 : (t / 0.30);
  const rise = (1 - inP) * 14;                         // slide up slightly as it pops

  // Ally-teal (the build wheel's friendly/recon hue, brightened) — clearly NOT
  // enemy-red, reads as "on your side". The palette has no green token by design.
  const green = '#5FD6A0';
  const cream = (typeof COLORS !== 'undefined') ? COLORS.cream : '#F2E9D0';
  const zh = (typeof getLang === 'function' && getLang() === 'zh');

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(W() / 2, H() * 0.42 + rise);
  ctx.scale(scale, scale);
  ctx.textAlign = 'center';

  // Line 1 — RECRUITED · CALLSIGN
  const head = zh ? ('✓ 招降 · ' + b.name) : ('✓ RECRUITED · ' + b.name);
  ctx.font = 'bold 22px sans-serif';
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(16, 14, 20, 0.9)';
  ctx.strokeText(head, 0, 0);
  ctx.fillStyle = green;
  ctx.fillText(head, 0, 0);

  // Line 2 — the army count ticking up (the actual payoff).
  const squadTxt = zh ? ('小隊 ×' + b.squad) : ('SQUAD ×' + b.squad);
  ctx.font = 'bold 30px monospace';
  ctx.lineWidth = 5;
  ctx.strokeText(squadTxt, 0, 30);
  ctx.fillStyle = cream;
  ctx.fillText(squadTxt, 0, 30);

  ctx.restore();
}

// Phase 155 — register as a screen-space layer OVER the HUD (was hand-wired in
// render()), after killstreak so the two never collide.
if (typeof registerFxLayer === 'function') {
  registerFxLayer({ id: 'recruit', space: 'overlay-over-hud', draw: renderRecruitFx });
}
