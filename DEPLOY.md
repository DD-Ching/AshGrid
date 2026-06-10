# Deployment

AshGrid 是 **線上 PvP .io 遊戲**。主產品是部署在 **ashgrid.io**(自有網域)的
線上多人對戰;同時上架 **CrazyGames**(廣告分潤)與一個 **GitHub Pages** 鏡像。
SOLO / 本機模式仍然存在,但 .io 線上產品是優先項。

架構是**權威伺服器**:多人對戰跑在 **PartyKit**(Cloudflare Workers + Durable
Objects)上的 authoritative WebSocket server —— 每個房間一個 Durable Object,
伺服器端跑完整的權威模擬(server-side NN bot 推論、server-owned bullets、
lag-compensated 命中判定、20–30Hz delta snapshot)。它**不是** broadcast relay,
也**不是** Trystero / WebRTC P2P(P2P 在 Phase 33 已被取代 —— 真正的 .io 遊戲
用權威伺服器,不是 P2P)。

所以部署是**兩塊**:

- **靜態網站**(`index.html` + `js/*.js` 模組 + ONNX 模型)—— 推到任何靜態 CDN
  即可(GitHub Pages / Cloudflare Pages / CrazyGames zip)。
- **MP 伺服器**(`server/`)—— **獨立部署**到 PartyKit,**不**跟靜態網站打包在一起。

> 雲端後端:本專案**有**雲端後端(不是「零後端」)。線上對戰靠 PartyKit
> 權威伺服器;全球排行榜靠 Firebase Realtime Database(見下方排行榜段落)。
> 唯一還是 stub 的雲端路徑是 `run_history.uploadSurvivalRun()`(no-op)。

---

## 三層架構(改 MP 前先看這個)

| 層 | 跑在哪 | 頻率 | 負責 |
|---|---|---|---|
| **NN-client** | 瀏覽器 | 60fps | 渲染 + 本地預測(prediction)|
| **PvP-server** | PartyKit Durable Object | 20–30Hz | 權威模擬:NN bot 推論、bullets、命中、生死 |
| **hybrid-player** | 瀏覽器(`js/mp_reconcile.js`)| — | 本地預測 + 伺服器和解(reconciliation)|

Bug 都聚在這三層的**交界**上。

---

## MP 伺服器(PartyKit)— 獨立部署

伺服器在 `server/party/server.js`(約 1,710 行),跑完整權威 sim。

```bash
# 一次性:裝依賴
cd server && npm install

# 本機開發(localhost:1999,client 會自動偵測)
cd server && npx partykit dev

# 部署到 production
cd server && npx partykit deploy
```

部署後的 host 寫死在 `js/multiplayer.js`:

```js
const PRODUCTION_HOST = 'ashgrid-mp.dd-ching.partykit.dev';
```

換 deploy 名稱就改這一行(`server/partykit.json` 的 `name` 也要對上)。

client 解析 MP host 的順序(`_mpResolveHost()` in `js/multiplayer.js`):

1. `?ws=<host>` URL 參數(指到另一個 deploy 測試用)
2. `window.MP_PARTYKIT_HOST`(在 console 貼一行快速切換)
3. localhost 自動偵測(配 `npx partykit dev`)
4. `PRODUCTION_HOST`(上面那行)

---

## 部署方式 A — GitHub Pages(已自動化 · 推 `main` 就更新)

`.github/workflows/pages.yml` 已經配好,**在 push 到 `main` 時觸發**
(Phase 158 修正:之前錯掛在已刪掉的 `arena-mp` 分支上)。整個 repo 直接當成
靜態網站上傳,沒有 build step。

**一次性設定**:

1. 進 https://github.com/DD-Ching/AshGrid/settings/pages
2. **Source** 選 **GitHub Actions**(不是 'Deploy from a branch')
3. 按 Save

完成。之後每次 merge 進 `main` 都會自動部署(`dev` 是 WIP 分支,只有 `main`
會觸發 Pages)。網址在 Pages settings 頁面頂上,通常長這樣:

```
https://dd-ching.github.io/AshGrid/?nn=1&mp=1
```

> **注意:** GitHub Pages 只部署**靜態網站**。MP 伺服器要另外 `partykit deploy`
> (見上方),否則這個鏡像連的還是同一個 production PartyKit host。

---

## 部署方式 B — CrazyGames(主流量入口,有廣告分潤)

1. **註冊開發者帳號:** [developer.crazygames.com](https://developer.crazygames.com)
2. **打包遊戲:** 跑打包腳本:
   ```bash
   cd /Users/ddh/Downloads/AshGrid
   ./scripts/build-zip.sh
   ```
   產生 `ashgrid.zip`(約 1.4MB)。腳本用一份顯式 keep-list 打包 production
   需要的檔案(`index.html` / `js` / `icons` / `sw.js` / manifest / favicon /
   `3d`,以及 `ai_arena/onnx/*.onnx` 模型),不含訓練筆記、`.git`、`.claude`、
   `scripts/`、dev-only 檔案與 `*.test.js` / `*.spec.js`。
3. **CrazyGames 後台上傳:**
   - **Game type:** HTML5
   - **Entry file:** `index.html`
   - **Default URL params:** `?nn=1&mp=1`(讓玩家直接進多人戰場)
   - **Aspect ratio:** Responsive(任意)
   - **Categories:** Action / Multiplayer / .IO / Shooter
4. **SDK 已經接好了**(`js/crazygames.js` —— 完整 lifecycle):
   - **`sdkGameLoadingStart` / `sdkGameLoadingStop`** — boot 完就發,
     讓 CrazyGames 解開自家 loader spinner + 暖起廣告 inventory
   - **`gameplayStart` / `gameplayStop`** — 進場開,離場/結算就停。
     讓 portal 可在 round 切換點插 mid-round 廣告
   - **`happytime` / `sadtime`** — 擊殺 / 死亡發出情緒事件,讓 Crazy
     避開玩家高張力時段
   - **`requestAd('rewarded')`** — `WATCH AD · SQUAD REVIVE` 按鈕觸發
   - **`requestAd('midgame')`** — 玩家死亡每 N 次自動播一支
     interstitial(有 throttle 防止快速死亡爆量)
5. **送審:** Crazy 通常 3-7 個工作天回覆。第一次過審後,後續更新走 OTA
   (你重新上傳 zip 就會替換版本)。

> **AdMob / GameMonetize 仍是 stub**(等帳號 credentials),目前只有
> CrazyGames SDK 是真的接好的廣告供應商。

### 廣告觸發點一覽

| 類型 | 觸發位置 | 條件 | 玩家報酬 |
|---|---|---|---|
| **rewarded** | `WATCH AD · SQUAD REVIVE` 綠色按鈕 | 全隊覆滅倒數中 | 玩家立即單獨復活 |
| **midgame** | 死亡計數每 N 次 | throttle 內未播過 | 無(廣告分潤給你)|

> **尚未上線:** code 裡有一個 build-phase「skip-wave / 延長建造期」的 rewarded
> 介面(`hud.js` / `touch_input.js` / `index.html` 的 `_skipWaveAdRect` +
> `requestRewardedAd('build_phase_extend')`),但目前是**死碼** —— 別把它列為
> 可用的廣告觸發點,等 build loop balance pass 再啟用。

預期收入:CrazyGames 獎勵廣告 CPM 約 $1-4 美金。穩定 200 DAU 大概一個月
$20-80;爆紅到 5k DAU 是月 $1k-4k。

---

## 部署方式 C — Cloudflare Pages(ashgrid.io 的線路)

**ashgrid.io 由 Cloudflare Pages 提供。** repo 根目錄的 `_headers`
(per-path cache + 安全 header)和 `_redirects`(`/play`、`/solo`、`/mp` 漂亮
網址)就是 Cloudflare Pages 的設定慣例,部署時會自動套用。

```bash
# 一次設定:
npm install -g wrangler
wrangler login
wrangler pages project create ashgrid

# 之後每次部署(從 main):
wrangler pages deploy . --project-name=ashgrid --branch=main
```

`_redirects` 目前提供的漂亮網址:

| 路徑 | 轉到 |
|---|---|
| `/play` | `/?nn=1&mp=1`(線上對戰)|
| `/mp`   | `/?nn=1&mp=1`(線上對戰)|
| `/solo` | `/?nn=1&solo=1`(本機,因為 mp 現在是預設)|

優勢:全球 CDN,亞洲線路最快;免費 tier 一個月 100k requests 用不完。

> 同樣注意:Cloudflare Pages 只服務**靜態網站**。MP 伺服器仍是 PartyKit
> 獨立部署。

---

## 排行榜(Firebase Realtime Database · LIVE)

全球排行榜是**真的線上後端**(Phase 23 起),不是 stub。`js/leaderboard.js`
用純 REST 對 Firebase RTDB 做 GET / PUT(約每 8 秒 debounced 推一次,
beforeunload 收尾),host 寫死在:

```js
const LB_FIREBASE_URL = 'https://ashgo-1bfec-default-rtdb.asia-southeast1.firebasedatabase.app';
```

沒有 SDK、沒有 auth —— 規則是公開的 `.read / .write`,client-authoritative
(任何人 CAN post 假數字,但這是 v1 可接受的取捨;有營收後再換 Cloud
Functions + per-uuid 簽核)。kills / deaths / streak / matches 也存 localStorage,
網路斷線時不會倒退。

---

## 開發 / 本機測試

```bash
# 1. 靜態網站
cd /Users/ddh/Downloads/AshGrid
python3 serve.py             # 起 localhost:8765 靜態伺服器

# 2.(測 MP 時)另開一個 terminal 起權威伺服器
cd /Users/ddh/Downloads/AshGrid/server
npx partykit dev             # localhost:1999,client 會自動偵測
```

兩個瀏覽器分頁開:

- A: http://localhost:8765/?nn=1&solo=1 → SOLO 模式
- B: http://localhost:8765/?nn=1&mp=1 → 線上 MP(連 localhost:1999)

> **記得驗 MP,不只是 SOLO。** 本機 SOLO 幾乎不會壞,回歸 bug 都咬在線上 MP /
> PvP。改 MP 相關的東西要起 `npx partykit dev` 並用 `?mp=1` 實測。

或從 lobby 切換 SOLO / MULTI · PvP。

---

## URL 旗標一覽

| Flag | 作用 |
|---|---|
| `?nn=1` | NN Arena 模式 |
| `?mp=1` | 線上多人對戰(PartyKit 權威伺服器)—— **現在是預設** |
| `?solo=1` | 強制 SOLO / 本機模式(覆蓋預設的 mp)|
| `?ws=<host>` | 覆蓋 MP 伺服器 host(指到另一個 PartyKit deploy 測試)|
| `?room=foo` | 加入自訂房間 foo(預設 `ashgrid-main`)|
| `?fresh=…` | 開發用,跳過 SW cache |

朋友連線:把 `?nn=1&mp=1&room=自訂房名` 給朋友,共用同 room 名就配對到同一場
PvP(同一個 PartyKit Durable Object)。

---

## 維運注意

- **Firebase RTDB 規則是時間綁定的**(`".read": "now < <timestamp>"`)。**到期前
  務必去 Firebase Console 把期限加長(或改成永久 `true`)**,否則線上排行榜的
  讀寫會被全部擋掉。這是會直接讓 LIVE 排行榜掛掉的 operational warning。
- **MP 伺服器要單獨部署。** 改了 `server/party/server.js` 之後,**靜態網站的部署
  不會帶上它** —— 一定要另外 `cd server && npx partykit deploy`,否則線上玩家連
  的還是舊版伺服器。
- **改 MP 邏輯後跑 sim-parity 測試。** `tools/check_sim_parity.js` 檢查
  client(SOLO)↔ server 的武器 / 觀測值漂移;pre-commit hook
  (`tools/githooks/pre-commit`)和 CI(`.github/workflows/checks.yml`,跑在
  `dev` + `main`)都會擋:js 語法 + `tools/version.js check`(asset 版本戳 +
  完整性)+ sim parity。
- **資產版本 cache-bust:** 沒有 bundler —— `index.html` 用 `<script src>` 直引
  約 60 個 `js/*.js` 模組(外加 `js/missions/`),每個帶 `?v=NNN`
  (目前 **v210**)。改了 JS 要 bump 版本(`tools/version.js stamp`),不然
  edge / SW cache 不會更新。

---

## Git workflow(部署前必看)

在 **`dev`** 分支開發;**`main` 只接受從 `dev` 的 merge**,嚴禁直接 commit /
push 到 `main`。GitHub Pages 掛在 `main`,所以「merge dev → main」就是 ship 動作。
