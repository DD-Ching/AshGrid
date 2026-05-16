# AshGrid — project rules

## Git workflow

- **必須在 `dev` 分支開發,完成後再 `merge dev → main`。**
- **嚴禁直接 commit / push 到 `main`。**

任何修改都先進 `dev`:`git checkout dev` → 改 → `git commit` → `git push origin dev`。`main` 只接受從 `dev` 的 merge,不接受直接修改。
