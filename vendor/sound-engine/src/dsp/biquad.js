/**
 * RBJ-cookbook biquad (direct form I). Coefficients are recomputed only when
 * `set*` is called, so call those per block, not per sample.
 */
export class Biquad {
  constructor(fs) {
    this.fs = fs;
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  _set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }

  _w(f) {
    return 2 * Math.PI * Math.min(Math.max(f, 1), this.fs * 0.49) / this.fs;
  }

  lowpass(f, q = Math.SQRT1_2) {
    const w = this._w(f), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }

  highpass(f, q = Math.SQRT1_2) {
    const w = this._w(f), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }

  /** Constant 0 dB peak gain band-pass. */
  bandpass(f, q = 1) {
    const w = this._w(f), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }

  peaking(f, q, gainDb) {
    const A = 10 ** (gainDb / 40), w = this._w(f), c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }

  process(x) {
    // silent in, silent state: skip the arithmetic (most filters idle most of the time)
    if (x === 0 && this.y1 === 0 && this.y2 === 0 && this.x1 === 0 && this.x2 === 0) return 0;
    let y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    if (y < 1e-25 && y > -1e-25) y = 0;   // flush subnormals so the state can reach exact zero
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  reset() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/**
 * Steep band split: four cascaded band-passes. Single biquads leak the slow
 * neighbour band's tail into short bands (read 36% long in dlist/E19).
 */
export class SteepBand {
  constructor(fs, f, sections = 4, q = 2) {
    this.stages = Array.from({ length: sections }, () => new Biquad(fs).bandpass(f, q));
  }

  process(x) {
    for (const s of this.stages) x = s.process(x);
    return x;
  }
}
