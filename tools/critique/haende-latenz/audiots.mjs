/**
 * Kritik-Linse HAENDE & LATENZ — Kosten von AudioContext.getOutputTimestamp() im Frame-Pfad
 * (TechnoAudio.heardTime, jeder Frame via beat()). Wrapper misst jede echte Aufrufdauer.
 * Port 5201. Aendert keinen Projektcode.
 *
 *   node tools/critique/haende-latenz/audiots.mjs [sekunden=30]
 */
import { chromium } from 'playwright';
import { startDevServer } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_PORT2 ?? 5201);
const seconds = Number(process.argv[2] ?? 30);
const srv = await startDevServer(PORT);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    const N = 1 << 15;
    const P = (window.__ats = { d: new Float64Array(N), n: 0 });
    const orig = AudioContext.prototype.getOutputTimestamp;
    AudioContext.prototype.getOutputTimestamp = function () {
      const t0 = performance.now();
      const r = orig.call(this);
      P.d[P.n++ & (N - 1)] = performance.now() - t0;
      return r;
    };
  });
  await page.goto(`${srv.url}?level=level2&lockless`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true && window.__vel.state().gameState === 'playing', null, { timeout: 20000 });
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  await page.evaluate(() => {
    window.__ats.n = 0;
  });
  await page.waitForTimeout(seconds * 1000);
  const r = await page.evaluate(() => {
    const P = window.__ats;
    const n = Math.min(P.n, P.d.length);
    const a = Array.from(P.d.subarray(0, n)).sort((x, y) => x - y);
    const q = (p) => a[Math.min(n - 1, Math.floor(p * n))];
    return { calls: P.n, p50: q(0.5), p99: q(0.99), p999: q(0.999), max: a[n - 1], over1ms: a.filter((x) => x > 1).length, over4ms: a.filter((x) => x > 4).length };
  });
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
  await srv.close();
}
