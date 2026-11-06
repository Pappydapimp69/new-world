import { Resonator } from './resonator.js';
import { Noise } from './noise.js';

/**
 * Bubble acoustics after van den Doel 2005 (ACM TAP 2:534):
 * a bubble rings at the Minnaert frequency f = 3 / r and decays at
 * d = 0.13 / r + 0.0072 r^-1.5 (r in metres).
 */
export const minnaert = (r) => 3 / r;
export const bubbleDecay = (r) => 0.13 / r + 0.0072 * r ** -1.5;

/**
 * Radius-binned resonator bank. Every bubble adds an impulse to the nearest
 * bin; by linearity that equals summing per-bubble voices exactly, at a fixed
 * cost of `bins` resonators instead of rate x lifetime voices (48 voices at
 * 1000 bubbles/s, 351 at 10000/s; dlist/E15).
 */
export class BubbleBank {
  constructor(fs, { minRadius = 0.0002, maxRadius = 0.005, bins = 16 } = {}) {
    this.fs = fs;
    this.radii = [];
    this.res = [];
    for (let k = 0; k < bins; k++) {
      const r = minRadius * (maxRadius / minRadius) ** (k / (bins - 1));
      this.radii.push(r);
      this.res.push(new Resonator(fs, minnaert(r), bubbleDecay(r)));
    }
    this.logMin = Math.log(minRadius);
    this.logStep = Math.log(maxRadius / minRadius) / (bins - 1);
  }

  /** @param {number} r bubble radius (m) @param {number} amp impulse size */
  add(r, amp) {
    const k = Math.round((Math.log(r) - this.logMin) / this.logStep);
    this.res[Math.min(this.res.length - 1, Math.max(0, k))].excite(amp);
  }

  process() {
    let y = 0;
    const res = this.res;
    for (let i = 0; i < res.length; i++) if (res[i].active) y += res[i].process();
    return y;
  }
}

/**
 * A handful of free voices for sparse drips whose pitch rises as the bubble
 * nears the surface: f(t) = f0 (1 + xi d t), xi ~ 0.1. A fixed bank cannot do
 * this (time-varying pitch), so keep these few and sparse.
 */
export class RisingBubbles {
  constructor(fs, maxVoices = 4) {
    this.fs = fs;
    this.voices = Array.from({ length: maxVoices }, () => ({ on: false, f0: 0, d: 0, amp: 0, xi: 0, t: 0, ph: 0 }));
  }

  add(r, amp, xi = 0.1) {
    let v = this.voices.find((x) => !x.on);
    if (!v) v = this.voices.reduce((a, b) => (a.t > b.t ? a : b)); // steal the oldest drip
    Object.assign(v, { on: true, f0: minnaert(r), d: bubbleDecay(r), amp, xi, t: 0, ph: 0 });
  }

  process() {
    let y = 0;
    const dt = 1 / this.fs;
    for (const v of this.voices) {
      if (!v.on) continue;
      v.ph += 2 * Math.PI * v.f0 * (1 + v.xi * v.d * v.t) * dt;
      const env = Math.exp(-v.d * v.t);
      y += v.amp * Math.sin(v.ph) * env;
      v.t += dt;
      if (env < 1e-4) v.on = false;
    }
    return y;
  }
}

/** Water presets: bubbles per second and radius-size exponent (1/r^gamma). */
export const WATER_PRESETS = {
  drip: { rate: 3, gamma: 1, minRadius: 0.001, maxRadius: 0.004, rising: 1 },
  stream: { rate: 800, gamma: 2, minRadius: 0.0005, maxRadius: 0.005, rising: 0.02 },
  rain: { rate: 4000, gamma: 6, minRadius: 0.0001, maxRadius: 0.002, rising: 0 },
  splash: { rate: 0, gamma: 2, minRadius: 0.0008, maxRadius: 0.008, rising: 0.1 },
};

/**
 * Stochastic bubble stream driving a bank (dense) and rising voices (sparse).
 * Seeded: same seed, same water.
 */
export class WaterSource {
  constructor(fs, preset = 'stream', seed = 1) {
    this.fs = fs;
    this.noise = new Noise(seed);
    this.setPreset(preset);
    this.rising = new RisingBubbles(fs);
    this.next = 0;
    this.gain = 1;
  }

  setPreset(name) {
    const p = typeof name === 'string' ? WATER_PRESETS[name] : name;
    this.p = { ...p };
    this.bank = new BubbleBank(this.fs, { minRadius: p.minRadius, maxRadius: p.maxRadius });
    this.next = 0;
    // uncorrelated bubbles add in power: keep loudness steady across rates
    this.norm = 3 / Math.sqrt(Math.max(p.rate, 10));
  }

  /** Sample a radius from a 1/r^gamma distribution between min and max. */
  _radius() {
    const { minRadius: a, maxRadius: b, gamma: g } = this.p;
    const u = this.noise.uniform();
    if (Math.abs(g - 1) < 1e-6) return a * (b / a) ** u;
    const e = 1 - g;
    return (a ** e + u * (b ** e - a ** e)) ** (1 / e);
  }

  /** Burst of n bubbles now (splashes, footsteps in water). */
  burst(n, energy = 1) {
    for (let i = 0; i < n; i++) this._emit(energy);
  }

  _emit(energy) {
    const r = this._radius();
    const amp = energy * (r / this.p.maxRadius) ** 0.5 * (0.5 + this.noise.uniform());
    if (this.noise.uniform() < this.p.rising) this.rising.add(r, amp);
    else this.bank.add(r, amp);
  }

  process() {
    if (this.p.rate > 0) {
      this.next -= 1 / this.fs;
      while (this.next <= 0) {
        this._emit(1);
        this.next += this.noise.exponential(this.p.rate);
      }
    }
    return this.gain * this.norm * (this.bank.process() + this.rising.process());
  }
}
