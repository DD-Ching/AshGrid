// ============ BALANCE — single home for tunable gameplay numbers (Phase 144) ============
// One place for a balance pass, instead of hunting magic numbers across
// index.html / bullets.js / arena_recruitment.js / structures.js.
//
//   BALANCE.energy.*     — the energy economy: passive regen + per-event rewards.
//   BALANCE.buildCost.*  — structure placement cost (⚡). js/structures.js reads
//                          these into STRUCTURE_DEFS. Not-buildable structures
//                          (spawn-relay / factory) keep their `cost:-1` inline
//                          since -1 is a "can't build" flag, not a tunable price.
//
// LOAD ORDER: must come before structures.js AND arena_recruitment.js — both
// read BALANCE at definition time (STRUCTURE_DEFS cost refs; the
// ARENA_RECYCLE_ENERGY const). It's wired as the first js include in index.html.
//
// Classic-script. Declares global: BALANCE.
const BALANCE = {
  energy: {
    regenPerSec:        3.0,   // passive trickle, per second   (index.html updateMission)
    siegeBonusPerSec:   3.0,   // SIEGE-only extra trickle on top (build-centric mode; siege_mission)
    perKill:            20,    // each NN-mode kill              (bullets.js)
    spawnBeaconDestroy: 60,    // destroying an enemy spawn beacon (bullets.js, ×2 paths)
    mineDefuse:         10,    // finishing a hostile-mine defuse (index.html)
    recycleRefund:      60,    // scrapping a squad bot          (arena_recruitment.js)
  },
  // Phase 184a — per-class ability energy costs for the chassis-as-classes
  // redesign (CHASSIS_CLASSES_DESIGN.md). DATA only here; the actions that spend
  // these land in 184b+ (humanoid recruit, wolf dash, heavy ultimate). devour is
  // 0 because it GAINS hp+energy (lifesteal), not spends. Tunable in one place.
  ability: {
    recruit:  40,    // humanoid 招降 (convert weaker enemy → squad slot)
    dash:     25,    // wolf 冲刺 (energy/sec drain while dashing)
    devour:    0,    // wolf 处决吸血 (execute weaker enemy → gain hp + regen stack)
    ultimate: 80,    // heavy 大招 (legacy one-shot cost; 188K the ultimate is now a sustained toggle)
    ultimateDrainPerFrame: 0.6,  // 188K — ⚡ drained per sim-tick while the heavy ULTIMATE toggle is ON
  },
  // SOLO PvE survivability (opt R3). Bots use the same WEAPONS table as the player,
  // which made TTK sub-second and the SNIPER a literal one-shot on a 100-HP player —
  // "unfair/unwinnable" on session 1. These scale AI→PLAYER damage ONLY (player→bot
  // stays full = asymmetric PvE), and ONLY in SOLO (gated on !_mpIsActive() so MP PvP
  // and server parity are untouched). Tune the feel here.
  combat: {
    aiDmgMul:     0.6,   // enemy(AI) bullet damage to the player ×this → LMG ~168/s, RIFLE ~140/s
    aiMaxHitFrac: 0.55,  // …and no single AI hit exceeds this fraction of player max HP (no one-shot)
  },
  // Phase 186 — per-chassis identity tunables for the "abilities are EXCLUSIVE"
  // redesign (each chassis only has its own kit; G = a chassis-specific execute
  // on a 反白/低血 target). One home for the feel numbers.
  wolf: {
    dashDmgMul:        0.10,  // 90% damage reduction while dashing (was 0.30 = 70%)
    killLifesteal:     18,    // HP restored per wolf kill (击杀回血), clamped to maxHp
    // Phase 188E — dash is a TOGGLE that drains energy; kills REFILL it (extend the
    // dash) + devour grows the energy MAX (总量变大). One home for the feel numbers.
    killEnergyRefill:  25,    // ⚡ restored per wolf kill — sustains/extends the dash
    devourMaxGain:     25,    // +max ⚡ per successful devour (the pool 总量 grows)
    energyMaxCap:      300,   // ceiling the devour-grown max can reach
    // Phase 188N — 越殺越強 "frenzy": the wolf's killstreak (連殺 = player._killStreak,
    // a 4 s window in bullets.js) ramps MOVE speed + fire-rate so it snowballs into a
    // blur. steps = clamp(killStreak − 1, 0, frenzyMaxSteps). SOLO-only (client state;
    // MP move/fire are server-gated). Tuned in js/wolf_frenzy.js. (root tunables map.)
    frenzyMaxSteps:    6,     // streak past which scaling stops (streak ≥ 7 = full power)
    frenzySpeedStep:   0.05,  // +5% move speed per step → up to +30% at full frenzy
    frenzyFireStep:    0.075, // −7.5% fire-cooldown per step (faster RoF)
    frenzyFireFloor:   0.55,  // cooldown never below 55% of base (≈1.8× max fire-rate)
  },
  // Energy cost (⚡) per structure. The radial wheel (js/defense_build_ui.js)
  // currently exposes only the 6 ACTIVE entries; the other 10 are LEGACY —
  // dropped from the wheel but kept DEFINED so MP-broadcast / older structures
  // still resolve a cost in getStructureCost() (a missing key would make
  // canAffordStructure compare against NaN). Don't delete — relocate to the
  // structure def if a true single source of truth is ever needed.
  buildCost: {
    // ── active (in the build wheel) ──
    wall: 30, smoke: 70, camera: 60,                 // defense
    turret: 100, mine: 40, dronebay: 200,            // offense
    // ── legacy (not in the wheel; kept for MP / back-compat) ──
    cover: 18, bunker: 70, tesla: 140, tripmine: 70,
    generator: 80, terminal: 200, medstation: 100, emp: 130,
    sensor: 30, bot: 180,
  },
};

// Phase 185 — single energy-GAIN helper. Kills the `Math.min(999, (game._energy
// || 0) + X)` idiom that was copy-pasted 9× (the 999 cap was a magic number
// repeated everywhere). Behaviour-identical; the shared pool clamps at 999.
function addEnergy(amount) {
  if (typeof game === 'undefined' || !game) return;
  // Phase 188E — clamp to game._energyMax (default 100; the wolf's devour grows it,
  // BALANCE.wolf.devourMaxGain → energyMaxCap). Makes the bar honest (full = full)
  // and is what the wolf's "总量变大" tunes. Falls back to 100 if unset.
  const cap = (typeof game._energyMax === 'number' && game._energyMax > 0) ? game._energyMax : 100;
  game._energy = Math.min(cap, (game._energy || 0) + amount);
}
// Phase 185 — energy SPEND helpers, the counterparts to addEnergy. canAffordEnergy
// is the repeated `(game._energy||0) >= cost` check; spendEnergy pairs the check +
// a clamped deduct and returns whether it spent. Used by the GUARDED structure /
// upgrade / tesla spends (sites that already check affordability — behaviour-
// identical). NOT applied to un-guarded drains (e.g. EMP) that intentionally let
// energy dip, so their edge behaviour is unchanged.
function canAffordEnergy(cost) {
  return (typeof game !== 'undefined' && game) ? (game._energy || 0) >= cost : false;
}
function spendEnergy(cost) {
  if (!canAffordEnergy(cost)) return false;
  game._energy = Math.max(0, (game._energy || 0) - cost);
  return true;
}
