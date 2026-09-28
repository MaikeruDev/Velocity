/**
 * Kamera-Kritik: nimmt pro Szenario jeden gerenderten Frame auf (Rig-Zustand + Kamera).
 *   node tools/critique/kamera/record.mjs [szenario ...]
 * Szenarien: level1 level2 level1h (sync 0.8) walk bhop bhophuman drops duck stairs
 * Ausgabe: shots/critique/kamera/data/<szenario>.json   Port: 5204
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../../lib/devServer.mjs';
import { FIELDS, openGame, recStart, recStop } from './lib.mjs';

const PORT = Number(process.env.CRIT_PORT ?? 5204);
const OUT = 'shots/verify1/kamera/data';
const ALL = ['level1', 'level2', 'level1h', 'walk', 'bhop', 'bhophuman', 'drops', 'duck', 'stairs'];
let srv;
const want = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

async function routeRun(page, level, sync) {
  await openGame(page, srv.url, level);
  await recStart(page);
  await page.evaluate((s) => window.__vel.useBot('route', { sync: s, seed: 11 }), sync);
  const t0 = Date.now();
  for (;;) {
    const s = await page.evaluate(() => window.__vel.state());
    if (s.finish || s.gameState === 'finished') break;
    if (s.bot && s.bot.status === 'failed') break;
    if (Date.now() - t0 > 120000) break;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(600);
  return recStop(page);
}

/** Sandbox, Auffangboden y = -576 (6000 × 6000, frei). */
const FLOOR = -576;

async function sandbox(page) {
  // Auffangboden ohne Kill-Trigger (nur im Browser dieses Tools, per Request-Interception).
  if (!page.__sandboxRouted) {
    page.__sandboxRouted = true;
    await page.route('**/sandbox.json', async (route) => {
      const res = await route.fetch();
      const lv = await res.json();
      lv.triggers = lv.triggers.filter((t) => t.kind !== 'kill');
      await route.fulfill({ response: res, json: lv });
    });
  }
  await openGame(page, srv.url, 'sandbox');
}

const SCEN = {
  level1: (p) => routeRun(p, 'level1', 1),
  level2: (p) => routeRun(p, 'level2', 1),
  level1h: (p) => routeRun(p, 'level1', 0.8),

  async walk(page) {
    await sandbox(page);
    await page.evaluate((y) => window.__vel.teleport(0, y, 2000, 0), FLOOR);
    await page.waitForTimeout(300);
    await recStart(page);
    await page.evaluate(() => {
      let k = 0;
      window.__vel.setInputOverride(() => {
        const t = k++;
        if (t < 384) return { forward: 1, yaw: 0 };
        if (t < 768) return { forward: 1, sprint: true, yaw: 0 };
        if (t < 1024) return { forward: 1, crouch: true, yaw: 0 };
        if (t < 1152) return { yaw: 0 };
        if (t < 1408) return { side: -1, yaw: 0 };
        return { yaw: 0 };
      });
    });
    await page.waitForTimeout(12800);
    await page.evaluate(() => window.__vel.setInputOverride(null));
    return recStop(page);
  },

  bhop: (page) => bhopChain(page, {}),
  bhophuman: (page) => bhopChain(page, { aimNoiseDeg: 3, seed: 5 }),

  async drops(page) {
    await sandbox(page);
    const all = { frames: [], events: [], drops: [] };
    for (const h of [57, 127, 225, 400, 625, 1225]) {
      await page.evaluate(() => window.__vel.setInputOverride(() => ({ yaw: 0 })));
      await page.evaluate(([y, hh]) => window.__vel.teleport(2000, y + hh, 2000, 0), [FLOOR, h]);
      await recStart(page);
      await page.waitForFunction(() => window.__vel.state().onGround, null, { timeout: 10000, polling: 16 });
      await page.waitForTimeout(700);
      const r = await recStop(page);
      all.drops.push({ h, start: all.frames.length, n: r.frames.length });
      all.frames.push(...r.frames);
      all.events.push(...r.events);
    }
    await page.evaluate(() => window.__vel.setInputOverride(null));
    return all;
  },

  async duck(page) {
    await sandbox(page);
    await page.evaluate((y) => window.__vel.teleport(0, y, 0, 0), FLOOR);
    await page.waitForTimeout(300);
    await recStart(page);
    await page.evaluate(() => {
      let k = 0;
      window.__vel.setInputOverride(() => {
        const t = k++;
        if (t < 64) return { yaw: 0 };
        if (t < 192) return { crouch: true, yaw: 0 }; // Ducken im Stand
        if (t < 320) return { yaw: 0 };
        if (t < 330) return { jumpHeld: true, jumpPressed: t === 320, yaw: 0 }; // Sprung
        if (t < 520) return { crouch: true, yaw: 0 }; // Crouch in der Luft, geduckt landen
        return { yaw: 0 };
      });
    });
    await page.waitForTimeout(5000);
    await page.evaluate(() => window.__vel.setInputOverride(null));
    return recStop(page);
  },

  async stairs(page) {
    await sandbox(page);
    await page.evaluate(() => window.__vel.teleport(272, 16, 360, -90));
    await page.waitForTimeout(400);
    await recStart(page);
    await page.evaluate(() => window.__vel.setInputOverride(() => ({ forward: 1, yaw: -Math.PI / 2 })));
    await page.waitForTimeout(1600);
    await page.evaluate(() => window.__vel.setInputOverride(null));
    return recStop(page);
  },
};

async function bhopChain(page, opts) {
  await sandbox(page);
  await page.evaluate((y) => window.__vel.teleport(0, y, 0, 0), FLOOR);
  await page.waitForTimeout(300);
  await recStart(page);
  await page.evaluate(async (o) => {
    const { StrafeBot } = await import('/src/player/bots/StrafeBot.ts');
    const { VELOCITY_DEFAULT } = await import('/src/player/MovementConfig.ts');
    const bot = new StrafeBot(VELOCITY_DEFAULT, { mode: 'zigzag', sync: 1, ...o });
    window.__vel.setInputOverride((s) => {
      // Auf dem freien Auffangboden halten: in der Luft um 4000 u zurückversetzen.
      if (!s.onGround) {
        if (s.pos.x > 2400) s.pos.x -= 4000;
        else if (s.pos.x < -2400) s.pos.x += 4000;
        if (s.pos.z > 2400) s.pos.z -= 4000;
        else if (s.pos.z < -2400) s.pos.z += 4000;
      }
      return bot.next(s);
    });
  }, opts);
  await page.waitForFunction(() => window.__camrec.events.filter((e) => e.type === 'jump').length >= 52, null, { timeout: 90000, polling: 250 });
  await page.evaluate(() => window.__vel.setInputOverride(null));
  return recStop(page);
}

// ---------------------------------------------------------------- Ablauf
mkdirSync(OUT, { recursive: true });
srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  for (const name of want) {
    const t0 = Date.now();
    const res = await SCEN[name](page);
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ name, fields: FIELDS, ...res }));
    console.log(`${name}: ${res.frames.length} Frames, ${res.events.length} Events, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
} finally {
  await browser.close();
  await srv.close();
}
if (errors.length) console.error(errors.join('\n'));

