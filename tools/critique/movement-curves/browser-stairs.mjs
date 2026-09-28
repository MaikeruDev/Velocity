/**
 * Echtes Spiel (Chromium, Echtzeit-Loop): L1 Treppe vs. Rampe mit W + Leertaste gehalten
 * (Auto-Hop, Default). Port 5202 (CRIT_PORT). Screenshots + Verlauf nach
 * shots/critique/movement-curves/.
 *   node tools/critique/movement-curves/browser-stairs.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_PORT ?? 5202);
const OUT = 'shots/critique/movement-curves';
mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const result = {};
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${srv.url}?debug`);
  await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
  await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForFunction(() => window.__vel.state().gameState === 'playing', null, { timeout: 30000 });
  for (const [name, x, v0] of [['treppe', -96, 320], ['rampe', 96, 320], ['treppe500', -96, 500]]) {
    await page.evaluate(([x, v0]) => {
      const v = window.__vel;
      v.setInputOverride(null);
      v.teleport(x, 1, -1060, 0);
      v.setVelocity(0, 0, -v0);
      v.setView(0, -8);
      v.setInputOverride((s, i) => ({ forward: 1, sprint: true, jumpHeld: true, jumpPressed: i === 0 }));
    }, [x, v0]);
    const samples = [];
    const t0 = Date.now();
    let shot = 0;
    while (Date.now() - t0 < 4000) {
      const st = await page.evaluate(() => window.__vel.state());
      samples.push({ t: (Date.now() - t0) / 1000, z: Math.round(st.pos.z), y: Math.round(st.pos.y), speed: Math.round(st.speed), ground: st.onGround });
      if ((shot === 0 && Date.now() - t0 > 1200) || (shot === 1 && Date.now() - t0 > 3000)) {
        await page.screenshot({ path: `${OUT}/${name}-${shot}.png` });
        shot++;
      }
      await page.waitForTimeout(100);
    }
    const last = samples[samples.length - 1];
    result[name] = { reachedPlateau: samples.some((s) => s.z < -1600), last, samples };
    console.log(`${name}: nach 4 s z=${last.z} y=${last.y} speed=${last.speed} Plateau=${result[name].reachedPlateau}`);
    console.log('  Speed-Verlauf:', samples.filter((_, i) => i % 3 === 0).map((s) => `${s.t.toFixed(1)}s:${s.speed}@z${s.z}`).join(' '));
  }
} finally {
  await browser.close();
  await srv.close();
}
writeFileSync(`${OUT}/browser-stairs.json`, JSON.stringify({ result, errors }, null, 2));
if (errors.length) console.log('Seitenfehler:', errors);
