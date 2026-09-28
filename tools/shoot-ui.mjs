/**
 * UI-Preview (dev/ui.html) im echten Chromium. Startet einen eigenen
 * Vite-Server auf Port 5183.
 *
 *   node tools/shoot-ui.mjs            → Screenshots: HUD in mehreren Spielmomenten + jedes Menü → shots/ui/*.png
 *   node tools/shoot-ui.mjs hud-bhop   → nur Shots, deren Name den Filter enthält
 *   node tools/shoot-ui.mjs --check    → Funktionschecks (Menü, Pointer Lock, Tasten, Font-Transparenz)
 */
import { mkdirSync } from 'node:fs';
import { startDevServer, launchBrowser } from './lib/devServer.mjs';

const PORT = 5183;
const OUT = 'shots/ui';
const CHECK = process.argv.includes('--check');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';

// Zeitpunkte im Fake-Lauf (src/ui/dev/fakeRun.ts): Hops starten bei 1.6 + k·0.755 s.
const HOP = (k) => 1.6 + k * 0.755;
const SHOTS = [
  { name: 'hud-intro', view: 'hud', t: 0.9 },
  { name: 'hud-intro-fade', view: 'hud', t: 2.0 },
  { name: 'hud-bhop', view: 'hud', t: HOP(4) + 0.3 },
  { name: 'hud-fade', view: 'hud', t: HOP(4) + 0.72 },
  { name: 'hud-land', view: 'hud', t: HOP(5) + 0.01 },
  { name: 'hud-bhop-late', view: 'hud', t: HOP(11) + 0.25 },
  { name: 'hud-badhop', view: 'hud', t: HOP(7) + 0.15 },
  { name: 'hud-split', view: 'hud', t: 6.5 },
  { name: 'hud-split-fade', view: 'hud', t: 6.2 + 2.55 },
  { name: 'hud-surf', view: 'hud', t: 14.2 },
  { name: 'hud-brake', view: 'hud', t: 15.55 },
  { name: 'hud-finish', view: 'hud', t: 18.35 },
  { name: 'hud-notice', view: 'hud', t: 5, setup: 'notice' },
  { name: 'hud-360', view: 'hud', t: HOP(4) + 0.3, res: 360 },
  { name: 'hud-240', view: 'hud', t: HOP(4) + 0.3, res: 240 },
  { name: 'hud-448', view: 'hud', t: 6.5, res: 448 },
  { name: 'hud-448-finish', view: 'hud', t: 18.35, res: 448 },
  { name: 'menu-title', view: 'title', t: 2 },
  { name: 'menu-title-hover', view: 'title', t: 2, setup: 'hoverLevel3' },
  { name: 'menu-pause', view: 'pause', t: 8 },
  { name: 'menu-pause-lockerror', view: 'pause', t: 8, setup: 'lockError' },
  { name: 'menu-settings', view: 'settings', t: 8 },
  { name: 'menu-controls', view: 'controls', t: 8 },
  { name: 'menu-finish', view: 'finish', t: 18.4 },
  { name: 'menu-tuning', view: 'tuning', t: 8 },
];

mkdirSync(OUT, { recursive: true });
const srv = await startDevServer(PORT);
const browser = await launchBrowser();
const errors = [];
let failed = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  if (CHECK) failed = await runChecks(page);
  else await runShots(page);
} finally {
  await browser.close();
  await srv.close();
}
if (errors.length > 0) {
  console.error(`\n${errors.length} Browser-Fehler:\n${errors.join('\n')}`);
  process.exit(1);
}
if (failed > 0) process.exit(1);

// ------------------------------------------------------------------ Screenshots

async function open(page, q) {
  await page.goto(`${srv.url}dev/ui.html?${q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ui?.ready === true);
  // Schriften müssen geladen sein, sonst fotografieren wir den Fallback-Font.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function runShots(page) {
  for (const s of SHOTS) {
    if (filter && !s.name.includes(filter)) continue;
    await open(page, `view=${s.view}&t=${s.t}&freeze=1&bar=0&res=${s.res ?? 270}`);
    if (s.setup === 'notice') await page.evaluate(() => window.__ui?.notice());
    if (s.setup === 'lockError') {
      await page.evaluate(() => window.__ui?.lockStatus({ pending: false, error: 'NotAllowedError: Too many pointer lock requests' }));
    }
    if (s.setup === 'hoverLevel3') await page.hover('.vel-level >> nth=2');
    await page.evaluate(() => window.__ui?.draw());
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${OUT}/${s.name}.png` });
    console.log(`✓ ${OUT}/${s.name}.png`);
  }
}

// ------------------------------------------------------------------ Funktionschecks

async function runChecks(page) {
  let fails = 0;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) fails++;
  };
  const probe = () => page.evaluate(() => window.__ui.probe());
  const lastLog = async (n = 8) => (await probe()).log.slice(-n).join(' ');

  // --- Titel: Hover ändert die Auswahl nicht, der Start-Knopf nennt das Level.
  await open(page, 'view=title&t=2&freeze=1&bar=0');
  const startText = await page.textContent('.vel-start-level');
  check('Start-Knopf nennt das ausgewählte Level', startText?.includes('Sandbox') === true, startText ?? '');
  const startBox = await page.locator('.vel-start').boundingBox();
  const l3 = await page.locator('.vel-level >> nth=2').boundingBox();
  // Weg von oben durch die Liste zum Start-Knopf (der Befund aus dem Review).
  await page.mouse.move(l3.x + l3.width / 2, 120);
  await page.mouse.move(l3.x + l3.width / 2, l3.y + l3.height / 2, { steps: 8 });
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + startBox.height / 2, { steps: 8 });
  check('Überfahren der Liste lässt die Auswahl stehen', (await probe()).selectedLevel === 'sandbox', (await probe()).selectedLevel);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('Start-Klick startet das vorausgewählte Level', (await lastLog()).includes('menu:play:sandbox'), await lastLog());
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForTimeout(200);

  // --- Pfeiltasten wählen und aktualisieren den Knopf.
  await open(page, 'view=title&t=2&freeze=1&bar=0');
  await page.keyboard.press('ArrowDown');
  const afterArrow = await page.textContent('.vel-start-level');
  check('Pfeil runter wählt Level 2 und beschriftet den Knopf', afterArrow?.includes('02') === true && (await probe()).selectedLevel === 'neonhafen', afterArrow ?? '');

  // --- Lock-Rückmeldung in der Pause.
  await open(page, 'view=pause&t=8&freeze=1&bar=0');
  await page.evaluate(() => window.__ui.lockStatus({ pending: true, error: null }));
  const disabledPending = await page.locator('.vel-pause-screen .vel-btn--primary').isDisabled();
  check('Weiter ist gesperrt, solange ein Lock-Versuch läuft', disabledPending);
  await page.evaluate(() => window.__ui.lockStatus({ pending: false, error: 'NotAllowedError: Too many pointer lock requests in a short window of time.' }));
  const resumeLabel = await page.textContent('.vel-resume-label');
  const hint = await page.textContent('.vel-lock-hint');
  check('Lock-Fehler: „Klicken zum Fortsetzen“ + lesbarer Hinweis', resumeLabel === 'Klicken zum Fortsetzen' && /Kurz warten/.test(hint ?? ''), `${resumeLabel} | ${hint}`);
  check('Weiter nach Fehler wieder klickbar', !(await page.locator('.vel-pause-screen .vel-btn--primary').isDisabled()));

  // --- Spiel: Lock per Klick, Maus, Grace-Filter, Esc, Strg, beforeunload.
  await open(page, 'view=hud&t=5&freeze=1&bar=0');
  await page.mouse.click(720, 405);
  await page.waitForFunction(() => window.__ui.probe().locked === true, null, { timeout: 3000 }).catch(() => undefined);
  let p = await probe();
  check('Klick ins Spiel lockt die Maus', p.locked, `raw=${p.rawInput}`);
  const move = (dx, dy = 0) =>
    page.evaluate(([x, y]) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y })), [dx, dy]);
  const yaw0 = (await probe()).yawDeg;
  if (!p.rawInput) {
    await move(900);
    check('Grace: absurder Sprung direkt nach Lock wird verworfen', Math.abs((await probe()).yawDeg - yaw0) < 1e-9);
    await move(100);
    await move(900);
    const y3 = (await probe()).yawDeg;
    // Sens 2 · 0.022 °/Count: 100 + 900 Counts = −44°.
    check('Grace: nur die ersten zwei Events geprüft — schneller Flick danach zählt voll', Math.abs(y3 - yaw0 + 44) < 1e-6, `${(y3 - yaw0).toFixed(3)}°`);
  } else {
    await move(900);
    check('Raw-Modus: kein Grace-Filter', Math.abs((await probe()).yawDeg - yaw0 + 39.6) < 1e-6);
  }
  const yaw1 = (await probe()).yawDeg;
  await move(100);
  check('100 Counts bei Sens 2 = −4.4°', Math.abs((await probe()).yawDeg - yaw1 + 4.4) < 1e-9);

  // Strg im Fenster: kein Ducken, aber ein Hinweis; C duckt.
  await page.keyboard.down('ControlLeft');
  let t = await page.evaluate(() => window.__ui.tick(0, 1));
  check('Strg im Fenstermodus duckt nicht', t.crouch === false && (await probe()).ctrlCrouch === false);
  check('Strg im Fenstermodus zeigt den Hinweis', (await lastLog()).includes('notice:ctrlCrouchNeedsFullscreen'), await lastLog(3));
  await page.keyboard.up('ControlLeft');
  await page.keyboard.down('KeyC');
  t = await page.evaluate(() => window.__ui.tick(0, 1));
  check('C duckt', t.crouch === true);
  await page.keyboard.up('KeyC');

  // Verlassen-Schutz im Lock.
  const guarded = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  check('beforeunload im Lock: Browser fragt nach (Strg+W-Netz)', guarded);

  // Esc als keydown im Lock (so liefert Chrome es mit Keyboard Lock): genau ein 'pause' und freie Maus.
  const nBefore = (await probe()).log.filter((l) => l === 'action:pause').length;
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true })));
  await page.waitForFunction(() => window.__ui.probe().locked === false, null, { timeout: 2000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  p = await probe();
  const nPause = p.log.filter((l) => l === 'action:pause').length - nBefore;
  check('Esc-keydown im Lock gibt die Maus frei', !p.locked);
  check('… und erzeugt genau eine Pause', nPause === 1 && p.view === 'pause', `pauses=${nPause} view=${p.view}`);
  const unguarded = await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  check('beforeunload ohne Lock: kein Dialog', !unguarded);

  // Weiter per Klick → Lock wieder da (trackLock), Knopf danach wieder frei.
  await page.waitForTimeout(1200);
  await page.click('.vel-pause-screen .vel-btn--primary');
  // Die Pause bleibt stehen, bis der Lock da ist (Integrationsablauf) — dann erst HUD.
  await page.waitForFunction(() => window.__ui.probe().locked === true && window.__ui.probe().view === 'hud', null, { timeout: 3000 }).catch(() => undefined);
  p = await probe();
  check('Weiter lockt wieder, Pause verschwindet erst danach', p.locked && p.view === 'hud', `locked=${p.locked} view=${p.view} lock=${p.lastLockResult}`);
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForTimeout(200);

  // Vollbild + Keyboard Lock (headless evtl. nicht verfügbar → nur Hinweis).
  await open(page, 'view=title&t=2&freeze=1&bar=0');
  await page.click('text=Vollbild');
  await page.waitForTimeout(500);
  const fs = await page.evaluate(() => ({ fs: document.fullscreenElement !== null, kb: 'keyboard' in navigator, ctrl: window.__ui.probe().ctrlCrouch }));
  if (fs.fs && fs.kb) check('Vollbild mit Keyboard Lock schaltet Strg-Ducken frei', fs.ctrl === true, JSON.stringify(fs));
  else console.log(`- Vollbild/Keyboard Lock headless nicht prüfbar (${JSON.stringify(fs)})`);
  if (fs.fs && fs.kb) {
    // Echter Esc-Druck mit Keyboard Lock + Pointer Lock (der Review-Befund): Chrome reicht Esc als
    // keydown durch und lässt den Pointer Lock stehen — wir müssen ihn selbst freigeben.
    await page.click('.vel-start');
    await page.waitForFunction(() => window.__ui.probe().locked === true, null, { timeout: 3000 }).catch(() => undefined);
    const before = (await probe()).log.filter((l) => l === 'action:pause').length;
    const lockedBefore = (await probe()).locked;
    // Diagnose: kommt Esc als echter keydown an, während der Lock noch steht? (= Chrome gibt ihn nicht selbst frei)
    await page.evaluate(() => {
      window.__escSeen = null;
      window.addEventListener(
        'keydown',
        (e) => {
          if (e.code === 'Escape') window.__escSeen = { trusted: e.isTrusted, locked: document.pointerLockElement !== null };
        },
        { capture: true, once: true },
      );
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const pp = await probe();
    const escSeen = await page.evaluate(() => window.__escSeen);
    const pauses = pp.log.filter((l) => l === 'action:pause').length - before;
    const stillFs = await page.evaluate(() => document.fullscreenElement !== null);
    console.log(`  Diagnose: Esc-keydown ${JSON.stringify(escSeen)} (locked=true → Chrome hätte den Lock stehen lassen)`);
    check('Vollbild+Keyboard Lock: echter Esc-Druck gibt die Maus frei', lockedBefore && !pp.locked, `vorher=${lockedBefore} nachher=${pp.locked}`);
    check('… genau eine Pause, Vollbild bleibt', pauses === 1 && pp.view === 'pause' && stillFs, `pauses=${pauses} view=${pp.view} fs=${stillFs}`);
  }
  if (fs.fs) {
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForTimeout(300);
    check('Vollbild verlassen sperrt Strg-Ducken wieder', (await probe()).ctrlCrouch === false);
  }

  // --- Font: verblassender Text mit Kontur wird transparent, nicht dunkel.
  await fontChecks(page, check);

  console.log(fails === 0 ? '\nAlle Checks grün.' : `\n${fails} Check(s) fehlgeschlagen.`);
  return fails;
}

async function fontChecks(page, check) {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const FILL = '#5dff9a';
  const OUTL = [7, 4, 15];
  const BG = '#c08060';
  const bg = hex(BG);
  const fill = hex(FILL);
  const run = (alpha, scale = 3) =>
    page.evaluate((o) => window.__ui.probeText(o), { text: '+23', alpha, scale, outline: true, shadow: true, color: FILL, bg: BG });
  const at = (r, x, y) => r.px.slice((y * r.w + x) * 4, (y * r.w + x) * 4 + 3);
  const near = (a, b, tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const mix = (a, b, t) => a.map((v, i) => v * t + b[i] * (1 - t));

  const full = await run(1);
  const half = await run(0.5);
  const quarter = await run(0.25);
  // Farbklassen bei alpha 1: nur Hintergrund, Füllung, Kontur und Schatten-über-Kontur/Hintergrund.
  let fillPx = 0;
  let badHalf = 0;
  let badQuarter = 0;
  let outlinePx = 0;
  let badOutline = 0;
  for (let y = 0; y < full.h; y++) {
    for (let x = 0; x < full.w; x++) {
      const c = at(full, x, y);
      if (near(c, fill, 0)) {
        fillPx++;
        if (!near(at(half, x, y), mix(fill, bg, 0.5))) badHalf++;
        if (!near(at(quarter, x, y), mix(fill, bg, 0.25))) badQuarter++;
      } else if (near(c, OUTL, 0)) {
        outlinePx++;
        if (!near(at(half, x, y), mix(OUTL, bg, 0.5))) badOutline++;
      }
    }
  }
  check('Font alpha 0.5: Füllung = 50 % über Hintergrund (kein dunkler Fleck)', fillPx > 50 && badHalf === 0, `${fillPx} px, ${badHalf} falsch, Beispiel ${JSON.stringify(sampleFill(full, half, fill, at, near))}`);
  check('Font alpha 0.25: Füllung = 25 % über Hintergrund', badQuarter === 0, `${badQuarter} falsch`);
  check('Font alpha 0.5: Kontur gleichmäßig 50 % (keine doppelten Ränder zwischen Zeichen)', outlinePx > 20 && badOutline === 0, `${outlinePx} px, ${badOutline} falsch`);
}

function sampleFill(full, half, fill, at, near) {
  for (let y = 0; y < full.h; y++) for (let x = 0; x < full.w; x++) if (near(at(full, x, y), fill, 0)) return at(half, x, y);
  return null;
}
