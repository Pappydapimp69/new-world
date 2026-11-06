#!/usr/bin/env node
// Bundles the vendored Sound-engine (vendor/sound-engine, from `brain engine vendor`) and
// inlines it into game/index.html between the SOUND-ENGINE markers, so the Artifact is
// one file: the engine as a script defining window.SoundEngineLib, and the AudioWorklet
// as text the page turns into a blob URL.
// Usage: node tools/inline-sound.js   (needs esbuild: npx esbuild@0.24.0, or ESBUILD=path)
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const esb = process.env.ESBUILD ? [process.env.ESBUILD] : ["npx", "-y", "esbuild@0.24.0"];
const run = args => execFileSync(esb[0], esb.slice(1).concat(args), { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
fs.mkdirSync(path.join(root, "game/sound"), { recursive: true });
run(["vendor/sound-engine/src/index.js", "--bundle", "--format=iife", "--global-name=SoundEngineLib",
  "--define:import.meta.url=\"https://local.invalid/sound/\"", "--minify", "--outfile=game/sound/engine.js", "--log-level=warning"]);
run(["vendor/sound-engine/src/worklet/processors.js", "--bundle", "--format=iife", "--minify", "--outfile=game/sound/worklet.js", "--log-level=warning"]);
const eng = fs.readFileSync(path.join(root, "game/sound/engine.js"), "utf8");
const wk = fs.readFileSync(path.join(root, "game/sound/worklet.js"), "utf8");
for (const [n, t] of [["engine", eng], ["worklet", wk]]) if (/<\/script/i.test(t)) throw new Error(n + " bundle contains </script");
const htmlPath = path.join(root, "game/index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const re = /(<!-- SOUND-ENGINE-START[^>]*-->)[\s\S]*?(<!-- SOUND-ENGINE-END -->)/;
if (!re.test(html)) throw new Error("SOUND-ENGINE markers not found");
const rev = execFileSync("git", ["log", "-1", "--format=%h", "--", "vendor/sound-engine"], { cwd: root }).toString().trim() || "uncommitted";
const block = `$1\n<script>/* sound-engine bundle, vendor rev ${rev} */\n${eng}</script>\n<script type="text/plain" id="workletSrc">${wk}</script>\n$2`;
fs.writeFileSync(htmlPath, html.replace(re, block));
console.log(`inlined engine ${eng.length} B + worklet ${wk.length} B`);
