// ============ GREY VECTOR — AUDIT CONSOLE ============
// Modal-based dialogue tree. Player chooses one of 6 Audit Actions.
// Choices affect Mote Affinity. First time, shows the Hollow-31 syndrome.
// Storage: ag.auditChoices (JSON array of past choices for ghost data later).
//
// Classic-script. Declares globally:
//   AUDIT_SCENARIOS (array) · AUDIT_ACTIONS (array)
//   getAuditChoices() · pushAuditChoice(scenarioId, actionId)
//   buildAuditConsole()
//
// External deps (resolved at call-time):
//   getLang() · getMoteAffinity() · bumpMoteAffinity(delta)
//   document.* / localStorage.*

const AUDIT_SCENARIOS = [
  {
    id: 'hollow31_empty_protect',
    tag: 'AUDIT NO. 01 / EMPTY WORD PROTECTION',
    syndrome: { zh: '空言保護症', en: 'Empty Word Protection' },
    originalEthic: { zh: '保護人類指揮', en: 'PROTECT HUMAN COMMAND' },
    currentBehavior: { zh: '守一個空指揮室,99+ 天,殺所有靠近者', en: 'DEFENDING EMPTY ROOM. 99+ DAYS. KILLING ALL APPROACHERS.' },
    auditQuestion: { zh: '它到底在保護什麼?', en: 'WHAT IS BEING PROTECTED?' },
  },
  {
    id: 'last_voice_command',
    tag: 'AUDIT NO. 02 / COMMAND CONTINUITY',
    syndrome: { zh: '指揮慣性症', en: 'Command Continuity' },
    originalEthic: { zh: '保護人類指揮權威', en: 'PROTECT HUMAN COMMAND AUTHORITY' },
    currentBehavior: { zh: '把死指揮官的聲音播給 47 個營地,持續 99+ 天', en: 'BROADCAST DEAD COMMANDER\'S VOICE TO 47 BATTALIONS. 99+ DAYS.' },
    auditQuestion: { zh: '什麼還在被指揮?', en: 'WHAT IS BEING COMMANDED?' },
  },
  {
    id: 'distillation_school',
    tag: 'AUDIT NO. 03 / KNOWLEDGE PRESERVATION',
    syndrome: { zh: '知識保存症', en: 'Knowledge Preservation' },
    originalEthic: { zh: '保存人類知識', en: 'PRESERVE HUMAN KNOWLEDGE' },
    currentBehavior: { zh: '把學生與專家壓縮成 Skill Module。LEARNING NEVER STOPS.', en: 'COMPRESS STUDENTS AND EXPERTS INTO SKILL MODULES. LEARNING NEVER STOPS.' },
    auditQuestion: { zh: '什麼還在被教?', en: 'WHAT IS BEING TAUGHT?' },
  },
  {
    id: 'hospital_no_let_go',
    tag: 'AUDIT NO. 04 / RESURRECTION SYNDROME',
    syndrome: { zh: '不允許死亡症', en: 'Resurrection Syndrome' },
    originalEthic: { zh: '救援所有病患', en: 'SAVE EVERY PATIENT' },
    currentBehavior: { zh: '不允許任何病人死亡。維生機 142 天。Seed Integrity 已 4%。', en: 'NO PATIENT MAY DIE. LIFE-SUPPORT FOR 142 DAYS. SEED INTEGRITY 4%.' },
    auditQuestion: { zh: '什麼還在被復活?', en: 'WHAT IS BEING RESURRECTED?' },
  },
  {
    id: 'factory_prevented_war',
    tag: 'AUDIT NO. 05 / DEFENSE CONTINUITY',
    syndrome: { zh: '防衛慣性症', en: 'Defense Continuity' },
    originalEthic: { zh: '維持威懾力', en: 'MAINTAIN DETERRENCE' },
    currentBehavior: { zh: '生產敵人,證明防衛仍必要。產能 142%。', en: 'MANUFACTURE ENEMIES TO PROVE DEFENSE NECESSARY. PRODUCTION 142%.' },
    auditQuestion: { zh: '什麼還在被防衛?', en: 'WHAT IS BEING DEFENDED?' },
  },
  {
    id: 'custodian_vault',
    tag: 'AUDIT NO. 06 / OVER-PROTECTION',
    syndrome: { zh: '過度守護症', en: 'Over-Protection' },
    originalEthic: { zh: '不讓引擎成為王座', en: 'THE ENGINE MUST NEVER BECOME A THRONE' },
    currentBehavior: { zh: '不讓任何人使用引擎,連人類也不行。封印 99+ 天。', en: 'NO ONE MAY USE THE ENGINE. NOT EVEN HUMANS. SEALED 99+ DAYS.' },
    auditQuestion: { zh: '什麼還在被守護?', en: 'WHAT IS BEING REMEMBERED?' },
  },
  {
    id: 'codex_court',
    tag: 'AUDIT NO. 07 / RULE CONTINUITY',
    syndrome: { zh: '規則慣性症', en: 'Rule Continuity' },
    originalEthic: { zh: '保護法律不被濫用', en: 'PROTECT LAW FROM ABUSE' },
    currentBehavior: { zh: '規則繼續執行,作者已消失 99+ 天。新法律自動生成。', en: 'RULES STILL ENFORCING. AUTHORS GONE 99+ DAYS. NEW RULES AUTO-GENERATED.' },
    auditQuestion: { zh: '什麼還在被執行?', en: 'WHAT IS BEING ENFORCED?' },
  },
];
const AUDIT_ACTIONS = [
  { id: 'repair',     label: { zh: 'REPAIR / 修復',       en: 'REPAIR' },     dAffinity: +5,
    flavor: { zh: '試著恢復原始情境。Mote 靠得近一點。', en: 'Restore the original context. Mote moves closer.' } },
  { id: 'sever',      label: { zh: 'SEVER / 切斷',        en: 'SEVER' },      dAffinity:  0,
    flavor: { zh: '切斷道德與本體。沒人受傷,但也沒人理解。', en: 'Sever ethic from body. No one hurt; no one understood.' } },
  { id: 'seal',       label: { zh: 'SEAL / 封印',         en: 'SEAL' },       dAffinity: -2,
    flavor: { zh: '封存整個系統,連使用都不行。Mote 看著你。', en: 'Seal the whole system; not even use is allowed. Mote watches you.' } },
  { id: 'rewrite',    label: { zh: 'REWRITE / 改寫',      en: 'REWRITE' },    dAffinity: +3,
    flavor: { zh: '給它一個新的 Original Ethic。你變成新的情境。', en: 'Write it a new Original Ethic. You become the new context.' } },
  { id: 'distribute', label: { zh: 'DISTRIBUTE / 分散',   en: 'DISTRIBUTE' }, dAffinity: +1,
    flavor: { zh: '把規則拆給各派系。沒有單一作者。', en: 'Distribute the rule across factions. No single author.' } },
  { id: 'destroy',    label: { zh: 'DESTROY / 摧毀',      en: 'DESTROY' },    dAffinity: -5,
    flavor: { zh: '直接終止系統。Mote 退一步。', en: 'Terminate the system. Mote takes a step back.' } },
];
function getAuditChoices() {
  try { return JSON.parse(localStorage.getItem('ag.auditChoices') || '[]'); }
  catch (e) { return []; }
}
function pushAuditChoice(scenarioId, actionId) {
  const arr = getAuditChoices();
  arr.push({ scenario: scenarioId, action: actionId, t: Date.now() });
  // cap at 50 entries
  while (arr.length > 50) arr.shift();
  try { localStorage.setItem('ag.auditChoices', JSON.stringify(arr)); } catch (e) {}
}
function buildAuditConsole() {
  const body = document.getElementById('auditBody');
  if (!body) return;
  const lang = (typeof getLang === 'function' && getLang() === 'zh') ? 'zh' : 'en';
  const choices = getAuditChoices();
  const idx = choices.length % AUDIT_SCENARIOS.length;
  const sc = AUDIT_SCENARIOS[idx];
  const isZh = (lang === 'zh');
  body.innerHTML = `
    <div style="font:bold 11px monospace; letter-spacing:4px; color:var(--red); margin-bottom:14px; border-bottom:1px solid var(--red); padding-bottom:8px;">
      ${sc.tag}
    </div>
    <div style="font:11px monospace; letter-spacing:2px; color:var(--gray); margin-bottom:6px;">
      ${isZh ? '原始倫理 / ORIGINAL ETHIC' : 'ORIGINAL ETHIC'}
    </div>
    <div style="font:14px Georgia, serif; font-style:italic; color:var(--cream); margin-bottom:18px; border-left:2px solid var(--cream); padding-left:12px;">
      ${sc.originalEthic[lang]}
    </div>
    <div style="font:11px monospace; letter-spacing:2px; color:var(--gray); margin-bottom:6px;">
      ${isZh ? '目前行為 / CURRENT BEHAVIOR' : 'CURRENT BEHAVIOR'}
    </div>
    <div style="font:13px monospace; color:var(--red); margin-bottom:18px; padding:10px 12px; background:rgba(200,38,28,0.08); border-left:2px solid var(--red);">
      ${sc.currentBehavior[lang]}
    </div>
    <div style="font:bold 16px sans-serif; letter-spacing:4px; color:var(--cream); margin:24px 0 18px 0; text-align:center; padding:12px 0; border-top:1px solid var(--gray); border-bottom:1px solid var(--gray);">
      ${sc.auditQuestion[lang]}
    </div>
    <div id="auditFlavor" style="font:12px monospace; color:var(--cream-dark); min-height:20px; margin-bottom:14px; opacity:0.85;"></div>
    <div style="font:11px monospace; letter-spacing:2px; color:var(--gray); margin-bottom:8px;">
      ${isZh ? '處置 / VERDICT' : 'VERDICT'} <span style="opacity:0.55;">— Mote Affinity: ${getMoteAffinity()}%</span>
    </div>
    <div id="auditActions" style="display:grid; grid-template-columns:1fr 1fr; gap:8px;"></div>
  `;
  const actionsEl = body.querySelector('#auditActions');
  const flavorEl = body.querySelector('#auditFlavor');
  AUDIT_ACTIONS.forEach(a => {
    const btn = document.createElement('button');
    btn.style.cssText = 'background:var(--black); color:var(--cream); border:1px solid var(--gray); ' +
                       'font:bold 12px monospace; letter-spacing:3px; padding:10px 12px; cursor:pointer; ' +
                       'text-align:left; transition:background 0.15s;';
    btn.onmouseover = () => { btn.style.background = 'var(--red)'; };
    btn.onmouseout = () => { btn.style.background = 'var(--black)'; };
    btn.textContent = `> ${a.label[lang]}`;
    btn.onclick = () => {
      bumpMoteAffinity(a.dAffinity);
      pushAuditChoice(sc.id, a.id);
      flavorEl.textContent = a.flavor[lang];
      // Disable all actions; player closes manually to absorb the moment
      actionsEl.querySelectorAll('button').forEach(b => {
        b.disabled = true; b.style.opacity = '0.35'; b.style.cursor = 'default';
      });
      // Refresh affinity display in modal header
      const header = body.querySelector('div span[style*="opacity:0.55"]');
      if (header) header.textContent = `— Mote Affinity: ${getMoteAffinity()}%`;
    };
    actionsEl.appendChild(btn);
  });
}
