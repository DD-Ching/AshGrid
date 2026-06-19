# js/ — client modules

Classic scripts (no bundler). Top-level `function` / `const` / `let` are **shared globals**
across every `<script>` (resolved at call time, so load order rarely matters) — but `const`/`let`
are NOT `window` properties (use the bare identifier, not `window.X`). Loaded before the inline
block in `index.html`, so they can be referenced from it.

## Modular-first

The metric isn't "how short is index.html" — it's **how many places can write the same piece of
state**. 12k lines is fine; 9 writers of `mouse.down` is the disease. Before editing, ask: who
else writes this state?

- **New feature → new file** `js/<feature>.js`. Only edit inline in `index.html` for a small
  (< ~50 line) change to existing inline logic.
- After a bug fix, ask: did this add a 7th writer to some state? If so, extract.
- Preventive extraction (no bug yet) is welcome when the owner asks or approves a proposal.
- A big multi-file refactor of a hotspot below → **propose first**. A small edit to one → just do it.

## State hotspots (regressions breed here — already extracted)

| Hotspot | Module |
|---|---|
| Input (`mouse.*`, `keys[]`, hit-rect, touch) | `input.js` |
| Weapon state (swap / fire / reload / cd) | `weapon_state.js` |
| Ad lifecycle (reward gate, overlay timer) | `ad_state.js` |
| Pawn-swap (manual + auto-on-death) | `pawn_swap.js` |
| Bullet update + collision | `bullets.js` |
| World render | `world_render.js` · overlays in `render_overlays.js` |
| World generation helpers | `world_gen.js` |
| HUD driver + cache | `hud.js` |
| Enemy AI + NN runtime | `enemy_ai.js` |
| Damage chokepoint (armour/dash/invuln/hit-flash) | `chassis.js` `_applyDamageToUnit` |
| Death chokepoint | `kill.js` `killUnit` · `player_lifecycle.js` `killPlayer` · `death_decider.js` |

## Chassis-classes (`game._classes`)

Abilities are chassis-EXCLUSIVE. `G` = one key, a per-chassis execute on a weaker (`hp<player.hp`)
target — builder=招降 (`arena_recruitment.js`), wolf=吞噬 (devour), heavy=夺取 (seize). `Space` =
signature: wolf dash (toggle on/off), heavy ultimate, builder none — gated on `player.alive` in
`key_bindings.js` so it can't collide with `Space`=respawn (dead-only) (188I, was `Shift`).
Shared eligibility lives in ONE predicate
`_arenaExecuteInfo()` (`arena_recruitment.js`) used by the HUD, the world prompt, AND the action —
keep all three reading it so a cue can't disagree with the action. Tunables → see root tunables map.
