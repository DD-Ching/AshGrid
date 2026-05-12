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
  // Phase 10D (user: '不看廣告是30秒, 看廣告15秒 = 兩倍速復活'): no-ad wait
  // is now 30 sec, ad-revive bypasses the wait entirely (the ad itself is
  // ~15 sec — so effectively 2× speed when watched).
  const TEAM_WIPE_TICKS       = 30 * 60;  // was 15*60
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
    const alive = enemies.filter(e => e && e.alive).length;
    if (alive >= ENEMY_HARD_CAP) return;
    const room = ENEMY_HARD_CAP - alive;
    const n = Math.min(_waveSize(_waveNum), room);
    const list = game._nnSpawnRedList || [game._nnSpawnRed];
    for (let i = 0; i < n; i++) {
      const sp = list[(game._nnSpawnRedIdx || 0) % list.length];
      game._nnSpawnRedIdx = ((game._nnSpawnRedIdx || 0) + 1) % list.length;
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
    const units = team === 'blue'
      ? (player ? [player, ...allies] : allies.slice())
      : enemies.slice();
    for (const u of units) {
      if (!u) continue;
      u.alive = true;
      u.hp = u.maxHp;
      if (u.maxArmor > 0) u.armor = u.maxArmor;
      u._respawnAt = null;
      u._invulnUntil = game.time + 90;
      u._nnFireCd = 0; u._nnRecentDmg = 0;
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
    if (state) { state.wipedSince = null; state.respawnAt = null; }
    if (!player) return;
    player.alive = true;
    player.hp = player.maxHp;
    if (player.maxArmor > 0) player.armor = player.maxArmor;
    player._respawnAt = null;
    player._invulnUntil = game.time + 120;
    // Pop the player back to the blue spawn anchor (their last death spot
    // is probably surrounded by red — give them breathing room).
    if (game._nnSpawnBlue) {
      player.x = game._nnSpawnBlue.x;
      player.y = game._nnSpawnBlue.y;
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
      // Contested: both teams inside → pause progress (no change)
      if (blueIn > 0 && redIn > 0) {
        // no-op
      } else if (blueIn > 0 && s._team !== 'blue') {
        // Blue capturing
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
      } else if (redIn > 0 && s._team !== 'red') {
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

    update() {
      const elapsed = game.time - startTick;

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
          state.respawnAt  = game.time + TEAM_WIPE_TICKS;
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
      // End-of-wipe team revive
      if (game._teamWipe.blue.wipedSince && game.time >= game._teamWipe.blue.respawnAt) {
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
      // Phase 9: evict long-dead reds. Without per-unit respawn, dead red
      // corpses would accumulate in the array forever (and still draw HP
      // bars / be checked by lots of loops). Mark a death tick once on
      // transition; drop the slot ~3 sec later.
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        if (!e || e.alive) continue;
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

      // Set respawn timers for newly-dead units. In NN mode, instead of
      // sending the operator to spawn for 5 seconds, auto-jump into the
      // CLOSEST alive ally (the operator never sits out — that's the whole
      // point of pawn-swap). If no alive allies, fall back to normal respawn.
      if (!player.alive && player._respawnAt == null && !blueWiped) {
        let bestIdx = -1, bestD = Infinity;
        for (let i = 0; i < allies.length; i++) {
          const ax = allies[i];
          if (!ax || !ax.alive) continue;
          const d = Math.hypot(ax.x - player.x, ax.y - player.y);
          if (d < bestD) { bestD = d; bestIdx = i; }
        }
        if (bestIdx >= 0) {
          const a = allies[bestIdx];
          // Operator inherits the ally's body in-place
          player.alive = true;
          player.x = a.x; player.y = a.y;
          player.angle = a.angle;
          player.gunAngle = a.gunAngle || a.angle;
          player.gunRecoil = (a.gunRecoil || 0) * 0.4;
          player.hp = a.hp; player.maxHp = a.maxHp;
          player._invulnUntil = game.time + 60;
          player._lastX = a.x; player._lastY = a.y;
          player._velX = 0; player._velY = 0;
          mouse.down = false;
          applyWeaponToPlayer(a._weapon || WEAPONS.RIFLE);
          // The slot we took over becomes the player's OLD (dead) body — it
          // will respawn normally under NN control after the standard timer.
          a.alive = false;
          a.x = player._lastDeathX != null ? player._lastDeathX : a.x;
          a.y = player._lastDeathY != null ? player._lastDeathY : a.y;
          a.callsign = T('前操作员', 'EX-OPERATOR');
          a._respawnAt = game.time + blueTicks;
          a._useNN = true;
          a._nnDifficulty = a._nnDifficulty || NN.difficulty || 'evolved';
          const killerInfo = player._killer ? ` · ${T('死於', 'killed by')} ${player._killer.callsign || T('敌方', 'enemy')}` : '';
          showSwapToast(`${T('接管', 'SWAP')} ${(a.callsign === '前操作员' || a.callsign === 'EX-OPERATOR') ? T('隊友', 'ALLY') : a.callsign}${killerInfo}`);
          playSfx('countdown', { freq: 1320, vol: 0.45 });
        } else {
          player._respawnAt = game.time + blueTicks;
        }
      }
      for (const a of allies) {
        if (!a.alive && a._respawnAt == null && !blueWiped) a._respawnAt = game.time + blueTicks;
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

      // Spawn protection: 1.5 seconds of damage immunity after respawn so
      // you don't get instantly killed by a sniper sitting on your spawn.
      const SPAWN_INVULN_TICKS = 90;
      // Clamp respawn positions to the playable interior of the NN_ARENA box
      // so a unit never spawns OUTSIDE the red border, regardless of jitter.
      const SP_PAD = 30;
      const _spX = (cx) => Math.max(NN_ARENA.x0 + SP_PAD,
                                     Math.min(NN_ARENA.x0 + NN_ARENA.w - SP_PAD, cx));
      const _spY = (cy) => Math.max(NN_ARENA.y0 + SP_PAD,
                                     Math.min(NN_ARENA.y0 + NN_ARENA.h - SP_PAD, cy));
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
      if (!player.alive && player._respawnAt != null && game.time >= player._respawnAt) {
        player.alive = true;
        player.hp = player.maxHp;
        if (playerWeapon) {
          player.ammo = playerWeapon.magSize;
          player.reserve = playerWeapon.reserveStart;
        } else {
          player.ammo = player.maxAmmo;
        }
        const psp = _nextBlueSpawn();
        player.x = _spX(psp.x);
        player.y = _spY(psp.y + (Math.random() - 0.5) * 60);
        player._respawnAt = null;
        player.gunRecoil = 0;
        player.reloading = false;
        player._invulnUntil = game.time + SPAWN_INVULN_TICKS;
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
