// ============ NN AI MODULE (PPO ONNX inference) — extracted Phase 185 ========
// The trained PPO policy expects:
//   input "observation":  Float32Array shape [batch, 65], values in [-1, 1]
//   output "action_probs": Float32Array shape [batch, 18], softmax probs
// Action 0..17 decoded as: move_dir = action // 2 (0..8), fire = action % 2 (0..1)
//   move_dir 0=idle, 1=N, 2=NE, 3=E, 4=SE, 5=S, 6=SW, 7=W, 8=NW
//
// Lifted verbatim out of the index.html inline monolith (behaviour-preserving).
// Classic-script: NN / nnLoadModel / nnLoadAll stay global, every reader
// (enemy_ai.js, squad.js, npc_director.js, vision) is unchanged. Loaded early
// (after geometry.js) — readers use NN at RUNTIME so order vs enemy_ai is moot;
// enemy_ai's lazy _nnObsBuf init still works. `ort` comes from the CDN <script>.
const NN = {
  session: null,           // ort.InferenceSession when loaded
  loading: false,
  loaded: false,
  error: null,
  difficulty: null,        // 'easy' | 'medium' | 'hard' | 'evolved' | 'elite' | 'defensive' | 'cqb' | null
  modelPaths: {
    easy:      'ai_arena/onnx/model_easy.onnx',
    medium:    'ai_arena/onnx/model_medium.onnx',
    hard:      'ai_arena/onnx/model_hard.onnx',
    evolved:   'ai_arena/onnx/model_evolved.onnx',
    elite:        'ai_arena/onnx/model_elite.onnx',
    defensive:    'ai_arena/onnx/model_norespawn.onnx',
    warrior:      'ai_arena/onnx/model_warrior.onnx',
    sharpshooter: 'ai_arena/onnx/model_sharpshooter.onnx',
    cqb:          'ai_arena/onnx/model_cqb.onnx',
    // Tactical model collapsed during PPO training — top action is always 5
    // (move NE + fire) at p≈1.0 regardless of enemy direction. The model
    // doesn't intercept because it doesn't even orient toward enemies. Fall
    // back to elite until a retrained model_tactical.onnx ships. Picker
    // still shows TAC so the unlock UX doesn't regress, just behind the
    // elite weights.
    tactical:     'ai_arena/onnx/model_elite.onnx',
  },
  modelPath: 'ai_arena/onnx/model.onnx',  // legacy fallback
  // Constants must match the Python combat_env exactly
  WORLD_W: 1800,                                // Phase 16: matches NN_ARENA bump
  WORLD_H: 1800,
  PLAYER_HP: 100,
  PLAYER_SPEED: 2.8,
  FIRE_CD: 8,
  AIM_LERP: 0.30,
  VIEW_RANGE: 960,    // matches VIEW.range — bumped from 720 to give NN units
  VIEW_ARC: Math.PI * 0.78,   // 140°
  OBS_DIM: 65,
  ACTION_DIM: 18,
  // 9 movement directions matching Python MOVE_DIRS
  MOVE_DIRS: [
    [0, 0],
    [0, -1],
    [Math.SQRT1_2, -Math.SQRT1_2],
    [1, 0],
    [Math.SQRT1_2, Math.SQRT1_2],
    [0, 1],
    [-Math.SQRT1_2, Math.SQRT1_2],
    [-1, 0],
    [-Math.SQRT1_2, -Math.SQRT1_2],
  ],
  lastSound: null,           // {x, y, tick, team} — most recent gunshot
};

// Per-difficulty session cache. Multiple difficulties can be loaded at once
// (used by the lineup editor — different units fight with different brains).
NN.sessions = {};

// In-flight load promises so concurrent callers (e.g. 8 units booting at the
// same time and each calling nnLoadModel('defensive')) share one create()
// instead of stampeding the WASM runtime with 8 parallel loads of the same
// .onnx blob. Without this we saw the model load + log 8x at match start.
NN.loading = NN.loading || {};
async function nnLoadModel(difficulty = 'hard') {
  // Fast-path: already cached
  if (NN.sessions[difficulty]) {
    NN.session = NN.sessions[difficulty];
    NN.loaded = true;
    NN.difficulty = difficulty;
    return true;
  }
  // Dedup in-flight loads — return the already-pending promise
  if (NN.loading[difficulty]) {
    return NN.loading[difficulty];
  }
  if (typeof ort === 'undefined') {
    NN.error = 'onnxruntime-web not loaded';
    console.warn(NN.error);
    return false;
  }
  // ONNX WASM thread count. Defaults to 4 (one per physical core); we'd
  // need cross-origin isolation (COOP + COEP) for SharedArrayBuffer to
  // actually use them, and we don't ship those headers (Cloudflare Pages
  // serves no Cross-Origin-Opener-Policy by default). So the threaded
  // wasm-MT bundle gets downloaded + initialized then silently falls
  // back to single-threaded with the noisy 'env.wasm.numThreads is set
  // to 4, but this will not work unless you enable crossOriginIsolated'
  // warning. Forcing 1 skips loading the multi-threaded wasm blob
  // entirely — same actual inference speed, smaller initial download,
  // clean console. Setting on ort.env is idempotent; safe to repeat if
  // multiple difficulty sessions get created.
  if (typeof ort.env !== 'undefined' && ort.env.wasm) {
    ort.env.wasm.numThreads = 1;
  }
  const path = NN.modelPaths[difficulty] || NN.modelPath;
  const promise = (async () => {
    try {
      const sess = await ort.InferenceSession.create(path, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      NN.sessions[difficulty] = sess;
      NN.session = sess;
      NN.loaded = true;
      NN.difficulty = difficulty;
      console.log('NN model loaded:', path, '(difficulty:', difficulty + ')');
      return true;
    } catch (e) {
      NN.error = String(e);
      console.error('NN load failed:', e);
      return false;
    } finally {
      delete NN.loading[difficulty];
    }
  })();
  NN.loading[difficulty] = promise;
  return promise;
}

// Pre-load multiple difficulties in parallel — used by the lineup editor when
// the user mixes different brains across units.
async function nnLoadAll(difficulties) {
  const uniq = [...new Set(difficulties.filter(Boolean))];
  const results = await Promise.all(uniq.map(d => nnLoadModel(d)));
  return results.every(Boolean);
}
