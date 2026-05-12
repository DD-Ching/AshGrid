// ============ DYNAMIC RADIO ============
// Context-aware beats fired during a match: HP threshold, kill streak,
// isolation, beacon destroyed, etc. Each beat has a cooldown so the
// player isn't drowning in chatter when they sit at low HP.
//
// Classic-script. Declares globally:
//   _radioCD (object, cooldown ledger)
//   _radioOnce(key, cdSec, label, text)
//   _resetRadioCooldowns()
//   _r(zh, en)              i18n helper — picks zh/en string by current lang
//   _dirCardinal(dx, dy)    octant compass word for a delta vector
//   _tickDynamicRadio()     per-frame scheduler, called by update()
//
// External deps (resolved at call-time):
//   game · player · allies · enemies · localStorage
//   showRadioToast() · showSwapToast() · getLang()

const _radioCD = {};
function _radioOnce(key, cdSec, label, text) {
  const now = (game && game.time) || 0;
  if (_radioCD[key] && _radioCD[key] > now) return;
  _radioCD[key] = now + cdSec * 60;
  showRadioToast(label, text);
}
function _resetRadioCooldowns() { for (const k of Object.keys(_radioCD)) delete _radioCD[k]; }

// Lookup helpers — all bilingual via active getLang()
function _r(zh, en) { return (typeof getLang === 'function' && getLang() === 'zh') ? zh : en; }

// Cardinal direction word for a delta (relative to player). Returns the
// localised compass term so callouts read "BRAVO down — SOUTH-EAST" etc.
function _dirCardinal(dx, dy) {
  const a = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180, 0=east, 90=south
  // Octants: 0=E, 1=SE, 2=S, 3=SW, 4=W, 5=NW, 6=N, 7=NE
  let oct = Math.round(((a + 360) % 360) / 45) % 8;
  const labelsZh = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
  const labelsEn = ['EAST', 'SE', 'SOUTH', 'SW', 'WEST', 'NW', 'NORTH', 'NE'];
  return _r(labelsZh[oct], labelsEn[oct]);
}

// Tick fired from update(). Looks at player + world state and fires beats
// when conditions cross thresholds. Cooldowns prevent spam.
function _tickDynamicRadio() {
  if (!game || game.state !== 'playing' || game._paused) return;
  if (!game._nnMode || !player) return;
  // FTUE/00 Section 5.4: the in-match Lumen toasts move to the SECOND
  // match. The first NN skirmish (the one fired by startNarrativeFTUE's
  // ENTER) plays clean — no UI radio drowning the prologue's emotional
  // weight. Gate: ag.stats.matchesPlayed must be >= 1 (incremented on
  // match completion, so true only AFTER the first skirmish ends).
  let _matchesDone = 0;
  try {
    const s = JSON.parse(localStorage.getItem('ag.stats') || '{}');
    _matchesDone = (s && s.matchesPlayed) || 0;
  } catch (e) {}
  if (_matchesDone < 1) return;
  // Low-HP threshold — Lumen warns about Seed Integrity drop
  if (player.alive && player.hp / player.maxHp < 0.25) {
    _radioOnce('lowHp', 18, 'Lumen',
      _r('"Seed Integrity 跌破 25%。 回掩體。 Mote 看著你。"',
         '"Seed Integrity below 25%. Get to cover. Mote is watching."'));
  }
  // Isolation: nobody friendly within 200u + 2+ enemies within 240u
  if (player.alive) {
    let nearAllies = 0;
    for (const a of allies) {
      if (a.alive && Math.hypot(a.x - player.x, a.y - player.y) < 200) nearAllies++;
    }
    if (nearAllies === 0 && allies.length > 0) {
      let closeEnemies = 0;
      for (const e of enemies) {
        if (e.alive && Math.hypot(e.x - player.x, e.y - player.y) < 240) closeEnemies++;
      }
      if (closeEnemies >= 2) {
        // Mute-9 (Black Signal) — sentence cuts mid-line, signature style
        _radioOnce('isolated', 22, 'Mute-9',
          _r('"[訊號被切] 你的通道斷了 — 撤"',
             '"[CHANNEL CUT] Your link is severed — fall back"'));
      }
    }
  }
  // Hot streak — Lumen warns the audit signature is being tracked.
  // SILENT: killstreak-triggered → routes through showSwapToast not
  // showRadioToast so it doesn't play the 2-tone ding-dong on every
  // 5-streak. User: '永遠別讓擊殺音效出現'.
  if ((player._killStreak || 0) >= 5) {
    if (!_radioCD['hot'] || _radioCD['hot'] <= game.time) {
      _radioCD['hot'] = game.time + 30 * 60;
      if (typeof showSwapToast === 'function') {
        showSwapToast(_r('▸ Lumen · 你的審計簽名被追蹤了',
                         '▸ Lumen · Your audit signature is being tracked'));
      }
    }
  }
  // GREY VECTOR — Build = Audit. Pure killing without construction drains
  // Seed Integrity and Lumen will say so. SILENT: kill-count-triggered,
  // routed through showSwapToast.
  const _structCount = (game._structures && game._structures.length) || 0;
  const _killCount = (game.killCount || 0);
  if (_killCount >= 5 && _structCount === 0) {
    if (!_radioCD['noBuild'] || _radioCD['noBuild'] <= game.time) {
      _radioCD['noBuild'] = game.time + 25 * 60;
      if (typeof showSwapToast === 'function') {
        showSwapToast(_r('▸ Lumen · 你在殺戮,不是審計。 按 B 開建造',
                         '▸ Lumen · You are killing, not auditing. Press B'));
      }
    }
  }
  if (_structCount >= 1) {
    _radioOnce('firstBuild', 9999, 'Lumen',
      _r('"審計基礎設施上線。 建築才能審計。"',
         '"Audit infrastructure online. Architecture audits where bullets cannot."'));
  }
  if (game.time > 60 * 60 && _structCount === 0 && _killCount < 3) {
    _radioOnce('promptBuild', 40, 'Lumen',
      _r('"你還沒設置任何審計站。 你打算用什麼證明你不是純殺手?"',
         '"You haven\'t placed any audit stations yet. How will you prove you are not just a killer?"'));
  }
  // Hostile recon warning — 4 cardinal sectors. When ≥2 enemies appear in
  // a sector for the first time this match, fire a one-shot directional
  // alert. ag time-based, fires once per sector per match.
  if (player.alive && enemies.length > 0) {
    const sectors = { N: 0, S: 0, E: 0, W: 0 };
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.x - player.x, dy = e.y - player.y;
      if (Math.abs(dx) > Math.abs(dy)) sectors[dx > 0 ? 'E' : 'W']++;
      else                              sectors[dy > 0 ? 'S' : 'N']++;
    }
    const _dirCh = { N:'北', S:'南', E:'东', W:'西' };
    const _dirEn = { N:'NORTH', S:'SOUTH', E:'EAST', W:'WEST' };
    for (const k of Object.keys(sectors)) {
      if (sectors[k] >= 2) {
        // Mote signal — short, factual, like decoded sensor blips
        _radioOnce('recon_' + k, 25, 'Mote',
          _r(`MOVEMENT DETECTED — ${_dirCh[k]} 側 (×${sectors[k]})`,
             `MOVEMENT DETECTED — ${_dirEn[k]} (×${sectors[k]})`));
      }
    }
  }
}
