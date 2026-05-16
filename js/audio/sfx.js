// ============ SOUND EFFECTS (positional + UI) ============
// playPositionalSound — short synthetic gunshot at world (sx, sy) heard from
//   the player's position. Distance attenuation + stereo pan. Per-weapon
//   profile gives each gun a distinct timbre.
// playSfx — named UI/event SFX (reload, hit_marker, kill_confirm, etc.)
//   with per-cue cooldown so rapid events don't pile up audio.
// emitSound — game-event broadcast: pushes a soundEvents entry for the AI
//   to alert on, AND triggers playPositionalSound for the audible side.
//   Also writes squad intel (allies investigate hostile gunshots in earshot).
//
// Classic-script. Declares globally:
//   playPositionalSound(sx, sy, intensity, kind, isSelf, profile)
//   _SFX_COOLDOWN · _sfxLastTick · _sfxAllowed(name) · playSfx(name, opts)
//   soundEvents (array — consumed by enemy AI alert logic)
//   emitSound(x, y, intensity, fromPlayer, isPlayerSelf, profile)
//
// External deps (resolved at call-time):
//   AUDIO · audioInit (from js/audio/positional.js)
//   player · mouse · enemies · allies · screenToWorld
//   squadIntel · SQUAD_INTEL_FRESH_FRAMES · game.time

// Play a short synthetic gunshot at world (sx, sy) heard from the player's position.
// `kind`: 'shot' (gunfire), 'buzz' (drone), 'self' (your own weapon — full vol, center pan)
// `profile` (optional): per-weapon { peakFreq, decay, bassFreq, bassDur, volMul }
//   that gives each gun a distinct timbre (SMG = bright pop, sniper = deep thump).
function playPositionalSound(sx, sy, intensity, kind = 'shot', isSelf = false, profile = null) {
  if (!AUDIO.enabled || !AUDIO.unlocked) return;
  audioInit();
  if (!AUDIO.ctx) return;
  const ctx = AUDIO.ctx;

  // Distance attenuation (relative to listener = player)
  const dx = sx - player.x, dy = sy - player.y;
  const dist = Math.hypot(dx, dy);
  const maxDist = intensity || 1500;
  const volMul = (profile && profile.volMul) || 1;
  let vol;
  if (isSelf) {
    vol = 0.7 * volMul;
  } else {
    if (dist > maxDist) return;
    // Phase 110 — linear falloff with a punchy close-range boost. The old
    // ^1.4 curve dropped to ~38 % at half-distance, which made ambushes
    // from the next room feel inaudible. Linear + a +0.45 boost inside
    // 250 u gives close shots an actual 'jolt' feel while far ones still
    // taper to zero. User: '武器近的時候很大聲, 遠的時候很小聲'.
    vol = Math.max(0, 1 - dist / maxDist) * volMul;
    vol += Math.max(0, 1 - dist / 250) * 0.45 * volMul;
    vol = Math.min(1.2, vol);
    if (vol < 0.005) return;
  }

  // Stereo pan: rotate offset into the LISTENER'S local frame. Pan must
  // line up with what's on screen, so we use camera.rotation (which is 0
  // in tactical top-down and tracks the pilot in FPV / drone modes). The
  // earlier code read `player.viewAngle` (never assigned, so always
  // undefined) and fell back to `player.angle` — so the pan rotated with
  // the player's body even in top-down. A player facing north with an
  // ambush from screen-east got rotated to a centre/inverted pan, exactly
  // the 'right side shot, no right-ear sound' the user reported.
  const va = (typeof camera !== 'undefined' && camera.rotation != null)
    ? camera.rotation
    : 0;
  const localX = dx * Math.cos(-va) - dy * Math.sin(-va);
  const pan = isSelf ? 0 : Math.max(-1, Math.min(1, localX / 350));
  const closeness = isSelf ? 1 : Math.max(0, 1 - dist / maxDist);

  // === BOOM kind (Phase 111) — explosions: sub-bass sweep + low crash ===
  // Used by FPV detonations, rockets, airstrikes, etc. Layered so far hits
  // still rumble (bass survives distance) while near ones feel concussive
  // (broadband crash + heavy low end).
  if (kind === 'boom') {
    // Layer 1 — sub-bass sweep (220 → 35 Hz over 0.8 s, sine wave)
    const subDur = 0.8;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(220, ctx.currentTime);
    sub.frequency.exponentialRampToValueAtTime(35, ctx.currentTime + subDur);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(vol * 1.0, ctx.currentTime);
    subGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + subDur);
    let subChain = sub.connect(subGain);
    if (ctx.createStereoPanner) {
      const p1 = ctx.createStereoPanner();
      p1.pan.value = pan * 0.5;   // low freqs less directional
      subChain = subChain.connect(p1);
    }
    subChain.connect(AUDIO.master);
    sub.start();
    sub.stop(ctx.currentTime + subDur + 0.05);

    // Layer 2 — broadband crash (filtered noise, fast decay)
    const crashDur = 0.50;
    const cbuf = ctx.createBuffer(1, Math.max(64, Math.floor(ctx.sampleRate * crashDur)), ctx.sampleRate);
    const cdata = cbuf.getChannelData(0);
    for (let i = 0; i < cdata.length; i++) {
      const t = i / cdata.length;
      cdata[i] = (Math.random() * 2 - 1) * Math.exp(-t * 5.5);
    }
    const cs = ctx.createBufferSource();
    cs.buffer = cbuf;
    const cbp = ctx.createBiquadFilter();
    cbp.type = 'bandpass';
    cbp.frequency.value = 220;
    cbp.Q.value = 0.5;
    const clp = ctx.createBiquadFilter();
    clp.type = 'lowpass';
    clp.frequency.value = 350 + closeness * 1800;
    const cg = ctx.createGain();
    cg.gain.value = vol * 0.7;
    let cChain = cs.connect(cbp).connect(clp);
    if (ctx.createStereoPanner) {
      const p2 = ctx.createStereoPanner();
      p2.pan.value = pan;
      cChain = cChain.connect(p2);
    }
    cChain.connect(cg).connect(AUDIO.master);
    cs.start();

    // Layer 3 — debris tail (very low-volume mid-band hiss for 0.3 s after)
    if (closeness > 0.15) {
      const tailDur = 0.35;
      const tbuf = ctx.createBuffer(1, Math.max(64, Math.floor(ctx.sampleRate * tailDur)), ctx.sampleRate);
      const tdata = tbuf.getChannelData(0);
      for (let i = 0; i < tdata.length; i++) {
        const t = i / tdata.length;
        tdata[i] = (Math.random() * 2 - 1) * Math.exp(-t * 2.5) * (1 - t * 0.7);
      }
      const ts = ctx.createBufferSource();
      ts.buffer = tbuf;
      const tbp = ctx.createBiquadFilter();
      tbp.type = 'bandpass';
      tbp.frequency.value = 700;
      tbp.Q.value = 1;
      const tg = ctx.createGain();
      tg.gain.value = vol * 0.35 * closeness;
      let tChain = ts.connect(tbp);
      if (ctx.createStereoPanner) {
        const p3 = ctx.createStereoPanner();
        p3.pan.value = pan;
        tChain = tChain.connect(p3);
      }
      tChain.connect(tg).connect(AUDIO.master);
      ts.start(ctx.currentTime + 0.06);   // delayed 60 ms after the crash
    }
    return;
  }

  // === CRACKLE kind (Phase 111) — burning wreckage embers ===
  // Tiny mid-band pops with randomised pitch. Used by wreckage tick to
  // emit positional ambient fire crackles whose volume scales with the
  // wreckage's remaining heat. Each call is one pop; the wreckage loop
  // schedules them at intervals.
  if (kind === 'crackle') {
    const dur = 0.04 + Math.random() * 0.05;
    const buf = ctx.createBuffer(1, Math.max(32, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length;
      data[i] = (Math.random() * 2 - 1) * Math.exp(-t * (18 + Math.random() * 12));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 320 + Math.random() * 360;
    bp.Q.value = 2.5;
    const gain = ctx.createGain();
    gain.gain.value = vol * 0.55;
    let chain = src.connect(bp);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      chain = chain.connect(p);
    }
    chain.connect(gain).connect(AUDIO.master);
    src.start();
    return;
  }

  const isGunshot = (kind !== 'buzz');

  // === MECHANICAL CLICK (Phase 111b) — sharp 1-3 ms transient at the
  // very top of the gunshot. Hammer-fall / bolt-release tick. Skipped
  // for drone buzz, played at REDUCED volume when very far away (it's a
  // close-quarters detail — too much from across the map sounds tinny).
  if (isGunshot) {
    const clickDur = 0.003;
    const clickBuf = ctx.createBuffer(1, Math.max(8, Math.floor(ctx.sampleRate * clickDur)), ctx.sampleRate);
    const cdata = clickBuf.getChannelData(0);
    for (let i = 0; i < cdata.length; i++) {
      cdata[i] = (Math.random() * 2 - 1) * Math.exp(-i / cdata.length * 8);
    }
    const cs = ctx.createBufferSource();
    cs.buffer = clickBuf;
    const cbp = ctx.createBiquadFilter();
    cbp.type = 'highpass';
    cbp.frequency.value = 2000;
    const cg = ctx.createGain();
    cg.gain.value = vol * (0.18 + closeness * 0.25);
    let cChain = cs.connect(cbp);
    if (ctx.createStereoPanner) {
      const cp = ctx.createStereoPanner();
      cp.pan.value = pan;
      cChain = cChain.connect(cp);
    }
    cChain.connect(cg).connect(AUDIO.master);
    cs.start();
  }

  // === Crack (noise burst) — bandpass center varies per weapon ===
  const peakFreq = (profile && profile.peakFreq) ||
                   (kind === 'buzz' ? 1200 : (kind === 'self' ? 480 : 600));
  const decay = (profile && profile.decay) ||
                (kind === 'buzz' ? 18 : 11);
  const dur = (kind === 'buzz') ? 0.08 : 0.18;

  const buf = ctx.createBuffer(1, Math.max(64, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * Math.exp(-t * decay);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = peakFreq;
  bp.Q.value = (kind === 'buzz') ? 2.0 : 0.7;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 600 + closeness * 5000;
  const crackPanner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (crackPanner) crackPanner.pan.value = pan;
  const gain = ctx.createGain();
  gain.gain.value = vol;
  let chain = src.connect(bp).connect(lp);
  if (crackPanner) chain = chain.connect(crackPanner);
  chain.connect(gain).connect(AUDIO.master);
  src.start();

  // === Bass thump (sine pulse) — only for big guns; survives distance better ===
  if (profile && profile.bassFreq > 0 && profile.bassDur > 0) {
    const bassDur = profile.bassDur;
    const bassVol = isSelf
      ? 0.55 * volMul
      : 0.55 * Math.max(0, 1 - dist / (maxDist * 1.4)) * volMul;
    if (bassVol >= 0.003) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(profile.bassFreq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, profile.bassFreq * 0.45),
        ctx.currentTime + bassDur
      );
      const bassGain = ctx.createGain();
      bassGain.gain.setValueAtTime(bassVol, ctx.currentTime);
      bassGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + bassDur);
      let bassChain = osc.connect(bassGain);
      if (ctx.createStereoPanner) {
        const bp2 = ctx.createStereoPanner();
        bp2.pan.value = pan;
        bassChain = bassChain.connect(bp2);
      }
      bassChain.connect(AUDIO.master);
      osc.start();
      osc.stop(ctx.currentTime + bassDur + 0.02);
    }
  }

  // === UNIVERSAL SUB-THUMP (Phase 111b) — small low-freq pulse on EVERY
  // gunshot (not just profiled big guns). Adds body / 'weight' to SMG /
  // pistol pops so they don't feel paper-thin. Skipped for drone buzz.
  // Profile bass thump above is bigger and survives further; this one is
  // a short attached pulse for the close/mid range.
  if (isGunshot && !(profile && profile.bassFreq > 0)) {
    const subDur = 0.08;
    const subVol = isSelf ? 0.28 * volMul : 0.34 * vol;
    if (subVol >= 0.003) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(140, ctx.currentTime);
      sub.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + subDur);
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(subVol, ctx.currentTime);
      sg.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + subDur);
      let subChain = sub.connect(sg);
      if (ctx.createStereoPanner) {
        const sp = ctx.createStereoPanner();
        sp.pan.value = pan * 0.6;     // low freqs less directional
        subChain = subChain.connect(sp);
      }
      subChain.connect(AUDIO.master);
      sub.start();
      sub.stop(ctx.currentTime + subDur + 0.02);
    }
  }

  // === REFLECTION TAIL (Phase 111b) — for distant gunshots only. Soft
  // delayed mid-band noise that simulates the 'crack-and-echo' of a shot
  // bouncing off buildings. Only audible past ~60 % of max range so close
  // shots stay punchy, not muddy. Drone buzz never gets a tail.
  if (isGunshot && !isSelf && closeness < 0.6 && closeness > 0.05) {
    const tailDur = 0.28;
    const tailVol = vol * 0.5 * (1 - closeness);
    if (tailVol >= 0.004) {
      const tbuf = ctx.createBuffer(1, Math.max(64, Math.floor(ctx.sampleRate * tailDur)), ctx.sampleRate);
      const tdata = tbuf.getChannelData(0);
      for (let i = 0; i < tdata.length; i++) {
        const t = i / tdata.length;
        tdata[i] = (Math.random() * 2 - 1) * Math.exp(-t * 3.5);
      }
      const ts = ctx.createBufferSource();
      ts.buffer = tbuf;
      const tbp = ctx.createBiquadFilter();
      tbp.type = 'bandpass';
      tbp.frequency.value = 500;
      tbp.Q.value = 0.9;
      const tlp = ctx.createBiquadFilter();
      tlp.type = 'lowpass';
      tlp.frequency.value = 1200;
      const tg = ctx.createGain();
      tg.gain.value = tailVol;
      let tChain = ts.connect(tbp).connect(tlp);
      if (ctx.createStereoPanner) {
        const tp = ctx.createStereoPanner();
        tp.pan.value = pan * 0.7;     // partial pan, echo bounces around
        tChain = tChain.connect(tp);
      }
      tChain.connect(tg).connect(AUDIO.master);
      ts.start(ctx.currentTime + 0.035);   // 35 ms delay — feels like an echo
    }
  }
}

// Generic synthesized SFX (hit/death/respawn/reload/whiz/countdown).
// Lighter weight than playPositionalSound — single oscillator + envelope.
// Per-name SFX cooldowns — kept around as a generic floor mechanism.
// Empty by default; populate when a future preset starts piling up
// (kill_confirm used to be in here at 8 ticks before the preset was
// removed entirely on user request — '把那個叮咚鈴聲移除').
const _SFX_COOLDOWN = {};
const _sfxLastTick = {};
function _sfxAllowed(name) {
  const cd = _SFX_COOLDOWN[name];
  if (!cd) return true;
  const now = (game && game.time) || 0;
  if ((now - (_sfxLastTick[name] || -9999)) < cd) return false;
  _sfxLastTick[name] = now;
  return true;
}
function playSfx(name, opts = {}) {
  if (!_sfxAllowed(name)) return;
  if (!AUDIO.enabled || !AUDIO.unlocked) return;
  audioInit();
  if (!AUDIO.ctx) return;
  const ctx = AUDIO.ctx;
  const presets = {
    // Phase 64 — bump every non-kill cue ~25% (user '其他的声音太小'). Hit
    // / reload / whiz / crack were getting drowned out by the death thump
    // and crackle. Tonal balance unchanged, just louder.
    hit:          { freq:  220, dur: 0.10, decay: 14, type: 'lowpass',  vol: 0.55, sweepTo: 80   },
    // Phase 56 → 64 — death cue softened progressively (0.85 → 0.45 → 0.32).
    // User keeps reporting kill audio as dominant; the explosion VFX + damage
    // popup carry the moment, audio should accent not announce. Same low
    // thump, just further behind the rest of the mix.
    death:        { freq:  140, dur: 0.55, decay:  4, type: 'lowpass',  vol: 0.32, sweepTo: 50   },
    // Phase 64 — kill cue lowered (0.18 → 0.08) + freq dropped from 1800
    // bandpass to 600 lowpass-ish (still bandpass for shape) so it reads
    // as 'scatter' not 'ding'. User: '擊殺的那個叮咚的聲音讓我感覺很奇怪'.
    kill_crackle: { freq:  600, dur: 0.06, decay: 30, type: 'bandpass', vol: 0.08, q: 2  },
    respawn:      { freq:  440, dur: 0.25, decay:  9, type: 'bandpass', vol: 0.50, sweepTo: 1320, q: 4 },
    reload:       { freq: 2400, dur: 0.06, decay: 30, type: 'bandpass', vol: 0.42, q: 6 },
    whiz:         { freq: 4500, dur: 0.06, decay: 35, type: 'bandpass', vol: 0.44, q: 12 },
    // Supersonic crack — sharp transient layered on top of whiz when a fast
    // round (sniper / rifle) passes very close. Gives the "snap" you hear
    // when a round breaks the sound barrier near your head.
    crack:        { freq: 5800, dur: 0.04, decay: 50, type: 'bandpass', vol: 0.46, q: 18 },
    countdown:    { freq:  660, dur: 0.10, decay: 22, type: 'bandpass', vol: 0.40, q: 8 },
    // New presets
    // kill_confirm: REMOVED on user request ('擊殺音效還在!!!把那個叮咚
    // 鈴聲移除!!!'). Tried bandpass-noise sweep, then sine sweep at lower
    // volume — both rejected. Kill feedback now comes purely from the
    // explosion VFX + damage popup. If a kill audio cue is ever needed
    // again, do NOT use the kill_confirm preset name (it's been burnt) —
    // start clean and run it past the user before wiring callsites.
    empty_click:  { freq: 3200, dur: 0.04, decay: 50, type: 'bandpass', vol: 0.28, q: 10 },                 // dry click
    lowhp:        { freq:  120, dur: 0.16, decay:  6, type: 'lowpass',  vol: 0.35, sweepTo: 60   },         // heartbeat thump
    match_start:  { freq:  330, dur: 0.30, decay:  5, type: 'bandpass', vol: 0.55, sweepTo: 990,  q: 3 },   // long up-tone "begin"
    match_win:    { freq:  523, dur: 0.45, decay:  4, type: 'bandpass', vol: 0.65, sweepTo: 1568, q: 3 },   // bright C-G triumph
    match_loss:   { freq:  392, dur: 0.55, decay:  3, type: 'lowpass',  vol: 0.60, sweepTo: 130          },  // descending "down"
  };
  const p = presets[name];
  if (!p) return;
  const vol = (opts.vol != null ? opts.vol : p.vol);
  const pan = opts.pan || 0;
  const freq = (opts.freq != null ? opts.freq : p.freq);

  const dur = p.dur;
  const buf = ctx.createBuffer(1, Math.max(64, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Two render modes:
  //   wave: 'sine' → clean tonal sine sweep (reserved for future chimes)
  //   default      → white noise + bandpass/lowpass filter for hits/clicks
  // The biquad still post-processes both — for sine that adds a soft
  // pre-delay roll-off, which actually rounds the attack nicely.
  if (p.wave === 'sine') {
    const sr = ctx.sampleRate;
    const freqStart = freq;
    const freqEnd = p.sweepTo || freq;
    let phase = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length;
      const env = Math.exp(-t * p.decay);
      // Linear freq sweep across the buffer
      const f = freqStart + (freqEnd - freqStart) * t;
      phase += (2 * Math.PI * f) / sr;
      data[i] = Math.sin(phase) * env;
    }
  } else {
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length;
      const env = Math.exp(-t * p.decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = p.type;
  filt.frequency.value = freq;
  if (p.q) filt.Q.value = p.q;
  if (p.sweepTo) {
    filt.frequency.linearRampToValueAtTime(p.sweepTo, ctx.currentTime + dur * 0.9);
  }
  const gain = ctx.createGain();
  gain.gain.value = vol;
  let chain = src.connect(filt);
  if (ctx.createStereoPanner && pan !== 0) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    chain = chain.connect(panner);
  }
  chain.connect(gain).connect(AUDIO.master);
  src.start();
}

// Sound events for directional indicators + enemy alerts + squad intel +
// positional audio. Gunshots are LOUD (1300-1500u) so most of the map is
// within earshot.
const soundEvents = [];
function emitSound(x, y, intensity, fromPlayer, isPlayerSelf = false, profile = null, audioKind = null) {
  soundEvents.push({ x, y, intensity, fromPlayer, isPlayerSelf, life: 80, maxLife: 80 });
  // Phase 111 — explicit audioKind override. When the caller knows what
  // kind of sound it really is (a 'boom' explosion vs a 'shot' gunshot),
  // pass it here and the dispatcher routes to the right synthesis path
  // instead of the auto-by-intensity heuristic. Default still inferred.
  if (audioKind === 'boom') {
    playPositionalSound(x, y, intensity, 'boom', isPlayerSelf, profile);
  } else if (audioKind === 'crackle') {
    playPositionalSound(x, y, intensity, 'crackle', isPlayerSelf, profile);
  } else if (audioKind === 'silent') {
    // alerts-only, no audio (caller plays its own)
  } else if (intensity >= 1000) {
    playPositionalSound(x, y, intensity, 'shot', isPlayerSelf, profile);
  } else {
    // Throttled drone buzz — at most once per 12 frames per drone (rate limit globally)
    if ((emitSound._buzzCt = (emitSound._buzzCt || 0) + 1) % 12 === 0) {
      playPositionalSound(x, y, intensity, 'buzz', false);
    }
  }
  // Alert nearby enemies (turn toward sound; investigate)
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = Math.hypot(x - e.x, y - e.y);
    if (d < intensity) {
      const lvl = 1 - d / intensity;
      e.alerted = Math.max(e.alerted || 0, 120 + lvl * 120);
      e.alertX = x; e.alertY = y;
    }
  }
  // Hostile gunshot becomes squad intel — every friendly within earshot now knows
  // approximately where the shot came from. Sight beats sound, so only set intel
  // if it's currently weaker than what sound would give.
  if (!fromPlayer) {
    const inEar = (player.alive && Math.hypot(x - player.x, y - player.y) < intensity)
                || allies.some(a => a.alive && Math.hypot(x - a.x, y - a.y) < intensity);
    if (inEar && squadIntel.source !== 'sight') {
      squadIntel.x = x; squadIntel.y = y;
      squadIntel.fresh = SQUAD_INTEL_FRESH_FRAMES;
      squadIntel.source = 'sound';
      squadIntel.bornAt = game.time;
    }
  }
}
