/**
 * Circular delay line with fractional reads. Doppler is a read position that
 * slides by v/c samples per sample; a fraction-dependent interpolator then
 * amplitude-modulates the signal. Linear left 8 kHz spurs at -29 dB whether
 * walking or sprinting; 4-point Lagrange -43 dB, 6-point -57 dB (dlist/E23).
 */
export class DelayLine {
  /** @param {number} maxSamples longest delay needed */
  constructor(maxSamples) {
    let n = 8;
    while (n < maxSamples + 8) n <<= 1;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
    this.w = 0;
  }

  write(x) {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }

  /**
   * Read `delay` samples behind the most recent write.
   * @param {number} delay fractional delay in samples (>= 3 for lagrange6)
   * @param {'linear'|'lagrange4'|'lagrange6'} mode
   */
  read(delay, mode = 'lagrange4') {
    const pos = this.w - 1 - delay;
    const i = Math.floor(pos);
    const a = pos - i;
    const b = this.buf, m = this.mask;
    // indexed reads, no per-call closure: this runs once per sample per source
    if (mode === 'linear') return (1 - a) * b[i & m] + a * b[(i + 1) & m];
    if (mode === 'lagrange6') {
      // closed-form 6-point Lagrange weights for nodes -2..3
      const am2 = a + 2, am1 = a + 1, a1 = a - 1, a2 = a - 2, a3 = a - 3;
      const p01 = am2 * am1, p23 = a * a1, p45 = a2 * a3;
      return -(am1 * p23 * p45) / 120 * b[(i - 2) & m]
        + (am2 * p23 * p45) / 24 * b[(i - 1) & m]
        - (p01 * a1 * p45) / 12 * b[i & m]
        + (p01 * a * p45) / 12 * b[(i + 1) & m]
        - (p01 * p23 * a3) / 24 * b[(i + 2) & m]
        + (p01 * p23 * a2) / 120 * b[(i + 3) & m];
    }
    const xm1 = b[(i - 1) & m], x0 = b[i & m], x1 = b[(i + 1) & m], x2 = b[(i + 2) & m];
    return (-a * (a - 1) * (a - 2) / 6) * xm1
      + ((a + 1) * (a - 1) * (a - 2) / 2) * x0
      - ((a + 1) * a * (a - 2) / 2) * x1
      + ((a + 1) * a * (a - 1) / 6) * x2;
  }

  /** Integer tap, used by the reverb. */
  tap(delay) {
    return this.buf[(this.w - 1 - delay) & this.mask];
  }
}
