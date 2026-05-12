// ============ STAGE HINTS ============
// Per-feature one-shot hints. Each fires on a specific gameplay event
// the first time it happens, then never again (tracked in
// ag.hintsSeen). Distinct from the time-based first-match radio
// chatter — these are tied to what the player actually did, so the
// right tip surfaces at the right moment instead of on a fixed timer.
//
// Adding a new hint = add a STAGE_HINTS row + showStageHint('id') call
// from the event site (kill / build / damage / etc.).
//
// Classic-script. Declares globally:
//   STAGE_HINTS (table) · _hintsSeen() · _markHintSeen(id)
//   showStageHint(id)
//
// External deps: localStorage · getLang · showRadioToast · showSwapToast

function _hintsSeen() {
  try { return new Set(JSON.parse(localStorage.getItem('ag.hintsSeen') || '[]')); }
  catch (e) { return new Set(); }
}
function _markHintSeen(id) {
  const s = _hintsSeen();
  s.add(id);
  try { localStorage.setItem('ag.hintsSeen', JSON.stringify([...s])); } catch (e) {}
}
const STAGE_HINTS = {
  basic_controls:  { zh: 'WASD 移動 · 按住滑鼠射擊 · R 換彈',
                     en: 'WASD move · hold mouse to fire · R reload' },
  swap_weapon:     { zh: '✓ 首擊 — 按 X 切換主/副武器',
                     en: '✓ FIRST KILL — Press X to swap primary/secondary' },
  low_hp:          { zh: '血量低 — 找掩體、R 換彈',
                     en: 'Low HP — find cover, hold R to reload' },
  pawn_swap:       { zh: '隊友倒下 — 按 1-4 接管最近的隊友身體',
                     en: 'Ally down — press 1-4 to take over their body' },
  tab_command:     { zh: 'TAB 進指揮視角 · 1-7 下令(集合/進攻/壓制…)',
                     en: 'TAB → command view · 1-7 issue orders (rally/attack/suppress…)' },
  build_mode:      { zh: 'B 開建造輪盤 · 16 模塊邊建邊打',
                     en: 'B opens the build radial · 16 modules to plant on the fly' },
  rocket_walls:    { zh: '火箭炮可炸開牆體 · 強行開路',
                     en: 'Rocket destroys walls — punch your own corridor' },
  unlock_survival: { zh: '★ 解鎖 SURVIVAL — 守住每一波,隊友死了不復活',
                     en: '★ SURVIVAL unlocked — hold waves, teammates stay dead' },
  unlock_defense:  { zh: '★ 解鎖 DEFENSE — 邊建造邊抵禦,16 模塊任選',
                     en: '★ DEFENSE unlocked — build while you fight, 16 modules' },
  build_now:       { zh: '⚡ 200 能源備用 · 按 B 蓋砲塔/牆守住中繼',
                     en: '⚡ 200⚡ to spend — press B to build turrets / walls' },
};
function showStageHint(id) {
  const def = STAGE_HINTS[id];
  if (!def) return;
  if (_hintsSeen().has(id)) return;
  _markHintSeen(id);
  const lang = (typeof getLang === 'function' && getLang() === 'zh') ? 'zh' : 'en';
  if (typeof showRadioToast === 'function') showRadioToast('TIP', def[lang] || def.en);
  else if (typeof showSwapToast === 'function') showSwapToast(def[lang] || def.en);
}
