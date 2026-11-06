import { FMSynth, midiToFreq } from './fm.js';
import { PSG } from './psg.js';
import { Noise } from './noise.js';
import { panGains } from './panlaw.js';

/**
 * Adaptive music: a sample-accurate step sequencer driving FM and PSG
 * instruments, with tracks layered by game intensity.
 *
 * Song format:
 *   { bpm, stepsPerBeat = 4, beatsPerBar = 4, swing = 0, seed,
 *     tracks: [{ name, instrument: 'fm' | 'psg' | 'noise', patch, channel,
 *                steps: 'C3 . E3 - G3! . x o ?C4 ...', octave = 0,
 *                gain = 0.8, pan = 0, gate = 0.8, minIntensity = 0, maxIntensity = 1,
 *                velocity = 0.8 }] }
 * Step tokens: a note (C4, F#2, Bb3), '.' rest, '-' hold the previous note,
 * 'x' / 'o' drum hit loud / soft (noise or percussion patch at the track's
 * `note`), a trailing '!' accents (+0.2 velocity), a leading '?' plays with
 * 50% chance from a seeded RNG (same seed, same performance).
 *
 * Dynamics: intensity 0..1 scales every velocity (0.55 + 0.45 x intensity),
 * and FM velocity drives modulator depth, so the same song plays darker when
 * calm and brighter when tense. Tracks enter and leave on a grid set by
 * `switchOn` ('bar' default, 'beat' or 'step'), fading over one grid unit
 * (at most a beat). Bar lines never cut a phrase but lag a fast-changing game
 * state by up to a bar; 'beat' or 'step' follow it sooner. Which suits a
 * given game is an open question (Brain tension on bar-quantized switching
 * vs stem fading), so the song chooses.
 */
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C4' -> 60, 'F#2' -> 42, 'Bb3' -> 58; null if not a note. */
export function parseNote(tok) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(tok);
  if (!m) return null;
  return 12 * (+m[3] + 1) + NOTE[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

/** Parse a step string into events: { midi | hit, velocity, accent, chance, hold }. */
export function parseSteps(steps) {
  const toks = (Array.isArray(steps) ? steps : steps.trim().split(/\s+/));
  const ev = toks.map((raw) => {
    let t = raw, chance = 1, accent = 0;
    if (t.startsWith('?')) { chance = 0.5; t = t.slice(1); }
    if (t.endsWith('!')) { accent = 0.2; t = t.slice(0, -1); }
    if (t === '.' || t === '') return { rest: true };
    if (t === '-') return { tie: true };
    if (t === 'x') return { hit: 1, accent, chance, hold: 1 };
    if (t === 'o') return { hit: 0.55, accent, chance, hold: 1 };
    const midi = parseNote(t);
    if (midi === null) throw new Error(`bad step token ${raw}`);
    return { midi, accent, chance, hold: 1 };
  });
  // fold ties into the preceding note's length (wrapping)
  for (let i = 0; i < ev.length; i++) {
    if (ev[i].rest || ev[i].tie) continue;
    let j = (i + 1) % ev.length;
    while (ev[j].tie && j !== i) { ev[i].hold++; j = (j + 1) % ev.length; }
  }
  return ev;
}

class Track {
  constructor(fs, t, psg) {
    this.def = t;
    this.events = parseSteps(t.steps);
    this.gain = t.gain ?? 0.8;
    [this.l, this.r] = panGains(t.pan ?? 0, 'equal-power');
    this.gate = t.gate ?? 0.8;
    this.velocity = t.velocity ?? 0.8;
    this.octave = t.octave ?? 0;
    this.instrument = t.instrument || 'fm';
    this.minI = t.minIntensity ?? 0;
    this.maxI = t.maxIntensity ?? 1;
    this.layer = 0; this.layerTarget = 0; this.layerStep = 0;
    if (this.instrument === 'fm') this.synth = new FMSynth(fs, { voices: t.voices ?? 3, patch: t.patch || 'epiano', vibrato: t.vibrato ?? 0 });
    this.psg = psg;
    this.channel = t.channel ?? (this.instrument === 'noise' ? 3 : 0);
  }

  wants(intensity) {
    return intensity >= this.minI - 1e-9 && intensity <= this.maxI + 1e-9;
  }
}

export class Sequencer {
  constructor(fs, song, { intensity = 0.5 } = {}) {
    this.fs = fs;
    this.psg = new PSG(fs);
    this.intensity = intensity;
    this.playing = false;
    this.master = 1;
    this.setSong(song);
  }

  setSong(song) {
    this.song = { stepsPerBeat: 4, beatsPerBar: 4, swing: 0, switchOn: 'bar', ...song };
    this.rng = new Noise(this.song.seed ?? 1234);
    this.tracks = this.song.tracks.map((t) => new Track(this.fs, t, this.psg));
    this.setTempo(this.song.bpm ?? 120);
    this.step = -1;
    this.acc = 0;
    for (const t of this.tracks) {          // start with the layers the intensity asks for
      t.layer = t.layerTarget = t.wants(this.intensity) ? 1 : 0;
      t.layerStep = 0;
    }
  }

  setTempo(bpm) {
    this.bpm = bpm;
    this.stepLen = (this.fs * 60) / (bpm * this.song.stepsPerBeat);
    this.barSteps = this.song.stepsPerBeat * this.song.beatsPerBar;
    const sw = this.song.switchOn;
    this.switchSteps = sw === 'step' ? 1 : sw === 'beat' ? this.song.stepsPerBeat : this.barSteps;
  }

  /** 0 (calm) .. 1 (danger): picks layers at the next bar and scales dynamics now. */
  setIntensity(x) {
    this.intensity = Math.max(0, Math.min(1, x));
  }

  play() { this.playing = true; this.step = -1; this.acc = 0; }

  stop() {
    this.playing = false;
    for (const t of this.tracks) t.synth?.releaseAll();
  }

  get active() {
    if (this.playing) return true;
    return this.tracks.some((t) => t.synth?.active) || this.psg.active;
  }

  _onStep() {
    this.step++;
    const s = this.step;
    if (s % this.switchSteps === 0) {
      const fadeLen = Math.round(this.stepLen * Math.min(this.switchSteps, this.song.stepsPerBeat));   // one grid unit, at most a beat
      for (const t of this.tracks) {
        const want = t.wants(this.intensity) ? 1 : 0;
        if (want !== t.layerTarget) { t.layerTarget = want; t.layerStep = (want - t.layer) / fadeLen; }
      }
    }
    const dyn = 0.55 + 0.45 * this.intensity;
    for (const t of this.tracks) {
      if (t.layerTarget === 0 && t.layer === 0) continue;
      const e = t.events[s % t.events.length];
      if (e.rest || e.tie) continue;
      if (e.chance < 1 && this.rng.uniform() >= e.chance) continue;
      const vel = Math.min(1, (t.velocity + e.accent) * dyn * (e.hit ?? 1));
      const dur = (e.hold * this.stepLen * t.gate) / this.fs;
      if (t.instrument === 'fm') {
        const midi = e.midi ?? parseNote(t.def.note || 'C2');
        t.synth.note({ freq: midiToFreq(midi + 12 * t.octave), velocity: vel, duration: dur });
      } else if (t.instrument === 'noise') {
        t.psg.note({ channel: 3, freq: t.def.rate ?? 9000, velocity: vel, duration: Math.min(dur, 0.03), decay: t.def.decay ?? 2, white: t.def.white ?? true });
      } else {
        const midi = e.midi ?? 60;
        t.psg.note({ channel: t.channel, freq: midiToFreq(midi + 12 * t.octave), velocity: vel, duration: dur, decay: t.def.decay ?? 1 });
      }
    }
  }

  /** @param {number[]} out receives [left, right] */
  process(out) {
    if (this.playing && --this.acc <= 0) {
      this._onStep();
      // swing: even steps run long and odd steps short by the same amount, so beats stay on the grid
      this.acc += this.stepLen * (this.step % 2 === 0 ? 1 + this.song.swing * 0.5 : 1 - this.song.swing * 0.5);
    }
    let l = 0, r = 0;
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      if (t.layerStep) {
        t.layer += t.layerStep;
        if ((t.layerStep > 0 && t.layer >= t.layerTarget) || (t.layerStep < 0 && t.layer <= t.layerTarget)) { t.layer = t.layerTarget; t.layerStep = 0; }
      }
      if (!t.synth || (t.layer === 0 && !t.synth.active)) continue;
      const y = t.synth.process() * t.gain * t.layer;
      l += y * t.l; r += y * t.r;
    }
    const p = this.psg.process();
    out[0] = (l + p) * this.master;
    out[1] = (r + p) * this.master;
    return out;
  }
}

/** A short demo loop in the Genesis manner: FM bass and lead, PSG arpeggio and hats, FM drums. */
export const DEMO_SONG = {
  bpm: 138, seed: 7, swing: 0.1,
  tracks: [
    { name: 'kick', instrument: 'fm', patch: 'kick', note: 'C2', steps: 'x . . . x . . . x . . . x . x .', gain: 1.1, gate: 0.5 },
    { name: 'snare', instrument: 'noise', rate: 14000, decay: 3, steps: '. . . . x . . . . . . . x . . ?o', gain: 1, minIntensity: 0.3 },
    { name: 'hats', instrument: 'noise', rate: 30000, decay: 6, steps: 'o o x o o o x o o o x o o o x ?x', minIntensity: 0.6 },
    { name: 'bass', instrument: 'fm', patch: 'bass', steps: 'A1 . A2 A1 . A1 G2 . F1 . F2 F1 . F1 E2 G1', gain: 1, gate: 0.6 },
    { name: 'arp', instrument: 'psg', channel: 0, steps: 'A4 C5 E5 A5 E5 C5 A4 C5 F4 A4 C5 F5 C5 A4 G4 B4', gate: 0.5, decay: 2, minIntensity: 0.45 },
    { name: 'lead', instrument: 'fm', patch: 'lead', vibrato: 0.15, pan: 0.2,
      steps: 'E5 - - C5 . D5 E5 - F5 - E5 - D5 - C5 . E5 - - C5 . D5 E5 - G5 - - - A5 - - .', gate: 0.95, minIntensity: 0.7 },
    { name: 'pad', instrument: 'fm', patch: 'organ', pan: -0.3, gain: 0.5, maxIntensity: 0.69,
      steps: 'A3 - - - - - - - F3 - - - - - - -', gate: 1 },
  ],
};
