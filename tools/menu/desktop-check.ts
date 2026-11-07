/**
 * Menü am Desktop ohne Electron (Plan 011, Review B4/B5) — Bridge-Attrappe statt Hülle, damit es im Web-Werkzeugkasten läuft:
 *  - Login wartet auf den System-Browser (§3.1, B4): "Login läuft" mit Abbrechen in classic und ps2 — Esc, Pad-B, Pad-A
 *    auf dem Knopf, Maus; "Browser erneut öffnen" öffnet dieselbe Seite; Ende ohne Login (Frist) schließt den Hinweis und
 *    meldet den Grund; Pfeile steuern das Menü darunter nicht. Web: Redirect wie bisher, kein Hinweis.
 *  - Ohne --dev kein Admin-Eintrag in irgendeinem Stil (B5: rave/arcade zeigten ihn, hub nannte ihn).
 *
 *   npx tsx tools/menu/desktop-check.ts       → shots/menu/desktop/<stil>-<WxH>-NN-<schritt>.png
 *   DESKCHECK_PORT=5722 (Default)  DESKCHECK_SIZE=1280x800,1920x1080 (Default)
 *
 * Hermetisch: window.velocityDesktop ist eine Attrappe (Login-Teil wie electron/auth.ts: openExternal wartet, cancel
 * antwortet 'cancelled'), Supabase ein erfundener Host, dessen Anfragen page.route beantwortet — kein Live-Projekt, kein
 * Discord, .env.local wird über die Prozess-Umgebung überstimmt (Vite: process.env schlägt .env-Dateien). Exit 1 bei Fehler.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = Number(process.env.DESKCHECK_PORT ?? 5722);
const SIZES = (process.env.DESKCHECK_SIZE ?? '1280x800,1920x1080').split(',').map((s) => {
  const [w, h] = s.trim().split('x').map(Number);
  if (!(w > 0 && h > 0)) throw new Error(`DESKCHECK_SIZE "${s}" ist nicht WxH`);
  return { w, h };
});
const OUT = 'shots/menu/desktop';
const FAKE_HOST = 'velocity-desktop-check.supabase.co';
// Vor createServer: Vite nimmt vorhandene process.env-Werte vor .env.local.
process.env.VITE_SUPABASE_URL = `https://${FAKE_HOST}`;
process.env.VITE_SUPABASE_ANON_KEY = 'desktop-check-test-key';
const PAD_JS = readFileSync('tools/pad/menu-page.js', 'utf8');
/** Attrappe des Bridges; Login wie electron/auth.ts (ein wartender Rücksprung, cancel → 'cancelled'). dev = --dev. */
const bridgeJs = (dev: boolean): string => `(() => {
  const st = { begins: 0, opens: [], cancels: 0, settle: null };
  window.__fakeAuth = st;
  window.__fakeAuthEnd = (r) => { const s = st.settle; st.settle = null; if (s) s(r); };
  window.velocityDesktop = {
    version: 1,
    versions: { electron: '0-fake', chrome: '0-fake' },
    dev: ${dev ? 'true' : 'false'},
    quit() {},
    window: { getMode: async () => 'windowed', setMode: async (m) => m },
    openExternal: async () => false,
    saveMirror: { readSync: () => null, write: async () => true, writeSync: () => true },
    auth: {
      begin: async () => { st.begins++; return { ok: true, redirectUrl: 'http://127.0.0.1:47823/auth/callback?state=0123456789abcdef0123456789abcdef' }; },
      openExternal: (url) => { st.opens.push(url); if (!st.settle) st.wait = new Promise((r) => { st.settle = r; }); return st.wait; },
      cancel: () => { st.cancels++; window.__fakeAuthEnd({ ok: false, error: 'cancelled', detail: 'Login abgebrochen.' }); },
      session: { read: async () => null, write: async () => true, remove: async () => true },
    },
  };
})();`;

let failed = false;
const fail = (msg: string): void => {
  failed = true;
  console.log(`  ✗ ${msg}`);
};
const ok = (msg: string): void => console.log(`  ✓ ${msg}`);

interface Auth {
  readonly begins: number;
  readonly opens: number;
  readonly sameUrl: boolean;
  readonly cancels: number;
}

class Run {
  private n = 0;
  constructor(
    readonly page: Page,
    readonly tag: string,
  ) {}

  async shot(name: string): Promise<void> {
    const path = `${OUT}/${this.tag}-${String(++this.n).padStart(2, '0')}-${name}.png`;
    await this.page.waitForTimeout(250);
    await this.page.screenshot({ path });
    console.log(`  ${path}`);
  }

  auth(): Promise<Auth> {
    // sameUrl: die letzten beiden Öffnungen (jeder neue Versuch hat eigenen state/Verifier, also eigene URL).
    return this.page.evaluate(`(() => { const o = window.__fakeAuth.opens; return { begins: window.__fakeAuth.begins, opens: o.length, sameUrl: o.length < 2 || o[o.length - 1] === o[o.length - 2], cancels: window.__fakeAuth.cancels }; })()`);
  }

  waiting(): Promise<boolean> {
    return this.page.evaluate(`(() => { const w = document.querySelector('.vel-menu .vel-login-wait'); return w !== null && w.getBoundingClientRect().height > 0; })()`);
  }

  toast(): Promise<string> {
    return this.page.evaluate(`(() => { const t = document.getElementById('vel-toast'); return t && !t.hidden ? (t.textContent ?? '') : ''; })()`);
  }

  focusText(): Promise<string> {
    return this.page.evaluate(`(document.querySelector('.vel-menu .vel-login-wait .is-padfocus')?.textContent ?? '(kein Pad-Fokus im Hinweis)').trim().replace(/\\s+/g, ' ')`);
  }

  async pad(b: string, hold = 3): Promise<void> {
    await this.page.evaluate(`window.__padTest.press(${JSON.stringify(b)}, ${hold})`);
  }

  /** Login-Knopf des Stils (Maus) — danach muss der Hinweis stehen. */
  async open(style: 'classic' | 'ps2', label: string): Promise<boolean> {
    await this.page.click(style === 'classic' ? '.vel-side .vel-discord-btn' : '.ps2-account--login');
    await this.page.waitForTimeout(300);
    const w = await this.waiting();
    if (!w) fail(`${label}: kein "Login läuft" nach dem Login-Knopf`);
    return w;
  }

  async closed(label: string, cancels: number): Promise<void> {
    await this.page.waitForTimeout(300);
    const a = await this.auth();
    const w = await this.waiting();
    const t = await this.toast();
    if (w || a.cancels !== cancels || /fehlgeschlagen/i.test(t)) fail(`${label}: Hinweis ${w ? 'noch da' : 'weg'}, cancel ${a.cancels}× (erwartet ${cancels}), Toast "${t}"`);
    else ok(`${label}: Hinweis weg, platform.auth.cancel() → ${a.cancels}×, kein Fehler-Toast`);
  }
}

async function style(browser: Browser, base: string, id: 'classic' | 'ps2', size: { w: number; h: number }): Promise<void> {
  const tag = `${id}-${size.w}x${size.h}`;
  console.log(`\n[desktop] Login läuft · ${tag}`);
  const errors: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  await ctx.addInitScript({ content: bridgeJs(true) });
  await ctx.addInitScript({ content: PAD_JS });
  // Supabase-Attrappe: Lesen → leer; kein Netz nach draußen.
  await ctx.route(`https://${FAKE_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: route.request().url().includes('/rest/') ? '[]' : '{}' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const r = new Run(page, tag);
  try {
    await page.goto(`${base}?menu=${id}&online=supabase`);
    await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
    await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 10000 });
    if (id === 'ps2') {
      await page.waitForSelector('.vel-menu[data-door="ready"]', { timeout: 15000 });
      await page.keyboard.press('Enter'); // Boot überspringen
      await page.waitForTimeout(500);
    }
    await page.waitForLoadState('networkidle');
    const plat = await page.evaluate(`document.querySelector('.vel-menu')?.getAttribute('data-platform') ?? ''`);
    if (plat !== 'desktop') fail(`Plattform "${plat}" statt desktop (Bridge-Attrappe nicht erkannt)`);

    // ---- Maus öffnet, Pfeile bewegen das Menü darunter nicht, Esc bricht ab
    if (await r.open(id, 'Maus')) {
      const a = await r.auth();
      if (a.begins !== 1 || a.opens !== 1) fail(`Login nicht gestartet (begin ${a.begins}×, Browser ${a.opens}×)`);
      else ok('Login-Knopf → Empfänger + Browser, "Login läuft" steht');
      const sel = id === 'ps2' ? `document.querySelector('.ps2-item.is-selected')?.dataset.id ?? ''` : `document.querySelector('.vel-level.is-selected .vel-level-num')?.textContent ?? ''`;
      const before: string = await page.evaluate(sel);
      await page.keyboard.press(id === 'ps2' ? 'ArrowRight' : 'ArrowDown');
      const after: string = await page.evaluate(sel);
      if (before !== after) fail(`Pfeiltaste bewegt das Menü unter dem Hinweis (${before} → ${after})`);
      await r.shot('waiting');
      await page.keyboard.press('Escape');
      await r.closed('Esc', 1);
      await r.shot('after-cancel');
    }

    // ---- Pad: Startfokus "Browser erneut öffnen", A öffnet dieselbe Seite, ▶ + A = Abbrechen
    if (await r.open(id, 'Pad')) {
      await page.evaluate(`window.__padTest.connect()`);
      await r.pad('LB'); // weckt das Pad (Gerät → Pad, Fokus sichtbar) — LB tut im Hinweis nichts
      const f0 = await r.focusText();
      if (!f0.includes('erneut')) fail(`Pad: Startfokus nicht auf "Browser erneut öffnen" (${f0})`);
      await r.shot('waiting-pad');
      const o0 = (await r.auth()).opens;
      await r.pad('A');
      await page.waitForTimeout(200);
      const a1 = await r.auth();
      if (a1.opens !== o0 + 1 || !a1.sameUrl || !(await r.waiting())) fail(`Pad-A "erneut öffnen": Browser ${a1.opens}× (erwartet ${o0 + 1}), gleiche URL ${a1.sameUrl}`);
      else ok('Pad-A "Browser erneut öffnen" → dieselbe Anmeldeseite, Hinweis bleibt');
      await r.pad('Right');
      const f1 = await r.focusText();
      if (!f1.includes('Abbrechen')) fail(`Pad ▶: Fokus nicht auf "Abbrechen" (${f1})`);
      await r.pad('A');
      await r.closed('Pad-A auf "Abbrechen"', 2);
    }

    // ---- Pad-B
    if (await r.open(id, 'Pad-B')) {
      await r.pad('B');
      await r.closed('Pad-B', 3);
    }

    // ---- Maus "Abbrechen"
    if (await r.open(id, 'Maus-Abbrechen')) {
      await page.mouse.move(2, 2);
      await page.click('.vel-login-wait .vel-login-cancel');
      await r.closed('Maus "Abbrechen"', 4);
    }

    // ---- Frist abgelaufen (Hauptprozess antwortet timeout): Hinweis weg, Grund im Toast
    if (await r.open(id, 'Frist')) {
      await page.evaluate(`window.__fakeAuthEnd({ ok: false, error: 'timeout', detail: 'Keine Rückmeldung aus dem Browser (5 min).' })`);
      await page.waitForTimeout(400);
      const w = await r.waiting();
      const t = await r.toast();
      if (w || !t.includes('Keine Rückmeldung')) fail(`Frist: Hinweis ${w ? 'noch da' : 'weg'}, Toast "${t}"`);
      else ok(`Frist: Hinweis weg, Toast "${t}"`);
    }
  } catch (err) {
    fail(`Ablauf abgebrochen: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    await page.screenshot({ path: `${OUT}/${tag}-99-abbruch.png` }).catch(() => undefined);
  } finally {
    for (const e of errors) fail(e);
    if (errors.length === 0) ok('keine Konsolenfehler');
    await ctx.close();
  }
}

/**
 * arcade löst Leertaste selbst aus (activateCursor → click(), wirkt auch auf inert). Unter "Login läuft" darf sie weder
 * den Login erneut öffnen noch etwas unter dem Hinweis starten (Review N1 menu-ui).
 */
async function arcadeSpace(browser: Browser, base: string): Promise<void> {
  console.log('\n[desktop] Login läuft · arcade · Leertaste');
  const errors: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript({ content: bridgeJs(true) });
  await ctx.addInitScript({ content: PAD_JS });
  await ctx.route(`https://${FAKE_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: route.request().url().includes('/rest/') ? '[]' : '{}' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const r = new Run(page, 'arcade-1280x800');
  try {
    await page.goto(`${base}?menu=arcade&online=supabase`);
    await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
    await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    // Automat startet im Attract-Modus: Münze einwerfen, dann steht das Menü mit den Werkzeugen.
    await page.keyboard.press('Digit5');
    await page.waitForTimeout(800);
    await page.waitForSelector('.ac-tool--login', { state: 'visible', timeout: 15000 });
    await page.click('.ac-tool--login');
    await page.waitForTimeout(300);
    if (!(await r.waiting())) fail('arcade: kein "Login läuft" nach LOGIN');
    else {
      const a0 = await r.auth();
      await page.waitForTimeout(500); // Sperre "frisch gemountet" (400 ms) der Tür vorbei
      await page.keyboard.press('Space');
      await page.waitForTimeout(300);
      const a1 = await r.auth();
      const screen = await page.evaluate(`document.querySelector('.vel-menu')?.getAttribute('data-screen') ?? ''`);
      const w = await r.waiting();
      if (a1.opens !== a0.opens || a1.begins !== a0.begins || !w || screen !== 'title') {
        fail(`arcade: Leertaste unter dem Hinweis wirkte (Browser ${a0.opens}→${a1.opens}, begin ${a0.begins}→${a1.begins}, Hinweis ${w}, Screen ${screen})`);
      } else ok('arcade: Leertaste unter "Login läuft" ohne Wirkung (kein erneuter Login, nichts gestartet)');
      await r.shot('waiting');
      await page.keyboard.press('Escape');
      await r.closed('arcade Esc', 1);
    }
  } catch (err) {
    fail(`Ablauf abgebrochen: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  } finally {
    for (const e of errors) fail(e);
    if (errors.length === 0) ok('keine Konsolenfehler');
    await ctx.close();
  }
}

/** Web (kein Bridge): Login bleibt der Seiten-Redirect — kein "Login läuft". */
async function web(browser: Browser, base: string): Promise<void> {
  console.log('\n[desktop] Web-Gegenprobe · classic 1280x800');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let authorize = 0;
  await ctx.route(`https://${FAKE_HOST}/**`, (route) => {
    if (route.request().url().includes('/auth/v1/authorize')) {
      authorize++;
      // 204 = Navigation ohne neues Dokument: die Seite bleibt stehen, der Redirect ist trotzdem gezählt.
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: route.request().url().includes('/rest/') ? '[]' : '{}' });
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}?menu=classic&online=supabase`);
    await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
    await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    await page.evaluate(`window.__sawWait = false; new MutationObserver(() => { if (document.querySelector('.vel-login-wait')) window.__sawWait = true; }).observe(document.body, { childList: true, subtree: true })`);
    await page.click('.vel-side .vel-discord-btn');
    await page.waitForTimeout(800);
    const w: boolean = await page.evaluate(`window.__sawWait === true || document.querySelector('.vel-login-wait') !== null`);
    if (w || authorize !== 1) fail(`Web: Hinweis ${w ? 'da' : 'nicht da'}, Redirect zu authorize ${authorize}× (erwartet: kein Hinweis, 1 Redirect)`);
    else ok('Web: Redirect zu Discord wie bisher, kein "Login läuft"');
  } catch (err) {
    fail(`Web: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  } finally {
    await ctx.close();
  }
}

/**
 * Desktop ohne --dev (B5): kein Stil bietet Admin an (Knopf, Werkzeug, Hinweistext) — er täte dort nichts. Der Stil kommt
 * aus den Einstellungen: ohne --dev gilt keine Query (?menu=).
 */
async function noAdmin(browser: Browser, base: string): Promise<void> {
  for (const id of ['classic', 'ps2', 'hub', 'rave', 'arcade'] as const) {
    console.log(`\n[desktop] ohne --dev · ${id} 1280x800`);
    const errors: string[] = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript({ content: `localStorage.setItem('velocity.settings.v1', JSON.stringify({ menuStyle: ${JSON.stringify(id)} }));` });
    await ctx.addInitScript({ content: bridgeJs(false) });
    await ctx.route(`https://${FAKE_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: route.request().url().includes('/rest/') ? '[]' : '{}' }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    try {
      await page.goto(base);
      // Ohne --dev gibt es kein window.__vel (und ?online=mock zählt nicht, Review C1) — auf das Menü selbst warten.
      await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 30000 });
      if (id !== 'classic') await page.waitForSelector('.vel-menu[data-door="ready"]', { timeout: 15000 });
      await page.waitForLoadState('networkidle');
      // Arcade: erst aus dem Attract-Mode (Münze), ps2: Boot überspringen, dann System (dort stünde Admin).
      if (id === 'arcade') {
        await page.keyboard.press('KeyC');
        await page.waitForTimeout(900);
      }
      if (id === 'ps2') {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        await page.click('.ps2-item[data-id="system"]');
        await page.waitForSelector('.ps2-ui[data-view="system"]', { timeout: 5000 });
      }
      await page.waitForTimeout(400);
      const r: { style: string; dev: string; hits: string[] } = await page.evaluate(`(() => {
        const m = document.querySelector('.vel-menu');
        const hits = Array.from(m.querySelectorAll('button, [role="button"], p, span')).filter((e) => e.offsetParent !== null && /admin/i.test(e.textContent ?? '') && !Array.from(e.children).some((c) => /admin/i.test(c.textContent ?? ''))).map((e) => (e.textContent ?? '').trim().slice(0, 40));
        return { style: m.getAttribute('data-menu-style') ?? '', dev: m.getAttribute('data-platform') ?? '', hits };
      })()`);
      if (r.style !== id || r.dev !== 'desktop') fail(`Aufbau: Stil "${r.style}", Plattform "${r.dev}"`);
      else if (r.hits.length > 0) fail(`${id}: Admin sichtbar ohne --dev: ${r.hits.join(' | ')}`);
      else ok(`${id}: kein Admin-Eintrag ohne --dev`);
      await page.screenshot({ path: `${OUT}/nodev-${id}.png` });
    } catch (err) {
      fail(`${id}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    } finally {
      for (const e of errors) fail(e);
      await ctx.close();
    }
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const vite = await createServer({ configFile: 'vite.config.ts', server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  const base = `http://localhost:${PORT}/`;
  for (const size of SIZES) {
    await style(browser, base, 'classic', size);
    await style(browser, base, 'ps2', size);
  }
  await arcadeSpace(browser, base);
  await web(browser, base);
  await noAdmin(browser, base);
} finally {
  await browser.close();
  await vite.close();
}
console.log(failed ? '\nFEHLER (siehe ✗)' : '\nOK');
process.exit(failed ? 1 : 0);
