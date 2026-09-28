/**
 * Ghost-Check (Plan 003, S7) im echten Spiel: Der Route-Bot fährt einen Bestlauf,
 * dann gegen seinen eigenen Ghost — einmal identisch (Seed/Sync gleich → Abstand 0),
 * einmal langsamer. Geprüft: kein Ghost ohne Bestzeit, Speichergröße, HUD-Abstand
 * im Ziel = Laufzeit − Ghost-Zeit (±0.05 s), Ghost-Pose zeitsynchron zum Spieler.
 * Screenshots mit sichtbarem Ghost nach shots/ghost/.
 *
 *   node tools/ghost-check.mjs [level1]     (Port GHOST_PORT, Default 5232)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { launchBrowser, startDevServer } from './lib/devServer.mjs';

const PORT = Number(process.env.GHOST_PORT ?? 5232);
const LEVEL = process.argv[2] ?? 'level1';
const OUT = 'shots/ghost';
const SEED = 7;
const SLOW_SYNC = 0.85;

mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const result = { level: LEVEL, runs: [], checks: [] };
let failed = 0;
const check = (name, ok, detail) => {
  result.checks.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(srv.url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__vel?.ready === true);
  await page.evaluate((id) => window.__vel.start(id, { lockless: true }), LEVEL);

  const g0 = await page.evaluate(() => window.__vel.ghost());
  check('Ohne Bestzeit kein Ghost', !g0.loaded, JSON.stringify({ loaded: g0.loaded, stored: g0.storedChars }));

  // 1) Bestlauf aufnehmen.
  const pb = await runBot(page, 1, 'pb', false);
  const g1 = await page.evaluate(() => window.__vel.ghost());
  check('Bestlauf im Ziel', pb.time !== null, `Zeit ${pb.time}`);
  check('Ghost gespeichert < 40 KB', g1.storedChars > 0 && g1.storedChars < 40000, `${g1.storedChars} Zeichen, ${g1.recorded} Samples`);

  // 2) Identischer Lauf gegen den eigenen Ghost.
  const same = await runBot(page, 1, 'same', true);
  check(
    'Identischer Lauf: Ghost deckt sich',
    same.ghostLoaded && same.gridSamples > 10 && same.gridMax < 0.5 && Math.abs((same.hudDiff ?? 99) - 0) < 0.05,
    `Zeit ${same.time} vs ${pb.time}, HUD ${same.hudDiff}, Abstand Ghost↔Spieler auf dem 32-Hz-Raster max ${same.gridMax.toFixed(3)} u ` +
      `(${same.gridSamples} Proben), zwischen den Samples Ø ${same.meanDist.toFixed(2)} / max ${same.maxDist.toFixed(1)} u (Sehne statt Bogen, Crouch-Jump-Versatz)`,
  );

  // 3) Langsamerer Lauf: HUD-Abstand im Ziel gegen die echte Differenz.
  const slow = await runBot(page, SLOW_SYNC, 'slow', true);
  const real = slow.time !== null && pb.time !== null ? slow.time - pb.time : null;
  check(
    'Ziel: HUD-Abstand = Laufzeit − Ghost (±0.05 s)',
    real !== null && slow.hudDiff !== null && Math.abs(slow.hudDiff - real) <= 0.05,
    `HUD ${slow.hudDiff?.toFixed(3)} s, echt ${real?.toFixed(3)} s (Lauf ${slow.time} − PB ${pb.time})`,
  );
  check('Checkpoints: HUD-Abstand vorhanden', slow.cpDiffs.length > 0, `CP-Abstände ${slow.cpDiffs.map((d) => d.toFixed(2)).join(' / ')}`);
  check('Screenshot mit sichtbarem Ghost', slow.shots.length > 0, slow.shots.join(', '));
  result.runs.push(pb, same, slow);
} finally {
  await browser.close();
  await srv.close();
}
check('0 Konsolenfehler', errors.length === 0, errors.slice(0, 5).join(' | ') || '0');
result.errors = errors;
writeFileSync(`${OUT}/report.json`, JSON.stringify(result, null, 2));
process.exit(failed > 0 ? 1 : 0);

/**
 * Bot-Lauf vom Start (restart). Misst alle ~100 ms den Abstand Ghost↔Spieler zur selben
 * Laufzeit (eingefroren abgelesen, damit Pose und Zustand zum selben Tick gehören).
 */
async function runBot(page, sync, tag, withGhost) {
  await page.evaluate(({ sync, seed }) => window.__vel.useBot('route', { sync, seed, restart: true }), { sync, seed: SEED });
  const ghostLoaded = (await page.evaluate(() => window.__vel.ghost())).loaded;
  const dists = [];
  const gridDists = [];
  const cpDiffs = [];
  const shots = [];
  let lastCp = 0;
  let lastShot = -10;
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < 90000) {
    await page.waitForTimeout(100);
    // Einfrieren, lesen, weiter — Pose und Spieler vom selben Tick.
    const snap = await page.evaluate(() => {
      const v = window.__vel;
      v.freeze(true);
      const s = v.state();
      const g = s.runTime !== null ? v.ghost(s.runTime) : v.ghost();
      v.freeze(false);
      return { s, g };
    });
    st = snap.s;
    if (st.finish) break;
    if (withGhost && snap.g.pose && st.running) {
      const p = snap.g.pose;
      const d = Math.hypot(p.x - st.pos.x, p.y - st.pos.y, p.z - st.pos.z);
      dists.push(d);
      // Auf dem Raster (jeder 4. Tick bei 128 Hz) ist der Ghost exakt die Aufnahme.
      if (Math.abs(st.runTime * 32 - Math.round(st.runTime * 32)) < 1e-6) gridDists.push(d);
      // Ghost vorne im Bild (±30° zum Blick) und in lesbarer Entfernung → Screenshot.
      const yaw = (st.yawDeg * Math.PI) / 180;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const dx = p.x - st.pos.x;
      const dz = p.z - st.pos.z;
      const along = dx * fx + dz * fz;
      const cos = along / Math.max(1, Math.hypot(dx, dz));
      if (tag === 'slow' && d > 180 && d < 900 && cos > 0.87 && st.runTime - lastShot > 2.5 && shots.length < 4) {
        const file = `${OUT}/${LEVEL}-${tag}-${st.runTime.toFixed(1)}s-${Math.round(d)}u.png`;
        await page.screenshot({ path: file });
        shots.push(file);
        lastShot = st.runTime;
      }
    }
    if (st.checkpoint.index > lastCp) {
      lastCp = st.checkpoint.index;
      if (snap.g.diff !== null) cpDiffs.push(snap.g.diff);
    }
  }
  const g = await page.evaluate(() => window.__vel.ghost());
  const time = st?.finish?.time ?? null;
  const mean = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : 0;
  const run = {
    tag,
    sync,
    time,
    ghostLoaded,
    hudDiff: withGhost ? g.diff : null,
    cpDiffs,
    samples: dists.length,
    gridSamples: gridDists.length,
    gridMax: gridDists.length ? Math.max(...gridDists) : 0,
    maxDist: dists.length ? Math.max(...dists) : 0,
    meanDist: mean,
    shots,
  };
  console.log(`  Lauf ${tag}: Zeit ${time}, Ghost ${ghostLoaded ? 'an' : 'aus'}, HUD ${run.hudDiff}, CPs ${cpDiffs.map((d) => d.toFixed(2)).join('/')}, Abstand Ø ${mean.toFixed(1)} max ${run.maxDist.toFixed(1)} u`);
  // Ergebnis-Menü abwarten, dann nächster Lauf.
  await page.waitForTimeout(1500);
  return run;
}
