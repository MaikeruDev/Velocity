/**
 * Level 4 — grobe Frame-Zeit im echten Spiel (headless Chromium/ANGLE), Level 2 zum Vergleich:
 * Route-Bot (sync 1.0) spielt 14 s in Echtzeit, rAF-Abstände werden im Browser gemessen.
 * Absolutwerte sind headless nicht repräsentativ — nur der Vergleich L2 ↔ L4 zählt.
 *   node tools/critique/v2/level4/perf.mjs
 */
import { readFileSync } from 'node:fs';
import { launchBrowser, startDevServer } from '../../../lib/devServer.mjs';

const PORT = Number(process.env.L4_PORT ?? 5309);
const level = JSON.parse(readFileSync('shots/v2/level4/level4.json', 'utf8'));
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  for (const id of ['level2', 'level4']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route('**/levels/index.json', async (route) => {
      const res = await route.fetch();
      const idx = await res.json();
      idx.push({ id: 'level4', name: level.name, subtitle: level.subtitle, file: 'level4.json', medals: level.medals });
      await route.fulfill({ response: res, json: idx });
    });
    await page.route('**/levels/level4.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(level) }));
    await page.goto(srv.url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__vel?.ready === true);
    await page.evaluate((lvl) => window.__vel.start(lvl, { lockless: true }), id);
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
    const r = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const d = [];
          let last = performance.now();
          const t0 = last;
          const loop = (t) => {
            d.push(t - last);
            last = t;
            if (t - t0 < 14000) requestAnimationFrame(loop);
            else {
              d.sort((a, b) => a - b);
              resolve({ n: d.length, mean: d.reduce((a, b) => a + b, 0) / d.length, p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] });
            }
          };
          requestAnimationFrame(loop);
        }),
    );
    const s = await page.evaluate(() => window.__vel.state());
    console.log(`${id}: ${r.n} Frames, Ø ${r.mean.toFixed(2)} ms, p95 ${r.p95.toFixed(2)} ms, max ${r.max.toFixed(1)} ms (Bot bei x ${s.pos.x.toFixed(0)}, CP ${s.checkpoint.index})`);
    await page.close();
  }
} finally {
  await browser.close();
  await srv.close();
}
