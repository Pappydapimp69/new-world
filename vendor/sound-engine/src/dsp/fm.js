/**
 * 4-operator FM synthesis in the style of the Yamaha YM2612 (Mega Drive /
 * Genesis): eight operator algorithms, operator-1 self-feedback averaged over
 * two samples, per-operator envelopes, frequency ratios and detune, a shared
 * LFO for vibrato and tremolo, and a pitch envelope for sound effects.
 *
 * What makes it dynamic: every operator has a velocity sensitivity, so a
 * harder note drives the modulators harder and comes out brighter, not just
 * louder; and envelopes can be key-scaled so high notes decay faster.
 *
 * Aliasing: a sine with a modulation index I spreads energy over roughly
 * (I + 1) x the modulator frequency on each side of the carrier (Carson's
 * rule), and a sin() output pins the peak, so a level meter never shows the
 * fold-over (Brain: genesis-fm E1, kernel-dsp-fm E1). Each modulator's index
 * is therefore capped per note so carrier + (I + 1) x modulator stays under
 * 0.45 fs, and feedback is capped the same way.
 */

import { DCBlocker } from './smoother.js';

const TABLE = 4096;
const SIN = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SIN[i] = Math.sin((2 * Math.PI * i) / TABLE);

/** Table sine of a phase in cycles (any real), linear interpolation. */
export function sinCycles(ph) {
  const x = (ph - Math.floor(ph)) * TABLE;
  const i = x | 0;
  const a = x - i;
  return SIN[i] + a * (SIN[i + 1] - SIN[i]);
}

/**
 * Modulation routing for the 8 YM2612 algorithms. `mods[k]` lists the
 * operators that modulate operator k (always lower-numbered, so one pass in
 * order 0..3 evaluates every algorithm); `out` lists the carriers.
 */
export const ALGORITHMS = [
  { mods: [[], [0], [1], [2]], out: [3] },              // 0: 1>2>3>4
  { mods: [[], [], [0, 1], [2]], out: [3] },            // 1: (1+2)>3>4
  { mods: [[], [], [1], [0, 2]], out: [3] },            // 2: (1+(2>3))>4
  { mods: [[], [0], [], [1, 2]], out: [3] },            // 3: ((1>2)+3)>4
  { mods: [[], [0], [], [2]], out: [1, 3] },            // 4: (1>2)+(3>4)
  { mods: [[], [0], [0], [0]], out: [1, 2, 3] },        // 5: 1>(2,3,4)
  { mods: [[], [0], [], []], out: [1, 2, 3] },          // 6: (1>2)+3+4
  { mods: [[], [], [], []], out: [0, 1, 2, 3] },        // 7: 1+2+3+4
];

const DEFAULT_OP = { ratio: 1, detune: 0, level: 0, attack: 0.005, decay: 0.3, sustain: 0.7, release: 0.2, vel: 0.5, keyScale: 0, am: 0 };

/**
 * Patches. Operator `level` is an amplitude for carriers and a modulation
 * index in radians for modulators. Times in seconds; sustain 0..1 of peak.
 */
export const FM_PATCHES = {
  epiano: { alg: 4, fb: 0.1, ops: [
    { ratio: 1, level: 1.6, attack: 0.002, decay: 0.8, sustain: 0.2, release: 0.3, vel: 0.9 },
    { ratio: 1, level: 0.8, attack: 0.002, decay: 2.5, sustain: 0.3, release: 0.4, vel: 0.3, keyScale: 0.5 },
    { ratio: 14, level: 0.9, attack: 0.001, decay: 0.15, sustain: 0, release: 0.1, vel: 1 },
    { ratio: 1, level: 0.35, attack: 0.002, decay: 1.2, sustain: 0.1, release: 0.3, vel: 0.4 }] },
  brass: { alg: 3, fb: 0.35, ops: [
    { ratio: 1, level: 1.2, attack: 0.06, decay: 0.4, sustain: 0.8, release: 0.15, vel: 0.8 },
    { ratio: 1, level: 1.0, attack: 0.08, decay: 0.5, sustain: 0.7, release: 0.15, vel: 0.8 },
    { ratio: 2, level: 0.4, attack: 0.05, decay: 0.3, sustain: 0.5, release: 0.15, vel: 0.6 },
    { ratio: 1, level: 0.9, attack: 0.03, decay: 0.6, sustain: 0.85, release: 0.12, vel: 0.3 }] },
  bass: { alg: 0, fb: 0.55, ops: [
    { ratio: 1, level: 1.4, attack: 0.001, decay: 0.25, sustain: 0.3, release: 0.08, vel: 0.8 },
    { ratio: 2, level: 1.1, attack: 0.001, decay: 0.35, sustain: 0.4, release: 0.08, vel: 0.7 },
    { ratio: 1, level: 1.3, attack: 0.001, decay: 0.2, sustain: 0.2, release: 0.08, vel: 0.9 },
    { ratio: 0.5, level: 1.0, attack: 0.001, decay: 0.9, sustain: 0.6, release: 0.1, vel: 0.3 }] },
  lead: { alg: 4, fb: 0.6, ops: [
    { ratio: 1, level: 1.5, attack: 0.01, decay: 0.4, sustain: 0.6, release: 0.15, vel: 0.8 },
    { ratio: 1, level: 0.7, attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.15, vel: 0.3, am: 1 },
    { ratio: 3, level: 0.7, attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.15, vel: 0.8 },
    { ratio: 1.003, level: 0.45, attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.15, vel: 0.3 }] },
  bell: { alg: 4, fb: 0, ops: [
    { ratio: 3.5, level: 2.0, attack: 0.001, decay: 1.4, sustain: 0, release: 1.0, vel: 0.9 },
    { ratio: 1, level: 0.7, attack: 0.001, decay: 3.5, sustain: 0, release: 1.5, vel: 0.2, keyScale: 0.6 },
    { ratio: 5.19, level: 1.0, attack: 0.001, decay: 0.6, sustain: 0, release: 0.5, vel: 0.9 },
    { ratio: 2, level: 0.35, attack: 0.001, decay: 2.0, sustain: 0, release: 1.2, vel: 0.2 }] },
  organ: { alg: 7, fb: 0.2, ops: [
    { ratio: 0.5, level: 0.3, attack: 0.005, decay: 1, sustain: 1, release: 0.05, vel: 0.2 },
    { ratio: 1, level: 0.35, attack: 0.005, decay: 1, sustain: 1, release: 0.05, vel: 0.2 },
    { ratio: 2, level: 0.22, attack: 0.005, decay: 1, sustain: 1, release: 0.05, vel: 0.3 },
    { ratio: 3, level: 0.15, attack: 0.005, decay: 1, sustain: 1, release: 0.05, vel: 0.4 }] },
  // percussion
  kick: { alg: 4, fb: 0, sweep: 30, sweepTime: 0.045, ops: [
    { ratio: 1, level: 0.6, attack: 0.001, decay: 0.03, sustain: 0, release: 0.02, vel: 0.8 },
    { ratio: 1, level: 1.0, attack: 0.001, decay: 0.28, sustain: 0, release: 0.05, vel: 0.4 },
    { ratio: 1, level: 0, attack: 0.001, decay: 0.1, sustain: 0, release: 0.05 },
    { ratio: 0.5, level: 0.3, attack: 0.001, decay: 0.2, sustain: 0, release: 0.05, vel: 0.4 }] },
  tom: { alg: 4, fb: 0.2, sweep: 12, sweepTime: 0.08, ops: [
    { ratio: 1.5, level: 0.8, attack: 0.001, decay: 0.05, sustain: 0, release: 0.03, vel: 0.9 },
    { ratio: 1, level: 0.9, attack: 0.001, decay: 0.3, sustain: 0, release: 0.06, vel: 0.4 },
    { ratio: 1, level: 0, attack: 0.001, decay: 0.1, sustain: 0, release: 0.05 },
    { ratio: 1, level: 0, attack: 0.001, decay: 0.1, sustain: 0, release: 0.05 }] },
  // sound effects (use with a pitch sweep)
  laser: { alg: 0, fb: 0.4, sweep: -30, sweepTime: 0.18, ops: [
    { ratio: 1, level: 1.5, attack: 0.001, decay: 0.15, sustain: 0, release: 0.05, vel: 0.7 },
    { ratio: 2, level: 1.2, attack: 0.001, decay: 0.12, sustain: 0, release: 0.05, vel: 0.7 },
    { ratio: 1, level: 0.8, attack: 0.001, decay: 0.1, sustain: 0, release: 0.05, vel: 0.7 },
    { ratio: 1, level: 0.9, attack: 0.001, decay: 0.25, sustain: 0, release: 0.05, vel: 0.3 }] },
  jump: { alg: 4, fb: 0.2, sweep: 12, sweepTime: 0.12, sweepUp: true, ops: [
    { ratio: 1, level: 0.9, attack: 0.001, decay: 0.2, sustain: 0, release: 0.05, vel: 0.6 },
    { ratio: 1, level: 0.8, attack: 0.001, decay: 0.25, sustain: 0, release: 0.05, vel: 0.2 },
    { ratio: 2, level: 0.5, attack: 0.001, decay: 0.15, sustain: 0, release: 0.05, vel: 0.6 },
    { ratio: 1, level: 0.3, attack: 0.001, decay: 0.25, sustain: 0, release: 0.05, vel: 0.2 }] },
  coin: { alg: 7, fb: 0, arp: [0, 7, 12], arpStep: 0.06, ops: [
    { ratio: 1, level: 0.45, attack: 0.001, decay: 0.35, sustain: 0, release: 0.08, vel: 0.2 },
    { ratio: 2, level: 0.2, attack: 0.001, decay: 0.25, sustain: 0, release: 0.08, vel: 0.4 },
    { ratio: 3, level: 0.1, attack: 0.001, decay: 0.2, sustain: 0, release: 0.08, vel: 0.5 },
    { ratio: 4, level: 0.08, attack: 0.001, decay: 0.15, sustain: 0, release: 0.08, vel: 0.6 }] },
  hit: { alg: 4, fb: 0.9, sweep: -12, sweepTime: 0.08, ops: [
    { ratio: 1.41, level: 2.5, attack: 0.001, decay: 0.08, sustain: 0, release: 0.04, vel: 1 },
    { ratio: 1, level: 1.0, attack: 0.001, decay: 0.16, sustain: 0, release: 0.05, vel: 0.5 },
    { ratio: 3.7, level: 2.0, attack: 0.001, decay: 0.05, sustain: 0, release: 0.03, vel: 1 },
    { ratio: 1, level: 0.6, attack: 0.001, decay: 0.12, sustain: 0, release: 0.05, vel: 0.4 }] },
  explosion: { alg: 0, fb: 1, sweep: -24, sweepTime: 0.9, ops: [
    { ratio: 1, level: 3, attack: 0.001, decay: 0.7, sustain: 0, release: 0.3, vel: 1 },
    { ratio: 1.5, level: 2.5, attack: 0.001, decay: 0.6, sustain: 0, release: 0.3, vel: 1 },
    { ratio: 0.5, level: 2, attack: 0.001, decay: 0.8, sustain: 0, release: 0.3, vel: 0.8 },
    { ratio: 1, level: 1, attack: 0.002, decay: 1.2, sustain: 0, release: 0.4, vel: 0.4 }] },
  roar: { alg: 1, fb: 0.7, sweep: -5, sweepTime: 0.9, vibrato: 0.4, ops: [
    { ratio: 0.5, level: 1.8, attack: 0.08, decay: 0.8, sustain: 0.6, release: 0.3, vel: 1 },
    { ratio: 1.01, level: 1.2, attack: 0.1, decay: 0.9, sustain: 0.5, release: 0.3, vel: 0.8 },
    { ratio: 1, level: 1.5, attack: 0.06, decay: 1.0, sustain: 0.6, release: 0.3, vel: 0.9 },
    { ratio: 1, level: 1.0, attack: 0.08, decay: 1.2, sustain: 0.8, release: 0.35, vel: 0.4 }] },
};

export const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

const IDLE = 0, ATTACK = 1, DECAY = 2, SUSTAIN = 3, RELEASE = 4;

/** One FM note: 4 operators, envelopes, pitch envelope. Preallocated; reused. */
class FMNote {
  constructor(fs) {
    this.fs = fs;
    this.on = false;
    this.ph = new Float64Array(4);
    this.inc = new Float64Array(4);
    this.lvl = new Float64Array(4);    // peak level after velocity and alias cap
    this.env = new Float64Array(4);
    this.stage = new Uint8Array(4);
    this.atk = new Float64Array(4);
    this.dk = new Float64Array(4);     // decay coefficient per sample
    this.rk = new Float64Array(4);     // release coefficient per sample
    this.sus = new Float64Array(4);
    this.am = new Float64Array(4);
    this.out = new Float64Array(4);
    this.fb1 = 0; this.fb2 = 0;
    // every field the note uses, set here so all notes share one hidden class
    this.alg = ALGORITHMS[0]; this.age = 0; this.gate = 1; this.freq = 440; this.velocity = 0; this.fb = 0;
    this.sweep = 0; this.sweepK = 0; this.sweepNow = 0; this.arp = null; this.arpLen = 1; this.vib = 0;
  }

  start(patch, freq, velocity, gate, fs, aliasCap = true) {
    const alg = ALGORITHMS[patch.alg ?? 0];
    this.alg = alg;
    this.on = true;
    this.age = 0;
    this.gate = Math.max(1, Math.round(gate * fs));
    this.freq = freq;
    this.velocity = velocity;
    const ops = patch.ops;
    const fr = this._fr || (this._fr = new Float64Array(4));
    for (let k = 0; k < 4; k++) {
      const o = { ...DEFAULT_OP, ...(ops[k] || {}) };
      const f = freq * o.ratio * 2 ** (o.detune / 1200);
      fr[k] = f;
      this.inc[k] = f / fs;
      this.ph[k] = 0;
      this.lvl[k] = o.level * (1 - o.vel + o.vel * velocity);
      // key scaling: higher notes decay faster (time x (261.6 / f)^keyScale)
      const ks = (261.6 / freq) ** o.keyScale;
      this.atk[k] = 1 / Math.max(1, o.attack * fs);
      this.dk[k] = Math.exp(Math.log(1e-3) / Math.max(1, o.decay * ks * fs));
      this.rk[k] = Math.exp(Math.log(1e-3) / Math.max(1, o.release * ks * fs));
      this.sus[k] = o.sustain;
      this.am[k] = o.am;
      this.env[k] = 0;
      this.stage[k] = ATTACK;
      this.out[k] = 0;
    }
    let fbI = Math.PI * (patch.fb ?? 0);
    if (aliasCap) this._capBandwidth(fr, 0.45 * fs, fbI, (v) => { fbI = v; });
    this.fb = fbI;
    this.fb1 = this.fb2 = 0;
    // pitch envelope: start `sweep` semitones off and glide exponentially to 0
    this.sweep = patch.sweep ?? 0;
    this.sweepK = patch.sweep ? Math.exp(Math.log(1e-3) / Math.max(1, (patch.sweepTime ?? 0.1) * fs)) : 0;
    this.sweepNow = patch.sweepUp ? -this.sweep : this.sweep;
    this.arp = patch.arp || null;
    this.arpLen = Math.max(1, Math.round((patch.arpStep ?? 0.06) * fs));
    this.vib = patch.vibrato ?? 0;
  }

  /**
   * Alias cap. Track each operator's spectral reach E: a sine at f phase-
   * modulated with index I by a signal reaching E_m spreads to about
   * f + (I + 1) E_m (Carson's rule, applied through the cascade), and op-1
   * feedback with index b reaches about f (1 + 2 b). Modulator indices (and
   * feedback) are lowered until every carrier's reach stays below `limit`.
   * One-pair caps miss cascades: a 1>2>3>4 chain at a C7 passed a per-pair
   * check yet put 59% of its energy off the harmonic grid.
   */
  _capBandwidth(fr, limit, fbI, setFb) {
    const alg = this.alg, lvl = this.lvl, E = this._E || (this._E = new Float64Array(4));
    const fb = Math.min(fbI, Math.max(0, (limit / fr[0] - 1) / 2));
    setFb(fb);
    E[0] = fr[0] * (1 + 2 * fb);
    for (let t = 1; t < 4; t++) {
      const mods = alg.mods[t];
      if (mods.length) {
        const share = Math.max(0, limit - fr[t]) / mods.length;
        for (const m of mods) lvl[m] = Math.min(lvl[m], Math.max(0, share / E[m] - 1));
      }
      let reach = fr[t];
      for (const m of mods) reach += (lvl[m] + 1) * E[m];
      E[t] = reach;
    }
  }

  release() {
    for (let k = 0; k < 4; k++) if (this.stage[k] !== IDLE) this.stage[k] = RELEASE;
  }

  /** @param {number} lfo -1..1 shared LFO value; @param {number} vibDepth semitones; @param {number} trem 0..1 */
  process(lfo, vibDepth, trem) {
    if (this.age++ === this.gate) this.release();
    let semis = 0;
    if (this.sweepK) { semis += this.sweepNow; this.sweepNow *= this.sweepK; }
    if (this.arp) semis += this.arp[Math.min(this.arp.length - 1, (this.age / this.arpLen) | 0)];
    const vd = vibDepth + this.vib;
    if (vd) semis += vd * lfo;
    const pitch = semis ? 2 ** (semis / 12) : 1;
    const alg = this.alg, out = this.out;
    let y = 0, alive = false;
    for (let k = 0; k < 4; k++) {
      // envelope
      let e = this.env[k];
      switch (this.stage[k]) {
        case ATTACK: e += this.atk[k]; if (e >= 1) { e = 1; this.stage[k] = DECAY; } break;
        case DECAY: e = this.sus[k] + (e - this.sus[k]) * this.dk[k]; if (e - this.sus[k] < 1e-4) this.stage[k] = SUSTAIN; break;
        case SUSTAIN: break;
        case RELEASE: e *= this.rk[k]; if (e < 1e-4) { e = 0; this.stage[k] = IDLE; } break;
        default: e = 0;
      }
      this.env[k] = e;
      if (e > 0 || this.stage[k] !== IDLE) alive = true;
      // phase modulation input
      let mod = 0;
      const m = alg.mods[k];
      for (let j = 0; j < m.length; j++) mod += out[m[j]];
      if (k === 0 && this.fb) mod += this.fb * 0.5 * (this.fb1 + this.fb2);
      this.ph[k] += this.inc[k] * pitch;
      if (this.ph[k] >= 1) this.ph[k] -= Math.floor(this.ph[k]);
      const amp = this.lvl[k] * e * (this.am[k] ? 1 - trem * this.am[k] * (0.5 + 0.5 * lfo) : 1);
      out[k] = amp * sinCycles(this.ph[k] + mod / (2 * Math.PI));
      if (k === 0) { this.fb2 = this.fb1; this.fb1 = out[0] / (this.lvl[0] || 1); }
    }
    for (let j = 0; j < alg.out.length; j++) y += out[alg.out[j]];
    if (!alive) this.on = false;
    return y;
  }
}

/**
 * Polyphonic FM synth (6 notes, like the YM2612's six channels by default).
 * `note()` starts a note; voices are stolen oldest-first.
 */
export class FMSynth {
  constructor(fs, { voices = 6, patch = 'epiano', lfoRate = 5.5, vibrato = 0, tremolo = 0, aliasCap = true } = {}) {
    this.aliasCap = aliasCap;
    this.fs = fs;
    this.notes = Array.from({ length: voices }, () => new FMNote(fs));
    this.setPatch(patch);
    this.lfoPh = 0;
    this.lfoInc = lfoRate / fs;
    this.vibrato = vibrato;     // semitones
    this.tremolo = tremolo;     // 0..1
    this.gain = 0.35;
    this.dc = new DCBlocker(fs);
  }

  setPatch(patch) {
    this.patch = typeof patch === 'string' ? FM_PATCHES[patch] : patch;
    if (!this.patch) throw new Error(`unknown FM patch ${patch}`);
  }

  /**
   * @param {object} o
   * @param {number} [o.freq] Hz, or
   * @param {number} [o.midi] MIDI note number
   * @param {number} [o.velocity] 0..1 (drives brightness through modulator levels)
   * @param {number} [o.duration] gate seconds before release
   * @param {string|object} [o.patch] override the synth's patch for this note
   */
  note({ freq, midi = 60, velocity = 0.8, duration = 0.3, patch } = {}) {
    const p = patch ? (typeof patch === 'string' ? FM_PATCHES[patch] : patch) : this.patch;
    let v = this.notes.find((n) => !n.on);
    if (!v) v = this.notes.reduce((a, b) => (a.age > b.age ? a : b));
    v.start(p, freq ?? midiToFreq(midi), Math.max(0, Math.min(1, velocity)), duration, this.fs, this.aliasCap);
    return v;
  }

  releaseAll() {
    for (const n of this.notes) if (n.on) n.release();
  }

  get active() {
    for (let i = 0; i < this.notes.length; i++) if (this.notes[i].on) return true;
    return this.dc.ringing;
  }

  process() {
    let y = 0;
    const notes = this.notes;
    let any = false;
    for (let i = 0; i < notes.length; i++) if (notes[i].on) { any = true; break; }
    if (!any) return this.dc.ringing ? this.dc.process(0) : 0;
    this.lfoPh += this.lfoInc;
    if (this.lfoPh >= 1) this.lfoPh -= 1;
    const lfo = sinCycles(this.lfoPh);
    for (let i = 0; i < notes.length; i++) if (notes[i].on) y += notes[i].process(lfo, this.vibrato, this.tremolo);
    return this.dc.process(y * this.gain);
  }
}
