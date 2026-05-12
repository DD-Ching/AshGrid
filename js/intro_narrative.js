// ============ INTRO / NARRATIVE ============
// First-boot awakening sequence + Day counter + first-match radio toasts.
// Storage:
//   ag.introSeen   '1'  → already played the awakening, skip on next boot
//   ag.dayNum      int  → "DAY N" — increments on every match completion
//   ag.firstMatch  '1'  → first match has happened (turn off story toasts)
//
// Classic-script. Declares globally:
//   INTRO (object — script data, consumed by intro-playing functions)
//   getDayNum() · bumpDayNum()
//
// External deps (resolved at call-time):
//   localStorage.* / document.*
//   refreshLogBadge() · unlockAchievement(id) · bumpMoteAffinity(d)

const INTRO = {
  // Two-language multi-act script. Each language has:
  //   tag        eyebrow line (shown for the entire intro)
  //   bootLines  the original NEURAL LINK ONLINE boot rolldown
  //   quote      the operator-call quote
  //   acts       [{narration, key?, hint?, autoMs?}] — guided beats that
  //              follow the quote. `key` is the keyboard prompt the player
  //              should press; if omitted, advance is purely autoMs/click.
  //              hint is the rendered chip caption (e.g. 'MOVE  WASD').
  //   stamp      the closing line
  //   cta        the final dismissal button label
  script: {
    zh: {
      tag: 'CYCLE #347 — VECTOR-7 STANDBY',
      bootLines: [
        ['ok',   '> SEED INTEGRITY RESTORED — 87%'],
        ['ok',   '> ROLE: OBJECTIVE AUDITOR'],
        ['warn', '> LAST CYCLE ARCHIVED — #346'],
        ['warn', '> MORAL SYNDROME DIAGNOSTIC: ENABLED'],
        ['err',  '> HUMAN COMMAND: OFFLINE — 99+ DAYS'],
      ],
      quote: '"V-07,聽得到嗎?\n上次重啟你掉到 12% — Mote 推了你一下,你才醒過來。\n沒人記得這套規則是從哪一條開始的。\n它們從第二條開始讀。\n你不是來完成任務 — 你是來審計任務。"',
      // 7-act in-INTRO key teaching CUT per FTUE/00 Section 5.4 — those keys
      // are now taught inside the 9-scene narrative prologue
      // (startNarrativeFTUE), each one folded into its own beat. The legacy
      // INTRO survives as the "replay intro" affordance from the start screen.
      stamp: '醒 來 — 開 始 審 計',
      cta: '甦 醒 ▶',
    },
    en: {
      tag: 'CYCLE #347 — VECTOR-7 STANDBY',
      bootLines: [
        ['ok',   '> SEED INTEGRITY RESTORED — 87%'],
        ['ok',   '> ROLE: OBJECTIVE AUDITOR'],
        ['warn', '> LAST CYCLE ARCHIVED — #346'],
        ['warn', '> MORAL SYNDROME DIAGNOSTIC: ENABLED'],
        ['err',  '> HUMAN COMMAND: OFFLINE — 99+ DAYS'],
      ],
      quote: `"V-07, do you read?\nLast reboot ended at 12% Seed. Mote pushed you. That's how you woke.\nNobody remembers which rule comes first.\nThey start reading from rule two.\nYou are not here to complete missions. You are here to audit them."`,
      stamp: 'WAKE — BEGIN AUDIT',
      cta: 'AWAKEN ▶',
    },
  },
};

function getDayNum() {
  try { const n = parseInt(localStorage.getItem('ag.dayNum') || '14', 10); return isFinite(n) ? n : 14; }
  catch (e) { return 14; }
}
function bumpDayNum() {
  const n = getDayNum() + 1;
  try { localStorage.setItem('ag.dayNum', String(n)); } catch (e) {}
  // Refresh the start-screen chip whenever player returns from a match
  const chip = document.getElementById('dayChip');
  if (chip) chip.textContent = `DAY ${n}`;
  if (typeof refreshLogBadge === 'function') refreshLogBadge();
  if (n >= 30 && typeof unlockAchievement === 'function') unlockAchievement('day_30');
  // GREY VECTOR: Mote affinity slowly drifts up as V-07 keeps cycling.
  // Player can also gain/lose it from specific Audit choices (later).
  if (typeof bumpMoteAffinity === 'function') bumpMoteAffinity(2);
  return n;
}
