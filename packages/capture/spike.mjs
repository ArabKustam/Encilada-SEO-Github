import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
for (const dpr of [1, 2]) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await page.setContent("<h1 style='font:80px sans-serif'>Hello DPR</h1>");
  for (const [name, opts] of [["a", {}], ["b", { captureBeyondViewport: false, fromSurface: true }], ["c", { clip: { x: 0, y: 0, width: 1920, height: 1080, scale: dpr } }]]) {
    const t = performance.now();
    const r = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, ...opts });
    writeFileSync(`spike-${dpr}${name}.png`, Buffer.from(r.data, "base64"));
    console.log(dpr, name, (performance.now() - t).toFixed(0) + "ms");
  }
  await browser.close();
}
