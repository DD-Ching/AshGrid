"""
Phase 0 — Export PPO ONNX weights to JSON for pure-JS server-side inference.

Why this exists: the wings.io-style server-authoritative refactor (MIGRATION
plan) needs the NN to run inside PartyKit (Cloudflare Workers). Shipping
onnxruntime-web's ~9MB WASM into a Worker is wasteful — the actual model is
a 3-layer MLP with 27,282 parameters and we can run forward() in ~50 lines
of plain JS.

This script reads each ai_arena/onnx/model_*.onnx file and dumps its weights
to a sibling .weights.json. The JS runtime (server/party/sim/nn_runtime.js)
loads these JSONs directly.

Network topology (verified identical across all 11 model_*.onnx files):
  obs[65] --(Gemm 128x65 + b)--> tanh --(Gemm 128x128 + b)--> tanh
        --(Gemm 18x128 + b)--> softmax --> action_probs[18]

  Gemm attribute transB=1 means weights are stored as [out_dim, in_dim]
  and the op computes  out = x @ W.T + b.

Output JSON schema (one file per model):
{
  "topology": "mlp_tanh_3layer",
  "input_dim": 65,
  "output_dim": 18,
  "layers": [
    {"w": [[...128 floats per row, 65 rows...] x 128 rows], "b": [...128 floats], "act": "tanh"},
    {"w": [[...128...] x 128], "b": [...128 floats], "act": "tanh"},
    {"w": [[...128...] x 18], "b": [...18 floats], "act": "softmax"}
  ]
}

Usage:
  python3 ai_arena/scripts/export_weights.py
  # writes ai_arena/onnx/model_<style>.weights.json for each .onnx
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper


ROOT = Path(__file__).resolve().parents[2]
ONNX_DIR = ROOT / "ai_arena" / "onnx"


def export_one(onnx_path: Path) -> Path:
    """Read one .onnx file → write sibling .weights.json. Return JSON path."""
    model = onnx.load(str(onnx_path))
    # Collect initializers into a name→ndarray map
    inits = {init.name: numpy_helper.to_array(init) for init in model.graph.initializer}

    # The graph is fixed across all 11 models (verified separately).
    # Layer 1: extractor.policy_net.0.{weight,bias}  shape [128, 65] + [128]
    # Layer 2: extractor.policy_net.2.{weight,bias}  shape [128, 128] + [128]
    # Layer 3: action_net.{weight,bias}              shape [18, 128] + [18]
    l1w = inits["extractor.policy_net.0.weight"]
    l1b = inits["extractor.policy_net.0.bias"]
    l2w = inits["extractor.policy_net.2.weight"]
    l2b = inits["extractor.policy_net.2.bias"]
    l3w = inits["action_net.weight"]
    l3b = inits["action_net.bias"]

    # Sanity check shapes (catch surprises early)
    assert l1w.shape == (128, 65), f"L1 weight shape {l1w.shape}"
    assert l1b.shape == (128,), f"L1 bias shape {l1b.shape}"
    assert l2w.shape == (128, 128), f"L2 weight shape {l2w.shape}"
    assert l2b.shape == (128,), f"L2 bias shape {l2b.shape}"
    assert l3w.shape == (18, 128), f"L3 weight shape {l3w.shape}"
    assert l3b.shape == (18,), f"L3 bias shape {l3b.shape}"

    payload = {
        "topology": "mlp_tanh_3layer",
        "input_dim": 65,
        "output_dim": 18,
        "source": onnx_path.name,
        "layers": [
            {"w": l1w.tolist(), "b": l1b.tolist(), "act": "tanh"},
            {"w": l2w.tolist(), "b": l2b.tolist(), "act": "tanh"},
            {"w": l3w.tolist(), "b": l3b.tolist(), "act": "softmax"},
        ],
    }

    out_path = onnx_path.with_suffix(".weights.json")
    # Compact JSON (one float per line would 10x file size; default separators).
    with open(out_path, "w") as f:
        json.dump(payload, f, separators=(",", ":"))

    size_kb = out_path.stat().st_size / 1024
    onnx_size_kb = onnx_path.stat().st_size / 1024
    print(f"  {onnx_path.name:32s} ({onnx_size_kb:6.1f} KB) → "
          f"{out_path.name:38s} ({size_kb:6.1f} KB)")
    return out_path


def main() -> int:
    if not ONNX_DIR.exists():
        print(f"ERROR: {ONNX_DIR} not found", file=sys.stderr)
        return 1

    onnx_files = sorted(ONNX_DIR.glob("model*.onnx"))
    if not onnx_files:
        print(f"ERROR: no model*.onnx in {ONNX_DIR}", file=sys.stderr)
        return 1

    print(f"Exporting {len(onnx_files)} ONNX models → JSON weight files:")
    print()
    for p in onnx_files:
        export_one(p)
    print()
    print("Done. JSONs sit next to the ONNX files for parity.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
