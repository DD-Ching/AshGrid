// ============ BOT NAMES (Phase 138B.1) ============
// .io-style human player handles for AI bots, so a bot-only arena READS as
// a lobby full of real people instead of "RX4F / BRAVO / BOT-1234".
//
// Why this exists (deep-research round 2, 2026-05-30): the cheapest,
// lowest-risk lever for fighting the "no real players / lonely" feeling is
// diverse, human-style naming. NetEase's Marvel Rivals bot-disguise applied
// random nameplates; .io games (slither/agar) fill lobbies with believably
// -named bots. A bot with a perfect military callsign reads as a bot; a bot
// named "noscope420" reads as that one annoying guy in the lobby. The label
// is already on every vehicle (SEED display) — we just make it read human.
//
// SCOPE: purely the displayed name string. No behaviour change, no loop /
// render / MP coupling. Additive: callers fall back to the old random
// callsign if this module failed to load.
//
// Classic-script. Declares globally:
//   pickBotName()        → an .io-style handle (string, ≤10 chars)
//   BotNames.reset()     → reshuffle the bag (optional; call at match start)
//   BotNames.poolSize    → number of distinct names
//
// No external deps. Names are curated ≤10 chars so they don't overflow the
// existing SEED label box, and screened to stay PG (gamer-culture jokes are
// fine; no slurs, no real-person impersonation).
(function() {
  'use strict';

  // Curated for VARIETY so the lobby reads as a diverse crowd: casual first
  // names, leetspeak gamer tags, clan-tagged handles, number suffixes,
  // tryhard names, and a few jokers. ~70 entries → with the typical <20 live
  // bots, the shuffled bag won't surface a visible duplicate within a match.
  const POOL = [
    // casual lowercase
    'mike', 'jenna', 'kev', 'tomtom', 'pixel', 'luna', 'dana', 'rob',
    'aki', 'sora', 'coffee', 'toast', 'noodle', 'waffle', 'pickle', 'goose',
    // leetspeak gamer tags
    'Gh0stff', 'n0scope', 'sn1p3z', 'xReaperx', 'v0idwlkr', 'd4rkwolf',
    'kr1ll', 'zappy', 'm4yhem', 'z3r0', 'neo_88', 'frost_x',
    // jokers
    'nanaTank', 'soupTime', 'notabot', 'lagswitch', 'pingpong', 'afk_andy',
    'ragequit', 'duck_lord',
    // number-suffixed
    'dragon42', 'kira99', 'ace206', 'blue72', 'jolt_7', 'kx99',
    // tryhards
    'noscope420', 'headsh0t', 'ProSn1per', 'clutchGod', 'tryhard',
    'sweatlord', 'ezpz', '360noscp',
    // clan-tagged
    '[YT]blaze', 'TTV_wolf', 'iFragz', 'xX_Kyle', '[KZ]nova', 'mlg_pete',
    // misc one-worders
    'silentK', 'wraith', 'tako', 'mochi', 'gizmo', 'breezy', 'cinder',
    'onyx', 'boltz', 'vex', 'grim', 'ravn', 'hayato', 'suzu',
  ];

  // Shuffled-bag draw: pop names until empty, then refill+reshuffle. Names
  // may repeat across refills (real lobbies churn too) but never collide
  // within a single bag, so simultaneously-visible bots stay distinct.
  let _bag = [];
  function _refill() {
    _bag = POOL.slice();
    for (let i = _bag.length - 1; i > 0; i--) {     // Fisher-Yates
      const j = Math.floor(Math.random() * (i + 1));
      const t = _bag[i]; _bag[i] = _bag[j]; _bag[j] = t;
    }
  }
  _refill();

  function pickBotName() {
    if (_bag.length === 0) _refill();
    return _bag.pop();
  }

  window.pickBotName = pickBotName;
  window.BotNames = {
    reset: _refill,
    get poolSize() { return POOL.length; },
  };
})();
