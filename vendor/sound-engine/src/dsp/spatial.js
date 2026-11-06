import { DelayLine } from './delayline.js';
import { Ramp } from './smoother.js';
import { OcclusionFilter } from './occlusion.js';
import { AirFilter } from './air.js';
import { panGains } from './panlaw.js';

export const SPEED_OF_SOUND = 343;
export const HEAD_RADIUS = 0.0875;

/** Woodworth interaural time difference (s) for a lateral angle theta (rad). */
export const woodworthITD = (theta) => (HEAD_RADIUS / SPEED_OF_SOUND) * (theta + Math.sin(theta));

/**
 * Per-frame spatial parameters for one source, from world positions.
 * Pure function: safe to unit-test and to run on the main thread.
 * @param {{x:number,y:number,z?:number,yaw?:number}} listener yaw in radians, 0 = facing +y
 * @param {{x:number,y:number,z?:number}} source
 * @param {object} [o]
 * @param {number} [o.refDistance] distance with 0 dB attenuation
 * @param {number} [o.rolloff] 1 = inverse distance (-6 dB per doubling)
 * @param {number} [o.occlusionDelta] path difference over terrain (m)
 * @returns {{distance:number, gain:number, sendGain:number, pan:number, delay:number, occlusionDelta:number}}
 */
export function spatialize(listener, source, { refDistance = 1, rolloff = 1, occlusionDelta = 0 } = {}) {
  const dx = source.x - listener.x, dy = source.y - listener.y, dz = (source.z ?? 0) - (listener.z ?? 0);
  const distance = Math.max(1e-3, Math.hypot(dx, dy, dz));
  const gain = refDistance / Math.max(refDistance, refDistance + rolloff * (distance - refDistance));
  // reverb send falls only ~1 dB per doubling, so the direct-to-reverberant
  // ratio carries distance (a post-distance send held it constant)
  const sendGain = (refDistance / Math.max(refDistance, distance)) ** (1 / 6.02);
  const yaw = listener.yaw ?? 0;
  const rx = Math.cos(yaw), ry = -Math.sin(yaw);   // right vector when facing (sin yaw, cos yaw)
  const pan = Math.max(-1, Math.min(1, (dx * rx + dy * ry) / (Math.hypot(dx, dy) || 1e-9)));
  return { distance, gain, sendGain, pan, delay: distance / SPEED_OF_SOUND, occlusionDelta };
}

/**
 * Streaming spatializer: mono in, stereo direct out plus a mono reverb send.
 *  - distance delay through a fractional delay line (Doppler, Lagrange)
 *  - terrain occlusion (Maekawa shelf chain), applied to direct and send
 *  - air absorption (cascaded 25 m sections) on the direct path
 *  - distance gain on the direct path only; the send is tapped before it
 *  - pan law, plus a fractional Woodworth ITD when `binaural` (headphones)
 * Every target is ramped per sample across one frame.
 */
export class Spatializer {
  constructor(fs, { maxDistance = 400, interp = 'lagrange4', law = 'equal-power', binaural = false, frameSamples, atmosphere } = {}) {
    this.fs = fs;
    this.line = new DelayLine(Math.ceil((maxDistance / SPEED_OF_SOUND) * fs) + 8);
    this.maxDelay = (maxDistance / SPEED_OF_SOUND) * fs;
    this.interp = interp;
    this.law = law;
    this.binaural = binaural;
    this.frame = frameSamples ?? Math.round(fs / 60);
    this.delay = new Ramp(8);
    this.gain = new Ramp(0);
    this.sendGain = new Ramp(0);
    this.left = new Ramp(0);
    this.right = new Ramp(0);
    this.itdL = new Ramp(0);
    this.itdR = new Ramp(0);
    this.itdLine = new DelayLine(64);
    this.occ = new OcclusionFilter(fs);
    this.air = new AirFilter(fs, atmosphere);
    this.send = 0;
    this.started = false;
  }

  /** Feed the latest spatialize() result (call once per game frame). */
  update(p) {
    const d = Math.min(this.maxDelay, Math.max(4, p.delay * this.fs));
    const [l, r] = panGains(p.pan, this.law);
    let il = 0, ir = 0;
    if (this.binaural) {
      const itd = woodworthITD(Math.asin(Math.min(1, Math.abs(p.pan)))) * this.fs;
      if (p.pan > 0) il = itd; else ir = itd;   // the far ear hears it later
    }
    const targets = [[this.delay, d], [this.gain, p.gain], [this.sendGain, p.sendGain ?? 1],
      [this.left, l], [this.right, r], [this.itdL, il], [this.itdR, ir]];
    for (const [ramp, v] of targets) {
      if (this.started) ramp.setTarget(v, this.frame); else ramp.reset(v);
    }
    this.started = true;
    if (Math.abs((p.occlusionDelta ?? 0) - this.occ.delta) > 0.01) this.occ.setDelta(p.occlusionDelta ?? 0);
    this.air.setDistance(p.distance ?? p.delay * SPEED_OF_SOUND);
  }

  /** Jump every ramp to its target (only while silent, e.g. a sleeping source). */
  snap() {
    for (const r of [this.delay, this.gain, this.sendGain, this.left, this.right, this.itdL, this.itdR]) r.reset(r.target);
  }

  /** Zero the delay lines and filter states (only while silent). */
  clear() {
    this.line.buf.fill(0);
    this.itdLine.buf.fill(0);
    this.air.s.fill(0);
    this.air.far?.reset();
    for (const c of this.occ.chain) { c.x1 = 0; c.y1 = 0; }
    this.send = 0;
  }

  /**
   * @param {number} x mono sample
   * @param {number[]} out receives [left, right]; `this.send` receives the mono send
   */
  process(x, out) {
    this.line.write(x);
    const y = this.occ.process(this.line.read(this.delay.next(), this.interp));
    this.send = y * this.sendGain.next();
    const direct = this.air.process(y) * this.gain.next();
    const l = this.left.next(), r = this.right.next();
    const dl = this.itdL.next(), dr = this.itdR.next();
    if (this.binaural || dl || dr) {
      this.itdLine.write(direct);
      out[0] = this.itdLine.read(2 + dl, 'lagrange4') * l;
      out[1] = this.itdLine.read(2 + dr, 'lagrange4') * r;
    } else {
      out[0] = direct * l;
      out[1] = direct * r;
    }
    return out;
  }
}
