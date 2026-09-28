/**
 * Kritik-Linse LEVEL-FLOW — gezielte Stellen im echten Spiel (ändert keinen Projektcode).
 * Port 5211 (CRIT_PORT). Crouch-Kante ohne/mit Ducken, Kehre/Abkürzung, Surf-Einstieg L2
 * mit W-Halter über echte Checkpoints (Respawn-Schleife).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_PORT ?? 5211);
const OUT = 'shots/critique/level-flow';
mkdirSync(OUT, { recursive: true });
const log = {};
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate(async () => document.fonts.ready);

  // --- Level 1: Checkpoints echt auslösen, dann Crouch-Kante
  await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await page.waitForTimeout(2500);
  const lv1 = await page.evaluate(() => window.__vel.levelInfo());
  const cps1 = lv1.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  await tp(page, cps1[0].spawn, cps1[0].spawnYaw);
  await page.waitForTimeout(200);
  const n16 = lv1.route[16].pos;
  await tp(page, { x: n16.x, y: n16.y, z: n16.z + 40 }, 0);
  await page.waitForTimeout(400);
  await shot(page, '30-l1-h7-crouch-wall-view');
  // Anfänger ohne Ducken: W+Shift, dann Leertaste halten, 4 s
  const trace = [];
  await page.evaluate(() =>
    window.__vel.setInputOverride((s, i) => ({ forward: 1, sprint: true, jumpHeld: true, jumpPressed: false, yaw: 0 })),
  );
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(250);
    const s = await st(page);
    trace.push([Math.round(s.pos.y), Math.round(s.pos.z), Math.round(s.speed), s.onGround ? 'G' : 'A', s.checkpoint.index]);
    if (i === 6) await shot(page, '31-l1-crouch-wall-bonk-no-crouch');
  }
  log.crouchNoCrouch = trace;
  await page.evaluate(() => window.__vel.setInputOverride(null));
  // mit Ducken in der Luft
  await tp(page, { x: n16.x, y: n16.y, z: n16.z + 40 }, 0);
  await page.waitForTimeout(200);
  const trace2 = [];
  await page.evaluate(() =>
    window.__vel.setInputOverride((s) => ({ forward: 1, sprint: true, jumpHeld: true, crouch: !s.onGround, yaw: 0 })),
  );
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    const s = await st(page);
    trace2.push([Math.round(s.pos.y), Math.round(s.pos.z), Math.round(s.speed), s.onGround ? 'G' : 'A', s.checkpoint.index]);
  }
  log.crouchWithCrouch = trace2;
  await page.evaluate(() => window.__vel.setInputOverride(null));

  // Kehre von CP2 aus, Blick auf Abkürzung
  const cp2 = cps1[1];
  await tp(page, cp2.spawn, cp2.spawnYaw);
  await page.waitForTimeout(400);
  await shot(page, '32-l1-cp2-kehre');
  await tp(page, cp2.spawn, cp2.spawnYaw + 55);
  await page.waitForTimeout(400);
  await shot(page, '33-l1-cp2-left-shortcut-islands');

  // --- Level 2: CP1 → CP2 echt, dann W-Halter am Surf
  await page.evaluate(() => window.__vel.start('level2', { lockless: true }));
  await page.waitForTimeout(2500);
  const lv2 = await page.evaluate(() => window.__vel.levelInfo());
  const cps2 = lv2.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  await tp(page, cps2[0].spawn, cps2[0].spawnYaw);
  await page.waitForTimeout(150);
  await tp(page, cps2[1].spawn, cps2[1].spawnYaw);
  await page.waitForTimeout(300);
  log.l2cp = (await st(page)).checkpoint;
  await shot(page, '34-l2-cp2-e1-view');
  await page.evaluate(() => window.__vel.events(0));
  await page.evaluate(() => window.__vel.setInputOverride(() => ({ forward: 1, yaw: 0 })));
  const t0 = Date.now();
  let shotSurf = false;
  const surf = [];
  while (Date.now() - t0 < 30000) {
    await page.waitForTimeout(200);
    const s = await st(page);
    surf.push([Math.round((Date.now() - t0) / 100) / 10, Math.round(s.pos.x), Math.round(s.pos.y), Math.round(s.pos.z), Math.round(s.speed), s.surfing ? 'S' : s.onGround ? 'G' : 'A']);
    if (!shotSurf && s.surfing) {
      shotSurf = true;
      await page.waitForTimeout(300);
      await shot(page, '35-l2-W-holder-on-surf1');
    }
  }
  await page.evaluate(() => window.__vel.setInputOverride(null));
  const ev = await page.evaluate(() => window.__vel.events().filter((e) => e.type === 'respawn').map((e) => [e.reason, e.t]));
  log.surfW30s = { respawns: ev.length, reasons: ev, samples: surf.filter((_, i) => i % 5 === 0) };
  // Blick mit A in die Rampe (richtig) zum Vergleich
  await tp(page, cps2[1].spawn, cps2[1].spawnYaw);
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__vel.events(0));
  await page.evaluate(() => window.__vel.setInputOverride((s) => ({ side: s.onGround ? 0 : -1, forward: s.onGround ? 1 : 0, yaw: 0 })));
  const t1 = Date.now();
  const surf2 = [];
  while (Date.now() - t1 < 8000) {
    await page.waitForTimeout(250);
    const s = await st(page);
    surf2.push([Math.round(s.pos.x), Math.round(s.pos.y), Math.round(s.pos.z), Math.round(s.speed), s.surfing ? 'S' : s.onGround ? 'G' : 'A', s.checkpoint.index]);
  }
  await page.evaluate(() => window.__vel.setInputOverride(null));
  const ev2 = await page.evaluate(() => window.__vel.events().filter((e) => e.type === 'respawn').length);
  log.surfA8s = { respawns: ev2, samples: surf2 };
} finally {
  await browser.close();
  await srv.close();
}
writeFileSync(`${OUT}/spots.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify(log));

async function tp(page, p, yaw) {
  await page.evaluate(({ p, yaw }) => window.__vel.teleport(p.x, p.y, p.z, yaw), { p, yaw });
}
async function st(page) {
  return page.evaluate(() => window.__vel.state());
}
async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
