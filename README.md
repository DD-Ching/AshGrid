# AshGrid

Single-file HTML5 top-down tactical sim. Both teams run the same PPO neural
network in-browser via ONNX Runtime Web; you take over one slot.

## Run it

No build step. Serve the repo from any static HTTP server, open `/`:

```bash
python3 -m http.server 8765
# http://localhost:8765/
```

PWA-installable in any modern browser. Service worker pre-caches the shell
and every `.onnx` brain so it works offline after first load.

## What you can play

### A1 · Skirmish (NN combat, 7 modes)

| Mode      | Goal                                                |
|-----------|-----------------------------------------------------|
| DM        | First to `max(5, 3 × team size)` kills, or 90 s clock |
| Survival  | Hold every wave; dead allies stay dead              |
| Defense   | Spawn-beacon waves; build between rounds            |
| Helo      | Hold a 60 s LZ, then 9 s board+lift                 |
| Convoy    | Escort a UGV across the map without losing it       |
| Duel      | 1 vs 1, no respawns                                 |
| Sniper    | Both teams forced to SNIPER, long-range only        |

Lobby picks blue/red size (1–8 each, asymmetric OK), one of 6 NN styles for
the team, weapon, chassis. `CUSTOM LINEUP` lets each slot pick its own brain.

### A2 · Campaign (6 missions across 5 maps)

| # | Mission                  | Map           | Type          |
|---|--------------------------|---------------|---------------|
| 1 | Hold the Last Relay      | Reactor Pool  | hold (90 s)   |
| 2 | Recover Black Box        | Foundry       | recover+extract|
| 3 | Convoy Escort            | Container Yard| escort        |
| 4 | Capture A/B/C Nodes      | Data Core     | capture       |
| 5 | Heavy Insertion          | Data Core     | heavyInsert   |
| 6 | Destroy the Hive         | Drone Hive    | destroyHive   |

3 mission failures in a row ends the run. Each victory bumps `ag.stats.matchesPlayed`.

### Map editor

- 60u-grid wall placement, drag-line drawing, multi-spawn per team
- 3 free slots, extends to 5 via rewarded-ad stub (`editor_extra_slots`)
- `TEST` button drops you into the active slot in any of the 7 NN modes;
  custom slot is also rolled in normal Skirmish if at least one is filled

## Loadout

| Axis     | Options                                                              |
|----------|----------------------------------------------------------------------|
| Weapons  | RIFLE · SMG · SHOTGUN · LMG · SNIPER · ROCKET                        |
| Chassis  | humanoid (balanced) · wolf (fast/fragile) · heavy (slow/armored)     |
| NN style | ELITE · WARRIOR · DEFENSIVE · SHARPSHOOTER · CQB · TACTICAL          |

TACTICAL currently routes to ELITE weights — the retrained PPO policy for it
collapsed and is pending a re-export. The picker is still live so the unlock
UX doesn't regress.

The four legacy difficulty tiers (`easy / medium / hard / evolved`) ship in
`ai_arena/onnx/` and are precached by the SW for backwards compat, but no
lobby button exposes them today.

## Build system

Press `B` to enter build mode in any NN match. Energy `⚡` accrues at
+0.5/s passively, +20 per kill, plus per-wave bonuses in Defense.

16 modules, three power classes:

| Class      | Modules                                | Notes                              |
|------------|----------------------------------------|------------------------------------|
| Cover      | cover · wall · bunker                  | drag-line; bunker eats 1 RPG       |
| Detection  | sensor · camera                        | camera adds shared vision (powered)|
| Offense    | turret · tesla · dronebay              | all need power + drain `⚡` per shot|
| Crowd ctl  | mine · tripmine · smoke · emp          | EMP is the only one needing power  |
| Support    | generator · medstation · terminal      | medstation/terminal need power     |
| Spawner    | bot                                    | deploys an NN ally on placement    |

**Power grid**: generators radiate 200u. Wall lines touched by that field
become powered conductors and chain power through other touching walls (BFS).
Any module within 60u of a powered wall (or directly inside a 200u generator
ring) is powered. Unpowered modules pause and show a `⚡ NO PWR` chip.

Modules can be upgraded I → II → III by pressing `U` while standing next to
them. Each tier multiplies HP / damage and reduces cooldown.

## Controls

### Keyboard

| Key   | Action                                                |
|-------|-------------------------------------------------------|
| WASD  | Move                                                  |
| Mouse | Aim · hold to fire                                    |
| Shift | Sprint (drains stamina)                               |
| R     | Reload                                                |
| X     | Swap primary ↔ secondary weapon                       |
| Q     | UAV recon (toggle)                                    |
| E     | FPV kamikaze drone                                    |
| G     | Throw grenade                                         |
| B     | Build mode                                            |
| U     | Upgrade nearest module                                |
| V     | Aim assist (lock to nearest visible enemy)            |
| TAB   | Command view ↔ tactical view                          |
| 1–7   | (command view) issue squad order: 1 RALLY, 2 SPREAD, 3 ATTACK, 4 DEFEND, 5 PROTECT, 6 SUPPRESS, 7 RETREAT |
| 2–6   | (tactical view, NN mode) pawn-swap to that ally slot  |
| H     | Recall to spawn (escape hatch if you get stuck)       |
| Esc/P | Pause                                                 |
| Enter | (on end card) play again                              |

### Touch

Dual virtual sticks (left=move, right=aim), on-screen action buttons (R/Q/E/G/B/X),
radial selector for build mode. Auto-detected from `'ontouchstart' in window`.

## URL flags

| Flag                 | Effect                                                          |
|----------------------|-----------------------------------------------------------------|
| `?fresh=1`           | Unregister all SWs, clear all caches, reload bare. Use after a deploy. |
| `?reset=1`           | Wipe `ag.*` localStorage; everything unlocked on fresh launch.   |
| `?reset=stats`       | Wipe matches/scores/leaderboards; keep language + operator name. |
| `?reset=tutorial`    | Full wipe + opt back into tier-gated unlocks.                    |

## Persistence

All under `localStorage.ag.*`:

| Key                    | Contents                                          |
|------------------------|---------------------------------------------------|
| `ag.lang`              | `zh` / `en`                                       |
| `ag.muted`             | `0` / `1`                                         |
| `ag.aimAssist`         | `0` / `1`                                         |
| `ag.minimapCollapsed`  | `0` / `1`                                         |
| `ag.tutorialSeen`      | `1` once dismissed                                |
| `ag.introSeen`         | `1` once the awakening intro finishes             |
| `ag.unlockAll`         | `1` (default) skips tier gating, `0` opts back in |
| `ag.stats`             | `{matchesPlayed, totalKills, bestSurvivalWave}`   |
| `ag.lobbyConfig`       | last lobby pick                                   |
| `ag.customMaps`        | editor slots (`{active, slots: [...] }`)          |
| `ag.editorSlots`       | unlocked slot count (3–5)                         |
| `ag.survivalScores`    | top 10                                            |
| `ag.defenseScores`     | top 10                                            |
| `ag.achievements`      | `[id, ...]` of unlocked achievements (12 total)   |

## Project layout

```
index.html            main game (HTML + CSS + JS, ~17k lines, no bundler)
sw.js                 service worker — network-first HTML, cache-first ONNX/icons
manifest.webmanifest  PWA install manifest
icons/                PWA icon set
assets/               audio + images
ai_arena/
  onnx/               exported PPO brains (~110 KB each)
  *.ipynb             training notebooks (run on Kaggle)
AGENTS.md             rules for AI coding agents (Claude Code etc.)
ARCHITECTURE.md       deeper system map (data flow, render order, extension points)
ROADMAP.md            release phases + status snapshot
README.md             this file
```

## Tech

- Vanilla JS, single HTML file, no bundler.
- ONNX Runtime Web (CDN-loaded) for PPO inference.
- Canvas 2D rendering at 60 fps; world transform vs HUD transform split.
- Service worker for offline + asset cache.
- localStorage only — no backend. Firebase / AdMob hooks (`requestRewardedAd`,
  `uploadSurvivalRun`) are stubs ready to be wired to real SDKs.

## Status

PWA-shippable single-file build. See `ROADMAP.md` for the deploy checklist
(itch.io / Cloudflare Pages / Firebase / AdMob / Play Store) and what's left
on the runway.
