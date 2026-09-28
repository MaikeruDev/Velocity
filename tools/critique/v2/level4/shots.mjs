/**
 * Level 4 (Turm) — Screenshots des PROTOTYPS im echten Spiel (ändert keinen Projektcode):
 * index.json und level4.json werden im Browser per page.route() untergeschoben
 * (Quelle: shots/v2/level4/level4.json aus check.ts). Port 5308 (L4_PORT=…).
 *   node tools/critique/v2/level4/shots.mjs
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { launchBrowser, startDevServer } from '../../../lib/devServer.mjs';

const PORT = Number(process.env.L4_PORT ?? 5308);
const OUT = 'shots/v2/level4';
mkdirSync(OUT, { recursive: true });
const level = JSON.parse(readFileSync(`${OUT}/level4.json`, 'utf8'));
const errors = [];

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.route('**/levels/index.json', async (route) => {
    const res = await route.fetch();
    const idx = await res.json();
    idx.push({ id: 'level4', name: level.name, subtitle: level.subtitle, file: 'level4.json', medals: level.medals });
    await route.fulfill({ response: res, json: idx });
  });
  await page.route('**/levels/level4.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(level) }));
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  const ok = await page.evaluate(() => window.__vel.start('level4', { lockless: true }));
  if (!ok) throw new Error('level4 startet nicht');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/game-00-start.png` });

  const info = await page.evaluate(() => window.__vel.levelInfo());
  const cps = info.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const DEG = Math.PI / 180;
  const helix = (theta, r, y) => {
    const phi = (270 + theta) * DEG;
    return { x: r * Math.cos(phi), y, z: -r * Math.sin(phi), yaw: (270 + theta) % 360 };
  };
  const views = [
    ['01-start-turm', { x: -1400, y: 0, z: 896 }, 270 + 25, 22],
    ['02-e1-wendel', helix(40, 1000, 116), null, 4],
    ['03-e1-blick-hoch', helix(60, 1080, 172), null, 58],
    ['04-e2-innenbahn-graeben', helix(172, 760, 436), null, -8],
    ['05-e3-crouchkante', helix(343, 900, 832), null, 2],
    ['06-steg-krone-abfahrt', { x: -250, y: 1390, z: -896 }, 90, -4],
    ['07-krone-dropin', { x: cps[3].spawn.x, y: cps[3].spawn.y, z: cps[3].spawn.z }, 90, -28],
    ['08-uebersicht', { x: 2600, y: 1500, z: 2900 }, 38, -14],
    ['09-abfahrt-seitlich', { x: -3200, y: 900, z: 900 }, 60, -12],
  ];
  await page.evaluate(() => window.__vel.freeze(true));
  for (const [name, p, yawIn, pitch] of views) {
    const yaw = yawIn ?? p.yaw;
    await page.evaluate(({ p, yaw, pitch }) => {
      window.__vel.teleport(p.x, p.y, p.z, yaw);
      window.__vel.setView(yaw, pitch);
    }, { p, yaw, pitch });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/game-${name}.png` });
    console.log(`✓ ${OUT}/game-${name}.png`);
  }
  // Abfahrt in Fahrt: Route-Bot (sync 1.0) bis in die zweite Hälfte der Kette vorspulen.
  await page.evaluate(() => {
    window.__vel.restart();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.__vel.useBot('route', { sync: 1, seed: 11 });
    window.__vel.freeze(true);
  });
  let s = null;
  for (let i = 0; i < 80; i++) {
    s = await page.evaluate(() => window.__vel.stepTicks(64));
    if (s.pos.x < -4300 || s.finish) break;
  }
  await page.evaluate(() => window.__vel.freeze(false));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/game-10-abfahrt-fahrt.png` });
  console.log(`✓ ${OUT}/game-10-abfahrt-fahrt.png (x ${s.pos.x.toFixed(0)}, ${Math.round(s.speed)} u/s)`);
} finally {
  await browser.close();
  await srv.close();
}
if (errors.length) console.error(`${errors.length} Konsolenfehler:\n${errors.slice(0, 10).join('\n')}`);
