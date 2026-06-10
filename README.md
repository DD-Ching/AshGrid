# AshGrid

Online PvP top-down tactical .io shooter. Both teams run the same PPO neural
network — in-browser via ONNX Runtime Web for SOLO, and on an authoritative
server for online multiplayer; you take over one slot and fight live opponents.

The shipped product is the **online multiplayer .io game** at
[ashgrid.io](https://ashgrid.io). The same build also runs SOLO/offline against
NN bots, and is distributed on CrazyGames and a GitHub Pages mirror.

## Core loop — arena recruitment

Wings.io-style progression: kill or wound an enemy NN unit, walk up to it, press
`G`, and it **converts onto your squad** — a bot that now fights for you. This is
the central progression hook, not a side mechanic.

Recruitment is fully **manual** (`G` key) and gated by a SEED skill differential
(recruiter SEED − target SEED must exceed `ARENA_SEED_GAP`, i.e. > 10). It works
in **both** SOLO and online MP:

- SOLO scans local `enemies[]` (`js/arena_recruitment.js`, `_arenaTrySEDConvert`).
- MP finds the nearest recruitable server bot in `remoteBots`, sends a `recruit`
  message, and the authoritative server re-checks every gate, flips the bot's
  team, and broadcasts `recruitOk` so every client fires the convert VFX
  (`js/arena_recruit_mp.js` + a server `recruit` handler — wired in Phase 159).

## Run it

No build step, no bundler. Serve the repo from any static HTTP server, open `/`:

```bash
python3 -m http.server 8765
# http://localhost:8765/
```

URL shortcuts (via Cloudflare Pages `_redirects`):

| Path    | Lands in                          |
|---------|------------------------------------|
| `/play` | `?nn=1&mp=1` — online multiplayer  |
| `/mp`   | `?nn=1&mp=1` — online multiplayer  |
| `/solo` | `?nn=1&solo=1` — SOLO vs NN bots   |

PWA-installable in any modern browser. Service worker pre-caches the shell
and every `.onnx` brain so SOLO works offline after first load.

### Multiplayer server (online play)

Online MP is **authoritative** — a real server holds the world's truth, not a
P2P relay (the old Trystero/WebRTC P2P was removed in Phase 33). It runs on
**PartyKit** (Cloudflare Workers + Durable Objects, one Durable Object per
room). The server (`server/party/server.js`, ~1710 lines) runs a full
authoritative sim: server-side NN bot inference, server-owned bullets,
lag-compensated hit detection, and delta snapshots at 20–30Hz.

Run the server locally and point the client at it:

```bash
cd server && npx partykit dev   # serves ws://localhost:1999
# then open the game with ?mp=1 — localhost is auto-detected
```

Deploy the server (separate from the static site):

```bash
cd server && npx partykit deploy
# production host: ashgrid-mp.dd-ching.partykit.dev (PRODUCTION_HOST in js/multiplayer.js)
```

Host resolution order in `js/multiplayer.js`: `?ws=<host>` URL param →
`window.MP_PARTYKIT_HOST` → localhost auto-detect → `PRODUCTION_HOST`.

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
- 3 free slots, extends to 5 via rewarded-ad slot (`editor_extra_slots`)
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
+3/s passively, +20 per kill, plus per-wave bonuses in Defense.
(Tunable values live in `js/balance.js` — `BALANCE.energy.*`,
`BALANCE.buildCost.*`.)

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
| G     | Recruit nearest eligible enemy (SEED gate); throws a grenade if no target |
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
| `?mp=1`              | Online multiplayer (default route; `?solo=1` opts back to bots) |
| `?fresh=1`           | Unregister all SWs, clear all caches, reload bare. Use after a deploy. |
| `?reset=1`           | Wipe `ag.*` localStorage; everything unlocked on fresh launch.   |
| `?reset=stats`       | Wipe matches/scores/leaderboards; keep language + operator name. |
| `?reset=tutorial`    | Full wipe + opt back into tier-gated unlocks.                    |
| `?ws=<host>`         | Point the MP client at a specific PartyKit host (testing).      |

## Persistence

Local progress lives under `localStorage.ag.*`. The **global leaderboard is a
live cloud backend**, not local-only (see below).

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
| `ag.playerId`          | per-device UUID, the leaderboard identity         |
| `ag.lbStats`           | local mirror of kills/deaths/streak/matches       |

### Global leaderboard (live, since Phase 23)

`js/leaderboard.js` backs a **live global ranking** by Firebase Realtime
Database — plain REST (no SDK): debounced `PUT` upserts (~every 8 s, plus a
tail push on `pagehide`/`beforeunload`) and a cached `GET` for the top list.
Counters are mirrored in `localStorage` so progress never goes backwards on a
network blip, but the cloud copy is real, not a stub.

It is client-authoritative (anyone *can* post fake numbers) — an acceptable v1
trade for an .io with no monetary stakes; harden later with Cloud Functions.

> **Operational warning**: the Firebase RTDB security rule is time-boxed
> (`now < <timestamp>`). It must be extended in the Firebase Console before it
> expires, or the live leaderboard reads/writes get blocked.

## Ads

Rewarded + interstitial ads run through `js/ad_dispatch.js` (single
`window.requestRewardedAd` entry point, fixed provider priority).

- **CrazyGames SDK** is fully integrated (`js/crazygames.js`): loading /
  gameplay / happytime lifecycle events, midgame interstitials, and rewarded
  ads. On their portal these fire real ads; in local dev the SDK shows a
  dev-mode overlay and ads resolve without playing.
- **AdMob / GameMonetize** remain stubs awaiting credentials (GameMonetize was
  dropped from the priority list in Phase 131).

Live rewarded trigger: **squad revive** on a team-wipe (`js/death_recap.js` —
revive + 30-min fast-respawn buff). A build-phase / skip-wave rewarded surface
exists in the HUD/touch code but is currently inert — not a shipping feature.

## Cloud / backend

The project is **not** zero-backend. Two cloud services are live:

- **Firebase Realtime Database** — the global leaderboard (above).
- **PartyKit (Cloudflare Workers + Durable Objects)** — the authoritative MP server.

The one remaining cloud stub is `uploadSurvivalRun` in `js/run_history.js`
(a no-op; local run history is authoritative).

## Architecture

Three layers; most bugs cluster at their boundaries:

1. **NN-client** — 60 fps render + local input prediction (the browser game).
2. **PvP-server** — 20–30Hz authoritative sim (`server/party/server.js`).
3. **Hybrid-player** — local prediction reconciled against server truth
   (`js/mp_reconcile.js`).

## Project layout

```
index.html            entry shell (HTML + CSS + boot, ~6.7k lines)
js/*.js               ~60 classic-script modules (globals, no bundler)
  input.js weapon_state.js ad_dispatch.js pawn_swap.js bullets.js
  world_render.js world_gen.js hud.js enemy_ai.js render_overlays.js
  multiplayer.js mp_reconcile.js arena_recruitment.js arena_recruit_mp.js
  leaderboard.js balance.js crazygames.js ...      (R1–R14, Phases 116–159)
js/missions/          mission scripts (nn_deathmatch, nn_arena_variants)
server/party/         PartyKit authoritative MP server (~1710 lines)
sw.js                 service worker — network-first HTML, cache-first ONNX/icons
manifest.webmanifest  PWA install manifest
icons/                PWA icon set
assets/               audio + images
ai_arena/
  onnx/               exported PPO brains (~110 KB each)
  *.ipynb             training notebooks (run on Kaggle)
tools/                version.js (stamp/check) · check_sim_parity.js · githooks/pre-commit
scripts/build-zip.sh  CrazyGames upload zip
_headers _redirects   Cloudflare Pages config
.github/workflows/    pages.yml (Pages deploy) · checks.yml (CI gate)
AGENTS.md             rules for AI coding agents (Claude Code etc.)
ARCHITECTURE.md       deeper system map (data flow, render order, extension points)
ROADMAP.md            release phases + status snapshot
CLAUDE.md             repo rules (git workflow + modular-first coding standard)
README.md             this file
```

The game is **modular**: ~66 module files total (~60 `js/*.js` + `js/missions/`),
loaded as plain `<script src>` globals with a `?v=NNN` cache-bust (currently
`v210`). `index.html` is the boot shell, not a monolith. There is no bundler.

## Tech

- Vanilla JS modules (classic-script globals), no bundler.
- ONNX Runtime Web (CDN-loaded) for PPO inference (SOLO + server-side bots).
- Canvas 2D rendering at 60 fps; world transform vs HUD transform split; render
  interpolation for smooth scroll at any refresh rate.
- Service worker for offline + asset cache.
- PartyKit (Cloudflare DO) for authoritative MP; Firebase RTDB for the
  leaderboard; CrazyGames SDK for ads.

## Maintenance / CI

- **Single balance config** — `js/balance.js` (energy economy, build costs).
- **Asset version stamp + integrity** — `node tools/version.js check` verifies
  every `<script src="js/*">` exists, is git-tracked, and shares one `?v=`.
- **SOLO/MP sim parity** — `node tools/check_sim_parity.js` catches
  client↔server weapon / observation drift.
- **Pre-commit gate** — `tools/githooks/pre-commit` (JS syntax + version +
  parity), mirrored server-side by `.github/workflows/checks.yml` (on `dev` +
  `main`) so it can't be bypassed with `--no-verify`.
- **Unit death chokepoint** — `killUnit` + `onUnitDeath` is the single path for
  kills/deaths.

## Deploy

- **GitHub Pages mirror** — auto-deploys on push to `main` via
  `.github/workflows/pages.yml` (the whole repo is the static site; no build).
- **ashgrid.io** — Cloudflare Pages (uses `_headers` + `_redirects`).
- **CrazyGames** — manual upload zip via `scripts/build-zip.sh`.
- **MP server** — deploys separately with `cd server && npx partykit deploy`
  (it is *not* bundled with the static site).

## Git workflow

Develop on `dev`; `main` only accepts `dev → main` merges. Never commit directly
to `main`. (See `CLAUDE.md` for the full rule + the modular-first coding standard.)

## Status

Live online .io product (ashgrid.io) plus SOLO/offline play. See `ROADMAP.md`
for the deploy checklist and what's left on the runway.
