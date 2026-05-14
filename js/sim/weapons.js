// ============================================================
// Phase 2 — Shared weapon physics table (CLIENT copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// server/party/sim/weapons.js. Only the bottom export boilerplate
// differs.
//
// This is a SUBSET of js/weapons.js — only the fields the server
// actually needs to simulate bullets correctly. Visual + audio fields
// (follow, swayAmp, swayFreq, recoilPerShot, soundProfile, blurb)
// stay client-only in js/weapons.js because the server never renders
// or plays sound.
//
// Pre-Phase-2 the server hardcoded BULLET_SPEED=14, BULLET_DAMAGE=25,
// FIRE_CD=6 for every weapon — so SMG fired as fast as SNIPER, SNIPER
// did the same damage as RIFLE, SHOTGUN had no pellets. Hit detection
// looked busted ('我打中他他沒死') because the network's idea of the
// shot disagreed with the client's.
//
// Units (consistent with sim/constants.js):
//   damage         hp per pellet, 1 pellet by default
//   bulletSpeed    px per tick (30 Hz) — half of the legacy js/weapons.js
//                  value because that one is per-frame at 60 fps
//   bulletLife     ticks until vanish — also halved from legacy
//   fireCdTicks    ticks between shots (30 Hz)
//   pellets        for shotgun-style spread; default 1
//   spread         radians of per-pellet angle jitter
//   isRocket       if true, AOE on impact (server applies blastDmg in r=blastR)
//   blastR         AOE radius (units)
//   blastDmg       per-target damage in radius
//
// Difference vs legacy js/weapons.js: speed/life are PER-TICK here.
// The legacy table uses PER-FRAME values (twice as fine). To convert:
//   per_tick = per_frame × FRAMES_PER_TICK = per_frame × 2
//
// Client integration: bullets render at 60 fps using per-frame speed
// (= bulletSpeed / 2 here). Server integration: bullets advance at
// 30 Hz using bulletSpeed directly. Both end up at the same place
// every server tick.

(function() {
  'use strict';

  // Map of weapon id → { physics-only fields }.
  // Ids match the player-side WEAPONS table (case-sensitive).
  const WEAPONS_SIM = {
    SMG:     { damage: 14,  bulletSpeed: 26, bulletLife: 21, fireCdTicks: 2, pellets: 1,  spread: 0.10 },
    RIFLE:   { damage: 22,  bulletSpeed: 28, bulletLife: 30, fireCdTicks: 4, pellets: 1,  spread: 0.04 },
    LMG:     { damage: 20,  bulletSpeed: 28, bulletLife: 35, fireCdTicks: 3, pellets: 1,  spread: 0.07 },
    SNIPER:  { damage: 100, bulletSpeed: 44, bulletLife: 50, fireCdTicks: 25, pellets: 1, spread: 0.005 },
    SHOTGUN: { damage: 18,  bulletSpeed: 32, bulletLife: 19, fireCdTicks: 15, pellets: 11, spread: 0.22 },
    ROCKET:  { damage: 80,  bulletSpeed: 22, bulletLife: 40, fireCdTicks: 30, pellets: 1, spread: 0.012,
               isRocket: true, blastR: 110, blastDmg: 60, structDmgMul: 4 },
    // Ally fallbacks (campaign uses M4 / AK; physics-only mirror of
    // legacy js/weapons.js).
    M4:      { damage: 16,  bulletSpeed: 26, bulletLife: 30, fireCdTicks: 7,  pellets: 1, spread: 0.06 },
    AK:      { damage: 14,  bulletSpeed: 22, bulletLife: 35, fireCdTicks: 8,  pellets: 1, spread: 0.09 },
  };

  function getWeaponSim(id) {
    return WEAPONS_SIM[id] || WEAPONS_SIM.RIFLE;
  }

  const API = { WEAPONS_SIM, getWeaponSim };

  if (typeof window !== 'undefined') {
    window.SIM = window.SIM || {};
    Object.assign(window.SIM, API);
  }
})();
