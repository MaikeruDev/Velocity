// HUD-Mitte mit Ghost (Prüfung 27.09., Befund 3): PB-Lauf, dann langsamer Lauf gegen den Ghost.
// Zählt Frames, in denen der Ghost hinter dem Speedometer liegt (HUD dimmt), und macht
// Screenshots dort sowie kurz nach jedem Checkpoint (Split-Popup vs. GHOST-Zeile).
//   node tools/critique/verify1/hudghost.mjs [level1]   (HUDGHOST_PORT, Default 5240)
import { mkdirSync } from 'node:fs';
import { launchBrowser, startDevServer } from '../../lib/devServer.mjs';

const PORT = Number(process.env.HUDGHOST_PORT ?? 5240);
const LEVEL = process.argv[2] ?? 'level1';
const OUT = 'shots/verify1/hudghost';
mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(srv.url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate((id) => window.__vel.start(id, { lockless: true }), LEVEL);
  for (const [tag, sync] of [['pb', 1], ['slow', 0.9]]) {
    await page.evaluate((o) => window.__vel.useBot('route', { sync: o.sync, seed: 7, restart: true }), { sync });
    let over = 0;
    let polls = 0;
    let lastCp = 0;
    let overShots = 0;
    let lastOverShot = -10;
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await page.waitForTimeout(50);
      const { s, g } = await page.evaluate(() => ({ s: window.__vel.state(), g: window.__vel.ghost() }));
      if (s.finish) break;
      if (!s.running) continue;
      polls++;
      if (g.overHud) over++;
      if (tag === 'slow' && g.overHud && overShots < 4 && s.runTime - lastOverShot > 2) {
        await page.waitForTimeout(150); // Einblenden abwarten
        await page.screenshot({ path: `${OUT}/${LEVEL}-over-${s.runTime.toFixed(1)}s.png` });
        overShots++;
        lastOverShot = s.runTime;
      }
      if (s.checkpoint.index > lastCp) {
        lastCp = s.checkpoint.index;
        if (tag === 'slow') {
          await page.waitForTimeout(250);
          await page.screenshot({ path: `${OUT}/${LEVEL}-cp${lastCp}.png` });
        }
      }
    }
    console.log(`${tag}: ${polls} Proben im Lauf, Ghost hinter dem Speedometer ${over} (${polls ? ((100 * over) / polls).toFixed(1) : 0} %)`);
    await page.waitForTimeout(1500);
  }
} finally {
  await browser.close();
  await srv.close();
}
