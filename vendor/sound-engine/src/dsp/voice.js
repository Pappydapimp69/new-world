import { Biquad } from './biquad.js';
import { Noise } from './noise.js';
import { sinCycles } from './fm.js';

const C = 343;

/**
 * Open-mouth tract: tube closed at the glottis, open at the mouth.
 * F_n = (2n - 1) c / (4 L).
 */
export function tractFormants(length, n = 5) {
  return Array.from({ length: n }, (_, i) => ((2 * i + 1) * C) / (4 * length));
}

/**
 * Highest f0 that keeps the heard F1 within 15%: the heard peak is the nearest
 * harmonic (error up to f0 / 2F1), so cap f0 at 0.3 F1; f0 at F1/2 can read
 * 20% off and a 200 Hz roar on a 0.7 m tract reads F1 at 200 Hz (dlist/E8).
 */
export const maxOpenF0 = (length) => 0.3 * tractFormants(length, 1)[0];

/**
 * Closed-mouth calls radiate through an inflated throat sac with one
 * resonance (Fletcher et al. 2004, dove coo ~600 Hz at a 35 mm sac). Scale by
 * size^-1 (wall mass ~ volume) to size^-0.5 (fixed wall thickness);
 * exponent 0.75 sits between (dlist/E16).
 */
export function sacResonance(sacDiameter, exponent = 0.75) {
  return 600 * (0.035 / sacDiameter) ** exponent;
}

/**
 * Size presets: vocal tract length and throat-sac diameter in metres.
 * Game estimates for the Dlist cast plus generic sizes.
 */
export const CREATURES = {
  small: { tract: 0.12, sac: 0.05 },
  eodromaeus: { tract: 0.2, sac: 0.08 },
  medium: { tract: 0.4, sac: 0.18 },
  herrerasaurus: { tract: 0.7, sac: 0.35 },
  large: { tract: 1.2, sac: 0.6 },
};

/**
 * Source-filter creature voice. Open mode: glottal pulses through a parallel
 * formant bank set by tract length, with f0 capped at 0.3 F1. Closed mode: no
 * formants, one sac resonance (Q ~10) with f0 locked within 10% of it, so the
 * call is a near pure tone (99% in the fundamental at resonance).
 *
 * Calls are dynamic: `intensity` shortens the glottal closing phase (louder
 * calls carry more high harmonics, as real voices do), `mouth` opens the jaw
 * over the call so the formants glide up and back, and `vibrato` adds a slow
 * pitch wobble on top of the random jitter. Each call keeps its own glottal
 * phase, so overlapping calls no longer push one shared oscillator twice.
 */
const MAX_CALLS = 4;

/** One sounding call. A class with every field set up front keeps one hidden class (fast property access). */
class Call {
  constructor() {
    this.on = false; this.mode = 'open'; this.len = 1; this.t = 0; this.a = 0; this.ratio = 1; this.f = 0; this.fk = 1;
    this.wob = 0; this.phase = 0; this.sub = 0; this.amp = 0; this.tn = 0.16; this.roughness = 0; this.breath = 0;
    this.jitter = 0; this.vib = 0; this.vibInc = 0; this.mouth = 0; this.atk = 1; this.rel = 1; this.iatk = 1; this.irel = 1;
    this.closed = false;
  }
}
const CONTROL = 64;   // formant coefficients update every 64 samples

export class CreatureVoice {
  constructor(fs, { tract = 0.7, sac = 0.35, seed = 3 } = {}) {
    this.fs = fs;
    this.noise = new Noise(seed);
    this.setSize(tract, sac);
    this.pool = Array.from({ length: MAX_CALLS }, () => new Call());
    this.ring = 0;
    this.ctl = 0;
    this.shape = 1;
  }

  setSize(tract, sac) {
    this.tract = tract;
    this.sac = sac;
    this.formants = tractFormants(tract);
    const n = this.formants.length;
    this.bank = this.formants.map((f, i) => ({
      f,
      g: 1 / (1 + i * 0.7),
      bq: new Biquad(this.fs).bandpass(f, f / (50 + 0.06 * f)),
    }));
    // flat copies for the per-sample loop: a band-pass has b1 = 0 and b2 = -b0
    this.fb0 = new Float64Array(n); this.fa1 = new Float64Array(n); this.fa2 = new Float64Array(n); this.fg = new Float64Array(n);
    this.fx1 = 0; this.fx2 = 0; this.fy1 = new Float64Array(n); this.fy2 = new Float64Array(n);
    this._copyBank();
    this.shape = 1;
    this.sacFreq = sacResonance(sac);
    this.sacBq = new Biquad(this.fs).bandpass(this.sacFreq, 10);
  }

  /**
   * Start a call.
   * @param {object} o
   * @param {'open'|'closed'} [o.mode]
   * @param {number} [o.duration] seconds
   * @param {number} [o.f0] start pitch (Hz); clamped per mode
   * @param {number} [o.f0End] end pitch
   * @param {number} [o.amp]
   * @param {number} [o.intensity] 0..1 effort: louder and brighter (default 0.6)
   * @param {number} [o.roughness] 0..1 period doubling / growl
   * @param {number} [o.breath] 0..1 aspiration noise
   * @param {number} [o.jitter] 0..1 random pitch wobble
   * @param {number} [o.vibrato] 0..1 periodic wobble depth (up to +-0.6 semitone)
   * @param {number} [o.vibratoRate] Hz (default 5)
   * @param {number} [o.mouth] 0..1 jaw opening: formants glide up to +30% and back
   * @param {number} [o.attack] seconds (default 0.07)
   */
  call({ mode = 'open', duration = 1.2, f0, f0End, amp = 0.8, intensity = 0.6, roughness = 0.3, breath = 0.15,
    jitter = 0.2, vibrato = 0, vibratoRate = 5, mouth = 0.5, attack = 0.07 } = {}) {
    let a, b;
    if (mode === 'closed') {
      const lock = (x) => Math.min(this.sacFreq * 1.1, Math.max(this.sacFreq * 0.9, x ?? this.sacFreq));
      a = lock(f0); b = lock(f0End ?? a * 0.95);
    } else {
      const cap = maxOpenF0(this.tract);
      a = Math.min(f0 ?? cap * 0.8, cap);
      b = Math.min(f0End ?? a * 0.7, cap);
    }
    const it = Math.max(0, Math.min(1, intensity));
    let c = this.pool.find((x) => !x.on);
    if (!c) c = this.pool.reduce((p, q) => (p.t / p.len > q.t / q.len ? p : q));   // steal the most finished
    const len = Math.max(1, Math.round(duration * this.fs));
    c.on = true; c.mode = mode; c.closed = mode === 'closed'; c.len = len; c.t = 0; c.a = a; c.ratio = b / a;
    c.f = a; c.fk = (b / a) ** (1 / len); c.wob = 0; c.phase = 0; c.sub = 0;
    c.amp = amp * (0.45 + 0.55 * it);
    c.tn = 0.24 - 0.14 * it;                     // closing phase: shorter = brighter
    c.roughness = Math.min(1, roughness + 0.4 * Math.max(0, it - 0.7));
    c.breath = breath; c.jitter = jitter;
    c.vib = vibrato * 0.035; c.vibInc = vibratoRate / this.fs;
    c.mouth = Math.max(0, Math.min(1, mouth));
    c.atk = Math.max(1, attack * this.fs); c.rel = Math.max(1, 0.25 * len);
    c.iatk = 1 / c.atk; c.irel = 1 / c.rel;
  }

  /** Calls currently sounding (allocates: for tests and tools, not the audio loop). */
  get calls() {
    return this.pool.filter((c) => c.on);
  }

  get active() {
    for (let i = 0; i < this.pool.length; i++) if (this.pool[i].on) return true;
    return false;
  }

  /** Rosenberg glottal flow derivative over one period (phase 0..1), closing time tn. */
  static pulse(ph, tn = 0.16) {
    const tp = 0.4;
    // sin(pi u) = table sine at u / 2 cycles
    if (ph < tp) return sinCycles(ph / (2 * tp)) * (Math.PI / tp) * 0.5;
    if (ph < tp + tn) return -sinCycles((ph - tp) / (4 * tn)) * (Math.PI / (2 * tn));
    return 0;
  }

  _copyBank() {
    this.bank.forEach((f, i) => { this.fb0[i] = f.bq.b0; this.fa1[i] = f.bq.a1; this.fa2[i] = f.bq.a2; this.fg[i] = f.g; });
  }

  /** Jaw opening shapes the formants: up to +30% at 30% of the call, then relaxes. */
  _shapeFormants() {
    let m = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const c = this.pool[i];
      if (!c.on || c.closed) continue;
      const u = c.t / c.len;
      const open = u < 0.3 ? u / 0.3 : Math.max(0, 1 - (u - 0.3) / 0.7);
      m = Math.max(m, c.mouth * open);
    }
    const shape = 1 + 0.3 * m;
    if (Math.abs(shape - this.shape) < 0.002) return;
    this.shape = shape;
    for (const f of this.bank) {
      const fr = f.f * shape;
      f.bq.bandpass(fr, fr / (50 + 0.06 * fr));
    }
    this._copyBank();
  }

  process() {
    if (this.ctl-- <= 0) { this.ctl = CONTROL; this._shapeFormants(); }
    let open = 0, closed = 0;
    const pool = this.pool, fs = this.fs;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      if (!c.on) continue;
      const left = c.len - c.t;
      const env = (c.t < c.atk ? c.t * c.iatk : 1) * (left < c.rel ? left * c.irel : 1);
      c.wob += (this.noise.bipolar() * 0.02 - c.wob * 0.001) * c.jitter;
      const vib = c.vib ? c.vib * sinCycles(c.vibInc * c.t) : 0;
      const f0 = c.f * (1 + c.wob * 0.05 + vib);
      c.f *= c.fk;                                 // exponential glide a -> b without a pow per sample
      c.phase += f0 / fs;
      if (c.phase >= 1) { c.phase -= 1; c.sub ^= 1; }
      let x = CreatureVoice.pulse(c.phase, c.tn) * (1 - c.roughness * 0.5 * c.sub);
      if (c.breath) x += c.breath * this.noise.bipolar() * 0.5;
      x *= env * c.amp;
      if (c.closed) closed += x; else open += x;
      if (++c.t >= c.len) c.on = false;
    }
    let y = 0;
    const x2 = this.fx2, y1 = this.fy1, y2 = this.fy2;
    if (open !== 0 || this.ring > 0) {
      const b0 = this.fb0, a1 = this.fa1, a2 = this.fa2, g = this.fg, d = open - x2;
      let e = 0;
      for (let i = 0; i < b0.length; i++) {
        const v = b0[i] * d - a1[i] * y1[i] - a2[i] * y2[i];
        y2[i] = y1[i]; y1[i] = v;
        y += g[i] * v;
        e += v < 0 ? -v : v;
      }
      this.fx2 = this.fx1; this.fx1 = open;
      this.ring = open !== 0 || e > 1e-9 ? 64 : this.ring - 1;   // run 64 samples past audibility, then park
      if (this.ring === 0) { y1.fill(0); y2.fill(0); this.fx1 = this.fx2 = 0; }
    }
    y += this.sacBq.process(closed) * 1.5;
    return y * 0.5;
  }
}
