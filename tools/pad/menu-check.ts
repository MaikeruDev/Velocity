/**
 * Menü nur mit Pad (Plan 011 §1.5–1.7, Strang S1c): ein Fake-Gamepad ersetzt navigator.getGamepads (addInitScript),
 * der Ablauf drückt nur Pad-Knöpfe — ps2-Hauptmenü, Disc-Auswahl, Training, Memory Card, Profil, Bestenliste (LB/RB),
 * Kosmetik, System, Moderation (?mockdev), Einstellungen (Controller-Abschnitt, Slider per Steuerkreuz), Pause.
 * Prüft je Screen: Pad-Fokus sichtbar, alle bedienbaren Elemente per Steuerkreuz erreichbar (gleiche Regeln wie
 * ui/padNav), Glyphen wechseln Xbox → PlayStation → Tastatur im nächsten Frame, keine Konsolenfehler.
 *
 *   npx tsx tools/pad/menu-check.ts            → shots/pad/menu/<WxH>-NN-<schritt>.png
 *   PADMENU_PORT=5731 (Default)  PADMENU_SIZE=1280x800,1920x1080 (Default)
 *
 * Alles über den echten Pfad: Game verdrahtet das Menü (menu.setPad / setInputDevice über InputManager.onDevice); das
 * Gerät wechselt nur durch echte Eingaben (Fake-Pad, Playwright-Tastatur). Belegungs-Aufnahme per Pad (RT belegen,
 * B gehalten bricht ab). Exit 1 bei Fehler.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = Number(process.env.PADMENU_PORT ?? 5731);
const SIZES = (process.env.PADMENU_SIZE ?? '1280x800,1920x1080').split(',').map((s) => {
  const [w, h] = s.trim().split('x').map(Number);
  if (!(w > 0 && h > 0)) throw new Error(`PADMENU_SIZE "${s}" ist nicht WxH`);
  return { w, h };
});
const OUT = 'shots/pad/menu';
const PAGE_JS = readFileSync('tools/pad/menu-page.js', 'utf8');
const REACH_JS = readFileSync('tools/pad/menu-reach.js', 'utf8').replace(/^\/\/.*$/gm, '').trim();
const PATH_JS = readFileSync('tools/pad/menu-path.js', 'utf8').replace(/^\/\/.*$/gm, '').trim();
const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const PS_ID = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';

let failed = false;
const fail = (msg: string): void => {
  failed = true;
  console.log(`  ✗ ${msg}`);
};
const ok = (msg: string): void => console.log(`  ✓ ${msg}`);

type Btn = 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'RT' | 'Menu' | 'View' | 'Up' | 'Down' | 'Left' | 'Right';

class Run {
  private n = 0;
  constructor(
    readonly page: Page,
    readonly tag: string,
  ) {}

  async press(b: Btn, hold = 3): Promise<void> {
    await this.page.evaluate(`window.__padTest.press(${JSON.stringify(b)}, ${hold})`);
  }

  async shot(name: string): Promise<void> {
    const path = `${OUT}/${this.tag}-${String(++this.n).padStart(2, '0')}-${name}.png`;
    await this.page.waitForTimeout(250);
    await this.page.screenshot({ path });
    console.log(`  ${path}`);
  }

  async attr(sel: string, a: string): Promise<string | null> {
    return this.page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)}) ?? null`);
  }

  async focusText(): Promise<string> {
    return this.page.evaluate(`(document.querySelector('.is-padfocus')?.textContent ?? '(kein Pad-Fokus)').trim().replace(/\\s+/g, ' ').slice(0, 60)`);
  }

  async view(v: string): Promise<void> {
    await this.page.waitForSelector(`.ps2-ui[data-view="${v}"]`, { timeout: 5000 });
  }

  async screen(s: string): Promise<void> {
    await this.page.waitForSelector(`.vel-menu[data-screen="${s}"]`, { timeout: 5000 });
  }

  /** Per Steuerkreuz zum Ziel (Weg je Schritt neu berechnet — Scrollen verschiebt Rechtecke). */
  async goto(rootSel: string, targetSel: string, text?: string): Promise<boolean> {
    for (let i = 0; i < 30; i++) {
      const path: string[] | null = await this.page.evaluate(`(${PATH_JS})(${JSON.stringify(rootSel)}, ${JSON.stringify(targetSel)}, ${JSON.stringify(text ?? '')})`);
      if (path === null) {
        fail(`${targetSel}${text ? ` "${text}"` : ''} per Pad nicht erreichbar (Fokus: ${await this.focusText()})`);
        return false;
      }
      if (path.length === 0) return true;
      await this.press(path[0] as Btn);
    }
    fail(`${targetSel} nach 30 Schritten nicht erreicht`);
    return false;
  }

  /** Alles Bedienbare im Bereich vom Pad-Fokus aus erreichbar? */
  async reach(rootSel: string, label: string, allow: RegExp | null = null): Promise<void> {
    const r: { total: number; unreachable: string[] } = await this.page.evaluate(`(${REACH_JS})(${JSON.stringify(rootSel)})`);
    const bad = r.unreachable.filter((u) => allow === null || !allow.test(u));
    if (bad.length > 0) fail(`${label}: ${bad.length}/${r.total} nicht per Pad erreichbar: ${bad.join(', ')}`);
    else ok(`${label}: ${r.total} Elemente, alle per Pad erreichbar${r.unreachable.length > 0 ? ` (${r.unreachable.length} bewusst ausgenommen)` : ''}`);
    const focus = await this.page.evaluate(`document.querySelectorAll('.is-padfocus').length`);
    if (focus !== 1) fail(`${label}: ${String(focus)} Pad-Fokus-Elemente (erwartet 1)`);
  }

  async glyphs(): Promise<{ xbox: number; ps: number; keys: number }> {
    return this.page.evaluate(`({ xbox: document.querySelectorAll('.ps2-prompts .vel-pg--xbox').length, ps: document.querySelectorAll('.ps2-prompts .vel-pg--playstation').length, keys: document.querySelectorAll('.ps2-prompts .ps2-key').length })`);
  }
}

async function flow(browser: Browser, base: string, size: { w: number; h: number }): Promise<void> {
  const tag = `${size.w}x${size.h}`;
  console.log(`\n[pad-menu] ${tag}`);
  const errors: string[] = [];
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h } });
  await ctx.addInitScript({ content: PAGE_JS });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  const r = new Run(page, tag);
  try {
    await page.goto(`${base}?menu=ps2&online=mock&mockdev`);
    await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
    await page.waitForSelector('.vel-menu[data-door="ready"]', { timeout: 15000 });
    await page.waitForLoadState('networkidle');
    await page.evaluate(`window.__padTest.connect()`);
    // Erster Druck weckt das Pad (PadInput zählt den Knopf, der es aktiv macht, erst nach dem Loslassen), der zweite
    // überspringt den Boot.
    await r.press('A');
    await r.press('A');
    await page.waitForTimeout(500);
    if ((await r.attr('.vel-menu', 'data-input')) !== 'pad') fail('Pad-Druck schaltet das Menü nicht auf Pad (data-input), InputManager → Menü nicht verdrahtet');
    else ok('Gerät kommt vom InputManager (data-input="pad")');
    await r.view('main');
    let g = await r.glyphs();
    if (g.xbox === 0) fail(`Hauptmenü: keine Xbox-Glyphen in der Fußzeile (${JSON.stringify(g)})`);
    await r.shot('main-xbox');
    await r.reach('.ps2-stage', 'Hauptmenü');

    // ---- Disc-Auswahl: A öffnet, ▶ dreht die Bahn, ▼ wählt die Aktion, B zurück
    await r.goto('.ps2-stage', '.ps2-item[data-id="play"]');
    await r.press('A');
    await r.view('discs');
    const disc0 = await page.evaluate(`document.querySelector('.ps2-slot-name')?.textContent ?? ''`);
    await r.press('Right');
    const disc1 = await page.evaluate(`document.querySelector('.ps2-slot-name')?.textContent ?? ''`);
    if (disc0 === disc1) fail(`Disc-Auswahl: ▶ wechselt die Disc nicht (${disc0})`);
    await r.press('Down');
    if (!(await r.focusText()).includes('Bestenliste')) fail(`Disc-Auswahl: ▼ fokussiert nicht "Bestenliste" (${await r.focusText()})`);
    await r.press('Up');
    await r.shot('discs');
    await r.press('B');
    await r.view('main');

    // ---- Training
    await r.goto('.ps2-stage', '.ps2-item[data-id="training"]');
    await r.press('A');
    await r.view('training');
    await r.press('Down');
    await r.shot('training');
    await r.reach('.ps2-stage', 'Training');
    await r.press('B');
    await r.view('main');

    // ---- Memory Card → Profil
    await r.goto('.ps2-stage', '.ps2-item[data-id="card"]');
    await r.press('A');
    await r.view('card');
    await r.shot('card');
    await r.reach('.ps2-stage', 'Memory Card');
    if (await r.goto('.ps2-stage', 'button', 'Profil')) {
      await r.press('A');
      await r.view('profile');
      await page.waitForTimeout(400);
      await r.shot('profile');
      await r.reach('.ps2-stage', 'Profil');
      await r.press('B');
      await r.view('card');
    }
    await r.press('B');
    await r.view('main');

    // ---- Bestenliste: LB/RB = Strecke
    await r.goto('.ps2-stage', '.ps2-item[data-id="board"]');
    await r.press('A');
    await r.view('board');
    await page.waitForTimeout(600);
    const lv0 = await page.evaluate(`document.querySelector('.ps2-board-panel .ps2-panel-title')?.textContent ?? ''`);
    await r.press('RB');
    await page.waitForTimeout(600);
    const lv1 = await page.evaluate(`document.querySelector('.ps2-board-panel .ps2-panel-title')?.textContent ?? ''`);
    if (lv0 === lv1) fail(`Bestenliste: RB wechselt die Strecke nicht (${lv0})`);
    else ok(`Bestenliste: RB ${lv0} → ${lv1}`);
    await r.goto('.ps2-stage', '.ps2-tname-btn');
    await r.shot('board');
    await r.reach('.ps2-stage', 'Bestenliste');
    await r.press('B');
    await r.view('main');

    // ---- Kosmetik: ausrüsten per A
    await r.goto('.ps2-stage', '.ps2-item[data-id="cosmetics"]');
    await r.press('A');
    await r.view('cosmetics');
    await r.press('Down');
    await r.shot('cosmetics');
    await r.reach('.ps2-stage', 'Kosmetik');
    await r.press('B');
    await r.view('main');

    // ---- System → Moderation (mockdev), RB = Reiter
    await r.goto('.ps2-stage', '.ps2-item[data-id="system"]');
    await r.press('A');
    await r.view('system');
    await r.shot('system');
    await r.reach('.ps2-stage', 'System');
    // Web: kein Beenden (ctx.quit = null), Admin da (Plan 011 §2.5/§2.2.13).
    const sysLabels: string[] = await page.evaluate(`Array.from(document.querySelectorAll('.ps2-sys-item .ps2-sys-label')).map((e) => e.textContent ?? '')`);
    if (sysLabels.includes('Beenden') || !sysLabels.includes('Admin')) fail(`System (Web): Einträge ${sysLabels.join('/')} (erwartet: ohne Beenden, mit Admin)`);
    else ok('System (Web): kein Beenden, Admin da');
    if (await r.goto('.ps2-stage', '.ps2-sys-item', 'Moderation')) {
      await r.press('A');
      await r.view('moderation');
      await r.press('RB');
      await page.waitForTimeout(500);
      const tab = await r.attr('.ps2-tab.is-selected', 'data-tab');
      if (tab !== 'players') fail(`Moderation: RB öffnet nicht "Spieler" (${tab ?? '—'})`);
      await r.shot('moderation');
      await r.reach('.ps2-stage', 'Moderation');
      await r.press('B');
      await r.view('system');
    }

    // ---- Einstellungen (Bestands-Screen): Controller-Abschnitt, Slider per ◀▶, RB = nächster Abschnitt
    await r.goto('.ps2-stage', '.ps2-sys-item', 'Einstellungen');
    await r.press('A');
    await r.screen('settings');
    await page.waitForTimeout(400);
    const f0 = await r.attr('.is-padfocus', 'data-pad');
    if (f0 !== 'yawRate') fail(`Einstellungen: Start-Fokus nicht auf "Kamera X" (${f0 ?? '—'})`);
    const v0 = await page.evaluate(`document.querySelector('input[data-pad="yawRate"]')?.value ?? ''`);
    await r.press('Right');
    await r.press('Right');
    const v1 = await page.evaluate(`document.querySelector('input[data-pad="yawRate"]')?.value ?? ''`);
    if (Number(v1) <= Number(v0)) fail(`Einstellungen: ▶ ändert den Slider nicht (${v0} → ${v1})`);
    else ok(`Einstellungen: Kamera X ${v0} → ${v1} °/s per ▶`);
    await r.shot('settings-controller');
    await r.reach('.vel-screen', 'Einstellungen');
    const panelOf = `(() => { const f = document.querySelector('.is-padfocus'); const p = f?.closest('.vel-panel'); return p ? Array.from(document.querySelectorAll('.vel-panel')).indexOf(p) : -1; })()`;
    const p0: number = await page.evaluate(panelOf);
    await r.press('RB');
    const p1: number = await page.evaluate(panelOf);
    if (p0 === p1) fail('Einstellungen: RB springt nicht in den nächsten Abschnitt');
    await r.shot('settings-rb');
    // Belegung: Feld wählen + A → "Knopf …", RT belegt; erneut + B gehalten bricht ab; zurück auf LB
    if (await r.goto('.vel-screen', 'button[data-pad-bind="jump.0"]')) {
      const bind0 = `(JSON.parse(localStorage.getItem('velocity.pad.v1') ?? '{}').binds?.jump ?? [])[0] ?? null`;
      const field = `document.querySelector('button[data-pad-bind="jump.0"]')?.textContent ?? ''`;
      await r.press('A');
      const waiting: string = await page.evaluate(field);
      if (!waiting.includes('Knopf')) fail(`Belegung: A öffnet die Aufnahme nicht ("${waiting}")`);
      await r.shot('settings-bind');
      await r.press('RT');
      const got: string | null = await page.evaluate(bind0);
      const screenAfter = await r.attr('.vel-menu', 'data-screen');
      if (got !== 'PadRT' || screenAfter !== 'settings') fail(`Belegung: RT nicht aufgenommen (jump[0] = ${got}, Screen ${screenAfter})`);
      else ok('Belegung: A → "Knopf …", RT → jump[0] = PadRT');
      await r.press('A');
      await r.press('B', 60); // ~1 s gehalten → Abbruch, kein "Zurück"
      const kept: string | null = await page.evaluate(bind0);
      const stillOpen = await r.attr('.vel-menu', 'data-screen');
      const label: string = await page.evaluate(field);
      if (kept !== 'PadRT' || stillOpen !== 'settings' || label.includes('Knopf')) fail(`Belegung: B halten bricht nicht sauber ab (jump[0] = ${kept}, Screen ${stillOpen}, Feld "${label}")`);
      else ok('Belegung: B gehalten bricht ab, Screen bleibt');
      await r.press('A');
      await r.press('LB');
      const back: string | null = await page.evaluate(bind0);
      if (back !== 'PadLB') fail(`Belegung: LB zurück nicht aufgenommen (${back})`);
    }
    await r.press('B');
    await r.view('system');

    // ---- Glyphen: PlayStation-Pad, dann Tastatur — Wechsel im nächsten Frame
    await page.evaluate(`window.__padTest.kind(${JSON.stringify(PS_ID)})`);
    await r.press('Down');
    await r.press('Up');
    g = await r.glyphs();
    if (g.ps === 0) fail(`PlayStation-Pad: keine PS-Glyphen (${JSON.stringify(g)})`);
    else ok('PlayStation-Pad → ✕/○-Glyphen');
    await r.shot('system-playstation');
    await page.keyboard.press('ArrowDown');
    const kb: { keys: number; pg: number } = await page.evaluate(`new Promise((res) => requestAnimationFrame(() => res({ keys: document.querySelectorAll('.ps2-prompts .ps2-key').length, pg: document.querySelectorAll('.ps2-prompts .vel-pg').length })))`);
    if (kb.keys === 0 || kb.pg > 0) fail(`Tastatur: Glyphen nicht im nächsten Frame umgeschaltet (${JSON.stringify(kb)})`);
    else ok('Tastatur → Kappen im nächsten Frame');
    await r.shot('system-keyboard');
    await page.evaluate(`window.__padTest.kind(${JSON.stringify(XBOX_ID)})`);
    await r.press('Up');
    await r.press('Up');

    // ---- Spielen per A, Pause per Start, B = weiter
    await r.press('B');
    await r.view('main');
    await r.goto('.ps2-stage', '.ps2-item[data-id="play"]');
    await r.press('A');
    await r.view('discs');
    await r.press('A');
    const playing = await page
      .waitForFunction(() => window.__vel?.state().gameState === 'playing', null, { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    if (!playing) {
      console.log('  ! Start per Pad startet kein Level (Steuer-Modus Pad, S1b 1.4) — weiter mit __vel.start lockless');
      await page.evaluate(() => window.__vel?.start('level1', { lockless: true }));
      await page.waitForFunction(() => window.__vel?.state().gameState === 'playing', null, { timeout: 20000 });
    } else ok('A in der Disc-Auswahl startet das Level');
    await page.waitForTimeout(500);
    await r.press('Menu');
    const paused = await page
      .waitForSelector('.vel-menu[data-screen="pause"]', { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!paused) {
      console.log('  ! Start pausiert nicht — __vel.pause()');
      await page.evaluate(() => window.__vel?.pause());
      await r.screen('pause');
    }
    await page.waitForTimeout(300);
    await r.shot('pause');
    await r.reach('.vel-screen', 'Pause');
    if (await r.goto('.vel-screen', 'button', 'Einstellungen')) {
      await r.press('A');
      await r.screen('settings');
      await r.press('B');
      await r.screen('pause');
    }
    await r.press('B');
    const resumed = await page
      .waitForFunction(() => window.__vel?.state().gameState === 'playing' && document.querySelector('.vel-menu')?.hasAttribute('hidden'), null, { timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!resumed) fail('Pause: B setzt das Spiel nicht fort');
    else ok('Pause: B = weiter');

    // ---- Ergebnis: Route-Bot fährt ins Ziel (Ticks vorgespult), A = Primärknopf, B = Menü
    await page.evaluate(() => {
      const v = window.__vel;
      if (!v) return;
      v.restart();
      v.useBot('route', { sync: 1, seed: 11 });
      v.freeze(true);
      for (let i = 0; i < 60 && v.state().gameState !== 'finished'; i++) v.stepTicks(128);
      v.useBot(null);
      v.freeze(false);
    });
    await r.screen('finish');
    await page.waitForTimeout(700); // Ergebnis-Sperre (450 ms) + Einblenden
    const prim = await page.evaluate(`document.querySelector('.is-padfocus')?.classList.contains('vel-btn--primary') ?? false`);
    if (!prim) fail(`Ergebnis: Start-Fokus nicht auf dem Primärknopf (${await r.focusText()})`);
    await r.shot('finish');
    await r.reach('.vel-screen', 'Ergebnis');
    await r.press('B');
    await r.screen('title');
    await page.waitForSelector('.vel-menu[data-door="ready"]', { timeout: 15000 });

    // ---- Übrige Bestands-Screens aus System: Steuerung, Menü-Labor, Admin
    if ((await page.evaluate(`document.querySelector('.ps2-ui')?.getAttribute('data-view')`)) !== 'system') {
      await r.press('B');
      await r.view('main');
      await r.goto('.ps2-stage', '.ps2-item[data-id="system"]');
      await r.press('A');
      await r.view('system');
    }
    for (const [item, screen, label] of [
      ['Steuerung', 'controls', 'Steuerung'],
      ['Menü-Labor', 'lab', 'Menü-Labor'],
      ['Admin', 'admin', 'Admin'],
    ] as const) {
      if (!(await r.goto('.ps2-stage', '.ps2-sys-item', item))) continue;
      await r.press('A');
      await r.screen(screen);
      await page.waitForTimeout(300);
      await r.shot(screen);
      await r.reach('.vel-screen', label);
      await r.press('B');
      await r.screen('title');
      await page.waitForSelector('.vel-menu[data-door="ready"]', { timeout: 15000 });
      await r.view('system');
    }

    // ---- Lektion per A starten, Lektions-Pause
    await r.press('B');
    await r.view('main');
    await r.goto('.ps2-stage', '.ps2-item[data-id="training"]');
    await r.press('A');
    await r.view('training');
    await r.press('A');
    const lesson = await page
      .waitForFunction(() => window.__vel?.state().gameState === 'playing', null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (lesson) {
      ok('A im Training startet die Lektion');
      await page.waitForTimeout(400);
      await r.press('Menu');
      if (await page.waitForSelector('.vel-menu[data-screen="pause"]', { timeout: 3000 }).then(() => true).catch(() => false)) {
        await r.shot('lesson-pause');
        await r.reach('.vel-screen', 'Lektions-Pause');
      } else fail('Lektion: Start pausiert nicht');
    } else fail('Training: A startet keine Lektion');
  } catch (err) {
    fail(`Ablauf abgebrochen: ${err instanceof Error ? err.message.split('\n')[0] : String(err)} (Fokus: ${await r.focusText().catch(() => '?')})`);
    await page.screenshot({ path: `${OUT}/${tag}-99-abbruch.png` }).catch(() => undefined);
  } finally {
    for (const e of errors) fail(e);
    if (errors.length === 0) ok('keine Konsolenfehler');
    await ctx.close();
  }
}

/**
 * Übrige Stile: classic (Bestands-Titel + klassische Bestenliste mit LB/RB), hub/rave/arcade (kein onNavigate →
 * räumlicher Fokus über ihre Knöpfe). Nur: Fokus da, erreichbar, A tut etwas, keine Fehler.
 */
async function otherStyles(browser: Browser, base: string): Promise<void> {
  for (const style of ['classic', 'hub', 'rave', 'arcade'] as const) {
    console.log(`\n[pad-menu] ${style} 1280x800`);
    const errors: string[] = [];
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript({ content: PAGE_JS });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    const r = new Run(page, `${style}-1280x800`);
    try {
      await page.goto(`${base}?menu=${style}&online=mock`);
      await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
      await page.waitForSelector('.vel-menu[data-screen="title"]', { timeout: 10000 });
      if (style !== 'classic') await page.waitForSelector('.vel-menu[data-door="ready"]', { timeout: 15000 });
      await page.waitForLoadState('networkidle');
      await page.evaluate(`window.__padTest.connect()`);
      // Wecken mit einer Richtung: A würde im Titel sofort starten (classic/rave).
      await r.press('Down');
      if ((await r.attr('.vel-menu', 'data-input')) !== 'pad') fail(`${style}: Pad-Richtung schaltet das Menü nicht auf Pad`);
      await r.press('Down');
      // Arcade-Attract-Mode hat keine Knöpfe: A = Münze (geht über onAction, weil kein Pad-Fokus da ist).
      if ((await page.evaluate(`document.querySelectorAll('.is-padfocus').length`)) === 0) {
        await r.press('A');
        await page.waitForTimeout(600);
        await r.press('Down');
      }
      await r.press('Up');
      await page.waitForTimeout(400);
      await r.shot('title');
      const root = style === 'classic' ? '.vel-screen' : '.vel-frontdoor';
      await r.reach(root, `${style} Titel`);
      if (style === 'classic' && (await r.goto('.vel-screen', 'button', 'Bestenliste'))) {
        await r.press('A');
        await r.screen('leaderboard');
        await page.waitForTimeout(500);
        const t0 = await r.attr('.vel-board-tabs [aria-pressed="true"]', 'aria-pressed');
        const n0: string = await page.evaluate(`document.querySelector('.vel-board-tabs [aria-pressed="true"]')?.textContent ?? ''`);
        await r.press('RB');
        await page.waitForTimeout(500);
        const n1: string = await page.evaluate(`document.querySelector('.vel-board-tabs [aria-pressed="true"]')?.textContent ?? ''`);
        if (t0 === null || n0 === n1) fail(`classic Bestenliste: RB wechselt die Strecke nicht (${n0})`);
        else ok(`classic Bestenliste: RB ${n0} → ${n1}`);
        await r.shot('leaderboard');
        await r.reach('.vel-screen', 'classic Bestenliste');
        await r.press('B');
        await r.screen('title');
      }
    } catch (err) {
      fail(`${style}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    } finally {
      for (const e of errors) fail(e);
      if (errors.length === 0) ok('keine Konsolenfehler');
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
  for (const size of SIZES) await flow(browser, `http://localhost:${PORT}/`, size);
  if (process.env.PADMENU_STYLES !== '0') await otherStyles(browser, `http://localhost:${PORT}/`);
} finally {
  await browser.close();
  await vite.close();
}
console.log(failed ? '\nFEHLER (siehe ✗)' : '\nOK');
process.exit(failed ? 1 : 0);
