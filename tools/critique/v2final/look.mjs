// Blick 1:1: echte Maus im Pointer Lock — 1×100 px gegen 100×1 px, Wirkung ohne Frame-Verzug. Port 5419.
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';
const srv = await startDevServer(5419); const browser = await launchBrowser();
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(srv.url); await page.waitForFunction(() => window.__vel?.ready);
  await page.getByRole('button', { name: /Klicken zum Starten/i }).click();
  await page.waitForFunction(() => window.__vel.state().locked); await page.waitForTimeout(800);
  const yaw = () => page.evaluate(() => window.__vel.state().yawDeg);
  let x = 640; await page.mouse.move(x, 360); const y0 = await yaw();
  x += 100; await page.mouse.move(x, 360); const y1 = await yaw();
  for (let i = 0; i < 100; i++) { x += 1; await page.mouse.move(x, 360); } const y2 = await yaw();
  for (let i = 0; i < 20; i++) { x -= 7; await page.mouse.move(x, 360); } const y3 = await yaw();
  // Verzug: Maus bewegen, dann sofort im selben rAF die Kamera lesen
  const cam = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(window.__vel.state().yawDeg))));
  console.log(JSON.stringify({ one100: +(y1 - y0).toFixed(4), hundred1: +(y2 - y1).toFixed(4), back140: +(y3 - y2).toFixed(4), camAfterRaf: cam, stateYaw: y3 }));
} finally { await browser.close(); await srv.close(); }
