// ============ CHASSIS ============
// Different unit body types with distinct stat profiles. Affects speed,
// max HP, hitbox radius, weapon-recoil tolerance, and silhouette. Lobby
// picker selects the global chassis; per-slot lineup can override later.
//
// Classic-script. Declares globally:
//   CHASSIS (table — humanoid / wolf / heavy with statMul / labels)
//   CHASSIS_ORDER (array — UI ordering)
//   applyChassisToUnit(u, chassisId, baseSpeed, baseHp, baseRadius)
//
// External deps: T (label helper, called at lobby render time)

const CHASSIS = {
  humanoid: {
    speedMul: 1.00, hpMul: 1.00, radiusMul: 1.00,
    label: () => T('人形', 'HUMANOID'),
    blurb: () => T('平衡 · 默认', 'Balanced · default'),
  },
  // 機器狼: fast, low-profile, lower HP. Smaller hitbox is the real edge —
  // harder to hit while flanking. NN AI compensates by aiming aggressively.
  wolf: {
    speedMul: 1.50, hpMul: 0.70, radiusMul: 0.78,
    label: () => T('机器狼', 'WOLF'),
    blurb: () => T('快 · 低姿态 · 脆', 'Fast · low-profile · fragile'),
  },
  // 重甲機甲: slow tank with double HP, bigger hitbox, AND a regenerating
  // armor buffer that fully absorbs damage until depleted, then bleeds 50%
  // to HP. User spec: '重型載具要有可以隨著時間慢慢恢復的護盾,就是裝甲,
  // 但是護甲值低於線以下時，受到傷害仍會傳遞50%的損傷治血量'.
  heavy: {
    speedMul: 0.72, hpMul: 1.80, radiusMul: 1.20,
    // Phase X balance: user '重裝甲 護盾太厚了'. EHP cut from
    // 100 + 180/0.50 = 460 → 60 + 180/0.65 = 337 (-27%). Still tankier
    // than humanoid's 100 EHP, but no longer absurd. Regen mechanic
    // preserved so the "duck behind cover and recover" gameplay loop
    // still works; just less raw absorption per encounter.
    armor: 60,                     // was 100 — max armor
    armorRegenDelay: 3 * 60,       // ticks of no-damage before regen starts (unchanged)
    armorRegenPerTick: 0.50,       // ~30 armor / second once regen kicks in (unchanged)
    armorBleedFactor: 0.65,        // was 0.50 — more HP damage after armor depleted
    label: () => T('重甲', 'HEAVY'),
    blurb: () => T('慢 · 護甲再生 · 高血量', 'Slow · regen armor · tanky'),
  },
};
const CHASSIS_ORDER = ['humanoid', 'wolf', 'heavy'];

// Phase 64 — per-chassis equipment budget. Each chassis has a total budget
// (in 'points') and items cost a fixed number of points:
//   grenade = 2 pts, FPV suicide drone = 3 pts
// Phase 102 — counts are now DETERMINISTIC per chassis (was random within
// the budget — '一個wolf可能5顆手雷+0台無人機, 另一個wolf 2+2', made
// kamikaze access feel arbitrary). User '自殺式人機, 每一個載具都要有
// 三台或兩台或四台(看種類)' — fixed FPV count per chassis class.
// Grenades fill whatever budget remains so total per chassis is unchanged.
const CHASSIS_LOADOUT_BUDGET = {
  wolf:     10,
  humanoid: 15,
  heavy:    20,
};
const LOADOUT_COSTS = {
  grenade: 2,
  fpv:     3,
};
// Fixed kamikaze-drone count per chassis (Phase 102). Sizes scale with the
// chassis profile: wolf is small / fragile / fast → minimum carry (2);
// humanoid balanced default (3); heavy is the tank / biggest carrier (4).
const CHASSIS_FPV_COUNT = {
  wolf:     2,
  humanoid: 3,
  heavy:    4,
};

// Return the deterministic {grenades, fpv} loadout for a chassis. Used
// at spawn (applyChassisToUnit) and respawn (server snapshot side). Caller
// stores the result on the unit as _grenadeAmmo / _fpvAmmo.
function rollUnitLoadout(chassisId) {
  const budget = CHASSIS_LOADOUT_BUDGET[chassisId] || CHASSIS_LOADOUT_BUDGET.humanoid;
  const fpv = CHASSIS_FPV_COUNT[chassisId] != null
    ? CHASSIS_FPV_COUNT[chassisId]
    : CHASSIS_FPV_COUNT.humanoid;
  const remaining = budget - (fpv * LOADOUT_COSTS.fpv);
  const grenades = Math.max(0, Math.floor(remaining / LOADOUT_COSTS.grenade));
  return { grenades, fpv };
}

// Apply a chassis profile to a unit (player or NN). Stores _chassis on the
// unit so render + NN inference can read it later. Stats are computed from
// a base value × the chassis multiplier, so weapon picks still drive their
// own modifiers on top.
function applyChassisToUnit(u, chassisId, baseSpeed, baseHp, baseRadius) {
  const c = CHASSIS[chassisId] || CHASSIS.humanoid;
  u._chassis = chassisId || 'humanoid';
  u.speed   = baseSpeed  * c.speedMul;
  // Phase 1 (refactor) — also store the RAW chassis multiplier so the
  // shared sim (SIM.simStepPerTick/PerFrame) can apply it without us
  // needing to back-derive baseSpeed at call sites. Used by the v2 MP
  // input packet (cMul field) so the server applies the same multiplier
  // — previously server defaulted to 1.0, which made wolf (1.50) and
  // heavy (0.72) chassis rubber-band hard while sprinting (sprint +
  // wolf = 4.62 px/tick client/server divergence → snap within 1 s).
  u._chassisSpeedMul = c.speedMul;
  u.maxHp   = Math.round(baseHp * c.hpMul);
  u.hp      = u.maxHp;
  u.radius  = Math.round(baseRadius * c.radiusMul);
  // Heavy chassis armor buffer. Initialised here so respawn / pawn-swap
  // both pick up the field. Non-heavy chassis don't get the property.
  if (c.armor != null) {
    u.maxArmor = c.armor;
    u.armor = c.armor;
    u._armorLastHurtAt = -9999;
  } else {
    u.maxArmor = 0;
    u.armor = 0;
  }
  // Phase 64 / 102 — deterministic grenade + FPV loadout per chassis.
  // Stamped onto the unit even if it'll never use them yet; the bot
  // grenade-throw / drone-launch AI hooks will read these counters when
  // (eventually) wired.
  const loadout = rollUnitLoadout(u._chassis);
  u._grenadeAmmo = loadout.grenades;
  u._fpvAmmo     = loadout.fpv;
  // Phase 102 — when the chassis is applied to the LOCAL player, also
  // sync the global fpv state (player tracks both u._fpvAmmo for the
  // bot/NN parity field AND the global fpv.max/fpv.available driving
  // the launch HUD + key-binding). Without this, wolf→heavy or
  // humanoid→wolf transitions left the HUD stuck at the previous chassis's
  // count. User '自殺式人機, 每一個載具都要有 N 台(看種類)'.
  if (typeof player !== 'undefined' && u === player && typeof fpv !== 'undefined') {
    fpv.max = loadout.fpv;
    fpv.available = loadout.fpv;
  }
}

// ============ DAMAGE ROUTING (heavy armor) ============
// Single damage gateway. Use this instead of `unit.hp -= dmg` for any
// hit on a chassis-owning unit (player / ally / enemy) so heavy gets
// its armor buffer + bleed-through behaviour. Structures / drones /
// other things keep `.hp -= dmg` since they aren't chassis units.
//
// Behaviour:
//   armor > 0: damage drains armor first. If incoming damage exceeds
//              remaining armor, the overflow leaks to HP at
//              armorBleedFactor (50%) — heavy never fully crumples.
//   armor = 0: damage hits HP at armorBleedFactor. Bleeds at 50% even
//              with no armor (heavy is still tankier than humanoid).
//   Non-heavy: full damage to HP (legacy behaviour).
function _applyDamageToUnit(u, dmg) {
  if (!u || !u.alive || !(dmg > 0)) return;
  // Phase 122 — centralised invuln gate. Every per-caller gate (Phase 117
  // kamikaze splash, bullets.js:456, grenades.js:102 …) was a fragile
  // belt-and-suspenders pattern: when a new damage type ships, the dev
  // can forget to add the check and the spawn shield bypasses again
  // (which is exactly how the Phase 117 regression happened). Centralising
  // here means the shield ALWAYS holds; per-caller gates become defensive
  // double-checks but no longer load-bearing.
  if (u._invulnUntil != null
      && typeof game !== 'undefined'
      && game.time < u._invulnUntil) {
    return;
  }
  const c = CHASSIS[u._chassis];
  if (c && c.armor != null) {
    u._armorLastHurtAt = (typeof game !== 'undefined') ? game.time : 0;
    const bleed = c.armorBleedFactor != null ? c.armorBleedFactor : 0.5;
    if (u.armor > 0) {
      const absorbed = Math.min(u.armor, dmg);
      u.armor -= absorbed;
      const overflow = dmg - absorbed;
      if (overflow > 0) u.hp -= overflow * bleed;
    } else {
      u.hp -= dmg * bleed;
    }
  } else {
    u.hp -= dmg;
  }
}

// Regen tick — call once per frame from the main update loop. Walks
// allies + enemies + player; if a unit is heavy and the no-damage
// cooldown has elapsed, top up its armor toward maxArmor.
function tickArmorRegen() {
  if (typeof game === 'undefined' || game.state !== 'playing') return;
  const now = game.time;
  const list = [];
  if (typeof player !== 'undefined') list.push(player);
  if (typeof allies !== 'undefined') for (const a of allies) list.push(a);
  if (typeof enemies !== 'undefined') for (const e of enemies) list.push(e);
  for (const u of list) {
    if (!u || !u.alive) continue;
    const c = CHASSIS[u._chassis];
    if (!c || c.armor == null) continue;
    const delay = c.armorRegenDelay != null ? c.armorRegenDelay : 180;
    if (now - (u._armorLastHurtAt || 0) < delay) continue;
    if (u.armor >= u.maxArmor) continue;
    u.armor = Math.min(u.maxArmor, u.armor + (c.armorRegenPerTick || 0.5));
  }
}
