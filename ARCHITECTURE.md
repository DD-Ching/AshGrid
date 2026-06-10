# AshGrid 遊戲架構 / GAME ARCHITECTURE

最後更新:2026-06-10(Phase 159)。範圍:`index.html`(~6.7K 行)+ ~66 個 `js/*.js` 模組 + 授權式 PartyKit 伺服器(`server/party/`)+ ONNX/PPO 模型 + PWA 殼。
中英對照:每節中文標題後括號是英文錨點,方便 grep。

> ⚠️ 架構已從「單檔 ~13K/17K 行 index.html」演進為**模組化 + 三層線上對戰**。
> 本檔已重寫舊的「零後端 / 單檔行號表」段落。導航請 grep 模組名(`js/multiplayer.js`、
> `js/arena_recruitment.js`、`server/party/server.js`)或 `// ========` section header。

---

## 1. 一句話摘要 / Overview

AshGrid 是一款**線上 PvP .io 遊戲**,核心是 60FPS 的 2D 俯視戰術射擊,**真正的權威式多人伺服器**(PartyKit / Cloudflare Workers + Durable Objects)。

**產品定位**:`ashgrid.io`(已購域名)是主要營收產品 —— 部署在線上的多人對戰版本。同時也發行於 **CrazyGames**(廣告營收)與一個 **GitHub Pages 鏡像**。SOLO / 本地單機仍可玩,但 .io 線上產品是優先級最高的。

三大特色:

1. **NN 對抗** — PPO 訓練的策略驅動敵我雙方。客戶端用 ONNX(`ort.js`)推論;**伺服器端用純 JS 前向傳播**(`server/party/sim/nn_runtime.js`,無 onnxruntime 依賴)跑權威 bot。多種風格(elite/warrior/defensive/sharpshooter/cqb/tactical)。
2. **Arena 招募(核心進度迴圈)** — 打傷敵方 NPC → 走近 → 按 `G` → 它轉投你的小隊變成為你而戰的 bot(wings.io 風格)。受 **SEED 技能差**(差距 > 10,`ARENA_SEED_GAP`)閘控。**SOLO 與線上 MP 都可用**(MP 在 Phase 159 接好:`js/arena_recruit_mp.js` + 伺服器 `recruit` handler + `recruitOk` 廣播)。
3. **建造系統 + NN 模式 + 戰役任務** — 16 種防禦/進攻/後勤模塊;NN Skirmish(DM / Survival / Defense / Helo / Convoy / Duel / Sniper)走 NN 對抗,Campaign 走手工任務工廠。

部署:GitHub Pages(`main` 自動部署)、Cloudflare Pages(`ashgrid.io`)、CrazyGames(手動 zip);MP 伺服器**獨立** `partykit deploy`。詳見 §14。

---

## 2. 檔案結構 / File Layout

```
AshGrid/
├── index.html              ← 主檔(~6.7K 行)。HTML + CSS + 啟動膠水 + 一部分仍 inline 的邏輯。
│                              核心熱點已抽到 js/*.js;<script src> 標籤在 <head>。
├── js/                     ← ~60 個 classic-script 全域模組(無打包工具,plain <script src>)
│   ├── (見 §3 模組地圖)
│   ├── audio/              ← positional / narrative / ambient / sfx
│   └── missions/           ← nn_deathmatch.js / nn_arena_variants.js
├── server/party/           ← PartyKit 權威伺服器
│   ├── server.js           ← Durable Object:30H+ 權威 sim、bullets、命中、快照(~1710 行)
│   └── sim/                ← 與客戶端對齊的 sim:weapons / bullet / movement /
│                              nn_obs / nn_runtime / nn_weights_elite / constants
├── tools/                  ← version.js(版本戳/完整性)、check_sim_parity.js、githooks/pre-commit
├── .github/workflows/      ← pages.yml(→ GitHub Pages)、checks.yml(CI 閘)
├── manifest.webmanifest    ← PWA 設定
├── sw.js                   ← Service Worker(離線快取;ASSETS 由 version.js check)
├── _headers / _redirects   ← Cloudflare Pages 慣例(ashgrid.io)
├── scripts/build-zip.sh    ← 打包 CrazyGames 上傳用 zip
├── icons/                  ← PWA icon 套
├── ai_arena/onnx/          ← 訓練好的客戶端模型(model_*.onnx)+ 訓練 notebook
├── assets/                 ← 音效 / 圖片
├── ROADMAP.md / DEPLOY.md / README.md / CLAUDE.md
└── ARCHITECTURE.md         ← 本文件
```

> 無打包工具(no bundler):全部是 plain `<script src="js/...js?v=NNN">`,以 `?v=` query 做 cache-bust(目前 **v210**)。新模組 → 在 `<head>` 加一行 `<script src>` + `node tools/version.js stamp` 重新戳版本。

---

## 3. 模組地圖 / Module Map

熱點 state 抽進獨立模組(對應 `CLAUDE.md` 的熱點/重構表 R1–R14)。「指標不是 index.html 多短,是同一塊 state 有幾個地方能寫」—— 以下每塊都是單一寫入點:

| 模組 | 角色 |
|---|---|
| `js/input.js` | Input 層:`mouse.*` / `keys[]` / hit-rect / 觸控(R2) |
| `js/touch_input.js` | 雙搖桿 + 觸控按鈕 + radial + 拉線觸控 |
| `js/key_bindings.js` | 鍵位對應 |
| `js/weapon_state.js` | 武器 state:swap / fire / reload / cd(R3) |
| `js/weapons.js` / `js/weapon_drop.js` | 武器資料表 / 掉落拾取 |
| `js/ad_state.js` `js/ad_dispatch.js` `js/ad_slots.js` `js/banner_gate.js` `js/adblock_notice.js` | 廣告生命週期 + 派發 + 觸發點(R1)。詳見 §13 |
| `js/crazygames.js` | CrazyGames SDK 整合(loading / gameplay / happytime / rewarded / midgame) |
| `js/pawn_swap.js` | Pawn-swap state(手動 + 陣亡自動接管)(R4) |
| `js/player_lifecycle.js` `js/respawn_buff.js` `js/death_recap.js` `js/death_decider.js` | 玩家生死週期 / 重生 buff / 死亡回顧 / 死因裁決 |
| `js/bullets.js` | 子彈 update + 碰撞(含結構/重生點)(R5) |
| `js/grenades.js` | 手雷 + 滾動爆炸 |
| `js/world_render.js` | World render(renderWorld / lowCovers / overheads / footprints)(R6) |
| `js/world_gen.js` | World 生成 helper(addBuilding / addLowCover / addWallLine ...)(R7) |
| `js/render_overlays.js` | Overlay render(結構 / 主題 / 地標 / FPV/UAV/CMD overlay / 單位 sprite)(R10) |
| `js/render_frame.js` | 單一 frame owner + FX layer registry(`registerFxLayer`);FX 在 update() tick、render() 只 dispatch |
| `js/killstreak_fx.js` `js/recruit_fx.js` `js/danger_fx.js` | 透過 FX registry 註冊的視覺層 |
| `js/hud.js` | HUD driver + cache + helpers(R8) |
| `js/enemy_ai.js` | 非 NN 敵方 AI + NN runtime 入口 + updateEnemies(R9) |
| `js/squad.js` `js/squad_commands.js` | 隊友 AI + 指令 |
| `js/drone_fpv.js` | UAV 偵察 + FPV 自殺機 |
| `js/structures.js` | `STRUCTURE_DEFS` + 放置 + tick(成本讀 `BALANCE`) |
| `js/defense_build_ui.js` | 建造 radial / 觸控 UI |
| `js/chassis.js` | humanoid / wolf / heavy 三型體 + `applyChassisToUnit` |
| `js/camera.js` | 跟隨 + 邊界 + 模式切換 |
| `js/vision_raycast.js` | `lineOfSight()`(牆 + 煙霧 + 結構) |
| `js/multiplayer.js` | **MP 客戶端**:WebSocket、輸入送出、快照渲染(~1741 行) |
| `js/mp_reconcile.js` | **hybrid-player**:本地預測 + 伺服器調和(reconcile / replay) |
| `js/arena_recruitment.js` | Arena 招募(SOLO,掃 `enemies[]`)+ 回收(`ARENA_RECYCLE_ENERGY`) |
| `js/arena_recruit_mp.js` | Arena 招募(線上,掃 `_mpState.remoteBots`,送 `recruit`) |
| `js/leaderboard.js` `js/leaderboard_seed.js` | **Firebase RTDB 全球排行榜**(REST,見 §10) |
| `js/balance.js` | 單一 `BALANCE` 設定(energy 經濟 + buildCost) |
| `js/kill.js` | 統一死亡 chokepoint:`killUnit()` + `onUnitDeath()` |
| `js/global_stats.js` `js/run_history.js` | 全域統計 / 跑局歷史(含 `uploadSurvivalRun` no-op stub) |
| `js/i18n.js` | `T(zh, en)` + 翻譯字典 |
| `js/maps.js` `js/missions/*` | 地圖表 + NN 任務工廠 + 競技場地圖變體 |
| `js/audio/*` | positional / narrative / ambient / sfx |
| 其它 | `achievements` `progressive_unlock` `mote_affinity` `stage_hints` `intro_narrative` `dynamic_radio` `operators_log` `bot_names` `audio_mute` `pause` `tod` `audit_console` |

> 仍 inline 在 `index.html` 的主要是:啟動 / lobby 膠水、`game` / `player` / `_lobby` 全域宣告、`update()` 主邏輯迴圈、部分 mission routing。改動前先 grep 確認該塊 state 還有誰在寫(見 `CLAUDE.md` 紀律)。

---

## 4. 三層線上架構 / Three-Layer MP Architecture

線上對戰是 wings.io / agar.io / krunker.io 風格的**權威式伺服器**(authoritative server),**不是** broadcast relay,**也不是** Trystero/WebRTC P2P —— P2P 在 **Phase 33 已被替換掉**(P2P 是錯的工具,真正的 .io 用授權伺服器)。

```
┌──────────────────────────────────────────────────────────────┐
│  NN-client (60fps render + prediction)   js/multiplayer.js     │
│   • 讀 input → 組 {dx,dy,angle,fire,seq} → 30Hz 送 WS          │
│   • 本地預測自己的移動(即時手感)                              │
│   • 快照插值渲染遠端玩家 / bullets(MP_INTERP_DELAY ≈150ms)   │
└───────────────────────────┬──────────────────────────────────┘
                            │  WebSocket(JSON 協定)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  PvP-server (權威 sim)            server/party/server.js        │
│   PartyKit · Cloudflare Workers + Durable Objects               │
│   • 一個房間 = 一個 Durable Object(setInterval tick)         │
│   • 內部 200Hz tick;每 6 tick 廣播一次 → ~33Hz delta 快照     │
│     (header 註解寫 20Hz;區間 20–33Hz)                        │
│   • 伺服器端 NN bot 推論(純 JS 前向,elite 權重)             │
│   • 伺服器持有 bullets、HP、死亡、重生                         │
│   • lag-compensated 命中:fire 時把目標 rewind 到 (vT−interp) │
│     「favor the shooter」—— 你看到的位置打中就算中             │
│   • Arena 招募:re-check 每個 gate → bot.team→0 → 廣播 recruitOk│
└───────────────────────────┬──────────────────────────────────┘
                            │  snapshot {tick, players, bullets, sT}
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  hybrid-player (預測 + 調和)        js/mp_reconcile.js          │
│   • 快照到達 → snap 到伺服器真值                               │
│   • replay 自 lastInputSeq 以來所有未確認 input                │
│   • 本地預測與伺服器漂移時平滑收斂                             │
└──────────────────────────────────────────────────────────────┘
```

Host 解析(`js/multiplayer.js` `_mpResolveHost`):`?ws=` URL 參數 → `window.MP_PARTYKIT_HOST` → localhost 自動偵測(`npx partykit dev`)→ `PRODUCTION_HOST = 'ashgrid-mp.dd-ching.partykit.dev'`。

> **bug 聚集在這三層的邊界**(NN-client 60fps ↔ PvP-server 20–33Hz ↔ hybrid-player reconcile)。改 MP 前先確認該塊 state 在三層各由誰寫。客戶端與伺服器各帶一份 weapon 物理 + NN obs layout,由 `tools/check_sim_parity.js` 確保不漂移(見 §12)。

協定摘要(完整見 `server/party/server.js` 頂端):
- client→server:`input`(seq/dx/dy/angle/fire/vT)、`build`、`explosionRequest`、`recruit`、`emote`、`ping`
- server→client:`welcome`、`snapshot`、`hit`、`kill`、`wallHit`、`structureAdd/Hit/Gone`、`recruitOk`、`leave`

---

## 5. 主要狀態物件 / Top-Level State

### `game` — runtime 全局
```
state         'menu' | 'playing' | 'editor'
mode          'tactical' | 'drone' | 'fpv' | 'command'
_nnMode       true 表示在 NN 戰場
_nnGameMode   'dm' | 'survival' | 'defense' | 'helo' | 'convoy' | 'duel' | 'sniper'
time          tick 計數(60/s)
score / killCount / deaths
shakeMag/Until 相機晃
_timeScale    慢動作速率(1.0 正常 / 連殺爆發放慢)
_paused       暫停旗標
_energy       建造能源(NN 模式都有;見 BALANCE.energy)
_structures   已放結構 [{kind,x,y,hp,sid,...}]
_smokeClouds / _teslaBolts / _empPulses / _autoDrones / _airstrikes
_spawnBeacons 敵方重生點(Defense)
_footprints   足跡追蹤
```

### `player` — 玩家
- 座標 / HP / 武器 / 彈匣 / 庫存;`_drawX/_drawY`(render 插值,Phase 154 平滑移動)
- `_chassis`(humanoid/wolf/heavy)、`_aimAssist`(自動瞄準)
- `_killStreak` / `_killer` / `_lastDamageBy`(連殺 + 死因)
- `_seed`(SEED 技能值,決定 Arena 招募閘)

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

### `_mpState` — MP 客戶端(`js/multiplayer.js`)
- `enabled` / `ws` / `myId` / `serverTick` / `roomName`
- `remotePlayers`(peerId → 快照,含插值 target)
- `remoteBots`(伺服器 NN bot,Arena 招募 MP 的掃描來源)
- 伺服器 bullets(快照外推平滑)

### `NN` — 客戶端模型狀態
- `modelPaths.{tier}` 對應 `.onnx`、`sessions[tier]` 載入後 session、`loaded` / `error`

---

## 6. NN 推論架構 / NN Inference

**客戶端**(SOLO + 渲染側):
- 入口 `nnTick()`,每幀呼叫;`_nnInferring` 旗標避免重疊
- 批次:同 difficulty 的 NN 單位打包成一個 batch(blue / red 各自)
- 輸入向量:30+ 特徵(自身 HP/位置/速度、隊友 + 敵人相對位置/HP/可見性、bullet 威脅…),對齊訓練端
- 輸出:PPO 動作層(move dir + fire 等),解碼成單位指令
- 載入:`nnLoadAll([tiers...])` 並行抓所需 `.onnx`,首次進 lobby 觸發

**伺服器端**(權威 bot,`server/party/sim/`):
- **不依賴 onnxruntime** —— `nn_runtime.js` 的純 JS `createNet()` 前向傳播,`server.js` 載入時跑一次,用 elite checkpoint 權重(`nn_weights_elite.js`;其餘 checkpoint 可熱換)
- `nn_obs.js` `buildObs()` 建 obs 向量;動作 = `moveDir*2 + fireBit`(9 方向)

> 客戶端 obs layout 與伺服器 `buildObs()` 長度必須一致(`OBS_DIM`),由 `tools/check_sim_parity.js` 在 CI 斷言。

擴充新 difficulty(客戶端):訓練 → 匯出 `ai_arena/onnx/model_X.onnx` → `NN.modelPaths.X` → `_DIFF_LABELS_*` → lobby 按鈕 + i18n。

---

## 7. Mission Factory 模式 / Mission Factories

每種模式是一個工廠函式 `MISSION_FACTORIES.{key}(mapDef)`,回傳:

```js
{
  title, titleEn, objective,
  update(),                     // 每 tick
  isComplete() / isFailed(),    // 觸發勝/敗 UI
  renderHUD(),                  // 任務專用 HUD
  onPlayerBulletHit(b) / onEnemyBulletHit(b),  // 可選
  tryRevive() canRevive() trySkipWave() canSkipWave() getRunSummary()
}
```

| Factory | 用途 | 特色 |
|---|---|---|
| `nnDeathmatch` | DM 對抗 | 先到目標殺數 / 限時多殺者勝 |
| `nnSurvival` | 生存 | wave_tiers 配方,死了不復活 |
| `nnDefense` | 邊打邊建 | spawn beacons + 能源 + 16 模塊 |
| `nnHelo` | 直升機撤離 | 守 LZ + 降落 + 起飛 |
| `nnConvoy` | UGV 護送 | UGV 沿路前進、被打爆任務失敗 |
| `escort` / `capture` / `destroyHive` / `recover` / `heavyInsert` / `hold` / `skirmish` | 舊 campaign | 手工任務 |

擴充新模式 → 加 factory + lobby 按鈕 + `startNNSkirmish` routing + modeLabel + 地圖變體 `modes` 標記。

---

## 8. 結構系統 / Structure System

定義:`STRUCTURE_DEFS = { kind: { cost, hp, size, blocks, blocksLOS, ...kindFields } }`(`js/structures.js`)。成本由 `BALANCE.buildCost` 注入(見 §12)。
順序:`STRUCTURE_ORDER`(radial wedge + 1-9/0 hotkey)。

目前 16 個模塊(防禦三階梯 cover/wall/bunker + sensor/camera + turret/tesla/dronebay + generator/medstation + mine/tripmine/smoke/emp/terminal/bot)。發電機範圍 + 牆線 BFS 連鎖供電。

擴充新結構 → `STRUCTURE_DEFS.X` + `BALANCE.buildCost.X` + `STRUCTURE_ORDER` + `updateStructures` case + `renderStructures` case(約 60 行)。可拉線的 kind 由 `isWallKind()` 判斷(cover/wall/bunker)。

> 在 MP 中結構是伺服器權威的(`build` / `structureAdd` / `structureHit` / `structureGone` 協定,以客戶端產生的 `sid` 為身分鍵)。

---

## 9. 持久化 / Persistence (localStorage)

| Key | 內容 | 寫入點 |
|---|---|---|
| `ag.lang` | 'zh' / 'en' | setLang() |
| `ag.muted` | '0' / '1' | 暫停選單音量 |
| `ag.aimAssist` | '0' / '1' | V 切換 |
| `ag.minimapCollapsed` | '0' / '1' | minimap header |
| `ag.tutorialSeen` | '1' | 首次 GOT IT |
| `ag.lobbyConfig` | JSON | lobby 選擇 |
| `ag.editorSlots` / `ag.customMaps` / `ag.customMap` | 地圖編輯 | editor save |
| `ag.stats` | JSON 全域 | 每場結算 |
| `ag.survivalScores` / `ag.defenseScores` | top 10 | 模式結束 |
| `ag.lbStats` | JSON 排行榜本地鏡像 | `_lbSaveLocal()`(`js/leaderboard.js`) |
| `ag.playerId` | 玩家 UUID(排行榜) | `_lbInit()` |

擴充:全部走 `ag.{key}` namespace。

---

## 10. 雲端後端 / Cloud Backend

本專案**有**雲端後端(因此舊文件的「零後端」說法是錯的)。兩個獨立後端:

### A. Firebase Realtime Database — 全球排行榜(Phase 23 起)
`js/leaderboard.js`:**真實 REST 讀寫**(不是 stub)。
- `PUT /leaderboard/<uuid>.json` 上傳本地計數(kills/deaths/bestStreak/matches),debounce + throttle(`LB_PUSH_THROTTLE_MS = 8000` ≈ 每 8 秒),並在 `pagehide`/`beforeunload` 收尾。
- `GET /leaderboard.json` 抓全榜,客戶端排序取 top N,快取 30 秒(`LB_FETCH_CACHE_MS`)。
- RTDB host:`ashgo-1bfec-default-rtdb.asia-southeast1.firebasedatabase.app`。無 SDK、無 auth —— client-authoritative(任何人能 PUT 假數字),v1 可接受。
- 本地 `ag.lbStats` 鏡像確保斷網時進度不倒退。

> ⚠️ **營運警告**:RTDB 安全規則是時間盒(`".read"/".write": "now < 1781100000000"`,到 **2026-06-10 14:00 UTC**(今天)過期)。過期後讀寫全被擋。到期前到 Firebase Console 把規則改成永久 `true`(或加上真正的驗證)。詳見 `DEPLOY.md`。

### B. PartyKit 權威伺服器 — 線上對戰(見 §4)
`server/party/server.js`,Cloudflare Workers + Durable Objects。獨立部署(`cd server && npx partykit deploy`)。

### 唯一剩下的 stub
`uploadSurvivalRun(run)`(`js/run_history.js`)是 no-op,等真接(Firestore / Cloud Functions)。

---

## 11. 渲染與主迴圈 / Render & Main Loop

`render_frame.js` 是單一 frame owner。世界座標段(translate + scale + rotate)與螢幕座標段(HUD)分開:

```
世界座標段:
  1. 背景 + world grid
  2. 地形 buildings + lowCovers + overheads(world_render.js)
  3. footprints / spawnBeacons / structures / smoke / tesla / EMP / drones / airstrikes
  4. 單位 enemies → allies → player(drawHumanoid 派發 chassis)
  5. 子彈 + 手雷 + FPV
  6. 爆炸 + 槍口火焰 + 傷害浮字
  7. FX layers(透過 registerFxLayer 註冊;killstreak / recruit / danger)
螢幕座標段(restore):
  8. HUD(任務面板 / minimap / 觸控按鈕 / 結算卡)
  9. 暫停選單(if paused)
```

主迴圈用 rAF + 時間累積器:固定步長 update + render 插值(`player._drawX/_drawY`)→ 任何更新率都平滑捲動(Phase 154–155)。相機晃在 world translate 之前 offset,不影響 HUD。FX 的狀態在 `update()` tick,`render()` 只 dispatch —— **不要**在 render() 手接 FX(見 `CLAUDE.md` movement smoothness 紀律)。

---

## 12. 維護基礎建設 / Maintenance Infra

避免「同一個數字散在多處」「改了 JS 忘記 cache-bust」「客戶端/伺服器漂移」三類回歸:

| 工具 | 作用 |
|---|---|
| `js/balance.js`(`BALANCE`) | 單一 balance 設定:`energy.*`(regen + 各 event 獎勵)、`buildCost.*`(結構成本)。必須在 `structures.js` / `arena_recruitment.js` 之前載入 |
| `tools/version.js` | `stamp [N]`:把所有 js `?v=` 與 sw.js cache name 設為同一版;`check`:每個 `<script src>` 檔存在 + git-tracked + 同一版 + sw.js ASSETS 存在(Phase 142) |
| `tools/check_sim_parity.js` | SOLO(客戶端 60fps)↔ MP(伺服器)weapon 物理 + NN obs 對齊斷言(Phase 143) |
| `js/kill.js` | 統一死亡 chokepoint:`killUnit()` + `onUnitDeath()` |
| `tools/githooks/pre-commit` | 本地閘:js syntax + version check + parity |
| `.github/workflows/checks.yml` | CI 鏡像同樣三檢(push 到 `dev` + `main`、PR):`node --check` 全 js、`version.js check`、`check_sim_parity.js`。無需 `npm install` |

---

## 13. 廣告 / Ads

| 平台 | 狀態 |
|---|---|
| **CrazyGames SDK** | **完整整合**(`js/crazygames.js`):loading / gameplay / happytime 生命週期 + rewarded + midgame interstitial |
| AdMob / GameMonetize | stub,等憑證 |

**Rewarded 觸發點**:小隊全滅復活(SQUAD REVIVE)。
> ⚠️ 程式裡還有一個建造期 / skip-wave 的 rewarded surface,但**目前是 dead code**,不要當作可用功能列出。

派發在 `js/ad_dispatch.js`(provider 註冊 + 優先序);非 CrazyGames 環境時 rewarded fail-open(透過 dispatch stub)。

---

## 14. 部署管線 / Deployment

開發:**沒有 build step**。改檔 → 重整就生效(本地測 MP 用 `cd server && npx partykit dev` + `?mp=1`)。

| 目標 | 機制 |
|---|---|
| **GitHub Pages 鏡像** | `.github/workflows/pages.yml` —— push 到 **`main`** 自動部署整個 repo(無 build step)。(原本錯設在已刪除的 arena-mp 分支,Phase 158 修正) |
| **`ashgrid.io`(Cloudflare Pages)** | 用 `_headers` + `_redirects` 慣例 |
| **CrazyGames** | `scripts/build-zip.sh` 手動打包 zip 上傳 |
| **MP 伺服器** | **獨立** `cd server && npx partykit deploy` → `ashgrid-mp.dd-ching.partykit.dev`。**不**和靜態站一起打包 |

PWA:`sw.js` 快取核心檔離線可玩;`manifest.webmanifest` 提供安裝。每次 deploy 前 `node tools/version.js stamp` 統一 cache-bust。

---

## 15. Git Workflow

- **在 `dev` 分支開發**;完成後 `merge dev → main`。
- **嚴禁直接 commit / push 到 `main`** —— `main` 只接受從 `dev` 的 merge。
- CI(`checks.yml`)在 `dev` + `main` 都跑;`main` push 額外觸發 GitHub Pages 部署。

---

## 16. 已知技術債 / Tech Debt

- **AI 訓練 ↔ 客戶端/伺服器 obs vector 同步**:三邊(訓練端 / 客戶端 / 伺服器 sim)手動對齊。`check_sim_parity.js` 守客戶端↔伺服器,但訓練端欄位改動仍需人工同步。
- **沒有單元測試**:依靠 parity check + 人工在 Chrome 跑驗證(MP 尤其要實測 `?mp=1`,本地單機幾乎不會壞)。
- **儲存沒有版本號**:`ag.*` JSON 無 schema version,改格式會壞舊存檔。
- **排行榜 client-authoritative**:任何人可 PUT 假數字;有營收後需換 Cloud Functions + per-uuid 簽核。
- **`index.html` 仍有 inline 邏輯**:啟動膠水 + `update()` 主迴圈尚未抽淨;新功能預設寫新 `js/<feature>.js`(見 `CLAUDE.md`)。
- **build 機制平衡缺口**:能源回充慢、對局太短,實戰中玩家難用上 Build;待下次 balance pass(見 MEMORY)。

---

## 17. 路線圖對照 / ROADMAP Alignment

實際路線圖見 `ROADMAP.md`、部署細節見 `DEPLOY.md`。本檔重點是**程式架構**。

當前主要待辦方向:
- AdMob / GameMonetize 接憑證(目前 stub)
- `uploadSurvivalRun` 真接雲端(唯一剩的 cloud stub)
- 建造迴圈平衡 pass
- Firebase RTDB 規則到期延長(營運動作,見 §10 警告)

---

> 寫給未來接手的人:從 §3 模組地圖入手 —— 每個熱點 state 都有單一寫入模組,改之前先 grep 確認沒人在別處戳同一塊。MP 相關的 bug 先看三層邊界(§4):`js/multiplayer.js`(客戶端)/ `server/party/server.js`(權威)/ `js/mp_reconcile.js`(調和)。
