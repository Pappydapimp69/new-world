/**
 * SN76489-style programmable sound generator (the Mega Drive / Genesis PSG):
 * three square-wave tone channels and one noise channel, each with a 4-bit
 * attenuator in 2 dB steps (15 = off).
 *
 * Squares are band-limited with PolyBLEP: a naive square at 48 kHz folds its
 * harmonics back into the audio band as inharmonic hash, which the real chip
 * (clocked at 3.58 MHz) never produced. Noise uses the chip's own 16-bit LFSR
 * with tap 0x0009, whose period is 57337 rather than the textbook 65535
 * (Brain: genesis-psg E1/E2); periodic mode taps bit 0 only (period 16).
 */

import { DCBlocker } from './smoother.js';

/** PolyBLEP residual for a discontinuity at phase 0 (t in cycles, dt = f / fs). */
function polyBlep(t, dt) {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

/** Linear gain for a 4-bit attenuation (0 = loudest, 15 = off). */
export const psgGain = (att) => (att >= 15 ? 0 : 10 ** (-2 * att / 20));

export const LFSR_WHITE_TAP = 0x0009;
export const LFSR_BITS = 16;

/** One step of the noise LFSR; returns the new state. */
export function lfsrStep(s, white = true) {
  const fb = white ? ((s & 1) ^ ((s >> 3) & 1)) : (s & 1);
  return (s >> 1) | (fb << (LFSR_BITS - 1));
}

class ToneChannel {
  constructor() { this.ph = 0; this.dt = 0; this.att = 15; this.env = null; }
  process() {
    if (this.att >= 15 || this.dt <= 0) return 0;
    this.ph += this.dt;
    if (this.ph >= 1) this.ph -= 1;
    let y = this.ph < 0.5 ? 1 : -1;
    y += polyBlep(this.ph, this.dt);                                  // rising edge at 0
    y -= polyBlep(this.ph >= 0.5 ? this.ph - 0.5 : this.ph + 0.5, this.dt);  // falling edge at 0.5
    return y * psgGain(this.att);
  }
}

class NoiseChannel {
  constructor() { this.s = 1 << (LFSR_BITS - 1); this.acc = 0; this.rate = 0; this.white = true; this.att = 15; this.out = 1; this.env = null; }
  process(fs) {
    if (this.att >= 15) return 0;
    this.acc += this.rate / fs;
    while (this.acc >= 1) { this.acc -= 1; this.s = lfsrStep(this.s, this.white); this.out = (this.s & 1) ? 1 : -1; }
    return this.out * psgGain(this.att);
  }
}

/**
 * PSG with software envelopes, as Genesis games drove it: a note sets an
 * attenuation and then steps it toward 15 at a fixed rate (2 dB per step).
 */
export class PSG {
  constructor(fs, { frameRate = 60 } = {}) {
    this.fs = fs;
    this.tones = [new ToneChannel(), new ToneChannel(), new ToneChannel()];
    this.noise = new NoiseChannel();
    this.chans = [...this.tones, this.noise];
    this.tick = 0;
    this.tickLen = Math.round(fs / frameRate);
    this.gain = 0.12;
    this.dc = new DCBlocker(fs);
  }

  /**
   * @param {object} o
   * @param {number} [o.channel] 0..2 tone, 3 noise
   * @param {number} [o.freq] Hz (tone pitch, or noise shift rate for channel 3)
   * @param {number} [o.velocity] 0..1 (maps to starting attenuation)
   * @param {number} [o.duration] seconds held before the decay starts
   * @param {number} [o.decay] attenuation steps per frame after the hold (0 = hold, then cut)
   * @param {boolean} [o.white] noise mode (default true; false = periodic buzz)
   * @param {number} [o.sweep] semitones per frame of pitch slide (tone channels)
   */
  note({ channel = 0, freq = 440, velocity = 0.8, duration = 0.2, decay = 1, white = true, sweep = 0 } = {}) {
    const att = Math.max(0, Math.min(14, Math.round((1 - velocity) * 10)));
    const hold = Math.max(1, Math.round((duration * this.fs) / this.tickLen));
    const env = { channel, att, hold, decay, sweep, freq };
    if (channel === 3) {
      this.noise.white = white;
      this.noise.rate = freq;
      this.noise.att = att;
      this.noise.env = env;
    } else {
      const ch = this.tones[channel % 3];
      ch.dt = freq / this.fs;
      ch.att = att;
      ch.env = env;
    }
  }

  get active() {
    return this.tones.some((c) => c.att < 15) || this.noise.att < 15 || this.dc.ringing;
  }

  _frame() {
    const chans = this.chans;
    for (let i = 0; i < 4; i++) {
      const ch = chans[i], e = ch.env;
      if (!e || ch.att >= 15) continue;
      if (e.sweep && i < 3) { e.freq *= 2 ** (e.sweep / 12); ch.dt = Math.min(0.45, e.freq / this.fs); }
      if (e.hold > 0) { e.hold--; continue; }
      ch.att = e.decay > 0 ? Math.min(15, ch.att + e.decay) : 15;
    }
  }

  process() {
    if (++this.tick >= this.tickLen) { this.tick = 0; this._frame(); }
    let y = 0;
    for (let i = 0; i < 3; i++) y += this.tones[i].process();
    y += this.noise.process(this.fs);
    return this.dc.process(y * this.gain);
  }
}
