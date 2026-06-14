// ============ MINE DEFUSE (Phase 63 — extracted to a module in Phase 185) ====
// Hostile mines are bulletImmune (see structures.js mine + tripmine defs). The
// only way to clear a mine is the G-key defuse: walk within MINE_DEFUSE_RANGE,
// press G, hold position for `defuseTicks` (5s). State is per-player
// (player._defuse = {sid, startedAt}); leaving range or the mine detonating
// cancels it. Lifted verbatim out of the index.html inline monolith (behaviour-
// preserving modularization). Classic-script globals — call sites unchanged.
//
// Declares globally: MINE_DEFUSE_RANGE · _tryDefuseMine() · tickMineDefuse() ·
//   renderMineDefuseRing().
// Deps (call-time globals): player · game._structures/_energy/time · STRUCTURE_DEFS
//   · BALANCE · ctx · COLORS · T · showSwapToast · playRadioBeep.
const MINE_DEFUSE_RANGE = 60;

// G-key handler — try to start a defuse on the nearest mine. Returns true
// if a defuse target was selected this press (so the caller skips its
// fallback action — grenade throw). No-op if already defusing the same
// mine, or if no mine is in range.
function _tryDefuseMine() {
  if (!player.alive || !game._structures) return false;
  let best = null, bestD = MINE_DEFUSE_RANGE + 0.001;
  for (const s of game._structures) {
    const def = STRUCTURE_DEFS[s.kind];
    if (!def || s.hp <= 0) continue;
    if (!(s.kind === 'mine' || s.kind === 'tripmine')) continue;
    const d = Math.hypot(s.x - player.x, s.y - player.y);
    if (d < bestD) { best = s; bestD = d; }
  }
  if (!best) return false;
  // Already defusing this one? Treat as a no-op (don't reset progress) so
  // the player can hammer G safely.
  if (player._defuse && player._defuse.sid === best.sid) return true;
  player._defuse = { sid: best.sid, startedAt: game.time };
  if (typeof showSwapToast === 'function') {
    showSwapToast(T('▶ 拆解中 · 不要離開',
                    '▶ DEFUSING · stay close'));
  }
  if (typeof playRadioBeep === 'function') playRadioBeep(440, 0.1);
  return true;
}

// Per-frame: advance any active defuse. Cancel if player moved out of
// range, died, or the target mine vanished (it detonated, e.g. enemy
// walked over it mid-defuse). Complete when defuseTicks elapsed.
function tickMineDefuse() {
  if (!player._defuse) return;
  const d = player._defuse;
  if (!player.alive) { player._defuse = null; return; }
  const target = (game._structures || []).find(s => s.sid === d.sid);
  if (!target || target.hp <= 0) { player._defuse = null; return; }
  const dist = Math.hypot(target.x - player.x, target.y - player.y);
  if (dist > MINE_DEFUSE_RANGE) {
    if (typeof showSwapToast === 'function') {
      showSwapToast(T('▶ 拆解中斷', '▶ DEFUSE INTERRUPTED'));
    }
    player._defuse = null;
    return;
  }
  const def = STRUCTURE_DEFS[target.kind] || {};
  const need = def.defuseTicks || (5 * 60);
  if (game.time - d.startedAt >= need) {
    // Complete — remove the mine + refund a tiny chunk of energy as a
    // 'recovered components' reward.
    target.hp = 0;
    addEnergy(BALANCE.energy.mineDefuse);
    if (typeof showSwapToast === 'function') {
      showSwapToast(T(`▶ 拆解完成 +${BALANCE.energy.mineDefuse}⚡`, `▶ DEFUSED +${BALANCE.energy.mineDefuse}⚡`));
    }
    if (typeof playRadioBeep === 'function') playRadioBeep(880, 0.18);
    player._defuse = null;
  }
}

// World-space render: ring filling around the target mine. Drawn in the
// same coordinate space as the unit render loop, so call it AFTER ctx
// camera transform is applied.
function renderMineDefuseRing() {
  if (!player._defuse || !game._structures) return;
  const d = player._defuse;
  const target = game._structures.find(s => s.sid === d.sid);
  if (!target) return;
  const def = STRUCTURE_DEFS[target.kind] || {};
  const need = def.defuseTicks || (5 * 60);
  const _tRaw = Math.max(0, Math.min(1, (game.time - d.startedAt) / need));
  // Phase 67 — ease-out cubic so the ring fills fast at the start then
  // slows into the final wedge (feels like 'almost there...' instead of
  // a metronomic linear sweep).
  const t = 1 - Math.pow(1 - _tRaw, 3);
  const r = (def.size || 24) / 2 + 8;
  ctx.save();
  // Backdrop ring (full circle, dim) — shows the player WHERE to look.
  ctx.strokeStyle = COLORS.cream;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.30;
  ctx.beginPath();
  ctx.arc(target.x, target.y, r, 0, Math.PI * 2);
  ctx.stroke();
  // Progress ring — bright yellow arc from −π/2 (12 o'clock) sweeping
  // clockwise. Reads as a 'charging' loader.
  ctx.strokeStyle = '#FFD24A';
  ctx.lineWidth = 4;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(target.x, target.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
  ctx.stroke();
  // Center label — countdown in seconds.
  const secLeft = Math.max(0, Math.ceil((need - (game.time - d.startedAt)) / 60));
  ctx.fillStyle = COLORS.cream;
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.globalAlpha = 0.9;
  ctx.fillText(`${secLeft}s`, target.x, target.y - r - 4);
  ctx.textAlign = 'left';
  ctx.restore();
}
