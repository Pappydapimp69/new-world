/* AudioWorklet processors. Load with
 *   await ctx.audioWorklet.addModule(new URL('./processors.js', import.meta.url))
 * All DSP lives in ../dsp so it is unit-tested outside the browser; these
 * classes only move blocks between the kernels and the Web Audio graph. */
import { SourceKernel, MusicKernel } from '../dsp/kernel.js';
import { FDNReverb, ZONES } from '../dsp/fdn.js';

/**
 * One sound source: a generator (voice | footsteps | water | modal | synth)
 * feeding a spatializer (Doppler delay, occlusion, distance gain, pan).
 * Output 0: stereo direct. Output 1: mono reverb send.
 * Idle sources sleep (no DSP) until a trigger message wakes them.
 */
class SourceProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.k = new SourceKernel(sampleRate, options.processorOptions || {});
    this.port.onmessage = (e) => this.k.onMessage(e.data);
  }

  onMessage(m) { this.k.onMessage(m); }

  /** True while the kernel is skipping DSP (silent and drained). */
  get asleep() { return this.k.asleep; }

  /** Upper bound on the silent samples before sleep: the longest delay plus the kernel's margin. */
  get sleepAfter() { return Math.ceil(this.k.spatial.maxDelay) + this.k.margin; }

  process(inputs, outputs) {
    const [L, R] = outputs[0];
    const S = outputs[1] && outputs[1][0];
    this.k.processBlock(L, R, S);
    return this.k.alive;
  }
}

/**
 * Music bus: sequencer with FM and PSG instruments, stereo, not spatialized.
 * Output 0: stereo. Output 1: mono reverb send.
 * Messages: {type:'song', song}, {type:'play'}, {type:'stop'},
 * {type:'intensity', value}, {type:'tempo', bpm}, {type:'volume', value}.
 */
class MusicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.k = new MusicKernel(sampleRate, options.processorOptions || {});
    this.port.onmessage = (e) => this.k.onMessage(e.data);
  }

  process(inputs, outputs) {
    const [L, R] = outputs[0];
    const S = outputs[1] && outputs[1][0];
    this.k.processBlock(L, R, S);
    return this.k.alive;
  }
}

/**
 * Shared FDN reverb bus: mono in, stereo out.
 * Zone changes on the same network size glide the absorption coefficients
 * (seamless); a size change runs a second network and equal-power crossfades
 * (the two are uncorrelated: linear dipped -2.2 dB, equal-power held).
 * A silent bus sleeps (no DSP) until input returns.
 * Messages: {type:'zone', name} | {type:'decay', t60Low, t60High, size}.
 */
class ReverbProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const z = ZONES[(options.processorOptions || {}).zone] || ZONES.openPlain;
    this.a = new FDNReverb(sampleRate, z);
    this.size = z.size;
    this.b = null;
    this.fade = 0;
    this.fadeLen = Math.round(0.4 * sampleRate);
    this.oa = [0, 0];
    this.ob = [0, 0];
    this.port.onmessage = (e) => {
      const m = e.data;
      const z2 = m.type === 'zone' ? ZONES[m.name] : m.type === 'decay' ? { ...m, size: m.size ?? this.size } : null;
      if (!z2) return;
      if (Math.abs((z2.size ?? this.size) - this.size) < 1e-6) {
        this.a.glideDecay(z2.t60Low, z2.t60High);
      } else {
        if (this.b) { this.a = this.b; }           // finish any fade in progress at once
        this.a.asleep = false;
        this.b = new FDNReverb(sampleRate, z2);
        this.size = z2.size;
        this.fade = 0;
      }
    };
  }

  /** Upper bound on the silent samples before the bus sleeps: about -130 dB of the low-band tail. */
  get sleepAfter() { return Math.round((this.a.t60Low * 2.2 + 0.2) * sampleRate); }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const [L, R] = outputs[0];
    if (!this.b) {
      this.a.processBlock(inp || null, L, R);
      return true;
    }
    for (let i = 0; i < L.length; i++) {
      const x = inp ? inp[i] : 0;
      this.a.process(x, this.oa);
      if (this.b) {
        this.b.process(x, this.ob);
        const u = Math.min(1, this.fade++ / this.fadeLen);
        const ga = Math.cos(u * Math.PI / 2), gb = Math.sin(u * Math.PI / 2);
        L[i] = ga * this.oa[0] + gb * this.ob[0];
        if (R) R[i] = ga * this.oa[1] + gb * this.ob[1];
        if (u >= 1) { this.a = this.b; this.b = null; }
      } else {
        L[i] = this.oa[0];
        if (R) R[i] = this.oa[1];
      }
    }
    return true;
  }
}

registerProcessor('se-source', SourceProcessor);
registerProcessor('se-music', MusicProcessor);
registerProcessor('se-reverb', ReverbProcessor);
