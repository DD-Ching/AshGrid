// ============================================================
// Phase 2 — Shared weapon physics table (SERVER copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// js/sim/weapons.js. Only the bottom export boilerplate differs.
//
// See js/sim/weapons.js for the full design comment.

const WEAPONS_SIM = {
  SMG:     { damage: 14,  bulletSpeed: 26, bulletLife: 21, fireCdTicks: 2, pellets: 1,  spread: 0.10 },
  RIFLE:   { damage: 22,  bulletSpeed: 28, bulletLife: 30, fireCdTicks: 4, pellets: 1,  spread: 0.04 },
  LMG:     { damage: 20,  bulletSpeed: 28, bulletLife: 35, fireCdTicks: 3, pellets: 1,  spread: 0.07 },
  SNIPER:  { damage: 100, bulletSpeed: 44, bulletLife: 50, fireCdTicks: 25, pellets: 1, spread: 0.005 },
  SHOTGUN: { damage: 18,  bulletSpeed: 32, bulletLife: 19, fireCdTicks: 15, pellets: 11, spread: 0.22 },
  ROCKET:  { damage: 80,  bulletSpeed: 22, bulletLife: 40, fireCdTicks: 30, pellets: 1, spread: 0.012,
             isRocket: true, blastR: 110, blastDmg: 60, structDmgMul: 4 },
  M4:      { damage: 16,  bulletSpeed: 26, bulletLife: 30, fireCdTicks: 7,  pellets: 1, spread: 0.06 },
  AK:      { damage: 14,  bulletSpeed: 22, bulletLife: 35, fireCdTicks: 8,  pellets: 1, spread: 0.09 },
};

function getWeaponSim(id) {
  return WEAPONS_SIM[id] || WEAPONS_SIM.RIFLE;
}

export { WEAPONS_SIM, getWeaponSim };
