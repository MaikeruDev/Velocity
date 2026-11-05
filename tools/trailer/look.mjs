/**
 * Erkundung: freie Kamera-Ansichten eines Levels als Low-Res-PNGs (ohne HUD/Hand), für Kameraflug-Planung.
 *   node tools/trailer/look.mjs <level> <outPrefix> '[[x,y,z,yawDeg,pitchDeg], …]'
 */
import { writeFileSync } from 'node:fs';
import { BASE_SETTINGS, openGame, startLevel } from './lib.mjs';

const [level, prefix, json] = process.argv.slice(2);
const views = JSON.parse(json);
const g = await openGame(Number(process.env.TRAILER_PORT ?? 5602));
try {
  await startLevel(g.page, level, BASE_SETTINGS);
  const info = await g.page.evaluate(() => {
    const i = window.__vel.levelInfo();
    return { spawn: i.spawn, spawnYaw: i.spawnYaw, triggers: i.triggers.map((t) => [t.kind, t.order, t.min, t.max]) };
  });
  console.log(JSON.stringify(info));
  await g.page.evaluate(() => {
    window.__vel.freeze(true);
    window.__vel.film({ on: true, hud: false });
  });
  for (let k = 0; k < views.length; k++) {
    const [x, y, z, yawDeg, pitchDeg] = views[k];
    const png = await g.page.evaluate(
      (c) => {
        window.__vel.filmCamera(c);
        window.__vel.advanceFrame(1 / 60);
        window.__vel.advanceFrame(1 / 60);
        return document.getElementById('vel-canvas').toDataURL('image/png');
      },
      { x, y, z, yawDeg, pitchDeg },
    );
    const f = `${prefix}${k}.png`;
    writeFileSync(f, Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
    console.log(f);
  }
} finally {
  await g.close();
}
