/**
 * Controller im echten Spiel (Plan 011 §1.4), nur mit Fake-Pad über `__vel.pad` (kein Klick, keine Taste):
 *
 *   npx tsx tools/pad/pad-check.ts            (Port 5730, PAD_PORT=…; immer ?online=mock)
 *
 * Prüft: Start aus dem Titel nur mit A → 'playing' OHNE Pointer Lock, Steuer-Modus 'pad', Gerät erkannt;
 * Stick bewegt (digital), Kamera-Stick dreht, LB springt; Fenster-Blur pausiert; A in der Pause → weiter ohne
 * Lock; Start pausiert; Pad abziehen pausiert; keine Konsolenfehler. Screenshots → shots/pad/. Exit 1 bei Fehler.
 * Strings in page.evaluate (tsx + Playwright: "__name is not defined", fallen.md #238).
 */
import { mkdirSync } from 'node:fs';
import type { Page } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = Number(process.env.PAD_PORT ?? 5730);
const DIR = 'shots/pad';

let failed = 0;
let passed = 0;
function check(ok: boolean, msg: string, detail = ''): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${detail && !ok ? ` — ${detail}` : ''}`);
}

interface Info {
  device: string;
  usingPad: boolean;
  controlMode: string;
  padConnected: boolean;
  menuContext: boolean;
  maxRate: number;
}
interface St {
  gameState: string;
  menu: string | null;
  yawDeg: number;
  pos: { x: number; y: number; z: number };
  onGround: boolean;
  locked: boolean;
}

const pad = (page: Page, patch: string): Promise<unknown> => page.evaluate(`window.__vel.pad(${patch})`);
const state = (page: Page): Promise<St> => page.evaluate('window.__vel.state()') as Promise<St>;
const info = (page: Page): Promise<Info> => page.evaluate('window.__vel.input()') as Promise<Info>;
const frames = (page: Page, n: number): Promise<unknown> =>
  page.evaluate(`new Promise((r) => { let k = ${n}; const f = () => (--k <= 0 ? r(0) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
const locked = (page: Page): Promise<boolean> => page.evaluate('document.pointerLockElement !== null') as Promise<boolean>;

/** Knopf kurz drücken: gedrückt für ein paar Frames, dann los. */
async function tap(page: Page, button: string): Promise<void> {
  await pad(page, `{ buttons: { ${button}: true } }`);
  await frames(page, 3);
  await pad(page, `{ buttons: { ${button}: false } }`);
  await frames(page, 3);
}

async function run(page: Page): Promise<void> {
  await page.goto(`http://localhost:${PORT}/?online=mock`);
  await page.waitForFunction('window.__vel && window.__vel.ready === true', null, { timeout: 30000 });
  await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);

  await pad(page, `{ id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)' }`);
  await frames(page, 2);
  let inf = await info(page);
  check(inf.padConnected && inf.menuContext, 'Fake-Pad verbunden, Menü-Kontext im Titel', JSON.stringify(inf));
  check(inf.device === 'keyboard', 'nur verbunden: Gerät bleibt Tastatur');

  // Titel → Level nur mit A (Front Door: erst Boot überspringen, dann bestätigen).
  for (let i = 0; i < 8 && (await state(page)).gameState === 'title'; i++) {
    await tap(page, 'PadA');
    await page.waitForTimeout(400);
  }
  await page.waitForFunction("window.__vel.state().gameState === 'playing'", null, { timeout: 15000 }).catch(() => undefined);
  let st = await state(page);
  inf = await info(page);
  check(st.gameState === 'playing', 'Start nur mit A → playing', `gameState ${st.gameState}, menu ${st.menu}`);
  check(!(await locked(page)), 'kein Pointer Lock');
  check(inf.controlMode === 'pad' && inf.device === 'playstation' && !inf.menuContext, 'Steuer-Modus pad, Gerät playstation, Spiel-Kontext', JSON.stringify(inf));
  const cursor = await page.evaluate("getComputedStyle(document.querySelector('canvas')).cursor");
  check(cursor === 'none', 'Mauszeiger im Pad-Modus aus', String(cursor));
  await mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: `${DIR}/01-playing.png` });

  // Bewegen: Stick nach vorn 1 s.
  await page.waitForFunction('window.__vel.state().onGround', null, { timeout: 5000 }).catch(() => undefined);
  const p0 = (await state(page)).pos;
  await pad(page, '{ axes: [0, -1, 0, 0] }');
  await page.waitForTimeout(1000);
  const p1 = (await state(page)).pos;
  const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  check(moved > 150, `Stick vorn bewegt (${moved.toFixed(0)} u in ~1 s)`);
  await pad(page, '{ axes: [0, 0, 0, 0] }');

  // Kamera-Stick: 0.5 s voll rechts → Yaw fällt um grob maxRate · 0.5 s.
  const y0 = (await state(page)).yawDeg;
  await pad(page, '{ axes: [0, 0, 1, 0] }');
  await page.waitForTimeout(500);
  await pad(page, '{ axes: [0, 0, 0, 0] }');
  await frames(page, 2);
  const y1 = (await state(page)).yawDeg;
  check(y1 < y0 - 60, `Kamera-Stick rechts dreht nach rechts (${(y1 - y0).toFixed(0)}°, maxRate ${inf.maxRate} °/s)`);

  // LB springt.
  await page.evaluate('window.__vel.events(0)');
  await tap(page, 'PadLB');
  await page.waitForTimeout(150);
  const jumped = (await page.evaluate("window.__vel.events().some((e) => e.type === 'jump')")) as boolean;
  check(jumped, 'LB → Sprung-Event');

  // Fenster verliert den Fokus → Pause.
  await page.waitForTimeout(600);
  await page.evaluate("window.dispatchEvent(new Event('blur'))");
  await frames(page, 2);
  st = await state(page);
  check(st.gameState === 'paused' && st.menu === 'pause', 'Blur im Pad-Modus → Pause-Menü', `${st.gameState}/${st.menu}`);
  await page.screenshot({ path: `${DIR}/02-pause.png` });

  // A in der Pause → weiter, weiterhin ohne Lock.
  await tap(page, 'PadA');
  await page.waitForTimeout(300);
  st = await state(page);
  check(st.gameState === 'playing' && !(await locked(page)), 'A in der Pause → weiter ohne Lock', st.gameState);

  // Start → Pause.
  await tap(page, 'PadMenu');
  st = await state(page);
  check(st.gameState === 'paused', 'Start → Pause', st.gameState);
  await tap(page, 'PadA');
  await page.waitForTimeout(300);

  // Pad abziehen im Spiel → Pause.
  check((await state(page)).gameState === 'playing', 'wieder im Spiel');
  await pad(page, '{ connected: false }');
  await frames(page, 3);
  st = await state(page);
  check(st.gameState === 'paused', 'Pad getrennt → Pause', st.gameState);
  await pad(page, 'null');
}

const vite = await createServer({ configFile: 'vite.config.ts', server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist'] });
const errors: string[] = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  console.log('\npad-check (Fake-Pad, ?online=mock)');
  await run(page);
  check(errors.length === 0, 'keine Konsolen-/Seitenfehler', errors.join(' | '));
} catch (err) {
  failed++;
  console.log(`  ✗ Abbruch: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await browser.close();
  await vite.close();
}
console.log(`\nChecks: ${passed} ok, ${failed} fehlgeschlagen`);
process.exit(failed > 0 ? 1 : 0);
