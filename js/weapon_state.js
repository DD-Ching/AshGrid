// ============ WEAPON STATE MACHINE (R3 refactor) ============
// Single owner of every weapon-state write on `player`:
//   • playerWeapon  (current equipped weapon ref)
//   • player.maxAmmo / ammo / reserve     (magazine + reserve)
//   • player.reloading / reloadTime        (reload progress)
//   • player.fireCooldown                  (RoF gate)
//
// Before R3 these were mutated from ≥ 6 places (fire() inline,
// tickPlayerCombat inline, updatePlayerAux inline, applyWeaponToPlayer,
// swapPlayerWeapon, startReload). Phase 110c → 111c shipped two
// different fixes for the same trigger-edge bug because nothing owned
// the transitions. After R3, every transition goes through a named
// method here and the cross-cutting concerns (RoF gate, reload tick,
// auto-reload) live in one place. Phase 140 removed the swap path
// (manual weapon switching) entirely — see the Swap section below.
//
// External deps (resolved at call-time via globals):
//   player          — declared in index.html
//   playerWeapon    — declared in js/weapons.js (mutable let)
//   WEAPONS         — static weapon table in js/weapons.js
//   playSfx         — declared in js/audio/sfx.js
//
// Public API (window.WeaponState):
//
//   Lifecycle ────────────────────────────────────────────────────
//     equip(w)                  Apply weapon w. Sets magSize / ammo
//                               / reserve / clears reload. ALSO
//                               refills grenades + stamina (legacy
//                               applyWeaponToPlayer contract — match
//                               start / respawn refresh).
//     beginReload()             Start reload sequence if eligible.
//
//   Per-frame ────────────────────────────────────────────────────
//     tickPerFrame()            Decrements fireCooldown + reloadTime,
//                               completes reload + refills magazine
//                               when timer expires. Auto-reload kicks
//                               in when ammo hits 0 with reserve > 0.
//                               Call ONCE per frame BEFORE tickPlayer-
//                               Combat (so the fire check sees fresh
//                               fireCooldown).
//
//   Fire-time ───────────────────────────────────────────────────
//     canFire(w, triggerOK)     Predicate: triggerOK + cd ≤ 0 + ammo
//                               > 0 + !reloading + alive + !invuln.
//                               Caller passes the trigger edge (auto
//                               vs semi-auto) it already computed.
//     consumeShot(w)            Apply post-fire state: ammo-- and
//                               fireCooldown = w.fireCd. Called by
//                               the inline fire() in index.html
//                               after it spawns bullets.

(function() {
  'use strict';

  function _player()    { return (typeof player !== 'undefined') ? player : null; }
  function _curWeapon() { return (typeof playerWeapon !== 'undefined') ? playerWeapon : null; }
  function _setPlayerWeapon(w) {
    // `playerWeapon` is a `let` declared in js/weapons.js. weapons.js
    // exposes `window.__setPlayerWeapon` as a thin setter shim so we
    // can mutate the let from this module.
    if (typeof window.__setPlayerWeapon === 'function') {
      window.__setPlayerWeapon(w);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────
  function equip(w) {
    if (!w) return;
    const p = _player();
    if (!p) return;
    _setPlayerWeapon(w);
    p.maxAmmo     = w.magSize;
    p.ammo        = w.magSize;
    p.reserve     = w.reserveStart;
    p.reloading   = false;
    p.reloadTime  = 0;
    p.fireCooldown = 0;
    // Legacy applyWeaponToPlayer contract: refill grenades + stamina
    // on every equip (called at match start, respawn, weapon swap).
    if (typeof p.maxGrenades === 'number')  p.grenades = p.maxGrenades;
    if (typeof p.maxStamina === 'number')   p.stamina  = p.maxStamina;
    p._spentToZero = false;
  }

  function beginReload() {
    const p = _player();
    const w = _curWeapon();
    if (!p || !w) return;
    if (p.reloading || p.ammo >= p.maxAmmo || p.reserve <= 0) return;
    p.reloading  = true;
    p.reloadTime = w.reloadFrames || 80;
    if (typeof playSfx === 'function') playSfx('reload');
  }

  // ─── Per-frame ──────────────────────────────────────────────────
  function tickPerFrame() {
    const p = _player();
    if (!p) return;
    if (typeof p.fireCooldown === 'number' && p.fireCooldown > 0) {
      p.fireCooldown--;
    }
    // Auto-reload: dry mag with reserve → start reload
    if (p.ammo === 0 && p.reserve > 0 && !p.reloading) {
      beginReload();
    }
    if (p.reloading) {
      p.reloadTime--;
      if (p.reloadTime <= 0) {
        const need = p.maxAmmo - p.ammo;
        const take = Math.min(need, p.reserve);
        p.ammo    += take;
        p.reserve -= take;
        p.reloading = false;
      }
    }
  }

  // ─── Fire-time ──────────────────────────────────────────────────
  function canFire(w, triggerOK) {
    const p = _player();
    if (!p || !w) return false;
    if (!triggerOK) return false;
    if (p.fireCooldown > 0) return false;
    if (p.ammo <= 0) return false;
    if (p.reloading) return false;
    if (!p.alive) return false;
    const pInvuln = p._invulnUntil != null
                  && typeof game !== 'undefined'
                  && game.time < p._invulnUntil;
    // opt R3 — let the player FIRE during their spawn shield in SOLO so a 3s shield
    // is a head-start, not 3s of helplessness (break a spawn-camp). MP keeps the
    // mute (no shoot-while-invuln exploit, server-authoritative).
    const _mpMute = (typeof _mpIsActive === 'function' && _mpIsActive());
    if (pInvuln && _mpMute) return false;
    return true;
  }

  function consumeShot(w) {
    const p = _player();
    if (!p || !w) return;
    p.ammo--;
    p.fireCooldown = w.fireCd;
  }

  // ─── Swap ───────────────────────────────────────────────────────
  // Phase 140 — REMOVED. Manual mid-match weapon switching is gone (one
  // pawn = one weapon). You change weapon by walking onto a killed enemy's
  // dropped gun, which equips via equip() above — see js/weapon_drop.js.
  // The old stash (_weaponSlots) + HUD pulse flag (_weaponSwapUntil) went
  // with it; nothing else read them.

  window.WeaponState = {
    equip,
    beginReload,
    tickPerFrame,
    canFire,
    consumeShot,
  };
})();
