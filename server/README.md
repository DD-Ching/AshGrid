# AshGrid multiplayer server

PartyKit / Cloudflare Workers + Durable Objects. One Durable Object per
room. Clients open a WebSocket; the server is a broadcast relay (it
forwards every message to the other connections in the same room,
tagged with the sender's id).

This replaced the previous Trystero P2P approach in Phase 33. P2P
was the wrong tool — wings.io, agar.io, krunker etc. all run on
authoritative servers, not P2P. After 5 phases of fighting NAT /
TURN / Trystero version regressions, we accepted that and pivoted.

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

## Deploy to Cloudflare

```sh
cd server
npx partykit deploy
```

PartyKit prints the deployed URL — something like:
`https://ashgrid-mp.<your-cf-username>.partykit.dev`

Open `js/multiplayer.js` and replace the `PRODUCTION_HOST` constant
near the top with that hostname (no `https://`, no trailing path).
Commit + push that change so GitHub Pages picks it up.

## Free tier

Cloudflare Workers Free covers 100k requests/day + 13ms CPU per request.
Durable Objects free includes 1M req/mo and 400k GB-s. For an .io hobby
game this is effectively infinite — you'd need thousands of concurrent
players to come close.

## Cost / scaling notes

- 1 Durable Object instance per room. Rooms scale horizontally for free.
- 20Hz position broadcasts × N peers per room. Each message is ~80 bytes.
  At 10 peers per room that's ~16 KB/sec inbound and ~144 KB/sec outbound
  per room. Well inside the free tier even at hundreds of rooms.
- No NAT/TURN/STUN to worry about. WebSocket goes through whatever
  network the user is on — no symmetric-NAT carve-outs.

## Files

- `partykit.json` — project config (name, entry point)
- `party/server.js` — the room class (~50 lines)
- `package.json` — just the `partykit` dev dependency

## Where to look when something breaks

- Client console: filter `[mp]`. Three breadcrumbs to verify:
  - `[mp] connecting to wss://...` — WebSocket URL is right
  - `[mp] WebSocket open` — TCP+upgrade succeeded
  - `[mp] welcomed as <uuid> · existing peers: [...]` — server handshake OK
- Server logs: `npx partykit tail` (deployed) or look at the dev terminal.
- Cloudflare dashboard → Workers & Pages → your project for invocation
  count, errors, and request analytics.
