"""
ai_arena/kaggle_train.py
========================

Headless NvN tactical-combat simulator + genetic-algorithm trainer.
Runs on Kaggle (CPU notebook is enough — no GPU needed).

The simulator mirrors the JS game's AI rules at the "behavioural" level:
vision cones, line-of-sight checks, cover seeking, peek-fire, flee on
low HP, respawn after 5 seconds. Both teams use a parameter vector
("genome") of 12 floats. The GA evolves these parameters across many
matches on a rotating set of maps.

USAGE on Kaggle:
  1. Create a new Kaggle notebook (Python 3, CPU is fine; 4 cores).
  2. In a single code cell, paste this entire file's contents.
  3. Edit the CONFIG block below (POPULATION, GENERATIONS, ...).
  4. Run the cell. Trained parameters land in /kaggle/working/checkpoints/.
  5. Download the JSON files from the Kaggle "Output" panel.

Output files (per checkpoint):
  /kaggle/working/checkpoints/gen_00050.json   <- best genome at gen 50
  /kaggle/working/checkpoints/gen_00100.json   <- best genome at gen 100
  ...
  /kaggle/working/checkpoints/history.json     <- per-gen avg/best fitness

The JSON has shape:
  {
    "gen": 100,
    "best_fitness": 14.25,
    "best_genome": { "view_arc": 2.31, "view_range": 720, ... },
    "hof": [ {...}, {...}, ... ]   # top-5 hall of fame
  }

Drop one of these files into the JS game and call `loadAIParams(json)`
(JS side hookup is a follow-up commit).
"""

import os
import json
import time
import math
import random
from dataclasses import dataclass
from typing import List, Optional, Tuple
from multiprocessing import Pool


# ============================================================
# CONFIG — tweak these
# ============================================================

# Combat
SQUAD_SIZE       = 3        # 3v3 (also try 2v2, 4v4 — keep equal)
MATCH_SECONDS    = 60       # one match wall-clock seconds (in-sim)

# Genetic algorithm
POPULATION       = 32       # genomes evaluated per generation
HALL_OF_FAME     = 16       # top-K kept across generations
GENERATIONS      = 200      # how many GA generations to run
MATCHES_PER_EVAL = 4        # each candidate plays N opponents from HOF
ELITE_FRAC       = 0.5      # top fraction that breeds the next gen
MUTATION_SIGMA   = 0.10     # gaussian sigma as fraction of param range
MUTATION_RATE    = 0.30     # probability each gene mutates per child

# Performance
WORKERS          = 4        # multiprocess pool (Kaggle has 4 cores)

# I/O
SAVE_EVERY       = 25       # save a checkpoint every N generations
OUTPUT_DIR       = '/kaggle/working/checkpoints' if os.path.exists('/kaggle/working') else './checkpoints'


# ============================================================
# SIM CONSTANTS (kept in sync with the JS game's rough values)
# ============================================================
WORLD_W           = 1200
WORLD_H           = 1200
TICK_RATE         = 60
MATCH_TICKS       = MATCH_SECONDS * TICK_RATE
RESPAWN_TICKS     = 5 * TICK_RATE       # 5-second respawn at spawn point
PLAYER_SPEED      = 2.8
PLAYER_RADIUS     = 14
PLAYER_HP         = 100
BULLET_SPEED      = 14.0
BULLET_LIFE       = 60
BULLET_DAMAGE     = 14
RAY_STEPS         = 12                  # LoS check resolution (12 = 2x faster than 24, still accurate enough)


# ============================================================
# GENOME — 12 numeric AI parameters
# ============================================================

GENOME_SCHEMA = {
    # perception
    'view_arc'           : (1.0, 3.0),    # radians (~57°-172°)
    'view_range'         : (300, 900),    # max sight distance
    'snap_to_threat'     : (0.05, 0.5),   # how fast body rotates toward target
    'patrol_scan_speed'  : (0.005, 0.08), # idle scan rate

    # combat positioning
    'engage_distance'    : (150, 400),    # preferred fight distance
    'spread'             : (0.02, 0.20),  # bullet inaccuracy (rad)
    'fire_cd_frames'     : (6, 30),       # frames between shots

    # cover behaviour
    'cover_dmg_threshold': (5, 80),       # damage taken that triggers seek-cover
    'peek_duration'      : (20, 100),     # frames out of cover firing
    'hide_duration'      : (20, 100),     # frames behind cover hiding
    'flee_hp_pct'        : (0.05, 0.60),  # HP fraction at which to flee

    # tactical bias
    'flank_chance'       : (0.0, 1.0),    # 2nd attacker chance to flank
}
GENOME_KEYS = list(GENOME_SCHEMA.keys())
GENOME_DIM  = len(GENOME_KEYS)


def random_genome():
    return [random.uniform(*GENOME_SCHEMA[k]) for k in GENOME_KEYS]


def mutate(g, sigma=MUTATION_SIGMA, rate=MUTATION_RATE):
    out = list(g)
    for i, k in enumerate(GENOME_KEYS):
        if random.random() < rate:
            lo, hi = GENOME_SCHEMA[k]
            v = out[i] + random.gauss(0, (hi - lo) * sigma)
            out[i] = max(lo, min(hi, v))
    return out


def crossover(g1, g2):
    return [random.choice([g1[i], g2[i]]) for i in range(GENOME_DIM)]


def to_dict(g):
    return {k: float(g[i]) for i, k in enumerate(GENOME_KEYS)}


def from_dict(d):
    return [float(d[k]) for k in GENOME_KEYS]


# ============================================================
# MAPS — diverse training arenas
# ============================================================

@dataclass
class Wall:
    x: float
    y: float
    w: float
    h: float


def map_open():
    """Wide open ground — pure positioning + duels."""
    return []


def map_pillars():
    """Four corner cover pillars. Symmetric, clean LoS lanes."""
    return [Wall(280, 280, 80, 80), Wall(840, 280, 80, 80),
            Wall(280, 840, 80, 80), Wall(840, 840, 80, 80)]


def map_cross():
    """Plus-shape in the centre. Forces flanking."""
    return [Wall(400, 570, 400, 60), Wall(570, 400, 60, 400)]


def map_maze():
    """Several mid-sized walls scattered. Lots of cover options."""
    return [Wall(200, 200, 60, 280), Wall(940, 420, 60, 280),
            Wall(400, 600, 220, 60), Wall(600, 200, 220, 60),
            Wall(500, 800, 60, 200)]


def map_corridor():
    """Two long horizontal walls — narrow corridor combat."""
    return [Wall(150, 380, 900, 60), Wall(150, 760, 900, 60)]


def map_random(seed):
    """Procedural wall placement — different every match."""
    rng = random.Random(seed)
    walls = []
    n = rng.randint(3, 8)
    for _ in range(n):
        w = rng.randint(60, 220)
        h = rng.randint(60, 220)
        x = rng.randint(180, WORLD_W - 180 - w)
        y = rng.randint(180, WORLD_H - 180 - h)
        walls.append(Wall(x, y, w, h))
    return walls


FIXED_MAPS = [map_open, map_pillars, map_cross, map_maze, map_corridor]


def pick_map(seed):
    """85% chance one of the fixed maps; 15% procedural."""
    rng = random.Random(seed)
    if rng.random() < 0.85:
        return rng.choice(FIXED_MAPS)()
    return map_random(seed + 7)


def cover_points_for(walls, offset=32):
    """One cover point per wall side, offset outward."""
    cps = []
    for w in walls:
        cx, cy = w.x + w.w / 2, w.y + w.h / 2
        cps.append((cx,            w.y - offset))
        cps.append((cx,            w.y + w.h + offset))
        cps.append((w.x - offset,  cy))
        cps.append((w.x + w.w + offset, cy))
    return cps


# ============================================================
# Geometry helpers (math module — faster than numpy for scalars)
# ============================================================

def line_blocked(x1, y1, x2, y2, walls):
    """True if any wall sits on the segment from (x1,y1)->(x2,y2)."""
    dx = x2 - x1
    dy = y2 - y1
    for i in range(1, RAY_STEPS):
        t = i / RAY_STEPS
        x = x1 + dx * t
        y = y1 + dy * t
        for w in walls:
            if w.x < x < w.x + w.w and w.y < y < w.y + w.h:
                return True
    return False


def angle_diff(a, b):
    d = a - b
    while d >  math.pi: d -= 2 * math.pi
    while d < -math.pi: d += 2 * math.pi
    return d


def angle_in_cone(src, arc, ox, oy, tx, ty):
    a = math.atan2(ty - oy, tx - ox)
    return abs(angle_diff(a, src)) <= arc / 2


def find_cover(mx, my, tx, ty, cps, walls, max_dist=600):
    """Nearest cover point that breaks LoS from (tx, ty)."""
    best, best_d2 = None, max_dist * max_dist
    for cx, cy in cps:
        d2 = (cx - mx) * (cx - mx) + (cy - my) * (cy - my)
        if d2 < 24 * 24 or d2 > best_d2:
            continue
        if not line_blocked(tx, ty, cx, cy, walls):
            continue
        best, best_d2 = (cx, cy), d2
    return best


def push_out_of_walls(u, walls):
    """If unit u overlaps a wall, push out along the smaller-overlap axis."""
    r = PLAYER_RADIUS
    for w in walls:
        if (w.x - r < u.x < w.x + w.w + r and
            w.y - r < u.y < w.y + w.h + r):
            cx = w.x + w.w / 2
            cy = w.y + w.h / 2
            ddx = u.x - cx
            ddy = u.y - cy
            ovx = (w.w / 2 + r) - abs(ddx)
            ovy = (w.h / 2 + r) - abs(ddy)
            if ovx < ovy:
                u.x += ovx if ddx > 0 else -ovx
            else:
                u.y += ovy if ddy > 0 else -ovy


def peek_offset(cp, tx, ty):
    """A small step from cover point toward the threat — used to peek out."""
    cx, cy = cp
    a = math.atan2(ty - cy, tx - cx)
    return (cx + math.cos(a) * 18, cy + math.sin(a) * 18)


# ============================================================
# UNIT
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
    cover_target: Optional[Tuple[float, float]] = None
    peek_timer: int = 0
    recent_damage_ticks: int = 0
    last_attacker_idx: int = -1
    kills: int = 0
    deaths: int = 0


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
# AI tick — same FSM the JS game uses
# ============================================================

def update_unit(u, units, walls, cps, p, tick, bullets, my_idx):
    """Run one tick of AI for unit u (team using genome p)."""

    if u.recent_damage_ticks > 0:
        u.recent_damage_ticks -= 1
    if u.fire_cd > 0:
        u.fire_cd -= 1

    # ---- Find nearest visible enemy ----
    target = None
    best_d2 = float('inf')
    for o in units:
        if not o.alive or o.team == u.team:
            continue
        dx, dy = o.x - u.x, o.y - u.y
        d2 = dx * dx + dy * dy
        if d2 > p['view_range'] * p['view_range']:
            continue
        if not angle_in_cone(u.angle, p['view_arc'], u.x, u.y, o.x, o.y):
            continue
        if line_blocked(u.x, u.y, o.x, o.y, walls):
            continue
        if d2 < best_d2:
            target = o
            best_d2 = d2

    best_d = math.sqrt(best_d2) if target else float('inf')

    if target:
        u.last_seen_tx = target.x
        u.last_seen_ty = target.y
        u.last_seen_tick = tick

    low_hp   = u.hp < PLAYER_HP * p['flee_hp_pct']
    just_dmg = u.recent_damage_ticks > 0
    in_cover = (u.cover_target is not None and
                (u.cover_target[0] - u.x) ** 2 + (u.cover_target[1] - u.y) ** 2 < 30 * 30)

    # ---- Mode selection ----
    mode = 'patrol'
    if low_hp and just_dmg:
        mode = 'flee'
        if u.cover_target is None:
            tx = target.x if target else u.last_seen_tx
            ty = target.y if target else u.last_seen_ty
            cp = find_cover(u.x, u.y, tx, ty, cps, walls, 1000)
            if cp: u.cover_target = cp
    elif target:
        if just_dmg or in_cover:
            cp = find_cover(u.x, u.y, target.x, target.y, cps, walls, 500)
            if cp: u.cover_target = cp
        if in_cover and u.cover_target is not None:
            mode = 'in_cover'
        elif u.cover_target is not None:
            mode = 'move_to_cover'
        else:
            mode = 'engage'
    elif tick - u.last_seen_tick < 90:
        mode = 'last_known'
    else:
        u.cover_target = None

    # ---- Movement per mode ----
    is_moving = False

    if mode == 'engage' and target is not None:
        a = math.atan2(target.y - u.y, target.x - u.x)
        u.angle += angle_diff(a, u.angle) * p['snap_to_threat']
        if best_d > p['engage_distance']:
            u.x += math.cos(u.angle) * PLAYER_SPEED
            u.y += math.sin(u.angle) * PLAYER_SPEED
            is_moving = True

    elif mode in ('move_to_cover', 'flee') and u.cover_target is not None:
        ax, ay = u.cover_target
        a = math.atan2(ay - u.y, ax - u.x)
        u.angle += angle_diff(a, u.angle) * p['snap_to_threat']
        speed = PLAYER_SPEED * (1.4 if mode == 'flee' else 1.1)
        u.x += math.cos(a) * speed
        u.y += math.sin(a) * speed
        is_moving = True

    elif mode == 'in_cover' and target is not None and u.cover_target is not None:
        a = math.atan2(target.y - u.y, target.x - u.x)
        u.angle += angle_diff(a, u.angle) * p['snap_to_threat'] * 1.5
        u.peek_timer += 1
        cycle = max(1, int(p['peek_duration'] + p['hide_duration']))
        peeking = (u.peek_timer % cycle) < int(p['peek_duration'])
        target_pt = (peek_offset(u.cover_target, target.x, target.y)
                     if peeking else u.cover_target)
        dx = target_pt[0] - u.x
        dy = target_pt[1] - u.y
        d = math.sqrt(dx * dx + dy * dy)
        if d > 1:
            u.x += dx / d * 0.7
            u.y += dy / d * 0.7
            if peeking:
                is_moving = True

    elif mode == 'last_known':
        a = math.atan2(u.last_seen_ty - u.y, u.last_seen_tx - u.x)
        u.angle += angle_diff(a, u.angle) * 0.10
        d2 = (u.last_seen_tx - u.x) ** 2 + (u.last_seen_ty - u.y) ** 2
        if d2 > 80 * 80:
            u.x += math.cos(u.angle) * PLAYER_SPEED * 0.7
            u.y += math.sin(u.angle) * PLAYER_SPEED * 0.7
            is_moving = True

    else:  # patrol
        # Scan + slowly drift forward. Without forward drift, units with low
        # view_range never close the gap to engage and the GA gets zero signal.
        u.angle += math.sin(tick * 0.022) * p['patrol_scan_speed']
        u.x += math.cos(u.angle) * PLAYER_SPEED * 0.4
        u.y += math.sin(u.angle) * PLAYER_SPEED * 0.4
        is_moving = True

    push_out_of_walls(u, walls)
    u.x = max(20, min(WORLD_W - 20, u.x))
    u.y = max(20, min(WORLD_H - 20, u.y))

    # ---- Fire if a clean shot exists ----
    if (target is not None and u.fire_cd <= 0 and
        not line_blocked(u.x, u.y, target.x, target.y, walls)):
        spread = p['spread'] * (1.6 if is_moving else 1.0)
        ang = u.angle + (random.random() - 0.5) * spread
        bullets.append(Bullet(
            x=u.x + math.cos(ang) * 16,
            y=u.y + math.sin(ang) * 16,
            vx=math.cos(ang) * BULLET_SPEED,
            vy=math.sin(ang) * BULLET_SPEED,
            life=BULLET_LIFE,
            damage=BULLET_DAMAGE,
            team=u.team,
            shooter_idx=my_idx,
        ))
        u.fire_cd = int(p['fire_cd_frames'])


# ============================================================
# Match
# ============================================================

def run_match(g_a, g_b, walls, seed=0, squad_size=SQUAD_SIZE):
    """One match. Returns dict with kill / death / damage / hit / winner stats.

    damage_a/damage_b = total damage delivered TO the opposing team by this team.
    hits_a/hits_b    = number of bullet hits (regardless of damage).
    These give the GA a smooth gradient even when no one dies in a match
    (which happens often when both AIs are early-generation random).
    """
    random.seed(seed)
    p_a = to_dict(g_a)
    p_b = to_dict(g_b)
    cps = cover_points_for(walls)

    # Spawn distance must be < typical view_range so units have a chance of
    # seeing each other before any patrol drift. 250 vs WORLD-250 = 700u
    # which fits inside view_range upper bound (900) and max move range.
    units: List[Unit] = []
    for i in range(squad_size):
        units.append(Unit(
            x=250, y=200 + i * 80, angle=0.0, hp=PLAYER_HP, team=0,
            spawn_x=250, spawn_y=200 + i * 80,
        ))
    for i in range(squad_size):
        units.append(Unit(
            x=WORLD_W - 250, y=200 + i * 80, angle=math.pi, hp=PLAYER_HP, team=1,
            spawn_x=WORLD_W - 250, spawn_y=200 + i * 80,
        ))

    bullets: List[Bullet] = []
    damage_by_team = [0, 0]   # damage dealt by team 0, team 1
    hits_by_team   = [0, 0]

    for tick in range(MATCH_TICKS):
        # Units
        for idx, u in enumerate(units):
            if not u.alive:
                u.respawn_cd -= 1
                if u.respawn_cd <= 0:
                    u.alive = True
                    u.hp = PLAYER_HP
                    u.x = u.spawn_x
                    u.y = u.spawn_y
                    u.fire_cd = 0
                    u.cover_target = None
                continue
            p = p_a if u.team == 0 else p_b
            update_unit(u, units, walls, cps, p, tick, bullets, idx)

        # Bullets
        survivors: List[Bullet] = []
        for b in bullets:
            b.x += b.vx
            b.y += b.vy
            b.life -= 1
            if b.life <= 0:
                continue
            # Wall hit?
            hit = False
            for w in walls:
                if w.x < b.x < w.x + w.w and w.y < b.y < w.y + w.h:
                    hit = True
                    break
            if hit:
                continue
            # Unit hit?
            hit_unit = None
            for u in units:
                if not u.alive or u.team == b.team:
                    continue
                if (b.x - u.x) ** 2 + (b.y - u.y) ** 2 < PLAYER_RADIUS * PLAYER_RADIUS:
                    hit_unit = u
                    break
            if hit_unit is not None:
                applied = min(b.damage, hit_unit.hp)  # damage actually applied (cap at remaining HP)
                hit_unit.hp -= b.damage
                hit_unit.recent_damage_ticks = 60
                hit_unit.last_attacker_idx = b.shooter_idx
                damage_by_team[b.team] += max(0, applied)
                hits_by_team[b.team]   += 1
                if hit_unit.hp <= 0:
                    hit_unit.alive = False
                    hit_unit.deaths += 1
                    hit_unit.respawn_cd = RESPAWN_TICKS
                    if 0 <= b.shooter_idx < len(units):
                        units[b.shooter_idx].kills += 1
                continue
            survivors.append(b)
        bullets = survivors

    kills_a  = sum(u.kills  for u in units if u.team == 0)
    kills_b  = sum(u.kills  for u in units if u.team == 1)
    deaths_a = sum(u.deaths for u in units if u.team == 0)
    deaths_b = sum(u.deaths for u in units if u.team == 1)

    if kills_a > kills_b:
        winner = 0
    elif kills_b > kills_a:
        winner = 1
    else:
        winner = -1

    return {
        'kills_a':  kills_a,  'kills_b':  kills_b,
        'deaths_a': deaths_a, 'deaths_b': deaths_b,
        'damage_a': damage_by_team[0], 'damage_b': damage_by_team[1],
        'hits_a':   hits_by_team[0],   'hits_b':   hits_by_team[1],
        'winner':   winner,
    }


# ============================================================
# GA evaluation
# ============================================================
# Fitness components and weights. Tuned to give SMOOTH gradient even when
# no kills happen in a match (common with early random AIs).
W_KILL        = 30   # +30 per kill scored
W_DEATH       = 20   # -20 per death suffered
W_DAMAGE_OUT  = 0.4  # +0.4 per HP of damage dealt
W_DAMAGE_IN   = 0.2  # -0.2 per HP of damage taken
W_HIT_OUT     = 1.0  # +1 per bullet that landed (rewards aim, not just kills)
W_WIN_BONUS   = 50   # +50 if won this match (more kills), -50 if lost

def evaluate(args):
    """Evaluate one candidate vs a list of opponents on random maps.
    Plays both home + away (swapped sides) for fairness.

    Fitness uses kills + damage + hits + win bonus, not just kills - deaths.
    This ensures we get USEFUL signal even early in training when most
    random genomes can't actually finish a kill in 60 sec."""
    candidate, opponents, seed_base = args
    if not opponents:
        return 0.0
    total = 0.0
    for i, opp in enumerate(opponents):
        walls = pick_map(seed_base + i)
        # r1: candidate=team0, opp=team1
        # r2: opp=team0, candidate=team1   (swap so spawn-side is fair)
        r1 = run_match(candidate, opp, walls, seed=seed_base + i)
        r2 = run_match(opp, candidate, walls, seed=seed_base + i + 99991)

        # Aggregate from candidate's POV across both directions
        cand_kills  = r1['kills_a']  + r2['kills_b']
        cand_deaths = r1['deaths_a'] + r2['deaths_b']
        cand_dmg_o  = r1['damage_a'] + r2['damage_b']
        cand_dmg_i  = r1['damage_b'] + r2['damage_a']
        cand_hits   = r1['hits_a']   + r2['hits_b']

        win1 = (W_WIN_BONUS if r1['winner'] == 0 else
                -W_WIN_BONUS if r1['winner'] == 1 else 0)
        win2 = (W_WIN_BONUS if r2['winner'] == 1 else
                -W_WIN_BONUS if r2['winner'] == 0 else 0)

        score = (cand_kills  * W_KILL
               - cand_deaths * W_DEATH
               + cand_dmg_o  * W_DAMAGE_OUT
               - cand_dmg_i  * W_DAMAGE_IN
               + cand_hits   * W_HIT_OUT
               + win1 + win2)
        total += score
    return total / len(opponents)


# ============================================================
# Training loop
# ============================================================

def train(generations=GENERATIONS, save_dir=OUTPUT_DIR):
    os.makedirs(save_dir, exist_ok=True)

    print(f"=== AI Arena GA ===")
    print(f"  squad_size={SQUAD_SIZE}, match_seconds={MATCH_SECONDS}, world={WORLD_W}x{WORLD_H}")
    print(f"  population={POPULATION}, hof={HALL_OF_FAME}, generations={generations}")
    print(f"  matches_per_eval={MATCHES_PER_EVAL}, workers={WORKERS}")
    print(f"  output={save_dir}")
    print()

    population = [random_genome() for _ in range(POPULATION)]
    hof = list(population[:HALL_OF_FAME])
    history = []
    n_elite = max(2, int(POPULATION * ELITE_FRAC))

    pool = Pool(WORKERS) if WORKERS > 1 else None

    try:
        for gen in range(1, generations + 1):
            t0 = time.time()

            # Sample HOF opponents per candidate
            arg_list = []
            for i, cand in enumerate(population):
                opps = random.sample(hof, k=min(MATCHES_PER_EVAL, len(hof)))
                arg_list.append((cand, opps, gen * 10000 + i * 137))

            if pool:
                fitnesses = pool.map(evaluate, arg_list)
            else:
                fitnesses = [evaluate(a) for a in arg_list]

            # Sort by fitness (desc)
            scored = sorted(zip(fitnesses, population), key=lambda x: -x[0])
            best_fit = scored[0][0]
            best_genome = scored[0][1]
            avg_fit = sum(fitnesses) / len(fitnesses)

            # Update HOF: merge old HOF + this gen's elite, re-rank by quick eval
            hof_pool = hof + [g for _, g in scored[:HALL_OF_FAME]]
            hof_args = [(g, random.sample(hof_pool, min(3, len(hof_pool))),
                        gen * 7777 + i) for i, g in enumerate(hof_pool)]
            if pool:
                hof_scores = pool.map(evaluate, hof_args)
            else:
                hof_scores = [evaluate(a) for a in hof_args]
            hof_ranked = sorted(zip(hof_scores, hof_pool), key=lambda x: -x[0])
            hof = [g for _, g in hof_ranked[:HALL_OF_FAME]]

            # Reproduce
            elite = [g for _, g in scored[:n_elite]]
            new_pop = list(elite)
            while len(new_pop) < POPULATION:
                p1, p2 = random.sample(elite, 2)
                child = mutate(crossover(p1, p2))
                new_pop.append(child)
            population = new_pop

            elapsed = time.time() - t0
            history.append({'gen': gen, 'best': best_fit, 'avg': avg_fit, 'time_s': round(elapsed, 2)})
            print(f"  gen {gen:4d} | best {best_fit:+7.2f} | avg {avg_fit:+7.2f} | {elapsed:5.1f}s")

            # Checkpoint
            if gen % SAVE_EVERY == 0 or gen == generations:
                ckpt = {
                    'gen': gen,
                    'best_fitness': best_fit,
                    'avg_fitness': avg_fit,
                    'config': {
                        'squad_size': SQUAD_SIZE, 'match_seconds': MATCH_SECONDS,
                        'population': POPULATION, 'hof': HALL_OF_FAME,
                    },
                    'best_genome': to_dict(best_genome),
                    'hof': [to_dict(g) for g in hof[:5]],
                }
                path = os.path.join(save_dir, f'gen_{gen:05d}.json')
                with open(path, 'w') as f:
                    json.dump(ckpt, f, indent=2, ensure_ascii=False)
                print(f"        ↳ saved {path}")
    finally:
        if pool:
            pool.close()
            pool.join()

    with open(os.path.join(save_dir, 'history.json'), 'w') as f:
        json.dump(history, f, indent=2)
    print(f"\nDone. {generations} generations. History at {save_dir}/history.json")


if __name__ == '__main__':
    train()
