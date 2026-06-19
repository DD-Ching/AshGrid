// ============ SIEGE — mission factory (the mode contract) ============
// MISSION_FACTORIES.siege — a purpose-designed last stand, NOT a survival branch.
// SOLO-first, no-respawn (a positional garrison = your lives), the Heart is the
// lose-condition, the siege director (siege_director.js) owns all pacing/spawns,
// and the fort (siege_arena.js) is the protagonist. Everything is game._siege-
// gated so every other mode stays byte-identical.
//
// Lifecycle (js/mission_runtime.js): initMission applies playerSpawn (teleport +
// spawnAllies) BEFORE setupStructures(), then updateMission() ticks update() and
// polls isComplete()/isFailed(). The director is ticked from update() (cleaner
// blast radius than a global loop hook — the loop slot freed in Phase 0 stays empty).
//
// Classic-script globals: MISSION_FACTORIES.siege · _siegeInitState()
// Call-time deps: game · player · allies · enemies · T · buildSiegeFort ·
//   siegeFort · updateSiegeDirector · drawObjectivePanel · SIEGE_FORT · NN_ARENA

// The initial game._siege STATE OBJECT (set by the startNNSkirmish siege branch).
// One place owns the shape so the lobby branch + the director + FX agree.
function _siegeInitState() {
  return {
    night: 0, t: 0, phaseStart: 0, phase: 'lull',   // 'lull'|'telegraph'|'assault'|'dawn'
    weather: 'clear', intent: null, goal: null,
    fort: null,
    // Garrison = your lives, tied to a PLACE (the Heart) not a respawn timer.
    garrisonSize: 3, livesLeft: 3, autopilot: false, autopilotUntil: 0,
    salvage: 0,
    _won: false, _failed: false,
    _nightCues: null, _cuesFired: null, _gapUntil: 0,
  };
}

window.MISSION_FACTORIES = window.MISSION_FACTORIES || {};
MISSION_FACTORIES.siege = function(mapDef) {
  const startTick = (typeof game !== 'undefined') ? game.time : 0;
  const teamKills = [0, 0];                 // [blue kills, red kills] — end-card reads this
  let lastBlueAlive = -1, lastRedAlive = -1;

  // playerSpawn is read by initMission BEFORE setupStructures() builds the fort,
  // so derive it from the fixed fort geometry (SIEGE_FORT), not the registry.
  const _F = (typeof SIEGE_FORT !== 'undefined') ? SIEGE_FORT : { cx: 900, cy: 900 };
  const _ax = (typeof NN_ARENA !== 'undefined') ? NN_ARENA.x0 : 0;
  const _ay = (typeof NN_ARENA !== 'undefined') ? NN_ARENA.y0 : 0;

  function _heart() {
    const f = (typeof siegeFort === 'function') ? siegeFort() : null;
    return f ? f.heart : null;
  }

  return {
    title: '守城', titleEn: 'SIEGE',
    objective: T('守住巴斯提昂-7 · 撐到第五夜黎明', 'Hold Bastion-7 · survive to Dawn of Night 5'),
    teamKills,
    // Start just south of the Heart, inside the keep — off the core's bbox (opt R9)
    // so the player isn't spawned on the reactor. AUTHORITATIVE spawn: initMission
    // reads this BEFORE setupStructures; the fort registry's copy is unread (kept at +72).
    playerSpawn: { x: _ax + _F.cx, y: _ay + _F.cy + 72 },

    // Pre-place the fort (walls + Heart + Armory + footings). The director,
    // garrison + FX read the registry it stores on game._siege.fort.
    setupStructures() {
      if (typeof buildSiegeFort === 'function') buildSiegeFort();
    },

    update() {
      // Canonical kill counter via alive-count deltas (same as nn_deathmatch), counted
      // with plain loops (no per-tick filter() garbage); reap spent red corpses in the
      // same enemies[] pass so the array doesn't grow unbounded.
      let blueAlive = (player && player.alive) ? 1 : 0;
      if (allies) for (const a of allies) if (a && a.alive) blueAlive++;
      let redAlive = 0;
      for (let i = enemies.length - 1; i >= 0; i--) {
        const e = enemies[i];
        if (!e) continue;
        if (e.alive) { redAlive++; continue; }
        if (e._deadAt == null) e._deadAt = game.time;
        else if (game.time - e._deadAt > 180) enemies.splice(i, 1);
      }
      if (lastBlueAlive >= 0) {
        teamKills[1] += Math.max(0, lastBlueAlive - blueAlive);   // red killed blue
        teamKills[0] += Math.max(0, lastRedAlive - redAlive);     // blue killed red
      }
      lastBlueAlive = blueAlive; lastRedAlive = redAlive;

      // The director owns pacing + spawns + terrain. Ticked here (not the main
      // loop) so the siege subsystem is self-contained.
      if (typeof updateSiegeDirector === 'function') updateSiegeDirector();

      // Garrison lives / weld / armory / autopilot. The death poll routes a
      // player death to garrison-wake (at the Heart) or AUTOPILOT — siege has its
      // own factory, so it owns the poll nn_deathmatch does for survival.
      if (typeof _siegeUpdateDeath === 'function') _siegeUpdateDeath();
      if (typeof _siegeTickWeld === 'function') _siegeTickWeld();
      if (typeof _siegeTickArmory === 'function') _siegeTickArmory();
      if (typeof _siegeTickAutopilot === 'function') _siegeTickAutopilot();

      // SIEGE energy re-tune — a higher trickle on top of the global regen so the
      // build/weld loop is meaty (survival's 3/sec is too slow — owner's note).
      if (typeof addEnergy === 'function' && typeof BALANCE !== 'undefined' && BALANCE.energy) {
        addEnergy((BALANCE.energy.siegeBonusPerSec || 0) / 60);
      }
    },

    // WIN — the director sets game._siege._won at the final-night dawn (Phase 7)
    // with the Heart alive. Endless mode continues past it for a best-night chase.
    isComplete() {
      return !!(game._siege && game._siege._won);
    },

    // LOSE — Heart falls (primary, position-defense loss) OR garrison-extinct
    // with no hold (Phase 5 sets _failed after AUTOPILOT grace expires).
    isFailed() {
      const h = _heart();
      if (h && h.hp <= 0) return true;
      return !!(game._siege && game._siege._failed);
    },

    getRunSummary() {
      return {
        wave: (game._siege && game._siege.night) || 1,
        kills: teamKills[0],
      };
    },

    // The rich siege HUD (night pill · HEART bar · garrison pips · INTENT banner)
    // is the over-HUD FX layer in siege_fx.js, so this contract method is a no-op
    // (drawing here too would double up). Kept for the factory-contract shape.
    renderHUD() {},
  };
};
