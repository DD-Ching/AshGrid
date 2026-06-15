# tools/ — CI gate, version stamp, smokes

Zero-dependency Node scripts. The CI workflow (`.github/workflows/checks.yml`) + the pre-commit
hook (`tools/githooks/pre-commit`) run these. Run the full set locally before every commit; it must
be green before a `dev → main` ship.

## The gate (run after any change)

```
node tools/check_inline.js      # compiles every inline <script> in index.html (catches what node --check can't)
node tools/version.js check     # all ?v= refs + sw cache share one version; all script files tracked
node tools/check_sim_parity.js  # client↔server parity: WEAPONS, OBS_DIM, recruit gates, ULT_FAN_STEP
node tools/test_reconcile.js    # MP self-reconcile pipeline contract
node tools/test_director.js     # adaptive-director one-way DDA invariant
node tools/test_killcam.js      # death replay + press-SPACE respawn
node tools/test_mp_respawn.js   # MP server respawn-authority rule
node tools/test_mp_ad_revive.js # MP ad-revive is server-authoritative
node tools/test_npc_director.js # NPC anti-clump / goals / fail-safe
node tools/test_mp_chassis.js   # server _applyChassisDamage (armour/dash/bleed) + recruit gate
node tools/test_squad_slots.js  # getSquadSlots roster predicate
```

When you add a guarded behaviour, add/extend a `test_*.js` here and wire it into BOTH
`checks.yml` and `githooks/pre-commit` (keep the two lists in sync).

## Version stamp (before `dev → main`)

`node tools/version.js stamp <N>` bumps every `?v=` in index.html + the `sw.js` cache name in one
shot. REQUIRED before shipping to `main`: `main` is live and `/js/*` is served `immutable`, so the
same `?v=` with changed bytes = a mixed old/new module load. `version.js check` flags drift but
NOT a skipped bump — so always stamp on a `main` ship.

## Browser boot-smoke (before a `main` ship — headless can't boot a SOLO match)

`python serve.py` (threaded, serves the repo, `:8765`) → drive Playwright to
`http://localhost:8765/index.html` → eval bare-identifier checks (NOT `window.X` — consts aren't on
window) + read console errors. The ~10 ad-COEP `invoke.js` errors are BENIGN; anything else is real.
