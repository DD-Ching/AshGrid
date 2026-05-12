// ============ FTUE — Compat no-op stubs (arena-mp) ============
// The full narrative prologue + scripted-canvas FTUE was removed for the
// arena-mp fork. These stubs keep the 130+ scattered callsites in the
// rest of the codebase safe (they all check typeof / null-guard).
//
// Classic-script. Declares globally:
//   ftue (object stub) · _ftueLog · _ftueIsActive · _ftueIsFirstSession
//   _ftueCurStep · _ftueRevealed · _ftueKeyLocked · _ftueCameraScale
//   _ftueShowCurrent · _ftueHide · _ftueEvent · _ftueSpawnAllies
//   _ftueSpawnTarget · _ftueStart · _scheduleFirstMatchToasts
//   _finalizeFtue
//
// External deps: AG.bool · AG.set · document.getElementById

const ftue = { active: false, stepIdx: 0, steps: [], stepShownAt: null,
                advancing: false, log: [] };
function _ftueLog(kind, msg) {
  try { console.log(`[FTUE-OLD ${kind}] ${msg}`); } catch (e) {}
}
function _ftueIsActive() { return false; }
function _ftueIsFirstSession() {
  // First session = ag.firstMatch is anything other than '1'.
  return !AG.bool('firstMatch');
}
function _ftueCurStep() { return null; }
function _ftueRevealed(_key) {
  // Arena mode: full HUD always. No scripted reveal gating.
  return true;
}
function _ftueKeyLocked(_k) {
  // Arena mode: no key lock. All keys work all the time.
  return false;
}
function _ftueCameraScale() {
  // Arena mode: no scripted camera override.
  return null;
}
function _ftueShowCurrent() {}
function _ftueHide() {
  const el = document.getElementById('ftueDialogue');
  if (el) el.setAttribute('hidden', '');
}
function _ftueEvent(_name) {}
function _ftueSpawnAllies() {}
function _ftueSpawnTarget() {}
function _ftueStart() {}
function _scheduleFirstMatchToasts() {}
function _finalizeFtue() {
  AG.set('firstMatch', '1');
}
