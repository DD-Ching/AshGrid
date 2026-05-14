// ============================================================
// Phase 0 — Benchmark pure-JS NN runtime.
// ============================================================
//
// Confirms the forward pass is fast enough to run 16 bots × 30Hz inside a
// Cloudflare Durable Object tick.
//
// Tick budget: a PartyKit DO tick at 30Hz has 33ms wall-clock between
// ticks. We want NN inference to consume well under 10% of that (3ms)
// so the rest of the simulation (physics, bullets, hit detection,
// broadcast) has comfortable headroom.
//
// Target:  16 inferences in < 3ms wall-clock (per tick)
// Stretch: 32 inferences in < 5ms (for larger room scenarios)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createNet } from "../../server/party/sim/nn_runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ONNX_DIR = resolve(__dirname, "..", "onnx");

const weights = JSON.parse(readFileSync(resolve(ONNX_DIR, "model_elite.weights.json"), "utf8"));
const fixture = JSON.parse(readFileSync(resolve(ONNX_DIR, "model_elite.verify.json"), "utf8"));

const net = createNet(weights);
const obsPool = fixture.obs.map((row) => new Float32Array(row));

function bench(label, iters, fn) {
  // Warmup (JIT settle)
  for (let i = 0; i < Math.min(200, iters); i++) fn();
  // Measure
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const t1 = performance.now();
  const totalMs = t1 - t0;
  const perCall = (totalMs / iters) * 1000; // µs
  console.log(`  ${label.padEnd(34)}  ${iters.toString().padStart(8)} calls in ${totalMs.toFixed(2)} ms  → ${perCall.toFixed(2)} µs/call`);
  return perCall;
}

console.log("Benchmark: pure-JS PPO forward pass (model_elite, 65→128→128→18)");
console.log();

// Single-call cost (forward returns probs array)
const usPerForward = bench("forward(obs)", 10000, () => {
  net.forward(obsPool[(Math.random() * 100) | 0]);
});

// Argmax shortcut (skips softmax in last layer)
const usPerArgmax = bench("argmax(obs)", 10000, () => {
  net.argmax(obsPool[(Math.random() * 100) | 0]);
});

console.log();

// Tick-scale benchmark: 16 bots
console.log("Tick-scale (16 bots per tick @ 30 Hz):");
const ticks = 1000;
const t0 = performance.now();
for (let t = 0; t < ticks; t++) {
  for (let b = 0; b < 16; b++) {
    net.argmax(obsPool[(b * 7 + t) % 100]);
  }
}
const t1 = performance.now();
const usPerTick = ((t1 - t0) / ticks) * 1000;
const tickBudgetMs = 33.33;
const tickPct = (usPerTick / 1000 / tickBudgetMs) * 100;
console.log(`  16 bots × ${ticks} ticks: ${(t1 - t0).toFixed(2)} ms total → ${usPerTick.toFixed(2)} µs/tick`);
console.log(`  Per-tick NN cost: ${(usPerTick / 1000).toFixed(3)} ms / ${tickBudgetMs} ms budget  → ${tickPct.toFixed(2)}% of tick`);

// Larger scenario: 32 bots
const t2 = performance.now();
for (let t = 0; t < ticks; t++) {
  for (let b = 0; b < 32; b++) {
    net.argmax(obsPool[(b * 11 + t) % 100]);
  }
}
const t3 = performance.now();
const usPer32 = ((t3 - t2) / ticks) * 1000;
const tickPct32 = (usPer32 / 1000 / tickBudgetMs) * 100;
console.log(`  32 bots × ${ticks} ticks: ${(t3 - t2).toFixed(2)} ms total → ${usPer32.toFixed(2)} µs/tick`);
console.log(`  Per-tick NN cost: ${(usPer32 / 1000).toFixed(3)} ms / ${tickBudgetMs} ms budget  → ${tickPct32.toFixed(2)}% of tick`);

console.log();
console.log("Verdict:");
if (usPerTick / 1000 < 3) {
  console.log(`  ✓ 16-bot scenario well within 3ms target (${(usPerTick / 1000).toFixed(2)} ms)`);
} else {
  console.log(`  ✗ 16-bot scenario exceeds 3ms target (${(usPerTick / 1000).toFixed(2)} ms) — optimize before Phase 3`);
}
if (usPer32 / 1000 < 5) {
  console.log(`  ✓ 32-bot scenario well within 5ms stretch target (${(usPer32 / 1000).toFixed(2)} ms)`);
} else {
  console.log(`  ⚠ 32-bot scenario exceeds 5ms stretch target (${(usPer32 / 1000).toFixed(2)} ms) — consider quantizing if rooms get this large`);
}
