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

## End-of-turn restart block — REQUIRED on every reply that touches
runnable code or affects the live preview

Every reply that ends with a runnable result MUST include a fenced
shell block the user can paste into a terminal in one shot. The block
must:

1. Free port **8765** of any old occupant
   (`lsof -ti:8765 | xargs kill -9 2>/dev/null`)
2. `cd` into the working tree (`/Users/ddh/Downloads/AshGrid` or the
   active worktree under `.claude/worktrees/`)
3. Start a fresh `python3 -m http.server 8765` in the background
4. Open the URL: `open http://localhost:8765/` (macOS) — **bare domain
   only, no `/index.html` suffix**. The reason: the preview tool's
   headless browser navigates to `/` (Python's http.server serves
   index.html as the default), so my evaluations and the user's view
   are guaranteed to land on the same `location.pathname` (`/`).
   `index.html` resolves to the same file but produces a *different*
   `location.pathname`, which causes my `?cb=` reload trick to
   redirect to a different URL than what the user is currently on.
   Same file, but the view-state divergence has bitten verification
   passes more than once.

Plus a clickable URL on its own line right after the block — also
the bare domain.

Format — REQUIRED, copy-paste this exact line at the end of every
runnable-result reply. The `&t=$(date +%s)` suffix is a unique
cache-buster every run — the user reported that without it Chrome
sometimes served the previous `?fresh=1` response from cache and
they ended up looking at stale code:

```
lsof -ti:8765 | xargs kill -9 2>/dev/null; cd /Users/ddh/Downloads/AshGrid && python3 -m http.server 8765 >/dev/null 2>&1 & sleep 0.4 && open "http://localhost:8765/?fresh=1&t=$(date +%s)"
```
http://localhost:8765/?fresh=1

### FTUE dev harness — `?ftue=1`

Append `&ftue=1` to the URL above to:
1. Wipe `ag.firstMatch` + `ag.firstAuditSeen` + `ag.tutorialSeen` (re-arm
   the first-time flow)
2. Set `ag.introSeen = 1` (skip the 90-second narration)
3. Auto-fire the WAKE button on load (no manual click)
4. Light up a top-right monitor panel showing live FTUE state:
   current step idx + expected advance + flags + ally/enemy counts +
   camera scale + pause flag

Use this when iterating on the tutorial:

```
lsof -ti:8765 | xargs kill -9 2>/dev/null; cd /Users/ddh/Downloads/AshGrid && python3 -m http.server 8765 >/dev/null 2>&1 & sleep 0.4 && open "http://localhost:8765/?fresh=1&ftue=1&t=$(date +%s)"
```

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
