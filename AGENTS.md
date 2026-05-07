# AGENTS.md — AshGrid project rules for AI assistants

This file is read first by Claude Code (and any compatible coding agent)
working in this repo. Treat it as authoritative.

## Project at a glance
- Single-file HTML5 game: `index.html` (~14k lines, no build system)
- Static assets: `ai_arena/onnx/*.onnx` (PPO inference brains), images,
  `manifest.webmanifest`, `sw.js`
- AI training notebooks: `ai_arena/*.ipynb` (run on Kaggle)
- Local preview server: Python `http.server` on port **8765**, launched
  via `.claude/launch.json` (`name: static`)
- Live URL: http://localhost:8765/index.html

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
4. Open the URL: `open http://localhost:8765/index.html` (macOS)

Plus a clickable URL on its own line right after the block.

Format example:

```
lsof -ti:8765 | xargs kill -9 2>/dev/null; cd /Users/ddh/Downloads/AshGrid && python3 -m http.server 8765 >/dev/null 2>&1 & sleep 0.4 && open http://localhost:8765/index.html
```
http://localhost:8765/index.html

If the change is purely docs-only with no runnable component, the
block can be skipped — but state that explicitly.

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
