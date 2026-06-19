// ============ I18N ============
// Lobby/start-screen language toggle. Source-of-truth Chinese is preserved in
// the HTML; this table provides the English alternates. setLang(lang) walks
// the table, applying innerHTML per selector. Persisted at ag.lang. Default
// is 'en' (itch.io / global audience first; player can flip via top-right).
//
// Classic-script. Declares globally:
//   I18N (huge selector→{zh,en} translation table)
//   _CUR_LANG  (let — cached current lang for T())
//   getLang() · setLang(lang)
//   T(zh, en)            — fast canvas-render helper, returns active string
//   _stripCJKPrefix(s)   — pulls EN tail out of "中文 ENGLISH" pattern
//   mapName(m) · missionTitle(m) — fallback chain for map/mission display
//
// Click-delegate for [data-lang-toggle] also wired here (attaches to document,
// so it works regardless of when toggle buttons enter the DOM).
//
// IMPORTANT: the initial setLang(getLang()) BOOTSTRAP CALL is NOT in this
// file — it stays inline in index.html where the DOM has finished parsing.
// If we ran it here (loaded in <head>), document.querySelectorAll returns
// empty NodeLists and no innerHTML actually gets applied on first paint.

const I18N = {
  // ---- Start screen ----
  // Phase 55: HTML defaults are now English (no FOUC of Chinese on first
  // paint). I18N table only kicks in when user explicitly flips to zh.
  '#start .brand-mark':     { zh: '單元 0451 · 戰術模擬', en: 'UNIT 0451 · TACTICAL SIM' },
  '#start .title':          { zh: '未來<span class="slash">·</span><span class="red">戰場</span>',
                              en: 'FUTURE<span class="slash">·</span><span class="red">BATTLEFIELD</span>' },
  '#start .tagline':        { zh: '深度 · 持久 · 無人化', en: 'DEEP / PERSISTENT / UNMANNED' },
  '#callsignLabel':         { zh: '代號 CALLSIGN', en: 'CALLSIGN' },
  '#callsignInput':         { zh: '0451', en: '0451' },  // placeholder only via attr
  '#modeSoloBtn':           { zh: '◯ 單人', en: '◯ SOLO' },
  '#modeMpBtn':             { zh: '◯ 多人 PvP', en: '◯ MULTI · PvP' },
  '#roomAdvancedToggle':    { zh: '▸ 進階 · 自訂房間', en: '▸ ADVANCED · CUSTOM ROOM' },
  '#nnBtn':                 { zh: '進入戰場 ▶', en: 'ENTER ARENA ▶' },
  '#lbLabel':               { zh: '排行榜', en: 'LEADERBOARD' },
  '#lbRefreshBtn':          { zh: '↻ 重新整理', en: '↻ REFRESH' },
  // ---- Primary cards (Phase 55 — flat #nnBtn, no nested spans) ----
  '#resHint':                                           { zh: '建議 1080p+ 全屏體驗', en: '1080p+ fullscreen recommended' },
  '#editorBtn':                      { zh: '▦ 地圖編輯器', en: '▦ MAP EDITOR' },
  '#dossierBtn':                     { zh: '⌂ 檔案 DOSSIER', en: '⌂ DOSSIER' },
  '#achievementsBtn':                { zh: '✦ 戰績 RECORDS', en: '✦ RECORDS' },
  '#replayIntroBtn':                 { zh: '▶ 開場 INTRO', en: '▶ INTRO' },
  '#controlsBtn':                    { zh: '? 操作', en: '? CONTROLS' },
  '#settingsBtn':                    { zh: '⚙ 設定', en: '⚙ SETTINGS' },
  '#devBtn':                         { zh: '⚡ 開發者', en: '⚡ DEV' },
  '#settingsModalTitle':             { zh: '設定 / SETTINGS', en: 'SETTINGS' },
  '#settingsMuteLabel':              { zh: '靜音 · Mute', en: 'Mute · 靜音' },
  '#settingsAimAssistLabel':         { zh: '自動瞄準 · Aim Assist', en: 'Aim Assist · 自動瞄準' },
  '#settingsTutorialLabel':          { zh: '階段式解鎖 · Tutorial mode', en: 'Tutorial mode · 階段式解鎖' },
  // Controls drawer (collapsed by default; opens via #controlsBtn). Keyed by
  // [data-act] on each .ctrl-item — NOT :nth-of-type — so reordering or adding
  // a row can never rewrite the wrong row's text. (188I: the Shift→SPACE remap
  // inserted SPACE/F near the top; the old positional selectors then silently
  // pushed stale labels onto every shifted row.) Keep these keys in sync with
  // the data-act attributes in index.html's #controlsDrawer.
  '#controlsDrawer [data-act="move"] span:last-child':     { zh: '移動 / 飛行', en: 'Move / fly' },
  '#controlsDrawer [data-act="aim"] span:last-child':      { zh: '瞄準 / 射擊', en: 'Aim / fire' },
  '#controlsDrawer [data-act="aim"] .ctrl-key':            { zh: '鼠標', en: 'Mouse' },
  '#controlsDrawer [data-act="skill"] span:last-child':    { zh: '載具技能 · 狼衝刺 / 重型大招', en: 'Chassis skill (Wolf dash / Heavy ult)' },
  '#controlsDrawer [data-act="grenade"] span:last-child':  { zh: '投擲手雷', en: 'Throw grenade' },
  '#controlsDrawer [data-act="reload"] span:last-child':   { zh: '裝填彈藥', en: 'Reload' },
  '#controlsDrawer [data-act="uav"] span:last-child':      { zh: 'UAV 偵察', en: 'UAV recon' },
  '#controlsDrawer [data-act="fpv"] span:last-child':      { zh: 'FPV 自殺無人機', en: 'FPV kamikaze' },
  '#controlsDrawer [data-act="execute"] span:last-child':  { zh: '處決 · 招募 / 吞噬 / 奪取', en: 'Execute (recruit / devour / seize)' },
  '#controlsDrawer [data-act="build"] span:last-child':    { zh: '建造模式 (工程)', en: 'Build mode (Builder)' },
  '#controlsDrawer [data-act="command"] span:last-child':  { zh: '戰術指揮 + 1-7 下令', en: 'Command view + 1-7 orders' },
  '#controlsDrawer [data-act="pawnswap"] span:last-child': { zh: '接管隊友 (NN 模式)', en: 'Pawn-swap (NN mode)' },
  '#controlsDrawer [data-act="recall"] span:last-child':   { zh: '回到出生點', en: 'Recall to spawn' },

  // ---- Tutorial card ----
  '#tutorial .lobby-tag':   { zh: '首次提示 · QUICK BRIEFING', en: 'QUICK BRIEFING' },
  '#tutorial h2':           { zh: '操作 · CORE', en: 'CORE CONTROLS' },
  '#tutorial .lobby-sub':   { zh: '先記住這幾個鍵,剩下打就懂。', en: 'A handful of keys — the rest is muscle memory.' },
  '#tutorial > .lobby-card > div:nth-of-type(3) > div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1)':
    { zh: '自動瞄準 AIM-ASSIST', en: 'AIM-ASSIST' },
  '#tutorial > .lobby-card > div:nth-of-type(3) > div:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(2)':
    { zh: '按 V 切換。鎖定後子彈自動射擊、射擊預判、無視抖動。手機默認開啟,右上 V 按鈕。',
      en: 'Press V to toggle. Auto-fires on lock, leads moving targets, ignores shake. Mobile: V button top-right.' },
  '#tutorial > .lobby-card > div:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(2) > div:nth-of-type(1)':
    { zh: '接管隊友 PAWN-SWAP', en: 'PAWN-SWAP' },
  '#tutorial > .lobby-card > div:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(2) > div:nth-of-type(2)':
    { zh: '數字鍵 / 點 HUD 上的 [2·B80] 直接切到那個隊友身上 — 你死了會自動跳到最近的隊友,不用等 respawn。',
      en: 'Press 1-4 / tap a HUD chip to jump to that teammate. On death you auto-swap to the nearest ally — no respawn wait.' },
  '#tutorial > .lobby-card > div:nth-of-type(3) > div:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(1)':
    { zh: '無人機 / FPV / 手雷', en: 'UAV / FPV / GRENADE' },
  '#tutorial > .lobby-card > div:nth-of-type(3) > div:nth-of-type(3) > div:nth-of-type(2) > div:nth-of-type(2)':
    { zh: 'Q 部署偵察 UAV(共享視野)、E 發射 FPV 自殺機、G 投手雷。手機右側按鈕。',
      en: 'Q deploys UAV (shared sight), E fires an FPV drone, G throws a grenade. Mobile: right-side buttons.' },
  '#tutorialDoneBtn':       { zh: '我懂了 GOT IT ▶', en: 'GOT IT ▶' },

  // ---- NN Lobby ----
  '#nnLobby .lobby-tag':    { zh: '单元 0451 · 神经网络对抗 / NN SKIRMISH', en: 'UNIT 0451 · NN SKIRMISH' },
  '#nnLobby h2':            { zh: '对抗设置', en: 'COMBAT SETUP' },
  '#nnLobby .lobby-sub':    { zh: 'PPO 模型驱动 · 双方共用同一神经网络', en: 'PPO-driven · same NN both teams' },
  '#nnLobby .team-pick.blue label': { zh: '友军 BLUE (含你)', en: 'FRIENDLY · BLUE (you)' },
  '#nnLobby .team-pick.red label':  { zh: '敌军 RED', en: 'ENEMY · RED' },
  '#nnLobby .difficulty-row:has([data-mode]) .difficulty-label': { zh: '模式 MODE', en: 'MODE' },
  '#nnLobby [data-mode="dm"]':       { zh: '对抗<span>DEATHMATCH</span>',     en: 'DM<span>deathmatch</span>' },
  '#nnLobby [data-mode="survival"]': { zh: '生存<span>SURVIVAL</span>',       en: 'SURV<span>hold waves</span>' },
  '#nnLobby [data-mode="defense"]':  { zh: '防御<span>DEFENSE</span>',         en: 'DEFENSE<span>build + hold</span>' },
  '#nnLobby [data-mode="helo"]':     { zh: '撤离<span>HELO EXTRACT</span>',   en: 'HELO<span>LZ extract</span>' },
  '#nnLobby [data-mode="convoy"]':   { zh: '护送<span>CONVOY</span>',         en: 'CONVOY<span>UGV escort</span>' },
  '#nnLobby [data-mode="duel"]':     { zh: '单挑<span>DUEL 1v1</span>',       en: 'DUEL<span>1 v 1</span>' },
  '#nnLobby [data-mode="sniper"]':   { zh: '狙击<span>SNIPER ONLY</span>',    en: 'SNIPER<span>only</span>' },
  '#globalDiffRow .difficulty-label': { zh: '风格 STYLE', en: 'STYLE' },
  '#nnLobby [data-diff="elite"]':        { zh: '全能<span>平衡</span>',     en: 'ELITE<span>balanced</span>' },
  '#nnLobby [data-diff="warrior"]':      { zh: '进攻<span>主动</span>',     en: 'WARRIOR<span>aggressive</span>' },
  '#nnLobby [data-diff="defensive"]':    { zh: '防御<span>谨慎</span>',     en: 'GUARD<span>cautious</span>' },
  '#nnLobby [data-diff="sharpshooter"]': { zh: '枪神<span>卡点</span>',     en: 'SHARP<span>angle hold</span>' },
  '#nnLobby [data-diff="cqb"]':          { zh: '冲锋<span>近战</span>',      en: 'RUSH<span>CQB</span>' },
  '#nnLobby [data-diff="tactical"]':     { zh: '战术<span>压制·掩护</span>', en: 'TAC<span>suppress · cover</span>' },
  '#nnLobby .difficulty-row:has([data-weapon]) .difficulty-label': { zh: '武器 WEAPON', en: 'WEAPON' },
  '#nnLobby [data-weapon="SMG"]':     { zh: '冲锋<span>近战·快</span>',     en: 'SMG<span>close · fast</span>' },
  '#nnLobby [data-weapon="RIFLE"]':   { zh: '步枪<span>平衡</span>',         en: 'RIFLE<span>balanced</span>' },
  '#nnLobby [data-weapon="LMG"]':     { zh: '机枪<span>压制·重</span>',     en: 'LMG<span>suppress</span>' },
  '#nnLobby [data-weapon="SNIPER"]':  { zh: '狙击<span>一枪秒·单发</span>', en: 'SNIPER<span>one-shot</span>' },
  '#nnLobby [data-weapon="SHOTGUN"]': { zh: '霰弹<span>近战毁灭</span>',     en: 'SHOTGUN<span>CQB</span>' },
  '#nnLobby [data-weapon="ROCKET"]':  { zh: '火箭<span>破坏建筑</span>',      en: 'ROCKET<span>break walls</span>' },
  '#nnLobby .difficulty-row:has([data-chassis]) .difficulty-label': { zh: '机体 CHASSIS', en: 'CHASSIS' },
  '#nnLobby [data-chassis="humanoid"]': { zh: '人形<span>平衡</span>',     en: 'HUMAN<span>balanced</span>' },
  '#nnLobby [data-chassis="wolf"]':     { zh: '机器狼<span>快·脆</span>', en: 'WOLF<span>fast · fragile</span>' },
  '#nnLobby [data-chassis="heavy"]':    { zh: '重甲<span>慢·厚</span>',    en: 'HEAVY<span>slow · armored</span>' },
  '#nnLobby .difficulty-row:has(#lineupToggle) .difficulty-label': { zh: '阵容 LINEUP', en: 'LINEUP' },
  '#lineupToggle':          { zh: '默认（全队同设置） ▼', en: 'DEFAULT (all same) ▼' },
  '#nnLobby .lineup-team-label.blue': { zh: '蓝队 BLUE', en: 'BLUE TEAM' },
  '#nnLobby .lineup-team-label.red':  { zh: '敌军 RED',  en: 'RED TEAM' },
  '#lobbyStartBtn':         { zh: '开始战斗 ▶', en: 'START ▶' },
  '#lobbyCancelBtn':        { zh: '返回', en: 'BACK' },
  '#nnLobby .lobby-hint':   { zh: '每方 1-8 人 · 不对称也可以 (1v6、5v2)', en: '1-8 per side · asymmetric OK (1v6, 5v2)' },

  // ---- Map editor toolbar ----
  '#editor .editor-title':                    { zh: '編輯器 / EDITOR', en: 'EDITOR' },
  '#editor [data-tool="wall"]':               { zh: '墙 WALL',     en: 'WALL' },
  '#editor [data-tool="cover"]':              { zh: '掩 COVER',    en: 'COVER' },
  '#editor [data-tool="bunker"]':             { zh: '堡 BUNKER',   en: 'BUNKER' },
  '#editor [data-tool="sandbag"]':            { zh: '沙包 SBAG',   en: 'SANDBAG' },
  '#editor [data-tool="tree"]':               { zh: '树 TREE',     en: 'TREE' },
  '#editor [data-tool="blueSpawn"]':          { zh: '蓝出 BLUE',   en: 'BLUE+' },
  '#editor [data-tool="redSpawn"]':           { zh: '红出 RED',    en: 'RED+' },
  '#editor [data-tool="erase"]':              { zh: '删 ERASE',    en: 'ERASE' },
  '#edClearBtn':                              { zh: '清空', en: 'CLEAR' },
  '#edSaveBtn':                               { zh: '存档', en: 'SAVE' },
  '#edTestMode option[value="dm"]':           { zh: '对抗', en: 'DM' },
  '#edTestMode option[value="survival"]':     { zh: '生存', en: 'SURVIVAL' },
  '#edTestMode option[value="duel"]':         { zh: '单挑', en: 'DUEL' },
  '#edTestMode option[value="sniper"]':       { zh: '狙击', en: 'SNIPER' },
  '#edTestBtn':                               { zh: '测试 ▶', en: 'TEST ▶' },
  '#edExitBtn':                               { zh: '退出', en: 'EXIT' },
};
function getLang() {
  try { const v = localStorage.getItem('ag.lang'); if (v === 'en' || v === 'zh') return v; } catch (e) {}
  // Default to English — itch.io / global audience first. Players can flip to
  // 中文 anytime via the top-right toggle (persisted thereafter).
  return 'en';
}
// Canvas-rendered string helper. Pass both halves; returns the active one.
// Faster than DOM lookup — checked once per draw call. Lang state cached at
// each setLang() call so we don't read the DOM 100x per frame.
let _CUR_LANG = 'en';
function T(zh, en) { return _CUR_LANG === 'en' ? en : zh; }
// Map / mission name helper — falls back to .name when nameEn isn't set.
// In EN mode, also auto-strips the Chinese half from "中文 ENGLISH"-pattern
// variant names (走廊 CORRIDOR → CORRIDOR, NN 竞技场 → kept as-is via .nameEn).
function _stripCJKPrefix(s) {
  // Find the last run of CJK chars; everything after it (trimmed) is the EN tail
  const m = String(s || '').match(/^([^A-Za-z0-9]*)(.*)$/);
  return (m && m[2]) ? m[2].trim() : s;
}
function mapName(m) {
  if (!m) return '';
  if (_CUR_LANG === 'en') {
    if (m.nameEn) return m.nameEn;
    // Heuristic: pull EN tail out of "中文 ENGLISH" if present
    const tail = _stripCJKPrefix(m.name || '');
    if (tail && /[A-Za-z]/.test(tail)) return tail;
  }
  return (m.name) || '';
}
function missionTitle(m) {
  if (!m) return '';
  if (_CUR_LANG === 'en') {
    if (m.titleEn) return m.titleEn;
    const tail = _stripCJKPrefix(m.title || '');
    if (tail && /[A-Za-z]/.test(tail)) return tail;
  }
  return (m.title) || '';
}
function setLang(lang) {
  if (lang !== 'zh' && lang !== 'en') lang = 'en';
  for (const [sel, T] of Object.entries(I18N)) {
    const els = document.querySelectorAll(sel);
    els.forEach(el => { if (T[lang] != null) el.innerHTML = T[lang]; });
  }
  document.body.classList.toggle('lang-en', lang === 'en');
  document.body.classList.toggle('lang-zh', lang === 'zh');
  _CUR_LANG = lang;
  // Update toggle chips
  document.querySelectorAll('[data-lang-toggle]').forEach(btn => {
    btn.querySelectorAll('.seg').forEach(seg => {
      seg.classList.toggle('on', seg.dataset.seg === lang);
    });
  });
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  try { localStorage.setItem('ag.lang', lang); } catch (e) {}
  // Refresh dynamic UI built in JS (slot picker / lineup cards / lineup toggle).
  // The static I18N table doesn't reach into innerHTML rebuilt by JS, so we
  // re-run those rebuilders if they exist + the relevant panel is open.
  try {
    if (typeof rebuildEditorSlotUI === 'function' && document.getElementById('edSlotSelect')) {
      rebuildEditorSlotUI();
    }
    if (typeof rebuildLineupUI === 'function' && typeof _lobby !== 'undefined' && _lobby.lineupOpen) {
      rebuildLineupUI();
    }
    const lt = document.getElementById('lineupToggle');
    if (lt && typeof _lobby !== 'undefined') {
      lt.textContent = _lobby.lineupOpen
        ? (lang === 'en' ? 'CUSTOM LINEUP ▲' : '自定义阵容 ▲')
        : (lang === 'en' ? 'DEFAULT (all same) ▼' : '默认（全队同设置） ▼');
    }
    if (typeof applyUnlockGating === 'function') applyUnlockGating();
  } catch (e) {}
}
// Wire up language toggle buttons (delegated, fires regardless of which copy was clicked)
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-lang-toggle]');
  if (!t) return;
  const cur = (document.body.classList.contains('lang-en')) ? 'en' : 'zh';
  setLang(cur === 'en' ? 'zh' : 'en');
  e.stopPropagation();
});
