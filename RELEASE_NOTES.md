# AshGrid — Release Notes

## v228 — MP death = leave the room → heaven → return (2026-06-14)

Phase 181. Fixes the multiplayer death flow reported as 大失敗: the watch-ad
revive rubber-banded you to death, the green ad button vanished after one use,
and ghost bots bled through the replay. The model is now exactly "death = leave
the room → a clean 'heaven' world (replay + countdown + ad) → the authority
brings you back into the room".

### Player-facing
- **看廣告復活不再被拉回去秒死 / Watch-ad revive no longer rubber-bands.** In MP
  the ad-revive used to flip you alive *locally* while the server still had you
  dead — reconcile dragged you back to your corpse ('前後左右移動會被拉回去')
  and the safety-net re-killed you ('馬上死掉'). Now MP is fully
  server-authoritative: watching the ad applies the fast-respawn buff and *asks*
  the server; it brings you back at your spawn with a 3 s shield. The client
  never revives ahead of the server.
- **綠色看廣告按鈕每次死亡都會出現 / Green watch-ad button re-arms every death.**
  It used to latch "used" after a single watch and disappear for the rest of a
  long MP match ('我現在沒有辦法增加看廣告綠色按鈕'). It now re-offers on each
  death (still hidden only while the 30-min buff is already running).
- **死亡 = 離開房間,進入天堂 / Clean 'heaven' death screen.** When you die in MP
  the live arena is covered by a calm opaque field, so you no longer spectate
  'ghost' bots wandering past your corpse ('看起來像殘影一樣,幽靈的東西'). The
  killcam replay is now fully opaque too (the old 16 % see-through let live units
  double up as afterimages over the replay).

### Under the hood
- `death_recap.js` `_adRevivePlayer` branches on `_mpIsActive()`: MP →
  `applyRespawnBuff()` + `_mpRequestRespawn()` (no local revive); SOLO unchanged.
  `triggerDeathRecap()` resets the `adReviveUsed` in-flight latch per death.
  MP-only opaque 'heaven' backdrop in `renderDeathRecap`.
- `killcam.js` replay backdrop 0.84 → 0.99 alpha (no live-world bleed-through).
- New `tools/test_mp_ad_revive.js` regression guard (CI now **8 checks**): proves
  MP ad-revive never revives locally, SOLO still does, and the button re-arms.
- No server change — the Phase 180 `requestRespawn` authority already shipped.

## v227 — Death Killcam & Server-Authoritative Respawn (2026-06-14)

Phases 179–180. No more 死不瞑目 (dying without seeing how) — you now get a
replay of your final moments and a clean, honest respawn. Live on ashgrid.io
+ the PartyKit server.

### Player-facing
- **死亡回放 / Death killcam.** When you're knocked out (SOLO) or eliminated
  (MP), a short top-down replay of your last ~2.6 s plays, with the killer
  ringed and a **"被 X 擊殺 · WEAPON / KILLED BY X"** banner — so you always
  see *who got you and how*.
- **按空白鍵復活 / Press SPACE to redeploy.** Respawn on your own cue instead of
  only waiting out a timer. If you don't press, it still brings you back
  automatically (no soft-lock).
- **誠實的復活倒數 / Honest respawn countdown.** The countdown now ticks in real
  seconds (it used to drain faster than the number shown).
- **廣告時機修正 / Ad timing fixed.** The respawn ad billboard no longer covers
  the killcam — it appears **after** the replay (death → killcam → ad), and the
  invisible "watch ad" button can no longer be tapped by accident during the
  replay.
- **MP「返回房間」復活 / MP "return to the room" respawn.** In multiplayer the
  server is the authority: you press SPACE → the request goes to the server →
  the server brings you back into the room. The client never revives ahead of
  the server, so no rubber-band / die-respawn loops. Squad team-wipe revives now
  drop you at your **base spawn**, not on the spot you died.

### Under the hood
- New `js/replay_buffer.js` (lightweight ~21 Hz ring buffer; samples enemies in
  SOLO, `remotePlayers`/`remoteBots` in MP) and `js/killcam.js` (self-contained
  over-HUD replay layer; never edits the respawn state machine).
- Server: `requestRespawn` message + a shared, unit-tested `_respawnDecision`
  rule; `killedAtTick` so an ad watched *after* death shortens the current MP
  respawn. **Backward-compatible** — the rule is behaviour-identical to the old
  AFK-gate for existing clients.
- CI gate grew to **7 checks** (added `tools/test_killcam.js`,
  `tools/test_mp_respawn.js`). All green on `main`.
- Self-reviewed (xhigh recall): 14 findings, all fixed before ship.

### Notes
- The end-to-end 2-client gameplay test (A kills B → B presses SPACE → B
  returns) was not run pre-ship; shipped on automated validation (server
  builds/boots under PartyKit, accepts `requestRespawn`, unit tests, SOLO+MP
  render checks). Worst-case fallback is the 12 s auto-return.
- Rollback: client = revert the merge on `main` + push (Pages redeploys);
  server = `cd server && npx partykit deploy` from an earlier commit.
