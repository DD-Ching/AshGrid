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
  if (!a) { console.warn('[pawn-swap] target idx', idx, 'is null — refused'); return; }
  if (!a.alive) {
    // Phase 129c — explicit defence: should never reach here since both
    // callers (tryAutoSwapToClosestAlly + manual 1-4 keys) pre-filter on
    // alive. Logging the refusal so a future regression surfaces fast.
    console.warn('[pawn-swap] refused swap to dead target idx', idx,
                 { _consumed: !!a._consumed, _respawnAt: a._respawnAt });
    if (typeof showSwapToast === 'function') {
      showSwapToast(T('目标已阵亡', 'TARGET DOWN'));
    }
    return;
  }
  // Phase 102 (server-side support shipped) — Phase 83's peers-present
  // block is REMOVED. The server now has a 'swap' message handler that
  // accepts an authoritative position update + clears lag-comp history +
  // grants spawn protection. With that in place, real multi-peer swap
  // works correctly. We still set the local reconcile-ignore window as
  // belt-and-braces in case the broadcast is dropped before the next
  // snapshot — the server's 'swap' echo (handled in multiplayer.js)
  // will clear it as soon as it round-trips.
  if (typeof _mpIsActive === 'function' && _mpIsActive()) {
    // Phase 136 — route ignore-window writes through MpReconcile so the
    // single-owner contract holds. Was a direct property write that any
    // other module could (and did) silently clobber.
    if (typeof MpReconcile !== 'undefined') {
      MpReconcile.setIgnoreWindow(Infinity);
    } else if (typeof game !== 'undefined' && typeof player !== 'undefined') {
      player._mpIgnoreReconcileUntil = Infinity;   // fallback (module not loaded)
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
    // Phase 102 — dead pawn-swap. User '我要的就是在原本的位置, 只是我
    //現在的視野換地方'. The ex-op slot is the player's OLD body, which
    // lies at the death spot as a dead corpse. Critically: NO respawn
    // timer is set (a._consumed=true blocks the auto-respawn loop in
    // nn_deathmatch.js), so the corpse never 'stands up' anywhere later
    // — that pop-back is what previously read as 'B teleported to my
    // death spot' (pre-Phase-96) or 'B teleported to spawn' (Phase 96).
    // Team count permanently drops by one until the FULL team-wipe path
    // (no live teammates) triggers the bulk respawn + ad.
    const corpseX = player._lastDeathX != null ? player._lastDeathX : player.x;
    const corpseY = player._lastDeathY != null ? player._lastDeathY : player.y;
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
      _respawnAt: null,
      _consumed: true,                 // never respawns — see nn_deathmatch.js respawn loop
      _invulnUntil: 0,
      _seed: operatorSeedBefore,
      _humanPiloted: false,
    };
  }

  // Move operator into target body — and ALWAYS clear any pending respawn.
  // This is the rule: a successful takeover cancels the respawn countdown.
  const wasResurrected = !player.alive;
  player._lastBeepSec = -1;
  // Set CHASSIS first so reviveAtSpawn's defaults (player.maxHp,
  // player.maxArmor checks) see the new chassis's values. The chassis
  // assignment is pawn-swap's load-bearing concern, so it stays inline.
  player.maxHp = targetMaxHp;
  player._chassis = targetChassis || player._chassis || 'humanoid';
  const _cdef = CHASSIS[player._chassis] || CHASSIS.humanoid;
  player.speed  = 2.8 * _cdef.speedMul;
  // Phase 1 refactor — mirror the raw chassis mul so v2 MP input picks
  // it up. See chassis.js applyChassisToUnit for rationale.
  player._chassisSpeedMul = _cdef.speedMul;
  player.radius = Math.round(14 * _cdef.radiusMul);
  // Phase 129d — radius multiplier carried alongside speed so the MP
  // server can size collision per-chassis (see js/chassis.js for the
  // companion setter + server/party/server.js for the read site).
  player._chassisRadiusMul = _cdef.radiusMul;
  // Phase 127 — armor buffer for the new chassis. Mirror chassis.js:107.
  // Set BEFORE reviveAtSpawn so its `if (maxArmor>0) armor=maxArmor`
  // branch uses the new chassis's value.
  if (_cdef.armor != null) {
    player.maxArmor = _cdef.armor;
    player.armor = _cdef.armor;
    player._armorLastHurtAt = (typeof game !== 'undefined') ? -9999 : 0;
  } else {
    player.maxArmor = 0;
    player.armor = 0;
  }
  // Phase 102 — entering a new chassis refills the kamikaze loadout to
  // that chassis's fixed count (wolf 2, humanoid 3, heavy 4). User:
  // '自殺式人機, 每一個載具都要有三台或兩台或四台'.
  if (typeof CHASSIS_FPV_COUNT !== 'undefined' && typeof fpv !== 'undefined') {
    const newFpvMax = CHASSIS_FPV_COUNT[player._chassis] != null
      ? CHASSIS_FPV_COUNT[player._chassis]
      : CHASSIS_FPV_COUNT.humanoid;
    fpv.max = newFpvMax;
    fpv.available = newFpvMax;
  }
  // R12 — canonical alive transition. reviveAtSpawn owns:
  //   alive=true, hp=targetHp, x/y=target spot, _invulnUntil=+180,
  //   _lastRespawnAt=now, _respawnAt=null, _killedAtTime=0,
  //   _mpIgnoreReconcileUntil=0, ammo=max (overridden by
  //   applyWeaponToPlayer below), reloading=false, dismissDeathRecap.
  // Phase 102: 180-tick invuln (was 60 = 1 s) so the body switch isn't
  // instant-killed in a hot zone. Phase 125: also engages the 180-tick
  // snapshot protection window so stale "you're dead" packets can't
  // strip the shield.
  if (typeof PlayerLifecycle !== 'undefined') {
    PlayerLifecycle.reviveAtSpawn({
      x: targetX, y: targetY,
      hp: targetHp,
      invulnTicks: 180,
    });
  } else {
    // Defensive fallback if PlayerLifecycle didn't load.
    player.alive = true;
    player._respawnAt = null;
    player.x = targetX; player.y = targetY;
    player.hp = targetHp;
    player._invulnUntil = game.time + 180;
    player._lastRespawnAt = game.time;
    player._killedAtTime = 0;
  }
  // Phase 129 — reviveAtSpawn clears _mpIgnoreReconcileUntil to 0
  // (correct for normal respawn — new spawn position, server agrees,
  // reconcile should resume immediately). But pawn-swap needs the
  // suppression set up at line 34 (= Infinity) to PERSIST until the
  // server's swap-echo arrives (multiplayer.js _mpHandleMessage line
  // ~321 clears it on the echo). Without this re-set, every snapshot
  // after pawn-swap pulls the player back to the OLD pre-swap server
  // position — exactly the '走路會卡住拖的感覺' bug the user reported.
  if (typeof _mpIsActive === 'function' && _mpIsActive()) {
    // Phase 136 — same routing as line 43. reviveAtSpawn just cleared
    // the ignore window; re-set it through MpReconcile so the swap-
    // suppression persists until server-echo round-trips.
    if (typeof MpReconcile !== 'undefined') {
      MpReconcile.setIgnoreWindow(Infinity);
    } else if (typeof game !== 'undefined' && typeof player !== 'undefined') {
      player._mpIgnoreReconcileUntil = Infinity;
    }
  }
  // Pawn-swap-specific overrides AFTER reviveAtSpawn defaults:
  player.angle = targetAngle;
  player.gunAngle = targetGun;
  player.gunRecoil = targetGunRecoil * 0.4;   // override the gunRecoil=0 reset
  player._lastX = targetX; player._lastY = targetY;
  player._velX = 0; player._velY = 0;
  player._lastDeathX = null; player._lastDeathY = null;
  // R2 — go through Input so trigger edge state stays consistent. The
  // new pilot must press mouse fresh before firing (releaseTrigger
  // clears both .down AND ._wasDown).
  if (typeof Input !== 'undefined' && Input.releaseTrigger) {
    Input.releaseTrigger();
  } else if (typeof mouse !== 'undefined') {
    mouse.down = false;
  }
  applyWeaponToPlayer(targetWeapon);
  player.hp = targetHp;   // applyWeaponToPlayer doesn't touch HP — be explicit
  // Phase 4: SEED follows the body. Player inherits the target ally's SEED
  // (almost always 0 since it was AI-driven, unless the player previously
  // built it up and swapped back into a body they once piloted).
  player._seed = targetSeed;
  player._humanPiloted = true;

  // Phase 102 — instant camera cut. Without this, updateCamera() lerps
  // at 0.18/frame for any move > 60u, which the user perceived as 'the
  // ally body is sliding toward me' (camera-relative motion looks like
  // world motion when the player is screen-centered). Snapping camera
  // to the new player position cuts that perceptual ambiguity — view
  // simply jumps to the new vehicle's location, no slide.
  if (typeof camera !== 'undefined') {
    camera.x = player.x;
    camera.y = player.y;
  }

  // Phase 102 — tell the authoritative server we just teleported. Without
  // this the server keeps simulating us at the OLD position and the next
  // snapshot would reconcile us back. The server handler clears its
  // lag-comp history + grants spawn-protection so peers can't insta-kill
  // us by aiming at the OLD position. botId is 0 here because allies[]
  // are client-side NN units, not server bots; a future hook for
  // _mpState.remoteBots-targeted swap would pass the actual id.
  if (typeof _mpBroadcastSwap === 'function') {
    _mpBroadcastSwap(player.x, player.y, 0);
  }

  showSwapToast(`${wasResurrected ? T('紧急接管', 'EMERGENCY SWAP') : T('接管', 'SWAP')} ${targetCallsign}`);
  playSfx('countdown', { freq: 1320, vol: 0.45 });
}

// R4 — auto-swap-on-death entry. Finds the closest alive ally and
// delegates to swapPlayerToAlly. Used by the NN_DEATHMATCH respawn
// loop in place of its previous ~70 lines of inlined logic (which
// silently diverged from swapPlayerToAlly — e.g. didn't set
// _mpIgnoreReconcileUntil and didn't call _mpBroadcastSwap, so MP
// peers saw a 0.5 s teleport back to the death spot after every
// auto-swap. Consolidating fixes that latent MP bug for free).
//
// Returns true if a swap happened; caller falls back to a normal
// respawn timer when false.
function tryAutoSwapToClosestAlly() {
  if (typeof game === 'undefined' || !game._nnMode) return false;
  if (typeof allies === 'undefined' || !allies) return false;
  if (typeof player === 'undefined' || !player) return false;
  let bestIdx = -1, bestD = Infinity;
  for (let i = 0; i < allies.length; i++) {
    const ax = allies[i];
    if (!ax || !ax.alive) continue;
    // Phase 129c — defence-in-depth: explicitly reject anything marked
    // dead by any other flag. Redundant against the alive check above
    // (_consumed slots always have alive: false; _respawnAt != null
    // implies alive: false) but spells out the user's rule:
    //   "緊急切換絕不能切到之前死亡的載具，否則一切會出問題"
    if (ax._consumed) continue;
    if (ax._respawnAt != null) continue;
    const d = Math.hypot(ax.x - player.x, ax.y - player.y);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  if (bestIdx < 0) return false;
  swapPlayerToAlly(bestIdx);
  return true;
}

// Small top-center toast for pawn-swap feedback — replaces the full-width
// "接管 BRAVO" center banner that used to block view of the action while
// the player was rapid-switching between bodies.
function showSwapToast(text, ttl = 75) {
  // Default 75 ticks (~1.25s) for swap/command confirmations. Callers that
  // need reading time (e.g. stage_hints tutorial tips) pass a larger ttl;
  // hud.js auto-sizes the chip width to the text either way.
  game._swapToast = { text, ttl };
}

// Phase 133.3 — handleLocalDeath moved to js/death_decider.js.
// The death-decision logic owns its own state now (lastAutoSwapAt
// timestamp for chain-loop guard), so MP auto-swap can be re-enabled
// safely. See death_decider.js for the new home + the rationale for
// the Phase 129c → 129c-rev → 133.3 evolution.
