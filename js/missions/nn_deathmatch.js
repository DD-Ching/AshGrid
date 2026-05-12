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
  const RESPAWN_TICKS    = 5 * 60;        // 5 seconds
  const startTick = game.time;
  const teamKills = [0, 0];               // [blue, red] — running totals, never resets
  let lastBlueAlive = -1, lastRedAlive = -1;

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

      // Set respawn timers for newly-dead units. In NN mode, instead of
      // sending the operator to spawn for 5 seconds, auto-jump into the
      // CLOSEST alive ally (the operator never sits out — that's the whole
      // point of pawn-swap). If no alive allies, fall back to normal respawn.
      if (!player.alive && player._respawnAt == null) {
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
          a._respawnAt = game.time + RESPAWN_TICKS;
          a._useNN = true;
          a._nnDifficulty = a._nnDifficulty || NN.difficulty || 'evolved';
          const killerInfo = player._killer ? ` · ${T('死於', 'killed by')} ${player._killer.callsign || T('敌方', 'enemy')}` : '';
          showSwapToast(`${T('接管', 'SWAP')} ${(a.callsign === '前操作员' || a.callsign === 'EX-OPERATOR') ? T('隊友', 'ALLY') : a.callsign}${killerInfo}`);
          playSfx('countdown', { freq: 1320, vol: 0.45 });
        } else {
          player._respawnAt = game.time + RESPAWN_TICKS;
        }
      }
      for (const a of allies) {
        if (!a.alive && a._respawnAt == null) a._respawnAt = game.time + RESPAWN_TICKS;
      }
      for (const e of enemies) {
        if (!e.alive && e._respawnAt == null) e._respawnAt = game.time + RESPAWN_TICKS;
      }

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
