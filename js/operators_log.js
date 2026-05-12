// ============ OPERATOR'S LOG ============
// 24 daily story entries that unlock progressively as ag.dayNum advances.
// Each entry has a (day) trigger, title, and body in zh + en. Read state
// persists in ag.logsRead (set of day-numbers as JSON array). Unread
// entries past the current day glow yellow + the lobby badge counts.
//
// Extracted from index.html as the first modularization step. This file
// runs as a classic script (no module / no strict mode) so its top-level
// `const` + `function` declarations land in the global scope, matching
// the existing pattern. Loaded BEFORE the main inline <script> so the
// main script can reference these symbols without timing issues.
//
// Dependencies (looked up by name at call-time, resolved from main script):
//   - getDayNum()   — current day counter
//   - getLang()     — 'zh' | 'en'
//   - document.* / localStorage.*
//
// Public surface (used by other modules + main script):
//   LOG_ENTRIES (const array)
//   getReadLogs()
//   markLogRead(day)
//   refreshLogBadge()
//   buildLogModal()

const LOG_ENTRIES = [
  { day: 14, title_zh: '甦醒',          title_en: 'AWAKENING',
    body_zh: '我醒在第 14 天。 神經連結還在,小隊全部斷訊。 NN 兩邊都在生兵 — 紅藍每天都死、每天又活回來。 我不知道誰按下了第一個扳機,但我能感覺到子彈、痛、和恐懼。 我必須做點什麼。',
    body_en: 'I woke on Day 14. The neural link held, but every voice in the squad has gone dark. The NN is still spawning bodies on both sides — red and blue, dying and respawning every day. I don\'t know who pulled the first trigger. But I can feel the bullets, the pain, the fear. I have to do something.' },
  { day: 15, title_zh: '殘響',          title_en: 'ECHOES',
    body_zh: '隊友的呼號在頻道裡飄著:BRAVO、CHARLIE、DELTA。 接管時我能看到他們的最後一刻 — 不是回放,是身體記憶。 NN 給我們一個共有的痛覺。 我開始懷疑這是不是訓練。',
    body_en: 'Squad callsigns drift in on the channel: BRAVO, CHARLIE, DELTA. When I take over, I can see their last moments — not playback, body memory. The NN shares pain across us all. I\'m starting to wonder if this is a training simulation.' },
  { day: 16, title_zh: '建造的衝動',    title_en: 'THE URGE TO BUILD',
    body_zh: '今天我發現我能蓋牆。 不是從庫存,是從**意念**。 我想要一道牆,能源從我體內流出去,牆就在那。 NN 是這樣設計的嗎? 還是我們本來就有這能力,只是忘了。',
    body_en: 'Today I learned I can build walls. Not from inventory — from intent. I want a wall, energy flows out of me, the wall appears. Is this how the NN works? Or have we always had this, and forgotten?' },
  { day: 17, title_zh: '紅色的邏輯',    title_en: 'THE RED LOGIC',
    body_zh: '紅軍 NN 跟我們用同一個權重。 同一個推論引擎。 他們的"想法"和我們是鏡像。 那為什麼我們在互相殺? 也許我們本來就是同一群人,被切成兩半。',
    body_en: 'The red NN uses the same weights as ours. Same inference engine. Their "thoughts" are mirrors of mine. So why are we killing each other? Maybe we were always the same people, cut in half.' },
  { day: 18, title_zh: '炮塔的眼睛',    title_en: 'THE TURRET\'S GAZE',
    body_zh: '我在中庭放了一個自動炮塔。 它鎖定、開火、再鎖定 — 沒有任何疑慮。 比我們快、比我們準。 我看著它工作,感覺像在看一個沒有靈魂的我。',
    body_en: 'Placed an auto-turret in the central yard. It locks, fires, locks again — no hesitation. Faster than us, more precise. Watching it work feels like staring at a soulless version of myself.' },
  { day: 19, title_zh: 'BRAVO 的最後一句', title_en: 'BRAVO\'S LAST WORDS',
    body_zh: '"它們學了我的走位。" 那是 BRAVO 倒下前對頻道說的最後一句話。 接管他的瞬間我感覺到他左肩的彈孔。 紅軍 NN 學會我們了。',
    body_en: '"They\'ve learned my pattern." That was the last thing BRAVO said on comms before he went down. Taking over his body, I felt the bullet hole in his left shoulder. The red NN is learning us.' },
  { day: 20, title_zh: '機器狼的爪',    title_en: 'CLAWS OF THE WOLF',
    body_zh: '今天敵方派出機器狼 — 四足、低姿態、衝鋒型號。 它們咬下隊友的時候沒有聲音。 我得換戰術了。',
    body_en: 'The enemy deployed wolves today — quadruped, low-profile, rush chassis. They take down squadmates without making a sound. I need a new tactic.' },
  { day: 21, title_zh: 'EMP 的寂靜',    title_en: 'SILENCE FROM THE EMP',
    body_zh: '我第一次按下 EMP 立柱。 周圍的紅軍 NN 像被拉了插頭一樣定住,3 秒鐘什麼都不能做。 那 3 秒鐘他們**還在**思考嗎? 還是真的關了?',
    body_en: 'First time I deployed an EMP pylon. The red NN around it froze like the plug was pulled — 3 full seconds of nothing. Were they still *thinking* in those 3 seconds? Or really, fully off?' },
  { day: 22, title_zh: '空中支援',      title_en: 'AIR SUPPORT',
    body_zh: '網路終端可以呼叫空襲。 紅色標記、四發爆破、整個 sector 變平。 但每次我下令,我都想:這個指揮頻道的另一端是誰?',
    body_en: 'Network terminals can call airstrikes. Red markers, four-blast cluster, sector flattened. But every time I authorise it, I wonder: who\'s on the other end of this comm channel?' },
  { day: 23, title_zh: '掩體的階級',    title_en: 'A LADDER OF COVER',
    body_zh: '我學會了三種掩體:輕、中、堡壘。 紙糊的能擋一發,水泥牆能擋十發,鎧甲堡壘能挨火箭。 戰場每天都更像建築工地。',
    body_en: 'Learned three tiers of cover: paper, concrete, bunker. Paper stops one shot. Concrete stops ten. The armoured bunker takes a rocket. The battlefield looks more like a construction site every day.' },
  { day: 24, title_zh: '監視器迴響',    title_en: 'CAMERA ECHO',
    body_zh: '我把監視器塞在巷口。 突然我能"看見"我看不見的地方 — 那種感覺很怪。 神經連結把它接到我視覺皮層裡了。 我們真的不只是人類了。',
    body_en: 'Slotted a surveillance module at the alley mouth. Suddenly I can "see" places I\'m not — strange feeling. The neural link routes the feed straight to my visual cortex. We are no longer just human.' },
  { day: 25, title_zh: '蜂群',          title_en: 'SWARM',
    body_zh: '蜂群艙。 我放下後它就自己生 FPV,自己找目標。 不需要我下令。 它在我視野邊緣自轉、突進、爆炸 — 像我體內的某個器官在運作。',
    body_en: 'Drone bay. Once placed, it spawns FPVs on its own, finds its own targets. No commands from me. It rotates, dives, detonates at the edge of my vision — like an organ in my body running on its own.' },
  { day: 26, title_zh: '重生點',        title_en: 'SPAWN POINTS',
    body_zh: '我看到紅色菱形樁柱了 — 那是它們的生兵點。 打爆一個,那邊就再也不會出兵。 但 NN 會在另一邊補上。 永遠補上。',
    body_en: 'Saw the red diamond pylons today — that\'s where their reinforcements come from. Destroy one, that direction stops spawning. But the NN compensates somewhere else. It always compensates.' },
  { day: 27, title_zh: '心跳',          title_en: 'HEARTBEAT',
    body_zh: '低血量的時候,我自己的心跳大聲到能蓋過槍聲。 那是真的我的心跳? 還是 NN 模擬給我聽的? 兩個答案都讓我害怕。',
    body_en: 'At low HP, my own heartbeat is loud enough to drown out the gunfire. Is that really my heart? Or is the NN simulating it for me? Both answers scare me.' },
  { day: 28, title_zh: '操作員 0451',   title_en: 'OPERATOR 0451',
    body_zh: '我終於回想起來:我不是第一個 0451。 系統文件裡有過 0450、0449、0448... 一路下去。 他們去哪裡了? 我會去同一個地方嗎?',
    body_en: 'I\'ve finally remembered: I\'m not the first 0451. The system logs reference 0450, 0449, 0448 — all the way back. Where did they go? Am I going to the same place?' },
  { day: 29, title_zh: '紅軍的訊息',    title_en: 'A MESSAGE FROM RED',
    body_zh: '今天紅軍 NN 用我的呼號回應頻道。 一個和我聲音極像的"我"說:「停下,你不會贏的。」 我關掉了頻道。 NN 開始模仿我了。',
    body_en: 'Today the red NN responded on comms using my callsign. A voice that sounded just like mine said, "Stop. You can\'t win." I cut the channel. The NN has started imitating me.' },
  { day: 30, title_zh: '半個月',        title_en: 'HALF A MONTH',
    body_zh: '14 + 16 = 30。 我已經在這個迴圈裡半個月了。 沒人告訴我外面發生了什麼。 sector 7G 的天空永遠是黃昏色。 我開始懷疑,**沒有外面**。',
    body_en: '14 + 16 = 30. I\'ve been in this loop half a month. Nobody tells me what\'s happening outside. The sky over sector 7G is always dusk. I\'m starting to wonder if there *is* an outside.' },
  { day: 32, title_zh: '網路深處',      title_en: 'DEEP IN THE NET',
    body_zh: '我接管 DELTA 的時候,意識在頻道裡多停了一秒。 我聽到了"訓練"這個字。 不是我說的。 不是 NN 說的。 是某個更深的東西。',
    body_en: 'When I took over DELTA, my consciousness hung on the channel a second too long. I heard the word "training". I didn\'t say it. The NN didn\'t say it. Something deeper did.' },
  { day: 35, title_zh: '電的味道',      title_en: 'THE TASTE OF VOLTAGE',
    body_zh: '特斯拉鏈電從一個敵人跳到下一個的時候,空氣是焦的。 我嘴裡有金屬味。 神經連結說:**那是真的味道**。 神經連結也會撒謊嗎?',
    body_en: 'When the Tesla coil chains from one enemy to the next, the air smells burnt. I taste metal. The neural link says: that\'s a real taste. Does the neural link lie?' },
  { day: 40, title_zh: '一個人',        title_en: 'ALONE',
    body_zh: '我試過不接管任何人。 整場我只控制自己。 我活下來了,但很慢、很孤獨。 NN 不需要我,**它需要的是流量**。',
    body_en: 'I tried not taking over anyone. Played the whole match in my own body. I survived, but it was slow, lonely. The NN doesn\'t need *me* — it needs *traffic*.' },
  { day: 50, title_zh: '建造者',        title_en: 'BUILDER',
    body_zh: '50 天後,我蓋的牆比我殺的人多。 sector 7G 看起來像一個工地。 也許我從來就不是士兵。 也許我是工程師。',
    body_en: 'After 50 days, I\'ve built more walls than I\'ve killed people. Sector 7G looks like a construction site. Maybe I was never a soldier. Maybe I\'m an engineer.' },
];

function getReadLogs() {
  try { return new Set(JSON.parse(localStorage.getItem('ag.logsRead') || '[]')); }
  catch (e) { return new Set(); }
}
function markLogRead(day) {
  const set = getReadLogs(); set.add(day);
  try { localStorage.setItem('ag.logsRead', JSON.stringify([...set])); } catch (e) {}
  refreshLogBadge();
}
function refreshLogBadge() {
  const badge = document.getElementById('logBadge');
  if (!badge) return;
  const dayN = (typeof getDayNum === 'function') ? getDayNum() : 14;
  const read = getReadLogs();
  const unread = LOG_ENTRIES.filter(e => e.day <= dayN && !read.has(e.day)).length;
  badge.textContent = unread;
  badge.hidden = unread === 0;
}
function buildLogModal() {
  const body = document.getElementById('logBody');
  if (!body) return;
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const dayN = (typeof getDayNum === 'function') ? getDayNum() : 14;
  const read = getReadLogs();
  const total = LOG_ENTRIES.length;
  const recovered = LOG_ENTRIES.filter(e => e.day <= dayN).length;
  body.innerHTML = '';
  LOG_ENTRIES.forEach((e, i) => {
    const div = document.createElement('div');
    const unlocked = e.day <= dayN;
    const wasRead = read.has(e.day);
    const isFresh = unlocked && !wasRead;
    div.className = 'log-entry' + (isFresh ? ' fresh' : (wasRead ? ' read' : '')) + (unlocked ? '' : ' locked');
    const dayLabel = (lang === 'zh') ? `第 ${String(e.day).padStart(2, '0')} 天` : `DAY ${String(e.day).padStart(2, '0')}`;
    const title = (lang === 'zh') ? e.title_zh : e.title_en;
    const text  = (lang === 'zh') ? e.body_zh  : e.body_en;
    const statusLabel = unlocked
      ? (isFresh ? ((lang === 'zh') ? '新檔案' : 'RECOVERED')
                 : ((lang === 'zh') ? '已讀'   : 'READ'))
      : ((lang === 'zh') ? '機密' : 'CLASSIFIED');
    const idx = String(i + 1).padStart(2, '0');
    if (unlocked) {
      div.innerHTML = `
        <div class="log-header">
          <span class="log-num">${idx}</span>
          <span class="log-day">${dayLabel}</span>
          <span class="log-status">${statusLabel}</span>
        </div>
        <div class="log-title">${title}</div>
        <div class="log-body">${text}</div>
      `;
    } else {
      // Redacted view — header still visible, body is black bars
      div.innerHTML = `
        <div class="log-header">
          <span class="log-num">${idx}</span>
          <span class="log-day">${dayLabel}</span>
          <span class="log-status">${statusLabel}</span>
        </div>
        <div class="log-title">[ ${title.length} CHAR — REDACTED ]</div>
        <div class="log-body">
          <span class="log-redact r1"></span>
          <span class="log-redact r2"></span>
          <span class="log-redact r3"></span>
          <span class="log-redact r4"></span>
          <span class="log-redact r5"></span>
        </div>
      `;
    }
    body.appendChild(div);
    if (unlocked) markLogRead(e.day);
  });
  // Header counter
  document.getElementById('logModalTitle').innerHTML =
    `<span class="log-tag-main">${(lang === 'zh') ? '操作員日誌' : 'OPERATOR LOG'}</span>` +
    `<span class="log-tag-sub">${(lang === 'zh') ? '解密檔案' : 'DECLASSIFIED'} //</span>` +
    `<span class="log-tag-counter"><b>${String(recovered).padStart(2, '0')}</b> / ${String(total).padStart(2, '0')} ${(lang === 'zh') ? '已恢復' : 'RECOVERED'}</span>`;
}
