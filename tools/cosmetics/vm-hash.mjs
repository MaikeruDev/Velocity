/**
 * Pixelgleichheit des Viewmodels (Plan 007 K1/K2): rendert einen festen Satz Kacheln über
 * dev/viewmodel.html (deterministisch: feste Zeit, eigener WebGL-Kontext, kein Spiel) und schreibt
 * je Kachel einen FNV-Hash über die RGBA-Pixel. Zwei Stände vergleichen = Hash-Listen vergleichen.
 * Warum nicht die In-Game-Blätter (viewmodel-shots props): die streuen schon zwischen zwei Läufen
 * desselben Codes um 29–42 Tsd. Pixel (fallen.md #57, #109).
 *
 *   node tools/cosmetics/vm-hash.mjs check [game|menu]                 gegen die eingecheckte Baseline (Exit 1 bei Unterschied)
 *   node tools/cosmetics/vm-hash.mjs write <out.json> [game|menu] [--png out.png]
 *   node tools/cosmetics/vm-hash.mjs cmp <a.json> <b.json>             (Exit 1 bei Unterschied)
 *   node tools/cosmetics/vm-hash.mjs baseline                          Baseline neu schreiben (nur nach bewusster Bildänderung)
 *
 * Satz: 2 Handschuhe (classic, neon) × 11 Posen + alle Trick-Phasen von Dose/Karte/Messer (wie
 * viewmodel-shots props) + Lauf-Pose/offenes Messer/gewendete Karte = 126 Kacheln. game = 480×270
 * Tiefe 40 (Spiel), menu = 240×200 Tiefe 30 (Menü-Vorschau). Port VMHASH_PORT (Default 5327).
 *
 * Baseline (tools/cosmetics/vm-hash-baseline/{game,menu}.json): Plan-006-Stand (HEAD vor Plan 007) —
 * mit EINER bewussten Abweichung: "can crack 0.5/0.8" (4 Spiel-, 2 Menü-Kacheln, 16 Pixel im Spielblatt).
 * Der einmalige Lasche-Ruck der festgehaltenen Dose wirkt seit Plan 007 K9 am Frame-Ende (fallen.md #77)
 * statt am Anfang.
 * Plan 008 (01.10., bewusst neu geschrieben): Griff-Audit und Butterfly-Mechanik ändern 102 von 126 Kacheln je
 * Größe — die Posen grip/pinch/crack (Finger liegen an Dose/Karte an statt hindurch), alle Dosen- und Karten-
 * Kacheln (Dose 1 Einheit höher in der Faust, Karte 2 Einheiten höher im Kniff) und alle Messer-Kacheln (neues
 * Modell mit zwei Stiften, Tang und Riegel, Griff am Safe-Handle-Ende, Physik statt Zeitleiste). Alle anderen
 * Posen blieben pixelgleich (geprüft vor dem Neuschreiben). Plan 008 Schritt 2 (Karte/Münze/Messer-Feinschliff, 01.10.):
 * NUR die 45 Karten- und Messer-Kacheln je Größe neu (Karte: Daumen wieder vorn, 0.7 tiefer im Kniff, neue Tricks;
 * Messer: Daumen-Fang per Kontakt statt Posenwechsel, Rollover 0.5 weiter vor) — übrige Kacheln unverändert übernommen.
 * Zweiter Durchgang (01.10. nachmittags): 9 Karten-Kacheln je Größe neu — "card spin" (die Karte steht mit der
 * Unterkante auf der Daumenkuppe statt 0.1–0.6 darüber zu schweben, Zeigefinger schnippt) und "card vanish" 0.8–1.62
 * (Back-Palm 0.18 s kürzer). Der Check davor zeigte NUR diese 18 Kacheln (Spiel+Menü) verschieden. Die Hashes hängen am Rasterizer (Chromium über ANGLE, launchBrowser): auf einem
 * anderen Rechner/GPU zuerst den HEAD-Stand hashen (`git archive HEAD | tar -x`, node_modules als
 * Junction) und nur gegen DIESEN vergleichen — nicht gegen die eingecheckte Datei.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASELINE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vm-hash-baseline');
const SIZES = ['game', 'menu'];
const [mode, ...rest] = process.argv.slice(2);

/** Vergleich zweier Hash-Listen: Zahl der Unterschiede, Zeilen je Unterschied. */
function diff(a, b) {
  const lines = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.hash !== y.hash || x.label !== y.label) lines.push(`ANDERS #${i}: ${x?.label} (${x?.hash}) vs ${y?.label} (${y?.hash})`);
  }
  return lines;
}

if (mode === 'cmp') {
  const a = JSON.parse(readFileSync(rest[0], 'utf8'));
  const b = JSON.parse(readFileSync(rest[1], 'utf8'));
  const d = diff(a, b);
  for (const l of d) console.log(l);
  console.log(`${a.length} / ${b.length} Kacheln, ${d.length} verschieden`);
  process.exit(d.length ? 1 : 0);
}

if (!['write', 'check', 'baseline'].includes(mode) || (mode === 'write' && !rest[0])) {
  console.error('node tools/cosmetics/vm-hash.mjs check [game|menu] | write <out.json> [game|menu] [--png out.png] | cmp <a.json> <b.json> | baseline');
  process.exit(2);
}

/** Trick-Phasen wie tools/viewmodel-shots.mjs phasesOf (Dose/Karte/Messer, Plan 006). */
function phases() {
  return {
    none: [['-', [0]]],
    can: [
      ['-', [0]],
      ['crack', [0.15, 0.35, 0.5, 0.8]],
      ['sip', [0.3, 0.7, 1.0]],
      ['tilt', [0.3]],
      ['flip', [0.05, 0.2, 0.33, 0.5]],
      ['highFlip', [0.3]],
      ['twirl', [0.25, 0.4]],
      ['doubleFlip', [0.3, 0.55]],
      ['behindThrow', [0.35, 0.6, 0.85]],
    ],
    card: [
      ['-', [0]],
      ['spin', [0.15, 0.3, 0.45, 0.6, 0.75]],
      ['turn', [0.35]],
      ['tossSpin', [0.3, 0.5]],
      ['vanish', [0.1, 0.25, 0.35, 0.8, 1.35, 1.52, 1.62]],
    ],
    knife: [
      ['-', [0]],
      ['open', [0.15, 0.3, 0.45]],
      ['close', [0.2]],
      ['rollover', [0.25, 0.5]],
      ['aerial', [0.25, 0.45, 0.65]],
      ['doubleAerial', [0.45]],
    ],
  };
}

function cells(aspect) {
  const out = [];
  for (const glove of ['classic', 'neon']) {
    for (const pose of ['relaxed', 'open', 'fist', 'run', 'grip', 'pinch', 'knife', 'thumbsUp', 'point', 'flat', 'crack']) {
      out.push({ label: `${glove} ${pose}`, glove, pose });
    }
    for (const [item, list] of Object.entries(phases())) {
      for (const [trick, times] of list) {
        for (const at of times) {
          const live = { item, aspect, opened: item === 'can' && trick === 'sip' };
          if (trick !== '-') Object.assign(live, { trick, at });
          out.push({ label: `${glove} ${item} ${trick} ${at}`, glove, live, time: 1.3 });
        }
      }
    }
    out.push({ label: `${glove} run 420`, glove, live: { item: 'none', speed: 420, aspect } });
    out.push({ label: `${glove} knife open rest`, glove, live: { item: 'knife', knifeOpen: true, aspect } });
    out.push({ label: `${glove} card flipped rest`, glove, live: { item: 'card', flipped: true, aspect } });
  }
  return out;
}

function specOf(size) {
  return size === 'menu' ? { w: 240, h: 200, zoom: 1, cols: 6, depth: 30, cells: cells(1.2) } : { w: 480, h: 270, zoom: 1, cols: 4, depth: 40, cells: cells(16 / 9) };
}

const { startDevServer, launchBrowser } = await import('../lib/devServer.mjs');
const srv = await startDevServer(Number(process.env.VMHASH_PORT ?? 5327));
const browser = await launchBrowser();
const errors = [];

/** Kacheln einer Größe rendern und hashen (optional das Blatt als PNG). */
async function hashes(size, pngPath = null) {
  const spec = specOf(size);
  const page = await browser.newPage({ viewport: { width: Math.min(3800, spec.cols * (spec.w * spec.zoom + 6) + 12), height: 900 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`);
  });
  await page.goto(`${srv.url}dev/viewmodel.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vm !== undefined);
  const res = await page.evaluate((s) => {
    window.__vm.render(s.cells, { w: s.w, h: s.h, zoom: s.zoom, depth: s.depth });
    return [...document.querySelectorAll('#sheet canvas')].map((c, i) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let k = 0; k < d.length; k++) h = Math.imul(h ^ d[k], 16777619) >>> 0;
      return { label: s.cells[i].label, hash: h.toString(16) };
    });
  }, spec);
  if (pngPath) await page.locator('#sheet').screenshot({ path: pngPath });
  await page.close();
  return res;
}

let failed = false;
try {
  if (mode === 'write') {
    const size = rest[1] === 'menu' ? 'menu' : 'game';
    const pngIdx = rest.indexOf('--png');
    const res = await hashes(size, pngIdx >= 0 ? rest[pngIdx + 1] : null);
    writeFileSync(rest[0], JSON.stringify(res, null, 1));
    console.log(`${res.length} Kacheln (${size}) → ${rest[0]}`);
  } else if (mode === 'baseline') {
    mkdirSync(BASELINE_DIR, { recursive: true });
    for (const size of SIZES) {
      const res = await hashes(size);
      writeFileSync(join(BASELINE_DIR, `${size}.json`), JSON.stringify(res, null, 1));
      console.log(`Baseline ${size}: ${res.length} Kacheln`);
    }
  } else {
    for (const size of rest[0] ? [rest[0]] : SIZES) {
      const base = JSON.parse(readFileSync(join(BASELINE_DIR, `${size}.json`), 'utf8'));
      const d = diff(base, await hashes(size));
      for (const l of d) console.log(l);
      console.log(`${size}: ${base.length} Kacheln, ${d.length} verschieden`);
      if (d.length) failed = true;
    }
  }
} finally {
  await browser.close();
  await srv.close();
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
process.exit(failed ? 1 : 0);
