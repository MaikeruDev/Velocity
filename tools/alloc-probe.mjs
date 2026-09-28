/**
 * Allokations-Probe im echten Spiel: CDP-Heap-Sampling, aufgeschlüsselt nach
 * Funktion und Datei. AGENTS.md verlangt "keine Allokation im Frame-/Tick-Pfad" —
 * das hier misst es. Gezählt wird auch kurzlebiger Müll, den Minor-/Major-GC
 * schon eingesammelt hat (genau der löst die Scavenges aus); ohne diese Flags
 * sähe man nur die ~6 %, die beim Stoppen noch leben.
 *
 *   node tools/alloc-probe.mjs [level=level1] [sekunden=4] [--no-bot] [--warmup 2.5] [--file Hud.ts,BitmapFont]
 *                              [--settings '{"showKeys":false}'] [--all] [--unlock-all]
 *   --all: Top-Funktionen aller Dateien (auch three.js/intern), nicht nur src/.
 *
 * ACHTUNG Aufwärmzeit (fallen.md #65): Nach 2.5 s läuft ein großer Teil von src/ noch
 * unoptimiert (Interpreter/Baseline boxen jede Gleitkommazahl) — das misst den JIT-Anlauf,
 * nicht den Dauerbetrieb. Level 2 ohne Bot: 2.5 s Aufwärmen → src/ ~355 KiB/s, 60 s → ~42.
 * Für den Dauerbetrieb --warmup 60 (ohne Bot; mit Route-Bot endet der Lauf vorher).
 *   (Port 5199, per ALLOC_PORT änderbar)
 *
 * Mit Bot (Default: route, sync 1, Seed 11) laufen Tick- und Frame-Pfad unter
 * Last; --no-bot misst den Stand (HUD, Kamera, Renderer, Audio). Vergleiche nur
 * bei gleichem Level, Seed und Dauer (fallen.md #49).
 */
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const PORT = Number(process.env.ALLOC_PORT ?? 5199);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const settingsJson = option('--settings');
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--settings' && args[i - 1] !== '--file' && args[i - 1] !== '--warmup');
const level = positional[0] ?? 'level1';
const seconds = Number(positional[1] ?? 4);
const useBot = !flag('--no-bot');
// Aufwärmzeit vor dem Messen (s): Intro, Glyphen-Caches, JIT-Tier-up. Kurz gemessen zählt noch Boxing aus nicht optimiertem Code.
const warmup = Number(option('--warmup') ?? 2.5);

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  if (settingsJson) {
    // Einstellungen vor dem Laden setzen (SettingsStore liest sie beim Start).
    const patch = JSON.parse(settingsJson);
    await page.addInitScript((p) => {
      const key = 'velocity.settings.v1';
      let cur = {};
      try {
        cur = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
      } catch {
        cur = {};
      }
      localStorage.setItem(key, JSON.stringify({ ...cur, ...p }));
    }, patch);
  }
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__vel?.ready === true);
  // --unlock-all: Kosmetik freischalten (mit --settings '{"heldItem":"can"}' die Dosen-Tricks messen, Plan 005).
  if (flag('--unlock-all')) await page.evaluate(() => window.__vel.unlockAll());
  await page.evaluate((id) => window.__vel.start(id, { lockless: true }), level);
  if (useBot) await page.evaluate(() => window.__vel.useBot('route', { sync: 1, seed: 11 }));
  // Intro, Glyphen-Caches und JIT warmlaufen lassen.
  await page.waitForTimeout(warmup * 1000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.startSampling', {
    samplingInterval: 256,
    includeObjectsCollectedByMinorGC: true,
    includeObjectsCollectedByMajorGC: true,
  });
  await page.waitForTimeout(seconds * 1000);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  const frames = await page.evaluate(() => window.__vel.state().fps);
  // Knoten-Baum flach machen: Selbst-Größe je Funktion + Datei:Zeile.
  const byFn = new Map();
  const byFile = new Map();
  let total = 0;
  const walk = (n) => {
    const cf = n.callFrame;
    const size = n.selfSize;
    total += size;
    const url = cf.url.replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '');
    const key = `${cf.functionName || '(anonym)'}  ${url}:${cf.lineNumber + 1}`;
    byFn.set(key, (byFn.get(key) ?? 0) + size);
    const file = url || '(intern)';
    byFile.set(file, (byFile.get(file) ?? 0) + size);
    for (const c of n.children) walk(c);
  };
  walk(profile.head);
  const rows = [...byFn].filter(([k]) => k.includes('src/')).sort((a, b) => b[1] - a[1]);
  const perSec = (b) => `${(b / 1024 / seconds).toFixed(1)} KiB/s`;
  const srcTotal = rows.reduce((s, r) => s + r[1], 0);
  console.log(
    `Level ${level}, ${seconds} s, ${useBot ? 'Bot route sync 1 Seed 11' : 'ohne Bot'}${settingsJson ? `, Settings ${settingsJson}` : ''}, ~${Math.round(frames)} fps`,
  );
  console.log(`  gesamt ${perSec(total)} (inkl. eingesammelter Objekte), davon src/ ${perSec(srcTotal)}`);
  console.log('  nach Datei:');
  for (const [k, v] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${perSec(v).padStart(12)}  ${k}`);
  console.log('  nach Funktion (src/):');
  for (const [k, v] of rows.slice(0, 25)) console.log(`  ${perSec(v).padStart(12)}  ${k}`);
  if (flag('--all')) {
    console.log('  nach Funktion (alle):');
    for (const [k, v] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${perSec(v).padStart(12)}  ${k}`);
  }
  // --file Hud.ts,BitmapFont: alle Funktionen dieser Dateien (auch unterhalb der Top 25).
  const files = option('--file');
  if (files) {
    for (const f of files.split(',')) {
      const sel = rows.filter(([k]) => k.includes(f));
      console.log(`  ${f}: ${perSec(sel.reduce((s, r) => s + r[1], 0))}`);
      for (const [k, v] of sel) console.log(`  ${perSec(v).padStart(12)}  ${k}`);
    }
  }
} finally {
  await browser.close();
  await srv.close();
}
