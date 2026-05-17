# AshGrid — project rules

## Git workflow

- **必須在 `dev` 分支開發,完成後再 `merge dev → main`。**
- **嚴禁直接 commit / push 到 `main`。**

任何修改都先進 `dev`:`git checkout dev` → 改 → `git commit` → `git push origin dev`。`main` 只接受從 `dev` 的 merge,不接受直接修改。

## Coding standard — modular-first

**指標不是「index.html 多短」,是「同一塊 state 有幾個地方能寫」。** 12,000 行不是病,9 個地方都能戳 `mouse.down` 才是病。改動前要先看:這塊 state 還有誰在寫?

### 五個熱點(回歸 bug 都從這冒)

| 熱點 | 已抽? | 模組 |
|---|---|---|
| Input(`mouse.*`, `keys[]`, hit-rect, 觸控)| ✅ R2 | `js/input.js` |
| Weapon state(swap / fire / reload / cd)| ✅ R3 | `js/weapon_state.js` |
| Ad lifecycle(reward gate, overlay timer)| ✅ R1 | `js/ad_state.js` |
| Pawn-swap state(manual + auto-on-death)| ✅ R4 | `js/pawn_swap.js`(整合完) |
| Bullet update + collision | ✅ R5 | `js/bullets.js` |
| World render(renderWorld / lowCovers / overheads / footprints)| ✅ R6 | `js/world_render.js` |
| World GENERATION helpers(addBuilding / addLowCover / addWallLine / ...)| ✅ R7 | `js/world_gen.js`(整合完) |
| HUD render driver(cache region, canvas inset offset)| ⚠️ | helpers 已抽,driver 還在 index |
| MAPS table + theme constants | ⚠️ | 還在 index 跟 js/maps.js,沒明顯耦合問題 |

### 紀律

1. **碰到上面任何熱點前**,先用一兩句話提議抽模組,問用戶 yes / no。同意才做;說 inline 就 inline,但在檔案頂端加 TODO + 該檔的累積 bug 計數。
2. **新功能預設寫新檔** `js/<feature>.js`。只有「修改既有 < 50 行小區段」才 inline 進 index.html。
3. **不能 autonomously 發起多檔大重構** — 大重構要先跟用戶提案、得到同意才動手。提案要講清楚 scope、commit 數、風險。
4. **預防性重構(無 bug 也抽)是歡迎的** — 用戶主動要求、或重構提案被用戶同意,就照做(R4/R5/R6/R7 都是這樣)。不再強制「等 bug 出現才抽」 — 有些耦合會等到出 bug 才修就太晚。
5. 每次 bug 修完問自己:這個 fix 有沒有讓某塊 state 多了第 7 個寫入點?有的話就抽。
