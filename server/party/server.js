// AshGrid authoritative game server (Phase 36+37+38).
//
// Wings.io-style: server holds the world's truth, ticks at 30Hz,
// broadcasts snapshots at 20Hz. Clients send INPUT (not positions);
// server applies inputs in order, simulates everything, broadcasts
// the result. Hit detection, HP, deaths — all decided here. No more
// "I shot him but he didn't die" desyncs.
//
// Cloudflare Durable Objects via PartyKit. Tick uses setInterval
// inside the DO instance — Cloudflare bills this against the room's
// owner; a room with no players idles cheaply because we tear down
// the interval in onClose-when-empty.
//
// Protocol (JSON over WebSocket):
//
//   client → server
//     {type: 'input', seq, dx, dy, angle, fire, t?, name?}
//         seq = monotonic input number (used for reconciliation)
//         dx, dy = move vector in [-1, 1]
//         angle = facing radians (for fire direction)
//         fire = bool (held)
//         t = client's Date.now() at send time (echoed in snapshot for RTT)
//     {type: 'emote', idx}            (transient, just relayed)
//     {type: 'ping', x, y}            (transient, just relayed)
//
//   server → client
//     {type: 'welcome', id, tick}     (sent once on connect)
//     {type: 'snapshot', tick, players, bullets, sT}
//         sT = server Date.now() at broadcast time (for snapshot interp clock sync)
//         players: [{id, x, y, angle, hp, alive, name, lastInputSeq, invuln, t}]
//             t = echoed client timestamp for own player only (used for RTT)
//         bullets: [{id, x, y, vx, vy, s}]    s = shooter id (short)
//     {type: 'hit', victim, shooter, hp, weapon}    (event, between snapshots)
//     {type: 'kill', shooter, victim, weapon}        (event)
//     {type: 'leave', id}
//     {type: 'emote'|'ping', from, ...}
//
// All deterministic constants live up here so the client can match
// movement feel exactly under prediction.

const TICK_HZ           = 30;
const TICK_MS           = 1000 / TICK_HZ;
const SNAPSHOT_EVERY    = 2;          // every 2 ticks → ~15Hz broadcast
const PLAYER_RADIUS     = 14;
const PLAYER_SPEED      = 5.6;        // px per tick at 30Hz = ~168 px/sec.
                                      // Matches index.html's NN.PLAYER_SPEED (2.8) × 60fps frame
                                      // rate, so client-side prediction (which moves per frame at
                                      // 2.8) and server tick (30Hz at 5.6) agree on apparent
                                      // velocity → reconciliation is a no-op in steady state.
const ARENA_W           = 1800;
const ARENA_H           = 1800;
const ARENA_PAD         = 50;         // wall margin
const HP_MAX            = 100;
const INVULN_TICKS      = 90;         // 3s spawn protection
const RESPAWN_TICKS     = 90;         // 3s respawn timer
const FIRE_COOLDOWN     = 6;          // ticks between shots (≈ 5 shots/sec)
const BULLET_SPEED      = 14;
const BULLET_LIFE       = 60;         // ticks
const BULLET_DAMAGE     = 25;
const BULLET_OFFSET     = 18;         // spawn distance from player center

export default class AshGridRoom {
  constructor(party) {
    this.party = party;
    this.players = new Map();          // peerId → player state
    this.bullets = [];                 // [{id, x, y, vx, vy, life, damage, shooterId, weapon}]
    this.nextBulletId = 1;
    this.tickCount = 0;
    this.lastSnapshotTick = -SNAPSHOT_EVERY;
    this._tickHandle = null;
  }

  // Lazy-start the tick. We don't burn CPU when nobody's connected.
  _ensureTicking() {
    if (this._tickHandle) return;
    this._tickHandle = setInterval(() => this.tick(), TICK_MS);
  }
  _maybeStopTicking() {
    if (this.players.size > 0) return;
    if (!this._tickHandle) return;
    clearInterval(this._tickHandle);
    this._tickHandle = null;
    this.bullets.length = 0;            // wipe stale bullets between sessions
    this.tickCount = 0;
    this.lastSnapshotTick = -SNAPSHOT_EVERY;
  }

  onConnect(conn) {
    const spawn = this._pickSpawn();
    const p = {
      id: conn.id,
      x: spawn.x, y: spawn.y, angle: 0,
      hp: HP_MAX,
      alive: true,
      fireCdUntil: 0,
      invulnUntil: this.tickCount + INVULN_TICKS,
      respawnAt: 0,
      name: 'PLAYER',
      // input applied next tick:
      input: { dx: 0, dy: 0, angle: 0, fire: false, seq: 0 },
      lastInputSeq: 0,
      // Echoed back in snapshot so client can compute RTT.
      lastInputT: 0,
    };
    this.players.set(conn.id, p);
    this._ensureTicking();

    conn.send(JSON.stringify({
      type: 'welcome',
      id: conn.id,
      tick: this.tickCount,
      arena: { w: ARENA_W, h: ARENA_H },
    }));
    // Snapshot will reach the new client on the next broadcast cycle.
    this.party.broadcast(JSON.stringify({ type: 'join', id: conn.id }), [conn.id]);
  }

  onMessage(message, sender) {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    if (!data || typeof data !== 'object') return;
    const p = this.players.get(sender.id);
    if (!p) return;

    if (data.type === 'input') {
      // Stash the latest input. We apply it on the next tick.
      p.input.dx    = clamp(num(data.dx), -1, 1);
      p.input.dy    = clamp(num(data.dy), -1, 1);
      p.input.angle = num(data.angle);
      p.input.fire  = !!data.fire;
      p.input.seq   = num(data.seq) | 0;
      if (p.input.seq > p.lastInputSeq) p.lastInputSeq = p.input.seq;
      // Stamp the freshest client timestamp; echoed back in snapshot for RTT.
      if (typeof data.t === 'number' && data.t > p.lastInputT) p.lastInputT = data.t;
      if (data.name) p.name = String(data.name).slice(0, 12);
      return;
    }
    if (data.type === 'emote' || data.type === 'ping') {
      // Transient peer-to-peer — server just relays.
      data.from = sender.id;
      this.party.broadcast(JSON.stringify(data), [sender.id]);
      return;
    }
    // Unknown types ignored (forward-compat).
  }

  onClose(conn) {
    this.players.delete(conn.id);
    this.party.broadcast(JSON.stringify({ type: 'leave', id: conn.id }));
    this._maybeStopTicking();
  }

  // ─── Tick ──────────────────────────────────────────────────────────
  tick() {
    this.tickCount++;

    // 1. Apply inputs + advance players
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.tickCount >= p.respawnAt) this._respawn(p);
        continue;
      }
      const inp = p.input;
      // Normalize diagonal
      let dx = inp.dx, dy = inp.dy;
      const mag = Math.hypot(dx, dy);
      if (mag > 1) { dx /= mag; dy /= mag; }
      p.x = clamp(p.x + dx * PLAYER_SPEED, ARENA_PAD, ARENA_W - ARENA_PAD);
      p.y = clamp(p.y + dy * PLAYER_SPEED, ARENA_PAD, ARENA_H - ARENA_PAD);
      p.angle = inp.angle;
      // Fire (if cooldown done)
      if (inp.fire && this.tickCount >= p.fireCdUntil) {
        this._spawnBullet(p);
        p.fireCdUntil = this.tickCount + FIRE_COOLDOWN;
      }
    }

    // 2. Advance bullets + hit detection
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx; b.y += b.vy; b.life--;
      if (b.life <= 0 ||
          b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H) {
        this.bullets.splice(i, 1);
        continue;
      }
      // Players are circles of PLAYER_RADIUS
      let consumed = false;
      for (const p of this.players.values()) {
        if (!p.alive || p.id === b.shooterId) continue;
        if (this.tickCount < p.invulnUntil) continue;
        const dx = p.x - b.x, dy = p.y - b.y;
        if (dx * dx + dy * dy < PLAYER_RADIUS * PLAYER_RADIUS) {
          p.hp -= b.damage;
          consumed = true;
          this.party.broadcast(JSON.stringify({
            type: 'hit', victim: p.id, shooter: b.shooterId,
            hp: Math.max(0, p.hp), weapon: b.weapon,
          }));
          if (p.hp <= 0) {
            p.alive = false;
            p.respawnAt = this.tickCount + RESPAWN_TICKS;
            this.party.broadcast(JSON.stringify({
              type: 'kill', shooter: b.shooterId, victim: p.id, weapon: b.weapon,
            }));
          }
          break;
        }
      }
      if (consumed) this.bullets.splice(i, 1);
    }

    // 3. Snapshot every SNAPSHOT_EVERY ticks (≈ 15Hz)
    if (this.tickCount - this.lastSnapshotTick >= SNAPSHOT_EVERY) {
      this.lastSnapshotTick = this.tickCount;
      this._broadcastSnapshot();
    }
  }

  _spawnBullet(p) {
    const ax = Math.cos(p.angle);
    const ay = Math.sin(p.angle);
    this.bullets.push({
      id: this.nextBulletId++,
      x: p.x + ax * BULLET_OFFSET,
      y: p.y + ay * BULLET_OFFSET,
      vx: ax * BULLET_SPEED,
      vy: ay * BULLET_SPEED,
      life: BULLET_LIFE,
      damage: BULLET_DAMAGE,
      shooterId: p.id,
      weapon: 'RIFLE',
    });
  }

  _respawn(p) {
    const spawn = this._pickSpawn();
    p.x = spawn.x; p.y = spawn.y;
    p.hp = HP_MAX;
    p.alive = true;
    p.invulnUntil = this.tickCount + INVULN_TICKS;
  }

  // Pick a spawn point that maximises distance from existing players.
  // Sample 8 candidates, take the one with the largest min-distance to any
  // alive player. Avoids the spawn-camp griefer pattern.
  _pickSpawn() {
    let best = { x: ARENA_W / 2, y: ARENA_H / 2 };
    let bestScore = -1;
    for (let i = 0; i < 8; i++) {
      const cand = {
        x: 200 + Math.random() * (ARENA_W - 400),
        y: 200 + Math.random() * (ARENA_H - 400),
      };
      let minD = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - cand.x, p.y - cand.y);
        if (d < minD) minD = d;
      }
      if (minD === Infinity) minD = 9999;
      if (minD > bestScore) { bestScore = minD; best = cand; }
    }
    return best;
  }

  _broadcastSnapshot() {
    const snap = {
      type: 'snapshot',
      tick: this.tickCount,
      // Server clock at broadcast time. Clients use it to align the
      // snapshot interpolation buffer to a single shared reference, so
      // remote players move in straight lines between known samples
      // instead of easing-toward-target (the "slug crawl" you'd see with
      // pure lerp).
      sT: Date.now(),
      players: [...this.players.values()].map(p => ({
        id: p.id,
        x: round1(p.x),
        y: round1(p.y),
        angle: round3(p.angle),
        hp: p.hp,
        alive: p.alive,
        name: p.name,
        lastInputSeq: p.lastInputSeq,
        invuln: this.tickCount < p.invulnUntil,
        // Latest client timestamp echoed back. Per-player so each client's
        // own entry has its own t for an accurate self-RTT measurement.
        t: p.lastInputT || 0,
      })),
      bullets: this.bullets.map(b => ({
        id: b.id,
        x: round1(b.x),
        y: round1(b.y),
        vx: round1(b.vx),
        vy: round1(b.vy),
        s: b.shooterId,
      })),
    };
    this.party.broadcast(JSON.stringify(snap));
  }
}

function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }
function num(n) { return typeof n === 'number' && isFinite(n) ? n : 0; }
function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }
