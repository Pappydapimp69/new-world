import { Resonator } from './resonator.js';

/**
 * Bank of ringing modes. Per-mode T60 = 2.2 / (eta f) for a material loss
 * factor eta, so high modes die first, as they do in wood and stone.
 */
export class ModalBank {
  /**
   * @param {number} fs sample rate
   * @param {{freq:number, gain:number, t60?:number}[]} modes
   * @param {number} lossFactor eta, used when a mode has no t60
   */
  constructor(fs, modes, lossFactor = 0.01) {
    this.modes = modes.map((m) => {
      const t60 = m.t60 ?? 2.2 / (lossFactor * m.freq);
      return { gain: m.gain, r: new Resonator(fs, m.freq, 6.907755 / t60) };
    });
  }

  /** Strike with an amplitude and a brightness 0..1 that tilts mode gains. */
  strike(amp, brightness = 0.5) {
    const n = this.modes.length;
    this.modes.forEach((m, i) => {
      const tilt = n > 1 ? brightness ** (i / (n - 1)) * (1 - brightness) ** (1 - i / (n - 1)) * 2 : 1;
      m.r.excite(amp * m.gain * Math.max(tilt, 0.05));
    });
  }

  process() {
    let y = 0;
    const modes = this.modes;
    for (let i = 0; i < modes.length; i++) {
      const r = modes[i].r;
      if (r.active) y += r.process();   // a silent resonator outputs exactly 0
    }
    return y;
  }
}

/**
 * Inharmonic mode sets for game surfaces, scaled by a size factor
 * (bigger slab or log -> lower modes). Ratios loosely follow free plates and
 * bars; loss factors are game estimates (wood ~0.01, stone ~0.01-0.02).
 */
export const SURFACE_MODES = {
  sandstone: { base: 900, ratios: [1, 1.59, 2.14, 2.65, 3.6, 4.15], loss: 0.015 },
  wood: { base: 260, ratios: [1, 2.76, 5.4, 8.93], loss: 0.01 },
  bone: { base: 1400, ratios: [1, 2.76, 5.4], loss: 0.02 },
};

export function surfaceBank(fs, name, size = 1) {
  const s = SURFACE_MODES[name];
  if (!s) return null;
  const modes = s.ratios.map((r, i) => ({ freq: (s.base * r) / size, gain: 1 / (1 + i) }));
  return new ModalBank(fs, modes, s.loss);
}
