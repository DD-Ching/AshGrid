// ============================================================
// Phase 2 — Shared weapon physics table (SERVER copy).
// ============================================================
//
// IMPORTANT: this file's logic MUST stay byte-identical to
// js/sim/weapons.js. Only the bottom export boilerplate differs.
//
// See js/sim/weapons.js for the full design comment.

// Phase 4 — server tick rate 30 Hz → 60 Hz. All per-tick values
// rescaled so the visible game stays identical:
//   bulletSpeed  halved   (60 ticks × half = same px/sec)
//   bulletLife   doubled  (same range = speed × life, time-in-air = life / TICK_HZ)
//   fireCdTicks  doubled  (same shots-per-second)
const WEAPONS_SIM = {
  SMG:     { damage: 14,  bulletSpeed: 13, bulletLife: 42, fireCdTicks: 4,  pellets: 1,  spread: 0.10 },
  RIFLE:   { damage: 22,  bulletSpeed: 14, bulletLife: 60, fireCdTicks: 8,  pellets: 1,  spread: 0.04 },
  LMG:     { damage: 20,  bulletSpeed: 14, bulletLife: 70, fireCdTicks: 6,  pellets: 1,  spread: 0.07 },
  SNIPER:  { damage: 100, bulletSpeed: 22, bulletLife: 100, fireCdTicks: 50, pellets: 1, spread: 0.005 },
  SHOTGUN: { damage: 18,  bulletSpeed: 16, bulletLife: 38, fireCdTicks: 30, pellets: 11, spread: 0.22 },
  ROCKET:  { damage: 80,  bulletSpeed: 11, bulletLife: 80, fireCdTicks: 60, pellets: 1, spread: 0.012,
             isRocket: true, blastR: 110, blastDmg: 60, structDmgMul: 4 },
  M4:      { damage: 16,  bulletSpeed: 13, bulletLife: 60, fireCdTicks: 14, pellets: 1, spread: 0.06 },
  AK:      { damage: 14,  bulletSpeed: 11, bulletLife: 70, fireCdTicks: 16, pellets: 1, spread: 0.09 },
};

function getWeaponSim(id) {
  return WEAPONS_SIM[id] || WEAPONS_SIM.RIFLE;
}

export { WEAPONS_SIM, getWeaponSim };
