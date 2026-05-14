// ============================================================
// Phase 3c — Server-side NN observation builder.
// ============================================================
//
// Builds a 65-dim observation vector matching the obs layout the PPO
// model was trained against (see js/missions/nn_deathmatch.js / the
// client's nnBuildObs at index.html ~4530). The trained policy outputs
// 18 logits (= 9 move dirs × 2 fire bits), so we just need the obs in
// the same shape.
//
// Layout (each block prefixed with its byte-offset / length):
//
//    0  self        (8)  pos.xy, sin/cos heading, hp_frac, recentDmg,
//                        fireCd_frac, alive
//    8  enemies × 3 (18) per-slot: rel.xy, dist_frac, hp_frac,
//                        is_visible, padding
//   26  teammates × 2 (12) per-slot: rel.xy, dist_frac, hp_frac, alive,
//                        is_visible
//   38  cover    × 5 (15) per-slot: rel.xy, dist_frac
//   53  last seen enemy (4)  rel.xy, age_frac, valid
//   57  last sound (4)       rel.xy, recency, friendly_flag
//   61  match state (4)     time_left, my_kills, enemy_kills, alive_count
//   65  ────────────
//
// Server-side simplifications (vs the client):
//
//   1. Cover points: server has no map cover data yet (Phase 4 will
//      share the map). Zero-padded for now — equivalent to telling the
//      policy "I see no nearby cover."
//
//   2. Last-seen / last-sound: server doesn't yet maintain these per
//      bot (Phase 3-followup work to mirror the client's _nnLastSeenX/Y
//      bookkeeping). Zero-padded.
//
//   3. Match state: zero-padded (the policy is robust to this — it was
//      trained with mostly-uniform values across training runs).
//
//   4. Visibility: angle-cone check only. No LoS — server has no map
//      walls. Equivalent to "open arena" assumption, which matches the
//      training regime where most of the map was open ground.

import { PLAYER_HP_MAX } from './constants.js';

const VIEW_RANGE      = 720;
const VIEW_RANGE2     = VIEW_RANGE * VIEW_RANGE;
const VIEW_ARC_BASE   = 140 * Math.PI / 180;     // 140° in rad
const VIEW_ARC_NEAR   = 170 * Math.PI / 180;     // 170° at point-blank
const NEAR_RANGE      = 120;                     // arc widens inside this
const WORLD_W         = 1800;                    // matches ARENA_W
const WORLD_H         = 1800;
const FIRE_CD_REF     = 8;                       // reference cooldown for normalization

function _effectiveArc(dist) {
  if (dist <= NEAR_RANGE) return VIEW_ARC_NEAR;
  if (dist >= VIEW_RANGE) return VIEW_ARC_BASE;
  const t = (dist - NEAR_RANGE) / (VIEW_RANGE - NEAR_RANGE);
  return VIEW_ARC_NEAR + (VIEW_ARC_BASE - VIEW_ARC_NEAR) * t;
}

function _isVisible(me, target) {
  if (!target.alive) return false;
  const dx = target.x - me.x, dy = target.y - me.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > VIEW_RANGE2) return false;
  const dist = Math.sqrt(d2);
  const a = Math.atan2(dy, dx);
  let diff = a - me.angle;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) > _effectiveArc(dist) / 2) return false;
  return true;
}

/**
 * Build observation. Output written into `outBuf` (must be 65-length
 * Float32Array; caller owns the allocation). flipX mirrors the obs
 * across the arena's vertical axis — used for team-1 (red) units
 * because the policy was trained only on team-0 (blue, left-spawn)
 * data; world coords get mirrored back when applying the action.
 *
 * Returns the obs length (65) for sanity assertions.
 */
export function buildObs(me, friendlies, enemies, outBuf, flipX = false) {
  const obs = outBuf;
  const W = WORLD_W, H = WORLD_H;
  const meX     = flipX ? (W - me.x) : me.x;
  const flipDX  = flipX ? -1 : 1;
  const cosFlip = flipX ? -1 : 1;

  let i = 0;
  // Self (8)
  obs[i++] = meX / W * 2 - 1;
  obs[i++] = me.y / H * 2 - 1;
  obs[i++] = Math.sin(me.angle);
  obs[i++] = Math.cos(me.angle) * cosFlip;
  obs[i++] = me.alive ? me.hp / PLAYER_HP_MAX : 0;
  obs[i++] = (me._recentDmg || 0) > 0 ? 1 : 0;
  obs[i++] = me._fireCd > 0 ? Math.min(1, me._fireCd / FIRE_CD_REF) : 0;
  obs[i++] = me.alive ? 1 : 0;

  // Enemies × 3 (6 fields each = 18). Sort visible-first, then by dist.
  const aliveEnemies = [];
  for (let k = 0; k < enemies.length; k++) {
    const e = enemies[k]; if (e && e.alive) aliveEnemies.push(e);
  }
  aliveEnemies.sort((a, b) => {
    const va = _isVisible(me, a) ? 1 : 0;
    const vb = _isVisible(me, b) ? 1 : 0;
    if (va !== vb) return vb - va;
    const da = (a.x - me.x) * (a.x - me.x) + (a.y - me.y) * (a.y - me.y);
    const db = (b.x - me.x) * (b.x - me.x) + (b.y - me.y) * (b.y - me.y);
    return da - db;
  });
  for (let k = 0; k < 3; k++) {
    if (k < aliveEnemies.length) {
      const e = aliveEnemies[k];
      const dx = e.x - me.x, dy = e.y - me.y;
      obs[i++] = (dx / W) * 2 * flipDX;
      obs[i++] = (dy / H) * 2;
      obs[i++] = Math.sqrt(dx * dx + dy * dy) / W;
      obs[i++] = e.hp / PLAYER_HP_MAX;
      obs[i++] = _isVisible(me, e) ? 1 : 0;
      obs[i++] = 0;
    } else {
      i += 6;
    }
  }

  // Teammates × 2 (6 each = 12).
  const teammates = [];
  for (let k = 0; k < friendlies.length; k++) {
    const f = friendlies[k]; if (f && f !== me) teammates.push(f);
  }
  teammates.sort((a, b) => {
    const da = (a.x - me.x) * (a.x - me.x) + (a.y - me.y) * (a.y - me.y);
    const db = (b.x - me.x) * (b.x - me.x) + (b.y - me.y) * (b.y - me.y);
    return da - db;
  });
  for (let k = 0; k < 2; k++) {
    if (k < teammates.length) {
      const t = teammates[k];
      const dx = t.x - me.x, dy = t.y - me.y;
      obs[i++] = (dx / W) * 2 * flipDX;
      obs[i++] = (dy / H) * 2;
      obs[i++] = Math.sqrt(dx * dx + dy * dy) / W;
      obs[i++] = t.alive ? t.hp / PLAYER_HP_MAX : 0;
      obs[i++] = t.alive ? 1 : 0;
      obs[i++] = _isVisible(me, t) ? 1 : 0;
    } else {
      i += 6;
    }
  }

  // Cover × 5 (3 each = 15) — server has none yet, zero-pad.
  i += 15;

  // Last seen enemy intel (4) — server doesn't track per-bot yet.
  i += 4;

  // Last sound (4) — same.
  i += 4;

  // Match state (4) — zero-pad.
  i += 4;

  return i; // 65
}
