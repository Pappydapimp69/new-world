import { FMSynth, FM_PATCHES } from './fm.js';
import { PSG } from './psg.js';

/**
 * Game sound-effect synth: an FM synth and a PSG behind one source, so a
 * spatial source can play FM tones, chip blips or named effects.
 */
export const SFX = {
  laser: { fm: 'laser', midi: 84 },
  jump: { fm: 'jump', midi: 67 },
  coin: { fm: 'coin', midi: 83 },
  hit: { fm: 'hit', midi: 45 },
  explosion: { fm: 'explosion', midi: 33, duration: 0.6 },
  roar: { fm: 'roar', midi: 38, duration: 1.1 },
  blip: { psg: { channel: 0, freq: 880, duration: 0.05, decay: 3 } },
  powerup: { psg: { channel: 1, freq: 330, duration: 0.25, decay: 1, sweep: 1 } },
  crunch: { psg: { channel: 3, freq: 6000, duration: 0.08, decay: 2, white: true } },
};

export class SynthVoice {
  constructor(fs, { patch = 'lead' } = {}) {
    this.fm = new FMSynth(fs, { patch, voices: 6 });
    this.psg = new PSG(fs);
  }

  /** FM note: { midi | freq, velocity, duration, patch }. */
  note(o) { this.fm.note(o); }

  /** PSG note: { channel, freq, velocity, duration, decay, white, sweep }. */
  chip(o) { this.psg.note(o); }

  /** Named effect from SFX; `o` overrides velocity, midi, duration. */
  sfx(name, o = {}) {
    const fx = SFX[name];
    if (!fx) throw new Error(`unknown sfx ${name}`);
    if (fx.fm) this.fm.note({ patch: FM_PATCHES[fx.fm], midi: fx.midi, duration: fx.duration ?? 0.2, velocity: 0.9, ...o });
    if (fx.psg) this.psg.note({ ...fx.psg, velocity: 0.9, ...o });
  }

  get active() { return this.fm.active || this.psg.active; }

  process() { return this.fm.process() + this.psg.process(); }
}
