// ============ MAP DEFINITIONS ============
// Each map satisfies: theme >= 70%, 3+ spatial layers, 1+ landmark,
// 3+ route types, distinct combat rhythm.
//
// Adding a new map = MAPS.push({...}). The `modes: [...]` array on each
// map gates which game modes can use it — modes filter MAPS at lobby
// open time to populate the map picker.
//
// Classic-script. Declares globally:
//   MAPS (array — populated with .push() per map)
//   NN_ARENA_MAP_INDEX (index of the dedicated NN arena map)
//
// External deps (resolved at call-time during world gen):
//   addBuilding · addLowCover · addOverhead · addRoute · addLandmark ·
//   addDecoration · addThemeShape · NN_ARENA · WORLD

const MAPS = [];

// ---------- MAP 1: 核池 / REACTOR POOL ----------
// Rhythm: room clearing — soldiers cluster around the cooling pool; tight corridors.
MAPS.push({
  id: 'reactor',
  name: '核池',
  nameEn: 'REACTOR POOL',
  subtitle: '高放冷却池 · 室内清剿',
  rhythmHint: 'CLOSE-QUARTERS / 室内清剿',
  playerSpawn: { x: 480, y: WORLD.h/2 },
  spawn: {
    soldierBase: 6, soldierPerWave: 1,
    droneBase: 1,  dronePerWave: 0,
    soldierBias: 'landmarkRing',
    droneBias: 'overhead',
    soldierSpeedMul: 0.95,
    soldierFireFast: false,
  },
  build() {
    addTheme({ kind: 'rect', x: 0, y: 0, w: WORLD.w, h: WORLD.h, color: COLORS.floor });
    // Single quiet hazard wedge instead of overlapping wedge + chevrons
    addTheme({ kind: 'wedge', cx: WORLD.w*0.5, cy: WORLD.h*0.5, r: 1900, a0: -Math.PI*0.92, a1: -Math.PI*0.45, color: COLORS.red, alpha: 0.07 });
    // Three cooling pools (was 5) — central + two corners
    addTheme({ kind: 'pool', cx: WORLD.w*0.50, cy: WORLD.h*0.50, r: 360 });
    addTheme({ kind: 'pool', cx: WORLD.w*0.18, cy: WORLD.h*0.22, r: 170 });
    addTheme({ kind: 'pool', cx: WORLD.w*0.82, cy: WORLD.h*0.78, r: 200 });
    // Two hazard rings (was 5)
    addTheme({ kind: 'circle-stroke', cx: WORLD.w*0.5, cy: WORLD.h*0.5, r: 720, color: COLORS.red, alpha: 0.18, dash: [16, 22] });
    addTheme({ kind: 'circle-stroke', cx: WORLD.w*0.5, cy: WORLD.h*0.5, r: 1080, color: COLORS.red, alpha: 0.10, dash: [16, 22] });
    // Four pipes (was 14: 9 vertical + 5 horizontal)
    addTheme({ kind: 'pipe', x: WORLD.w*0.20, y: 0, w: 28, h: WORLD.h, color: COLORS.gray });
    addTheme({ kind: 'pipe', x: WORLD.w*0.80 - 28, y: 0, w: 28, h: WORLD.h, color: COLORS.gray });
    addTheme({ kind: 'pipe', x: 0, y: WORLD.h*0.18, w: WORLD.w, h: 28, color: COLORS.gray });
    addTheme({ kind: 'pipe', x: 0, y: WORLD.h*0.82 - 28, w: WORLD.w, h: 28, color: COLORS.gray });
    // Trefoil radiation symbol (kept — strong landmark accent)
    addTheme({ kind: 'trefoil', cx: WORLD.w*0.78, cy: WORLD.h*0.18, r: 220, color: COLORS.red, alpha: 0.55 });

    // === LAYERS ===
    // GROUND — sparse containment ring (was 8 → 6) + 2 service halls (was 4)
    const ringR = 600;
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI*2 + 0.3;
      const cx = WORLD.w/2 + Math.cos(a)*ringR;
      const cy = WORLD.h/2 + Math.sin(a)*ringR;
      addBuilding(cx-55, cy-55, 110, 110, COLORS.gray, { accent: i%2===0 });
    }
    addBuilding(180, 180, 360, 200, COLORS.gray, { accent: true });
    addBuilding(WORLD.w-540, WORLD.h-380, 360, 200, COLORS.black);
    // Sandbag bunkers near pool (4 instead of 6)
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI*2 + Math.PI/4;
      const cx = WORLD.w/2 + Math.cos(a)*430;
      const cy = WORLD.h/2 + Math.sin(a)*430;
      addLowCover(cx-32, cy-32, 64, 64, COLORS.creamDark, { kind: 'sandbag' });
    }

    // ELEVATED — single catwalk cross over the pool (was 4 overhead pieces)
    addOverhead(WORLD.w*0.36, WORLD.h*0.50 - 12, WORLD.w*0.28, 22, COLORS.black, { kind: 'catwalk' });
    addOverhead(WORLD.w*0.50 - 12, WORLD.h*0.36, 22, WORLD.h*0.28, COLORS.black, { kind: 'catwalk' });

    // === ROUTES ===
    addRoute(WORLD.w*0.20, WORLD.h*0.50 - 26, WORLD.w*0.60, 52, 'main', { label: '主路 · 热区' });
    addRoute(120, 120, WORLD.w-240, 26, 'side', { label: '侧路 · 外环' });
    addRoute(120, WORLD.h-150, WORLD.w-240, 26, 'side');
    addRoute(WORLD.w*0.36, WORLD.h*0.50 - 14, 28, 28, 'vertical', { label: '垂直 · 楼梯' });

    addLandmark({
      kind: 'reactorPool',
      x: WORLD.w/2, y: WORLD.h/2,
      r: 320,
      name: '核池 / REACTOR POOL',
    });

    // Decorations dropped: 18 → 6, nodes dropped: 30 → 10
    for (let i = 0; i < 6; i++) {
      addDecoration(Math.random()*WORLD.w, Math.random()*WORLD.h, 'triangle',
        28 + Math.random()*22, COLORS.red, 0.20 + Math.random()*0.18,
        Math.random()*Math.PI*2);
    }
    for (let i = 0; i < 10; i++) addNode(Math.random()*WORLD.w, Math.random()*WORLD.h);
  }
});

// ---------- MAP 2: 高炉 / BLAST FOUNDRY ----------
// Rhythm: vertical combat — drones swarm from gantries; player must clear elevated threats.
MAPS.push({
  id: 'foundry',
  name: '高炉',
  nameEn: 'BLAST FOUNDRY',
  subtitle: '熔铸车间 · 垂直交火',
  rhythmHint: 'VERTICAL FIREFIGHT / 垂直交火',
  playerSpawn: { x: WORLD.w/2, y: WORLD.h-360 },
  spawn: {
    soldierBase: 4, soldierPerWave: 1,
    droneBase: 4,  dronePerWave: 1,
    soldierBias: 'gantry',
    droneBias: 'overhead',
    soldierSpeedMul: 0.85,
    soldierFireFast: true,
  },
  build() {
    addTheme({ kind: 'rect', x: 0, y: 0, w: WORLD.w, h: WORLD.h, color: COLORS.floor });
    addTheme({ kind: 'plume', cx: WORLD.w/2, cy: WORLD.h*0.40, w: 900, h: WORLD.h*0.85, color: COLORS.red, alpha: 0.10 });
    // 3 slag pools (was 5)
    const slags = [
      { x: WORLD.w*0.10, y: WORLD.h*0.30, w: 360, h: 140 },
      { x: WORLD.w*0.65, y: WORLD.h*0.20, w: 520, h: 160 },
      { x: WORLD.w*0.55, y: WORLD.h*0.72, w: 600, h: 160 },
    ];
    for (const s of slags) addTheme({ kind: 'slag', x: s.x, y: s.y, w: s.w, h: s.h });
    // 2 conveyor belts (was 4)
    addTheme({ kind: 'belt', x: 0, y: WORLD.h*0.30, w: WORLD.w, h: 30, color: COLORS.black });
    addTheme({ kind: 'belt-v', x: WORLD.w*0.78, y: 0, w: 30, h: WORLD.h, color: COLORS.gray });
    // 3 light pipes (was 10)
    addTheme({ kind: 'pipe', x: WORLD.w*0.15, y: 0, w: 16, h: WORLD.h, color: COLORS.lightGray });
    addTheme({ kind: 'pipe', x: WORLD.w*0.45, y: 0, w: 16, h: WORLD.h, color: COLORS.lightGray });
    addTheme({ kind: 'pipe', x: WORLD.w*0.85, y: 0, w: 16, h: WORLD.h, color: COLORS.lightGray });
    // 2 heat rings around furnace (was 6)
    addTheme({ kind: 'circle-stroke', cx: WORLD.w/2, cy: WORLD.h*0.40, r: 460, color: COLORS.red, alpha: 0.20, dash: [10, 14] });
    addTheme({ kind: 'circle-stroke', cx: WORLD.w/2, cy: WORLD.h*0.40, r: 720, color: COLORS.red, alpha: 0.12, dash: [10, 14] });
    // Big stamped foundry insignia (kept)
    addTheme({ kind: 'gear', cx: WORLD.w*0.12, cy: WORLD.h*0.88, r: 200, color: COLORS.black, alpha: 0.18 });

    // GROUND — 2 production halls (was 4) + 4 furnace columns (was 6) + drop side walls
    addBuilding(180, 200, 360, 280, COLORS.gray, { accent: true });
    addBuilding(WORLD.w-540, WORLD.h-460, 360, 280, COLORS.black);
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI*2 + Math.PI/4;
      const cx = WORLD.w/2 + Math.cos(a)*420;
      const cy = WORLD.h*0.40 + Math.sin(a)*320;
      addBuilding(cx-40, cy-40, 80, 80, COLORS.gray);
    }
    // 5 girders (was 10)
    for (let i = 0; i < 5; i++) {
      addLowCover(WORLD.w*0.20 + i*340, WORLD.h*0.58, 100, 22, COLORS.gray, { kind: 'girder' });
    }

    // ELEVATED — single horizontal crane rail + 2 gantries + crane trolley
    addOverhead(120, WORLD.h*0.18, WORLD.w-240, 20, COLORS.black, { kind: 'crane-rail' });
    addOverhead(WORLD.w*0.20, WORLD.h*0.32, 22, WORLD.h*0.36, COLORS.black);
    addOverhead(WORLD.w*0.80 - 22, WORLD.h*0.32, 22, WORLD.h*0.36, COLORS.black);
    addOverhead(WORLD.w*0.50 - 70, WORLD.h*0.18 - 14, 140, 46, COLORS.black, { kind: 'trolley' });

    // ROUTES
    addRoute(0, WORLD.h*0.58 + 30, WORLD.w, 50, 'main', { label: '主路 · 生产线' });
    addRoute(WORLD.w*0.20 - 14, WORLD.h*0.65, 52, 28, 'vertical', { label: '垂直 · 钢梯' });
    addRoute(WORLD.w*0.80 - 38, WORLD.h*0.65, 52, 28, 'vertical');
    addRoute(0, 60, WORLD.w, 30, 'drone', { label: '空中 · 无人机' });
    addRoute(WORLD.w*0.35, WORLD.h-200, WORLD.w*0.30, 80, 'vehicle', { label: '车道 · 运料' });

    addLandmark({
      kind: 'blastFurnace',
      x: WORLD.w/2, y: WORLD.h*0.40,
      r: 240,
      name: '高炉 / BLAST FURNACE',
    });

    // Decorations 14 → 5, nodes 22 → 8
    for (let i = 0; i < 5; i++) {
      addDecoration(Math.random()*WORLD.w, Math.random()*WORLD.h, 'square',
        30 + Math.random()*40, COLORS.black, 0.15 + Math.random()*0.18,
        Math.random()*Math.PI*2);
    }
    for (let i = 0; i < 8; i++) addNode(Math.random()*WORLD.w, Math.random()*WORLD.h);
  }
});

// ---------- MAP 3: 货柜港 / CONTAINER YARD ----------
// Rhythm: ambush in narrow gaps + open vehicle/drone combat on wide quay.
MAPS.push({
  id: 'containerYard',
  name: '货柜港',
  nameEn: 'CONTAINER YARD',
  subtitle: '集装箱码头 · 伏击与突袭',
  rhythmHint: 'AMBUSH + OPEN ASSAULT / 伏击突袭',
  playerSpawn: { x: WORLD.w-360, y: WORLD.h*0.60 },
  spawn: {
    soldierBase: 5, soldierPerWave: 2,
    droneBase: 2,  dronePerWave: 1,
    soldierBias: 'corridor',
    droneBias: 'open',
    soldierSpeedMul: 1.10,
    soldierFireFast: false,
  },
  build() {
    addTheme({ kind: 'rect', x: 0, y: 0, w: WORLD.w, h: WORLD.h, color: COLORS.floor });
    addTheme({ kind: 'water', x: 0, y: 0, w: WORLD.w*0.18, h: WORLD.h, color: COLORS.gray });
    addTheme({ kind: 'rect', x: WORLD.w*0.18, y: 0, w: 80, h: WORLD.h, color: COLORS.floorAccent });
    // Yard markings — far fewer (was 19 lines, now 6)
    for (let i = 0; i < 4; i++) addTheme({ kind: 'line-h', x: WORLD.w*0.22, y: 600 + i*640, w: WORLD.w*0.76, h: 3, color: COLORS.gray, alpha: 0.30 });
    for (let i = 0; i < 2; i++) addTheme({ kind: 'line-v', x: WORLD.w*0.40 + i*WORLD.w*0.30, y: 120, w: 3, h: WORLD.h-240, color: COLORS.gray, alpha: 0.30 });
    // Port logo (kept — strong identity)
    addTheme({ kind: 'square', x: WORLD.w*0.78, y: 120, w: 320, h: 320, color: COLORS.red, alpha: 0.14 });

    // GROUND — much sparser container grid: 3 rows × 5 cols (was 5×8 = ~36)
    const cw0 = 240, ch0 = 110;
    const startX = WORLD.w*0.28, startY = WORLD.h*0.18;
    const cols = 5, rows = 3;
    const colStep = (WORLD.w*0.66) / cols;
    const rowStep = (WORLD.h*0.62) / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if ((row + col) % 5 === 2) continue; // gaps for alleys
        const px = startX + col * colStep;
        const py = startY + row * rowStep;
        const palette = [COLORS.gray, COLORS.black, COLORS.red];
        const color = palette[(row*2 + col) % palette.length];
        addBuilding(px, py, cw0, ch0, color, { accent: (col%3)===0 });
      }
    }
    // Quay wall (kept)
    addLowCover(WORLD.w*0.18 + 80, 80, 24, WORLD.h-160, COLORS.black, { kind: 'quay-wall' });

    // ELEVATED — single horizontal crane rail + trolley (was 2 rails)
    addOverhead(WORLD.w*0.22, WORLD.h*0.50, WORLD.w*0.76, 26, COLORS.black, { kind: 'crane-rail' });
    addOverhead(WORLD.w*0.55 - 90, WORLD.h*0.50 - 18, 180, 56, COLORS.black, { kind: 'trolley' });

    // ROUTES — keep main quay + 2 alleys + drone lane (was many)
    addRoute(WORLD.w*0.20, 80, 80, WORLD.h-160, 'vehicle', { label: '主路·码头道', style: 'wide' });
    addRoute(WORLD.w*0.28, WORLD.h*0.36, WORLD.w*0.66, 26, 'side', { label: '侧路·暗巷' });
    addRoute(WORLD.w*0.28, WORLD.h*0.62, WORLD.w*0.66, 26, 'side');
    addRoute(0, 60, WORLD.w, 28, 'drone', { label: '空中·无人机' });

    addLandmark({
      kind: 'gantryCrane',
      x: WORLD.w*0.55, y: WORLD.h*0.50,
      w: WORLD.w*0.76, h: 320,
      name: '货柜吊车 / GANTRY CRANE',
    });

    // Decorations 12 → 4
    for (let i = 0; i < 4; i++) {
      addDecoration(WORLD.w*0.30 + Math.random()*WORLD.w*0.60,
        Math.random()*WORLD.h, 'line', 80 + Math.random()*60,
        COLORS.red, 0.20 + Math.random()*0.18,
        Math.random()*Math.PI*0.4 - Math.PI*0.2);
    }
    for (let i = 0; i < 6; i++) addNode(WORLD.w*0.20 + Math.random()*WORLD.w*0.78, Math.random()*WORLD.h);
  }
});

// ---------- MAP 4: 资料核心 / DATA CORE ----------
// Rhythm: node control — tight grid of server racks; capture-the-node feel.
MAPS.push({
  id: 'dataCore',
  name: '资料核心',
  nameEn: 'DATA CORE',
  subtitle: '服务器矩阵 · 节点控制',
  rhythmHint: 'NODE CONTROL / 节点控制',
  playerSpawn: { x: WORLD.w*0.15, y: WORLD.h*0.15 },
  spawn: {
    soldierBase: 6, soldierPerWave: 2,
    droneBase: 3,  dronePerWave: 1,
    soldierBias: 'nodes',
    droneBias: 'corridor',
    soldierSpeedMul: 1.0,
    soldierFireFast: true,
  },
  build() {
    addTheme({ kind: 'rect', x: 0, y: 0, w: WORLD.w, h: WORLD.h, color: COLORS.floor });
    // Three quiet cooling vent bands instead of seven
    for (let i = 0; i < 3; i++) {
      addTheme({ kind: 'rect', x: 280, y: 540 + i*880, w: WORLD.w-560, h: 18, color: COLORS.red, alpha: 0.22 });
    }
    // Central data sigil — keep the strong shape, drop the dashed circle
    addTheme({ kind: 'square', x: WORLD.w*0.50 - 320, y: WORLD.h*0.50 - 320, w: 640, h: 640, color: COLORS.black, alpha: 0.07 });
    // Data flow cross
    addTheme({ kind: 'line-h', x: 0, y: WORLD.h*0.50 - 2, w: WORLD.w, h: 4, color: COLORS.red, alpha: 0.45 });
    addTheme({ kind: 'line-v', x: WORLD.w*0.50 - 2, y: 0, w: 4, h: WORLD.h, color: COLORS.red, alpha: 0.45 });

    // GROUND — sparser server rack clusters in 4 quadrants instead of a 7×5 grid
    const clusters = [
      { cx: WORLD.w*0.20, cy: WORLD.h*0.20 },
      { cx: WORLD.w*0.80, cy: WORLD.h*0.20 },
      { cx: WORLD.w*0.20, cy: WORLD.h*0.80 },
      { cx: WORLD.w*0.80, cy: WORLD.h*0.80 },
    ];
    for (const c of clusters) {
      // 2 rows × 1 wide rack per cluster — visually clear, easy to navigate around
      addBuilding(c.cx - 140, c.cy - 60, 280, 36, COLORS.black, { accent: true });
      addBuilding(c.cx - 140, c.cy + 24, 280, 36, COLORS.gray);
    }
    // Two longer racks flanking the data core (visual support of the central feature)
    addBuilding(WORLD.w*0.30, WORLD.h*0.50 - 18, 240, 36, COLORS.black);
    addBuilding(WORLD.w*0.70 - 240, WORLD.h*0.50 - 18, 240, 36, COLORS.black);

    // Capture-node markers — three (was four), positioned for A/B/C mission
    const nodes = [
      { x: WORLD.w*0.25, y: WORLD.h*0.25 },
      { x: WORLD.w*0.75, y: WORLD.h*0.25 },
      { x: WORLD.w*0.50, y: WORLD.h*0.75 },
    ];
    for (const n of nodes) {
      addLowCover(n.x-60, n.y-60, 120, 120, COLORS.red, { kind: 'node-platform' });
    }

    // ELEVATED — single horizontal duct + single vertical (was three)
    addOverhead(0, WORLD.h*0.18, WORLD.w, 16, COLORS.black, { kind: 'duct' });
    addOverhead(WORLD.w*0.50 - 8, 0, 16, WORLD.h, COLORS.black, { kind: 'duct' });

    // ROUTES
    addRoute(WORLD.w*0.10, WORLD.h*0.50 - 22, WORLD.w*0.80, 44, 'main', { label: '主路·冷通道' });
    addRoute(120, WORLD.h*0.32, WORLD.w-240, 24, 'side', { label: '侧路·线槽' });
    addRoute(WORLD.w*0.50 - 14, 60, 28, 28, 'vertical', { label: '垂直·风道' });
    addRoute(WORLD.w*0.50 - 14, WORLD.h-100, 28, 28, 'vertical');

    // LANDMARK — central data core
    addLandmark({
      kind: 'dataCore',
      x: WORLD.w*0.50, y: WORLD.h*0.50,
      r: 220,
      name: '资料核心 / DATA CORE',
      capturePoints: nodes,
    });

    // Decorations dropped to 6, network nodes dropped to 14 (was 16 + 80)
    for (let i = 0; i < 6; i++) {
      addDecoration(Math.random()*WORLD.w, Math.random()*WORLD.h, 'square',
        18 + Math.random()*22, COLORS.black, 0.20 + Math.random()*0.15,
        Math.random()*Math.PI*2);
    }
    for (let i = 0; i < 14; i++) addNode(Math.random()*WORLD.w, Math.random()*WORLD.h);
  }
});

// ---------- MAP 5: 蜂巢 / DRONE HIVE ----------
// Rhythm: open vehicle / drone-heavy combat with constant aerial harassment.
MAPS.push({
  id: 'droneHive',
  name: '蜂巢',
  nameEn: 'DRONE HIVE',
  subtitle: '无人机巢穴 · 开阔战场',
  rhythmHint: 'OPEN AERIAL ASSAULT / 空中开阔战',
  playerSpawn: { x: WORLD.w/2, y: WORLD.h-380 },
  spawn: {
    soldierBase: 3, soldierPerWave: 1,
    droneBase: 6,  dronePerWave: 2,
    soldierBias: 'pad',
    droneBias: 'hive',
    soldierSpeedMul: 1.05,
    soldierFireFast: false,
  },
  build() {
    addTheme({ kind: 'rect', x: 0, y: 0, w: WORLD.w, h: WORLD.h, color: COLORS.floor });
    // 5 concentric rings (was 12) — still gives the radial feel
    for (let i = 0; i < 5; i++) {
      addTheme({ kind: 'circle-stroke', cx: WORLD.w/2, cy: WORLD.h*0.40, r: 320 + i*280, color: COLORS.red, alpha: 0.18, dash: [12, 18] });
    }
    // 3 hex pads (was 5)
    const pads = [
      { x: WORLD.w*0.18, y: WORLD.h*0.32, r: 160 },
      { x: WORLD.w*0.82, y: WORLD.h*0.32, r: 160 },
      { x: WORLD.w*0.50, y: WORLD.h*0.86, r: 190 },
    ];
    for (const p of pads) {
      addTheme({ kind: 'pad', cx: p.x, cy: p.y, r: p.r, color: COLORS.black, alpha: 0.45 });
    }
    // 6 antenna masts along top edge (was 14)
    for (let i = 0; i < 6; i++) {
      addTheme({ kind: 'mast', x: 240 + i*520, y: WORLD.h*0.08, h: 220 + (i%2)*40, color: COLORS.black });
    }
    // Runway: simpler centerline (8 dashes instead of 16)
    addTheme({ kind: 'rect', x: WORLD.w*0.45, y: 0, w: WORLD.w*0.10, h: WORLD.h, color: COLORS.floorAccent });
    for (let i = 0; i < 8; i++) addTheme({ kind: 'rect', x: WORLD.w*0.50 - 6, y: 200 + i*380, w: 12, h: 100, color: COLORS.black });

    // GROUND — 2 control kiosks + 4 hive support pylons (was 4 + 6)
    addBuilding(180, 200, 240, 200, COLORS.gray, { accent: true });
    addBuilding(WORLD.w-420, WORLD.h-400, 240, 200, COLORS.black);
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI*2 + Math.PI/4;
      const cx = WORLD.w/2 + Math.cos(a)*340;
      const cy = WORLD.h*0.40 + Math.sin(a)*340;
      addBuilding(cx-30, cy-30, 60, 60, COLORS.gray, { accent: true });
    }
    // 6 blast walls (was 10)
    for (let i = 0; i < 6; i++) {
      const ang = i / 6 * Math.PI*2 + 0.3;
      const r = 580;
      addLowCover(WORLD.w/2 + Math.cos(ang)*r - 40, WORLD.h*0.40 + Math.sin(ang)*r - 16, 80, 32, COLORS.creamDark, { kind: 'blastwall' });
    }

    // ELEVATED — 4 hive perch spokes (was 6) + 1 antenna band (was 2)
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI*2 + Math.PI/4;
      const len = 320;
      const x1 = WORLD.w/2, y1 = WORLD.h*0.40;
      const x2 = x1 + Math.cos(a)*len, y2 = y1 + Math.sin(a)*len;
      const minX = Math.min(x1, x2), minY = Math.min(y1, y2);
      const w = Math.max(20, Math.abs(x2-x1));
      const h = Math.max(20, Math.abs(y2-y1));
      addOverhead(minX, minY, w, h, COLORS.black, { kind: 'perch', spoke: true });
    }
    addOverhead(0, WORLD.h*0.10 - 9, WORLD.w, 16, COLORS.black);

    // ROUTES
    addRoute(WORLD.w*0.45, 0, WORLD.w*0.10, WORLD.h, 'vehicle', { label: '主路·跑道', style: 'wide' });
    addRoute(120, 120, WORLD.w-240, 24, 'side', { label: '侧路·边线' });
    addRoute(120, WORLD.h-150, WORLD.w-240, 24, 'side');
    for (let i = 0; i < 2; i++) {
      const a = i * Math.PI;
      const cx = WORLD.w/2 + Math.cos(a)*280, cy = WORLD.h*0.40 + Math.sin(a)*280;
      addRoute(cx-14, cy-14, 28, 28, 'vertical', { label: i===0 ? '垂直·攀爬' : '' });
    }
    addRoute(0, 60, WORLD.w, 28, 'drone', { label: '空中·蜂群' });

    addLandmark({
      kind: 'droneHive',
      x: WORLD.w/2, y: WORLD.h*0.40,
      r: 200,
      name: '无人机蜂巢 / DRONE HIVE',
    });

    // Decorations 22 → 5
    for (let i = 0; i < 5; i++) {
      addDecoration(
        Math.random()*WORLD.w, Math.random()*WORLD.h,
        'triangle', 30 + Math.random()*30, COLORS.red,
        0.20 + Math.random()*0.18,
        Math.random()*Math.PI*2
      );
    }
    for (let i = 0; i < 8; i++) addNode(Math.random()*WORLD.w, Math.random()*WORLD.h);
  }
});

// ---------- SKIRMISH ARENA (dev / sandbox map) ----------
// A small maze for pure combat — no mission, no objectives. Used to verify
// AI behaviour and test loadout balance.
MAPS.push({
  id: 'arena',
  name: '竞技场',
  nameEn: 'SKIRMISH ARENA',
  subtitle: '迷宫对抗 · 纯射击',
  rhythmHint: 'PURE COMBAT / 纯对抗',
  playerSpawn: { x: 400, y: WORLD.h/2 },
  spawn: {
    soldierBase: 6, soldierPerWave: 0,
    droneBase: 0,  dronePerWave: 0,
    soldierBias: 'ringFromPlayer',
    droneBias: 'open',
    soldierSpeedMul: 1.0,
    soldierFireFast: false,
  },
  build() {
    addTheme({ kind: 'rect', x: 0, y: 0, w: WORLD.w, h: WORLD.h, color: COLORS.floor });
    // (Light grid background CUT per FTUE/01 §10 + §A.4.1 — no grid lines.
    // The "show scale" purpose was strategy-game cosmetics, not GREY VECTOR.)

    // Maze walls — strategically placed so cover-seeking AI has options.
    // Vertical walls
    addBuilding(800, 600, 60, 700, COLORS.gray, { accent: true });
    addBuilding(1500, 300, 60, 800, COLORS.gray);
    addBuilding(1500, 1700, 60, 800, COLORS.gray);
    addBuilding(2200, 800, 60, 1100, COLORS.gray, { accent: true });
    addBuilding(2700, 1500, 60, 700, COLORS.gray);
    // Horizontal walls
    addBuilding(800, 1700, 700, 60, COLORS.black);
    addBuilding(1700, 1100, 600, 60, COLORS.black, { accent: true });
    addBuilding(1700, 2300, 600, 60, COLORS.black);
    addBuilding(400, 2400, 500, 60, COLORS.black);
    // Crate clusters (low cover)
    addLowCover(1200, 800, 90, 90, COLORS.creamDark, { kind: 'crate' });
    addLowCover(1200, 1400, 90, 90, COLORS.creamDark);
    addLowCover(2400, 600, 90, 90, COLORS.creamDark);
    addLowCover(2400, 2200, 90, 90, COLORS.creamDark);
    addLowCover(1900, 1500, 90, 90, COLORS.creamDark);
    addLowCover(600, 1100, 90, 90, COLORS.creamDark);
    addLowCover(600, 2000, 90, 90, COLORS.creamDark);

    // Spawn-room markers (visual: friendly side / enemy side)
    addRoute(120, WORLD.h/2 - 200, 200, 400, 'side', { label: '友军 SQUAD' });
    addRoute(WORLD.w - 320, WORLD.h/2 - 200, 200, 400, 'side', { label: '敌军 HOSTILE' });

    addLandmark({ kind: 'arena', x: WORLD.w/2, y: WORLD.h/2, r: 80, name: '中央 ARENA' });
  }
});
const ARENA_MAP_INDEX = MAPS.length - 1;

// ---------- NN ARENA (1200×1200 sub-region, matches the trained PPO model) ----------
// The PPO model was trained in a 1200×1200 world. We embed a 1200×1200
// play area inside the JS world's top-left so the NN's spatial
// normalisation matches its training. AI + player are clamped here.
// Phase 16: arena expanded from 1200×1200 → 1800×1800 (2.25× area, 1.5×
// linear) per user request — '这个地图可能可以再大十倍五倍 · 现在完全几乎
// 一样的东西的概念'. NN.WORLD_W / NN.WORLD_H below are bumped to match so
// the trained PPO's obs normalization tracks the new bounds. The model
// was trained on 1200×1200 so spatial reasoning is slightly stretched —
// acceptable given user feedback that '敌人现在不是那么聪明'.
const NN_ARENA = { x0: 0, y0: 0, w: 1800, h: 1800 };
MAPS.push({
  id: 'nnArena',
  name: 'NN 竞技场',
  nameEn: 'NN ARENA',
  subtitle: '神经网络对抗 · 1200×1200',
  rhythmHint: 'NEURAL NET COMBAT / PPO 推论',
  playerSpawn: { x: NN_ARENA.x0 + 250, y: NN_ARENA.y0 + NN_ARENA.h/2 },
  spawn: {
    soldierBase: 3, soldierPerWave: 0,
    droneBase: 0,  dronePerWave: 0,
    soldierBias: 'nnArena',
    droneBias: 'open',
    soldierSpeedMul: 1.0,
    soldierFireFast: false,
  },
  build() {
    // Cream base only inside the 1200×1200 region; outside left grey-ish.
    // Phase 5: both colors are TOD-tinted via COLORS rebind so the whole
    // off-arena + arena shifts together by time-of-day (warm noon, ember
    // dusk, void night, cold dawn).
    addTheme({ kind: 'rect', x: 0, y: 0, w: WORLD.w, h: WORLD.h, color: COLORS.lightGray });
    addTheme({ kind: 'rect', x: NN_ARENA.x0, y: NN_ARENA.y0, w: NN_ARENA.w, h: NN_ARENA.h, color: COLORS.floor });
    // Border
    addTheme({ kind: 'rect', x: NN_ARENA.x0, y: NN_ARENA.y0 - 4, w: NN_ARENA.w, h: 8, color: COLORS.red });
    addTheme({ kind: 'rect', x: NN_ARENA.x0, y: NN_ARENA.y0 + NN_ARENA.h - 4, w: NN_ARENA.w, h: 8, color: COLORS.red });
    addTheme({ kind: 'rect', x: NN_ARENA.x0 - 4, y: NN_ARENA.y0, w: 8, h: NN_ARENA.h, color: COLORS.red });
    addTheme({ kind: 'rect', x: NN_ARENA.x0 + NN_ARENA.w - 4, y: NN_ARENA.y0, w: 8, h: NN_ARENA.h, color: COLORS.red });
    // (Grid for scale reference CUT per FTUE/01 §10 + §A.4.1 — no grid lines.)
    // Walls + cover are added per-match by buildNNArenaVariant() so we can
    // randomize layouts to match the training distribution. Build() only
    // creates the empty arena shell (border, grid, spawn markers, landmark).
    addRoute(NN_ARENA.x0 + 50, NN_ARENA.y0 + NN_ARENA.h/2 - 100, 80, 200, 'side', { label: '友军 NN_BLUE' });
    addRoute(NN_ARENA.x0 + NN_ARENA.w - 130, NN_ARENA.y0 + NN_ARENA.h/2 - 100, 80, 200, 'side', { label: '敌军 NN_RED' });
    addLandmark({ kind: 'arena', x: NN_ARENA.x0 + NN_ARENA.w/2, y: NN_ARENA.y0 + NN_ARENA.h/2, r: 60, name: 'NN ARENA' });
  }
});
const NN_ARENA_MAP_INDEX = MAPS.length - 1;
