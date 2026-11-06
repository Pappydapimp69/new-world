#!/usr/bin/env node
// Mechanics tests: each runs the page's own stepWorld on a tiny test map and checks a
// number written down before the mechanic was built. Fast (well under a second).
// Usage: node tools/mechanics.test.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const HTML = process.env.GAME_HTML || path.join(__dirname, "..", "game", "index.html");
const src = fs.readFileSync(HTML, "utf8");
const ctx = vm.createContext({});
vm.runInContext(src.match(/\/\/ SIM-START[\s\S]*?\/\/ SIM-END/)[0] + "\n;this.api={buildWorld,newState,stepWorld,regroup,TILE,PW,PH};", ctx);
const { buildWorld, newState, stepWorld, regroup, TILE, PW, PH } = ctx.api;
const R = { left: false, right: true, jump: false }, L = { left: true, right: false, jump: false }, J = { jump: true }, N = {};
const room = (rows, w = 20) => ["#".repeat(w), ...rows.map(r => ("#" + r).padEnd(w - 1, ".") + "#"), "#".repeat(w)];
const make = (map, types = [], extra = {}) => { const W = buildWorld({ map, rules: Object.assign({ types }, extra) }); return [W, newState(W)]; };
const run = (W, s, frames, inp) => { for (let k = 0; k < frames; k++) { stepWorld(W, s, typeof inp === "function" ? inp(k) : inp); s.events.length = 0; } };
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "✓" : "✗"} ${name}  (${detail})`); if (!ok) fails++; };
const tall = room(Array(12).fill("").concat(["12"]));

// 1. extra jumps (airJumps): a full jump rises v^2/2g = 11^2/1.1 = 110 px; an air jump at the
//    apex adds (0.9 x 11)^2/1.1 = 89 px, so about 199 px in all
function apex(types, airJump) {
  const [W, s] = make(tall, types); run(W, s, 20, [N, N]);
  const p = s.players[0], y0 = p.y; let top = y0, phase = 0;
  for (let k = 0; k < 150; k++) {
    let inp = J;
    if (phase === 0 && k > 5 && p.vy >= 0) { phase = 1; inp = {}; }          // apex: let go for one frame
    else if (phase === 1) { phase = 2; inp = airJump ? J : {}; }             // press again (or not)
    else if (phase === 2 && !airJump) inp = {};
    stepWorld(W, s, [inp, N]); s.events.length = 0; top = Math.min(top, p.y);
  }
  return Math.round(y0 - top);
}
const one = apex([], false), two = apex(["gust"], true), noType = apex([], true);
check("a full jump rises about 110 px", one >= 104 && one <= 114, one + " px");
check("Gust's air jump at the apex reaches about 199 px", two >= 185 && two <= 210, two + " px");
check("without the ability, pressing jump in mid-air does nothing", noType === one, noType + " px");

// 2-4. riding: a rider moves with its carrier, both ways round
for (const [carrier, rider] of [[0, 1], [1, 0]]) {
  const [W, s] = make(room(Array(4).fill("").concat(["1....2"])));
  const c = s.players[carrier], r = s.players[rider];
  run(W, s, 10, [N, N]);
  r.x = c.x; r.y = c.y - PH - 4; r.vy = 0;
  run(W, s, 10, [N, N]);
  const on0 = r.on === carrier, cx0 = c.x, rx0 = r.x;
  run(W, s, 40, k => carrier === 0 ? [R, N] : [N, R]);
  const dc = c.x - cx0, dr = r.x - rx0;
  check(`P${rider + 1} rides on P${carrier + 1}: carried the same distance`, on0 && r.on === carrier && Math.abs(dc - dr) <= 1 && dc > 60, `carrier ${dc.toFixed(1)} px, rider ${dr.toFixed(1)} px, still riding ${r.on === carrier}`);
  const ry0 = r.y; let rtop = ry0;
  for (let k = 0; k < 70; k++) { stepWorld(W, s, carrier === 0 ? [k < 30 ? J : N, N] : [N, k < 30 ? J : N]); s.events.length = 0; rtop = Math.min(rtop, r.y); }
  check(`P${carrier + 1} jumping lifts its rider and lands with it`, ry0 - rtop >= 90 && r.on === carrier, `rider rose ${Math.round(ry0 - rtop)} px, riding after landing ${r.on === carrier}`);
}

// 5. checkpoints: die after the flag, come back at the flag; regroup goes to the flag too
{
  const [W, s] = make(room(["", "", "", "12......c...^^"]));
  const flagX = W.checkpoints[0].tx * TILE + (TILE - PW) / 2;
  for (let k = 0; k < 300 && s.falls === 0; k++) { stepWorld(W, s, [R, N]); s.events.length = 0; }
  const p = s.players[0];
  check("falling after a checkpoint brings you back at it, not the start", s.falls === 1 && Math.abs(p.x - flagX) <= PW, `falls ${s.falls}, x ${Math.round(p.x)} vs flag ${Math.round(flagX)}`);
  p.x += 40; regroup(W, s);
  check("regroup sends you to your checkpoint, your partner to theirs", Math.abs(s.players[0].x - flagX) <= PW && s.players[1].x === W.spawns[1].x, `P1 x ${Math.round(s.players[0].x)}, P2 at its start ${s.players[1].x === W.spawns[1].x}`);
}
// 6. a flag hanging over a pit never makes the pit the respawn point (Brain sweety#E12):
//    after touching it from the edge you come back on solid ground, and don't die again
{
  const [W, s] = make(room(["", "", "", "1......c"]).map((r, i, a) => i === a.length - 1 ? r.slice(0, 8) + "^" + r.slice(9) : r));
  for (let k = 0; k < 300 && s.falls === 0; k++) { stepWorld(W, s, [R, N]); s.events.length = 0; }
  run(W, s, 120, [N, N]);
  check("a flag over spikes never respawns you into them", s.falls === 1 && s.players[0].ground, `falls ${s.falls} (want 1), standing after respawn ${s.players[0].ground}`);
}
// 7. beat blocks: a block that switches on around you doesn't trap you
{
  const [W, s] = make(room(["", "", "", "1..b"]), [], { bpm: 128 });
  const b = W.beats[0];
  while (Math.floor(s.t / W.beatFrames) % 4 < 2) { stepWorld(W, s, [N, N]); s.events.length = 0; } // wait until 'b' is off
  const p = s.players[0]; p.x = b.tx * TILE + 6; p.y = b.ty * TILE + 2; p.vy = 0;
  while (Math.floor(s.t / W.beatFrames) % 4 >= 2) { stepWorld(W, s, [N, N]); s.events.length = 0; p.x = b.tx * TILE + 6; p.y = b.ty * TILE + 2; p.vy = 0; } // held inside until it switches on
  const x0 = p.x; run(W, s, 30, [R, N]);
  check("you can walk out of a beat block that switched on around you", p.x > x0 + 20, `moved ${Math.round(p.x - x0)} px`);
}
console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
