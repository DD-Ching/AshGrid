// ============ AMBIENT MUSIC ============
// Synth-only — no audio file dependency. Two detuned sawtooth drones at
// 55/55.5Hz + a 220Hz sine shimmer through a slow-LFO-modulated lowpass.
// Lives only while game.state === 'playing'.
//
// Classic-script. Declares globally:
//   MUSIC (object — { active, master, oscs, volume })
//   startMusic() · stopMusic()
//
// External deps: AUDIO + audioInit (from js/audio/positional.js)

const MUSIC = { active: false, master: null, oscs: [], volume: 0.05 };
function startMusic() {
  if (!AUDIO.enabled || !AUDIO.unlocked || MUSIC.active) return;
  audioInit();
  const ctx = AUDIO.ctx;
  if (!ctx) return;
  const master = ctx.createGain();
  master.gain.value = 0;        // fade in
  master.gain.linearRampToValueAtTime(MUSIC.volume, ctx.currentTime + 1.5);
  master.connect(AUDIO.master);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 240;
  filt.Q.value = 1.6;
  filt.connect(master);
  // LFO modulates filter cutoff for "breathing" feel
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.06;
  const lfoG = ctx.createGain();
  lfoG.gain.value = 110;
  lfo.connect(lfoG);
  lfoG.connect(filt.frequency);
  lfo.start();
  const oscs = [lfo];
  const drone = (freq, vol, type) => {
    const o = ctx.createOscillator();
    o.type = type || 'sawtooth';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = vol;
    o.connect(g).connect(filt);
    o.start();
    oscs.push(o);
  };
  drone(55,   0.55, 'sawtooth');
  drone(55.5, 0.55, 'sawtooth');
  drone(82.5, 0.30, 'sawtooth');     // perfect fifth above for harmonic body
  drone(220,  0.18, 'sine');         // shimmer
  MUSIC.master = master;
  MUSIC.oscs = oscs;
  MUSIC.active = true;
}
function stopMusic() {
  if (!MUSIC.active) return;
  const ctx = AUDIO.ctx;
  if (MUSIC.master && ctx) {
    try {
      MUSIC.master.gain.cancelScheduledValues(ctx.currentTime);
      MUSIC.master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
    } catch (e) {}
  }
  setTimeout(() => {
    for (const o of MUSIC.oscs) {
      try { o.stop(); } catch (e) {}
      try { o.disconnect(); } catch (e) {}
    }
    if (MUSIC.master) try { MUSIC.master.disconnect(); } catch (e) {}
    MUSIC.master = null;
    MUSIC.oscs = [];
    MUSIC.active = false;
  }, 700);
  MUSIC.active = false;   // mark inactive immediately so loop() doesn't re-fire
}

// Play a short synthetic gunshot at world (sx, sy) heard from the player's position.
// `kind`: 'shot' (gunfire), 'buzz' (drone), 'self' (your own weapon — full vol, center pan)
// `profile` (optional): per-weapon { peakFreq, decay, bassFreq, bassDur, volMul }
//   that gives each gun a distinct timbre (SMG = bright pop, sniper = deep thump).
