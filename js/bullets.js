// ============ BULLET UPDATE + COLLISION (R5 refactor) ============
// Single home for every player + enemy bullet code path.
//
// Before R5 these three functions lived inline in index.html at
// ~7129 / ~7225 / ~7330. Touching them — adding a new collision
// branch (lowCover pass-through, MP ghost, structure damage) — meant
// scrolling past 12 000 lines of unrelated render / HUD / world-gen
// code to find them. Pre-extraction list of regressions in this area:
// Phase 51 swept-segment, Phase 41 wall-vs-bullet ordering, Phase 43
// MP structure damage, Phase 114 lowCover pass-through. Every fix
// was a careful insertion into a giant block.
//
// Functions moved (signatures unchanged, behaviour 1:1):
//   fire()              spawn player bullets per pellet, apply recoil,
//                       emit sound, MP via input packet (not direct
//                       broadcast — server is authoritative).
//   detonateRocket(b)   rocket projectile explode: AOE damage to
//                       enemies / enemy drones / player-built struct,
//                       MP server-authoritative for structures.
//   updateBullets()     per-frame: advance + swept-collide both
//                       `bullets[]` (player→enemies) and
//                       `enemyBullets[]` (enemy→player). Includes
//                       wall / wallLines / building / lowCover /
//                       structure / spawn-beacon / drone / FPV
//                       collision branches, plus rocket detonation
//                       handoffs.
//
// External deps (resolved at call-time via classic-script globals):
//   playerWeapon · player · enemies · enemyDrones · allies · drone · fpv ·
//   bullets · enemyBullets · muzzleFlashes · game · WEAPONS · mission ·
//   wallLines · buildings · lowCovers · structureFootprints ·
//   smokeClouds · spawnBeacons (via game._spawnBeacons) ·
//   _applyDamageToUnit · _tryStunOrKill · spawnDamagePopup · _nnNoteHit ·
//   _lbBumpKill · createExplosion · emitSound · playSfx · applyRecoil ·
//   triggerShake · _mpIsActive · _mpBroadcastExplosion · _maybeStumble ·
//   WeaponState · Input · _wallSegHitBullet · etc.

function fire() {
  const w = playerWeapon;
  // R3 — WeaponState owns ammo + cooldown mutations
  if (typeof WeaponState !== 'undefined' && WeaponState.consumeShot) {
    WeaponState.consumeShot(w);
  } else {
    player.fireCooldown = w.fireCd;
    player.ammo--;
  }
  const baseAngle = player.gunAngle + player.gunRecoil;
  // Aim-assist locked shots: cut random spread to 30% so the locked reticle
  // really means "the bullet is going there" — not "go somewhere in a 2.3°
  // cone around there". Pellet weapons (shotgun) keep their natural spread.
  const spreadMul = (player._aimAssistLockedAt && (w.pellets || 1) === 1) ? 0.3 : 1.0;
  // Shotgun and similar: emit `pellets` bullets per shot with shared spread cone
  const pellets = w.pellets || 1;
  // Design trade-off: NN bots run client-only (the ONNX inference happens
  // on each player's machine — we don't ship models to PartyKit). So MP
  // bullets must travel two parallel tracks:
  //   • Local bullet → hits local NN bots (server doesn't know they exist)
  //     AND renders locally so OUR bullets feel snappy (60 fps, no RTT).
  //   • Server bullet → hits remote players (server runs lag comp + truth).
  //     _mpRenderRemoteBullets skips server-echoes whose shooter == us so
  //     there's no twin tracer.
  // The `_mpGhost` flag is preserved on the local bullet so callers that
  // need to know "this is the local mirror in MP" still can — but it no
  // longer gates rendering. If we ever move NN inference server-side,
  // this whole branch collapses to "server owns all bullets."
  const _mpActive = typeof _mpIsActive === 'function' && _mpIsActive();
  for (let i = 0; i < pellets; i++) {
    const barrel = baseAngle + (Math.random()-0.5) * w.spread * spreadMul;
    bullets.push({
      x: player.x + Math.cos(barrel)*18,
      y: player.y + Math.sin(barrel)*18,
      vx: Math.cos(barrel)*w.bulletSpeed, vy: Math.sin(barrel)*w.bulletSpeed,
      life: w.bulletLife, damage: w.damage,
      fromAlly: false,
      fromUnit: player,
      weaponName: w.name,
      // Rocket flag — turn the bullet into an AOE projectile on impact
      isRocket: !!w.isRocket,
      blastR: w.blastR, blastDmg: w.blastDmg, structDmgMul: w.structDmgMul,
      // In MP: render-suppressed (server's bullet is canonical visual)
      // but collision still runs locally so NN bots — which exist only
      // client-side — take damage. See ghost-bullet rationale above.
      _mpGhost: _mpActive,
    });
  }
  // One muzzle flash per shot (not per pellet) — spread looks like a cloud
  muzzleFlashes.push({ x: player.x + Math.cos(baseAngle)*22, y: player.y + Math.sin(baseAngle)*22, angle: baseAngle, life: 5 });
  applyRecoil(player, w);
  emitSound(player.x, player.y, w.soundIntensity, true, true, w.soundProfile);
  // MP fire intent travels via the per-tick input packet (`fire: true` in
  // _mpSendInput). Server is authoritative for spawning the network bullet
  // — no separate broadcast needed here.
}
function detonateRocket(b) {
  const r = b.blastR || 110;
  const splashDmg = b.blastDmg || 60;
  const structMul = b.structDmgMul || 4;
  createExplosion(b.x, b.y, 'big');
  // Phase 111 — rocket impact uses the new 'boom' kind (low rumble + crash).
  emitSound(b.x, b.y, 1900, false, false, null, 'boom');
  playSfx('death', { vol: 0.6 });
  // Heavy shake on every rocket detonation — feels like ordnance
  if (player.alive) {
    const d = Math.hypot(player.x - b.x, player.y - b.y);
    const closeness = Math.max(0.4, 1 - d / 280);
    triggerShake(10 * closeness, 22);
  } else {
    triggerShake(6, 18);
  }
  // Enemies in radius
  for (const e of enemies) {
    if (!e.alive) continue;
    if (e._invulnUntil != null && game.time < e._invulnUntil) continue;
    const d = Math.hypot(e.x - b.x, e.y - b.y);
    if (d >= r) continue;
    const dmg = Math.round(splashDmg * (1 - d / r));
    _applyDamageToUnit(e, dmg);
    if (e.hp <= 0 && e.alive) {
      // Phase 18: first KO → stun + freeze; second KO (already stunned)
      // falls through to real death. Splash + explosions are the ONLY
      // way to finish a stunned enemy because bullets / aim-assist skip
      // them — user wants the player to walk over and recruit, not snipe.
      if (typeof _tryStunOrKill === 'function' && _tryStunOrKill(e)) {
        // stunned, no score awarded yet
      } else {
        killUnit(e, { source: 'bullet' });   // alive=false + score 100 + lb bump
        createExplosion(e.x, e.y, 'small');
      }
    }
  }
  // Enemy drones
  for (const d of enemyDrones) {
    if (!d.alive) continue;
    const dist = Math.hypot(d.x - b.x, d.y - b.y);
    if (dist < r) {
      d.hp -= splashDmg;
      if (d.hp <= 0) { d.alive = false; createExplosion(d.x, d.y, 'small'); }
    }
  }
  // Player-built structures — friendly fire on own modules CAN happen.
  // Phase 43: in MP, structures are server-authoritative; broadcast the
  // explosion and let the server apply damage + emit structureHit / Gone
  // events. In SP we apply directly.
  if (typeof _mpIsActive === 'function' && _mpIsActive()
      && typeof _mpBroadcastExplosion === 'function') {
    _mpBroadcastExplosion(b.x, b.y, r, splashDmg * structMul);
  } else if (game._structures) {
    for (let si = game._structures.length - 1; si >= 0; si--) {
      const s = game._structures[si];
      const def = STRUCTURE_DEFS[s.kind]; if (!def || s.hp <= 0) continue;
      if (def.bulletImmune) continue;   // Phase 63: mines/tripmines no-clear
      const dist = Math.hypot(s.x - b.x, s.y - b.y);
      if (dist < r) s.hp -= splashDmg * structMul;
    }
  }
  // Arena buildings + lowCovers are now destructible in EVERY NN mode
  // (the previous '_nnGameMode === defense'-only gate hid this from the
  // user — rockets felt useless in DM/SURV/HELO/CONVOY because nothing
  // changed on impact).
  for (let bi = buildings.length - 1; bi >= 0; bi--) {
    const bd = buildings[bi];
    const cx = bd.x + bd.w / 2, cy = bd.y + bd.h / 2;
    if (Math.hypot(cx - b.x, cy - b.y) < r + Math.max(bd.w, bd.h) / 2) {
      if (bd.hp != null) {
        bd.hp -= splashDmg * structMul;
        if (bd.hp <= 0) { createExplosion(cx, cy, 'small'); buildings.splice(bi, 1); }
      }
    }
  }
  for (let li = lowCovers.length - 1; li >= 0; li--) {
    const lc = lowCovers[li];
    const cx = lc.x + lc.w / 2, cy = lc.y + lc.h / 2;
    if (Math.hypot(cx - b.x, cy - b.y) < r + Math.max(lc.w, lc.h) / 2) {
      if (lc.hp != null) {
        lc.hp -= splashDmg * structMul;
        if (lc.hp <= 0) { createExplosion(cx, cy, 'small'); lowCovers.splice(li, 1); }
      }
    }
  }
  // Enemy spawn beacons (defense mode) — rocket destroys them outright
  if (game._spawnBeacons) {
    for (let bk = game._spawnBeacons.length - 1; bk >= 0; bk--) {
      const beacon = game._spawnBeacons[bk];
      if (Math.hypot(beacon.x - b.x, beacon.y - b.y) < r + 20) {
        beacon.hp -= splashDmg * structMul;
        if (beacon.hp <= 0) {
          createExplosion(beacon.x, beacon.y, 'big');
          showSwapToast(T(`敌方重生点已摧毁`, `Enemy spawn destroyed`));
            unlockAchievement('beacon_kill');
          game._spawnBeacons.splice(bk, 1);
          game._energy = Math.min(999, (game._energy || 0) + BALANCE.energy.spawnBeaconDestroy);
        }
      }
    }
  }
}
function updateBullets() {
  for (let i = bullets.length-1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx; b.y += b.vy;
    b.life--;
    let hit = false;
    // Mission-specific damage hook (e.g. hive HP) — fires before enemy-soldier check
    if (mission && mission.onPlayerBulletHit && mission.onPlayerBulletHit(b)) hit = true;
    // Phase 51: swept-segment vs circle. Bullet step is bulletSpeed (~14)
    // and enemy radius is ~10 — point-in-circle tunneled glancing shots.
    // Project enemy pos onto the bullet's prev→cur segment and use the
    // closest distance instead of the per-tick sample. Same fix applied
    // server-side for MP players.
    const _prevX = b.x - b.vx, _prevY = b.y - b.vy;
    const _segVx = b.x - _prevX, _segVy = b.y - _prevY;
    const _segL2 = _segVx * _segVx + _segVy * _segVy;
    if (!hit) for (const e of enemies) {
      if (!e.alive) continue;
      let _t = 0;
      if (_segL2 > 0) {
        _t = ((e.x - _prevX) * _segVx + (e.y - _prevY) * _segVy) / _segL2;
        if (_t < 0) _t = 0; else if (_t > 1) _t = 1;
      }
      const _cx = _prevX + _segVx * _t, _cy = _prevY + _segVy * _t;
      if (Math.hypot(_cx - e.x, _cy - e.y) < e.radius) {
        // Spawn invuln: still consume the bullet so it doesn't pass through,
        // but don't apply damage. Visually the bullet vanishes on impact.
        if (e._invulnUntil != null && game.time < e._invulnUntil) { hit = true; break; }
        // Phase 18→19: KO-stunned are AIM-ASSIST-SAFE only (auto-lock won't
        // pick them), but MANUAL shots still land + finish them — '你可以
        // 手動射擊他, 他就會真的爆掉'. Damage applies; if hp drops below 0
        // again, _tryStunOrKill returns false (already stunned) and the
        // real-death branch below runs.
        _applyDamageToUnit(e, b.damage);
        e.recentDamage = 60;     // marks "I'm under fire" for FSM low-HP flee branch
        e.alerted = Math.max(e.alerted || 0, 240);
        e.alertX = b.x - b.vx*4; // alert toward where the shot came from
        e.alertY = b.y - b.vy*4;
        // Phase 97 — NN-driven enemies use a different state machine
        // (_aiMode / _nnLastSeenX/Y / _nnRecentDmg). Mirror the alert
        // into those fields too so NN units actually react to bullets
        // from outside their vision cone.
        if (e._useNN) _nnNoteHit(e, b);
        const isKill = e.hp <= 0;
        spawnDamagePopup(e.x, e.y - 14, b.damage, isKill);
        if (isKill) {
          // Phase 18: first KO → stun, not death. _tryStunOrKill returns
          // true if we stunned the enemy (skip the death branch); false if
          // already stunned (let real death run — but stunned skips bullets
          // above, so this branch only fires for non-stun KOs).
          if (typeof _tryStunOrKill === 'function' && _tryStunOrKill(e)) {
            spawnDamagePopup(e.x, e.y - 26, 'KO', true);
            hit = true; break;
          }
          killUnit(e, { source: 'bullet' });   // alive=false + score 100 + lb bump
          // (arena-mp: _maybeTriggerFirstKillAudit call stripped — was the
          // FTUE Phase 4 auto-popup. Audit Console reachable via lobby button.)
          // Kill SFX + ally-kill radio callout BOTH removed on user request
          // ('移除擊殺音效!!!', third escalation). The radio callout was the
          // 'ding-dong' the user kept hearing — showRadioToast plays a 2-tone
          // beep (1320 + 880 Hz, 70 ms apart) and the cooldown key was bugged
          // anyway: 'killcall_' + cs + '_' + game.time made the key unique
          // every tick so the 0.5s rate-limit never engaged. Result: every
          // ally kill in a firefight fired another ding-dong on top of the
          // last. Now: silence on kill. Visual feedback only — explosion
          // VFX, damage popup (isKill=true → bigger red), score bump,
          // killCount tick. KIA + hurt callouts on FRIENDLY losses still
          // fire (different cooldown keys, those work correctly).
          createExplosion(e.x, e.y, 'small');
          // Phase 56 — subtle debris/scatter cue on kill. Quiet (vol
          // 0.18) + brief (60ms) so it doesn't crowd the explosion VFX
          // or repeat into mush during streaks. User: '可能再加一些微
          // 的爆炸聲、爆裂聲'. The earlier kill_confirm preset is gone
          // for good (burnt by '把那個叮咚鈴聲移除'); this one is
          // noise-only, no melodic tone.
          if (typeof playSfx === 'function') playSfx('kill_crackle');
          // Kill streak — chain kills within 4s bump the counter
          const KS_WINDOW = 240;
          const last = player._lastKillTick || -9999;
          if (game.time - last < KS_WINDOW) {
            player._killStreak = (player._killStreak || 1) + 1;
          } else {
            player._killStreak = 1;
          }
          player._lastKillTick = game.time;
          player._killStreakFlashUntil = game.time + 90;
          // Bonus score for streaks (small but feels good)
          if (player._killStreak >= 2) {
            game.score += player._killStreak * 25;
          }
          // Per-kill energy bonus (any NN mode) so building is sustainable
          // even outside Defense's wave-clear payouts.
          if (game._nnMode) {
            game._energy = Math.min(999, (game._energy || 0) + BALANCE.energy.perKill);
          }
          // Slow-mo on 3+ killstreak — 0.55× for 1.5s, retriggers on each
          // subsequent kill so a hot streak stays in slow-mo. Tiny shake on
          // every kill so even a single shot punches.
          if (player._killStreak >= 3) {
            // Kill-streak bullet-time. Gated behind game._vfxEnabled so it
            // can be flipped on/off without code changes. User initially
            // perceived it as 'lag' so it ships off; re-enable by setting
            // game._vfxEnabled = true (lobby toggle could expose this).
            if (game._vfxEnabled) triggerSlowMo(0.55, 90);
            triggerShake(4, 8);
            unlockAchievement('killstreak3');
            if (player._killStreak >= 5) unlockAchievement('killstreak5');
            // Crazy Games — 3+ streak is a 'happytime' beat (positive
            // gameplay moment; SDK uses it for analytics + ad-cadence cues).
            if (typeof crazyEvent_happytime === 'function') crazyEvent_happytime();
          } else {
            triggerShake(2, 4);
          }
          // First kill + cumulative + low-HP kill achievements
          unlockAchievement('first_blood');
          if (player.hp <= 5) unlockAchievement('survive_low');
          if (b.isRocket) unlockAchievement('rocket_kill');
          // Stats — read off persisted totalKills + check thresholds
          try {
            const _s = JSON.parse(localStorage.getItem('ag.stats') || '{}');
            const total = (_s.totalKills || 0) + (game.killCount || 0);
            if (total >= 100) unlockAchievement('kills_100');
          } catch (e) {}
          // Track which chassis the player killed with — for the COMMANDER
          // achievement (win/play with all 3). Bumped here so any kill counts
          // as 'used this chassis this match'; finish-of-match logic checks.
          if (player._chassis) {
            try {
              const u = JSON.parse(localStorage.getItem('ag.chassisUsed') || '[]');
              if (!u.includes(player._chassis)) {
                u.push(player._chassis);
                localStorage.setItem('ag.chassisUsed', JSON.stringify(u));
                if (u.length >= 3) unlockAchievement('tactical_win');
              }
            } catch (e) {}
          }
        }
        hit = true; break;
      }
    }
    if (!hit) for (const d of enemyDrones) {
      if (!d.alive) continue;
      if (Math.hypot(b.x-d.x, b.y-d.y) < d.radius) {
        d.hp -= b.damage;
        if (d.hp <= 0) { d.alive = false; game.score += 150; game.killCount++; createExplosion(d.x, d.y, 'small'); /* kill SFX removed */ }
        hit = true; break;
      }
    }
    if (!hit) for (let bi = 0; bi < buildings.length; bi++) {
      const bd = buildings[bi];
      if (b.x > bd.x && b.x < bd.x+bd.w && b.y > bd.y && b.y < bd.y+bd.h) {
        if (game._nnGameMode === 'defense' && bd.hp != null) {
          bd.hp -= b.damage || 12;
          if (bd.hp <= 0) {
            createExplosion(bd.x + bd.w/2, bd.y + bd.h/2, 'small');
            buildings.splice(bi, 1);
          }
        }
        hit = true; break;
      }
    }
    // Wall-line bullet collision — capsule check (segment + thickness/2).
    if (!hit) for (let li = 0; li < wallLines.length; li++) {
      const w = wallLines[li];
      if (w.hp <= 0) continue;
      const r = _segPointDist(b.x, b.y, w.x1, w.y1, w.x2, w.y2);
      if (r.dist <= w.thickness / 2) {
        if (w.hp != null) {
          w.hp -= b.damage || 12;
          if (w.hp <= 0) {
            createExplosion(r.cx, r.cy, 'small');
            wallLines.splice(li, 1);
          }
        }
        hit = true; break;
      }
    }
    if (!hit) for (let li = 0; li < lowCovers.length; li++) {
      const lc = lowCovers[li];
      if (b.x > lc.x && b.x < lc.x+lc.w && b.y > lc.y && b.y < lc.y+lc.h) {
        // Phase 114 — pass-through when the shooter is INSIDE this same
        // lowCover. User: '如果我今天在這一個方塊裡面, 然後敵人也進這個
        // 方塊, 敵人是射得到我的, 這樣才公平'.
        // Two effects of the same rule:
        //   • Fire OUT of your own cover — bullets aren't eaten on spawn
        //     the moment they leave your waist; they exit normally.
        //   • Same-cover firefight — if you AND the enemy both stand in
        //     the same lowCover bbox, neither cover-blocks the other's
        //     shots, and damage registers normally.
        // Bullets coming IN from outside still die at the cover (that's
        // the whole point of cover for the person inside).
        const fu = b.fromUnit;
        if (fu && fu.alive
            && fu.x > lc.x && fu.x < lc.x+lc.w
            && fu.y > lc.y && fu.y < lc.y+lc.h) {
          continue;     // shooter is inside this cover — let bullet pass
        }
        if (game._nnGameMode === 'defense' && lc.hp != null) {
          lc.hp -= b.damage || 12;
          if (lc.hp <= 0) {
            createExplosion(lc.x + lc.w/2, lc.y + lc.h/2, 'small');
            lowCovers.splice(li, 1);
          }
        }
        hit = true; break;
      }
    }
    // Spawn beacons: small + circular hitbox; hit them with regular fire too
    if (!hit && game._spawnBeacons) {
      for (let ci = 0; ci < game._spawnBeacons.length; ci++) {
        const bk = game._spawnBeacons[ci];
        if (bk.hp <= 0) continue;
        if (Math.hypot(b.x - bk.x, b.y - bk.y) < 22) {
          bk.hp -= b.damage || 12;
          spawnDamagePopup(bk.x, bk.y - 24, b.damage || 12, false);
          if (bk.hp <= 0) {
            createExplosion(bk.x, bk.y, 'big');
            showSwapToast(T(`敌方重生点已摧毁`, `Enemy spawn destroyed`));
            unlockAchievement('beacon_kill');
            game._spawnBeacons.splice(ci, 1);
            game._energy = Math.min(999, (game._energy || 0) + BALANCE.energy.spawnBeaconDestroy);
            game.score += 250;
          }
          hit = true; break;
        }
      }
    }
    // Rockets ALSO detonate on contact with structure walls (the player's
    // own wall stack lives in game._structures, not buildings[], so the
    // generic check above doesn't see them). Same for enemy structures
    // when those exist later. AOE handles damage; here we just trigger.
    if (!hit && b.isRocket && game._structures) {
      for (const s of game._structures) {
        const def = STRUCTURE_DEFS[s.kind]; if (!def || s.hp <= 0) continue;
        if (!def.blocks) continue;   // only solid blockers (walls)
        const r = def.size / 2;
        if (Math.abs(b.x - s.x) <= r && Math.abs(b.y - s.y) <= r) { hit = true; break; }
      }
    }
    if (hit && b.isRocket) {
      detonateRocket(b);
    } else if (b.life <= 0 && b.isRocket) {
      // Lifetime-expired rocket detonates in mid-air rather than vanishing
      detonateRocket(b);
    }
    if (hit || b.life <= 0) bullets.splice(i, 1);
  }
  // Enemy-targeted bullet pass below — also damage player structures.
  for (let i = enemyBullets.length-1; i >= 0; i--) {
    const b = enemyBullets[i];
    b.x += b.vx; b.y += b.vy;
    b.life--;
    let hit = false;
    // Mission-specific damage hook (UGV / heavy / relay take damage from enemy fire)
    if (mission && mission.onEnemyBulletHit && mission.onEnemyBulletHit(b)) hit = true;
    if (!hit && player.alive && Math.hypot(b.x-player.x, b.y-player.y) < player.radius) {
      hit = true;
      if (player._invulnUntil != null && game.time < player._invulnUntil) {
        // (consume bullet silently)
      } else {
        // Phase 56: NN bullet damage applies in BOTH SP and MP. Phase 51
        // suppressed it in MP to fix the '血量卡在80 馬上恢復' jitter,
        // but that left the player invincible to NN bots in MP+NN rooms
        // where no other MP players were present (CrazyGames QA case).
        // The jitter is now solved properly via min() reconciliation in
        // multiplayer.js' snapshot handler — local NN damage is preserved
        // because the server's higher hp doesn't overwrite our lower
        // local hp.
        _applyDamageToUnit(player, b.damage);
        game.hitFlash = 12;
        playSfx('hit');
        triggerShake(Math.min(6, b.damage * 0.25), 8);
        // Track most recent damage source for the killer-info banner
        player._lastDamageBy = b.fromUnit || null;
        player._lastDamageWeapon = b.weaponName || '';
        // Phase 179 — recent-hits log for the death recap / killcam (was read
        // by death_recap.js but never populated). Keep the last 6, cheap.
        if (!player._recentHits) player._recentHits = [];
        player._recentHits.push({ dmg: b.damage, weapon: b.weaponName || '' });
        if (player._recentHits.length > 6) player._recentHits.shift();
        // Directional hurt indicator — angle FROM player TO bullet source.
        // Decays over ~30 frames; render in renderHUDOverlays as edge glow.
        const srcX = b.x - b.vx, srcY = b.y - b.vy;
        player._hurtAngle = Math.atan2(srcY - player.y, srcX - player.x);
        player._hurtIntensity = Math.min(1, (player._hurtIntensity || 0) + 0.6);
        if (player.hp <= 0 && player.alive) {
          // Bullet-specific telemetry — recorded BEFORE the state transition
          // so the death-recap UI can read the killer / weapon next frame.
          player._killer = b.fromUnit || null;
          player._killerWeapon = b.weaponName || '';
          // Streak ends with you
          player._killStreak = 0;
          player._killStreakFlashUntil = 0;
          // R12 — canonical state transition: alive=false, hp=0,
          // _lbBumpDeath, _lastDeathX/Y, _respawnAt, _killedAtTime.
          if (typeof PlayerLifecycle !== 'undefined') {
            PlayerLifecycle.killPlayer({ x: player.x, y: player.y });
          }
          createExplosion(player.x, player.y, 'big');
          playSfx('death');
          // Crazy Games — count the death for the midgame-ad cadence.
          if (typeof crazyNoteDeath === 'function') crazyNoteDeath();
          // Trigger the death-recap overlay — captures the kill state at
          // this instant so the render later doesn't have to recompute.
          if (typeof triggerDeathRecap === 'function') {
            triggerDeathRecap();
          }
        }
      }
    }
    // Bullet whiz: enemy bullet passing close — pitch + supersonic crack scale
    // with bullet speed, pan with lateral offset relative to player view.
    if (!hit && player.alive) {
      const d = Math.hypot(b.x - player.x, b.y - player.y);
      const WHIZ_RANGE = 80;
      if (d < WHIZ_RANGE && d >= player.radius && !b._whizzed) {
        b._whizzed = true;
        const va = (player.viewAngle != null) ? player.viewAngle : (player.angle || 0);
        const lx = (b.x - player.x) * Math.cos(-va) - (b.y - player.y) * Math.sin(-va);
        const pan = Math.max(-1, Math.min(1, lx / WHIZ_RANGE));
        const proximity = 1 - d / WHIZ_RANGE;          // 0 at edge, 1 at center
        const speed = Math.hypot(b.vx, b.vy);
        // Faster bullet → higher whiz pitch (3500–6000 Hz)
        const whizFreq = 3500 + Math.min(2500, speed * 110);
        playSfx('whiz', { pan, vol: 0.36 * proximity, freq: whizFreq });
        // Supersonic snap for sniper-class rounds within point-blank range
        if (speed > 18 && proximity > 0.5) {
          playSfx('crack', { pan, vol: 0.42 * proximity });
        }
      }
    }
    if (!hit) for (const a of allies) {
      if (!a.alive) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) < a.radius) {
        if (a._invulnUntil != null && game.time < a._invulnUntil) { hit = true; break; }
        const wasFullish = a.hp / a.maxHp > 0.5;
        _applyDamageToUnit(a, b.damage);
        // Phase 97 — NN ally taking damage gets the same alert treatment
        // as enemy NN units (back-trace bullet → force combat mode).
        // Without this, allies stood like dummies while reds shot them
        // through cover (their cone never saw the shooter).
        if (a._useNN) _nnNoteHit(a, b);
        if (a.hp <= 0) {
          a.alive = false;
          createExplosion(a.x, a.y, 'small');
          playPositionalSound(a.x, a.y, 1500, 'shot', false);
          // Squad callout: KIA — directional cue
          if (typeof showRadioToast === 'function' && a.callsign) {
            const dir = _dirCardinal(a.x - player.x, a.y - player.y);
            _radioOnce('kia_' + a.callsign, 6, _r('小队', 'SQUAD'),
              _r(`"${a.callsign} 阵亡 — ${dir}"`,
                 `"${a.callsign} down — ${dir}"`));
          }
        } else if (wasFullish && a.hp / a.maxHp <= 0.5 && a.callsign) {
          // First time this match the ally drops below 50% → callout
          const dir = _dirCardinal(a.x - player.x, a.y - player.y);
          _radioOnce('hurt_' + a.callsign, 8, _r('小队', 'SQUAD'),
            _r(`"${a.callsign} 受伤 — ${dir} 侧"`,
               `"${a.callsign} hit — ${dir} side"`));
        }
        hit = true;
        break;
      }
    }
    if (!hit) for (let bi = 0; bi < buildings.length; bi++) {
      const bd = buildings[bi];
      if (b.x > bd.x && b.x < bd.x+bd.w && b.y > bd.y && b.y < bd.y+bd.h) {
        if (game._nnGameMode === 'defense' && bd.hp != null) {
          bd.hp -= b.damage || 12;
          if (bd.hp <= 0) {
            createExplosion(bd.x + bd.w/2, bd.y + bd.h/2, 'small');
            buildings.splice(bi, 1);
          }
        }
        hit = true; break;
      }
    }
    // Wall-line bullet collision — capsule check (segment + thickness/2).
    if (!hit) for (let li = 0; li < wallLines.length; li++) {
      const w = wallLines[li];
      if (w.hp <= 0) continue;
      const r = _segPointDist(b.x, b.y, w.x1, w.y1, w.x2, w.y2);
      if (r.dist <= w.thickness / 2) {
        if (w.hp != null) {
          w.hp -= b.damage || 12;
          if (w.hp <= 0) {
            createExplosion(r.cx, r.cy, 'small');
            wallLines.splice(li, 1);
          }
        }
        hit = true; break;
      }
    }
    if (!hit) for (let li = 0; li < lowCovers.length; li++) {
      const lc = lowCovers[li];
      if (b.x > lc.x && b.x < lc.x+lc.w && b.y > lc.y && b.y < lc.y+lc.h) {
        // Phase 114 — same pass-through rule as player bullets (above):
        // if the enemy shooter is also inside this lowCover (same bbox
        // firefight), let the bullet pass so a player crouched in the
        // cover can be hit fairly. See header comment in the player
        // bullet branch for the full rationale.
        const fu = b.fromUnit;
        if (fu && fu.alive
            && fu.x > lc.x && fu.x < lc.x+lc.w
            && fu.y > lc.y && fu.y < lc.y+lc.h) {
          continue;
        }
        if (game._nnGameMode === 'defense' && lc.hp != null) {
          lc.hp -= b.damage || 12;
          if (lc.hp <= 0) {
            createExplosion(lc.x + lc.w/2, lc.y + lc.h/2, 'small');
            lowCovers.splice(li, 1);
          }
        }
        hit = true; break;
      }
    }
    // Player-built structures take damage from enemy bullets — EXCEPT
    // mines/tripmines (Phase 63: bulletImmune). The only way to clear a
    // mine is the G-key defuse (see _tryDefuseMine). Bullets passing over
    // them just continue.
    if (!hit && game._structures) {
      for (let si = 0; si < game._structures.length; si++) {
        const s = game._structures[si];
        const def = STRUCTURE_DEFS[s.kind]; if (!def || s.hp <= 0) continue;
        if (def.bulletImmune) continue;
        const r = def.size / 2;
        if (Math.abs(b.x - s.x) <= r && Math.abs(b.y - s.y) <= r) {
          s.hp -= b.damage || 12;
          spawnDamagePopup(b.x, b.y - 6, b.damage || 12, false);
          hit = true; break;
        }
      }
    }
    if (hit && b.isRocket) detonateRocket(b);
    if (hit || b.life <= 0) enemyBullets.splice(i, 1);
  }
}
