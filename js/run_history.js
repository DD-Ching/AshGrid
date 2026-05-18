// ============ RUN HISTORY (R11 Step 2 — split from ad_stubs.js) =========
// Per-mode local leaderboards for SP modes that have a clear "run ends,
// record the result" structure (survival waves, defense waves). NOT the
// global cross-player leaderboard — that's js/leaderboard.js (Firebase).
//
// Two storage buckets keyed by mode:
//   ag.survivalScores → top 10 survival runs (wave + kills + style + ts)
//   ag.defenseScores  → top 10 defense runs  (same shape)
//
// Also hosts the loss-card share + (stub) cloud upload paths because
// they're called from the same end-of-run code as the recordRun path.
//
// Classic-script. Declares globally:
//   SURVIVAL_KEY · DEFENSE_KEY · SURVIVAL_MAX
//   getSurvivalScores() · getDefenseScores()
//   recordRun({ mode, wave, kills, style })
//   recordSurvivalRun({ wave, kills, style })   ← back-compat shim
//   uploadSurvivalRun(run)                       ← cloud stub (no-op)
//   shareSurvivalRun({ wave, kills, style })    ← Web Share API / clipboard
//
// External deps:
//   localStorage · navigator.share · navigator.clipboard ·
//   T · showSwapToast · getOperatorName (global_stats.js) ·
//   bumpSurvivalWave (global_stats.js) · DIFF_LABELS (i18n.js)

const SURVIVAL_KEY = 'ag.survivalScores';
const DEFENSE_KEY  = 'ag.defenseScores';
const SURVIVAL_MAX = 10;

function getSurvivalScores() {
  try { return JSON.parse(localStorage.getItem(SURVIVAL_KEY) || '[]'); }
  catch (e) { return []; }
}
function getDefenseScores() {
  try { return JSON.parse(localStorage.getItem(DEFENSE_KEY) || '[]'); }
  catch (e) { return []; }
}

// Records to whichever bucket the run came from. Used by survival's loss
// path AND defense's loss path; the `mode` param routes the write so the
// two leaderboards don't collide.
function recordRun({ mode, wave, kills, style }) {
  const key = mode === 'defense' ? DEFENSE_KEY : SURVIVAL_KEY;
  const run = { wave, kills, style: style || 'elite', ts: Date.now() };
  try {
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    list.push(run);
    list.sort((a, b) => (b.wave - a.wave) || (b.kills - a.kills));
    list.length = Math.min(list.length, SURVIVAL_MAX);
    localStorage.setItem(key, JSON.stringify(list));
  } catch (e) {}
  // Cloud upload (no-op until Firebase wires in) — both modes share the
  // same upload endpoint for now; the run object carries `mode`.
  uploadSurvivalRun({ ...run, mode });
  if (typeof bumpSurvivalWave === 'function') bumpSurvivalWave(wave);
}

// Back-compat shim — older call sites still call recordSurvivalRun. Routes
// to recordRun with mode='survival' so existing data lands in its bucket.
function recordSurvivalRun({ wave, kills, style }) {
  recordRun({ mode: 'survival', wave, kills, style });
}

// Cloud leaderboard upload — currently a no-op. Real impl pushes to Firestore.
function uploadSurvivalRun(run) {
  // STUB. Real impl:
  //   firebase.firestore().collection('survival').add({ ...run, uid });
  // For now we keep the local list authoritative.
  return Promise.resolve(run);
}

// Share-run helper — called from the survival end card. Builds a one-line
// brag text + the page URL, then prefers Web Share API (mobile native
// sheet) and falls back to clipboard. The toast tells the player which
// path fired so they can paste manually if neither worked.
function shareSurvivalRun({ wave, kills, style }) {
  const styleLabel = (typeof DIFF_LABELS !== 'undefined' && DIFF_LABELS[style]) || style || 'elite';
  const url = location.href.split('?')[0].split('#')[0];
  const op = (typeof getOperatorName === 'function') ? getOperatorName() : '0451';
  const text = T(
    `AshGrid · 操作員 ${op} · 撑过 ${wave} 波 · 击杀 ${kills} · 风格 ${styleLabel}`,
    `AshGrid · OPERATOR ${op} · Wave ${wave} · ${kills} kills · ${styleLabel}`
  );
  const shareData = { title: 'AshGrid · Tactical Sim', text, url };
  if (navigator.share) {
    navigator.share(shareData).then(
      () => showSwapToast(T('已分享 ✓', 'Shared ✓')),
      () => {/* user cancelled — silent */}
    );
    return;
  }
  // Fallback: clipboard copy
  const blurb = `${text}\n${url}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(blurb).then(
      () => showSwapToast(T('已复制 · 贴到 X / Discord', 'Copied · paste to X / Discord')),
      () => showSwapToast(T('复制失败,长按文字手动复制', 'Copy failed, long-press to copy manually'))
    );
  } else {
    showSwapToast(T('请手动复制:', 'Copy manually:') + ' ' + blurb);
  }
}
