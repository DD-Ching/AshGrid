# AshGrid 遊戲架構 / GAME ARCHITECTURE

最後更新:2026-05-08。範圍:整個 `index.html` 約 17K 行 + ONNX 模型 + PWA 殼。
中英對照:每節中文標題後括號是英文錨點,方便 grep。

> ⚠️ Section 3 的行號表是舊的快照(`index.html` 已從 ~13K 增長到 ~17K)。
> 用作粗略導航即可,精確位置請 grep `// ========`、結構名(`STRUCTURE_DEFS`、
> `MISSION_FACTORIES.X`、`nnTick`、`recomputePowerGrid` …)定位。

---

## 1. 一句話摘要 / Overview

AshGrid 是**單檔 HTML5 遊戲**(無打包工具),核心是 60FPS 的 2D 俯視戰術射擊。
特色三層:

1. **NN 對抗** — PPO 訓練的 ONNX 模型驅動敵我雙方,6 種風格(elite/warrior/defensive/sharpshooter/cqb/tactical;tactical 暫 fallback 到 elite 權重),客戶端 ort.js 推論。
2. **建造系統** — 16 種模塊(掩體三階梯 / 自動炮塔 / 特斯拉 / EMP / 醫療 / 蜂群 / 終端 / 機器人 / 哨點 ...),所有 NN 模式都可邊打邊建。發電機 200u 範圍 + 牆線 BFS 連鎖供電。
3. **7 NN 模式 + 6 戰役任務** — Skirmish 走 NN 對抗 (DM / Survival / Defense / Helo / Convoy / Duel / Sniper),Campaign 6 關走手工任務工廠;NN 地圖變體有 21 個 + 玩家自製 slot。

部署目標:**itch.io / 自建 web → PWA → 之後 Play Store**。零後端目前(Firebase / AdMob 是 stub)。

---

## 2. 檔案結構 / File Layout

```
AshGrid/
├── index.html              ← 主檔。HTML + CSS + JS 全在一起(~13K 行)
├── manifest.webmanifest    ← PWA 設定
├── sw.js                   ← Service Worker(離線快取)
├── icons/                  ← PWA icon 套(各種尺寸)
├── ai_arena/onnx/          ← 訓練好的模型(model_*.onnx,~110KB 各)
│   ├── model_elite.onnx
│   ├── model_warrior.onnx
│   ├── model_defensive.onnx → norespawn.onnx 別名
│   ├── model_sharpshooter.onnx
│   ├── model_cqb.onnx       ← 最新加入
│   └── ai_arena/*.ipynb     ← 訓練 notebook(Kaggle 用)
├── assets/                 ← 音效 / 圖片
├── ROADMAP.md              ← 上架時程 + 已完成清單
└── ARCHITECTURE.md         ← 本文件
```

---

## 3. index.html 內部分節 / Section Map

每節都用 `// ============ NAME ============` 分隔。順序大致是:**資料 → 輸入 → 模型 → 邏輯 → 渲染 → 主迴圈**。

| 行號 | 段落 | 角色 |
|---:|---|---|
| 747 | I18N | `T(zh, en)` 助手 + 起始畫面/lobby/HUD/結構 三千條翻譯字典 |
| 944 | SETUP | canvas / DPR / W()/H() 助手 |
| 982 | STATE | `game` 全域物件(state/mode/wave/score/shake/timeScale...) |
| 1048 | (player) | `player` 全域物件(座標/HP/武器/chassis/aim-assist) |
| 1070 | STRUCTURES | 防禦模塊定義 + 放置 + tick(`STRUCTURE_DEFS`、`updateStructures`) |
| 1637 | GRENADES | 一般手雷 + 滾動爆炸 |
| 1839 | OPERATOR PAWN-SWAP | 接管隊友、把舊身體交給 NN |
| 1948 | CHASSIS | humanoid / wolf / heavy 三型體 + `applyChassisToUnit` |
| 2057 | AUDIO | 位置音 + 動態音樂 |
| 2444 | INPUT | keydown / mousedown / mouseup / mousemove + 編輯器拖線 |
| 2520 | MAP EDITOR | 多槽位地圖編輯 + Bresenham 拉線繪牆 |
| 3080 | TOUCH INPUT | 雙搖桿 + 觸控按鈕 + radial 點擊 + 拉線觸控 |
| 3358 | GAME LIFECYCLE | `_lobby` 狀態 + `startNNSkirmish` + 設定持久化 |
| 3484 | LINEUP EDITOR | 每位 NN 隊員獨立難度/武器/chassis |
| 3907 | MAP HELPERS | `addBuilding` / `addLowCover` / `addOverhead`(可破壞建物有 hp) |
| 3948 | MAP DEFINITIONS | 5 張 campaign 地圖 |
| 4476 | NN ARENA MAP VARIANTS | 12+ 個 NN 競技場變體(各模式可用的 map pool) |
| 4927 | NN AI MODULE | ONNX 推論 dispatcher,batched + 多 difficulty 並行 |
| 5433 | MISSIONS | campaign 6 個 + 7 個 NN mission(共 12 個 factory) |
| 6502 | GLOBAL STATS | `ag.stats`(總場數 / 擊殺 / 最佳生存波次) |
| 6543 | AD/CLOUD STUBS | `requestRewardedAd(id, cb)` + `uploadSurvivalRun(run)` 介面 |
| 7042 | NN DEFENSE | 邊打邊建 mission factory(獨立波次邏輯 + spawn beacons) |
| 7920 | WORLD GEN | 隨機戰場物體生成 |
| 8120 | SQUAD | 隊友 AI(非 NN 模式) |
| 8365 | DRONE / FPV | UAV 偵察 + FPV 自殺機 |
| 8398 | VISION RAYCASTING | `lineOfSight(x1,y1,x2,y2)`,加進牆 + 煙霧 + 結構 |
| 8514 | AI | 非 NN 敵方狀態機 |
| 8943 | UPDATE | 主邏輯迴圈(每 tick) |
| 9735 | CAMERA | 跟隨 + 邊界 + 模式切換 |
| 9782 | RENDER | 主繪圖迴圈 + 地形 + 單位 + 子彈 + HUD 順序 |
| 11836 | HUD | 任務面板 + minimap + radial + 觸控按鈕 + 結算卡 |
| 12778 | PAUSE | 暫停選單 + 退出/靜音/快捷鍵列表 |
| 12928 | MAIN LOOP | rAF 迴圈,內含時間累積器(支援 slow-mo) |

---

## 4. 主要狀態物件 / Top-Level State

### `game` — runtime 全局
```
state         'menu' | 'playing' | 'editor'
mode          'tactical' | 'drone' | 'fpv' | 'command'
_nnMode       true 表示在 NN 戰場
_nnGameMode   'dm' | 'survival' | 'defense' | 'helo' | 'convoy' | 'duel' | 'sniper'
time          tick 計數(60/s)
score         分數
killCount     擊殺數
shakeMag/Until 相機晃
_timeScale    慢動作速率(1.0 = 正常 / 0.55 = 連殺爆發)
_paused       暫停旗標
_energy       建造能源(NN 模式都有,Defense 額外加波清算獎)
_structures   已放結構 [{kind,x,y,hp,...}]
_smokeClouds  煙霧雲視覺
_teslaBolts   特斯拉鏈電視覺殘影
_empPulses    EMP 脈衝環
_autoDrones   蜂群自走 FPV
_airstrikes   空中支援待引爆
_spawnBeacons 敵方重生點(Defense)
_footprints   足跡追蹤
```

### `player` — 玩家
- 座標 / HP / 武器 / 彈匣 / 庫存
- `_chassis`(humanoid/wolf/heavy)
- `_aimAssist`(自動瞄準鎖定)
- `_killStreak` / `_killer` / `_lastDamageBy`(連殺 + 死因追蹤)

### `_lobby` — 戰前選擇
```
blue / red       1-8 各方
difficulty       NN 風格(預設 elite)
weapon           SMG / RIFLE / LMG / SNIPER / SHOTGUN / ROCKET
chassis          humanoid / wolf / heavy
mode             dm / survival / defense / helo / convoy / duel / sniper
lineup           per-slot override 字典
```
持久化:`ag.lobbyConfig`(JSON)。

### `NN` — 模型狀態
- `modelPaths.{tier}` 對應 .onnx 檔
- `sessions[tier]` 載入後的 ort session
- `loaded` / `error`

---

## 5. 資料流 / Data Flow

```
                        ┌─────────────┐
   keyboard / mouse ─→──│  INPUT 層   │
   touch / pointer  ─→──│  (line 2444)│
                        └──────┬──────┘
                               ▼
                        ┌─────────────┐
                        │  game state │  ← _lobby / mission / _structures
                        │  (line 982) │
                        └──────┬──────┘
                               ▼
   ┌─────────────────── update() (line 8943) ─────────────────┐
   │                                                          │
   │   nnTick (async)  ←  ONNX 推論(批次,各 difficulty 一組)│
   │   updateAI         ←  非 NN 敵方狀態機                   │
   │   updateBullets    ←  子彈軌跡 + 命中(含結構/重生點)    │
   │   updateMission    ←  當前 mission factory 的 update()   │
   │     └─ updateStructures (line 1230) — 16 模塊行為        │
   │     └─ updateAirstrikes / smoke / tesla / EMP / drones   │
   │     └─ +energy 0.5/sec(任何 NN 模式)                    │
   │                                                          │
   └──────────────────────────┬───────────────────────────────┘
                              ▼
                     ┌─────────────────┐
                     │  render() 9782  │
                     ├─────────────────┤
                     │ 1. world bg     │
                     │ 2. footprints   │
                     │ 3. spawn beacons│
                     │ 4. structures   │
                     │ 5. smoke clouds │
                     │ 6. tesla bolts  │
                     │ 7. EMP pulses   │
                     │ 8. auto-drones  │
                     │ 9. airstrikes   │
                     │ 10. units (chassis dispatcher)  │
                     │ 11. bullets / explosions        │
                     │ 12. HUD overlay (canvas)        │
                     └─────────────────┘
```

主迴圈(line 12928)用 **時間累積器**:`_timeScale<1` 時不每 frame 都呼叫 update,實現連殺慢動作。

---

## 6. NN 推論架構 / NN Inference

- **入口**:`async function nnTick()` line ~5033
- **執行頻率**:每幀都呼叫,但 `_nnInferring` 旗標避免重疊
- **批次策略**:同 difficulty 的所有 NN 單位打包成一個 batch 跑(blue + red 各自)
- **輸入向量**:30+ 特徵(自身 HP/位置/速度、4 隊友 + 4 敵人相對位置/HP/可見性、bullet 威脅...),`obsBuf` 的對應在 `combat_env.py` 訓練端
- **輸出**:8 維連續動作(move x/y、aim x/y、fire、reload、grenade、sprint),sigmoid/tanh 解碼
- **載入**:`nnLoadAll([tiers...])` 並行抓所有需要的 .onnx,首次 lobby 進入時觸發

擴充點:加新 difficulty → 加 .onnx 檔到 `ai_arena/onnx/` + 加進 `NN.modelPaths` + 加進 `_DIFF_LABELS_*` + lobby 加按鈕。CQB 模型就是這條路徑,30 行內完成。

---

## 7. Mission Factory 模式 / Mission Factories

每種模式是一個工廠函式 `MISSION_FACTORIES.{key}(mapDef)`,回傳:

```js
{
  title, titleEn, objective,
  update(),                     // 每 tick 呼叫
  isComplete() / isFailed(),    // 回傳布林,觸發勝/敗 UI
  renderHUD(),                  // 任務專用 HUD
  onPlayerBulletHit(b) / onEnemyBulletHit(b),  // 可選:特殊命中物件
  // 額外方法:
  tryRevive() canRevive() trySkipWave() canSkipWave() getRunSummary()
}
```

| Factory | 用途 | 特色 |
|---|---|---|
| `nnDeathmatch` | DM 對抗 | 先到 12 殺 / 90s 多殺者勝 |
| `nnSurvival` | 生存 | 8 個 wave_tiers 配方,死了不復活 |
| `nnDefense` | 邊打邊建 | spawn beacons + 能源 + 16 模塊 |
| `nnHelo` | 直升機撤離 | 60s 守 LZ + 6s 降落 + 3s 起飛 |
| `nnConvoy` | UGV 護送 | UGV 沿路前進、被打爆任務失敗 |
| `escort` / `capture` / `destroyHive` / `recover` / `heavyInsert` / `hold` / `skirmish` | 舊 campaign | 待重整或併入 NN modes |

擴充新模式 → 加一個 factory + lobby 按鈕 + `startNNSkirmish` routing。約 100-200 行。

---

## 8. 結構系統 / Structure System

定義:`STRUCTURE_DEFS = { kind: { cost, hp, size, blocks, blocksLOS, ...kindFields } }` (line 1070)
順序:`STRUCTURE_ORDER`(radial wedge 順序 + 1-9/0 hotkey 對應)

目前 16 個:

| 類別 | 模塊 | 成本 | HP | 特色 |
|---|---|---:|---:|---|
| 防禦 | cover / wall / bunker | 18/30/70 | 60/100/260 | 三階梯 + line-drag |
|  | sensor | 30 | 30 | passive intel ping |
|  | camera | 60 | 40 | shared vision +360u |
| 進攻 | turret | 100 | 80 | autoaim 380u, 25 dmg/sec |
|  | tesla | 140 | 70 | chain 4 enemies |
|  | dronebay | 200 | 80 | autonomous FPV swarm |
| 後勤 | generator | 80 | 50 | +1⚡/sec 疊加 |
|  | medstation | 100 | 50 | +4 HP/sec 範圍治療 |
| 騷操作 | mine / tripmine | 40/70 | 1/1 | 1-shot AOE trap |
|  | smoke | 70 | 50 | 周期煙幕擋 LOS |
|  | emp | 130 | 60 | stun 範圍 NN 3s |
|  | terminal | 200 | 60 | shift+click 空襲 |
|  | bot | 180 | — | 部署 NN 隊友 |

擴充新結構 → 加一個 `STRUCTURE_DEFS.X` + `updateStructures` 一個 case + `renderStructures` 一個 case + 加進 `STRUCTURE_ORDER`。新模塊約 60 行。

特殊 helper:`isWallKind(kind)` 判斷哪些可以拉線(目前是 cover/wall/bunker 三個)。

---

## 9. 持久化 / Persistence (localStorage)

| Key | 內容 | 寫入點 |
|---|---|---|
| `ag.lang` | 'zh' / 'en' | setLang() |
| `ag.muted` | '0' / '1' | 暫停選單音量按鈕 |
| `ag.aimAssist` | '0' / '1' | V 切換 |
| `ag.minimapCollapsed` | '0' / '1' | 點 minimap header |
| `ag.tutorialSeen` | '1' | 首次點 GOT IT |
| `ag.lobbyConfig` | JSON | lobby 任何選擇 |
| `ag.editorSlots` | int 3-5 | 解鎖地圖槽位 |
| `ag.customMaps` | JSON 多槽 | editor save |
| `ag.customMap` | JSON 單槽 | legacy mirror |
| `ag.stats` | JSON 全域 | 每場結算 |
| `ag.survivalScores` | top 10 | survival 結束 |
| `ag.defenseScores` | top 10 | defense 結束 |

擴充:全部走 `ag.{key}` namespace,任何新功能都套這套。

雲端介面:`uploadSurvivalRun(run)` 是 stub,真接 Firebase 時把這個函式換掉就生效。

---

## 10. 輸入抽象 / Input Layer

桌面 + 手機共用一個 INPUT 層,但分兩套監聽器:

**桌面**(line 2444):
- `keydown` / `keyup` → `keys[k]` map(WASD 拉去 update 用)
- `mousedown` → 觸發行動(射擊 / 放結構 / 點 radial / 點按鈕)
- `mousemove` → `mouse.x/y` + 拉線預覽
- `mouseup` → 提交拉線
- `contextmenu` → 右鍵取消建造

**手機**(line 3080):
- `touchstart/move/end` → 雙搖桿(左移右瞄)+ action button hit
- 拉線檢查在 `onMove`、提交在 `onEnd`(同模式)
- B 按鈕(右側 column 多了一顆)→ 開 radial

切換點:`touchInput.enabled` 自動偵測(`'ontouchstart' in window`)。

---

## 11. 渲染順序 / Render Order

`render()` line 9782 — 嚴格順序保證疊層正確。**世界座標**(translate + scale + rotate)和 **螢幕座標**(HUD)分兩段:

```
世界座標段:
  1. cream 背景
  2. world grid
  3. 地形 buildings + lowCovers + overheads
  4. 建造物 footprints / spawnBeacons / structures / smoke / tesla / EMP / drones / airstrikes
  5. 單位 enemies → allies → player(各自呼 drawHumanoid 派發 chassis)
  6. 子彈 + 手雷 + FPV
  7. 爆炸 + 槍口火焰 + 傷害浮字
螢幕座標段(restore):
  8. HUD(任務面板 / minimap / 觸控按鈕)
  9. 暫停選單(if paused)
```

Camera shake 在 `world translate` 之前 offset,只影響 viewport 不影響 HUD。

---

## 12. 擴充點清單 / Extension Points

**加新 NN difficulty**:
1. 訓練 → 匯出 ai_arena/onnx/model_X.onnx
2. `NN.modelPaths.X = 'ai_arena/onnx/model_X.onnx'`
3. `_DIFF_LABELS_ZH/EN.X = ...`
4. 加進 `STYLE_TIERS` / wave_tiers 配方
5. lobby 加 `<button data-diff="X">` + i18n entry

**加新結構**:
1. `STRUCTURE_DEFS.X = { cost, hp, size, ... }`
2. `STRUCTURE_ORDER.push('X')`
3. `updateStructures` 加一個 `if (s.kind === 'X') {...}` case
4. `renderStructures` 加一個 `else if (s.kind === 'X')` case

**加新 mission/mode**:
1. `MISSION_FACTORIES.X = function(mapDef) { return { update, isComplete, ... } }`
2. `startNNSkirmish` routing 加 `gameMode === 'X' ? 'X'`
3. lobby 加 mode 按鈕
4. modeLabel 字典加 X
5. (可選)地圖變體用 `modes: ['X']` 標記哪張可用

**加新地圖變體**:
1. `NN_MAP_VARIANTS.push({ id, name, walls: () => [...], spawn, modes })`
2. 自動進 `pickMapForMode(mode)` 抽選池

**加新武器**:
1. `WEAPONS.X = { fireCd, damage, ... }`
2. lobby weapon-pick 加 button + i18n
3. `_WPN_LABELS_ZH/EN.X` 加標籤

**加新 chassis**:
1. `CHASSIS.X = { speedMul, hpMul, radiusMul, label }`
2. `CHASSIS_ORDER.push('X')`
3. lobby 加 chassis-btn
4. drawHumanoid 派發加分支 + `_drawXChassis()` 函式

---

## 13. 已知技術債 / Tech Debt

- **單檔**:13K 行在一個 .html 裡,IDE 跳轉變慢、PR 衝突易發。長期可拆 ESM 模組,但會破壞「無打包」優勢。**短期不動**。
- **AI 訓練 ↔ 客戶端 obs vector 同步**:目前是手動對齊。任何欄位改動兩邊都要改,沒有 schema 檢查。
- **沒有單元測試**:依靠 `preview` 工具人工跑驗證。重構大膽度受限。
- **儲存沒有版本號**:`ag.*` 的 JSON 沒有 schema version,改格式會壞舊存檔。應加 `version` 欄位。
- **NN 推論在主執行緒**:重邏輯把幀拖慢時最先犧牲。可改 Web Worker(ort.js 支援)。

---

## 14. 部署管線 / Deployment

開發:**沒有 build step**。改 `index.html` → 重整就生效。
生產(itch / Cloudflare Pages):打包 `index.html + manifest + sw.js + icons/ + ai_arena/onnx/` 進一個 zip 上傳。
PWA:`sw.js` 快取核心檔,離線可玩。`manifest.webmanifest` 提供安裝到桌面/主畫面。

---

## 15. 路線圖對照 / ROADMAP Alignment

實際路線圖見 `ROADMAP.md`。本檔重點是**程式架構** — 路線圖重點是**待辦/已完成**。

當前未完成大項:
- AdMob `cosmetic_skin` 觸發點(等外觀系統)
- 雲端排行榜真接(Firebase config 還是 stub)
- iOS / Steam / 多人連線(Phase 5,長期)

---

> 寫給未來想接手的人:從 `index.html` 的 section header 入手,跟著本文件的 line 號就能跳到任何子系統。看不懂的東西先 grep `// ===`,再 grep 關鍵函式名(例如 `applyChassisToUnit`、`MISSION_FACTORIES.nnDefense`)。
