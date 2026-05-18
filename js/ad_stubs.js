// ============ AD / CLOUD STUBS (Phase 3 swap-in points) ============
// Rewarded ads (skip-wave, revive-on-loss, extend-build-phase) and cloud
// leaderboard hooks are stubbed for now — Phase 3 will replace these with
// real network calls. The stubs unconditionally succeed so the flow works
// during dev / itch.io demo days.
//
// Classic-script. Declares globally:
//   uploadScore(...) · fetchLeaderboard(...) · shareSurvivalRun ·
//   uploadSurvivalRun · getSurvivalScores · getDefenseScores ·
//   bumpSurvivalWave (etc.)
//
// External deps: localStorage · navigator.clipboard · T · showSwapToast
//
// R11 Step 1: requestRewardedAd stub MOVED to js/ad_dispatch.js (single
// owner of the global). SDK adapters (gamemonetize.js / crazygames.js)
// register via window.registerAdProvider instead of override war.

// These wrap the lifecycle that the real Firebase / AdMob integrations will
// plug into. Today they're local-only stubs — saving + loading come from
// localStorage. When the user authenticates Firebase, drop the real
// SDK into the marked spots — every callsite on the rest of the codebase
// stays unchanged.

// Share-run helper — called from the survival end card. Builds a one-line
// brag text + the page URL, then prefers Web Share API (mobile native
// sheet) and falls back to clipboard. The toast tells the player which
// path fired so they can paste manually if neither worked.
function shareSurvivalRun({ wave, kills, style }) {
  const styleLabel = (DIFF_LABELS && DIFF_LABELS[style]) || style || 'elite';
  const url = location.href.split('?')[0].split('#')[0];
  const op = getOperatorName();
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

// Cloud leaderboard upload — currently a no-op. Real impl pushes to Firestore.
function uploadSurvivalRun(run) {
  // STUB. Real impl:
  //   firebase.firestore().collection('survival').add({ ...run, uid });
  // For now we keep the local list authoritative.
  return Promise.resolve(run);
}

// Local survival leaderboard (localStorage). Top 10 runs sorted by waves
// then kills. recordSurvivalRun() will both store locally AND fire the
// cloud upload stub — when Firebase ships, both paths populate.
const SURVIVAL_KEY = 'ag.survivalScores';
const DEFENSE_KEY  = 'ag.defenseScores';
const SURVIVAL_MAX = 10;
const OPERATOR_NAME_KEY = 'ag.operatorName';
function getOperatorName() {
  try { return (localStorage.getItem(OPERATOR_NAME_KEY) || '0451').slice(0, 12); }
  catch (e) { return '0451'; }
}
function setOperatorName(name) {
  const clean = String(name || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
  if (!clean) return getOperatorName();
  try { localStorage.setItem(OPERATOR_NAME_KEY, clean); } catch (e) {}
  return clean;
}
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
  bumpSurvivalWave(wave);
}
// Back-compat shim — older call sites still call recordSurvivalRun. Routes
// to recordRun with mode='survival' so existing data lands in its bucket.
function recordSurvivalRun({ wave, kills, style }) {
  recordRun({ mode: 'survival', wave, kills, style });
}


