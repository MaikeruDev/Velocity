/**
 * Admin-Menü im echten Spiel → shots/admin/. Port ADMIN_PORT (Default 5290).
 *
 *   title.png          Titel mit dem unauffälligen Admin-Knopf im System-Panel
 *   admin.png          Admin-Menü (per F8), alles gesperrt
 *   admin-set.png      nach "Alles sperren" + L1 Gold + L2 VELOCITY
 *   admin-pause.png    Admin-Menü aus der Pause (F8)
 *   cosmetics-fallback.png  Kosmetik: gespeicherte Wahl zeigt auf Gesperrtes → Standard/Nichts markiert
 *
 * Ablauf-Checks (Exit 1 bei Fehler): F8 öffnet/schließt, Schalter überleben Neuladen samt
 * Ableitung, Medaille setzen → Levelauswahl zeigt sie, Bestzeit löschen entfernt den Ghost,
 * gesperrte Kosmetik wirkt in der Hand als Standard, Esc aus der Pause führt zurück in die Pause.
 *
 *   node tools/admin-shots.mjs
 */
import { mkdirSync } from 'node:fs';
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const PORT = Number(process.env.ADMIN_PORT ?? 5290);
const OUT = 'shots/admin';
mkdirSync(OUT, { recursive: true });

const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
const fails = [];
const check = (ok, msg) => {
  if (!ok) fails.push(msg);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('vel-init')) return;
    sessionStorage.setItem('vel-init', '1');
    localStorage.clear();
    // Gespeicherte Wahl zeigt auf Gegenstände, die gleich gesperrt werden — Rückfall prüfen.
    // Ein alter v2-Stand mit Neon: Migration auf v3 im echten Spiel.
    localStorage.setItem('velocity.settings.v1', JSON.stringify({ fullscreenOnStart: false, glove: 'neon', heldItem: 'knife' }));
    localStorage.setItem('velocity.unlocks.v1', JSON.stringify({ v: 2, unlocked: { 'glove.neon': 'x' } }));
    localStorage.setItem('velocity.ghost.v1.level1', JSON.stringify({ dummy: true }));
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const load = async () => {
    await page.goto(srv.url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__vel?.ready === true);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForSelector('.vel-level');
  };
  await load();
  const store = () => page.evaluate(() => JSON.parse(localStorage.getItem('velocity.unlocks.v1') ?? 'null'));
  check((await store())?.v === 3, 'v2-Stand beim Start als v3 neu geschrieben');

  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/title.png` });
  check(await page.getByRole('button', { name: /^Admin/ }).isVisible(), 'Admin-Knopf im System-Panel sichtbar');

  // F8 öffnet, F8 schließt.
  await page.keyboard.press('F8');
  await page.waitForSelector('.vel-admin-screen');
  await page.keyboard.press('F8');
  check((await page.locator('.vel-admin-screen').count()) === 0, 'F8 schließt das Admin-Menü');
  await page.getByRole('button', { name: /^Admin/ }).click();
  await page.waitForSelector('.vel-admin-screen');

  // Alles sperren → dauerhaft, auch gegen Ableitung beim Neuladen.
  await page.getByRole('button', { name: 'Alles sperren' }).click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/admin.png` });
  check((await page.evaluate(() => window.__vel.unlocks())).length === 0, 'Alles sperren: nichts frei');
  check((await page.evaluate(() => window.__vel.hand())).glove === 'classic', 'gesperrter Neon-Handschuh → Hand trägt Standard');

  // Medaillen setzen: L1 Gold → Jo-Jo (Silber) + Neon (Sperre für L1 aufgehoben), L2 VELOCITY → Feuerzeug (Silber),
  // Skelett (Gold), Dose; Messer bleibt gesperrt (braucht L1-VELOCITY). Plan 007 Phase 3: ohne PENDING_UNLOCKS vergibt
  // die Ableitung auch die neuen Freischaltungen dieser Level.
  const level = (i) => page.locator('.vel-admin-level').nth(i);
  await level(0).getByRole('button', { name: 'GOLD' }).click();
  await level(1).getByRole('button', { name: 'VELOCITY' }).click();
  await page.waitForTimeout(250);
  const u1 = await page.evaluate(() => window.__vel.unlocks());
  check(JSON.stringify(u1) === JSON.stringify(['item.yoyo', 'item.lighter', 'glove.neon', 'glove.skeleton', 'item.can']), `Medaille setzen schaltet frei: ${JSON.stringify(u1)}`);
  check((await page.evaluate(() => localStorage.getItem('velocity.ghost.v1.level1'))) === null, 'Medaille setzen löscht den alten Ghost');
  // Sammelkarte von Hand an, Neon von Hand aus.
  await page.locator('[data-unlock="item.card"]').click();
  await page.locator('[data-unlock="glove.neon"]').click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/admin-set.png` });

  await load();
  const u2 = await page.evaluate(() => window.__vel.unlocks());
  check(JSON.stringify(u2) === JSON.stringify(['item.yoyo', 'item.lighter', 'glove.skeleton', 'item.card', 'item.can']), `nach Neuladen + Ableitung unverändert: ${JSON.stringify(u2)}`);
  const badges = await page.locator('.vel-level .vel-medal').allTextContents();
  check(badges[0] === 'GOLD' && badges[1] === 'VELOCITY', `Levelauswahl zeigt gesetzte Medaillen: ${JSON.stringify(badges)}`);

  // Kosmetik: gespeichert Neon + Messer, beides gesperrt → Standard + Nichts markiert.
  await page.getByRole('button', { name: 'Kosmetik' }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/cosmetics-fallback.png` });
  const pressed = await page.locator('.vel-cosm[aria-pressed="true"] .vel-cosm-name').allTextContents();
  check(JSON.stringify(pressed) === JSON.stringify(['Standard', 'Nichts']), `Kosmetik-Rückfall markiert: ${JSON.stringify(pressed)}`);
  await page.keyboard.press('Escape');

  // Pause → F8 → Bestzeit löschen für das laufende Level → Esc zurück in die Pause.
  await page.evaluate(() => window.__vel.start('level1', { lockless: true }));
  await page.evaluate(() => window.__vel.pause());
  await page.waitForSelector('.vel-pause-screen');
  await page.keyboard.press('F8');
  await page.waitForSelector('.vel-admin-screen');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/admin-pause.png` });
  await level(0).getByRole('button', { name: 'Bestzeit löschen' }).click();
  await page.waitForTimeout(100);
  check((await level(0).locator('.vel-admin-time').textContent()) === '--:--.--', 'Bestzeit löschen: Zeile zeigt keine Zeit');
  check((await page.evaluate(() => JSON.parse(localStorage.getItem('velocity.best.v1') ?? '{}').level1)) === undefined, 'Bestzeit gelöscht (Speicher)');
  check((await page.evaluate(() => window.__vel.ghost().loaded)) === false, 'kein Ghost mehr im laufenden Level');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check((await page.locator('.vel-pause-screen').count()) === 1, 'Esc führt zurück in die Pause');

  // Plan 007 (I2): "Alles freischalten" = alle 14 Einträge der Freischalt-Tabelle; das Kosmetik-Menü hat 14
  // Freischalt-Kacheln (+ Standard, Nichts), keine gesperrt.
  await page.keyboard.press('F8');
  await page.waitForSelector('.vel-admin-screen');
  await page.getByRole('button', { name: 'Alles freischalten' }).click();
  await page.waitForTimeout(200);
  const all = await page.evaluate(() => window.__vel.unlocks());
  const rows = await page.locator('.vel-admin-row').count();
  check(all.length === 14 && rows === 14, `Alles freischalten = 14 (frei ${all.length}, Admin-Zeilen ${rows})`);
  await page.screenshot({ path: `${OUT}/admin-all.png` });
} finally {
  await browser.close();
  await srv.close();
}
if (errors.length) console.error(`${errors.length} Konsolenfehler:\n${errors.join('\n')}`);
if (errors.length || fails.length) process.exit(1);
console.log('ok');
