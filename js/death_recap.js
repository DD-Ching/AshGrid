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
    // Phase 60: bundle the 30-minute fast-respawn buff with the revive.
    // One ad watch = both benefits → higher perceived ad value, more
    // willing watches. Same rewarded ad, double payoff.
    if (typeof applyRespawnBuff === 'function') applyRespawnBuff();
    dismissDeathRecap();
    if (typeof showSwapToast === 'function') {
      showSwapToast(_r('▶ 廣告收看完成 · 復活 + 30 分鐘加成',
                       '▶ AD WATCHED · REVIVE + 30 MIN BUFF'));
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

// Phase 60: standalone buff-only ad. No revive, just the 30-min fast-respawn
// buff (5s instead of 15s). Used by the second button in the death recap
// that appears when the player is dead but NOT team-wiped (single death with
// allies still alive — most common scenario, can't trigger the revive button)
// AND the buff isn't already active.
function _adGrantRespawnBuff(onDone) {
  const finish = (ok) => {
    if (ok && typeof applyRespawnBuff === 'function') {
      applyRespawnBuff();
      if (typeof showSwapToast === 'function') {
        const mins = (typeof RESPAWN_BUFF_CONFIG === 'object') ? RESPAWN_BUFF_CONFIG.DURATION_MIN : 30;
        const buffed = (typeof RESPAWN_BUFF_CONFIG === 'object') ? RESPAWN_BUFF_CONFIG.BUFFED_SEC : 5;
        showSwapToast(_r(`▶ 加成生效 · ${mins} 分鐘 ${buffed} 秒復活`,
                         `▶ BUFF ON · ${buffed}s RESPAWN · ${mins} MIN`));
      }
    }
    if (typeof onDone === 'function') onDone(!!ok);
  };
  if (typeof crazyAd_rewarded === 'function') {
    crazyAd_rewarded(finish);
  } else if (typeof requestRewardedAd === 'function') {
    requestRewardedAd('respawn_buff', finish);
  } else {
    finish(true);   // dev fallback
  }
}

// Hit-test the ad buttons on canvas mousedown. Two possible buttons:
//   • adReviveBtnRect    — team-wipe scenario, "revive squad + buff"
//   • adBuffBtnRect      — Phase 60, single-death scenario, "buff only"
// Returns true if either was consumed so the caller doesn't fall through
// to dismissDeathRecap / fire.
function tryDeathRecapAdClick(x, y) {
  if (!_deathRecap.active) return false;
  // Revive button (team-wipe only, single-use per match).
  const rRevive = _deathRecap.adReviveBtnRect;
  if (rRevive && !_deathRecap.adReviveUsed && _isBlueTeamWiped()
      && x >= rRevive.x && x <= rRevive.x + rRevive.w
      && y >= rRevive.y && y <= rRevive.y + rRevive.h) {
    _adRevivePlayer();
    return true;
  }
  // Phase 60: buff-only button. Available whenever the buff isn't already
  // active (regardless of team-wipe). Doesn't consume the death recap —
  // player keeps watching the countdown / waiting for auto-swap.
  const rBuff = _deathRecap.adBuffBtnRect;
  if (rBuff
      && x >= rBuff.x && x <= rBuff.x + rBuff.w
      && y >= rBuff.y && y <= rBuff.y + rBuff.h
      && typeof isRespawnBuffed === 'function' && !isRespawnBuffed()) {
    _adGrantRespawnBuff();
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
  // Phase 30: while the blue team is wiped (i.e. respawn countdown is
  // active), KEEP the recap visible no matter how much time elapsed.
  // The 2.5-sec auto-dismiss was leaving a 0.5-sec dead window between
  // recap disappearing + respawn firing — user '倒數計時的圖片動畫並沒
  // 有出來 · 即便之後有廣告彈出, 動畫也不會消失'.
  const teamWiped = _isBlueTeamWiped();
  if (!teamWiped && elapsed >= _deathRecap.durationTicks) {
    _deathRecap.active = false;
    return;
  }
  // For the FADE math, cap t at 1 when wiped (recap stays full-opacity
  // for the whole countdown; no premature fade-out).
  const tRaw = elapsed / _deathRecap.durationTicks;
  const t = teamWiped ? Math.min(1, tRaw) : tRaw;
  const fade = teamWiped
    ? Math.min(1, tRaw / 0.15)     // fade in but never fade out while wiped
    : (t < 0.15 ? (t / 0.15) : (t > 0.85 ? (1 - t) / 0.15 : 1));

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
  // Phase 50: bottom-bar background is now FULLY opaque (was alpha-pulsing
  // 0.34→0.85). The pulse caused the SQUAD WIPED text to render behind a
  // half-transparent red and visually wash out when other UI (squad-order
  // chips, build pill, drone HUD) drew into the same area
  // (user report '倒時計時有時候會消掉不見'). The pulse is preserved as a
  // brightness wobble on the text colour instead.
  const pulse = 0.7 + 0.3 * Math.sin(game.time * 0.18);
  const hintH = 56;
  ctx.fillStyle = COLORS.red;
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
    // Watch-ad-to-skip button — Phase 60 copy bundles 30-min respawn buff
    // with the squad revive (single ad watch = both benefits).
    if (!_deathRecap.adReviveUsed) {
      const btnW = 360, btnH = 70;
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
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(_r('▶ 看廣告 · 全隊復活 + 30 分鐘加成',
                      '▶ WATCH AD · REVIVE + 30 MIN BUFF'),
                   W_ / 2, btnY + btnH / 2 - 2);
      ctx.font = 'bold 10px monospace';
      ctx.fillText(_r('(復活時間 15s → 5s,半小時)',
                      '(respawn 15s → 5s, half-hour)'),
                   W_ / 2, btnY + btnH - 10);
    } else {
      _deathRecap.adReviveBtnRect = null;
    }
    // Phase 60: hide the buff-only button in team-wipe — the bundled revive
    // button already grants the buff. Don't double-offer.
    _deathRecap.adBuffBtnRect = null;
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
    // Phase 60: buff-only button. Visible when buff isn't already active.
    // Compact, mid-right so it doesn't fight the auto-swap hint or the
    // top kill-cam strip. Player can ignore and let auto-swap handle the
    // death; if they tap it, ad fires + buff activates for 30 min.
    if (typeof isRespawnBuffed === 'function' && !isRespawnBuffed()) {
      const btnW = 280, btnH = 50;
      const btnX = W_ - btnW - 24;
      const btnY = H_ - hintH - btnH - 14;
      _deathRecap.adBuffBtnRect = { x: btnX, y: btnY, w: btnW, h: btnH };
      const pulse3 = 0.80 + 0.20 * Math.sin(game.time * 0.18);
      ctx.fillStyle = `rgba(255, 210, 74, ${pulse3})`;   // gold = buff
      ctx.fillRect(btnX, btnY, btnW, btnH);
      ctx.strokeStyle = COLORS.black;
      ctx.lineWidth = 2;
      ctx.strokeRect(btnX, btnY, btnW, btnH);
      ctx.fillStyle = COLORS.black;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(_r('▶ 看廣告 · 30 分鐘 5 秒復活',
                      '▶ WATCH AD · 5s RESPAWN · 30 MIN'),
                   btnX + btnW / 2, btnY + btnH / 2 - 1);
      ctx.font = 'bold 9px monospace';
      ctx.fillText(_r('(平常 15 秒)', '(default 15s)'),
                   btnX + btnW / 2, btnY + btnH - 8);
    } else {
      _deathRecap.adBuffBtnRect = null;
    }
  }

  // Phase 60: buff status badge in the top strip (between killer line and
  // callsign), shown when buff is currently active. Reminds the player the
  // bonus is running and how much time is left.
  if (typeof isRespawnBuffed === 'function' && isRespawnBuffed()
      && typeof getRespawnBuffMsLeft === 'function') {
    const msLeft = getRespawnBuffMsLeft();
    const mins = Math.floor(msLeft / 60000);
    const secs = Math.floor((msLeft % 60000) / 1000);
    const mmss = `${mins}:${String(secs).padStart(2, '0')}`;
    ctx.fillStyle = '#FFD24A';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(_r(`⚡ 加成 · 5s 復活 · ${mmss}`,
                    `⚡ BUFF · 5s RESPAWN · ${mmss}`),
                 W_ - 24, stripH - 8);
  }

  ctx.textAlign = 'left';
  ctx.restore();
}
