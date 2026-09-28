/**
 * Kritik-Linse HAENDE & LATENZ — Probe 2: Frame-Pacing, lange Frames, GC waehrend eines
 * Echtzeit-Bot-Laufs. CDP-Trace (GC, Animation Frames) + rAF-Huelle ohne Allokation.
 * Port 5201 (CRIT_PORT2). Aendert keinen Projektcode.
 *
 *   node tools/critique/haende-latenz/pacing.mjs [--uncapped] [--level level1] [--seconds 20] [--pixel 240]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startDevServer } from '../../lib/devServer.mjs';

const PORT = Number(process.env.CRIT_PORT2 ?? 5201);
const OUT = 'shots/critique/haende-latenz';
const argv = process.argv.slice(2);
const UNCAPPED = argv.includes('--uncapped');
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const LEVEL = opt('--level', 'level1');
const SECONDS = Number(opt('--seconds', '20'));
const PIXEL = opt('--pixel', null);
const VW = Number(opt('--w', '1280'));
const VH = Number(opt('--h', '720'));
mkdirSync(OUT, { recursive: true });

const args = ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
if (UNCAPPED) args.push('--disable-gpu-vsync', '--disable-frame-rate-limit');

const srv = await startDevServer(PORT);
const browser = await chromium.launch({ args });
let result;
try {
  const page = await browser.newPage({ viewport: { width: VW, height: VH } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const N = 1 << 16;
    const P = (window.__pace = { ts: new Float64Array(N), cb: new Float64Array(N), gap: new Float64Array(N), n: 0, on: false, lastEnd: 0 });
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      raf((ts) => {
        if (P.on && cb.name === 'frame') {
          const t0 = performance.now();
          cb(ts);
          const t1 = performance.now();
          const i = P.n & (N - 1);
          P.ts[i] = ts;
          P.cb[i] = t1 - t0;
          // Zeit zwischen Ende des vorigen Spiel-Callbacks und Start dieses (Browser-Arbeit, GPU-Wartezeit)
          P.gap[i] = P.lastEnd > 0 ? t0 - P.lastEnd : 0;
          P.lastEnd = t1;
          P.n++;
          return;
        }
        cb(ts);
      });
  });
  // Start per Query (?level=&lockless): ohne Debug-Event-Recorder, der jedes Event kopiert (im echten Spiel aus).
  await page.goto(srv.url + '?level=' + LEVEL + '&lockless', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true && window.__vel.state().gameState === 'playing', null, { timeout: 20000 });
  if (PIXEL) await page.evaluate((p) => window.__vel.setRenderSettings({ pixelHeight: Number(p) }), PIXEL);
  const hasRoute = await page.evaluate(() => window.__vel.state().routeNodes > 0);
  await page.evaluate((r) => (r ? window.__vel.useBot('route', { sync: 1, seed: 11 }) : window.__vel.useBot('strafe', { sync: 1 })), hasRoute);
  await page.waitForTimeout(1500);

  const cdp = await page.context().newCDPSession(page);
  const traceEvents = [];
  cdp.on('Tracing.dataCollected', (d) => traceEvents.push(...d.value));
  const done = new Promise((res) => cdp.once('Tracing.tracingComplete', res));
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8,disabled-by-default-v8.gc,disabled-by-default-devtools.timeline.frame,blink.user_timing',
    transferMode: 'ReportEvents',
  });
  const heap = [];
  await page.evaluate(() => {
    window.__pace.on = true;
    window.__pace.n = 0;
    window.__pace.lastEnd = 0;
  });
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    await page.waitForTimeout(1000);
    const h = await page.evaluate(() => {
      const s = window.__vel.state();
      return { used: 0, fin: s.gameState, bot: s.bot?.status ?? null, speed: s.speed };
    });
    heap.push((await cdp.send('Runtime.getHeapUsage')).usedSize);
    if (h.fin === 'finished' || h.bot === 'failed') {
      // Weiter messen: Bot neu starten, damit durchgehend gespielt wird.
      await page.evaluate((r) => (r ? window.__vel.useBot('route', { sync: 1, seed: 11 }) : window.__vel.useBot('strafe', { sync: 1 })), hasRoute);
    }
  }
  const pace = await page.evaluate(() => {
    const P = window.__pace;
    P.on = false;
    const n = Math.min(P.n, P.ts.length);
    const ev = [];
    return { ts: Array.from(P.ts.subarray(0, n)), cb: Array.from(P.cb.subarray(0, n)), gap: Array.from(P.gap.subarray(0, n)), ev };
  });
  await cdp.send('Tracing.end');
  await done;

  // --- Auswertung
  const dts = [];
  for (let i = 1; i < pace.ts.length; i++) dts.push(pace.ts[i] - pace.ts[i - 1]);
  const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
  const nominal = UNCAPPED ? mean : 1000 / 60;
  const long = dts.filter((d) => d > nominal * 1.5).length;
  const jitter = Math.sqrt(dts.reduce((a, b) => a + (b - mean) ** 2, 0) / dts.length);
  // Ticks pro Frame bei 128 Hz (aus Framezeiten nachgerechnet, wie FixedLoop)
  let acc = 0;
  const tpf = new Map();
  for (const d of dts) {
    acc += Math.min(d / 1000, 0.1);
    const n = Math.floor((acc + 1e-9) * 128);
    acc -= n / 128;
    tpf.set(n, (tpf.get(n) ?? 0) + 1);
  }
  const gcNames = new Map();
  let gcTotal = 0;
  let gcMax = 0;
  const gcList = [];
  for (const e of traceEvents) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    if (/^(MinorGC|MajorGC|V8\.GC_SCAVENGER$|V8\.GC_MARK_COMPACTOR$|V8\.GCIncrementalMarking$|V8\.GCFinalizeMC$|V8\.GCScavenger$)/.test(e.name)) {
      const k = e.name;
      const o = gcNames.get(k) ?? { n: 0, totalMs: 0, maxMs: 0 };
      o.n++;
      o.totalMs += e.dur / 1000;
      o.maxMs = Math.max(o.maxMs, e.dur / 1000);
      gcNames.set(k, o);
      if (k === 'MinorGC' || k === 'MajorGC') {
        gcTotal += e.dur / 1000;
        gcMax = Math.max(gcMax, e.dur / 1000);
        gcList.push(e.dur / 1000);
      }
    }
  }
  // Heap-Saegezahn: Anstiege aufsummieren = Allokationsrate
  let rise = 0;
  for (let i = 1; i < heap.length; i++) if (heap[i] > heap[i - 1]) rise += heap[i] - heap[i - 1];
  const worst = [...dts].sort((a, b) => b - a).slice(0, 10).map((v) => r2(v));
  const cbSorted = [...pace.cb].sort((a, b) => a - b);
  result = {
    uncapped: UNCAPPED,
    level: LEVEL,
    viewport: [VW, VH],
    pixelHeight: PIXEL,
    seconds: SECONDS,
    frames: pace.ts.length,
    fps: r2(1000 / mean),
    frameDtMs: stats(dts),
    jitterStdMs: r2(jitter),
    longFrames: long,
    longFramesPct: r2((100 * long) / dts.length),
    worstFramesMs: worst,
    gameCallbackMs: stats(pace.cb),
    cbOver4ms: pace.cb.filter((c) => c > 4.17).length,
    cbOver7ms: pace.cb.filter((c) => c > 6.94).length,
    dtOver7ms: dts.filter((d) => d > 6.94).length,
    dtOver14ms: dts.filter((d) => d > 13.9).length,
    gcOver3ms: gcList.filter((g) => g > 3).length,
    gameCallbackP99: r2(cbSorted[Math.floor(cbSorted.length * 0.99)]),
    gapBetweenCallbacksMs: stats(pace.gap.slice(1)),
    ticksPerFrame: Object.fromEntries([...tpf].sort((a, b) => a[0] - b[0])),
    gc: Object.fromEntries(gcNames),
    gcMinorMajorTotalMs: r2(gcTotal),
    gcMaxMs: r2(gcMax),
    gcEvents: gcList.length,
    gcTopMs: [...gcList].sort((a, b) => b - a).slice(0, 10).map(r2),
    gcPerMinute: r2((gcList.length / SECONDS) * 60),
    heapRiseKiBps: r2(rise / 1024 / SECONDS),
    heapMiB: stats(heap.map((b) => b / 1048576)),
    errors,
    longCallbacks: pace.cb.map((c, i) => ({ c: r2(c), ts: r2(pace.ts[i]) })).filter((x) => x.c > 8).map((x) => ({ ...x, near: pace.ev.filter((e) => Math.abs(e.t * 1000 - x.ts) < 60).map((e) => e.type + (e.reason ? ':' + e.reason : '')).join(',') })),
    longGaps: pace.ts.slice(1).map((t, i) => ({ dt: r2(t - pace.ts[i]), ts: r2(t) })).filter((x) => x.dt > 25).map((x) => ({ ...x, near: pace.ev.filter((e) => Math.abs(e.t * 1000 - x.ts) < 80).map((e) => e.type + (e.reason ? ':' + e.reason : '')).join(',') })),
  };
} finally {
  await browser.close();
  await srv.close();
}
console.log(JSON.stringify(result, null, 1));
const tag = `${result.level}${UNCAPPED ? '-uncapped' : ''}${PIXEL ? `-px${PIXEL}` : ''}-${VW}x${VH}`;
writeFileSync(`${OUT}/pacing-${tag}.json`, JSON.stringify(result, null, 2));

function stats(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, mean: r2(mean), min: r2(s[0]), p50: r2(q(0.5)), p95: r2(q(0.95)), p99: r2(q(0.99)), max: r2(s[s.length - 1]) };
}
function r2(v) {
  return Math.round(v * 100) / 100;
}
