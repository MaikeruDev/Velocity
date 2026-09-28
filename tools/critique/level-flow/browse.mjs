/**
 * Kritik-Linse LEVEL-FLOW — die ersten 90 Sekunden im echten Spiel (ändert keinen Projektcode).
 * Port 5210 (CRIT_PORT). Screenshots → shots/critique/level-flow/.
 *
 *   node tools/critique/level-flow/browse.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_PORT ?? 5210);
const OUT = 'shots/critique/level-flow';
mkdirSync(OUT, { recursive: true });
const VIEW = { width: 1280, height: 720 };
const log = {};
const errors = [];

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.waitForTimeout(2200);
  await shot(page, '01-title');
  log.titleText = await page.evaluate(() => document.querySelector('.vel-menu')?.innerText ?? '');

  // Steuerung
  await page.getByRole('button', { name: 'Steuerung' }).click();
  await page.waitForTimeout(300);
  await shot(page, '02-controls');
  log.controlsText = await page.evaluate(() => document.querySelector('.vel-menu')?.innerText ?? '');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Klick → spielen (Ladezeit messen)
  const t0 = Date.now();
  await page.locator('.vel-start').click();
  await page.waitForFunction(() => window.__vel.state().gameState === 'playing', null, { timeout: 10000 });
  log.clickToPlayingMs = Date.now() - t0;
  const st0 = await st(page);
  log.afterClick = { locked: st0.locked, lockless: st0.lockless, level: st0.levelId, menu: st0.menu };
  await page.waitForTimeout(250);
  await shot(page, '03-level1-0.25s');
  await page.waitForTimeout(1000);
  await shot(page, '04-level1-1.25s-intro');

  // Anfänger drückt W und Leertaste gleichzeitig (echte Tasten)
  await page.keyboard.down('KeyW');
  await page.keyboard.down('Space');
  const crawl = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    const s = await st(page);
    crawl.push([Math.round(s.speed), Math.round(s.pos.z), s.onGround ? 'G' : 'A']);
    if (i === 7) await shot(page, '05-level1-W+Space-crawl-2s');
  }
  log.wSpaceCrawl = crawl;
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyW');

  // W halten ohne Sprung → fällt in Lücke 1: Tod → Respawn messen
  await page.evaluate(() => window.__vel.restart());
  await page.waitForTimeout(300);
  await page.keyboard.down('KeyW');
  const fall = [];
  const tf0 = Date.now();
  let respawnSeen = null;
  let shotFall = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(50);
    const s = await st(page);
    fall.push([Date.now() - tf0, Math.round(s.pos.y), Math.round(s.pos.z), s.runTime]);
    if (!shotFall && s.pos.y < -120) {
      shotFall = true;
      await shot(page, '06-level1-fall-in-gap1');
    }
    const ev = await page.evaluate(() => window.__vel.events().filter((e) => e.type === 'respawn').at(-1) ?? null);
    if (ev && ev.reason !== 'restart' && respawnSeen === null) {
      respawnSeen = Date.now() - tf0;
      await shot(page, '07-level1-respawn-fade');
      break;
    }
  }
  await page.keyboard.up('KeyW');
  log.fallToRespawn = { ms: respawnSeen, samples: fall.filter((_, i) => i % 3 === 0) };
  await page.waitForTimeout(600);
  await shot(page, '08-level1-after-respawn');
  log.afterRespawn = await st(page);

  // Crouch-Kante: was sieht man auf H7?
  const lv1 = await page.evaluate(() => window.__vel.levelInfo());
  const n16 = lv1.route[16].pos;
  await page.evaluate(({ p }) => window.__vel.teleport(p.x, p.y, p.z + 180, 0), { p: n16 });
  await page.waitForTimeout(400);
  await shot(page, '09-level1-crouch-wall-view');
  // normal springen gegen die Wand (ohne Ducken)
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(300);
  await page.keyboard.down('Space');
  await page.waitForTimeout(2500);
  const atWall = await st(page);
  await shot(page, '10-level1-crouch-wall-bonk');
  await page.keyboard.up('Space');
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  log.crouchWallNoCrouch = { pos: atWall.pos, speed: atWall.speed, cp: atWall.checkpoint };

  // Kehre / Könner-Inseln sichtbar? Blick von der Kante (CP2)
  const cp2 = lv1.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order)[1];
  await page.evaluate(({ p, y }) => window.__vel.teleport(p.x, p.y, p.z, y), { p: cp2.spawn, y: cp2.spawnYaw });
  await page.waitForTimeout(400);
  await shot(page, '11-level1-cp2-view-kehre');
  await page.evaluate(({ p, y }) => window.__vel.teleport(p.x, p.y, p.z, y + 40), { p: cp2.spawn, y: cp2.spawnYaw });
  await page.waitForTimeout(400);
  await shot(page, '12-level1-cp2-view-left-shortcut');

  // Level 2: E1 (CP2) → Surf-Blick, Anfänger hält W
  await page.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await page.waitForTimeout(1300);
  await shot(page, '13-level2-start');
  const lv2 = await page.evaluate(() => window.__vel.levelInfo());
  const cps2 = lv2.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  await page.evaluate(({ p, y }) => window.__vel.teleport(p.x, p.y, p.z, y), { p: cps2[1].spawn, y: cps2[1].spawnYaw });
  await page.waitForTimeout(400);
  await shot(page, '14-level2-cp2-surf-view');
  await page.keyboard.down('KeyW');
  const surf = [];
  let surfShot = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100);
    const s = await st(page);
    surf.push([Math.round(s.pos.x), Math.round(s.pos.y), Math.round(s.pos.z), Math.round(s.speed), s.surfing ? 'S' : s.onGround ? 'G' : 'A', s.checkpoint.index]);
    if (s.surfing && surfShot === 0) {
      surfShot = 1;
      await shot(page, '15-level2-novice-W-on-surf');
    }
  }
  await page.keyboard.up('KeyW');
  const ev2 = await page.evaluate(() => window.__vel.events().filter((e) => e.type === 'respawn').map((e) => e.reason));
  log.level2NoviceSurfW = { samples: surf.filter((_, i) => i % 2 === 0), respawns: ev2 };
  await shot(page, '16-level2-after-surf-fail');

  // Ergebnis-Screen + Restart-Fluss: Level 2 mit perfektem Bot
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  await page.waitForFunction(() => window.__vel.state().gameState === 'finished', null, { timeout: 60000 });
  const tFin = Date.now();
  await page.waitForFunction(() => window.__vel.state().menu === 'finish', null, { timeout: 5000 });
  log.finishToMenuMs = Date.now() - tFin;
  await page.waitForTimeout(500);
  await shot(page, '17-level2-finish-screen');
  log.finishText = await page.evaluate(() => document.querySelector('.vel-menu')?.innerText ?? '');
  log.finish = (await st(page)).finish;
  // R im Ergebnis → wie schnell wieder spielbar?
  const tR = Date.now();
  await page.keyboard.press('KeyR');
  await page.waitForFunction(() => window.__vel.state().gameState === 'playing', null, { timeout: 5000 });
  log.rToPlayingMs = Date.now() - tR;
  await page.waitForTimeout(80);
  await shot(page, '18-level2-after-R');
  // Zweiter Lauf: was zeigt das HUD am CP (Split gegen Bestzeit)?
  await page.evaluate(() => window.__vel.useBot('route', { sync: 0.8, seed: 3, restart: true }));
  await page.waitForFunction(() => window.__vel.state().checkpoint.index >= 1, null, { timeout: 20000 });
  await page.waitForTimeout(150);
  await shot(page, '19-level2-split-popup-cp1');
  await page.waitForFunction(() => window.__vel.state().gameState === 'finished', null, { timeout: 60000 });
  await page.waitForTimeout(300);
  await shot(page, '20-level2-finish-hud-coast');
  await page.waitForFunction(() => window.__vel.state().menu === 'finish', null, { timeout: 5000 });
  await page.waitForTimeout(500);
  await shot(page, '21-level2-finish-screen-2nd');
  log.finishText2 = await page.evaluate(() => document.querySelector('.vel-menu')?.innerText ?? '');

  // Titel mit Bestzeiten
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await shot(page, '22-title-with-best');
} finally {
  await browser.close();
  await srv.close();
}
log.errors = errors;
writeFileSync(`${OUT}/browse.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));

async function st(page) {
  return page.evaluate(() => window.__vel.state());
}
async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
