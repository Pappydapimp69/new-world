# sound-engine

A general-purpose **procedural** sound engine for browser games. Every sound is synthesized in code at runtime: no recordings, no dependencies. It runs on Web Audio with AudioWorklet DSP, and all the DSP is plain JavaScript that is unit-tested in Node.

Each design rule comes from a sandbox-verified lesson in the Brain knowledge base (`dlist/E8`–`E27`, `sound-engine/E1`–`E6`). Those lesson IDs are cited in the code comments.

## What it does

| Feature | How | Lesson |
|---|---|---|
| Creature voices (open mouth) | Glottal pulses → formant bank set by vocal-tract length, `F_n = (2n-1)c/4L`; f0 capped at `0.3·F1` so the size cue survives | E8 |
| Creature voices (closed mouth) | No formants; one throat-sac resonance (Q≈10) with f0 locked to it; scaled from the dove's 600 Hz at 35 mm | E16 |
| Footsteps | Hertz contact pulse (`tc ∝ M^0.33 v^-0.2`) for weight; the surface's own response for identity: modes (stone, wood) rung by claws, debris grains (dirt, sand), suction (mud), bubbles (water) | E17 |
| Water, rain, mud | Minnaert bubbles (`f = 3/r`) summed into a 16-resonator radius-binned bank: exact at any rate, constant cost; a few free voices for rising-pitch drips | E15 |
| Reverb | 8-line Householder FDN, per-line Jot absorption → separate low/high T60 per zone; deterministic | E24, E19 |
| Occlusion | Maekawa barrier as a −3 dB/oct shelf chain with corner `25.7/δ` Hz, within ~0.6 dB | E21 |
| Doppler | Distance delay through a fractional delay line, 4- or 6-point Lagrange (linear interpolation spurs at −29 dB on bright sounds) | E23 |
| No zipper noise | Every per-frame target is ramped per sample across one frame | E25 |
| Pan law | Chosen by playback device: equal-power (headphones), linear (phone folding to mono), −4.5 dB (unknown) | E26 |
| Voice budget | 24 voices by default; steals the voice quietest at the listener (plus a priority boost), never the oldest | E27 |
| Distance cue | Reverb send tapped **before** the distance gain (falls ~1 dB/doubling), so direct-to-reverb ratio falls ~5 dB per doubling; each zone's send is sized from a critical distance, measured on total stereo power | SE E5, E6 |
| Air absorption | ISO 9613-1, as cascaded 25 m one-pole sections (within 0.9 dB to 200 m) plus a fitted 2nd-order beyond; temperature and humidity settable | SE E1 |
| Headphones | Woodworth interaural time difference on the far ear through a fractional delay (integer samples crackle on moving sources) | SE E2 |
| Zone changes | Same-size zones glide the absorption coefficients (no hole in the tail); size changes run two networks and equal-power crossfade | SE E3 |
| Master headroom | Master gain = level / sqrt(power-weighted active sources), ramped, into a light −6 dBFS limiter | SE E4 |
| Dynamic calls | `intensity` shortens the glottal closing phase (harder = brighter, rougher), `mouth` glides the formants as the jaw opens, `vibrato` adds a periodic wobble; overlapping calls keep separate phases | |
| FM synthesis (Mega Drive style) | 4 operators, the YM2612's 8 algorithms, op-1 feedback averaged over two samples, per-operator envelopes, ratios, detune, key scaling, LFO vibrato/tremolo, pitch sweeps and arpeggios. Velocity drives modulator depth, so harder notes are brighter. A cascade-aware Carson's-rule cap keeps high notes from aliasing | |
| Chip sound (PSG) | SN76489-style: 3 PolyBLEP squares (20–34× less off-grid energy than naive squares) + noise from the chip's own 16-bit LFSR, tap 0x0009 (period 57337), 2 dB attenuator steps, software envelopes at 60 Hz | |
| Adaptive music | Sample-accurate step sequencer on FM and PSG; tracks layer in and out by game intensity on a bar, beat or step grid (`switchOn`), with short fades, and intensity scales every velocity so the same song is darker when calm and brighter when tense; swing; seeded `?` steps | |
| Performance | Idle sources and the idle reverb sleep (no DSP) until triggered; no per-sample allocation; fixed-shape objects in hot loops; flushed subnormals | |

## Quick start

```js
import { SoundEngine, DEMO_SONG } from './src/index.js';

const engine = await SoundEngine.create({ zone: 'coniferForest', device: 'headphones' });
await engine.resume();                       // after a user gesture

const dino  = engine.createSource('voice', { creature: 'herrerasaurus', priority: 20 });
const feet  = engine.createSource('footsteps');
const river = engine.createSource('water', { preset: 'stream', position: { x: -10, y: -18 } });

// every game frame:
engine.setListener({ x: player.x, y: player.y, yaw: player.heading });
dino.setPosition(d.x, d.y).setOcclusion(ridgeDelta);   // metres of path difference, 0 = clear
feet.setPosition(d.x, d.y);
engine.update();

// events:
dino.call({ mode: 'open', duration: 1.2 });            // roar
dino.call({ mode: 'closed', duration: 1.8 });          // low closed-mouth boom
feet.step({ mass: 200, speed: 5, surface: 'sandstone', claws: true });
river.setWater('rain');

// FM / chip effects and adaptive music
const fx = engine.createSource('synth', { position: { x: 4, y: 2 } });
fx.sfx('laser');                                        // laser jump coin hit explosion roar blip powerup crunch
fx.note({ midi: 64, velocity: 0.9, duration: 0.3, patch: 'epiano' });
const music = engine.createMusic(DEMO_SONG, { intensity: 0.2 }).play();
music.setIntensity(0.9);                                // danger: lead and hats enter on the next bar
engine.setZone('rockyGully');
engine.setDevice('mono');                               // phone speaker
```

The worklet module loads from `src/worklet/processors.js` by default. If you bundle the engine, pass `workletUrl` to `SoundEngine.create`.

### Sources

- `voice`: `call({ mode, duration, f0, f0End, amp, intensity, roughness, breath, jitter, vibrato, vibratoRate, mouth, attack })`, `setCreature(name)`. Creatures: `small`, `eodromaeus`, `medium`, `herrerasaurus`, `large`. You can also pass `tract` and `sac` sizes in metres.
- `footsteps`: `step({ mass, speed, surface, claws, gain })`. Surfaces: `packedDirt`, `sand`, `sandstone`, `wood`, `mud`, `water`.
- `water`: presets `drip`, `stream`, `rain`, `splash`, or a custom `{ rate, gamma, minRadius, maxRadius, rising }`; `splash(n, energy)`.
- `modal`: `{ modes: [{ freq, gain, t60? }], lossFactor }`, then `strike(amp, brightness)`. Use it for rocks, logs, bones and props.
- `synth`: `sfx(name, { velocity, midi })`, `note({ midi | freq, velocity, duration, patch })`, `chip({ channel 0-2 | 3 noise, freq, velocity, duration, decay, white, sweep })`. FM patches: `epiano`, `brass`, `bass`, `lead`, `bell`, `organ`, `kick`, `tom`, `laser`, `jump`, `coin`, `hit`, `explosion`, `roar` (or your own `{ alg, fb, ops: [{ ratio, detune, level, attack, decay, sustain, release, vel, keyScale, am }] }`).

### Music

`engine.createMusic(song, { intensity, volume })` returns a non-spatial music bus with `play()`, `stop()`, `setIntensity(0..1)`, `setTempo(bpm)`, `setSong(song)`, `setVolume(v)`. A song is `{ bpm, stepsPerBeat, beatsPerBar, swing, seed, switchOn: 'bar' | 'beat' | 'step', tracks }`; each track is `{ instrument: 'fm' | 'psg' | 'noise', patch, channel, steps, octave, gain, pan, gate, velocity, minIntensity, maxIntensity }`. Step strings use note names (`C4`, `F#2`, `Bb3`), `.` rest, `-` hold, `x`/`o` drum hits, a trailing `!` accent and a leading `?` for a seeded 50% chance. See `DEMO_SONG` in `src/dsp/sequencer.js`.

## Performance

`node bench/bench.js` measures ns per output sample (best of 5 runs). On a 24-source scene with 4 creatures calling, 20 idle and one reverb bus, the engine went from about 4,350 ns per sample (21% of one core at 48 kHz) to 750-980 ns (3.6-4.7%), 4-6× less. Most of that comes from idle sources and the reverb sleeping. The rest:
- the voice now uses one fixed-shape object per call, which made it 2.1× faster than before;
- there are no per-sample allocations;
- delay-line reads use no closures;
- the reverb coefficients are flat arrays.

The demo song (7 FM/PSG tracks) costs about 3.4% of a core.

### Zones and atmosphere

`openPlain`, `coniferForest`, `fernSwamp`, `rockyGully`, `cave`, `room`. Each sets low/high T60, network size and a critical distance: the distance at which reverb equals the direct sound (forest 20 m, cave 3 m). The engine derives the reverb send from that. The values are game estimates; tune them by ear.

`engine.setAtmosphere({ tempC, humidity })` changes air absorption. `device: 'headphones'` (the default) adds the interaural time cue; `'mono'`, `'stereo'` and `'unknown'` use the pan law only.

### Using the DSP without Web Audio

```js
import { CreatureVoice, FootstepSynth, WaterSource, FDNReverb } from './src/dsp/index.js';
const v = new CreatureVoice(48000, { tract: 0.7, sac: 0.35 });
v.call({ mode: 'open' });
const sample = v.process();   // one sample at a time
```

## Demo

```sh
python3 -m http.server 8080      # from the repo root
# open http://localhost:8080/demo/
```

Drag on the map to move yourself while the dinosaur walks a loop around you. You can change the ground, water, zone, ridge occlusion and playback device. `demo/scene.wav` is a 12 s offline render: a walk-by on sandstone then dirt, a roar, a stream on the left, and a closed-mouth boom behind a ridge. `node demo/render-genesis.js out.wav` renders 22 s of the adaptive music climbing from calm to tense, with FM and chip effects circling the listener and two dinosaur calls at different effort.

## Tests

```sh
npm test                                                    # 47 DSP, synth, music and allocator tests (Node >= 20)
NODE_PATH=/path/to/playwright node scripts/browser-smoke.mjs   # AudioWorklet graph in headless Chromium
NODE_PATH=/path/to/playwright node scripts/render-demo.mjs     # re-render demo/scene.wav
```

The tests check the lesson numbers directly:
- The bubble bank equals the per-bubble sum to 1e-9.
- The closed-mouth call puts more than 85% of its power in the fundamental.
- Lagrange interpolation beats linear by more than 10 dB on a moving 8 kHz read.
- The occlusion chain stays within 0.7 dB of Maekawa.
- The FDN's low-band T60 is within 12%.
- The pan laws give exact centre levels.
- The allocator steals the quietest voice.
- Every FM algorithm sounds exactly its carriers.
- Harder FM notes are brighter, not just louder.
- The alias cap keeps a deep C7 on its harmonic grid.
- The PSG noise has period 57337, and PolyBLEP squares stay on the harmonic grid.
- Sequencer beats are sample-accurate under swing.
- Music layers change only on bar lines.
- A sleeping source matches an awake one within -100 dB, and the reverb wakes exactly like a fresh network.
- Overlapping calls sum linearly.

## Layout

```
src/dsp/        pure DSP, sample-by-sample, no browser APIs (kernel.js = what each worklet runs)
src/engine/     main-thread engine (graph, sources, voice allocation)
src/worklet/    AudioWorklet processors that host the DSP
demo/           interactive page + rendered scene.wav
test/           node:test suites + headless browser pages
scripts/        browser smoke test and offline renderer
bench/          CPU benchmark (ns per sample)
```

## Limits and next steps

- Occlusion takes a path difference you compute yourself (`ridgeDelta` helps for a single ridge); there is no terrain ray-casting built in.
- The forest excess-attenuation term (scattering by trunks) is not modelled; air absorption is.
- Headphone cues are timing only: no head-shadow level difference, pinna or elevation cues (no HRTF).
- One mono generator per source.
