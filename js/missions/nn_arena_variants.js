// ============ NN ARENA MAP VARIANTS ============
// Mirrors the 5 fixed maps + procedural map_random in combat_env.py.
// startNNSkirmish() picks one at random per match so the deployed model
// sees the same map distribution it trained on.
//
// Classic-script. Declares globally:
//   NN_MAP_VARIANTS (array — { id, name, forest?, walls, trees? })
//   buildNNArenaVariant(idx)  — populates buildings/lowCovers/routes
//
// External deps: game · NN_ARENA · buildings · lowCovers · routes ·
//   landmarks · themeShapes · decorations · trees · networkNodes ·
//   buildCoverPoints · addBuilding · addLowCover · addTree ·
//   addRoute · addLandmark

const NN_MAP_VARIANTS = [
  // FTUE-only arena. Curated geometry for the 6-step tutorial:
  //  - empty centre (step 0 'alone in space' moment)
  //  - 4 cover blocks at the cardinals (step 1 first kill — somewhere to
  //    line up a shot)
  //  - a short E-W wall line (step 4 'place a structure beside it')
  //  - both spawn anchors aligned on the long axis so the camera doesn't
  //    have to pan
  // Hidden from the regular pool (modes: []) — only ever picked via
  // _forceVariantId from the FTUE flow.
  { id: 'ftue',     name: 'FTUE · 教學',
    walls: () => [
      { x: 540, y: 200, w: 120, h: 30, kind: 'building' },
      { x: 540, y: 970, w: 120, h: 30, kind: 'building' },
      { x: 200, y: 540, w: 30,  h: 120, kind: 'building' },
      { x: 970, y: 540, w: 30,  h: 120, kind: 'building' },
    ],
    spawn: { blue: [{ x: 200, y: 600 }], red: [{ x: 1000, y: 600 }] },
    modes: [],   // never rolls in the regular variant pool
  },
  { id: 'open',     name: '开阔 OPEN',
    walls: () => [],
    modes: ['dm', 'duel', 'sniper'],
  },
  { id: 'pillars',  name: '四柱 PILLARS',
    walls: () => [
      { x: 280, y: 280, w: 80, h: 80, kind: 'building', accent: true },
      { x: 840, y: 280, w: 80, h: 80, kind: 'building', accent: true },
      { x: 280, y: 840, w: 80, h: 80, kind: 'building' },
      { x: 840, y: 840, w: 80, h: 80, kind: 'building' },
    ],
    modes: ['dm', 'duel'],
  },
  { id: 'cross',    name: '十字 CROSS',
    walls: () => [
      { x: 400, y: 570, w: 400, h: 60, kind: 'building', color: '#1A1A1A' },
      { x: 570, y: 400, w: 60, h: 400, kind: 'building', color: '#1A1A1A' },
    ],
    modes: ['dm', 'duel'],
  },
  { id: 'maze',     name: '迷阵 MAZE',
    walls: () => [
      { x: 200, y: 200, w: 60, h: 280, kind: 'building' },
      { x: 940, y: 420, w: 60, h: 280, kind: 'building' },
      { x: 400, y: 600, w: 220, h: 60, kind: 'cover' },
      { x: 600, y: 200, w: 220, h: 60, kind: 'cover' },
      { x: 500, y: 800, w: 60, h: 200, kind: 'building' },
    ],
    modes: ['dm'],
  },
  { id: 'corridor', name: '走廊 CORRIDOR',
    walls: () => [
      { x: 150, y: 380, w: 900, h: 60, kind: 'building' },
      { x: 150, y: 760, w: 900, h: 60, kind: 'building' },
    ],
    modes: ['dm', 'sniper'],
  },
  { id: 'random',   name: '随机 RANDOM',
    walls: () => {
      const rng = Math.random;
      const n = 2 + Math.floor(rng() * 5);
      const out = [];
      const margin = 120;
      for (let i = 0; i < n; i++) {
        const w = 60 + Math.floor(rng() * 161);
        const h = 60 + Math.floor(rng() * 161);
        const x = margin + Math.floor(rng() * (NN_ARENA.w - 2*margin - w));
        const y = margin + Math.floor(rng() * (NN_ARENA.h - 2*margin - h));
        out.push({ x, y, w, h, kind: i % 2 === 0 ? 'building' : 'cover' });
      }
      return out;
    },
    modes: ['dm'],
  },
  { id: 'fortress', name: '堡垒 FORTRESS',
    walls: () => [
      { x: 500, y: 500, w: 200, h: 200, kind: 'building', accent: true },
      { x: 480, y: 480, w: 60,  h: 60,  kind: 'cover' },
      { x: 660, y: 480, w: 60,  h: 60,  kind: 'cover' },
      { x: 480, y: 660, w: 60,  h: 60,  kind: 'cover' },
      { x: 660, y: 660, w: 60,  h: 60,  kind: 'cover' },
    ],
    modes: ['dm', 'survival', 'helo'],
  },
  { id: 'crossfire', name: '交叉火力 CROSSFIRE',
    walls: () => [
      { x: 540, y: 200, w: 120, h: 120, kind: 'cover' },
      { x: 540, y: 880, w: 120, h: 120, kind: 'cover' },
      { x: 200, y: 540, w: 120, h: 120, kind: 'cover' },
      { x: 880, y: 540, w: 120, h: 120, kind: 'cover' },
    ],
    modes: ['dm', 'duel', 'sniper'],
  },
  { id: 'arena', name: '竞技场 ARENA',
    walls: () => {
      const out = [];
      const cx = 600, cy = 600, r = 380;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x = cx + Math.cos(a) * r - 40;
        const y = cy + Math.sin(a) * r - 40;
        out.push({ x: Math.round(x), y: Math.round(y), w: 80, h: 80,
                   kind: i % 2 === 0 ? 'building' : 'cover' });
      }
      return out;
    },
    modes: ['dm', 'duel'],
  },
  { id: 'urban', name: '城区 URBAN',
    walls: () => [
      // L-shaped buildings + alleys
      { x: 200, y: 200, w: 240, h: 70, kind: 'building' },
      { x: 200, y: 200, w: 70, h: 240, kind: 'building' },
      { x: 760, y: 200, w: 240, h: 70, kind: 'building' },
      { x: 930, y: 200, w: 70, h: 240, kind: 'building' },
      { x: 200, y: 930, w: 70, h: 70,  kind: 'building' },
      { x: 930, y: 930, w: 70, h: 70,  kind: 'building' },
      { x: 540, y: 540, w: 120, h: 120, kind: 'cover' },   // central crate
      { x: 380, y: 740, w: 60, h: 60, kind: 'cover' },
      { x: 760, y: 460, w: 60, h: 60, kind: 'cover' },
    ],
    modes: ['dm', 'survival', 'sniper', 'helo'],
  },
  { id: 'bunker', name: '碉堡 BUNKER',
    walls: () => [
      // Central bunker — thick walls with one entrance each side
      { x: 440, y: 440, w: 320, h: 50, kind: 'building' },   // top
      { x: 440, y: 710, w: 320, h: 50, kind: 'building' },   // bottom
      { x: 440, y: 440, w: 50, h: 130, kind: 'building' },   // left top half
      { x: 440, y: 630, w: 50, h: 130, kind: 'building' },   // left bot half
      { x: 710, y: 440, w: 50, h: 130, kind: 'building' },   // right top half
      { x: 710, y: 630, w: 50, h: 130, kind: 'building' },   // right bot half
      // Outer covers (siege side)
      { x: 240, y: 240, w: 80, h: 80, kind: 'cover' },
      { x: 880, y: 240, w: 80, h: 80, kind: 'cover' },
      { x: 240, y: 880, w: 80, h: 80, kind: 'cover' },
      { x: 880, y: 880, w: 80, h: 80, kind: 'cover' },
    ],
    modes: ['dm', 'survival', 'helo'],
  },
  { id: 'fortress2', name: '阵地战 SIEGE',
    walls: () => [
      // Dueling forts — left and right strongholds with no-man's-land between
      { x: 100, y: 400, w: 120, h: 60, kind: 'building' },
      { x: 100, y: 540, w: 60, h: 120, kind: 'building' },
      { x: 100, y: 740, w: 120, h: 60, kind: 'building' },
      { x: 980, y: 400, w: 120, h: 60, kind: 'building' },
      { x: 1040, y: 540, w: 60, h: 120, kind: 'building' },
      { x: 980, y: 740, w: 120, h: 60, kind: 'building' },
      // Center crates for cover during the push
      { x: 460, y: 540, w: 80, h: 120, kind: 'cover' },
      { x: 660, y: 540, w: 80, h: 120, kind: 'cover' },
    ],
    modes: ['dm', 'sniper', 'survival', 'helo'],
  },
  // ========= Indoor variants — single-room interiors with cover =========
  // Spawn anchors are placed INSIDE the perimeter so the whole match plays
  // out indoors. Internal walls are kept short / wide-doored so the trained
  // NN (which never saw indoor maps) can still navigate to engage.
  { id: 'office', name: '办公大楼 OFFICE',
    walls: () => {
      // 800x800 outer perimeter w/ 4 entry doorways. Inside: cubicle rows
      // built from low cover (walk-through, blocks bullets) so the NN can
      // path around without hitting closed rooms.
      const out = [];
      const T = 30, D = 200;
      const x1 = 200, x2 = 1000, y1 = 200, y2 = 1000;
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      // Outer walls (with center doorway on each side)
      out.push({ x: x1, y: y1, w: (cx - D/2) - x1, h: T, kind: 'building' });
      out.push({ x: cx + D/2, y: y1, w: x2 - (cx + D/2), h: T, kind: 'building' });
      out.push({ x: x1, y: y2 - T, w: (cx - D/2) - x1, h: T, kind: 'building' });
      out.push({ x: cx + D/2, y: y2 - T, w: x2 - (cx + D/2), h: T, kind: 'building' });
      out.push({ x: x1, y: y1, w: T, h: (cy - D/2) - y1, kind: 'building' });
      out.push({ x: x1, y: cy + D/2, w: T, h: y2 - (cy + D/2), kind: 'building' });
      out.push({ x: x2 - T, y: y1, w: T, h: (cy - D/2) - y1, kind: 'building' });
      out.push({ x: x2 - T, y: cy + D/2, w: T, h: y2 - (cy + D/2), kind: 'building' });
      // Cubicle rows (low cover) — three short rows with gaps for movement
      out.push({ x: 320, y: 360, w: 200, h: 30, kind: 'cover' });
      out.push({ x: 680, y: 360, w: 200, h: 30, kind: 'cover' });
      out.push({ x: 480, y: 540, w: 240, h: 30, kind: 'cover' });
      out.push({ x: 320, y: 720, w: 200, h: 30, kind: 'cover' });
      out.push({ x: 680, y: 720, w: 200, h: 30, kind: 'cover' });
      // Reception desks (cover) flanking the spawn anchors
      out.push({ x: 260, y: 580, w: 50, h: 80, kind: 'cover' });
      out.push({ x: 890, y: 580, w: 50, h: 80, kind: 'cover' });
      return out;
    },
    spawn: { blue: { x: 280, y: 600 }, red: { x: 920, y: 600 } },
    modes: ['dm', 'survival', 'helo'],
  },
  { id: 'parking', name: '停车场 PARKING',
    walls: () => {
      // 3x3 sparse columns + parked cars in lanes. Spawn lanes (rows 1+5) clear.
      const out = [];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          out.push({ x: 380 + c * 220, y: 380 + r * 220, w: 50, h: 50, kind: 'building', accent: (r + c) % 2 === 0 });
        }
      }
      // Parked cars (low cover) along the spawn lanes
      out.push({ x: 380, y: 280, w: 110, h: 50, kind: 'cover' });
      out.push({ x: 720, y: 280, w: 110, h: 50, kind: 'cover' });
      out.push({ x: 380, y: 870, w: 110, h: 50, kind: 'cover' });
      out.push({ x: 720, y: 870, w: 110, h: 50, kind: 'cover' });
      // Side covers near spawns
      out.push({ x: 250, y: 540, w: 60, h: 120, kind: 'cover' });
      out.push({ x: 890, y: 540, w: 60, h: 120, kind: 'cover' });
      return out;
    },
    spawn: { blue: { x: 200, y: 600 }, red: { x: 1000, y: 600 } },
    modes: ['dm'],
  },
  { id: 'school', name: '空学校 SCHOOL',
    walls: () => {
      // 800x800 perimeter w/ 1 wide doorway each side. Inside: desks (cover)
      // and 2 short partial dividers — no closed classrooms, so NN can roam.
      const out = [];
      const T = 30, D = 200;
      const x1 = 200, x2 = 1000, y1 = 200, y2 = 1000;
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      // Perimeter (with doorway centered each side)
      out.push({ x: x1, y: y1, w: (cx - D/2) - x1, h: T, kind: 'building' });
      out.push({ x: cx + D/2, y: y1, w: x2 - (cx + D/2), h: T, kind: 'building' });
      out.push({ x: x1, y: y2 - T, w: (cx - D/2) - x1, h: T, kind: 'building' });
      out.push({ x: cx + D/2, y: y2 - T, w: x2 - (cx + D/2), h: T, kind: 'building' });
      out.push({ x: x1, y: y1, w: T, h: (cy - D/2) - y1, kind: 'building' });
      out.push({ x: x1, y: cy + D/2, w: T, h: y2 - (cy + D/2), kind: 'building' });
      out.push({ x: x2 - T, y: y1, w: T, h: (cy - D/2) - y1, kind: 'building' });
      out.push({ x: x2 - T, y: cy + D/2, w: T, h: y2 - (cy + D/2), kind: 'building' });
      // Two short partial dividers (don't reach across — leaves wide gaps)
      out.push({ x: 480, y: 280, w: T, h: 200, kind: 'building' });
      out.push({ x: 720, y: 720, w: T, h: 200, kind: 'building' });
      // Desks in 3 rows
      for (const cxd of [320, 540, 760]) {
        out.push({ x: cxd, y: 380, w: 60, h: 40, kind: 'cover' });
        out.push({ x: cxd, y: 540, w: 60, h: 40, kind: 'cover' });
        out.push({ x: cxd, y: 760, w: 60, h: 40, kind: 'cover' });
      }
      return out;
    },
    spawn: { blue: { x: 280, y: 600 }, red: { x: 920, y: 600 } },
    modes: ['dm'],
  },
  { id: 'basement', name: '地下室 BASEMENT',
    walls: () => [
      // Outer rectangle (tall room)
      { x: 200, y: 300, w: 800, h: 30, kind: 'building' },
      { x: 200, y: 870, w: 800, h: 30, kind: 'building' },
      { x: 200, y: 300, w: 30, h: 600, kind: 'building' },
      { x: 970, y: 300, w: 30, h: 600, kind: 'building' },
      // 2 short partial dividers — clearly leave a central corridor open
      { x: 420, y: 300, w: 30, h: 240, kind: 'building' },
      { x: 760, y: 660, w: 30, h: 240, kind: 'building' },
      // Cover crates scattered through
      { x: 320, y: 450, w: 60, h: 60, kind: 'cover' },
      { x: 540, y: 540, w: 60, h: 60, kind: 'cover' },
      { x: 680, y: 450, w: 60, h: 60, kind: 'cover' },
      { x: 320, y: 750, w: 60, h: 60, kind: 'cover' },
      { x: 540, y: 700, w: 60, h: 60, kind: 'cover' },
      { x: 880, y: 750, w: 60, h: 60, kind: 'cover' },
    ],
    spawn: { blue: { x: 280, y: 600 }, red: { x: 920, y: 600 } },
    modes: ['dm'],
  },

  // ============ MODE-DEDICATED MAPS ============

  // Survival 退路堡壘: central bunker on the LEFT half (x:200..600), open
  // battlefield on the right where waves spawn. Doorway facing east lets
  // you push out and fall back. Inner cubicle covers + outer flanking
  // covers in the field.
  { id: 'survival_fort', name: '生存堡垒 BASTION',
    walls: () => {
      const out = [];
      // Outer bunker (left half) — 4 walls with central doorways
      // Top wall: x=200..600, y=400..430 with doorway at x=360..440
      out.push({ x: 200, y: 400, w: 160, h: 30, kind: 'building' });
      out.push({ x: 440, y: 400, w: 160, h: 30, kind: 'building' });
      // Bottom wall: doorway at same x range
      out.push({ x: 200, y: 770, w: 160, h: 30, kind: 'building' });
      out.push({ x: 440, y: 770, w: 160, h: 30, kind: 'building' });
      // Left wall: full (no entry from arena west edge)
      out.push({ x: 200, y: 400, w: 30, h: 400, kind: 'building' });
      // Right wall (facing battlefield): doorway at y=560..640
      out.push({ x: 570, y: 400, w: 30, h: 160, kind: 'building' });
      out.push({ x: 570, y: 640, w: 30, h: 160, kind: 'building' });
      // Inside-bunker cover crates (cubicle layout)
      out.push({ x: 270, y: 470, w: 60, h: 60, kind: 'cover' });
      out.push({ x: 470, y: 470, w: 60, h: 60, kind: 'cover' });
      out.push({ x: 270, y: 670, w: 60, h: 60, kind: 'cover' });
      out.push({ x: 470, y: 670, w: 60, h: 60, kind: 'cover' });
      // Mid-field flanking cover (fight zone east of bunker)
      out.push({ x: 700, y: 500, w: 60, h: 200, kind: 'cover' });
      out.push({ x: 820, y: 350, w: 60, h: 200, kind: 'cover' });
      out.push({ x: 820, y: 760, w: 60, h: 200, kind: 'cover' });
      // Edge covers near red spawn so reds have something to break LoS on too
      out.push({ x: 1020, y: 380, w: 60, h: 80, kind: 'cover' });
      out.push({ x: 1020, y: 760, w: 60, h: 80, kind: 'cover' });
      return out;
    },
    spawn: { blue: { x: 400, y: 600 }, red: { x: 1100, y: 600 } },
    modes: ['survival', 'dm', 'helo'],
  },

  // Duel 决斗场: small symmetric arena with center pillar + 8 cover blocks.
  // Tight, lots of cover, no place to hide forever — encourages peek-shoot.
  { id: 'duel_arena', name: '决斗场 DUELING ARENA',
    walls: () => [
      // Center pillar (full block) — bisects sightline
      { x: 580, y: 580, w: 40, h: 40, kind: 'building', accent: true },
      // 4 corner cover blocks
      { x: 380, y: 380, w: 80, h: 80, kind: 'cover' },
      { x: 740, y: 380, w: 80, h: 80, kind: 'cover' },
      { x: 380, y: 740, w: 80, h: 80, kind: 'cover' },
      { x: 740, y: 740, w: 80, h: 80, kind: 'cover' },
      // 4 mid-edge horizontal/vertical cover slabs
      { x: 540, y: 320, w: 120, h: 30, kind: 'cover' },
      { x: 540, y: 850, w: 120, h: 30, kind: 'cover' },
      { x: 320, y: 540, w: 30, h: 120, kind: 'cover' },
      { x: 850, y: 540, w: 30, h: 120, kind: 'cover' },
    ],
    spawn: { blue: { x: 280, y: 600 }, red: { x: 920, y: 600 } },
    modes: ['duel'],
  },

  // Sniper 双塔街: long horizontal corridor flanked by two tower buildings.
  // Center has thin slab cover for ducking; main lane is open for sightlines.
  { id: 'sniper_twintowers', name: '双塔街 TWIN TOWERS',
    walls: () => [
      // Two side towers (full buildings)
      { x: 100, y: 380, w: 200, h: 440, kind: 'building', accent: true },
      { x: 900, y: 380, w: 200, h: 440, kind: 'building', accent: true },
      // Sniper "windows" — small cover blocks at the tower fronts so you
      // can peek out without exposing your whole body
      { x: 320, y: 450, w: 30, h: 80, kind: 'cover' },
      { x: 320, y: 670, w: 30, h: 80, kind: 'cover' },
      { x: 850, y: 450, w: 30, h: 80, kind: 'cover' },
      { x: 850, y: 670, w: 30, h: 80, kind: 'cover' },
      // Mid-lane low-cover pillars (vertical strips for ducking)
      { x: 480, y: 540, w: 30, h: 160, kind: 'cover' },
      { x: 690, y: 540, w: 30, h: 160, kind: 'cover' },
      // Far ends — corner blockers so you can't run all the way around
      { x: 100, y: 200, w: 200, h: 30, kind: 'building' },
      { x: 100, y: 970, w: 200, h: 30, kind: 'building' },
      { x: 900, y: 200, w: 200, h: 30, kind: 'building' },
      { x: 900, y: 970, w: 200, h: 30, kind: 'building' },
    ],
    spawn: { blue: { x: 250, y: 600 }, red: { x: 950, y: 600 } },
    modes: ['sniper'],
  },

  // Convoy 物资护送: clear horizontal lane down the middle for the UGV to
  // traverse, with side cover berms + ambush buildings flanking.
  { id: 'convoy_road', name: '补给路线 CONVOY ROAD',
    walls: () => {
      const out = [];
      for (let i = 0; i < 8; i++) {
        const x = 200 + i * 110;
        out.push({ x: x, y: 460, w: 60, h: 30, kind: 'cover' });
        out.push({ x: x, y: 720, w: 60, h: 30, kind: 'cover' });
      }
      out.push({ x: 280, y: 250, w: 100, h: 100, kind: 'building' });
      out.push({ x: 600, y: 200, w: 100, h: 80,  kind: 'building' });
      out.push({ x: 880, y: 270, w: 100, h: 100, kind: 'building' });
      out.push({ x: 280, y: 870, w: 100, h: 100, kind: 'building' });
      out.push({ x: 600, y: 920, w: 100, h: 80,  kind: 'building' });
      out.push({ x: 880, y: 870, w: 100, h: 100, kind: 'building' });
      return out;
    },
    spawn: { blue: { x: 200, y: 600 }, red: { x: 1000, y: 200 } },
    modes: ['convoy'],
  },

  // Forest 森林: dense low-cover tree clumps. The UAV is a sensor in every
  // other map but here the canopy blocks aerial vision — combat is ground-
  // only. Hand-placed clusters with sightline lanes between them so the map
  // doesn't degenerate into pure CQB.
  { id: 'forest', name: '森林 FOREST',
    walls: () => {
      const out = [];
      const trees = [
        // West thicket
        [180, 220], [240, 280], [200, 360], [280, 420], [220, 500], [310, 580],
        // North thicket
        [380, 200], [460, 260], [540, 220], [620, 280], [700, 230], [780, 290], [860, 240],
        // East thicket
        [880, 380], [820, 440], [900, 520], [840, 600], [890, 700],
        // South thicket
        [380, 760], [460, 820], [540, 780], [620, 840], [700, 800], [780, 860], [860, 820],
        // Mid scattered (broken sightlines)
        [420, 460], [560, 540], [680, 480], [500, 660], [620, 700],
      ];
      for (const [tx, ty] of trees) {
        // 50×50 canopy block, marked so UAV vision is blocked when target is inside
        out.push({ x: tx, y: ty, w: 50, h: 50, kind: 'cover', canopy: true });
      }
      return out;
    },
    spawn: { blue: { x: 200, y: 600 }, red: { x: 1000, y: 600 } },
    modes: ['dm', 'survival', 'helo'],
    forest: true,    // marker for UAV-disable + minimap green tint
  },
];

// User-built map slot — normally randomly picks a non-empty slot from the
// 3-slot customMaps store, so each match with the custom variant rotates
// through whatever the player has saved. The editor's TEST button overrides
// this via _forceCustomSlot so 'TEST' always loads the slot the user is
// currently editing, not a random other one (user report: '測試地圖根本不
// 是我畫的').
let _customPickCache = null;
let _forceCustomSlot = null;     // {walls, spawn} — set by editorTest, cleared after match start
NN_MAP_VARIANTS.push({
  id: 'custom', name: '玩家自制 CUSTOM',
  walls: () => {
    _customPickCache = _forceCustomSlot || getAnyNonEmptyMap();
    return _customPickCache && Array.isArray(_customPickCache.walls) ? _customPickCache.walls : [];
  },
  get spawn() {
    if (_customPickCache && _customPickCache.spawn) return _customPickCache.spawn;
    return undefined;
  },
  modes: ['dm'],
  _gateOnSavedMap: true,
});

// Mode-aware variant pool. Variants without an explicit `modes` array
// default to deathmatch only. Some variants tag multiple modes.
// _forceVariantId, when set, skips the random roll and returns that
// variant's index directly. Used by editorTest to guarantee the custom
// variant gets picked even if NN loading takes longer than the previous
// Math.random hack's 800 ms window.
let _forceVariantId = null;
// arena-mp: map editor cut, no custom maps. Stubs:
function getAnyNonEmptyMap() { return null; }
// Normalize spawn entries (single {x,y} → array, or pass array through).
// Used by startNNSkirmish + NN_MAP_VARIANTS spawn pickers.
function _normalizeSpawnList(spawn) {
  if (!spawn) return [];
  if (Array.isArray(spawn)) return spawn.filter(p => p && typeof p.x === 'number' && typeof p.y === 'number');
  if (typeof spawn.x === 'number' && typeof spawn.y === 'number') return [{ x: spawn.x, y: spawn.y }];
  return [];
}
function pickMapForMode(mode) {
  if (_forceVariantId) {
    const idx = NN_MAP_VARIANTS.findIndex(v => v.id === _forceVariantId);
    if (idx >= 0) return idx;
  }
  const hasSavedCustom = !!getAnyNonEmptyMap();
  // Backfill default tag for variants that don't declare modes. Custom
  // variant only joins the pool when the user has actually saved one.
  const pool = NN_MAP_VARIANTS.filter(v => {
    if (v._gateOnSavedMap && !hasSavedCustom) return false;
    const tags = v.modes || ['dm'];
    return tags.includes(mode);
  });
  if (pool.length === 0) {
    return Math.floor(Math.random() * NN_MAP_VARIANTS.length);
  }
  const v = pool[Math.floor(Math.random() * pool.length)];
  return NN_MAP_VARIANTS.indexOf(v);
}

// Apply one of the variants to the current arena (after generateWorld). Pass
// `idx` (0..NN_MAP_VARIANTS.length-1) for explicit pick, or null/undefined to
// roll one from the current game-mode's pool (game._nnGameMode set in
// startNNSkirmish).
function buildNNArenaVariant(idx) {
  if (idx == null) idx = pickMapForMode(game._nnGameMode || 'dm');
  const v = NN_MAP_VARIANTS[idx];
  const walls = v.walls();
  for (const w of walls) {
    // Custom-editor + drag-line walls are stored as { kind: 'wallLine',
    // x1, y1, x2, y2, thickness } — these are real vector segments and
    // need addWallLine, NOT addBuilding. Dropping them through the else
    // branch was the silent breakage behind '這種牆壁在實戰的時候不會出現'.
    if (w.kind === 'wallLine') {
      addWallLine(NN_ARENA.x0 + w.x1, NN_ARENA.y0 + w.y1,
                  NN_ARENA.x0 + w.x2, NN_ARENA.y0 + w.y2,
                  { thickness: w.thickness || 18 });
      continue;
    }
    const x = NN_ARENA.x0 + w.x;
    const y = NN_ARENA.y0 + w.y;
    if (w.kind === 'cover') {
      // sub: 'crate' (default cream) / 'sandbag' (olive) / 'tree' (canopy)
      const sub = w.subkind || (w.canopy ? 'tree' : 'crate');
      const col = w.color
        || (sub === 'tree'    ? '#3F4A3A'
        :   sub === 'sandbag' ? '#A89568'
        :                       COLORS.creamDark);
      addLowCover(x, y, w.w, w.h, col,
                  { kind: sub, canopy: sub === 'tree' || !!w.canopy });
    } else {
      // sub: 'building' (default) / 'bunker' (tougher full-height block)
      const sub = w.subkind || 'building';
      addBuilding(x, y, w.w, w.h, w.color || COLORS.gray,
                  { kind: sub, accent: !!w.accent });
    }
  }
  buildCoverPoints();
  game._nnVariantId = v.id;
  game._nnVariantForest = !!v.forest;
  return v;
}
