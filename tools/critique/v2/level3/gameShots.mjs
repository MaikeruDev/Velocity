/**
 * Level-3-Prototyp im ECHTEN Spiel-Renderer (PS2-Pipeline, Trims, Fog, HUD), ohne public/levels anzufassen:
 * index.json wird um "level3" ergänzt und level3.json auf die Prototyp-JSON umgebogen (Playwright-Route).
 *   node tools/critique/v2/level3/gameShots.mjs [fast|safe]      (Port 5307, L3_GAME_PORT=…)
 * Ausgabe: shots/v2/level3/game-*.png
 */
import { readFileSync } from 'node:fs';
import { launchBrowser, startDevServer } from '../../../lib/devServer.mjs';

const PORT = Number(process.env.L3_GAME_PORT ?? 5307);
const OUT = 'shots/v2/level3';
const variant = process.argv[2] ?? 'fast';
const levelJson = readFileSync(`${OUT}/level3-${variant}.json`, 'utf8');
const def = JSON.parse(levelJson);
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route('**/levels/index.json', async (route) => {
    const res = await route.fetch();
    const idx = await res.json();
    idx.push({ id: 'level3', name: def.name, subtitle: def.subtitle, file: 'level3.json' });
    await route.fulfill({ response: res, body: JSON.stringify(idx), headers: { 'content-type': 'application/json' } });
  });
  await page.route('**/levels/level3.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: levelJson }));
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  const ok = await page.evaluate(() => window.__vel.start('level3', { lockless: true }));
  if (!ok) throw new Error('level3 startet nicht');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/game-${variant}-01-start.png` });
  // Bot fährt die Route; an Zeitmarken anhalten und fotografieren.
  await page.evaluate(() => {
    window.__vel.useBot('route', { sync: 1, seed: 11 });
    window.__vel.freeze(true);
  });
  const marks = [
    [4.6, 'kehre-einfahrt'],
    [7.5, 'kehre-mitte'],
    [11.2, 'kehre-ausfahrt'],
    [14.2, 'z'],
    [17.2, 'finale-launch'],
  ];
  let t = 0;
  for (const [at, name] of marks) {
    const ticks = Math.max(0, Math.round((at - t) * 128));
    if (ticks > 0) await page.evaluate((n) => window.__vel.stepTicks(n), ticks);
    t = at;
    await page.evaluate(() => window.__vel.freeze(false));
    await page.waitForTimeout(160);
    await page.evaluate(() => window.__vel.freeze(true));
    const st = await page.evaluate(() => window.__vel.state());
    await page.screenshot({ path: `${OUT}/game-${variant}-${name}.png` });
    console.log(`✓ ${name}: t ${at}s, Tempo ${Math.round(st.speed ?? 0)} u/s, pos ${[st.pos?.x, st.pos?.y, st.pos?.z].map((v) => Math.round(v ?? 0)).join(',')}`);
  }
} finally {
  await browser.close();
  await srv.close();
}
if (errors.length) console.error(`Konsolenfehler:\n${errors.slice(0, 5).join('\n')}`);
