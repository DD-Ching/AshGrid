# AshGrid — Chassis-as-Classes redesign (design doc)

Status: **DESIGN** (Phase 184+). Captures the gameplay redesign from the 2026-06-14
`/goal`. Bug fixes (squad slots, respawn-on-SPACE, no ad-on-death) shipped
separately as Phase 183. This doc is the blueprint for the class system; it is
implemented in phases, SOLO-first, behind flags, with CI at each step.

## Core idea
The three chassis become three **classes**. Abilities that are universal today
become **class-exclusive**, and every special action draws from one shared,
regenerating **energy** pool. Death does **not** auto-revive (Phase 183): you
press SPACE to redeploy, or — if a squad member exists — take it over.

> Energy already exists (`game._energy`, regen 3/s, earned per-kill/beacon,
> spent only on building). Today it's **client-only**; MP server is chassis-blind
> beyond speed/radius scalars. Teaching the server the chassis (HP, armor,
> ability validation, energy) is the bulk of the MP work — see "MP authority".

## The three classes

### 1. Humanoid = BUILDER (建築師)
- **Build** (existing B/radial): place structures, costs energy (already gated).
- **Recruit / 招降** (G): convert an enemy whose **HP < my HP** into a squad
  member (joins a slot, max 5). Costs energy. Replaces today's `hp < 50% of own
  max` + SEED-gap gate with a simple **target.hp < player.hp** rule.
- Only the humanoid can build and recruit-to-squad.

### 2. Wolf / Dog = CHARGER / DEVOURER (機器狗)
- **Dash / 冲刺** (costs energy): while dashing, **damage taken −70%** and
  damage dealt reduced; a fast repositioning burst. (Distinct from Shift-sprint
  to avoid speed-stacking; see risks.)
- **G = Devour (處決+吸血), NOT recruit.** On a highlighted (反白) enemy whose
  **HP < mine**, press G → the enemy **instantly dies / vanishes** (no body, no
  squad slot) → **lifesteal**: gain its HP **and** energy. The dog grows by
  eating, it doesn't recruit.

### 3. Heavy = ARSENAL / ULTIMATE (重型)
- **Weapon stockpile**: can hold **multiple weapons at once**; weapons
  **accumulate**. Cycle the (up to 3) held weapons with **R**.
- **Ultimate / 大招** (costs energy): fire **ALL** accumulated weapons at once
  (開轟 barrage) — a burst that spends a chunk of energy.
- **Loot on kill**: after killing an enemy, Heavy **steals the victim's
  FPV/suicide-drone quota** (and similar consumables) into its own stockpile.
- (Heavy is the tank: today its HP×1.8 + armor buffer is **SOLO-only** — the
  server gives it neither. Fixing that is part of this redesign.)

## Energy economy (shared substrate)
- One regenerating pool. Centralize the scattered `game._energy -= x` into
  `spendEnergy(cost)` / `canAffordEnergy(cost)` helpers (next to
  `canAffordStructure`); costs live in `js/balance.js` (`BALANCE.ability.*`).
- Per-class regen rate (in the chassis table). Each special action (build,
  recruit, dash, devour, ultimate) has an energy cost; they all slowly recover.
- **Open decision**: keep energy a single match pool (current SOLO) or make it
  **per-player** (needed for clean MP). Recommendation: per-player `u._energy`
  initialized in `applyChassisToUnit`, server-tracked for MP.

## Implementation phases (each: SOLO-first, flagged `game._classes`, CI-gated)
- **184a — substrate**: `spendEnergy/canAffordEnergy` helpers + per-class energy
  in the chassis table + `BALANCE.ability.*`; chassis becomes a **player pick**
  (lobby) instead of random. No behavior change yet.
- **184b — Builder**: gate build + recruit to humanoid; recruit eligibility →
  `target.hp < player.hp`; recruit costs energy. SOLO + MP (client pre-check +
  `arena_recruit_mp` + server gate, all three in lockstep) + server deploy.
- **184c — Dog**: chassis-gated G = devour+lifesteal (new `_arenaTryExecute`,
  never touches `allies[]`); dash −70%-damage window (new flag checked in
  `chassis.js _applyDamageToUnit`). MP: new `execute`/`executeOk` server
  messages (clone the recruit handler) + server-validated dash damage window.
- **184d — Heavy**: weapon stockpile + R-cycle + ultimate(fire-all) (new system;
  reuse the FPV-stockpile pattern) + steal-FPV-on-kill. Server learns chassis
  HP×mul + armor so Heavy is a real tank in MP.
- **184e — polish/balance**: HUD for energy/ability cooldowns, class pick UI,
  debug overlay, tuning.

## MP authority (the hard part — must not be skipped)
The server today knows chassis only as `cMul`/`rMul` per-input. For the redesign
it must learn the chassis **ID** (one-time join/hello message) and:
- apply `hpMul` + heavy armor (today heavy is a non-tank in MP);
- **validate** every energy/class ability server-side (recruit already is — copy
  that pattern for execute/dash/ultimate), or clients can cheat + desync;
- own a per-player energy value (or trust+reconcile).
Any client-only ability (dash −70%, lifesteal hp gain) WILL rubber-band against
the next snapshot unless the server agrees. MP changes require `partykit deploy`
+ a 2-client smoke test before shipping.

## Open decisions to confirm (sensible defaults chosen; will proceed unless told)
1. "**最多上線五個**" — squad size: **5 total = you + 4 members** (default), or
   5 members + you (6)? Phase 183 used you+4.
2. Recruit eligibility `target.hp < player.hp` — drop the SEED gate entirely?
   (SEED HUD/recycle becomes vestigial — default: drop it.)
3. Does Dog **execute** require a prior "stun" (white/反白) like recruit, or can
   it execute any live target under the HP threshold? (Default: same 反白 gate.)
4. Heavy weapon switching partly **reverses** the Phase-140 "one pawn = one
   weapon" decision — confirm intent (default: Heavy-only exception).
5. Energy: per-player (recommended for MP) vs single match pool.
