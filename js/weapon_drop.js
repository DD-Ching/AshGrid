// ============ WEAPON DROP + PICKUP (Phase 140) ============
// Replaces manual mid-match weapon switching (the old X-swap). The new rule
// the user asked for: ONE pawn = ONE weapon. You don't toggle between two
// stashed guns any more — instead, when an enemy is KILLED its weapon drops
// on the ground, and you change weapon by WALKING onto the drop and HOLDING
// position until a capture-style ring fills.
//
//   kill enemy → weapon drops at the body → stand on it ~1.5s → equip it
//
// ── Why a frame-scan instead of hooking the kill sites ──────────────────
// Enemy death is set in ~10 scattered places (bullets.js, structures.js,
// grenades.js, index.html) with no single chokepoint. Rather than edit all
// of them (several are R5/bullets + structures hot spots), this module scans
// `enemies` each frame:
//   • A KILLED enemy stays in `enemies` with alive=false (it respawns later)
//     → we see it, drop once, and flag it (_weaponDropped).
//   • A RECRUITED enemy is spliced OUT of `enemies` while still alive=true
//     (see arena_recruitment._arenaConvertEnemyToAlly) → it never trips the
//     drop. Good: recruiting someone shouldn't litter their gun.
//   • A KO-STUNNED enemy (recruit target) is alive=true + _koStunned → also
//     skipped until it's actually killed.
// On respawn (alive flips back true) we clear _weaponDropped so the next
// death drops again.
//
// Classic-script. Declares globally:
//   GROUND_WEAPONS · updateWeaponDrops() · renderWeaponDrops()
// External deps (resolved at call-time): game · player · enemies ·
//   playerWeapon · applyWeaponToPlayer · WeaponState · ctx · COLORS · T ·
//   showSwapToast · playSfx
// Wired in index.html: updateWeaponDrops() after updateBullets(),
//   renderWeaponDrops() inside the world transform after renderAutoDrones().

const GROUND_WEAPONS = [];             // { x, y, weapon, life }
const WEAPON_DROP_LIFE     = 30 * 60;  // 30s on the ground before it fades
const WEAPON_DROP_FADE     = 3 * 60;   // last 3s fades out
const WEAPON_PICKUP_R      = 28;       // stand-within distance to charge a swap
const WEAPON_PICKUP_TICKS  = 90;       // ~1.5s hold to complete the swap
const WEAPON_DROP_MAX      = 40;       // hard cap so a long match can't pile up

// Module-scoped pickup progress — only ONE drop charges at a time (the
// nearest in range). Moving off it (target changes) resets the ring.
let _wpPickupTarget = null;
let _wpPickupProgress = 0;

// The player's currently-equipped weapon object (for the "don't bother
// swapping to the same gun" check). playerWeapon is a global `let` in
// weapons.js; guard in case of load-order surprises.
function _wpCurrentWeapon() {
  if (typeof playerWeapon !== 'undefined' && playerWeapon) return playerWeapon;
  return (typeof player !== 'undefined' && player) ? player._weapon : null;
}

function _spawnGroundWeapon(x, y, weapon) {
  if (!weapon) return;
  if (GROUND_WEAPONS.length >= WEAPON_DROP_MAX) GROUND_WEAPONS.shift(); // drop oldest
  GROUND_WEAPONS.push({ x, y, weapon, life: WEAPON_DROP_LIFE });
}

function updateWeaponDrops() {
  // ── 1. Detect fresh kills → drop the dead enemy's weapon ──────────────
  if (typeof enemies !== 'undefined' && Array.isArray(enemies)) {
    for (const e of enemies) {
      if (!e) continue;
      if (e.alive) { e._weaponDropped = false; continue; }   // (re)spawned → re-arm
      if (e._weaponDropped) continue;                         // already dropped this death
      if (e._koStunned) continue;                             // recruit target, not a kill
      if (e._weapon) _spawnGroundWeapon(e.x, e.y, e._weapon);
      e._weaponDropped = true;                                // even with no weapon, don't re-check
    }
  }

  // ── 2. Age out old drops ──────────────────────────────────────────────
  for (let i = GROUND_WEAPONS.length - 1; i >= 0; i--) {
    if (--GROUND_WEAPONS[i].life <= 0) {
      if (GROUND_WEAPONS[i] === _wpPickupTarget) { _wpPickupTarget = null; _wpPickupProgress = 0; }
      GROUND_WEAPONS.splice(i, 1);
    }
  }

  // ── 3. Hold-to-pickup ─────────────────────────────────────────────────
  if (typeof player === 'undefined' || !player || !player.alive) {
    _wpPickupTarget = null; _wpPickupProgress = 0; return;
  }
  const cur = _wpCurrentWeapon();
  let near = null, nearD = WEAPON_PICKUP_R;
  for (const g of GROUND_WEAPONS) {
    if (g.weapon === cur) continue;                 // same gun — no point swapping
    const d = Math.hypot(g.x - player.x, g.y - player.y);
    if (d <= nearD) { near = g; nearD = d; }
  }
  if (!near) { _wpPickupTarget = null; _wpPickupProgress = 0; return; }

  if (near !== _wpPickupTarget) { _wpPickupTarget = near; _wpPickupProgress = 0; }
  _wpPickupProgress++;

  if (_wpPickupProgress >= WEAPON_PICKUP_TICKS) {
    // Equip via the canonical entry (delegates to WeaponState.equip, with a
    // built-in fallback if weapon_state.js didn't load).
    if (typeof applyWeaponToPlayer === 'function') applyWeaponToPlayer(near.weapon);
    else if (window.WeaponState && WeaponState.equip) WeaponState.equip(near.weapon);
    const idx = GROUND_WEAPONS.indexOf(near);
    if (idx >= 0) GROUND_WEAPONS.splice(idx, 1);
    _wpPickupTarget = null; _wpPickupProgress = 0;
    const nm = (near.weapon && near.weapon.name) ? near.weapon.name : '';
    if (typeof showSwapToast === 'function') {
      showSwapToast((typeof T === 'function')
        ? T('▸ 拾取武器 · ' + nm, '▸ PICKED UP · ' + nm)
        : ('▸ PICKED UP · ' + nm));
    }
    if (typeof playSfx === 'function') playSfx('reload', { vol: 0.5 });
  }
}

// World-space draw — called inside renderWorld()'s camera transform, so we
// draw at raw world coords. A small ammo-crate pip with the weapon's initial,
// plus the capture ring on whichever drop is currently charging.
function renderWeaponDrops() {
  if (!GROUND_WEAPONS.length || typeof ctx === 'undefined') return;
  const cream = (typeof COLORS !== 'undefined') ? COLORS.cream : '#EDE6D6';
  const red   = (typeof COLORS !== 'undefined') ? COLORS.red   : '#C8261C';
  for (const g of GROUND_WEAPONS) {
    const a = g.life < WEAPON_DROP_FADE ? Math.max(0, g.life / WEAPON_DROP_FADE) : 1;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(g.x, g.y);
    // Crate body.
    ctx.fillStyle = 'rgba(20, 18, 24, 0.85)';
    ctx.fillRect(-12, -8, 24, 16);
    ctx.strokeStyle = cream;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-12, -8, 24, 16);
    // Weapon initial (first char of the localized name, else '?').
    const nm = (g.weapon && g.weapon.name) ? g.weapon.name : '?';
    ctx.fillStyle = '#FFD24A';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(nm.charAt(0).toUpperCase(), 0, 4);
    ctx.textAlign = 'left';
    // Capture ring — only on the drop currently being picked up.
    if (g === _wpPickupTarget && _wpPickupProgress > 0) {
      const frac = Math.min(1, _wpPickupProgress / WEAPON_PICKUP_TICKS);
      ctx.globalAlpha = a;
      ctx.strokeStyle = red;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 18, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}
