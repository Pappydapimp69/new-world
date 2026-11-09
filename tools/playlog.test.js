#!/usr/bin/env node
// Play-log test: the real page in Chromium with an in-memory stand-in for the Artifact database.
// One scripted try of the newest level (player 1, Ember, walks into the sea, the pair regroups, then
// the cached machine solve finishes it) must save one run with that fall, the regroup and won: true,
// and the world and write screens must show it. Needs a passing tools/playtest.js (for the cached solve).
const fs = require("fs"), path = require("path"), http = require("http");
const { chromium } = require("playwright");
const DIR = path.join(__dirname, "..", "game");
const cache = JSON.parse(fs.readFileSync(path.join(__dirname, "playtest-cache.json"), "utf8"));
const dec = str => Array.from({ length: str.length / 2 }, (_, k) => [0, 1].map(i => { const v = +str[k * 2 + i]; return { left: !!(v & 1), right: !!(v & 2), jump: !!(v & 4) }; }));
(async () => {
  const server = http.createServer((q, r) => fs.readFile(path.join(DIR, decodeURIComponent(new URL(q.url, "http://x").pathname)), (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { "content-type": q.url.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" }); r.end(d); })).listen(0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = []; page.on("pageerror", e => errors.push(String(e)));
  await page.addInitScript(() => {
    // minimal stand-in for claude.use("db"): doc get/set/onSnapshot, collection onSnapshot
    const docs = new Map(), docSubs = new Map(), colSubs = new Map();
    const snap = (id, d) => ({ id, exists: d !== undefined, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } });
    const colOf = p => p.split("/").slice(0, -1).join("/");
    const fireCol = c => (colSubs.get(c) || []).forEach(f => { const ds = [...docs].filter(([k]) => colOf(k) === c).map(([k, v]) => snap(k.split("/").pop(), v)); f({ docs: ds, size: ds.length, empty: !ds.length }); });
    const db = {
      doc: p => ({ path: p, id: p.split("/").pop(),
        get: async () => snap(p, docs.get(p)),
        set: async d => { docs.set(p, JSON.parse(JSON.stringify(d))); (docSubs.get(p) || []).forEach(f => f(snap(p, docs.get(p)))); fireCol(colOf(p)); },
        onSnapshot: (f) => { (docSubs.get(p) || docSubs.set(p, []).get(p)).push(f); setTimeout(() => f(snap(p, docs.get(p))), 0); return () => {}; } }),
      collection: c => ({ onSnapshot: (f) => { (colSubs.get(c) || colSubs.set(c, []).get(c)).push(f); setTimeout(() => fireCol(c), 0); return () => {}; } })
    };
    window.__mockDocs = docs;
    window.claude = { use: async n => (n === "db" ? db : null) };
  });
  await page.goto(`http://localhost:${server.address().port}/index.html`);
  await page.waitForTimeout(500);
  const newest = Math.max(...Object.keys(cache).map(Number));
  const sol = dec(cache[String(newest)].inputs);
  const out = await page.evaluate(async sol => {
    const nw = window.__nw;
    const idx = nw.levels - 1;
    nw.loadLevel(idx); nw.begin();
    for (let k = 0; k < 300 && nw.state.falls === 0; k++) nw.feed([[{ right: true }, {}]]);   // player 1 walks into the hazard, once
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyR" }));
    nw.feed([[{}, {}]]);                              // the regroup event is handled on the next step
    while (nw.state.t % 225) nw.feed([[{}, {}]]);     // 225 frames = 8 beats: the beat blocks line up with a fresh start
    nw.feed(sol);                                     // then the machine solve finishes the level
    await new Promise(r => setTimeout(r, 300));
    const runs = [...window.__mockDocs].filter(([k]) => k.startsWith("runs/")).map(([, v]) => v);
    nw.show("world");
    const stats = [...document.querySelectorAll(".playstats")].map(e => e.textContent);
    const struggle = document.getElementById("struggle").textContent;
    return { runs, stats, struggle, mode: nw.mode };
  }, sol);
  const r = out.runs[0] || {};
  const checks = [
    ["exactly one run saved for the try", out.runs.length === 1, `${out.runs.length} run(s)`],
    ["it records player 1's one fall and what killed them", (r.falls || []).length === 1 && r.falls[0].p === 0 && ["water", "spikes", "fire"].includes(r.falls[0].k), JSON.stringify(r.falls)],
    ["it records the regroup and the clear", r.regroups === 1 && r.won === true, `regroups ${r.regroups}, won ${r.won}, ${r.seconds} s`],
    ["the world screen shows the try", out.stats.some(t => /1 try · cleared 1/.test(t) && /(water|spikes|fire)/.test(t)), JSON.stringify(out.stats)],
    ["the write screen names where you struggled", /(water|spikes|fire)/.test(out.struggle), out.struggle || "(empty)"],
    ["no script errors", !errors.length, errors.join(" | ") || "none"]
  ];
  let ok = true;
  for (const [n, pass, d] of checks) { console.log(`${pass ? "✓" : "✗"} ${n}  (${d})`); ok = ok && pass; }
  await browser.close(); server.close();
  console.log(ok ? "PASS" : "FAIL"); process.exit(ok ? 0 : 1);
})();
