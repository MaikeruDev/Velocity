/**
 * Kritik-Linse LOOK: Level-2-Finale — Blick entlang der gemessenen Bot-Flugbahn
 * (measure-lintel.json) auf das Ziel-Tor. Eingefroren, Kamera exakt auf der Bahn.
 */
import { readFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const OUT = 'shots/critique/look';
const path = JSON.parse(readFileSync(`${OUT}/measure-lintel.json`, 'utf8')).path;
const wantZ = [-6900, -7100, -7200, -7260, -7300];
const srv = await startDevServer(5209);
const browser = await launchBrowser();
try {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(srv.url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__vel?.ready === true);
  await p.evaluate(() => window.__vel.setRenderSettings({ pixelHeight: 270 }));
  await p.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await new Promise((r) => setTimeout(r, 2600));
  await p.evaluate(() => window.__vel.freeze(true));
  for (const z of wantZ) {
    const f = path.reduce((best, q) => (Math.abs(q.z - z) < Math.abs(best.z - z) ? q : best), path[0]);
    await p.evaluate((f) => {
      window.__vel.teleport(f.x, f.camY - 64, f.z, 0);
      window.__vel.setView(0, 0);
    }, f);
    await new Promise((r) => setTimeout(r, 250));
    await p.screenshot({ path: `${OUT}/E2-lintel-z${-f.z}.png` });
    console.log(z, f);
  }
} finally {
  await browser.close();
  await srv.close();
}
