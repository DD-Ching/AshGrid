// ============ ACHIEVEMENTS + DOSSIER ============
// 12 unlocks — fired by hooks scattered through the game. Each card has a
// hand-drawn SVG (no emoji — gritty military aesthetic), a numbered badge,
// localised title + description, and a progress getter that returns
// {current,total} so the modal can render "PROGRESS: 37 / 100" live.
//
// This file also includes the Operator Dossier modal, since it consumes
// ACHIEVEMENTS data + LOG_ENTRIES data + the chassis portrait SVGs — same
// "lobby info screen" concern.
//
// Extracted from index.html. Classic-script — declares the following on the
// global scope, matching the existing pattern:
//   _ICON_FIRST_BLOOD ... _ICON_DAY30 (12 SVG strings, prefixed `_ICON_`)
//   ACHIEVEMENTS (array, used by Dossier modal + match-end card)
//   getUnlockedAchievements() · _resetMatchAchievementUnlocks()
//   unlockAchievement(id) · ACHIEVEMENT_TIER_GATE (object)
//   buildAchievementsModal()
//   _dossierPortraitSvg(chassis) · buildDossierModal()
//
// External dependencies (resolved at call-time from the main script):
//   player.* / game.* / localStorage.*
//   getLang() · getDayNum() · getOperatorName() · setOperatorName()
//   getUnlockTier() · isAllUnlocked()
//   _lobby · CHASSIS · DIFF_LABELS · WPN_LABELS
//   LOG_ENTRIES (from js/operators_log.js)
//   showSwapToast(msg)

const _ICON_FIRST_BLOOD = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#1A1A1A" stroke-width="2.5"><path d="M8 8 L8 18 L18 8" /><path d="M56 8 L56 18 L46 8" /><path d="M8 56 L8 46 L18 56" /><path d="M56 56 L56 46 L46 56" /></g><path d="M32 16 C32 16 22 32 22 40 A10 10 0 0 0 42 40 C42 32 32 16 32 16 Z" fill="#C8261C" stroke="#1A1A1A" stroke-width="1.5"/></svg>`;
const _ICON_KILL_CHAIN = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g fill="#1A1A1A"><path d="M14 12 Q22 22 18 50 L22 50 Q26 22 18 12 Z"/><path d="M28 12 Q36 22 32 52 L36 52 Q40 22 32 12 Z"/><path d="M42 12 Q50 22 46 50 L50 50 Q54 22 46 12 Z"/></g></svg>`;
const _ICON_HEAT_BLOOM = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M32 8 L58 54 L6 54 Z" fill="none" stroke="#1A1A1A" stroke-width="3" stroke-linejoin="round"/><g stroke="#1A1A1A" stroke-width="2.5" stroke-linecap="round" fill="none"><path d="M22 36 Q26 32 22 28 Q18 24 22 20"/><path d="M32 38 Q36 34 32 30 Q28 26 32 22"/><path d="M42 36 Q46 32 42 28 Q38 24 42 20"/></g></svg>`;
const _ICON_BODY_COUNT = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M22 8 L42 8 L52 18 L52 56 L12 56 L12 18 Z" fill="#E8E4D8" stroke="#1A1A1A" stroke-width="2.5"/><circle cx="32" cy="14" r="2.5" fill="#1A1A1A"/><g fill="#1A1A1A"><path d="M32 26 C24 26 20 31 20 38 C20 42 22 46 26 48 L26 52 L30 52 L30 48 L34 48 L34 52 L38 52 L38 48 C42 46 44 42 44 38 C44 31 40 26 32 26 Z"/></g><g fill="#E8E4D8"><circle cx="27" cy="38" r="2.5"/><circle cx="37" cy="38" r="2.5"/><rect x="29" y="42" width="6" height="2"/></g></svg>`;
const _ICON_HOLD_LINE = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M32 6 L52 14 L52 34 Q52 48 32 58 Q12 48 12 34 L12 14 Z" fill="none" stroke="#1A1A1A" stroke-width="2.5"/><path d="M18 30 Q23 26 28 30 T38 30 T48 30" fill="none" stroke="#1A1A1A" stroke-width="2.5"/><path d="M18 38 Q23 34 28 38 T38 38 T48 38" fill="none" stroke="#1A1A1A" stroke-width="2.5"/></svg>`;
const _ICON_LAST_WALL = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M32 8 L58 54 L6 54 Z" fill="none" stroke="#1A1A1A" stroke-width="3" stroke-linejoin="round"/><path d="M14 44 Q19 40 24 44 T34 44 T44 44 T54 44" fill="none" stroke="#1A1A1A" stroke-width="2.5"/><rect x="30" y="22" width="4" height="14" fill="#1A1A1A"/><circle cx="32" cy="42" r="2.2" fill="#1A1A1A"/></svg>`;
const _ICON_FIELD_ENGINEER = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g fill="#1A1A1A"><rect x="10" y="36" width="10" height="8"/><rect x="22" y="36" width="10" height="8"/><rect x="34" y="36" width="10" height="8"/><rect x="16" y="46" width="10" height="8"/><rect x="28" y="46" width="10" height="8"/><rect x="40" y="46" width="10" height="8"/></g><g transform="translate(36 8) rotate(35)"><path d="M10 0 Q14 -4 18 0 Q22 4 18 8 L18 22 L24 28 L20 32 L14 26 L14 8 Q10 4 10 0 Z" fill="#1A1A1A"/></g></svg>`;
const _ICON_BEACON_DOWN = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#1A1A1A" stroke-width="2.5" stroke-linecap="round"><path d="M22 14 Q14 22 14 32 Q14 42 22 50"/><path d="M42 14 Q50 22 50 32 Q50 42 42 50"/><path d="M26 18 Q22 24 22 32 Q22 40 26 46"/><path d="M38 18 Q42 24 42 32 Q42 40 38 46"/></g><circle cx="32" cy="32" r="3" fill="#C8261C"/><path d="M32 32 L26 56 L38 56 Z" fill="#1A1A1A"/></svg>`;
const _ICON_ROCKET = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g transform="translate(32 32) rotate(-30)"><path d="M-22 -3 L18 -3 L26 0 L18 3 L-22 3 Z" fill="#1A1A1A"/><path d="M18 -3 L24 -6 L24 6 L18 3 Z" fill="#1A1A1A"/><circle cx="14" cy="0" r="2.5" fill="#E8E4D8"/><path d="M-22 -3 L-30 -7 L-26 0 L-30 7 L-22 3 Z" fill="#C8261C"/></g></svg>`;
const _ICON_REDLINE = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M4 32 L18 32 L22 32 L26 12 L32 52 L38 24 L42 32 L60 32" fill="none" stroke="#C8261C" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const _ICON_FULL_SPECTRUM = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="24" fill="none" stroke="#1A1A1A" stroke-width="2"/><path d="M32 12 L36 26 L50 26 L39 35 L43 49 L32 41 L21 49 L25 35 L14 26 L28 26 Z" fill="#1A1A1A"/></svg>`;
const _ICON_DAY30 = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="14" width="48" height="44" fill="#E8E4D8" stroke="#1A1A1A" stroke-width="2.5"/><rect x="8" y="14" width="48" height="10" fill="#1A1A1A"/><rect x="14" y="8" width="4" height="12" fill="#1A1A1A"/><rect x="46" y="8" width="4" height="12" fill="#1A1A1A"/><text x="32" y="48" font-family="Courier New, monospace" font-weight="900" font-size="18" text-anchor="middle" fill="#1A1A1A">D30</text></svg>`;

const ACHIEVEMENTS = [
  { id: 'first_blood',  icon: _ICON_FIRST_BLOOD, title_zh: '初戰',     title_en: 'FIRST BLOOD',
    desc_zh: '第一次擊殺敵方 NN', desc_en: 'First confirmed NN kill',
    progress: () => ({ cur: getUnlockedAchievements().has('first_blood') ? 1 : 0, tot: 1 }) },
  { id: 'killstreak3',  icon: _ICON_KILL_CHAIN, title_zh: '連殺鏈',    title_en: 'KILL CHAIN',
    desc_zh: '一場 3 連殺',       desc_en: 'Chain 3 kills in a single round',
    progress: () => ({ cur: Math.min(3, player._killStreak || 0), tot: 3 }) },
  { id: 'killstreak5',  icon: _ICON_HEAT_BLOOM, title_zh: '熱浪',      title_en: 'HEAT BLOOM',
    desc_zh: '一場 5 連殺',       desc_en: 'Chain 5 kills',
    progress: () => ({ cur: Math.min(5, player._killStreak || 0), tot: 5 }) },
  { id: 'kills_100',    icon: _ICON_BODY_COUNT, title_zh: '百人斬',    title_en: 'BODY COUNT: 100',
    desc_zh: '累計擊殺 100',      desc_en: 'Cumulative 100 kills',
    progress: () => {
      try {
        const s = JSON.parse(localStorage.getItem('ag.stats') || '{}');
        const total = (s.totalKills || 0) + (game.killCount || 0);
        return { cur: Math.min(100, total), tot: 100 };
      } catch (e) { return { cur: 0, tot: 100 }; }
    }
  },
  { id: 'wave5',        icon: _ICON_HOLD_LINE, title_zh: '守住戰線',   title_en: 'HOLD THE LINE',
    desc_zh: '生存撐過第 5 波',   desc_en: 'Hold survival to wave 5',
    progress: () => {
      try {
        const s = JSON.parse(localStorage.getItem('ag.stats') || '{}');
        return { cur: Math.min(5, s.bestSurvivalWave || 0), tot: 5 };
      } catch (e) { return { cur: 0, tot: 5 }; }
    }
  },
  { id: 'wave10',       icon: _ICON_LAST_WALL, title_zh: '最後防線',   title_en: 'LAST WALL',
    desc_zh: '生存撐過第 10 波',  desc_en: 'Hold survival to wave 10',
    progress: () => {
      try {
        const s = JSON.parse(localStorage.getItem('ag.stats') || '{}');
        return { cur: Math.min(10, s.bestSurvivalWave || 0), tot: 10 };
      } catch (e) { return { cur: 0, tot: 10 }; }
    }
  },
  { id: 'build_50',     icon: _ICON_FIELD_ENGINEER, title_zh: '工兵',     title_en: 'FIELD ENGINEER',
    desc_zh: '累計建造 50 模塊',  desc_en: 'Build 50 structures',
    progress: () => {
      try {
        return { cur: Math.min(50, parseInt(localStorage.getItem('ag.buildCount') || '0', 10)), tot: 50 };
      } catch (e) { return { cur: 0, tot: 50 }; }
    }
  },
  { id: 'beacon_kill',  icon: _ICON_BEACON_DOWN, title_zh: '信標斷源',   title_en: 'BEACON DOWN',
    desc_zh: '摧毀敵方重生點',    desc_en: 'Destroy an enemy spawn beacon',
    progress: () => ({ cur: getUnlockedAchievements().has('beacon_kill') ? 1 : 0, tot: 1 }) },
  { id: 'rocket_kill',  icon: _ICON_ROCKET, title_zh: '火箭確認',    title_en: 'ROCKET CONFIRM',
    desc_zh: '用火箭炮擊殺',      desc_en: 'Get a kill with the rocket launcher',
    progress: () => ({ cur: getUnlockedAchievements().has('rocket_kill') ? 1 : 0, tot: 1 }) },
  { id: 'survive_low',  icon: _ICON_REDLINE, title_zh: '紅線倖存者',  title_en: 'REDLINE SURVIVOR',
    desc_zh: '5HP 以下擊殺敵人',  desc_en: 'Kill an enemy at <5 HP yourself',
    progress: () => ({ cur: getUnlockedAchievements().has('survive_low') ? 1 : 0, tot: 1 }) },
  { id: 'tactical_win', icon: _ICON_FULL_SPECTRUM, title_zh: '全機型',     title_en: 'FULL SPECTRUM',
    desc_zh: '使用所有 3 種機體',  desc_en: 'Win with all 3 chassis types',
    progress: () => {
      try {
        const u = JSON.parse(localStorage.getItem('ag.chassisUsed') || '[]');
        return { cur: Math.min(3, u.length), tot: 3 };
      } catch (e) { return { cur: 0, tot: 3 }; }
    }
  },
  { id: 'day_30',       icon: _ICON_DAY30, title_zh: '半個月倖存者', title_en: 'DAY 30 SURVIVOR',
    desc_zh: '達到第 30 天',     desc_en: 'Reach Day 30',
    progress: () => ({ cur: Math.min(30, (typeof getDayNum === 'function' ? getDayNum() : 14)), tot: 30 }) },
];

function getUnlockedAchievements() {
  try { return new Set(JSON.parse(localStorage.getItem('ag.achievements') || '[]')); }
  catch (e) { return new Set(); }
}
// Per-match unlock tracker — cleared at match start, surfaced on the
// match-end result card so the player sees what they earned this round.
let _matchAchievementUnlocks = [];
function _resetMatchAchievementUnlocks() {
  _matchAchievementUnlocks = [];
  if (typeof _lastMatchUnlocks !== 'undefined') _lastMatchUnlocks = [];
}

function unlockAchievement(id) {
  const set = getUnlockedAchievements();
  if (set.has(id)) return;
  set.add(id);
  try { localStorage.setItem('ag.achievements', JSON.stringify([...set])); } catch (e) {}
  const a = ACHIEVEMENTS.find(x => x.id === id);
  if (!a) return;
  _matchAchievementUnlocks.push(a);
  // Phase 184n — fire the animated unlock CARD (js/achievement_fx.js). Silent +
  // additive; the corner toast below stays as the quiet log echo. Guarded so the
  // module being absent is a no-op.
  if (typeof _achievementFxEnqueue === 'function') _achievementFxEnqueue(a);
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const title = (lang === 'zh') ? a.title_zh : a.title_en;
  // Achievement unlock used to route through showRadioToast — that path
  // plays a 2-tone beep (1320 + 880 Hz) which is the ding-dong the user
  // has flagged FOUR TIMES now. first_blood / killstreak3 / killstreak5
  // are kill-triggered achievements, so re-arming them via ?reset=1 made
  // the kill-ding-dong come back even after the kill_confirm preset and
  // the ally-kill radio callout were both deleted. Switch to showSwapToast
  // (silent) so achievement unlocks remain VISIBLE but never SOUND.
  if (typeof showSwapToast === 'function') {
    const tag = (lang === 'zh') ? '成就解鎖' : 'ACHIEVEMENT';
    showSwapToast(`▸ ${tag} · ${title}`);
  }
}
// Achievements that depend on locked features. Hidden until the underlying
// feature unlocks — otherwise the modal lists goals the player can't even
// start working on, which reads as messy.
const ACHIEVEMENT_TIER_GATE = {
  wave5:        1,   // SURVIVAL
  wave10:       1,   // SURVIVAL
  build_50:     2,   // DEFENSE (build phase)
  beacon_kill:  2,   // DEFENSE (enemy spawn beacon)
  rocket_kill:  4,   // ROCKET weapon
  tactical_win: 4,   // HEAVY chassis
};
function buildAchievementsModal() {
  const body = document.getElementById('achvBody');
  if (!body) return;
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const unlocked = getUnlockedAchievements();
  const tier = (typeof getUnlockTier === 'function') ? getUnlockTier() : 4;
  const visible = ACHIEVEMENTS.filter(a => {
    const need = ACHIEVEMENT_TIER_GATE[a.id];
    return need == null || need <= tier || (typeof isAllUnlocked === 'function' && isAllUnlocked());
  });
  const total = visible.length, done = visible.filter(a => unlocked.has(a.id)).length;
  body.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'achv-grid-v2';
  visible.forEach((a, i) => {
    const isUnlocked = unlocked.has(a.id);
    const idx = String(i + 1).padStart(2, '0');
    const title = (lang === 'zh') ? a.title_zh : a.title_en;
    const desc  = (lang === 'zh') ? a.desc_zh  : a.desc_en;
    let prog = { cur: 0, tot: 1 };
    try { prog = a.progress(); } catch (e) {}
    const cell = document.createElement('div');
    cell.className = 'achv-card' + (isUnlocked ? ' unlocked' : ' locked');
    // 4-column layout: number badge | icon frame | title+desc+status | lock pad
    const statusHtml = isUnlocked
      ? `<div class="achv-status unlocked-mark">${(lang === 'zh') ? '✓ 已解锁' : '✓ UNLOCKED'}</div>`
      : `<div class="achv-status">${(lang === 'zh') ? '進度' : 'PROGRESS'}: ${prog.cur} / ${prog.tot}</div>`;
    cell.innerHTML = `
      <div class="achv-num">
        <div class="achv-num-big">${idx}</div>
        <div class="achv-num-pill">${isUnlocked ? ((lang === 'zh') ? '已解锁' : 'UNLOCKED') : ((lang === 'zh') ? '锁定' : 'LOCKED')}</div>
      </div>
      <div class="achv-icon-frame">${a.icon}</div>
      <div class="achv-meta">
        <div class="achv-title">${title}</div>
        <div class="achv-desc">${desc}</div>
        ${statusHtml}
      </div>
      <div class="achv-lock">${isUnlocked ? '' : '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 10 V7 a5 5 0 0 1 10 0 v3" fill="none" stroke="#6B6B6B" stroke-width="2"/><rect x="5" y="10" width="14" height="11" fill="none" stroke="#6B6B6B" stroke-width="2"/><circle cx="12" cy="15.5" r="1.5" fill="#6B6B6B"/></svg>'}</div>
    `;
    grid.appendChild(cell);
  });
  body.appendChild(grid);

  // Bottom completion strip — N filled red squares + total
  const strip = document.createElement('div');
  strip.className = 'achv-completion';
  let cells = '';
  for (let i = 0; i < total; i++) cells += `<span class="achv-pip ${i < done ? 'done' : ''}"></span>`;
  strip.innerHTML = `<span class="achv-completion-label">${(lang === 'zh') ? '戰鬥紀錄完成度' : 'COMBAT RECORD COMPLETION'}</span><span class="achv-completion-pips">${cells}</span><span class="achv-completion-count">${done} / ${total}</span>`;
  body.appendChild(strip);

  // Header counter
  document.getElementById('achvModalTitle').innerHTML =
    `<span class="achv-tag-main">${(lang === 'zh') ? '成就' : 'ACHIEVEMENTS'}</span>` +
    `<span class="achv-tag-sub">${(lang === 'zh') ? '戰鬥紀錄' : 'COMBAT RECORDS'} //</span>` +
    `<span class="achv-tag-counter"><b>${String(done).padStart(2, '0')}</b> / ${String(total).padStart(2, '0')} ${(lang === 'zh') ? '已解鎖' : 'UNLOCKED'}</span>`;
}

// Operator portrait — picks the SVG silhouette based on saved chassis.
function _dossierPortraitSvg(chassis) {
  const stroke = '#1A1A1A';
  if (chassis === 'wolf') {
    return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g fill="${stroke}"><rect x="10" y="22" width="36" height="14"/><polygon points="46,22 56,28 46,36"/><rect x="14" y="36" width="6" height="10"/><rect x="36" y="36" width="6" height="10"/></g><circle cx="48" cy="29" r="2" fill="#C8261C"/></svg>`;
  }
  if (chassis === 'heavy') {
    return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g fill="${stroke}"><rect x="14" y="14" width="36" height="36"/><rect x="8" y="14" width="6" height="22"/><rect x="50" y="14" width="6" height="22"/></g><rect x="22" y="22" width="20" height="6" fill="#C8261C"/><rect x="28" y="36" width="8" height="10" fill="#E5E0D2"/></svg>`;
  }
  // humanoid (default) — head + torso + gun barrel
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g fill="${stroke}"><circle cx="32" cy="14" r="6"/><rect x="20" y="22" width="24" height="28"/><rect x="44" y="32" width="14" height="4"/></g><rect x="28" y="32" width="8" height="4" fill="#C8261C"/></svg>`;
}

// Build the dossier modal — service-record style summary of the operator's
// stats, achievements progress, log progress, and current loadout.
function buildDossierModal() {
  const body = document.getElementById('dossierBody');
  if (!body) return;
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const dayN = (typeof getDayNum === 'function') ? getDayNum() : 14;
  // Stats
  let stats = { matchesPlayed: 0, totalKills: 0, bestSurvivalWave: 0 };
  try { stats = Object.assign(stats, JSON.parse(localStorage.getItem('ag.stats') || '{}')); } catch (e) {}
  const buildCount = parseInt(localStorage.getItem('ag.buildCount') || '0', 10) || 0;
  const chassis = (typeof _lobby !== 'undefined' && _lobby.chassis) || 'humanoid';
  const weapon  = (typeof _lobby !== 'undefined' && _lobby.weapon)  || 'RIFLE';
  const styleId = (typeof _lobby !== 'undefined' && _lobby.difficulty) || 'elite';
  const chassisLabel = (CHASSIS[chassis]?.label?.()) || chassis;
  const styleLabel  = (DIFF_LABELS && DIFF_LABELS[styleId]) || styleId;
  const wpnLabel    = (WPN_LABELS  && WPN_LABELS[weapon])   || weapon;
  // Tagline — pull the most-recent unlocked log entry's title as the
  // operator's "current state of mind" callout
  const recovered = LOG_ENTRIES.filter(e => e.day <= dayN);
  const last = recovered[recovered.length - 1] || LOG_ENTRIES[0];
  const taglineTitle = last ? ((lang === 'zh') ? last.title_zh : last.title_en) : '';
  const taglineDay   = last ? `DAY ${last.day}` : '';
  // Achievements progress — denominator drops when achievements are still
  // tier-gated, so the progress bar reads "3 / 6" instead of "3 / 12" while
  // half the achievements aren't applicable yet.
  const _achvTier = (typeof getUnlockTier === 'function') ? getUnlockTier() : 4;
  const _achvVisible = ACHIEVEMENTS.filter(a => {
    const need = ACHIEVEMENT_TIER_GATE && ACHIEVEMENT_TIER_GATE[a.id];
    return need == null || need <= _achvTier ||
           (typeof isAllUnlocked === 'function' && isAllUnlocked());
  });
  const _achvUnlocked = getUnlockedAchievements();
  const totalAchv = _achvVisible.length;
  const doneAchv  = _achvVisible.filter(a => _achvUnlocked.has(a.id)).length;
  // Log progress
  const totalLog  = LOG_ENTRIES.length;
  const recoveredLog = recovered.length;

  body.innerHTML = `
    <div class="dossier-hero">
      <div class="dossier-portrait">${_dossierPortraitSvg(chassis)}</div>
      <div>
        <div class="dossier-id">UNIT 0451 // SECTOR 7G</div>
        <div class="dossier-name" id="dossierOperatorName" title="${(lang === 'zh') ? '點擊更改代號' : 'Click to change callsign'}">${(lang === 'zh') ? '操作員 · ' : 'OPERATOR '}${getOperatorName()}</div>
        <div class="dossier-tagline">"${taglineTitle}" — ${taglineDay}</div>
        <div class="dossier-meta">
          <span><b>${(lang === 'zh') ? '機體' : 'CHASSIS'}</b>${chassisLabel}</span>
          <span><b>${(lang === 'zh') ? '武器' : 'WEAPON'}</b>${wpnLabel}</span>
          <span><b>${(lang === 'zh') ? '風格' : 'STYLE'}</b>${styleLabel}</span>
          <span><b>${(lang === 'zh') ? '日數' : 'DAYS IN LOOP'}</b>${dayN - 14}</span>
        </div>
      </div>
    </div>
    <div class="dossier-stats">
      <div class="dossier-stat accent">
        <div class="v">${stats.matchesPlayed || 0}</div>
        <div class="l">${(lang === 'zh') ? '出擊次數' : 'DEPLOYMENTS'}</div>
      </div>
      <div class="dossier-stat">
        <div class="v">${stats.totalKills || 0}</div>
        <div class="l">${(lang === 'zh') ? '累計擊殺' : 'CONFIRMED KILLS'}</div>
      </div>
      <div class="dossier-stat">
        <div class="v">${stats.bestSurvivalWave || 0}</div>
        <div class="l">${(lang === 'zh') ? '最深波次' : 'DEEPEST WAVE'}</div>
      </div>
      <div class="dossier-stat">
        <div class="v">${buildCount}</div>
        <div class="l">${(lang === 'zh') ? '建造模塊' : 'MODULES BUILT'}</div>
      </div>
    </div>
    <div class="dossier-progress">
      <div class="dossier-progress-row">
        <div class="dossier-progress-label">${(lang === 'zh') ? '戰鬥紀錄' : 'COMBAT RECORDS'}</div>
        <div class="dossier-progress-bar"><div class="dossier-progress-fill" style="width: ${(doneAchv / totalAchv * 100).toFixed(0)}%"></div></div>
        <div class="dossier-progress-count">${String(doneAchv).padStart(2, '0')} / ${String(totalAchv).padStart(2, '0')}</div>
      </div>
      <div class="dossier-progress-row">
        <div class="dossier-progress-label">${(lang === 'zh') ? '解密日誌' : 'LOG RECOVERED'}</div>
        <div class="dossier-progress-bar"><div class="dossier-progress-fill" style="width: ${(recoveredLog / totalLog * 100).toFixed(0)}%"></div></div>
        <div class="dossier-progress-count">${String(recoveredLog).padStart(2, '0')} / ${String(totalLog).padStart(2, '0')}</div>
      </div>
    </div>
  `;
  document.getElementById('dossierModalTitle').innerHTML =
    `<span class="achv-tag-main">${(lang === 'zh') ? '操作員檔案' : 'OPERATOR DOSSIER'}</span>` +
    `<span class="achv-tag-sub">${(lang === 'zh') ? '服役紀錄' : 'SERVICE RECORD'} //</span>` +
    `<span class="achv-tag-counter">DAY <b>${dayN}</b></span>`;
  const nameEl = document.getElementById('dossierOperatorName');
  if (nameEl) {
    nameEl.style.cursor = 'pointer';
    nameEl.onclick = () => {
      const cur = getOperatorName();
      const next = window.prompt(
        (lang === 'zh') ? '輸入新代號 (字母/數字 ≤12)' : 'New callsign (A–Z 0–9, ≤12)',
        cur
      );
      if (next != null) {
        setOperatorName(next);
        buildDossierModal();
      }
    };
  }
}
