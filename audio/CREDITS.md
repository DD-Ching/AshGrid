# Audio Credits

This folder hosts the sound assets for AshGrid / GREY VECTOR Chapter 1.

## Status: WebAudio synthesis (no external files yet)

Per the FTUE/03 spec the audio categories below are needed. **The current
implementation synthesises every cue in-engine via WebAudio** (low-frequency
sines, filtered noise, granular bursts). No third-party sample files have
been downloaded yet — this is the safest legal default and works offline.

When real CC0 / CC-BY samples ship later, drop them in this folder and
list them under "External samples" below with full attribution.

## Synthesised cues (current implementation)

Each is built from `OscillatorNode` + `BiquadFilterNode` + `AudioBufferSourceNode`
white-noise. No external dependencies. Source: `index.html` — search for
`function _missionAudio_*` near the FTUE block.

| Cue                     | Recipe                                                |
|-------------------------|-------------------------------------------------------|
| Low-freq heartbeat (S1) | sine 60 Hz, 20 ms attack, 450 ms exp decay            |
| Mote bearing breath     | sine 80 Hz + sawtooth 240 Hz, 1.6 s loop              |
| Lumen radio static      | filtered white noise, low-pass 1.2 kHz, 0.7 s burst   |
| Concrete footstep       | filtered noise, band-pass 800 Hz, 60 ms attack         |
| Mech-Hound footstep     | high-pass noise + click click click 12 Hz, fast       |
| Hollow-31 footstep      | noise burst + 40 Hz sine thud, slow 0.8 s             |
| Heavy UGV rumble loop   | sawtooth 35 Hz + noise band-pass 60 Hz, looping       |
| Muzzle flash            | noise burst + sine 1.8 kHz down-sweep                 |
| Explosion               | noise + low-pass envelope sweep                       |
| Wall thud + dust        | noise burst, low-pass 200 Hz, 400 ms decay            |
| SED electromagnetic ping| sine 220 Hz with FM ring-mod 18 Hz, 600 ms decay      |
| Dripping water (ambient)| short sine pluck 950 Hz, every 1.4 s                  |
| Fluorescent buzz        | sawtooth 50 Hz + 100 Hz overtone, looping at 0.06 vol |

## External samples (placeholder — TBD)

When real samples are downloaded, fill in:

| File | Cue used for | Source URL | License | Author |
|------|--------------|------------|---------|--------|
| (none yet) | | | | |

## Recommended sources for future downloads

- [freesound.org](https://freesound.org) (CC0 + CC-BY, attribution required for CC-BY)
- [opengameart.org](https://opengameart.org) (CC0 / CC-BY)
- [kenney.nl/assets](https://kenney.nl/assets) (CC0)
- [pixabay.com/sound-effects](https://pixabay.com/sound-effects) (no attribution)
- [mixkit.co/free-sound-effects](https://mixkit.co/free-sound-effects) (free for use)
- [Sonniss GDC bundle](https://sonniss.com/gameaudiogdc) (free, commercial use)

Filter by license = "CC0" or "Creative Commons 0" first to skip attribution.
For "CC-BY" downloads, copy the author + URL into the table above per
the Creative Commons Attribution requirements.
