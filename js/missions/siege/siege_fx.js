// ============ SIEGE — FX layers (運鏡 / 背景 / HUD) ============
// The siege's screen-space dressing, all registerFxLayer'd and self-gated on
// game._siege so every layer is inert outside siege (other modes byte-identical):
//   • WEATHER (背景)   — wind/rain/storm streaks + storm lightning + dawn sunrise,
//                        driven by game._siege.weather + the TOD palette.
//   • HUD strip        — night pill + goal, the HEART HP bar, garrison-life pips,
//                        and the INTENT telegraph banner ("ARMOUR · NORTH GATE").
// The cinematic FOCUS (運鏡) is the siegeCine CAMERA_MODE (re-added in js/camera.js);
// the director's `camera` cues set game._cineFocus and that mode lerps the view.
//
// Classic-script. Call-time deps: game · ctx · W · H · COLORS · T · getLang ·
//   siegeFort · camera

// ── WEATHER (背景) — light motion streaks only; the TONE is the palette ───────
function renderSiegeWeather() {
  if (typeof game === 'undefined' || !game._siege || game.state !== 'playing') return;
  if (typeof ctx === 'undefined' || !ctx) return;
  const s = game._siege;
  const w = s.weather || 'clear';
  const W_ = (typeof W === 'function') ? W() : 800;
  const H_ = (typeof H === 'function') ? H() : 600;
  const t = (typeof game.time === 'number') ? game.time : 0;
  if (w === 'clear') return;          // the scene TONE is the palette's job — nothing to overlay
  ctx.save();
  // WIND/RAIN/STORM here is light MOTION only (thin streaks). The cool/desaturated/
  // dark TONE is carried by the scene palette via siege_director._siegeApplyAtmosphere
  // (the whole scene retints), NOT a translucent tone mask — per the owner's ask.
  if (w === 'wind') {
    ctx.strokeStyle = 'rgba(200, 195, 175, 0.10)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < 26; i++) {
      const seed = i * 51.7;
      const x = (seed * 17 + t * 34) % (W_ + 60) - 30;
      const y = (seed * 37) % H_;
      ctx.moveTo(x, y); ctx.lineTo(x - 18, y + 2);
    }
    ctx.stroke();
  } else if (w === 'rain' || w === 'storm') {
    const count = (w === 'storm') ? 80 : 50;
    ctx.strokeStyle = (w === 'storm') ? 'rgba(190,205,225,0.16)' : 'rgba(175,195,215,0.13)';
    ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const seed = i * 73.13;
      const x = (seed * 13 + t * 9) % (W_ + 40) - 20;
      const y = (seed * 29 + t * 26) % (H_ + 40) - 20;
      ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 14);
    }
    ctx.stroke();
    if (w === 'storm') {                // lightning — a brief flash, not a steady mask
      const f = Math.sin(t * 0.013) * Math.sin(t * 0.071);
      if (f > 0.985) {
        ctx.fillStyle = 'rgba(230,240,255,' + ((f - 0.985) / 0.015 * 0.30).toFixed(3) + ')';
        ctx.fillRect(0, 0, W_, H_);
      }
    }
  }
  ctx.restore();
}

// ── HUD strip (night · goal · HEART · garrison · INTENT) ─────────────────────
const _SIEGE_GATE_LABEL = {
  N: { zh: '北門',   en: 'NORTH GATE' },
  E: { zh: '東翼',   en: 'EAST POSTERN' },
  S: { zh: '南崩口', en: 'SOUTH COLLAPSE' },
  W: { zh: '西門',   en: 'WEST SALLY' },
};
const _SIEGE_THREAT_LABEL = {
  armour: { zh: '重裝甲集結', en: 'ARMOUR MASSING' },
  air:    { zh: '空襲逼近',   en: 'AIR INBOUND' },
  mass:   { zh: '步兵壓上',   en: 'INFANTRY MASSING' },
};

function renderSiegeHud() {
  if (typeof game === 'undefined' || !game._siege || game.state !== 'playing') return;
  if (typeof ctx === 'undefined' || !ctx) return;
  const s = game._siege;
  const zh = (typeof getLang === 'function' && getLang() === 'zh');
  const W_ = (typeof W === 'function') ? W() : 800;
  const cream = (typeof COLORS !== 'undefined' && COLORS.cream) ? COLORS.cream : '#F2E9D0';
  const red = (typeof COLORS !== 'undefined' && COLORS.red) ? COLORS.red : '#C8261C';
  const t = (typeof game.time === 'number') ? game.time : 0;

  // Top-centre pill — 守城 · 第 N 夜 · <goal>
  const night = s.night || 1;
  const goalTxt = s.goal ? (zh ? s.goal.zh : s.goal.en) : '';
  const main = (zh ? ('守城 · 第 ' + night + ' 夜') : ('SIEGE · NIGHT ' + night))
             + (goalTxt ? '  ·  ' + goalTxt : '');
  const cx = W_ / 2, y = 2, h = 30;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = 'bold 13px sans-serif';
  const tw = Math.max(160, ctx.measureText(main).width + 40);
  ctx.fillStyle = 'rgba(16,14,20,0.82)'; ctx.fillRect(cx - tw / 2, y, tw, h);
  ctx.fillStyle = red; ctx.fillRect(cx - tw / 2, y, 3, h);
  ctx.strokeStyle = cream; ctx.lineWidth = 1; ctx.strokeRect(cx - tw / 2 + 0.5, y + 0.5, tw - 1, h - 1);
  ctx.fillStyle = cream; ctx.fillText(main, cx, y + 14);

  // Sub-line — HEART HP bar + garrison pips.
  // Read the PER-RUN fort (game._siege.fort), NEVER the stale module-global
  // siegeFort() — a fresh siege's fort is null until buildSiegeFort runs, and a
  // null heart must read as 100% (full), not last run's depleted value.
  const f = s.fort || null;
  const heart = f ? f.heart : null;
  const heartMax = (heart && heart.maxHp) ? heart.maxHp : 1200;
  const hpPct = heart ? Math.max(0, Math.min(1, heart.hp / heartMax)) : 1;
  const barW = Math.min(tw - 14, 200), barH = 12, barX = cx - barW / 2, barY = y + h + 4;
  const low = hpPct <= 0.3;
  // Urgency pulse below 30% — the lose-condition bar must read as "core dying", not a bug.
  const pulseA = low ? (0.55 + 0.45 * Math.abs(Math.sin(t * 0.18))) : 1;
  ctx.fillStyle = 'rgba(16,14,20,0.7)'; ctx.fillRect(barX - 2, barY - 2, barW + 4, barH + 4);
  ctx.globalAlpha = pulseA;
  ctx.fillStyle = hpPct > 0.5 ? '#5FD6A0' : (hpPct > 0.3 ? '#E8B84B' : red);
  ctx.fillRect(barX, barY, barW * hpPct, barH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = low ? red : cream; ctx.lineWidth = low ? 2 : 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
  // Absolute value + % so the readout is trustworthy (a bare % read like a glitch).
  const heartLabel = (zh ? '核心 ' : 'HEART ') + Math.round(hpPct * 100) + '%'
    + (heart ? '  ' + Math.max(0, Math.round(heart.hp)) + '/' + Math.round(heartMax) : '');
  ctx.font = 'bold 9px monospace'; ctx.fillStyle = low ? red : cream; ctx.textAlign = 'left';
  ctx.fillText(heartLabel, barX, barY + barH + 10);
  // garrison-life pips
  const lives = (s.livesLeft != null) ? s.livesLeft : 0;
  ctx.textAlign = 'right';
  const pips = '◆'.repeat(Math.min(Math.max(0, lives), 8));
  if (s.autopilot) { ctx.fillStyle = red; ctx.fillText(zh ? '自動防禦' : 'AUTOPILOT', barX + barW, barY + barH + 10); }
  else { ctx.fillStyle = '#5FD6A0'; ctx.fillText((zh ? '駐軍 ' : 'GARRISON ') + pips, barX + barW, barY + barH + 10); }

  // opt R9 — CORE UNDER ATTACK telegraph: a red unit is ON the Heart. The
  // lose-condition under threat is the most urgent read, so it pre-empts the
  // INTENT axis banner below.
  const _heartThreatened = s._heartThreatUntil && t < s._heartThreatUntil;
  if (_heartThreatened) {
    const cp = 0.45 + 0.55 * Math.abs(Math.sin(t * 0.3));
    const warn = zh ? '⚠ 核心受襲 — 守住核心！' : '⚠ CORE UNDER ATTACK';
    ctx.textAlign = 'center';
    ctx.font = 'bold 15px sans-serif';
    const ww = ctx.measureText(warn).width + 32;
    const wy = barY + barH + 18;
    ctx.globalAlpha = cp;
    ctx.fillStyle = 'rgba(40,8,6,0.92)'; ctx.fillRect(cx - ww / 2, wy, ww, 22);
    ctx.fillStyle = red; ctx.fillText(warn, cx, wy + 15);
    ctx.globalAlpha = 1;
  }

  // INTENT telegraph banner — pulsing red, names the threat axis.
  if (!_heartThreatened && s.intent && t < s.intent.until) {
    const gl = _SIEGE_GATE_LABEL[s.intent.gate] || _SIEGE_GATE_LABEL.N;
    const th = _SIEGE_THREAT_LABEL[s.intent.threat] || _SIEGE_THREAT_LABEL.mass;
    const warn = '⚠ ' + (zh ? (th.zh + ' · ' + gl.zh) : (th.en + ' · ' + gl.en));
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 0.12));
    ctx.textAlign = 'center';
    ctx.font = 'bold 15px sans-serif';
    const ww = ctx.measureText(warn).width + 32;
    const wy = barY + barH + 18;
    ctx.fillStyle = 'rgba(40,8,8,' + (0.8 * pulse).toFixed(2) + ')';
    ctx.fillRect(cx - ww / 2, wy, ww, 24);
    ctx.strokeStyle = red; ctx.lineWidth = 2; ctx.strokeRect(cx - ww / 2 + 1, wy + 1, ww - 2, 22);
    ctx.fillStyle = 'rgba(255,210,200,' + pulse.toFixed(2) + ')';
    ctx.fillText(warn, cx, wy + 16);
  }
  ctx.restore();
}

// ── Register the layers (self-gated on game._siege; inert in every other mode) ──
if (typeof registerFxLayer === 'function') {
  registerFxLayer({ id: 'siege-weather', space: 'overlay-under-hud',
                    when: () => typeof game !== 'undefined' && !!game._siege,
                    draw: renderSiegeWeather, allocsPerFrame: true });
  registerFxLayer({ id: 'siege-hud', space: 'overlay-over-hud',
                    when: () => typeof game !== 'undefined' && !!game._siege,
                    draw: renderSiegeHud });
}
