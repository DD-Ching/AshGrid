// ============ SIEGE — the data-driven control surface (劇本) ============
// THE owner's #1 ask: the entire siege is DATA. SIEGE_SCRIPT is a declarative
// TIMELINE of cues; DIRECTOR_PARAMS are the emergent knobs; SIEGE_LOG_ENTRIES is
// the operator-log story. To retune pacing (進場時間) / story (劇情) / camera
// (運鏡) / day-night + weather (背景) / terrain (更改地形) — you EDIT THESE ROWS,
// never engine code. The runtime (siege_director.js) is a generic dispatcher:
// _SIEGE_CUE[kind] maps each verb to one clean engine call, and the DIRECTOR
// emits cues into the SAME pipeline, so authored (Nights 1–5) and emergent
// (Night 6+) content share one schema.
//
// A cue = { night, at, kind, ...params }
//   night — which night (1…5), or '_proc' for the endless generator
//   at    — seconds into that night's active phase to fire
//   kind  — a verb in _SIEGE_CUE (siege_director.js)
//
// Classic-script globals: SIEGE_SCRIPT · DIRECTOR_PARAMS · SIEGE_LOG_ENTRIES
//   · _siegeScriptCueKinds() (test accessor)

// ── THE TIMELINE (Nights 1–2 authored here; 3–5 + proc added in Phase 7) ──────
const SIEGE_SCRIPT = [
  // ───────────── NIGHT 1 · 試探 / THE PROBE — teach walls + the weld loop ─────
  { night: 1, at: 0,  kind: 'tod',       name: 'dusk' },
  { night: 1, at: 0,  kind: 'weather',   w: 'clear' },
  { night: 1, at: 0,  kind: 'goal',      zh: '守住北門', en: 'HOLD THE NORTH GATE' },
  { night: 1, at: 1,  kind: 'beat',      zh: '第 1 夜 · 試探 · 守住北門',
                                          en: 'NIGHT 1 · THE PROBE · HOLD THE NORTH GATE' },
  { night: 1, at: 2,  kind: 'log',       entry: 'the_first_horn' },
  { night: 1, at: 4,  kind: 'telegraph', gate: 'N', dur: 6, threat: 'mass' },
  { night: 1, at: 5,  kind: 'camera',    fx: 'focus', on: 'gate-N', scale: 1.3, dur: 80 },
  { night: 1, at: 6,  kind: 'spawn',     unit: 'sapper', n: 4, gate: 'N' },
  { night: 1, at: 22, kind: 'spawn',     unit: 'sapper', n: 4, gate: 'N' },
  { night: 1, at: 40, kind: 'spawn',     unit: 'sapper', n: 5, gate: 'N' },
  { night: 1, at: 55, kind: 'beat',      zh: '撐住…天快亮了', en: 'Hold… dawn is close' },
  { night: 1, at: 62, kind: 'dawn',      windowSec: 30, salvage: 200 },

  // ───────────── NIGHT 2 · 鋼鐵 / IRON — the first wall-breaking tank ─────────
  { night: 2, at: 0,  kind: 'tod',       name: 'night' },
  { night: 2, at: 0,  kind: 'weather',   w: 'wind' },
  { night: 2, at: 0,  kind: 'goal',      zh: '撐住北門 — 重裝甲來了',
                                          en: 'HOLD THE NORTH — armour incoming' },
  { night: 2, at: 1,  kind: 'beat',      zh: '第 2 夜 · 鋼鐵', en: 'NIGHT 2 · IRON' },
  { night: 2, at: 2,  kind: 'log',       entry: 'iron_in_the_dark' },
  { night: 2, at: 4,  kind: 'spawn',     unit: 'sapper', n: 4, gate: 'N' },              // screen for the tank
  { night: 2, at: 10, kind: 'telegraph', gate: 'N', dur: 8, threat: 'armour' },          // INTENT: ARMOUR · NORTH
  { night: 2, at: 10, kind: 'camera',    fx: 'focus', on: 'gate-N', scale: 1.4, dur: 90 },// horn telegraph (運鏡)
  { night: 2, at: 11, kind: 'beat',      zh: '聽見了嗎?引擎聲。', en: 'You hear that? Engines.' },
  { night: 2, at: 14, kind: 'spawn',     unit: 'tank', n: 1, gate: 'N', target: 'curtainN' }, // THE SETPIECE
  { night: 2, at: 15, kind: 'camera',    fx: 'focus', on: 'tank', scale: 1.2, dur: 140 },     // ARMOUR REVEAL (運鏡)
  { night: 2, at: 30, kind: 'spawn',     unit: 'sapper', n: 5, gate: 'E' },                   // flank pressure
  // tank reaches the wall ~at:48; _siegeTankBreach eats 'curtainN' live.
  { night: 2, at: 50, kind: 'camera',    fx: 'shake', mag: 7, dur: 30 },                      // breach punch
  { night: 2, at: 52, kind: 'beat',      zh: '北牆破了!退守內堡!',
                                          en: 'NORTH WALL BREACHED! Fall back to the keep!' },
  { night: 2, at: 54, kind: 'spawn',     unit: 'sapper', n: 6, gate: 'N', target: 'innerN' }, // pour through
  { night: 2, at: 90, kind: 'beat',      zh: '撐住…天快亮了。', en: 'Hold… dawn is close.' },
  { night: 2, at: 95, kind: 'dawn',      windowSec: 35, salvage: 260 },

  // ───────────── NIGHT 3 · 蜂群 / THE SWARM — over the walls, in the rain ─────
  { night: 3, at: 0,  kind: 'tod',       name: 'night' },
  { night: 3, at: 0,  kind: 'weather',   w: 'rain' },
  { night: 3, at: 0,  kind: 'goal',      zh: '守住核心 — 注意天空', en: 'GUARD THE HEART — watch the sky' },
  { night: 3, at: 1,  kind: 'beat',      zh: '第 3 夜 · 蜂群 · 暴雨', en: 'NIGHT 3 · THE SWARM · RAIN' },
  { night: 3, at: 2,  kind: 'log',       entry: 'they_have_wings' },
  { night: 3, at: 3,  kind: 'telegraph', gate: 'W', dur: 6, threat: 'armour' },
  { night: 3, at: 4,  kind: 'spawn',     unit: 'tank', n: 1, gate: 'W', target: 'curtainW_n' },
  { night: 3, at: 8,  kind: 'telegraph', gate: 'E', dur: 6, threat: 'air' },
  { night: 3, at: 9,  kind: 'drone',     n: 6, target: 'core', from: 'E' },              // OVER-THE-WALL
  { night: 3, at: 9,  kind: 'camera',    fx: 'focus', on: 'swarm', scale: 1.8, dur: 70 }, // SWARM WIDE (運鏡)
  { night: 3, at: 20, kind: 'spawn',     unit: 'sapper', n: 5, gate: 'S' },
  { night: 3, at: 30, kind: 'weather',   w: 'storm' },                                    // 背景 escalates
  { night: 3, at: 30, kind: 'camera',    fx: 'shake', mag: 5, dur: 18 },                  // thunder
  { night: 3, at: 38, kind: 'drone',     n: 5, target: 'core' },
  { night: 3, at: 55, kind: 'beat',      zh: '天要亮了…撐住', en: 'Almost dawn… hold' },
  { night: 3, at: 60, kind: 'dawn',      windowSec: 30, salvage: 300 },

  // ───────────── NIGHT 4 · 風暴 / THE STORM — two fronts, lightning ──────────
  { night: 4, at: 0,  kind: 'tod',       name: 'night' },
  { night: 4, at: 0,  kind: 'weather',   w: 'storm' },
  { night: 4, at: 0,  kind: 'goal',      zh: '兩面受敵 — 別讓核心暴露', en: 'TWO FRONTS — keep the Heart covered' },
  { night: 4, at: 1,  kind: 'beat',      zh: '第 4 夜 · 風暴', en: 'NIGHT 4 · THE STORM' },
  { night: 4, at: 2,  kind: 'log',       entry: 'the_storm_remembers' },
  { night: 4, at: 3,  kind: 'telegraph', gate: 'N', dur: 6, threat: 'armour' },
  { night: 4, at: 4,  kind: 'spawn',     unit: 'tank', n: 1, gate: 'N', target: 'curtainN' },
  { night: 4, at: 6,  kind: 'telegraph', gate: 'S', dur: 6, threat: 'mass' },             // the opposite front
  { night: 4, at: 7,  kind: 'spawn',     unit: 'sapper', n: 6, gate: 'S' },
  { night: 4, at: 14, kind: 'drone',     n: 6, target: 'core' },
  { night: 4, at: 20, kind: 'camera',    fx: 'shake', mag: 8, dur: 30 },                  // lightning wall-collapse
  { night: 4, at: 22, kind: 'spawn',     unit: 'tank', n: 1, gate: 'S', target: 'curtainS_w' },
  { night: 4, at: 35, kind: 'spawn',     unit: 'sapper', n: 6, gate: 'E' },
  { night: 4, at: 40, kind: 'drone',     n: 6 },
  { night: 4, at: 55, kind: 'beat',      zh: '如果核心倒了,我也一起。', en: 'If the core goes, I go with it.' },
  { night: 4, at: 62, kind: 'dawn',      windowSec: 30, salvage: 340 },

  // ───────────── NIGHT 5 · 黎明前 / BEFORE THE DAWN — the gate-push → WIN ─────
  { night: 5, at: 0,  kind: 'tod',       name: 'night' },
  { night: 5, at: 0,  kind: 'weather',   w: 'storm' },
  { night: 5, at: 0,  kind: 'goal',      zh: '守住核心 · 撐到破曉', en: 'HOLD THE HEART · survive to dawn' },
  { night: 5, at: 1,  kind: 'beat',      zh: '第 5 夜 · 黎明前 · 他們傾巢而出',
                                          en: 'NIGHT 5 · BEFORE THE DAWN · everything they have left' },
  { night: 5, at: 2,  kind: 'log',       entry: 'before_the_dawn' },
  { night: 5, at: 3,  kind: 'telegraph', gate: 'N', dur: 5, threat: 'armour' },
  { night: 5, at: 4,  kind: 'spawn',     unit: 'tank', n: 2, gate: 'N', target: 'innerN' },
  { night: 5, at: 8,  kind: 'spawn',     unit: 'sapper', n: 6, gate: 'E' },
  { night: 5, at: 10, kind: 'drone',     n: 8, target: 'core' },
  { night: 5, at: 14, kind: 'spawn',     unit: 'walker', n: 1, gate: 'S', target: 'innerS_w' },  // final super-tank
  { night: 5, at: 18, kind: 'camera',    fx: 'focus', on: 'core', scale: 1.1, dur: 120 },        // Heart's-eye
  { night: 5, at: 22, kind: 'spawn',     unit: 'sapper', n: 8, gate: 'W' },
  { night: 5, at: 30, kind: 'drone',     n: 8, target: 'core' },
  { night: 5, at: 40, kind: 'camera',    fx: 'shake', mag: 8, dur: 24 },
  { night: 5, at: 48, kind: 'beat',      zh: '只剩核心了。站上去,守住,直到天亮。',
                                          en: 'Only the Heart now. Stand on it. Hold until the light.' },
  { night: 5, at: 58, kind: 'camera',    fx: 'focus', on: 'core', scale: 1.0, dur: 170 },         // dawn pull
  { night: 5, at: 64, kind: 'dawn',      windowSec: 40, salvage: 0 },                             // DAWN HOLDS = WIN

  // ───────────── NIGHT 6+ · 長夜 / THE LONG NIGHT — procedural endless ────────
  // The director composes from DIRECTOR_PARAMS + this row (see _siegeProcNight).
  { night: '_proc', kind: 'proc', tankBase: 3, droneBase: 8, escalate: 1.25, windowSec: 24 },
];

// ── DIRECTOR_PARAMS — the emergent knobs (what makes runs differ; Phase 7) ────
const DIRECTOR_PARAMS = {
  basePressure:     6,          // baseline "army points" per night
  pressurePerNight: 4,          // linear ramp
  perfMultiplier:   [0.9, 1.6], // [struggling, dominating] — reads K/D + wall integrity (one-way-ish DDA)
  unitCost:   { sapper: 1, marauder: 2, tank: 5, walker: 9, drone: 1 },
  telegraphSec:     [8, 3],     // telegraph lead-time shrinks as nights escalate
  lullSec:          [10, 4],    // dawn/lull window shrinks as nights escalate
  targetGate:       'adaptive', // aim the weakest / least-repaired gate
  splitAfterNight:  4,          // when TWO-FRONTS becomes possible
  droneFloor:       3,          // min drones once drone nights begin
  finalDawnNight:   5,          // night whose `dawn` cue = WIN
  procFrom:         6,          // first fully-procedural night
};

// ── Operator log (劇情) — { night, title_zh/en, body_zh/en }. Nights 0–2 here;
//    3–5 + the dawn entry added in Phase 7. Stored read-state in ag.logsRead. ──
const SIEGE_LOG_ENTRIES = {
  abandoned: {
    night: 0, title_zh: '棄守', title_en: 'ABANDONED',
    body_zh: '撤離令來了,我沒走。一個人守一座沒人要的中繼站。',
    body_en: "The evacuation order came; I didn't go. One operator garrisoning a relay nobody wanted.",
  },
  the_first_horn: {
    night: 1, title_zh: '第一聲號角', title_en: 'THE FIRST HORN',
    body_zh: '東門是我自己焊上的。工具還在,他們走得很急。你會先聽見黑暗裡的他們,才看見。',
    body_en: 'Welded the east gate myself. Tools still here — they left in a hurry. You hear them in the dark before you see them.',
  },
  iron_in_the_dark: {
    night: 2, title_zh: '暗夜鋼鐵', title_en: 'IRON IN THE DARK',
    body_zh: '我透過神經連結感覺到牆裂開,像一顆牙鬆了。庭院,才一直是真正的牆。',
    body_en: 'I felt the wall give through the link, like a tooth coming loose. The courtyard was always the real wall.',
  },
  they_have_wings: {
    night: 3, title_zh: '他們長了翅膀', title_en: 'THEY HAVE WINGS NOW',
    body_zh: '牆對會飛的東西沒用。留點火力對著天空 — 我快沒有可用的身體了。',
    body_en: 'Walls mean nothing to the ones that fly. Keep something pointed at the sky — I am running out of bodies to be.',
  },
  the_storm_remembers: {
    night: 4, title_zh: '風暴記得', title_en: 'THE STORM REMEMBERS',
    body_zh: '同時兩道門。一個操作員分不成兩個地方 — 這就是小隊存在的理由。核心若倒,我與它同葬。我不走。',
    body_en: "Two gates at once. One operator can't be two places — this is what the squad is for. If the core goes, I go with it. I'm not leaving.",
  },
  before_the_dawn: {
    night: 5, title_zh: '黎明前', title_en: 'BEFORE THE DAWN',
    body_zh: '如果你讀到這裡,內牆已經沒了。現在只剩核心。站上去。守住 — 撐到天亮就好。',
    body_en: 'If you are reading this, the inner wall is gone. There is only the Heart now. Stand on it. Hold — just hold until the light.',
  },
  dawn_holds: {
    night: 5, title_zh: '破曉', title_en: 'DAWN HOLDS',
    body_zh: '日出時紅色 NN 撤了。你不知道是你贏了,還是他們只是停手。你還在這裡。',
    body_en: "The red NN withdraws at sunrise. You don't know if you won or if they simply stopped. You're still here.",
  },
};

// Test accessor — the set of cue kinds the authored script actually uses.
function _siegeScriptCueKinds() {
  const seen = {};
  for (const c of SIEGE_SCRIPT) if (c && c.kind) seen[c.kind] = true;
  return Object.keys(seen);
}
