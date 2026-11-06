import { spatialize } from '../dsp/spatial.js';
import { lawForDevice } from '../dsp/panlaw.js';
import { ZONES, zoneSend } from '../dsp/fdn.js';
import { VoiceAllocator } from './voiceAllocator.js';
import { SFX } from '../dsp/synth.js';

const DEFAULT_WORKLET = new URL('../worklet/processors.js', import.meta.url);
const dbOf = (g) => 20 * Math.log10(Math.max(g, 1e-6));

/**
 * Main-thread engine. Owns the AudioContext graph:
 *   sources (AudioWorklet 'se-source') -> master -> limiter -> destination
 *                                     \-> reverb send -> 'se-reverb' (FDN) -> master
 * Call `update()` once per game frame after moving the listener and sources.
 */
export class SoundEngine {
  /**
   * @param {object} [o]
   * @param {BaseAudioContext} [o.context] existing context (or OfflineAudioContext for tests)
   * @param {string|URL} [o.workletUrl] where processors.js is served
   * @param {number} [o.maxVoices] concurrent sounding sources (default 24)
   * @param {'headphones'|'stereo'|'mono'|'unknown'} [o.device] picks the pan law
   * @param {string} [o.zone] reverb zone preset (see ZONES)
   * @param {number} [o.fps] game frame rate used to size parameter ramps
   * @param {AudioNode} [o.destination] where the limiter feeds (default ctx.destination),
   *   e.g. a game's own sound-effects bus so its volume setting applies
   */
  static async create(o = {}) {
    const ctx = o.context || new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(o.workletUrl || DEFAULT_WORKLET);
    return new SoundEngine(ctx, o);
  }

  constructor(ctx, { maxVoices = 24, device = 'headphones', zone = 'openPlain', fps = 60, atmosphere, destination } = {}) {
    this.ctx = ctx;
    this.atmosphere = atmosphere || { tempC: 20, humidity: 70 };
    this._sends = {};
    this.fps = fps;
    this.frameSamples = Math.round(ctx.sampleRate / fps);
    this.device = device;
    this.law = lawForDevice(device);
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.sources = new Set();
    this.alloc = new VoiceAllocator(maxVoices);
    this._id = 0;

    this.masterLevel = 0.8;
    this.master = new GainNode(ctx, { gain: this.masterLevel });
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -6, knee: 0, ratio: 20, attack: 0.002, release: 0.15 });
    this.master.connect(this.limiter).connect(destination || ctx.destination);

    this.reverbIn = new GainNode(ctx, { gain: 1 });
    this.reverb = new AudioWorkletNode(ctx, 'se-reverb', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { zone },
    });
    this.reverbIn.connect(this.reverb).connect(this.master);
    this.setZone(zone);
  }

  /** Resume audio after a user gesture (browsers start contexts suspended). */
  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Reverb send for a zone, sized so D/R = 0 dB at its critical distance. */
  zoneSend(name = this.zone) {
    return (this._sends[name] ??= zoneSend(this.ctx.sampleRate, ZONES[name]));
  }

  setZone(name) {
    const z = ZONES[name];
    if (!z) throw new Error(`unknown zone ${name}`);
    this.zone = name;
    this.reverb.port.postMessage({ type: 'zone', name });
    const send = this.zoneSend(name);
    for (const s of this.sources) s.node.port.postMessage({ type: 'send', value: send });
  }

  /** Headphones get the Woodworth ITD on top of the pan law. */
  get binaural() {
    return this.device === 'headphones';
  }

  /** Pan law by output device (dlist/E26). */
  setDevice(device) {
    this.device = device;
    this.law = lawForDevice(device);
    for (const s of this.sources) s.node.port.postMessage({ type: 'law', law: this.law, binaural: this.binaural });
  }

  /** Temperature (C) and relative humidity (%) for air absorption. */
  setAtmosphere(atmosphere) {
    this.atmosphere = { ...this.atmosphere, ...atmosphere };
    for (const s of this.sources) s.node.port.postMessage({ type: 'atmosphere', atmosphere: this.atmosphere });
  }

  setListener({ x, y, z, yaw }) {
    Object.assign(this.listener, { x: x ?? this.listener.x, y: y ?? this.listener.y, z: z ?? this.listener.z, yaw: yaw ?? this.listener.yaw });
  }

  setMasterVolume(v) {
    this.masterLevel = v;
    this._applyMaster();
  }

  /**
   * Master gain = level / sqrt(effective active sources), where each active
   * source counts by its power relative to the loudest. Uncorrelated sources
   * add in power: a fixed gain made 24 sources +13.8 dB louder than one and
   * sent 63% of samples into the limiter; 1/sqrt(N) held loudness flat.
   */
  _applyMaster() {
    let maxP = 0, sum = 0;
    for (const v of this.alloc.voices.values()) {
      const p = 10 ** (v.level / 10);
      sum += p; maxP = Math.max(maxP, p);
    }
    const nEff = maxP > 0 ? Math.max(1, sum / maxP) : 1;
    const target = this.masterLevel / Math.sqrt(nEff);
    if (Math.abs(target - (this._masterTarget ?? -1)) < 1e-3) return;
    this._masterTarget = target;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(target, t + 4 / this.fps); // ramp, never step (dlist/E25)
  }

  /**
   * Create a source.
   * @param {'voice'|'footsteps'|'water'|'modal'|'synth'} kind
   * @param {object} [o] { creature, tract, sac, preset, modes, patch, position:{x,y,z},
   *   level: nominal level in dB at 1 m (for voice stealing), priority (dB),
   *   interp: 'linear'|'lagrange4'|'lagrange6', seed }
   */
  createSource(kind, o = {}) {
    const src = new Source(this, kind, o, ++this._id);
    this.sources.add(src);
    src._spatial();
    return src;
  }

  /**
   * Adaptive music bus (not spatialized): a step-sequenced song on FM and PSG
   * instruments whose layers follow `setIntensity(0..1)`. See dsp/sequencer.js
   * for the song format; `DEMO_SONG` is a ready example.
   */
  createMusic(song, { intensity = 0.5, volume = 0.7, send = 0.05 } = {}) {
    return new Music(this, song, { intensity, volume, send });
  }

  /** Push spatial targets for every source and rebalance the master; call once per frame. */
  update() {
    for (const s of this.sources) s._spatial();
    this._applyMaster();
  }

  dispose() {
    for (const s of [...this.sources]) s.dispose();
    this.reverb.disconnect();
    this.master.disconnect();
    this.limiter.disconnect();
  }
}

export class Source {
  constructor(engine, kind, o, id) {
    this.engine = engine;
    this.kind = kind;
    this.id = id;
    this.position = { x: 0, y: 0, z: 0, ...(o.position || {}) };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.level = o.level ?? (kind === 'voice' ? 100 : kind === 'footsteps' ? 75 : kind === 'synth' ? 85 : 65);
    this.priority = o.priority ?? 0;
    this.occlusionDelta = 0;
    this.refDistance = o.refDistance ?? 1;
    this.until = 0;
    this.continuous = kind === 'water';
    const ctx = engine.ctx;
    this.node = new AudioWorkletNode(ctx, 'se-source', {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [2, 1],
      processorOptions: {
        kind,
        creature: o.creature, tract: o.tract, sac: o.sac,
        preset: o.preset, modes: o.modes, lossFactor: o.lossFactor, patch: o.patch,
        interp: o.interp || (kind === 'voice' ? 'lagrange4' : 'lagrange6'),
        law: engine.law,
        binaural: engine.binaural,
        atmosphere: engine.atmosphere,
        frameSamples: engine.frameSamples,
        send: engine.zoneSend(),
        seed: o.seed ?? id,
      },
    });
    this.node.connect(engine.master, 0);
    this.node.connect(engine.reverbIn, 1);
    if (this.continuous) this._claim(Infinity);
  }

  setPosition(x, y, z = 0) {
    Object.assign(this.position, { x, y, z });
    return this;
  }

  /** Path difference over terrain between source and listener, in metres (0 = clear). */
  setOcclusion(delta) {
    this.occlusionDelta = Math.max(0, delta);
    return this;
  }

  /** Level at the listener now, in dB (for stealing). */
  audibleLevel(p) {
    return this.level + dbOf(p.gain) - (this.occlusionDelta > 0 ? 10 : 0);
  }

  _spatial() {
    const e = this.engine;
    const p = spatialize(e.listener, this.position, { refDistance: this.refDistance, occlusionDelta: this.occlusionDelta });
    this._last = p;
    this.node.port.postMessage({ type: 'spatial', p });
    if (this.continuous && !this.until && this._claim(Infinity)) {
      this.node.port.postMessage({ type: 'unmute' });   // a stolen loop comes back when room frees
    }
    if (this.until && e.ctx.currentTime > this.until) {
      e.alloc.release(this.id);
      this.until = 0;
    } else if (this.until) {
      e.alloc.setLevel(this.id, this.audibleLevel(p));
    }
  }

  _claim(duration) {
    const e = this.engine;
    const p = this._last || spatialize(e.listener, this.position);
    const lvl = this.audibleLevel(p);
    if (this.until) { // already holding a voice: extend
      this.until = Math.max(this.until, e.ctx.currentTime + duration);
      e.alloc.setLevel(this.id, lvl);
      return true;
    }
    const r = e.alloc.request(this.id, lvl, this.priority);
    if (!r.accepted) return false;
    if (r.steal !== null) {
      for (const s of e.sources) if (s.id === r.steal) s._stolen();
    }
    this.until = e.ctx.currentTime + duration;
    return true;
  }

  _stolen() {
    this.until = 0;
    this.node.port.postMessage({ type: 'mute' });
  }

  /**
   * Creature call: { mode:'open'|'closed', duration, f0, f0End, amp, intensity, roughness,
   * breath, jitter, vibrato, vibratoRate, mouth, attack }. `intensity` 0..1 makes
   * the call louder and brighter; `mouth` glides the formants as the jaw opens.
   */
  call(o = {}) {
    if (this.kind !== 'voice') throw new Error('call() needs a voice source');
    if (!this._claim((o.duration ?? 1.2) + 0.5)) return false;
    this.node.port.postMessage({ type: 'call', ...o });
    return true;
  }

  /** FM note on a 'synth' source: { midi | freq, velocity, duration, patch }. Velocity drives brightness. */
  note(o = {}) {
    this._synthOnly('note');
    if (!this._claim((o.duration ?? 0.3) + 1)) return false;
    this.node.port.postMessage({ type: 'note', ...o });
    return true;
  }

  /** PSG (chip) note on a 'synth' source: { channel 0-2 tone | 3 noise, freq, velocity, duration, decay, white, sweep }. */
  chip(o = {}) {
    this._synthOnly('chip');
    if (!this._claim((o.duration ?? 0.2) + 0.5)) return false;
    this.node.port.postMessage({ type: 'chip', ...o });
    return true;
  }

  /** Named effect on a 'synth' source: laser, jump, coin, hit, explosion, roar, blip, powerup, crunch. */
  sfx(name, o = {}) {
    this._synthOnly('sfx');
    if (!SFX[name]) throw new Error(`unknown sfx ${name}`);
    if (!this._claim((SFX[name].duration ?? 0.3) + 1.2)) return false;
    this.node.port.postMessage({ type: 'sfx', name, ...o });
    return true;
  }

  _synthOnly(what) {
    if (this.kind !== 'synth') throw new Error(`${what}() needs a synth source`);
  }

  /** Footstep: { mass, speed, surface, claws, gain }. */
  step(o) {
    if (this.kind !== 'footsteps') throw new Error('step() needs a footsteps source');
    if (!this._claim(0.4)) return false;
    this.node.port.postMessage({ type: 'step', ...o });
    return true;
  }

  /** Water preset: 'drip' | 'stream' | 'rain' | 'splash' or a custom object. */
  setWater(preset) {
    this.node.port.postMessage({ type: 'water', preset });
    return this;
  }

  /** Bubble burst for splashes. */
  splash(n = 40, energy = 1) {
    if (!this._claim(0.3)) return false;
    this.node.port.postMessage({ type: 'burst', n, energy });
    return true;
  }

  /** Strike a modal source. */
  strike(amp = 1, brightness = 0.5) {
    if (!this._claim(2)) return false;
    this.node.port.postMessage({ type: 'strike', amp, brightness });
    return true;
  }

  setCreature(creature) {
    this.node.port.postMessage({ type: 'size', creature });
    return this;
  }

  dispose() {
    this.engine.alloc.release(this.id);
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    this.engine.sources.delete(this);
  }
}

/** Music bus handle returned by `engine.createMusic()`. */
export class Music {
  constructor(engine, song, { intensity, volume, send }) {
    this.engine = engine;
    this.node = new AudioWorkletNode(engine.ctx, 'se-music', {
      numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 1],
      processorOptions: { song, intensity, send },
    });
    this.gain = new GainNode(engine.ctx, { gain: volume });
    this.node.connect(this.gain, 0).connect(engine.master);
    this.node.connect(engine.reverbIn, 1);
  }

  play() { this.node.port.postMessage({ type: 'play' }); return this; }
  stop() { this.node.port.postMessage({ type: 'stop' }); return this; }
  /** 0 calm .. 1 danger: layers change on the next bar line; dynamics follow at once. */
  setIntensity(value) { this.node.port.postMessage({ type: 'intensity', value }); return this; }
  setTempo(bpm) { this.node.port.postMessage({ type: 'tempo', bpm }); return this; }
  setSong(song) { this.node.port.postMessage({ type: 'song', song }); return this; }
  setVolume(v) {
    const t = this.engine.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(v, t + 0.05);
    return this;
  }

  dispose() {
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    this.gain.disconnect();
  }
}
