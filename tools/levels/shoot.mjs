/**
 * Screenshots der Level-Vorschau: node tools/levels/shoot.mjs level1:top level1:node:12 …
 * Eigener Port 5187 (Level-Strang), per SHOOT_PORT änderbar (parallele Stränge
 * brauchen eigene Ports). Bilder landen in shots/levels/.
 */
import { mkdirSync } from 'node:fs';
import { launchBrowser, startDevServer } from '../lib/devServer.mjs';

const PORT = Number(process.env.SHOOT_PORT ?? 5187);
const jobs = process.argv.slice(2);
if (jobs.length === 0) {
  console.error('Aufruf: node tools/levels/shoot.mjs <level>:<view> …   (view: top | iso | node:N | cam:x,y,z,tx,ty,tz)');
  process.exit(1);
}
mkdirSync('shots/levels', { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  for (const job of jobs) {
    const [level, ...rest] = job.split(':');
    const view = rest.join(':') || 'top';
    const size = view === 'top' ? { width: 1400, height: 1400 } : { width: 1280, height: 720 };
    const page = await browser.newPage({ viewport: size });
    page.on('pageerror', (e) => console.error(`[${job}] ${e.message}`));
    await page.goto(`${srv.url}tools/levels/preview.html?level=${level}&view=${encodeURIComponent(view)}`);
    await page.waitForFunction(() => window.__previewReady || window.__previewError, null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__previewError);
    if (err) console.error(`[${job}] ${err}`);
    const file = `shots/levels/${level}-${view.replace(/[:,]/g, '_')}.png`;
    await page.screenshot({ path: file });
    console.log(`✓ ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
  await srv.close();
}
