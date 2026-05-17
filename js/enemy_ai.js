// ============ ENEMY AI / NN RUNTIME (R9 refactor) ============
// All neural-network observation building, action decoding, patrol state
// machine, heat map, team vision, per-frame batch inference, and the
// rule-based updateEnemies tick. Pulled out of the 12 000-line inline
// script (now ~9 900). Pre-extraction this block was 1 145+ lines of
// closely-coupled state — every NN tuning change had to scroll past
// HUD / bullet / world code.
//
// Functions moved:
//   nnIsVisible / nnNearestVisibleEnemy / nnUnitOverlapsBuilding
//     — geometry probes the NN obs uses
//   nnBuildObs (105L) — pack one unit's view into the NN input float
//     buffer (positions, velocities, line-of-sight flags, last-seen
//     coords). Mirrors data when flipX=true to reuse the same network
//     for either team.
//   nnApplyAction (214L) — decode an 18-class action into movement
//     vector + fire bit, push the unit, sweep wall slide, stuck-breaker,
//     arena clamp, etc.
//   _nnHasRecentDetection / _nnNoteHit / _nnUpdateAiMode — the patrol
//     ↔ combat state machine that frames the PPO model's outputs.
//   _nnHeatIdx / _nnHeatTick — arena occupancy heat map used to bias
//     patrol waypoint selection away from over-trodden cells.
//   _nnPickPatrolTarget / _nnRunPatrol — patrol waypoint chase logic.
//   updateTeamVision — pre-pass to set _spottedByBlue / _spottedByRed
//     so squad members share sightings.
//   nnTick (104L) — per-frame batch dispatcher: collect NN units, run
//     one ONNX inference for all of them, dispatch actions.
//   updateEnemies (305L) — the rule-based (non-NN) enemy update tick,
//     still used for any non-NN spawn (rare in NN arena, common in
//     campaign + early prototypes).
//
// External deps (resolved at call-time via classic-script globals):
//   player · enemies · allies · drone · fpv · game · bullets ·
//   enemyBullets · NN · WEAPONS · NN_ARENA · NN_WEAPON_POOL ·
//   isVisibleToFriendly · isVisibleToEnemy · lineOfSight · angleInCone ·
//   effectiveArc · _applyDamageToUnit · _spawnBullet · applyRecoil ·
//   showDamagePopup · createExplosion · emitSound · _pushOutOfWalls ·
//   _pushOutOfStructure · _pushOutOfBuilding · _maybeStumble · etc.

function nnIsVisible(me, target) {
  if (!target.alive) return false;
  // Squad vision: cross-team spotting through teammates (set per tick)
  const meTeam = me.team || 0, tgtTeam = target.team || 0;
  if (meTeam !== tgtTeam) {
    if (meTeam === 0 && target._spottedByBlue) return true;
    if (meTeam === 1 && target._spottedByRed)  return true;
  }
  const dx = target.x - me.x, dy = target.y - me.y;
  const d2 = dx*dx + dy*dy;
  if (d2 > NN.VIEW_RANGE * NN.VIEW_RANGE) return false;
  const dist = Math.sqrt(d2);
  const a = Math.atan2(dy, dx);
  let diff = a - me.angle;
  while (diff >  Math.PI) diff -= Math.PI*2;
  while (diff < -Math.PI) diff += Math.PI*2;
  if (Math.abs(diff) > effectiveArc(dist) / 2) return false;
  if (!lineOfSight(me.x, me.y, target.x, target.y)) return false;
  return true;
}

// Build the 65-dim observation EXACTLY matching ai_arena/combat_env.py _build_obs_for_unit.
// `me` is the unit asking, `friendlies` and `enemies` are arrays of units (alive or not).
// `flipX = true` mirrors observations across the vertical axis of the arena.
// The model was trained only on team-0 data (blue, spawning on the LEFT side
// of NN_ARENA), so for team-1 units (red, spawning on the RIGHT side) we
// mirror everything so they look like blue to the model — then mirror the
// resulting action back so "move E" becomes "move W" in world coords.
function nnBuildObs(me, friendlies, enemies, outBuf, flipX = false) {
  const obs = outBuf;
  let i = 0;
  const W = NN.WORLD_W, H = NN.WORLD_H;
  // Flip helpers: when flipX, x_world is reflected across the arena's vertical center.
  const meX = flipX ? (W - me.x) : me.x;
  const flipDX = flipX ? -1 : 1;
  // sin(π - a) = sin(a), cos(π - a) = -cos(a) → flip cos only
  const cosFlip = flipX ? -1 : 1;

  // --- Self (8) ---
  obs[i++] = meX / W * 2 - 1;
  obs[i++] = me.y / H * 2 - 1;
  obs[i++] = Math.sin(me.angle);
  obs[i++] = Math.cos(me.angle) * cosFlip;
  obs[i++] = me.alive ? me.hp / NN.PLAYER_HP : 0;
  obs[i++] = (me._nnRecentDmg || 0) > 0 ? 1 : 0;
  obs[i++] = me._nnFireCd > 0 ? me._nnFireCd / NN.FIRE_CD : 0;
  obs[i++] = me.alive ? 1 : 0;

  // --- Visible enemies × 3 (6 each = 18) ---
  const enemySorted = enemies.filter(e => e.alive).slice().sort((a, b) => {
    const va = nnIsVisible(me, a) ? 1 : 0;
    const vb = nnIsVisible(me, b) ? 1 : 0;
    if (va !== vb) return vb - va;
    return Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y);
  });
  for (let k = 0; k < 3; k++) {
    if (k < enemySorted.length) {
      const e = enemySorted[k];
      obs[i++] = (e.x - me.x) / W * 2 * flipDX;
      obs[i++] = (e.y - me.y) / H * 2;
      obs[i++] = Math.hypot(e.x - me.x, e.y - me.y) / W;
      obs[i++] = e.hp / NN.PLAYER_HP;
      obs[i++] = nnIsVisible(me, e) ? 1 : 0;
      obs[i++] = 0;
    } else {
      i += 6; // zero-padded
    }
  }

  // --- Friendly teammates × 2 (6 each = 12) ---
  const teammates = friendlies.filter(f => f !== me).sort((a, b) =>
    Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
  for (let k = 0; k < 2; k++) {
    if (k < teammates.length) {
      const t = teammates[k];
      obs[i++] = (t.x - me.x) / W * 2 * flipDX;
      obs[i++] = (t.y - me.y) / H * 2;
      obs[i++] = Math.hypot(t.x - me.x, t.y - me.y) / W;
      obs[i++] = t.alive ? t.hp / NN.PLAYER_HP : 0;
      obs[i++] = t.alive ? 1 : 0;
      obs[i++] = nnIsVisible(me, t) ? 1 : 0;
    } else {
      i += 6;
    }
  }

  // --- Cover points × 5 (3 each = 15) ---
  const cps = coverPoints.slice().sort((a, b) =>
    (a.x - me.x)**2 + (a.y - me.y)**2 - ((b.x - me.x)**2 + (b.y - me.y)**2));
  for (let k = 0; k < 5; k++) {
    if (k < cps.length) {
      const cp = cps[k];
      obs[i++] = (cp.x - me.x) / W * 2 * flipDX;
      obs[i++] = (cp.y - me.y) / H * 2;
      obs[i++] = Math.hypot(cp.x - me.x, cp.y - me.y) / W;
    } else {
      i += 3;
    }
  }

  // --- Last seen enemy intel (4) ---
  if (me._nnLastSeenTick != null && me._nnLastSeenTick > -9999) {
    obs[i++] = (me._nnLastSeenX - me.x) / W * 2 * flipDX;
    obs[i++] = (me._nnLastSeenY - me.y) / H * 2;
    obs[i++] = Math.min(1, (game.time - me._nnLastSeenTick) / 90);
    obs[i++] = 1;
  } else {
    i += 4;
  }

  // --- Last sound (4) ---
  if (NN.lastSound) {
    const s = NN.lastSound;
    obs[i++] = (s.x - me.x) / W * 2 * flipDX;
    obs[i++] = (s.y - me.y) / H * 2;
    obs[i++] = Math.max(0, 1 - (game.time - s.tick) / 90);
    obs[i++] = (s.team === me.team) ? 1 : -1;
  } else {
    i += 4;
  }

  // --- Match state (4) ---
  // We don't have a strict match clock in skirmish; use a 60s rolling window.
  const matchTicks = 60 * 60;
  const elapsed = (game.time - (game._nnEpochStart || 0));
  obs[i++] = Math.max(0, 1 - elapsed / matchTicks);
  obs[i++] = (game._nnTeamKills?.[me.team] || 0) / 20;
  obs[i++] = (game._nnTeamKills?.[1 - me.team] || 0) / 20;
  const aliveTeam = friendlies.filter(f => f.alive).length;
  obs[i++] = aliveTeam / 3;

  return i; // should be 65
}

// Returns true if the unit's current AABB overlaps any building.
function nnUnitOverlapsBuilding(unit, radius) {
  for (const b of buildings) {
    if (unit.x > b.x - radius && unit.x < b.x+b.w+radius &&
        unit.y > b.y - radius && unit.y < b.y+b.h+radius) return true;
  }
  // Wall-lines: capsule overlap test
  for (const w of wallLines) {
    if (w.hp <= 0) continue;
    const pad = w.thickness / 2 + radius;
    const r = _segPointDist(unit.x, unit.y, w.x1, w.y1, w.x2, w.y2);
    if (r.dist < pad) return true;
  }
  return false;
}

// ============ SQUAD COMMANDS ============
// → Moved to js/squad_commands.js. Declares globally:
//     SQUAD_ORDER_DURATION · SQUAD_ORDERS (7-order table)
//     issueSquadOrder(id) · _squadOrderActive()
//     _vectorToMoveDir(dx, dy) · _squadOrderMoveDirFor(...)
// Used by nnApplyAction below + the TAB+number key-bindings.

// Apply a discrete action (0..17) to a unit. Mirrors combat_env._apply_action,
// but also handles "stuck on wall" — the trained model sometimes confidently
// picks a direction that's blocked by a wall, so we slide along the wall and
// nudge perpendicularly if the unit hasn't progressed.
function nnApplyAction(unit, action, friendlies, enemies) {
  if (!unit.alive) return;
  const r = unit.radius || 14;
  const speed = NN.PLAYER_SPEED;
  let moveDir = action >> 1;        // 0..8
  let fire = action & 1;            // 0|1

  // Squad order override — only player-team NN allies. Old check was
  // `friendlies.indexOf(player) >= 0` which looked right but the player
  // is NEVER pushed to `allies` (allies = NN companions only, player is
  // its own slot), so the check ALWAYS returned false → squad orders
  // were dead code, allies ignored every TAB+1-7 input. User report:
  // '隊友無隨指令行動'. Fix: directly test whether unit is in the
  // global `allies` array.
  if (_squadOrderActive() && allies.indexOf(unit) >= 0 && unit !== player) {
    const orderId = game._squadOrder.id;
    const orderDir = _squadOrderMoveDirFor(unit, friendlies, enemies, orderId);
    if (orderDir != null) moveDir = orderDir;
    if (orderId === 'suppress') fire = 1;             // always fire while suppressing
    if (orderId === 'attack')   fire = action & 1;    // keep NN's fire bit
    if (orderId === 'retreat')  fire = 0;             // don't shoot while breaking contact
  }

  // Pursue-last-seen fallback: when NN chose idle (moveDir=0) AND has no
  // currently visible target, push toward where this unit last saw an enemy.
  // Without this, a player-drawn wall that breaks LoS makes both teams sit
  // motionless and never re-engage — the user reports it as '別人像木偶
  // 一樣都沒有攻擊'. Memory window: 4 s (240 ticks); min push distance: 60u.
  if (moveDir === 0
      && unit._nnLastSeenTick != null
      && unit._nnLastSeenTick > game.time - 240
      && unit._nnLastSeenX != null) {
    const visTgt = nnNearestVisibleEnemy(unit, enemies);
    if (!visTgt) {
      const dx = unit._nnLastSeenX - unit.x;
      const dy = unit._nnLastSeenY - unit.y;
      if (Math.hypot(dx, dy) > 60) {
        moveDir = _vectorToMoveDir(dx, dy);
      }
    }
  }

  // Phase 97 — anti-clump for NN combat. The PPO model never learned spacing
  // (training spawned bots far apart), so in combat 3-4 bots converge on the
  // same enemy and pile up on the same tile. If we'd move TOWARD a teammate
  // within 45u, rotate the moveDir 45° AWAY from them so the squad spreads.
  // Skipped during squad orders so RALLY / formations aren't broken.
  // User '不擠成一團'.
  if (moveDir !== 0 && !_squadOrderActive()) {
    let nearestMate = null, nearestD2 = 45 * 45;
    for (const m of friendlies) {
      if (m === unit || !m.alive) continue;
      const ddx = m.x - unit.x, ddy = m.y - unit.y;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < nearestD2) { nearestD2 = d2; nearestMate = m; }
    }
    if (nearestMate) {
      const [mdx, mdy] = NN.MOVE_DIRS[moveDir] || [0, 0];
      const mateDx = nearestMate.x - unit.x, mateDy = nearestMate.y - unit.y;
      // dot > 0 → moveDir points toward mate. Rotate ±45° away.
      if (mdx * mateDx + mdy * mateDy > 0) {
        // cross product sign tells us which side the mate is on; rotate
        // the opposite way so we curve around them.
        const crossSign = (mdx * mateDy - mdy * mateDx) >= 0 ? -1 : 1;
        moveDir = ((moveDir - 1 + crossSign + 8) % 8) + 1;
      }
    }
  }

  // Stuck breaker: if this unit has been stuck (<2u progress) for >=12 ticks
  // (Phase 97 — was 20, faster reaction) while NN keeps trying to move,
  // override with a random non-blocked dir. Persistent wedging (3+ triggers
  // without recovery) clears the patrol target so the next picker rolls a
  // fresh waypoint far from the wedge spot — breaks the 'bot rams the same
  // wall corner for 8s straight' loop the user reported as '卡住'.
  unit._nnStuckCt = unit._nnStuckCt || 0;
  unit._nnStuckTriggers = unit._nnStuckTriggers || 0;
  if (moveDir !== 0 && unit._nnStuckCt > 12) {
    // Try perpendicular dirs (rotate 90° each way) until one would clear a wall
    const rotations = [2, -2, 4, -4, 1, -1];   // ±90°, ±180°, ±45° (in 45° steps)
    for (const off of rotations) {
      let trialDir = ((moveDir - 1 + off) % 8 + 8) % 8 + 1;   // stays in 1..8
      const [tdx, tdy] = NN.MOVE_DIRS[trialDir];
      const trialX = unit.x + tdx * speed;
      const trialY = unit.y + tdy * speed;
      const saveX = unit.x, saveY = unit.y;
      unit.x = trialX; unit.y = trialY;
      const blocked = nnUnitOverlapsBuilding(unit, r);
      unit.x = saveX; unit.y = saveY;
      if (!blocked) { moveDir = trialDir; break; }
    }
    unit._nnStuckCt = 0;
    unit._nnStuckTriggers++;
    if (unit._nnStuckTriggers >= 3) {
      // Persistent wedge — repick a fresh patrol target and force a
      // small angular jitter so the next move vector differs from the
      // wedge direction. Without this, the NN keeps choosing the same
      // direction every tick and we stuck-trigger forever.
      unit._patrolTarget = null;
      unit._patrolPauseUntil = 0;
      unit._patrolRetargetAt = 0;
      unit._nnStuckTriggers = 0;
      unit.angle = (unit.angle || 0) + (Math.random() - 0.5) * Math.PI;
    }
  }
  // Decay the trigger counter slowly so an isolated stuck doesn't compound.
  if ((game.time & 63) === 0 && unit._nnStuckTriggers > 0) unit._nnStuckTriggers--;

  const [dx, dy] = NN.MOVE_DIRS[moveDir] || [0, 0];
  const oldX = unit.x, oldY = unit.y;

  if (dx !== 0 || dy !== 0) {
    // Axis-decoupled movement: try X then Y separately so a diagonal blocked
    // on one axis still slides along the wall on the other.
    const tryX = oldX + dx * speed;
    unit.x = tryX;
    if (nnUnitOverlapsBuilding(unit, r)) unit.x = oldX;
    const tryY = oldY + dy * speed;
    unit.y = tryY;
    if (nnUnitOverlapsBuilding(unit, r)) unit.y = oldY;
    unit.angle = Math.atan2(dy, dx);
    unit.walkPhase = (unit.walkPhase || 0) + 0.18;
  } else {
    // Idle but visible enemy: slowly aim at it
    const tgt = nnNearestVisibleEnemy(unit, enemies);
    if (tgt) {
      const desired = Math.atan2(tgt.y - unit.y, tgt.x - unit.x);
      let d = desired - unit.angle;
      while (d > Math.PI) d -= Math.PI*2;
      while (d < -Math.PI) d += Math.PI*2;
      unit.angle += d * NN.AIM_LERP;
    }
  }

  // Track progress for the stuck-breaker (only count when NN tried to move)
  if (moveDir !== 0) {
    const progressed = Math.hypot(unit.x - oldX, unit.y - oldY);
    if (progressed < 0.5) unit._nnStuckCt++;
    else unit._nnStuckCt = 0;
  }

  // Clamp to NN arena play area, then a final wall push as a safety net
  unit.x = Math.max(NN_ARENA.x0 + 20, Math.min(NN_ARENA.x0 + NN_ARENA.w - 20, unit.x));
  unit.y = Math.max(NN_ARENA.y0 + 20, Math.min(NN_ARENA.y0 + NN_ARENA.h - 20, unit.y));
  pushOutOfBuildings(unit, r);

  // Decrement fire cooldown
  if (unit._nnFireCd > 0) unit._nnFireCd--;
  if (unit._nnRecentDmg > 0) unit._nnRecentDmg--;
  // Phase 21: invuln mutes the trigger for NN units too. Aligns with the
  // player + ally + FSM enemy fire-gate so the spawn shield never doubles
  // as a one-way snipe window.
  const _nnInvuln = unit._invulnUntil != null && game.time < unit._invulnUntil;
  if (_nnInvuln) return;

  if (fire && unit._nnFireCd <= 0) {
    const tgt = nnNearestVisibleEnemy(unit, enemies);
    if (tgt && lineOfSight(unit.x, unit.y, tgt.x, tgt.y)) {
      const w = unit._weapon || WEAPONS.RIFLE;
      // Target leading: predict where the target will be when the bullet
      // arrives. Uses the velocity tracked at the start of update(). Without
      // this, NN bullets always miss a strafing player because the bullet
      // takes (dist / bulletSpeed) frames to arrive — at d=200 + RIFLE bullet
      // speed 14, that's 14 frames, during which the player moves 14 × 2.8 =
      // 40 units. Imperfect prediction (target also accelerates / changes
      // direction) but cuts the error roughly 5×.
      const dx0 = tgt.x - unit.x, dy0 = tgt.y - unit.y;
      const dist0 = Math.hypot(dx0, dy0);
      const flightTime = dist0 / w.bulletSpeed;
      const tvx = tgt._velX || 0, tvy = tgt._velY || 0;
      const leadX = tgt.x + tvx * flightTime;
      const leadY = tgt.y + tvy * flightTime;
      const aimSpread = 0.05;
      const aim = Math.atan2(leadY - unit.y, leadX - unit.x) + (Math.random() - 0.5) * aimSpread;
      unit.angle = aim;
      // Use team to pick the right bullet pool. unit.team 0 = friendly, 1 = hostile.
      // Previous bug: relied on `friendlies.includes(unit)` which is also true for
      // an enemy NN unit (its dispatcher passes the enemies array as `friendlies`),
      // so enemy bullets ended up in the friendly array and never damaged us.
      const isFriendlyTeam = unit.team === 0 || unit === player;
      const isAlly = isFriendlyTeam && unit !== player;
      const isPlayer = unit === player;
      const bulletList = isFriendlyTeam ? bullets : enemyBullets;
      // NN units use whatever weapon they were assigned at spawn (random
      // from the player weapon pool — see assignNNWeapon). Fall back to
      // RIFLE if somehow unassigned. Spread + pellets honored, so NN
      // shotgunners spray and NN snipers hit hard but rarely.
      const pellets = w.pellets || 1;
      for (let i = 0; i < pellets; i++) {
        const a = (pellets > 1)
          ? aim + (Math.random() - 0.5) * w.spread
          : aim;
        bulletList.push({
          x: unit.x + Math.cos(a) * 16,
          y: unit.y + Math.sin(a) * 16,
          vx: Math.cos(a) * w.bulletSpeed,
          vy: Math.sin(a) * w.bulletSpeed,
          life: w.bulletLife,
          damage: w.damage,
          fromAlly: isAlly,
          fromUnit: unit,
          weaponName: w.name,
        });
      }
      muzzleFlashes.push({ x: unit.x + Math.cos(aim)*22, y: unit.y + Math.sin(aim)*22, angle: aim, life: 5 });
      unit._nnFireCd = w.fireCd;
      unit._nnLastSeenX = tgt.x;
      unit._nnLastSeenY = tgt.y;
      unit._nnLastSeenTick = game.time;
      NN.lastSound = { x: unit.x, y: unit.y, tick: game.time, team: unit.team || 0 };
      emitSound(unit.x, unit.y, w.soundIntensity || 1300, isPlayer || isAlly, false, w.soundProfile);
    }
  }
}

function nnNearestVisibleEnemy(me, enemies) {
  let best = null, bestD2 = Infinity;
  for (const e of enemies) {
    if (!e.alive || e === me) continue;
    if (!nnIsVisible(me, e)) continue;
    const d2 = (e.x - me.x)**2 + (e.y - me.y)**2;
    if (d2 < bestD2) { best = e; bestD2 = d2; }
  }
  if (best) {
    me._nnLastSeenX = best.x;
    me._nnLastSeenY = best.y;
    me._nnLastSeenTick = game.time;
  }
  return best;
}

// ============ Phase 61 — PATROL / COMBAT STATE MACHINE ============
// Why this exists: the PPO model was trained on scenarios where there is
// ALWAYS a visible enemy. When no enemy is in view (or in last-seen / sound
// memory), the observation collapses to zero-padded enemy slots and the
// network outputs a near-degenerate action — empirically it biased every
// idle unit toward the same screen corner ('卡到左下角或右下角' per user).
//
// Fix: gate NN inference on actual detection. When a unit has no visible
// enemy AND no recent intel AND no recent enemy sound, switch to a hand-
// coded patrol that walks between waypoints (random arena point or cover
// point). NN inference only runs while in combat. Combat→patrol transition
// fires after COMBAT_TIMEOUT_TICKS of zero detection (~15s) so a short
// LoS break doesn't kick a still-engaged unit back to patrol immediately.
const NN_AI = {
  COMBAT_TIMEOUT_TICKS:  15 * 60,   // 15s of no detection → patrol
  SOUND_DETECTION_TICKS: 90,        // enemy gunshot heard < 1.5s ago = detection
  LAST_SEEN_WINDOW:      240,       // 4s of stale 'last seen' still counts as detection
  // Phase 64: looser patrol — bigger reach radius so units don't stall
  // exactly on the waypoint, more variance in retarget timing so a squad
  // doesn't sync-tick its waypoints, and three distinct waypoint sources
  // (wander offset, cover point, center-biased random) so movement reads
  // as exploration not stamping a grid. PATROL_COVER_BIAS dropped from
  // 0.70 → 0.25 (was clumping bots on the same handful of cover spots
  // → 'stuck in the corner' look the user reported).
  PATROL_RETARGET_MIN:   4 * 60,
  PATROL_RETARGET_MAX:   12 * 60,
  PATROL_REACH_DIST:     55,        // 40 → 55: stop chasing exact coords
  PATROL_COVER_BIAS:     0.25,
  PATROL_WANDER_BIAS:    0.50,      // 50%: random offset from current pos
  PATROL_WANDER_MIN:     120,       // 120-260u wander step (further than reach)
  PATROL_WANDER_MAX:     260,
  PATROL_PAUSE_CHANCE:   0.35,      // 35% chance to briefly idle on retarget
  PATROL_PAUSE_MIN:      30,        // 0.5–1.5s pause = look-around beat
  PATROL_PAUSE_MAX:      90,
  PATROL_JITTER_CHANCE:  0.15,      // 15% of frames: off-axis step
};

// Detection: visible enemy NOW, recent last-seen, or recent enemy gunshot.
// Phase 97 — when sound is the only signal, ALSO seed last-seen X/Y from
// the gunshot source so the pursue-last-seen branch inside nnApplyAction
// actually drives the unit toward the noise (was: detection flag flipped
// but unit had no coordinates to push toward → still stood around).
function _nnHasRecentDetection(unit, hostile) {
  if (nnNearestVisibleEnemy(unit, hostile)) return true;
  if (unit._nnLastSeenTick != null
      && unit._nnLastSeenTick > game.time - NN_AI.LAST_SEEN_WINDOW) return true;
  if (NN.lastSound
      && NN.lastSound.team !== unit.team
      && (game.time - NN.lastSound.tick) < NN_AI.SOUND_DETECTION_TICKS) {
    const haveFresher = unit._nnLastSeenTick != null
                     && unit._nnLastSeenTick > NN.lastSound.tick;
    if (!haveFresher && NN.lastSound.x != null && NN.lastSound.y != null) {
      unit._nnLastSeenX = NN.lastSound.x;
      unit._nnLastSeenY = NN.lastSound.y;
      unit._nnLastSeenTick = NN.lastSound.tick;
    }
    return true;
  }
  return false;
}

// Phase 97/98 — wake an NN unit when it takes a bullet, then propagate
// the alert to its squad. The point of this whole helper is to FORCE
// the unit into the ONNX inference batch on the next nnTick:
//
//   _nnNoteHit  →  _aiMode='combat'  +  _nnLastSeenTick=now
//        ↓                                       ↓
//   next nnTick → _nnUpdateAiMode → _nnHasRecentDetection returns true
//                                       (LAST_SEEN_WINDOW is 240 ticks)
//        ↓
//   _aiMode stays 'combat'  →  unit pushed into nnUnits[]  →  ONNX runs
//
// nnBuildObs encodes _nnLastSeenX/Y into the obs (4-dim "last seen
// enemy intel" block, dims 53-56), so the trained policy reacts to
// the back-traced shooter direction even when the unit can't actually
// see them yet — that's what 'infer direction and fight' looks like
// when the shooter is behind cover. User '重點是要進入戰鬥狀態(onnx)'.
//
// Squad awareness: teammates within 200u of the hit unit inherit the
// same intel + combat state so a single bullet wakes the whole fire
// team, not just the one bot that got hit. Matches a real squad
// reacting to a buddy taking fire ('我希望nn會因為事件...察覺動靜').
function _nnNoteHit(unit, bullet) {
  if (!unit || !unit._useNN || !unit.alive || !bullet) return;
  // Back-trace ~6 frames so we point AT the shooter, not next to them.
  const srcX = bullet.x - (bullet.vx || 0) * 6;
  const srcY = bullet.y - (bullet.vy || 0) * 6;
  unit._nnLastSeenX = srcX;
  unit._nnLastSeenY = srcY;
  unit._nnLastSeenTick = game.time;
  unit._aiMode = 'combat';
  unit._combatLastActiveAt = game.time;
  unit._nnRecentDmg = 90;           // 1.5s 'under fire' flag (ONNX obs dim 5)
  unit._patrolPauseUntil = 0;
  unit.angle = Math.atan2(srcY - unit.y, srcX - unit.x);

  // Phase 98 — squad-awareness ripple. Same-team NN units within 200u
  // (within shouting distance) flip into combat with the same shooter
  // intel. Only overwrites their last-seen memory if it's staler than
  // a second old — keeps fresher self-spotted intel from being clobbered.
  const SQUAD_ALERT_R2 = 200 * 200;
  const mates = (unit.team === 0)
    ? (typeof allies !== 'undefined' ? allies : [])
    : (typeof enemies !== 'undefined' ? enemies : []);
  for (const m of mates) {
    if (m === unit || !m || !m._useNN || !m.alive) continue;
    const ddx = m.x - unit.x, ddy = m.y - unit.y;
    if (ddx * ddx + ddy * ddy > SQUAD_ALERT_R2) continue;
    m._aiMode = 'combat';
    m._combatLastActiveAt = game.time;
    m._patrolPauseUntil = 0;
    const stale = m._nnLastSeenTick == null
               || m._nnLastSeenTick < game.time - 60;
    if (stale) {
      m._nnLastSeenX = srcX;
      m._nnLastSeenY = srcY;
      m._nnLastSeenTick = game.time;
    }
  }
}

// State transition. Sets unit._aiMode ∈ {'patrol', 'combat'}. Detection
// keeps refreshing the combat-active timestamp; once that timestamp ages
// past COMBAT_TIMEOUT_TICKS without a fresh detection we drop to patrol.
function _nnUpdateAiMode(unit, hostile) {
  if (unit._aiMode == null) unit._aiMode = 'patrol';   // cold start
  const detected = _nnHasRecentDetection(unit, hostile);
  if (detected) {
    unit._aiMode = 'combat';
    unit._combatLastActiveAt = game.time;
  } else if (unit._aiMode === 'combat') {
    const since = game.time - (unit._combatLastActiveAt || 0);
    if (since > NN_AI.COMBAT_TIMEOUT_TICKS) {
      unit._aiMode = 'patrol';
      unit._patrolTarget = null;        // re-pick on first patrol tick
    }
  }
}

// Phase 79 — arena occupancy heatmap. Each cell of a 6×6 grid tracks how
// long units have been there (decays exponentially). Patrol picker SUBTRACTS
// the heat score so frequently-visited cells become unappealing waypoints.
// Creates a negative-feedback loop: wherever bots cluster → heat rises →
// next picks avoid it → distribution spreads back out toward even cover.
// 'Long-term recovery from disturbance' = exactly this kind of relaxation
// toward uniform after a combat-driven local concentration.
const NN_HEAT = {
  GRID:    6,                        // 6×6 cells over the arena
  DECAY:   0.992,                    // per frame → ~half-life ~85 frames (1.4s)
                                     // → cells cool over ~5-10 seconds visibly
  DEPOSIT: 1.0,                      // heat added per bot per frame in its cell
  SCALE:   0.06,                     // candidate scoring weight (heat * this)
};
const _nnHeatmap = new Float32Array(NN_HEAT.GRID * NN_HEAT.GRID);

function _nnHeatIdx(x, y) {
  if (typeof NN_ARENA === 'undefined') return 0;
  const fx = (x - NN_ARENA.x0) / NN_ARENA.w;
  const fy = (y - NN_ARENA.y0) / NN_ARENA.h;
  const gx = Math.max(0, Math.min(NN_HEAT.GRID - 1, Math.floor(fx * NN_HEAT.GRID)));
  const gy = Math.max(0, Math.min(NN_HEAT.GRID - 1, Math.floor(fy * NN_HEAT.GRID)));
  return gy * NN_HEAT.GRID + gx;
}
// Per-frame: decay everything, then deposit at each NN unit's cell.
// Tick rate is fine at the inference cadence (every-other-frame in nnTick)
// so we call this inside nnTick rather than the main update loop.
function _nnHeatTick() {
  for (let i = 0; i < _nnHeatmap.length; i++) _nnHeatmap[i] *= NN_HEAT.DECAY;
  if (typeof allies !== 'undefined') {
    for (const a of allies) {
      if (a && a.alive && a._useNN) _nnHeatmap[_nnHeatIdx(a.x, a.y)] += NN_HEAT.DEPOSIT;
    }
  }
  if (typeof enemies !== 'undefined') {
    for (const e of enemies) {
      if (e && e.alive && e._useNN) _nnHeatmap[_nnHeatIdx(e.x, e.y)] += NN_HEAT.DEPOSIT;
    }
  }
}

// Pick a new patrol waypoint. Phase 79 — TWO meaningful changes from
// Phase 72:
//   1. WANDER is now arena-wide (random anywhere in arena) instead of
//      offset-from-current-position. A bot stuck in BL no longer has
//      all its candidates locked to BL — it can pick TR / TL / BR freely.
//      Anti-herd alone couldn't break the BL cluster because no candidate
//      was even GENERATED far from BL.
//   2. HEATMAP SCORING — candidates lose score proportional to how hot
//      their cell is. Combat naturally heats the firefight area, but as
//      bots disperse afterward, the heat decays and the area becomes
//      pickable again. Long-term equilibrium ≈ uniform distribution.
function _nnPickPatrolTarget(unit) {
  const pad = 120;
  const pickOne = () => {
    const r = Math.random();
    if (r < NN_AI.PATROL_WANDER_BIAS) {
      // Phase 79 — arena-wide random (was 'offset from current position').
      // Breaks the cluster-lock where a BL bot only ever wandered in BL.
      return {
        x: NN_ARENA.x0 + pad + Math.random() * (NN_ARENA.w - 2 * pad),
        y: NN_ARENA.y0 + pad + Math.random() * (NN_ARENA.h - 2 * pad),
      };
    }
    if (coverPoints.length > 0 && r < NN_AI.PATROL_WANDER_BIAS + NN_AI.PATROL_COVER_BIAS) {
      const cp = coverPoints[Math.floor(Math.random() * coverPoints.length)];
      return { x: cp.x, y: cp.y };
    }
    // Center-biased random (anti-edge bias).
    const cx = NN_ARENA.x0 + NN_ARENA.w / 2;
    const cy = NN_ARENA.y0 + NN_ARENA.h / 2;
    const ang  = Math.random() * Math.PI * 2;
    const rad  = Math.random() * (NN_ARENA.w * 0.30);
    return { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad };
  };

  const teamRoster = (unit.team === 0)
    ? [...allies, ...(player.alive ? [player] : [])]
    : enemies;

  // Generate 6 candidates (was 4) — wider search now that wander is arena-
  // wide; more variety amortizes to better spread.
  let best = null, bestScore = -Infinity;
  for (let i = 0; i < 6; i++) {
    const c = pickOne();
    let score = Math.random() * 0.5;
    // (a) anti-herd from teammates' targets
    for (const t of teamRoster) {
      if (t === unit || !t.alive) continue;
      const tgt = t._patrolTarget;
      if (!tgt) continue;
      const dd = Math.hypot(c.x - tgt.x, c.y - tgt.y);
      score += Math.min(dd, 300) / 100;
    }
    // (b) anti-pattern from own last target
    if (unit._patrolTarget) {
      const dd = Math.hypot(c.x - unit._patrolTarget.x, c.y - unit._patrolTarget.y);
      score += Math.min(dd, 250) / 100;
    }
    // (c) Phase 79 — heatmap penalty. Hot cells (recently inhabited) get
    // a strong negative. A fully saturated cell (~333) yields -20 score,
    // dominating the +up-to-15 anti-herd reward — guarantees a hot BL
    // can't keep winning every roll.
    score -= _nnHeatmap[_nnHeatIdx(c.x, c.y)] * NN_HEAT.SCALE;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

// Per-tick patrol mover. Replaces NN inference for units in 'patrol'
// state. Uses the same nnApplyAction pipeline so stuck-breaker + wall
// slide + arena clamp all apply — no path-finding here, just nudge toward
// the waypoint and let the existing collision response work. Re-target on
// reach OR after retarget timer expires (whichever first).
//
// Phase 64 — three knobs that make patrol read as 'organic' instead of
// 'cron job': (1) a 35% chance to PAUSE for 0.5–1.5s on each retarget,
// idling in place + slow gun rotation; (2) 15% of frames take an off-axis
// step (random ±90° kick) so the path bends instead of going laser-straight
// to the waypoint; (3) bigger reach radius (55u) so units don't twitch on
// the spot trying to land exactly on the waypoint. The user wanted patrol
// to not 'look robotic' — these three together break the visible grid.
function _nnRunPatrol(unit, friendly, hostile) {
  // Pause state: stand still + slow rotate, no movement input.
  if (unit._patrolPauseUntil && game.time < unit._patrolPauseUntil) {
    unit.angle = (unit.angle || 0) + 0.015 * (unit._patrolPauseDir || 1);
    return;
  }
  const needNew = !unit._patrolTarget
    || Math.hypot(unit._patrolTarget.x - unit.x, unit._patrolTarget.y - unit.y) < NN_AI.PATROL_REACH_DIST
    || game.time > (unit._patrolRetargetAt || 0);
  if (needNew) {
    unit._patrolTarget = _nnPickPatrolTarget(unit);
    unit._patrolRetargetAt = game.time + NN_AI.PATROL_RETARGET_MIN
      + Math.random() * (NN_AI.PATROL_RETARGET_MAX - NN_AI.PATROL_RETARGET_MIN);
    // Roll a pause beat — visible "look around" moment between waypoints.
    if (Math.random() < NN_AI.PATROL_PAUSE_CHANCE) {
      unit._patrolPauseUntil = game.time + NN_AI.PATROL_PAUSE_MIN
        + Math.random() * (NN_AI.PATROL_PAUSE_MAX - NN_AI.PATROL_PAUSE_MIN);
      unit._patrolPauseDir = Math.random() < 0.5 ? -1 : 1;
      return;
    }
  }
  let dx = unit._patrolTarget.x - unit.x;
  let dy = unit._patrolTarget.y - unit.y;
  // Off-axis jitter — rotate the direction vector by a random ±90° kick
  // a fraction of frames so the path curves instead of being a straight
  // line to the waypoint.
  if (Math.random() < NN_AI.PATROL_JITTER_CHANCE) {
    const len = Math.hypot(dx, dy);
    const baseAng = Math.atan2(dy, dx);
    const kick = (Math.random() - 0.5) * Math.PI;   // ±90°
    dx = Math.cos(baseAng + kick) * len;
    dy = Math.sin(baseAng + kick) * len;
  }
  const moveDir = _vectorToMoveDir(dx, dy);
  // Fire bit OFF in patrol — bots don't shoot ghosts. Squad orders, stuck-
  // breaker, and clamp logic still run inside nnApplyAction.
  nnApplyAction(unit, moveDir * 2, friendly, hostile);
}

// Per-frame batch dispatcher: collect all NN-controlled units, run one inference, apply actions.
const _nnObsBuf = new Float32Array(NN.OBS_DIM * 16); // up to 16 units
// Mirror an action across the vertical axis (E↔W, NE↔NW, SE↔SW; N/S/idle unchanged).
// Built from action = move_dir * 2 + fire, where move_dirs 1..8 are
// [N, NE, E, SE, S, SW, W, NW]. Mirroring across X swaps E↔W → swaps move_dirs
// (3, 4) ↔ (7, 8) and (2, 5)? Actually: NE↔NW (2↔8), E↔W (3↔7), SE↔SW (4↔6).
// N (1), S (5), idle (0) stay. Fire bit unchanged.
const NN_ACTION_MIRROR_X = [
  /* idle */    0,  1,
  /* N    */    2,  3,
  /* NE   */   16, 17,    // -> NW
  /* E    */   14, 15,    // -> W
  /* SE   */   12, 13,    // -> SW
  /* S    */   10, 11,
  /* SW   */    8,  9,    // -> SE
  /* W    */    6,  7,    // -> E
  /* NW   */    4,  5,    // -> NE
];

// Squad vision: any blue (player/ally/drone) seeing a red unit marks that
// red as spotted-by-blue, and vice versa. NN units on the same team then
// inherit each other's sightings via nnIsVisible's cross-team early-out.
// Refreshed once per nnTick — cheap (≤4 reds × 5 blues = 20 cone+LoS checks).
function updateTeamVision() {
  for (const e of enemies) {
    if (!e.alive) continue;
    e._spottedByBlue = isVisibleToFriendly(e.x, e.y);
  }
  const blueUnits = (player.alive ? [player] : []).concat(allies.filter(a => a.alive));
  for (const t of blueUnits) t._spottedByRed = false;
  for (const r of enemies) {
    if (!r.alive) continue;
    for (const t of blueUnits) {
      if (t._spottedByRed) continue;
      const dx = t.x - r.x, dy = t.y - r.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= NN.VIEW_RANGE * NN.VIEW_RANGE) continue;
      const dist = Math.sqrt(d2);
      if (!angleInCone(r.angle, effectiveArc(dist), r.x, r.y, t.x, t.y)) continue;
      if (!lineOfSight(r.x, r.y, t.x, t.y)) continue;
      t._spottedByRed = true;
    }
  }
}

let _nnInferring = false;
async function nnTick() {
  if (!NN.loaded || _nnInferring) return;
  if (game.state !== 'playing') return;
  // Run NN dispatcher in campaign too if any unit has _useNN flagged. The
  // skirmish path sets game._nnMode and pre-flags every unit; the campaign
  // path now opts individual enemies in (spawnSoldier + spawnDroneEnemy
  // tag them with _useNN so they share the trained brain instead of the
  // legacy state machine). User asked for the merge: '把這個做融合,就是
  // 我們現在的NN跟現在的戰役的這個他們原本的程式做融合'.
  if (!game._nnMode) {
    const anyNN =
      enemies.some(e => e.alive && e._useNN)
      || allies.some(a => a.alive && a._useNN);
    if (!anyNN) return;
  }

  // Refresh team-shared spotting before any nnIsVisible call this tick
  updateTeamVision();
  // Phase 79 — tick the arena occupancy heatmap. Cheap (decay = ~36 mults,
  // deposit = ~6-10 unit lookups). Drives patrol picker's anti-cluster bias.
  _nnHeatTick();

  // Phase 61: patrol/combat state machine. Run the patrol mover for any
  // unit that has no detection; only combat units enter the NN inference
  // batch. This is what stops the 'all bots drift to the same corner'
  // failure mode — the NN never sees a zeroed-enemy obs anymore.
  //
  // Hostile lists:
  //   • allies' hostile  = enemies              (player is on their team)
  //   • enemies' hostile = allies + player      (player is on the allies'
  //                                              team but stored separately)
  // Built once per tick so the inner loops don't re-spread the array.
  const _hostileForEnemy = [...allies, ...(player.alive ? [player] : [])];

  const nnUnits = [];
  for (const a of allies) {
    if (!a._useNN || !a.alive) continue;
    _nnUpdateAiMode(a, enemies);
    if (a._aiMode === 'patrol') {
      _nnRunPatrol(a, allies, enemies);
      continue;   // skip inference batch
    }
    nnUnits.push({u: a, friendly: allies, hostile: enemies, flipX: false,
                  diff: a._nnDifficulty || NN.difficulty || 'evolved'});
  }
  for (const e of enemies) {
    if (!e._useNN || !e.alive) continue;
    // EMP-stunned NN skip the inference pass entirely so they freeze in
    // place + don't fire. _stunUntil is set by the EMP pylon's pulse.
    if (e._stunUntil != null && game.time < e._stunUntil) continue;
    // Phase 18: KO-stunned (post-knockout, awaiting recruit) also skip
    // — they're frozen in place until the player walks over + presses G.
    if (e._koStunned) continue;
    _nnUpdateAiMode(e, _hostileForEnemy);
    if (e._aiMode === 'patrol') {
      _nnRunPatrol(e, enemies, _hostileForEnemy);
      continue;
    }
    nnUnits.push({u: e, friendly: enemies, hostile: _hostileForEnemy, flipX: true,
                  diff: e._nnDifficulty || NN.difficulty || 'evolved'});
  }
  if (nnUnits.length === 0) return;

  // Group units by difficulty so we can call each session with one batched run
  const groups = {};
  for (const ent of nnUnits) {
    (groups[ent.diff] = groups[ent.diff] || []).push(ent);
  }

  _nnInferring = true;
  try {
    for (const diff of Object.keys(groups)) {
      const session = NN.sessions[diff] || NN.sessions[NN.difficulty] || NN.session;
      if (!session) continue;
      const batch = groups[diff];
      const N = batch.length;
      const obsArr = new Float32Array(N * NN.OBS_DIM);
      for (let k = 0; k < N; k++) {
        const sub = obsArr.subarray(k * NN.OBS_DIM, (k+1) * NN.OBS_DIM);
        nnBuildObs(batch[k].u, batch[k].friendly, batch[k].hostile, sub, batch[k].flipX);
      }
      const tensor = new ort.Tensor('float32', obsArr, [N, NN.OBS_DIM]);
      const inName  = session.inputNames[0];
      const outName = session.outputNames[0];
      const feeds = {}; feeds[inName] = tensor;
      const out = await session.run(feeds);
      const probs = out[outName].data;
      for (let k = 0; k < N; k++) {
        let bestI = 0, bestP = probs[k * NN.ACTION_DIM];
        for (let a = 1; a < NN.ACTION_DIM; a++) {
          const p = probs[k * NN.ACTION_DIM + a];
          if (p > bestP) { bestP = p; bestI = a; }
        }
        const realAction = batch[k].flipX ? NN_ACTION_MIRROR_X[bestI] : bestI;
        nnApplyAction(batch[k].u, realAction, batch[k].friendly, batch[k].hostile);
      }
    }
  } catch (e) {
    console.error('NN inference failed:', e);
    NN.error = String(e);
  } finally {
    _nnInferring = false;
  }
}
function updateEnemies() {
  const w = WEAPONS.AK;
  // Squad-level intel: count enemies that have a visible target right now,
  // assign one per visible target as the flanker.
  const visibleAttackers = [];
  for (const e of enemies) {
    if (!e.alive) continue;
    if (e._koStunned) continue;     // Phase 18: stunned ⇒ no AI tick
    if (e._useNN) continue; // NN dispatcher owns this unit's per-tick movement
    e._sees = (e.attackTarget && e.attackTarget.alive)
      ? e.attackTarget
      : nearestVisibleFriendly(e.x, e.y, e.angle, ENEMY_VIEW.range, ENEMY_VIEW.arc);
    if (e._sees) visibleAttackers.push(e);
  }
  // If 2+ attackers see a target, pick the one farthest away as the flanker.
  if (visibleAttackers.length >= 2) {
    visibleAttackers.sort((a,b) => {
      const ta = a.attackTarget && a.attackTarget.alive ? a.attackTarget : (a._sees || player);
      const tb = b.attackTarget && b.attackTarget.alive ? b.attackTarget : (b._sees || player);
      return Math.hypot(b.x - tb.x, b.y - tb.y) - Math.hypot(a.x - ta.x, a.y - ta.y);
    });
    visibleAttackers[0]._flanker = true;
    for (let i = 1; i < visibleAttackers.length; i++) visibleAttackers[i]._flanker = false;
  } else {
    for (const e of visibleAttackers) e._flanker = false;
  }

  for (const e of enemies) {
    if (!e.alive) continue;
    if (e._koStunned) continue;     // Phase 18: stunned ⇒ no AI tick
    if (e._useNN) continue; // NN dispatcher owns this unit's per-tick movement
    if (e.angle == null) e.angle = Math.random() * Math.PI*2;
    if (e.alerted == null) e.alerted = 0;
    if (e.lockTime == null) e.lockTime = 0;
    if (e.coverPick == null) e.coverPick = null;
    if (e.peekTimer == null) e.peekTimer = 0;
    if (e.recentDamage == null) e.recentDamage = 0;
    e.recentDamage = Math.max(0, e.recentDamage - 1);

    const hasHardTarget = e.attackTarget && e.attackTarget.alive;
    const tgt = hasHardTarget
      ? e.attackTarget
      : nearestVisibleFriendly(e.x, e.y, e.angle, ENEMY_VIEW.range, ENEMY_VIEW.arc);
    const canSee = tgt != null;
    const tx = tgt ? tgt.x : null, ty = tgt ? tgt.y : null;
    const dist = tgt ? Math.hypot(tx - e.x, ty - e.y) : 0;
    let isMoving = false;
    const losClear = canSee && lineOfSight(e.x, e.y, tx, ty);
    const lowHp = e.hp < e.maxHp * 0.30;

    // ----- BEHAVIOUR PER USER SPEC -----
    // 1. Cover: if I see target AND took recent damage AND not currently in cover
    //    → grab nearest cover that breaks LoS to target, sidestep toward it.
    // 2. Peek-fire: if target visible AND I'm at cover → 60-frame fire / 60-frame
    //    hide cycle + small reposition. Always fire when LoS is clear,
    //    regardless of peek phase.
    // 3. Flank: marked _flanker (when 2+ enemies see target) circles 90° around
    //    instead of approaching head-on.
    // 4. Suppression: target NOT visible but recently was (lockTime>0) → fire
    //    toward last known position with extra spread, even without direct LoS,
    //    to keep player pinned.
    // 5. Low HP retreat: HP < 30% → flee toward far cover behind us.
    // 6. Patrol when idle.

    let mode = 'patrol';
    if (lowHp && e.recentDamage > 0) {
      if (!e.coverPick || (game.time - (e.coverPickedAt||0)) > 60) {
        e.coverPick = findCover(e.x, e.y, tx || player.x, ty || player.y, 1000);
        e.coverPickedAt = game.time;
      }
      mode = 'flee';
    } else if (canSee) {
      // Decide: take cover sideways, or engage / flank
      if (e.recentDamage > 0 || (e.behavior === 'inCover')) {
        // Refresh cover pick periodically
        if (!e.coverPick || (game.time - (e.coverPickedAt||0)) > 120
            || lineOfSight(tx, ty, e.coverPick.x, e.coverPick.y)) {
          e.coverPick = findCover(e.x, e.y, tx, ty, 500);
          e.coverPickedAt = game.time;
        }
      }
      const inCoverNow = e.coverPick && Math.hypot(e.x - e.coverPick.x, e.y - e.coverPick.y) < 30;
      mode = inCoverNow ? 'inCover'
           : (e.coverPick ? 'moveToCover'
           : (e._flanker ? 'flank' : 'engage'));
    } else if (e.lockTime > 0) {
      // Lost sight but recently saw — suppression fire toward last known position
      mode = 'suppress';
      e.lockTime--;
    } else if (e.alerted > 0) {
      mode = 'investigate';
      e.alerted--;
    }
    e.behavior = mode;

    // ----- Movement -----
    switch (mode) {
      case 'engage': {
        const a = Math.atan2(ty - e.y, tx - e.x);
        e.angle += angDiff(a, e.angle) * 0.22;
        if (dist > 340) {
          e.x += Math.cos(e.angle) * e.speed;
          e.y += Math.sin(e.angle) * e.speed;
          e.walkPhase += 0.18; isMoving = true;
        }
        break;
      }
      case 'flank': {
        // Move 90° around the target (clockwise based on enemy id)
        const aToTarget = Math.atan2(ty - e.y, tx - e.x);
        const side = (e.x + e.y) % 2 ? 1 : -1;
        const flankAngle = aToTarget + side * Math.PI/2;
        e.angle += angDiff(aToTarget, e.angle) * 0.18; // body still faces threat
        e.x += Math.cos(flankAngle) * e.speed * 0.85;
        e.y += Math.sin(flankAngle) * e.speed * 0.85;
        e.walkPhase += 0.18; isMoving = true;
        break;
      }
      case 'moveToCover': {
        const cp = e.coverPick;
        const a = Math.atan2(cp.y - e.y, cp.x - e.x);
        e.angle += angDiff(a, e.angle) * 0.22;
        e.x += Math.cos(a) * e.speed * 1.1;
        e.y += Math.sin(a) * e.speed * 1.1;
        e.walkPhase += 0.20; isMoving = true;
        break;
      }
      case 'flee': {
        const cp = e.coverPick;
        if (cp) {
          const a = Math.atan2(cp.y - e.y, cp.x - e.x);
          e.angle += angDiff(a, e.angle) * 0.22;
          e.x += Math.cos(a) * e.speed * 1.4;
          e.y += Math.sin(a) * e.speed * 1.4;
        } else if (canSee) {
          // Just back away from threat
          const a = Math.atan2(ty - e.y, tx - e.x);
          e.x -= Math.cos(a) * e.speed * 1.2;
          e.y -= Math.sin(a) * e.speed * 1.2;
        }
        e.walkPhase += 0.22; isMoving = true;
        break;
      }
      case 'inCover': {
        // Always face threat. Peek 60 fire / 60 hide cycle, slight sidestep.
        const a = Math.atan2(ty - e.y, tx - e.x);
        e.angle += angDiff(a, e.angle) * 0.30; // snappy aim
        e.peekTimer++;
        const peeking = (e.peekTimer % 120) < 60;
        const peekTarget = peeking ? peekOffset(e.coverPick, tx, ty) : e.coverPick;
        const dx = peekTarget.x - e.x, dy = peekTarget.y - e.y;
        const dl = Math.hypot(dx, dy);
        if (dl > 1) {
          e.x += (dx/dl) * 0.7;
          e.y += (dy/dl) * 0.7;
          if (peeking) isMoving = true;
        }
        e._peekingNow = peeking;
        break;
      }
      case 'suppress': {
        // Face last seen, fire toward there even without LoS (high-spread spam)
        const lx = e.lastSeenX, ly = e.lastSeenY;
        if (lx != null) {
          const a = Math.atan2(ly - e.y, lx - e.x);
          e.angle += angDiff(a, e.angle) * 0.18;
        }
        break;
      }
      case 'investigate': {
        const tdx = (e.alertX || 0) - e.x, tdy = (e.alertY || 0) - e.y;
        const td = Math.hypot(tdx, tdy);
        if (td > 1) {
          const a = Math.atan2(tdy, tdx);
          // SNAP-turn on hearing the gunshot — alert reaction
          e.angle += angDiff(a, e.angle) * 0.30;
          if (td > 100) {
            e.x += Math.cos(e.angle) * e.speed * 0.7;
            e.y += Math.sin(e.angle) * e.speed * 0.7;
            e.walkPhase += 0.14; isMoving = true;
          }
        }
        break;
      }
      default: { // patrol — wider, faster scan than before so they actually see things
        e.angle += Math.sin(game.time * 0.022 + (e.walkPhase || 0)) * 0.045;
      }
    }

    pushOutOfBuildings(e, e.radius);
    e.x = Math.max(20, Math.min(WORLD.w-20, e.x));
    e.y = Math.max(20, Math.min(WORLD.h-20, e.y));

    const barrel = tickShooter(e, e.angle, w, isMoving);

    // ----- Firing -----
    // Always fire when LoS is clear and target in range. inCover doesn't gate
    // firing — peek phase happens to expose us; non-peek the wall blocks LoS
    // naturally so canFire becomes false on its own.
    e.fireCd--;
    let canFire = false;
    if (mode === 'suppress' && e.lastSeenX != null) {
      // Fire toward last seen with extra spread, even if no LoS — suppression
      canFire = e.fireCd <= 0;
    } else {
      canFire = canSee && dist < 520 && losClear && e.fireCd <= 0;
    }
    // Phase 21: invuln mutes the trigger. Same rule applied to player + allies.
    if (e._invulnUntil != null && game.time < e._invulnUntil) canFire = false;
    if (canFire) {
      const aimX = (mode === 'suppress') ? e.lastSeenX : tx;
      const aimY = (mode === 'suppress') ? e.lastSeenY : ty;
      const aimAng = Math.atan2(aimY - e.y, aimX - e.x);
      const extra = (mode === 'suppress') ? w.spread * 2 : w.spread;
      const ang = (mode === 'suppress' ? aimAng : barrel) + (Math.random()-0.5) * extra;
      enemyBullets.push({
        x: e.x + Math.cos(ang)*16,
        y: e.y + Math.sin(ang)*16,
        vx: Math.cos(ang)*w.bulletSpeed, vy: Math.sin(ang)*w.bulletSpeed,
        life: w.bulletLife, damage: w.damage,
        fromUnit: e,
        weaponName: w.name,
      });
      applyRecoil(e, w);
      e.fireCd = w.fireCd + Math.floor(Math.random()*8);
      emitSound(e.x, e.y, w.soundIntensity, false, false, w.soundProfile);
    }
  }

  // ---- Kamikaze FPV drones ----
  // Charge nearest friendly with a slow turn rate. If they overshoot (high speed,
  // low turn) they fly past and have to circle back. Explode on contact with any
  // friendly, building, low cover, overhead, or world edge.
  for (const d of enemyDrones) {
    if (!d.alive) continue;
    d.hoverPhase += 0.18;

    // Target = mission-assigned target if alive (e.g. convoy UGV); otherwise
    // nearest alive friendly. Underground hides friendlies from the drone.
    let tgt = null, bestD = Infinity;
    if (d.attackTarget && d.attackTarget.alive) {
      tgt = d.attackTarget;
      bestD = Math.hypot(tgt.x - d.x, tgt.y - d.y);
    } else {
      if (player.alive) {
        bestD = Math.hypot(player.x - d.x, player.y - d.y);
        tgt = player;
      }
      for (const a of allies) {
        if (!a.alive) continue;
        const dd = Math.hypot(a.x - d.x, a.y - d.y);
        if (dd < bestD) { tgt = a; bestD = dd; }
      }
    }

    if (tgt) {
      // Steer toward target with limited turn rate (low manoeuvrability)
      const desired = Math.atan2(tgt.y - d.y, tgt.x - d.x);
      let aDiff = desired - d.angle;
      while (aDiff > Math.PI) aDiff -= Math.PI*2;
      while (aDiff < -Math.PI) aDiff += Math.PI*2;
      const maxTurn = d.turnRate;
      d.angle += Math.max(-maxTurn, Math.min(maxTurn, aDiff));
    }
    // Always cruise forward at high speed (committed approach)
    d.x += Math.cos(d.angle) * d.speed;
    d.y += Math.sin(d.angle) * d.speed;
    // Tiny lateral wobble for FPV flight feel
    const wob = Math.sin(d.hoverPhase) * 0.6;
    d.x += -Math.sin(d.angle) * wob * 0.2;
    d.y +=  Math.cos(d.angle) * wob * 0.2;

    // World-edge: explode (they can't bank that hard)
    if (d.x < 30 || d.x > WORLD.w-30 || d.y < 30 || d.y > WORLD.h-30) {
      kamikazeExplode(d);
      continue;
    }
    // Building / lowCover / overhead collision: explode
    let crashed = false;
    for (const b of buildings) {
      if (d.x > b.x && d.x < b.x+b.w && d.y > b.y && d.y < b.y+b.h) { crashed = true; break; }
    }
    if (!crashed) for (const lc of lowCovers) {
      if (d.x > lc.x && d.x < lc.x+lc.w && d.y > lc.y && d.y < lc.y+lc.h) { crashed = true; break; }
    }
    if (!crashed) for (const o of overheads) {
      if (d.x > o.x && d.x < o.x+o.w && d.y > o.y && d.y < o.y+o.h) { crashed = true; break; }
    }
    if (crashed) { kamikazeExplode(d); continue; }

    // Friendly contact: explode
    if (player.alive && Math.hypot(d.x - player.x, d.y - player.y) < d.radius + player.radius) {
      kamikazeExplode(d); continue;
    }
    for (const a of allies) {
      if (!a.alive) continue;
      if (Math.hypot(d.x - a.x, d.y - a.y) < d.radius + a.radius) { kamikazeExplode(d); break; }
    }

    // Buzzing — periodic sound emit so the player gets directional warning
    if ((game.time + d.hoverPhase * 10 | 0) % 28 === 0) {
      emitSound(d.x, d.y, 850, false); // FPV buzz carries far — directional warning
    }
  }
}
