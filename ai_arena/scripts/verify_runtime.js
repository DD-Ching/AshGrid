// ============================================================
// Phase 0 — Verify pure-JS NN runtime matches ONNX reference.
// ============================================================
//
// For each model_*.onnx in ai_arena/onnx/, load:
//   - model_<style>.weights.json   (the JS-side weights, dumped by export_weights.py)
//   - model_<style>.verify.json    (ONNX ground-truth, dumped by gen_verify_fixtures.py)
//
// Run createNet().forward(obs) on each of the 100 obs vectors in the
// fixture, then assert:
//   1. argmax matches ONNX on >= 99/100 obs (allow 1 tie-break disagreement)
//   2. max per-class probability delta < 1e-4
//   3. top-1 probability within 1e-3
//
// Any failure ABORTS — this is the gate before any Phase 1+ refactor work.
//
// Run:   node ai_arena/scripts/verify_runtime.js

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createNet } from "../../server/party/sim/nn_runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ONNX_DIR = resolve(__dirname, "..", "onnx");

const ARGMAX_MATCH_THRESHOLD = 0.99;   // ≥ 99/100 must match ONNX argmax
const PROB_DELTA_TOLERANCE   = 1e-4;   // per-class probability delta
const TOP1_TOLERANCE         = 1e-3;   // top-1 probability delta

let totalPass = 0;
let totalFail = 0;
const failures = [];

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function verifyOne(style) {
  const weightsPath = resolve(ONNX_DIR, `${style}.weights.json`);
  const verifyPath  = resolve(ONNX_DIR, `${style}.verify.json`);

  const weights = loadJson(weightsPath);
  const fixture = loadJson(verifyPath);
  const net = createNet(weights);

  const n = fixture.n;
  let argmaxMatches = 0;
  let maxProbDelta = 0;
  let maxTop1Delta = 0;
  const disagreements = [];

  for (let k = 0; k < n; k++) {
    const obs = new Float32Array(fixture.obs[k]);
    const expectedArgmax = fixture.ground_truth_argmax[k];
    const expectedProbs = fixture.ground_truth_probs[k];

    const probs = net.forward(obs);

    // Argmax check
    let bestIdx = 0, bestVal = probs[0];
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > bestVal) { bestVal = probs[i]; bestIdx = i; }
    }
    if (bestIdx === expectedArgmax) {
      argmaxMatches++;
    } else {
      // Record the disagreement detail — what was ONNX confident about
      // vs us? If both top-2 are within 1e-3, this is a tie-break we
      // shouldn't worry about.
      const onnxTop = expectedProbs[expectedArgmax];
      const onnxOurs = expectedProbs[bestIdx];
      const oursTop = probs[bestIdx];
      const oursOnnx = probs[expectedArgmax];
      disagreements.push({
        obsIdx: k,
        onnxArgmax: expectedArgmax,
        jsArgmax: bestIdx,
        onnxTopProb: onnxTop,
        onnxJsProb: onnxOurs,
        jsTopProb: oursTop,
        jsOnnxProb: oursOnnx,
        gap: Math.abs(onnxTop - onnxOurs),
      });
    }

    // Probability delta check
    for (let i = 0; i < probs.length; i++) {
      const d = Math.abs(probs[i] - expectedProbs[i]);
      if (d > maxProbDelta) maxProbDelta = d;
    }
    const top1Delta = Math.abs(probs[expectedArgmax] - expectedProbs[expectedArgmax]);
    if (top1Delta > maxTop1Delta) maxTop1Delta = top1Delta;
  }

  const argmaxRate = argmaxMatches / n;
  const pass = (
    argmaxRate >= ARGMAX_MATCH_THRESHOLD &&
    maxProbDelta < PROB_DELTA_TOLERANCE &&
    maxTop1Delta < TOP1_TOLERANCE
  );

  if (pass) {
    totalPass++;
    console.log(`  ✓ ${style.padEnd(28)} argmax ${argmaxMatches}/${n} (${(argmaxRate*100).toFixed(1)}%)  maxProbΔ=${maxProbDelta.toExponential(2)}  top1Δ=${maxTop1Delta.toExponential(2)}`);
  } else {
    totalFail++;
    failures.push({ style, argmaxMatches, n, maxProbDelta, maxTop1Delta, disagreements });
    console.log(`  ✗ ${style.padEnd(28)} argmax ${argmaxMatches}/${n} (${(argmaxRate*100).toFixed(1)}%)  maxProbΔ=${maxProbDelta.toExponential(2)}  top1Δ=${maxTop1Delta.toExponential(2)}`);
  }
}

function main() {
  // Find all model styles by scanning .weights.json files
  const files = readdirSync(ONNX_DIR).filter((f) => f.endsWith(".weights.json")).sort();
  const styles = files.map((f) => f.replace(".weights.json", ""));

  console.log(`Verifying ${styles.length} models against ONNX ground truth:`);
  console.log(`  argmax match threshold:  ≥ ${(ARGMAX_MATCH_THRESHOLD*100).toFixed(0)}%`);
  console.log(`  per-class prob delta:    < ${PROB_DELTA_TOLERANCE.toExponential(0)}`);
  console.log(`  top-1 prob delta:        < ${TOP1_TOLERANCE.toExponential(0)}`);
  console.log();

  for (const style of styles) verifyOne(style);

  console.log();
  console.log(`Result: ${totalPass} passed / ${totalFail} failed`);

  if (totalFail > 0) {
    console.log();
    console.log("Failure details:");
    for (const f of failures) {
      console.log(`  ${f.style}:`);
      console.log(`    argmaxMatches: ${f.argmaxMatches}/${f.n}`);
      console.log(`    maxProbDelta:  ${f.maxProbDelta}`);
      console.log(`    top1Delta:     ${f.maxTop1Delta}`);
      console.log(`    disagreements (first 3):`);
      for (const d of f.disagreements.slice(0, 3)) {
        console.log(`      obs[${d.obsIdx}]: ONNX→${d.onnxArgmax} (p=${d.onnxTopProb.toFixed(4)}), `
                  + `JS→${d.jsArgmax} (p=${d.jsTopProb.toFixed(4)}), gap=${d.gap.toExponential(2)}`);
      }
    }
    process.exit(1);
  }
}

main();
