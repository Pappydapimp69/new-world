/**
 * Air absorption (ISO 9613-1). Loss in dB is linear in distance and grows
 * ~f^2, so one distance-scaled one-pole misses by 1.9-6.2 dB from 100 to
 * 800 m. Instead: fit ONE one-pole section for 25 m and cascade k copies
 * (within 0.89 dB to 200 m); beyond 200 m add a fitted 2nd-order low-pass.
 */
export function airAbsorption(f, tempC = 20, humidity = 70, pressureKPa = 101.325) {
  const pr = 101.325, T0 = 293.15, T01 = 273.16, T = tempC + 273.15, pa = pressureKPa;
  const psat = pr * 10 ** (-6.8346 * (T01 / T) ** 1.261 + 4.6151);
  const h = (humidity * psat) / pa;
  const frO = (pa / pr) * (24 + (4.04e4 * h * (0.02 + h)) / (0.391 + h));
  const frN = (pa / pr) * (T / T0) ** -0.5 * (9 + 280 * h * Math.exp(-4.17 * ((T / T0) ** (-1 / 3) - 1)));
  const z = (0.1068 * Math.exp(-3352 / T)) / (frN + (f * f) / frN);
  const y = (T / T0) ** -2.5 * ((0.01275 * Math.exp(-2239.1 / T)) / (frO + (f * f) / frO) + z);
  return 8.686 * f * f * (1.84e-11 * (pa / pr) ** -1 * (T / T0) ** 0.5 + y); // dB per metre
}

const BANDS = Array.from({ length: 23 }, (_, k) => 63 * 2 ** (k / 3));
import { Biquad } from './biquad.js';

export const SECTION_METRES = 25;
export const MAX_SECTIONS = 8;

/** Min-max fit of a one-pole corner so k sections match ISO loss; returns corner Hz. */
export function fitSectionCorner(atmosphere = {}) {
  const { tempC = 20, humidity = 70, pressureKPa = 101.325 } = atmosphere;
  const target = BANDS.map((f) => airAbsorption(f, tempC, humidity, pressureKPa) * SECTION_METRES);
  let best = [Infinity, 1000];
  for (let fc = 200; fc < 200000; fc *= 1.01) {
    let e = 0;
    BANDS.forEach((f, i) => { e = Math.max(e, Math.abs(10 * Math.log10(1 + (f / fc) ** 2) - target[i])); });
    if (e < best[0]) best = [e, fc];
  }
  return best[1];
}

/** Fitted 2nd-order (Butterworth) corner for the loss beyond 200 m. */
export function fitFarCorner(extraMetres, atmosphere = {}) {
  const { tempC = 20, humidity = 70, pressureKPa = 101.325 } = atmosphere;
  const target = BANDS.map((f) => airAbsorption(f, tempC, humidity, pressureKPa) * extraMetres);
  let best = [Infinity, 20000];
  for (let fc = 200; fc < 100000; fc *= 1.02) {
    let e = 0;
    BANDS.forEach((f, i) => { if (target[i] <= 40) e = Math.max(e, Math.abs(10 * Math.log10(1 + (f / fc) ** 4) - target[i])); });
    if (e < best[0]) best = [e, fc];
  }
  return best[1];
}

/** Analog loss (dB) of the near-range model at frequency f and distance d, for tests. */
export function modelLossDb(f, d, corner) {
  const k = Math.min(MAX_SECTIONS, d / SECTION_METRES);
  return k * 10 * Math.log10(1 + (f / corner) ** 2);
}

/**
 * Streaming air-absorption filter: up to 8 one-pole sections; the output
 * blends adjacent taps of the cascade for fractional section counts so
 * distance changes glide instead of stepping.
 */
export class AirFilter {
  constructor(fs, atmosphere) {
    this.fs = fs;
    this.s = new Float64Array(MAX_SECTIONS);
    this.k = 0;
    this.far = null;
    this.farMetres = 0;
    this.setAtmosphere(atmosphere);
  }

  setAtmosphere(atmosphere = {}) {
    this.atmosphere = atmosphere;
    this.corner = fitSectionCorner(atmosphere);
    const fc = Math.min(this.corner, this.fs * 0.45);
    this.a = Math.exp((-2 * Math.PI * fc) / this.fs);
  }

  /** @param {number} distance metres */
  setDistance(distance) {
    this.k = Math.min(MAX_SECTIONS, Math.max(0, distance / SECTION_METRES));
    const extra = distance - MAX_SECTIONS * SECTION_METRES;
    if (extra > 5) {
      if (!this.far || Math.abs(extra - this.farMetres) > 10) {   // refit only on real change
        this.farMetres = extra;
        const fc = fitFarCorner(extra, this.atmosphere);
        (this.far ||= new Biquad(this.fs)).lowpass(fc, Math.SQRT1_2);
      }
    } else {
      this.far = null;
    }
  }

  process(x) {
    const kInt = Math.floor(this.k), frac = this.k - kInt;
    const a = this.a, b = 1 - a;
    const n = Math.min(MAX_SECTIONS, kInt + (frac > 0 ? 1 : 0));
    let prev = x, atK = x;                 // atK: output after kInt sections
    for (let i = 0; i < n; i++) {
      this.s[i] = b * prev + a * this.s[i];
      prev = this.s[i];
      if (i === kInt - 1) atK = prev;
    }
    // fractional count: blend the tap after kInt sections with the next one
    let y = frac > 0 && n > kInt ? (1 - frac) * atK + frac * this.s[kInt] : atK;
    if (this.far) y = this.far.process(y);
    return y;
  }
}
