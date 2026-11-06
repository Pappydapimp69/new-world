/**
 * Voice allocator that steals by audibility. With dense per-bubble water in
 * 24 voices, oldest-first stealing cut 70% of the creature calls' audible
 * energy while stealing the quietest-at-listener cut none (dlist/E27).
 * `priority` (dB) lifts cues that must be heard even when faint.
 */
export class VoiceAllocator {
  constructor(maxVoices = 24) {
    this.max = maxVoices;
    this.voices = new Map(); // id -> { level, priority, started }
    this.clock = 0;
  }

  get count() {
    return this.voices.size;
  }

  /** Update a playing voice's current level at the listener (dB). */
  setLevel(id, levelDb) {
    const v = this.voices.get(id);
    if (v) v.level = levelDb;
  }

  release(id) {
    this.voices.delete(id);
  }

  /**
   * Ask for a voice.
   * @returns {{accepted:boolean, steal:(string|number|null)}} `steal` is the id
   * to stop, if any. When the newcomer would be the least audible it is
   * rejected instead.
   */
  request(id, levelDb, priority = 0) {
    this.clock++;
    if (this.voices.size < this.max) {
      this.voices.set(id, { level: levelDb, priority, started: this.clock });
      return { accepted: true, steal: null };
    }
    let victim = null, worst = levelDb + priority;
    for (const [vid, v] of this.voices) {
      const score = v.level + v.priority;
      if (score < worst) { worst = score; victim = vid; }
    }
    if (victim === null) return { accepted: false, steal: null };
    this.voices.delete(victim);
    this.voices.set(id, { level: levelDb, priority, started: this.clock });
    return { accepted: true, steal: victim };
  }
}
