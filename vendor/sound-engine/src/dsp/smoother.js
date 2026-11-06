/**
 * Per-sample linear ramp toward a target. Game code writes targets once per
 * frame; ramping across the next frame removes the staircase that raw
 * frame-rate writes leave (60 fps steps on a 12 dB/s fade spur at -49 dB,
 * a ramp matches per-sample gain at -72 dB; see dlist/E25).
 */
export class Ramp {
  constructor(value = 0) {
    this.value = value;
    this.target = value;
    this.step = 0;
    this.remaining = 0;
  }

  /**
   * @param {number} target value to reach
   * @param {number} samples ramp length; use one frame (e.g. 800 at 48 kHz / 60 fps)
   */
  setTarget(target, samples) {
    this.target = target;
    if (samples <= 0) {
      this.value = target;
      this.remaining = 0;
      this.step = 0;
      return;
    }
    this.remaining = Math.round(samples);
    this.step = (target - this.value) / this.remaining;
  }

  /** Jump without a ramp (use only while silent). */
  reset(value) {
    this.value = this.target = value;
    this.remaining = 0;
    this.step = 0;
  }

  next() {
    if (this.remaining > 0) {
      this.value += this.step;
      if (--this.remaining === 0) this.value = this.target;
    }
    return this.value;
  }
}

/**
 * DC blocker: one-pole high-pass at `corner` Hz (default 10). FM with
 * operator ratios 1:1 or 2:1 puts a sideband at 0 Hz (the demo's bass and
 * lead patches carried -39 to -41 dBFS of DC); the Mega Drive's output was
 * AC-coupled through capacitors, so this is also what the hardware did.
 */
export class DCBlocker {
  constructor(fs, corner = 10) {
    this.r = 1 - (2 * Math.PI * corner) / fs;
    this.x1 = 0;
    this.y1 = 0;
  }

  process(x) {
    let y = x - this.x1 + this.r * this.y1;
    if (y < 1e-25 && y > -1e-25) y = 0;
    this.x1 = x;
    this.y1 = y;
    return y;
  }

  /** True while the blocker still has a tail to play out after its input stops. */
  get ringing() {
    return this.y1 > 1e-7 || this.y1 < -1e-7 || this.x1 !== 0;
  }
}
