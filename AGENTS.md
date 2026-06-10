# AGENTS.md — AshGrid project rules for AI assistants

This file is read first by Claude Code (and any compatible coding agent)
working in this repo. Treat it as authoritative.

## Product identity — read this first

**AshGrid is an ONLINE PvP `.io` game.** The bought domain `ashgrid.io`
is the primary revenue product (the deployed online-multiplayer build).
It is also distributed on **CrazyGames** (ad revenue) and a **GitHub Pages
mirror**. A SOLO/local mode exists, but the online MP `.io` product is the
priority — when in doubt, fix MP first (local rarely breaks; the layer
boundaries in MP are where regressions bite).

### Core loop — arena recruitment

Kill or wound an enemy NPC, walk up to it, press **G** → it converts onto
**your** squad as a bot fighting for you (wings.io-style). This is THE
progression loop, not a side mechanic. It is gated by a SEED skill
differential (recruiter SEED − bot SEED > `ARENA_SEED_GAP` = 10; bots are
seed 0). It works in **both** SOLO and online MP — MP was wired in Phase 159
(`js/arena_recruit_mp.js` + a server `recruit` handler that re-validates the
gate authoritatively + a `recruitOk` broadcast so every client fires the
SED-convert VFX).

## Project at a glance

- **Not a single-file game.** `index.html` is ~6.7k lines and is the boot
  shell. Gameplay is split across **~66 module script files**: ~60 in
  `js/*.js` (classic-script globals, no ES modules) plus `js/missions/`.
  Modules were extracted in refactors **R1–R14** and **Phases 116–159**
  (`input.js`, `weapon_state.js`, `ad_state.js`, `pawn_swap.js`,
  `bullets.js`, `world_render.js`, `world_gen.js`, `hud.js`, `enemy_ai.js`,
  `render_overlays.js`, `multiplayer.js`, `arena_recruitment.js`, …).
- **No bundler.** Plain `<script src>` tags with a `?v=NNN` cache-bust query
  (currently **v210**). `tools/version.js` keeps every `?v=` in sync — never
  hand-edit individual version numbers.
- Static assets: `ai_arena/onnx/*.onnx` (PPO inference brains), images,
  `manifest.webmanifest`, `sw.js`.
- AI training notebooks: `ai_arena/*.ipynb` (run on Kaggle).
- Local preview server: Python `http.server` on port **8765**, launched
  via `.claude/launch.json` (`name: static`).
- Live URL: **http://localhost:8765/** (NOT `/index.html`).

## Multiplayer architecture — three layers

MP is an **authoritative WebSocket server**, NOT a broadcast relay and NOT
P2P. (Trystero/WebRTC P2P was the original approach; it was REPLACED in
Phase 33 because P2P is the wrong tool — real `.io` games use authoritative
servers.)

- **Transport:** PartyKit (Cloudflare Workers + Durable Objects). One Durable
  Object per room. `server/party/server.js` (~1710 lines) runs a full
  authoritative sim: server-side NN bot inference, server-owned bullets,
  lag-compensated hit detection, delta snapshots at ~20–30 Hz.
- `PRODUCTION_HOST = 'ashgrid-mp.dd-ching.partykit.dev'` (in
  `js/multiplayer.js`). Deploy the server with `cd server && npx partykit
  deploy` — it deploys **separately** from the static site.

The three layers (bugs cluster at the boundaries):

1. **NN-client** — 60 fps render + client-side prediction.
2. **PvP-server** — 20–30 Hz authoritative sim.
3. **hybrid-player** — local prediction + server reconciliation
   (`js/mp_reconcile.js`).

Before claiming an MP change works: run the PartyKit dev server
(`cd server && npx partykit dev`) and test with `?mp=1`.

## Cloud backend — it exists (NOT "zero backend")

- **Live global leaderboard** (`js/leaderboard.js`, since Phase 23) — real
  REST GET/PUT against a **Firebase Realtime Database** (`LB_FIREBASE_URL`),
  pushed ~every 8 s (debounced) + on `beforeunload`. It is **not** a stub.
- **PartyKit MP server** (above) — the authoritative game backend.
- The only remaining cloud **stub** is `run_history.uploadSurvivalRun`
  (`js/run_history.js`) — a no-op.

> **Operational warning — Firebase RTDB rule expiry.** The RTDB security
> rule is time-boxed (`now < <timestamp>`). It must be extended in the
> Firebase Console before it expires, or live leaderboard reads/writes get
> blocked. This is a manual, recurring chore — keep an eye on it.

## Ads

- **CrazyGames SDK is fully integrated** (`js/crazygames.js`) —
  loading / gameplay / happytime lifecycle events + rewarded + midgame
  interstitials. It registers itself as the `crazygames` provider with the
  ad dispatcher on SDK ready.
- Rewarded ads go through a single chokepoint: `window.requestRewardedAd`
  (owned by `js/ad_dispatch.js`), which selects a provider by fixed
  priority. **AdMob / GameMonetize remain stubs** awaiting credentials.
- **Working rewarded trigger: SQUAD REVIVE on team-wipe** (`js/death_recap.js`
  → `requestRewardedAd('revive', …)`, bundled with a 30-min fast-respawn
  buff; the buff-only `respawn_buff` path is the same dispatch).
- A build-phase / skip-wave rewarded surface exists in code
  (`build_phase_extend`, `game._skipWaveAdRect` in `hud.js` /
  `touch_input.js` / `index.html`) but is **currently dead** — the build
  phase isn't reachable in real matches. Do NOT describe it as working.

## Maintenance infra — use the tools, not the by-hand way

- **`js/balance.js`** — single `BALANCE` config for tunable gameplay numbers
  (energy economy, build costs). Loaded first; `structures.js` +
  `arena_recruitment.js` read it at definition time. Tune balance here, not
  with scattered magic numbers.
- **`tools/version.js`** — asset version stamp + integrity. `node
  tools/version.js check` verifies every `<script src>` file exists, is
  git-tracked, and shares ONE `?v=`; `… stamp [N]` bumps everything to N.
- **`tools/check_sim_parity.js`** — SOLO/MP sim-parity test (catches
  client↔server weapon / observation drift).
- **Pre-commit gate** (`tools/githooks/pre-commit`), mirrored server-side by
  CI (`.github/workflows/checks.yml`, runs on `dev` + `main` + PRs): JS
  syntax check (`node --check`), `version.js check`, `check_sim_parity.js`.
  The CI mirror exists so the checks can't be bypassed with `--no-verify`.
- **`killUnit()` + `onUnitDeath()`** (`js/kill.js`) — the single chokepoint
  for unit kills/deaths (flips alive/hp, awards score, bumps the
  leaderboard). Route deaths through it; don't hand-flip `alive`.

## Git workflow

- **Develop on the `dev` branch.** `main` only accepts `dev → main` merges.
- **Never commit / push directly to `main`.**

Flow: `git checkout dev` → change → `git commit` → `git push origin dev`.
Merge `dev → main` only when shipping. (See `CLAUDE.md` for the modular-first
coding standard + the shared-state hotspot table.)

## Deploy targets

- **(A) GitHub Pages** — auto-deploys via `.github/workflows/pages.yml` on
  push to **`main`** (corrected in Phase 158; the trigger was previously on
  the now-deleted `arena-mp` branch).
- **(B) Cloudflare Pages** — serves `ashgrid.io`; uses the `_headers` and
  `_redirects` conventions in the repo root.
- **(C) CrazyGames** — manual zip build via `scripts/build-zip.sh`.
- **MP server** deploys SEPARATELY via `partykit deploy` — it is NOT bundled
  with the static site.

## End-of-turn restart block — REQUIRED, MUST MATCH THE CURRENT TOPIC

Every reply that ends with a runnable result includes a fenced shell
block the user can paste into a terminal in one shot. The block:

1. Frees port **8765** (`lsof -ti:8765 | xargs kill -9 2>/dev/null`)
2. `cd`s into `/Users/ddh/Downloads/AshGrid`
3. Starts a fresh `python3 -m http.server 8765` in the background
4. `open`s a URL that JUMPS THE USER STRAIGHT INTO WHATEVER WE'RE
   DEBUGGING THIS TURN — bare domain, never `/index.html`

**The URL flags you append MUST match what the user is verifying
right now.** User feedback (verbatim, multiple turns):

> 「Agent.MD 裡面記錄的不是說每一次結束要放哪些存文字,而是每一次
>  結束之後如果要立即執行我們現在在討論的話題的任務和驗收的話,
>  要執行哪一段代碼」

Pick the variant that lands on the relevant verification surface:

| Discussion topic                | URL flags                          |
|---------------------------------|-------------------------------------|
| Online MP / PvP                 | `?mp=1&fresh=1&t=$(date +%s)`      |
| NN-bot / arena recruitment      | `?nn=1&fresh=1&t=$(date +%s)`      |
| General gameplay / shake / SFX  | `?fresh=1&t=$(date +%s)`           |
| Veteran flow tweak              | `?fresh=1&t=$(date +%s)` (skip intro via persisted `ag.introSeen`) |
| Reset to clean state            | `?reset=1` (no `&t=…` — reset strips params) |
| Tutorial-mode opt-in test       | `?reset=tutorial`                   |

Cache-buster `&t=$(date +%s)` is required — without it Chrome
sometimes serves the previous response from disk cache.

### Format

```
lsof -ti:8765 | xargs kill -9 2>/dev/null; cd /Users/ddh/Downloads/AshGrid && python3 -m http.server 8765 >/dev/null 2>&1 & sleep 0.4 && open "http://localhost:8765/<TOPIC-MATCHED-FLAGS>"
```

…followed by a bare-URL line on its own row for click-through.

The `?fresh=1` flag is handled by `index.html`: it unregisters every
service worker, clears every cache, then redirects to the bare URL.
This is the user's anti-staleness lever — guarantees they see the
latest pushed code without opening DevTools. Their `localStorage`
progress is preserved (no progression wipe). The flag handler runs
BEFORE any other module init, so by the time the page renders, the
SW + caches are clean.

If the change is purely docs-only with no runnable component, the
block can be skipped — but state that explicitly.

> **Note:** the old `?ftue=1` dev harness + `#ftueDevMonitor` panel + the
> FTUE prologue it re-armed were **deleted** (commit `8d5f177`). `?ftue=1`
> is now a no-op — don't append it or reference the FTUE flow.

### Verification ≠ user view

The preview tool runs its OWN headless Chrome instance. It does NOT
share `localStorage`, viewport size, or cache state with the user's
browser. When verifying language/layout/state-dependent UI, drive
the test through `?reset=stats` (or `?reset=1` for full wipe) to
match what a fresh-launch user would see, AND test in both `setLang('zh')`
and `setLang('en')`. Don't rely on the preview's current state being
representative — it's whatever the previous turn left it in.

## State / unlocks

The game uses a tier-based progressive-unlock system keyed off
`localStorage.ag.stats.matchesPlayed`. Tier thresholds: 0 / 1 / 3 / 5 / 7.
Locked things are `display:none`, not greyed — clean surface for new
players. To bypass, the user clicks the `SKIP ALL ▶` button in the
lobby footer (sets `localStorage.ag.unlockAll = '1'`).

If the user reports "things are missing" or "X used to be there":
- First check: are they on a fresh `localStorage` state? Tier 0 hides
  most modes/styles/weapons/chassis/editor by design.
- Confirm by reading `localStorage.ag.stats` and
  `localStorage.ag.unlockAll`.
- Restoration paths to suggest:
  1. Click the `SKIP ALL ▶` button (footer right side)
  2. Or browser console: `localStorage.setItem('ag.unlockAll','1');
     location.reload()`

## Common gotchas

- The preview tab can be `document.visibilityState === 'hidden'` when
  Chrome backgrounds it — `requestAnimationFrame` throttles, so eval
  loops doing `setTimeout(16)` for 50 frames will time out at 30s.
  Drive `update()` in tight sync loops for state checks instead.
- Multiple NN units on the same difficulty used to stampede
  `ort.InferenceSession.create()` — `NN.loading[difficulty]` dedupe
  fixed this; don't remove.
- `editor.spawn.blue` / `.red` are now ARRAYS (multi-spawn). Use
  `_normalizeSpawnList()` when reading from saved data — the
  `FIXED_MAPS` table still has single-object entries.
- The `model_tactical.onnx` file in the repo is the collapsed PPO
  policy from the first training run; `NN.modelPaths.tactical`
  currently points at `model_elite.onnx` as a fallback. When a
  retrained model ships, point the path back to `model_tactical.onnx`
  and verify with the smoke-test in
  `ai_arena/continue_ppo_tactical.ipynb`.

## Don't

- Don't add a bundler / build system. Keep the plain `<script src>` setup;
  bump versions with `tools/version.js stamp`, never by hand.
- Don't commit or push directly to `main` (`dev → main` merges only).
- Don't run `git push --force` to `main`.
- Don't strip the progressive-unlock gating without a replacement —
  the user's instruction was explicit: "解鎖之前不應存在 不然很亂".
- Don't describe the build-phase / skip-wave rewarded ad as a working
  surface — it's currently dead code.
- Don't reintroduce `?ftue=1` / `#ftueDevMonitor` / the FTUE prologue —
  that harness was deleted.
