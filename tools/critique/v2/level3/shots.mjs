/**
 * Screenshots des Level-3-Prototyps über die Level-Vorschau (tools/levels/preview.html), ohne public/levels
 * anzufassen: die Anfrage /levels/level3proto*.json wird per Playwright auf die Prototyp-JSONs umgebogen.
 *   node tools/critique/v2/level3/shots.mjs      (Port 5306, L3_PORT=…)
 * Ausgabe: shots/v2/level3/*.png
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { launchBrowser, startDevServer } from '../../../lib/devServer.mjs';

const PORT = Number(process.env.L3_PORT ?? 5306);
const OUT = 'shots/v2/level3';
mkdirSync(OUT, { recursive: true });
const files = {
  level3fast: readFileSync(`${OUT}/level3-fast.json`, 'utf8'),
  level3safe: readFileSync(`${OUT}/level3-safe.json`, 'utf8'),
};
const jobs = [
  ['level3fast', 'top'],
  ['level3safe', 'top'],
  ['level3fast', 'iso'],
  ...(process.env.L3_VIEWS ?? '').split(',').filter(Boolean).map((v) => v.split('@')),
];
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  for (const [level, view] of jobs) {
    const size = view === 'top' ? { width: 1400, height: 1400 } : { width: 1280, height: 720 };
    const page = await browser.newPage({ viewport: size });
    page.on('pageerror', (e) => console.error(`[${level}:${view}] ${e.message}`));
    await page.route('**/levels/level3*.json', (route) => {
      const name = route.request().url().split('/').pop().replace('.json', '');
      route.fulfill({ status: 200, contentType: 'application/json', body: files[name] ?? '{}' });
    });
    await page.goto(`${srv.url}tools/levels/preview.html?level=${level}&view=${encodeURIComponent(view)}`);
    await page.waitForFunction(() => window.__previewReady || window.__previewError, null, { timeout: 90000 });
    const err = await page.evaluate(() => window.__previewError);
    if (err) console.error(`[${level}:${view}] ${err}`);
    const file = `${OUT}/${level}-${view.replace(/[:,]/g, '_')}.png`;
    await page.screenshot({ path: file });
    console.log(`✓ ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
  await srv.close();
}
