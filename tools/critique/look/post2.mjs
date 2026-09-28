/**
 * Kritik-Linse LOOK: Sichtbarkeit von CA + Speed-Streifen (Port 5209).
 * Gleiche Kameraposition, einmal mit Tempo V (ein Tick vorgespult), einmal mit 0.
 * Rauschboden = zwei Grabs bei 0 (Kick-Puls, Sterne, Sonnenstreifen laufen weiter).
 * HUD-Bereiche (Timer oben, Speedometer Mitte unten) ausgenommen.
 */
import { writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from '../../lib/devServer.mjs';

const OUT = 'shots/critique/look';
const srv = await startDevServer(5209);
const browser = await launchBrowser();
const res = {};
try {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(srv.url, { waitUntil: 'load' });
  await p.waitForFunction(() => window.__vel?.ready === true);
  await p.evaluate(() => window.__vel.setRenderSettings({ pixelHeight: 270 }));
  await p.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await new Promise((r) => setTimeout(r, 2600));
  await p.evaluate(() => {
    window.__grab = () =>
      new Promise((res) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const c = document.getElementById('vel-canvas');
            const cv = window.__gcv ?? (window.__gcv = document.createElement('canvas'));
            cv.width = c.width;
            cv.height = c.height;
            const x = cv.getContext('2d', { willReadFrequently: true });
            x.drawImage(c, 0, 0);
            res(x.getImageData(0, 0, c.width, c.height));
          }),
        );
      });
    // Diff zweier Bilder außerhalb der HUD-Zonen; zusätzlich getrennt: Rand (r>0.5) und Mitte.
    window.__diff = (A, B) => {
      const a = A.data;
      const b = B.data;
      const W = A.width;
      const H = A.height;
      let n = 0;
      let ch = 0;
      let strong = 0;
      let sum = 0;
      let edgeN = 0;
      let edgeCh = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const fx = x / W;
          const fy = y / H;
          if (fx > 0.35 && fx < 0.65 && (fy < 0.2 || (fy > 0.62 && fy < 0.9))) continue;
          const i = (y * W + x) * 4;
          const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          n++;
          sum += d;
          if (d > 0) ch++;
          if (d > 30) strong++;
          const cx = (x - W / 2) / (H / 2);
          const cy = (y - H / 2) / (H / 2);
          const r = Math.hypot(cx, cy) / Math.hypot(W / H, 1);
          if (r > 0.5) {
            edgeN++;
            if (d > 0) edgeCh++;
          }
        }
      return { changed: +(ch / n).toFixed(4), strong: +(strong / n).toFixed(4), mean: +(sum / n / 3).toFixed(3), edgeChanged: +(edgeCh / edgeN).toFixed(4) };
    };
  });
  const info = await p.evaluate(() => window.__vel.levelInfo());
  const n = info.route[9].pos;
  await p.evaluate(() => window.__vel.freeze(true));
  for (const chromatic of [0.5, 0]) {
    await p.evaluate((c) => window.__vel.setRenderSettings({ chromatic: c }), chromatic);
    for (const V of [500, 800, 1100, 1500]) {
      // Tempo V: teleport, Geschwindigkeit, 1 Tick (Snapshot.speed wird erst im Tick gesetzt)
      const pos = await p.evaluate(({ n, V }) => {
        window.__vel.teleport(n.x, n.y, n.z + 60, 0);
        window.__vel.setView(0, 0);
        window.__vel.setVelocity(0, 0, -V);
        const s = window.__vel.stepTicks(1);
        return { pos: s.pos, speed: s.speed };
      }, { n, V });
      const m = await p.evaluate(async () => {
        const fast = [];
        for (let k = 0; k < 6; k++) fast.push(await window.__grab());
        return fast.length;
      });
      await p.evaluate(async () => {
        window.__fast = [];
        for (let k = 0; k < 6; k++) window.__fast.push(await window.__grab());
      });
      if (chromatic === 0.5) await p.screenshot({ path: `${OUT}/E3b-v${V}.png` });
      // Tempo 0 an exakt derselben Stelle
      await p.evaluate((pp) => {
        window.__vel.teleport(pp.x, pp.y, pp.z, 0);
        window.__vel.setView(0, 0);
        window.__vel.setVelocity(0, 0, 0);
        window.__vel.stepTicks(1);
      }, pos.pos);
      const r = await p.evaluate(async () => {
        const slow = [];
        for (let k = 0; k < 6; k++) slow.push(await window.__grab());
        const sig = [];
        const noise = [];
        for (let k = 0; k < 6; k++) sig.push(window.__diff(window.__fast[k], slow[k]));
        for (let k = 0; k < 5; k++) noise.push(window.__diff(slow[k], slow[k + 1]));
        const avg = (xs, key) => +(xs.reduce((a, x) => a + x[key], 0) / xs.length).toFixed(4);
        return {
          signal: { changed: avg(sig, 'changed'), strong: avg(sig, 'strong'), mean: avg(sig, 'mean'), edgeChanged: avg(sig, 'edgeChanged') },
          noise: { changed: avg(noise, 'changed'), strong: avg(noise, 'strong'), mean: avg(noise, 'mean'), edgeChanged: avg(noise, 'edgeChanged') },
        };
      });
      if (chromatic === 0.5 && V === 1500) await p.screenshot({ path: `${OUT}/E3b-v0.png` });
      res[`ca${chromatic}-v${V}`] = { speedAfterTick: pos.speed, ...r };
      console.log(`ca${chromatic} v${V}`, JSON.stringify(res[`ca${chromatic}-v${V}`]), m);
    }
  }
} finally {
  await browser.close();
  await srv.close();
}
writeFileSync(`${OUT}/measure-post.json`, JSON.stringify(res, null, 1));
