/**
 * Terrain occlusion. Maekawa's barrier loss A = 10 log10(3 + 20 N) with
 * N = 2 delta f / c is exactly A = 4.77 dB + 10 log10(1 + f / fc),
 * fc = 3c / (40 delta) = 25.7 / delta Hz: a -3 dB/octave ("half-order")
 * low-pass. A one-pole low-pass (-6 dB/oct) misses by 1.9-3.6 dB; a chain of
 * first-order shelves tracks it within about half a dB (dlist/E21).
 */
const C = 343;

export const maekawaCorner = (delta) => (3 * C) / (40 * Math.max(delta, 1e-4));

/** Exact Maekawa loss in dB (positive = attenuation). */
export function maekawaLoss(f, delta) {
  if (delta <= 0) return 0;
  return 10 * Math.log10(3 + (40 * delta * f) / C);
}

/** One first-order high-shelf cut via the bilinear transform with prewarp. */
class ShelfCut {
  constructor(fs, pole, zero) {
    const k = (f) => Math.tan((Math.PI * Math.min(f, fs * 0.45)) / fs);
    const wp = k(pole), wz = k(zero);
    // H(s) = (1 + s/wz) / (1 + s/wp), mapped with s = (1 - z^-1)/(1 + z^-1)
    const b0 = 1 / wz + 1, b1 = 1 - 1 / wz;
    const a0 = 1 / wp + 1, a1 = 1 - 1 / wp;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.a1 = a1 / a0;
    this.x1 = 0; this.y1 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 - this.a1 * this.y1;
    this.x1 = x; this.y1 = y;
    return y;
  }

  /** magnitude at f, for tests */
  static analogDb(f, pole, zero) {
    return 10 * Math.log10((1 + (f / zero) ** 2) / (1 + (f / pole) ** 2));
  }
}

/**
 * Shelf layout: pole/zero pairs every 0.9 octave from fc, zero = 2^0.4275 x
 * pole, plus a fixed 5.5 dB floor (min-max fitted over 63 Hz-8 kHz for
 * delta 0.02-10 m: within about 0.6 dB of Maekawa).
 */
export function shelfLayout(delta, fs = 48000) {
  const fc = maekawaCorner(delta);
  const spacing = 2 ** 0.9, ratio = 2 ** 0.4275;
  const pairs = [];
  for (let p = fc; p < Math.min(20000, fs * 0.45); p *= spacing) pairs.push([p, p * ratio]);
  return { fc, pairs, floorDb: 5.5 };
}

/** Analog response of the shelf chain in dB of loss, for tests and tooling. */
export function shelfLossDb(f, delta) {
  if (delta <= 0) return 0;
  const { pairs, floorDb } = shelfLayout(delta);
  let loss = floorDb;
  for (const [p, z] of pairs) loss -= ShelfCut.analogDb(f, p, z);
  return loss;
}

/** Streaming occlusion filter. Rebuild with setDelta() when geometry changes a lot. */
export class OcclusionFilter {
  constructor(fs) {
    this.fs = fs;
    this.setDelta(0);
  }

  /** @param {number} delta path difference over the obstacle (m); 0 = clear line of sight */
  setDelta(delta) {
    this.delta = delta;
    if (delta <= 0) {
      this.chain = [];
      this.gain = 1;
      return;
    }
    const { pairs, floorDb } = shelfLayout(delta, this.fs);
    this.chain = pairs.map(([p, z]) => new ShelfCut(this.fs, p, z));
    this.gain = 10 ** (-floorDb / 20);
  }

  process(x) {
    for (const s of this.chain) x = s.process(x);
    return x * this.gain;
  }
}

/** Path difference over a single ridge: source S, listener L, ridge top T (x, y). */
export function ridgeDelta(s, l, t) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const direct = d(s, l);
  // only blocks when the ridge top is above the straight line S-L
  const u = (t[0] - s[0]) / (l[0] - s[0] || 1e-9);
  const lineY = s[1] + u * (l[1] - s[1]);
  if (u <= 0 || u >= 1 || t[1] <= lineY) return 0;
  return d(s, t) + d(t, l) - direct;
}
