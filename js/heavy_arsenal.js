// ============ HEAVY ARSENAL (Phase 184d) — chassis-class "Heavy" abilities ====
// The Heavy chassis is the ARSENAL class (CHASSIS_CLASSES_DESIGN.md). Unlike the
// "one pawn = one weapon" rule for humanoid/wolf, Heavy STOCKPILES weapons it
// picks up (cap 3), cycles the active one with R, and its ULTIMATE (X) fires ALL
// stockpiled weapons at once ("把累積的所有武器全部都開") for an energy cost.
// (FPV-loot-on-kill lives in bullets.js at the kill site.)
//
// ALL flag-gated behind game._classes (OFF by default → no live effect; test with
// game._classes=true) AND heavy-only, so the normal single-weapon flow is
// untouched for other chassis / when off. SOLO-first; MP needs server-chassis
// (184e). Classic-script globals: heavyPickupWeapon · heavyCycleWeapon ·
// heavyUltimate · heavyMaxWeapons. Deps (call-time): game · player · playerWeapon
// · applyWeaponToPlayer · bullets · muzzleFlashes · BALANCE · triggerShake ·
// emitSound · showSwapToast · T · _mpIsActive.

(function () {
  'use strict';
  const MAX = 3;                 // stockpile cap (the "3 把來回切換")
  window.heavyMaxWeapons = MAX;

  function _on() {
    return typeof game !== 'undefined' && game && game._classes
        && typeof player !== 'undefined' && player && player._chassis === 'heavy';
  }
  // Ensure the currently-equipped weapon is in the stockpile (seed on first use).
  function _seed() {
    if (typeof player === 'undefined' || !player) return;
    player._weapons = player._weapons || [];
    const cur = (typeof playerWeapon !== 'undefined') ? playerWeapon : null;
    if (cur && player._weapons.indexOf(cur) < 0) player._weapons.unshift(cur);
    if (player._weapons.length > MAX) player._weapons.length = MAX;
  }

  // Pickup: ADD to the stockpile (cap MAX, drop oldest) + equip the new gun.
  // Returns true if it handled the pickup (caller skips the normal replace).
  window.heavyPickupWeapon = function (w) {
    if (!_on() || !w) return false;
    _seed();
    if (typeof applyWeaponToPlayer === 'function') applyWeaponToPlayer(w);
    if (player._weapons.indexOf(w) < 0) {
      player._weapons.push(w);
      while (player._weapons.length > MAX) player._weapons.shift();
    }
    return true;
  };

  // R: cycle the active weapon among the stockpile. Returns false when not
  // applicable (not heavy / classes off / <2 weapons) so the caller falls back
  // to reload.
  window.heavyCycleWeapon = function () {
    if (!_on()) return false;
    _seed();
    const ws = player._weapons || [];
    if (ws.length < 2) return false;
    let idx = ws.indexOf((typeof playerWeapon !== 'undefined') ? playerWeapon : ws[0]);
    idx = (idx + 1) % ws.length;
    const next = ws[idx];
    if (typeof applyWeaponToPlayer === 'function') applyWeaponToPlayer(next);
    if (typeof showSwapToast === 'function') {
      const nm = (next && next.name) ? next.name : '';
      showSwapToast(T('▸ 切換武器 · ' + nm, '▸ SWITCH · ' + nm));
    }
    return true;
  };

  // X (ULTIMATE): fire ALL stockpiled weapons at once, for an energy cost. Each
  // weapon fans slightly off the aim; bypasses per-weapon ammo/cooldown (it's a
  // burst, not normal fire). No-op (with a toast) when not enough energy.
  window.heavyUltimate = function () {
    if (!_on() || !player.alive) return false;
    _seed();
    const ws = player._weapons || [];
    if (ws.length === 0) return false;
    const cost = (typeof BALANCE === 'object' && BALANCE.ability) ? (BALANCE.ability.ultimate || 0) : 0;
    if ((game._energy || 0) < cost) {
      if (typeof showSwapToast === 'function') showSwapToast(T('能量不足', 'NOT ENOUGH ENERGY'));
      return false;
    }
    game._energy = Math.max(0, (game._energy || 0) - cost);
    const baseAngle = (player.gunAngle != null ? player.gunAngle : (player.angle || 0));
    const mpGhost = (typeof _mpIsActive === 'function' && _mpIsActive());
    const n = ws.length;
    for (let wi = 0; wi < n; wi++) {
      const w = ws[wi];
      const fanBase = baseAngle + (wi - (n - 1) / 2) * 0.14;   // splay the barrels
      const pellets = w.pellets || 1;
      for (let i = 0; i < pellets; i++) {
        const barrel = fanBase + (Math.random() - 0.5) * (w.spread || 0);
        bullets.push({
          x: player.x + Math.cos(barrel) * 18,
          y: player.y + Math.sin(barrel) * 18,
          vx: Math.cos(barrel) * w.bulletSpeed,
          vy: Math.sin(barrel) * w.bulletSpeed,
          life: w.bulletLife, damage: w.damage,
          fromAlly: false, fromUnit: player, weaponName: w.name,
          isRocket: !!w.isRocket, blastR: w.blastR, blastDmg: w.blastDmg,
          structDmgMul: w.structDmgMul, _mpGhost: mpGhost,
        });
      }
      muzzleFlashes.push({ x: player.x + Math.cos(fanBase) * 22, y: player.y + Math.sin(fanBase) * 22, angle: fanBase, life: 6 });
    }
    if (typeof triggerShake === 'function') triggerShake(6, 12);
    if (typeof emitSound === 'function') emitSound(player.x, player.y, 1800, true, true, null);
    if (typeof showSwapToast === 'function') showSwapToast(T('▶ 大招 · 全武器齊射', '▶ ULTIMATE · ALL GUNS'));
    return true;
  };
})();
