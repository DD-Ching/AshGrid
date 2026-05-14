// ============================================================
// Phase 0 — Pure-JS PPO forward pass.
// ============================================================
//
// Target: replace onnxruntime-web (~9MB WASM bundle) with this file
// (~3KB compressed) for the server-authoritative MP refactor.
//
// The PPO models trained for AshGrid (ai_arena/onnx/model_*.onnx) are
// all 3-layer MLPs with the same topology:
//
//     obs[65] → Gemm(128,65) + b → tanh
//             → Gemm(128,128) + b → tanh
//             → Gemm(18,128) + b → softmax → action[18]
//
// `Gemm` with attribute `transB=1` means the weights are stored as
// [out_dim, in_dim] and the operation is `out = x @ W.T + b`.
//
// JSON schema (produced by ai_arena/scripts/export_weights.py):
//   {
//     topology: "mlp_tanh_3layer",
//     input_dim: 65,
//     output_dim: 18,
//     layers: [
//       { w: [[..65 floats..] x 128], b: [..128 floats..], act: "tanh"    },
//       { w: [[..128 floats..] x 128], b: [..128 floats..], act: "tanh"   },
//       { w: [[..128 floats..] x 18],  b: [..18 floats..],  act: "softmax"},
//     ]
//   }
//
// API:
//   const net = createNet(weightsJson);   // packs into Float32Arrays
//   const probs = net.forward(obs);       // Float32Array(18) of probabilities
//   const action = net.argmax(obs);       // int 0..17 (skips softmax cost)
//
// Performance: each forward is ~30µs on V8 (Node 18, M-series Mac). 16
// bots × 30Hz = 480 calls/sec = 14ms CPU/sec. Comfortable inside a
// Cloudflare Durable Object tick budget.
//
// Determinism: pure JS math (Math.tanh, Math.exp, ~+,*). Output matches
// onnxruntime probabilities to ~1e-5 (rounding at the +/* level). The
// argmax matches ONNX argmax on >99% of random obs vectors — the rare
// disagreements happen when the top-2 logits are within ~1e-3 of each
// other (essentially policy ties; safe).
//
// This file is an ES module that runs identically in:
//   - Node 18+ (verification harness + PartyKit dev)
//   - Cloudflare Workers (production PartyKit deploy)
//   - Browser (for SP, post-Phase-6 unification)

const TANH = Math.tanh;
const EXP = Math.exp;

/**
 * Pack the nested-array JSON into flat Float32Arrays. Flat arrays are
 * ~3x faster to iterate than nested JS arrays (no inner-array prop
 * lookups in the hot loop).
 *
 * Weight indexing: layer.w is a [outDim][inDim] array. Flatten to
 * row-major: flat[i*inDim + j] = w[i][j].
 */
function packLayer(layer) {
  const w = layer.w;
  const outDim = w.length;
  const inDim = w[0].length;
  const flat = new Float32Array(outDim * inDim);
  for (let i = 0; i < outDim; i++) {
    const row = w[i];
    for (let j = 0; j < inDim; j++) flat[i * inDim + j] = row[j];
  }
  return {
    w: flat,
    b: new Float32Array(layer.b),
    outDim,
    inDim,
    act: layer.act,
  };
}

/**
 * Gemm + bias + activation, all in one pass for cache friendliness.
 *
 * Computes:  out[i] = act( sum_j(x[j] * W[i,j]) + b[i] )
 *
 * @param x       input vector (Float32Array)
 * @param layer   packed layer { w, b, outDim, inDim, act }
 * @param out     output buffer (Float32Array of length outDim) — reused
 *                across forward() calls to avoid allocations
 */
function gemmActInto(x, layer, out) {
  const w = layer.w;
  const b = layer.b;
  const outDim = layer.outDim;
  const inDim = layer.inDim;

  if (layer.act === "tanh") {
    for (let i = 0; i < outDim; i++) {
      let s = b[i];
      const row = i * inDim;
      for (let j = 0; j < inDim; j++) s += x[j] * w[row + j];
      out[i] = TANH(s);
    }
  } else if (layer.act === "softmax") {
    // Pass 1: compute pre-activation logits into out[]
    for (let i = 0; i < outDim; i++) {
      let s = b[i];
      const row = i * inDim;
      for (let j = 0; j < inDim; j++) s += x[j] * w[row + j];
      out[i] = s;
    }
    // Pass 2: max-shift + exp + normalize (numerical stability)
    let max = out[0];
    for (let i = 1; i < outDim; i++) if (out[i] > max) max = out[i];
    let sum = 0;
    for (let i = 0; i < outDim; i++) {
      out[i] = EXP(out[i] - max);
      sum += out[i];
    }
    const inv = 1 / sum;
    for (let i = 0; i < outDim; i++) out[i] *= inv;
  } else if (layer.act === "linear" || layer.act === null) {
    for (let i = 0; i < outDim; i++) {
      let s = b[i];
      const row = i * inDim;
      for (let j = 0; j < inDim; j++) s += x[j] * w[row + j];
      out[i] = s;
    }
  } else {
    throw new Error(`unknown activation: ${layer.act}`);
  }
}

/**
 * Build a forward-runnable network from the weights JSON.
 *
 * Layer buffers are allocated once and reused, so forward() / argmax()
 * are alloc-free in the hot path. NOT thread-safe — one Net per
 * concurrent caller (each NN-driven bot gets its own).
 */
export function createNet(weightsJson) {
  if (weightsJson.topology !== "mlp_tanh_3layer") {
    throw new Error(`unsupported topology: ${weightsJson.topology}`);
  }
  const layers = weightsJson.layers.map(packLayer);

  // Hidden buffers — sized to each layer's output. Reused per forward.
  const buffers = layers.map((l) => new Float32Array(l.outDim));

  /**
   * Run forward pass. Returns the OUTPUT BUFFER of the final layer,
   * which is owned by this Net — copy if you need to retain it across
   * the next forward() call.
   *
   * @param obs Float32Array of length input_dim (65). Plain Arrays
   *            also accepted but Float32Array is faster.
   */
  function forward(obs) {
    let x = obs;
    for (let i = 0; i < layers.length; i++) {
      gemmActInto(x, layers[i], buffers[i]);
      x = buffers[i];
    }
    return x; // final layer's softmax output (Float32Array(18))
  }

  /**
   * Argmax of the policy distribution. Saves the softmax cost in the
   * last layer (the max-of-softmax is the same as the max-of-logits,
   * since softmax is monotonic). About 5% faster than forward() +
   * external argmax for the 65→128→128→18 topology.
   */
  function argmax(obs) {
    // Manually run the last layer as "linear" to skip softmax.
    let x = obs;
    for (let i = 0; i < layers.length - 1; i++) {
      gemmActInto(x, layers[i], buffers[i]);
      x = buffers[i];
    }
    // Last layer: linear, then argmax over logits.
    const last = layers[layers.length - 1];
    const out = buffers[buffers.length - 1];
    const linearLayer = { w: last.w, b: last.b, outDim: last.outDim, inDim: last.inDim, act: "linear" };
    gemmActInto(x, linearLayer, out);
    let bestIdx = 0, bestVal = out[0];
    for (let i = 1; i < out.length; i++) {
      if (out[i] > bestVal) { bestVal = out[i]; bestIdx = i; }
    }
    return bestIdx;
  }

  return { forward, argmax, inputDim: weightsJson.input_dim, outputDim: weightsJson.output_dim };
}
