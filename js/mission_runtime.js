// ============ MISSION RUNTIME (Phase 185 — extracted from index.html) ========
// Mission lifecycle: instantiate from the factory registry, per-frame tick,
// success/fail handling, return-to-lobby, the NN match-end card + the
// match-unlock/tier strips, and retry. Lifted verbatim from the inline monolith
// (behaviour-preserving). Classic-script globals — callers (the update loop,
// kill.js, nn_deathmatch.js, lobby) unchanged. The STATE it uses (MISSIONS /
// mission [a reassigned let] / MISSION_FACTORIES) stays inline and is read +
// reassigned across scripts as a shared global binding at runtime.
//
// Declares globally: initMission · updateMission · onMissionSuccess ·
//   onMissionFailed · returnToNNLobby · showNNEndCard · retryCurrentMission ·
//   drawMatchTierUnlockStrip · drawMatchUnlockStrip.

function initMission(missionDef, mapDef) {
  const factory = MISSION_FACTORIES[missionDef.type];
  if (!factory) { mission = null; return; }
  mission = factory(mapDef);
  mission.type   = missionDef.type;
  mission.id     = missionDef.id;
  mission.status = 'active';
  mission.startFrame = game.time;
  // Mission-specific player spawn override — generateWorld puts the player
  // at the map's general spawn (e.g. far west of the reactor for room to
  // walk in), but defense-flavoured missions like 'hold' want the player
  // AT the objective so the 90 s clock isn't half-spent walking. User
  // report: '我还是被卡在地图外面' for the relay mission. Allies follow
  // suit so the squad doesn't end up 1100 u behind.
  if (mission.playerSpawn) {
    player.x = mission.playerSpawn.x;
    player.y = mission.playerSpawn.y;
    player._lastX = player.x; player._lastY = player.y;
    player._velX = 0; player._velY = 0;
    if (typeof spawnAllies === 'function') spawnAllies();
  }
  // Mission can pre-place friendly structures (e.g. relay defense gives the
  // player a generator + medstation already wired up — feels like defending
  // a real outpost, not a bare crystal in the middle of nowhere).
  if (mission.setupStructures) {
    if (typeof game._structures === 'undefined' || !game._structures) game._structures = [];
    // Campaign players need a starting build budget so they can immediately
    // start fortifying without waiting for kills to drip in energy. 200⚡
    // covers e.g. 1 turret (100) + 2 sandbag walls (60) before any kill.
    // User: '這個遊戲有關很大部分是跟建造有關,要讓玩家能體會到'.
    if (typeof game._energy === 'undefined') game._energy = 200;
    mission.setupStructures();
    if (typeof recomputePowerGrid === 'function') recomputePowerGrid();
    // First-time tutorial nudge — fires once across all sessions; gates on
    // ag.hintsSeen so veterans never see it after the first relay.
    if (typeof showStageHint === 'function') {
      setTimeout(() => showStageHint('build_now'), 1500);
    }
  }
}

function updateMission() {
  if (!mission || mission.status !== 'active') return;
  if (mission.update) mission.update();
  // Structures + battlefield FX tick in every NN mode (defense's factory
  // calls updateStructures redundantly — guard with a flag so we don't
  // double-tick when defense's update() runs first).
  if (game._nnMode && !game._structuresTickedThisFrame) {
    // Passive regen (0.5 → 2 → Phase 140: 3/sec) so a 90s DM yields ~270⚡.
    // With the 100⚡ match-start budget + per-kill bonus, the player can place
    // 1 turret + several walls in a single match — the Build skill is
    // reachable in normal play. Bumped again in Phase 140 because the
    // generator (the old way to accelerate income) was removed from the wheel
    // along with the power-supply mechanic, so passive trickle is now the
    // ONLY income besides kills. User: '充電太慢了' / '東西變少, 簡單一點'.
    // Phase 186 — wolf devour stacks add to the regen RATE (累加能量回复速度).
    // _wolfRegenStacks is set by the wolf's devour (arena_recruitment.js), 0 for
    // every other chassis / when classes off → no effect.
    let _regen = BALANCE.energy.regenPerSec;
    if (game._wolfRegenStacks && typeof BALANCE.wolf === 'object') {
      _regen += game._wolfRegenStacks * (BALANCE.wolf.devourRegenPerStack || 0);
    }
    addEnergy(_regen / 60);
    updateStructures();
    updateAirstrikes();
  }
  game._structuresTickedThisFrame = false;
  if (mission.isComplete && mission.isComplete()) {
    mission.status = 'success';
    onMissionSuccess();
  } else if (mission.isFailed && mission.isFailed()) {
    mission.status = 'failure';
    onMissionFailed();
  }
}

function onMissionSuccess() {
  // NN match: bump stats + open the persistent HTML end-card. No banner
  // (the canvas already drew MATCH RESULT during the 4s latch) and no
  // auto-return — the player decides PLAY AGAIN vs LOBBY.
  if (game._nnMode) {
    bumpMatchPlayed();
    playSfx('match_win');
    // Phase 108 — end-match interstitial DISABLED. User: '我看完這個
    // 廣告,我就死掉了' — the auto-firing video right after the win/lose
    // banner disorients the player. Only the explicit WATCH AD · REVIVE
    // click on the team-wipe overlay should ever trigger a full-screen
    // ad. gmEndMatch() is still defined but no longer invoked.
    showNNEndCard('win');
    return;
  }
  game.score += 800;
  game.missionRetries = 0; // reset retry counter on each successful mission
  showMessage(T(`任务完成 +800`, `Mission complete +800`), 200);
  game.waveBreak = 220;
}

// Mission failure now RETRIES the current mission (not the whole campaign).
// Allies and the player respawn full HP, the same map+objective is re-initialised.
// On the third failure of the same mission, the campaign ends.
function onMissionFailed() {
  // NN match: same flow as success — open the HTML end-card with the
  // appropriate result.
  if (game._nnMode) {
    bumpMatchPlayed();
    const tied = mission && mission.teamKills && mission.teamKills[0] === mission.teamKills[1];
    playSfx(tied ? 'match_start' : 'match_loss');
    // Phase 108 — end-match interstitial DISABLED on loss/draw (see win
    // path above for rationale). Only explicit WATCH AD · REVIVE click
    // fires the rewarded video.
    showNNEndCard(tied ? 'draw' : 'loss');
    return;
  }
  game.missionRetries = (game.missionRetries || 0) + 1;
  if (game.missionRetries >= 3) {
    showMessage(T(`任务三次失败 · 撤退`, `Mission failed 3× · retreat`), 200);
    setTimeout(() => endGame(false), 2200);
    return;
  }
  showMessage(T(`任务失败 · 重试 (${game.missionRetries}/3)`, `Mission failed · retry (${game.missionRetries}/3)`), 200);
  setTimeout(() => retryCurrentMission(), 1800);
}

function returnToNNLobby() {
  game._nnMode = false;
  game._skirmish = false;
  game.state = 'menu';
  bullets.length = 0;
  enemyBullets.length = 0;
  enemies.length = 0;
  allies.length = 0;
  soundEvents.length = 0;
  mission = null;
  game._buildPhase = null;   // Phase 161 — don't bleed a build phase into the menu/next match
  const lobby = document.getElementById('nnLobby');
  if (lobby) lobby.classList.remove('hidden');
  // Also surface the start screen so the player can switch modes / leave.
  // returnToNNLobby is now reachable directly from the end-card LOBBY
  // button, so we want the main lobby visible on top.
  document.getElementById('start')?.classList.remove('hidden');
  document.getElementById('nnEndCard') && (document.getElementById('nnEndCard').style.display = 'none');
}

// Populate + show the NN match-end card. Result = 'win' | 'loss' | 'draw'.
// Pulls stats off `mission` (kills, scoreline, time, mode); shows tier
// unlocks if the bumpMatchPlayed call crossed a threshold this match.
// PLAY AGAIN restarts the same mode immediately; LOBBY returns to menu.
function showNNEndCard(result) {
  // Phase 52 — Crazy Games SDK lifecycle. The end-card pause IS the
  // natural "between rounds" boundary, so signal gameplayStop now so the
  // portal can serve a midgame interstitial during the result screen.
  if (typeof crazyEvent_gameplayStop === 'function') crazyEvent_gameplayStop();
  const card = document.getElementById('nnEndCard');
  if (!card) return;
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const titleEl = document.getElementById('nnEndTitle');
  const tagEl   = document.getElementById('nnEndTag');
  const accent  = document.getElementById('nnEndAccent');
  const subEl   = document.getElementById('nnEndSubtitle');
  const killsEl = document.getElementById('nnEndKills');
  const scoreEl = document.getElementById('nnEndScore');
  const timeEl  = document.getElementById('nnEndTime');
  const gradeEl = document.getElementById('nnEndGrade');
  const unlocksEl = document.getElementById('nnEndUnlocks');
  // Result text + accent colour
  if (titleEl) {
    titleEl.textContent = result === 'win' ? (lang === 'zh' ? '胜利 · VICTORY' : 'VICTORY')
                       : result === 'loss' ? (lang === 'zh' ? '失败 · DEFEAT' : 'DEFEAT')
                                          : (lang === 'zh' ? '平手 · DRAW' : 'DRAW');
    titleEl.style.color = result === 'win' ? 'var(--red)' : (result === 'loss' ? 'var(--black)' : 'var(--gray)');
  }
  if (tagEl) tagEl.textContent = lang === 'zh' ? '— 对局结算 —' : '— MATCH RESULT —';
  if (accent) accent.style.background = result === 'win' ? 'var(--red)' : 'var(--black)';
  // Subtitle: mode + operator name
  const modeLabel = ({
    dm: 'DEATHMATCH', survival: 'SURVIVAL', defense: 'DEFENSE',
    helo: 'HELO EXTRACT', convoy: 'CONVOY', duel: 'DUEL', sniper: 'SNIPER',
  })[game._nnGameMode] || 'SKIRMISH';
  const opName = (typeof getOperatorName === 'function') ? getOperatorName() : '0451';
  if (subEl) subEl.textContent = `${modeLabel} · OPERATOR ${opName}`;
  // Stats
  const kills = game.killCount || 0;
  const tk = mission && mission.teamKills;
  const scoreline = tk ? `${tk[0]}–${tk[1]}` : `${kills}`;
  const startT = (mission && mission.startFrame) || 0;
  const sec = Math.floor((game.time - startT) / 60);
  if (killsEl) killsEl.textContent = String(kills);
  if (scoreEl) scoreEl.textContent = scoreline;
  if (timeEl)  timeEl.textContent  = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
  // Grade — same heuristic as the canvas card. WIN gets 0.6 base, scaled
  // by margin + carry; loss starts at 0.15.
  let s;
  if (tk) {
    const margin = (tk[0] - tk[1]);
    const winS = result === 'win' ? 0.6 : (result === 'draw' ? 0.4 : 0.15);
    const marginS = Math.max(-0.3, Math.min(0.3, margin / 12));
    const totalKills = tk[0] + tk[1];
    const carryS = totalKills > 0 ? 0.1 * (kills / totalKills) : 0;
    s = Math.max(0, Math.min(1, winS + marginS + carryS));
  } else {
    s = result === 'win' ? 0.7 : 0.3;
  }
  const grade = (typeof gradeFromScore === 'function') ? gradeFromScore(s) : { letter: 'B', color: '#888' };
  if (gradeEl) {
    gradeEl.textContent = grade.letter;
    gradeEl.style.color = (grade.letter === 'S' || grade.letter === 'A') ? 'var(--red)' : 'var(--black)';
  }
  // Unlocks (tier-cross + achievement chips)
  if (unlocksEl) {
    let html = '';
    const tierUnlocks = (typeof _lastMatchUnlocks !== 'undefined') ? _lastMatchUnlocks : [];
    const achvUnlocks = (typeof _matchAchievementUnlocks !== 'undefined') ? _matchAchievementUnlocks : [];
    if (tierUnlocks.length > 0) {
      html += `<div style="padding: 14px 0 8px; border-bottom: 2px solid var(--cream-dark);">`;
      html += `<div style="font:bold 9px monospace; letter-spacing:3px; color:var(--red); margin-bottom:8px;">✓ ${lang === 'zh' ? '解锁' : 'UNLOCKED'}</div>`;
      html += `<div style="display:flex; flex-wrap:wrap; gap:6px;">`;
      for (const u of tierUnlocks) {
        const label = (lang === 'zh' && u.zh) ? u.zh : (u.key || '').toUpperCase();
        html += `<span style="background:var(--red); color:var(--cream); padding:5px 12px; font:bold 11px sans-serif;">${label}</span>`;
      }
      html += `</div></div>`;
    }
    if (achvUnlocks.length > 0) {
      html += `<div style="padding: 14px 0 8px;">`;
      html += `<div style="font:bold 9px monospace; letter-spacing:3px; color:var(--black); margin-bottom:8px;">★ ${lang === 'zh' ? '本场成就' : 'ACHIEVEMENTS THIS MATCH'}</div>`;
      html += `<div style="display:flex; flex-wrap:wrap; gap:6px;">`;
      for (const a of achvUnlocks) {
        const label = (lang === 'zh') ? (a.title_zh || a.id) : (a.title_en || a.id);
        html += `<span style="background:var(--black); color:var(--cream); padding:5px 12px; font:bold 11px sans-serif;">${label}</span>`;
      }
      html += `</div></div>`;
    }
    unlocksEl.innerHTML = html;
  }
  // Wire buttons every show — replace handlers each time so they capture
  // the current game._nnGameMode in their closure.
  const againBtn = document.getElementById('nnEndAgainBtn');
  const lobbyBtn = document.getElementById('nnEndLobbyBtn');
  const lastMode = game._nnGameMode || 'dm';
  const playAgain = () => {
    card.style.display = 'none';
    if (typeof startNNSkirmish === 'function' && typeof _lobby !== 'undefined') {
      startNNSkirmish(_lobby.blue, _lobby.red, _lobby.difficulty, _lobby.weapon, null, lastMode);
    } else {
      returnToNNLobby();
    }
  };
  const backToLobby = () => {
    card.style.display = 'none';
    returnToNNLobby();
  };
  if (againBtn) againBtn.onclick = playAgain;
  if (lobbyBtn) lobbyBtn.onclick = backToLobby;
  // Keyboard shortcuts while the end-card is up:
  //   ENTER / SPACE  → play again (default action — matches the red CTA)
  //   ESC            → back to lobby
  // Bound to document so it fires regardless of which element has focus.
  // We unbind on dismissal so leaving the card doesn't leak the listener.
  if (showNNEndCard._keyHandler) {
    document.removeEventListener('keydown', showNNEndCard._keyHandler);
  }
  showNNEndCard._keyHandler = (e) => {
    if (card.style.display !== 'flex') return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      document.removeEventListener('keydown', showNNEndCard._keyHandler);
      showNNEndCard._keyHandler = null;
      playAgain();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      document.removeEventListener('keydown', showNNEndCard._keyHandler);
      showNNEndCard._keyHandler = null;
      backToLobby();
    }
  };
  document.addEventListener('keydown', showNNEndCard._keyHandler);
  // Also surface the shortcut hints in the buttons themselves (subtle,
  // small monospace appended) so the player learns them without a tooltip.
  if (againBtn && !againBtn._labeled) {
    const lang = (typeof getLang === 'function' && getLang() === 'zh') ? 'zh' : 'en';
    againBtn.innerHTML = (lang === 'zh' ? '再玩 ▶' : 'PLAY AGAIN ▶') +
                         '<span style="font:9px monospace; opacity:0.7; margin-left:6px;">[ENTER]</span>';
    againBtn._labeled = true;
  }
  if (lobbyBtn && !lobbyBtn._labeled) {
    const lang = (typeof getLang === 'function' && getLang() === 'zh') ? 'zh' : 'en';
    lobbyBtn.innerHTML = (lang === 'zh' ? '回大廳' : 'LOBBY') +
                         '<span style="font:9px monospace; opacity:0.7; margin-left:6px;">[ESC]</span>';
    lobbyBtn._labeled = true;
  }
  card.style.display = 'flex';
}

function retryCurrentMission() {
  if (game.state !== 'playing') return;
  // Reset combat state but keep score, kill count
  bullets.length = 0;
  enemyBullets.length = 0;
  enemies.length = 0;
  enemyDrones.length = 0;
  soundEvents.length = 0;
  squadIntel.fresh = 0;
  // Phase 129e — also clear the visual-residue arrays. Previously retry
  // left wreckages / explosions / muzzleFlashes / damagePopups from the
  // FAILED attempt in place — user reported '幽靈從開場就存在...感覺
  // 是資料沒清乾淨' (gray bots from opening). Wreckages of bots killed
  // in the failed run were still in their 8s decay window when retry
  // fired, so the player respawned into a battlefield littered with
  // last-attempt corpses.
  wreckages.length = 0;
  explosions.length = 0;
  muzzleFlashes.length = 0;
  damagePopups.length = 0;
  // Phase 135.2 — drop unfired entries from the previous attempt's spawn
  // queue, same rationale as startNextWave.
  if (game._pendingNNSpawns) game._pendingNNSpawns.length = 0;
  // Player respawns
  player.alive = true;
  player.hp = player.maxHp;
  player.ammo = player.maxAmmo;
  player.reserve = 120;
  player.reloading = false;
  player.gunRecoil = 0;
  drone.deployed = false;
  drone.battery = drone.maxBattery;
  fpv.active = false;
  fpv.available = fpv.max;
  if (game.mode === 'fpv' || game.mode === 'drone') game.mode = 'tactical';
  // Reload the same mission
  const missionDef = MISSIONS[game.wave - 1];
  generateWorld(missionDef.mapIdx);
  spawnAllies();
  initMission(missionDef, currentMap);
  spawnWave(game.wave);
  showMessage(`${T('重试', 'Retry')} · ${missionTitle(mission)}`, 150);
  game.waveBreak = 0;
}

// ============ MISSION FACTORIES ============
// Each mode registers `MISSION_FACTORIES.<modeId> = function(mapDef) {...}`
// from its own file. initMission() dispatches by missionDef.type.
//
// Currently registered (loaded via <script src="..."> in <head>):
//   nnDeathmatch  →  js/missions/nn_deathmatch.js  (endless arena)
//
// To add a new mode, create js/missions/<your_mode>.js following the same
// pattern, then add the <script> tag to index.html. See nn_deathmatch.js
// header for the full factory contract.

// Renders a big "TIER UNLOCK" callout when a match crosses one of the
// progression thresholds. Sits above the achievement strip so the player
// sees it first — that's the moment that makes the gating feel rewarding
// instead of arbitrary. Returns the y-offset consumed so the caller can
// stack the achievement strip below it.
function drawMatchTierUnlockStrip(cx, y, maxW) {
  if (!_lastMatchUnlocks || _lastMatchUnlocks.length === 0) return 0;
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const heading = (lang === 'zh') ? '✓ 解鎖' : '✓ UNLOCKED';
  ctx.save();
  // Card: red on cream with the same drop-shadow vibe as the match-end card
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  const items = _lastMatchUnlocks.map(u => (lang === 'zh') ? u.zh : u.key.toUpperCase());
  const padX = 14, gap = 8;
  const itemWidths = items.map(t => ctx.measureText(t).width + padX * 2);
  // Lay out, wrapping at maxW
  let line = []; let lineW = 0;
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    const w = itemWidths[i] + gap;
    if (lineW + w > maxW && line.length > 0) {
      lines.push({ items: line, w: lineW - gap });
      line = []; lineW = 0;
    }
    line.push({ title: items[i], w: itemWidths[i] });
    lineW += w;
  }
  if (line.length > 0) lines.push({ items: line, w: lineW - gap });
  // Heading
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(heading, cx, y + 12);
  // Pills
  const pillH = 22;
  let py = y + 22;
  for (const ln of lines) {
    let lx = cx - ln.w / 2;
    for (const it of ln.items) {
      // Drop shadow
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(lx + 3, py + 3, it.w, pillH);
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(lx, py, it.w, pillH);
      ctx.fillStyle = COLORS.cream;
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(it.title, lx + it.w / 2, py + 15);
      lx += it.w + gap;
    }
    py += pillH + 6;
  }
  ctx.restore();
  return py - y + 8;
}

// Renders a horizontal chip row underneath the match-end card listing every
// achievement the player unlocked THIS match. Each chip is "ACHV · TITLE"
// in a red pill. Skipped if the per-match unlock list is empty.
function drawMatchUnlockStrip(cx, y, maxW) {
  if (!_matchAchievementUnlocks || _matchAchievementUnlocks.length === 0) return;
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const heading = (lang === 'zh') ? '本場解鎖' : 'UNLOCKED THIS MATCH';
  ctx.save();
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(heading, cx, y);
  ctx.font = 'bold 11px sans-serif';
  let chipY = y + 14;
  // Pack chips on as many lines as needed
  const chipH = 18, chipPadX = 8;
  const titles = _matchAchievementUnlocks.map(a =>
    (lang === 'zh') ? a.title_zh : a.title_en);
  // Measure widths
  const chipWidths = titles.map(t => ctx.measureText(t).width + chipPadX * 2);
  // Lay out, wrapping at maxW
  let line = []; let lineW = 0;
  const lines = [];
  for (let i = 0; i < titles.length; i++) {
    const w = chipWidths[i] + 6;
    if (lineW + w > maxW && line.length > 0) {
      lines.push({ items: line, w: lineW - 6 });
      line = []; lineW = 0;
    }
    line.push({ title: titles[i], w: chipWidths[i] });
    lineW += w;
  }
  if (line.length > 0) lines.push({ items: line, w: lineW - 6 });
  for (const ln of lines) {
    let lx = cx - ln.w / 2;
    for (const ch of ln.items) {
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(lx, chipY, ch.w, chipH);
      ctx.fillStyle = COLORS.cream;
      ctx.textAlign = 'center';
      ctx.fillText(ch.title, lx + ch.w / 2, chipY + 13);
      lx += ch.w + 6;
    }
    chipY += chipH + 4;
  }
  ctx.restore();
}
