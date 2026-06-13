// ============ WORLD RENDER (R6 refactor) ============
// All visual rendering of map objects: terrain, buildings, lowCovers
// (waist-high cover with diagonal hatch), overheads (elevated awnings),
// wallLines, structure footprints.
//
// Before R6 these functions lived inline in the 12 000-line script in
// index.html. renderWorld() alone was 659 lines — the longest single
// function in the codebase. Touching map visuals (theme palettes, TOD
// tinting, damage cracks, building windows) meant scrolling through
// hundreds of lines of unrelated game state / HUD / bullet logic.
//
// Functions moved (signatures + behaviour 1:1):
//   renderFootprints()   structure placement ghosts (build mode preview)
//   renderWorld()        main world draw — sky, floor, theme shapes,
//                        wallLines (shadow + body + damage hatch +
//                        power conductor), buildings (body + windows +
//                        accent), invokes drawLowCovers + drawOverheads
//                        at the right z-order.
//   drawLowCovers()      waist-high cover with diagonal hatch
//   drawOverheads()      raised awnings / canopies
//
// External deps (resolved at call-time via classic-script globals):
//   ctx · COLORS · WORLD · game · buildings · lowCovers · overheads ·
//   wallLines · themeShapes · structureFootprints · player · camera ·
//   COLORS.sky / .floor / .gray / .cream / .red / .black / .creamDark ·
//   etc.
//
// Generation HELPERS (addBuilding / addLowCover / addOverhead /
// addTheme) stay in index.html for this round — they're tightly
// coupled with the MAPS table that lives there too. World-gen
// extraction is a separate future refactor.

function renderFootprints() {
  if (!game._footprints || !game._footprints.length) return;
  ctx.save();
  for (const f of game._footprints) {
    const a = f.life / f.maxLife;
    ctx.fillStyle = f.team === 0
      ? `rgba(40, 60, 100, ${0.25 * a})`
      : `rgba(200, 38, 28, ${0.30 * a})`;
    // Two dots per print (left/right foot offset perpendicular to angle)
    const off = 4;
    const sx = Math.cos(f.angle - Math.PI / 2) * off;
    const sy = Math.sin(f.angle - Math.PI / 2) * off;
    ctx.beginPath(); ctx.arc(f.x + sx, f.y + sy, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(f.x - sx, f.y - sy, 2.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function renderWorld() {
  // Grid (subtle)
  ctx.strokeStyle = COLORS.creamDark;
  ctx.lineWidth = 1;
  const gridSize = 80;
  const viewBuffer = 200;
  const startX = Math.max(0, camera.x - W()/camera.scale - viewBuffer);
  const startY = Math.max(0, camera.y - H()/camera.scale - viewBuffer);
  const endX = Math.min(WORLD.w, camera.x + W()/camera.scale + viewBuffer);
  const endY = Math.min(WORLD.h, camera.y + H()/camera.scale + viewBuffer);
  ctx.beginPath();
  for (let x = Math.floor(startX/gridSize)*gridSize; x < endX; x += gridSize) {
    ctx.moveTo(x, startY); ctx.lineTo(x, endY);
  }
  for (let y = Math.floor(startY/gridSize)*gridSize; y < endY; y += gridSize) {
    ctx.moveTo(startX, y); ctx.lineTo(endX, y);
  }
  ctx.stroke();
  // === THEME-DRIVEN MAP DRESSING ===
  drawThemeShapes();
  drawRoutes();
  drawLandmarksUnder();

  // Decorative shapes
  for (const d of decorations) {
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.angle);
    ctx.fillStyle = d.color;
    ctx.globalAlpha = d.opacity;
    if (d.type === 'triangle') {
      ctx.beginPath();
      ctx.moveTo(0, -d.size/2);
      ctx.lineTo(d.size/2, d.size/2);
      ctx.lineTo(-d.size/2, d.size/2);
      ctx.closePath();
      ctx.fill();
    } else if (d.type === 'square') {
      ctx.fillRect(-d.size/2, -d.size/2, d.size, d.size);
    } else {
      ctx.fillRect(-d.size, -1.5, d.size*2, 3);
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // Network lines
  ctx.strokeStyle = COLORS.gray;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  for (let i = 0; i < networkNodes.length; i++) {
    const a = networkNodes[i];
    for (let j = i+1; j < Math.min(networkNodes.length, i+4); j++) {
      const b = networkNodes[j];
      const d = Math.hypot(a.x-b.x, a.y-b.y);
      if (d < 380) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Building shadows (offset)
  for (const b of buildings) {
    ctx.fillStyle = COLORS.creamDark;
    ctx.fillRect(b.x+10, b.y+10, b.w, b.h);
  }
  // Buildings
  for (const b of buildings) {
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    if (b.accent) {
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(b.x, b.y, b.w*0.25, 14);
    }
    // Window pattern (top)
    ctx.fillStyle = b.color === COLORS.gray ? COLORS.creamDark : COLORS.gray;
    ctx.globalAlpha = 0.4;
    for (let yy = b.y + 12; yy < b.y + b.h - 8; yy += 14) {
      for (let xx = b.x + 8; xx < b.x + b.w - 8; xx += 14) {
        ctx.fillRect(xx, yy, 6, 6);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Wall lines — drawn as stroked vector segments. Drop-shadow first
  // (offset SE by 4u, dim cream), then the body in `color`. HP-damaged
  // walls fade toward black-on-cream so the player can read 'this one
  // is about to break' at a glance. Powered walls get a faint red core
  // pulse so the player can read the live conductor at a glance.
  for (const w of wallLines) {
    if (w.hp <= 0) continue;
    const dmg = w.maxHp ? (1 - w.hp / w.maxHp) : 0;
    // shadow
    ctx.strokeStyle = COLORS.creamDark;
    ctx.lineWidth = w.thickness;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(w.x1 + 4, w.y1 + 4); ctx.lineTo(w.x2 + 4, w.y2 + 4); ctx.stroke();
    // body
    ctx.strokeStyle = w.color;
    ctx.beginPath(); ctx.moveTo(w.x1, w.y1); ctx.lineTo(w.x2, w.y2); ctx.stroke();
    // Power conductor core — thin red stripe down the middle when energised.
    // Pulses at 1.4 Hz so the wire is alive-looking, not just a gradient.
    if (w._powered) {
      const pulse = 0.5 + Math.sin(game.time * 0.09) * 0.5;
      ctx.strokeStyle = COLORS.red;
      ctx.globalAlpha = 0.35 + 0.45 * pulse;
      ctx.lineWidth = Math.max(2, w.thickness * 0.18);
      ctx.beginPath(); ctx.moveTo(w.x1, w.y1); ctx.lineTo(w.x2, w.y2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // damage cracks — diagonal hatch when dmg > 0.4
    if (dmg > 0.4) {
      ctx.strokeStyle = COLORS.black;
      ctx.lineWidth = 1;
      ctx.globalAlpha = dmg * 0.5;
      const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      const ux = (w.x2 - w.x1) / len, uy = (w.y2 - w.y1) / len;
      const nx = -uy, ny = ux;
      const half = w.thickness / 2 - 1;
      const segs = Math.max(2, Math.floor(len / 30));
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        const cx = w.x1 + (w.x2 - w.x1) * t;
        const cy = w.y1 + (w.y2 - w.y1) * t;
        ctx.beginPath();
        ctx.moveTo(cx + nx * half * 0.6, cy + ny * half * 0.6);
        ctx.lineTo(cx - nx * half * 0.6, cy - ny * half * 0.6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
  ctx.lineCap = 'butt';
  ctx.lineWidth = 1;

  // Low covers (waist-high — between buildings & units in z-order)
  drawLowCovers();

  // Landmark mid layer (silhouette body that sits with buildings)
  drawLandmarksMid();

  // Network nodes (decorative)
  for (const n of networkNodes) {
    n.pulse += 0.05;
    const r = 2.5 + Math.sin(n.pulse)*1;
    ctx.fillStyle = COLORS.gray;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Bullets — rockets render as a chunky missile body + flame tail; regular
  // rounds get a 3-layer streak so they pop on ANY TOD background:
  //   (1) wide dark outline (4 px) for contrast on bright TODs
  //   (2) bright core (2 px) for visibility on dark TODs (night/dawn)
  //   (3) tracer head dot at the bullet position
  // Player bullets: cream core (universally readable). Enemy: bright red.
  // Streak length 2.2× (was 1.6×) so the line is easier to track.
  ctx.lineCap = 'round';
  // --- Player bullets ---
  for (const b of bullets) {
    // No ghost-skip here anymore. In MP, OUR bullets render locally
    // (predicted at 60 fps so they feel snappy and match NN-bullet
    // speed). _mpRenderRemoteBullets skips server-echoes whose shooter
    // id == our id, so there's no twin-tracer. Phase 51's "skip ghost"
    // approach made our bullets feel laggy — see the matching note in
    // _mpRenderRemoteBullets and in fire().
    if (b.isRocket) { _drawRocket(b, false); continue; }
    const tx = b.x - b.vx * 2.2;
    const ty = b.y - b.vy * 2.2;
    // Outline (dark, wider)
    ctx.strokeStyle = COLORS.black;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y); ctx.lineTo(tx, ty);
    ctx.stroke();
    // Bright core
    ctx.strokeStyle = COLORS.cream;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y); ctx.lineTo(tx, ty);
    ctx.stroke();
    // Head dot
    ctx.fillStyle = COLORS.cream;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // --- Enemy bullets ---
  for (const b of enemyBullets) {
    if (!isVisibleToFriendly(b.x, b.y)) continue;
    if (b.isRocket) { _drawRocket(b, true); continue; }
    const tx = b.x - b.vx * 2.2;
    const ty = b.y - b.vy * 2.2;
    // Outline (deep red, wider)
    ctx.strokeStyle = COLORS.black;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y); ctx.lineTo(tx, ty);
    ctx.stroke();
    // Bright red core
    ctx.strokeStyle = COLORS.redBright || '#E63329';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y); ctx.lineTo(tx, ty);
    ctx.stroke();
    // Head dot
    ctx.fillStyle = COLORS.redBright || '#E63329';
    ctx.beginPath();
    ctx.arc(b.x, b.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineCap = 'butt';
  ctx.lineWidth = 1;

  // Grenades — black sphere + pulsing red fuse light + flashing in last 0.5s
  for (const g of grenades) {
    const final = g.fuse < 30;            // last 0.5s — flash white
    const flash = final && (game.time & 4) === 0;
    ctx.fillStyle = flash ? COLORS.cream : COLORS.black;
    ctx.beginPath(); ctx.arc(g.x, g.y, 6, 0, Math.PI*2); ctx.fill();
    // Fuse pulse (slow → fast as fuse runs out)
    const fusePeriod = Math.max(4, Math.floor(g.fuse / 6));
    if ((game.time % fusePeriod) < (fusePeriod / 2)) {
      ctx.fillStyle = COLORS.red;
      ctx.beginPath(); ctx.arc(g.x, g.y - 8, 2.5, 0, Math.PI*2); ctx.fill();
    }
    // Aim/range hint while still in flight (faint dotted circle showing kill radius)
    if (final) {
      ctx.strokeStyle = 'rgba(200, 38, 28, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.arc(g.x, g.y, GRENADE_RADIUS, 0, Math.PI*2); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Muzzle flashes
  for (const m of muzzleFlashes) {
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(m.angle);
    ctx.fillStyle = COLORS.red;
    ctx.globalAlpha = m.life / 5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(22, -7);
    ctx.lineTo(30, 0);
    ctx.lineTo(22, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // Damage popups — float up + fade. Kill hits use bigger red text,
  // non-fatal hits cream + smaller. Drawn in WORLD-space (camera applies).
  for (const p of damagePopups) {
    const t = p.life / 36;             // 1 → 0
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 1.4);
    ctx.fillStyle = p.kill ? COLORS.red : COLORS.cream;
    ctx.font = p.kill ? 'bold 16px sans-serif' : 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.kill ? `−${p.damage}!` : `−${p.damage}`, p.x, p.y);
    ctx.textAlign = 'left';
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // FPV trail
  if (fpv.active) {
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 2;
    for (let i = 1; i < fpv.trail.length; i++) {
      const t = fpv.trail[i];
      const t0 = fpv.trail[i-1];
      ctx.globalAlpha = t.life / 25 * 0.7;
      ctx.beginPath();
      ctx.moveTo(t0.x, t0.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Drone vision indicator
  if (drone.deployed) {
    ctx.strokeStyle = COLORS.black;
    ctx.globalAlpha = 0.18;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(drone.x, drone.y, drone.visionRadius, 0, Math.PI*2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Phase 62: burning wreckage. Drawn here so live units render ABOVE the
  // smoldering bodies (top-down realism — you walk over the corpse, not
  // around it). Glow + silhouette + embers all decay with `life`; defined
  // near updateWreckages above.
  renderWreckages();
  // Phase 63: mine defuse progress ring (only when actively defusing).
  renderMineDefuseRing();

  // Enemies — visibility memory prevents flicker:
  //  - Visible right now → full alpha + refresh _lastSeen.
  //  - Recently lost LoS (within 3s) → fade-out "memory" silhouette.
  //  - Beyond memory window → not rendered at all.
  for (const e of enemies) {
    if (!e.alive) continue;
    let alpha = 0;
    if (isVisibleToFriendly(e.x, e.y)) {
      e._lastSeen = game.time;
      alpha = 1;
    } else if (e._lastSeen != null && game.time - e._lastSeen < 180) {
      alpha = Math.max(0.25, 1 - (game.time - e._lastSeen) / 180);
    }
    if (alpha === 0) continue;
    // Spawn-invuln pulse: alpha oscillates between 0.4 and 1.0 while active
    const eInvuln = e._invulnUntil != null && game.time < e._invulnUntil;
    if (eInvuln) alpha = 0.7 + 0.3 * Math.abs(Math.sin(game.time * 0.25));
    ctx.globalAlpha = alpha;
    // Phase 18: KO-stunned enemies render in pale-cream + slow-pulse so
    // they read as 'neutralized, waiting to be recruited' rather than
    // 'live threat'. User: '他就變白色之類的'.
    const _stunPulse = e._koStunned ? (0.6 + 0.25 * Math.sin(game.time * 0.10)) : 1;
    if (e._koStunned) ctx.globalAlpha = alpha * _stunPulse;
    // Phase 149 — flash the body white for a few frames when freshly hit.
    const _eHit = (typeof game !== 'undefined') && game.time < (e._hitFlashUntil || 0);
    const _bodyColor = _eHit ? '#FFFFFF' : (e._koStunned ? COLORS.cream : COLORS.red);
    drawHumanoid(e.x, e.y, e.angle, e.walkPhase, _bodyColor, true, e);
    // Phase 98 — "!" alert indicator. Visible above any NN unit currently
    // in ONNX combat state from a recent damage trigger (1.5s window).
    // Lets the player SEE that hits + sound events are actually waking
    // up the right brain (the ONNX policy), not just the patrol code.
    // User '重點是要進入戰鬥狀態(onnx)'.
    if (e._useNN && e._aiMode === 'combat' && (e._nnRecentDmg || 0) > 0) {
      const _pulse = 0.7 + 0.3 * Math.sin(game.time * 0.4);
      ctx.fillStyle = `rgba(255, 140, 60, ${_pulse})`;
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('!', e.x, e.y - 32);
    }
    if (e.hp < e.maxHp) {
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(e.x-15, e.y-26, 30, 3);
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(e.x-15, e.y-26, 30 * e.hp/e.maxHp, 3);
    }
    // Heavy chassis armor bar — cyan, above HP, only when armor > 0
    if (e._chassis === 'heavy' && e.maxArmor > 0 && e.armor > 0) {
      ctx.fillStyle = 'rgba(20,20,32,0.55)';
      ctx.fillRect(e.x-15, e.y-30, 30, 2);
      ctx.fillStyle = '#42B7E8';
      ctx.fillRect(e.x-15, e.y-30, 30 * e.armor/e.maxArmor, 2);
    }
    // Phase 4: SEED label + recruit-cue. Show enemy SEED when within
    // engagement range (≤200u). When VISIBLE GATES (distance + HP + SEED
    // diff) all pass, draw a red "▶ G" pulse so the player knows recruit
    // is a press away. _humanPiloted is INTENTIONALLY excluded from the
    // cue — that gate fails silently so the player learns by feel that
    // some targets resist (forward-compat for PvP).
    if (game._nnMode) {
      const _ed = Math.hypot(e.x - player.x, e.y - player.y);
      if (_ed < 200) {
        const _eSeed = Math.floor(e._seed || 0);
        ctx.fillStyle = COLORS.black;
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`SEED ${_eSeed}`, e.x, e.y - 36);
        ctx.textAlign = 'left';
        // Recruit cue — STUNNED targets show a bright pulsing '▶ G' as
        // soon as the player is within touch range (no SEED gate). Live
        // targets still need the original 3-gate path.
        const _pR = (player.radius || 13) + (e.radius || 13) + ARENA_TOUCH_BUFFER;
        const _gRng = _ed <= _pR;
        const _gHp = e.hp < (e.maxHp || 80) * ARENA_HP_GATE;
        const _gSeed = ((player._seed || 0) - _eSeed) > ARENA_SEED_GAP;
        const _stunReady = e._koStunned && _gRng;
        const _liveReady = !e._koStunned && _gHp && _gRng && _gSeed;
        if (_stunReady || _liveReady) {
          const _pulse = 0.6 + 0.4 * Math.sin(game.time * 0.2);
          // Phase 150 — recruitable-in-range: tag with an inviting ally-teal
          // ring + prompt (teal, NOT enemy-red, so the grab cue pops against
          // the red mob). This is the gateway to the whole squad loop.
          if (_stunReady) {
            const _rr = (e.radius || 13) + 9 + 2 * Math.sin(game.time * 0.2);
            ctx.strokeStyle = `rgba(95, 214, 160, ${0.55 + 0.4 * _pulse})`;
            ctx.lineWidth = 2.5;
            ctx.beginPath(); ctx.arc(e.x, e.y, _rr, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = `rgba(95, 214, 160, ${_pulse})`;
          } else {
            ctx.fillStyle = `rgba(230, 51, 41, ${_pulse})`;   // live-gate cue stays red
          }
          ctx.font = 'bold 12px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(_stunReady ? T('▶ G 招降', '▶ G GRAB') : '▶ G', e.x, e.y - 48);
          ctx.textAlign = 'left';
        } else if (e._koStunned) {
          // Stunned but out of touch range — a faint teal ring + hint pulls
          // the player over (recruit opportunity visible from a distance).
          const _p = 0.5 + 0.3 * Math.sin(game.time * 0.18);
          const _rr = (e.radius || 13) + 7;
          ctx.strokeStyle = `rgba(95, 214, 160, ${0.22 + 0.22 * _p})`;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(e.x, e.y, _rr, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = 'rgba(95, 214, 160, 0.82)';
          ctx.font = 'bold 10px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(T('招降目標', 'RECRUIT'), e.x, e.y - 48);
          ctx.textAlign = 'left';
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // Kamikaze drones — same visibility memory
  for (const d of enemyDrones) {
    if (!d.alive) continue;
    let alpha = 0;
    if (isVisibleToFriendly(d.x, d.y)) {
      d._lastSeen = game.time;
      alpha = 1;
    } else if (d._lastSeen != null && game.time - d._lastSeen < 180) {
      alpha = Math.max(0.25, 1 - (game.time - d._lastSeen) / 180);
    }
    if (alpha === 0) continue;
    ctx.globalAlpha = alpha;
    drawDrone(d.x, d.y, COLORS.red, d.hoverPhase + game.time*0.2);
    // Aim line so the player can read which way it's diving
    ctx.save();
    ctx.strokeStyle = 'rgba(200,38,28,0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(d.x, d.y);
    ctx.lineTo(d.x + Math.cos(d.angle)*60, d.y + Math.sin(d.angle)*60);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    if (d.hp < d.maxHp) {
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(d.x-12, d.y-22, 24, 2);
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(d.x-12, d.y-22, 24 * d.hp/d.maxHp, 2);
    }
    ctx.globalAlpha = 1;
  }

  // Allies (squad)
  for (const a of allies) {
    if (!a.alive) continue;
    // Spawn-invuln pulse-flicker is the visual cue for "just respawned,
    // can't be killed yet".
    const aInvuln = a._invulnUntil != null && game.time < a._invulnUntil;
    // Phase X — user '看不到剛出生的'. Alpha used to range 0.4-0.9 which
    // made cream-on-dark allies near-invisible at the trough. Raised to
    // 0.7-1.0 so the spawn-protect flicker is still readable as "this
    // unit is invulnerable" while keeping the silhouette legible.
    if (aInvuln) ctx.globalAlpha = 0.7 + 0.3 * Math.abs(Math.sin(game.time * 0.25));
    // Phase 149 — allies flash white on hit too (same tactile read).
    const _aHit = (typeof game !== 'undefined') && game.time < (a._hitFlashUntil || 0);
    drawHumanoid(a.x, a.y, a.angle, a.walkPhase, _aHit ? '#FFFFFF' : COLORS.creamDark, false, a);
    if (aInvuln) ctx.globalAlpha = 1;
    // Phase 98 — same "!" alert for friendly NN units. Same combat trigger,
    // same visual rule. Confirms ONNX-state on the team you actually
    // control, useful for verifying squad-awareness ripple from the bot
    // standing nearest the shooter.
    if (a._useNN && a._aiMode === 'combat' && (a._nnRecentDmg || 0) > 0) {
      const _pulse = 0.7 + 0.3 * Math.sin(game.time * 0.4);
      ctx.fillStyle = `rgba(255, 140, 60, ${_pulse})`;
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('!', a.x, a.y - 32);
    }
    // Cream outline highlight to distinguish from enemies
    ctx.save();
    ctx.strokeStyle = COLORS.cream;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.radius + 3, 0, Math.PI*2);
    ctx.stroke();
    // Callsign label
    ctx.fillStyle = COLORS.black;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(a.callsign, a.x, a.y - 22);
    // Phase 16 — SEED chip on allies. The player needs to see ally SEED
    // values too (their squad bots train up over time + the recruit-gate
    // diff includes them, e.g. for swap targets). Match enemy SEED label
    // style for consistency.
    if (game._nnMode) {
      const _aSeed = Math.floor(a._seed || 0);
      ctx.font = 'bold 9px monospace';
      ctx.fillStyle = COLORS.black;
      ctx.fillText(`SEED ${_aSeed}`, a.x, a.y - 34);
    }
    ctx.textAlign = 'left';
    // HP bar
    if (a.hp < a.maxHp) {
      ctx.fillStyle = COLORS.creamDark;
      ctx.fillRect(a.x-15, a.y-32, 30, 3);
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(a.x-15, a.y-32, 30 * a.hp/a.maxHp, 3);
    }
    // Heavy chassis armor bar — cyan, above HP, only when armor > 0
    if (a._chassis === 'heavy' && a.maxArmor > 0 && a.armor > 0) {
      ctx.fillStyle = 'rgba(20,20,32,0.55)';
      ctx.fillRect(a.x-15, a.y-36, 30, 2);
      ctx.fillStyle = '#42B7E8';   // armor-blue
      ctx.fillRect(a.x-15, a.y-36, 30 * a.armor/a.maxArmor, 2);
    }
    ctx.restore();
  }

  // Cull enemy bullets that fly through dark
  // (The render is a separate loop above — visibility check happens there.)

  // Player
  if (player.alive) {
    const pInvuln = player._invulnUntil != null && game.time < player._invulnUntil;
    if (pInvuln) ctx.globalAlpha = 0.7 + 0.3 * Math.abs(Math.sin(game.time * 0.25));
    // Phase 154 — draw the player at the interpolated position (same source the
    // camera follows) so the player stays screen-centred and the ground scrolls
    // smoothly between sim ticks. Sim/aim/bullets still use player.x/y.
    drawHumanoid(player._drawX != null ? player._drawX : player.x,
                 player._drawY != null ? player._drawY : player.y,
                 player.angle, player.walkPhase, COLORS.black, false, player);
    if (pInvuln) ctx.globalAlpha = 1;
  }

  // Phase 5 (re-add) — server-side NN bots from snapshot. Same fade-out
  // pattern as the local NN enemies block above (line ~9189): full alpha
  // when currently visible, linear fade-to-0.25 over 3 s after LoS lost,
  // then full cull. Without the fade, team-1 bots popped instantly when
  // crossing the cone edge (user '不是漸漸消失,而是一離開視野範圍就消失').
  if (typeof _mpState !== 'undefined' && _mpState && _mpState.remoteBots && _mpState.remoteBots.size > 0) {
    const lerpK = 0.45;
    for (const rb of _mpState.remoteBots.values()) {
      if (!rb.alive) continue;
      const prevX = rb.x, prevY = rb.y;
      rb.x += (rb.targetX - rb.x) * lerpK;
      rb.y += (rb.targetY - rb.y) * lerpK;
      let alpha = 1;
      if (rb.team === 1) {
        // Team-1 (red/enemy) → fog-of-war. Friendly cone/drone/FPV defines
        // 'visible'. Track _lastSeen tick for the fade-out memory window.
        if (typeof isVisibleToFriendly === 'function' && isVisibleToFriendly(rb.x, rb.y)) {
          rb._lastSeen = game.time;
          alpha = 1;
        } else if (rb._lastSeen != null && game.time - rb._lastSeen < 180) {
          alpha = Math.max(0.25, 1 - (game.time - rb._lastSeen) / 180);
        } else {
          continue;        // beyond 3 s memory window — fully cull
        }
      }
      const moved = Math.hypot(rb.x - prevX, rb.y - prevY);
      rb._walkPhase = (rb._walkPhase || 0) + Math.min(0.32, moved * 0.06);
      const synth = {
        _chassis: 'humanoid',
        radius: 14,
        callsign: 'BOT-' + String(rb.id).slice(-4),
        gunAngle: rb.angle,
        gunRecoil: 0,
        x: rb.x, y: rb.y,
        hp: rb.hp, maxHp: 100,
      };
      const bodyColor = (rb.team === 0) ? COLORS.creamDark : COLORS.red;
      ctx.globalAlpha = alpha;
      drawHumanoid(rb.x, rb.y, rb.angle, rb._walkPhase, bodyColor, rb.team === 1, synth);
      if (rb.hp < 100) {
        ctx.fillStyle = COLORS.black;
        ctx.fillRect(rb.x - 15, rb.y - 26, 30, 3);
        ctx.fillStyle = (rb.team === 0) ? COLORS.creamDark : COLORS.red;
        ctx.fillRect(rb.x - 15, rb.y - 26, 30 * rb.hp / 100, 3);
      }
      ctx.globalAlpha = 1;
      // Recruit cue — parity with the SOLO enemies[] cue (above). Phase 159
      // wired the MP recruit ACTION but not the CUE, so online the player had
      // no per-bot signal that a wounded enemy was a G-press away. MP bots are
      // server seed 0; show "SEED 0" within engagement range and a pulsing
      // "▶ G" once the live gates (touch range + hp<50% + our SEED > gap) pass.
      if (game._nnMode && rb.team === 1) {
        const _ed = Math.hypot(rb.x - player.x, rb.y - player.y);
        if (_ed < 200) {
          ctx.fillStyle = COLORS.black;
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('SEED 0', rb.x, rb.y - 36);
          const _pR = (player.radius || 13) + (rb.radius || 14) + ARENA_TOUCH_BUFFER;
          const _ready = _ed <= _pR
            && rb.hp < 100 * ARENA_HP_GATE
            && ((player._seed || 0) - 0) > ARENA_SEED_GAP;
          if (_ready) {
            const _pulse = 0.6 + 0.4 * Math.sin(game.time * 0.2);
            ctx.fillStyle = `rgba(230, 51, 41, ${_pulse})`;
            ctx.font = 'bold 12px monospace';
            ctx.fillText('▶ G', rb.x, rb.y - 48);
          }
          ctx.textAlign = 'left';
        }
      }
    }
  }

  // Phase 20a/b/24: remote players + bullets + pings + emote bubbles.
  // All no-ops when ?mp=1 absent (emotes still render locally so
  // single-player gets feedback when pressing T).
  if (typeof _mpRenderPings === 'function') _mpRenderPings();
  if (typeof _mpRenderRemoteBullets === 'function') _mpRenderRemoteBullets();
  if (typeof _mpRenderRemote === 'function') _mpRenderRemote();
  if (typeof _mpRenderEmotes === 'function') _mpRenderEmotes();

  // Player drone
  if (drone.deployed) drawDrone(drone.x, drone.y, COLORS.black, game.time * 0.25);

  // FPV body
  if (fpv.active) {
    drawDrone(fpv.x, fpv.y, COLORS.red, game.time*0.3);
    ctx.save();
    ctx.translate(fpv.x, fpv.y);
    ctx.rotate(fpv.angle);
    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(8, -5);
    ctx.lineTo(8, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Explosions — three layered blooms (outer red glow, mid orange flame,
  // hot cream-yellow core) so the fireball reads as fire instead of a
  // single red blob. Particles use per-particle stable colours (set in
  // createExplosion) for variety. User: '爆炸的火焰要鮮紅一點 · 不要全部
  // 都一個顏色'.
  for (const e of explosions) {
    const t = e.life / e.maxLife;
    // Outer red glow — biggest, softest, longest-lived. Same as before.
    ctx.fillStyle = '#C8261C';
    ctx.globalAlpha = t * 0.50;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius * (1-t)*1.4, 0, Math.PI*2);
    ctx.fill();
    // Mid orange-red flame — visible most of the explosion's life.
    ctx.fillStyle = '#F2402E';
    ctx.globalAlpha = t * 0.78;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius * (1-t)*0.95, 0, Math.PI*2);
    ctx.fill();
    // Hot cream-yellow core — only visible during the first ~40% of the
    // explosion's life (the "flash" moment). Adds the bright initiation
    // beat the user asked for.
    if (t > 0.60) {
      ctx.fillStyle = '#FFDC9A';
      ctx.globalAlpha = (t - 0.60) / 0.40 * 0.85;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius * (1-t)*0.55, 0, Math.PI*2);
      ctx.fill();
    }

    ctx.globalAlpha = t;
    for (const p of e.particles) {
      ctx.save();
      ctx.translate(e.x + p.x, e.y + p.y);
      ctx.rotate(p.angle);
      // Use the colour locked in at particle birth — no more per-frame
      // 50/50 flicker that washed out as a single colour blur.
      ctx.fillStyle = p.color || '#C8261C';
      ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;

  // === OVERHEADS — drawn ABOVE everything for elevation effect ===
  drawOverheads();

  // Landmark top features (antenna spires, hive crowns) — last so they read as tall
  drawLandmarksTop();

  // Mission objective elements (UGV, hive damage outline, capture zones, relay…)
  // Drawn over landmarks so capture rings / breach progress sit on top.
  if (mission && mission.renderWorld && (game.mode === 'tactical' || game.mode === 'command')) {
    mission.renderWorld();
  }

  // No darkening overlay anywhere. Visible area = fully bright (enemies look
  // sharp). The "fog of war" is implicit: enemies/drones/enemy bullets are
  // simply not rendered when outside friendly vision (already culled in their
  // render passes above). Map geometry is permanently visible (you remember the
  // terrain).
  if (game.mode === 'tactical') {
    drawSoundIndicators();
    drawGunAimIndicator();
  }
}
function drawLowCovers() {
  ctx.save();
  for (const lc of lowCovers) {
    // Slight drop shadow
    ctx.fillStyle = COLORS.creamDark;
    ctx.fillRect(lc.x + 4, lc.y + 4, lc.w, lc.h);
    ctx.fillStyle = lc.color;
    ctx.fillRect(lc.x, lc.y, lc.w, lc.h);
    // Hatch top to suggest waist-high
    ctx.strokeStyle = COLORS.black;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < lc.w; i += 8) {
      ctx.beginPath();
      ctx.moveTo(lc.x + i, lc.y);
      ctx.lineTo(lc.x + i + 4, lc.y + lc.h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeRect(lc.x, lc.y, lc.w, lc.h);
  }
  ctx.restore();
}
function drawOverheads() {
  ctx.save();
  for (const o of overheads) {
    // Big offset shadow to read as elevated
    ctx.fillStyle = 'rgba(26,26,26,0.20)';
    ctx.fillRect(o.x + 18, o.y + 18, o.w, o.h);
    ctx.fillStyle = o.color || COLORS.black;
    ctx.fillRect(o.x, o.y, o.w, o.h);
    // Catwalk grid pattern
    ctx.strokeStyle = COLORS.gray;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    if (o.w > o.h) {
      for (let x = o.x; x < o.x + o.w; x += 12) {
        ctx.beginPath();
        ctx.moveTo(x, o.y);
        ctx.lineTo(x, o.y + o.h);
        ctx.stroke();
      }
    } else {
      for (let y = o.y; y < o.y + o.h; y += 12) {
        ctx.beginPath();
        ctx.moveTo(o.x, y);
        ctx.lineTo(o.x + o.w, y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // Red outline rivets
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(o.x, o.y, o.w, 3);
    ctx.fillRect(o.x, o.y + o.h - 3, o.w, 3);
  }
  ctx.restore();
}
