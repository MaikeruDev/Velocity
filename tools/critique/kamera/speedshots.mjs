/**
 * Kamera-Kritik: gleicher Frame, verschiedene Geschwindigkeiten, FOV-Kick an/aus.
 * Route-Bot fährt level1/level2 in Echtzeit; bei Erreichen des Trigger-Speeds in der Luft
 * wird eingefroren, Speed per setVelocity gesetzt, FOV-Kick auf den Gleichgewichtswert
 * gestellt (Rig-Feld) und jeweils mit fovKick 1 und 0 fotografiert.
 *   node tools/critique/kamera/speedshots.mjs   → shots/critique/kamera/speed/   Port 5205
 */
import { mkdirSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';
import { openGame } from './lib.mjs';
import { fovKickTarget } from './derive.mjs';

const PORT = Number(process.env.CRIT_PORT2 ?? 5205);
const OUT = 'shots/critique/kamera/speed';
mkdirSync(OUT, { recursive: true });
const SPEEDS = [250, 500, 800, 1200];

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  for (const [level, trig] of [['level1', 700], ['level2', 650]]) {
    await openGame(page, srv.url, level);
    await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
    await page.waitForFunction((v) => { const s = window.__vel.state(); return s.speed >= v && !s.onGround; }, trig, { timeout: 60000, polling: 16 });
    await page.evaluate(() => window.__vel.freeze(true));
    const st = await page.evaluate(() => window.__vel.state());
    const hx = st.vel.x / st.speed;
    const hz = st.vel.z / st.speed;
    for (const v of SPEEDS) {
      for (const kick of [1, 0]) {
        await page.evaluate(([vx, vy, vz, k, fk]) => {
          window.__vel.setVelocity(vx, vy, vz);
          // Ein Tick, damit snapshot.speed (HUD, Post-Streifen, CA) den neuen Wert hat.
          window.__vel.stepTicks(1);
          window.__vel.setVelocity(vx, vy, vz);
          const rig = window.__rig;
          rig.setSettings({ ...rig.settings, fovKick: fk });
          rig.fovKickCur = k;
        }, [hx * v, st.vel.y, hz * v, fovKickTarget(v), kick]);
        await page.waitForTimeout(120);
        await page.screenshot({ path: `${OUT}/${level}-${v}-kick${kick}.png` });
      }
    }
    await page.evaluate(() => { const rig = window.__rig; rig.setSettings({ ...rig.settings, fovKick: 1 }); });
    console.log(level, 'Shots bei', Math.round(st.speed), 'u/s, pos', st.pos);
  }
} finally {
  await browser.close();
  await srv.close();
}
