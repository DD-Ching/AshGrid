// ============ GLOBAL PLAYER STATS ============
// Persistent across sessions — shown on the start screen footer + used by
// the main menu to motivate return visits. Also owns the player's
// operator callsign (R11 Step 2: moved from js/ad_stubs.js, where the
// header had falsely claimed this module owned it since Phase ~30).
//
// Classic-script. Declares globally:
//   STATS_KEY · getGlobalStats() · saveGlobalStats(s) · bumpMatchPlayed(...)
//   bumpSurvivalWave(w) · refreshStartStatsLine() ·
//   OPERATOR_NAME_KEY · getOperatorName() · setOperatorName(name)
//
// External deps: localStorage · document · T · getLang ·
//   refreshStartStatsLine (self) · playUnlockChord · unlockAchievement ·
//   showStageHint · bumpDayNum · bumpCycleNum · applyUnlockGating

// Persistent across sessions — shown on the start screen footer + used by
// the main menu to motivate return visits.
const STATS_KEY = 'ag.stats';

// ─── Operator callsign (R11 Step 2) ──────────────────────────────────
// Player's chosen display name, persisted across reloads. Used by the
// global leaderboard (js/leaderboard.js _lbCurrentName), MP nameplates
// (js/multiplayer.js), share-run brag text (js/run_history.js), the
// dossier panel (js/achievements.js), and the lobby callsign input.
// Stays here because it's a core player-identity concern — independent of
// runs, ads, MP. Default '0451' matches the UNIT 0451 narrative tag.
const OPERATOR_NAME_KEY = 'ag.operatorName';
function getOperatorName() {
  try { return (localStorage.getItem(OPERATOR_NAME_KEY) || '0451').slice(0, 12); }
  catch (e) { return '0451'; }
}
function setOperatorName(name) {
  const clean = String(name || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
  if (!clean) return getOperatorName();
  try { localStorage.setItem(OPERATOR_NAME_KEY, clean); } catch (e) {}
  return clean;
}

function getGlobalStats() {
  try {
    const s = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
    if (s && typeof s === 'object') return Object.assign({ matchesPlayed: 0, totalKills: 0, bestSurvivalWave: 0 }, s);
  } catch (e) {}
  return { matchesPlayed: 0, totalKills: 0, bestSurvivalWave: 0 };
}
function saveGlobalStats(s) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (e) {}
}
// Stash the things that crossed an unlock threshold THIS match. Read by the
// end-of-match overlay (drawMatchTierUnlockStrip), cleared at next match
// start. Empty if the player didn't tier-up this match.
let _lastMatchUnlocks = [];
function _computeTierUnlocks(prevTier, nextTier) {
  if (nextTier <= prevTier) return [];
  const unlocked = [];
  const NAME = {
    survival: { zh: '生存 / SURVIVAL',  cat: 'mode'    },
    defense:  { zh: '防御 / DEFENSE',   cat: 'mode'    },
    helo:     { zh: '撤离 / HELO',      cat: 'mode'    },
    convoy:   { zh: '护送 / CONVOY',    cat: 'mode'    },
    duel:     { zh: '单挑 / DUEL',      cat: 'mode'    },
    sniper:   { zh: '狙击 / SNIPER',    cat: 'mode'    },
    warrior:  { zh: 'WARRIOR 风格',     cat: 'style'   },
    defensive:{ zh: 'GUARD 风格',       cat: 'style'   },
    sharpshooter: { zh: 'SHARP 风格',   cat: 'style'   },
    cqb:      { zh: 'RUSH 风格',        cat: 'style'   },
    tactical: { zh: 'TAC 风格',         cat: 'style'   },
    SMG:      { zh: 'SMG 武器',         cat: 'weapon'  },
    SHOTGUN:  { zh: 'SHOTGUN 武器',     cat: 'weapon'  },
    LMG:      { zh: 'LMG 武器',         cat: 'weapon'  },
    SNIPER:   { zh: 'SNIPER 武器',      cat: 'weapon'  },
    ROCKET:   { zh: 'ROCKET 武器',      cat: 'weapon'  },
    wolf:     { zh: 'WOLF 机体',        cat: 'chassis' },
    heavy:    { zh: 'HEAVY 机体',       cat: 'chassis' },
    editor:   { zh: '地图编辑器 / MAP EDITOR', cat: 'tool' },
  };
  const TABLES = [MODE_UNLOCK_TIER, STYLE_UNLOCK_TIER, WEAPON_UNLOCK_TIER, CHASSIS_UNLOCK_TIER];
  for (const t of TABLES) {
    for (const [k, tier] of Object.entries(t)) {
      if (tier > prevTier && tier <= nextTier && NAME[k]) unlocked.push({ key: k, ...NAME[k] });
    }
  }
  // Editor crosses the gate at tier 4 only — same as DUEL/SNIPER/HEAVY.
  if (prevTier < 4 && nextTier >= 4) unlocked.push({ key: 'editor', ...NAME.editor });
  return unlocked;
}
function bumpMatchPlayed() {
  const prevTier = getUnlockTier();
  const s = getGlobalStats();
  s.matchesPlayed++;
  s.totalKills += game.killCount || 0;
  saveGlobalStats(s);
  refreshStartStatsLine();
  const nextTier = getUnlockTier();
  _lastMatchUnlocks = _computeTierUnlocks(prevTier, nextTier);
  if (_lastMatchUnlocks.length > 0 && typeof playUnlockChord === 'function') {
    playUnlockChord();
  }
  // Stage hints tied to tier crosses — fire AFTER the chord so the
  // 'how to use it' tip lands while the player is still looking at
  // the unlock callout.
  if (typeof showStageHint === 'function') {
    if (prevTier < 1 && nextTier >= 1) setTimeout(() => showStageHint('unlock_survival'), 1200);
    if (prevTier < 2 && nextTier >= 2) setTimeout(() => showStageHint('unlock_defense'),  1800);
  }
  // Day++ on every completed match — feeds the "DAY N" chip + sets up
  // future per-day flavor missions / unlocks.
  if (typeof bumpDayNum === 'function') bumpDayNum();
  // GREY VECTOR — Cycle++ each match. The reboot loop is canon: every
  // completed match = one V-07 audit cycle archived.
  if (typeof bumpCycleNum === 'function') bumpCycleNum();
}
function bumpSurvivalWave(waveReached) {
  const s = getGlobalStats();
  if (waveReached > s.bestSurvivalWave) s.bestSurvivalWave = waveReached;
  saveGlobalStats(s);
  refreshStartStatsLine();
  if (waveReached >= 5  && typeof unlockAchievement === 'function') unlockAchievement('wave5');
  if (waveReached >= 10 && typeof unlockAchievement === 'function') unlockAchievement('wave10');
}
function refreshStartStatsLine() {
  const el = document.getElementById('startStatsLine');
  if (!el) return;
  const s = getGlobalStats();
  if (s.matchesPlayed === 0) {
    el.textContent = 'SECTOR 7G · UNIT 0451';
  } else {
    el.textContent = `已 ${s.matchesPlayed} 局 · 击杀 ${s.totalKills}` +
      (s.bestSurvivalWave > 0 ? ` · 生存最佳 W${s.bestSurvivalWave}` : '');
  }
  applyUnlockGating();
}

