# AI Arena — Genetic-Algorithm Trainer

Train the AI used by the JS game by running thousands of headless 3v3
matches on Kaggle's free CPUs. Output is one or more `gen_NNNNN.json`
checkpoint files containing the best AI parameters at that generation —
drop those into the JS game to load a smarter (or different-difficulty)
AI.

## Files

- `kaggle_train.py` — self-contained simulator + GA trainer. Single file
  with all logic inline so you can paste it into one Kaggle cell.
- `README.md` — this file.

No external dependencies beyond Python 3 stdlib (uses `math`,
`random`, `multiprocessing`, `dataclasses`, `json`). NumPy/PyTorch not
required — pure Python is fast enough at this problem size.

---

## Run on Kaggle (recommended)

1. Go to [kaggle.com](https://www.kaggle.com), sign in.
2. **+ Create → New Notebook** → leave it Python, leave Accelerator off
   (CPU is enough). The free notebook has 4 cores.
3. In the notebook, **delete the empty cell** that's there by default
   and paste the entire contents of `kaggle_train.py` into one cell.
4. Edit the **CONFIG** block at the top of the cell to set how long you
   want to train (see below).
5. Click **▶ Run All** or just run that cell.
6. When it finishes, in the right panel under **Output** you'll see a
   `checkpoints/` folder with files like:
   ```
   gen_00050.json
   gen_00100.json
   gen_00150.json
   gen_00200.json
   history.json
   ```
   Right-click → Download. Drop these into the repo at
   `ai_arena/checkpoints/` and commit.

---

## Run locally

```bash
cd ai_arena
python3 kaggle_train.py
# Outputs land in ./checkpoints/
```

---

## Config (edit at top of `kaggle_train.py`)

| Variable | Default | What it does |
|---|---|---|
| `SQUAD_SIZE` | 3 | NvN combat. 2v2, 3v3, 4v4 are all fine. Keep equal sides. |
| `MATCH_SECONDS` | 60 | One match's in-sim duration. Longer = more reliable signal but slower. |
| `POPULATION` | 32 | Genomes evaluated per generation. Bigger = explores more, slower. |
| `HALL_OF_FAME` | 16 | Top-K best ever kept across generations. Candidates fight HOF members for fitness. |
| `GENERATIONS` | 200 | How many GA generations to run. See "How long" below. |
| `MATCHES_PER_EVAL` | 4 | Each candidate plays N HOF opponents (×2 for home/away = 8 matches). More = lower variance, slower. |
| `ELITE_FRAC` | 0.5 | Top fraction that breeds the next generation. |
| `MUTATION_SIGMA` | 0.10 | Per-gene gaussian noise as fraction of param range. |
| `MUTATION_RATE` | 0.30 | Probability each gene gets mutated per child. |
| `WORKERS` | 4 | Multiprocess pool size. Kaggle has 4 cores. |
| `SAVE_EVERY` | 25 | Checkpoint every N generations — controls how many difficulty tiers you get. |
| `OUTPUT_DIR` | `/kaggle/working/checkpoints` | Auto-detects Kaggle vs local. |

---

## How long does it take?

Roughly, on Kaggle 4-core CPU:

| Setup | Per gen | 100 gens | 1 000 gens | 10 000 gens |
|---|---|---|---|---|
| Default (POP 32, MATCHES 4) | ~12 s | ~20 min | ~3.3 h | ~33 h ❌ |
| Lite (POP 16, MATCHES 2) | ~3 s | ~5 min | ~50 min | ~8 h |
| Heavy (POP 64, MATCHES 6) | ~36 s | ~1 h | ~10 h ❌ | — |

For first experiments use **Lite** (pop 16, matches 2), 200 gens, ~10
minutes. Once you see fitness rising, scale up.

Kaggle notebooks have a **9-hour limit** per session. If you want more,
either:
- Run 9 h, save checkpoint, close session, start a new session loading
  the last checkpoint as the seed population (one-line edit; ask me).
- Use multiple Kaggle accounts and average results.

---

## Difficulty tiers

The script saves a checkpoint every `SAVE_EVERY` generations. So if you
run 200 gens with `SAVE_EVERY=25`, you get 8 tiers:

```
gen_00025.json  ← "trainee" — barely competent
gen_00050.json  ← "rookie"
gen_00075.json
gen_00100.json  ← "competent"
gen_00125.json
gen_00150.json
gen_00175.json
gen_00200.json  ← "veteran" / "master"
```

In the JS game we'll let players pick their difficulty by loading
different checkpoints. Earlier = easier, later = harder.

---

## Fitness signal

```
fitness = mean over MATCHES_PER_EVAL matchups of:
            (candidate's kills - candidate's deaths)
```

Each matchup plays the candidate twice — once as team A, once as team B
— so spawn-side bias is cancelled out. Maps are sampled from a pool of
5 hand-built layouts plus a procedural generator, so the genome learns
to fight on **any** layout, not just one map.

If fitness sits at 0 for the first ~10 generations, that's normal —
random genomes mostly can't see each other. Should rise after gen 20-30.

---

## The genome (12 parameters)

```python
GENOME_SCHEMA = {
    'view_arc'           : (1.0, 3.0),    # vision cone width (rad)
    'view_range'         : (300, 900),    # how far they see
    'snap_to_threat'     : (0.05, 0.5),   # body rotation speed toward target
    'patrol_scan_speed'  : (0.005, 0.08), # idle look-around rate

    'engage_distance'    : (150, 400),    # preferred fight distance
    'spread'             : (0.02, 0.20),  # bullet inaccuracy (rad)
    'fire_cd_frames'     : (6, 30),       # frames between shots

    'cover_dmg_threshold': (5, 80),       # damage that triggers seek-cover
    'peek_duration'      : (20, 100),     # frames out of cover firing
    'hide_duration'      : (20, 100),     # frames behind cover hiding
    'flee_hp_pct'        : (0.05, 0.60),  # HP fraction → flee

    'flank_chance'       : (0.0, 1.0),    # bias toward flanking (reserved)
}
```

These are the exact knobs the AI's behaviour-tree consults. Training
finds the combination that wins fights against other smart opponents
across diverse maps.

---

## Output JSON format

```json
{
  "gen": 100,
  "best_fitness": 14.25,
  "avg_fitness": 8.31,
  "config": {
    "squad_size": 3,
    "match_seconds": 60,
    "population": 32,
    "hof": 16
  },
  "best_genome": {
    "view_arc":            2.31,
    "view_range":          720,
    "snap_to_threat":      0.27,
    "patrol_scan_speed":   0.042,
    "engage_distance":     280,
    "spread":              0.07,
    "fire_cd_frames":      12,
    "cover_dmg_threshold": 28,
    "peek_duration":       55,
    "hide_duration":       40,
    "flee_hp_pct":         0.34,
    "flank_chance":        0.61
  },
  "hof": [ {...}, {...}, {...}, {...}, {...} ]
}
```

The JS game will read `best_genome` and apply the values to its AI.

---

## Troubleshooting

**Best fitness stuck at 0** — early gens of random AI; wait 20-30
generations.

**Best fitness oscillating, not climbing** — `MATCHES_PER_EVAL` too
low (high variance). Bump to 6.

**Best fitness climbs then drops** — HOF too small; the GA found a
counter-strategy that the old HOF can't expose. Bump `HALL_OF_FAME`.

**Out of memory** — Python pickle of `Pool` workers. Drop `WORKERS` to
2. Or set `WORKERS = 1` and run sequentially.

**Match duration unfair** — bump `MATCH_SECONDS` to 90 or 120 so the
scoreboard converges.

---

## What this trainer does NOT do (yet)

- Neural networks. We're doing GA over a 12-D parameter vector. If you
  want a real policy net (PPO/DQN), see comments at top of
  `kaggle_train.py`.
- Heatmap / replay viewer. The trainer is headless. To watch a trained
  AI play, load its JSON in the JS game.
- Cross-team intel sharing. Both teams use the same genome at play time
  (both squads play smart). During training they're different so we can
  compare.

---

## Next step (JS side)

After you have a `gen_NNNNN.json`:

1. Drop it into the repo at `ai_arena/checkpoints/`.
2. (Coming next commit) The JS game reads it and applies the values to
   `AI_PARAMS`. The Skirmish lobby will get a difficulty selector.

If you train and get a checkpoint that feels too strong / too weak,
that's the cue to add humanisation caps or pick an earlier checkpoint.
