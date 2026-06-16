# AshGrid 守城 / SIEGE — Redesign Blueprint

> Status: **IMPLEMENTED** (all phases 0–8 built, CI-green, SOLO boot-smoked). The
> survival-reuse 守城 was removed and the mode rebuilt as the self-contained subtree
> `js/missions/siege/` (siege_script · siege_arena · siege_director · siege_mission ·
> siege_fx) + `tools/test_siege.js` (in the CI gate). Remaining: owner play-through —
> the only validation headless can't do — before a `dev → main` ship.
>
> Status (orig): design-locked, buildable. Supersedes Phase 188 (the survival-reuse 守城). Lives at repo root `c:\Users\DD\Downloads\Ash\AshGrid\SIEGE_BLUEPRINT.md`. SOLO-first, additive, modular, data-driven. Single mode flag: **`game._siege`** (reclaimed after the Phase-188 removal below). Mode id / lobby value: **`siege`**.

---

## 0. Owner mandate (why this redesign, in their words)

The owner rejected the shipped 守城 (Phase 188) on **2026-06-16**:

> "It was built by REUSING the survival mode (`_forceVariantId='survival_fort'` + survival wave path + `game._siege` gate) and feels cobbled/patched — **把之前那個模式套上來…非常不好…缺東補西** (put the old mode on top of it… very bad… patching holes in piecemeal)."

> **Mandate:** REMOVE the siege-reuse ENTIRELY (**全部移除**), then REBUILD as a purpose-designed mode — fresh rules, fresh terrain, story/劇情, content — designed from scratch on the CURRENT game (chassis/weapons), NOT from old templates.

Standing principles the owner has repeated across Phases 183–188:

- **做加法 not 做減法** — build fresh/additively; do NOT take old code out and whittle it.
- **Modular not bloated** — one cohesive set of rules in its own subsystem, not a Frankenstein bolted onto survival.
- **No piecemeal patching (缺東補西)** — no scattered flag-gates across shared files.
- **Keep the data-driven editable control interface** — timeline / entry-timing / camera (運鏡) / story (劇情) / background (背景), **"像一個操作介面"** (like an operations console). Editing data, never engine code, retunes the whole mode.
- **更改地形** — the terrain itself changes during play (the literal ask that drives this design's spine).
- **Behaviour-preserving** — every other mode (DM/survival/defense/helo/convoy/duel/sniper/campaign, SOLO and MP) stays byte-identical.

---

## 1. Requirements recap (everything the owner asked for)

**Core mechanics (hard asks):**
- **No respawn** — single run; ending is a *position* loss, not a respawn-timer loss.
- **A BASTION fort / base** to hold (defensible structure at map center; 坦克轰墙).
- **Day/Night escalation** — Day/Night 1 → 2 → 3+ visible to the player as score.
- **Tanks that breach walls** — heavy units (×6 HP, ×2 size, slow, rocket-armed) chew fort-wall HP on contact and splice buildings, creating tactical holes that **persist**.
- **Drone swarms (kiting / shoot-down)** — fast hp-18 kamikaze swarms; "有機率射下來" (you down them on reaction).
- **Weather** — wind drift, rain streaks, thunder/lightning storm, day/night cycle via `TOD.setTOD`, driven from the timeline.
- **Survive-max scoring** — score = nights survived; no gold/loot economy.

**The #1 ask — data-driven editable control interface (運鏡/時間軸/劇情/背景):**
- A declarative timeline array where ALL pacing / story / visuals / timing / narrative are DATA-EDITABLE.
- Verbs for: spawn (進場), drone, tod (day/night), weather (背景), camera (運鏡), beat (劇情) — plus, per the 更改地形 ask, **terrain** and **dawn/build** verbs.
- Authored early nights; procedural escalation after → endless.

**Meta constraints (standing):**
- SOLO-first (headless can't boot ONNX matches to validate MP).
- Flag-gated behind `game._siege`, defaults off outside the lobby selection.
- CI each step (`tools/check_inline.js` + the 10-check gate); add a siege smoke test.
- **Do not touch the timing unit** (`*60`/`*84` scaling is intentional, off-limits).
- Version-stamp + green CI before any dev→main.

---

## 2. Remove first — delete the current survival-reuse siege (removal manifest + safe order)

The shipped 守城 is a thin survival branch gated by `game._siege`. Excise it entirely before building the new mode. Behaviour impact on every other mode is ZERO (it was purely additive). Estimated removal: ~450 lines.

**Removal checklist (file · what · action):**

1. `js/siege_director.js` (entire file, 339 lines) — **DELETE FILE** (SIEGE_SCRIPT, `_SIEGE_CUE`, `_siegeMakeTank`, `_siegeTankBreach`, `updateSiegeDirector`, `renderSiegeWeather`, `renderSiegeHud`, the two FxLayer registrations). No cross-deps.
2. `index.html` line ~199 `<script src="js/siege_director.js?v=237"></script>` — **REMOVE** the include.
3. `index.html` line ~4992 `if (typeof updateSiegeDirector === 'function') updateSiegeDirector();` — **REMOVE** the per-frame call.
4. `js/camera.js` lines ~26–36 `siegeCine` CAMERA_MODES entry — **REMOVE** (keep editor/mpDead/drone/fpv/command/tactical untouched).
5. `index.html` lines ~4173–4187 — the `startNNSkirmish()` SIEGE branch (`game._siege = (gameMode==='siege')`, `blueSize=1; redSize=3`, `_forceVariantId='survival_fort'`, `game._siegeDay/_siegeWeather`, `gameMode='survival'` rewrite) — **REMOVE the whole branch**; keep the surrounding duel/helo/convoy branches.
6. `index.html` line ~2039 `<button data-mode="siege" …>守城<span>SIEGE</span></button>` — **REMOVE** (re-added clean in §10/§12).
7. `js/progressive_unlock.js` line ~21 `siege: 1,` MODE_UNLOCK_TIER entry — **REMOVE** (re-added clean later).
8. `js/death_decider.js` lines ~99–106 — the SIEGE no-respawn gate — **REMOVE** (keep the `wiped` path unchanged).
9. `js/missions/nn_deathmatch.js` line ~481 — revert the wave-spawn gate to `if (game.time >= _nextWaveAt) {` (remove the `!(… game._siege) &&` negation).
10. `sw.js` — **NO CHANGE** (blanket `/js/*` network-first rule; cache version auto-stamps at release).

**DO NOT remove (shared, used by other modes):** `survival_fort` map entry, the survival mission factory, wave escalation helpers, `game._teamWipe`, TOD/weather systems, `registerFxLayer`, the remaining CAMERA_MODES, `game._nnGameMode`, `MISSION_FACTORIES`/`missions/*`, `spawnDroneEnemy`/`_arenaSpawnFactoryBot`, player lifecycle/swap/respawn.

**Safe removal order:** 1 (delete file) → 2 (script include) → 3 (loop call) → 4 (camera mode) → 5 (startNNSkirmish branch) → 6 (lobby button) → 7 (unlock tier) → 8 (death gate) → 9 (wave gate revert) → 10 (version stamp `node tools/version.js stamp <N>`). After step 5 there are no dangling references; CI must be green before proceeding to the build.

> The reclaimed names — the `siege` lobby value, `game._siege`, the `siegeCine` camera slot, the `updateSiege*()` loop slot — are all reused by the NEW mode below, so the net wiring footprint stays minimal.

---

## 3. The new mode — concept & fantasy

**Title:** 守城 / **SIEGE** — "The Long Night at Bastion-7."

**One-line pitch:** A directed, story-first last stand where the **FORTRESS is the protagonist** — you don't kite a wave, you read a stone shell of gates, murder-holes and a reactor core, and across five named nights you rebuild it faster than a *thinking* enemy can pull it down.

**Fantasy / premise:** You are the last live neural-link operator garrisoning **Bastion-7**, a frontier relay fort the NN was supposed to defend and abandoned. Comms went dark on Day 13. Each night a red NN column marches out of the dark to take it apart stone by stone — and it does not attack everywhere; it *watches*, finds the wall you patched the least, masses armour on that seam, and sends drones over the wall you hid behind. You cannot out-shoot the column — there are too many. You can only **out-engineer** it: weld breaches, re-route the killzone, sacrifice the outer ring to save the keep. The map **degrades visibly** across the run; by the final night you are fighting inside a ruin of your own triage, and dawn is the only victory.

**The three-vision synthesis (what makes this one mode):**
- **Spine (Vision 3 — terrain):** the fort is the protagonist; terrain is mutable *both ways* (enemies subtract walls; you weld/upgrade/re-route at dawn); 更改地形 is literal and central; the dawn build-phase with salvage economy is the heartbeat.
- **Drama graft (Vision 1 — cinematic):** five named nights with distinct *threat identities* (probe → iron → swarm → storm → gate-push), an operator-log story arc, camera-synced 運鏡 setpieces, an authored tension/release rhythm, and a hold-to-DAWN win.
- **Systemic graft (Vision 2 — director):** a DIRECTOR that *reads your fort* and telegraphs **INTENT** ("ARMOUR MASSING · WEST GATE"), aims your weakest gate, splits you across fronts, and dives the core when you turtle — and it **emits into the same cue pipeline** the authored nights use, so authored and emergent content share one schema.

This is **not** survival-with-a-fort. Survival is "kill the count, a bell rings, next wave." SIEGE is "an *opponent with intent* is trying to take YOUR ground, the way it comes is a reaction to how you play, and the ground itself changes as you fight."

---

## 4. Core rules (objective / win / lose / loop / lives / chassis+weapon+build interplay)

**Objective:** Hold **Bastion-7** until **DAWN of Night 5**. Keep the **Reactor Core** (the "Heart") alive. The fort is what you defend; your units are expendable; the nights survived are your score.

**Win condition (`isComplete`):** The director reaches the scripted `dawn` beat of the final authored night (Night 5) with the **Heart still standing** (`game._siege.heart.hp > 0`). Victory card: **"DAWN HOLDS."** (Endless mode continues past Night 5 for a personal-best chase; the *story* completes at Night 5 dawn.)

**Lose condition (`isFailed`) — geography-driven, single primary fail:**
- **Heart falls** (`game._siege.heart.hp <= 0`) — the column breached all the way to center. This is a *position-defense* loss; you can lose with units still alive. **Primary fail.**
- **Garrison extinct with no hold** — your last garrison body dies AND the autopilot grace (below) does not save the night. Secondary fail.

Loss card: **"THE FORT FELL,"** stamped with the night/beat you died on.

**No-respawn / lives — the "garrison" (the owner's hard ask, made positional):**
- Your lineup is a **garrison of N chassis** (e.g. 3). They *are* your lives — tied to a *place*, not a respawn timer. **No ad-revive, no timed respawn.**
- When your active body dies, you **wake the next garrison member at the Heart** (instant `pawnSwap` into a fresh chassis standing on the core). Death is a **positional setback** — you're yanked from the breach you were plugging back to center.
- **Recruiting** a downed enemy (招降, humanoid chassis) or **capturing the Armory** adds a body to the garrison = *earns back a life*. This makes recruitment **load-bearing**.
- When the last garrison body falls, you do **not** lose instantly — you enter **AUTOPILOT**: the fort's turrets/tesla/allies fight on for a short grace while the Heart is undefended. If the Heart survives the night anyway, the whole garrison wakes at dawn (the fort held without you — a triumphant beat). If the Heart falls during autopilot, the run ends.
- Roster does **not** auto-refill between nights — only recruiting/Armory does. Attrition compounds across the five nights; that compounding *is* the difficulty curve.

**Moment-to-moment loop (the engineer-under-fire loop):**
1. **LULL (calm).** Camera low and close; an operator-log line surfaces; the wind dies before the storm. You reposition, **weld breaches** (restore wall HP), upgrade walls→bunkers, drop turrets/tesla/EMP/mines into the murder-holes, **recruit** a straggler, **swap chassis at the Armory**.
2. **TELEGRAPH (horn).** The director shows the threat axis: a `beat` + `camera focus` on the gate about to open + an on-HUD **INTENT** readout ("ARMOUR MASSING · WEST GATE"). The night's threat is *shown before it arrives* (運鏡 telegraph).
3. **ASSAULT.** The night's threat identity hits from gate-anchored spawns. You brace the gate the armour is chewing while shooting down drones overhead.
4. **TRIAGE / BREACH.** You can't hold everything. Weld the east breach (cheap, restores the killzone) or let it fall and funnel them into a pre-mined courtyard? Terrain is a resource you spend. A tank cracks a named wall **on camera**; the fight migrates to the hole.
5. **HOLD TO DAWN.** Clear the field; a `SIEGE_CLEAR_GRACE` window mops up stragglers; TOD glides toward `dawn`; a quiet beat; the next night's LULL begins.

**Chassis / weapon / build interplay (purpose-built around the fort, uses Phase-184 chassis-as-classes):**
- **Humanoid = Builder/Engineer** — the *natural* siege pilot. Only chassis that **builds and welds breaches** and **recruits** (refills lives). In SIEGE, build energy is the fort's structural reserve. The "hold the line / rebuild at dawn" pick.
- **Wolf/Dog = Charger** — dash (−70% dmg) to *cross your own breach* and intercept a charge before it reaches the wall; `G`-devour a wounded breacher for HP+energy (lifesteal directly funds emergency wall repairs). The "plug the gap" pick.
- **Heavy = Arsenal** — multi-weapon stockpile (R-cycle) + `ultimate` (fire ALL) is the **anti-tank** answer; the only chassis that reliably one-bursts a breach-tank before it opens a second hole. Stealing FPV/drone quota on kills feeds the swarm-night shoot-down. Park it on the keep wall.
- **The garrison is a loadout puzzle:** the *order* of your lives is a strategy (e.g. Humanoid rebuild → Heavy anti-tank → Wolf last-stand mobility).
- **Weapons map to threats:** SMG/rifle down drones; rocket/LMG break armour. The DIRECTOR exploits whatever you *lack* — bring only anti-armour and it floods drones; bring only AA and it sends a tank wall. No single loadout covers every night → the Armory swap between nights is itself a scripted lull beat.
- **Energy economy re-tuned for build-centric play** (survival's 3/sec trickle is too slow — owner's own standing note): SIEGE pays a **dawn salvage lump-sum** (from the night's kills) plus a higher trickle, so the build phase is meaty. Energy is shared between "build a turret" and "weld the wall" — a deliberate tension. (Additive: a siege-only kill hook + dawn payout crediting `game._energy`; no change to other modes' economy.)

---

## 5. Terrain & map (fortress layout, chokepoints, breachable walls, spawn geography)

A **purpose-authored concentric fort**, NOT `survival_fort` (a left-half east-facing bunker — wrong shape for a 360° siege). A fresh `NN_MAP_VARIANTS` entry **`siege_bastion`** with `modes:['siege']` only, built by a `walls()` definition using `addBuilding` / `addWallLine` / `addLowCover` / `addOverhead` / `addLandmark` inside the standard `NN_ARENA` (1800×1800, origin `x0,y0`; center ≈ 900,900). Coordinates are arena-relative.

**Layout — three rings + a keep (designed so the siege reads cinematically):**

```
                       NORTH GATE  (main assault axis — horn-cam always frames this)
                ════════╗   gap   ╔════════   ← OUTER CURTAIN (low HP, meant to fall)
        ┌───────────────╨─────────╨───────────────┐
        │        COURTYARD  (the killzone donut)    │
   WEST │     ┌─────────────────────────────┐       │  EAST
   SALLY│     │  INNER WALL (high HP)  ◣ MH ◢ │       │  POSTERN
   PORT │     │     ┌───────────────────┐     │       │  (flank)
        │     │ MH  │   INNER KEEP      │ MH  │ ARMORY│
        │     │     │  ┌─────────────┐  │     │  (cap)│
        │     │     │  │ REACTOR CORE│  │     │       │
        │     │     │  │  = the HEART│  │     │       │
        │     │     │  └─────────────┘  │     │       │
        │     │     └───────────────────┘     │       │
        │     │  ◥ MH ◤        keep door (S)   │       │
        │     └─────────────────────────────┘       │
        └───────────────────────────────────────────┘
                  SOUTH COLLAPSE  (permanent pre-broken hole = pressure valve)
```

**Concrete structures for `walls()`:**
- **REACTOR CORE / the HEART** — one `spawn-relay`-class structure dead-center (`x:880,y:880,w:40,h:40, kind:'spawn-relay', accent:true, blocks:true, _isHeart:true`), HP 1200, registered as `game._siege.heart`. The lose-condition object; rendered with a pulsing accent + (optional) a charge/score ring so the player always knows what they defend.
- **INNER KEEP** — 4 `bunker`-HP `building` segments boxing the Heart, with **one keep door (S)** (a one-tile choke you can plug with your body + a bunker). The final fallback.
- **INNER WALL (ring, radius ≈ 200)** — continuous `addWallLine` `building` segments, **high HP (~600 each)** — the real defensive line. Four **murder-holes** (60u gaps NE/NW/SE/SW) fronted by `lowCover` lips, pre-seeded with empty turret/tesla **build footings** the player fills. LOS-blocking → enemies funnel. Losing one is a crisis.
- **OUTER CURTAIN (ring, radius ≈ 300/380)** — `building` segments, **low HP (~300–400)** — deliberately the weak ring, meant to be breached, forming a perimeter with **named gaps**:
  - **NORTH GATE** — wide gap, the scripted main axis (most spawns + the Night-5 gate-push); the horn-cam default frame. Has a low-HP **gate-leaf** `building` between two indestructible `cover` gate-pillars; you can **weld it shut** at dawn to force the column to chew a wall instead — a real terrain decision.
  - **EAST POSTERN** — narrow 1-unit-wide flank gap (Night-3 swarm leak-in, Night-4 storm flank); a kill-funnel.
  - **WEST SALLY PORT** — your sortie exit (lets the Charger dash out to intercept; lets you contest a conduit).
  - **SOUTH COLLAPSE** — a **permanent** pre-broken hole. The pressure valve: a guaranteed weak side you can't fully seal, so every night has a real flank to manage. Story: "the side that fell on Day 13."
- **COURTYARD** — the killzone donut between curtain and inner wall; open ground with scattered `lowCover` rubble to fight from; the turret/tesla/mine build zone. As walls fall, its shape mutates — a collapsed segment becomes a new lane.
- **ARMORY** — a `factory`-class capturable structure (neutral at start, `captureR`, `_team`) inside the keep, flagged `_isArmory:true`. Capturing it = the per-night chassis/weapon swap point AND the roster-refill (factory bot production = earned lives). `addLandmark({kind:'arena', name:'ARMORY'})`.
- **CATWALKS** — `addOverhead` (`kind:'catwalk'`) ringing the inner wall; visual high-ground that frames the drone (over-the-wall) air threat.

**Chokepoints (geography that makes the rules):** North Gate (wide — mass turrets here), East Postern (narrow kill-funnel), South Collapse (open flank you must babysit), the keep door (final one-tile plug). Breachable curtain segments mean the **map changes shape** as the siege wears on — by Night 4 the ring is full of tank-made holes and the fight has migrated inward.

**Breachable structures (the 更改地形 spine):**
- Outer curtain + gate-leaf: low HP, **meant to fall.** When a segment's `hp<=0` it splices from `buildings` (the existing bullet/grenade/explosion destruction path) → a **permanent** gap.
- Inner wall: high HP, expensive to break — losing one is a crisis.
- **Player weld/repair** = restoring `building.hp` (and re-pushing a destroyed segment back into `buildings`) via a new siege-only `weld` build-action.

**Spawn geography (informs the cue script):** red spawns are **gate-anchored, not edge-random** — `spawn.red` anchors sit just outside North Gate, East Postern, and South Collapse so the director can say "this comes from the NORTH" and have it mean something on camera. The director biases `pickBiasedSpawn('nnArena')` toward the night's targeted edge. `spawn.blue` / `mission.playerSpawn` = at the Heart (you start AT the objective).

---

## 6. Escalation & timeline (the arc + named beats)

Five hand-authored nights, each a **named act** with a distinct *threat identity* (so it never feels like "wave N+1"), separated by **DAWN build windows**. Difficulty ramps by *changing the kind of threat* and by *compounding terrain loss + roster attrition* — not just bigger numbers. Days 1–5 are scripted; **Night 6+ is procedural** (`proc` cue) that recombines the established threats at rising intensity (endless mode; the *story* completes at Night 5 dawn).

| Night | Name (zh / en) | Threat identity | Setpiece beat (運鏡) | TOD / weather |
|---|---|---|---|---|
| **1** | 試探 / THE PROBE | Light infantry, North only. Teaches walls + the weld/repair loop. | First wall takes fire on camera. | dusk → night, clear |
| **2** | 鋼鐵 / IRON | First **wall-breaking tank** crawls in. | `camera focus` "armour reveal" riding the tank as it cracks North Gate live. | night, wind |
| **3** | 蜂群 / THE SWARM | **FPV drone swarm** comes *over* the walls (East Postern + South), diving the Heart. | Camera pulls wide to show the swarm enveloping the fort. | night, rain |
| **4** | 風暴 / THE STORM | Combined arms, **two fronts** (armour one gate, infantry+drones the opposite) — breaks the single operator. | Lightning-strike `camera shake` on a wall collapse; storm cuts visibility. | deep night, storm + lightning |
| **5** | 黎明前 / BEFORE THE DAWN | The gate-push: 2 tanks + max swarm + infantry, all axes — "everything they have left." | Final breach at the keep; then TOD glides to **dawn** = WIN. | storm → dawn |
| **6+** | 長夜 / THE LONG NIGHT | Procedural (DIRECTOR composes from params). | Director-emitted (telegraph→focus→shake). | escalating |

**Difficulty ramp — three independent axes (so it's never "same wave, bigger number"):**
- **Breach pressure:** N1 = 1 tank on the gate → N3 = 2 tanks split targets → N5 = 3+ on the inner wall.
- **Air pressure:** N1 = none → N3 = swarm over the wall → N5 = sustained drone rain forcing you off the ramparts.
- **Terrain you have left:** N1 = full fort → mid = gate gone + outer segments down → N5 = fighting in the courtyard, ring half-ruined, keep in range.

**The DIRECTOR's knobs (how the systemic graft escalates — see §9 `DIRECTOR_PARAMS`):** per-night **pressure budget** = base × night × a *performance multiplier* (reads K/D + wall integrity; **one-way-ish** like the existing `adaptive_director.js` DDA — never *easier* than baseline, but won't pile on a bleeding player); composition shifts with budget (more armour, larger swarms, shorter telegraphs, multi-gate splits); **LULL length** shrinks from ~10s (N1) toward ~4s (late), compressing repair windows. `targetGate:'adaptive'` aims your weakest/least-repaired gate.

**Pacing knobs (data):** `SIEGE_DAY_GAP_SEC` (calm gap between nights), `SIEGE_CLEAR_GRACE` (straggler mop-up before a night closes), per-night `dawn` window length. A night ends when its authored cues have fired **and** the field clears + grace elapses.

---

## 7. Story / 劇情 (narrative, operator-log beats, setpieces, emotional arc)

**Narrative spine:** Bastion-7 was abandoned; you're the operator who stayed. The fort's previous defenders are the operator logs — you're reading the diary of the garrison that held before you and didn't make it. Threaded through: *who is even attacking, and why does the red NN fight like it remembers you, like it learns the shape of your defense.* The map's **visible decay IS the story** — there is no cutscene; the fort narrates by falling apart.

**Emotional arc:** isolation (a dead station, alone) → comprehension (it's *learning* me) → desperation (two fronts, walls falling, running out of bodies to be) → defiance (recruit, rebuild, brace) → **release** (dawn; light literally returns via TOD). The siege earns its catharsis because it can be **won**, not merely outlasted. The lulls are as authored as the assaults — quiet camera, a log line, the wind dying — so the next horn *lands*.

**Operator-log beats** (`operators_log.js` `LOG_ENTRIES` shape — `{ night, title_zh/en, body_zh/en }`, unlocked as you reach each night, stored in `localStorage` under `ag.logsRead`):
- **Night 0 / pre-siege — 「棄守」/ "ABANDONED":** the evacuation order came; you didn't go. Lone-operator dread.
- **Night 1 — 「第一聲號角」/ "THE FIRST HORN":** "Welded the east gate myself. Tools still here. They left in a hurry. You hear them in the dark before you see them."
- **Night 2 — 「暗夜鋼鐵」/ "IRON IN THE DARK":** the tank. "I felt the wall give through the link, like a tooth coming loose. The courtyard was always the real wall."
- **Night 3 — 「他們長了翅膀」/ "THEY HAVE WINGS NOW":** doubt. "Walls mean nothing to the ones that fly. Keep something pointed at the sky — I'm running out of bodies to be."
- **Night 4 — 「風暴記得」/ "THE STORM REMEMBERS":** the low point. "Two gates at once. One operator can't be two places — this is what the squad is for. If the core goes, I go with it. I'm not leaving."
- **Night 5 — 「黎明前」/ "BEFORE THE DAWN":** resolve. "If you're reading this, the inner wall is gone. There is only the Heart now. Stand on it. Hold — just hold until the light."
- **Dawn / win — 「破曉」/ "DAWN HOLDS":** release. The red NN withdraws at sunrise. You don't know if you won or if they simply stopped. You're still here.

**On-screen story moments** (`beat` cues → `showSwapToast`, bilingual): every night opens with a titled banner ("第 1 夜 · 試探 · 守住北門" / "NIGHT 1 · THE PROBE · HOLD THE NORTH GATE"); the horn fires a tension beat before each assault; breaches fire a reaction beat ("北牆破了!退守內堡!" / "NORTH WALL BREACHED! Fall back to the keep!"); the dawn beat closes; the INTENT telegraph names the threat axis ("ARMOUR MASSING · WEST GATE"); the lull breath ("黎明 · 修補" / "DAWN · REPAIR"). These are the director's diegetic narration — short, camera-synced.

**Setpieces (each one authored cue cluster, not emergent — except 6+):** the armour reveal (N2), the swarm envelopment wide-shot (N3), the lightning wall-collapse (N4), the multi-axis gate-push + dawn pull (N5), and "The Hold" (any night you survive with the last garrison body down → autopilot wins it → dawn wakes the whole garrison → triumphant toast).

---

## 8. Content (enemies incl. wall-breaking tanks + shoot-down drones, events, weather/TOD, camera/運鏡)

**Enemy roles — an ARMY with objectives, not a count** (fresh content on clean spawn APIs):
- **SAPPER infantry** — standard `_arenaSpawnFactoryBot('red', x, y)` at a gate anchor, but in SIEGE they path to the *nearest gate/wall* and chew it (objective: **breach**), not just chase the player. Cheap, numerous, channel through kill-funnels.
- **BREACHER TANK (the star threat)** — spawn a red bot via `_arenaSpawnFactoryBot` then post-process into a siege-tank: `_isTank=true`, `maxHp` ×6 (~600), `radius` ×2, `_speedMul 0.4–0.5` (slow crawl), `_weapon = WEAPONS.ROCKET`, `callsign 'TANK'`, plus a fresh `_siegeBreacher:true`. **Behavior:** ignores the player, picks the cue's `target` wall segment, and **grinds its `building.hp` on contact** (a new siege-only `_siegeTankBreach` AABB-vs-circle tick subtracts wall HP each contact tick → opens a *permanent* gap). Telegraphed; killing it before it breaches is the Heavy's job. This is purpose-built terrain-changer behavior, not a survival chaser.
- **DRONE swarm (shoot-down content)** — `spawnDroneEnemy(cfg)` ×N, fast, HP ~18, kamikaze. **Siege objective: ignore walls, dive the Heart** (anti-turtle) — forces you to keep AA and look up. "有機率射下來" — downing them is a skill check under pressure.
- **MARAUDER (new role flag, pure composition — no new engine)** — a fast flanker that ignores the fort and hunts the operator / contests a **conduit/armory**, punishing players who camp one gate.
- **SIEGE-WALKER / final super-tank (Night 5 + procedural)** — a giant slow tank that targets the **inner** wall and can two-shot a murder-hole turret; the climax threat (pure parameter scaling + escort).
- **Recruitable warden** — any downed Sapper can be 招降'd into a wall-defender; your only mid-run garrison growth.

**Salvage economy (siege-specific, NOT survival's drip):** downed armour/sappers drop **salvage** funding build/weld energy → the Builder loop "kill the tank → salvage → weld the gate it broke" is the heartbeat. Siege-only kill hook + dawn lump-sum crediting `game._energy` (additive).

**Events / setpieces (authored or director-emitted, all expressed as cues):** MASS-ON-A-GATE (telegraph + biased edge + armour focus), OVER-THE-WALL (drones timed mid-assault), TWO-FRONTS (opposite-edge simultaneous pressure), CORE-RUSH grand assault (all gates + max armour + storm + camera sweep), CONDUIT/ARMORY RAID (marauders contest your refill, forcing a sortie).

**Weather / TOD** (`TOD.setTOD` + a siege weather FX layer via `registerFxLayer`, `space:'overlay-under-hud'`, `when:()=>game._siege`): `tod` cues glide **dusk → night → rain → storm → dawn/day** as the emotional clock; `weather` cues layer clear/wind/rain/storm. Storm adds lightning flashes that double as `camera shake` triggers; rain/dark cut visibility so the fort's own turret muzzle-flashes become navigation — **diegetic difficulty.** Weather is dramaturgical: rain on swarm night, storm on the worst night, clear dawn on victory.

**Camera / 運鏡** (via `game._cineFocus = {x,y,scale,until}` + a fresh top-priority `siegeCine` CAMERA_MODE; the existing `dd>60` camera lerp absorbs the glide in and back to the player when `until` expires): **horn telegraph** (focus on the gate about to open), **armour reveal** (N2 slow zoomed focus riding the tank), **breach punch** (`shake` on every wall collapse + a half-second focus snap to the new gap so you *see* your fort change), **swarm wide** (N3 wide-`scale` focus showing the swarm enveloping the fort), **Heart's-eye** (N5 slow pull to the Heart as the inner wall falls), **dawn pull** (N5 win, slow focus on the Heart + sunrise as TOD glides to dawn).

---

## 9. Data-driven control interface — the editable cue-script schema + a concrete worked example

> **This is the owner's #1 ask — the "操作介面."** The entire siege is **data**: a `SIEGE_SCRIPT` cue array (the timeline) + a `DIRECTOR_PARAMS` knob block (the emergent composer). Tuning pacing / story / camera (運鏡) / weather (背景) / spawns (進場) / **terrain (更改地形)** = editing these, **never** engine code. The runtime is a generic dispatcher: `_SIEGE_CUE[kind]` maps each verb to a handler that calls one clean engine API. Crucially, the **DIRECTOR emits cues at runtime into the SAME pipeline** — authored cues (Nights 1–5) and emergent cues (Night 6+ / adaptive targeting) share one schema. Adding a new threat = one `_SIEGE_CUE` entry + data rows; no engine surgery.

### 9.1 Where it lives

`js/missions/siege/siege_script.js` — pure data: the `SIEGE_SCRIPT` array, the `DIRECTOR_PARAMS` block, and the siege `LOG_ENTRIES`. This file is the owner's control surface; it has no logic.

### 9.2 Runtime model

The director (`updateSiegeDirector()`, called from the mission factory's `update()`) tracks:
- `game._siege.night` — current night (1…N).
- `game._siege.t` — seconds into the current night's active phase.
- `game._siege.phase` — `'lull' | 'telegraph' | 'assault' | 'dawn'`.
- `game._siege.intent` — `{ gate, threat, until }` (drives the HUD warning + biases the next spawns).
- Per night: fire each cue **once** when `at` is reached; advance the night when authored cues are exhausted **and** the field clears + `SIEGE_CLEAR_GRACE` elapses; open the `dawn` build window of the cue's `dur`; then the next night's `lull`.

### 9.3 Cue shape

```
{ night, at, kind, ...params }
```
- `night` *(number | string)* — which night the cue belongs to (1…5). `'_proc'` = the procedural-escalation generator for Night 6+.
- `at` *(number)* — seconds into that night's active phase the cue fires.
- `kind` *(string)* — a verb in the `_SIEGE_CUE` dispatch table (below).
- `...params` — per-kind fields.

### 9.4 Every cue KIND — the timeline's complete vocabulary

| `kind` | params | effect | engine API it drives |
|---|---|---|---|
| `beat` | `zh`, `en` | story banner / narration toast (劇情) | `showSwapToast(zh\|en)` (bilingual via `getLang()`) |
| `goal` | `zh`, `en` | set the persistent on-HUD objective line for the night | `game._siege.goal = {zh,en}` (read by `renderHUD`) |
| `tod` | `name:'dusk'\|'night'\|'dawn'\|'day'` | day/night palette | `TOD.setTOD(name)` |
| `weather` | `w:'clear'\|'wind'\|'rain'\|'storm'` | background FX overlay (背景) | sets `game._siege.weather` (FX layer reads it) |
| `telegraph` | `gate:'N'\|'E'\|'S'\|'W'\|'adaptive'`, `dur`, `threat:'armour'\|'mass'\|'air'` | INTENT warning + biases next spawns to that edge | sets `game._siege.intent`; `'adaptive'` resolves to the weakest/least-repaired gate |
| `spawn` | `unit:'sapper'\|'tank'\|'marauder'\|'walker'`, `n`, `gate?:'N'\|'E'\|'S'\|'W'\|'telegraphed'`, `target?:wallId` | enemy entry (進場) at the (optionally gate-biased) anchor; `tank`/`walker` get the breacher mutation + a wall `target` to grind | `pickBiasedSpawn('nnArena')` → `_arenaSpawnFactoryBot('red',x,y)` (+ tank post-process) |
| `drone` | `n`, `target:'core'\|'player'`, `from?` | drone swarm with siege objective routing | `spawnDroneEnemy(cfg)` ×n |
| `camera` | `fx:'focus'\|'shake'`, `on:'gate-N'\|'core'\|'tank'\|'swarm'\|{x,y}`, `scale?`, `dur`, `mag?` | cinematic move (運鏡) | `focus`→`game._cineFocus={x,y,scale,until}`; `shake`→`triggerShake(mag,dur)` |
| `terrain` | `op:'breach'\|'reinforce'\|'opengate'`, `target:wallId`, `hp?` | **scripted terrain change (更改地形)** — pre-weaken/collapse a segment, or open the gate at a dramatic beat | mutate the named `building.hp` / splice it from `buildings` |
| `wall` | `seg:wallId`, `hp?`, `breach?:true` | set/zero a named wall segment's HP (scripted collapse / pre-weaken) | direct `building.hp` write (alias of `terrain` for HP-only edits) |
| `conduit` | `node:'NE'\|'SW'\|'armory'`, `action:'raid'` | spawn a marauder push to contest a refill/objective (forces a sortie) | `_arenaSpawnFactoryBot` marauders at the node |
| `objective` | `set:'charge'\|'hold'`, `rate?` | tune the score/charge behaviour for this night | `game._siege.chargeRate` |
| `lull` | `dur` | open / override the inter-phase repair window | `game._siege.phase='lull'`, length `dur` |
| `dawn` | `windowSec?`, `salvage?` | open the dawn build window (calm + energy payout + repair hint); on the **final** night, trigger `isComplete` | `game._siege.phase='dawn'`; credit `game._energy += salvage`; final-night flag |
| `log` | `entry` | unlock an operator-log fragment | mark `LOG_ENTRIES[entry]` read (localStorage `ag.logsRead`) |
| `proc` | `tankBase`, `droneBase`, `escalate`, `windowSec` | Night 6+ procedural generator (endless); the DIRECTOR composes from `DIRECTOR_PARAMS` and **emits** `telegraph`/`spawn`/`camera`/`drone` cues into this same pipeline | (composes other cues) |

> **Extensibility rule:** a brand-new threat = (1) one `_SIEGE_CUE` handler entry, (2) reference it from `SIEGE_SCRIPT` data. The runtime dispatches generically; no engine file changes.

### 9.5 DIRECTOR_PARAMS — the emergent knobs (what makes runs differ)

```js
const DIRECTOR_PARAMS = {
  basePressure:     6,          // baseline "army points" per night
  pressurePerNight: 4,          // linear ramp
  perfMultiplier:   [0.9, 1.6], // [struggling, dominating] — reads K/D + wall integrity (one-way-ish DDA)
  unitCost:   { sapper:1, marauder:2, tank:5, walker:9, drone:1 }, // budget spend per unit
  telegraphSec:     [8, 3],     // telegraph lead time shrinks as nights escalate
  lullSec:          [10, 4],    // dawn/lull window shrinks as nights escalate
  targetGate:       'adaptive', // 'adaptive' = aim the weakest / least-repaired gate
  splitAfterNight:  4,          // when TWO-FRONTS becomes possible
  droneFloor:       3,          // min drones once drone nights begin
  finalDawnNight:   5,          // night whose `dawn` cue = WIN
  procFrom:         6,          // first fully-procedural night
};
```

### 9.6 Worked example — authored Night 2 ("鋼鐵 / IRON") + a Night 3 + the Night 6+ generator

```js
const SIEGE_SCRIPT = [
  // ─────────── NIGHT 2 · 鋼鐵 / IRON — the first wall-breaking tank ───────────
  { night:2, at:0,  kind:'tod',       name:'night' },
  { night:2, at:0,  kind:'weather',   w:'wind' },
  { night:2, at:0,  kind:'goal',      zh:'撐住北門 — 重裝甲來了',
                                       en:'HOLD THE NORTH — armour incoming' },
  { night:2, at:1,  kind:'beat',      zh:'第 2 夜 · 鋼鐵',  en:'NIGHT 2 · IRON' },
  { night:2, at:2,  kind:'log',       entry:'iron_in_the_dark' },

  { night:2, at:4,  kind:'spawn',     unit:'sapper', n:4, gate:'N' },              // screen for the tank
  { night:2, at:10, kind:'telegraph', gate:'N', dur:8, threat:'armour' },          // INTENT: "ARMOUR MASSING · NORTH"
  { night:2, at:10, kind:'camera',    fx:'focus', on:'gate-N', scale:1.4, dur:90 },// horn telegraph (運鏡)
  { night:2, at:11, kind:'beat',      zh:'聽見了嗎?引擎聲。', en:'You hear that? Engines.' },

  { night:2, at:14, kind:'spawn',     unit:'tank', n:1, gate:'N', target:'curtainN' }, // THE SETPIECE
  { night:2, at:15, kind:'camera',    fx:'focus', on:'tank', scale:1.2, dur:140 },     // ARMOUR REVEAL (運鏡)
  { night:2, at:30, kind:'spawn',     unit:'sapper', n:5, gate:'E' },                  // flank pressure

  // tank reaches the wall ~at:48; its _siegeTankBreach tick eats 'curtainN' live.
  { night:2, at:50, kind:'camera',    fx:'shake', mag:7, dur:30 },                     // breach punch
  { night:2, at:50, kind:'beat',      zh:'北牆破了!退守內堡!',
                                       en:'NORTH WALL BREACHED! Fall back to the keep!' },
  { night:2, at:52, kind:'spawn',     unit:'sapper', n:6, gate:'N', target:'innerN' }, // pour through the hole

  { night:2, at:90, kind:'beat',      zh:'撐住…天快亮了。', en:'Hold… dawn is close.' },
  { night:2, at:95, kind:'dawn',      windowSec:35, salvage:260 },  // clear-grace + build window → Night 3 lull

  // ─────────── NIGHT 3 · 蜂群 / THE SWARM — over the walls, in the rain ───────────
  { night:3, at:0,  kind:'tod',       name:'night' },
  { night:3, at:0,  kind:'weather',   w:'rain' },
  { night:3, at:0,  kind:'goal',      zh:'守住核心 — 注意天空', en:'GUARD THE HEART — watch the sky' },
  { night:3, at:0,  kind:'beat',      zh:'第 3 夜 · 蜂群 · 暴雨', en:'NIGHT 3 · THE SWARM · RAIN' },
  { night:3, at:3,  kind:'spawn',     unit:'tank',  n:2, gate:'telegraphed', target:'curtainW' },
  { night:3, at:8,  kind:'telegraph', gate:'E', dur:6, threat:'air' },
  { night:3, at:9,  kind:'drone',     n:6, target:'core', from:'E' },                   // OVER-THE-WALL
  { night:3, at:9,  kind:'camera',    fx:'focus', on:'swarm', scale:1.8, dur:70 },      // SWARM WIDE (運鏡)
  { night:3, at:30, kind:'weather',   w:'storm' },                                      // 背景 escalates mid-night
  { night:3, at:30, kind:'camera',    fx:'shake', mag:5, dur:18 },                      // thunder
  { night:3, at:52, kind:'dawn',      windowSec:30, salvage:300 },

  // ─────────── NIGHT 6+ · 長夜 / THE LONG NIGHT — procedural endless ───────────
  { night:'_proc', kind:'proc', tankBase:3, droneBase:8, escalate:1.25, windowSec:24 },
];
```

**To retune, the owner edits ONLY these data rows:** make the tank arrive sooner (lower its `spawn.at`), add a second tank (bump `n` or add a row), change the dwell (`camera.dur`), swap rain for wind (`weather.w`), rewrite the dialogue (`beat.zh/en`), make the gate fall dramatically on cue (`terrain op:'breach' target:'curtainN'`), shorten the build window (`dawn.windowSec`), or re-theme stormy (`tod`/`weather`). New nights = append rows with a new `night` number. No handler, no engine change.

---

## 10. Architecture (new files, clean APIs reused, flag/gating, additivity, modular layout)

**Self-contained subtree `js/missions/siege/` — nothing bolted onto survival.** Each file is one concern.

| New file | Responsibility | Clean engine APIs it builds on |
|---|---|---|
| `js/missions/siege/siege_script.js` | **Data only** — `SIEGE_SCRIPT` cue array + `DIRECTOR_PARAMS` + siege `LOG_ENTRIES`. The owner's control surface; no logic. | — (pure data) |
| `js/missions/siege/siege_director.js` | `updateSiegeDirector()` + `_SIEGE_CUE` dispatch + night/phase/grace/dawn state machine + the procedural Night 6+ composer + adaptive targeting + INTENT/telegraph state. Ticked from the **factory's `update()`** (self-contained — cleaner than a global loop hook). | `_arenaSpawnFactoryBot`, `spawnDroneEnemy`, `pickBiasedSpawn`, `TOD.setTOD`, `triggerShake`, `showSwapToast`, `game._cineFocus`; siege-only `_siegeTankBreach` (AABB-vs-circle on `building.hp`) |
| `js/missions/siege/siege_mission.js` | `MISSION_FACTORIES.siege = function(mapDef){…}` — the mode contract: `title/titleEn/objective`, `playerSpawn` (the Heart), `setupStructures` (places the Heart `spawn-relay` + murder-hole footings + Armory), `update()` (director + breacher tick + Heart-HP + salvage hook), `renderHUD()` (night # / goal / Heart-HP / lives / INTENT / breach counter), `isComplete()` (final-night dawn + Heart alive), `isFailed()` (Heart dead OR garrison-extinct-with-no-hold), `tryRevive()` (garrison-wake / autopilot), `getRunSummary()` (`{night, heartHpPct, breachesSealed, kills}`). | `MISSION_FACTORIES`, mission lifecycle in `mission_runtime.js` (`initMission`/`updateMission`/`onMissionSuccess`/`onMissionFailed`/`showNNEndCard`), `setupStructures`/`playerSpawn` |
| `js/missions/siege/siege_arena.js` | `siege_bastion` entry in `NN_MAP_VARIANTS` (`walls()` = concentric fort, named gates, Heart, Armory, murder-holes, catwalks, `modes:['siege']`) + helpers to fetch a gate anchor / named wall segment by id. | `NN_MAP_VARIANTS`, `buildNNArenaVariant`, `addBuilding`/`addWallLine`/`addLowCover`/`addOverhead`/`addLandmark`, `STRUCTURE_DEFS` (`spawn-relay`/`factory`), `NN_ARENA` |
| `js/missions/siege/siege_fx.js` | Siege weather + lightning FX layer + the lives/Heart/INTENT HUD strip; the dawn flash. All `registerFxLayer` calls gated `when:()=>game._siege`. | `registerFxLayer` (spaces: `world` / `overlay-under-hud` / `overlay-over-hud`), `COLORS`, `ctx` |

**Wiring into existing engine — minimal, additive, ALL flag-gated (each touch reuses a name freed by the §2 removal):**
- `js/camera.js`: one `siegeCine` row prepended to `CAMERA_MODES` (top priority, `when:()=>game._siege && game._cineFocus && game.time < game._cineFocus.until`). Inert when the flag is off.
- `index.html` main loop: one `if (game._siege && typeof updateSiegeDirector==='function') updateSiegeDirector();` — *but preferably the director ticks from the factory's `update()`*, leaving the loop untouched (cleaner blast radius; the global slot freed in §2 stays empty).
- `index.html` `startNNSkirmish`: a clean `gameMode==='siege'` branch — sets `game._siege` (the object: `{night, t, phase, heart, weather, intent, garrison}`), forces the `siege_bastion` map, seeds the garrison roster, then routes to `initMission({type:'siege'})`. It does **NOT** masquerade as survival (no `gameMode='survival'` rewrite, no `_forceVariantId='survival_fort'`, no survival wave clock). **This is the key break from the removed version.**
- `index.html`: lobby button `data-mode="siege"`; `<script>` includes for the 5 new files.
- `js/progressive_unlock.js`: one `siege:` `MODE_UNLOCK_TIER` line.
- `js/death_decider.js`: one `if (game._siege)` branch → call the factory's `tryRevive()` (garrison-wake / autopilot) instead of timed respawn; falls through to existing logic otherwise. (Distinct from survival's revive path.)

**Flag / gating / additivity:** everything lives behind **`game._siege`** (an object set only by the siege lobby branch; unset → every new code path is inert). Every new FX layer, the camera mode, the director call, and the death branch self-guard on it. No shared mutable state is changed; DM/survival/defense/helo/convoy/duel/sniper/campaign stay **byte-identical**. The only edits to existing files are additive guarded rows/branches; all real logic lives in the new subtree. Timing unit untouched.

---

## 11. MP stance

**SOLO-only at ship — explicitly.** The mode is authored, single-operator, no-respawn with a positional garrison and an adaptive director — a narrative chapter, not a competitive arena. The headless harness can't boot ONNX matches to validate MP anyway (standing constraint). All SIEGE code is `game._siege`-gated and never touches the MP reconcile path, so MP survival/arena stay byte-identical.

**What a future MP co-op siege would need (architecture kept extensible, NOT built now):**
- The **director becomes server-authoritative** — `SIEGE_SCRIPT` + `DIRECTOR_PARAMS` run on the PartyKit server; cues broadcast as events (telegraph/spawn/camera/beat) so all clients see the same horn at the same tick. The director is deliberately a near-pure function of `(night, t, fort-state)` → cues, so a server runs the identical dispatch.
- The **garrison roster becomes a shared team pool** (co-op lives); no-respawn becomes "spectate until the squad falls or the night is held."
- **Reconciled state in `MpReconcile`:** Heart HP, named wall-segment HP (terrain sync is the hard part), salvage economy. The self-snapshot pipeline from Phases 173–175 is the model.
- `_cineFocus` becomes a **per-client suggestion** (you don't yank another player's camera).
- TWO-FRONTS night is practically begging for 2–4 operators splitting gates — the natural co-op fantasy. **Explicitly deferred** to a post-SOLO phase, after `npx partykit deploy` + a 2-client smoke.

---

## 12. Implementation phases (each an ordered, shippable slice) + CI guards/tests

Each phase is a self-contained dev commit; CI (`tools/check_inline.js` + the 10-check gate) must be green before the next. Nothing reaches main until the whole arc is play-tested by the owner, version-stamped, and CI-green.

- **Phase 0 — REMOVE.** Execute §2 in order; CI green; the codebase reverts to pre-188 with the `siege`/`game._siege`/`siegeCine`/loop-slot names freed. *Guard:* existing 10-check gate stays green; `tools/check_inline.js`.
- **Phase 1 — Arena.** `siege_arena.js`: the `siege_bastion` `NN_MAP_VARIANTS` entry (concentric fort, named gates, Heart `spawn-relay`, Armory, murder-hole footings, catwalks). Loadable via a debug route; nothing else wired. *Test:* `tools/test_siege.js` asserts the variant builds, the Heart/gates/Armory exist with expected ids + HP.
- **Phase 2 — Factory skeleton.** `siege_mission.js`: `MISSION_FACTORIES.siege` with `playerSpawn`=Heart, `setupStructures`, a no-op `update()`, `isFailed()`=Heart-dead, `renderHUD()` (night/Heart-HP). Lobby button + `startNNSkirmish` siege branch (sets `game._siege` object, forces `siege_bastion`, seeds garrison) + `<script>` includes + unlock tier. Mode boots, you stand at the Heart, no enemies. *Test:* boot smoke (Playwright MCP: navigate → 1 combined eval that selects siege, asserts `game._siege` set + Heart present → close); `test_siege.js` asserts factory registers + `isFailed` flips when Heart HP forced to 0.
- **Phase 3 — Director + data + cue dispatch.** `siege_script.js` (Night 1–2 authored + `DIRECTOR_PARAMS`) + `siege_director.js` (`updateSiegeDirector` ticked from the factory `update()`, `_SIEGE_CUE` dispatch for `beat`/`goal`/`tod`/`weather`/`spawn`/`drone`/`telegraph`/`camera`/`lull`/`dawn`/`log`). Night 1 fully playable (probe). *Test:* `test_siege.js` asserts the `_SIEGE_CUE` table is **exhaustive** (every `kind` used in `SIEGE_SCRIPT` has a handler) and that the director advances `night`/`phase` over simulated ticks.
- **Phase 4 — Breacher tanks + terrain mutation (更改地形).** Tank post-process + `_siegeTankBreach` tick (subtract named `building.hp` on contact, splice at 0) + `terrain`/`wall` cues + the breach camera punch. Walls fall and stay fallen. *Test:* `test_siege.js` asserts a tank pressed to a named wall drains its HP and that `terrain op:'breach'` splices the segment from `buildings`.
- **Phase 5 — Garrison lives + weld/build + salvage.** `death_decider.js` siege branch → `tryRevive()` garrison-wake at the Heart; AUTOPILOT grace; recruit/Armory adds a life; the `weld` build-action restoring `building.hp`; dawn salvage lump-sum into `game._energy`. *Test:* `test_siege.js` asserts roster decrement on death, garrison-wake places the pawn at the Heart, weld restores HP, and run ends only when roster empty + Heart undefended.
- **Phase 6 — Camera, weather/TOD, FX, HUD.** `siege_fx.js` (`siegeCine` CAMERA_MODE, weather + lightning FX layer, lives/Heart/INTENT HUD strip, dawn flash) + the full 運鏡 setpieces wired to cues. *Test:* boot smoke confirms FX layers register only under `game._siege`; visual review by owner.
- **Phase 7 — Authored Nights 3–5 + story arc + procedural Night 6+.** Complete `SIEGE_SCRIPT` (swarm/storm/gate-push), the operator-log `LOG_ENTRIES`, the `proc` generator + adaptive `targetGate`/perf-multiplier composer. WIN at Night-5 dawn; endless beyond. *Test:* `test_siege.js` asserts `isComplete` fires at the final-night `dawn` with Heart alive; `proc` emits valid cues.
- **Phase 8 — Polish + balance + ship.** Energy re-tune, telegraph/lull pacing pass, owner play-through (the only validation possible — headless can't boot ONNX matches). Then `node tools/version.js stamp <N>`, full CI green, dev→main.

**Standing guards (every phase):** `tools/check_inline.js` (CI #10) — no new inline bloat in `index.html`; the 10-check gate (syntax + version + sim-parity + reconcile + director); new `tools/test_siege.js` added to the gate. No timing-unit edits. All new code `game._siege`-gated; other modes verified byte-identical.

---

## 13. Open questions for the owner

1. **Win vs endless framing.** Is Night-5 dawn a **hard win that ends the run** (then a separate endless mode), or does the run *continue* into procedural Night 6+ after a "DAWN HOLDS" milestone toast (best-night score chase)? Blueprint currently does the latter (story completes at N5; play continues).
2. **Garrison size & order-as-strategy.** Default garrison N = 3? Should the lineup **order** be player-chosen at lobby (life #1 = Humanoid rebuild, #2 = Heavy anti-tank, #3 = Wolf last-stand), or fixed by the lineup you bring?
3. **AUTOPILOT grace.** Keep the "fort holds without you → whole garrison wakes at dawn" triumphant beat, or is last-body-down an immediate loss (simpler, harsher)? It softens the no-respawn ask — is that desirable?
4. **Energy/salvage economy magnitude.** Confirm the dawn lump-sum range (example uses 260–300⚡) and the higher trickle — this is the single biggest feel lever for the build-centric loop. Owner's prior note: survival's 3/sec is too slow.
5. **Score definition.** Score = nights survived only, or **nights + Heart-HP% bonus + breaches-sealed** (Vision 3's richer `getRunSummary`)? Affects leaderboard semantics.
6. **Adaptive director intensity.** The performance-multiplier (`perfMultiplier:[0.9,1.6]`) is one-way-ish DDA (never easier than baseline). Acceptable, or should SIEGE be **fully authored / non-adaptive** so the five nights play identically every run (more "directed film," less "systemic opponent")?
7. **South Collapse permanence.** The unsealtable pressure-valve hole — keep it permanent (forces a babysat flank every night), or make it weldable-but-expensive (more player agency, less guaranteed tension)?
8. **Weld as a new build-action vs. reuse `medstation`/repair.** Should "weld a breach" be a brand-new build-mode action, or routed through an existing repair primitive if one exists in `STRUCTURE_DEFS`? (Affects whether `defense_build_ui.js` needs a siege-only entry.)
9. **MP timing.** Confirm SOLO-only ship is acceptable and co-op siege is a clearly separate, later phase (post 2-client smoke), as the blueprint assumes.