// ============ PLAYER LIFECYCLE (R12 — alive / dead / respawn / invuln) =====
// Single owner of the player object's life-state writes. Before R12 this was
// the worst hot-spot in the codebase — Agent audit found 12+ write sites for
// `player.alive` / `_respawnAt` / `_invulnUntil` / `_killedAtTime` /
// `_lastDeathX/Y` / `_lastRespawnAt` scattered across 6 files. Every fix
// (Phase 117 / 122 / 125) had to chase down "which other path forgot to set
// the shield" individually. Every time we missed one, the bug regressed.
//
// New contract: the rest of the codebase calls these 3 transition APIs +
// 3 read APIs. Inlined writes to those fields are forbidden going forward
// (greppable: any non-PlayerLifecycle file writing `player._invulnUntil =`
// is a candidate for migration into one of the APIs).
//
// Classic-script. Declares globally:
//   window.PlayerLifecycle = {
//     killPlayer({ reason?, x?, y? }),
//     reviveAtSpawn({ x?, y?, hp?, invulnTicks? }),
//     extendInvuln(ticks),
//     isPlayerAlive(), isPlayerInvuln(), justRespawned(withinTicks)
//   }
//
// External deps (all optional, resolved at call time):
//   player · game.time · getRespawnSeconds() (respawn_buff.js) ·
//   dismissDeathRecap (death_recap.js) · _lbBumpDeath (leaderboard.js) ·
//   createExplosion (bullets/effects)

(function() {
  'use strict';

  function _gameTime() {
    return (typeof game !== 'undefined' && game.time) ? game.time : 0;
  }

  // ─── Transition: kill ──────────────────────────────────────────────
  // Sets alive=false, hp=0, records death marker, schedules respawn.
  // Idempotent — calling on an already-dead player no-ops (returns false).
  // Caller is responsible for creating explosion / playing audio / spawning
  // particles; this API only owns the state-fields.
  function killPlayer(opts) {
    opts = opts || {};
    if (typeof player === 'undefined' || !player.alive) return false;
    const _gt = _gameTime();
    const respawnSec = (typeof getRespawnSeconds === 'function')
      ? getRespawnSeconds() : 15;
    player.alive = false;
    player.hp = 0;
    player._lastDeathX = (opts.x != null) ? opts.x : player.x;
    player._lastDeathY = (opts.y != null) ? opts.y : player.y;
    player._killedAtTime = _gt;
    // Ticks-per-second is 60 (matches Phase 21 "180 ticks = 3 s").
    player._respawnAt = _gt + Math.round(respawnSec * 60);
    if (typeof _lbBumpDeath === 'function') _lbBumpDeath();
    return true;
  }

  // ─── Transition: revive ────────────────────────────────────────────
  // Restores alive=true + hp=max + 3s invuln shield. Optional x/y for
  // explicit spawn point; otherwise leaves position alone (caller chose
  // where to put the body before calling).
  //
  // Phase 125 made this client-authoritative for MP — when the local UI
  // countdown ends we FORCE alive=true regardless of server's current
  // serverSelfAlive (which can be stale from gap-damage during the
  // countdown). _lastRespawnAt stamps the 180-tick snapshot-protection
  // window so the multiplayer.js snapshot handler ignores stale "dead"
  // packets for 3 s.
  function reviveAtSpawn(opts) {
    opts = opts || {};
    if (typeof player === 'undefined') return false;
    const _gt = _gameTime();
    const invulnTicks = (opts.invulnTicks != null) ? opts.invulnTicks : 180;
    player.alive = true;
    player.hp = (opts.hp != null) ? opts.hp : (player.maxHp || 100);
    if (opts.x != null) player.x = opts.x;
    if (opts.y != null) player.y = opts.y;
    player.ammo = player.maxAmmo || player.ammo || 0;
    player.reserve = Math.max(player.reserve || 0, 120);
    player.reloading = false;
    // Explicit grant (no Math.max). The dead-state Infinity from MP
    // snapshot must NOT stick onto the live-state shield — Phase 122
    // root cause.
    player._invulnUntil = _gt + invulnTicks;
    player._lastRespawnAt = _gt;
    player._respawnAt = null;
    player._killedAtTime = 0;
    player._mpIgnoreReconcileUntil = 0;
    if (typeof dismissDeathRecap === 'function') dismissDeathRecap();
    return true;
  }

  // ─── Transition: extend invuln ─────────────────────────────────────
  // Grants OR extends invuln window. Used by match-start initial shield,
  // ad-revive buff stacking, etc. Idempotent if target end is earlier
  // than current (never reduces a longer shield).
  function extendInvuln(ticks) {
    if (typeof player === 'undefined') return;
    const _gt = _gameTime();
    const next = _gt + ticks;
    if (player._invulnUntil == null || player._invulnUntil < next) {
      player._invulnUntil = next;
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────
  function isPlayerAlive() {
    return typeof player !== 'undefined' && !!player.alive;
  }
  function isPlayerInvuln() {
    if (typeof player === 'undefined' || player._invulnUntil == null) return false;
    return _gameTime() < player._invulnUntil;
  }
  // True if the player respawned within the last `withinTicks` (default
  // 180 = 3 s). Used by the MP snapshot handler to gate stale packets.
  function justRespawned(withinTicks) {
    if (typeof player === 'undefined' || player._lastRespawnAt == null) return false;
    return (_gameTime() - player._lastRespawnAt) < (withinTicks || 180);
  }

  window.PlayerLifecycle = {
    killPlayer,
    reviveAtSpawn,
    extendInvuln,
    isPlayerAlive,
    isPlayerInvuln,
    justRespawned,
  };
})();
