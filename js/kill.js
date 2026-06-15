// ============ UNIT KILL / DEATH CHOKEPOINT (Phase 141) ============
// ONE entry point for "a unit just died". Before this, the pattern
//   e.alive = false; game.score += 100; game.killCount++;
// was copy-pasted across ~9 enemy-kill sites in bullets.js, structures.js,
// grenades.js and index.html — each subtly different (some credit score,
// some don't; some bump the leaderboard, some don't; some set hp=0). Adding
// a "when a unit dies, also do X" behaviour (e.g. drop its weapon) meant
// editing all of them and inevitably missing one.
//
// killUnit() centralises the COMMON part — flip alive/hp, optional score +
// kill credit + leaderboard bump — and fires a death-hook list so any future
// "on death, do X" attaches in ONE place. Each callsite keeps its OWN special
// behaviour (explosion FX, KO-stun pre-check, recruit gating, kill sounds):
// killUnit only runs once the callsite has already decided this is a real
// kill, so stun/recruit branches stay exactly where they were.
//
// Classic-script. Declares globally:
//   killUnit(unit, opts) · onUnitDeath(cb) · _unitDeathHooks
// External deps (call-time): game · _lbBumpKill (optional)
//
// opts:
//   credit  (default true)  — award game.score + game.killCount for this kill
//   score   (default 100)   — score amount when credit is on
//   lbBump  (default true)  — also bump the leaderboard kill stat (credit on)
//   source  (optional)      — tag for hooks ('bullet'|'mine'|'tesla'|...)
// Anything else on opts is passed through to the death hooks untouched.

const _unitDeathHooks = [];

// Register a callback fired (unit, opts) every time killUnit() kills a unit.
function onUnitDeath(cb) {
  if (typeof cb === 'function') _unitDeathHooks.push(cb);
}

function killUnit(unit, opts) {
  // Guard re-entry: a unit already dead must not score / fire hooks twice
  // (AOE loops can hit the same corpse, stray bullets arrive after death).
  if (!unit || !unit.alive) return false;
  opts = opts || {};
  unit.alive = false;
  unit.hp = 0;

  if (opts.credit !== false) {
    if (typeof game !== 'undefined') {
      game.score = (game.score || 0) + (opts.score != null ? opts.score : 100);
      game.killCount = (game.killCount || 0) + 1;
    }
    if (opts.lbBump !== false && typeof _lbBumpKill === 'function') _lbBumpKill();
  }

  for (let i = 0; i < _unitDeathHooks.length; i++) {
    try { _unitDeathHooks[i](unit, opts); } catch (e) { /* a bad hook can't break a kill */ }
  }
  // Phase 187b — every dead ENEMY drops its gun on the ground ("敵人死掉了都會噴
  // 裝備…槍都會掉地上"), so the Heavy can walk over + collect it (stacking). Gated
  // on game._classes (the heavy-collection loop is a classes feature); enemies
  // only (team !== 0, not the player). Ground-weapon list self-caps.
  if (typeof game !== 'undefined' && game._classes
      && typeof player !== 'undefined' && unit !== player && unit.team !== 0
      && unit._weapon && typeof _spawnGroundWeapon === 'function') {
    _spawnGroundWeapon(unit.x, unit.y, unit._weapon);
  }
  return true;
}
