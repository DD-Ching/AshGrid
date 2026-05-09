# AGENTS.md — AshGrid project rules for AI assistants

This file is read first by Claude Code (and any compatible coding agent)
working in this repo. Treat it as authoritative.

## Project at a glance
- Single-file HTML5 game: `index.html` (~17k lines, no build system)
- Static assets: `ai_arena/onnx/*.onnx` (PPO inference brains), images,
  `manifest.webmanifest`, `sw.js`
- AI training notebooks: `ai_arena/*.ipynb` (run on Kaggle)
- Local preview server: Python `http.server` on port **8765**, launched
  via `.claude/launch.json` (`name: static`)
- Live URL: **http://localhost:8765/** (NOT `/index.html`)

## End-of-turn restart block — REQUIRED, MUST MATCH THE CURRENT TOPIC

Every reply that ends with a runnable result includes a fenced shell
block the user can paste into a terminal in one shot. The block:

1. Frees port **8765** (`lsof -ti:8765 | xargs kill -9 2>/dev/null`)
2. `cd`s into `/Users/ddh/Downloads/AshGrid`
3. Starts a fresh `python3 -m http.server 8765` in the background
4. `open`s a URL that JUMPS THE USER STRAIGHT INTO WHATEVER WE'RE
   DEBUGGING THIS TURN — bare domain, never `/index.html`

**The URL flags you append MUST match what the user is verifying
right now.** Don't paste a generic `?fresh=1` if we're discussing
the FTUE — that drops the user on the start screen and they have
to click through to repro. User feedback (verbatim, multiple turns):

> 「Agent.MD 裡面記錄的不是說每一次結束要放哪些存文字,而是每一次
>  結束之後如果要立即執行我們現在在討論的話題的任務和驗收的話,
>  要執行哪一段代碼」

Pick the variant that lands on the relevant verification surface:

| Discussion topic                | URL flags                          |
|---------------------------------|-------------------------------------|
| FTUE / first-time experience    | `?fresh=1&ftue=1&t=$(date +%s)`    |
| General gameplay / shake / SFX  | `?fresh=1&t=$(date +%s)`           |
| Veteran flow tweak              | `?fresh=1&t=$(date +%s)` (skip intro via persisted ag.introSeen) |
| Reset to clean state            | `?reset=1` (no `&t=…` — reset strips params) |
| Tutorial-mode opt-in test       | `?reset=tutorial`                   |

Cache-buster `&t=$(date +%s)` is required — without it Chrome
sometimes serves the previous response from disk cache.

### FTUE flag reference

`?ftue=1` (commit 12d53ef) does on the boot path:
1. Wipes `ag.firstMatch` + `ag.firstAuditSeen` + `ag.tutorialSeen`
2. Sets `ag.introSeen = 1` (skip 90 s narration)
3. Auto-fires the WAKE button after `window.load + 400 ms`
4. Lights up a top-right `#ftueDevMonitor` panel showing live
   step idx / expected advance / flags / ally+enemy counts /
   camera scale / pause flag

Critical sequencing detail: the `?ftue=1` IIFE branch MUST run
BEFORE the `?fresh=1` IIFE returns, because fresh's redirect strips
all query params. Both `localStorage` + `sessionStorage` writes
survive the redirect, so the post-load wiring picks them up on the
second load. Auto-click is also gated on `fresh !== '1'` so the
click only fires AFTER the redirect has landed.

### Format

```
lsof -ti:8765 | xargs kill -9 2>/dev/null; cd /Users/ddh/Downloads/AshGrid && python3 -m http.server 8765 >/dev/null 2>&1 & sleep 0.4 && open "http://localhost:8765/<TOPIC-MATCHED-FLAGS>"
```

…followed by a bare-URL line on its own row for click-through.

The `?fresh=1` flag is handled by index.html: it unregisters every
service worker, clears every cache, then redirects to the bare URL.
This is the user's anti-staleness lever — guarantees they see the
latest pushed code without opening DevTools. Their localStorage
progress is preserved (no progression wipe). The flag handler runs
BEFORE any other module init, so by the time the page renders, the
SW + caches are clean.

If the change is purely docs-only with no runnable component, the
block can be skipped — but state that explicitly.

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

- Don't add a build system. Keep it single-file `index.html` editable
  in any text editor.
- Don't run `git push --force` to main.
- Don't strip the progressive-unlock gating without a replacement —
  the user's instruction was explicit: "解鎖之前不應存在 不然很亂".
