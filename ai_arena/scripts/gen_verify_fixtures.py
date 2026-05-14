"""
Phase 0 — Verification fixture generator.

For each model_*.onnx, generates 100 random 65-dim obs vectors, runs ONNX
inference (ground truth), and writes a fixture file:

  ai_arena/onnx/model_<style>.verify.json
    {
      "model": "model_elite.onnx",
      "n": 100,
      "obs": [[..65 floats..] x 100],
      "ground_truth_argmax": [int, int, ..., int],   // 100 ints, 0..17
      "ground_truth_probs":  [[..18 floats..] x 100] // for fine-grained diff
    }

The Node-side verifier (ai_arena/scripts/verify_runtime.js) loads this
fixture + the matching .weights.json and asserts:
  - argmax matches ONNX on >= 99/100 obs
  - top-1 probability within 1e-3 of ONNX value
  - max per-class probability delta < 1e-4

This is the gate before any Phase 1+ work touches multiplayer.js.
"""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort


ROOT = Path(__file__).resolve().parents[2]
ONNX_DIR = ROOT / "ai_arena" / "onnx"
N_OBS = 100
SEED = 4242


def gen_one(onnx_path: Path) -> Path:
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    rng = np.random.default_rng(SEED)
    # The training obs is bounded ~[-1, 1] for most dims (positions /
    # angles / hp ratios all normalized). Sample slightly wider to also
    # cover edge-of-arena and stale-intel cases.
    obs = rng.uniform(-1.3, 1.3, size=(N_OBS, 65)).astype(np.float32)
    probs = sess.run([out_name], {in_name: obs})[0]  # shape (N, 18)

    argmax = probs.argmax(axis=1).tolist()

    payload = {
        "model": onnx_path.name,
        "n": N_OBS,
        "seed": SEED,
        "obs": obs.tolist(),
        "ground_truth_argmax": argmax,
        "ground_truth_probs": probs.tolist(),
    }
    out_path = onnx_path.with_suffix(".verify.json")
    with open(out_path, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"  {onnx_path.name:32s} → {out_path.name}  "
          f"(top1 entropy avg={float(-(probs * np.log(probs + 1e-12)).sum(1).mean()):.3f})")
    return out_path


def main() -> None:
    files = sorted(ONNX_DIR.glob("model*.onnx"))
    print(f"Generating verify fixtures for {len(files)} models (N={N_OBS}, seed={SEED}):")
    for p in files:
        gen_one(p)
    print()
    print("Run the verifier next:  node ai_arena/scripts/verify_runtime.js")


if __name__ == "__main__":
    main()
