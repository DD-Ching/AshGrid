# 上架路線圖 / RELEASE ROADMAP

最後更新:2026-05-08(16 模塊 Defense + 6 NN 風格 + 完整觸控 + cursor/shake/squad/editor 修穩)。我自主執行 — 進度在 commits、需你動作的標 🔑。

## 階段 0:現況
- ✅ 核心玩法穩定(6 NN 風格、aim-assist、pawn-swap、7 模式、21 NN 地圖變體 + 5 戰役地圖)
- ✅ 桌面 + 手機瀏覽器體驗完整
- ✅ PWA 可安裝,offline 玩(SW 預快取所有 brain)

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

**階段 2 完成 ✅**

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
- [x] Defense 獨立排行榜(與 Survival 分桶)— 下一個 commit
- 隊伍人數上限 4 → 8

**階段 2c 完成 ✅**(16 模塊 / 6 NN 風格 / 完整觸控)

## 階段 3:Stub 接點(我寫好,你補帳號)
- [x] AdMob rewarded-ad interface — 746ed8d(stub `requestRewardedAd(id, cb)`)
- [x] Firebase 排行榜接口 — 746ed8d(stub `uploadSurvivalRun(run)`)
- [x] 地圖編輯器 — 254788d / ddd356c(60u 格網 + 雙方 spawn)
- [x] 多槽位地圖編輯器(3 free,看廣告解鎖到 5)— 651bde4 / d9d419e

**階段 3 完成 ✅**

## 階段 3b:AdMob 觸發點(就緒待 SDK)
- [x] survival_revive — 844d42e(死亡看廣告續命)
- [x] editor_extra_slots — d9d419e(地圖編輯器槽位 +2)
- [x] build_phase_extend — 8425560(蓋碉堡 +2 cover +5s)
- [x] survival_skip_wave — 下一個 commit(跳過下一波 + 補給)
- [ ] cosmetic_skin(待設計外觀系統)

每個 trigger 都用 `requestRewardedAd('reward_id', cb)`。當你給我 AdMob ad unit ID,只要把 stub 換成真 SDK,所有 trigger 立刻生效。

## 階段 4:🔑 你動作清單

照這個順序,有時間挑一個做:

| 動作 | 時間 | 費用 | 解鎖 |
|---|---|---|---|
| 1. **itch.io 註冊** + 上架 | 30 分 | 免費 | 立刻有作品集 |
| 2. **Cloudflare Pages** + 接 GitHub | 15 分 | 免費 | 自架網址 |
| 3. **Firebase** 建專案 + 給我 config | 10 分 | 免費 | 雲端排行榜 |
| 4. **AdMob** 註冊 + 給我 ad unit ID | 15 分 | 免費 | 廣告開始賺錢 |
| 5. **Play Store** 開發者帳號 | 1-2 小時(身份驗證) | $25 一次 | 安卓上架 |
| 6. **域名**(.com / .gg) | 5 分 | $10/年 | 品牌 |

每一項做完 ping 我一聲,我接著動。

## 階段 5:長期(看反饋再決定)
- iOS 上架($99/年)
- Steam 上架($100 一次)
- 多人連線(WebRTC,複雜)
- 全平台帳號同步

## 怎麼追進度
- `git log --oneline` 看我做了什麼
- 這個 ROADMAP.md 我會每完成一項打 ✅
- 卡在你動作的我會在 commit message 標 [BLOCKED:auth]

