// ============ Positional audio (foundation) ============
// WebAudio context bootstrap + autoplay-unlock wiring. All other audio
// modules build on top of this — call `audioInit()` to get AUDIO.ctx, or
// rely on `audioUnlock()` having run via the document-level listeners
// below (one-time, on first user interaction).
//
// Classic-script. Declares globally:
//   AUDIO (object — { ctx, master, volume, enabled, unlocked, muted })
//   audioInit() · setAudioMuted(m) · audioUnlock()
//
// External deps: localStorage.* / document.* / window.AudioContext

const AUDIO = {
  ctx: null,
  master: null,
  volume: 0.35,    // master gain; lower if it's too loud
  enabled: true,
  unlocked: false,
  muted: false,
};
try { AUDIO.muted = localStorage.getItem('ag.muted') === '1'; } catch (e) {}
function audioInit() {
  if (AUDIO.ctx) return;
  try {
    AUDIO.ctx = new (window.AudioContext || window.webkitAudioContext)();
    AUDIO.master = AUDIO.ctx.createGain();
    AUDIO.master.gain.value = AUDIO.muted ? 0 : AUDIO.volume;
    AUDIO.master.connect(AUDIO.ctx.destination);
  } catch (e) { AUDIO.enabled = false; }
}
function setAudioMuted(m) {
  // R14 — delegate to AudioMute's user-preference path when loaded so
  // existing callsites (pause-menu button, legacy code) automatically
  // get the stack-aware mute logic. Direct AUDIO writes are kept as a
  // fallback in case audio_mute.js failed to load.
  if (typeof AudioMute !== 'undefined') {
    AudioMute.setUserMuted(!!m);
    return;
  }
  AUDIO.muted = !!m;
  if (AUDIO.master) AUDIO.master.gain.value = AUDIO.muted ? 0 : AUDIO.volume;
  try { localStorage.setItem('ag.muted', AUDIO.muted ? '1' : '0'); } catch (e) {}
}
function audioUnlock() {
  audioInit();
  if (AUDIO.ctx && AUDIO.ctx.state === 'suspended') AUDIO.ctx.resume();
  AUDIO.unlocked = true;
}
// Wire any user gesture as the unlock event
document.addEventListener('pointerdown', audioUnlock, { once: true });
document.addEventListener('keydown',     audioUnlock, { once: true });
