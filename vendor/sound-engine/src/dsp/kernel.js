import { CreatureVoice, CREATURES } from './voice.js';
import { FootstepSynth } from './footstep.js';
import { WaterSource } from './bubbles.js';
import { ModalBank } from './modal.js';
import { SynthVoice } from './synth.js';
import { Sequencer } from './sequencer.js';
import { Spatializer } from './spatial.js';
import { Ramp } from './smoother.js';

const SILENT = 1e-6;          // -120 dBFS
const WAKE = new Set(['call', 'step', 'burst', 'strike', 'note', 'chip', 'sfx', 'water', 'unmute']);

/**
 * Everything one 'se-source' worklet does, as a plain class so it runs and is
 * tested outside the browser: a generator (voice | footsteps | water | modal |
 * synth) feeding the spatializer, rendered a block at a time.
 *
 * Idle sleep: once the generator has been silent for longer than the
 * spatializer's delay plus a margin (so the delayed tail has played out), the
 * kernel clears its state and returns silent blocks without running any DSP.
 * A trigger message wakes it. An idle source used to cost as much as a busy
 * one because the delay line, filters and pan ramps ran every sample.
 */
export class SourceKernel {
  constructor(fs, o = {}) {
    this.fs = fs;
    this.kind = o.kind || 'voice';
    if (this.kind === 'voice') {
      const size = CREATURES[o.creature] || { tract: o.tract ?? 0.7, sac: o.sac ?? 0.35 };
      this.gen = new CreatureVoice(fs, { ...size, seed: o.seed ?? 3 });
    } else if (this.kind === 'footsteps') {
      this.gen = new FootstepSynth(fs, o.seed ?? 7);
    } else if (this.kind === 'water') {
      this.gen = new WaterSource(fs, o.preset || 'stream', o.seed ?? 1);
    } else if (this.kind === 'modal') {
      this.gen = new ModalBank(fs, o.modes || [{ freq: 440, gain: 1 }], o.lossFactor ?? 0.01);
    } else if (this.kind === 'synth') {
      this.gen = new SynthVoice(fs, { patch: o.patch || 'lead' });
    } else {
      throw new Error(`unknown source kind ${this.kind}`);
    }
    this.spatial = new Spatializer(fs, {
      interp: o.interp || 'lagrange4', law: o.law || 'equal-power', binaural: !!o.binaural,
      frameSamples: o.frameSamples, atmosphere: o.atmosphere,
    });
    this.send = new Ramp(o.send ?? 0.2);
    this.mute = new Ramp(1);
    this.alive = true;
    this.out = [0, 0];
    this.quiet = 0;
    this.asleep = false;
    this.canSleep = o.sleep ?? this.kind !== 'water';   // a stream never goes quiet
    this.margin = Math.round(0.05 * fs);
  }

  onMessage(m) {
    if (WAKE.has(m.type)) this.wake();
    const g = this.gen;
    switch (m.type) {
      case 'spatial': this.spatial.update(m.p); if (this.asleep) this.spatial.snap(); break;
      case 'call': this.mute.setTarget(1, 64); g.call?.(m); break;
      case 'step': this.mute.setTarget(1, 64); g.step?.(m); break;
      case 'water': g.setPreset?.(m.preset); break;
      case 'burst': g.burst?.(m.n, m.energy ?? 1); break;
      case 'strike': g.strike?.(m.amp ?? 1, m.brightness ?? 0.5); break;
      case 'note': this.mute.setTarget(1, 64); g.note?.(m); break;
      case 'chip': this.mute.setTarget(1, 64); g.chip?.(m); break;
      case 'sfx': this.mute.setTarget(1, 64); g.sfx?.(m.name, m); break;
      case 'gain': if (g) g.gain = m.value; break;
      case 'size': {
        const s = CREATURES[m.creature] || m;
        g.setSize?.(s.tract, s.sac);
        break;
      }
      case 'send': this.send.setTarget(m.value, 800); break;
      case 'law': this.spatial.law = m.law; this.spatial.binaural = !!m.binaural; break;
      case 'atmosphere': this.spatial.air.setAtmosphere(m.atmosphere); break;
      case 'mute': this.mute.setTarget(0, 256); break;  // stolen: fade fast, never click
      case 'unmute': this.mute.setTarget(1, 2048); break;
      case 'dispose': this.alive = false; break;
    }
  }

  wake() {
    this.asleep = false;
    this.quiet = 0;
  }

  _sleep() {
    this.asleep = true;
    this.spatial.clear();
    this.spatial.snap();
  }

  /**
   * Render one block. L, R: direct stereo; S: mono reverb send (may be null).
   * @returns {boolean} true if DSP ran (false = asleep, outputs zeroed)
   */
  processBlock(L, R, S) {
    const n = L.length;
    if (this.asleep) {
      L.fill(0); if (R) R.fill(0); if (S) S.fill(0);
      return false;
    }
    const sp = this.spatial, out = this.out, gen = this.gen;
    let genPeak = 0, outPeak = 0;
    for (let i = 0; i < n; i++) {
      const x = gen.process() * this.mute.next();
      const ax = x < 0 ? -x : x;
      if (ax > genPeak) genPeak = ax;
      sp.process(x, out);
      L[i] = out[0];
      if (R) R[i] = out[1];
      if (S) S[i] = sp.send * this.send.next();   // tapped before the distance gain
      const ao = Math.abs(out[0]) + Math.abs(out[1]);
      if (ao > outPeak) outPeak = ao;
    }
    if (this.canSleep) {
      if (genPeak < SILENT && outPeak < SILENT && !(gen.active ?? false)) {
        this.quiet += n;
        if (this.quiet > sp.delay.value + sp.delay.target + this.margin) this._sleep();
      } else {
        this.quiet = 0;
      }
    }
    return true;
  }
}

/** Non-spatial music bus: a Sequencer rendered to stereo, sleeping when stopped and silent. */
export class MusicKernel {
  constructor(fs, { song, intensity = 0.5, send = 0.05 } = {}) {
    this.seq = song ? new Sequencer(fs, song, { intensity }) : null;
    this.fs = fs;
    this.sendLevel = send;
    this.out = [0, 0];
    this.volume = new Ramp(1);
    this.alive = true;
  }

  onMessage(m) {
    switch (m.type) {
      case 'song': this.seq = new Sequencer(this.fs, m.song, { intensity: m.intensity ?? this.seq?.intensity ?? 0.5 }); break;
      case 'play': this.seq?.play(); break;
      case 'stop': this.seq?.stop(); break;
      case 'intensity': this.seq?.setIntensity(m.value); break;
      case 'tempo': this.seq?.setTempo(m.bpm); break;
      case 'volume': this.volume.setTarget(m.value, Math.round(0.05 * this.fs)); break;
      case 'dispose': this.alive = false; break;
    }
  }

  processBlock(L, R, S) {
    const seq = this.seq;
    if (!seq || !seq.active) {
      L.fill(0); if (R) R.fill(0); if (S) S.fill(0);
      return false;
    }
    const o = this.out;
    for (let i = 0; i < L.length; i++) {
      seq.process(o);
      const v = this.volume.next();
      L[i] = o[0] * v;
      if (R) R[i] = o[1] * v;
      if (S) S[i] = (o[0] + o[1]) * 0.5 * v * this.sendLevel;
    }
    return true;
  }
}
