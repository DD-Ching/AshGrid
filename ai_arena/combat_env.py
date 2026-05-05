"""
ai_arena/combat_env.py
======================

Gym/Gymnasium environment that wraps the headless 3v3 combat simulator
for PPO training.

CURRICULUM-ENABLED VERSION
--------------------------
Every episode resets with a `Curriculum` snapshot that controls:
  - World size (600..1200 sq)         smaller = harder to evade
  - Spawn distance (200..700 u)       smaller = forces engagement
  - Match length (15..45 sec)         shorter = denser gradient
  - Opponent mix                       static/runner/GA/self/random
  - Reward shaping coefficients        visibility + approach bonus, decay
The deployment world is 1200x1200, so the curriculum's FINAL stage matches
deployment scale exactly — model stays in-distribution at game time.

Observation per unit (65 floats, all in [-1, 1] or [0, 1]):
  Self info:
     0..1   x_norm, y_norm                  position (normalized by current WORLD_W/H)
     2..3   angle_sin, angle_cos            facing
     4      hp_norm                          health 0..1
     5      recent_damage                    0/1
     6      fire_cd_norm                     cooldown 0..1
     7      is_alive                         0/1
  Visible enemies x 3:
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
"""

import math
import random
from dataclasses import dataclass, field
from typing import List, Optional, Callable

import numpy as np

# ============================================================
# Constants
# ============================================================
DEPLOY_WORLD_W = 1200          # JS arena size — final curriculum stage matches this
DEPLOY_WORLD_H = 1200
TICK_RATE      = 60
PLAYER_SPEED   = 2.8
PLAYER_RADIUS  = 14
PLAYER_HP      = 100
BULLET_SPEED   = 14.0
BULLET_LIFE    = 60
BULLET_DAMAGE  = 14
RAY_STEPS      = 12

DEFAULT_MATCH_SECONDS = 45
DEFAULT_MATCH_TICKS   = DEFAULT_MATCH_SECONDS * TICK_RATE
RESPAWN_TICKS         = 5 * TICK_RATE
SQUAD_SIZE            = 3
NN_FIRE_CD            = 8
NN_AIM_LERP           = 0.30

VIEW_RANGE  = 720.0           # NN's fixed vision range
VIEW_HALF   = math.pi * 0.78 / 2   # 70° half-angle (140° cone)

OBS_DIM    = 65
ACTION_DIM = 18

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
# Curriculum schedule
# ============================================================
@dataclass
class Curriculum:
    """A snapshot of curriculum parameters applied to one episode.

    The trainer should mutate these between episodes (typically via a
    callback that updates a shared Curriculum object based on global
    step count). The env reads the snapshot at reset() time.
    """
    world_w: int = DEPLOY_WORLD_W
    world_h: int = DEPLOY_WORLD_H
    spawn_dist: float = 700.0          # x-distance between blue & red spawns
    match_ticks: int = DEFAULT_MATCH_TICKS

    # Opponent mix probabilities (sum should be 1.0)
    p_static:  float = 0.0             # idle, never fires (punching bag)
    p_runner:  float = 0.0             # moves randomly, occasional fire
    p_random:  float = 0.10            # uniform random actions
    p_ga:      float = 0.50            # GA-best genome
    p_self:    float = 0.40            # frozen self snapshot

    # Reward shaping coefficients (decay over training)
    coef_visibility: float = 0.05      # bonus per tick when any enemy visible
    coef_approach:   float = 0.002     # per (1 - dist_to_nearest_visible / world_w)
    coef_aimcone:    float = 0.01      # bonus when an enemy is in firing cone

    # Reward base coefficients (always on)
    coef_dmg_dealt:  float = 0.4
    coef_dmg_taken:  float = 0.2
    coef_kill:       float = 30.0
    coef_death:      float = 20.0
    coef_alive:      float = 0.005
    coef_team_lead:  float = 0.001
    coef_episode_win: float = 50.0

    # "Fear-death" mode: dead units STAY dead and the episode terminates as
    # soon as one team is fully wiped. Combined with high coef_death this
    # teaches the agent that dying genuinely costs the team — no more
    # rush-and-respawn behavior.
    disable_respawn: bool = False


def curriculum_for_step(step: int, total_steps: int) -> Curriculum:
    """Map a global step counter onto a Curriculum snapshot.

    Stage budget is tilted toward stage 4 (deployment scale) — that's
    where the policy gets refined for the actual game-time distribution.

      Stage 1 (0-15%):    600x600   spawn 200u   static+random opp,    heavy shaping
      Stage 2 (15-35%):   900x900   spawn 400u   runner+GA+self,       medium shaping
      Stage 3 (35-55%):   1100x1100 spawn 550u   GA+self,              light shaping
      Stage 4 (55-100%):  1200x1200 spawn 700u   GA+self,              NO shaping
                                                 (deployment scale, matches JS NN_ARENA)
    Reward shaping decays to 0 by the end of stage 3 → stage 4 trains on
    pure kill/death signal at deployment scale.
    """
    p = max(0.0, min(1.0, step / max(1, total_steps)))

    if p < 0.15:
        # Stage 1: cramped, close spawn, slow opponent — aim/fire reflex
        s = p / 0.15
        return Curriculum(
            world_w=600, world_h=600,
            spawn_dist=200 + s * 100,                # 200 → 300
            match_ticks=20 * TICK_RATE,
            p_static=0.7 - s * 0.4,                  # 0.7 → 0.3
            p_runner=0.0 + s * 0.3,                  # 0.0 → 0.3
            p_random=0.3 - s * 0.1,                  # 0.3 → 0.2
            p_ga=0.0 + s * 0.2,                      # 0.0 → 0.2
            p_self=0.0,
            coef_visibility=0.10,
            coef_approach=0.004,
            coef_aimcone=0.02,
        )
    elif p < 0.35:
        # Stage 2: medium map, runner+GA opponents — tracking + decent fight
        s = (p - 0.15) / 0.20
        return Curriculum(
            world_w=900, world_h=900,
            spawn_dist=350 + s * 100,                # 350 → 450
            match_ticks=30 * TICK_RATE,
            p_static=0.0,
            p_runner=0.3 - s * 0.2,                  # 0.3 → 0.1
            p_random=0.2 - s * 0.1,                  # 0.2 → 0.1
            p_ga=0.4 + s * 0.1,                      # 0.4 → 0.5
            p_self=0.1 + s * 0.2,                    # 0.1 → 0.3
            coef_visibility=0.06,
            coef_approach=0.0025,
            coef_aimcone=0.012,
        )
    elif p < 0.55:
        # Stage 3: near-deployment, varied opponents — full combat with decaying shaping
        s = (p - 0.35) / 0.20
        return Curriculum(
            world_w=int(1000 + s * 100),             # 1000 → 1100
            world_h=int(1000 + s * 100),
            spawn_dist=500 + s * 100,                # 500 → 600
            match_ticks=int(35 * TICK_RATE + s * 5 * TICK_RATE),
            p_static=0.0, p_runner=0.0,
            p_random=0.10,
            p_ga=0.50 - s * 0.10,                    # 0.50 → 0.40
            p_self=0.40 + s * 0.10,                  # 0.40 → 0.50
            coef_visibility=0.03 * (1 - s),
            coef_approach=0.0015 * (1 - s),
            coef_aimcone=0.006 * (1 - s),
        )
    else:
        # Stage 4 (45% of budget): deployment scale, no shaping — pure reward signal
        return Curriculum(
            world_w=DEPLOY_WORLD_W, world_h=DEPLOY_WORLD_H,
            spawn_dist=700.0,
            match_ticks=DEFAULT_MATCH_TICKS,
            p_static=0.0, p_runner=0.0,
            p_random=0.10, p_ga=0.40, p_self=0.50,
            coef_visibility=0.0,
            coef_approach=0.0,
            coef_aimcone=0.0,
        )


# ============================================================
# Geometry helpers
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
# Maps — scaled to current world size
# ============================================================
def _scale_walls(walls, world_w, world_h):
    sx = world_w / DEPLOY_WORLD_W
    sy = world_h / DEPLOY_WORLD_H
    return [Wall(w.x * sx, w.y * sy, w.w * sx, w.h * sy) for w in walls]


def _map_open(world_w, world_h):
    return []


def _map_pillars(world_w, world_h):
    base = [Wall(280, 280, 80, 80), Wall(840, 280, 80, 80),
            Wall(280, 840, 80, 80), Wall(840, 840, 80, 80)]
    return _scale_walls(base, world_w, world_h)


def _map_cross(world_w, world_h):
    base = [Wall(400, 570, 400, 60), Wall(570, 400, 60, 400)]
    return _scale_walls(base, world_w, world_h)


def _map_maze(world_w, world_h):
    base = [Wall(200, 200, 60, 280), Wall(940, 420, 60, 280),
            Wall(400, 600, 220, 60), Wall(600, 200, 220, 60),
            Wall(500, 800, 60, 200)]
    return _scale_walls(base, world_w, world_h)


def _map_corridor(world_w, world_h):
    base = [Wall(150, 380, 900, 60), Wall(150, 760, 900, 60)]
    return _scale_walls(base, world_w, world_h)


def _map_random(rng_seed, world_w, world_h):
    rng = random.Random(rng_seed)
    walls = []
    for _ in range(rng.randint(2, 6)):
        w = rng.randint(60, max(80, world_w // 6))
        h = rng.randint(60, max(80, world_h // 6))
        margin = max(120, world_w // 10)
        x = rng.randint(margin, world_w - margin - w)
        y = rng.randint(margin, world_h - margin - h)
        walls.append(Wall(x, y, w, h))
    return walls


FIXED_MAPS = [_map_open, _map_pillars, _map_cross, _map_maze, _map_corridor]


def pick_map(seed, world_w, world_h):
    rng = random.Random(seed)
    if rng.random() < 0.85:
        return rng.choice(FIXED_MAPS)(world_w, world_h)
    return _map_random(seed + 7, world_w, world_h)


# ============================================================
# Unit + Bullet
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
    damage_dealt_this_tick: int = 0
    damage_taken_this_tick: int = 0
    killed_this_tick: bool = False
    died_this_tick: bool = False
    runner_dir: int = 1     # for runner_opponent state
    # Per-frame velocity tracking — for target leading. Set every step from
    # the position delta vs the prior frame.
    last_x: float = 0.0
    last_y: float = 0.0
    vel_x: float = 0.0
    vel_y: float = 0.0


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
# CombatEnv
# ============================================================

class CombatEnv:
    """Single match. The friendly team (team 0) is controlled via step();
    the enemy team (team 1) is controlled by `opponent_policy`. Curriculum
    parameters are read at reset() from `self.curriculum` (mutate it
    between episodes for course progression).
    """

    def __init__(self,
                 opponent_policy: Callable = None,
                 squad_size: int = SQUAD_SIZE,
                 curriculum: Optional[Curriculum] = None,
                 seed: Optional[int] = None):
        self.squad_size = squad_size
        self.curriculum = curriculum if curriculum is not None else Curriculum()
        self.opponent_policy = opponent_policy or random_opponent
        self._seed = seed

        # Set by reset()
        self.world_w = self.curriculum.world_w
        self.world_h = self.curriculum.world_h
        self.match_ticks = self.curriculum.match_ticks
        self.cur = self.curriculum

        self.reset()

    def reset(self, seed: Optional[int] = None):
        if seed is not None:
            self._seed = seed
        seed = self._seed if self._seed is not None else random.randint(0, 1_000_000)
        random.seed(seed)
        np.random.seed(seed % (2**31))

        # Snapshot curriculum at reset time
        self.cur = self.curriculum
        self.world_w = max(400, int(self.cur.world_w))
        self.world_h = max(400, int(self.cur.world_h))
        self.match_ticks = int(self.cur.match_ticks)

        self.walls = pick_map(seed, self.world_w, self.world_h)
        self.cover_points = cover_points_for(self.walls)

        self.tick = 0
        self.bullets: List[Bullet] = []

        # Spawn placement: blue at left, red at right, separated by spawn_dist
        spawn_dist = max(120.0, min(self.world_w - 200, self.cur.spawn_dist))
        cx = self.world_w / 2
        cy = self.world_h / 2
        blue_x = cx - spawn_dist / 2
        red_x  = cx + spawn_dist / 2

        self.units: List[Unit] = []
        for i in range(self.squad_size):
            offset_y = (i - (self.squad_size - 1) / 2) * 80
            self.units.append(Unit(
                x=blue_x, y=cy + offset_y, angle=0.0,
                hp=PLAYER_HP, team=0,
                spawn_x=blue_x, spawn_y=cy + offset_y,
            ))
        for i in range(self.squad_size):
            offset_y = (i - (self.squad_size - 1) / 2) * 80
            self.units.append(Unit(
                x=red_x, y=cy + offset_y, angle=math.pi,
                hp=PLAYER_HP, team=1,
                spawn_x=red_x, spawn_y=cy + offset_y,
            ))

        self.team_kills = [0, 0]
        self.last_sound = None
        self.done = False

        return self._observe_team(team=0)

    # ---- step ----
    def step(self, agent_actions: List[int], agent_team: int = 0):
        """Apply agent_actions to agent_team's units. Other team is driven by
        opponent_policy. Defaults to agent_team=0 for backward compatibility
        with training code that always trained as the blue/team-0 side."""
        if self.done:
            raise RuntimeError("Episode is done. Call reset().")
        opp_team = 1 - agent_team

        # Per-frame velocity snapshot — used by target leading in the fire
        # path. Captures the prior tick's actual displacement.
        for u in self.units:
            u.vel_x = u.x - u.last_x
            u.vel_y = u.y - u.last_y
            u.last_x = u.x
            u.last_y = u.y

        for u in self.units:
            u.damage_dealt_this_tick = 0
            u.damage_taken_this_tick = 0
            u.killed_this_tick = False
            u.died_this_tick = False
            if u.recent_damage_ticks > 0:
                u.recent_damage_ticks -= 1
            if u.fire_cd > 0:
                u.fire_cd -= 1
            if not u.alive and not self.cur.disable_respawn:
                u.respawn_cd -= 1
                if u.respawn_cd <= 0:
                    u.alive = True
                    u.hp = PLAYER_HP
                    u.x = u.spawn_x
                    u.y = u.spawn_y
                    u.fire_cd = 0

        agent_offset = agent_team * self.squad_size
        opp_offset   = opp_team   * self.squad_size

        # Agent's actions
        for i, action in enumerate(agent_actions):
            unit = self.units[agent_offset + i]
            if unit.alive:
                self._apply_action(unit, int(action), my_idx=agent_offset + i)

        # Opponent actions (built from opponent's POV)
        opp_obs = [self._build_obs_for_unit(self.units[opp_offset + i],
                                             friendly_team=opp_team)
                   for i in range(self.squad_size)]
        opp_actions = self.opponent_policy(opp_obs, self)
        for i, action in enumerate(opp_actions):
            unit = self.units[opp_offset + i]
            if unit.alive:
                self._apply_action(unit, int(action), my_idx=opp_offset + i)

        self._update_bullets()

        if self.last_sound is not None:
            self.last_sound = (*self.last_sound[:2], self.last_sound[2] + 1, self.last_sound[3])
            if self.last_sound[2] > 90:
                self.last_sound = None

        self.tick += 1
        self.done = self.tick >= self.match_ticks
        # No-respawn early-out: terminate as soon as a team is wiped so the
        # winning agent doesn't burn rollout time on dead air.
        if self.cur.disable_respawn and not self.done:
            team_a_alive = any(u.alive for u in self.units[:self.squad_size])
            team_b_alive = any(u.alive for u in self.units[self.squad_size:])
            if not (team_a_alive and team_b_alive):
                self.done = True

        rewards = [self._reward_for(self.units[agent_offset + i]) for i in range(self.squad_size)]
        obs = self._observe_team(team=agent_team)

        info = {}
        if self.done:
            kills_agent = self.team_kills[agent_team]
            kills_opp   = self.team_kills[opp_team]
            if kills_agent > kills_opp:
                bonus = +self.cur.coef_episode_win
                info['winner'] = agent_team
            elif kills_opp > kills_agent:
                bonus = -self.cur.coef_episode_win
                info['winner'] = opp_team
            else:
                bonus = 0.0
                info['winner'] = -1
            for i in range(self.squad_size):
                rewards[i] += bonus
            info.update({'kills_agent': kills_agent, 'kills_opp': kills_opp,
                         'agent_team': agent_team})

        return obs, rewards, self.done, info

    # ---- observation ----
    def _observe_team(self, team: int) -> List[np.ndarray]:
        out = []
        for i in range(self.squad_size):
            unit = self.units[i if team == 0 else self.squad_size + i]
            out.append(self._build_obs_for_unit(unit, friendly_team=team))
        return out

    def _build_obs_for_unit(self, me: Unit, friendly_team: int) -> np.ndarray:
        """Build the 65-dim obs from `me`'s POV. Distance/position are normalized
        by the CURRENT world size so the [-1, 1] range stays full at every
        curriculum stage. Stage 4 (deployment) uses world_w=1200, matching JS.
        """
        W = self.world_w
        H = self.world_h
        obs = np.zeros(OBS_DIM, dtype=np.float32)
        i = 0

        obs[i] = me.x / W * 2 - 1; i += 1
        obs[i] = me.y / H * 2 - 1; i += 1
        obs[i] = math.sin(me.angle); i += 1
        obs[i] = math.cos(me.angle); i += 1
        obs[i] = me.hp / PLAYER_HP if me.alive else 0.0; i += 1
        obs[i] = 1.0 if me.recent_damage_ticks > 0 else 0.0; i += 1
        obs[i] = me.fire_cd / NN_FIRE_CD if me.fire_cd > 0 else 0.0; i += 1
        obs[i] = 1.0 if me.alive else 0.0; i += 1

        enemies = [u for u in self.units if u.team != me.team and u.alive]
        def enemy_key(u):
            d2 = (u.x - me.x) ** 2 + (u.y - me.y) ** 2
            visible = self._is_visible(me, u)
            return (-int(visible), d2)
        enemies.sort(key=enemy_key)

        for k in range(3):
            if k < len(enemies):
                e = enemies[k]
                dx = (e.x - me.x) / W * 2
                dy = (e.y - me.y) / H * 2
                dist = math.hypot(e.x - me.x, e.y - me.y) / W
                hp = e.hp / PLAYER_HP
                visible_now = 1.0 if self._is_visible(me, e) else 0.0
                obs[i:i+6] = [dx, dy, dist, hp, visible_now, 0.0]; i += 6
            else:
                i += 6

        teammates = [u for u in self.units if u.team == me.team and u is not me]
        teammates.sort(key=lambda u: (u.x - me.x) ** 2 + (u.y - me.y) ** 2)
        for k in range(2):
            if k < len(teammates):
                t = teammates[k]
                dx = (t.x - me.x) / W * 2
                dy = (t.y - me.y) / H * 2
                dist = math.hypot(t.x - me.x, t.y - me.y) / W
                hp = t.hp / PLAYER_HP if t.alive else 0.0
                alive = 1.0 if t.alive else 0.0
                visible_now = 1.0 if self._is_visible(me, t) else 0.0
                obs[i:i+6] = [dx, dy, dist, hp, alive, visible_now]; i += 6
            else:
                i += 6

        cps_sorted = sorted(self.cover_points,
                            key=lambda cp: (cp[0] - me.x) ** 2 + (cp[1] - me.y) ** 2)
        for k in range(5):
            if k < len(cps_sorted):
                cx, cy = cps_sorted[k]
                dx = (cx - me.x) / W * 2
                dy = (cy - me.y) / H * 2
                dist = math.hypot(cx - me.x, cy - me.y) / W
                obs[i:i+3] = [dx, dy, dist]; i += 3
            else:
                i += 3

        if me.last_seen_tick > -9999:
            obs[i] = (me.last_seen_tx - me.x) / W * 2; i += 1
            obs[i] = (me.last_seen_ty - me.y) / H * 2; i += 1
            obs[i] = min(1.0, (self.tick - me.last_seen_tick) / 90); i += 1
            obs[i] = 1.0; i += 1
        else:
            i += 4

        if self.last_sound is not None:
            sx, sy, ticks_ago, src_team = self.last_sound
            obs[i] = (sx - me.x) / W * 2; i += 1
            obs[i] = (sy - me.y) / H * 2; i += 1
            obs[i] = max(0.0, 1.0 - ticks_ago / 90); i += 1
            obs[i] = 1.0 if src_team == me.team else -1.0; i += 1
        else:
            i += 4

        obs[i] = (self.match_ticks - self.tick) / self.match_ticks; i += 1
        obs[i] = self.team_kills[me.team] / 20.0; i += 1
        obs[i] = self.team_kills[1 - me.team] / 20.0; i += 1
        alive_team = sum(1 for u in self.units if u.team == me.team and u.alive)
        obs[i] = alive_team / self.squad_size; i += 1

        return obs

    def _is_visible(self, me: Unit, target: Unit) -> bool:
        if not target.alive:
            return False
        d = math.hypot(target.x - me.x, target.y - me.y)
        if d > VIEW_RANGE:
            return False
        a = math.atan2(target.y - me.y, target.x - me.x)
        diff = a - me.angle
        while diff > math.pi: diff -= 2 * math.pi
        while diff < -math.pi: diff += 2 * math.pi
        if abs(diff) > VIEW_HALF:
            return False
        if line_blocked(me.x, me.y, target.x, target.y, self.walls):
            return False
        return True

    def _apply_action(self, unit: Unit, action: int, my_idx: int):
        move_dir = action // 2
        fire = action % 2

        dx, dy = MOVE_DIRS[move_dir]
        if dx != 0 or dy != 0:
            unit.x += dx * PLAYER_SPEED
            unit.y += dy * PLAYER_SPEED
            unit.angle = math.atan2(dy, dx)
        else:
            target = self._nearest_visible_enemy(unit)
            if target is not None:
                desired = math.atan2(target.y - unit.y, target.x - unit.x)
                d = desired - unit.angle
                while d > math.pi: d -= 2 * math.pi
                while d < -math.pi: d += 2 * math.pi
                unit.angle += d * NN_AIM_LERP

        push_out_of_walls(unit, self.walls)
        unit.x = max(20, min(self.world_w - 20, unit.x))
        unit.y = max(20, min(self.world_h - 20, unit.y))

        if fire and unit.fire_cd <= 0:
            target = self._nearest_visible_enemy(unit)
            if target is not None and not line_blocked(
                    unit.x, unit.y, target.x, target.y, self.walls):
                # Target leading: predict where the target will be when the
                # bullet arrives. Same heuristic as the JS deployment so the
                # model trains under the same auto-aim accuracy it'll see at
                # game time. Without this the agent learns "chase, fire,
                # miss" loops; with it, fire vs strafing target hits.
                dx0 = target.x - unit.x
                dy0 = target.y - unit.y
                dist0 = math.hypot(dx0, dy0)
                flight_time = dist0 / BULLET_SPEED
                lead_x = target.x + target.vel_x * flight_time
                lead_y = target.y + target.vel_y * flight_time
                aim = math.atan2(lead_y - unit.y, lead_x - unit.x)
                aim += (random.random() - 0.5) * 0.05
                unit.angle = aim
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

    def _update_bullets(self):
        survivors = []
        for b in self.bullets:
            b.x += b.vx
            b.y += b.vy
            b.life -= 1
            if b.life <= 0:
                continue
            hit = False
            for w in self.walls:
                if w.x < b.x < w.x + w.w and w.y < b.y < w.y + w.h:
                    hit = True; break
            if hit:
                continue
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

    def _reward_for(self, unit: Unit) -> float:
        c = self.cur
        r = 0.0
        r += c.coef_dmg_dealt * unit.damage_dealt_this_tick
        r -= c.coef_dmg_taken * unit.damage_taken_this_tick
        if unit.killed_this_tick:
            r += c.coef_kill
        if unit.died_this_tick:
            r -= c.coef_death
        if unit.alive:
            r += c.coef_alive
        r += c.coef_team_lead * (self.team_kills[unit.team] - self.team_kills[1 - unit.team])

        # Curriculum shaping: visibility + approach + aim cone
        # Only computed if any shaping coefficient is non-zero (skip in stage 4)
        if unit.alive and (c.coef_visibility > 0 or c.coef_approach > 0 or c.coef_aimcone > 0):
            visible_enemy = self._nearest_visible_enemy(unit)
            if visible_enemy is not None:
                r += c.coef_visibility
                if c.coef_approach > 0:
                    d = math.hypot(visible_enemy.x - unit.x, visible_enemy.y - unit.y)
                    closeness = max(0.0, 1.0 - d / max(self.world_w, 1))
                    r += c.coef_approach * closeness
                if c.coef_aimcone > 0:
                    aim_angle = math.atan2(visible_enemy.y - unit.y,
                                            visible_enemy.x - unit.x)
                    diff = abs(aim_angle - unit.angle)
                    while diff > math.pi: diff -= 2 * math.pi
                    diff = abs(diff)
                    if diff < math.pi / 6:   # within 30° of facing
                        r += c.coef_aimcone

        return r


# ============================================================
# Opponent policies
# ============================================================

def random_opponent(obs_list, env: CombatEnv) -> List[int]:
    """Random actions. Useful for warm-up."""
    return [random.randint(0, ACTION_DIM - 1) for _ in obs_list]


def idle_opponent(obs_list, env: CombatEnv) -> List[int]:
    """Stand still and never fire. Punching bag for stage 1 aim training."""
    return [0 for _ in obs_list]


def runner_opponent(obs_list, env: CombatEnv) -> List[int]:
    """Move in roughly one direction, change direction occasionally,
    fire about 30% of the time. Forces the agent to learn to lead and track.
    """
    actions = []
    for i, _ in enumerate(obs_list):
        unit = env.units[env.squad_size + i]
        if not unit.alive:
            actions.append(0); continue
        if random.random() < 0.05:
            unit.runner_dir = random.randint(1, 8)
        fire = 1 if random.random() < 0.3 else 0
        actions.append(unit.runner_dir * 2 + fire)
    return actions


def make_ga_opponent(genome_dict: dict):
    """GA-best behaviour-tree wrapped as an opponent policy."""
    p = genome_dict
    def policy(obs_list, env: CombatEnv):
        actions = []
        for i in range(env.squad_size):
            unit = env.units[env.squad_size + i]
            if not unit.alive:
                actions.append(0); continue
            actions.append(_ga_decide_action(unit, env, p))
        return actions
    return policy


def _ga_decide_action(unit: Unit, env: CombatEnv, p: dict) -> int:
    target = None
    best_d = float('inf')
    for o in env.units:
        if not o.alive or o.team == unit.team:
            continue
        d = (o.x - unit.x) ** 2 + (o.y - unit.y) ** 2
        view_range_sq = p.get('view_range', 720) ** 2
        if d > view_range_sq:
            continue
        a = math.atan2(o.y - unit.y, o.x - unit.x)
        diff = a - unit.angle
        while diff > math.pi: diff -= 2 * math.pi
        while diff < -math.pi: diff += 2 * math.pi
        if abs(diff) > p.get('view_arc', 2.4) / 2:
            continue
        if line_blocked(unit.x, unit.y, o.x, o.y, env.walls):
            continue
        if d < best_d:
            target, best_d = o, d

    if target is not None:
        dx = target.x - unit.x
        dy = target.y - unit.y
        dist = math.hypot(dx, dy)
        engage_d = p.get('engage_distance', 280)
        if dist < 0.001:
            # Units exactly overlap (rare edge case) — hold position, fire
            mx, my = 0.0, 0.0
        elif dist > engage_d * 1.2:
            mx, my = dx / dist, dy / dist
        elif dist < engage_d * 0.7:
            mx, my = -dx / dist, -dy / dist
        else:
            mx, my = 0.0, 0.0
        return _vector_to_movedir(mx, my) * 2 + 1
    else:
        mx, my = math.cos(unit.angle), math.sin(unit.angle)
        return _vector_to_movedir(mx, my) * 2


def _vector_to_movedir(mx: float, my: float) -> int:
    if abs(mx) < 0.2 and abs(my) < 0.2:
        return 0
    angle = math.atan2(my, mx)
    dir_angles = {
        1: -math.pi / 2, 2: -math.pi / 4,
        3: 0.0,          4: math.pi / 4,
        5: math.pi / 2,  6: 3 * math.pi / 4,
        7: math.pi,      8: -3 * math.pi / 4,
    }
    best, best_diff = 1, math.pi
    for d, a in dir_angles.items():
        diff = abs(((angle - a + math.pi) % (2 * math.pi)) - math.pi)
        if diff < best_diff:
            best_diff = diff; best = d
    return best


# ============================================================
# Curriculum-aware opponent picker
# ============================================================

def make_curriculum_opponent_picker(ga_genome: Optional[dict] = None,
                                     self_pool: Optional[list] = None):
    """Return a callable that picks an opponent policy each call, weighted by
    the current Curriculum's p_static / p_runner / p_random / p_ga / p_self.
    `self_pool` is a list of frozen NN policies (callable taking obs_list -> actions).
    """
    self_pool = self_pool if self_pool is not None else []
    ga_policy = make_ga_opponent(ga_genome) if ga_genome is not None else None

    def make_for(curriculum: Curriculum):
        # Sample one
        weights = [curriculum.p_static, curriculum.p_runner, curriculum.p_random,
                   curriculum.p_ga, curriculum.p_self]
        names = ['static', 'runner', 'random', 'ga', 'self']
        total = sum(max(0, w) for w in weights)
        if total <= 0:
            return random_opponent
        roll = random.random() * total
        acc = 0
        chosen = 'random'
        for n, w in zip(names, weights):
            acc += max(0, w)
            if roll <= acc:
                chosen = n; break
        if chosen == 'static':
            return idle_opponent
        if chosen == 'runner':
            return runner_opponent
        if chosen == 'ga' and ga_policy is not None:
            return ga_policy
        if chosen == 'self' and self_pool:
            return random.choice(self_pool)
        return random_opponent

    return make_for


# ============================================================
# SB3 wrapper with curriculum support
# ============================================================
# Lazy import — gym/gymnasium isn't required to use CombatEnv directly
# (the JS-side eval and the local sanity test don't need it). Only the
# SB3 trainer on Kaggle needs gymnasium.
try:
    import gymnasium as gym
    from gymnasium import spaces
    _HAS_GYM = True
except ImportError:
    try:
        import gym  # type: ignore
        from gym import spaces  # type: ignore
        _HAS_GYM = True
    except ImportError:
        gym = None
        spaces = None
        _HAS_GYM = False


_GymBase = gym.Env if _HAS_GYM else object


class SinglePerspectiveEnv(_GymBase):
    """Wraps CombatEnv into a single-agent gym env. Each underlying tick is
    exposed as 3 SB3 transitions (one per friendly unit).

    `curriculum_provider`: a callable () -> Curriculum, queried at every
        reset(). Use this with `curriculum_for_step(global_step, total)`
        to schedule the curriculum. The trainer must update `global_step`
        from a callback.
    `opponent_factory`: a callable (Curriculum) -> opponent_policy, queried
        at every reset() AFTER the curriculum is applied. Lets you sample
        opponents weighted by curriculum.p_*.
    """

    metadata = {'render_modes': []}

    def __init__(self,
                 curriculum_provider: Optional[Callable[[], Curriculum]] = None,
                 opponent_factory: Optional[Callable[[Curriculum], Callable]] = None,
                 squad_size: int = SQUAD_SIZE,
                 seed: Optional[int] = None,
                 agent_team_provider: Optional[Callable[[], int]] = None):
        """
        agent_team_provider: callable () -> 0 or 1, queried at every reset().
            Default returns 0 always (backward-compatible — only trains team 0).
            Pass `lambda: random.randint(0, 1)` to randomize each episode and
            train a bilateral policy that handles both spawn sides equally.
            opponent_factory may inspect curriculum (and its own state) to
            choose an appropriate opponent for whichever side the agent is on.
        """
        if not _HAS_GYM:
            raise RuntimeError(
                "SinglePerspectiveEnv needs gymnasium or gym installed. "
                "Run `pip install gymnasium` on Kaggle, or use CombatEnv directly.")
        super().__init__()
        self.observation_space = spaces.Box(
            low=-1.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32)
        self.action_space = spaces.Discrete(ACTION_DIM)

        self._curriculum_provider = curriculum_provider or (lambda: Curriculum())
        self._opponent_factory = opponent_factory or (lambda c: random_opponent)
        self._agent_team_provider = agent_team_provider or (lambda: 0)
        self._squad_size = squad_size

        c0 = self._curriculum_provider()
        self._inner = CombatEnv(
            opponent_policy=self._opponent_factory(c0),
            squad_size=squad_size,
            curriculum=c0,
            seed=seed,
        )
        self._cur_friendly_idx = 0
        self._pending_actions = [0] * squad_size
        self._agent_team = 0
        self._last_obs = self._inner._observe_team(team=0)

    def reset(self, seed: Optional[int] = None, options=None):
        c = self._curriculum_provider()
        self._inner.curriculum = c
        # Pick which side the agent plays this episode
        self._agent_team = int(self._agent_team_provider()) & 1
        self._inner.opponent_policy = self._opponent_factory(c)
        self._inner.reset(seed=seed)
        # Build obs from the agent's actual POV (could be team 0 or team 1)
        obs_list = self._inner._observe_team(team=self._agent_team)
        self._last_obs = obs_list
        self._cur_friendly_idx = 0
        self._pending_actions = [0] * self._squad_size
        return obs_list[0], {}

    def step(self, action):
        self._pending_actions[self._cur_friendly_idx] = int(action)
        self._cur_friendly_idx += 1

        if self._cur_friendly_idx < self._squad_size:
            obs = self._last_obs[self._cur_friendly_idx]
            return obs, 0.0, False, False, {}

        obs_list, rewards, done, info = self._inner.step(
            self._pending_actions, agent_team=self._agent_team)
        total_reward = float(sum(rewards) / self._squad_size)
        self._last_obs = obs_list
        self._cur_friendly_idx = 0
        self._pending_actions = [0] * self._squad_size
        return obs_list[0], total_reward, done, False, info


# ============================================================
# Sanity test
# ============================================================
if __name__ == '__main__':
    print("CombatEnv curriculum sanity check...")
    for step_frac, name in [(0.10, 'stage1'), (0.40, 'stage2'),
                             (0.65, 'stage3'), (0.90, 'stage4')]:
        c = curriculum_for_step(int(step_frac * 1_000_000), 1_000_000)
        print(f"  {name} (step {int(step_frac*1_000_000)}):"
              f" world={c.world_w}x{c.world_h} spawn={c.spawn_dist:.0f}"
              f" ticks={c.match_ticks}"
              f" mix=stat:{c.p_static:.2f}/run:{c.p_runner:.2f}"
              f"/rand:{c.p_random:.2f}/ga:{c.p_ga:.2f}/self:{c.p_self:.2f}"
              f" shape=vis:{c.coef_visibility:.3f}/app:{c.coef_approach:.4f}")

    print("\n One full episode (stage 1, idle opponent)...")
    env = CombatEnv(opponent_policy=idle_opponent,
                    curriculum=curriculum_for_step(50_000, 1_000_000), seed=42)
    obs = env.reset(seed=42)
    print(f"  obs shape: {obs[0].shape}, obs in [-1,1]:"
          f" {obs[0].min():.2f}..{obs[0].max():.2f}")
    total_reward = [0.0] * SQUAD_SIZE
    for _ in range(env.match_ticks):
        actions = [random.randint(0, ACTION_DIM - 1) for _ in range(SQUAD_SIZE)]
        obs, rewards, done, info = env.step(actions)
        for i, r in enumerate(rewards):
            total_reward[i] += r
        if done:
            break
    print(f"  ep_reward per friendly: {[round(r, 1) for r in total_reward]}")
    print(f"  kills: a={env.team_kills[0]} b={env.team_kills[1]}")

    if _HAS_GYM:
        print("\n SinglePerspectiveEnv with curriculum_provider...")
        step_counter = [0]
        def provider():
            step_counter[0] += 1
            return curriculum_for_step(step_counter[0] * 100, 100_000)
        senv = SinglePerspectiveEnv(curriculum_provider=provider, seed=42)
        obs, _ = senv.reset(seed=42)
        for _ in range(20):
            action = senv.action_space.sample()
            obs, r, done, trunc, info = senv.step(action)
            if done:
                break
        print(f"  OK. obs shape={obs.shape}, action_space={senv.action_space}")
    else:
        print("\n (gymnasium not installed locally — skip SB3 wrapper test)")
    print("\n OK.")
