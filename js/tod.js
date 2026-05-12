// ============ TIME OF DAY ============
// Constructivist palette in 4 ambient states (day / dusk / night / dawn).
// Selected per-match in NN arena: random by default, override with
// ?tod=day|dusk|night|dawn. Mutates SCENE-only keys in COLORS so HUD and
// the red signature accent stay stable. The whole point of constructivism
// here is "red+cream+black on industrial gray" — TOD shifts the gray's
// HUE (warm noon → ember dusk → void night → cold dawn), it does NOT
// touch the red or the cream.
//
// Per FTUE/01 §A.4.1 the floor must NEVER be cream/light, so every TOD
// keeps a dark floor — the differentiation is hue, not luminance.
//
// Classic-script. Declares globally:
//   TOD_PALETTES (object — { day, dusk, night, dawn })
//   TOD (object — { current, snapshotBaseline, setTOD, pickForMatch,
//                   applyMatchTOD, revertToDay })
//
// External deps (resolved at call-time):
//   COLORS  (defined later in index.html — we never reference it at
//            module-init, only inside method bodies that callers invoke
//            after COLORS exists)

const TOD_PALETTES = {
  // 白天 — industrial noon. Ash-warm gray ground, cement buildings,
  // bleached cream highlights. Red sings against the gray.
  day: {
    sky:         '#2A2A28',  // warm ash above the arena box (edges)
    floor:       '#1E1E1C',  // dark warm gray — primary ground
    floorAccent: '#262624',
    gray:        '#9C988C',  // cement / mid building tone
    lightGray:   '#C8C2B0',  // sun-bleached highlight / sandbag
    creamDark:   '#807A6C',  // shadow + grid + cover
  },
  // 黃昏 — smokestack ember. Burnt sienna ground, brick + rust buildings,
  // long shadows. The whole world warms one hue-stop into orange-brown.
  dusk: {
    sky:         '#3A1A0E',  // smoke-orange dome edge
    floor:       '#22130B',  // ember umber ground
    floorAccent: '#2D1A10',
    gray:        '#7A4824',  // brick / rust building bodies
    lightGray:   '#B8703A',  // sunlit edges glow
    creamDark:   '#5C3220',  // deep ember shadow
  },
  // 黑夜 — Rodchenko night poster. Near-black void floor; buildings sink
  // to silhouette and the red accent becomes the only saturated thing on
  // screen (intended — that's the constructivist trick at night).
  night: {
    sky:         '#08090E',  // pure void edge
    floor:       '#10121A',  // ultra-dark cool-black ground
    floorAccent: '#15182A',
    gray:        '#2A2D34',  // building silhouette (slightly above floor)
    lightGray:   '#4A4D58',  // faint highlight on edges
    creamDark:   '#1F2230',  // shadow tone disappears into dark
  },
  // 黎明 — cold pre-dawn mist. Steel-blue palette, low contrast, soft.
  // Hint of warmth nowhere — everything reads cold, fog-damp.
  dawn: {
    sky:         '#1F2832',  // cold steel-blue dome
    floor:       '#1A1F26',  // very dark cool-gray ground
    floorAccent: '#222932',
    gray:        '#4A5662',  // cool gray-blue building bodies
    lightGray:   '#7A8898',  // dawn light on edges
    creamDark:   '#3A4452',  // damp shadow
  },
};

const TOD = {
  current: 'day',
  palettes: TOD_PALETTES,
  _base: null,

  // Snapshot the current COLORS scene-keys so we can revert cleanly. Also
  // injects COLORS.sky if it doesn't exist yet (defaults to day sky).
  // Idempotent — safe to call from many entry points.
  snapshotBaseline() {
    if (this._base) return;
    if (typeof COLORS === 'undefined') return;   // called too early — skip
    this._base = {
      sky:         TOD_PALETTES.day.sky,
      floor:       COLORS.floor,
      floorAccent: COLORS.floorAccent,
      gray:        COLORS.gray,
      lightGray:   COLORS.lightGray,
      creamDark:   COLORS.creamDark,
    };
    if (typeof COLORS.sky === 'undefined') COLORS.sky = this._base.sky;
  },

  // Apply a TOD by mutating COLORS scene-only keys. Returns true if the
  // palette name was valid. red / redBright / redDim / black / cream are
  // INTENTIONALLY untouched — accent + HUD must stay stable.
  setTOD(name) {
    if (!TOD_PALETTES[name]) return false;
    this.snapshotBaseline();
    if (typeof COLORS === 'undefined') return false;
    const p = TOD_PALETTES[name];
    COLORS.sky         = p.sky;
    COLORS.floor       = p.floor;
    COLORS.floorAccent = p.floorAccent;
    COLORS.gray        = p.gray;
    COLORS.lightGray   = p.lightGray;
    COLORS.creamDark   = p.creamDark;
    this.current = name;
    return true;
  },

  // Pick a TOD for the upcoming match. Honors ?tod= URL param when valid;
  // otherwise random across the four states.
  pickForMatch() {
    try {
      const qp = new URLSearchParams(location.search).get('tod');
      if (qp && TOD_PALETTES[qp]) return qp;
    } catch (e) {}
    const order = ['day', 'dusk', 'night', 'dawn'];
    return order[Math.floor(Math.random() * order.length)];
  },

  // Pick + apply in one call. Called from startNNSkirmish so each match
  // gets its own ambient. Returns the name selected (caller can toast it).
  applyMatchTOD() {
    const name = this.pickForMatch();
    this.setTOD(name);
    return name;
  },

  // Revert to day baseline. Use this when leaving NN mode (campaign,
  // FTUE etc. expect day-baseline colors).
  revertToDay() {
    return this.setTOD('day');
  },
};

try { window.TOD = TOD; window.TOD_PALETTES = TOD_PALETTES; } catch (e) {}
