/**
 * PROTOTYP-Shots (Kosmetik v2): Kontaktblätter der neuen Skins/Gegenstände am echten Viewmodel.
 *   node tools/critique/v2/kosmetik/shots.mjs [skins|props|combos ...]
 * Port KOS_PORT (Default 5310). Ausgabe: shots/v2/kosmetik/<name>.png + stats.json
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../../lib/devServer.mjs';

const PORT = Number(process.env.KOS_PORT ?? 5310);
const OUT = 'shots/v2/kosmetik';
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['skins', 'props', 'combos', 'ingame'];
const OPTS = {
  skins: { w: 220, h: 200, zoom: 2, depth: 27, x: 0.12, y: 0.2, cols: 4 },
  props: { w: 220, h: 200, zoom: 2, depth: 27, x: 0.12, y: 0.2, cols: 4 },
  combos: { w: 220, h: 200, zoom: 2, depth: 27, x: 0.12, y: 0.2, cols: 5 },
  // Spielgröße: 480×270, VM_DEPTH 40, Anker wie ViewHand (16:9: 0.889 − 0.30, 0.5 − 0.17).
  ingame: { w: 480, h: 270, zoom: 2, depth: 40, x: 0.589, y: 0.33, cols: 2 },
};
mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const statsPath = `${OUT}/stats.json`;
const allStats = existsSync(statsPath) ? JSON.parse(readFileSync(statsPath, 'utf8')) : {};
try {
  for (const name of names) {
    const o = OPTS[name];
    const width = o.cols * (o.w * o.zoom + 6) + 12;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`);
    });
    await page.goto(`${srv.url}tools/critique/v2/kosmetik/proto.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__kos !== undefined, null, { timeout: 30000 });
    const stats = await page.evaluate(([n, opt]) => window.__kos.render(n, opt), [name, o]);
    allStats[name] = stats;
    const el = await page.$('#sheet');
    await el.screenshot({ path: `${OUT}/${name}.png` });
    await page.close();
    console.log(`→ ${OUT}/${name}.png`);
  }
} finally {
  await browser.close();
  await srv.close();
}
writeFileSync(statsPath, JSON.stringify(allStats, null, 2));
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
