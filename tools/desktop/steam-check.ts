/**
 * Steam-Check der Desktop-Hülle (Plan 011 Phase 4) — NUR mit Fake-steamworks, nie gegen den echten Client:
 * jeder Start mit `--steam` bekommt `--steam-fake` (sonst bricht das Werkzeug ab), VELOCITY_STEAM wird aus der
 * Umgebung genommen. So entsteht auf dem Steam-Konto des Spielers weder "Spielt Spacewar" noch ein Achievement.
 *
 *  A  ohne --steam: kein Bridge-Feld, kein Steam-Log, kein Fake im Hauptprozess.
 *  B  --steam --steam-fake=fail (wie "Steam läuft nicht"): genau ein Log-Eintrag, ready() inaktiv, Spiel startet,
 *     Overlay-Schalter nur wegen des Flags, keine Presence.
 *  C  --steam --steam-fake: init(480) nach dem ersten Bild, Rich Presence Menü → L2 SCHLEIFE → Gegen Ghost →
 *     Training T3 → Menü (nur Geändertes), Overlay → Pause, unter Playwright (CDP = Debug-Zugang) + --dev sind
 *     Achievements komplett aus (Bridge-Aufruf abgelehnt, kein activate, kein velocity.achv.v1), 0 Fehler/CSP.
 *  D  release/win-unpacked/VELOCITY.exe --steam --steam-fake --dev (falls gebaut): --dev ist im Paket wirkungslos →
 *     gesperrt, das echte Modul wird NICHT geladen, kein Bridge-Feld, kein __vel.
 *
 *   npm run build && npx tsx tools/desktop/steam-check.ts [--no-exe]   → shots/desktop/steam/report.json, Exit 1 bei Fehler
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright';
import type { DesktopBridge, DesktopSteamStatus } from '../../src/platform/bridgeTypes';

const ROOT = process.cwd();
const OUT = 'shots/desktop/steam';
mkdirSync(OUT, { recursive: true });

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const checks: Check[] = [];
const info: Record<string, unknown> = {};
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}: ${detail}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- Sicherheit: nie das echte steamworks.js mit laufendem Client
function steamRunning(): boolean {
  try {
    return /steam\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}
info.steamClientRunning = steamRunning();
console.log(`Steam-Client läuft: ${info.steamClientRunning ? 'ja' : 'nein'} — dieses Werkzeug startet ohnehin nur mit Fake.`);
function guard(args: readonly string[]): void {
  if (args.includes('--steam') && !args.some((a) => a === '--steam-fake' || a.startsWith('--steam-fake='))) {
    throw new Error('steam-check: --steam nur zusammen mit --steam-fake (nie gegen den echten Client)');
  }
}
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'VELOCITY_STEAM') env[k] = v;

// ---- Vorbedingungen
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/ fehlt → erst `npm run build`.');
  process.exit(1);
}
const req = createRequire(import.meta.url);
let electronPath: string;
try {
  electronPath = req('electron') as string;
} catch (e) {
  console.error(`Electron-Binary fehlt (${e instanceof Error ? e.message : String(e)}) — fallen.md #285.`);
  process.exit(1);
}
execFileSync(process.execPath, [req.resolve('typescript/bin/tsc'), '-p', 'electron'], { cwd: ROOT, stdio: 'inherit' });
execFileSync(process.execPath, ['tools/desktop/config.mjs'], { cwd: ROOT, stdio: 'inherit' });

type BridgeWin = Window & { velocityDesktop?: DesktopBridge; __cspViolations?: string[] };
interface FakeCall {
  readonly fn: string;
  readonly args: readonly unknown[];
}
type FakeGlobal = { __velSteamFake?: { calls: FakeCall[]; overlay(active: boolean): void } };

const CSP_INIT = `window.__cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));`;

interface Session {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly logs: string[];
  readonly errors: string[];
}

async function launch(args: string[]): Promise<Session> {
  guard(args);
  const userData = mkdtempSync(join(tmpdir(), 'velocity-steam-'));
  const app = await _electron.launch({ executablePath: electronPath, args: ['.', ...args, `--user-data=${userData}`], cwd: ROOT, env });
  const logs: string[] = [];
  const grab = (b: Buffer | string): void => {
    for (const l of String(b).split(/\r?\n/)) if (l.includes('[velocity]')) logs.push(l.trim());
  };
  app.process().stdout?.on('data', grab);
  app.process().stderr?.on('data', grab);
  await app.context().addInitScript(CSP_INIT);
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
  return { app, page, logs, errors };
}

const fakeCalls = (app: ElectronApplication): Promise<FakeCall[] | null> =>
  app.evaluate(() => (globalThis as FakeGlobal).__velSteamFake?.calls.map((c) => ({ fn: c.fn, args: [...c.args] })) ?? null);

/** Rich-Presence-Aufrufe ab Index `from`, bis `want` (status-Wert) auftaucht oder die Zeit um ist. */
async function waitPresence(app: ElectronApplication, from: number, want: string, ms = 4000): Promise<FakeCall[]> {
  const t0 = Date.now();
  let got: FakeCall[] = [];
  while (Date.now() - t0 < ms) {
    got = ((await fakeCalls(app)) ?? []).filter((c) => c.fn === 'localplayer.setRichPresence').slice(from);
    if (got.some((c) => c.args[0] === 'status' && c.args[1] === want)) return got;
    await sleep(150);
  }
  return got;
}

const presenceCount = async (app: ElectronApplication): Promise<number> => ((await fakeCalls(app)) ?? []).filter((c) => c.fn === 'localplayer.setRichPresence').length;

async function startLevel(page: Page, id: string): Promise<void> {
  await page.evaluate((lid) => window.__vel?.start(lid, { lockless: true }), id);
  await page.waitForFunction(() => window.__vel?.state().gameState === 'playing', null, { timeout: 20000 });
}

// =====================================================================================================
// A — ohne --steam
// =====================================================================================================
{
  const s = await launch(['--dev', '--query=online=mock', '--window-mode=windowed']);
  try {
    // Was Playwright selbst ans argv hängt (Debug-Zugang → Achievements aus, auch ohne --dev).
    info.mainArgv = await s.app.evaluate(() => [...process.argv.slice(1), ...process.execArgv]);
    await sleep(1500);
    const steamField = await s.page.evaluate(() => 'steam' in ((window as BridgeWin).velocityDesktop ?? {}));
    const fake = await s.app.evaluate(() => (globalThis as FakeGlobal).__velSteamFake !== undefined);
    const chunk = await s.page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/assets\/steam-[^/]*\.js/.test(e.name)));
    check('A ohne --steam: kein Bridge-Feld, kein Fake, kein Steam-Chunk', !steamField && !fake && !chunk, `steam im Bridge ${steamField}, Fake ${fake}, Chunk geladen ${chunk}`);
    check('A ohne --steam: kein Steam-Log', !s.logs.some((l) => /Steam/.test(l)), s.logs.join(' | ') || '—');
    check('A: 0 Konsolenfehler', s.errors.length === 0, s.errors.slice(0, 3).join(' | ') || '0');
  } finally {
    await s.app.close().catch(() => {});
  }
}

// =====================================================================================================
// B — --steam, aber "Steam läuft nicht" (Fake wirft in init)
// =====================================================================================================
{
  const s = await launch(['--dev', '--steam', '--steam-fake=fail', '--query=online=mock', '--window-mode=windowed']);
  try {
    const st = await s.page.evaluate(() => (window as BridgeWin).velocityDesktop?.steam?.ready() ?? null);
    await sleep(1500);
    const calls = (await fakeCalls(s.app)) ?? [];
    const steamLogs = s.logs.filter((l) => /Steam/.test(l));
    info.bLogs = steamLogs;
    check('B Steam fehlt: ready() inaktiv', st !== null && st.active === false && st.appId === null, JSON.stringify(st));
    check('B Steam fehlt: genau EIN Log-Eintrag', steamLogs.length === 1 && /Steam nicht verfügbar \(init/.test(steamLogs[0] ?? ''), steamLogs.join(' | ') || '—');
    check(
      'B Steam fehlt: Overlay-Schalter nur wegen des Flags, init(480) einmal, keine Presence',
      calls.filter((c) => c.fn === 'electronEnableSteamOverlay').length === 1 &&
        JSON.stringify(calls.filter((c) => c.fn === 'init').map((c) => c.args)) === '[[480]]' &&
        !calls.some((c) => c.fn === 'localplayer.setRichPresence'),
      calls.map((c) => c.fn).join(', '),
    );
    await startLevel(s.page, 'level1');
    check('B Steam fehlt: Spiel läuft normal', (await s.page.evaluate(() => window.__vel?.state().gameState)) === 'playing', 'L1 playing');
    check('B: 0 Konsolenfehler', s.errors.length === 0, s.errors.slice(0, 3).join(' | ') || '0');
  } finally {
    await s.app.close().catch(() => {});
  }
}

// =====================================================================================================
// C — --steam mit Fake: Presence, Overlay → Pause, Achievements unter CDP aus
// =====================================================================================================
{
  const s = await launch(['--dev', '--steam', '--steam-fake', '--query=online=mock', '--window-mode=windowed']);
  try {
    const st = await s.page.evaluate(() => (window as BridgeWin).velocityDesktop?.steam?.ready() ?? null);
    check(
      'C init(480) aktiv, Achievements aus (--dev + CDP)',
      st !== null && st.active && st.appId === 480 && st.achievements === false,
      JSON.stringify(st satisfies DesktopSteamStatus | null),
    );
    await sleep(300);
    const steamLogs = s.logs.filter((l) => /Steam/.test(l));
    info.cLogs = steamLogs;
    check('C Log: Steam aktiv, Achievements aus, Overlay-Ereignis (Fake) ja', steamLogs.length === 1 && /Steam aktiv: App 480, Achievements aus.*Overlay-Ereignis ja/.test(steamLogs[0] ?? ''), steamLogs.join(' | '));
    const menu = await waitPresence(s.app, 0, 'Menü');
    check('C Presence im Titel: Menü (status/mode/level)', JSON.stringify(menu.map((c) => c.args)) === JSON.stringify([['status', 'Menü'], ['mode', 'menu'], ['level', null]]), JSON.stringify(menu.map((c) => c.args)));

    const n0 = await presenceCount(s.app);
    await startLevel(s.page, 'level2');
    const l2 = await waitPresence(s.app, n0, 'L2 SCHLEIFE');
    check('C Presence im Level: L2 SCHLEIFE', l2.some((c) => c.args[0] === 'status' && c.args[1] === 'L2 SCHLEIFE'), JSON.stringify(l2.map((c) => c.args)));
    // Pause ändert nichts an der Presence (nur Geändertes wird gesendet).
    const before = await presenceCount(s.app);
    await s.page.evaluate(() => window.__vel?.pause());
    await sleep(1600);
    check('C Pause sendet keine neue Presence', (await presenceCount(s.app)) === before, `${before} → ${await presenceCount(s.app)}`);

    // Overlay → Pause (Fake meldet GameOverlayActivated wie ein Binding, das es kennt; 0.4.0 tut es nicht).
    await startLevel(s.page, 'level2');
    await s.app.evaluate(() => (globalThis as FakeGlobal).__velSteamFake?.overlay(true));
    await s.page.waitForFunction(() => window.__vel?.state().gameState === 'paused', null, { timeout: 3000 }).catch(() => {});
    const paused = await s.page.evaluate(() => ({ st: window.__vel?.state().gameState ?? null, menu: window.__vel?.state().menu ?? null }));
    check('C Overlay auf → Pause-Menü', paused.st === 'paused' && paused.menu === 'pause', JSON.stringify(paused));
    await s.app.evaluate(() => (globalThis as FakeGlobal).__velSteamFake?.overlay(false));
    await sleep(300);
    check('C Overlay zu → bleibt pausiert (kein Auto-Weiter)', (await s.page.evaluate(() => window.__vel?.state().gameState)) === 'paused', 'paused');

    // Gegen Ghost: der Mock baut seine Rivalen erst beim Abruf der Bestenliste — ohne sie verwirft Game den Race
    // (Ghost "nicht gefunden"). Also erst die Tafel, dann einen echten Rivalen-Lauf. Danach Lektion, dann Titel.
    const rival = await s.page.evaluate(async () => (await window.__vel?.leaderboard('level1'))?.top.entries.find((e) => e.runId.startsWith('rival-'))?.runId ?? null);
    const g0 = await presenceCount(s.app);
    if (rival) await s.page.evaluate((id) => window.__vel?.raceGhost('level1', id, 'Rivale'), rival);
    const ghost = await waitPresence(s.app, g0, 'Gegen Ghost · L1 GRUNDKURS', 6000);
    check('C Presence gegen Ghost', rival !== null && ghost.some((c) => c.args[1] === 'Gegen Ghost · L1 GRUNDKURS'), `${rival} → ${JSON.stringify(ghost.map((c) => c.args))}`);
    const t0 = await presenceCount(s.app);
    await startLevel(s.page, 't3');
    const tr = await waitPresence(s.app, t0, 'Training T3');
    check('C Presence in der Lektion: Training T3', tr.some((c) => c.args[1] === 'Training T3'), JSON.stringify(tr.map((c) => c.args)));
    const m0 = await presenceCount(s.app);
    await s.page.evaluate(() => window.__vel?.toTitle());
    const back = await waitPresence(s.app, m0, 'Menü');
    check('C zurück im Titel: Menü', back.some((c) => c.args[1] === 'Menü'), JSON.stringify(back.map((c) => c.args)));

    // Achievements komplett aus unter CDP/--dev: Bridge-Aufruf abgelehnt, kein activate, kein Buch nach einem Ziel.
    const direct = await s.page.evaluate(() => (window as BridgeWin).velocityDesktop?.steam?.achievement('ACH_WIN_ONE_GAME') ?? null);
    await startLevel(s.page, 'level1');
    await s.page.evaluate(() => {
      window.__vel?.useBot('route', { aimNoiseDeg: 1, seed: 5, restart: true });
      window.__vel?.freeze(true);
    });
    for (let k = 0; k < 400; k++) {
      const g = await s.page.evaluate(() => window.__vel?.stepTicks(256) ?? null);
      if (!g || g.gameState === 'finished') break;
    }
    await s.page.evaluate(() => window.__vel?.freeze(false));
    const fin = await s.page.evaluate(() => window.__vel?.state().gameState ?? null);
    const calls = (await fakeCalls(s.app)) ?? [];
    const book = await s.page.evaluate(() => localStorage.getItem('velocity.achv.v1'));
    check(
      'C Achievements unter CDP/--dev aus: Aufruf abgelehnt, kein activate, kein velocity.achv.v1',
      direct === false && !calls.some((c) => c.fn === 'achievement.activate') && book === null && fin === 'finished',
      `Bridge → ${direct}, activate ${calls.filter((c) => c.fn === 'achievement.activate').length}, Buch ${book === null ? 'leer' : book}, Lauf ${fin}`,
    );
    const bad = await s.page.evaluate(() => (window as BridgeWin).velocityDesktop?.steam?.presence('Status!', 'x') ?? null);
    check('C Presence-Schlüssel geprüft', bad === false, String(bad));
    await s.page.screenshot({ path: `${OUT}/c-title.png` });
    const csp = await s.page.evaluate(() => (window as BridgeWin).__cspViolations ?? []);
    check('C: 0 CSP-Verstöße, 0 Konsolenfehler', csp.length === 0 && s.errors.length === 0, [...csp, ...s.errors].slice(0, 3).join(' | ') || '0');
    info.cFakeCalls = calls.length;
  } finally {
    await s.app.close().catch(() => {});
  }
}

// =====================================================================================================
// D — gebaute exe: Fake ist gesperrt, auch mit --dev (im Paket wirkungslos, Review C1) — das echte Modul wird nicht
//     ersatzweise geladen. Kein __vel im Paket: Bereitschaft über die Menü-Tür.
// =====================================================================================================
const exe = resolve(ROOT, 'release', 'win-unpacked', 'VELOCITY.exe');
if (process.argv.includes('--no-exe')) console.log('- exe übersprungen (--no-exe)');
else if (!existsSync(exe)) console.log(`- exe fehlt (${exe}) → npm run desktop:build; übersprungen`);
else {
  const args = ['--steam', '--steam-fake', '--dev', '--remote-debugging-port=9352'];
  guard(args);
  const dataD = mkdtempSync(join(tmpdir(), 'velocity-steam-exe-'));
  const proc = spawn(exe, [...args, `--user-data=${dataD}`], { stdio: ['ignore', 'pipe', 'pipe'], env });
  const logs: string[] = [];
  const grab = (b: Buffer): void => {
    for (const l of String(b).split(/\r?\n/)) if (l.includes('[velocity]')) logs.push(l.trim());
  };
  proc.stdout?.on('data', grab);
  proc.stderr?.on('data', grab);
  const exited = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
  try {
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
    for (let k = 0; k < 40 && !browser; k++) {
      await sleep(250);
      browser = await chromium.connectOverCDP('http://127.0.0.1:9352').catch(() => null);
    }
    let page: Page | undefined;
    for (let k = 0; browser && k < 40 && !page; k++) {
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://'));
      if (!page) await sleep(250);
    }
    if (!page) check('D exe: Spielseite', false, 'keine app://-Seite');
    else {
      await page.waitForFunction(() => document.querySelector('.vel-menu[data-door="ready"]') !== null, null, { timeout: 30000 });
      const vel = await page.evaluate(() => typeof window.__vel);
      const steamField = await page.evaluate(() => 'steam' in ((window as BridgeWin).velocityDesktop ?? {}));
      check('D exe --steam --steam-fake --dev: gesperrt, kein Bridge-Feld, kein __vel', !steamField && vel === 'undefined', `steam im Bridge ${steamField}, typeof __vel ${vel}`);
      check('D exe: Log "nur mit --dev", kein "Steam aktiv"', logs.some((l) => /--steam-fake gilt nur mit --dev/.test(l)) && !logs.some((l) => /Steam aktiv/.test(l)), logs.join(' | ') || '(kein Log gelesen)');
      await page.evaluate(() => (window as BridgeWin).velocityDesktop?.quit()).catch(() => {});
    }
    await browser?.close().catch(() => {});
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)]);
    check('D exe: Beenden → Exit 0', code === 0, `Code ${code}`);
  } finally {
    if (proc.exitCode === null) proc.kill();
    // Gerade beendete Kindprozesse halten Cache-Dateien kurz offen (EPERM/EBUSY) — nur Temp, notfalls liegen lassen.
    try {
      rmSync(dataD, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.log(`  - ${dataD} nicht gelöscht (${e instanceof Error ? e.message.slice(0, 60) : String(e)})`);
    }
  }
}

writeFileSync(`${OUT}/report.json`, JSON.stringify({ checks, info }, null, 2));
const bad = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - bad.length}/${checks.length} grün${bad.length ? ` — rot: ${bad.map((c) => c.name).join('; ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
