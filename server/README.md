# AshGrid multiplayer server

PartyKit / Cloudflare Workers + Durable Objects. One Durable Object per
room. Clients open a WebSocket and send **inputs** (move vector + fire +
aim angle); the **server holds the world's truth** and is authoritative.
It is NOT a broadcast relay — the server runs a full game simulation:

- a fixed-step sim tick driven by `setInterval` inside the Durable Object
  (torn down via `onClose` when the room empties, so idle rooms cost
  nothing),
- server-side NN bot inference (a pure-JS PPO forward pass — the elite
  policy in `sim/nn_weights_elite.js`, no onnxruntime dependency),
- server-owned bullets, hit detection, HP, deaths and respawn lifecycle,
- lag-compensated hit detection ("favor the shooter" — rewinds targets to
  the snapshot tick the shooter was rendering before testing the hit),
- server-authoritative built structures + AOE explosion damage,
- arena recruitment (Phase 159 `recruit` / `recruitOk` — see below),
- delta snapshots broadcast at ~20–30 Hz; clients render + predict at
  60 fps and reconcile against server truth.

Wings.io / agar.io / krunker.io architecture — clients predict locally
for instant response, then snap to the server state when it arrives.

This replaced the previous Trystero **P2P** approach in Phase 33. P2P
was the wrong tool — wings.io, agar.io, krunker etc. all run on
authoritative servers, not P2P. After 5 phases of fighting NAT /
TURN / Trystero version regressions, we accepted that and pivoted.

> The MP server deploys **separately** from the static site (`partykit
> deploy`). It is not bundled with GitHub Pages / Cloudflare Pages.

## One-time setup

```sh
cd server
npm install
npx partykit login        # opens a browser, links your Cloudflare account
```

## Local development

```sh
cd server
npx partykit dev          # listens on http://localhost:1999
```

The client auto-detects localhost — open the game with `?ws=localhost:1999`
or just from `http://localhost:8000/?nn=1&mp=1` (the client falls back
to `localhost:1999` whenever it's loaded from localhost).

To test two players against the local server, just open the game in
two browser tabs / two windows. They'll connect to the same room.

Host resolution order in `js/multiplayer.js`:

1. `?ws=<host>` URL param (test against another deploy)
2. `window.MP_PARTYKIT_HOST` (paste in console for a quick swap)
3. localhost auto-detect (the `npx partykit dev` workflow)
4. `PRODUCTION_HOST` constant (current: `ashgrid-mp.dd-ching.partykit.dev`)

## Deploy to Cloudflare

```sh
cd server
npx partykit deploy
```

PartyKit prints the deployed URL — something like:
`https://ashgrid-mp.<your-cf-username>.partykit.dev`

Open `js/multiplayer.js` and replace the `PRODUCTION_HOST` constant
near the top with that hostname (no `https://`, no trailing path).
Commit + push that change so the deployed clients pick it up.

## Free tier

Cloudflare Workers Free covers 100k requests/day + 13ms CPU per request.
Durable Objects free includes 1M req/mo and 400k GB-s. For an .io hobby
game this is effectively infinite — you'd need thousands of concurrent
players to come close. Note the sim runs inside the DO (NN inference +
per-tick physics), so the cost driver here is **CPU time per active
room**, not request count; empty rooms idle for free because the tick
interval is torn down on the last disconnect.

## Cost / scaling notes

- 1 Durable Object instance per room. Rooms scale horizontally for free.
- Each active room runs a sim tick + NN inference for its bots and
  broadcasts a delta snapshot ~20–30 Hz to every connected client.
  Snapshots carry only the room's players + live bullets, so per-room
  bandwidth stays small (single-digit KB/s per client) — well inside the
  free tier even at hundreds of rooms.
- No NAT/TURN/STUN to worry about. WebSocket goes through whatever
  network the user is on — no symmetric-NAT carve-outs.

## Arena recruitment over MP (Phase 159)

Killing/wounding an enemy NPC and pressing **G** to convert it onto your
squad is AshGrid's core progression loop, and it works online too. The
client sends `{type:'recruit', botId, seed}`; the server (`server.js`)
re-checks every gate so a spoofed/optimistic client can't force a
conversion:

- recruiter alive, bot exists + alive + currently enemy (team 1),
- within touch reach (~106 px),
- bot HP below 50% of max,
- `recruiterSeed − botSeed > 10` (the `ARENA_SEED_GAP` skill differential;
  bots are seed 0).

On success the server flips the bot's team (rides the normal snapshot
delta) and broadcasts `{type:'recruitOk', ...}` so every client fires the
SED-convert VFX. The SOLO live-target path lives in
`js/arena_recruitment.js`; the MP client glue is `js/arena_recruit_mp.js`.

## Files

- `partykit.json` — project config (name = `ashgrid-mp`, entry = `party/server.js`)
- `party/server.js` — **the authoritative room class (~1710 lines)**. Owns
  the world: input handling, fixed-step tick loop, server-side NN bot
  inference, server-owned bullets + lag-compensated hit detection,
  deaths + respawn lifecycle, built structures + AOE explosions, the
  Phase-159 `recruit` handler, and snapshot broadcasting.
- `party/sim/` — shared deterministic sim, imported by `server.js` and
  kept byte-identical to the browser copies under `js/sim/` (a parity
  check guards the duplication):
  - `constants.js` — physics + arena constants (tick rate, speeds, radii,
    bullet defaults). Mirrors `js/sim/constants.js`.
  - `movement.js` — per-tick movement step (`simStepPerTick`).
  - `weapons.js` — shared weapon table (`getWeaponSim`).
  - `bullet.js` — bullet spawn from a firing unit (`spawnBulletsFromUnit`).
  - `nn_runtime.js` / `nn_obs.js` / `nn_weights_elite.js` — the pure-JS NN
    forward pass, observation builder, and the elite PPO weights used for
    server-side bot inference.
  - `protocol.md` — the WebSocket message schema (client↔server message
    types). The live contract is the comment block at the top of
    `server.js` and the mirror in `js/multiplayer.js`.
- `package.json` — just the `partykit` dev dependency.

## Where to look when something breaks

- Client console: filter `[mp]`. Three breadcrumbs to verify:
  - `[mp] connecting to wss://...` — WebSocket URL is right
  - `[mp] WebSocket open` — TCP+upgrade succeeded
  - `[mp] welcomed as <uuid> · existing peers: [...]` — server handshake OK
- Server logs: `npx partykit tail` (deployed) or look at the dev terminal.
- Cloudflare dashboard → Workers & Pages → your project for invocation
  count, errors, and request analytics.
- Bugs cluster at the **three-layer boundaries**: NN-client (60 fps render
  + prediction) / PvP-server (~20–30 Hz authoritative sim) / hybrid-player
  (local prediction + server reconciliation in `js/mp_reconcile.js`).
  When prediction and server truth disagree, start there.
