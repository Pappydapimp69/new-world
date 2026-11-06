/**
 * Seeded xorshift32 noise. Deterministic: the same seed gives the same
 * stream, so tests and replays sound identical.
 */
export class Noise {
  /** @param {number} seed non-zero 32-bit seed */
  constructor(seed = 0x9e3779b9) {
    // hash the seed (murmur3 finaliser): raw small seeds made xorshift's first
    // draws tiny and alike, so seeds 7 and 8 took the same random choices
    let h = (seed >>> 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    this.state = h >>> 0 || 1;
  }

  /** @returns {number} uniform in [0, 1) */
  uniform() {
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return x / 4294967296;
  }

  /** @returns {number} uniform in [-1, 1) */
  bipolar() {
    return this.uniform() * 2 - 1;
  }

  /** Exponential gap for a Poisson process of `rate` events per second. */
  exponential(rate) {
    return -Math.log(1 - this.uniform()) / rate;
  }
}
