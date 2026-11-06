import { DelayLine } from './delayline.js';

const BASE_DELAYS = [601, 691, 797, 907, 1031, 1153, 1277, 1399]; // at 16 kHz, size 1

/**
 * 8-line feedback delay network with a Householder matrix and a Jot one-pole
 * absorption filter per line. Per-line gains come from each line's own length
 * (g = 10^(-3 m / (fs T60))); per-band T60 lands within 4% of target from one
 * deterministic network, with none of the seed scatter of noise IRs
 * (dlist/E24, dlist/E19).
 */
export class FDNReverb {
  constructor(fs, { size = 1, t60Low = 1.5, t60High = 0.8 } = {}) {
    this.fs = fs;
    this.n = BASE_DELAYS.length;
    this.setSize(size);
    this.setDecay(t60Low, t60High);
  }

  setSize(size) {
    this.delays = BASE_DELAYS.map((d) => Math.max(8, Math.round((d * size * this.fs) / 16000)));
    this.lines = this.delays.map((d) => new DelayLine(d + 4));
    this.lp = new Float64Array(this.n);
    this.f = new Float64Array(this.n);
    this.bufs = null;
    this.cb = new Float64Array(this.n);   // flattened absorption coefficients (no per-sample destructuring)
    this.ca = new Float64Array(this.n);
    this.quiet = 0;
    this.asleep = false;
    if (this.t60Low) this.setDecay(this.t60Low, this.t60High);
  }

  /** Low-frequency and high-frequency T60 in seconds (applied at once). */
  setDecay(t60Low, t60High) {
    this.t60Low = t60Low;
    this.t60High = Math.min(t60High, t60Low);
    this._applyCoefs();
    this.glide = null;
  }

  _applyCoefs() {
    this.coef = this._coefs(this.t60Low, this.t60High);
    for (let i = 0; i < this.n; i++) { this.cb[i] = this.coef[i][0]; this.ca[i] = this.coef[i][1]; }
  }

  _coefs(lo, hi) {
    return this.delays.map((m) => {
      const kdc = 10 ** ((-3 * m) / (this.fs * lo));
      const kny = 10 ** ((-3 * m) / (this.fs * hi));
      const a = (kdc - kny) / (kdc + kny);
      return [kdc * (1 - a), a];
    });
  }

  /**
   * Glide to new T60s on the same delay lines: no rebuild, no hole in the
   * tail (a rebuild silenced the reverb for the first delay length).
   */
  glideDecay(t60Low, t60High, seconds = 0.3) {
    const hi = Math.min(t60High, t60Low);
    this.glide = { from: [this.t60Low, this.t60High], to: [t60Low, hi], n: 0, len: Math.max(1, Math.round(seconds * this.fs)) };
  }

  _stepGlide() {
    const g = this.glide;
    g.n = Math.min(g.len, g.n + 128);
    const u = g.n / g.len;
    // interpolate decay *rates* (1/T60) so the glide is even in dB/s
    const lo = 1 / ((1 - u) / g.from[0] + u / g.to[0]);
    const hi = 1 / ((1 - u) / g.from[1] + u / g.to[1]);
    this.t60Low = lo; this.t60High = Math.min(hi, lo);
    this._applyCoefs();
    if (g.n >= g.len) this.glide = null;
  }

  /**
   * @param {number} x mono input
   * @param {Float64Array|number[]} out 2-element array receiving [left, right]
   */
  process(x, out) {
    if (this.glide && (this._g = (this._g || 0) + 1) % 128 === 0) this._stepGlide();
    const n = this.n, lp = this.lp, f = this.f, cb = this.cb, ca = this.ca;
    const bufs = this.bufs || this._bindLines(), pos = this.pos, masks = this.masks, dl = this.dl;
    let sum = 0, l = 0, r = 0;
    for (let i = 0; i < n; i++) {
      const tap = bufs[i][(pos[i] - dl[i]) & masks[i]];
      const v = cb[i] * tap + ca[i] * lp[i];
      lp[i] = v;
      f[i] = v;
      sum += v;
      if (i & 1) r += tap; else l += tap;
    }
    const s = (2 / n) * sum;
    for (let i = 0; i < n; i++) {
      const p = pos[i];
      bufs[i][p] = f[i] - s + x;
      pos[i] = (p + 1) & masks[i];
    }
    // flush subnormals once per 64 samples: a silent tail was 40% slower than a busy one
    if ((++this._fz & 63) === 0) {
      for (let i = 0; i < n; i++) if (lp[i] < 1e-25 && lp[i] > -1e-25) lp[i] = 0;
      if (sum < 1e-20 && sum > -1e-20 && x === 0) for (let i = 0; i < n; i++) { const b = bufs[i], p = (pos[i] - 1) & masks[i]; if (b[p] < 1e-25 && b[p] > -1e-25) b[p] = 0; }
    }
    out[0] = l * 0.35;
    out[1] = r * 0.35;
    return out;
  }

  /** Cache line buffers, write positions, masks and tap offsets in flat arrays. */
  _bindLines() {
    this.bufs = this.lines.map((ln) => ln.buf);
    this.pos = Int32Array.from(this.lines, (ln) => ln.w);
    this.masks = Int32Array.from(this.lines, (ln) => ln.mask);
    this.dl = Int32Array.from(this.delays);     // write position minus delay = tap
    this._fz = 0;
    return this.bufs;
  }

  /**
   * Block render with sleep: once the input has been silent and the output
   * below -120 dBFS for a full longest-delay period, the network is cleared
   * and later silent blocks cost nothing; any input wakes it.
   * @param {Float32Array|null} inp mono input (null = silence)
   * @param {Float32Array} L
   * @param {Float32Array} [R]
   * @returns {boolean} true if the block was rendered (false = slept, outputs zeroed)
   */
  processBlock(inp, L, R) {
    const len = L.length;
    let loud = false;
    if (inp) for (let i = 0; i < len; i++) if (inp[i] !== 0) { loud = true; break; }
    if (this.asleep && !loud) { L.fill(0); if (R) R.fill(0); return false; }
    this.asleep = false;
    const o = this._o || (this._o = [0, 0]);
    let peak = 0;
    for (let i = 0; i < len; i++) {
      this.process(inp ? inp[i] : 0, o);
      L[i] = o[0];
      if (R) R[i] = o[1];
      const a = Math.abs(o[0]) + Math.abs(o[1]);
      if (a > peak) peak = a;
    }
    if (!loud && peak < 1e-6) {
      this.quiet += len;
      if (this.quiet > this.delays[this.n - 1] * 2) this.sleep();
    } else {
      this.quiet = 0;
    }
    return true;
  }

  /** Clear the network (silent from here on) and skip work until input returns. */
  sleep() {
    for (const line of this.lines) line.buf.fill(0);
    if (this.bufs) this.pos.fill(0);
    this.lp.fill(0);
    this.quiet = 0;
    this.asleep = true;
  }
}

/**
 * Zone presets: low/high T60 (s), network size and critical distance rc (m),
 * where the reverb equals the direct sound. Game estimates; tune by ear.
 */
export const ZONES = {
  openPlain: { t60Low: 0.35, t60High: 0.15, size: 2.0, criticalDistance: 60 },
  coniferForest: { t60Low: 1.6, t60High: 0.7, size: 1.4, criticalDistance: 20 },
  fernSwamp: { t60Low: 0.6, t60High: 0.2, size: 0.8, criticalDistance: 15 },
  rockyGully: { t60Low: 1.2, t60High: 0.9, size: 1.0, criticalDistance: 8 },
  cave: { t60Low: 2.8, t60High: 1.6, size: 1.2, criticalDistance: 3 },
  room: { t60Low: 0.6, t60High: 0.4, size: 0.4, criticalDistance: 2.5 },
};

/**
 * Total stereo energy (left + right) of the network for a unit impulse in.
 * Compared against the direct sound's total power (equal-power pan keeps
 * l^2 + r^2 = 1). Measuring a mono (L+R)/2 fold instead understates the
 * decorrelated reverb by 10log10(4/(1+rho)): 5 dB for this network, 6 dB if fully uncorrelated.
 */
export function reverbEnergy(fs, zone) {
  const rv = new FDNReverb(fs, zone);
  const out = [0, 0];
  let e = 0;
  const n = Math.ceil(fs * zone.t60Low * 1.3);
  for (let i = 0; i < n; i++) {
    rv.process(i === 0 ? 1 : 0, out);
    e += out[0] * out[0] + out[1] * out[1];
  }
  return e;
}

/**
 * Reverb send for a zone so D/R = 0 dB at the zone's critical distance:
 * send x sendGain(rc) = 1 / (rc * sqrt(E_rev)), where the per-source send
 * gain falls ~1 dB per doubling (rc^(-1/6.02)) and is applied before the
 * distance gain.
 */
export function zoneSend(fs, zone, energy = reverbEnergy(fs, zone)) {
  const rc = zone.criticalDistance;
  return 1 / (rc ** (1 - 1 / 6.02) * Math.sqrt(energy));
}
