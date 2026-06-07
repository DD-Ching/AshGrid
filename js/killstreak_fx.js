// ============ KILLSTREAK ANNOUNCER (Phase 147) ============
// Game-feel / juice: the player-kill streak already exists (player._killStreak,
// set in bullets.js — proper 4s window + reset on death) and pays bonus score,
// but it had NO on-screen payoff. Arena shooters live on that "DOUBLE KILL!"
// dopamine, so this adds an escalating call-out banner + an ascending sting
// each time the streak crosses a tier. Pure feedback — no time-warp (the old
// slow-mo read as lag and ships off), no gameplay change, no balance guesswork.
//
// Self-contained + additive: it only READS player._killStreak each frame (works
// in any mode that increments it) and draws a screen-space banner. Wired in
// index.html as renderKillstreakFx() right after renderHUD().
//
// Classic-script. Declares global: renderKillstreakFx().
// External deps (call-time): player · game · ctx · W · H · COLORS · T · getLang ·
//   playRadioBeep · triggerShake

// Tiers — highest whose `at` <= current streak wins. Color + pitch escalate.
const _KS_TIERS = [
  { at: 2,  zh: '雙殺',     en: 'DOUBLE KILL',  col: '#F2E9D0' },
  { at: 3,  zh: '三殺',     en: 'TRIPLE KILL',  col: '#FFD24A' },
  { at: 4,  zh: '四殺',     en: 'MULTI KILL',   col: '#FFB23E' },
  { at: 5,  zh: '暴走',     en: 'RAMPAGE',      col: '#FF8C42' },
  { at: 6,  zh: '殺戮盛宴', en: 'KILLING SPREE',col: '#FF6A33' },
  { at: 7,  zh: '勢不可擋', en: 'UNSTOPPABLE',  col: '#FF3B30' },
  { at: 9,  zh: '神之領域', en: 'GODLIKE',      col: '#FF2419' },
  { at: 12, zh: '超越神',   en: 'BEYOND GODLIKE', col: '#FF1A4B' },
];
function _ksTier(ks) {
  let t = null;
  for (const tier of _KS_TIERS) { if (ks >= tier.at) t = tier; else break; }
  return t;
}

let _ksLastStreak = 0;
let _ksBanner = null;   // { text, sub, col, ttl, maxTtl }
const _KS_TTL = 66;     // ~1.1s on screen

function renderKillstreakFx() {
  if (typeof game === 'undefined' || game.state !== 'playing') { _ksLastStreak = 0; _ksBanner = null; return; }
  if (typeof player === 'undefined' || !player) return;

  const ks = player._killStreak || 0;

  // ── Detect a fresh tier crossing ─────────────────────────────────────
  if (ks < _ksLastStreak) _ksLastStreak = ks;          // streak ended → re-arm
  if (ks > _ksLastStreak && ks >= 2) {
    const tier = _ksTier(ks);
    if (tier) {
      const zh = (typeof getLang === 'function' && getLang() === 'zh');
      const bonus = ks * 25;                            // mirrors bullets.js streak bonus
      _ksBanner = {
        text: zh ? tier.zh : tier.en,
        sub:  `×${ks}  ·  +${bonus}`,
        col:  tier.col,
        ttl:  _KS_TTL, maxTtl: _KS_TTL,
      };
      // Ascending sting — pitch climbs with the streak (capped).
      if (typeof playRadioBeep === 'function') playRadioBeep(520 + Math.min(ks, 10) * 60, 0.16);
      // A little extra punch on the bigger milestones.
      if (typeof triggerShake === 'function') triggerShake(Math.min(2 + ks, 7), 7);
    }
    _ksLastStreak = ks;
  }

  // ── Draw the banner ──────────────────────────────────────────────────
  const b = _ksBanner;
  if (!b) return;
  const t = b.ttl / b.maxTtl;                           // 1 → 0
  // Pop in (first ~18%): scale 1.55 → 1.0 with overshoot; hold; fade last ~30%.
  const inP = Math.min(1, (1 - t) / 0.18);
  const scale = inP < 1 ? (1.55 - 0.55 * inP) : 1.0;
  const alpha = t > 0.30 ? 1 : (t / 0.30);

  const cx = W() / 2, cy = H() * 0.28;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.textAlign = 'center';
  // Heavy text with a dark backing stroke so it reads over any background.
  ctx.font = 'bold 38px sans-serif';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(16, 14, 20, 0.9)';
  ctx.strokeText(b.text, 0, 0);
  ctx.fillStyle = b.col;
  ctx.fillText(b.text, 0, 0);
  // Sub-line: streak count + bonus.
  ctx.font = 'bold 13px monospace';
  ctx.lineWidth = 3;
  ctx.strokeText(b.sub, 0, 22);
  ctx.fillStyle = (typeof COLORS !== 'undefined') ? COLORS.cream : '#F2E9D0';
  ctx.fillText(b.sub, 0, 22);
  ctx.restore();

  if (--b.ttl <= 0) _ksBanner = null;
}
