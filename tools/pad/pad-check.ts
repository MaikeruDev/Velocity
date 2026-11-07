/**
 * Controller im echten Spiel (Plan 011 §1.4), nur mit Fake-Pad über `__vel.pad` (kein Klick, keine Taste):
 *
 *   npx tsx tools/pad/pad-check.ts            (Port 5730, PAD_PORT=…; immer ?online=mock)
 *
 * Prüft: Start aus dem Titel nur mit A → 'playing' OHNE Pointer Lock, Steuer-Modus 'pad', Gerät erkannt;
 * Stick bewegt (digital), Kamera-Stick dreht, LB springt; Fenster-Blur pausiert; A in der Pause → weiter ohne
 * Lock; Start pausiert; Pad abziehen pausiert; keine Konsolenfehler. Screenshots → shots/pad/. Exit 1 bei Fehler.
 * Review-Fixes (zweite Seite, Web-Autoplay emuliert): Ton per Taste/Klick ohne Lock und ohne Ende des Pad-Modus
 * (A7), Blick steht hinter der Pause und der Stick wirkt im ersten Frame nach "Weiter" (A1), ein Fake-Pad-Lauf
 * ist im Replay assistiert (A6).
 * Strings in page.evaluate (tsx + Playwright: "__name is not defined", fallen.md #238).
 */
import { mkdirSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { unpackReplay } from '../../src/engine/replay/codec';

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
  output: { fwd: number; side: number; yawRate: number; pitchRate: number };
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

/**
 * Chrome-Autoplay wie im echten Web (headless startet den Ton sonst ohne Geste): der Kontext beginnt 'suspended',
 * resume() wirkt nur innerhalb einer echten Eingabe, sonst hängt es — und löst sich mit, sobald eine Geste ihn
 * startet. Nicht navigator.userActivation: Playwrights page.evaluate (also auch __vel.pad) zählt als Aktivierung.
 */
const AUTOPLAY_GATE = `(() => {
  const Orig = window.AudioContext;
  const waiting = [];
  let gesture = false;
  const mark = (e) => { if (!e.isTrusted) return; gesture = true; setTimeout(() => { gesture = false; }, 0); };
  for (const t of ['keydown', 'mousedown', 'pointerdown', 'click']) window.addEventListener(t, mark, true);
  class Gated extends Orig {
    constructor(o) { super(o); this.__gate = true; void super.suspend(); }
    get state() { return this.__gate ? 'suspended' : super.state; }
    resume() {
      if (gesture) {
        this.__gate = false;
        return super.resume().then(() => { for (const r of waiting.splice(0)) r(); });
      }
      return new Promise((r) => waiting.push(r));
    }
  }
  window.AudioContext = Gated;
})();`;

/** Timer starten (Stick vorn aus der Start-Zone), dann per Teleport durch alle Checkpoints ins Ziel. */
const PAD_FINISH = `(() => {
  const v = window.__vel;
  const lv = v.levelInfo();
  const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const fin = lv.triggers.find((t) => t.kind === 'finish');
  v.freeze(true);
  v.pad({ axes: [0, -1, 0, 0] });
  for (let i = 0; i < 600 && v.state().runTime === null; i++) v.stepTicks(1);
  v.pad({ axes: [0, 0, 0, 0] });
  for (const c of cps) { v.teleport(c.spawn.x, c.spawn.y, c.spawn.z, c.spawnYaw); v.stepTicks(2); }
  v.teleport((fin.min.x + fin.max.x) / 2, fin.min.y + 4, (fin.min.z + fin.max.z) / 2);
  v.stepTicks(2);
  v.freeze(false);
  return v.state().gameState;
})()`;

/** Neue Seite (Autoplay-Gate aus dem Kontext), per Fake-Pad ins erste Level. */
async function bootPad(ctx: BrowserContext, errors: string[]): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.goto(`http://localhost:${PORT}/?online=mock`);
  await page.waitForFunction('window.__vel && window.__vel.ready === true', null, { timeout: 30000 });
  await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 15000 });
  await page.waitForTimeout(800);
  await pad(page, `{ id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)' }`);
  await frames(page, 2);
  for (let i = 0; i < 8 && (await state(page)).gameState === 'title'; i++) {
    await tap(page, 'PadA');
    await page.waitForTimeout(400);
  }
  await page.waitForFunction("window.__vel.state().gameState === 'playing'", null, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
  return page;
}

const beatOf = (page: Page): Promise<number> => page.evaluate('window.__vel.beat().beat') as Promise<number>;

async function review(browser: Browser, errors: string[]): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(AUTOPLAY_GATE);

  // A7 (Taste): eigene Seite, weil der Ton pro Seite nur einmal freigeschaltet wird.
  const kp = await bootPad(ctx, errors);
  const notice = (await kp.evaluate('window.__vel.state().notice')) as string | null;
  check(notice === 'Für Ton: Klick oder Taste' && (await beatOf(kp)) === 0, 'Pad-Start ohne Geste: kein Ton, Hinweis "Klick oder Taste"', `${notice}, beat ${await beatOf(kp)}`);
  await kp.keyboard.press('KeyQ');
  await kp.waitForTimeout(600);
  check((await beatOf(kp)) > 0, 'Taste im Spiel schaltet den Ton frei (Review A7)', `beat ${await beatOf(kp)}`);
  await kp.close();

  const page = await bootPad(ctx, errors);
  // A7 (Klick): der erste Klick ist nur die Ton-Geste — Ton an, kein Lock, Pad-Modus bleibt.
  check((await beatOf(page)) === 0, 'zweite Seite: noch kein Ton', `beat ${await beatOf(page)}`);
  await page.mouse.click(640, 420);
  await page.waitForTimeout(600);
  let inf = await info(page);
  check(
    (await beatOf(page)) > 0 && inf.controlMode === 'pad' && !(await locked(page)) && (await state(page)).gameState === 'playing',
    'erster Klick im Pad-Modus: Ton an, kein Lock, Pad-Modus bleibt (Review A7)',
    `beat ${await beatOf(page)}, ${inf.controlMode}, Lock ${await locked(page)}`,
  );
  // N1: mit Ton ist ein Klick wieder "zurück auf Maus" (vorher nach A7: Klick ohne jede Wirkung).
  await page.mouse.click(640, 420);
  await page.waitForTimeout(400);
  inf = await info(page);
  const st1 = await state(page);
  check(
    inf.controlMode === 'mouse' && ((await locked(page)) || st1.gameState === 'paused'),
    'zweiter Klick (Ton an): zurück auf Maus, Lock angefordert (Review N1)',
    `${inf.controlMode}, Lock ${await locked(page)}, ${st1.gameState}`,
  );

  // A1 braucht den Pad-Modus ohne Lock (mit Lock nullt der Lock-Verlust beim Pausieren alles): der zweite Klick
  // nahm den Lock (oder pausierte, weil er scheiterte) → Lock lösen → Pause → A = weiter im Pad-Modus.
  if (await locked(page)) {
    await page.evaluate('document.exitPointerLock()');
    await frames(page, 3);
  }
  if ((await state(page)).gameState === 'paused') {
    await tap(page, 'PadA');
    await page.waitForTimeout(300);
  }
  inf = await info(page);
  check(inf.controlMode === 'pad' && !(await locked(page)) && (await state(page)).gameState === 'playing', 'Pause → A: weiter im Pad-Modus ohne Lock', `${inf.controlMode}, ${(await state(page)).gameState}`);
  // A1: Kamera-Stick gehalten → Start → Stick los: der Blick steht hinter der Pause (vorher 630 °/s weiter).
  await pad(page, '{ axes: [0, 0, 1, 0] }');
  await page.waitForTimeout(400);
  await tap(page, 'PadMenu');
  await pad(page, '{ axes: [0, 0, 0, 0] }');
  await frames(page, 2);
  const y0 = (await state(page)).yawDeg;
  await page.waitForTimeout(1000);
  // Der Spieler-Yaw steht in der Pause ohnehin (keine Ticks) — die Rate lief in InputState weiter und sprang erst
  // nach "Weiter" in den Blick. Also nach Weiter + 1 Tick messen (Stick ist los).
  const back = (await page.evaluate(
    "(() => { const v = window.__vel; const s = v.state().gameState; v.freeze(true); v.resume(); v.stepTicks(1); const y = v.state().yawDeg; v.freeze(false); return { s, y }; })()",
  )) as { s: string; y: number };
  const dy = (((back.y - y0) % 360) + 540) % 360 - 180;
  check(back.s === 'paused' && Math.abs(dy) < 0.5, `Pause mit gedrehtem Stick, 1 s, Weiter: Blick steht (${dy.toFixed(2)}°, Review A1)`, back.s);
  await tap(page, 'PadMenu');
  await frames(page, 2);
  const st = await state(page);
  check(st.gameState === 'paused', 'wieder pausiert', st.gameState);
  // A1: Stick in der Pause gedrückt, "Weiter" zwischen zwei Frames → schon der erste Tick dreht (keine Ein-Frame-Lücke).
  await pad(page, '{ axes: [0, 0, 1, 0] }');
  await frames(page, 3);
  inf = await info(page);
  check(inf.output.yawRate === 0, 'im Menü: Kamera-Stick ohne Drehrate', JSON.stringify(inf.output));
  const first = (await page.evaluate(
    "(() => { const v = window.__vel; v.freeze(true); v.resume(); const a = v.state().yawDeg; v.stepTicks(1); const b = v.state().yawDeg; v.freeze(false); return { state: v.state().gameState, d: b - a }; })()",
  )) as { state: string; d: number };
  check(first.state === 'playing' && first.d < -1, `Weiter → erster Frame dreht schon (${first.d.toFixed(2)}°, Review A1)`, JSON.stringify(first));
  await pad(page, '{ axes: [0, 0, 0, 0] }');
  await page.waitForTimeout(300);

  // A6: Lauf mit Fake-Pad ins Ziel → das Replay ist assistiert (submit-run lehnt es ab).
  const done = (await page.evaluate(PAD_FINISH)) as string;
  await page.waitForFunction('window.__vel.online().replay !== null', null, { timeout: 8000 }).catch(() => undefined);
  const b64 = (await page.evaluate('window.__vel.online().replay')) as string | null;
  const assisted = b64 ? (await unpackReplay(new Uint8Array(Buffer.from(b64, 'base64')))).header.assisted : null;
  check(done === 'finished' && assisted === true, 'Fake-Pad-Lauf: Replay assistiert (Review A6)', `${done}, assisted ${assisted}`);
  await page.screenshot({ path: `${DIR}/03-review-finish.png` });
  await ctx.close();
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
  console.log('  — Review-Fixes (Web-Autoplay emuliert)');
  await review(browser, errors);
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
