// ============ WEAPONS ============
// Player + NN selectable weapons. Each profile defines ballistics, recoil
// pattern, audio profile, and per-frame sway. Adding a weapon = adding a
// row to WEAPONS. Lobby drop-down + chassis logic discover them by key.
//
// Classic-script. Declares globally:
//   WEAPONS (table — RIFLE / SMG / LMG / SNIPER / SHOTGUN / ROCKET / AK
//            + the AR7 backward-compat alias)
//   playerWeapon (let — currently-selected player weapon, mutable)
//
// External deps: T (label helper, called at render time so available)

// All shooters use the same lag/sway/recoil mechanic — they just pick a weapon profile.
// follow: how fast the gun barrel angle damps toward the target angle (1=instant, 0.05=sluggish)
// swayAmp: idle weapon sway amplitude (radians)
// movePenalty: extra sway while moving
// recoilPerShot: rad kick added to gunRecoil each shot
// recoilDecay: recoil decay multiplier per frame
// spread: per-bullet random angle (radians)
// fireCd: frames between shots
// damage / bulletSpeed / bulletLife: ballistics
// soundIntensity: how far the gunshot reaches as an alert
const WEAPONS = {
  // Player-selectable weapons, each with clear trade-offs. Stats:
  //  fireCd       frames between shots (8 = ~7.5 rounds/sec at 60fps)
  //  damage       hp loss per hit (player.maxHp = 100)
  //  bulletSpeed  travel per frame; range = bulletSpeed × bulletLife
  //  bulletLife   how many frames the bullet lives before dissipating
  //  spread       random aim noise per shot (rad)
  //  magSize      shots per mag
  //  reserveStart starting reserve ammo
  //  speedMul     player movement multiplier (heavy gun → slower)
  //  auto         true = full-auto, false = semi-auto (one shot per click)
  //  reloadFrames frames to reload (default 80 = 1.33s)
  //  follow / swayAmp / recoilPerShot etc. — barrel handling for tickShooter
  // All damages tuned for fast lethality (player.maxHp = 100). Easy to bump
  // individual numbers — each weapon's `damage` is a single dial.
  SMG:    { name: 'SMG / 冲锋枪', follow: 0.22, swayAmp: 0.040, swayFreq: 0.08, movePenalty: 0.030,
            recoilPerShot: 0.07, recoilDecay: 0.88, spread: 0.10,
            fireCd: 4,  damage: 14, bulletSpeed: 13, bulletLife: 42, soundIntensity: 1200,
            magSize: 30, reserveStart: 180, speedMul: 1.10, auto: true,  reloadFrames: 60,
            soundProfile: { peakFreq: 950, decay: 16, bassFreq: 0,   bassDur: 0,    volMul: 0.80 },
            blurb: '高射速·近战' },
  RIFLE:  { name: 'AR / 步枪',  follow: 0.18, swayAmp: 0.024, swayFreq: 0.06, movePenalty: 0.018,
            recoilPerShot: 0.10, recoilDecay: 0.86, spread: 0.04,
            fireCd: 8,  damage: 22, bulletSpeed: 14, bulletLife: 60, soundIntensity: 1500,
            magSize: 30, reserveStart: 120, speedMul: 1.00, auto: true,  reloadFrames: 80,
            soundProfile: { peakFreq: 620, decay: 10, bassFreq: 110, bassDur: 0.06, volMul: 1.00 },
            blurb: '平衡·全能' },
  LMG:    { name: 'LMG / 机枪',  follow: 0.10, swayAmp: 0.034, swayFreq: 0.05, movePenalty: 0.026,
            recoilPerShot: 0.13, recoilDecay: 0.84, spread: 0.07,
            fireCd: 6,  damage: 20, bulletSpeed: 14, bulletLife: 70, soundIntensity: 1600,
            magSize: 75, reserveStart: 150, speedMul: 0.85, auto: true,  reloadFrames: 140,
            soundProfile: { peakFreq: 510, decay: 8,  bassFreq: 95,  bassDur: 0.08, volMul: 1.15 },
            blurb: '持续压制·重' },
  SNIPER: { name: 'DMR / 狙击', follow: 0.30, swayAmp: 0.018, swayFreq: 0.04, movePenalty: 0.014,
            recoilPerShot: 0.30, recoilDecay: 0.78, spread: 0.005,
            fireCd: 50, damage: 100, bulletSpeed: 22, bulletLife: 100, soundIntensity: 1800,
            magSize: 5,  reserveStart: 30,  speedMul: 0.90, auto: false, reloadFrames: 100,
            soundProfile: { peakFreq: 320, decay: 4,  bassFreq: 70,  bassDur: 0.20, volMul: 1.40 },
            blurb: '一枪秒·单发' },
  SHOTGUN:{ name: 'SG / 霰弹', follow: 0.16, swayAmp: 0.028, swayFreq: 0.07, movePenalty: 0.022,
            recoilPerShot: 0.40, recoilDecay: 0.78, spread: 0.22,
            fireCd: 30, damage: 18, bulletSpeed: 16, bulletLife: 38, soundIntensity: 1600,
            magSize: 8,  reserveStart: 40,  speedMul: 0.95, auto: false, reloadFrames: 110,
            pellets: 11,
            soundProfile: { peakFreq: 410, decay: 7,  bassFreq: 80,  bassDur: 0.11, volMul: 1.30 },
            blurb: '近战毁灭·散布' },
  // ROCKET LAUNCHER — slow projectile, big AOE on impact, 2× structure dmg.
  // Direct hit on a unit: 80 dmg to the target + 60 AOE dmg in 110u radius.
  // Structure damage: 4× the projectile's listed `damage` so it can punch
  // through walls (200 hp) in 2 hits. Tiny mag, slow reload — high impact
  // ammo that has to count.
  ROCKET: { name: 'RPG / 火箭炮', follow: 0.20, swayAmp: 0.026, swayFreq: 0.05, movePenalty: 0.020,
            recoilPerShot: 0.55, recoilDecay: 0.74, spread: 0.012,
            fireCd: 60, damage: 80, bulletSpeed: 11, bulletLife: 80, soundIntensity: 1900,
            magSize: 2, reserveStart: 6, speedMul: 0.88, auto: false, reloadFrames: 160,
            isRocket: true, blastR: 110, blastDmg: 60, structDmgMul: 4,
            soundProfile: { peakFreq: 220, decay: 5, bassFreq: 60, bassDur: 0.30, volMul: 1.55 },
            blurb: '爆破·破坏建筑' },

  // Allies (campaign) — kept separate so balancing AI doesn't bleed into player picks
  M4:  { follow: 0.14, swayAmp: 0.030, swayFreq: 0.07, movePenalty: 0.022,
         recoilPerShot: 0.09, recoilDecay: 0.87, spread: 0.06,
         fireCd: 14, damage: 16, bulletSpeed: 13, bulletLife: 60, soundIntensity: 1400,
         soundProfile: { peakFreq: 660, decay: 11, bassFreq: 105, bassDur: 0.05, volMul: 0.92 } },
  AK:  { follow: 0.10, swayAmp: 0.034, swayFreq: 0.05, movePenalty: 0.026,
         recoilPerShot: 0.12, recoilDecay: 0.85, spread: 0.09,
         fireCd: 16, damage: 14, bulletSpeed: 11, bulletLife: 70, soundIntensity: 1300,
         soundProfile: { peakFreq: 480, decay: 9,  bassFreq: 90,  bassDur: 0.07, volMul: 1.00 } },

  // Backward-compat alias — old code paths reference WEAPONS.AR7.
  // Points at RIFLE so AR7 references stay valid until everything migrates.
  get AR7() { return this.RIFLE; },
};

// Currently-selected player weapon (mutable). Default RIFLE = balanced baseline.
let playerWeapon = WEAPONS.RIFLE;

// R3 — expose a setter so js/weapon_state.js (which owns weapon state
// mutations) can assign through to this `let`. JavaScript hoisting +
// classic-script semantics mean a closure-free module can't reach in
// to set `playerWeapon` directly; this thin shim is how.
window.__setPlayerWeapon = function(w) { playerWeapon = w; };

// ---- Weapon helpers (apply / swap / NN pool / tick) ----
// R3: applyWeaponToPlayer + swapPlayerWeapon now delegate to
// window.WeaponState (js/weapon_state.js). These wrappers stay so the
// existing callsites (pawn_swap.js, mission factories, key bindings)
// don't need to change.
function applyWeaponToPlayer(w) {
  if (window.WeaponState && WeaponState.equip) {
    WeaponState.equip(w);
    return;
  }
  // Fallback for the edge case where weapon_state.js failed to load.
  playerWeapon = w;
  player.maxAmmo = w.magSize;
  player.ammo = w.magSize;
  player.reserve = w.reserveStart;
  player.reloading = false;
  player.reloadTime = 0;
  player.grenades = player.maxGrenades;
  player.stamina = player.maxStamina;
  player._spentToZero = false;
}

// Mid-match weapon swap (X key). Logic owned by js/weapon_state.js —
// see that file's `swap()` for the full contract (stash + pick other
// slot or random NN pool weapon + reset trigger edge + toast).
function swapPlayerWeapon() {
  if (window.WeaponState && WeaponState.swap) {
    WeaponState.swap();
  }
}

// Weapons NN units can spawn with. Same trade-offs as player picks.
const NN_WEAPON_POOL = ['SMG', 'RIFLE', 'LMG', 'SNIPER', 'SHOTGUN'];
function pickRandomNNWeaponId() {
  return NN_WEAPON_POOL[Math.floor(Math.random() * NN_WEAPON_POOL.length)];
}

// Backward-compat shim — code that still reads `weapon` gets the player profile
const weapon = WEAPONS.AR7;

// Drive any shooter's gunAngle: damps toward `target`, adds idle sway, decays recoil.
// Returns the *effective* barrel angle (gunAngle + recoil) for firing this frame.
function tickShooter(s, target, w, isMoving) {
  if (s.gunAngle == null) s.gunAngle = target;
  if (s.gunRecoil == null) s.gunRecoil = 0;
  if (s.swayPhase == null) s.swayPhase = Math.random() * Math.PI*2;
  let d = target - s.gunAngle;
  while (d > Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  s.gunAngle += d * w.follow;
  const swayAmp = w.swayAmp + (isMoving ? w.movePenalty : 0);
  s.swayPhase += w.swayFreq;
  s.gunAngle += Math.sin(s.swayPhase) * swayAmp * 0.18;
  s.gunRecoil *= w.recoilDecay;
  if (Math.abs(s.gunRecoil) < 0.001) s.gunRecoil = 0;
  return s.gunAngle + s.gunRecoil;
}
