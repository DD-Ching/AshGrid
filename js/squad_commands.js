// ============ SQUAD COMMANDS ============
// Player issues high-level orders (RALLY / SPREAD / ATTACK / DEFEND / PROTECT
// / SUPPRESS / RETREAT) and allies bias their movement + fire toward the
// order for ~8 seconds. Orders post-process the NN's chosen action — the
// model still picks fire-vs-hold and the rough motion, we just nudge the
// move direction toward the order's intent. After the order expires, NN
// takes back over completely.
//
// Classic-script. Declares globally:
//   SQUAD_ORDER_DURATION · SQUAD_ORDERS (table)
//   issueSquadOrder(id) · _squadOrderActive() · _vectorToMoveDir(dx, dy)
//   _squadOrderMoveDirFor(unit, friendlies, enemies, orderId)
//
// External deps (resolved at call-time):
//   game · player · allies · enemies · WORLD
//   showSwapToast · T · playRadioBeep · _r

const SQUAD_ORDER_DURATION = 8 * 60;      // 8 seconds of biased behaviour
const SQUAD_ORDERS = {
  rally:    { id: 'rally',    key: '1', zh: '集合',  en: 'RALLY',    radio_zh: '靠攏',   radio_en: 'On me' },
  spread:   { id: 'spread',   key: '2', zh: '散開',  en: 'SPREAD',   radio_zh: '展開',   radio_en: 'Spread out' },
  attack:   { id: 'attack',   key: '3', zh: '進攻',  en: 'ATTACK',   radio_zh: '推進',   radio_en: 'Push them' },
  defend:   { id: 'defend',   key: '4', zh: '防禦',  en: 'DEFEND',   radio_zh: '據點',   radio_en: 'Hold position' },
  protect:  { id: 'protect',  key: '5', zh: '護衛',  en: 'PROTECT',  radio_zh: '貼我',   radio_en: 'Protect me' },
  suppress: { id: 'suppress', key: '6', zh: '壓制',  en: 'SUPPRESS', radio_zh: '火力',   radio_en: 'Suppress' },
  retreat:  { id: 'retreat',  key: '7', zh: '撤退',  en: 'RETREAT',  radio_zh: '後撤',   radio_en: 'Fall back' },
};
function issueSquadOrder(id) {
  const def = SQUAD_ORDERS[id];
  if (!def) return;
  game._squadOrder = { id: def.id, expiresAt: game.time + SQUAD_ORDER_DURATION };
  const lang = (typeof getLang === 'function' && getLang() === 'zh') ? 'zh' : 'en';
  const label = (lang === 'zh') ? def.zh : def.en;
  const radio = (lang === 'zh') ? def.radio_zh : def.radio_en;
  if (typeof showSwapToast === 'function') showSwapToast(`▶ ${label}`);
  if (typeof showRadioToast === 'function') showRadioToast('CMD', `"${radio}"`);
  if (typeof playRadioBeep === 'function') playRadioBeep(880, 0.12);
}
function _squadOrderActive() {
  return game._squadOrder && game.time < game._squadOrder.expiresAt;
}
// Map a continuous direction (dx, dy) to one of the 9 NN move-dir slots.
// Mirrors Python's combat_env._vector_to_movedir.
function _vectorToMoveDir(dx, dy) {
  if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) return 0;
  const angle = Math.atan2(dy, dx);
  const dirs = [
    [1, -Math.PI / 2],          // N
    [2, -Math.PI / 4],          // NE
    [3, 0],                     // E
    [4, Math.PI / 4],           // SE
    [5, Math.PI / 2],           // S
    [6, 3 * Math.PI / 4],       // SW
    [7, Math.PI],               // W
    [8, -3 * Math.PI / 4],      // NW
  ];
  let best = 1, bestDiff = Math.PI;
  for (const [d, a] of dirs) {
    let diff = ((angle - a + Math.PI) % (2 * Math.PI)) - Math.PI;
    if (diff < -Math.PI) diff += 2 * Math.PI;
    diff = Math.abs(diff);
    if (diff < bestDiff) { bestDiff = diff; best = d; }
  }
  return best;
}
// Compute the order-biased move direction for a friendly unit. Returns
// `null` if the order doesn't dictate movement (e.g. SUPPRESS holds).
// Phase 14: when the player is piloting the UAV (game.mode === 'drone' &&
// drone.deployed), rally + protect target the DRONE's position instead of
// the player's so the squad escorts the UAV as the user explicitly asked
// for ('進入無人機的視角,我可以讓大家跟著無人機,保護無人機').
function _squadAnchor() {
  if (typeof drone !== 'undefined' && drone.deployed
      && typeof game !== 'undefined' && game.mode === 'drone') {
    return { x: drone.x, y: drone.y };
  }
  return { x: player.x, y: player.y };
}
function _squadOrderMoveDirFor(unit, friendlies, enemies, orderId) {
  if (orderId === 'rally') {
    const a = _squadAnchor();
    const dx = a.x - unit.x, dy = a.y - unit.y;
    if (Math.hypot(dx, dy) < 100) return 0;          // close enough → idle
    return _vectorToMoveDir(dx, dy);
  }
  if (orderId === 'spread') {
    // Move away from nearest other friendly
    let nearest = null, bd = Infinity;
    for (const f of friendlies) {
      if (f === unit || !f || !f.alive) continue;
      const d = Math.hypot(f.x - unit.x, f.y - unit.y);
      if (d < bd) { bd = d; nearest = f; }
    }
    if (!nearest || bd > 220) return null;          // already spread out
    return _vectorToMoveDir(unit.x - nearest.x, unit.y - nearest.y);
  }
  if (orderId === 'attack') {
    // Push toward nearest enemy (visible or last-seen)
    let nearest = null, bd = Infinity;
    for (const e of enemies) {
      if (!e || !e.alive) continue;
      const d = Math.hypot(e.x - unit.x, e.y - unit.y);
      if (d < bd) { bd = d; nearest = e; }
    }
    if (!nearest) return null;
    if (bd < 180) return null;                      // close enough; let NN engage
    return _vectorToMoveDir(nearest.x - unit.x, nearest.y - unit.y);
  }
  if (orderId === 'defend') {
    // Move to nearest cover point if not already at one
    if (typeof coverPoints === 'undefined' || !coverPoints.length) return 0;
    let nearest = null, bd = Infinity;
    for (const cp of coverPoints) {
      const d = Math.hypot(cp.x - unit.x, cp.y - unit.y);
      if (d < bd) { bd = d; nearest = cp; }
    }
    if (!nearest || bd < 30) return 0;              // at cover → hold
    return _vectorToMoveDir(nearest.x - unit.x, nearest.y - unit.y);
  }
  if (orderId === 'protect') {
    // Orbit ~80u from the squad anchor (player normally, drone when the
    // player is piloting UAV — see _squadAnchor) on a slot derived from
    // ally index so they spread evenly around the target.
    const a = _squadAnchor();
    const idx = Math.max(0, friendlies.indexOf(unit));
    const ang = (idx / Math.max(1, friendlies.length - 1)) * Math.PI * 2;
    const desiredX = a.x + Math.cos(ang) * 80;
    const desiredY = a.y + Math.sin(ang) * 80;
    const dx = desiredX - unit.x, dy = desiredY - unit.y;
    if (Math.hypot(dx, dy) < 30) return 0;
    return _vectorToMoveDir(dx, dy);
  }
  if (orderId === 'suppress') {
    return 0;                                       // hold position; fire forced below
  }
  if (orderId === 'retreat') {
    // Move toward unit's spawn position
    const sx = unit.spawnX != null ? unit.spawnX : (typeof NN_ARENA !== 'undefined' ? NN_ARENA.x0 + 200 : unit.x);
    const sy = unit.spawnY != null ? unit.spawnY : unit.y;
    const dx = sx - unit.x, dy = sy - unit.y;
    if (Math.hypot(dx, dy) < 60) return 0;
    return _vectorToMoveDir(dx, dy);
  }
  return null;
}
