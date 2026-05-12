// AshGrid multiplayer room — PartyKit / Cloudflare Durable Objects.
//
// One Durable Object instance per room (room name = URL path segment).
// Client connects via WebSocket and exchanges JSON messages with the
// other players in the same room.
//
// Architecture: broadcast relay (NOT authoritative).
//   - Server doesn't simulate the game — just relays input + events.
//   - Each client is still the authority for their own player (pos, hp).
//   - This is the same trust model we had with Trystero, but on a
//     reliable server connection instead of P2P WebRTC.
//   - Cheat resistance is poor; revisit when the game has more users
//     (move bullet resolution to server-side).
//
// Free tier: Cloudflare Workers Free includes 100k requests/day +
// 13ms CPU per request. Durable Objects are billed separately —
// 1M requests/mo + 400k GB-s free. For a hobby .io game this is
// effectively infinite.
//
// Messages from client → server:
//   { type: 'pos',   x, y, angle, name }            position update (~20Hz)
//   { type: 'fire',  x, y, angle, ...weapon }       single shot broadcast
//   { type: 'kill',  shooterId, weapon }            victim reports their death
//   { type: 'emote', idx }                           emote bubble
//   { type: 'ping',  x, y }                          map ping
//
// Messages from server → client:
//   { type: 'welcome', id, peers }                   on connect: own id + others
//   { type: 'join',   id }                           someone connected
//   { type: 'leave',  id }                           someone disconnected
//   { type: 'pos'|'fire'|'kill'|'emote'|'ping', from, ... }
//                                                   tagged-with-sender relay
//
// Allowed message types — anything else is dropped. Keeps the relay
// from being abused as a generic chat channel.
const ALLOWED = new Set(['pos', 'fire', 'kill', 'emote', 'ping']);

export default class AshGridRoom {
  constructor(party) {
    this.party = party;
  }

  // Called once per new WebSocket connection. PartyKit assigns each
  // connection a stable id we expose as the player's selfId.
  onConnect(conn) {
    const peers = [];
    for (const c of this.party.getConnections()) {
      if (c.id !== conn.id) peers.push(c.id);
    }
    conn.send(JSON.stringify({ type: 'welcome', id: conn.id, peers }));
    // Tell everyone else (excluding the new joiner) that someone joined.
    this.party.broadcast(
      JSON.stringify({ type: 'join', id: conn.id }),
      [conn.id]
    );
  }

  // Each client message becomes a broadcast to all other connections,
  // tagged with the sender's id so receivers know who to attribute it
  // to. We refuse to relay messages we don't recognize.
  onMessage(message, sender) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (!ALLOWED.has(data.type)) return;
    data.from = sender.id;
    // Trust the sender's pos/angle but cap obvious abuse (huge bursts).
    // 1 KB per message is plenty for our payloads — drop anything bigger.
    const out = JSON.stringify(data);
    if (out.length > 1024) return;
    this.party.broadcast(out, [sender.id]);
  }

  onClose(conn) {
    this.party.broadcast(JSON.stringify({ type: 'leave', id: conn.id }));
  }

  onError(conn, err) {
    // Just close on error — PartyKit will fire onClose afterwards.
    try { conn.close(); } catch {}
  }
}
