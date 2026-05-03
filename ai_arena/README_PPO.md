# AI Arena — Neural Network (PPO) Trainer

PPO + self-play training pipeline for the AshGrid combat AI.
**Kaggle GPU notebook required.** Cannot easily train locally on macOS.

## Files

| File | What it is |
|---|---|
| `combat_env.py` | The Gym/Gymnasium environment wrapping the combat sim. Imported by the notebook. |
| `train_ppo.ipynb` | Kaggle notebook — paste/upload, set GPU, run all. Trains the NN and exports ONNX. |
| `kaggle_train.py` | (From the GA branch) used as a strong baseline opponent during NN training. |

## Smoke test first (5 minutes)

The notebook's default config is `TOTAL_STEPS = 100_000` — just enough to
verify the entire pipeline works end-to-end without wasting your Kaggle GPU
hours. Expect a weak AI but no crashes.

### Steps

1. **Kaggle → New Notebook** (Python 3) → switch **Accelerator** to **GPU T4 ×2**
2. **+ Add Data → Upload Dataset** → upload `combat_env.py` AND `kaggle_train.py`
   as one dataset (give it any name, e.g. `ai-arena-files`)
3. **Files → Upload** → upload `train_ppo.ipynb` (or paste its cells into a new notebook)
4. The notebook auto-detects the data path. If it can't find the files,
   adjust the `data_dir` list in the "Load combat_env" cell.
5. Click **Run All**

### What you'll see

- Cell 5 (install): `stable-baselines3` and `onnx` install (~30 sec)
- Cell 7 (load): "combat_env loaded. OBS_DIM=65, ACTION_DIM=18"
- Cell 11 (training): SB3's progress bar shows `ep_rew_mean` per rollout.
  - Steps 0-50k: `ep_rew_mean` likely negative (-50 to +5)
  - Steps 50-100k: should rise into +10..+30 range
- Cell 12 (ONNX): "ONNX exported to /kaggle/working/ppo_ckpt/model.onnx (~150 KB)"
- Cell 13 (sanity): `NN vs GA-best: 2W / 7L / 1D` (NN is bad after only 100k steps — that's fine)

### Outputs (download from right panel)

- `model.onnx` — the file we plug into the JS game
- `ppo_combat_final.zip` — full SB3 model (re-loadable for further training)

## Real training (after smoke test passes)

Edit the `TOTAL_STEPS` line in the CONFIG cell:

```python
TOTAL_STEPS = 1_000_000    # ~30-60 min, first playable AI
TOTAL_STEPS = 4_000_000    # ~2-4 hrs, recommended
TOTAL_STEPS = 16_000_000   # ~8 hrs, max in one Kaggle session, very strong
```

Each `CHECKPOINT_EVERY` (default 200k) steps, a `.zip` saves to the output.
Those become "difficulty tiers" — early checkpoint = easy AI, late = hard AI.

## How the env works (quick mental model)

- **Match**: 3v3, 45 seconds (2700 ticks at 60fps), random map from 5 fixed +
  procedural generator
- **Friendly team** (3 units) is controlled by the policy being trained
- **Enemy team** (3 units) is controlled by a "sparring partner" sampled
  every episode from:
  - GA-best (the hand-tuned baseline AI from `kaggle_train.py`) — 50%
  - `self_old` — frozen snapshots of past NN versions — 40%
  - random — 10%
- Every `FROZEN_OPP_EVERY` (default 250k) steps, current NN is frozen and
  added to the `self_old` pool. Old snapshots get rotated out (max 6).

## Action space (what the NN decides each tick)

`Discrete(18)` = `move_dir × 2 + fire`
- `move_dir` ∈ {0..8} → idle / N / NE / E / SE / S / SW / W / NW
- `fire` ∈ {0, 1} → hold / fire (auto-aim at nearest visible enemy)

## Observation (what the NN sees, ~65 floats)

- Self: position, angle, HP, recent damage, fire cooldown, alive
- Up to 3 visible enemies: relative position, distance, HP, visibility flag
- Up to 2 teammates: relative position, distance, HP, visibility flag
- Up to 5 nearby cover points: relative position, distance
- Last seen enemy intel: relative position, age, validity
- Last sound (gunshot): relative position, intensity, friend/foe
- Match state: time remaining, our kills, enemy kills, alive teammates

All values normalised to [-1, 1] or [0, 1].

## Reward shaping (what the NN tries to maximise)

Per tick (per friendly unit):
- `+0.4 × damage_dealt`
- `-0.2 × damage_taken`
- `+30` per kill credited
- `-20` if I died
- `+0.005` if alive (tiny survival bias)
- `+0.001 × team_kill_advantage`

Episode end:
- `+50` if our team has more kills, `-50` if fewer, `0` if tied

These are the same numbers the GA used, so trained NN parameters are
directly comparable: the GA's best `fitness` (~2000) is roughly equivalent
to the NN's `ep_rew_mean × 3` (since 3 friendlies on same team).

## What to send back

After your training run finishes, upload the resulting **`model.onnx`**
to the repo at `ai_arena/onnx/model.onnx` (or attach to a chat message).
I'll wire up the JS-side ONNX loader and the deathmatch lobby.

If you save multiple checkpoints (different difficulty tiers), name them:
- `model_easy.onnx`     ← from gen ~100k
- `model_medium.onnx`   ← from gen ~500k
- `model_hard.onnx`     ← from gen ~2M+
