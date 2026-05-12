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
  // 重甲機甲: slow tank with double HP and bigger hitbox (easier to hit but
  // can soak much more). Pair with LMG / SHOTGUN for a walking fortress.
  heavy: {
    speedMul: 0.72, hpMul: 1.80, radiusMul: 1.20,
    label: () => T('重甲', 'HEAVY'),
    blurb: () => T('慢 · 厚甲 · 高血量', 'Slow · armored · tanky'),
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
}
