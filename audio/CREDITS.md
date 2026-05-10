# Audio Credits — Mission 1

Sound effects in this folder are downloaded from
[Mixkit](https://mixkit.co/free-sound-effects/) under the
[Mixkit License](https://mixkit.co/license/).

## License summary

> All Mixkit Sound Effects can be used **free of charge in commercial
> and non-commercial projects**. You don't need to pay for anything,
> there are no attribution requirements (we appreciate it but you don't
> have to). The only restriction is **you can't redistribute or sell
> the sounds** themselves as a sound effects pack.

Although Mixkit doesn't require attribution, this file lists every
file's source, ID, and direct preview URL so the legal trail is intact
and so future contributors can swap a cue without re-fetching from a
broken catalogue page.

## Files in this folder

| File                       | Cue / use                              | Mixkit ID | Mixkit title                          |
|----------------------------|----------------------------------------|-----------|---------------------------------------|
| `heartbeat-slow.mp3`       | S1 ambient pulse (slow, dread)         | 495       | Slow heartbeat                        |
| `heartbeat-fast.mp3`       | S1 escalation (final beats)            | 559       | Fast Heartbeat                        |
| `bearing-hum.mp3`          | Mote bearing breath / ambient mech     | 2634      | Bass rumble hum                       |
| `static-radio.mp3`         | Lumen voice carrier (static layer)     | 1456      | Static radio noise sound              |
| `broken-voice.mp3`         | Lumen distorted speech bursts          | 309       | Terror radio frequency                |
| `footstep-concrete.mp3`    | V-07 + scripted concrete footsteps     | 535       | Walking on stones loop                |
| `footstep-mech-hound.mp3`  | Mech-Hound (S5 ambush, fast/light)     | 2301      | Robot step                            |
| `footstep-hollow31.mp3`    | Hollow-31 heavy stomp (S5 ambush)      | 1729      | Golem stomp c                         |
| `ugv-rumble.mp3`           | Heavy UGV approach loop (S7 countdown) | 2128      | Space rocket full power turbine       |
| `gunshot.mp3`              | Muzzle flash (LMB fire)                | 1670      | Game gun shot                         |
| `explosion.mp3`            | Boom + debris                          | 1704      | Epic impact afar explosion            |
| `thud-wood.mp3`            | Light thud variant                     | 2199      | Wood hard hit                         |
| `thud-bomb.mp3`            | Heavy wall thud + dust (BUILD = VERDICT) | 1278    | Bomb drop impact                      |
| `sed-electric.mp3`         | SED bomb electromagnetic ping (G key)  | 773       | Electricity static power up           |
| `title-drum.mp3`           | BUILD = VERDICT cinematic accent       | 2566      | Hard horror hit drum                  |

Direct preview URL pattern (Mixkit CDN):
`https://assets.mixkit.co/active_storage/sfx/{ID}/{ID}-preview.mp3`

## Why these cues match the spec

- **§A.5** — None are 2-tone UI beeps. All are organic / cinematic /
  industrial. Lumen voice = `static-radio` + `broken-voice` layered.
- **§3 S1** — `heartbeat-slow` then `heartbeat-fast` for the final
  Seed-cascade beats; matches the spec's "心跳第 3 下(更快)".
- **§3 S5** — `footstep-mech-hound` (light/fast) + `footstep-hollow31`
  (slow/heavy) gives audible direction differentiation when the 4
  enemies converge from blind spots.
- **§3 S7** — `ugv-rumble` loops to communicate "the heavy thing is
  coming" without showing it. `thud-bomb` for wall placement.
  `title-drum` accents the BUILD = VERDICT moment.
- **§5 招降** — `sed-electric` is the chest-emblem-flips-color sound.

## Wiring (in `index.html`)

`_missionGetAudio(name)` lazily constructs a single `Audio` element per
cue. `_missionPlayCue(name, vol)` clones the element on each play so
overlapping plays don't clip. Five named wrappers (`_missionAudio_static`,
`_missionAudio_thud`, `_missionAudio_sed`, `_missionAudio_footstep`,
`_missionAudio_voice` etc.) each try the file first and fall back to a
WebAudio synthesised version if the file doesn't load (404 / CORS / etc.)
— so the prologue still has audio if the static server isn't serving
`/audio/`.

## Adding new cues later

1. Find the cue on a Mixkit category page (e.g.
   `https://mixkit.co/free-sound-effects/horror/`).
2. View page source — search for `active_storage/sfx/` to find the
   numeric ID + direct mp3 URL.
3. `curl -sL https://assets.mixkit.co/active_storage/sfx/{ID}/{ID}-preview.mp3 -o audio/{cue-name}.mp3`
4. Add an entry to `_missionAudioCues` in `index.html`.
5. Append a row here in CREDITS.md.

## Note on synthesis fallbacks

Some `_missionAudio_*` functions still ship the WebAudio synth recipe
as a fallback. If you ever want to drop them entirely, search for
`Synth fallback` in `index.html` and remove the `if (typeof getAC ...)`
blocks. Behaviour-equivalent to keeping them: file plays first, synth
only fires if the file load failed.
