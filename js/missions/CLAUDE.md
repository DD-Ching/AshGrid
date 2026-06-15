# js/missions/ — game modes, wave factories, arena maps

Each mode registers `MISSION_FACTORIES.<type> = function(mapDef) {…}`. `nn_deathmatch.js` is the
core arena factory (the endless escalating-wave engine — fight / die / respawn / waves get denser);
`survival` reuses it. `nn_arena_variants.js` holds `NN_MAP_VARIANTS` (each `{ id, walls(), spawn,
modes:[…] }`) and `pickMapForMode(mode)`.

## How a match starts

Lobby mode button (`data-mode="…"`, `index.html`) → `_lobby.mode` → `startNNSkirmish(…, gameMode)`
→ per-mode size/weapon overrides + `game._nnGameMode` → map via `pickMapForMode` →
`MISSION_FACTORIES[type]`. Force a specific map by setting `_forceVariantId = '<id>'`
(`nn_arena_variants.js`); clear it (`= null`) for non-forcing modes.

## Wave scaling (tune here)

`_waveInterval(n)` / `_waveSize(n)` in `nn_deathmatch.js` — the escalation curve for survival/siege.

## Adding a mode (the pattern, e.g. how `siege` was built)

1. Lobby button `data-mode="<m>"` + a tier in `MODE_UNLOCK_TIER` (`js/progressive_unlock.js`).
2. A branch in `startNNSkirmish` (`index.html`): set sizes + a `game._<m>` flag, and **reuse** an
   existing factory/map where possible (siege = SOLO + `_forceVariantId='survival_fort'` + the
   survival wave path + `game._siege`) rather than a new factory.
3. Gate the only behavioural differences on the flag (e.g. siege's no-respawn lives in
   `death_decider.js` under `game._siege`) so every other mode is untouched.
4. Score / end-card via `mission_runtime.js` `showNNEndCard`.

Keep modes ADDITIVE: a new mode is a flag + a thin branch, never a rewrite of the shared loop.
Don't retime waves with new `*84`-style factors — reuse the existing cadence (see root rule 2).
