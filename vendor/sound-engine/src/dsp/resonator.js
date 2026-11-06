/**
 * Impulse-invariant two-pole resonator: an impulse of size A produces exactly
 * A * sin(2 pi f t) * exp(-d t). Linear, so many impulses sum to many
 * independent decaying sinusoids, which is what makes a resonator bank equal
 * to one-voice-per-event synthesis (dlist/E15).
 */
export class Resonator {
  /**
   * @param {number} fs sample rate
   * @param {number} freq Hz
   * @param {number} decay amplitude decay rate d in 1/s (T60 = 6.9078 / d)
   */
  constructor(fs, freq, decay) {
    this.fs = fs;
    this.y1 = this.y2 = 0;
    this.pending = 0;
    this.x1 = 0;
    this.tune(freq, decay);
  }

  tune(freq, decay) {
    const w = 2 * Math.PI * Math.min(freq, this.fs * 0.49) / this.fs;
    const r = Math.exp(-decay / this.fs);
    this.a1 = 2 * r * Math.cos(w);
    this.a2 = -r * r;
    this.b1 = r * Math.sin(w);
    this.freq = freq;
    this.decay = decay;
  }

  /** Add an impulse that rings from the next sample on. */
  excite(amp) {
    this.pending += amp;
  }

  process(x = 0) {
    const y = this.b1 * this.x1 + this.a1 * this.y1 + this.a2 * this.y2;
    this.x1 = x + this.pending;
    this.pending = 0;
    this.y2 = this.y1;
    this.y1 = y;
    // flush subnormals so silent banks cost nothing and terminate
    if (Math.abs(this.y1) < 1e-30 && Math.abs(this.y2) < 1e-30) this.y1 = this.y2 = 0;
    return y;
  }

  /** @returns {boolean} true while still ringing above -120 dB of unit */
  get active() {
    return this.y1 !== 0 || this.y2 !== 0 || this.x1 !== 0 || this.pending !== 0;
  }
}

/** T60 in seconds to a decay rate d in 1/s. */
export const t60ToDecay = (t60) => 6.907755 / t60;
