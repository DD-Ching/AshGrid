# AshGrid — project rules (root)

Online top-down .io tactical shooter. Live at **ashgrid.io** (GitHub Pages from `main`).
Architecture: one big inline `<script>` in `index.html` (game loop / update / render / player)
+ `js/*.js` **classic-script** modules (top-level `function`/`const`/`let` are cross-file
globals) + `server/party/server.js` (PartyKit, server-authoritative multiplayer).

> Folder-scoped rules live next to the code — read the nearest one when you work there:
> [`js/CLAUDE.md`](js/CLAUDE.md) · [`js/missions/CLAUDE.md`](js/missions/CLAUDE.md) ·
> [`server/CLAUDE.md`](server/CLAUDE.md) · [`tools/CLAUDE.md`](tools/CLAUDE.md).
> Keep each file LEAN + about ITS folder. Repo-wide rules + the tunables map stay here.

## Cardinal rules (do not break)

1. **Branch:** develop on `dev`; ship by `merge dev → main` only. NEVER commit/push `main` directly.
2. **Timing unit:** the global `*60` / `*84` "tick-second" scaling is intentional and **off-limits** — never "fix" it.
3. **Before shipping `dev → main`:** stamp the cache version (`node tools/version.js stamp <N>`)
   and the CI gate must be green. See [`tools/CLAUDE.md`](tools/CLAUDE.md).
4. **MP server changes** (`server/`) need `cd server && npx partykit deploy` + a 2-client smoke
   **and the owner's OK** before they count as shipped. See [`server/CLAUDE.md`](server/CLAUDE.md).
5. **No autonomous multi-file big refactors** — propose scope/commits/risk first, get a yes.
   Small edits + new-feature-in-a-new-file are fine without asking.
6. **Behaviour-preserving by default** ("不能降低遊玩體驗"): gate every new/risky behaviour behind a
   flag (`game._classes`, `game._siege`, `game._npcAI`) so the old path stays byte-identical.

## Tunables map — "want to change X? edit ONE place"

Tune by editing the named constant; don't scatter magic numbers. (★ = client **and** server copy
must match — `tools/check_sim_parity.js` enforces it.)

| Want to change… | Edit | Where |
|---|---|---|
| Energy economy (regen, per-kill, ability costs) | `BALANCE.energy` / `BALANCE.ability` | `js/balance.js` |
| Wolf feel (dash DR, kill-lifesteal, devour regen, killstreak frenzy) | `BALANCE.wolf` | `js/balance.js` |
| Chassis stats (hp/armour/speed/radius/abilities) | `CHASSIS` | `js/chassis.js` |
| Heavy arsenal size / ultimate fan (spread + concentration cap) | `ARSENAL_CAP`, `ULT_FAN_STEP`, `ULT_FAN_MAX` ★ | `js/heavy_arsenal.js` (+ server) |
| Weapon stats ★ | `WEAPONS` ↔ `_BASE_30HZ` | `js/weapons.js` ↔ `server/party/sim/weapons.js` |
| Recruit / devour / seize gates ★ | `ARENA_SEED_GAP`/`HP_GATE`/`SQUAD_CAP`/`TOUCH_BUFFER` | `js/arena_recruitment.js` (+ server) |
| Structure cost / HP | `BALANCE.buildCost` + `STRUCTURE_DEFS` | `js/balance.js` + `js/structures.js` |
| Wave scaling (survival/siege) | `_waveInterval` / `_waveSize` | `js/missions/nn_deathmatch.js` |
| Maps / arena variants | `NN_MAP_VARIANTS` | `js/missions/nn_arena_variants.js` |
| Which modes are unlocked when | `MODE_UNLOCK_TIER` | `js/progressive_unlock.js` |

## Mode / feature flags

`game._classes` chassis-classes (builder/wolf/heavy; default ON in dev) · `game._siege` siege
last-stand mode · `game._npcAI` NPC director (on unless `=== false`) · `game._achvFx` achievement
card · `game._rangeFair` hostile-bullet range cap (on unless `=== false`; set `false` for the
byte-identical legacy full-range path — `hostileBulletLife` in `js/bullets.js`). Default a new
flag ON only in dev; decide explicitly before it reaches `main`.
