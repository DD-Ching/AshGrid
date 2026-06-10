# 上架路線圖 / RELEASE ROADMAP

最後更新:2026-06-10(Phase 159)。AshGrid 已從「單機 .io demo」轉成 **線上 PvP .io 產品**:PartyKit 權威伺服器、競技場招降(SOLO + 線上)、Firebase 即時排行榜、CrazyGames SDK 全接。我自主執行 — 進度在 commits、需你動作的標 🔑。

> **產品定位 / PRODUCT**:主打 **線上多人 PvP .io**。`ashgrid.io`(已買域名)是首要營收產品(部署線上 MP);同時上 **CrazyGames**(廣告營收)與 **GitHub Pages** 鏡像。SOLO / 單機仍在,但 **線上 .io 優先**。

> **核心循環 / CORE LOOP**:**競技場招降(arena recruitment)** — 打傷敵方 NPC → 走近 → 按 **G** → 它轉成你方小隊(替你作戰的 bot)。這是 **唯一的成長循環**(wings.io 風格),由 **SEED 技能差**(> 10,`ARENA_SEED_GAP`)把關。SOLO 與線上 MP **都能用**(MP 在 Phase 159 接通:`js/arena_recruit_mp.js` + server `recruit` handler + `recruitOk` 廣播)。

## 階段 0:現況
- ✅ 核心玩法穩定(6 NN 風格、aim-assist、pawn-swap、多模式、21 NN 地圖變體 + 5 戰役地圖)
- ✅ 桌面 + 手機瀏覽器體驗完整
- ✅ PWA 可安裝,offline 玩(SW 預快取所有 brain)
- ✅ **線上多人(PartyKit 權威伺服器)上線** — 見階段 6
- ✅ **競技場招降(SOLO + 線上 MP)上線** — 核心成長循環

## 階段 1:手機可玩(我先做)
- [x] 觸控操作(雙搖桿 + 自動射擊預設 ON)— 45822da
- [x] HUD 縮放適配 portrait + landscape — 下一個 commit
- [x] Lobby 響應式(小螢幕單欄)— 2fbc9fa
- [x] PWA manifest(可加桌面)+ Service Worker 離線 — 13916ae
- [x] 首次教學(教 swap + aim-assist)— c96a93f
- [x] 本地 Survival 排行榜(localStorage)— c969132

**階段 1 完成 ✅**

## 階段 2:內容 / 樂趣
- [x] 直升機撤離任務(Helo Extract)— 1302179
- [x] 物資護送任務(UGV Convoy)— 3a901e5
- [x] 多方向 spawn(survival 進階波)— a147e9c
- [x] 森林地圖(UAV 看不穿樹冠)— 911a254
- [x] 背景音樂(ambient loop × 2-3)— 6b3db0a
- [x] 玩家蓋碉堡 phase(survival 波間)— 下一個 commit

**階段 2 完成 ✅**(注意:build / energy 經濟在實戰仍不可用,見階段 7「核心缺口」)

## 階段 2b:國際化 / 賣相
- [x] 設定列中/EN 切換 + 持久化 — 93f8aa5(預設 EN,可切回中)
- [x] Canvas HUD 全 i18n(暫停 / 結算 / 排行榜 / 補給 / 任務)— c7107c5
- [x] 起始畫面 EN 預設 + cover image EN — c7107c5
- [x] SHARE RUN 按鈕(navigator.share / 剪貼板)— 0e7a8f5

## 階段 2c:Defense 模式 — 邊建造邊抵禦
- [x] 核心 Defense mode + 6 基礎模塊(牆/炮塔/發電機/監視/機器人/終端)— 2b0feda
- [x] 牆兩點成一線(Bresenham 拉繪)— 314334c
- [x] Radial selector 取代底部條 — aad749e
- [x] 火箭炮武器(可破壞建築) + 敵方重生點 + 30u 細格 — c3b3ab1
- [x] CQB 衝鋒模型(第 5 種風格)— febedd1
- [x] Camera shake + killstreak slow-mo — 3d7f784
- [x] End-of-match S/A/B/C/D 評級 — 7ef1ded
- [x] 進階模塊:特斯拉(鏈電)/ EMP / 醫療站 / 蜂群 — 262208b ~ dd6f63e
- [x] 觸控 radial picker + 行動 B 鍵 — 09ca308 / 963b194
- [x] Defense 獨立排行榜(與 Survival 分桶)— 已完成
- 隊伍人數上限 4 → 8

**階段 2c 完成 ✅**(16 模塊 / 6 NN 風格 / 完整觸控)

## 階段 3:雲端接點(我寫好,你補帳號)
- [x] Rewarded-ad 介面(`requestRewardedAd(id, cb)`,統一派發在 `js/ad_dispatch.js`)— 746ed8d
- [x] 排行榜接口 — 746ed8d 起;**已升級成真 Firebase RTDB,見階段 6**
- [x] 地圖編輯器 — 254788d / ddd356c(60u 格網 + 雙方 spawn)
- [x] 多槽位地圖編輯器(3 free,看廣告解鎖到 5)— 651bde4 / d9d419e

**階段 3 完成 ✅**

## 階段 3b:Rewarded-ad 觸發點
- [x] **squad / survival revive** — 死亡看廣告續命(`'revive'` / `'respawn_buff'`,`js/death_recap.js`)。團滅復活是目前**唯一真正在用**的 rewarded surface。
- [x] editor_extra_slots — d9d419e(地圖編輯器槽位 +2)
- [⚠️] **build_phase_extend / survival_skip_wave** — 程式碼存在(`index.html` + `js/touch_input.js` 的 hit-rect、`js/hud.js` 畫按鈕),**但目前是死碼**:`game._buildPhase` 在全 repo 從未被建立 / 啟動,所以那兩個按鈕在實戰永遠不會出現。**先別當成可用功能**(見階段 7 核心缺口 1)。
- [ ] cosmetic_skin(設定列已有 `data-coming="skin"` 鎖定佔位,外觀系統未做)

所有 rewarded 都走 `requestRewardedAd('reward_id', cb)`,由 `js/ad_dispatch.js` 依固定優先序派發給 provider。**CrazyGames SDK 已全接**(`js/crazygames.js`:loading / gameplay / happytime 生命週期 + rewarded + midgame interstitial),在 CrazyGames portal 上是真廣告。**AdMob / GameMonetize 仍是 stub**,等你給 ad unit ID 換掉即生效。

## 階段 4:🔑 你動作清單

| 動作 | 時間 | 費用 | 解鎖 |
|---|---|---|---|
| 0. **🔥 延長 Firebase RTDB 規則期限** | 30 秒 | 免費 | **緊急 / 週期性**:規則是時間限定 `".read/.write": "now < 1781100000000"`(**到 2026-06-10 14:00 UTC 過期**,即今天)。過期後即時排行榜的讀寫會被擋。到期前去 **Firebase Console** 把規則改掉(改永久 `true`,或往後展期)。**今天就要看**。 |
| 1. **CrazyGames** 開發者帳號 + 上架 | 30 分 | 免費 | 廣告營收(SDK 已接,上傳 zip 即可) |
| 2. **Cloudflare Pages** 接 `ashgrid.io` | 15 分 | 免費 | 正式域名(用 `_headers` + `_redirects` 慣例) |
| 3. **itch.io 註冊** + 上架 | 30 分 | 免費 | 作品集 / 額外曝光 |
| 4. **AdMob / GameMonetize** 註冊 + 給我 ad unit ID | 15 分 | 免費 | 把剩下的 ad stub 換成真 SDK |
| 5. **Play Store** 開發者帳號 | 1-2 小時(身份驗證) | $25 一次 | 安卓上架 |

每一項做完 ping 我一聲,我接著動。

## 階段 5:長期(看反饋再決定)
- iOS 上架($99/年)
- Steam 上架($100 一次)
- 全平台帳號同步
- ~~多人連線(WebRTC,複雜)~~ — **已做**,但**不是** WebRTC P2P:見階段 6(Trystero/WebRTC P2P 在 Phase 33 被換成 PartyKit 權威伺服器,因為 P2P 是錯的工具,真 .io 都用權威伺服器)。

## 階段 6:線上多人(已上線 ✅)

**傳輸 / 架構**:**PartyKit(Cloudflare Workers + Durable Objects)的權威 WebSocket 伺服器**,一個房間一個 Durable Object。`server/party/server.js`(~1710 行)跑**完整權威 sim**:server 端 NN bot 推論、server 擁有的子彈、lag-compensated 命中判定(`vT` rewind,favor-the-shooter)、20–30Hz delta snapshot。**不是 broadcast relay,也不是 P2P**。
`PRODUCTION_HOST = 'ashgrid-mp.dd-ching.partykit.dev'`(在 `js/multiplayer.js`)。MP server **獨立部署**:`cd server && npx partykit deploy`(不跟靜態站一起打包)。

**三層架構**(bug 都聚在層邊界):
1. **NN-client** — 60fps 渲染 + 本地預測(`js/multiplayer.js`)
2. **PvP-server** — 20–30Hz 權威 sim(`server/party/server.js`)
3. **hybrid-player** — 本地預測 + server 對賬(`js/mp_reconcile.js`)

**已做 / DONE**:
- [x] PartyKit 權威 server + client 預測 + reconciliation(Phase 36-39 起)
- [x] Snapshot 插值(render remote ~150ms in the past,Quake3 風格)
- [x] Server 端 NN bot 推論 + server 擁有的子彈 + lag comp
- [x] Build 結構同步(`build` / `explosionRequest` 訊息,late-joiner 拿 `welcome` 全量)
- [x] **競技場招降線上化(Phase 159)** — `js/arena_recruit_mp.js` 找 `_mpState.remoteBots` 最近可招降 bot,送 `recruit`;server 重新驗每個 gate(招募者 alive、SEED 差 > 10、bot 仍 alive),flip `bot.team → 0`,廣播 `recruitOk` 讓所有 client 放 SED-convert VFX。不做樂觀翻面,server 是唯一真相源。
- [x] Killstreak / recruit / danger FX、render 插值(平滑世界捲動)— Phase 154-157

## 階段 7:剩餘核心缺口 / REMAINING CORE GAPS

排在前面、最該補的東西:

1. **Build / energy 經濟在實戰不可用**
   - 能量回得太慢(`BALANCE.energy.regenPerSec = 3.0`)、一場太短、loop 太重複 → 玩家在真比賽裡幾乎用不到 Build。
   - **孤兒 build-phase 死碼**:`game._buildPhase` 從沒被建立,`build_phase_extend` / skip-wave 兩個 rewarded 按鈕因此永遠不出現(見階段 3b ⚠️)。要嘛接活、要嘛清掉。
   - 下一輪 balance pass 處理(全部數字集中在單一 `js/balance.js`)。

2. **MP 協議剩餘切片**
   - [x] recruit(已做,Phase 159)
   - [ ] `protoVer 4001` 版本握手(client/server 開連線時對版本,擋舊 client)
   - [ ] server 權威防禦波時鐘 / mission state 進 snapshot(目前 wave / 任務狀態未在 server 權威)
   - [ ] 完整 pawnSwap body-reattach(線上換 pawn 的身體重綁,參 `js/mp_reconcile.js` 的 ghost-vehicle 歷史)

3. **cosmetic_skin** — 外觀 / 皮膚系統(設定列已有鎖定佔位,未實作)。最後一個 rewarded 觸發點也卡在這。

## 維護基建 / MAINTENANCE INFRA(已就位)
- **單一 BALANCE config** — `js/balance.js`(energy + buildCost 全在這,balance pass 只改一處)。
- **資產版本戳 + 完整性** — `tools/version.js`(`stamp` / `check`);所有 `<script src>` 帶 `?v=NNN` cache-bust,**目前 v210**(無 bundler,純 `<script src>`,~67 個 module tag)。
- **SOLO/MP sim-parity 測試** — `tools/check_sim_parity.js`(抓 client↔server 武器 / obs 漂移)。
- **Pre-commit gate** — `tools/githooks/pre-commit`,由 CI 鏡像:`.github/workflows/checks.yml`(在 dev + main 上跑 js 語法 + version + parity,server-side 擋不能 `--no-verify` 繞過)。
- **單位死亡 chokepoint** — `killUnit()` + `onUnitDeath()`(`js/kill.js`):所有擊殺走同一個出口(flip alive/hp、計分、排行榜 bump)。

## 部署 / DEPLOY
- **(A) GitHub Pages** — `.github/workflows/pages.yml`,**push 到 `main` 自動部署**(Phase 158 修好:之前誤掛在已刪除的 `arena-mp` 分支)。整個 repo 就是站本身,無 build step。
- **(B) Cloudflare Pages**(`ashgrid.io`)— 用 `_headers` + `_redirects` 慣例。
- **(C) CrazyGames** — `scripts/build-zip.sh` 手動打 zip 上傳。
- **(D) MP server** — **獨立** `cd server && npx partykit deploy`(不跟靜態站綁)。

## 程式結構 / CODE STRUCTURE
- `index.html` ~6687 行(**不是** 13k/17k 的單檔)。
- 遊戲拆在 ~66 個 module script(`js/*.js` 的 classic-script 全域 + `js/missions/` + `js/audio/`)。
- 模塊在 R1–R14 + Phase 116–159 抽出:`input.js` · `weapon_state.js` · `ad_state.js` · `pawn_swap.js` · `bullets.js` · `world_render.js` · `world_gen.js` · `hud.js` · `enemy_ai.js` · `render_overlays.js` · `multiplayer.js` · `arena_recruitment.js` · `arena_recruit_mp.js` · `mp_reconcile.js` · `kill.js` · `balance.js` …(完整熱點表見 `CLAUDE.md`)。

## 雲端後端現況 / CLOUD BACKEND(更正:**不是**「零後端」)
- ✅ **Firebase Realtime Database** — 即時全球排行榜(Phase 23 起),真 REST GET/PUT(~每 8 秒 debounce push)。**不是 stub**。URL 在 `js/leaderboard.js`,client-authoritative(v1 可接受)。
- ✅ **PartyKit** — 權威 MP server(見階段 6)。
- ⚠️ 唯一剩下的雲端 stub:`run_history.uploadSurvivalRun`(`js/run_history.js`,no-op)。
- ❌ 舊文件寫的「零後端 / 全 stub」**已過時,是錯的**。

## Git workflow
- 在 **`dev`** 開發,`main` 只接受 dev→main merge,**嚴禁直接 commit / push 到 `main`**(見 `CLAUDE.md`)。

## 怎麼追進度
- `git log --oneline` 看我做了什麼
- 這個 ROADMAP.md 我會每完成一項打 ✅
- 卡在你動作的我會在 commit message 標 [BLOCKED:auth]
