// ============ OVERLAY RENDER (R10 refactor) ============
// All world-space + screen-space overlay rendering. Pulled out of the
// inline script — final big extraction in this refactor wave.
//
// World-space (drawn inside camera transform):
//   renderStructures      525L  placed structures: cover, wall, bunker,
//                               turret, factory, generator, spawn-relay,
//                               mine, terminal, tripmine. Capture rings,
//                               banners, power conductors, damage hatch.
//   renderAutoDrones       38L  defense-mode auto turrets
//   renderEMPPulses        27L
//   renderTeslaBolts       42L
//   renderSmokeClouds      26L
//   renderSpawnBeacons     46L
//   renderAirstrikes       30L
//   renderBuildPreview    113L  ghost preview while placing structures
//   renderEditorOverlay   141L  map-editor selection + cursor tools
//   drawThemeShapes       256L  per-map themed geometry under buildings
//   drawRoutes             91L  tactical patrol routes
//   drawLandmarksUnder/Mid/Top  252L  per-map signature props in 3 z-bands
//   drawSharedVisionFog    39L  shared-cone fog over unseen world
//   drawSoundIndicators    47L  edge arrows pointing to off-screen sounds
//   drawGunAimIndicator    24L  red barrel/aim line on units
//   drawHumanoid / _drawWolfChassis / _drawHeavyChassis / drawDrone — unit
//     sprite renderers (humanoid / wolf / heavy / UAV).
//   drawObjectivePanel  + drawObjectiveCompass / collectMissionWaypoints
//     (stubs — campaign objective HUD).
//
// Screen-space (drawn after camera reset):
//   renderFPVOverlay       81L  FPV brackets, telemetry panel, target indicator
//   renderDroneOverlay    107L  UAV recon HUD elements
//   renderCommandOverlay   88L  TAB squad-command overlay
//
// ~2200 lines moved. After R10: index.html ~6 590 lines (was 12 634
// pre-refactor wave). All functions resolve their globals (ctx, COLORS,
// game, player, enemies, etc.) at call time via classic-script
// hoisting — same load-time-decoupled pattern as the previous 9
// refactors.

function renderStructures() {
  if (!game._structures || !game._structures.length) return;
  ctx.save();
  for (const s of game._structures) {
    const def = STRUCTURE_DEFS[s.kind]; if (!def) continue;
    const r = def.size / 2;
    // Unpowered modules drop opacity to 0.45 so the player can scan
    // the field at a glance and see which assets aren't connected.
    const isOff = def.needsPower && !s._powered;
    ctx.globalAlpha = isOff ? 0.45 : 1.0;
    // Body
    if (s.kind === 'cover') {
      // Half-height cover — drawn as a shorter rectangle so the player can
      // tell it's penetrable visually. Top tier of the rect is faded.
      ctx.fillStyle = COLORS.creamDark;
      ctx.fillRect(s.x - r, s.y - r * 0.4, def.size, def.size * 0.7);
      ctx.strokeStyle = COLORS.black;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(s.x - r, s.y - r * 0.4, def.size, def.size * 0.7);
      // Two horizontal scratch lines for texture
      ctx.strokeStyle = 'rgba(26, 26, 26, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.x - r + 4, s.y - r * 0.1); ctx.lineTo(s.x + r - 4, s.y - r * 0.1);
      ctx.moveTo(s.x - r + 4, s.y + r * 0.3); ctx.lineTo(s.x + r - 4, s.y + r * 0.3);
      ctx.stroke();
    } else if (s.kind === 'wall') {
      ctx.fillStyle = COLORS.gray;
      ctx.fillRect(s.x - r, s.y - r, def.size, def.size);
      ctx.strokeStyle = COLORS.black;
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x - r, s.y - r, def.size, def.size);
    } else if (s.kind === 'bunker') {
      // Armored bunker — dark fill + diagonal cross-hatch + thick border to
      // sell its tanky 260-HP feel.
      ctx.fillStyle = COLORS.creamDark;
      ctx.fillRect(s.x - r + 4, s.y - r + 4, def.size, def.size);   // shadow
      ctx.fillStyle = '#3A3F4A';
      ctx.fillRect(s.x - r, s.y - r, def.size, def.size);
      ctx.strokeStyle = COLORS.black;
      ctx.lineWidth = 3;
      ctx.strokeRect(s.x - r, s.y - r, def.size, def.size);
      // Cross-hatch for armor texture
      ctx.strokeStyle = 'rgba(232, 228, 216, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = -def.size; k < def.size * 2; k += 6) {
        ctx.moveTo(s.x - r + k,        s.y - r);
        ctx.lineTo(s.x - r + k - 30,   s.y - r + 30);
      }
      ctx.stroke();
      // Center red rivet — armored module signal
      ctx.fillStyle = COLORS.red;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.kind === 'factory') {
      // Phase 3C: capturable factory. Neutralized in Phase 4B per user
      // feedback ('不要讓它有特別的顏色, 不然很突兀') — the body now blends
      // with the TOD palette regardless of who owns it. The ONLY ownership
      // tell is a faint red corner mark when the player owns it. Capture
      // progress is shown via an arc in the capturing team's color so the
      // ACTION still reads, but the idle state is just "neutral factory".
      const FD = STRUCTURE_DEFS['factory'];
      const playerOwned = s._team === 'blue';
      const enemyOwned  = s._team === 'red';
      // Phase 71 power-radius ring — outermost, ALWAYS visible so the
      // player can see "if I capture this, I get a power radius for my
      // needsPower modules". Visual states:
      //   • blue (player-owned)  → red pulse  (you own this coverage)
      //   • neutral              → faint cream-dark dash (preview)
      //   • red (enemy-owned)    → faint red dash (warning)
      // Dashed long-stroke distinguishes it from the tighter captureR
      // ring (shorter dashes drawn below).
      if (FD.powerSource && FD.powerR) {
        if (playerOwned) {
          ctx.globalAlpha = 0.12 + 0.06 * Math.sin(game.time * 0.05);
          ctx.strokeStyle = COLORS.red;
          ctx.lineWidth = 1.5;
        } else if (enemyOwned) {
          ctx.globalAlpha = 0.10;
          ctx.strokeStyle = COLORS.red;
          ctx.lineWidth = 1;
        } else {
          ctx.globalAlpha = 0.16;
          ctx.strokeStyle = COLORS.creamDark;
          ctx.lineWidth = 1;
        }
        ctx.setLineDash([4, 10]);
        ctx.beginPath();
        ctx.arc(s.x, s.y, FD.powerR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
      }
      // Ground capture-radius ring — neutral creamDark (TOD-aware), always
      // shown so players see WHERE to stand without team-color noise.
      ctx.strokeStyle = COLORS.creamDark;
      ctx.globalAlpha = 0.30;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, FD.captureR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;
      // Body — neutral TOD-tinted gray
      ctx.fillStyle = COLORS.gray;
      ctx.fillRect(s.x - r, s.y - r, def.size, def.size);
      ctx.strokeStyle = COLORS.cream;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x - r, s.y - r, def.size, def.size);
      ctx.globalAlpha = 1.0;
      // Inner core — neutral creamDark, no team flair
      ctx.fillStyle = COLORS.creamDark;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(s.x - r * 0.55, s.y - r * 0.55, def.size * 0.55, def.size * 0.55);
      ctx.globalAlpha = 1.0;
      // Player-owned indicator — tiny red rivet in top-right corner only.
      // (Enemy ownership is intentionally invisible — the player learns
      // through the spawn flow that an enemy bot just emerged.)
      if (playerOwned) {
        ctx.fillStyle = COLORS.red;
        ctx.fillRect(s.x + r - 6, s.y - r + 2, 4, 4);
      }
      // Capture progress arc — STILL team-colored because it shows live
      // action, not idle ownership. Subtle enough not to read as a team
      // signal when nobody's contesting.
      if (s._captureProgress > 0 && s._captureBy) {
        const capCol = s._captureBy === 'blue' ? COLORS.red : '#B8703A';
        const frac = s._captureProgress / FD.captureTicks;
        ctx.strokeStyle = capCol;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 6, -Math.PI/2, -Math.PI/2 + frac * Math.PI * 2);
        ctx.stroke();
      }
      // 'FACTORY' label — cream (TOD-stable, readable on any ambient)
      ctx.fillStyle = COLORS.cream;
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('FACTORY', s.x, s.y + 4);
      // Owner banner above the factory. User '工廠上面會寫說誰現在
      // 正在佔領, 這個工廠現在屬於誰的, 會為誰生產'. Three lines:
      //   1. ownership state (OWNED BY YOU / RED / NEUTRAL)
      //   2. capturing party (only when progress > 0; says CAPTURING
      //      from neutral, NEUTRALISING when reverting a held faction)
      //   3. production countdown (owner only; existing)
      const _bannerY = s.y - r - 24;
      let _bLabel, _bColor;
      if (s._team === 'blue') {
        _bLabel = T('屬於你 · 為你方生產', 'OWNED BY YOU · for your squad');
        _bColor = '#42B7E8';
      } else if (s._team === 'red') {
        _bLabel = T('屬於敵方 · 為敵方生產', 'OWNED BY RED · for enemy');
        _bColor = '#E63329';
      } else {
        _bLabel = T('中立 · 待佔領', 'NEUTRAL · capturable');
        _bColor = COLORS.cream;
      }
      ctx.font = 'bold 9px monospace';
      ctx.fillStyle = _bColor;
      ctx.fillText(_bLabel, s.x, _bannerY);
      if (s._captureProgress > 0 && s._captureBy) {
        const _cCol = s._captureBy === 'blue' ? '#42B7E8' : '#E63329';
        const _stage = (s._team === 'neutral')
          ? T('佔領中', 'CAPTURING')
          : T('解除佔領中', 'NEUTRALISING');
        ctx.font = 'bold 8px monospace';
        ctx.fillStyle = _cCol;
        ctx.globalAlpha = 0.9;
        ctx.fillText(`${s._captureBy === 'blue' ? 'YOU' : 'RED'} · ${_stage}`, s.x, _bannerY + 11);
        ctx.globalAlpha = 1.0;
      }
      // Owner-only: production countdown — cream so it doesn't shout team color
      if (s._team !== 'neutral' && s._nextProductionAt > 0) {
        const remTicks = Math.max(0, s._nextProductionAt - game.time);
        const remSec = Math.ceil(remTicks / 60);
        ctx.font = 'bold 8px monospace';
        ctx.fillStyle = COLORS.cream;
        ctx.globalAlpha = 0.85;
        ctx.fillText(`+1 IN ${remSec}s`, s.x, s.y + r + 14);
        ctx.globalAlpha = 1.0;
      }
      ctx.textAlign = 'left';
    } else if (s.kind === 'spawn-relay') {
      // Phase 3B: spawn relay — beacon-like obelisk in team color. Pulses
      // so it reads as 'critical objective' from across the arena.
      const teamCol = s._team === 'blue' ? '#42B7E8' : '#E63329';
      const pulse = 0.55 + 0.45 * Math.sin(game.time * 0.06);
      // Ground halo
      const grad = ctx.createRadialGradient(s.x, s.y, 4, s.x, s.y, def.size);
      grad.addColorStop(0, `rgba(${s._team === 'blue' ? '66,183,232' : '230,51,41'}, ${0.45 * pulse})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(s.x - def.size, s.y - def.size, def.size * 2, def.size * 2);
      // Base (dark hex-ish square)
      ctx.fillStyle = '#1A1A1A';
      ctx.fillRect(s.x - r, s.y - r, def.size, def.size);
      ctx.strokeStyle = teamCol;
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x - r, s.y - r, def.size, def.size);
      // Inner team-colored core
      ctx.fillStyle = teamCol;
      ctx.globalAlpha = isOff ? 0.45 : (0.65 + 0.35 * pulse);
      ctx.fillRect(s.x - r * 0.4, s.y - r * 0.4, def.size * 0.4, def.size * 0.4);
      ctx.globalAlpha = isOff ? 0.45 : 1.0;
      // Cross indicator (visible while alive)
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r * 0.5); ctx.lineTo(s.x, s.y + r * 0.5);
      ctx.moveTo(s.x - r * 0.5, s.y); ctx.lineTo(s.x + r * 0.5, s.y);
      ctx.stroke();
    } else if (s.kind === 'turret') {
      // Octagonal base
      ctx.fillStyle = '#2A2A2A';
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4;
        const px = s.x + Math.cos(a) * r, py = s.y + Math.sin(a) * r;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = COLORS.red; ctx.lineWidth = 2; ctx.stroke();
      // Barrel pointing at last fire angle
      const ga = s.gunAngle || 0;
      ctx.strokeStyle = COLORS.red; ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x + Math.cos(ga) * (r + 14), s.y + Math.sin(ga) * (r + 14));
      ctx.stroke();
      // Range ring (faint, only when armed/recent)
      if (s.fireCd < 30) {
        ctx.strokeStyle = 'rgba(200, 38, 28, 0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, def.range, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (s.kind === 'generator') {
      // Phase 10B: harmonize with TOD. Body uses COLORS.gray (TOD-tinted)
      // and the outline + power ring use COLORS.cream / COLORS.red — both
      // are TOD-stable (cream HUD anchor + constructivist red accent).
      // The lightning bolt keeps a cream-on-red core so the "energy"
      // semantic still reads at a glance without screaming yellow across
      // every ambient.
      const powerR = def.powerR || 200;
      const ringPulse = 0.18 + 0.10 * Math.sin(game.time * 0.06);
      ctx.globalAlpha = ringPulse;
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, powerR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Drop-shadow + body — matches the wall-line aesthetic (4u SE)
      ctx.fillStyle = COLORS.creamDark;
      ctx.fillRect(s.x - r + 4, s.y - r + 4, def.size, def.size);
      ctx.fillStyle = COLORS.gray;
      ctx.fillRect(s.x - r, s.y - r, def.size, def.size);
      ctx.strokeStyle = COLORS.cream;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x - r, s.y - r, def.size, def.size);
      ctx.globalAlpha = 1;
      // Pulsing core — red bg square with cream lightning bolt vector.
      // Red is the constructivist signature; cream is universally legible.
      const pulse = 0.55 + 0.35 * Math.sin(game.time * 0.15);
      ctx.fillStyle = `rgba(200, 38, 28, ${pulse})`;
      ctx.fillRect(s.x - 8, s.y - 8, 16, 16);
      ctx.strokeStyle = COLORS.cream;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'miter';
      ctx.beginPath();
      ctx.moveTo(s.x - 4, s.y - 8);
      ctx.lineTo(s.x + 1, s.y - 1);
      ctx.lineTo(s.x - 2, s.y - 1);
      ctx.lineTo(s.x + 4, s.y + 8);
      ctx.lineTo(s.x - 1, s.y + 1);
      ctx.lineTo(s.x + 2, s.y + 1);
      ctx.closePath();
      ctx.fillStyle = COLORS.cream;
      ctx.fill();
      ctx.stroke();
    } else if (s.kind === 'camera') {
      ctx.fillStyle = '#1A1A1A';
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLORS.cream; ctx.lineWidth = 2; ctx.stroke();
      // Lens — sweeping
      const sweep = (game.time * 0.04) % (Math.PI * 2);
      ctx.fillStyle = 'rgba(200, 38, 28, 0.12)';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.arc(s.x, s.y, def.visionR, sweep - 0.5, sweep + 0.5);
      ctx.closePath();
      ctx.fill();
    } else if (s.kind === 'mine') {
      // Small dome — barely visible (defense mode only player should know it)
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = COLORS.gray;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLORS.red; ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Tiny center dot
      ctx.fillStyle = COLORS.red;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (s.kind === 'tripmine') {
      // Cross pattern marking a trip volume (visible to player)
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(s.x - r, s.y - r, def.size, def.size);
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y); ctx.lineTo(s.x + r, s.y);
      ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x, s.y + r);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (s.kind === 'sensor') {
      ctx.fillStyle = '#1A1A1A';
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = k * Math.PI / 3 + Math.PI / 6;
        const px = s.x + Math.cos(a) * r, py = s.y + Math.sin(a) * r;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      // Pulsing antenna
      const pulse = 0.4 + 0.4 * Math.sin(game.time * 0.18);
      ctx.fillStyle = `rgba(74, 143, 230, ${pulse})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.fill();
      // Faint range ring (only when something is in range)
      const def = STRUCTURE_DEFS.sensor;
      ctx.globalAlpha = 0.10;
      ctx.strokeStyle = '#4A8FE6';
      ctx.beginPath();
      ctx.arc(s.x, s.y, def.pingR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (s.kind === 'emp') {
      // Drum + radar antenna
      ctx.fillStyle = '#0F1A2A';
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#7AC9FF';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Antenna spike
      ctx.strokeStyle = '#7AC9FF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x, s.y - r - 16);
      ctx.stroke();
      ctx.fillStyle = '#7AC9FF';
      ctx.beginPath();
      ctx.arc(s.x, s.y - r - 16, 3, 0, Math.PI * 2);
      ctx.fill();
      // Charge ring (faint when on cooldown, full when ready)
      const charge = 1 - (s.emitCd / def.emitCd);
      ctx.globalAlpha = 0.3 + 0.5 * charge;
      ctx.strokeStyle = '#7AC9FF';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * charge);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (s.kind === 'medstation') {
      // White cross on red diamond
      ctx.fillStyle = COLORS.creamDark;
      ctx.fillRect(s.x - r + 3, s.y - r + 3, def.size, def.size);   // shadow
      ctx.fillStyle = COLORS.cream;
      ctx.fillRect(s.x - r, s.y - r, def.size, def.size);
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = 2;
      ctx.strokeRect(s.x - r, s.y - r, def.size, def.size);
      // Red cross
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(s.x - 12, s.y - 4, 24, 8);
      ctx.fillRect(s.x - 4, s.y - 12, 8, 24);
      // Healing pulse — ring expansion when active (lower healCd = active)
      if (s.healCd < 12) {
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = COLORS.red;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, def.healR * (1 - s.healCd / 12), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else if (s.kind === 'tesla') {
      // Conical base + capacitor coil with humming arc
      ctx.fillStyle = '#1A1A1A';
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y + r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.lineTo(s.x + 2, s.y - r * 0.3);
      ctx.lineTo(s.x - 2, s.y - r * 0.3);
      ctx.closePath();
      ctx.fill();
      // Toroid cap
      ctx.fillStyle = '#3A4A6A';
      ctx.beginPath();
      ctx.arc(s.x, s.y - r * 0.4, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#7AC9FF';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Humming arc — small jagged lines around the toroid
      const phase = (game.time * 0.4) % (Math.PI * 2);
      ctx.strokeStyle = `rgba(122, 201, 255, ${s.fireCd > 30 ? 0.4 : 0.85})`;
      ctx.lineWidth = 1;
      for (let k = 0; k < 3; k++) {
        const a = phase + k * Math.PI * 2 / 3;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - r * 0.4);
        const wob = (Math.random() - 0.5) * 4;
        ctx.lineTo(s.x + Math.cos(a) * 14 + wob, s.y - r * 0.4 + Math.sin(a) * 14 + wob);
        ctx.stroke();
      }
    } else if (s.kind === 'smoke') {
      // Drum-shaped emitter
      ctx.fillStyle = '#3A3A3A';
      ctx.fillRect(s.x - r, s.y - r, def.size, def.size);
      ctx.strokeStyle = COLORS.cream; ctx.lineWidth = 1;
      ctx.strokeRect(s.x - r, s.y - r, def.size, def.size);
      // Vapor wisps
      const wisps = (game.time * 0.05) % (Math.PI * 2);
      for (let k = 0; k < 3; k++) {
        const a = wisps + k * 2;
        const wx = s.x + Math.cos(a) * (r + 6 + (game.time + k*7) % 14);
        const wy = s.y + Math.sin(a) * (r + 6 + (game.time + k*7) % 14);
        ctx.fillStyle = `rgba(180, 180, 180, ${0.4 - k * 0.1})`;
        ctx.beginPath();
        ctx.arc(wx, wy, 6 - k * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (s.kind === 'terminal') {
      ctx.fillStyle = '#0F1A2A';
      ctx.fillRect(s.x - r, s.y - r, def.size, def.size);
      ctx.strokeStyle = '#4A8FE6'; ctx.lineWidth = 2;
      ctx.strokeRect(s.x - r, s.y - r, def.size, def.size);
      // Antenna
      ctx.strokeStyle = '#4A8FE6';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x, s.y - r - 14);
      ctx.stroke();
      ctx.fillStyle = '#4A8FE6';
      ctx.beginPath();
      ctx.arc(s.x, s.y - r - 14, 3, 0, Math.PI * 2);
      ctx.fill();
      // Ready indicator
      const ready = s.airstrikeCd <= 0;
      ctx.fillStyle = ready ? '#3FE63F' : 'rgba(230, 51, 41, 0.7)';
      ctx.fillRect(s.x - 4, s.y + r - 8, 8, 4);
    }
    // HP bar (top)
    if (s.hp < s.maxHp) {
      const bw = def.size, bh = 3;
      const bx = s.x - bw / 2, by = s.y - r - 8;
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = s.hp / s.maxHp > 0.4 ? '#3FE63F' : COLORS.red;
      ctx.fillRect(bx, by, bw * s.hp / s.maxHp, bh);
    }
    // 'NO PWR' indicator — proper red pill with cream text. The chip
    // sits above the module by a margin proportional to its radius, so
    // big modules (terminal r=25) and tiny ones (camera r=20) all
    // get a chip that doesn't overlap the body.
    if (def.needsPower && !s._powered) {
      ctx.globalAlpha = 1;
      const txt = '⚡ NO PWR';
      ctx.font = 'bold 9px monospace';
      const tw = ctx.measureText(txt).width;
      const cw = tw + 12, ch = 14;
      const cx = s.x - cw / 2, cy = s.y - r - ch - 4;
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(cx + 2, cy + 2, cw, ch);              // drop-shadow
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(cx, cy, cw, ch);                      // body
      ctx.fillStyle = COLORS.cream;
      ctx.textAlign = 'center';
      ctx.fillText(txt, s.x, cy + 10);
      ctx.textAlign = 'left';
    }
    // Tier badge — clean red square with cream Roman numeral, centred
    // at the module's upper-right with a black drop-shadow that gives
    // it a stamped-on-armor feel rather than a sticker.
    if ((s.tier || 1) > 1) {
      const t = s.tier;
      const tier = UPGRADE_TIERS[t];
      ctx.globalAlpha = 1;
      const bx = s.x + r * 0.7, by = s.y - r * 0.85;
      const bw = 18, bh = 16;
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(bx - bw/2 + 2, by - bh/2 + 2, bw, bh);   // shadow
      ctx.fillStyle = COLORS.red;
      ctx.fillRect(bx - bw/2, by - bh/2, bw, bh);
      ctx.fillStyle = COLORS.cream;
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(tier ? tier.label : 'II', bx, by + 4);
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// Render auto-drones — small black diamonds with a red eye + motion trail.
function renderAutoDrones() {
  if (!game._autoDrones || !game._autoDrones.length) return;
  ctx.save();
  for (const d of game._autoDrones) {
    const a = Math.atan2(d.vy, d.vx) || 0;
    // Trail (3 fading dots behind)
    for (let k = 1; k <= 3; k++) {
      const tx = d.x - Math.cos(a) * (k * 5);
      const ty = d.y - Math.sin(a) * (k * 5);
      ctx.fillStyle = `rgba(200, 38, 28, ${0.5 - k * 0.13})`;
      ctx.beginPath();
      ctx.arc(tx, ty, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Body — diamond
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(a);
    ctx.fillStyle = COLORS.black;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(0, -4);
    ctx.lineTo(-6, 0);
    ctx.lineTo(0, 4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.arc(2, 0, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// Render EMP pulse rings — expanding circle that fades over its life.
// Pure visual; the actual stun effect was applied when the pulse fired.
function renderEMPPulses() {
  if (!game._empPulses || !game._empPulses.length) return;
  ctx.save();
  for (const p of game._empPulses) {
    const t = 1 - p.life / p.maxLife;       // 0..1 expansion
    const a = p.life / p.maxLife;             // 1..0 alpha
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#7AC9FF';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * t, 0, Math.PI * 2);
    ctx.stroke();
    // Inner brighter ring
    ctx.strokeStyle = '#E8F0FF';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * t * 0.9, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// Render tesla bolts — jagged lightning between two world points, fading
// over the bolt's life. Each segment renders as a few zigzag steps with
// random side-jitter so it looks like real lightning rather than a line.
function renderTeslaBolts() {
  if (!game._teslaBolts || !game._teslaBolts.length) return;
  ctx.save();
  for (const b of game._teslaBolts) {
    const a = b.life / 14;
    if (a <= 0) continue;
    const dx = b.x2 - b.x1, dy = b.y2 - b.y1;
    const len = Math.hypot(dx, dy);
    if (len <= 0.1) continue;
    const nx = -dy / len, ny = dx / len;     // perpendicular unit
    const segs = Math.max(4, Math.floor(len / 30));
    // Outer glow
    ctx.strokeStyle = `rgba(122, 201, 255, ${0.25 * a})`;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const wob = (Math.random() - 0.5) * 18;
      ctx.lineTo(b.x1 + dx * t + nx * wob, b.y1 + dy * t + ny * wob);
    }
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
    // Bright inner core
    ctx.strokeStyle = `rgba(232, 240, 255, ${0.95 * a})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    for (let i = 1; i < segs; i++) {
      const t = i / segs;
      const wob = (Math.random() - 0.5) * 14;
      ctx.lineTo(b.x1 + dx * t + nx * wob, b.y1 + dy * t + ny * wob);
    }
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
  }
  ctx.restore();
}

// Render fading smoke clouds. Each is a soft greyish disc whose alpha
// scales with remaining life. Two passes (outer + inner) for a softer edge.
function renderSmokeClouds() {
  if (!game._smokeClouds || !game._smokeClouds.length) return;
  ctx.save();
  for (const c of game._smokeClouds) {
    const fade = c.life / c.maxLife;
    if (fade <= 0) continue;
    // Outer soft disc
    ctx.fillStyle = `rgba(170, 170, 170, ${0.30 * fade})`;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
    // Inner denser core
    ctx.fillStyle = `rgba(140, 140, 140, ${0.45 * fade})`;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Render footprints — small fading dot trails. Blue tint for friendlies, red
// for enemies. Helps the player track movement during quiet moments.

// Render enemy spawn beacons — red diamond pylons with HP rings. Player can
// see them on the world + minimap. Destroying one halts that side's spawns.
function renderSpawnBeacons() {
  if (!game._spawnBeacons || !game._spawnBeacons.length) return;
  ctx.save();
  for (const b of game._spawnBeacons) {
    if (b.hp <= 0) continue;
    // Diamond pylon
    const r = 22;
    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y - r);
    ctx.lineTo(b.x + r, b.y);
    ctx.lineTo(b.x, b.y + r);
    ctx.lineTo(b.x - r, b.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = COLORS.cream;
    ctx.lineWidth = 2;
    ctx.stroke();
    // Pulsing inner core
    const pulse = 0.5 + 0.5 * Math.sin(game.time * 0.12);
    ctx.fillStyle = `rgba(232, 228, 216, ${pulse})`;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 6, 0, Math.PI * 2);
    ctx.fill();
    // HP ring
    if (b.hp < b.maxHp) {
      const bw = 36, bh = 4;
      const bx = b.x - bw / 2, by = b.y - r - 12;
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = b.hp / b.maxHp > 0.4 ? '#3FE63F' : COLORS.red;
      ctx.fillRect(bx, by, bw * b.hp / b.maxHp, bh);
    }
    // Label
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(T('敌方重生', 'ENEMY SPAWN'), b.x, b.y + r + 14);
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

// Telegraphed airstrike marker — red ground circle that flashes faster as it
// nears detonation. Players (and friendly NN) should see + scatter.
function renderAirstrikes() {
  if (!game._airstrikes || !game._airstrikes.length) return;
  ctx.save();
  for (const a of game._airstrikes) {
    const t = a.t / 72; // 0..1 telegraph
    const flash = (game.time % 6) < 3 ? 0.8 : 0.3;
    ctx.strokeStyle = `rgba(200, 38, 28, ${flash})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 130, 0, Math.PI * 2);
    ctx.stroke();
    // Fill
    ctx.fillStyle = `rgba(200, 38, 28, ${0.06 + t * 0.18})`;
    ctx.beginPath();
    ctx.arc(a.x, a.y, 130, 0, Math.PI * 2);
    ctx.fill();
    // Crosshair
    ctx.strokeStyle = `rgba(200, 38, 28, ${flash})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x - 16, a.y); ctx.lineTo(a.x + 16, a.y);
    ctx.moveTo(a.x, a.y - 16); ctx.lineTo(a.x, a.y + 16);
    ctx.stroke();
  }
  ctx.restore();
}

// Build-mode placement preview at the cursor world position. Ghosts the
// structure shape + a green tint when affordable, red when not.
function renderBuildPreview() {
  const wp = screenToWorld(mouse.x, mouse.y);
  // Snap to 60-unit grid (same as build_phase + editor)
  const SNAP = 30;
  const gx = Math.round(wp.x / SNAP) * SNAP;
  const gy = Math.round(wp.y / SNAP) * SNAP;
  const def = STRUCTURE_DEFS[buildMode.kind];
  if (!def) return;
  const r = def.size / 2;
  const ok = canAffordStructure(buildMode.kind);

  // Wall + active drag → ghost the entire line, colour-code which cells fit
  // in the current energy budget vs which would run out mid-line.
  if (isWallKind(buildMode.kind) && buildMode._dragStart && buildMode._dragEnd
      && (buildMode._dragStart.gx !== buildMode._dragEnd.gx
          || buildMode._dragStart.gy !== buildMode._dragEnd.gy)) {
    const a = buildMode._dragStart, b = buildMode._dragEnd;
    const cells = _editorLineCells(a.gx, a.gy, b.gx, b.gy, 30);
    const cost = def.cost;
    const energy = game._energy || 0;
    // First cell is already paid (placed on mousedown); count budget for the rest
    const affordable = 1 + Math.max(0, Math.floor(energy / cost));
    ctx.save();
    // §A.3 — green leak suppressed during FTUE.
    const okColor = '#3FE63F';
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const willPlace = i < affordable;
      ctx.globalAlpha = willPlace ? 0.55 : 0.30;
      ctx.fillStyle = willPlace ? okColor : COLORS.red;
      ctx.fillRect(c.cx - r, c.cy - r, def.size, def.size);
    }
    // Center stroke from start to end
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.gx, a.gy);
    ctx.lineTo(b.gx, b.gy);
    ctx.stroke();
    // Cost label near cursor
    const totalCost = (cells.length - 1) * cost;   // first cell already spent
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`${cells.length}× ${def.label()}  ${totalCost}⚡`,
                 b.gx + 12, b.gy - 12);
    ctx.restore();
    return;
  }

  // Range check — out-of-reach cells render dim red so the player sees
  // why their click won't land. Same constant as the click/touch path
  // (BUILD_REACH_PX) so they can never disagree.
  const inReach = !player.alive ||
    Math.hypot(gx - player.x, gy - player.y) <= BUILD_REACH_PX;
  // UAV / FPV view: no placement, full red strike-through preview.
  const wrongMode = (game.mode !== 'tactical');
  ctx.save();
  if (wrongMode) {
    // Dim cross-hatched preview to communicate "not here".
    ctx.globalAlpha = 0.20;
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(gx - r, gy - r, def.size, def.size);
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx - r, gy - r); ctx.lineTo(gx + r, gy + r);
    ctx.moveTo(gx + r, gy - r); ctx.lineTo(gx - r, gy + r);
    ctx.stroke();
    ctx.restore();
    return;
  }
  // §A.3 palette swap: during FTUE, OK preview uses cream (#E8E4D8)
  // instead of green (#3FE63F). Green is banned per §A.3 + §A.4.
  const okColor = '#3FE63F';
  ctx.globalAlpha = inReach ? 0.55 : 0.18;
  ctx.fillStyle = (ok && inReach) ? okColor : COLORS.red;
  ctx.fillRect(gx - r, gy - r, def.size, def.size);
  ctx.globalAlpha = inReach ? 0.9 : 0.5;
  ctx.strokeStyle = (ok && inReach) ? okColor : COLORS.red;
  ctx.lineWidth = inReach ? 2 : 1;
  ctx.strokeRect(gx - r, gy - r, def.size, def.size);
  // Reach ring around the player so the player sees the placement boundary.
  if (player.alive) {
    ctx.globalAlpha = 0.10;
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(player.x, player.y, 200, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // For turret: show range
  if (buildMode.kind === 'turret') {
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#3FE63F';
    ctx.beginPath();
    ctx.arc(gx, gy, def.range, 0, Math.PI * 2);
    ctx.fill();
  }
  // For camera: show vision
  if (buildMode.kind === 'camera') {
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.arc(gx, gy, def.visionR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Editor-only world overlay: arena grid + cursor preview block
function renderEditorOverlay() {
  // Grid (60u cells matching the placement snap)
  ctx.save();
  ctx.strokeStyle = 'rgba(232, 228, 216, 0.18)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= NN_ARENA.w; gx += EDITOR_BLOCK) {
    ctx.beginPath();
    ctx.moveTo(NN_ARENA.x0 + gx, NN_ARENA.y0);
    ctx.lineTo(NN_ARENA.x0 + gx, NN_ARENA.y0 + NN_ARENA.h);
    ctx.stroke();
  }
  for (let gy = 0; gy <= NN_ARENA.h; gy += EDITOR_BLOCK) {
    ctx.beginPath();
    ctx.moveTo(NN_ARENA.x0,                  NN_ARENA.y0 + gy);
    ctx.lineTo(NN_ARENA.x0 + NN_ARENA.w,     NN_ARENA.y0 + gy);
    ctx.stroke();
  }
  // Spawn markers — number each one so the placement order is visible.
  // The game uses that order for both initial squad placement and respawn
  // cycling, so the editor surfaces it explicitly.
  const drawSpawnMarker = (sp, color, label, idx) => {
    if (!sp) return;
    const wx = NN_ARENA.x0 + sp.x, wy = NN_ARENA.y0 + sp.y;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(wx, wy, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.cream;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${label}${idx + 1}`, wx, wy + 4);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  };
  const blueList = Array.isArray(editor.spawn.blue) ? editor.spawn.blue : [];
  const redList  = Array.isArray(editor.spawn.red)  ? editor.spawn.red  : [];
  blueList.forEach((sp, i) => drawSpawnMarker(sp, '#1A1A1A', T('蓝', 'B'), i));
  redList.forEach((sp, i)  => drawSpawnMarker(sp, COLORS.red,    T('红', 'R'), i));

  // Drag-line preview — wall tool ghosts a single thick stroked line,
  // cover/tree/erase still ghost the per-cell rasterised path.
  if (editor._dragStart && editor._dragEnd
      && editor.tool !== 'blueSpawn' && editor.tool !== 'redSpawn'
      && (editor._dragStart.gx !== editor._dragEnd.gx
          || editor._dragStart.gy !== editor._dragEnd.gy)) {
    const tile = EDITOR_BLOCK;
    const ax = NN_ARENA.x0 + editor._dragStart.gx + (editor.tool === 'wall' ? EDITOR_WALL_STEP : tile) / 2;
    const ay = NN_ARENA.y0 + editor._dragStart.gy + (editor.tool === 'wall' ? EDITOR_WALL_STEP : tile) / 2;
    const bx = NN_ARENA.x0 + editor._dragEnd.gx   + (editor.tool === 'wall' ? EDITOR_WALL_STEP : tile) / 2;
    const by = NN_ARENA.y0 + editor._dragEnd.gy   + (editor.tool === 'wall' ? EDITOR_WALL_STEP : tile) / 2;
    ctx.save();
    if (editor.tool === 'wall') {
      // Single stroked ghost line — exactly what mouseup will commit.
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = COLORS.gray;
      ctx.lineWidth = 18;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.lineCap = 'butt';
    } else {
      const cells = _editorLineCells(
        editor._dragStart.gx, editor._dragStart.gy,
        editor._dragEnd.gx,   editor._dragEnd.gy,
        tile
      );
      const ghostFill = editor.tool === 'tree'  ? '#3F4A3A'
                      : editor.tool === 'erase' ? COLORS.red
                                                : COLORS.creamDark;
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = ghostFill;
      for (const c of cells) {
        const wx = NN_ARENA.x0 + c.cx, wy = NN_ARENA.y0 + c.cy;
        if (wx < NN_ARENA.x0 || wy < NN_ARENA.y0) continue;
        if (wx + tile > NN_ARENA.x0 + NN_ARENA.w) continue;
        if (wy + tile > NN_ARENA.y0 + NN_ARENA.h) continue;
        ctx.fillRect(wx, wy, tile, tile);
      }
    }
    // Endpoint markers + dashed centre line (helps eyeball alignment)
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    // Live length + angle readout
    const len = Math.hypot(bx - ax, by - ay);
    const angleDeg = Math.round(Math.atan2(by - ay, bx - ax) * 180 / Math.PI);
    const lblX = bx + 14, lblY = by - 10;
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.black;
    const txt = `${Math.round(len)}u · ${angleDeg}°`;
    ctx.font = 'bold 11px monospace';
    const tw = ctx.measureText(txt).width;
    ctx.fillRect(lblX - 6, lblY - 12, tw + 12, 18);
    ctx.fillStyle = COLORS.cream;
    ctx.fillText(txt, lblX, lblY + 1);
    ctx.restore();
  }

  // Cursor preview block at the snapped grid cell under the mouse
  const wp = screenToWorld(mouse.x, mouse.y);
  const localX = wp.x - NN_ARENA.x0, localY = wp.y - NN_ARENA.y0;
  const gx = Math.floor(localX / EDITOR_BLOCK) * EDITOR_BLOCK;
  const gy = Math.floor(localY / EDITOR_BLOCK) * EDITOR_BLOCK;
  if (gx >= 0 && gy >= 0 && gx + EDITOR_BLOCK <= NN_ARENA.w && gy + EDITOR_BLOCK <= NN_ARENA.h) {
    const wx = NN_ARENA.x0 + gx, wy = NN_ARENA.y0 + gy;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 3;
    if (editor.tool === 'erase') {
      ctx.strokeStyle = COLORS.red;
      ctx.strokeRect(wx, wy, EDITOR_BLOCK, EDITOR_BLOCK);
      ctx.beginPath();
      ctx.moveTo(wx, wy); ctx.lineTo(wx + EDITOR_BLOCK, wy + EDITOR_BLOCK);
      ctx.moveTo(wx + EDITOR_BLOCK, wy); ctx.lineTo(wx, wy + EDITOR_BLOCK);
      ctx.stroke();
    } else if (editor.tool === 'blueSpawn' || editor.tool === 'redSpawn') {
      // Show a faint disc at cell center so the user sees where the spawn lands
      const cx = wx + EDITOR_BLOCK / 2, cy = wy + EDITOR_BLOCK / 2;
      ctx.fillStyle = editor.tool === 'blueSpawn' ? '#1A1A1A' : COLORS.red;
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLORS.red;
      ctx.strokeRect(wx, wy, EDITOR_BLOCK, EDITOR_BLOCK);
    } else {
      const fill = editor.tool === 'wall' ? COLORS.gray
                 : editor.tool === 'tree' ? '#3F4A3A'
                                          : COLORS.creamDark;
      ctx.fillStyle = fill;
      ctx.fillRect(wx, wy, EDITOR_BLOCK, EDITOR_BLOCK);
      ctx.strokeStyle = COLORS.red;
      ctx.strokeRect(wx, wy, EDITOR_BLOCK, EDITOR_BLOCK);
    }
  }
  ctx.restore();
}


// ============ MAP RENDER HELPERS ============
function drawThemeShapes() {
  for (const s of themeShapes) {
    ctx.save();
    if (s.alpha != null) ctx.globalAlpha = s.alpha;
    switch (s.kind) {
      case 'rect': {
        ctx.fillStyle = s.color || COLORS.cream;
        ctx.fillRect(s.x, s.y, s.w, s.h);
        break;
      }
      case 'square': {
        ctx.fillStyle = s.color || COLORS.red;
        ctx.fillRect(s.x, s.y, s.w, s.h);
        break;
      }
      case 'wedge': {
        ctx.fillStyle = s.color || COLORS.red;
        ctx.beginPath();
        ctx.moveTo(s.cx, s.cy);
        ctx.arc(s.cx, s.cy, s.r, s.a0, s.a1);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'pool': {
        // Cooling pool — gray base, red ring, inner reflection ticks
        ctx.fillStyle = COLORS.lightGray;
        ctx.beginPath();
        ctx.arc(s.cx, s.cy, s.r, 0, Math.PI*2);
        ctx.fill();
        ctx.strokeStyle = COLORS.red;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(s.cx, s.cy, s.r-4, 0, Math.PI*2);
        ctx.stroke();
        ctx.strokeStyle = COLORS.creamDark;
        ctx.lineWidth = 1;
        for (let a = 0; a < Math.PI*2; a += Math.PI/8) {
          const r0 = s.r * 0.55, r1 = s.r * 0.85;
          ctx.beginPath();
          ctx.moveTo(s.cx + Math.cos(a)*r0, s.cy + Math.sin(a)*r0);
          ctx.lineTo(s.cx + Math.cos(a)*r1, s.cy + Math.sin(a)*r1);
          ctx.stroke();
        }
        break;
      }
      case 'circle-stroke': {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        if (s.dash) ctx.setLineDash(s.dash);
        ctx.beginPath();
        ctx.arc(s.cx, s.cy, s.r, 0, Math.PI*2);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      case 'arc-stroke': {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(s.cx, s.cy, s.r, s.a0, s.a1);
        ctx.stroke();
        break;
      }
      case 'pipe': {
        ctx.fillStyle = s.color || COLORS.gray;
        ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.fillStyle = COLORS.creamDark;
        if (s.w > s.h) {
          ctx.fillRect(s.x, s.y + s.h/2 - 1, s.w, 2);
        } else {
          ctx.fillRect(s.x + s.w/2 - 1, s.y, 2, s.h);
        }
        // Joint flanges
        if (s.h > s.w) {
          for (let y = s.y; y < s.y + s.h; y += 320) {
            ctx.fillStyle = COLORS.black;
            ctx.fillRect(s.x - 4, y, s.w + 8, 8);
          }
        } else {
          for (let x = s.x; x < s.x + s.w; x += 320) {
            ctx.fillStyle = COLORS.black;
            ctx.fillRect(x, s.y - 4, 8, s.h + 8);
          }
        }
        break;
      }
      case 'trefoil': {
        // Radiation symbol
        ctx.translate(s.cx, s.cy);
        ctx.fillStyle = s.color || COLORS.red;
        ctx.beginPath();
        ctx.arc(0, 0, s.r*0.18, 0, Math.PI*2);
        ctx.fill();
        for (let i = 0; i < 3; i++) {
          ctx.save();
          ctx.rotate(i * Math.PI*2/3);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.arc(0, 0, s.r, -Math.PI/6, Math.PI/6);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        break;
      }
      case 'chevron': {
        ctx.fillStyle = s.color || COLORS.black;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + 60, s.y + 30);
        ctx.lineTo(s.x + 50, s.y + 30);
        ctx.lineTo(s.x - 10, s.y);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = COLORS.red;
        ctx.beginPath();
        ctx.moveTo(s.x + 12, s.y);
        ctx.lineTo(s.x + 72, s.y + 30);
        ctx.lineTo(s.x + 62, s.y + 30);
        ctx.lineTo(s.x + 2, s.y);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'plume': {
        const grad = ctx.createRadialGradient(s.cx, s.cy, 0, s.cx, s.cy, s.w);
        grad.addColorStop(0, s.color || COLORS.red);
        grad.addColorStop(1, 'rgba(200,38,28,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(s.cx - s.w, s.cy - s.h*0.5, s.w*2, s.h);
        break;
      }
      case 'slag': {
        ctx.fillStyle = COLORS.redDim;
        ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.fillStyle = COLORS.red;
        ctx.fillRect(s.x + 8, s.y + 8, s.w - 16, s.h - 16);
        ctx.fillStyle = COLORS.redBright;
        for (let i = 0; i < 6; i++) {
          ctx.fillRect(s.x + 16 + i*((s.w-32)/6), s.y + s.h*0.3, (s.w-32)/8, 6);
        }
        // Edge bars
        ctx.fillStyle = COLORS.black;
        ctx.fillRect(s.x, s.y, s.w, 6);
        ctx.fillRect(s.x, s.y + s.h - 6, s.w, 6);
        break;
      }
      case 'belt':
      case 'belt-v': {
        ctx.fillStyle = s.color || COLORS.black;
        ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.fillStyle = COLORS.creamDark;
        if (s.kind === 'belt') {
          for (let x = s.x; x < s.x + s.w; x += 24) {
            ctx.fillRect(x, s.y + s.h/2 - 1, 14, 2);
          }
        } else {
          for (let y = s.y; y < s.y + s.h; y += 24) {
            ctx.fillRect(s.x + s.w/2 - 1, y, 2, 14);
          }
        }
        break;
      }
      case 'gear': {
        ctx.fillStyle = s.color || COLORS.black;
        const teeth = 16;
        ctx.beginPath();
        for (let i = 0; i < teeth*2; i++) {
          const a = i / (teeth*2) * Math.PI*2;
          const r = (i%2===0) ? s.r : s.r*0.85;
          const x = s.cx + Math.cos(a)*r;
          const y = s.cy + Math.sin(a)*r;
          if (i===0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = COLORS.cream;
        ctx.beginPath();
        ctx.arc(s.cx, s.cy, s.r*0.35, 0, Math.PI*2);
        ctx.fill();
        break;
      }
      case 'water': {
        ctx.fillStyle = s.color || COLORS.gray;
        ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.strokeStyle = COLORS.creamDark;
        ctx.lineWidth = 1.5;
        for (let y = s.y + 30; y < s.y + s.h; y += 60) {
          ctx.beginPath();
          for (let x = s.x; x < s.x + s.w; x += 20) {
            const yy = y + Math.sin((x + game.time)*0.02)*4;
            if (x === s.x) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
          }
          ctx.stroke();
        }
        break;
      }
      case 'line-h':
      case 'line-v': {
        ctx.fillStyle = s.color || COLORS.black;
        ctx.fillRect(s.x, s.y, s.w, s.h);
        break;
      }
      case 'megaGrid': {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = s.x; x < s.x + s.w; x += s.step) {
          ctx.moveTo(x, s.y); ctx.lineTo(x, s.y + s.h);
        }
        for (let y = s.y; y < s.y + s.h; y += s.step) {
          ctx.moveTo(s.x, y); ctx.lineTo(s.x + s.w, y);
        }
        ctx.stroke();
        break;
      }
      case 'pad': {
        ctx.fillStyle = s.color || COLORS.black;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = i / 6 * Math.PI*2;
          const x = s.cx + Math.cos(a)*s.r;
          const y = s.cy + Math.sin(a)*s.r;
          if (i===0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = COLORS.red;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(s.cx, s.cy, s.r*0.55, 0, Math.PI*2);
        ctx.stroke();
        ctx.fillStyle = COLORS.red;
        ctx.font = 'bold 36px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('H', s.cx, s.cy + 12);
        ctx.textAlign = 'left';
        break;
      }
      case 'mast': {
        ctx.fillStyle = s.color || COLORS.black;
        ctx.fillRect(s.x - 3, s.y, 6, s.h);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 10, 0, Math.PI*2);
        ctx.fill();
        ctx.fillStyle = COLORS.red;
        ctx.fillRect(s.x - 14, s.y + 30, 28, 4);
        ctx.fillRect(s.x - 10, s.y + 60, 20, 4);
        break;
      }
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawRoutes() {
  ctx.save();
  for (const r of routes) {
    switch (r.type) {
      case 'main': {
        ctx.fillStyle = COLORS.creamDark;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = COLORS.red;
        const isHorizontal = r.w > r.h;
        if (isHorizontal) {
          for (let x = r.x; x < r.x + r.w; x += 30) {
            ctx.fillRect(x, r.y + r.h/2 - 2, 16, 4);
          }
        } else {
          for (let y = r.y; y < r.y + r.h; y += 30) {
            ctx.fillRect(r.x + r.w/2 - 2, y, 4, 16);
          }
        }
        break;
      }
      case 'side': {
        ctx.strokeStyle = COLORS.gray;
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
        break;
      }
      case 'vertical': {
        ctx.fillStyle = COLORS.red;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeStyle = COLORS.cream;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(r.x + 4, r.y + 4 + i*6);
          ctx.lineTo(r.x + r.w - 4, r.y + 4 + i*6);
          ctx.stroke();
        }
        break;
      }
      case 'vehicle': {
        ctx.fillStyle = COLORS.creamDark;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = COLORS.black;
        const isVertical = r.h > r.w;
        if (isVertical) {
          for (let y = r.y; y < r.y + r.h; y += 80) {
            ctx.fillRect(r.x + r.w/2 - 5, y, 10, 50);
          }
          ctx.fillStyle = COLORS.red;
          ctx.fillRect(r.x, r.y, 4, r.h);
          ctx.fillRect(r.x + r.w - 4, r.y, 4, r.h);
        } else {
          for (let x = r.x; x < r.x + r.w; x += 80) {
            ctx.fillRect(x, r.y + r.h/2 - 5, 50, 10);
          }
          ctx.fillStyle = COLORS.red;
          ctx.fillRect(r.x, r.y, r.w, 4);
          ctx.fillRect(r.x, r.y + r.h - 4, r.w, 4);
        }
        break;
      }
      case 'drone': {
        ctx.strokeStyle = COLORS.red;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2, 8]);
        const isH = r.w > r.h;
        ctx.beginPath();
        if (isH) {
          ctx.moveTo(r.x, r.y + r.h/2);
          ctx.lineTo(r.x + r.w, r.y + r.h/2);
        } else {
          ctx.moveTo(r.x + r.w/2, r.y);
          ctx.lineTo(r.x + r.w/2, r.y + r.h);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        break;
      }
    }
    if (r.label) {
      ctx.fillStyle = COLORS.black;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(r.label, r.x + 6, r.y - 6);
    }
  }
  ctx.restore();
}



function drawLandmarksUnder() {
  // Footprint shadow / radiating glow
  for (const lm of landmarks) {
    ctx.save();
    if (lm.kind === 'reactorPool' || lm.kind === 'droneHive' || lm.kind === 'dataCore') {
      const grad = ctx.createRadialGradient(lm.x, lm.y, 0, lm.x, lm.y, lm.r * 2.4);
      grad.addColorStop(0, 'rgba(200,38,28,0.25)');
      grad.addColorStop(1, 'rgba(200,38,28,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(lm.x - lm.r*2.4, lm.y - lm.r*2.4, lm.r*4.8, lm.r*4.8);
    }
    ctx.restore();
  }
}

function drawLandmarksMid() {
  for (const lm of landmarks) {
    ctx.save();
    switch (lm.kind) {
      case 'reactorPool': {
        // Outer rim
        ctx.fillStyle = COLORS.gray;
        ctx.beginPath();
        ctx.arc(lm.x, lm.y, lm.r, 0, Math.PI*2);
        ctx.fill();
        // Reactor cap (red core)
        ctx.fillStyle = COLORS.black;
        ctx.beginPath();
        ctx.arc(lm.x, lm.y, lm.r*0.72, 0, Math.PI*2);
        ctx.fill();
        ctx.fillStyle = COLORS.red;
        ctx.beginPath();
        ctx.arc(lm.x, lm.y, lm.r*0.45, 0, Math.PI*2);
        ctx.fill();
        // Pulsing core
        ctx.fillStyle = COLORS.cream;
        const pulse = 0.7 + Math.sin(game.time*0.06)*0.3;
        ctx.globalAlpha = pulse;
        ctx.beginPath();
        ctx.arc(lm.x, lm.y, lm.r*0.18, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Cooling pipes radiating
        ctx.strokeStyle = COLORS.black;
        ctx.lineWidth = 12;
        for (let i = 0; i < 4; i++) {
          const a = i * Math.PI/2 + Math.PI/4;
          ctx.beginPath();
          ctx.moveTo(lm.x + Math.cos(a)*lm.r*0.7, lm.y + Math.sin(a)*lm.r*0.7);
          ctx.lineTo(lm.x + Math.cos(a)*lm.r*1.3, lm.y + Math.sin(a)*lm.r*1.3);
          ctx.stroke();
        }
        break;
      }
      case 'blastFurnace': {
        // Tall trapezoid silhouette
        ctx.fillStyle = COLORS.black;
        ctx.beginPath();
        ctx.moveTo(lm.x - lm.r*0.9, lm.y + lm.r*0.6);
        ctx.lineTo(lm.x - lm.r*0.5, lm.y - lm.r*0.9);
        ctx.lineTo(lm.x + lm.r*0.5, lm.y - lm.r*0.9);
        ctx.lineTo(lm.x + lm.r*0.9, lm.y + lm.r*0.6);
        ctx.closePath();
        ctx.fill();
        // Slag spout opening
        ctx.fillStyle = COLORS.red;
        ctx.fillRect(lm.x - lm.r*0.25, lm.y + lm.r*0.4, lm.r*0.5, lm.r*0.25);
        // Furnace body bands
        ctx.fillStyle = COLORS.gray;
        for (let i = 0; i < 4; i++) {
          ctx.fillRect(lm.x - lm.r*0.7 + i*4, lm.y - lm.r*0.6 + i*lm.r*0.35, lm.r*1.4 - i*8, 6);
        }
        // Glow at top (charge hole)
        ctx.fillStyle = COLORS.redBright;
        ctx.globalAlpha = 0.5 + Math.sin(game.time*0.08)*0.3;
        ctx.beginPath();
        ctx.ellipse(lm.x, lm.y - lm.r*0.85, lm.r*0.4, lm.r*0.12, 0, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }
      case 'gantryCrane': {
        // Massive crane spans the yard horizontally
        const cx = lm.x, cy = lm.y;
        const span = lm.w, height = lm.h;
        // Two leg towers (pillars)
        ctx.fillStyle = COLORS.black;
        ctx.fillRect(cx - span*0.5, cy - height*0.5, 50, height);
        ctx.fillRect(cx + span*0.5 - 50, cy - height*0.5, 50, height);
        // Main beam (truss) — cream with red cross-bracing
        ctx.fillStyle = COLORS.creamDark;
        ctx.fillRect(cx - span*0.5, cy - height*0.5, span, 50);
        ctx.strokeStyle = COLORS.red;
        ctx.lineWidth = 3;
        for (let i = 0; i < 12; i++) {
          const x = cx - span*0.5 + (i / 12) * span;
          ctx.beginPath();
          ctx.moveTo(x, cy - height*0.5);
          ctx.lineTo(x + span/12, cy - height*0.5 + 50);
          ctx.stroke();
        }
        // Trolley + container hanging
        const tx = cx + Math.sin(game.time*0.01) * span*0.3;
        ctx.fillStyle = COLORS.red;
        ctx.fillRect(tx - 30, cy - height*0.5 + 50, 60, 30);
        ctx.strokeStyle = COLORS.black;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(tx, cy - height*0.5 + 80);
        ctx.lineTo(tx, cy - height*0.5 + 200);
        ctx.stroke();
        ctx.fillStyle = COLORS.gray;
        ctx.fillRect(tx - 50, cy - height*0.5 + 200, 100, 40);
        // Big "PORT" letters on beam
        ctx.fillStyle = COLORS.black;
        ctx.font = 'bold 38px sans-serif';
        ctx.fillText('PORT 7G', cx - 80, cy - height*0.5 + 38);
        break;
      }
      case 'dataCore': {
        // Central data core — stacked black/red squares
        ctx.fillStyle = COLORS.black;
        ctx.fillRect(lm.x - lm.r, lm.y - lm.r, lm.r*2, lm.r*2);
        // Red core
        ctx.fillStyle = COLORS.red;
        ctx.fillRect(lm.x - lm.r*0.6, lm.y - lm.r*0.6, lm.r*1.2, lm.r*1.2);
        // Inner "rack rows" white pattern
        ctx.fillStyle = COLORS.cream;
        for (let i = 0; i < 6; i++) {
          ctx.fillRect(lm.x - lm.r*0.5, lm.y - lm.r*0.5 + i*lm.r*0.18, lm.r, lm.r*0.06);
        }
        // Pulsing center
        ctx.fillStyle = COLORS.cream;
        ctx.globalAlpha = 0.5 + Math.sin(game.time*0.1)*0.5;
        ctx.beginPath();
        ctx.arc(lm.x, lm.y, lm.r*0.22, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Heat sink fins around
        ctx.fillStyle = COLORS.gray;
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI/4;
          ctx.save();
          ctx.translate(lm.x, lm.y);
          ctx.rotate(a);
          ctx.fillRect(lm.r*0.95, -8, 30, 16);
          ctx.restore();
        }
        // Capture-node markers
        if (lm.capturePoints) {
          for (const n of lm.capturePoints) {
            ctx.fillStyle = COLORS.black;
            ctx.fillRect(n.x - 30, n.y - 30, 60, 60);
            ctx.fillStyle = COLORS.cream;
            ctx.font = 'bold 14px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('NODE', n.x, n.y + 4);
            ctx.textAlign = 'left';
          }
        }
        break;
      }
      case 'droneHive': {
        // Hexagonal hive base
        ctx.fillStyle = COLORS.black;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = i / 6 * Math.PI*2;
          const x = lm.x + Math.cos(a)*lm.r;
          const y = lm.y + Math.sin(a)*lm.r;
          if (i===0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        // Inner red hexagon
        ctx.fillStyle = COLORS.red;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = i / 6 * Math.PI*2;
          const x = lm.x + Math.cos(a)*lm.r*0.6;
          const y = lm.y + Math.sin(a)*lm.r*0.6;
          if (i===0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        // Hexagonal honeycomb cells
        ctx.fillStyle = COLORS.black;
        for (let ring = 0; ring < 3; ring++) {
          for (let i = 0; i < 6; i++) {
            const a = i / 6 * Math.PI*2;
            const r = (ring+1) * lm.r*0.18;
            const cx = lm.x + Math.cos(a)*r, cy = lm.y + Math.sin(a)*r;
            ctx.beginPath();
            ctx.arc(cx, cy, lm.r*0.06, 0, Math.PI*2);
            ctx.fill();
          }
        }
        // Pulsing center
        ctx.fillStyle = COLORS.cream;
        ctx.globalAlpha = 0.6 + Math.sin(game.time*0.12)*0.4;
        ctx.beginPath();
        ctx.arc(lm.x, lm.y, lm.r*0.16, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }
    }
    ctx.restore();
  }
}

function drawLandmarksTop() {
  // Drawn last so spires/antennas read as tall
  for (const lm of landmarks) {
    ctx.save();
    if (lm.kind === 'blastFurnace') {
      // Smoke stack rising
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(lm.x - 16, lm.y - lm.r*1.6, 32, lm.r*0.8);
      ctx.fillStyle = COLORS.gray;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.arc(lm.x, lm.y - lm.r*1.7, 60, 0, Math.PI*2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (lm.kind === 'droneHive') {
      // Antenna spire
      ctx.fillStyle = COLORS.black;
      ctx.fillRect(lm.x - 4, lm.y - lm.r*2.4, 8, lm.r*1.4);
      ctx.fillStyle = COLORS.red;
      ctx.beginPath();
      ctx.arc(lm.x, lm.y - lm.r*2.4, 10, 0, Math.PI*2);
      ctx.fill();
      // Pulse blink
      if (Math.sin(game.time*0.1) > 0.6) {
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.arc(lm.x, lm.y - lm.r*2.4, 32, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    } else if (lm.kind === 'reactorPool') {
      // Containment dome top — small concentric red rings
      ctx.strokeStyle = COLORS.red;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(lm.x, lm.y, lm.r*1.05, 0, Math.PI*2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
}

// ============ VISION / FOG / SOUND RENDERING ============
// Soft fog over the world. The cones of every alive friendly (player + allies)
// are CUT OUT of the fog using destination-out compositing — overlapping cones
// merge into one visible region, so the player never sees crossed cone edges.
// The cone vertex is offset forward from each unit so the fan doesn't look like
// a sharp triangle pinned to the character; instead it spreads out in front.
const VISION_OFFSET = 24;
const FOG_TINT = 'rgba(28, 26, 32, 0.36)';
const _polyBuf = [];
function drawSharedVisionFog() {
  // Bounding box of the world viewport in world coords
  const camHalfW = W() / camera.scale + 400;
  const camHalfH = H() / camera.scale + 400;
  const fx = camera.x - camHalfW, fy = camera.y - camHalfH;
  const fw = camHalfW * 2, fh = camHalfH * 2;

  ctx.save();
  ctx.fillStyle = FOG_TINT;
  ctx.fillRect(fx, fy, fw, fh);

  ctx.globalCompositeOperation = 'destination-out';

  const friendlies = [];
  if (player.alive) friendlies.push(player);
  for (const a of allies) if (a.alive) friendlies.push(a);

  for (const f of friendlies) {
    const ox = f.x + Math.cos(f.angle) * VISION_OFFSET;
    const oy = f.y + Math.sin(f.angle) * VISION_OFFSET;
    buildVisionPoly(_polyBuf, ox, oy, f.angle, VIEW.arc, VIEW.range);
    ctx.beginPath();
    ctx.moveTo(_polyBuf[0].x, _polyBuf[0].y);
    for (let i = 1; i < _polyBuf.length; i++) {
      ctx.lineTo(_polyBuf[i].x, _polyBuf[i].y);
    }
    ctx.closePath();
    ctx.fill();
    // Small "self halo" so the unit isn't sitting in dim fog
    ctx.beginPath();
    ctx.arc(f.x, f.y, 56, 0, Math.PI*2);
    ctx.fill();
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

function drawSoundIndicators() {
  if (!player.alive || soundEvents.length === 0) return;
  ctx.save();
  for (const s of soundEvents) {
    if (s.isPlayerSelf) continue;   // your own gunshots don't need an indicator
    const dx = s.x - player.x, dy = s.y - player.y;
    const a = Math.atan2(dy, dx);
    const dist = Math.hypot(dx, dy);
    const inCone = angleInCone(player.angle, VIEW.arc, player.x, player.y, s.x, s.y);
    const ringR = 230 / camera.scale;
    const alpha = s.life / s.maxLife;

    // Pulse ring at the sound origin (always visible)
    const pulse = (1 - alpha) * 60;
    ctx.strokeStyle = s.fromPlayer ? 'rgba(26,26,26,0.7)' : 'rgba(230, 51, 41, 0.85)';
    ctx.lineWidth = 2;
    ctx.globalAlpha = alpha * 0.6;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 12 + pulse, 0, Math.PI*2);
    ctx.stroke();

    // Off-screen / off-cone direction marker on player's ring
    if (!inCone || dist > VIEW.range) {
      const ix = player.x + Math.cos(a) * ringR;
      const iy = player.y + Math.sin(a) * ringR;
      ctx.save();
      ctx.translate(ix, iy);
      ctx.rotate(a);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = s.fromPlayer ? COLORS.black : COLORS.red;
      // Triangle pointing outward
      ctx.beginPath();
      ctx.moveTo(20, 0);
      ctx.lineTo(0, -10);
      ctx.lineTo(0, 10);
      ctx.closePath();
      ctx.fill();
      // Wing marks
      ctx.fillRect(-4, -14, 2, 28);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawGunAimIndicator() {
  if (!player.alive) return;
  // A short red line from the gun barrel showing where the bullet ACTUALLY goes right now,
  // distinct from the white crosshair (which shows where the player is looking).
  const a = player.gunAngle + player.gunRecoil;
  const len = 90;
  ctx.save();
  ctx.strokeStyle = 'rgba(200, 38, 28, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(player.x + Math.cos(a)*22, player.y + Math.sin(a)*22);
  ctx.lineTo(player.x + Math.cos(a)*len, player.y + Math.sin(a)*len);
  ctx.stroke();
  ctx.setLineDash([]);
  // Small tick at the end
  ctx.fillStyle = COLORS.red;
  ctx.beginPath();
  ctx.arc(player.x + Math.cos(a)*len, player.y + Math.sin(a)*len, 3, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();
}

function drawHumanoid(x, y, angle, walkPhase, color, isEnemy, unitOrChassis) {
  // Dispatch to chassis-specific silhouettes. Accepts a chassis id string
  // or a unit object (reads u._chassis). Defaults to humanoid when nothing
  // is supplied — keeps legacy call sites working.
  const chassisId = (typeof unitOrChassis === 'string')
    ? unitOrChassis
    : (unitOrChassis && unitOrChassis._chassis) || 'humanoid';
  if (chassisId === 'wolf')  { _drawWolfChassis(x, y, angle, walkPhase, color, isEnemy); return; }
  if (chassisId === 'heavy') { _drawHeavyChassis(x, y, angle, walkPhase, color, isEnemy); return; }
  // Humanoid (default)
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = COLORS.creamDark;
  ctx.beginPath();
  ctx.ellipse(2, 5, 17, 6, 0, 0, Math.PI*2);
  ctx.fill();

  ctx.rotate(angle);

  const legOffset = Math.sin(walkPhase) * 4;
  ctx.fillStyle = color;
  ctx.fillRect(-9, -3+legOffset, 7, 6);
  ctx.fillRect(2, -3-legOffset, 7, 6);

  ctx.fillRect(-10, -10, 16, 20);
  ctx.fillRect(-5, -6, 10, 8);

  ctx.fillStyle = isEnemy ? COLORS.redDim : COLORS.black;
  ctx.fillRect(4, -2, 20, 4);

  if (isEnemy) {
    ctx.fillStyle = COLORS.black;
    ctx.fillRect(-3, -6, 6, 4);
  } else {
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(-2, 2, 4, 6);
  }

  ctx.restore();
}

// Wolf: quadruped silhouette — longer + lower than humanoid, four short
// stubby legs that alternate-pair gait. Smaller hitbox communicated by the
// thin elliptical shadow.
function _drawWolfChassis(x, y, angle, walkPhase, color, isEnemy) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = COLORS.creamDark;
  ctx.beginPath();
  ctx.ellipse(0, 4, 14, 5, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.rotate(angle);
  // 4 legs in trot pattern (front-L + rear-R, then front-R + rear-L)
  const phase = walkPhase * 1.4;
  const legA = Math.sin(phase) * 3;
  const legB = Math.sin(phase + Math.PI) * 3;
  ctx.fillStyle = color;
  ctx.fillRect(-12, -7 + legA, 4, 5);
  ctx.fillRect(-12,  3 + legB, 4, 5);
  ctx.fillRect( 4, -7 + legB, 4, 5);
  ctx.fillRect( 4,  3 + legA, 4, 5);
  // Long thin body
  ctx.fillRect(-13, -5, 22, 10);
  // Head — pointed
  ctx.beginPath();
  ctx.moveTo(9, -3); ctx.lineTo(15, 0); ctx.lineTo(9, 3); ctx.closePath();
  ctx.fill();
  // Mounted gun (shorter than humanoid's)
  ctx.fillStyle = isEnemy ? COLORS.redDim : COLORS.black;
  ctx.fillRect(8, -1.5, 14, 3);
  // Eye
  if (isEnemy) {
    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.arc(11, 0, 1.6, 0, Math.PI*2);
    ctx.fill();
  } else {
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(-2, -1, 3, 2);
  }
  ctx.restore();
}

// Heavy mech: bulkier square chassis + big shoulders + thicker barrel.
function _drawHeavyChassis(x, y, angle, walkPhase, color, isEnemy) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = COLORS.creamDark;
  ctx.beginPath();
  ctx.ellipse(2, 6, 21, 7, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.rotate(angle);
  // Chunky legs (smaller swing than humanoid)
  const legOffset = Math.sin(walkPhase * 0.7) * 2.5;
  ctx.fillStyle = color;
  ctx.fillRect(-11, -5 + legOffset,  9, 8);
  ctx.fillRect(-11,  3 - legOffset,  9, 8);
  // Wide armored body
  ctx.fillRect(-13, -13, 22, 26);
  // Shoulder plates
  ctx.fillStyle = isEnemy ? COLORS.redDim : '#333';
  ctx.fillRect(-15, -13, 4, 12);
  ctx.fillRect( 9, -13, 4, 12);
  // Heavy gun barrel
  ctx.fillStyle = isEnemy ? COLORS.redDim : COLORS.black;
  ctx.fillRect(5, -3, 24, 6);
  // Cockpit window / eye
  if (isEnemy) {
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(-4, -8, 8, 4);
  } else {
    ctx.fillStyle = COLORS.red;
    ctx.fillRect(-4, -8, 8, 3);
    ctx.fillStyle = COLORS.black;
    ctx.fillRect(-2, 4, 4, 6);
  }
  // Center rivet
  ctx.fillStyle = COLORS.black;
  ctx.beginPath(); ctx.arc(0, 0, 1.4, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

function drawDrone(x, y, color, phase) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = COLORS.creamDark;
  ctx.beginPath();
  ctx.arc(2, 4, 10, 0, Math.PI*2);
  ctx.fill();

  ctx.strokeStyle = COLORS.gray;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (i*Math.PI/2) + phase;
    const cx = Math.cos(i*Math.PI/2 + Math.PI/4)*10;
    const cy = Math.sin(i*Math.PI/2 + Math.PI/4)*10;
    ctx.moveTo(cx + Math.cos(a)*5, cy + Math.sin(a)*5);
    ctx.lineTo(cx - Math.cos(a)*5, cy - Math.sin(a)*5);
  }
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.fillRect(-2, -10, 4, 20);
  ctx.fillRect(-10, -2, 20, 4);

  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI*2);
  ctx.fill();

  ctx.restore();
}


// arena-mp: no campaign waypoints; compass is a no-op.
function drawObjectiveCompass() {}
function collectMissionWaypoints() { return []; }

// Shared HUD helper for the objective panel (used by mission.renderHUD).
// Phase 77 — fully hidden on narrow viewports (<500px). User '介面極度
// 臃腫'. Every line this panel shows (KILLS / DEATHS / TIME / SQUAD /
// B BUILD · G RECRUIT) is already available elsewhere on the HUD:
//   • kills → top-right score row 'SCORE · KILLS N'
//   • time  → not meaningful in endless arena, was just noise
//   • squad → top-left status panel has squad chips (tappable swap)
//   • B/G hints → right-side touch action column shows the buttons
// So duplicating it inside a fat 200px panel was pure clutter on phones.
// Phase 75 had moved + shrunk it; Phase 77 drops it entirely.
function drawObjectivePanel(lines) {
  if (W() < 500) return;
  // Wide screens only — narrow screens early-return above. Top-centered panel.
  const w = 300;
  const h = 36 + lines.length * 17;
  const x = W() / 2 - w / 2;
  const y = 54;
  drawHUDPanel(x, y, w, h, null);
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(x + 10, y + 8, 28, 12);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('MSN', x + 24, y + 17);
  ctx.textAlign = 'left';
  ctx.fillStyle = COLORS.black;
  ctx.font = 'bold 11px sans-serif';
  const title = (missionTitle(mission) || '').toUpperCase();
  ctx.fillText(title, x + 46, y + 17);
  ctx.fillStyle = 'rgba(26, 26, 26, 0.18)';
  ctx.fillRect(x + 10, y + 26, w - 20, 1);
  ctx.fillStyle = COLORS.black;
  ctx.font = '10px monospace';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + 10, y + 40 + i * 16);
  }
}

// ============ DEFENSE BUILD UI (radial + status pill) ============
// → Moved to js/defense_build_ui.js. Declares globally:
//     RADIAL_R_INNER · RADIAL_R_OUTER · _radialGeom · _radialKindUnderCursor
//     drawDefenseStatusPill · drawDefenseShop · drawBuildRadial ·
//     renderBuildPreview

// ============ HUD ============
// (arena-mp: FTUE-reveal gating was always-true → inlined.)

function renderFPVOverlay() {
  const cx = W()/2, cy = H()/2;
  // Frame brackets
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 30, cy); ctx.lineTo(cx - 10, cy);
  ctx.moveTo(cx + 10, cy); ctx.lineTo(cx + 30, cy);
  ctx.moveTo(cx, cy - 30); ctx.lineTo(cx, cy - 10);
  ctx.moveTo(cx, cy + 10); ctx.lineTo(cx, cy + 30);
  ctx.stroke();
  ctx.beginPath();
  for (const [x, y] of [[-50,-50],[50,-50],[-50,50],[50,50]]) {
    const dirX = Math.sign(x), dirY = Math.sign(y);
    ctx.moveTo(cx + x, cy + y - dirY*18);
    ctx.lineTo(cx + x, cy + y);
    ctx.lineTo(cx + x - dirX*18, cy + y);
  }
  ctx.stroke();

  // Telemetry panel (left)
  ctx.fillStyle = 'rgba(26, 26, 26, 0.85)';
  ctx.fillRect(20, H()/2 - 70, 130, 140);
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(20, H()/2 - 70, 4, 140);
  ctx.strokeStyle = COLORS.cream;
  ctx.lineWidth = 1;
  ctx.strokeRect(24, H()/2 - 70, 126, 140);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('FPV — KAMIKAZE', 32, H()/2 - 50);
  ctx.font = 'bold 13px monospace';
  ctx.fillText(`THR  100%`, 32, H()/2 - 26);
  ctx.fillText(`SPD   ${(fpv.speed*45).toFixed(0)}`, 32, H()/2 - 8);
  ctx.fillText(`ALT   080m`, 32, H()/2 + 10);
  ctx.fillText(`GUN  ----`, 32, H()/2 + 28);
  ctx.fillText(`RKT    01`, 32, H()/2 + 46);
  // Phase 9: pulsing hint that SPACE manually detonates the FPV. Sits
  // bottom-center so it's unmissable while diving.
  const _spcPulse = 0.6 + 0.4 * Math.sin(game.time * 0.18);
  ctx.fillStyle = `rgba(230, 51, 41, ${_spcPulse})`;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(_r('▶ 空白鍵 · 手動引爆', '▶ SPACE · MANUAL DETONATE'),
               W()/2, H() - 60);
  ctx.font = 'bold 10px monospace';
  ctx.fillStyle = COLORS.cream;
  ctx.fillText(_r('(隨時可炸 · 不需命中)',
                  '(detonate any time · no impact needed)'),
               W()/2, H() - 44);
  ctx.textAlign = 'left';

  // LOCK indicator
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(W()/2 + 70, H()/2 + 60, 90, 28);
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('LOCK', W()/2 + 115, H()/2 + 80);
  ctx.textAlign = 'left';

  // Speed lines
  ctx.strokeStyle = COLORS.cream;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 10; i++) {
    const t = (game.time + i*5) % 60 / 60;
    const x = W() * (0.05 + t*0.18);
    const y = H() * (0.18 + i*0.07);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 35, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W()-x, y); ctx.lineTo(W()-x-35, y); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Vignette for that "small camera" feel
  const grad = ctx.createRadialGradient(cx, cy, Math.min(W(),H())*0.3, cx, cy, Math.max(W(),H())*0.7);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W(), H());
}

function renderDroneOverlay() {
  // No drone HUD when the team is wiped — there's no live operator to
  // watch the feed, and the panel would crowd the SQUAD WIPED recap.
  if (typeof _isBlueTeamWiped === 'function' && _isBlueTeamWiped()) return;
  // UAV HUD panel
  ctx.fillStyle = 'rgba(232, 228, 216, 0.94)';
  ctx.fillRect(20, H()/2 - 80, 140, 160);
  ctx.strokeStyle = COLORS.black;
  ctx.lineWidth = 2;
  ctx.strokeRect(20, H()/2 - 80, 140, 160);
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(20, H()/2 - 80, 4, 160);

  ctx.fillStyle = COLORS.black;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('UAV — RECON', 32, H()/2 - 60);
  ctx.fillRect(32, H()/2 - 56, 40, 1);
  ctx.font = 'bold 13px monospace';
  ctx.fillText(`ALT   120m`, 32, H()/2 - 32);
  ctx.fillText(`SPD    ${drone.deployed ? 45 : 0}`, 32, H()/2 - 14);
  ctx.fillText(`BAT   ${drone.battery.toFixed(0)}%`, 32, H()/2 + 4);
  ctx.fillText(`SIG   STR`, 32, H()/2 + 22);
  // Battery bar
  ctx.fillStyle = COLORS.creamDark;
  ctx.fillRect(32, H()/2 + 36, 110, 10);
  ctx.fillStyle = drone.battery > 30 ? COLORS.black : COLORS.red;
  ctx.fillRect(32, H()/2 + 36, 110 * drone.battery/drone.maxBattery, 10);
  ctx.fillStyle = COLORS.gray;
  ctx.font = '10px monospace';
  ctx.fillText(T('Q · 切换视角', 'Q · SWITCH VIEW'), 32, H()/2 + 64);

  // Frame brackets (corners)
  ctx.strokeStyle = COLORS.black;
  ctx.lineWidth = 2;
  const fx = W()*0.15, fy = H()*0.15;
  const fw = W()*0.7, fh = H()*0.7;
  const cl = 24;
  ctx.beginPath();
  ctx.moveTo(fx, fy+cl); ctx.lineTo(fx, fy); ctx.lineTo(fx+cl, fy);
  ctx.moveTo(fx+fw-cl, fy); ctx.lineTo(fx+fw, fy); ctx.lineTo(fx+fw, fy+cl);
  ctx.moveTo(fx, fy+fh-cl); ctx.lineTo(fx, fy+fh); ctx.lineTo(fx+cl, fy+fh);
  ctx.moveTo(fx+fw-cl, fy+fh); ctx.lineTo(fx+fw, fy+fh); ctx.lineTo(fx+fw, fy+fh-cl);
  ctx.stroke();

  // REC indicator (top-left of frame)
  ctx.fillStyle = COLORS.red;
  ctx.beginPath();
  ctx.arc(fx + 16, fy + 16, 5, 0, Math.PI*2);
  if (Math.sin(game.time*0.2) > 0) ctx.fill();
  ctx.fillStyle = COLORS.black;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('REC', fx + 26, fy + 20);

  // Phase 51: "YOU" tracker — when the player avatar is off-screen while
  // the camera is on the drone, draw an edge arrow + distance toward
  // them so the user always knows where their body is. User report:
  // '我用無人機按Q的時候 我就看不到自己在哪裡'.
  if (player && player.alive && drone.deployed) {
    const sw = W(), sh = H();
    // World → screen via camera transform (camera.x/y is world center).
    const dxW = player.x - camera.x;
    const dyW = player.y - camera.y;
    const sX = sw / 2 + dxW * camera.scale;
    const sY = sh / 2 + dyW * camera.scale;
    const margin = 36;
    const offscreen = (sX < margin || sX > sw - margin
                    || sY < margin || sY > sh - margin);
    if (offscreen) {
      // Clamp arrow position to screen edge along the player direction
      const ang = Math.atan2(dyW, dxW);
      const ex = sw / 2, ey = sh / 2;
      // Find intersection of ray from screen center to player with the
      // inset rectangle. Use parametric line until x or y hits margin.
      const halfW = sw / 2 - margin;
      const halfH = sh / 2 - margin;
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const tX = (cosA !== 0) ? halfW / Math.abs(cosA) : Infinity;
      const tY = (sinA !== 0) ? halfH / Math.abs(sinA) : Infinity;
      const t = Math.min(tX, tY);
      const ax = ex + cosA * t;
      const ay = ey + sinA * t;
      // Distance pip in world units
      const distU = Math.round(Math.hypot(dxW, dyW));
      // Arrow — cream filled triangle pointing toward the player
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.fillStyle = COLORS.cream;
      ctx.strokeStyle = COLORS.black;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, 0); ctx.lineTo(-8, -8); ctx.lineTo(-8, 8); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
      // "YOU · 320u" badge just inside the arrow
      const lx = ax - cosA * 30;
      const ly = ay - sinA * 30;
      ctx.fillStyle = 'rgba(20,18,24,0.85)';
      ctx.fillRect(lx - 36, ly - 9, 72, 18);
      ctx.fillStyle = COLORS.cream;
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`YOU · ${distU}u`, lx, ly + 4);
      ctx.textAlign = 'left';
    }
  }
}

function renderCommandOverlay() {
  // No command HUD when the team is wiped — no live allies to command,
  // and the chrome would crowd the SQUAD WIPED countdown + WATCH AD CTA.
  if (typeof _isBlueTeamWiped === 'function' && _isBlueTeamWiped()) return;
  // Strategic overlay (left side)
  ctx.fillStyle = 'rgba(232, 228, 216, 0.94)';
  ctx.fillRect(20, H()/2 - 60, 240, 120);
  ctx.strokeStyle = COLORS.black;
  ctx.lineWidth = 2;
  ctx.strokeRect(20, H()/2 - 60, 240, 120);
  ctx.fillStyle = COLORS.red;
  ctx.fillRect(20, H()/2 - 60, 4, 120);
  ctx.fillStyle = COLORS.black;
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText(T('指挥视角 COMMAND VIEW', 'COMMAND VIEW'), 32, H()/2 - 40);
  ctx.fillRect(32, H()/2 - 36, 40, 1);
  ctx.font = 'bold 12px monospace';
  const allyCount = allies.filter(a => a && a.alive).length;
  ctx.fillText(`SECTOR    7G`, 32, H()/2 - 14);
  ctx.fillText(`UNITS     ${allyCount} ALLY`, 32, H()/2 + 4);
  ctx.fillStyle = COLORS.red;
  const dt = enemies.filter(e=>e.alive).length + enemyDrones.filter(d=>d.alive).length;
  ctx.fillText(`THREATS   ${dt}`, 32, H()/2 + 22);
  ctx.fillStyle = COLORS.gray;
  ctx.font = '10px sans-serif';
  ctx.fillText(T('TAB · 返回战术视角', 'TAB · BACK TO TACTICAL'), 32, H()/2 + 44);

  // Squad-orders strip (bottom of screen) — shows the 7 numbered slots,
  // highlights the active order, and pulses while the order is in effect.
  const lang = (typeof getLang === 'function' && getLang() === 'zh') ? 'zh' : 'en';
  const ids = ['rally','spread','attack','defend','protect','suppress','retreat'];
  const activeId = (_squadOrderActive() ? game._squadOrder.id : null);
  const activeRemain = activeId
    ? Math.max(0, (game._squadOrder.expiresAt - game.time) / SQUAD_ORDER_DURATION)
    : 0;
  const slotW = 110, slotH = 52, gap = 6;
  const totalW = ids.length * slotW + (ids.length - 1) * gap;
  const baseX = (W() - totalW) / 2;
  const y = H() - slotH - 24;
  ctx.save();
  // Heading
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  // Phase 14: heading shows '集合/護衛 → UAV' when the player is piloting
  // the recon drone, so they know rally + protect now escort the UAV rather
  // than the player's body.
  const _droneAnchor = (typeof drone !== 'undefined' && drone.deployed && game.mode === 'drone');
  if (_droneAnchor) {
    ctx.fillText(lang === 'zh' ? '隊伍指令 · 1/5 跟隨 UAV · 1-7 下令'
                                : 'SQUAD ORDERS · 1/5 ESCORT UAV · 1-7 to issue',
                 W()/2, y - 8);
  } else {
    ctx.fillText(lang === 'zh' ? '隊伍指令 · 1-7 下令' : 'SQUAD ORDERS · 1-7 to issue',
                 W()/2, y - 8);
  }
  for (let i = 0; i < ids.length; i++) {
    const def = SQUAD_ORDERS[ids[i]];
    const x = baseX + i * (slotW + gap);
    const isActive = (def.id === activeId);
    // Background
    ctx.fillStyle = isActive ? COLORS.red : 'rgba(20, 18, 24, 0.85)';
    ctx.fillRect(x, y, slotW, slotH);
    ctx.strokeStyle = isActive ? COLORS.cream : 'rgba(232,228,216,0.4)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, slotW, slotH);
    // Active progress bar (fills from right to left as order expires)
    if (isActive) {
      ctx.fillStyle = 'rgba(232,228,216,0.25)';
      ctx.fillRect(x, y + slotH - 3, slotW * activeRemain, 3);
    }
    // Hotkey badge
    ctx.fillStyle = isActive ? COLORS.cream : COLORS.gray;
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(def.key, x + 8, y + 14);
    // Label
    ctx.fillStyle = COLORS.cream;
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((lang === 'zh') ? def.zh : def.en, x + slotW/2, y + 26);
    // Sub-label radio
    ctx.fillStyle = isActive ? COLORS.cream : 'rgba(232,228,216,0.55)';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(`"${(lang === 'zh') ? def.radio_zh : def.radio_en}"`, x + slotW/2, y + 42);
  }
  ctx.restore();
}
