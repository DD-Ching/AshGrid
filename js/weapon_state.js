// ============ WEAPON STATE MACHINE (R3 refactor) ============
// Single owner of every weapon-state write on `player`:
//   • playerWeapon  (current equipped weapon ref)
//   • player.maxAmmo / ammo / reserve     (magazine + reserve)
//   • player.reloading / reloadTime        (reload progress)
//   • player.fireCooldown                  (RoF gate)
//   • player._weaponSwapUntil              (HUD anim flag)
//   • player._weaponSlots                  (stash for X-swap)
//
// Before R3 these were mutated from ≥ 6 places (fire() inline,
// tickPlayerCombat inline, updatePlayerAux inline, applyWeaponToPlayer,
// swapPlayerWeapon, startReload). Phase 110c → 111c shipped two
// different fixes for the same trigger-edge bug because nothing owned
// the transitions. After R3, every transition goes through a named
// method here and the cross-cutting concerns (RoF gate, reload tick,
// auto-reload, swap edge) live in one place.
//
// External deps (resolved at call-time via globals):
//   player          — declared in index.html
//   playerWeapon    — declared in js/weapons.js (mutable let)
//   WEAPONS         — static weapon table in js/weapons.js
//   NN_WEAPON_POOL  — pool used by swap to pick a different weapon
//   Input           — js/input.js (R2). Used by swap to reset trigger
//                     edge so the new weapon's first shot lands cleanly.
//   playSfx         — declared in js/audio/sfx.js
//   showSwapToast   — declared in pawn_swap.js
//   T               — i18n helper in index.html
//   getLang         — i18n helper
//   playRadioBeep   — audio helper
//
// Public API (window.WeaponState):
//
//   Lifecycle ────────────────────────────────────────────────────
//     equip(w)                  Apply weapon w. Sets magSize / ammo
//                               / reserve / clears reload. ALSO
//                               refills grenades + stamina (legacy
//                               applyWeaponToPlayer contract — match
//                               start / respawn refresh).
//     swap()                    Toggle to the other slot, picking a
//                               random NN_WEAPON_POOL weapon on the
//                               first swap. Resets fire trigger edge
//                               via Input.resetTriggerEdge().
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
    if (pInvuln) return false;
    return true;
  }

  function consumeShot(w) {
    const p = _player();
    if (!p || !w) return;
    p.ammo--;
    p.fireCooldown = w.fireCd;
  }

  // ─── Swap ───────────────────────────────────────────────────────
  // Reproduces the legacy swapPlayerWeapon contract:
  //   • Stash current weapon's ammo into player._weaponSlots[curKey]
  //   • Pick the OTHER slot. If only one weapon stashed, roll a random
  //     NN_WEAPON_POOL weapon that ISN'T the current one.
  //   • equip() the next weapon, restoring its stashed ammo.
  //   • Set _weaponSwapUntil for the HUD pulse animation.
  //   • Reset trigger edge so semi-auto fires once on the held trigger
  //     (Phase 111c contract — auto guns keep firing across swap).
  //   • Toast + radio beep.
  function swap() {
    const p = _player();
    const cur = _curWeapon();
    if (!p || !cur) return;
    if (typeof game === 'undefined' || game.state !== 'playing' || game._paused) return;
    if (p.reloading) return;                                  // can't swap mid-reload
    const curKey = cur.name || cur.blurb || 'cur';
    p._weaponSlots = p._weaponSlots || {};
    p._weaponSlots[curKey] = {
      weapon: cur,
      ammo: p.ammo,
      reserve: p.reserve,
    };
    let next = null;
    for (const k of Object.keys(p._weaponSlots)) {
      if (k !== curKey) { next = p._weaponSlots[k]; break; }
    }
    if (!next || (next.weapon && (next.weapon.name || next.weapon.blurb) === curKey)) {
      // No other slot stashed — roll a random different weapon.
      if (typeof NN_WEAPON_POOL === 'undefined' || typeof WEAPONS === 'undefined') return;
      const others = NN_WEAPON_POOL.filter(id => {
        const w = WEAPONS[id];
        return w && (w.name || w.blurb) !== curKey;
      });
      const pickId = others[Math.floor(Math.random() * others.length)] || 'SMG';
      const pickW  = WEAPONS[pickId] || WEAPONS.SMG;
      next = { weapon: pickW, ammo: pickW.magSize, reserve: pickW.reserveStart };
    }
    equip(next.weapon);
    p.ammo    = next.ammo;
    p.reserve = next.reserve;
    if (game && game.time != null) p._weaponSwapUntil = game.time + 9;
    // R2 — reset trigger edge so the held mouse counts as a fresh
    // rising edge for semi-auto. mouse.down stays so auto guns keep
    // firing without a re-click.
    if (typeof Input !== 'undefined' && Input.resetTriggerEdge) {
      Input.resetTriggerEdge();
    } else if (typeof mouse !== 'undefined') {
      mouse._wasDown = false;
    }
    p.fireCooldown = 0;
    if (typeof showSwapToast === 'function') {
      const lang = (typeof getLang === 'function' && getLang() === 'zh') ? 'zh' : 'en';
      const wname = next.weapon.name || (lang === 'zh' ? '副武器' : 'SECONDARY');
      showSwapToast(`${lang === 'zh' ? '切換 ▶ ' : 'SWITCH ▶ '}${wname}`);
    }
    if (typeof playRadioBeep === 'function') playRadioBeep(620, 0.1);
  }

  window.WeaponState = {
    equip,
    beginReload,
    tickPerFrame,
    canFire,
    consumeShot,
    swap,
  };
})();
