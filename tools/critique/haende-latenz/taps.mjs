/**
 * Kritik-Linse HAENDE & LATENZ — kurze Tasten-Tipper (kuerzer als ein Frame) im echten Spiel.
 * Space hat eine Flanken-Klammer (pendingJump), C/A/D nicht: sieht irgendein Tick den Tipper?
 * Port 5200. Aendert keinen Projektcode.
 */
import { chromium } from 'playwright';
import { startDevServer } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_PORT ?? 5200);
const srv = await startDevServer(PORT);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${srv.url}?level=level1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true && window.__vel.state().gameState === 'paused', null, { timeout: 20000 });
  await page.locator('button:has(.vel-resume-label)').click();
  await page.waitForFunction(() => window.__vel.state().locked, null, { timeout: 3000 });
  const res = {};
  for (const [key, evType] of [['Space', 'jump'], ['KeyC', 'duck']]) {
    let seen = 0;
    const N = 30;
    for (let k = 0; k < N; k++) {
      await page.evaluate(() => {
        const li = window.__vel.levelInfo();
        window.__vel.teleport(li.spawn.x, li.spawn.y, li.spawn.z, li.spawnYaw);
        window.__vel.setVelocity(0, 0, 0);
      });
      await page.waitForTimeout(250);
      const n0 = await page.evaluate(() => window.__vel.events().length);
      // Tipper von ~2-4 ms, zufaellige Phase zum Frame
      await page.waitForTimeout(Math.random() * 16);
      await page.evaluate(
        (code) =>
          new Promise((r) => {
            // echter Tipper ueber CDP waere besser; hier synthetisch, gleiche Handler-Pfade (keydown/keyup auf window)
            window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
            setTimeout(() => {
              window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
              r(null);
            }, 3);
          }),
        key,
      );
      await page.waitForTimeout(120);
      const hit = await page.evaluate(([n0, t]) => window.__vel.events().slice(n0).some((e) => e.type === t), [n0, evType]);
      if (hit) seen++;
    }
    res[key] = `${seen}/${N} Tipper (3 ms) wirkten`;
  }
  // Seitentaste: kurzer D-Tipper in der Luft -> aendert sich die Geschwindigkeit seitlich?
  let sideSeen = 0;
  const N2 = 30;
  for (let k = 0; k < N2; k++) {
    await page.evaluate(() => {
      const li = window.__vel.levelInfo();
      window.__vel.teleport(li.spawn.x, li.spawn.y + 400, li.spawn.z, 0);
      window.__vel.setVelocity(0, 0, -400);
    });
    await page.waitForTimeout(40 + Math.random() * 16);
    const v0 = await page.evaluate(() => window.__vel.state().vel.x);
    await page.evaluate(
      () =>
        new Promise((r) => {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }));
          setTimeout(() => {
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', bubbles: true }));
            r(null);
          }, 3);
        }),
    );
    await page.waitForTimeout(50);
    const v1 = await page.evaluate(() => window.__vel.state().vel.x);
    if (Math.abs(v1 - v0) > 0.5) sideSeen++;
  }
  res.KeyD_air = `${sideSeen}/${N2} Tipper (3 ms) wirkten`;
  console.log(JSON.stringify(res));
} finally {
  await browser.close();
  await srv.close();
}
