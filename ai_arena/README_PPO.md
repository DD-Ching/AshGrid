# AI Arena — Neural Network (PPO) Trainer  ·  Curriculum Edition

PPO + curriculum learning + behavior-cloning warm-start for the AshGrid combat AI.
**Kaggle GPU notebook required.** Cannot easily train locally on macOS.

## What's new in this version

The previous 4M-step training produced a weak AI ("看到敌人也不怎么打"). This
rewrite adds three things that should fix that:

1. **4-stage curriculum** — small map / close spawn / static opponents
   first, gradually expanding to deployment scale. Solves the "agents never
   see each other so the gradient is zero" problem of the original env.
2. **Behavior-cloning warm-start** — supervised pretrain of the policy net
   from GA-best self-play before PPO begins. Saves ~5M steps of
   "discover what the fire button does".
3. **Reward shaping with decay** — visibility/approach/aim-cone bonuses
   in stages 1–3, fading to zero by stage 4 so the final policy uses pure
   kill/death signal.

Plus: **bigger budget** (16M steps default, ~3 hours on Kaggle T4 GPU).

## Files

| File | What it is |
|---|---|
| `combat_env.py` | Curriculum-enabled Gym env. Imported by the notebook. |
| `train_ppo.ipynb` | Kaggle notebook — paste/upload, set GPU, run all. |
| `kaggle_train.py` | (From the GA branch.) Used as BC teacher + curriculum opponent. |

## Smoke test first (5 minutes)

In the notebook, set `SMOKE_TEST = True` in the CONFIG cell. This drops:

- `TOTAL_STEPS` to 100k
- `BC_ROLLOUT_STEPS` to 20k
- `BC_EPOCHS` to 10

Just enough to verify the entire pipeline (BC + curriculum stage 1+2 + ONNX
export + sanity check) runs end-to-end without crashing. Expect a weak AI
but no errors.

### Steps

1. **Kaggle → New Notebook** (Python 3) → switch **Accelerator** to **GPU T4 ×2**
2. **+ Add Data → Upload Dataset** → upload `combat_env.py` AND `kaggle_train.py`
   together as one dataset (any name, e.g. `ai-arena-files`)
3. **Files → Upload** → upload `train_ppo.ipynb` (or paste cells into a new notebook)
4. The notebook auto-detects the dataset path. If it can't find them, edit
   the `candidates` list in the "Load combat_env" cell.
5. Click **Run All**

### What you'll see (smoke test)

- Cell "Install" — `stable-baselines3` + `onnx` install (~30 s)
- Cell "Load combat_env" — prints curriculum stages preview:
  ```
  combat_env loaded. OBS_DIM=65, ACTION_DIM=18
    step      5,000: 600x600 spawn=240 stat=0.54 ga=0.08 self=0.00 vis=0.100
    step     30,000: 900x900 spawn=410 stat=0.00 ga=0.46 self=0.22 vis=0.060
    ...
  ```
- Cell "Behavior cloning" — collects 20k pairs (~2 min) then trains 10 epochs
  (~30 s). Should reach `acc=40-60%` (not perfect — GA is stochastic).
- Cell "Train" — SB3 progress; `ep_rew_mean` likely +5..+15 with shaping bonus
- Cell "ONNX export" — `model.onnx exported (~150 KB)`
- Cell "Sanity" — `NN vs GA-best:  3 W / 5 L / 2 D` (weak after 100k — fine)

### Outputs (download from right panel)

- `model.onnx` — drop into the JS game at `ai_arena/onnx/model.onnx`
- `ppo_combat_final.zip` — full SB3 model, can resume training
- `self_snap_<step>.zip` — frozen self-play snapshots (intermediate)

## Real training (after smoke test passes)

Training is **time-budgeted**, not step-budgeted. Set how many hours you
have, the trainer runs until then:

```python
SMOKE_TEST       = False
TIME_LIMIT_HOURS = 7.5     # default; Kaggle session limit is 9h
```

The curriculum advances against ELAPSED TIME, so the 4 stages take fixed
*fractions* of your budget regardless of throughput:

| Hours into 7.5h budget | Stage | What's happening |
|---|---|---|
| 0:00 – 1:08 | 1 | Aim/fire reflex (600×600, close spawn, static opps) |
| 1:08 – 2:38 | 2 | Tracking (900×900, runner+GA opps) |
| 2:38 – 4:08 | 3 | Full combat (1000×, GA+self, decaying shaping) |
| **4:08 – 7:30** | **4** | **Deployment scale (1200×1200, no shaping) — bulk of training** |

Stage 4 gets 45% of the budget — that's where the policy actually
converges to a strong deployment-scale agent.

Each `CHECKPOINT_EVERY` (default 2M) steps a `.zip` is saved — these become
the **difficulty tiers**:
- `ppo_combat_2000000.zip`   → easy AI (still in stage 1/2)
- `ppo_combat_8000000.zip`   → medium AI (stage 3)
- `ppo_combat_<final>.zip`   → hard AI (final stage 4 polish)

Convert each to its own ONNX (re-run the export cell with that checkpoint
loaded) and name them `model_easy.onnx` / `model_medium.onnx` / `model_hard.onnx`.

## Curriculum stages

Time progress drives a 4-stage schedule (back-loaded toward stage 4 for
extra deployment-scale refinement):

| Stage | Time range | World | Spawn dist | Opponent mix | Reward shaping |
|------:|-----------:|:------|:-----------|:-------------|:---------------|
| 1 | 0% – 15%   | 600×600                | 200 → 300u | 70% static + GA + random | heavy (vis 0.10) |
| 2 | 15% – 35%  | 900×900                | 350 → 450u | runner + GA + self-old   | medium (vis 0.06) |
| 3 | 35% – 55%  | 1000×1000 → 1100×1100  | 500 → 600u | GA + self-old            | light, decaying |
| 4 | **55% – 100%** | **1200×1200** (deploy) | **700u** | 50% self + 40% GA + 10% rand | **none** |

Stage 4 matches the JS `NN_ARENA` exactly — no distribution shift between
training and deployment.

## How the obs/action spaces work (unchanged from previous version)

- **Action**: `Discrete(18)` = `move_dir × 2 + fire`
- **Observation**: 65 floats, normalized by **current** world size so the
  [-1, 1] range stays full at every curriculum stage. The model learns to
  read coordinates as fractions of the current map, not absolute units.
- See `combat_env.py` docstring for the exact byte layout.

## Reward formula

Per tick, per friendly unit:

```
+0.4 × damage_dealt
-0.2 × damage_taken
+30  per kill credited
-20  if I died
+0.005 if alive
+0.001 × (my_kills - enemy_kills)
+ shaping_terms (curriculum-dependent, decays to 0 in stage 4)
```

Shaping terms (active in stages 1–3 only):

```
+ coef_visibility    when any enemy is in my vision cone
+ coef_approach × (1 - dist_to_nearest_visible / world_w)
+ coef_aimcone       when an enemy is within 30° of facing
```

Episode-end bonus: `±50` based on team-kill comparison.

## Troubleshooting

**`ep_rew_mean` stuck near 0 in stage 1** — shaping should rescue this. If
not, check the curriculum log line printed every 100k steps; verify
`vis=0.100` is non-zero. If somehow zero, the env's `_reward_for` isn't
wired to the curriculum's coefficients.

**BC accuracy < 30%** — GA-best is stochastic but should be more learnable
than that. Check that `_ga_decide_action` is returning the same action
twice for the same obs (it should be — the only randomness is the GA's
0.05-rad shooting spread, which doesn't affect the discrete action).

**OOM on Kaggle GPU** — the BC dataset (`bc_obs_t`) lives on GPU. Drop
`BC_ROLLOUT_STEPS` to 100k or move BC training to CPU.

**Curriculum not advancing** — check that `_global_step.value` is being
written by the callback (look for `[curriculum @ <step>]` log lines every
100k steps). If those don't appear, SB3 isn't calling `_on_step` per
worker step — verify `SubprocVecEnv` setup.

**NN vs GA-best loses** after 16M steps — try:
1. Bump `TOTAL_STEPS` to 32M
2. Increase `BC_ROLLOUT_STEPS` to 1M for a stronger init
3. Add more frozen self-play opponents (`SELF_POOL_MAX = 16`)

## What to send back

After your training run finishes, upload **`model.onnx`** to the repo at
`ai_arena/onnx/model.onnx`. The JS-side wiring already exists on the
`claude/ai-ppo-nn` branch — just replace the file and reload the page.
