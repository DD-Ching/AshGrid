// ============ DEATH RECAP ============
// On player death, capture the kill context + flag the renderer to draw a
// full-screen "OPERATOR DOWN" overlay for ~2.5s (auto-dismiss). The overlay
// is visual only — pawn-swap (1-4) still works underneath so the player can
// jump bodies during the recap if they want to skip it.
//
// Classic-script. Declares globally:
//   _deathRecap (object — { active, killerCallsign, weaponLabel, distance, t })
//   triggerDeathRecap(killer, weaponLabel) · dismissDeathRecap()
//   renderDeathRecap()
//
// External deps: player · game · ctx · W · H · _r · COLORS ·
//   getOperatorName · drawHUDPanel

// On player death, capture the kill context + flag the renderer to draw a
// full-screen "OPERATOR DOWN" overlay for ~2.5s (auto-dismiss). The overlay
// is visual only — pawn-swap (1-4) still works underneath so the player can
// jump bodies during the recap if they want to skip it.
const _deathRecap = {
  active: false,
  startTick: 0,
  durationTicks: 150,         // 2.5s @ 60 TPS
  killer: null,
  killerCallsign: '',
  killerWeapon: '',
  killerX: 0, killerY: 0,
  victimX: 0, victimY: 0,
  distance: 0,
  lastHits: [],               // {dmg, weapon} for the 3 most recent hits
  adReviveUsed: false,        // one revive ad per match
  adReviveBtnRect: null,      // hit rect for the watch-ad button (canvas coords)
};

// Phase 3A: ad-revive ONLY when the whole blue team is wiped. A single
// death is no longer "you sit out + watch an ad" — the mission factory
// auto-pawn-swaps the operator into the nearest live ally. The ad shows
// only when there's no body left to swap into, and the entire squad
// revives together when the player watches it (or the 15-sec timer ends).
function _isBlueTeamWiped() {
  return !!(typeof game !== 'undefined' && game._teamWipe && game._teamWipe.blue && game._teamWipe.blue.wipedSince);
}

function _adRevivePlayer() {
  if (_deathRecap.adReviveUsed) return;
  if (!_isBlueTeamWiped()) return;     // gate: team-wipe only
  _deathRecap.adReviveUsed = true;
  const doRevive = () => {
    // Phase 10D: ad path revives the OPERATOR ALONE — squad stays dead,
    // player has to rebuild via recruit. Fall back to whole-team revive
    // only if the player-only helper doesn't exist (defensive — older
    // mission factories without Phase 10 plumbing).
    if (typeof game._arenaRevivePlayerOnly === 'function') {
      game._arenaRevivePlayerOnly();
    } else if (typeof game._arenaReviveTeam === 'function') {
      game._arenaReviveTeam('blue');
    } else if (player) {
      player.alive = true;
      player.hp = player.maxHp;
      player._respawnAt = null;
      // Phase 21: ad-revive invuln 90 → 180 ticks (3 s) to match the
      // rest of the spawn-shield set after user '無敵時間需增長'.
      player._invulnUntil = (game.time || 0) + 180;
    }
    dismissDeathRecap();
    if (typeof showSwapToast === 'function') {
      showSwapToast(_r('▶ 廣告收看完成 · 你獨自復活',
                       '▶ AD WATCHED · SOLO REVIVE'));
    }
  };
  if (typeof crazyAd_rewarded === 'function') {
    crazyAd_rewarded((ok) => { if (ok) doRevive(); else _deathRecap.adReviveUsed = false; });
  } else if (typeof requestRewardedAd === 'function') {
    requestRewardedAd('revive', (ok) => { if (ok) doRevive(); else _deathRecap.adReviveUsed = false; });
  } else {
    doRevive();   // dev fallback
  }
}

// Hit-test the ad-revive button on canvas mousedown.
function tryDeathRecapAdClick(x, y) {
  if (!_deathRecap.active || _deathRecap.adReviveUsed) return false;
  if (!_isBlueTeamWiped()) return false;
  const r = _deathRecap.adReviveBtnRect;
  if (!r) return false;
  if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
    _adRevivePlayer();
    return true;
  }
  return false;
}
function triggerDeathRecap() {
  // Skip in non-NN modes (campaign hands its own end card; killcam noise)
  if (!game._nnMode) return;
  _deathRecap.active = true;
  _deathRecap.adReviveBtnRect = null;
  _deathRecap.startTick = game.time;
  const k = player._killer;
  _deathRecap.killer = k;
  _deathRecap.killerCallsign = (k && k.callsign) || _r('敵方', 'ENEMY');
  _deathRecap.killerWeapon  = player._killerWeapon || '';
  _deathRecap.killerX = k ? k.x : player.x;
  _deathRecap.killerY = k ? k.y : player.y;
  _deathRecap.victimX = player.x;
  _deathRecap.victimY = player.y;
  _deathRecap.distance = k ? Math.hypot(k.x - player.x, k.y - player.y) : 0;
  // Snapshot last few damage events from the recent damage log if we have one
  _deathRecap.lastHits = (player._recentHits || []).slice(-3);
}
function dismissDeathRecap() { _deathRecap.active = false; }

function renderDeathRecap() {
  if (!_deathRecap.active) return;
  const elapsed = game.time - _deathRecap.startTick;
  if (elapsed >= _deathRecap.durationTicks) { _deathRecap.active = false; return; }
  const t = elapsed / _deathRecap.durationTicks;
  const fade = t < 0.15 ? (t / 0.15) : (t > 0.85 ? (1 - t) / 0.15 : 1);

  // Top strip + bottom hint instead of a full-screen blocker. The world
  // stays visible underneath so pawn-swap (1-4) can target a live ally
  // without the player guessing where everyone is. User: '不應該直接擋住
  // 介面,不然的話我在切換它自動切換人員的時候會不會直接擋住,沒有辦法玩'.
  const W_ = W(), H_ = H();
  ctx.save();
  ctx.globalAlpha = fade;

  // ---- Top strip: black bar with red accent rail + key data ----
  const stripH = 64;
  ctx.fillStyle = `rgba(20, 8, 8, 0.92)`;
  ctx.fillRect(0, 0, W_, stripH);
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(0, stripH - 4, W_, 4);
  // CRT scanlines on the strip only
  ctx.fillStyle = 'rgba(0, 0, 0, 0.20)';
  for (let y = 0; y < stripH; y += 4) ctx.fillRect(0, y, W_, 2);
  // Subtle red flicker corner
  if ((game.time & 6) < 3) {
    ctx.fillStyle = `rgba(200, 38, 28, 0.18)`;
    ctx.fillRect(0, 0, W_, 4);
  }
  // 'SIGNAL LOST' eyebrow — GREY VECTOR: cycle archived, not just death
  ctx.fillStyle = COLORS.red;
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  const _cyc = (typeof getCycleNum === 'function') ? getCycleNum() : 347;
  ctx.fillText(_r(`連結中斷 // CYCLE #${_cyc} ARCHIVED`,
                  `NEURAL LINK SEVERED // CYCLE #${_cyc} ARCHIVED`), 24, 18);
  // OPERATOR DOWN big
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(_r('V-07 倒下 — Mote 在等', 'V-07 DOWN — MOTE IS WAITING'), 24, 48);
  // Killer card on the right side of the strip
  const dist = Math.round(_deathRecap.distance);
  const weaponStr = _deathRecap.killerWeapon ? `${_deathRecap.killerWeapon} · ` : '';
  const killerLine = `${_r('被', 'BY')} ${_deathRecap.killerCallsign} · ${weaponStr}${dist}u`;
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = COLORS.cream;
  ctx.fillText(killerLine, W_ - 24, 28);
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = COLORS.red;
  ctx.fillText(_r('代號 · ' + getOperatorName(), 'CALLSIGN · ' + getOperatorName()), W_ - 24, 46);

  // ---- Bottom hint bar — strong red CTA telling the player WHAT TO DO ----
  // Pulses so it draws the eye, can't be missed mid-firefight. Bigger text
  // (16px bold) per user feedback '下面這個文字組線內容要更強勢一點'.
  const pulse = 0.7 + 0.3 * Math.sin(game.time * 0.18);
  const hintH = 56;
  ctx.fillStyle = `rgba(200, 38, 28, ${0.85 * pulse})`;
  ctx.fillRect(0, H_ - hintH, W_, hintH);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  // Phase 3A: while there are live teammates, the operator auto-swaps
  // (mission factory handles that BEFORE this recap even fires for that
  // case). So if the recap is up AND blue is wiped, we know the squad
  // really is gone — show countdown + ad button. Otherwise the recap is
  // just the kill-cam header for ~2.5 sec.
  if (_isBlueTeamWiped()) {
    const ticksLeft = Math.max(0, (game._teamWipe.blue.respawnAt || 0) - game.time);
    const sLeft = Math.ceil(ticksLeft / 60);
    // Hint text — overwrite the 1-4 prompt since there's no live teammate
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      _r(`▼ 全隊覆滅 — ${sLeft} 秒後重生 ▼`,
         `▼ SQUAD WIPED — RESPAWN IN ${sLeft}s ▼`),
      W_ / 2, H_ - hintH / 2 + 6,
    );
    // Watch-ad-to-skip button
    if (!_deathRecap.adReviveUsed) {
      const btnW = 320, btnH = 64;
      const btnX = W_ / 2 - btnW / 2;
      const btnY = H_ / 2 - btnH / 2 + 24;
      _deathRecap.adReviveBtnRect = { x: btnX, y: btnY, w: btnW, h: btnH };
      const pulse2 = 0.85 + 0.15 * Math.sin(game.time * 0.22);
      ctx.fillStyle = `rgba(63, 230, 63, ${pulse2})`;
      ctx.fillRect(btnX, btnY, btnW, btnH);
      ctx.strokeStyle = COLORS.black;
      ctx.lineWidth = 2;
      ctx.strokeRect(btnX, btnY, btnW, btnH);
      ctx.fillStyle = COLORS.black;
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText(_r('▶ 看廣告 · 全隊立即復活', '▶ WATCH AD · SQUAD REVIVE'),
                   W_ / 2, btnY + btnH / 2 + 4);
      ctx.font = 'bold 10px monospace';
      ctx.fillText(_r('(跳過倒數)', '(skip the countdown)'),
                   W_ / 2, btnY + btnH - 8);
    } else {
      _deathRecap.adReviveBtnRect = null;
    }
  } else {
    // Single death, allies alive — operator auto-swaps. Tell them.
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      _r('▼ 自動接管最近的隊友 · 按 1-4 手動切換 ▼',
         '▼ AUTO-SWAP TO NEAREST ALLY · 1-4 to override ▼'),
      W_ / 2, H_ - hintH / 2 + 6,
    );
    _deathRecap.adReviveBtnRect = null;
  }

  ctx.textAlign = 'left';
  ctx.restore();
}
