/**
 * Griff-Audit (Plan 008): Kontaktblätter aller Gegenstände in Ruhe- und Trick-Posen aus mehreren
 * Kamerawinkeln (Spielkamera + Orbit um den Gegenstand: vorn, rechts, links, unten, oben, hinten)
 * und mit allen Skins. Über dev/viewmodel.html (deterministisch, kein Spiel).
 *
 *   node tools/hand-audit.mjs <outDir> [rest|skins|tricks|knife|trick|all] [item … | item trick s]
 *
 * rest:   je Gegenstand eine Zeile: Spielbild (Ausschnitt) + 6 Orbit-Ansichten (classic)
 * skins:  je Skin × Gegenstand Spielbild + Seitenansicht
 * tricks: wichtigste Trick-Phasen je Gegenstand, Spielbild + Seitenansicht
 * knife:  Butterfly-Messer-Zeitlupe: jeder Trick frei laufend (play 240 Hz), Kacheln im Abstand 1/30 s
 * trick:  beliebiger Trick: node tools/hand-audit.mjs <out> trick <item> <trick> [Sekunden] [open]
 * Port VMSHEET_PORT (Default 5500).
 */
import { mkdirSync } from 'node:fs';
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const [outDir = 'shots/hand-v3/audit', mode = 'all', ...only] = process.argv.slice(2);
const PORT = Number(process.env.VMSHEET_PORT ?? 5500);
mkdirSync(outDir, { recursive: true });

const ITEMS = ['none', 'card', 'can', 'knife', 'yoyo', 'spinner', 'coin', 'lighter', 'kendama', 'phone'].filter((i) => only.length === 0 || only.includes(i) || mode === 'knife');
const GLOVES = ['classic', 'neon', 'gold', 'robot', 'skeleton', 'cat'];
const VIEWS = [
  ['vorn', { yaw: 0, pitch: 0 }],
  ['rechts', { yaw: 90, pitch: 0 }],
  ['links', { yaw: -90, pitch: 0 }],
  ['unten', { yaw: 0, pitch: -75 }],
  ['oben', { yaw: 0, pitch: 75 }],
  ['hinten', { yaw: 180, pitch: 10 }],
];
/** Wichtigste Trick-Posen je Gegenstand (Trick, festgehaltene Zeiten). */
const TRICKS = {
  card: [['spin', [0.3]], ['tossSpin', [0.3]], ['vanish', [0.25]]],
  can: [['crack', [0.5]], ['sip', [0.7]], ['flip', [0.33]], ['twirl', [0.3]]],
  knife: [['open', [0.15, 0.3]], ['rollover', [0.4]], ['aerial', [0.4]]],
  yoyo: [['sleeper', [0.6]], ['cradle', [0.8]]],
  spinner: [['flick', [0.3]], ['swap', [0.3]]],
  coin: [['knuckleRoll', [0.4]], ['flip', [0.3]], ['edgeSpin', [0.4]]],
  lighter: [['flickOpen', [0.3]], ['strike', [0.3]], ['twirl', [0.3]]],
  kendama: [['bigCup', [0.4]], ['spike', [0.6]]],
  phone: [['scroll', [0.3]], ['tap', [0.3]], ['flipCatch', [0.3]]],
};

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const page = await browser.newPage({ viewport: { width: 3600, height: 1200 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
await page.goto(`${srv.url}dev/viewmodel.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__vm !== undefined);

async function sheet(file, cells, o) {
  await page.setViewportSize({ width: Math.min(3800, o.cols * (Math.round(o.w * (o.crop ? o.crop[2] - o.crop[0] : 1)) * o.zoom + 6) + 12), height: 1200 });
  await page.evaluate((s) => window.__vm.render(s.cells, s.o), { cells, o });
  await page.locator('#sheet').screenshot({ path: file });
  console.log(`→ ${file} (${cells.length})`);
}

const GAME = { w: 480, h: 270, zoom: 2, depth: 40, crop: [0.5, 0.15, 1, 1], cols: 7 };
const ORBIT = { w: 300, h: 240, zoom: 2, depth: 40, cols: 3 };

function live(item, extra = {}) {
  return { aspect: 16 / 9, item, ...extra };
}

/** Eine Zeile: Spielbild + Orbit-Ansichten. Spielbild und Orbit haben verschiedene Größen → zwei Blätter. */
async function rowSheets(tag, cellsFor) {
  const game = [];
  const orbit = [];
  for (const [label, l, glove] of cellsFor) {
    game.push({ label: `${label} · Spiel`, glove, live: l });
    for (const [vn, v] of VIEWS) orbit.push({ label: `${label} · ${vn}`, glove, live: l, view: { ...v, dist: 24, target: l.item === 'none' || l.item === 'yoyo' ? 'hand' : 'item' } });
  }
  await sheet(`${outDir}/${tag}-game.png`, game, { ...GAME, cols: Math.min(5, game.length) });
  await sheet(`${outDir}/${tag}-orbit.png`, orbit, { ...ORBIT, cols: 3 });
}

if (mode === 'rest' || mode === 'all') {
  for (const item of ITEMS) await rowSheets(`rest-${item}`, [[item, live(item, item === 'knife' ? {} : {}), 'classic'], ...(item === 'knife' ? [['knife offen', live(item, { knifeOpen: true }), 'classic']] : [])]);
}
if (mode === 'skins' || mode === 'all') {
  for (const item of ITEMS) {
    const cells = GLOVES.map((g) => [`${item} ${g}`, live(item), g]);
    const game = cells.map(([label, l, glove]) => ({ label, glove, live: l }));
    const side = cells.map(([label, l, glove]) => ({ label: `${label} · rechts`, glove, live: l, view: { yaw: 90, pitch: 0, dist: 30, target: item === 'none' || item === 'yoyo' ? 'hand' : 'item' } }));
    const below = cells.map(([label, l, glove]) => ({ label: `${label} · unten`, glove, live: l, view: { yaw: 0, pitch: -75, dist: 30, target: item === 'none' || item === 'yoyo' ? 'hand' : 'item' } }));
    await sheet(`${outDir}/skins-${item}-game.png`, game, { ...GAME, cols: 6 });
    await sheet(`${outDir}/skins-${item}-orbit.png`, [...side, ...below], { ...ORBIT, cols: 6 });
  }
}
if (mode === 'tricks' || mode === 'all') {
  for (const item of ITEMS) {
    const list = TRICKS[item];
    if (!list) continue;
    const cells = [];
    for (const [trick, ats] of list) for (const at of ats) cells.push([`${item} ${trick} ${at}`, live(item, { trick, at }), 'classic']);
    await rowSheets(`tricks-${item}`, cells);
  }
}
if (mode === 'knife') {
  const fps = 240;
  const only2 = only.length ? only : ['open', 'close', 'rollover', 'aerial'];
  for (const [trick, total, extra] of [
    ['open', 0.62, {}],
    ['close', 0.8, { knifeOpen: true }],
    ['rollover', 0.7, { knifeOpen: true }],
    ['aerial', 0.95, {}],
    ['doubleAerial', 1.1, { knifeOpen: true }],
  ].filter(([t]) => only2.includes(t))) {
    const game = [];
    const side = [];
    for (let at = 0; at <= total + 1e-9; at += 1 / 30) {
      const l = live('knife', { trick, at: Math.round(at * 1000) / 1000, play: fps, ...extra });
      game.push({ label: `${trick} ${l.at.toFixed(3)}`, live: l });
      side.push({ label: `${trick} ${l.at.toFixed(3)} · rechts`, live: l, view: { yaw: 70, pitch: 10, dist: 34, target: 'hand' } });
    }
    await sheet(`${outDir}/knife-${trick}-game.png`, game, { ...GAME, cols: 8 });
    await sheet(`${outDir}/knife-${trick}-side.png`, side, { ...ORBIT, cols: 8 });
  }
}

if (mode === 'trick') {
  // Beliebiger Gegenstand/Trick: N Frames (1/30 s Abstand) frei gerechnet mit 240 Hz — Spielbild + Seitenansicht.
  const [item, trick, secs = '1', flag = ''] = only;
  const game = [];
  const side = [];
  for (let at = 0; at <= Number(secs) + 1e-9; at += 1 / 30) {
    const l = live(item, { trick, at: Math.round(at * 1000) / 1000, play: 240, ...(flag === 'open' ? { knifeOpen: true, opened: true } : {}) });
    game.push({ label: `${item} ${trick} ${l.at.toFixed(3)}`, live: l });
    side.push({ label: `${trick} ${l.at.toFixed(3)} · rechts`, live: l, view: { yaw: 70, pitch: 10, dist: 34, target: 'hand' } });
  }
  await sheet(`${outDir}/trick-${item}-${trick}-game.png`, game, { ...GAME, cols: 8 });
  await sheet(`${outDir}/trick-${item}-${trick}-side.png`, side, { ...ORBIT, cols: 8 });
}

await browser.close();
await srv.close();
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
