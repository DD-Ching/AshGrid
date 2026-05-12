// ============ SQUAD (allies) ============
// Ally spawn + respawn lifecycle. Reads ALLY_LOADOUT (BRAVO/CHARLIE/
// DELTA/ECHO templates) and the lobby's lineup overrides to instance
// each ally with the right chassis / weapon / NN style.
//
// Classic-script. Declares globally (~10 functions):
//   spawnAllies() · spawnSoldier(idx, opts) · spawnEnemy(idx, opts)
//   removeDeadUnits() · respawnDeadAllies() · etc.
//
// External deps: game · player · allies · enemies · ALLY_LOADOUT ·
//   WEAPONS · CHASSIS · applyChassisToUnit · applyWeaponToPlayer ·
//   NN · pickRandomNNWeaponId · NN_ARENA · _lobby · currentMap

function spawnAllies() {
  allies.length = 0;
  for (let i = 0; i < ALLY_LOADOUT.length; i++) {
    const ld = ALLY_LOADOUT[i];
    const ally = {
      callsign: ld.callsign,
      offsetX: ld.offsetX, offsetY: ld.offsetY,
      x: player.x + ld.offsetX, y: player.y + ld.offsetY,
      angle: player.angle, gunAngle: player.angle, gunRecoil: 0, swayPhase: Math.random()*Math.PI*2,
      alive: true, walkPhase: Math.random()*Math.PI*2,
      fireCd: 0,
      target: null,
      lookPhase: Math.random()*Math.PI*2, // patrol look-around
      team: 0,
      // NN-merge: campaign allies use the trained brain too. Without _useNN
      // they fell back to legacy squad AI which can't keep up with the
      // NN-driven enemies the player now faces. Each ally gets its own
      // style (per ALLY_LOADOUT) so BRAVO / CHARLIE / DELTA / ECHO all play
      // distinctively.
      _useNN: true, _nnFireCd: 0, _nnRecentDmg: 0, _nnLastSeenTick: -9999,
      _nnDifficulty: ld.nnStyle || 'elite',
      _weapon: WEAPONS[ld.weaponId] || WEAPONS.RIFLE,
      _respawnAt: null,
    };
    // Chassis stats — wolves take less HP but move fast, heavies the opposite
    applyChassisToUnit(ally, ld.chassis || 'humanoid', 2.5, 80, 13);
    // Phase 21: spawn invuln 90 → 180 ticks (3 s) per user '無敵時間需增長'.
    // Combined with no-fire-during-invuln (updatePlayer + tickAlly) so the
    // shield can't double as a respawn-camp turret.
    ally._invulnUntil = (typeof game !== 'undefined' && game.time != null) ? game.time + 180 : 180;
    allies.push(ally);
  }
}

function nearestVisibleEnemy(ax, ay, fromAngle, range) {
  let best = null, bestD = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const dx = e.x - ax, dy = e.y - ay;
    const d = Math.hypot(dx, dy);
    if (d < range && angleInCone(fromAngle, effectiveArc(d), ax, ay, e.x, e.y) && lineOfSight(ax, ay, e.x, e.y)) {
      if (d < bestD) { best = e; bestD = d; }
    }
  }
  for (const dr of enemyDrones) {
    if (!dr.alive) continue;
    const dx = dr.x - ax, dy = dr.y - ay;
    const d = Math.hypot(dx, dy);
    // Drones are priority targets — they'll explode on you
    const priority = d * 0.6;
    if (d < range && angleInCone(fromAngle, effectiveArc(d), ax, ay, dr.x, dr.y) && lineOfSight(ax, ay, dr.x, dr.y)) {
      if (priority < bestD) { best = dr; bestD = priority; }
    }
  }
  return best;
}

function updateAllies() {
  for (const a of allies) {
    if (!a.alive) continue;
    if (a._useNN) continue; // NN dispatcher owns this unit's per-tick movement
    // Stuck detector — sidestep when blocked
    if (a._lastX == null) { a._lastX = a.x; a._lastY = a.y; a._stuckFrames = 0; }
    if (Math.hypot(a.x - a._lastX, a.y - a._lastY) < 2) a._stuckFrames++;
    else { a._stuckFrames = 0; a._lastX = a.x; a._lastY = a.y; }
    if (a._stuckFrames > 60) {
      const side = (a.callsign.charCodeAt(0) % 2) ? 1 : -1;
      a.x += -Math.sin(a.angle) * a.speed * side;
      a.y +=  Math.cos(a.angle) * a.speed * side;
      a._stuckFrames = 0;
      a._lastX = a.x; a._lastY = a.y;
    }
    // Don't block the player — soft push if too close
    const pdx = a.x - player.x, pdy = a.y - player.y;
    const pd = Math.hypot(pdx, pdy);
    if (pd < a.radius + player.radius + 4 && pd > 0.001 && player.alive) {
      const k = (a.radius + player.radius + 4 - pd) / pd;
      a.x += pdx * k;
      a.y += pdy * k;
    }

    // Look first (turn body toward target if any), then move.
    const target = a.target && a.target.alive ? a.target : nearestVisibleEnemy(a.x, a.y, a.angle, VIEW.range);
    a.target = target;

    let desiredAngle;
    let isMoving = false;

    if (target) {
      // ENGAGE branch with cover-seeking + corner peek — mirror of soldier AI
      const tx = target.x, ty = target.y;
      const dist = Math.hypot(tx - a.x, ty - a.y);
      const lowHp = a.hp < a.maxHp * 0.40;
      const inCoverNow = a.coverPick && Math.hypot(a.x - a.coverPick.x, a.y - a.coverPick.y) < 28;

      if (lowHp) {
        // Low HP — fall back to FAR cover
        if (!a.coverPick || inCoverNow) {
          a.coverPick = findCover(a.x, a.y, tx, ty, 900) || a.coverPick;
        }
        a.allyMode = 'flee';
      } else if (inCoverNow) {
        a.allyMode = 'cornerPeek';
      } else {
        if (!a.coverPick || (game.time - (a.coverPickedAt || 0)) > 90
            || lineOfSight(tx, ty, a.coverPick.x, a.coverPick.y)) {
          a.coverPick = findCover(a.x, a.y, tx, ty, 500);
          a.coverPickedAt = game.time;
        }
        a.allyMode = a.coverPick ? 'seekCover' : 'engage';
      }

      switch (a.allyMode) {
        case 'engage': {
          desiredAngle = Math.atan2(ty - a.y, tx - a.x);
          a.angle = desiredAngle;
          const ideal = 280;
          if (dist > ideal + 60) {
            a.x += Math.cos(desiredAngle) * a.speed * 0.7;
            a.y += Math.sin(desiredAngle) * a.speed * 0.7;
            a.walkPhase += 0.16; isMoving = true;
          } else if (dist < ideal - 60) {
            a.x -= Math.cos(desiredAngle) * a.speed * 0.4;
            a.y -= Math.sin(desiredAngle) * a.speed * 0.4;
            a.walkPhase += 0.10; isMoving = true;
          }
          break;
        }
        case 'seekCover':
        case 'flee': {
          const cp = a.coverPick;
          const dxc = cp.x - a.x, dyc = cp.y - a.y;
          const goAng = Math.atan2(dyc, dxc);
          a.angle += angDiff(goAng, a.angle) * 0.18;
          const speedMul = a.allyMode === 'flee' ? 1.3 : 1.0;
          a.x += Math.cos(a.angle) * a.speed * speedMul;
          a.y += Math.sin(a.angle) * a.speed * speedMul;
          a.walkPhase += 0.20; isMoving = true;
          break;
        }
        case 'cornerPeek': {
          const angleToTarget = Math.atan2(ty - a.y, tx - a.x);
          a.angle += angDiff(angleToTarget, a.angle) * 0.22;
          a.peekTimer = (a.peekTimer || 0) + 1;
          const peeking = (a.peekTimer % 100) < 45;
          const tgtPos = peeking ? peekOffset(a.coverPick, tx, ty) : a.coverPick;
          const dxp = tgtPos.x - a.x, dyp = tgtPos.y - a.y;
          const dp = Math.hypot(dxp, dyp);
          if (dp > 1) {
            a.x += (dxp/dp) * 0.6;
            a.y += (dyp/dp) * 0.6;
            isMoving = peeking;
          }
          a._peekingNow = peeking;
          break;
        }
      }
    } else if (squadIntel.fresh > 0) {
      // INVESTIGATE — squad has fresh intel on enemy position. Move toward it,
      // facing it, ready to engage. This is the "regroup on contact" behavior.
      a.scoutTimer = 0;
      const dx = squadIntel.x - a.x, dy = squadIntel.y - a.y;
      const d = Math.hypot(dx, dy);
      desiredAngle = Math.atan2(dy, dx);
      a.angle += angDiff(desiredAngle, a.angle) * 0.10;
      if (d > 240) {
        a.x += Math.cos(a.angle) * a.speed * 0.85;
        a.y += Math.sin(a.angle) * a.speed * 0.85;
        a.walkPhase += 0.15;
        isMoving = true;
      }
    } else {
      // No target, no intel — follow the player at flanking offset OR scout out
      // if no contact for a while.
      a.scoutTimer = (a.scoutTimer || 0) + 1;
      const scouting = a.scoutTimer > SQUAD_IDLE_BEFORE_SCOUT;

      if (scouting) {
        // Each ally picks a unique outward bearing (based on callsign hash)
        // and patrols 380u from the player. They face their bearing — covers
        // an arc of the squad's perimeter while they search.
        if (!a.scoutBearing || a.scoutTimer % 360 === 0) {
          const seed = (a.callsign.charCodeAt(0) + a.callsign.charCodeAt(1)) || 0;
          a.scoutBearing = (seed * 0.7) % (Math.PI*2) + Math.sin(game.time*0.003 + seed) * 0.5;
        }
        const sx = player.x + Math.cos(a.scoutBearing) * 380;
        const sy = player.y + Math.sin(a.scoutBearing) * 380;
        const dx = sx - a.x, dy = sy - a.y;
        const d = Math.hypot(dx, dy);
        if (d > 40) {
          desiredAngle = Math.atan2(dy, dx);
          a.angle += angDiff(desiredAngle, a.angle) * 0.10;
          a.x += Math.cos(a.angle) * a.speed * 0.7;
          a.y += Math.sin(a.angle) * a.speed * 0.7;
          a.walkPhase += 0.14;
          isMoving = true;
        } else {
          // At scout post — face outward and scan
          a.lookPhase += 0.018;
          desiredAngle = a.scoutBearing + Math.sin(a.lookPhase) * 0.55;
          a.angle += angDiff(desiredAngle, a.angle) * 0.06;
        }
      } else {
        // FORMATION — flank the player. Offset rotates with player.angle so the
        // formation keeps its shape as the player turns.
        const cosA = Math.cos(player.angle), sinA = Math.sin(player.angle);
        const fx = player.x + (a.offsetX*cosA - a.offsetY*sinA);
        const fy = player.y + (a.offsetX*sinA + a.offsetY*cosA);
        const dx = fx - a.x, dy = fy - a.y;
        const d = Math.hypot(dx, dy);
        if (d > 30) {
          const fa = Math.atan2(dy, dx);
          const step = Math.min(a.speed, d);
          a.x += Math.cos(fa) * step;
          a.y += Math.sin(fa) * step;
          a.walkPhase += 0.18;
          isMoving = true;
          desiredAngle = player.angle;
        } else {
          a.lookPhase += 0.012;
          desiredAngle = player.angle + Math.sin(a.lookPhase) * 0.6;
        }
        a.angle = desiredAngle;
      }
    }

    pushOutOfBuildings(a, a.radius);
    a.x = Math.max(20, Math.min(WORLD.w-20, a.x));
    a.y = Math.max(20, Math.min(WORLD.h-20, a.y));

    // Gun barrel — same lag/sway/recoil mechanic as the player
    const w = WEAPONS[a.weaponId];
    const barrel = tickShooter(a, a.angle, w, isMoving);

    a.fireCd--;
    // Fire only with a clean shot. While in cover but NOT peeking, the wall
    // blocks our shot — hold fire (no wasted bullets, no shooting through walls).
    let canFire = !!target && lineOfSight(a.x, a.y, target.x, target.y);
    if (a.allyMode === 'cornerPeek' && !a._peekingNow) canFire = false;
    // Phase 21: invuln mutes the trigger. Same rule the player follows so
    // allies don't snipe under the spawn shield either.
    if (a._invulnUntil != null && (typeof game !== 'undefined') && game.time < a._invulnUntil) canFire = false;
    if (a.fireCd <= 0 && canFire) {
      const ang = barrel + (Math.random()-0.5)*w.spread;
      bullets.push({
        x: a.x + Math.cos(ang)*16,
        y: a.y + Math.sin(ang)*16,
        vx: Math.cos(ang)*w.bulletSpeed, vy: Math.sin(ang)*w.bulletSpeed,
        life: w.bulletLife, damage: w.damage,
        fromAlly: true,
        fromUnit: a,
        weaponName: w.name,
      });
      muzzleFlashes.push({ x: a.x + Math.cos(ang)*22, y: a.y + Math.sin(ang)*22, angle: ang, life: 5 });
      applyRecoil(a, w);
      a.fireCd = w.fireCd + Math.floor(Math.random()*8);
      emitSound(a.x, a.y, w.soundIntensity, true, false, w.soundProfile);
    }
  }
}

