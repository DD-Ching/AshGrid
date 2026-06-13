// ============ ADAPTIVE DIRECTOR — one-way DDA (Phase 176) ============
// "Make the enemies feel smart by TARGETING YOU." A lightweight director that
// raises enemy QUALITY (which NN brain + weapon they spawn with) as the player
// dominates, and relaxes back toward the normal spawn roll when the player
// struggles. ONE-WAY by design (user choice 2026-06-13 "只往上,越強越聰明,
// 不會變簡單"): it can only UPGRADE a spawn above its baseline roll, never make
// it easier — so at rest (heat 0) every pick is identical to the old behaviour.
//
// No NN retraining: it just biases WHICH of the existing 11-model zoo + which
// weapon a bot spawns with. The "smart" feeling comes from the arena suddenly
// fielding elite/sharpshooter/warrior brains (precise aim, flanking, sniping)
// once you start winning, instead of the same baseline mix.
//
// SOLO only: MP bot difficulty is server-authoritative (server/party/server.js),
// so the director must never touch it — gated on game._nnMode && !_mpState.enabled.
//
// Classic-script. Declares globally:
//   directorPickStyle(defaultStyle)              spawn hooks call this; returns
//                                                a harder style as heat rises,
//                                                else the passed default (incl.
//                                                null = "leave bot's default")
//   directorPickWeapon(chassisId, style, defW)   upgrades the weapon at high heat
//   directorHeat()                               0..1, for HUD/debug/tests
//   directorNoteOutcome(kind)                    manual nudge hook (optional)
//   AdaptiveDirector = { enabled }               runtime toggle
//
// Deps (resolved at call time): game · _mpState · player · WEAPONS · Math.
// Registers an onUnitDeath hook (js/kill.js) at load for the pressure signal —
// so this file MUST load AFTER kill.js.

(function () {
  'use strict';

  // Styles that read as "smart/dangerous" — precise ranged + aggressive flank.
  const HIGH_STYLES   = ['elite', 'sharpshooter', 'warrior'];
  const HEAT_PER_KILL    = 0.12;   // an enemy dies (your side winning) → +heat
  const HEAT_PER_DEATH   = 0.30;   // YOU die → bleed heat back toward baseline
  const HEAT_PER_ALLY    = 0.05;   // a recruited ally dies → small bleed
  const HEAT_DECAY       = 0.0008; // per game-tick passive relax toward baseline

  let _heat = 0;       // 0 = baseline (old behaviour), 1 = max pressure
  let _lastT = 0;      // game.time of last decay application (lazy decay)

  const D = { enabled: true };

  function _clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function _solo() {
    return (typeof game !== 'undefined' && game && game._nnMode)
        && (typeof _mpState === 'undefined' || !_mpState || !_mpState.enabled);
  }

  // Lazy passive decay: applied on every public read, proportional to the
  // game-ticks elapsed since the last call. Avoids needing a per-frame hook —
  // spawns/HUD reads are frequent enough to keep heat current.
  function _decay() {
    const now = (typeof game !== 'undefined' && game && game.time) ? game.time : 0;
    if (_lastT && now > _lastT) _heat = _clamp01(_heat - HEAT_DECAY * (now - _lastT));
    _lastT = now;
  }

  // Pressure from the kill chokepoint (js/kill.js onUnitDeath). In the SOLO
  // arena every team-1 death is the player's side scoring; the player's own
  // death (and, smaller, an ally's) bleeds heat back toward baseline.
  function _noteDeath(unit, opts) {
    if (!unit || !_solo()) return;
    _decay();
    if (unit.team === 1) {
      _heat = _clamp01(_heat + HEAT_PER_KILL);
    } else if (typeof player !== 'undefined' && unit === player) {
      _heat = _clamp01(_heat - HEAT_PER_DEATH);
    } else if (unit.team === 0) {
      _heat = _clamp01(_heat - HEAT_PER_ALLY);
    }
  }
  if (typeof onUnitDeath === 'function') onUnitDeath(_noteDeath);

  // ── public API ──────────────────────────────────────────────────────
  // Upgrade probability scales with heat. At heat 0 this ALWAYS returns the
  // passed default → byte-identical to the pre-176 spawn. One-way: the override
  // is only ever a HIGH_STYLE, never something easier.
  function directorPickStyle(defaultStyle) {
    if (!D.enabled || !_solo()) return defaultStyle;
    _decay();
    if (_heat > 0 && Math.random() < _heat) {
      return HIGH_STYLES[Math.floor(Math.random() * HIGH_STYLES.length)];
    }
    return defaultStyle;
  }

  function directorPickWeapon(chassisId, style, defWeapon) {
    if (!D.enabled || !_solo()) return defWeapon;
    _decay();
    if (style === 'sharpshooter') return 'SNIPER';
    // Only at high heat, and only upward — heavier punch as you dominate.
    if (_heat > 0.6 && Math.random() < _heat) {
      if (chassisId === 'heavy') return 'LMG';
      return (Math.random() < 0.5 ? 'LMG' : 'SNIPER');
    }
    return defWeapon;
  }

  function directorHeat() { _decay(); return _heat; }

  // Optional manual nudge (e.g. future wave-cleared / objective events).
  function directorNoteOutcome(kind) {
    if (!_solo()) return;
    _decay();
    if (kind === 'win')  _heat = _clamp01(_heat + 0.2);
    if (kind === 'lose') _heat = _clamp01(_heat - 0.2);
  }

  window.AdaptiveDirector  = D;
  window.directorPickStyle = directorPickStyle;
  window.directorPickWeapon = directorPickWeapon;
  window.directorHeat      = directorHeat;
  window.directorNoteOutcome = directorNoteOutcome;
})();
