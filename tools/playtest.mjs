/**
 * Playtest im echten Spiel (npm run playtest): Chromium, echter Loop, echter
 * Renderer, Bot am Steuer — in ECHTZEIT, nicht vorgespult. Port 5191.
 *
 * Pro Level: __vel.start(id, { lockless }) → __vel.useBot('route', { sync }) →
 * Screenshot alle ~2 s (shots/playtest/<level>/), Speed-Verlauf pro 0.25 s,
 * FPS, Checkpoints, Respawns, Ergebnis (finish/fail/timeout + Zeit).
 * Bericht: shots/playtest/report.json. Exit 1 bei Konsolen-/Seitenfehlern —
 * ein Bot, der ein Level nicht schafft, ist KEIN Fehler dieses Tools (Level-Strang).
 *
 *   node tools/playtest.mjs                 → level1–level4, sandbox
 *   node tools/playtest.mjs level2          → nur level2
 *   node tools/playtest.mjs --sync 0.8      → unsauberer Bot
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const PORT = Number(process.env.PLAYTEST_PORT ?? 5191);
const OUT = 'shots/playtest';
const SAMPLE_MS = 250;
const SHOT_EVERY_MS = 2000;
/** Ohne Route (sandbox): so lange geradeaus bhoppen. */
const FREE_RUN_MS = 10000;
/** Glätte-Messung: so viele Frames einmal pro Level, sobald der Bot in Fahrt ist. */
const SMOOTH_FRAMES = 180;
const SMOOTH_AFTER_MS = 6000;

const args = process.argv.slice(2);
const syncArg = args.indexOf('--sync');
const SYNC = syncArg >= 0 ? Number(args[syncArg + 1]) : 1.0;
const filter = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--sync');
const LEVELS = filter.length > 0 ? filter : ['level1', 'level2', 'level3', 'level4', 'sandbox'];

mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const consoleErrors = [];
const report = { date: new Date().toISOString(), sync: SYNC, viewport: [1280, 720], levels: [], consoleErrors };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`);
  });
  for (const id of LEVELS) report.levels.push(await playLevel(page, id));
} finally {
  await browser.close();
  await srv.close();
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log('\n=== Playtest ===');
for (const l of report.levels) {
  const t = l.time !== null ? `${l.time.toFixed(2)} s` : '-';
  const why = l.reason ? ` (${l.reason})` : '';
  console.log(
    `${l.level.padEnd(8)} ${l.result.padEnd(8)}${why.padEnd(10)} Zeit ${t.padStart(9)}  CP ${l.checkpoints}/${l.checkpointsTotal}  ` +
      `max ${l.maxSpeed} u/s  FPS Ø ${l.fps.avg} (min ${l.fps.min})  Respawns ${l.respawns}  Shots ${l.shots.length}` +
      (l.smoothness ? `  Glätte ${l.smoothness.ratioMean}±${l.smoothness.ratioStd} (${l.smoothness.airFrames} Luft-Frames, dt ${l.smoothness.dtMean}±${l.smoothness.dtStd} ms)` : ''),
  );
}
console.log(`Bericht: ${OUT}/report.json`);
if (consoleErrors.length > 0) {
  console.error(`\n${consoleErrors.length} Konsolenfehler:\n${consoleErrors.join('\n')}`);
  process.exit(1);
}

// ------------------------------------------------------------------ Ablauf je Level

async function playLevel(page, id) {
  const dir = `${OUT}/${id}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const started = await page.evaluate((lv) => window.__vel.start(lv, { lockless: true }), id);
  if (!started) return failed(id, 'start fehlgeschlagen');

  const hasRoute = await page.evaluate(() => window.__vel.state().routeNodes > 0);
  if (hasRoute) {
    await page.evaluate((sync) => window.__vel.useBot('route', { sync, seed: 11 }), SYNC);
  } else {
    await page.evaluate(() => window.__vel.useBot('strafe', { sync: 1 }));
  }

  const speed = [];
  const fps = [];
  const shots = [];
  const t0 = Date.now();
  let nextShot = 0;
  let shotIndex = 0;
  let last = null;
  let smooth = null;
  const timeoutMs = hasRoute ? 180000 : FREE_RUN_MS;
  for (;;) {
    const elapsed = Date.now() - t0;
    const s = await page.evaluate(() => window.__vel.state());
    last = s;
    speed.push([round(elapsed / 1000, 2), Math.round(s.speed), Math.round(s.pos.y)]);
    if (s.fps > 0 && elapsed > 1000) fps.push(s.fps);
    if (elapsed >= nextShot) {
      const name = `${String(shotIndex++).padStart(2, '0')}-${(elapsed / 1000).toFixed(0)}s.png`;
      await page.screenshot({ path: `${dir}/${name}` });
      shots.push(name);
      nextShot += SHOT_EVERY_MS;
    }
    if (smooth === null && elapsed > SMOOTH_AFTER_MS && s.speed > 400) {
      smooth = smoothness(await page.evaluate((n) => window.__vel.sampleFrames(n), SMOOTH_FRAMES));
    }
    if (s.gameState === 'finished' || s.finish) break;
    if (s.bot && s.bot.status === 'failed') break;
    if (elapsed > timeoutMs) break;
    await page.waitForTimeout(SAMPLE_MS);
  }

  let result = 'timeout';
  if (last.finish) result = 'finish';
  else if (last.bot && last.bot.status === 'failed') result = 'fail';
  else if (!hasRoute) result = 'freerun';

  if (result === 'finish') {
    // Ergebnis-Overlay kommt nach ~1 s Weiterflug.
    await page.waitForFunction(() => window.__vel.state().menu === 'finish', null, { timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/result.png` });
    shots.push('result.png');
  }
  const events = await page.evaluate(() => window.__vel.events());
  const respawns = events.filter((e) => e.type === 'respawn' && e.reason !== 'restart').length;
  const maxSpeed = Math.max(0, ...speed.map((x) => x[1]));
  const entry = {
    level: id,
    result,
    reason: last.bot?.reason ?? null,
    time: last.finish ? last.finish.time : null,
    isBest: last.finish ? last.finish.isBest : null,
    checkpoints: last.checkpoint.index,
    checkpointsTotal: last.checkpoint.total,
    botNodes: last.bot ? `${last.bot.nextIndex}/${last.bot.total}` : null,
    maxSpeed,
    respawns,
    jumps: events.filter((e) => e.type === 'jump').length,
    milestones: events.filter((e) => e.type === 'speedMilestone').map((e) => e.speed),
    splits: events.filter((e) => e.type === 'checkpoint').map((e) => round(e.time, 3)),
    fps: stats(fps),
    smoothness: smooth,
    endPos: last.pos,
    realSeconds: round((Date.now() - t0) / 1000, 1),
    speed,
    shots,
  };
  return entry;
}

/**
 * Interpolations-Glätte: Kamera-Weg pro Frame geteilt durch Speed·dt, nur in
 * der Luft (kein Head-Bob). Ohne Interpolation springt das Verhältnis bei
 * 60 fps / 128 Tick zwischen ~0.94 und ~1.41 (2 bzw. 3 Ticks pro Frame).
 */
function smoothness(frames) {
  const ratios = [];
  const dts = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const dt = (b.t - a.t) / 1000;
    if (!(dt > 0)) continue;
    dts.push(dt * 1000);
    if (a.onGround || b.onGround) continue;
    const expected = ((a.speed + b.speed) / 2) * dt;
    if (expected < 1) continue;
    const r = Math.hypot(b.x - a.x, b.z - a.z) / expected;
    if (r > 3) continue; // Teleport/Respawn
    ratios.push(r);
  }
  const m = (xs) => xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length);
  const sd = (xs) => Math.sqrt(m(xs.map((x) => (x - m(xs)) ** 2)));
  return { airFrames: ratios.length, ratioMean: round(m(ratios), 3), ratioStd: round(sd(ratios), 3), dtMean: round(m(dts), 2), dtStd: round(sd(dts), 2) };
}

function failed(id, why) {
  consoleErrors.push(`${id}: ${why}`);
  return { level: id, result: 'error', reason: why, time: null, checkpoints: 0, checkpointsTotal: 0, maxSpeed: 0, respawns: 0, fps: stats([]), shots: [], speed: [] };
}

function stats(xs) {
  if (xs.length === 0) return { avg: 0, min: 0, p5: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { avg: round(avg, 1), min: round(sorted[0], 1), p5: round(sorted[Math.floor(sorted.length * 0.05)], 1) };
}

function round(v, d = 0) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}
