// ============ NARRATIVE AUDIO ============
// Short cinematic sounds that pair with the radio toasts + low-HP feedback
// loops. All synthesised on the fly through Web Audio so we don't ship any
// extra audio files.
//
// Classic-script. Declares globally:
//   playRadioStatic(durationSec, vol)   — bandpass noise burst
//   playRadioBeep(freq, vol)            — square-wave click
//   playUnlockChord()                   — C5/E5/G5 triad
//   playHeartbeat(rate, vol)            — kick-drum lub-dub
//   _tickHeartbeat()                    — per-frame scheduler (called by update())
//
// External deps: AUDIO (from js/audio/positional.js) · game · player

// Radio static burst — band-limited noise burst with a quick tail. Pairs
// with every radio toast so the comm channel feels physical, not visual.
function playRadioStatic(durationSec = 0.35, vol = 0.4) {
  if (!AUDIO.ctx || AUDIO.muted) return;
  const ctx = AUDIO.ctx;
  const sampleRate = ctx.sampleRate;
  const samples = Math.floor(sampleRate * durationSec);
  const buf = ctx.createBuffer(1, samples, sampleRate);
  const data = buf.getChannelData(0);
  // White noise w/ a slight high-pass texture (subtract DC + scale by ramp)
  for (let i = 0; i < samples; i++) {
    const t = i / samples;
    // Envelope: instant attack, exp decay
    const env = Math.pow(1 - t, 1.6);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // Bandpass to make it sound like radio chatter, not white noise
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1700;
  bp.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(bp); bp.connect(g); g.connect(AUDIO.master);
  src.start();
}

// Two-tone radio chirp — short beep that precedes a transmission. Combined
// with playRadioStatic for the classic "click → beep → message" feel.
function playRadioBeep(freq = 1320, vol = 0.18) {
  if (!AUDIO.ctx || AUDIO.muted) return;
  const ctx = AUDIO.ctx;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  g.gain.value = 0;
  g.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.005);
  g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.16);
  o.connect(g); g.connect(AUDIO.master);
  o.start(); o.stop(ctx.currentTime + 0.18);
}

// Tier-unlock chord — ascending triad (C5 / E5 / G5) with a soft sine
// timbre + short attack and a longer release. Distinct from the harsh
// radio square-wave beep so "you unlocked something" feels rewarding,
// not warning-ish. Fires once at bumpMatchPlayed when a tier crosses.
function playUnlockChord() {
  if (!AUDIO.ctx || AUDIO.muted) return;
  const ctx = AUDIO.ctx;
  const NOTES = [523.25, 659.25, 783.99];   // C5, E5, G5
  NOTES.forEach((freq, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    const start = ctx.currentTime + i * 0.10;
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.18, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.55);
    o.connect(g); g.connect(AUDIO.master);
    o.start(start); o.stop(start + 0.6);
  });
}

// Heartbeat — kick-drum-ish low thud + a soft second pump. Played on a
// loop with rate scaling with low-HP severity. update() schedules these
// based on the player's HP%.
function playHeartbeat(rate = 1.0, vol = 0.55) {
  if (!AUDIO.ctx || AUDIO.muted) return;
  const ctx = AUDIO.ctx;
  // Two pumps to sound like lub-dub, second one a tick after the first
  const pump = (offset, gain) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = 70;
    o.frequency.exponentialRampToValueAtTime(35, ctx.currentTime + offset + 0.18);
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(gain * vol, ctx.currentTime + offset + 0.012);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + offset + 0.20);
    o.connect(g); g.connect(AUDIO.master);
    o.start(ctx.currentTime + offset);
    o.stop(ctx.currentTime + offset + 0.22);
  };
  pump(0, 1.0);
  pump(0.18 / rate, 0.7);
}

// State: heart loop scheduler. update() calls _tickHeartbeat() each frame;
// it triggers one beat on schedule and skips when game isn't playing.
let _heartNextBeat = 0;
function _tickHeartbeat() {
  if (!game || game.state !== 'playing' || game._paused) return;
  if (!player.alive || player.maxHp <= 0) return;
  const hpFrac = player.hp / player.maxHp;
  if (hpFrac > 0.45) return;            // calm — no heartbeat audible
  // Rate ramps from 60bpm at 45% HP to 130bpm at <15% HP
  const intensity = Math.max(0, Math.min(1, (0.45 - hpFrac) / 0.30));
  const bpm = 60 + intensity * 70;
  const intervalTicks = (60 / bpm) * 60;   // 60 ticks/sec
  if (game.time >= _heartNextBeat) {
    playHeartbeat(1 + intensity, 0.35 + intensity * 0.4);
    _heartNextBeat = game.time + intervalTicks;
  }
}
