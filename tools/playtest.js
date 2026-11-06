#!/usr/bin/env node
// Playtest for New World. Runs the page's own simulation code (the block between
// SIM-START and SIM-END in game/index.html) with no browser, then:
//   1. For each step in a level's testPlan, searches (BFS over held inputs) for a way for
//      the moving player to reach the target while the partner stands still.
//      `expect: "unreachable"` steps must find NO way (proves a co-op gate is a gate).
//   2. Replays every found input sequence from a fresh start through stepWorld and checks
//      that the level ends won, which is the same code path the real game runs.
//   3. With --browser, loads the page in Chromium, checks for script errors, replays the
//      solution in the page's own runtime, presses real keys, and saves a screenshot.
// Usage: node tools/playtest.js [levelNumber|all] [--browser] [--shot out.png]
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = path.join(__dirname, "..", "game", "index.html");
const src = fs.readFileSync(HTML, "utf8");
const levelsSrc = src.match(/const LEVELS = \[[\s\S]*?\n\];/);
const simSrc = src.match(/\/\/ SIM-START[\s\S]*?\/\/ SIM-END/);
if (!levelsSrc || !simSrc) { console.error("could not find LEVELS or the SIM block in game/index.html"); process.exit(2); }
const ctx = vm.createContext({ console });
vm.runInContext(levelsSrc[0] + "\n" + simSrc[0] + "\n;this.LEVELS=LEVELS;this.api={buildWorld,newState,cloneState,stepWorld,touches,PW,PH,TILE};", ctx);
const { LEVELS, api } = ctx;
const { buildWorld, newState, cloneState, stepWorld, touches } = api;

// Macro moves, each simulated until the player is standing again (or 150 frames):
// a short walk either way, a pause, and jumps in 3 directions x 3 jump-hold lengths x
// 3 air-steering patterns. Searching between standing spots keeps the graph small, and
// every path is exact because it is the literal frame-by-frame input the game would get.
const MACROS = [];
const I = (h, j) => ({ left: h < 0, right: h > 0, jump: !!j });
for (const d of [-1, 1]) MACROS.push({ kind: "walk", d, f: k => I(d, 0), len: 6 });
MACROS.push({ kind: "wait", f: () => I(0, 0), len: 6 });
for (const d of [-1, 0, 1]) for (const hold of [5, 11, 40]) for (const steer of ["hold", "release", "late"]) {
  if (d === 0 && steer !== "hold") {
    // jump straight up, then drift either way
    for (const late of [-1, 1]) MACROS.push({ kind: "jump", f: k => I(k >= 12 ? late : 0, k < hold), len: 150 });
    continue;
  }
  MACROS.push({ kind: "jump", f: k => {
    const h = steer === "hold" ? d : steer === "release" ? (k < 12 ? d : 0) : (k < 8 ? 0 : d);
    return I(h, k < hold);
  }, len: 150 });
}
// swimming: short strokes in each direction, with and without jump (stroke up)
for (const d of [-1, 0, 1]) for (const j of [0, 1]) MACROS.push({ kind: "swim", f: () => I(d, j), len: 10 });
const MAX_NODES = 60000;

function reached(W, s, mover, to) {
  if (to === "won") return s.won;
  if (typeof to === "function") return to(W, s, mover);
  if (to === "i") return s.melted.length > 0;              // some ice melted
  if (to.startsWith("*@")) {                                 // one specific star, "*@col,row"
    const [tx, ty] = to.slice(2).split(",").map(Number);
    const k = W.gems.findIndex(g => g.tx === tx && g.ty === ty);
    if (k < 0) throw new Error("no star at " + to);
    return s.gems[k];
  }
  return touches(W, s.players[mover], to);
}

function key(s, m) {
  const p = s.players[m];
  const world = `${s.latched ? 1 : 0},${s.gateOpen ? 1 : 0},${s.melted.length}`;
  // swimming is slow and forgiving, so a coarse 8 px cell and the direction of travel is enough
  if (p.swim) return `s${Math.round(p.x / 8)},${Math.round(p.y / 8)},${Math.sign(Math.round(p.vy))},${world}`;
  return `${Math.round(p.x / 3)},${Math.round(p.y / 4)},${Math.round(p.vx)},${p.ground ? 1 : 0},${world}`;
}

// Runs one macro. Returns {state, frames, hit, died}.
function runMacro(W, start, mover, mac, to) {
  const n = start.players.length;
  const s = cloneState(start), frames = [];
  const falls0 = s.falls;
  for (let k = 0; k < mac.len; k++) {
    const inp = Array.from({ length: n }, (_, i) => (i === mover ? mac.f(k) : {}));
    stepWorld(W, s, inp); s.events.length = 0; frames.push(inp);
    if (s.falls !== falls0) return { died: true };
    if (reached(W, s, mover, to)) return { state: s, frames, hit: true };
    if (mac.kind === "jump" && k > 2 && (s.players[mover].ground || s.players[mover].swim)) break;
  }
  // a walk that steps off an edge keeps holding its direction until it lands (or starts swimming)
  if (mac.kind === "walk" || mac.kind === "wait") for (let k = 0; k < 120 && !s.players[mover].ground && !s.players[mover].swim; k++) {
    const inp = Array.from({ length: n }, (_, i) => (i === mover ? mac.f(0) : {}));
    stepWorld(W, s, inp); s.events.length = 0; frames.push(inp);
    if (s.falls !== falls0) return { died: true };
    if (reached(W, s, mover, to)) return { state: s, frames, hit: true };
  }
  return { state: s, frames, hit: false };
}

function search(W, start, mover, to) {
  if (reached(W, start, mover, to)) return { inputs: [], end: start, nodes: 1 };
  // settle onto the ground first
  const nodes = [{ s: start, parent: -1, frames: [] }];
  const seen = new Set([key(start, mover)]);
  for (let head = 0; head < nodes.length; head++) {
    if (nodes.length > MAX_NODES) return { inputs: null, nodes: nodes.length, capped: true };
    const swimming = nodes[head].s.players[mover].swim;
    for (const mac of MACROS) {
      if ((mac.kind === "swim") !== swimming && !(swimming && mac.kind === "jump")) continue;
      const r = runMacro(W, nodes[head].s, mover, mac, to);
      if (r.died) continue;
      const k = key(r.state, mover);
      if (!r.hit && seen.has(k)) continue;
      seen.add(k);
      nodes.push({ s: r.state, parent: head, frames: r.frames });
      if (r.hit) {
        const chain = [];
        for (let i = nodes.length - 1; i > 0; i = nodes[i].parent) chain.push(nodes[i].frames);
        const inputs = chain.reverse().flat();
        return { inputs, end: r.state, nodes: nodes.length };
      }
    }
  }
  return { inputs: null, nodes: nodes.length };
}

function playtest(level) {
  const W = buildWorld(level);
  const plan = level.testPlan || [];
  let cur = newState(W);
  const all = [];
  const report = [];
  let ok = true;
  if (!plan.length) { report.push("  ✗ no testPlan"); ok = false; }
  for (const step of plan) {
    const t0 = Date.now();
    const res = search(W, cloneState(cur), step.mover, step.to);
    const ms = Date.now() - t0;
    const label = `P${step.mover + 1} → ${step.to}${step.note ? "  (" + step.note + ")" : ""}`;
    if (step.expect === "unreachable") {
      const pass = !res.inputs && !res.capped;
      ok = ok && pass;
      report.push(`  ${pass ? "✓" : "✗"} unreachable: ${label}  [${res.nodes} states, ${ms} ms${res.capped ? ", search capped, inconclusive" : ""}]`);
      continue;
    }
    if (!res.inputs) { ok = false; report.push(`  ✗ ${label}  no path found [${res.nodes} states${res.capped ? ", capped" : ""}]`); break; }
    report.push(`  ✓ ${label}  ${(res.inputs.length / 60).toFixed(1)} s of input [${res.nodes} states, ${ms} ms]`);
    all.push(...res.inputs);
    cur = res.end;
  }
  // full replay from a fresh start through the same stepWorld the game runs
  if (ok) {
    const s = newState(W);
    for (const inp of all) { stepWorld(W, s, inp); s.events.length = 0; }
    if (!s.won) { ok = false; report.push("  ✗ replay from a fresh start did not end in a win"); }
    else report.push(`  ✓ full replay wins in ${(all.length / 60).toFixed(1)} s, falls ${s.falls}, stars ${s.gems.filter(Boolean).length}/${s.gems.length}`);
    // every star must be reachable by someone once the gates are open
    let starsOk = true;
    W.gems.forEach((gm, k) => {
      const st = newState(W); st.latched = true; st.gateOpen = true;
      const got = [0, 1].some(m => !!search(W, cloneState(st), m, (W2, s) => s.gems[k]).inputs);
      if (!got) { starsOk = false; report.push(`  ✗ star at column ${gm.tx}, row ${gm.ty} is unreachable`); }
    });
    ok = ok && starsOk;
    if (W.gems.length && starsOk) report.push(`  ✓ all ${W.gems.length} stars reachable`);
  }
  return { ok, report, inputs: all };
}

async function browserCheck(levelIdx, inputs, shot) {
  const { chromium } = require("playwright");
  // served over http (as the real page is), not file://: AudioWorklets can't load from a null origin
  const http = require("http");
  const server = http.createServer((req, res) => {
    const f = path.join(path.dirname(HTML), decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!f.startsWith(path.dirname(HTML))) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" }); res.end(data);
    });
  }).listen(0);
  const URL_ = `http://localhost:${server.address().port}/index.html`;
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|fonts\.g/.test(m.text())) errors.push(m.text()); });
  // fake controllers, read through the page's real getGamepads() polling
  await page.addInitScript(() => {
    const mk = i => ({ index: i, id: "test pad " + i, connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) });
    window.__pads = [];
    window.__padSet = (i, patch) => {
      while (window.__pads.length <= i) window.__pads.push(mk(window.__pads.length));
      const p = window.__pads[i];
      if (patch.axes) p.axes = patch.axes.concat([0, 0, 0, 0]).slice(0, 4);
      if (patch.buttons) for (const [b, v] of Object.entries(patch.buttons)) p.buttons[b] = { pressed: !!v, value: v ? 1 : 0 };
    };
    navigator.getGamepads = () => window.__pads;
  });
  await page.goto(URL_);
  await page.waitForTimeout(600);
  const out = [];
  const vis = () => page.evaluate(() => ({
    screen: window.__nw.screen, mode: window.__nw.mode,
    play: !document.getElementById("screenPlay").hidden, write: !document.getElementById("screenWrite").hidden, world: !document.getElementById("screenWorld").hidden,
    writeTab: !document.getElementById("goWrite").disabled
  }));
  const shotOf = suffix => shot ? shot.replace(/\.png$/, "") + "-" + suffix + ".png" : null;
  let v = await vis();
  const firstOk = v.play && !v.write && !v.world && v.mode === "start" && !v.writeTab;
  out.push(`  ${firstOk ? "✓" : "✗"} opens on the level only (play ${v.play}, write ${v.write}, world ${v.world}, write tab locked ${!v.writeTab})`);
  if (shotOf("1-play")) { await page.screenshot({ path: shotOf("1-play"), fullPage: true }); out.push(`  · screenshot ${shotOf("1-play")}`); }
  // the page's own runtime: same LEVELS, same sim, real loaded page
  const won = await page.evaluate(({ idx, inputs }) => {
    const W = buildWorld(LEVELS[idx]); const s = newState(W);
    for (const inp of inputs) { stepWorld(W, s, inp); s.events.length = 0; }
    return s.won;
  }, { idx: levelIdx, inputs });
  out.push(`  ${won ? "✓" : "✗"} solution replays to a win inside the loaded page`);
  // real keys through the real loop
  await page.evaluate(i => window.__nw.loadLevel(i), levelIdx);
  await page.keyboard.press("Enter");
  const x0 = await page.evaluate(() => [window.__nw.state.players[0].x, window.__nw.state.players[1].x]);
  await page.keyboard.down("KeyD"); await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyD"); await page.keyboard.up("ArrowRight");
  await page.keyboard.down("KeyW"); await page.waitForTimeout(120); await page.keyboard.up("KeyW");
  await page.waitForTimeout(80);
  const after = await page.evaluate(() => ({ mode: window.__nw.mode, x: [window.__nw.state.players[0].x, window.__nw.state.players[1].x], y0: window.__nw.state.players[0].y, ground: window.__nw.state.players[0].ground }));
  const moved = after.x[0] > x0[0] + 10 && after.x[1] > x0[1] + 10;
  out.push(`  ${after.mode === "playing" && moved ? "✓" : "✗"} Enter starts, D and → move both players (${x0.map(Math.round)} → ${after.x.map(Math.round)})`);
  out.push(`  ${!after.ground ? "✓" : "✗"} W makes player 1 jump`);

  // sound: the Sound-engine starts on the level's start, plays this level's song, and is audible
  if (LEVELS[levelIdx].song) {
    await page.waitForTimeout(1200);
    const a = await page.evaluate(() => window.__nw.audio);
    out.push(`  ${a.ready && a.state === "running" && a.song === LEVELS[levelIdx].song ? "✓" : "✗"} sound engine running (loaded via ${a.via || a.error}), song "${a.song}"`);
    const lv = await page.evaluate(() => new Promise(res => {
      const eng = window.__nwAudioEngine; if (!eng) return res({ rms: 0, peak: 0 });
      const an = new AnalyserNode(eng.ctx, { fftSize: 2048 }); eng.limiter.connect(an);
      const buf = new Float32Array(2048); let max = 0, sum = 0, n = 0; const t0 = performance.now();
      (function poll() { an.getFloatTimeDomainData(buf); for (const v of buf) { max = Math.max(max, Math.abs(v)); sum += v * v; n++; }
        if (performance.now() - t0 < 1500) setTimeout(poll, 40); else { eng.limiter.disconnect(an); res({ peak: max, rms: Math.sqrt(sum / n) }); } })();
    }));
    out.push(`  ${lv.rms > 0.01 && lv.peak < 1 ? "✓" : "✗"} music is audible and unclipped (rms ${lv.rms.toFixed(3)}, peak ${lv.peak.toFixed(2)})`);
  }

  // gamepads
  const P = () => page.evaluate(() => window.__nw.state.players.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), ground: p.ground })));
  await page.evaluate(i => window.__nw.loadLevel(i), levelIdx);
  await page.evaluate(() => { window.__padSet(0, {}); window.__padSet(1, {}); });
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__padSet(0, { buttons: { 0: 1 } }));   // A on pad 1, held
  await page.waitForTimeout(250);
  const g0 = await page.evaluate(() => window.__nw.mode);
  const pAfterA = await P();
  out.push(`  ${g0 === "playing" ? "✓" : "✗"} pad A starts the level`);
  out.push(`  ${pAfterA[0].ground ? "✓" : "✗"} the A press that started the level did not also jump (held 250 ms)`);
  await page.evaluate(() => window.__padSet(0, { buttons: { 0: 0 } }));
  await page.waitForTimeout(60);
  const gp0 = await P();
  await page.evaluate(() => { window.__padSet(0, { axes: [1, 0] }); window.__padSet(1, { buttons: { 15: 1 } }); });
  await page.waitForTimeout(350);
  await page.evaluate(() => { window.__padSet(0, { axes: [0, 0] }); window.__padSet(1, { buttons: { 15: 0 } }); });
  const gp1 = await P();
  const padMoved = gp1[0].x > gp0[0].x + 10 && gp1[1].x > gp0[1].x + 10;
  out.push(`  ${padMoved ? "✓" : "✗"} pad 1 stick moves player 1, pad 2 d-pad moves player 2 (${gp0.map(p => p.x)} → ${gp1.map(p => p.x)})`);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__padSet(1, { buttons: { 0: 1 } }));
  await page.waitForTimeout(120);
  const gp2 = await P();
  await page.evaluate(() => window.__padSet(1, { buttons: { 0: 0 } }));
  out.push(`  ${!gp2[1].ground && gp2[0].ground ? "✓" : "✗"} pad 2 A makes only player 2 jump`);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__padSet(0, { buttons: { 3: 1 } }));
  await page.waitForTimeout(60);
  await page.evaluate(() => window.__padSet(0, { buttons: { 3: 0 } }));
  const gp3 = await P();
  const spawnX = await page.evaluate(() => window.__nw.world.spawns.map(s => Math.round(s.x)));
  out.push(`  ${gp3[0].x === spawnX[0] && gp3[1].x === spawnX[1] ? "✓" : "✗"} pad Y regroups both players`);
  const padText = await page.evaluate(() => document.getElementById("padInfo").textContent);
  out.push(`  ${/controller 2/i.test(padText) ? "✓" : "✗"} shows who each controller plays ("${padText}")`);
  await page.evaluate(() => { window.__pads.length = 0; });

  // the screen flow (newest level only): a real win through tick() opens Write, sending opens The world so far
  if (levelIdx === LEVELS.length - 1) {
  await page.evaluate(i => { window.__nw.loadLevel(i); window.__nw.begin(); }, levelIdx);
  const fed = await page.evaluate(inputs => window.__nw.feed(inputs), inputs);
  await page.waitForTimeout(100);
  v = await vis();
  const toWrite = fed.won && v.screen === "write" && v.write && !v.play && !v.world && v.writeTab;
  const note = await page.evaluate(() => !document.getElementById("clearedNote").hidden && document.getElementById("clearedNote").textContent);
  out.push(`  ${toWrite ? "✓" : "✗"} clearing the level opens the Write screen and hides the rest (${note || "no cleared note"})`);
  if (shotOf("2-write")) { await page.screenshot({ path: shotOf("2-write"), fullPage: true }); out.push(`  · screenshot ${shotOf("2-write")}`); }
  await page.fill("#text1", "Add a double jump");
  await page.click("#lock1");
  await page.fill("#text2", "Make it nighttime");
  await page.click("#lock2");
  await page.click("#sendBtn");
  await page.waitForTimeout(150);
  v = await vis();
  const banner = await page.evaluate(() => !document.getElementById("worldBanner").hidden);
  const toWorld = v.screen === "world" && v.world && !v.write && !v.play && banner;
  out.push(`  ${toWorld ? "✓" : "✗"} sending the turns opens The world so far with the waiting note`);
  if (shotOf("3-world")) { await page.screenshot({ path: shotOf("3-world"), fullPage: true }); out.push(`  · screenshot ${shotOf("3-world")}`); }
  await page.click("#goPlay");
  v = await vis();
  out.push(`  ${v.play && !v.world ? "✓" : "✗"} the step tabs go back to the level`);
  }

  out.push(`  ${errors.length ? "✗" : "✓"} no script errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  await browser.close();
  server.close();
  const allOk = !out.some(l => l.includes("✗"));
  return { ok: won && moved && allOk && !errors.length, out };
}

(async () => {
  const args = process.argv.slice(2);
  const which = args.find(a => /^(\d+|all)$/.test(a)) || String(LEVELS[LEVELS.length - 1].n);
  const shotI = args.indexOf("--shot");
  const shot = shotI >= 0 ? args[shotI + 1] : null;
  const targets = which === "all" ? LEVELS : LEVELS.filter(L => String(L.n) === which);
  let allOk = true;
  for (const L of targets) {
    console.log(`Level ${L.n} · ${L.name}`);
    const r = playtest(L);
    r.report.forEach(l => console.log(l));
    allOk = allOk && r.ok;
    if (r.ok && args.includes("--browser")) {
      const b = await browserCheck(LEVELS.indexOf(L), r.inputs, shot);
      b.out.forEach(l => console.log(l));
      allOk = allOk && b.ok;
    }
  }
  console.log(allOk ? "PASS" : "FAIL");
  process.exit(allOk ? 0 : 1);
})();
