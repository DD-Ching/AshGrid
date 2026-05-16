# AshGrid — project rules

## Git workflow

- **必須在 `dev` 分支開發,完成後再 `merge dev → main`。**
- **嚴禁直接 commit / push 到 `main`。**

任何修改都先進 `dev`:`git checkout dev` → 改 → `git commit` → `git push origin dev`。`main` 只接受從 `dev` 的 merge,不接受直接修改。

## Coding standard — modular-first

**改動前要先想「這要不要抽成模組」**,尤其下列五塊(回歸 bug 都在這冒):

1. **Input state** — `mouse.*`, `keys[]`, hit-rect dispatch, touch handlers
2. **Weapon state** — `playerWeapon`, `_weaponSlots`, fire trigger, swap, reload
3. **Ad lifecycle** — `_pendingAdCb`, `_didReallyPause`, overlay timers, reward gate
4. **HUD render/cache** — offsets, cache regions, canvas inset
5. **Pawn / swap state** — `allies[i]._consumed`, `_useNN`, `_humanPiloted`, `_respawnAt`

碰到其中任何一個 → 先用一兩句話提議抽成 `js/<module>.js`,問用戶要不要做這個重構;同意才做。若用戶說 inline 就好,inline 修法 + 在檔案頂端加 TODO 註明累積的 bug 次數。

`index.html` 已 ~12000 行 → 新代碼若不是修改既有 < 50 行小區段,一律抽出成新檔。

**不要主動發起整個 codebase 大重構** — vibe-coding 流程不適合長重構;**機會性 refactor**:每次碰到上述五塊就順手抽一塊。
