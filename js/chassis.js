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
    armor: 100,                    // max armor; refills from 0 over ~3.3 sec
    armorRegenDelay: 3 * 60,       // ticks of no-damage before regen starts
    armorRegenPerTick: 0.50,       // ~30 armor / second once regen kicks in
    armorBleedFactor: 0.50,        // share of damage that hits HP after armor=0
    label: () => T('重甲', 'HEAVY'),
    blurb: () => T('慢 · 護甲再生 · 高血量', 'Slow · regen armor · tanky'),
  },
};
const CHASSIS_ORDER = ['humanoid', 'wolf', 'heavy'];

// Apply a chassis profile to a unit (player or NN). Stores _chassis on the
// unit so render + NN inference can read it later. Stats are computed from
// a base value × the chassis multiplier, so weapon picks still drive their
// own modifiers on top.
function applyChassisToUnit(u, chassisId, baseSpeed, baseHp, baseRadius) {
  const c = CHASSIS[chassisId] || CHASSIS.humanoid;
  u._chassis = chassisId || 'humanoid';
  u.speed   = baseSpeed  * c.speedMul;
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
