/**
 * Menü-Labor (Plan 010): Screenshots je Hauptmenü-Stil zur Selbstkontrolle, im echten Spiel (?online=mock).
 *
 *   npx tsx tools/menu/shot.ts                    → alle Stile (classic, ps2, hub, rave, arcade)
 *   MENU_STYLE=rave npx tsx tools/menu/shot.ts    → nur einer (auch Liste: MENU_STYLE=rave,ps2)
 *   MENU_PORT=5720 (Default)  MENU_SIZE=1280x720 (Default; Liste: 1280x720,1920x1080)  MENU_WAIT=1500 (ms bis "später")
 *
 * Je Stil und Größe → shots/menu/<id>/[<WxH>-]NN-<schritt>.png:
 *   01-title (gleich nach "Front Door steht"), 02-title-later (nach MENU_WAIT), 03-arrow-down, 04-hover
 *   (Maus über dem ersten Knopf im Titel), 05-lab (über F8 → Admin → Menü-Labor), 06-pause, 07-settings
 *   (Bestands-Screens mit vel-style--<id>), 08-title-return (zurück aus dem Level: entry 'return').
 * Prüft: keine Konsolen-/Seitenfehler, Front Door gemountet (data-door=ready), Klasse vel-style--<id> am Root,
 * nach dem Level wieder gemountet. Exit 1 bei Fehler. Frischer Browser-Kontext je Stil (leerer localStorage).
 */
import { mkdirSync, rmSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { MENU_STYLE_IDS } from '../../src/engine/settingsTypes';
import type { MenuStyleId } from '../../src/engine/settingsTypes';

const PORT = Number(process.env.MENU_PORT ?? 5720);
const WAIT = Number(process.env.MENU_WAIT ?? 1500);
/** Bestands-Screens blenden 160 ms ein (vel-in, steps(4)) — davor wäre das Bild leer. */
const SETTLE = 300;
const wanted = (process.env.MENU_STYLE ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
const styles: MenuStyleId[] = wanted.length === 0 ? [...MENU_STYLE_IDS] : MENU_STYLE_IDS.filter((id) => wanted.includes(id));
if (wanted.length > 0 && styles.length !== wanted.length) {
  console.error(`Unbekannter Stil in MENU_STYLE=${process.env.MENU_STYLE} (bekannt: ${MENU_STYLE_IDS.join(', ')})`);
  process.exit(2);
}
const sizes = (process.env.MENU_SIZE ?? '1280x720').split(',').map((s) => {
  const [w, h] = s.trim().split('x').map(Number);
  if (!(w > 0 && h > 0)) throw new Error(`MENU_SIZE "${s}" ist nicht WxH`);
  return { w, h, tag: sizesTag(s.trim()) };
});
function sizesTag(s: string): string {
  return (process.env.MENU_SIZE ?? '').includes(',') ? `${s}-` : '';
}

let failed = false;
const fail = (msg: string): void => {
  failed = true;
  console.log(`  ✗ ${msg}`);
};

async function shoot(page: Page, dir: string, name: string): Promise<void> {
  const path = `${dir}/${name}.png`;
  await page.screenshot({ path });
  console.log(`  ${path}`);
}

async function runStyle(browser: Browser, base: string, id: MenuStyleId, size: { w: number; h: number; tag: string }): Promise<void> {
  const dir = `shots/menu/${id}`;
  mkdirSync(dir, { recursive: true });
  const errors: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const door = id !== 'classic';
  const p = (n: string): string => `${size.tag}${n}`;
  try {
    console.log(`\n[${id}] ${size.w}x${size.h}`);
    await page.goto(`${base}?menu=${id}&online=mock`);
    await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
    await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 10000 });
    if (door) await page.waitForSelector('.vel-menu[data-door="ready"]', { timeout: 15000 });
    // __vel.ready steht schon vor game.boot() — Levelliste/Lektionen erst nach dem Netz-Leerlauf sicher da.
    await page.waitForLoadState('networkidle');
    const cls = await page.evaluate(() => document.querySelector('.vel-menu')?.className ?? '');
    if (!cls.split(/\s+/).includes(`vel-style--${id}`)) fail(`Root-Klasse vel-style--${id} fehlt ("${cls}")`);
    await shoot(page, dir, p('01-title'));
    await page.waitForTimeout(WAIT);
    await shoot(page, dir, p('02-title-later'));
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(250);
    await shoot(page, dir, p('03-arrow-down'));
    const firstBtn = page.locator(door ? '.vel-frontdoor button' : '.vel-title-screen button').first();
    if ((await firstBtn.count()) > 0) {
      await firstBtn.hover();
      await page.waitForTimeout(250);
      await shoot(page, dir, p('04-hover'));
    } else console.log('  (kein Knopf im Titel zum Überfahren)');
    await page.mouse.move(2, 2);

    // Labor über F8 → Admin → Menü-Labor (geht in jedem Stil, unabhängig von dessen Knöpfen).
    await page.keyboard.press('F8');
    await page.waitForSelector('.vel-menu[data-screen="admin"]', { timeout: 5000 });
    await page.click('.vel-admin-screen .vel-lab-btn');
    await page.waitForSelector('.vel-menu[data-screen="lab"]', { timeout: 5000 });
    await page.waitForTimeout(SETTLE);
    await shoot(page, dir, p('05-lab'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.vel-menu[data-screen="admin"]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 5000 });

    // Bestands-Screens im Stil: Pause und Einstellungen.
    await page.evaluate(() => window.__vel?.start('level1', { lockless: true }));
    await page.waitForFunction(() => window.__vel?.state().gameState === 'playing', null, { timeout: 20000 });
    await page.evaluate(() => window.__vel?.pause());
    await page.waitForSelector('.vel-menu[data-screen="pause"]', { timeout: 5000 });
    await page.waitForTimeout(SETTLE);
    await shoot(page, dir, p('06-pause'));
    await page.click('.vel-menu .vel-btn:has-text("Einstellungen")');
    await page.waitForSelector('.vel-menu[data-screen="settings"]', { timeout: 5000 });
    await page.waitForTimeout(SETTLE);
    await shoot(page, dir, p('07-settings'));
    await page.mouse.move(2, 2); // sonst überfährt die Maus vom Klick auf Einstellungen einen Titel-Knopf
    await page.evaluate(() => window.__vel?.toTitle());
    await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 5000 });
    if (door) await page.waitForSelector('.vel-menu[data-door="ready"]', { timeout: 15000 }).catch(() => fail('nach dem Level nicht wieder gemountet'));
    await page.waitForTimeout(WAIT);
    await shoot(page, dir, p('08-title-return'));
  } catch (err) {
    fail(`Ablauf abgebrochen: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    await shoot(page, dir, p('99-abbruch')).catch(() => undefined);
  } finally {
    for (const e of errors) fail(e);
    if (errors.length === 0) console.log('  ✓ keine Konsolenfehler');
    await ctx.close();
  }
}

const vite = await createServer({ configFile: 'vite.config.ts', server: { port: PORT, strictPort: true, hmr: false }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
try {
  for (const id of styles) {
    // Alte Bilder des Stils weg — sonst liegen Reste eines früheren Laufs (z. B. 99-abbruch) dazwischen.
    rmSync(`shots/menu/${id}`, { recursive: true, force: true });
    for (const size of sizes) await runStyle(browser, `http://localhost:${PORT}/`, id, size);
  }
} finally {
  await browser.close();
  await vite.close();
}
console.log(failed ? '\nFEHLER (siehe ✗)' : '\nOK');
process.exit(failed ? 1 : 0);
