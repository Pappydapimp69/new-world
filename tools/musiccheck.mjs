// Renders each song in game/index.html through the vendored Sound-engine's own MusicKernel
// (the same DSP the AudioWorklet runs) and measures it. Prediction to beat:
//   peak below 1.0 on the raw music bus at every intensity (no clipping before the limiter),
//   loudness (RMS) at intensity 0.9 at least 1.5x the RMS at 0.2 (layers really enter),
//   no NaN or silence.
// Usage: node tools/musiccheck.mjs [seconds]
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { MusicKernel } from "../vendor/sound-engine/src/dsp/kernel.js";

const html = readFileSync(new URL("../game/index.html", import.meta.url), "utf8");
const src = html.match(/const SONGS = \{[\s\S]*?\n\};/);
if (!src) { console.error("no SONGS block"); process.exit(2); }
const ctx = vm.createContext({});
vm.runInContext(src[0] + "\nthis.SONGS = SONGS;", ctx);
const SONGS = ctx.SONGS;

const FS = 48000, SECS = +(process.argv[2] || 16), BLOCK = 128;
function render(song, intensity) {
  const k = new MusicKernel(FS, { song: JSON.parse(JSON.stringify(song)), intensity });
  k.onMessage({ type: "play" });
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), S = new Float32Array(BLOCK);
  let peak = 0, sum = 0, n = 0, bad = 0;
  for (let i = 0; i < (FS * SECS) / BLOCK; i++) {
    k.processBlock(L, R, S);
    for (let j = 0; j < BLOCK; j++) {
      const a = L[j], b = R[j];
      if (!Number.isFinite(a) || !Number.isFinite(b)) { bad++; continue; }
      peak = Math.max(peak, Math.abs(a), Math.abs(b));
      sum += a * a + b * b; n += 2;
    }
  }
  return { peak, rms: Math.sqrt(sum / n), bad };
}

let ok = true;
for (const [name, song] of Object.entries(SONGS)) {
  const loopSteps = Math.max(...song.tracks.map(t => t.steps.trim().split(/\s+/).length));
  const r = {};
  for (const I of [0.2, 0.5, 0.9]) r[I] = render(song, I);
  const ratio = r[0.9].rms / r[0.2].rms;
  const peakOk = Object.values(r).every(x => x.peak < 1.0);
  const sound = Object.values(r).every(x => x.rms > 0.01 && x.bad === 0);
  const pass = peakOk && sound && ratio >= 1.5;
  ok = ok && pass;
  const secsPerLoop = (loopSteps / (song.stepsPerBeat || 4)) * 60 / song.bpm;
  console.log(`${pass ? "✓" : "✗"} ${name}: loop ${secsPerLoop.toFixed(1)} s · ` +
    [0.2, 0.5, 0.9].map(I => `I=${I} peak ${r[I].peak.toFixed(2)} rms ${r[I].rms.toFixed(3)}`).join(" · ") +
    ` · calm→tense loudness x${ratio.toFixed(2)}`);
}
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
