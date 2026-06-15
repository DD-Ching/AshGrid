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
  // Phase 187b — the Heavy stockpile is a QUANTITY multiset, not 3 unique slots:
  // every gun walked-over ADDS to a count (two shotguns = +2, can stack to dozens),
  // and the ultimate fires the FULL accumulated arsenal. ARSENAL_CAP bounds the
  // one-frame burst (perf). player._arsenal is a Map<weaponObj, count>.
  const ARSENAL_CAP = 50;        // total guns the heavy can hold ("几十把")
  window.heavyMaxWeapons = ARSENAL_CAP;
  // Ultimate barrel splay (radians between stockpiled weapons). MUST equal the
  // server's ULT_FAN_STEP (server/party/server.js) so the client ghost burst and
  // the server-authoritative burst fan identically — tools/check_sim_parity.js
  // asserts the two literals match (184m: was a bare 0.14 on both sides).
  const ULT_FAN_STEP = 0.14;

  function _on() {
    return typeof game !== 'undefined' && game && game._classes
        && typeof player !== 'undefined' && player && player._chassis === 'heavy';
  }
  function _arsenal() {
    if (typeof player === 'undefined' || !player) return null;
    if (!(player._arsenal instanceof Map)) player._arsenal = new Map();
    return player._arsenal;
  }
  function _arsenalTotal() {
    const a = _arsenal(); if (!a) return 0;
    let n = 0; for (const c of a.values()) n += c; return n;
  }
  window.heavyArsenalTotal = _arsenalTotal;   // HUD readout
  // Seed the equipped weapon into the arsenal (count ≥ 1) on first use.
  function _seed() {
    const a = _arsenal(); if (!a) return;
    const cur = (typeof playerWeapon !== 'undefined') ? playerWeapon : null;
    if (cur && !a.has(cur) && a.size === 0) a.set(cur, 1);
  }

  // Pickup: ADD ONE to this weapon's count (duplicates STACK — "十把就是十把").
  // Equips the latest gun. Returns true if it handled the pickup (caller skips
  // the normal single-weapon replace). At ARSENAL_CAP it still equips but stops
  // counting (bounds the burst).
  window.heavyPickupWeapon = function (w) {
    if (!_on() || !w) return false;
    _seed();
    const a = _arsenal(); if (!a) return false;
    if (typeof applyWeaponToPlayer === 'function') applyWeaponToPlayer(w);   // equip the latest
    if (_arsenalTotal() < ARSENAL_CAP) a.set(w, (a.get(w) || 0) + 1);
    if (typeof showSwapToast === 'function') {
      const nm = (w && w.name) ? w.name : '';
      showSwapToast(T('▸ 囤積 · ' + nm + ' · 軍火 ×' + _arsenalTotal(),
                      '▸ STOCKPILE · ' + nm + ' · arsenal ×' + _arsenalTotal()));
    }
    return true;
  };

  // R: cycle the ACTIVE (normal-fire) weapon among the unique types held.
  // Returns false when not applicable so the caller falls back to reload.
  window.heavyCycleWeapon = function () {
    if (!_on()) return false;
    _seed();
    const a = _arsenal(); if (!a) return false;
    const keys = [...a.keys()];
    if (keys.length < 2) return false;
    let idx = keys.indexOf((typeof playerWeapon !== 'undefined') ? playerWeapon : keys[0]);
    idx = (idx + 1) % keys.length;
    const next = keys[idx];
    if (typeof applyWeaponToPlayer === 'function') applyWeaponToPlayer(next);
    if (typeof showSwapToast === 'function') {
      const nm = (next && next.name) ? next.name : '';
      showSwapToast(T('▸ 切換武器 · ' + nm + ' ×' + (a.get(next) || 1),
                      '▸ SWITCH · ' + nm + ' ×' + (a.get(next) || 1)));
    }
    return true;
  };

  // X (ULTIMATE): fire ALL stockpiled weapons at once, for an energy cost. Each
  // weapon fans slightly off the aim; bypasses per-weapon ammo/cooldown (it's a
  // burst, not normal fire). No-op (with a toast) when not enough energy.
  window.heavyUltimate = function () {
    if (!_on() || !player.alive) return false;
    _seed();
    const a = _arsenal(); if (!a || a.size === 0) return false;
    // Flatten the multiset → a fire list with each gun repeated by its COUNT, so
    // 10 shotguns really fire 10 shotgun volleys ("十把就是十把").
    const fireList = [];
    for (const [w, c] of a.entries()) for (let i = 0; i < c; i++) fireList.push(w);
    const n = fireList.length;
    if (n === 0) return false;
    const cost = (typeof BALANCE === 'object' && BALANCE.ability) ? (BALANCE.ability.ultimate || 0) : 0;
    if ((game._energy || 0) < cost) {
      if (typeof showSwapToast === 'function') showSwapToast(T('能量不足', 'NOT ENOUGH ENERGY'));
      return false;
    }
    game._energy = Math.max(0, (game._energy || 0) - cost);
    const baseAngle = (player.gunAngle != null ? player.gunAngle : (player.angle || 0));
    const mpGhost = (typeof _mpIsActive === 'function' && _mpIsActive());
    for (let wi = 0; wi < n; wi++) {
      const w = fireList[wi];
      const fanBase = baseAngle + (wi - (n - 1) / 2) * ULT_FAN_STEP;   // splay the barrels
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
      if (wi % 3 === 0 || n <= 12) muzzleFlashes.push({ x: player.x + Math.cos(fanBase) * 22, y: player.y + Math.sin(fanBase) * 22, angle: fanBase, life: 6 });
    }
    // Phase 184j/187b — MP: the local bullets above are _mpGhost (visual only);
    // send an ultimateBurst so the SERVER spawns the FULL arsenal authoritatively
    // (each gun repeated by count). Map each weapon object → its wId.
    if (mpGhost && typeof _mpSendRaw === 'function' && typeof WEAPONS !== 'undefined') {
      const ids = [];
      for (const w of fireList) {
        let id = 'RIFLE';
        for (const k of Object.keys(WEAPONS)) { if (WEAPONS[k] === w) { id = k; break; } }
        ids.push(id);
      }
      _mpSendRaw({ type: 'ultimateBurst', weapons: ids, angle: baseAngle });
    }
    if (typeof triggerShake === 'function') triggerShake(Math.min(10, 5 + n * 0.2), 14);
    if (typeof emitSound === 'function') emitSound(player.x, player.y, 1800, true, true, null);
    if (typeof showSwapToast === 'function') showSwapToast(T('▶ 大招 · 全武器齊射 ×' + n, '▶ ULTIMATE · ALL GUNS ×' + n));
    return true;
  };

  // Phase 187b — Heavy G = 处决抢夺 (EXECUTE + SEIZE). On a 反白/weaker enemy in
  // touch range, the heavy executes it and seizes the victim's CONSUMABLE quotas —
  // FPV / suicide-drone + grenades (+ recon-drone charge if any). The victim's GUN
  // is NOT taken by G — it DROPS on the ground (every dead enemy drops its gun),
  // and the heavy collects guns by walking over them (stacking). SOLO path
  // (enemies[]); self-gates to heavy + game._classes. Wired in the G dispatcher.
  window._arenaTryHeavyExecute = function () {
    if (!_on() || !player.alive) return false;
    if (typeof enemies === 'undefined' || !enemies) return false;
    const myR = player.radius || 13;
    const myHp = player.hp || 1;
    const buf = (typeof ARENA_TOUCH_BUFFER === 'number') ? ARENA_TOUCH_BUFFER : 80;
    let best = null, bestD = Infinity;
    for (const e of enemies) {
      if (!e || !e.alive || e._humanPiloted) continue;
      const d = Math.hypot(e.x - player.x, e.y - player.y);
      if (d > myR + (e.radius || 13) + buf) continue;
      if (e.hp >= myHp) continue;            // must be 反白 (weaker than me)
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) return false;
    const bx = best.x, by = best.y;
    const looted = [];
    // FPV / suicide-drone quota
    if (typeof best._fpvAmmo === 'number' && best._fpvAmmo > 0 && typeof fpv !== 'undefined') {
      fpv.available += best._fpvAmmo; fpv.max = Math.max(fpv.max, fpv.available);
      looted.push('FPV×' + best._fpvAmmo); best._fpvAmmo = 0;
    }
    // grenades (cap at player max)
    if (typeof best.grenades === 'number' && best.grenades > 0 && typeof player.maxGrenades === 'number') {
      const g = Math.min(best.grenades, (player.maxGrenades || 0) - (player.grenades || 0));
      if (g > 0) { player.grenades = (player.grenades || 0) + g; looted.push((T ? T('手雷','NADE') : 'NADE') + '×' + g); }
    }
    // recon-drone charge, if the victim carries one (defensive — many don't)
    if (typeof best._droneCharge === 'number' && best._droneCharge > 0 && typeof drone !== 'undefined') {
      drone.battery = Math.min(drone.maxBattery || 100, (drone.battery || 0) + best._droneCharge);
      looted.push((T ? T('無人機','UAV') : 'UAV')); best._droneCharge = 0;
    }
    // EXECUTE — vanish the victim (no squad slot, like the wolf devour) + DROP its
    // gun on the ground for walk-over collection (guns aren't seized via G).
    if (best._weapon && typeof _spawnGroundWeapon === 'function') _spawnGroundWeapon(bx, by, best._weapon);
    best.alive = false; best._koStunned = false;
    const idx = enemies.indexOf(best); if (idx >= 0) enemies.splice(idx, 1);
    if (typeof createExplosion === 'function') createExplosion(bx, by, 'small');
    if (typeof playRadioStatic === 'function') playRadioStatic(0.5, 0.4);
    if (typeof triggerRecruitFx === 'function') triggerRecruitFx('SEIZE');
    if (typeof showSwapToast === 'function') {
      const lt = looted.length ? looted.join(' · ') : (T ? T('已處決','executed') : 'executed');
      showSwapToast(T ? T('▸ 奪取 · ' + lt, '▸ SEIZE · ' + lt) : ('▸ SEIZE · ' + lt));
    }
    return true;
  };
})();
