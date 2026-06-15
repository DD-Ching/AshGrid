# server/ — PartyKit multiplayer (ESM)

`party/server.js` is the **server-authoritative** MP sim (ESM — `import`, `type:module`; NOT the
client's classic-script world). Clients send INPUT; the server owns positions, hp, hits, deaths,
and broadcasts snapshots (20 Hz, keyframe + delta).

## Rules

1. **A server change is not "done" until** `cd server && npx partykit deploy` runs AND a 2-client
   smoke passes AND the owner has OK'd it. There's ONE shared prod server — a deploy is live
   immediately for everyone.
2. **Deploy is backward-compatible by design:** old/live clients omit new input fields, so a new
   handler must be a no-op for them (`typeof data.x === 'number'` guards, sane defaults). Deploy the
   server BEFORE the client that sends the new fields.
3. **Client↔server parity:** anything duplicated on both sides (weapon stats, recruit gates, fan
   angles) is enforced by `tools/check_sim_parity.js`. Update both copies + the check together.
4. **Validate over the wire**, not by eye: `server/tools_smoke_chassis_hp.cjs` is the pattern —
   connect a `ws` client to `partykit dev` (or prod `wss://…`), send input, assert the snapshot.
   `partykit dev` is single-room local; assert on the SETTLED snapshot (the first one is pre-input).

## Quirks

- Prod host: `ashgrid-mp.dd-ching.partykit.dev`. Local: `partykit dev` on `:1999`, room path
  `/parties/main/<room>`.
- Server is largely chassis-blind: it sizes per-chassis maxHp/armour from the client's `hMul`/`aMax`
  input + reads `dashActive` (with anti-spoof guards) — it does not know the chassis id.
- `node --check server/party/server.js` before any commit; the MP node tests in `tools/` import it.
