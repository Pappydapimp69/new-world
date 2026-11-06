#!/usr/bin/env node
// Golden trajectories: proves a sim refactor didn't change how existing levels play.
// For every level, 24 seeded input scripts drive both players for 900 frames through the
// page's own stepWorld; a hash of the state every 30 frames must match tools/golden.json.
// Usage: node tools/golden.js [--update]
const fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto");
const HTML = process.env.GAME_HTML || path.join(__dirname, "..", "game", "index.html");
const src = fs.readFileSync(HTML, "utf8");
const pick = re => { const m = src.match(re); if (!m) throw new Error("missing " + re); return m[0]; };
const ctx = vm.createContext({});
vm.runInContext(pick(/const LEVELS = \[[\s\S]*?\n\];/) + "\n" + pick(/\/\/ SIM-START[\s\S]*?\/\/ SIM-END/) + "\n;this.LEVELS=LEVELS;this.api={buildWorld,newState,stepWorld};", ctx);
const { LEVELS: GAME_LEVELS, api } = ctx;
// test-only lab maps: every mechanic within reach of a random walk, in both type orders
const LAB = (n, types, map) => ({ n, name: "lab", rules: { types, bpm: 128 }, map });
const labMap = [
  "################",
  "#..............#",
  "#....bbBB......#",
  "#..............#",
  "#i.ff.12.p.g.ww#",
  "#############ww#",
  "################"
];
const LEVELS = [...GAME_LEVELS, LAB("lab-a", ["ember", "tide"], labMap), LAB("lab-b", ["tide", "ember"], labMap), LAB("lab-c", [], labMap)];
function lcg(seed) { let x = seed >>> 0; return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296); }
const coverage = {}, riders = {};
function run(level, seed) {
  const W = api.buildWorld(level), s = api.newState(W), r = lcg(seed * 7919 + level.n);
  const h = crypto.createHash("sha1");
  const cov = coverage["level-" + level.n] = coverage["level-" + level.n] || {};
  let held = [{}, {}], rode = false;
  for (let t = 0; t < 900; t++) {
    if (t % 12 === 0) held = [0, 1].map(() => { const d = Math.floor(r() * 3) - 1; return { left: d < 0, right: d > 0, jump: r() < 0.4 }; });
    api.stepWorld(W, s, held);
    for (const e of s.events) { const k = e.type + (e.kind ? ":" + e.kind : ""); cov[k] = (cov[k] || 0) + 1; }
    s.players.forEach(p => { if (p.swim) cov.swimFrames = (cov.swimFrames || 0) + 1; if (p.on >= 0) rode = true; });
    s.events.length = 0;
    if (t % 30 === 29) h.update(JSON.stringify([s.players.map(p => [p.x.toFixed(3), p.y.toFixed(3), p.vx.toFixed(3), p.vy.toFixed(3)]), s.gems, s.melted, s.latched, s.falls, s.won]));
  }
  (riders[level.n] = riders[level.n] || [])[seed - 1] = rode;
  return h.digest("hex").slice(0, 12);
}
const out = {};
for (const L of LEVELS) out["level-" + L.n] = Array.from({ length: 24 }, (_, i) => run(L, i + 1));
if (process.argv.includes("--coverage")) for (const [k, v] of Object.entries(coverage)) console.log("coverage", k, JSON.stringify(v));
const file = path.join(__dirname, "golden.json");
if (process.argv.includes("--update") || !fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(out, null, 1)); console.log("wrote", file); process.exit(0); }
const want = JSON.parse(fs.readFileSync(file, "utf8"));
let ok = true;
for (const [k, v] of Object.entries(want)) {
  const got = out[k] || [];
  const diff = v.filter((h, i) => h !== got[i]).length;
  if (process.argv.includes("--riders")) {
    const rid = riders[k.slice(6)] || [];
    const diffIdx = v.map((h, i) => h !== got[i]);
    const unexplained = diffIdx.filter((d, i) => d && !rid[i]).length;
    console.log(`  ${k}: ${rid.filter(Boolean).length} trajectories with riding, ${diff} differ, ${unexplained} differ without any riding`);
  }
  console.log(`${diff ? "✗" : "✓"} ${k}: ${v.length - diff}/${v.length} trajectories identical`);
  ok = ok && !diff;
}
console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1);
