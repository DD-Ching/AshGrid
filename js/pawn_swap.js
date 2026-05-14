// ============ OPERATOR PAWN-SWAP ============
// In NN mode the player is just one of the team-0 slots. Press 2/3/4 to hand
// the operator (you) into a different friendly body — the body you leave
// behind keeps fighting under NN control, and you take over the chosen ally.
// Operator-level state (drone, FPV, grenades, stamina) stays with you; only
// body-level state (position, weapon, HP, ammo, gun barrel) swaps.
//
// Also bundles the tiny showSwapToast helper used by 30+ callsites — the
// "接管 BRAVO" center banner that used to block view of the action while
// the player was rapid-switching between bodies.
//
// Classic-script. Declares globally:
//   swapPlayerToAlly(idx) · showSwapToast(text)
//
// External deps: game · player · allies · WEAPONS · CHASSIS ·
//   applyWeaponToPlayer · applyChassisToUnit · dismissDeathRecap ·
//   playSfx · T

function swapPlayerToAlly(idx) {
  if (!game._nnMode) return;
  if (idx < 0 || idx >= allies.length) return;
  const a = allies[idx];
  if (!a || !a.alive) return;
  // Phase 83 — pawn-swap in MP now allowed WHEN ALONE in the room. User
  // '在正常模式下沒有辦法正常切換隊友 ... 工廠生產出來的新隊友無法操控'.
  // Since Phase 74 made MP the default, every solo session was actually
  // hitting the Phase 63 block. The reason Phase 63 blocked: in a real
  // multi-peer match, a local teleport diverges from server position +
  // server's reconciliation snaps you back. But if there are NO other
  // peers in the room, divergence is harmless — no one else needs to
  // see consistent state. We DO still need to ride out the next ~60
  // ticks until the server catches up to inputs that drove the player
  // toward the new position; player._mpIgnoreReconcileUntil suppresses
  // the dist > 150u snap during that window so the swap actually sticks.
  if (typeof _mpIsActive === 'function' && _mpIsActive()) {
    const peers = (typeof _mpState !== 'undefined' && _mpState.remotePlayers)
      ? Math.max(0, _mpState.remotePlayers.size - 1)
      : 0;
    if (peers > 0) {
      // Real multi-peer match — block. Server-authoritative state would
      // snap us back anyway, and the brief client-side teleport visually
      // looks like 'the other ally just zoomed onto your screen'.
      if (typeof showSwapToast === 'function') {
        showSwapToast(T('▶ 聯機模式有其他玩家時不支援角色切換',
                        '▶ Pawn-swap disabled while peers present'));
      }
      return;
    }
    // Alone — suppress MP position reconcile for the next 90 ticks
    // (1.5s) so server's next 'you're at old pos' snapshot doesn't
    // immediately yank us back. By that time client inputs will have
    // driven server position closer to the new spot anyway.
    if (typeof game !== 'undefined' && typeof player !== 'undefined') {
      player._mpIgnoreReconcileUntil = game.time + 90;
    }
  }
  // Pawn-swap auto-dismisses the death recap — player wants to see the
  // new body, not stare at the killer card.
  if (typeof dismissDeathRecap === 'function') dismissDeathRecap();

  // Snapshot ally body before we overwrite the slot
  const targetCallsign  = a.callsign;
  const targetWeapon    = a._weapon || WEAPONS.RIFLE;
  const targetX         = a.x, targetY = a.y;
  const targetAngle     = a.angle;
  const targetGun       = a.gunAngle || a.angle;
  const targetGunRecoil = a.gunRecoil || 0;
  const targetHp        = a.hp, targetMaxHp = a.maxHp;
  const targetChassis   = a._chassis || 'humanoid';
  // Phase 4: SEED follows the body. Snapshot the operator's pre-swap SEED
  // so we can stamp it onto the ex-op slot below (body remembers its
  // accumulated SEED in case you swap back). Target ally's SEED transfers
  // into the player when we take over its body.
  const operatorSeedBefore = player._seed || 0;
  const targetSeed         = a._seed || 0;

  // What to put in the ally slot we just left behind:
  //   - If the operator was ALIVE, hand the live body to NN intact (full hp,
  //     same weapon, NN takes over driving it).
  //   - If the operator was MID-RESPAWN-COUNTDOWN, the old body already
  //     exploded; the slot becomes a dead corpse at the death spot that
  //     respawns under NN control after the standard timer.
  if (player.alive) {
    allies[idx] = {
      callsign: T('前操作员', 'EX-OPERATOR'),
      offsetX: a.offsetX, offsetY: a.offsetY,
      x: player.x, y: player.y,
      angle: player.angle, gunAngle: player.gunAngle, gunRecoil: player.gunRecoil,
      swayPhase: Math.random() * Math.PI * 2,
      walkPhase: player.walkPhase || 0,
      hp: player.hp, maxHp: player.maxHp,
      alive: true, radius: player.radius || 13,
      speed: player.speed || 2.5, fireCd: 0,
      weaponId: 'M4',
      _weapon: playerWeapon,
      _nnDifficulty: a._nnDifficulty || NN.difficulty || 'evolved',
      _chassis: player._chassis || 'humanoid',
      target: null, lookPhase: 0,
      team: 0,
      _useNN: true, _nnFireCd: 0, _nnRecentDmg: 0, _nnLastSeenTick: -9999,
      _respawnAt: null,
      _invulnUntil: game.time + 60,
      // Phase 4: ex-op slot inherits the SEED the human player built up in
      // this body. AI now drives, so _humanPiloted flips false (SEED no
      // longer ticks here — but the accumulated value persists for swap-back).
      _seed: operatorSeedBefore,
      _humanPiloted: false,
    };
  } else {
    // Phase 85 — dead pawn-swap. User '別人會瞬間移動到我原本死掉的位置
    // 這樣很怪'. The ex-op slot now respawns at the TEAM SPAWN point
    // instead of at the player's death position. Old behaviour placed
    // the corpse at corpseX/corpseY (= player death spot) and 5s later
    // it visibly 'came back to life' at the player's death position,
    // reading as 'BRAVO teleported to my death spot'. The fix routes
    // it through the standard blue spawn so the respawn is far from
    // the action + nowhere near the player's new position.
    const _spawn = (typeof game !== 'undefined' && game._nnSpawnBlue) || null;
    const corpseX = _spawn ? _spawn.x : (player._lastDeathX != null ? player._lastDeathX : player.x);
    const corpseY = _spawn ? _spawn.y : (player._lastDeathY != null ? player._lastDeathY : player.y);
    allies[idx] = {
      callsign: T('前操作员', 'EX-OPERATOR'),
      offsetX: a.offsetX, offsetY: a.offsetY,
      x: corpseX, y: corpseY,
      angle: 0, gunAngle: 0, gunRecoil: 0,
      swayPhase: Math.random() * Math.PI * 2, walkPhase: 0,
      hp: 0, maxHp: 100,
      alive: false, radius: 13,
      speed: 2.5, fireCd: 0,
      weaponId: 'M4',
      _weapon: playerWeapon,
      _nnDifficulty: a._nnDifficulty || NN.difficulty || 'evolved',
      target: null, lookPhase: 0,
      team: 0,
      _useNN: true, _nnFireCd: 0, _nnRecentDmg: 0, _nnLastSeenTick: -9999,
      _respawnAt: game.time + 5 * 60,   // RESPAWN_TICKS — same constant inline
      _invulnUntil: 0,
      // Phase 4: dead ex-op body keeps its SEED (will respawn as AI with
      // this value; the player chose to abandon it mid-respawn-countdown).
      _seed: operatorSeedBefore,
      _humanPiloted: false,
    };
  }

  // Move operator into target body — and ALWAYS clear any pending respawn.
  // This is the rule: a successful takeover cancels the respawn countdown.
  const wasResurrected = !player.alive;
  player.alive = true;
  player._respawnAt = null;
  player._lastBeepSec = -1;
  player.x = targetX; player.y = targetY;
  player.angle = targetAngle;
  player.gunAngle = targetGun;
  player.gunRecoil = targetGunRecoil * 0.4;
  player.hp = targetHp; player.maxHp = targetMaxHp;
  // Inherit the ally's chassis (speed / radius / silhouette) on pawn-swap
  player._chassis = targetChassis || player._chassis || 'humanoid';
  const _cdef = CHASSIS[player._chassis] || CHASSIS.humanoid;
  player.speed  = 2.8 * _cdef.speedMul;
  // Phase 1 refactor — mirror the raw chassis mul so v2 MP input picks
  // it up. See chassis.js applyChassisToUnit for rationale.
  player._chassisSpeedMul = _cdef.speedMul;
  player.radius = Math.round(14 * _cdef.radiusMul);
  player._invulnUntil = game.time + 60;
  player._lastX = targetX; player._lastY = targetY;
  player._velX = 0; player._velY = 0;
  player._lastDeathX = null; player._lastDeathY = null;
  mouse.down = false;
  applyWeaponToPlayer(targetWeapon);
  player.hp = targetHp;   // applyWeaponToPlayer doesn't touch HP — be explicit
  // Phase 4: SEED follows the body. Player inherits the target ally's SEED
  // (almost always 0 since it was AI-driven, unless the player previously
  // built it up and swapped back into a body they once piloted).
  player._seed = targetSeed;
  player._humanPiloted = true;

  showSwapToast(`${wasResurrected ? T('紧急接管', 'EMERGENCY SWAP') : T('接管', 'SWAP')} ${targetCallsign}`);
  playSfx('countdown', { freq: 1320, vol: 0.45 });
}

// Small top-center toast for pawn-swap feedback — replaces the full-width
// "接管 BRAVO" center banner that used to block view of the action while
// the player was rapid-switching between bodies.
function showSwapToast(text) {
  game._swapToast = { text, ttl: 75 };   // 1.25s
}
