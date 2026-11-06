#!/usr/bin/env node
// Does the Play screen fit in the browser window with no scrolling?
// Viewports are CSS inner sizes after browser chrome, including Windows 125% scaling
// (1920x1080 -> 1536x~730) per Brain mirage#E10.
const path = require("path");
const { chromium } = require("playwright");
const HTML = path.join(__dirname, "..", "game", "index.html");
const VIEWPORTS = [
  ["laptop 1366x768", 1366, 640],
  ["1920 @125%", 1536, 730],
  ["laptop 1280x800", 1280, 680],
  ["MacBook 1440x900", 1440, 790],
  ["desktop 1920x1080", 1920, 950],
  ["small 1024x600", 1024, 500],
  ["phone landscape", 844, 360],
  ["phone portrait", 390, 750],
];
(async () => {
  const shotDir = process.argv[2];
  const browser = await chromium.launch();
  let ok = true;
  for (const [name, w, h] of VIEWPORTS) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto("file://" + HTML);
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const c = document.getElementById("cv").getBoundingClientRect();
      const doc = document.documentElement;
      const b = document.getElementById("startBtn").getBoundingClientRect();
      const ov = document.getElementById("ovStart").getBoundingClientRect();
      const btnShown = b.height > 0 && b.top >= ov.top && b.bottom <= ov.bottom && b.bottom <= innerHeight;
      return { scrollH: doc.scrollHeight, scrollW: doc.scrollWidth, innerH: innerHeight, innerW: innerWidth, canvasW: Math.round(c.width), canvasBottom: Math.round(c.bottom), btnShown };
    });
    const portrait = h > w;
    const fits = m.scrollH <= m.innerH + 1;
    const noSideScroll = m.scrollW <= m.innerW + 1;
    const canvasVisible = m.canvasBottom <= m.innerH + 1;
    const pass = noSideScroll && fits && canvasVisible && m.btnShown;
    ok = ok && pass;
    console.log(`${pass ? "✓" : "✗"} ${name.padEnd(18)} ${w}x${h}  page ${m.scrollH}px tall (overflow ${m.scrollH - m.innerH}), canvas ${m.canvasW}px wide (${Math.round(100 * m.canvasW / w)}% of width), start button ${m.btnShown ? "visible" : "HIDDEN"}`);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, `fit-${w}x${h}.png`) });
    await page.close();
  }
  await browser.close();
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
})();
