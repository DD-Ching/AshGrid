// ============================================================
// Phase 2 — Weapon physics table (SERVER, authoritative).
// ============================================================
//
// SOURCE OF TRUTH for the 30-Hz weapon baseline. The CLIENT counterpart is
// js/weapons.js (`WEAPONS`, hardcoded at the 60-fps frame rate). They are NOT
// byte-identical — the client is the same baseline rescaled to 60 fps:
//   client.damage  == base.damage            (tick-independent)
//   client.spread  == base.spread            (tick-independent)
//   client.pellets == base.pellets           (tick-independent)
//   client.fireCd     == base.fireCdTicks * (60/30)
//   client.bulletSpeed== base.bulletSpeed   / (60/30)
//   client.bulletLife == base.bulletLife    * (60/30)
// tools/check_sim_parity.js asserts this so the two can't silently drift
// (Phase 143). `_BASE_30HZ` is exported for that test.

// Phase 4b — weapon stats refactored to derive from a 30-Hz baseline so
// future tick-rate changes are a one-liner. Per-tick rescale rules:
//   bulletSpeed  ÷ TICK_FACTOR   (same px/sec)
//   bulletLife   × TICK_FACTOR   (same time-in-air)
//   fireCdTicks  × TICK_FACTOR   (same shots/sec)
// damage / pellets / spread / blastR / etc. are tick-rate-independent.
import { TICK_HZ } from './constants.js';
const TICK_FACTOR = TICK_HZ / 30;

const _BASE_30HZ = {
  SMG:     { damage: 14,  bulletSpeed: 26, bulletLife: 21, fireCdTicks: 2,  pellets: 1,  spread: 0.10 },
  RIFLE:   { damage: 22,  bulletSpeed: 28, bulletLife: 30, fireCdTicks: 4,  pellets: 1,  spread: 0.04 },
  LMG:     { damage: 20,  bulletSpeed: 28, bulletLife: 35, fireCdTicks: 3,  pellets: 1,  spread: 0.07 },
  SNIPER:  { damage: 100, bulletSpeed: 44, bulletLife: 50, fireCdTicks: 25, pellets: 1, spread: 0.005 },
  SHOTGUN: { damage: 18,  bulletSpeed: 32, bulletLife: 19, fireCdTicks: 15, pellets: 11, spread: 0.22 },
  ROCKET:  { damage: 80,  bulletSpeed: 22, bulletLife: 40, fireCdTicks: 30, pellets: 1, spread: 0.012,
             isRocket: true, blastR: 110, blastDmg: 60, structDmgMul: 4 },
  M4:      { damage: 16,  bulletSpeed: 26, bulletLife: 30, fireCdTicks: 7,  pellets: 1, spread: 0.06 },
  AK:      { damage: 14,  bulletSpeed: 22, bulletLife: 35, fireCdTicks: 8,  pellets: 1, spread: 0.09 },
};

const WEAPONS_SIM = {};
for (const [id, w] of Object.entries(_BASE_30HZ)) {
  WEAPONS_SIM[id] = {
    ...w,
    bulletSpeed: w.bulletSpeed / TICK_FACTOR,
    bulletLife:  Math.round(w.bulletLife * TICK_FACTOR),
    fireCdTicks: Math.round(w.fireCdTicks * TICK_FACTOR),
  };
}

function getWeaponSim(id) {
  return WEAPONS_SIM[id] || WEAPONS_SIM.RIFLE;
}

export { WEAPONS_SIM, getWeaponSim, _BASE_30HZ };
