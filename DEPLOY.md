# Deployment

AshGrid 是純客戶端 PvP .io 遊戲。所有遊戲邏輯都在瀏覽器跑(PPO 推論用
onnxruntime-web,多人對戰用 Trystero WebRTC P2P + Firebase 做 signaling)。
**不需要遊戲伺服器、不需要付費託管,**直接把整個資料夾推到任何靜態 CDN
就能上線。

---

## 部署方式 A — GitHub Pages(零設定,推 commit 就更新)

1. GitHub 上開啟 Pages:**Repo Settings → Pages → Source: `arena-mp` branch → root**
2. 等 1-2 分鐘,網址會出現在頂上,長這樣:
   ```
   https://ddh.github.io/AshGrid/?nn=1&mp=1
   ```
3. 之後每次 `git push origin arena-mp` 自動部署。

> Firebase 規則目前是 `".read": true, ".write": true`,公開可讀寫(我們只
> 拿來做 WebRTC signaling,沒有任何敏感資料)。Trystero 通訊握手完成後
> 一切遊戲流量走 P2P,Firebase 流量幾乎是零。
>
> Firebase 規則內建到 **2026-06-11** 過期,記得定期續期(或改成永久 `true`)。

---

## 部署方式 B — CrazyGames(主流量入口,有廣告分潤)

1. **註冊開發者帳號:** [developer.crazygames.com](https://developer.crazygames.com)
2. **打包遊戲:** 把整個 repo 壓成 zip(`index.html` 放最頂,其他資料夾如 `js/`、`ai_arena/`、`icons/` 一起進)
   ```bash
   cd /Users/ddh/Downloads/AshGrid
   zip -r ashgrid.zip index.html sw.js manifest.webmanifest icons/ js/ ai_arena/ 3d/
   ```
3. **CrazyGames 後台上傳:**
   - **Game type:** HTML5
   - **Entry file:** `index.html`
   - **Default URL params:** `?nn=1&mp=1`(讓玩家直接進多人戰場)
   - **Aspect ratio:** Responsive(任意)
   - **Categories:** Action / Multiplayer / Shooter
4. **SDK 已經接好了**(`js/crazygames.js` 處理獎勵廣告 + happytime 事件 +
   loadingStop 回呼),CrazyGames 會自動把廣告分潤打到你帳號。
5. **送審:** Crazy 通常 3-7 個工作天回覆。第一次過審後,後續更新走 OTA
   (你重新上傳 zip 就會替換版本)。

預期收入:CrazyGames 獎勵廣告 CPM 約 $1-4 美金。穩定 200 DAU 大概一個月
$20-80;爆紅到 5k DAU 是月 $1k-4k。

---

## 部署方式 C — Cloudflare Pages(企業級 CDN,免費 tier)

```bash
# 一次設定:
npm install -g wrangler
wrangler login
wrangler pages project create ashgrid

# 之後每次部署:
wrangler pages deploy . --project-name=ashgrid --branch=arena-mp
```

優勢:全球 CDN,亞洲線路最快;免費 tier 一個月 100k requests 用不完。

---

## 開發 / 本機測試

```bash
cd /Users/ddh/Downloads/AshGrid
python3 serve.py             # 起 localhost:8765 靜態伺服器
```

兩個瀏覽器分頁開:
- A: http://localhost:8765/?nn=1 → SOLO 模式
- B: http://localhost:8765/?nn=1&mp=1 → MULTI 模式

或從 lobby 切換 SOLO / MULTI · PvP。

---

## URL 旗標一覽

| Flag | 作用 |
|---|---|
| `?nn=1` | NN Arena 模式(預設)|
| `?mp=1` | 開啟多人連線(Trystero P2P)|
| `?room=foo` | 加入自訂房間 foo(預設 `ashgrid-main`)|
| `?fresh=…` | 開發用,跳過 SW cache |

朋友連線:把 `?nn=1&mp=1&room=自訂房名` 給朋友,共用同 room 名就配對到同
一場 PvP。

---

## 維運注意

- **Firebase RTDB 規則到 2026-06-11 過期**,屆時所有讀寫會被擋。改成永久
  `true` 或重新加長期限。
- **如果 esm.sh 掛了**,Trystero 載不進來,MP 會 fall back 到 console
  錯誤(SOLO 模式不受影響)。可以改成 jsdelivr 或自己 npm install + bundle。
- **PvP 是 client-authoritative**(沒有 server 端校驗),理論上有外掛
  空間。等真的有問題(廣告營收 > $500/月) 再投資架真實 server。
