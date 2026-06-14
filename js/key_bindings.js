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
//   game · player · WORLD · currentMap · buildMode · activeBuildKinds
//   MISSIONS · mission · AG
//   showSwapToast · showMessage · playRadioBeep · T
//   toggleDrone · launchFPV · startReload · throwGrenade · toggleBuildMode
//   upgradeNearestModule · togglePause
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
  // R12 — grant 60-tick (1 s) invuln via PlayerLifecycle so future
  // refactors of the invuln gate don't miss this path. Short shield
  // (vs the standard 180) is intentional — recall is a quick teleport,
  // not a death/respawn, so we just need a frame or two of "you didn't
  // get hit while teleporting" cover.
  if (typeof PlayerLifecycle !== 'undefined') {
    PlayerLifecycle.extendInvuln(60);
  } else {
    player._invulnUntil = game.time + 60;
  }
  if (typeof showSwapToast === 'function') {
    showSwapToast(T('▶ 回到出生點', '▶ RECALL TO SPAWN'));
  }
  if (typeof playRadioBeep === 'function') playRadioBeep(990, 0.10);
}

function _toggleCommandView() {
  // Phase 14: command overlay is orthogonal to view mode. `game._cmdOpen`
  // is the canonical flag for "command UI + 1-7 bindings active"; renders
  // and number-key handlers check it. From tactical we still flip
  // game.mode to 'command' so the existing zoom-out camera kicks in.
  // From drone / FPV view game.mode stays put and the overlay layers on
  // top, so the player can still pilot while issuing squad orders (user
  // asked: '按 Q 的時候也一樣會有領導大獎的功能'). Toggle is driven
  // purely by _cmdOpen so the state machine doesn't desync when the
  // player exits drone via Q while command was open.
  game._cmdOpen = !game._cmdOpen;
  if (game.mode === 'tactical' || game.mode === 'command') {
    game.mode = game._cmdOpen ? 'command' : 'tactical';
  }
  const inCmd = !!game._cmdOpen;
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
  // 0-9 → module index 9, 0..8 (so '0' acts as a tenth slot). Phase 140 —
  // reads the mode-aware wheel (activeBuildKinds, defense-only in MP) so a
  // hotkey can never select a module that isn't on the current wheel.
  const idx = eKey === '0' ? 9 : (parseInt(eKey, 10) - 1);
  const kinds = (typeof activeBuildKinds === 'function') ? activeBuildKinds() : [];
  if (kinds[idx]) buildMode.kind = kinds[idx];
  buildMode.radialOpen = false;
  buildMode._dragStart = null;
  buildMode._dragEnd   = null;
}

function _handleNumberKey(eKey) {
  // COMMAND overlay open + NN: 1-7 issue squad orders. Works whether the
  // player is in tactical view (game.mode='command') or piloting the UAV /
  // FPV with command layered on top (_cmdOpen=true, game.mode='drone'|'fpv').
  if (eKey >= '1' && eKey <= '7' && game._cmdOpen && game._nnMode) {
    const orderById = { '1': 'rally', '2': 'spread', '3': 'attack', '4': 'defend',
                        '5': 'protect', '6': 'suppress', '7': 'retreat' };
    const id = orderById[eKey];
    if (id) issueSquadOrder(id);
    return;
  }
  // Otherwise: 1-6 are pawn-swap (NN) or mission-jump (campaign).
  if (eKey >= '1' && eKey <= '6') {
    if (game._nnMode) {
      if (eKey === '1') {
        // '1' is reserved for self in this layout. Surface a hint so
        // the player learns the TAB+1 squad-order path.
        if (typeof showSwapToast === 'function') {
          showSwapToast(T('1 = 自己 · 按 TAB 後 1 → 集合',
                         '1 = SELF · press TAB then 1 to RALLY'));
        }
      } else {
        // Phase 183 — map the digit to the COMPACTED, alive-filtered squad slot
        // (getSquadSlots), the same roster the HUD dots show, so digit '2' swaps
        // into the unit visibly under dot '2' (the old raw allies[eKey-2] index
        // pointed at a different/dead ally once the roster compacted).
        const slotN = parseInt(eKey, 10) - 2;        // '2' → squad slot 0
        const slots = (typeof getSquadSlots === 'function') ? getSquadSlots() : [];
        const s = slots[slotN];
        if (s && s.allyIdx != null) {
          swapPlayerToAlly(s.allyIdx);
        } else if (typeof showSwapToast === 'function') {
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
  // Phase 184d — R cycles the Heavy chassis's stockpiled weapons (when classes
  // on + heavy + >1 weapon); heavyCycleWeapon self-gates + returns false
  // otherwise → normal reload. Other chassis / classes-off reload as before.
  r:   { action: () => {
    if (typeof heavyCycleWeapon === 'function' && heavyCycleWeapon()) return;
    startReload();
  } },
  g:   { action: () => {
    // Context-sensitive priority order:
    //   (1) Arena recruit SED on a downed enemy nearby (Phase 18+)
    //   (2) Phase 63: defuse the nearest hostile mine
    //   (3) Fallback: throw a hand grenade
    // Phase 104 — F is now the PRIMARY frag throw key (resolves the
    // G grenade vs G recruit ambiguity in the HUD label). G keeps the
    // fallback throwGrenade() for backward compatibility / muscle memory.
    // Phase 159 — MP first: online targets live in remoteBots, not
    // enemies[], so the SOLO scan below finds nothing in MP. Route the
    // press to the server-authoritative recruit path when online.
    // Phase 184c — Wolf/Dog G = DEVOUR (execute+lifesteal), tried first; self-
    // gates to wolf + game._classes so other chassis / classes-off fall through
    // to the recruit + grenade chain unchanged.
    if (typeof _arenaTryDevour === 'function' && _arenaTryDevour()) {
      return;
    }
    // Phase 184i — MP wolf DEVOUR (server-authoritative); tried before MP recruit
    // since a wolf devours rather than recruits. Self-gates to wolf + classes +
    // online, so it no-ops otherwise and the chain falls through unchanged.
    if (typeof _arenaTryDevourMP === 'function' && _arenaTryDevourMP()) {
      return;
    }
    if (typeof _arenaTryRecruitMP === 'function' && _arenaTryRecruitMP()) {
      return;
    }
    if (typeof _arenaTrySEDConvert === 'function' && _arenaTrySEDConvert()) {
      return;
    }
    if (typeof _tryDefuseMine === 'function' && _tryDefuseMine()) {
      return;
    }
    throwGrenade();
  } },
  // Phase 104 — primary frag key (matches new action-bar label 'F FRAG').
  f:   { action: () => throwGrenade() },
  b:   { action: () => toggleBuildMode() },
  // Phase 140 — manual weapon swap removed. One pawn = one weapon; you change
  // weapon by walking onto a killed enemy's dropped gun (see weapon_drop.js).
  // Phase 184d — X is the Heavy chassis ULTIMATE (fire ALL stockpiled weapons at
  // once, costs energy). heavyUltimate self-gates (heavy + game._classes); no-op
  // for other chassis / classes-off, so X stays effectively unbound there.
  x:   { action: () => { if (typeof heavyUltimate === 'function') heavyUltimate(); } },
  u:   { action: () => upgradeNearestModule() },
  v:   { action: () => _toggleAimAssist() },
  // Phase 6B: recycle the lowest-SEED squad bot into +60 build energy.
  // Closes the wings.io loop: kill → recruit → scrap weakest → build.
  y:   { action: () => {
    if (typeof _arenaTryRecycle === 'function') _arenaTryRecycle();
  } },
  // Phase 24: T cycles through the emote list (GG → LOL → GO! → ! → ?),
  // bubble pops over your head + broadcasts to peers in the room. SP mode
  // still shows the bubble locally for visual feedback.
  t:   { action: () => {
    if (typeof _mpTriggerEmote === 'function') _mpTriggerEmote();
  } },
  // Phase 24: Z drops a ping at the mouse cursor's world position. All
  // peers see a pulsing red marker + hear a tone — call out a target /
  // route without typing.
  z:   { action: () => {
    if (typeof _mpTriggerPing !== 'function') return;
    if (typeof screenToWorld !== 'function' || typeof mouse === 'undefined') return;
    const wp = screenToWorld(mouse.x, mouse.y);
    _mpTriggerPing(wp.x, wp.y);
  } },
};

window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys[k] = true;
  if (e.key === 'Tab') e.preventDefault();
  // Phase 39: F3 toggles MP debug overlay (Minecraft/Krunker convention).
  // Works regardless of pause/state so users can flip it on while triaging.
  // Eats the key — F3 in Chrome opens "Find Next" otherwise.
  if (e.key === 'F3') {
    e.preventDefault();
    if (typeof game !== 'undefined') game._mpDebug = !game._mpDebug;
    return;
  }
  // Pause toggle works regardless of pause state — Esc again resumes.
  // The pause overlay has its own EXIT-TO-MENU button. Phase 34: in MP
  // we swallow Esc/P entirely so it doesn't even register as a no-op
  // (togglePause itself bails on MP, but eating the key here keeps the
  // event from leaking to other handlers).
  if ((e.key === 'Escape' || k === 'p') && game.state === 'playing') {
    // Phase 35→Phase 129b (CG build): MP can't meaningfully pause
    // (server keeps ticking, opponents keep moving). Previously we
    // silently swallowed ESC in MP per user feedback "我選了 MULTI
    // 為什麼 Esc 還會暫停?". But silent-swallow fails the CG reviewer
    // expectation that ESC always does SOMETHING — they treat a dead
    // ESC key as a UX bug.
    //
    // New behaviour: in MP, ESC routes to exitMatchToMenu() (leave the
    // match cleanly). In SP, ESC still toggles pause as before.
    try {
      if (new URLSearchParams(location.search).get('mp') === '1') {
        if (typeof exitMatchToMenu === 'function') exitMatchToMenu();
        return;
      }
    } catch (e) {}
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
  // Phase 179 — SPACE redeploys from the death killcam (SOLO). Self-gates on
  // killcamCanRespawn() (dead + replay seen), so it's a no-op during live play
  // and an ad in flight is already swallowed by the game._paused gate above.
  if ((e.key === ' ' || e.code === 'Space')
      && typeof killcamCanRespawn === 'function' && killcamCanRespawn()) {
    e.preventDefault();
    killcamRequestRespawn();
    return;
  }
  // Phase 183 — SOLO no-killcam fallback: respawn is now SPACE-gated (the
  // nn_deathmatch timers only fire on _respawnRequested), so a death where the
  // killcam never armed (e.g. no _killer) would otherwise soft-lock. If we're
  // dead in a SOLO NN match with a pending respawn, SPACE still requests it.
  if ((e.key === ' ' || e.code === 'Space')
      && typeof requestSoloRespawn === 'function'
      && typeof player !== 'undefined' && player && !player.alive
      && typeof game !== 'undefined' && game._nnMode
      && (typeof _mpState === 'undefined' || !_mpState || !_mpState.enabled)
      && (player._respawnAt != null
          || (game._teamWipe && game._teamWipe.blue && game._teamWipe.blue.wipedSince))) {
    e.preventDefault();
    requestSoloRespawn();
    return;
  }
  // Phase 180 — MP: SPACE on the death screen asks the authority to bring you
  // back (server respawns → client waits for the snapshot, never self-revives).
  // Mutually exclusive with the SOLO killcam path above (solo vs mp).
  if ((e.key === ' ' || e.code === 'Space')
      && typeof mpRespawnEligible === 'function' && mpRespawnEligible()
      && typeof _mpRequestRespawn === 'function') {
    e.preventDefault();
    _mpRequestRespawn();
    return;
  }
  // Build-radial number shortcut: digits pick a module ONLY when the
  // radial picker UI is actually visible. Earlier this gated on the
  // bare `buildMode.active` flag, which meant ANY time the player had
  // build mode toggled on (the green placement cursor) digits 1-9 / 0
  // got eaten by the picker — pawn-swap on 2-5 silently died. User:
  // '按B的時候我就沒有辦法透過按1234來切換人, 或者是死掉的時候我會
  // 真的會掛掉, 而不是切換載具'. Radial closed → fall through to the
  // regular pawn-swap / squad-order path below.
  if (game.state === 'playing' && buildMode.active && buildMode.radialOpen
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
