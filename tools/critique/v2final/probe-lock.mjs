// Prüft, ob headless Chromium echten Pointer Lock bekommt (dann echte Maus-Events möglich).
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';
const srv = await startDevServer(5419);
const browser = await launchBrowser();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('vel-init')) return;
    sessionStorage.setItem('vel-init', '1');
    localStorage.clear();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__vel?.ready, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'tools/critique/v2final/shots/00-title.png' });
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log(txt);
  const btns = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b => b.textContent.trim()).slice(0,40));
  console.log('BUTTONS', JSON.stringify(btns));
  console.log('state', JSON.stringify(await page.evaluate(() => { const s = window.__vel.state(); return { g: s.gameState, menu: s.menu, locked: s.locked }; })));
} finally { await browser.close(); await srv.close(); console.log('errors', errors); }
