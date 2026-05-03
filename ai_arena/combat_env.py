"""
ai_arena/combat_env.py
======================

Gym/Gymnasium environment that wraps the headless 3v3 combat simulator
for PPO training. The friendly team (3 units) is the AGENT being trained;
the enemy team (3 units) is controlled by a "frozen opponent" policy
(GA-best genome, past NN snapshot, or random).

This is the bridge between sim.py (game logic) and stable-baselines3 (PPO).

Observation per unit (~70 floats, all in [-1, 1] or [0, 1]):
  Self info:
     0..1   x_norm, y_norm                  position
     2..3   angle_sin, angle_cos            facing
     4      hp_norm                          health 0..1
     5      recent_damage                    0/1
     6      fire_cd_norm                     cooldown 0..1
     7      is_in_cover                      0/1
  Visible enemies x 3 (most recent / nearest, sorted):
     8..25  for each: dx, dy, dist, hp, visible_now, recently_visible
  Visible teammates x 2 (excluding self):
     26..37 for each: dx, dy, dist, hp, alive, visible_now
  Nearby cover points x 5:
     38..52 for each: dx, dy, dist
  Enemy intel memory:
     53..56 last_seen_dx, last_seen_dy, ticks_since_seen, has_intel
  Sound (recent gunshot):
     57..60 sound_dx, sound_dy, intensity, is_friendly
  Match state:
     61..64 ticks_remaining, my_team_kills, enemy_team_kills, alive_friendly_count

Action (Discrete 18):
  encoded as: action = move_dir * 2 + fire
    move_dir: 0=idle, 1=N, 2=NE, 3=E, 4=SE, 5=S, 6=SW, 7=W, 8=NW
    fire:     0=hold, 1=fire (auto-aim at nearest visible enemy)

Reward (per unit, per tick):
  +0.4 * damage dealt this tick
  -0.2 * damage taken this tick
  +30  per kill credited this tick
  -20  if I died this tick
  +0.005 if alive this tick
  +0.001 * (my_team_kills - enemy_team_kills) per tick (reward team advantage)
  Episode-end:
  +50 if my team won (more kills)
  -50 if my team lost
  0  draw

This file is meant to be IMPORTED by the training notebook.
For the Kaggle notebook version, the same code is inlined into one cell.
"""

import math
import random
from dataclasses import dataclass, field
from typing import List, Optional, Tuple, Callable

import numpy as np

# ============================================================
# Constants — must match sim.py
# ============================================================
WORLD_W       = 1200
WORLD_H       = 1200
TICK_RATE     = 60
PLAYER_SPEED  = 2.8
PLAYER_RADIUS = 14
PLAYER_HP     = 100
BULLET_SPEED  = 14.0
BULLET_LIFE   = 60
BULLET_DAMAGE = 14
RAY_STEPS     = 12

MATCH_SECONDS  = 45
MATCH_TICKS    = MATCH_SECONDS * TICK_RATE
RESPAWN_TICKS  = 5 * TICK_RATE
SQUAD_SIZE     = 3       # 3v3
NN_FIRE_CD     = 8       # frames between shots for NN-controlled units
NN_AIM_LERP    = 0.30    # how fast unit body rotates to face target

# Observation dimensions
OBS_DIM = 65
ACTION_DIM = 18

# 9 movement directions: idle, N, NE, E, SE, S, SW, W, NW
MOVE_DIRS = [
    (0.0, 0.0),                                                # 0 idle
    (0.0, -1.0),                                               # 1 N
    (math.sqrt(0.5), -math.sqrt(0.5)),                         # 2 NE
    (1.0, 0.0),                                                # 3 E
    (math.sqrt(0.5), math.sqrt(0.5)),                          # 4 SE
    (0.0, 1.0),                                                # 5 S
    (-math.sqrt(0.5), math.sqrt(0.5)),                         # 6 SW
    (-1.0, 0.0),                                               # 7 W
    (-math.sqrt(0.5), -math.sqrt(0.5)),                        # 8 NW
]


# ============================================================
# Geometry helpers (mirror sim.py)
# ============================================================

@dataclass
class Wall:
    x: float
    y: float
    w: float
    h: float


def line_blocked(x1, y1, x2, y2, walls):
    dx, dy = x2 - x1, y2 - y1
    for i in range(1, RAY_STEPS):
        t = i / RAY_STEPS
        x, y = x1 + dx * t, y1 + dy * t
        for w in walls:
            if w.x < x < w.x + w.w and w.y < y < w.y + w.h:
                return True
    return False


def push_out_of_walls(unit, walls):
    r = PLAYER_RADIUS
    for w in walls:
        if (w.x - r < unit.x < w.x + w.w + r and
                w.y - r < unit.y < w.y + w.h + r):
            cx, cy = w.x + w.w / 2, w.y + w.h / 2
            ddx, ddy = unit.x - cx, unit.y - cy
            ovx = (w.w / 2 + r) - abs(ddx)
            ovy = (w.h / 2 + r) - abs(ddy)
            if ovx < ovy:
                unit.x += ovx if ddx > 0 else -ovx
            else:
                unit.y += ovy if ddy > 0 else -ovy


def cover_points_for(walls, offset=32):
    cps = []
    for w in walls:
        cx, cy = w.x + w.w / 2, w.y + w.h / 2
        cps.append((cx, w.y - offset))
        cps.append((cx, w.y + w.h + offset))
        cps.append((w.x - offset, cy))
        cps.append((w.x + w.w + offset, cy))
    return cps


# ============================================================
# Maps — same set as GA training, ensures NN trains on diverse layouts
# ============================================================

def map_open():
    return []


def map_pillars():
    return [Wall(280, 280, 80, 80), Wall(840, 280, 80, 80),
            Wall(280, 840, 80, 80), Wall(840, 840, 80, 80)]


def map_cross():
    return [Wall(400, 570, 400, 60), Wall(570, 400, 60, 400)]


def map_maze():
    return [Wall(200, 200, 60, 280), Wall(940, 420, 60, 280),
            Wall(400, 600, 220, 60), Wall(600, 200, 220, 60),
            Wall(500, 800, 60, 200)]


def map_corridor():
    return [Wall(150, 380, 900, 60), Wall(150, 760, 900, 60)]


def map_random(rng_seed):
    rng = random.Random(rng_seed)
    walls = []
    for _ in range(rng.randint(3, 8)):
        w = rng.randint(60, 220)
        h = rng.randint(60, 220)
        x = rng.randint(180, WORLD_W - 180 - w)
        y = rng.randint(180, WORLD_H - 180 - h)
        walls.append(Wall(x, y, w, h))
    return walls


FIXED_MAPS = [map_open, map_pillars, map_cross, map_maze, map_corridor]


def pick_map(seed):
    rng = random.Random(seed)
    if rng.random() < 0.85:
        return rng.choice(FIXED_MAPS)()
    return map_random(seed + 7)


# ============================================================
# Unit + Bullet (sim entities)
# ============================================================

@dataclass
class Unit:
    x: float
    y: float
    angle: float
    hp: int
    team: int
    spawn_x: float
    spawn_y: float
    alive: bool = True
    fire_cd: int = 0
    respawn_cd: int = 0
    last_seen_tx: float = 0.0
    last_seen_ty: float = 0.0
    last_seen_tick: int = -9999
    recent_damage_ticks: int = 0
    kills: int = 0
    deaths: int = 0
    # Per-tick deltas (cleared at end of tick)
    damage_dealt_this_tick: int = 0
    damage_taken_this_tick: int = 0
    killed_this_tick: bool = False
    died_this_tick: bool = False


@dataclass
class Bullet:
    x: float
    y: float
    vx: float
    vy: float
    life: int
    damage: int
    team: int
    shooter_idx: int


# ============================================================
# CombatEnv — the Gym environment
# ============================================================

class CombatEnv:
    """Single match. Friendly team (team 0, 3 units) controlled by external
    policy via step(); enemy team (team 1, 3 units) controlled by opponent.

    Each step takes 3 actions (one per friendly unit) and advances the sim by
    1 tick. Returns 3 observations, 3 rewards, done flag, info.
    """

    def __init__(self,
                 opponent_policy: Callable = None,
                 squad_size: int = SQUAD_SIZE,
                 match_ticks: int = MATCH_TICKS,
                 seed: Optional[int] = None):
        self.squad_size = squad_size
        self.match_ticks = match_ticks
        self.opponent_policy = opponent_policy or random_opponent
        self._seed = seed
        self.reset()

    def reset(self, seed: Optional[int] = None):
        if seed is not None:
            self._seed = seed
        seed = self._seed if self._seed is not None else random.randint(0, 1_000_000)
        random.seed(seed)
        np.random.seed(seed % (2**31))

        self.walls = pick_map(seed)
        self.cover_points = cover_points_for(self.walls)

        self.tick = 0
        self.bullets: List[Bullet] = []

        self.units: List[Unit] = []
        for i in range(self.squad_size):
            self.units.append(Unit(
                x=250, y=200 + i * 80, angle=0.0, hp=PLAYER_HP, team=0,
                spawn_x=250, spawn_y=200 + i * 80,
            ))
        for i in range(self.squad_size):
            self.units.append(Unit(
                x=WORLD_W - 250, y=200 + i * 80, angle=math.pi,
                hp=PLAYER_HP, team=1,
                spawn_x=WORLD_W - 250, spawn_y=200 + i * 80,
            ))

        self.team_kills = [0, 0]
        self.last_sound = None     # (x, y, ticks_ago, is_friendly_to_team_0)
        self.done = False

        return self._observe_team(team=0)

    # ---- step ----
    def step(self, friendly_actions: List[int]):
        """Apply friendly actions (3 ints), get enemy actions from opponent,
        advance the sim by 1 tick. Return (obs_list, reward_list, done, info).
        """
        if self.done:
            raise RuntimeError("Episode is done. Call reset().")

        # Reset per-tick deltas
        for u in self.units:
            u.damage_dealt_this_tick = 0
            u.damage_taken_this_tick = 0
            u.killed_this_tick = False
            u.died_this_tick = False
            if u.recent_damage_ticks > 0:
                u.recent_damage_ticks -= 1
            if u.fire_cd > 0:
                u.fire_cd -= 1
            if not u.alive:
                u.respawn_cd -= 1
                if u.respawn_cd <= 0:
                    u.alive = True
                    u.hp = PLAYER_HP
                    u.x = u.spawn_x
                    u.y = u.spawn_y
                    u.fire_cd = 0

        # 1) Apply friendly actions
        for i, action in enumerate(friendly_actions):
            unit = self.units[i]
            if unit.alive:
                self._apply_action(unit, int(action), my_idx=i)

        # 2) Get + apply enemy actions
        enemy_obs = [self._build_obs_for_unit(self.units[self.squad_size + i],
                                               friendly_team=1)
                     for i in range(self.squad_size)]
        enemy_actions = self.opponent_policy(enemy_obs, self)
        for i, action in enumerate(enemy_actions):
            unit = self.units[self.squad_size + i]
            if unit.alive:
                self._apply_action(unit, int(action), my_idx=self.squad_size + i)

        # 3) Update bullets
        self._update_bullets()

        # 4) Decay last sound
        if self.last_sound is not None:
            self.last_sound = (*self.last_sound[:2], self.last_sound[2] + 1, self.last_sound[3])
            if self.last_sound[2] > 90:  # 1.5 sec memory
                self.last_sound = None

        # 5) Advance tick
        self.tick += 1
        self.done = self.tick >= self.match_ticks

        # 6) Build rewards + obs
        rewards = [self._reward_for(self.units[i]) for i in range(self.squad_size)]
        obs = self._observe_team(team=0)

        # 7) End-of-episode bonus
        info = {}
        if self.done:
            kills_a = self.team_kills[0]
            kills_b = self.team_kills[1]
            if kills_a > kills_b:
                bonus = +50.0
                info['winner'] = 0
            elif kills_b > kills_a:
                bonus = -50.0
                info['winner'] = 1
            else:
                bonus = 0.0
                info['winner'] = -1
            for i in range(self.squad_size):
                rewards[i] += bonus
            info.update({
                'kills_a': kills_a, 'kills_b': kills_b,
            })

        return obs, rewards, self.done, info

    # ---- observation ----
    def _observe_team(self, team: int) -> List[np.ndarray]:
        out = []
        for i in range(self.squad_size):
            unit = self.units[i if team == 0 else self.squad_size + i]
            out.append(self._build_obs_for_unit(unit, friendly_team=team))
        return out

    def _build_obs_for_unit(self, me: Unit, friendly_team: int) -> np.ndarray:
        """Build the ~65-dim observation vector from `me`'s POV.
        `friendly_team` is the team we consider 'friendly' for this view (0 or 1)."""
        obs = np.zeros(OBS_DIM, dtype=np.float32)
        i = 0

        # ---- Self (8) ----
        obs[i] = me.x / WORLD_W * 2 - 1; i += 1
        obs[i] = me.y / WORLD_H * 2 - 1; i += 1
        obs[i] = math.sin(me.angle); i += 1
        obs[i] = math.cos(me.angle); i += 1
        obs[i] = me.hp / PLAYER_HP if me.alive else 0.0; i += 1
        obs[i] = 1.0 if me.recent_damage_ticks > 0 else 0.0; i += 1
        obs[i] = me.fire_cd / NN_FIRE_CD if me.fire_cd > 0 else 0.0; i += 1
        obs[i] = 1.0 if me.alive else 0.0; i += 1

        # ---- Visible enemies x 3 (6 floats each = 18) ----
        enemies = [u for u in self.units if u.team != me.team and u.alive]
        # Sort by distance from me; visible (in cone+LoS) first
        def enemy_key(u):
            d2 = (u.x - me.x) ** 2 + (u.y - me.y) ** 2
            visible = self._is_visible(me, u)
            return (-int(visible), d2)
        enemies.sort(key=enemy_key)

        for k in range(3):
            if k < len(enemies):
                e = enemies[k]
                dx = (e.x - me.x) / WORLD_W * 2
                dy = (e.y - me.y) / WORLD_H * 2
                dist = math.hypot(e.x - me.x, e.y - me.y) / WORLD_W
                hp = e.hp / PLAYER_HP
                visible_now = 1.0 if self._is_visible(me, e) else 0.0
                obs[i:i+6] = [dx, dy, dist, hp, visible_now, 0.0]; i += 6
            else:
                i += 6  # leave zeros

        # ---- Friendly teammates x 2 (6 each = 12) ----
        teammates = [u for u in self.units if u.team == me.team and u is not me]
        teammates.sort(key=lambda u: (u.x - me.x) ** 2 + (u.y - me.y) ** 2)
        for k in range(2):
            if k < len(teammates):
                t = teammates[k]
                dx = (t.x - me.x) / WORLD_W * 2
                dy = (t.y - me.y) / WORLD_H * 2
                dist = math.hypot(t.x - me.x, t.y - me.y) / WORLD_W
                hp = t.hp / PLAYER_HP if t.alive else 0.0
                alive = 1.0 if t.alive else 0.0
                visible_now = 1.0 if self._is_visible(me, t) else 0.0
                obs[i:i+6] = [dx, dy, dist, hp, alive, visible_now]; i += 6
            else:
                i += 6

        # ---- Cover points x 5 (3 each = 15) ----
        cps_sorted = sorted(self.cover_points,
                            key=lambda cp: (cp[0] - me.x) ** 2 + (cp[1] - me.y) ** 2)
        for k in range(5):
            if k < len(cps_sorted):
                cx, cy = cps_sorted[k]
                dx = (cx - me.x) / WORLD_W * 2
                dy = (cy - me.y) / WORLD_H * 2
                dist = math.hypot(cx - me.x, cy - me.y) / WORLD_W
                obs[i:i+3] = [dx, dy, dist]; i += 3
            else:
                i += 3

        # ---- Enemy intel memory (4) ----
        if me.last_seen_tick > -9999:
            obs[i] = (me.last_seen_tx - me.x) / WORLD_W * 2; i += 1
            obs[i] = (me.last_seen_ty - me.y) / WORLD_H * 2; i += 1
            obs[i] = min(1.0, (self.tick - me.last_seen_tick) / 90); i += 1
            obs[i] = 1.0; i += 1
        else:
            i += 4

        # ---- Sound (4) ----
        if self.last_sound is not None:
            sx, sy, ticks_ago, src_team = self.last_sound
            obs[i] = (sx - me.x) / WORLD_W * 2; i += 1
            obs[i] = (sy - me.y) / WORLD_H * 2; i += 1
            obs[i] = max(0.0, 1.0 - ticks_ago / 90); i += 1
            obs[i] = 1.0 if src_team == me.team else -1.0; i += 1
        else:
            i += 4

        # ---- Match state (4) ----
        obs[i] = (self.match_ticks - self.tick) / self.match_ticks; i += 1
        obs[i] = self.team_kills[me.team] / 20.0; i += 1
        obs[i] = self.team_kills[1 - me.team] / 20.0; i += 1
        alive_team = sum(1 for u in self.units if u.team == me.team and u.alive)
        obs[i] = alive_team / self.squad_size; i += 1

        return obs

    # ---- visibility check ----
    def _is_visible(self, me: Unit, target: Unit) -> bool:
        """Same vision rules as sim: must be alive + in 140° cone + LoS clear."""
        if not target.alive:
            return False
        d = math.hypot(target.x - me.x, target.y - me.y)
        if d > 720:  # NN doesn't have variable view range — fixed at 720
            return False
        a = math.atan2(target.y - me.y, target.x - me.x)
        diff = a - me.angle
        while diff > math.pi: diff -= 2 * math.pi
        while diff < -math.pi: diff += 2 * math.pi
        if abs(diff) > math.pi * 0.78 / 2:  # 140° cone half-angle = 70°
            return False
        if line_blocked(me.x, me.y, target.x, target.y, self.walls):
            return False
        return True

    # ---- apply action ----
    def _apply_action(self, unit: Unit, action: int, my_idx: int):
        move_dir = action // 2
        fire = action % 2

        # Movement
        dx, dy = MOVE_DIRS[move_dir]
        if dx != 0 or dy != 0:
            unit.x += dx * PLAYER_SPEED
            unit.y += dy * PLAYER_SPEED
            # Body angle follows movement direction
            unit.angle = math.atan2(dy, dx)
        else:
            # If idle but visible enemy, face nearest enemy
            target = self._nearest_visible_enemy(unit)
            if target is not None:
                desired = math.atan2(target.y - unit.y, target.x - unit.x)
                d = desired - unit.angle
                while d > math.pi: d -= 2 * math.pi
                while d < -math.pi: d += 2 * math.pi
                unit.angle += d * NN_AIM_LERP

        push_out_of_walls(unit, self.walls)
        unit.x = max(20, min(WORLD_W - 20, unit.x))
        unit.y = max(20, min(WORLD_H - 20, unit.y))

        # Fire
        if fire and unit.fire_cd <= 0:
            target = self._nearest_visible_enemy(unit)
            if target is not None and not line_blocked(
                    unit.x, unit.y, target.x, target.y, self.walls):
                # Aim toward target
                aim = math.atan2(target.y - unit.y, target.x - unit.x)
                # Small spread
                aim += (random.random() - 0.5) * 0.05
                unit.angle = aim   # snap face to shot
                self.bullets.append(Bullet(
                    x=unit.x + math.cos(aim) * 16,
                    y=unit.y + math.sin(aim) * 16,
                    vx=math.cos(aim) * BULLET_SPEED,
                    vy=math.sin(aim) * BULLET_SPEED,
                    life=BULLET_LIFE,
                    damage=BULLET_DAMAGE,
                    team=unit.team,
                    shooter_idx=my_idx,
                ))
                unit.fire_cd = NN_FIRE_CD
                unit.last_seen_tx = target.x
                unit.last_seen_ty = target.y
                unit.last_seen_tick = self.tick
                # Sound event
                self.last_sound = (unit.x, unit.y, 0, unit.team)

    def _nearest_visible_enemy(self, me: Unit) -> Optional[Unit]:
        best, best_d = None, float('inf')
        for o in self.units:
            if o is me or not o.alive or o.team == me.team:
                continue
            if not self._is_visible(me, o):
                continue
            d = (o.x - me.x) ** 2 + (o.y - me.y) ** 2
            if d < best_d:
                best, best_d = o, d
        if best is not None:
            me.last_seen_tx = best.x
            me.last_seen_ty = best.y
            me.last_seen_tick = self.tick
        return best

    # ---- update bullets ----
    def _update_bullets(self):
        survivors = []
        for b in self.bullets:
            b.x += b.vx
            b.y += b.vy
            b.life -= 1
            if b.life <= 0:
                continue
            # Wall hit?
            hit = False
            for w in self.walls:
                if w.x < b.x < w.x + w.w and w.y < b.y < w.y + w.h:
                    hit = True; break
            if hit:
                continue
            # Unit hit?
            hit_unit = None
            for u in self.units:
                if not u.alive or u.team == b.team:
                    continue
                if (b.x - u.x) ** 2 + (b.y - u.y) ** 2 < PLAYER_RADIUS ** 2:
                    hit_unit = u; break
            if hit_unit is not None:
                applied = min(b.damage, hit_unit.hp)
                hit_unit.hp -= b.damage
                hit_unit.recent_damage_ticks = 60
                hit_unit.damage_taken_this_tick += applied
                if 0 <= b.shooter_idx < len(self.units):
                    self.units[b.shooter_idx].damage_dealt_this_tick += applied
                if hit_unit.hp <= 0:
                    hit_unit.alive = False
                    hit_unit.died_this_tick = True
                    hit_unit.deaths += 1
                    hit_unit.respawn_cd = RESPAWN_TICKS
                    if 0 <= b.shooter_idx < len(self.units):
                        self.units[b.shooter_idx].kills += 1
                        self.units[b.shooter_idx].killed_this_tick = True
                        self.team_kills[b.team] += 1
                continue
            survivors.append(b)
        self.bullets = survivors

    # ---- reward shaping ----
    def _reward_for(self, unit: Unit) -> float:
        r = 0.0
        r += 0.4 * unit.damage_dealt_this_tick
        r -= 0.2 * unit.damage_taken_this_tick
        if unit.killed_this_tick:
            r += 30.0
        if unit.died_this_tick:
            r -= 20.0
        if unit.alive:
            r += 0.005
        # Tiny bias toward team advantage
        r += 0.001 * (self.team_kills[unit.team] - self.team_kills[1 - unit.team])
        return r


# ============================================================
# Opponent policies
# ============================================================

def random_opponent(obs_list, env: CombatEnv) -> List[int]:
    """Random actions. Bad opponent — useful as the very first sparring partner."""
    return [random.randint(0, ACTION_DIM - 1) for _ in obs_list]


def idle_opponent(obs_list, env: CombatEnv) -> List[int]:
    """Stand still and never fire. Punching bag for sanity tests."""
    return [0 for _ in obs_list]   # action 0 = idle, no fire


def make_ga_opponent(genome_dict: dict):
    """Wrap a GA genome as an opponent policy. Uses the GA's behaviour-tree
    state machine instead of NN inference. Provides a strong, varied opponent
    early in training so the NN doesn't only learn to beat random.
    """
    # Lazy import to avoid hard dependency
    try:
        from ai_arena import kaggle_train as ga_sim
    except ImportError:
        import kaggle_train as ga_sim

    def policy(obs_list, env: CombatEnv):
        # GA AI takes the same Unit struct + walls/cover etc.
        # We re-use the GA update_unit on each enemy unit, but it modifies state
        # and produces bullets via env.bullets — so we just call it with env's
        # walls/cover. This is a "cross-control" approach: GA driver writes
        # actions that match env state.
        actions = []
        for i, unit in enumerate(env.units[env.squad_size:]):
            if not unit.alive:
                actions.append(0); continue
            # GA decides — but our env is action-driven, so derive action from
            # GA's chosen movement after a "shadow tick".
            actions.append(_ga_decide_action(unit, env, genome_dict))
        return actions
    return policy


def _ga_decide_action(unit: Unit, env: CombatEnv, p: dict) -> int:
    """Decide a discrete action for one unit using GA-style reasoning.
    Quick adaptation: pick movement toward (or away from) target, fire if LoS.
    """
    # Find nearest visible target
    target = None
    best_d = float('inf')
    for o in env.units:
        if not o.alive or o.team == unit.team:
            continue
        d = (o.x - unit.x) ** 2 + (o.y - unit.y) ** 2
        # Use genome's view_arc/range for visibility
        view_range_sq = p['view_range'] ** 2
        if d > view_range_sq:
            continue
        a = math.atan2(o.y - unit.y, o.x - unit.x)
        diff = a - unit.angle
        while diff > math.pi: diff -= 2 * math.pi
        while diff < -math.pi: diff += 2 * math.pi
        if abs(diff) > p['view_arc'] / 2:
            continue
        if line_blocked(unit.x, unit.y, o.x, o.y, env.walls):
            continue
        if d < best_d:
            target, best_d = o, d

    if target is not None:
        # Move toward target if too far, away if too close
        dx = target.x - unit.x
        dy = target.y - unit.y
        dist = math.hypot(dx, dy)
        engage_d = p['engage_distance']
        if dist > engage_d * 1.2:
            mx, my = dx / dist, dy / dist          # advance
        elif dist < engage_d * 0.7:
            mx, my = -dx / dist, -dy / dist        # retreat
        else:
            mx, my = 0.0, 0.0                       # hold
        move_dir = _vector_to_movedir(mx, my)
        return move_dir * 2 + 1   # fire
    else:
        # Patrol — drift forward
        mx, my = math.cos(unit.angle), math.sin(unit.angle)
        return _vector_to_movedir(mx, my) * 2  # no fire


def _vector_to_movedir(mx: float, my: float) -> int:
    """Convert (mx, my) unit vector to nearest of 9 movement directions."""
    if abs(mx) < 0.2 and abs(my) < 0.2:
        return 0  # idle
    angle = math.atan2(my, mx)
    # Map to 8-way: idle is 0, dirs 1..8 are N, NE, E, SE, S, SW, W, NW
    # angle 0 = E (dir 3), -π/2 = N (dir 1), π/2 = S (dir 5)
    # So convert: dir = round(((-angle) / (π/4) + 5) % 8) ... messy. Use lookup.
    dir_angles = {
        1: -math.pi / 2,                  # N
        2: -math.pi / 4,                  # NE
        3: 0.0,                            # E
        4: math.pi / 4,                   # SE
        5: math.pi / 2,                   # S
        6: 3 * math.pi / 4,               # SW
        7: math.pi,                        # W (or -pi)
        8: -3 * math.pi / 4,              # NW
    }
    best, best_diff = 1, math.pi
    for d, a in dir_angles.items():
        diff = abs(((angle - a + math.pi) % (2 * math.pi)) - math.pi)
        if diff < best_diff:
            best_diff = diff
            best = d
    return best


# ============================================================
# SB3-friendly Gymnasium wrapper
# ============================================================
# Exposes one friendly unit at a time as a single-agent env. The other 2
# friendlies + 3 enemies share the same internal env. We multiplex by
# rotating which unit is "the agent" each step. SB3 sees this as a normal
# single-agent gym env.

try:
    import gymnasium as gym
    from gymnasium import spaces
except ImportError:
    import gym
    from gym import spaces


class SinglePerspectiveEnv(gym.Env):
    """Wraps CombatEnv into a single-agent gym env by training all 3
    friendly units simultaneously. Each `step` collects ONE unit's
    transition, but advances the underlying env every 3 calls (when all
    3 units have submitted their action for the same tick).

    Simpler alternative: just train one unit's policy; other friendlies
    use the SAME shared policy (parameter sharing). To keep the
    implementation simple, we do parameter-sharing by running the env
    with a shared policy reference.

    For the FIRST version, even simpler: train policy on all 3 friendly
    units, but treat each tick as 3 separate transitions. SB3 sees:
        obs = current friendly unit's view
        step takes 1 action, advances...

    To keep correctness, we cache actions until we have all 3, then step
    underlying env once.
    """

    metadata = {'render_modes': []}

    def __init__(self,
                 opponent_policy_fn: Callable = None,
                 squad_size: int = SQUAD_SIZE,
                 match_ticks: int = MATCH_TICKS,
                 seed: Optional[int] = None):
        super().__init__()
        self.observation_space = spaces.Box(
            low=-1.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32)
        self.action_space = spaces.Discrete(ACTION_DIM)

        self._opponent_policy_fn = opponent_policy_fn or (lambda: random_opponent)
        self._inner = CombatEnv(
            opponent_policy=self._opponent_policy_fn(),
            squad_size=squad_size, match_ticks=match_ticks, seed=seed,
        )
        self._squad_size = squad_size
        self._cur_friendly_idx = 0
        self._pending_actions = [0] * squad_size
        self._last_obs = self._inner._observe_team(team=0)

    def reset(self, seed: Optional[int] = None, options=None):
        # Re-roll opponent (so each episode can have a different sparring partner)
        self._inner.opponent_policy = self._opponent_policy_fn()
        obs_list = self._inner.reset(seed=seed)
        self._last_obs = obs_list
        self._cur_friendly_idx = 0
        self._pending_actions = [0] * self._squad_size
        return obs_list[0], {}

    def step(self, action):
        # Cache this unit's action
        self._pending_actions[self._cur_friendly_idx] = int(action)
        self._cur_friendly_idx += 1

        if self._cur_friendly_idx < self._squad_size:
            # Not yet all 3 friendlies decided — return next friendly's obs
            # without advancing the world. Reward = 0, done = False.
            obs = self._last_obs[self._cur_friendly_idx]
            return obs, 0.0, False, False, {}

        # All 3 actions collected — advance the world
        obs_list, rewards, done, info = self._inner.step(self._pending_actions)
        # Sum rewards across the team for THIS step (or use mean — both work)
        total_reward = float(sum(rewards) / self._squad_size)
        self._last_obs = obs_list
        self._cur_friendly_idx = 0
        self._pending_actions = [0] * self._squad_size

        # Return the FIRST unit's next obs as the "next obs" for SB3
        return obs_list[0], total_reward, done, False, info


# ============================================================
# Minimal sanity test (run this file directly)
# ============================================================
if __name__ == '__main__':
    print("CombatEnv sanity check...")
    env = CombatEnv(opponent_policy=random_opponent, seed=42)
    obs = env.reset(seed=42)
    print(f"  reset() returned {len(obs)} observations of shape {obs[0].shape}")
    print(f"  walls: {len(env.walls)}, cover_points: {len(env.cover_points)}")

    total_reward = [0.0] * SQUAD_SIZE
    for tick in range(MATCH_TICKS):
        actions = [random.randint(0, ACTION_DIM - 1) for _ in range(SQUAD_SIZE)]
        obs, rewards, done, info = env.step(actions)
        for i, r in enumerate(rewards):
            total_reward[i] += r
        if done:
            print(f"  match ended at tick {tick}: kills_a={env.team_kills[0]}, "
                  f"kills_b={env.team_kills[1]}, info={info}")
            break

    print(f"  total reward per friendly unit: "
          f"{[round(r, 1) for r in total_reward]}")

    print("\n SinglePerspectiveEnv (SB3 wrapper) sanity check...")
    senv = SinglePerspectiveEnv(seed=42)
    obs, _ = senv.reset(seed=42)
    print(f"  reset returns obs shape {obs.shape}")
    for _ in range(20):
        action = senv.action_space.sample()
        obs, r, done, trunc, info = senv.step(action)
        if done:
            break
    print(f"  step works, action_space = {senv.action_space}, "
          f"obs_space = {senv.observation_space.shape}")

    print("\n OK.")
