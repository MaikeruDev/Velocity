// Freischalt-Leiter im echten Spiel: Bestzeiten + Trainingsstand der Leiter-Zeilen in localStorage, Spiel laden,
// Ableitung zählen (__vel.unlocks) — gegen shots/v2/kosmetik/unlock-ladder-core.json. Port 5419.
import { readFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';
const ladder = JSON.parse(readFileSync('shots/v2/kosmetik/unlock-ladder-core.json', 'utf8'));
const lessons = (id) => JSON.parse(readFileSync(`public/levels/training/${id}.json`, 'utf8')).training.stages;
const train = (ids) => ({ v: 1, lessons: Object.fromEntries(ids.map((id) => [id, { stages: lessons(id).filter((s) => !s.rank || s.rank === 'required').map((s) => s.id), stars: 1, at: '2026-10-01' }])) });
const srv = await startDevServer(5419);
const browser = await launchBrowser();
try {
  for (const [name, row] of Object.entries(ladder.rows)) {
    const best = {};
    for (const m of row.medals) { const [id, t] = m.split(' '); best[id] = { time: Number(t), splits: [], date: '2026-10-01' }; }
    const tr = name.startsWith('Einsteiger') ? train(['t1', 't2', 't3', 't4']) : train(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(({ best, tr }) => {
      if (sessionStorage.getItem('i')) return; sessionStorage.setItem('i', '1');
      localStorage.clear();
      localStorage.setItem('velocity.best.v1', JSON.stringify(best));
      localStorage.setItem('velocity.training.v1', JSON.stringify(tr));
    }, { best, tr });
    const page = await ctx.newPage();
    await page.goto(srv.url);
    await page.waitForFunction(() => window.__vel?.ready, null, { timeout: 30000 });
    await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
    await page.waitForTimeout(800);
    const u = await page.evaluate(() => window.__vel.unlocks());
    console.log(`${name}: im Spiel ${u.length} (Leiter ${row.count}) ${u.length === row.count ? 'OK' : 'ABWEICHUNG'} ${JSON.stringify(u)}`);
    await ctx.close();
  }
} finally { await browser.close(); await srv.close(); }
