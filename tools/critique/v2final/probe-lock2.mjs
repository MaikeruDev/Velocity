import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';
const srv = await startDevServer(5419);
const browser = await launchBrowser();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => { if (sessionStorage.getItem('vel-init')) return; sessionStorage.setItem('vel-init', '1'); localStorage.clear(); localStorage.setItem('velocity.settings.v1', JSON.stringify({ fullscreenOnStart: false })); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__vel?.ready, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Training starten/i }).click();
  await page.waitForTimeout(1500);
  const st = () => page.evaluate(() => { const s = window.__vel.state(); return { g: s.gameState, menu: s.menu, locked: s.locked, lockless: s.lockless, lesson: s.lesson, yaw: s.yawDeg }; });
  console.log(JSON.stringify(await st()));
  await page.mouse.move(960, 540); await page.mouse.move(1060, 540, { steps: 10 });
  await page.waitForTimeout(100);
  console.log('after mouse', JSON.stringify(await st()));
  await page.screenshot({ path: 'tools/critique/v2final/shots/01-t1-start.png' });
} finally { await browser.close(); await srv.close(); console.log('errors', errors); }
