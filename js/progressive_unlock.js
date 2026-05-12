// ============ PROGRESSIVE UNLOCK ============
// Tier-based feature unlocks driven by matches played. Each tier reveals
// new lobby options (SURVIVAL/DEFENSE/CHASSIS/etc.) when the count crosses
// a threshold. ag.unlockAll skips the gating entirely.
//
// Classic-script. Declares globally:
//   UNLOCK_TIERS (table) · CHASSIS_UNLOCK_TIER · WEAPON_UNLOCK_TIER
//   getUnlockTier() · isAllUnlocked() · setUnlockAll(on)
//   applyUnlockGating()
//
// External deps: localStorage · document · getGlobalStats ·
//   buildAchievementsModal · refreshLogBadge · T · getLang

// Hide modes / features the player hasn't earned yet. The goal is a clean
// first-launch surface: only DEATHMATCH visible. Each finished match steps
// the tier up, revealing the next mode bucket. Power-users hit "skip" in
// the intro to set ag.unlockAll=1 and bypass gating entirely.
const MODE_UNLOCK_TIER = {
  dm: 0,         // always
  survival: 1,   // after first match
  defense:  2,   // after 3 matches
  helo:     3,   // after 5 matches
  convoy:   3,   // after 5 matches
  duel:     4,   // after 7 matches
  sniper:   4,   // after 7 matches
};
const STYLE_UNLOCK_TIER = {
  elite: 0, warrior: 1, defensive: 2, sharpshooter: 3, cqb: 3, tactical: 4,
};
const WEAPON_UNLOCK_TIER = {
  RIFLE: 0, SMG: 1, SHOTGUN: 2, LMG: 3, SNIPER: 3, ROCKET: 4,
};
const CHASSIS_UNLOCK_TIER = {
  humanoid: 0, wolf: 2, heavy: 4,
};
const TIER_THRESHOLDS = [0, 1, 3, 5, 7];   // matchesPlayed needed for tiers 0-4
const NEXT_UNLOCK_LABEL = {
  1: { zh: '生存', en: 'SURVIVAL' },
  2: { zh: '防御', en: 'DEFENSE' },
  3: { zh: '撤离 + 护送', en: 'HELO + CONVOY' },
  4: { zh: '单挑 + 狙击', en: 'DUEL + SNIPER' },
};
// Default: everything unlocked. The progressive tutorial-style gating
// is opt-IN via ag.unlockAll === '0'. This was opt-OUT originally
// ('not set' = gated) but in practice that hid too much for veteran
// players who'd cleared their state.
function isAllUnlocked() {
  try { return localStorage.getItem('ag.unlockAll') !== '0'; } catch (e) { return true; }
}
function setUnlockAll(val) {
  try {
    if (val) localStorage.setItem('ag.unlockAll', '1');
    else     localStorage.setItem('ag.unlockAll', '0');   // explicit opt-IN to gating
  } catch (e) {}
  applyUnlockGating();
}
function getUnlockTier() {
  if (isAllUnlocked()) return TIER_THRESHOLDS.length - 1;
  const played = getGlobalStats().matchesPlayed | 0;
  let tier = 0;
  for (let i = 0; i < TIER_THRESHOLDS.length; i++) {
    if (played >= TIER_THRESHOLDS[i]) tier = i;
  }
  return tier;
}
function isModeUnlocked(mode) {
  if (isAllUnlocked()) return true;
  const tier = MODE_UNLOCK_TIER[mode];
  return tier == null || tier <= getUnlockTier();
}
function _isItemUnlocked(table, key) {
  if (isAllUnlocked()) return true;
  const tier = table[key];
  return tier == null || tier <= getUnlockTier();
}
function applyUnlockGating() {
  const tier = getUnlockTier();
  // If the persisted lobby pick is now gated, fall back to dm so the picker
  // doesn't open with no visible "active" highlight.
  if (typeof _lobby !== 'undefined' && !isModeUnlocked(_lobby.mode)) {
    _lobby.mode = 'dm';
  }
  // The lobby info-strip used to live here as 7 .mission cards; the
  // refactored two-card hero (SKIRMISH / CAMPAIGN) drops it. Mode-tier
  // gating still applies inside the COMBAT SETUP picker below.
  // COMBAT SETUP picker mode buttons
  document.querySelectorAll('#nnLobby [data-mode]').forEach(btn => {
    btn.style.display = isModeUnlocked(btn.dataset.mode) ? '' : 'none';
  });
  // STYLE / WEAPON / CHASSIS — same progressive reveal so first-match
  // setup is just (DM × ELITE × RIFLE × HUMAN). Snap saved picks back to
  // the default if the persisted choice is now gated.
  if (typeof _lobby !== 'undefined') {
    if (!_isItemUnlocked(STYLE_UNLOCK_TIER,   _lobby.difficulty)) _lobby.difficulty = 'elite';
    if (!_isItemUnlocked(WEAPON_UNLOCK_TIER,  _lobby.weapon))     _lobby.weapon     = 'RIFLE';
    if (!_isItemUnlocked(CHASSIS_UNLOCK_TIER, _lobby.chassis))    _lobby.chassis    = 'humanoid';
  }
  document.querySelectorAll('#nnLobby [data-diff]').forEach(btn => {
    btn.style.display = _isItemUnlocked(STYLE_UNLOCK_TIER, btn.dataset.diff) ? '' : 'none';
  });
  document.querySelectorAll('#nnLobby [data-weapon]').forEach(btn => {
    btn.style.display = _isItemUnlocked(WEAPON_UNLOCK_TIER, btn.dataset.weapon) ? '' : 'none';
  });
  document.querySelectorAll('#nnLobby [data-chassis]').forEach(btn => {
    btn.style.display = _isItemUnlocked(CHASSIS_UNLOCK_TIER, btn.dataset.chassis) ? '' : 'none';
  });
  // First-launch tutorial card: hide the pawn-swap row at tier 0. Default
  // tier-0 lineup is blue=1 vs red=3, so there's nobody to swap to and the
  // row reads as confusing fluff. Reappears once SURVIVAL (which guarantees
  // teammates) unlocks at tier 1.
  const pawnRow = document.getElementById('tutorialPawnSwapRow');
  if (pawnRow) pawnRow.style.display = (tier >= 1 || isAllUnlocked()) ? '' : 'none';
  // Map editor — gate to tier 4 (advanced)
  const editorBtn = document.getElementById('editorBtn');
  if (editorBtn) editorBtn.style.display = (tier >= 4 || isAllUnlocked()) ? '' : 'none';
  // Campaign — gate to tier 1 so the first match teaches the basics in DM
  // before exposing the structured story-mission flow.
  const campaignBtn = document.getElementById('campaignBtn');
  if (campaignBtn) campaignBtn.style.display = (tier >= 1 || isAllUnlocked()) ? '' : 'none';
  // "Next unlock" hint chip + "skip" button
  const hint = document.getElementById('nextUnlockHint');
  const skipBtn = document.getElementById('unlockAllBtn');
  const next = tier + 1;
  const allDone = isAllUnlocked() || next >= TIER_THRESHOLDS.length;
  if (hint) {
    if (allDone) {
      hint.style.display = 'none';
    } else {
      const need = TIER_THRESHOLDS[next] - (getGlobalStats().matchesPlayed | 0);
      const label = NEXT_UNLOCK_LABEL[next];
      const lang = (typeof getLang === 'function' && getLang() === 'zh') ? 'zh' : 'en';
      hint.style.display = '';
      hint.textContent = (lang === 'zh')
        ? `下一個解鎖: ${label.zh} · 再 ${need} 局`
        : `NEXT UNLOCK: ${label.en} · ${need} more match${need === 1 ? '' : 'es'}`;
    }
  }
  if (skipBtn) skipBtn.style.display = allDone ? 'none' : '';
}
// Initial render once DOM is ready (this script runs at end of body so it's safe)
if (typeof document !== 'undefined') refreshStartStatsLine();

