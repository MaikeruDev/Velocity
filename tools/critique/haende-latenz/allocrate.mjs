/**
 * Kritik-Linse HAENDE & LATENZ — echte Allokationsrate im Frame-/Tick-Pfad.
 * Wie tools/alloc-probe.mjs, aber MIT den von GC eingesammelten Objekten
 * (includeObjectsCollectedByMinorGC/MajorGC). Ohne diese Flags zaehlt das
 * Sampling nur Objekte, die beim Stop noch leben — kurzlebiger Muell pro Frame
 * (der GC-Pausen verursacht) faellt heraus. Waehrend der Messung kein Polling.
 * Port 5201 (CRIT_PORT2).
 *
 *   node tools/critique/haende-latenz/allocrate.mjs [level=level1] [sekunden=8] [--norecord]
 */
import { chromium } from 'playwright';
import { startDevServer } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_PORT2 ?? 5201);
const level = process.argv[2] ?? 'level1';
const seconds = Number(process.argv[3] ?? 8);
const noRecord = process.argv.includes('--norecord');

const srv = await startDevServer(PORT);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate((id) => window.__vel.start(id, { lockless: true }), level);
  await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  if (noRecord) {
    // Debug-Event-Recorder (kopiert jedes Event) abschalten: events() schaltet ihn ein, start() auch.
    await page.evaluate(() => {
      // kein offizieller Schalter — Recorder haengt an game.eventRecorder; ueber state nicht erreichbar.
    });
  }
  await page.waitForTimeout(2000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const results = {};
  for (const mode of ['nurLebende', 'alle']) {
    const params = { samplingInterval: 512 };
    if (mode === 'alle') Object.assign(params, { includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    await cdp.send('HeapProfiler.startSampling', params);
    await page.waitForTimeout(seconds * 1000);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const byFn = new Map();
    let total = 0;
    const walk = (n) => {
      const cf = n.callFrame;
      total += n.selfSize;
      const url = cf.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '');
      const key = `${cf.functionName || '(anonym)'}  ${url}:${cf.lineNumber + 1}`;
      byFn.set(key, (byFn.get(key) ?? 0) + n.selfSize);
      for (const c of n.children) walk(c);
    };
    walk(profile.head);
    const rows = [...byFn].sort((a, b) => b[1] - a[1]);
    const perSec = (b) => `${(b / 1024 / seconds).toFixed(1)} KiB/s`;
    results[mode] = { total: perSec(total), top: rows.slice(0, 18).map(([k, v]) => `${perSec(v).padStart(12)}  ${k}`) };
  }
  for (const [mode, r] of Object.entries(results)) {
    console.log(`\n== ${mode}: gesamt ${r.total}`);
    for (const l of r.top) console.log(l);
  }
} finally {
  await browser.close();
  await srv.close();
}
