/**
 * Kritik-Linse HAENDE & LATENZ — lange Frames zuordnen: CPU-Profil (200 us) waehrend eines
 * Echtzeit-Bot-Laufs, danach zusammenhaengende Nicht-Idle-Strecken >= MIN_MS suchen und
 * deren Top-Funktionen (self time) ausgeben. Port 5201. Aendert keinen Projektcode.
 *
 *   node tools/critique/haende-latenz/hitch.mjs [level=level2] [sekunden=45]
 */
import { chromium } from 'playwright';
import { startDevServer } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_PORT2 ?? 5201);
const level = process.argv[2] ?? 'level2';
const seconds = Number(process.argv[3] ?? 45);
const MIN_MS = 12;

const srv = await startDevServer(PORT);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${srv.url}?level=${level}&lockless`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true && window.__vel.state().gameState === 'playing', null, { timeout: 20000 });
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  let restarts = 0;
  while (Date.now() - t0 < seconds * 1000) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => ({ g: window.__vel.state().gameState, b: window.__vel.state().bot?.status ?? null }));
    if (s.g === 'finished' || s.b === 'failed') {
      restarts++;
      await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
    }
  }
  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (id) => {
    const n = byId.get(id);
    const cf = n.callFrame;
    const url = cf.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '');
    return `${cf.functionName || '(anonym)'} ${url}:${cf.lineNumber + 1}`;
  };
  const isIdle = (id) => {
    const f = byId.get(id).callFrame.functionName;
    return f === '(idle)' || f === '(program)' || f === '(root)';
  };
  // Zeitstempel je Sample
  let t = profile.startTime;
  const times = [];
  for (const d of profile.timeDeltas) {
    t += d;
    times.push(t);
  }
  const hitches = [];
  let start = -1;
  for (let i = 0; i <= profile.samples.length; i++) {
    const busy = i < profile.samples.length && !isIdle(profile.samples[i]);
    if (busy && start < 0) start = i;
    if (!busy && start >= 0) {
      const ms = (times[i - 1] - times[start]) / 1000;
      if (ms >= MIN_MS) hitches.push({ start, end: i - 1, ms });
      start = -1;
    }
  }
  console.log(`${level}, ${seconds} s, Bot-Neustarts ${restarts}, zusammenhaengende Rechenstrecken >= ${MIN_MS} ms: ${hitches.length}`);
  for (const h of hitches.sort((a, b) => b.ms - a.ms).slice(0, 8)) {
    const self = new Map();
    const stackTop = new Map();
    for (let i = h.start; i <= h.end; i++) {
      const id = profile.samples[i];
      self.set(label(id), (self.get(label(id)) ?? 0) + 1);
      // obersten Spiel-Aufrufer (src/) im Stack finden
      let cur = id;
      let found = null;
      while (cur !== undefined) {
        const l = label(cur);
        if (l.includes('src/')) found = l;
        cur = parent.get(cur);
      }
      if (found) stackTop.set(found, (stackTop.get(found) ?? 0) + 1);
    }
    const n = h.end - h.start + 1;
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${((100 * v) / n).toFixed(0)}% ${k}`);
    const outer = [...stackTop].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${((100 * v) / n).toFixed(0)}% ${k}`);
    console.log(`\n-- ${h.ms.toFixed(1)} ms bei +${((times[h.start] - profile.startTime) / 1e6).toFixed(1)} s`);
    console.log('   self:  ' + top.join(' | '));
    console.log('   aeusserster src-Aufrufer: ' + outer.join(' | '));
  }
} finally {
  await browser.close();
  await srv.close();
}
