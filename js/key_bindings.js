// ============ KEY BINDINGS ============
// Single source of truth for all keyboard input. Each binding row knows
// the key, the action it fires, and whether it should respect mode/state
// gates. Adding a new key = one new row, not 6 places in a switch chain.
//
// Why: the previous 235-line keydown body had 14 `else if (k === 'X')`
// branches each with its own typeof guards. Hard to scan, easy to drop
// a guard, FTUE typeof noise everywhere.
//
// Classic-script. Declares globally:
//   _recallToSpawn() · _toggleCommandView() · _toggleAimAssist()
//   _pickBuildModuleByNumber(eKey) · _handleNumberKey(eKey)
//   KEY_BINDINGS (table — { q, e, h, tab, r, g, b, x, u, v })
// Also attaches the window keydown listener that dispatches by table.
//
// External deps (resolved at call-time):
//   game · player · WORLD · currentMap · buildMode · STRUCTURE_ORDER
//   MISSIONS · mission · AG
//   showSwapToast · showMessage · playRadioBeep · T
//   toggleDrone · launchFPV · startReload · throwGrenade · toggleBuildMode
//   swapPlayerWeapon · upgradeNearestModule · togglePause
//   issueSquadOrder · swapPlayerToAlly · startNextWave · onMissionSuccess
//   _arenaTrySEDConvert · _ftueKeyLocked

// --- Action helpers (extracted from inline keydown blocks) ---
function _recallToSpawn() {
  if (!player.alive) return;
  let sx = null, sy = null;
  if (game._nnMode && game._nnSpawnBlue) {
    sx = game._nnSpawnBlue.x; sy = game._nnSpawnBlue.y;
  } else if (typeof currentMap !== 'undefined' && currentMap && currentMap.playerSpawn) {
    sx = currentMap.playerSpawn.x; sy = currentMap.playerSpawn.y;
  } else {
    sx = WORLD.w / 2; sy = WORLD.h / 2;
  }
  player.x = sx; player.y = sy;
  player._velX = 0; player._velY = 0;
  player._invulnUntil = game.time + 60;
  if (typeof showSwapToast === 'function') {
    showSwapToast(T('▶ 回到出生點', '▶ RECALL TO SPAWN'));
  }
  if (typeof playRadioBeep === 'function') playRadioBeep(990, 0.10);
}

function _toggleCommandView() {
  game.mode = (game.mode === 'command') ? 'tactical' : 'command';
  const inCmd = (game.mode === 'command');
  if (typeof showSwapToast === 'function') {
    showSwapToast(inCmd
      ? T('▶ 指令模式 · 1-7 下令', '▶ COMMAND MODE · 1-7 to order')
      : T('◀ 戰術視角', '◀ TACTICAL VIEW'));
  }
  if (typeof playRadioBeep === 'function') {
    playRadioBeep(inCmd ? 1320 : 660, 0.10);
  }
}

function _toggleAimAssist() {
  player._aimAssist = !player._aimAssist;
  AG.set('aimAssist', player._aimAssist ? '1' : '0');
  showMessage(`AIM-ASSIST · ${player._aimAssist ? T('开启', 'ON') : T('关闭', 'OFF')}`, 60);
}

function _pickBuildModuleByNumber(eKey) {
  // 0-9 → module index 9, 0..8 (so '0' acts as a tenth slot)
  const idx = eKey === '0' ? 9 : (parseInt(eKey, 10) - 1);
  if (STRUCTURE_ORDER[idx]) buildMode.kind = STRUCTURE_ORDER[idx];
  buildMode.radialOpen = false;
  buildMode._dragStart = null;
  buildMode._dragEnd   = null;
}

function _handleNumberKey(eKey) {
  // COMMAND mode + NN: 1-7 issue squad orders.
  if (eKey >= '1' && eKey <= '7' && game.mode === 'command' && game._nnMode) {
    const orderById = { '1': 'rally', '2': 'spread', '3': 'attack', '4': 'defend',
                        '5': 'protect', '6': 'suppress', '7': 'retreat' };
    const id = orderById[eKey];
    if (id) issueSquadOrder(id);
    return;
  }
  // Otherwise: 1-6 are pawn-swap (NN) or mission-jump (campaign).
  if (eKey >= '1' && eKey <= '6') {
    if (game._nnMode) {
      const allyIdx = parseInt(eKey, 10) - 2;       // '2' → ally[0], etc.
      if (allyIdx >= 0 && allyIdx < allies.length) {
        swapPlayerToAlly(allyIdx);
      } else if (eKey === '1') {
        // '1' is reserved for self in this layout. Surface a hint so
        // the player learns the TAB+1 squad-order path.
        if (typeof showSwapToast === 'function') {
          showSwapToast(T('1 = 自己 · 按 TAB 後 1 → 集合',
                         '1 = SELF · press TAB then 1 to RALLY'));
        }
      } else if (allyIdx >= allies.length) {
        if (typeof showSwapToast === 'function') {
          showSwapToast(T(`沒有 ${eKey} 號隊友`, `No ally in slot ${eKey}`));
        }
      }
    } else {
      // Campaign — 1-6 jumps directly to mission idx.
      const idx = parseInt(eKey, 10);
      if (idx <= MISSIONS.length) {
        game.wave = idx - 1;
        startNextWave();
      }
    }
  }
}

// Single-key in-match bindings. Each row: {action: (e)=>void}.
// Keys not listed fall through to the number-key + dev branches below.
const KEY_BINDINGS = {
  q:   { action: () => toggleDrone() },
  e:   { action: () => launchFPV() },
  h:   { action: () => _recallToSpawn() },
  tab: { action: (e) => { e.preventDefault(); _toggleCommandView(); } },
  r:   { action: () => startReload() },
  g:   { action: () => {
    // Context-sensitive: during S4 with a live Sentinel target, G fires
    // an SED bomb that converts the unit. Otherwise G is a hand grenade.
    // Arena recruitment SED — if there's a live enemy within 220 px,
    // throwing G converts them into an ally (chance-gated in Batch 6).
    // Until that mechanic is wired, G is just a grenade.
    if (typeof _arenaTrySEDConvert === 'function' && _arenaTrySEDConvert()) {
      return;
    }
    throwGrenade();
  } },
  b:   { action: () => toggleBuildMode() },
  x:   { action: () => swapPlayerWeapon() },
  u:   { action: () => upgradeNearestModule() },
  v:   { action: () => _toggleAimAssist() },
  // Phase 6B: recycle the lowest-SEED squad bot into +60 build energy.
  // Closes the wings.io loop: kill → recruit → scrap weakest → build.
  y:   { action: () => {
    if (typeof _arenaTryRecycle === 'function') _arenaTryRecycle();
  } },
};

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (e.key === 'Tab') e.preventDefault();
  // Pause toggle works regardless of pause state — Esc again resumes.
  // The pause overlay has its own EXIT-TO-MENU button.
  if ((e.key === 'Escape' || k === 'p') && game.state === 'playing') {
    togglePause();
    return;
  }
  // While paused, swallow all other hotkeys.
  if (game._paused) return;
  // Phase 9: SPACE while flying FPV = manual detonate. Bypasses impact
  // gating so the player can blow up at the optimal frame (over a cluster
  // / before a building intercept). Eats the key so it doesn't also fire.
  if ((e.key === ' ' || e.code === 'Space')
      && typeof fpv !== 'undefined' && fpv.active
      && game.mode === 'fpv'
      && game.state === 'playing'
      && typeof _detonateFPV === 'function') {
    e.preventDefault();
    _detonateFPV(true);
    return;
  }
  // Build-radial number shortcut MUST run before the FTUE-lock check so that
  // pressing a digit while build mode is active picks a module instead of
  // showing the locked-key toast (user report: '按下 1 也不知道發生什麼事情').
  if (game.state === 'playing' && buildMode.active
      && ((e.key >= '1' && e.key <= '9') || e.key === '0')) {
    _pickBuildModuleByNumber(e.key);
    e.preventDefault();
    return;
  }
  // (arena-mp: FTUE key-lock check stripped — arena never locks keys.)
  // All gameplay key paths require state=playing.
  if (game.state !== 'playing') return;
  // Single-key bindings (Q/E/H/TAB/R/G/B/X/U/V) — table-driven.
  const binding = KEY_BINDINGS[k];
  if (binding) { binding.action(e); return; }
  // Number keys (1-7): squad orders / pawn-swap / mission-jump.
  if (e.key >= '1' && e.key <= '7') {
    _handleNumberKey(e.key);
    return;
  }
  // Dev: skip current mission (treat as success).
  if (k === 'n' && mission && mission.status === 'active') {
    mission.status = 'success';
    onMissionSuccess();
  }
});
