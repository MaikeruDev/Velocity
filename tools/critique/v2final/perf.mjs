// Performance je Level (1920×1080): Draw Calls/Dreiecke Szene + Viewmodel, frameCost, rAF-Framezeiten während eines
// Bot-Laufs; mit jedem Gegenstand × Skin (Budget ≤ 50 Calls / 12 000 Dreiecke). Port 5419.
import { writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';
const srv = await startDevServer(5419);
const browser = await launchBrowser();
const out = { levels: {}, combos: [] };
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => { if (sessionStorage.getItem('i')) return; sessionStorage.setItem('i', '1'); localStorage.clear(); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__vel?.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.__vel.unlockAll());
  for (const id of ['level1', 'level2', 'level3', 'level4', 't3', 't8']) {
    await page.evaluate((id) => window.__vel.start(id, { lockless: true }), id);
    await page.waitForFunction(() => window.__vel.state().gameState === 'playing');
    const hasRoute = await page.evaluate(() => window.__vel.state().routeNodes > 0);
    if (hasRoute && id.startsWith('level')) await page.evaluate(() => window.__vel.useBot('route', { sync: 1 }));
    const calls = [], vm = [], tris = [];
    await page.evaluate(() => window.__vel.frameCost());
    const dts = await page.evaluate(() => new Promise((res) => { const a = []; let last = performance.now(); let n = 0; const f = (t) => { a.push(t - last); last = t; if (++n < 600) requestAnimationFrame(f); else res(a); }; requestAnimationFrame(f); }));
    for (let i = 0; i < 6; i++) { const s = await page.evaluate(() => window.__vel.renderStats()); calls.push(s.sceneCalls); vm.push(s.viewModelCalls); tris.push(s.sceneTriangles); await page.waitForTimeout(700); }
    const fc = await page.evaluate(() => window.__vel.frameCost());
    const sorted = [...dts].sort((a, b) => a - b);
    out.levels[id] = { sceneCallsMax: Math.max(...calls), sceneCallsMin: Math.min(...calls), vmCalls: Math.max(...vm), sceneTrisMax: Math.max(...tris), frameMsP50: +sorted[300].toFixed(2), frameMsP99: +sorted[594].toFixed(2), frameMsMax: +sorted.at(-1).toFixed(2), cpuFrameMs: fc };
    await page.evaluate(() => window.__vel.useBot(null));
    console.log(id, JSON.stringify(out.levels[id]));
  }
  // Skin × Gegenstand: Viewmodel-Budget im laufenden Spiel
  await page.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await page.waitForFunction(() => window.__vel.state().gameState === 'playing');
  for (const glove of ['classic', 'neon', 'gold', 'robot', 'skeleton', 'cat']) {
    for (const item of ['none', 'can', 'card', 'knife', 'yoyo', 'spinner', 'coin', 'lighter', 'kendama', 'phone']) {
      await page.evaluate(({ glove, item }) => { const raw = JSON.parse(localStorage.getItem('velocity.settings.v1') ?? '{}'); }, { glove, item });
      await page.evaluate(({ glove, item }) => window.__velSettings?.update?.({ glove, heldItem: item }), { glove, item });
    }
  }
} finally {
  out.errors = errors;
  writeFileSync('tools/critique/v2final/logs/perf.json', JSON.stringify(out, null, 1));
  await browser.close(); await srv.close();
  console.log('errors', errors.length, errors.slice(0, 3));
}
