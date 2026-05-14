# AshGrid MP Protocol (target end-of-Phase-6)

Status: **DRAFT** — finalised per phase as the refactor lands.

This document describes the WebSocket message schema that the server-
authoritative architecture will speak. Phase 0 commits this draft;
each subsequent phase (1-6) implements one slice of it and the doc
becomes the up-to-date contract.

The protocol is small on purpose. There are 12 client-to-server message
types and 14 server-to-client message types. Snapshots and inputs are
the only "hot" messages (30 Hz each); everything else is event-driven.

---

## Wire format

Every message is a JSON object with a `type` field plus type-specific
payload. Each connection is bound to a single room (PartyKit Durable
Object instance) keyed by URL path `/parties/main/<room>`.

Messages are sent as text frames over WebSocket. After Phase 6 we may
revisit binary framing (MessagePack / flatbuffers) for the snapshot
hot path, but JSON keeps debugging trivial in dev.

Numeric coordinates are world units (1 unit = 1 in-game pixel; arena
is 4000×3000 by default; see `js/sim/constants.js` in Phase 1).
Angles are radians, atan2-convention (0 = +X, π/2 = +Y).

---

## Client → Server

### `hello` (once, on connect)

```js
{
  type: 'hello',
  name: string,         // ≤ 12 chars, callsign
  weapon: string,       // weapon id (RIFLE / SMG / LMG / SNIPER / SHOTGUN / ROCKET)
  chassis: string,      // 'humanoid' | 'heavy' | 'agile'
  protoVer: number,     // bump when this doc's shape changes
}
```

Server replies with `welcome` (see below). Until welcome arrives, all
further messages are queued client-side.

### `input` (30 Hz, replaces today's `_mpSendInput`)

```js
{
  type: 'input',
  seq: number,          // monotonic per-client; server echoes back the
                        // last-applied seq in snapshots so the client
                        // can drop ack'd inputs from its replay buffer
  t: number,            // client send timestamp (ms since epoch);
                        // used only for diagnostics, not authoritative
  moveX: -1 | 0 | 1,    // WASD: A=-1, D=+1
  moveY: -1 | 0 | 1,    // W=-1 (screen-up), S=+1
  angle: number,        // gun aim, radians
  fire: 0 | 1,          // primary fire held
  sprint: 0 | 1,        // shift
  reload: 0 | 1,        // R pressed this tick (edge-triggered)
  grenade: 0 | 1,       // G pressed
  // future: cmdMode, throwCharge, etc.
}
```

The server applies this input on the **next** server tick that runs.
Client predicts immediately via the shared `simStepPlayer(player,
input, ...)` from `js/sim/player_step.js`. Reconciliation works because
the server runs the SAME function on the SAME input.

### `equip`

```js
{ type: 'equip', weaponId: string }   // swap to weaponId
```

Server validates against unlocks + ammo state, then sets `player.weapon`.

### `pawnSwap`

```js
{ type: 'pawnSwap', targetBotId: number }
```

Server detaches the player from the current body and re-attaches to
the bot with `id === targetBotId`. Same-team check, alive check, range
check (≤ 200 u). Old body becomes EX-OP NN driven, respawns at team
spawn after the standard timer. Server confirms via `pawnSwapOk` event.

### `build`

```js
{ type: 'build', sid: number, kind: string, x: number, y: number }
```

Existing message — already implemented (Phase 43). Server validates
energy cost, AABB overlap, placement rules. Confirms via
`structureAdd` event; rejects silently.

### `grenade`

```js
{ type: 'grenade', kind: 'frag' | 'flash' | 'smoke', vx: number, vy: number }
```

Server spawns grenade entity at player position with velocity (vx, vy),
advances it server-side, detonates on impact or timer.

### `fpvLaunch`

```js
{ type: 'fpvLaunch', vx: number, vy: number }
```

Server spawns FPV kamikaze drone, flies it under the player's control
inputs (which arrive as further `input` messages while FPV is active —
the input scope is reinterpreted as drone control).

### `recruit`

```js
{ type: 'recruit', targetBotId: number }
```

Server validates SEED diff (> 10), KO state, range (< 60 u), then
converts the bot to player's team.

### `ping`

```js
{ type: 'ping', x: number, y: number }   // HUD ping
```

Existing message. Broadcast to teammates.

### `emote`

```js
{ type: 'emote', idx: number }   // emote slot 0-7
```

Existing message. Broadcast to all in room.

### `chat`

```js
{ type: 'chat', text: string }   // ≤ 80 chars
```

Future — not in Phase 0-7 scope but reserved.

---

## Server → Client

### `welcome` (once, after `hello`)

```js
{
  type: 'welcome',
  id: number,             // your player id (used for self-vs-other checks)
  tick: number,           // current server tick number
  protoVer: number,
  arena: {
    w: number, h: number,
    map: string,          // 'industrial' | 'forest' | ...
  },
  structures: [           // initial snapshot of player-built structures
    { sid, kind, x, y, hp, team, ... }
  ],
  mission: {              // current mission state
    kind: string,         // 'arena' | 'build_wall' | 'defense'
    teamKills: [number, number],
    wave: number,
    respawnSec: number,
  },
}
```

### `snapshot` (20-30 Hz; the hot path)

```js
{
  type: 'snapshot',
  tick: number,           // server tick number when snapshot was built
  sT: number,             // server timestamp (ms)
  ackSeq: number,         // last input seq from THIS client that was applied

  players: [
    {
      id: number,
      x: number, y: number,
      angle: number,
      gunAngle: number,
      hp: number,
      alive: 0 | 1,
      // cosmetic (only changes when relevant; could be event-driven later):
      name: string,
      weapon: string,
      chassis: string,
      ammo: number,
      reloadT: number,    // 0 = not reloading, else seconds remaining
      sprintT: number,    // 0..1 stamina ratio
      invulnT: number,    // 0 = vulnerable
      seed: number,
    }
  ],

  bots: [                 // NEW in Phase 3 — what was nnTick's allies/enemies
    {
      id: number,
      x: number, y: number,
      angle: number,
      hp: number,
      alive: 0 | 1,
      team: 0 | 1,
      callsign: string,
      chassis: string,
      weapon: string,
      useNN: 0 | 1,       // false = FSM controlled (rare; for compat)
      diff: string,       // 'easy' | 'medium' | ... | 'elite'
      koStunned: 0 | 1,   // Phase 18 KO-stun state for recruit cue
      invulnT: number,
      seed: number,
      // Phase 97 telemetry — useful for the "!" alert indicator:
      aiMode: 'patrol' | 'combat',
      recentDmg: number,  // 0..90 (ticks since last bullet hit)
    }
  ],

  bullets: [              // server-owned (Phase 2 onward)
    {
      id: number,
      x: number, y: number,
      vx: number, vy: number,
      life: number,       // ticks remaining
      weaponName: string,
      shooter: number,    // player or bot id; -1 = environment (turret)
      fromAlly: 0 | 1,
      isRocket: 0 | 1,
    }
  ],

  // Delta-encoded — only structures whose state changed since last
  // snapshot. Initial set arrives in welcome.structures. Removals come
  // via structureGone events.
  structuresΔ: [
    { sid: number, hp: number /* etc */ }
  ],

  // Mission patches — only fields that changed:
  missionΔ: {
    teamKills?: [number, number],
    wave?: number,
    respawnSec?: number,
  },
}
```

Snapshot interpolation: client buffers the last 2 snapshots, renders
at `serverT − INTERP_DELAY` (~100 ms). Own-player position uses
prediction instead of interpolation (see Phase 1).

### `hit` (event)

```js
{ type: 'hit', victim: number, shooter: number, hp: number, weapon: string, x: number, y: number, lc: number }
```

Existing message (lag-compensated hit confirm). After Phase 2 this is
the only path that decrements anyone's HP locally for the kill-feed
HUD; the snapshot's `players[].hp` is the canonical value.

### `kill` (event)

```js
{ type: 'kill', shooter: number, victim: number, weapon: string, x: number, y: number, lc: number }
```

Existing message. Client triggers explosion + radio callout + score
update. The HP-to-zero is already in the snapshot.

### `wallHit` (event)

```js
{ type: 'wallHit', x: number, y: number, kind: string }
```

Existing. Bullet impact on wall/cover/structure (no damage to it, just
VFX). Saves bandwidth vs sending the whole bullet array every tick.

### `structureAdd` (event)

```js
{ type: 'structureAdd', s: Structure }   // see structures.js for shape
```

Existing. Echoed to every client + the owner.

### `structureHit` (event)

```js
{ type: 'structureHit', sid: number, hp: number, x: number, y: number }
```

Existing.

### `structureGone` (event)

```js
{ type: 'structureGone', sid: number, x: number, y: number, killer?: number }
```

Existing. Removes from local structure list + spawns destruction VFX.

### `grenadeBurst` (event, Phase 5)

```js
{ type: 'grenadeBurst', x: number, y: number, kind: 'frag' | 'flash' | 'smoke', shooter: number }
```

Replaces the current local `detonateRocket` AOE apply path.

### `recruitOk` (event)

```js
{ type: 'recruitOk', botId: number, newTeam: 0 | 1, recruiter: number, callsign: string }
```

Phase 4. Server already applied the recruit. Client plays the SED
conversion VFX.

### `pawnSwapOk` (event)

```js
{ type: 'pawnSwapOk', oldBotId: number, newBotId: number, player: number }
```

Phase 4. Server already applied the swap. Client camera + HUD pivot
to the new body.

### `mission` (event)

```js
{ type: 'mission', wave?: number, teamWipe?: { team, respawnAt }, etc. }
```

Mission state changes — wave starts, team-wipe begins, factory captured.
Renders the squad-wiped banner + countdown.

### `leave` (event)

```js
{ type: 'leave', id: number }
```

Existing. A player disconnected. Client removes them from `remotePlayers`.

### `ping` / `emote` (events)

```js
{ type: 'ping', from: number, x: number, y: number }
{ type: 'emote', from: number, idx: number }
```

Existing relays.

### `error` (event)

```js
{ type: 'error', code: string, msg: string }
```

Validation failures (e.g. tried to recruit out-of-range bot). Client
shows a HUD toast.

---

## Mapping from today's protocol to the target

| Today's message      | Lives in `server/party/server.js` | Target |
|----------------------|-----------------------------------|--------|
| `welcome`            | line ~410                          | rename to `welcome`, add `structures`, `mission` (Phase 3) |
| `snapshot`           | line ~862                          | add `bots`, `bullets` (Phase 2+3), delta-encode structures (Phase 5) |
| `input`              | line ~510                          | add `grenade`, `pawnSwap` fields. Drop separate messages where possible. |
| `bullet` (single)    | line ~672                          | **delete** — bullets live in snapshots after Phase 2 |
| `hit`                | line ~727                          | keep, drop the duplicate `b.shooter` field — pull from snapshot |
| `kill`               | line ~772                          | keep |
| `wallHit`            | line ~700                          | keep |
| `build`              | line ~613                          | keep, validate server-side |
| `structureAdd/Hit/Gone` | line ~647, ~750, ~759           | keep |
| `ping`, `emote`      | line ~801                          | keep, rename `from` → conform to new id |
| `leave`              | line ~870                          | keep |

New messages added by phases:
- `bots` field on snapshot (Phase 3)
- `bullets` field on snapshot (Phase 2 — replaces the `bullet` event)
- `equip`, `pawnSwap`, `grenade`, `fpvLaunch`, `recruit` (Phase 4-5)
- `grenadeBurst`, `recruitOk`, `pawnSwapOk`, `mission` events (Phase 4-5)

Removed:
- The local `_mpGhost` bullet mechanic (client-side) is gone after Phase 2
- The `_mpIgnoreReconcileUntil` window logic shrinks dramatically once
  the position predictor is exact (Phase 1)

---

## Versioning

`protoVer` is bumped each time the schema changes incompatibly. Client
sends its `protoVer` in `hello`; server responds in `welcome`. If the
server's `protoVer` differs by more than the supported window (defined
in `server/party/sim/constants.js`), the connection closes with code
`4001 protocol-mismatch` and the client shows a "RELOAD" prompt.

Current value: **0** (Phase 0 draft).
Target value at end of Phase 6: **1**.
