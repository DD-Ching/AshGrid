// ============ NN ENDLESS ARENA (mission factory) ============
// Wings.io / Slither.io style — no match start, no match end. You spawn in,
// you fight, you die, you respawn 5 seconds later, you keep going. The
// only score is your running K/D + current squad size (from recruitment).
// Per user direction: '沒有一開始跟結束 ... 死掉是等復活,然後就全部都在
// 一個伺服器裡面的概念'.
//
// === MODULE PATTERN — HOW TO ADD A NEW MODE ===
// 1. Copy this file to js/missions/<your_mode>.js
// 2. Change the registration line:
//      MISSION_FACTORIES.<yourMode> = function(mapDef) { ... }
// 3. Replace the update()/renderHUD()/isComplete()/isFailed() implementations
// 4. Add <script src="js/missions/<your_mode>.js"></script> to index.html's
//    <head> after this file
// 5. Wire the new mode into the lobby (_lobby.mode dropdown or NN button)
// 6. initMission() at index.html dispatches by missionDef.type
//    → factory(mapDef) returns the mission object
//
// Factory contract (what the returned object must provide):
//   title / titleEn   string                — top-of-HUD label
//   objective         string                — sub-label
//   update()          () => void            — called every frame
//   renderHUD()       () => void            — called after world render
//   isComplete()      () => boolean         — win condition (true = victory)
//   isFailed()        () => boolean         — loss condition (true = defeat)
//   onPlayerBulletHit(b)  (bullet) => bool  — optional, swallow custom hits
//   onEnemyBulletHit(b)   (bullet) => bool  — optional
//   getRunSummary()   () => {wave, kills, style} — for the run-log card
//
// All external dependencies (game, player, allies, enemies, T, _r, playSfx,
// WEAPONS, NN, etc.) are resolved at runtime from the global scope — same
// classic-script pattern the rest of the codebase uses.

// ---------- MISSION 1: CONVOY ESCORT ----------
// ---------- NN ENDLESS ARENA (was Deathmatch) ----------
// Wings.io / Slither.io style — no match start, no match end. You spawn in,
// you fight, you die, you respawn 5 seconds later, you keep going. The
// only score is your running K/D + current squad size (from recruitment).
// Per user direction: '沒有一開始跟結束 ... 死掉是等復活,然後就全部都在
// 一個伺服器裡面的概念'.
// Defensive: ensure the registry exists. Script load order puts this file
// BEFORE the main inline script (which used to declare MISSION_FACTORIES),
// so we create the registry on window if it isn't there yet. The main
// script's declaration was changed to also use window.MISSION_FACTORIES so
// both sides cooperate.
window.MISSION_FACTORIES = window.MISSION_FACTORIES || {};
MISSION_FACTORIES.nnDeathmatch = function(mapDef) {
  // Per-unit "you died, wait this long" timer. Used when the team is NOT
  // wiped — the rest of the squad keeps fighting while a dead bot cools.
  // Spawn-relay (Phase 3B): when a team's relay is destroyed, this timer
  // is replaced by a longer one for that team. Set base low so squad
  // wipes are the real penalty.
  const RESPAWN_TICKS         = 5 * 60;   // 5 sec when relay alive
  const RESPAWN_TICKS_NO_SP   = 20 * 60;  // 20 sec when relay destroyed
  // Phase 3A: team-wipe state. When a whole team is 0-alive, halt
  // individual respawns and start a longer countdown. During the
  // countdown the ad-revive button is the only way to skip the wait.
  // Phase 49 (user: '縮短成15秒 / 顯示廣告狀態下的話只需要五秒'):
  //   • Default no-ad wait: 15 s (was 30).
  //   • While the WATCH-AD button is on offer (i.e. !_deathRecap.adReviveUsed),
  //     wait shrinks to 5 s — incentivises the ad-watcher path; the player
  //     just sees a quick countdown rather than a chore.
  //   • Once the ad has been used in this match, button disappears and the
  //     subsequent wipe falls back to the 15 s default.
  // Phase 94 — team-wipe wait time now mirrors getRespawnSeconds() so
  // it matches the user's ad-buff mental model:
  //   default (no ad watched)   → 15s wait
  //   30-min buff active        → 5s wait
  // Old code used a separate 'ad CTA visible' flag which made FRESH
  // sessions revive in 5s simply because the green Watch Ad button
  // happened to be on screen — opposite of what the user expected.
  const TEAM_WIPE_TICKS         = 15 * 60;  // legacy default kept as fallback
  const TEAM_WIPE_TICKS_AD_OPEN =  5 * 60;  // legacy buffed kept as fallback
  function _wipeWaitTicks() {
    if (typeof getRespawnSeconds === 'function') {
      return Math.round(getRespawnSeconds() * 60);
    }
    const adOpen = (typeof _deathRecap !== 'undefined') && !_deathRecap.adReviveUsed;
    return adOpen ? TEAM_WIPE_TICKS_AD_OPEN : TEAM_WIPE_TICKS;
  }
  const startTick = game.time;
  const teamKills = [0, 0];               // [blue, red] — running totals, never resets
  let lastBlueAlive = -1, lastRedAlive = -1;
  // Phase 9: escalating red waves. User feedback '敵人會越來越多 一波一波
  // 越來越密集 不會一個一個生成'. Red side stops doing per-unit respawn —
  // instead we run a wave clock: every WAVE_INTERVAL ticks, drop WAVE_SIZE
  // fresh NN bots at the red spawn anchor (with stand-off jitter). Both
  // numbers escalate with wave count; hard-capped by ENEMY_HARD_CAP so the
  // CPU + the player both survive past wave 10.
  let _waveNum = 0;
  let _nextWaveAt = game.time + 6 * 60;   // first reinforcement at +6 sec
  // Phase 161 — periodic BUILD PHASE (SOLO only). Opens a short fortify window
  // on its own cadence (decoupled from the wave clock so it stays sane once
  // late-game waves are only ~6s apart). The window grants free covers
  // (placeBuildBlock) + a small energy stipend, and surfaces the two
  // rewarded-ad buttons (+2 covers / skip wave). MP build is server-driven, so
  // this never opens online.
  // NOTE: game.time advances at the SIM tick rate (_timeScale 1.4 → 84 ticks/s,
  // see index.html), NOT 60 — a "seconds" value must be sec*84. Phase 161
  // shipped these as sec*60, so every build window ran ~30% shorter than its
  // label (worsening the known "build window too short" complaint). Rescaled to
  // sec*84 to match the labels — same convention Phase 156 used for FX TTLs.
  const BUILD_PERIOD = 45 * 84;           // a fortify window every 45 s
  const BUILD_WINDOW = 12 * 84;           // each window stays open 12 s
  let _nextBuildPhaseAt = game.time + 30 * 84;   // first window at +30 s
  function _waveInterval(n) {
    // 15s → 6s over the first 10 waves, then floor at 6s.
    return Math.max(360, 900 - n * 60);
  }
  function _waveSize(n) {
    // 3 → 8 over the first 10 waves, then capped.
    return Math.min(8, 3 + Math.floor(n / 2));
  }
  const ENEMY_HARD_CAP = 16;              // simultaneous live red enemies
  function _spawnRedWave() {
    if (typeof _arenaSpawnFactoryBot !== 'function') return;
    if (typeof game._nnSpawnRed === 'undefined' || !game._nnSpawnRed) return;
    // Phase 1 ?nonn=1 — wave spawner short-circuits when bots are disabled
    // for the MP diagnostic mode. Without this gate, even with redSize=0
    // at spawn, the first wave tick (~15s in) refills the arena with
    // factory bots — user reported '機器人不會動 並非消失' because the
    // wave spawner had no nonn check, only nnTick did.
    if (game._nnNoBots) return;
    // Phase 18: KO-stunned enemies don't count toward the cap — they're
    // frozen / neutralized and waiting to be recruited, so we shouldn't
    // let the wave system see them as 'active threats' or it'd stall.
    const alive = enemies.filter(e => e && e.alive && !e._koStunned).length;
    if (alive >= ENEMY_HARD_CAP) return;
    const room = ENEMY_HARD_CAP - alive;
    const n = Math.min(_waveSize(_waveNum), room);
    // Phase 135.1 — instead of cycling _nnSpawnRedList (typically 1-2
    // anchors all on the right side, which produced the user's '一堆
    // 從同樣地方走出來,走向同一個地方' complaint), use the same 4-edge
    // round-robin as the initial spawn via pickBiasedSpawn('nnArena').
    // Each call increments the round-robin index via enemies.length so
    // subsequent spawns within this wave naturally rotate N→E→S→W.
    for (let i = 0; i < n; i++) {
      const sp = pickBiasedSpawn('nnArena');
      _arenaSpawnFactoryBot('red', sp.x, sp.y);
    }
    _waveNum++;
    if (typeof showSwapToast === 'function') {
      showSwapToast(T(`▶ 增援波 #${_waveNum} · 紅方 +${n}`,
                      `▶ WAVE #${_waveNum} · RED +${n}`));
    }
  }
  // Mounted on game._teamWipe so other modules (death_recap, HUD, ad
  // button) can read state without coupling to this factory closure.
  game._teamWipe = game._teamWipe || {};
  game._teamWipe.blue = { wipedSince: null, respawnAt: null };
  game._teamWipe.red  = { wipedSince: null, respawnAt: null };
  // Helper to read the spawn relay's HP for a team. Returns null if
  // structures aren't loaded yet (early ticks); callers treat null as
  // "intact" (use the short timer). Spawn-relay structures get tagged
  // _isSpawnRelay + _team during world gen in Phase 3B.
  function _spawnRelayAlive(team) {
    if (!game._structures) return true;
    for (const s of game._structures) {
      if (s && s._isSpawnRelay && s._team === team) return (s.hp || 0) > 0;
    }
    return true;   // no relay placed yet — treat as alive
  }
  // Instantly revive an entire team. Called at end of team-wipe countdown
  // OR by the watch-ad button (death_recap.js). Resets every unit to full
  // HP/armor + spawn-point positions.
  function _reviveTeam(team) {
    const state = game._teamWipe[team];
    if (!state) return;
    state.wipedSince = null;
    state.respawnAt  = null;
    state.respawnRequested = false;   // Phase 183 — served; next wipe must re-request (SPACE)
    const units = team === 'blue'
      ? (player ? [player, ...allies] : allies.slice())
      : enemies.slice();
    // Phase 180d — respawn the team AT the team spawn, not in place at the death
    // spot. _reviveTeam used to leave x/y untouched, so the squad popped back
    // exactly where it fell ('probably surrounded by red'), contradicting the
    // 'RESPAWN AT BLUE BASE' HUD + the killcam press-SPACE that now triggers it.
    // SOLO-only: in MP the local player's position is server-authoritative
    // (reconcile would fight a client-side teleport), so MP keeps the old
    // alive/hp resets without repositioning.
    const _soloRevive = (typeof _mpState === 'undefined' || !_mpState || !_mpState.enabled);
    const spawnList = team === 'blue'
      ? (game._nnSpawnBlueList || (game._nnSpawnBlue ? [game._nnSpawnBlue] : null))
      : (game._nnSpawnRedList  || (game._nnSpawnRed  ? [game._nnSpawnRed]  : null));
    const _hasClamp = (typeof clampToArenaX === 'function' && typeof clampToArenaY === 'function');
    let spawnCursor = 0;
    for (const u of units) {
      if (!u) continue;
      u.alive = true;
      u.hp = u.maxHp;
      if (u.maxArmor > 0) u.armor = u.maxArmor;
      u._respawnAt = null;
      // Phase 102 — 3s spawn protection. User '復活要復活是要有三秒的
      // 無敵時間, 不要一復活就被秒殺, 再重新倒數'. Standardise on 180
      // ticks across ALL respawn / swap / revive paths to match server
      // INVULN_TICKS and prevent the kill→countdown→kill loop.
      u._invulnUntil = game.time + 180;
      u._nnFireCd = 0; u._nnRecentDmg = 0;
      // Phase 102 — clear chain-takeover consumed flag so ex-op slots
      // come back as live teammates after the team-wipe bulk respawn.
      u._consumed = false;
      // Phase 180d — reposition to a cycled spawn point (y-jitter + arena clamp),
      // mirroring the per-unit respawn path (_nextBlueSpawn). SOLO only.
      if (_soloRevive && spawnList && spawnList.length) {
        const sp = spawnList[spawnCursor % spawnList.length];
        spawnCursor++;
        if (sp) {
          const jy = sp.y + (Math.random() - 0.5) * 60;
          u.x = _hasClamp ? clampToArenaX(sp.x, 30, 30) : sp.x;
          u.y = _hasClamp ? clampToArenaY(jy, 30, 30) : jy;
        }
      }
    }
  }
  // Exposed so death_recap.js (ad-revive button) can call.
  game._arenaReviveTeam = _reviveTeam;

  // Phase 10D (user: '看完廣告復活之後 你當然也就是只有一個人了'): ad-revive
  // brings the player back ALONE — no squad, no allies. They have to
  // rebuild via recruit. Differs from no-ad timeout which brings the whole
  // blue team back. Sets player only; ally bodies stay dead (will respawn
  // from waves / per-unit timer if relay alive).
  function _revivePlayerOnly() {
    const state = game._teamWipe.blue;
    if (state) { state.wipedSince = null; state.respawnAt = null; state.respawnRequested = false; }
    if (!player) return;
    // R12 — alive=true, hp=max, armor=max, _respawnAt=null, _invulnUntil=+180
    // all go through PlayerLifecycle.reviveAtSpawn. Position pops back to the
    // blue spawn anchor (their last death spot is probably surrounded by red
    // — give them breathing room).
    if (typeof PlayerLifecycle === 'undefined') return;
    const sp = game._nnSpawnBlue;
    PlayerLifecycle.reviveAtSpawn(sp ? { x: sp.x, y: sp.y } : {});
    if (sp) {
      player._lastX = player.x; player._lastY = player.y;
      player._velX = 0; player._velY = 0;
    }
  }
  game._arenaRevivePlayerOnly = _revivePlayerOnly;

  // Phase 3C: factory capture + production tick. Pulled out so the main
  // update() block below stays readable. Walks each factory structure
  // and applies capture progress + spawn bots when owned.
  function _tickFactories() {
    if (!game._structures) return;
    const FD = STRUCTURE_DEFS && STRUCTURE_DEFS['factory'];
    if (!FD) return;
    for (const s of game._structures) {
      if (!s || !s._isFactory || s.hp <= 0) continue;
      // Count units of each team inside capture radius
      let blueIn = 0, redIn = 0;
      if (player && player.alive) {
        if (Math.hypot(player.x - s.x, player.y - s.y) < FD.captureR) blueIn++;
      }
      for (const a of allies) {
        if (a && a.alive && Math.hypot(a.x - s.x, a.y - s.y) < FD.captureR) blueIn++;
      }
      for (const e of enemies) {
        if (e && e.alive && Math.hypot(e.x - s.x, e.y - s.y) < FD.captureR) redIn++;
      }
      // Phase X — two-stage capture. User: '如果別人佔領了工廠, 那是不是
      // 要有解除佔領工廠, 然後再變成自己佔領的工廠'.
      //
      // Old behaviour: standing in an enemy-owned factory ticked
      // _captureProgress straight from 0 → FD.captureTicks then flipped
      // _team in one go. The user wanted a clearer two-step feel:
      // first DECAPTURE (the owning team's progress drains back to 0,
      // factory reverts to neutral), THEN CAPTURE (your team accrues
      // progress from neutral to full).
      //
      // New flow:
      //   Enemy-owned + you stand in radius → _captureBy = you,
      //     _captureProgress accrues. At captureTicks the factory
      //     becomes NEUTRAL (not yours yet). Keep standing → progress
      //     resets to 0 and starts accruing again toward YOUR ownership.
      //     At captureTicks (second time) → _team = you.
      //   Neutral + you stand in radius → standard single-stage capture
      //     direct to ownership.
      //   Contested (both teams in radius) → progress paused.
      //   Uncontested + progress > 0 → decay back toward 0.
      if (blueIn > 0 && redIn > 0) {
        // no-op: contested
      } else if (blueIn > 0 && s._team === 'red') {
        // Stage 1: decapture from red back to neutral
        s._captureBy = 'blue';
        s._captureProgress = Math.min(FD.captureTicks, s._captureProgress + 1);
        if (s._captureProgress >= FD.captureTicks) {
          s._team = 'neutral';
          s._captureProgress = 0;
          s._captureBy = null;
          s._nextProductionAt = 0;
          if (typeof showSwapToast === 'function') {
            showSwapToast(T('▶ 工廠回歸中立 · 繼續佔領為你方',
                            '▶ FACTORY NEUTRALISED · keep standing to capture'));
          }
        }
      } else if (blueIn > 0 && s._team === 'neutral') {
        // Stage 2 (from neutral) — actually capture for blue
        s._captureBy = 'blue';
        s._captureProgress = Math.min(FD.captureTicks, s._captureProgress + 1);
        if (s._captureProgress >= FD.captureTicks) {
          s._team = 'blue';
          s._captureProgress = 0;
          s._captureBy = null;
          s._nextProductionAt = game.time + FD.productionTicks;
          if (typeof showSwapToast === 'function') {
            showSwapToast(T('▶ 工廠被你佔領', '▶ FACTORY CAPTURED'));
          }
        }
      } else if (redIn > 0 && s._team === 'blue') {
        // Stage 1: red decaptures blue back to neutral
        s._captureBy = 'red';
        s._captureProgress = Math.min(FD.captureTicks, s._captureProgress + 1);
        if (s._captureProgress >= FD.captureTicks) {
          s._team = 'neutral';
          s._captureProgress = 0;
          s._captureBy = null;
          s._nextProductionAt = 0;
          if (typeof showSwapToast === 'function') {
            showSwapToast(T('▶ 你的工廠被中立化', '▶ YOUR FACTORY NEUTRALISED'));
          }
        }
      } else if (redIn > 0 && s._team === 'neutral') {
        // Stage 2 — red captures neutral
        s._captureBy = 'red';
        s._captureProgress = Math.min(FD.captureTicks, s._captureProgress + 1);
        if (s._captureProgress >= FD.captureTicks) {
          s._team = 'red';
          s._captureProgress = 0;
          s._captureBy = null;
          s._nextProductionAt = game.time + FD.productionTicks;
          if (typeof showSwapToast === 'function') {
            showSwapToast(T('▶ 工廠被敵方佔領', '▶ FACTORY LOST TO RED'));
          }
        }
      } else if (s._captureProgress > 0 && blueIn === 0 && redIn === 0) {
        // Nobody contesting → progress decays
        s._captureProgress = Math.max(0, s._captureProgress - 0.5);
        if (s._captureProgress === 0) s._captureBy = null;
      }
      // Production tick — owned factory spawns a bot every productionTicks
      if (s._team !== 'neutral' && game.time >= s._nextProductionAt) {
        s._nextProductionAt = game.time + FD.productionTicks;
        // Use existing recruitment / spawn helpers — adds NN bot to the
        // owning team within squad cap. arena_recruitment.js exposes
        // _arenaSpawnFactoryBot if present; otherwise fall back to a
        // minimal local spawn.
        if (typeof _arenaSpawnFactoryBot === 'function') {
          _arenaSpawnFactoryBot(s._team, s.x, s.y);
        }
      }
    }
  }

  return {
    title: 'ARENA',
    titleEn: 'ARENA',
    objective: T('連環戰 · 死亡 → 復活 → 招降隊友',
                 'Endless arena · die, respawn, recruit your squad'),
    teamKills,

    // Phase 161 — methods the build-phase / death-recap HUD calls (all were
    // undefined since the arena-mp fork, so the guarded call sites were inert).
    // Survival revive via rewarded ad (player-only).
    tryRevive() {
      if (typeof requestRewardedAd !== 'function') return;
      requestRewardedAd('survival_revive', (ok) => {
        if (!ok) return;
        if (typeof game._arenaRevivePlayerOnly === 'function') game._arenaRevivePlayerOnly();
        else if (typeof game._arenaReviveTeam === 'function') game._arenaReviveTeam('blue');
        else if (player) { player.alive = true; player.hp = player.maxHp || 100; }
      });
    },
    // Share-run payload (shareSurvivalRun destructures {wave, kills, style};
    // style falls back to 'elite' when omitted).
    getRunSummary() {
      return { wave: _waveNum, kills: teamKills[0] };
    },
    // Gate for the "WATCH AD · SKIP NEXT WAVE" button — only during an open
    // build phase, once per phase.
    canSkipWave() {
      return !!(game._buildPhase && game._buildPhase.active && !game._buildPhase._skipUsed);
    },
    // Rewarded ad: push the next reinforcement out + grant supply, end the phase.
    trySkipWave() {
      if (!game._buildPhase || game._buildPhase._skipUsed) return;
      if (typeof requestRewardedAd !== 'function') return;
      game._buildPhase._skipUsed = true;
      requestRewardedAd('skip_wave', (ok) => {
        if (!ok) { if (game._buildPhase) game._buildPhase._skipUsed = false; return; }
        _nextWaveAt = game.time + _waveInterval(_waveNum);   // delay next reinforcement
        if (typeof game._energy === 'number') game._energy = Math.min(999, game._energy + 100);
        if (typeof showSwapToast === 'function') {
          showSwapToast(T('▶ 跳過下一波 · +補給', '▶ WAVE SKIPPED · +SUPPLY'));
        }
        game._buildPhase = null;
      });
    },
    // The "+2 covers · +5s" ad calls this to actually extend the window.
    _extendBreather(ticks) {
      if (game._buildPhase) {
        game._buildPhase.endsAt = (game._buildPhase.endsAt || game.time) + ticks;
      }
    },

    update() {
      const elapsed = game.time - startTick;

      // Phase 135.2 — drain the staggered NN-arena spawn queue. spawnWave
      // enqueues entries with fireAt timestamps so a 3-8 unit reinforcement
      // wave trickles in over SPAWN_WINDOW_TICKS instead of dumping all on
      // a single frame. Each drained entry calls spawnSoldier/spawnDroneEnemy
      // → pickBiasedSpawn('nnArena') → 4-edge distribution. Result: enemies
      // arrive from N/E/S/W edges at staggered times, addressing user's
      // '一堆從同樣地方走出來' + '不是從一個點一次生成一堆' feedback.
      if (typeof tickPendingNNSpawns === 'function') tickPendingNNSpawns();

      // Detect team deaths this tick (alive count went down) → credit kills to opposing team
      const blueAlive = (player.alive ? 1 : 0) + allies.filter(a => a.alive).length;
      const redAlive  = enemies.filter(e => e.alive).length;
      if (lastBlueAlive >= 0) {
        const blueDeaths = Math.max(0, lastBlueAlive - blueAlive);
        const redDeaths  = Math.max(0, lastRedAlive  - redAlive);
        teamKills[1] += blueDeaths;   // red killed blue
        teamKills[0] += redDeaths;    // blue killed red
      }
      lastBlueAlive = blueAlive;
      lastRedAlive  = redAlive;

      // Phase 3A: detect team-wipe transitions. When a whole team hits 0
      // alive AND we haven't already started a wipe countdown, kick off
      // the wipe state. Individual _respawnAt timers are cleared so the
      // team revives together at the end of TEAM_WIPE_TICKS (or earlier
      // if the player watches a rewarded ad).
      function _checkTeamWipe(team, aliveCount, units) {
        const state = game._teamWipe[team];
        if (aliveCount === 0 && !state.wipedSince) {
          state.wipedSince = game.time;
          state.respawnRequested = false;   // Phase 183 — a FRESH wipe needs a FRESH SPACE
          state.respawnAt  = game.time + _wipeWaitTicks();
          // Phase 92 — also record WALL-CLOCK timestamps for the countdown
          // display + revive trigger. User reports the in-game countdown
          // still runs at ~2× speed despite Phase 87 60-Hz lock, which
          // means *something* is still advancing game.time faster than 60
          // per real second on their machine. Using Date.now() for the
          // visible timer + revive condition sidesteps the issue entirely
          // — the wait is always exactly real-seconds-as-shown.
          state.wipedAtMs    = Date.now();
          state.respawnAtMs  = state.wipedAtMs + _wipeWaitTicks() * (1000 / 60);
          // Clear pending individual respawns — wipe gates them all
          for (const u of units) { if (u) u._respawnAt = null; }
        }
      }
      const blueUnits = player ? [player, ...allies] : allies;
      _checkTeamWipe('blue', blueAlive, blueUnits);
      // Phase 9: red side no longer enters team-wipe state — fresh reds
      // arrive via the wave clock. _checkTeamWipe('red', ...) intentionally
      // skipped so we never trigger an in-place revival of last-position
      // corpses (which would land on top of the player after a clean sweep).
      // End-of-wipe team revive — Phase 92 uses wall-clock to match the
      // displayed countdown exactly.
      const _blueWipe = game._teamWipe.blue;
      // Phase 183 — SPACE-gated: only revive the wiped squad once the player has
      // explicitly requested it (killcam SPACE → respawnRequested). No request =
      // stay dead (the user's '不按空白鍵就永遠不會復活'). The deadline still acts
      // as a floor (can't revive before it) via the collapse-to-now on request.
      if (_blueWipe.wipedSince && _blueWipe.respawnRequested
          && (_blueWipe.respawnAtMs ? Date.now() >= _blueWipe.respawnAtMs
                                    : game.time >= _blueWipe.respawnAt)) {
        _reviveTeam('blue');
      }
      // Phase 3C: factory capture / production tick (independent of wipe)
      _tickFactories();
      // Phase 9: red waves. Independent of wipe — even during a red team-wipe
      // countdown, the wave clock keeps ticking so the player is overwhelmed
      // either by surviving red or by incoming reinforcements.
      if (game.time >= _nextWaveAt) {
        _spawnRedWave();
        _nextWaveAt = game.time + _waveInterval(_waveNum);
      }

      // Phase 161 — BUILD PHASE producer (SOLO only). Open a fortify window on
      // the periodic clock; close it when its timer (endsAt) runs out. The two
      // ad buttons can extend endsAt (_extendBreather) / end it (trySkipWave).
      const _soloBuild = (typeof _mpState === 'undefined' || !_mpState.enabled);
      if (_soloBuild) {
        if (!game._buildPhase && game.time >= _nextBuildPhaseAt && player.alive) {
          game._buildPhase = {
            active: true, left: 3, _adExtended: false, _skipUsed: false,
            endsAt: game.time + BUILD_WINDOW,
          };
          // small stipend so the player can also afford a wheel build or two
          // during the lull — the deeper "energy too slow" complaint.
          if (typeof game._energy === 'number') game._energy = Math.min(999, game._energy + 50);
          _nextBuildPhaseAt = game.time + BUILD_PERIOD;
          if (typeof showSwapToast === 'function') {
            showSwapToast(T('▶ 建造階段 · 點擊放置掩體 ×3 · +50⚡',
                            '▶ BUILD PHASE · tap to place cover ×3 · +50⚡'));
          }
          if (typeof playSfx === 'function') playSfx('match_win', { vol: 0.3 });
        } else if (game._buildPhase && game.time >= (game._buildPhase.endsAt || 0)) {
          game._buildPhase = null;   // window elapsed → close (ad-extend pushed endsAt)
        }
      } else if (game._buildPhase) {
        game._buildPhase = null;     // safety: never leave a build phase open in MP
      }
      // Phase 9: evict long-dead reds. Without per-unit respawn, dead red
      // corpses would accumulate in the array forever (and still draw HP
      // bars / be checked by lots of loops). Mark a death tick once on
      // transition; drop the slot ~3 sec later.
      // Phase 18: also expire KO-stunned units that the player never came
      // to recruit. After ARENA_STUN_TICKS (25s) without a G press, the
      // stunned body auto-dies (small explosion + score) and gets evicted
      // a few seconds later by the regular dead-corpse path.
      const _STUN_TICKS = (typeof ARENA_STUN_TICKS !== 'undefined') ? ARENA_STUN_TICKS : 1500;
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        if (!e) continue;
        if (e._koStunned && e.alive
            && (game.time - (e._koStunnedAt || 0)) > _STUN_TICKS) {
          // C4 chokepoint: route the timeout-death through killUnit() so it
          // earns the SAME credit as a normal kill (score + killCount +
          // _lbBumpKill + onUnitDeath hooks). The old inline `game.score += 100;
          // game.killCount++` skipped _lbBumpKill(), so a stun-timeout kill
          // scored but never reached the leaderboard.
          e._koStunned = false;
          killUnit(e, { source: 'stun-timeout' });
          if (typeof createExplosion === 'function') createExplosion(e.x, e.y, 'small');
        }
        if (e.alive) continue;
        if (e._deadAt == null) e._deadAt = game.time;
        else if (game.time - e._deadAt > 180) enemies.splice(i, 1);
      }
      // While a team is wiped, skip the per-unit respawn-timer setter
      // (those would race with the team revive). Per-team relay state
      // affects the individual timer length when the team is NOT wiped.
      const blueWiped = !!game._teamWipe.blue.wipedSince;
      const redWiped  = !!game._teamWipe.red.wipedSince;
      const blueTicks = _spawnRelayAlive('blue') ? RESPAWN_TICKS : RESPAWN_TICKS_NO_SP;
      const redTicks  = _spawnRelayAlive('red')  ? RESPAWN_TICKS : RESPAWN_TICKS_NO_SP;

      // Phase 86 — player respawn time NOW honors the ad-buff system.
      // User '若沒有廣告獎勵 應該是15sec, 若看全屏廣告(不可跳過)才有5sec'.
      // Old code used the hard-coded RESPAWN_TICKS (5s) for the player,
      // bypassing getRespawnSeconds() — so default + buffed both timed
      // out at 5s and the ad reward was meaningless. Fix: derive the
      // player slot's ticks from getRespawnSeconds(). NN bots still use
      // blueTicks (no ad mechanic applies to them).
      const playerTicks = (typeof getRespawnSeconds === 'function')
        ? Math.round(getRespawnSeconds() * 60)
        : blueTicks;

      // Set respawn timers for newly-dead units. In NN mode, instead of
      // sending the operator to spawn for 5 seconds, auto-jump into the
      // closest alive ally. Phase 129c — delegate to pawn_swap.js's
      // canonical handleLocalDeath() so the SP and MP paths share one
      // decision site (try-auto-swap-first, fall back to countdown +
      // team-wipe). Previously the SP and MP paths diverged: MP always
      // scheduled respawn + always set wipedSince, ignoring live allies.
      if (!player.alive && player._respawnAt == null && !blueWiped) {
        if (typeof handleLocalDeath === 'function') {
          handleLocalDeath({ x: player.x, y: player.y });
        }
      }
      for (const a of allies) {
        // Phase 102 — skip _consumed slots (chain-takeover ex-op corpses).
        // They never respawn individually; only the team-wipe bulk respawn
        // brings them back.
        if (!a.alive && a._respawnAt == null && !blueWiped && !a._consumed) a._respawnAt = game.time + blueTicks;
      }
      // Phase 9: red side does NOT respawn per-unit anymore — fresh red
      // arrives in escalating waves above. Without this, dead reds were
      // popping back at their spawn anchor on a 5-sec timer which is the
      // "刷 NPC" feel the user wanted gone.

      // Player respawn countdown beep — once per remaining whole second
      if (!player.alive && player._respawnAt != null) {
        const ticksLeft = player._respawnAt - game.time;
        const sLeft = Math.ceil(ticksLeft / 60);
        if (player._lastBeepSec !== sLeft && sLeft > 0 && sLeft <= 5) {
          playSfx('countdown', { vol: sLeft === 1 ? 0.5 : 0.3 });
          player._lastBeepSec = sLeft;
        }
      } else { player._lastBeepSec = -1; }

      // Phase 102 — 3 seconds of damage immunity after respawn (was 1.5).
      // User '復活要復活是要有三秒的無敵時間, 不要一復活就被秒殺,
      // 再重新倒數'. Standardised across every respawn / swap / revive
      // path; matches server INVULN_TICKS so client/server stay in sync.
      const SPAWN_INVULN_TICKS = 180;
      // Clamp respawn positions to the playable interior of the NN_ARENA box
      // so a unit never spawns OUTSIDE the red border, regardless of jitter.
      const SP_PAD = 30;
      const _spX = (cx) => clampToArenaX(cx, SP_PAD, SP_PAD);
      const _spY = (cy) => clampToArenaY(cy, SP_PAD, SP_PAD);
      // Process respawns
      // Cycle helpers — next spawn point in placement order. game._nnSpawnBlueIdx
      // bumps every time someone respawns, so a 4-marker map sends respawn 1 to
      // marker 1, respawn 2 to marker 2, etc. (wraps around).
      const _nextBlueSpawn = () => {
        const list = game._nnSpawnBlueList || [game._nnSpawnBlue];
        const sp = list[game._nnSpawnBlueIdx % list.length];
        game._nnSpawnBlueIdx = (game._nnSpawnBlueIdx + 1) % list.length;
        return sp;
      };
      const _nextRedSpawn = () => {
        const list = game._nnSpawnRedList || [game._nnSpawnRed];
        const sp = list[game._nnSpawnRedIdx % list.length];
        game._nnSpawnRedIdx = (game._nnSpawnRedIdx + 1) % list.length;
        return sp;
      };
      if (!player.alive && player._respawnRequested && player._respawnAt != null && game.time >= player._respawnAt) {
        // Phase 183 — SPACE-gated (player._respawnRequested set by SPACE); no
        // request = never auto-revive. R12 — canonical revive transition
        // (alive=true, hp=max, armor=max,
        // gunRecoil=0, reloading=false, _invulnUntil=+SPAWN_INVULN_TICKS,
        // _lastRespawnAt=now, _respawnAt=null, _killedAtTime=0).
        const psp = _nextBlueSpawn();
        if (typeof PlayerLifecycle !== 'undefined') {
          PlayerLifecycle.reviveAtSpawn({
            x: _spX(psp.x),
            y: _spY(psp.y + (Math.random() - 0.5) * 60),
            invulnTicks: SPAWN_INVULN_TICKS,
          });
        }
        // SP-NN weapon-specific ammo override (reviveAtSpawn defaults to
        // maxAmmo; here we want playerWeapon.magSize + reserveStart from
        // the actual weapon definition).
        if (playerWeapon) {
          player.ammo = playerWeapon.magSize;
          player.reserve = playerWeapon.reserveStart;
        }
        playSfx('respawn');
      }
      for (const a of allies) {
        if (!a.alive && a._respawnAt != null && game.time >= a._respawnAt) {
          a.alive = true;
          a.hp = a.maxHp;
          const asp = _nextBlueSpawn();
          a.x = _spX(asp.x);
          a.y = _spY(asp.y + (Math.random() - 0.5) * 60);
          a._respawnAt = null;
          a._nnFireCd = 0; a._nnRecentDmg = 0;
          a._invulnUntil = game.time + SPAWN_INVULN_TICKS;
          if (!a._nnDifficulty) a._weapon = WEAPONS[pickRandomNNWeaponId()];
        }
      }
      for (const e of enemies) {
        if (!e.alive && e._respawnAt != null && game.time >= e._respawnAt) {
          e.alive = true;
          e.hp = e.maxHp;
          const esp = _nextRedSpawn();
          e.x = _spX(esp.x);
          e.y = _spY(esp.y + (Math.random() - 0.5) * 60);
          e._respawnAt = null;
          e._nnFireCd = 0; e._nnRecentDmg = 0;
          e._invulnUntil = game.time + SPAWN_INVULN_TICKS;
          if (!e._nnDifficulty) e._weapon = WEAPONS[pickRandomNNWeaponId()];
        }
      }

      // Endless arena — no win conditions. Match never ends.
    },

    isComplete() { return false; },
    isFailed()   { return false; },

    renderHUD() {
      // Endless arena — no countdown, no goal. Just running K/D + squad size.
      const elapsed = game.time - startTick;
      const sec = Math.floor(elapsed / 60);
      const mySquad = (typeof _arenaAliveSquadCount === 'function')
        ? _arenaAliveSquadCount() : 0;
      drawObjectivePanel([
        `${T('擊殺', 'KILLS')} ${teamKills[0]}    ${T('陣亡', 'DEATHS')} ${teamKills[1]}    ${T('在線', 'TIME')} ${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`,
        `${T('你的小隊', 'SQUAD')} ${mySquad}/${typeof ARENA_SQUAD_CAP !== 'undefined' ? ARENA_SQUAD_CAP : 5}    ${T('B 建造 · G 招降', 'B BUILD · G RECRUIT')}`,
      ]);
    },
  };
};
