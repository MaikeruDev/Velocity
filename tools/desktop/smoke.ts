/**
 * Desktop-Smoke (Plan 011 Schritte 2.1, 2.3 Hauptprozess, 2.4 Kürzel/Schließen Hauptprozess, 2.6, 2.7 Bridge;
 * Review-Befunde C1–C7). Startet die ECHTE Electron-Hülle mit der gebauten dist/ über app://velocity (kein Dev-Server).
 * Alles, was das Debug-Handle window.__vel braucht, läuft gegen das UNVERPACKTE Dev-Binary (`electron . --dev`); am
 * Paket gibt es kein __vel (Review C1) — dort nur Prüfungen über DOM, Bridge und OS.
 *
 *  A  --dev (unverpackt), ?online=mock, Fenster: Origin, kein require/process, Bridge, CSP, Levelliste, Pfad-Ausbruch,
 *     Navigation/window.open gesperrt, Strg+W/Strg+R/F5/Strg+Shift+I/Alt (sendInputEvent), Determinismus L1–L4
 *     (Electron → Node und Node → Electron, bitgleich) + detMath-Hash, Alt+Enter/F11 (C7), Anzeigemodus, Bildschirm
 *     wach nur im Vordergrund + Drosselung minimiert (C2/C3), Speicher-Spiegel, Fenster-X trotz beforeunload → Exit 0.
 *     S2b: Plattform im Menü, Strg duckt im Fenster, Pointer Lock roh, Esc im Lock (echte OS-Taste, nur nach
 *     PID-Prüfung des Vordergrundfensters) → genau eine Pause, Modus springt beim Levelstart nicht um.
 *  B  unverpackt OHNE --dev, gleiches userData, Local Storage GELÖSCHT: Spiegel eingespielt, Modus übernommen,
 *     DevTools gesperrt, kein __vel, kein Admin/F8, echtes Supabase unter der CSP, Beenden per Fake-Pad
 *     (navigator.getGamepads ersetzt — __vel.pad gibt es ohne Dev-Modus nicht) über das ps2-System-Panel → Exit 0.
 *  D  --dev ohne Playwright (rohes CDP; Playwright hält Seiten selbst sichtbar): echtes Minimieren (ShowWindow am
 *     eigenen Fenster per PID) → visibilityState 'hidden', visibilitychange, Pause, rAF ≈ 0; Wiederherstellen → normal (C2).
 *  E  Fehler-Injektion (--dev --fault=…, nur unverpackt): Startfehler/Dauerabsturz/Ladefehler → Dialog + Exit 1;
 *     einmaliger Absturz/Ladefehler/Hänger → neu geladen, spielbar; setup wirft → Fenster kommt trotzdem;
 *     ready-to-show kommt nie → Fenster nach Zeitlimit sichtbar (C4/C6).
 *  C  release/win-unpacked/VELOCITY.exe (falls gebaut, `npm run desktop:build`), per CDP (Fuses sperren --inspect):
 *     --dev/--query/--fault im Paket wirkungslos, kein __vel, kein Admin/F8, CSP, Kürzel (OS-Tasten, PID-geprüft),
 *     Alt+Enter, Speicher, Beenden per Fake-Pad → Exit 0; Fuses (--inspect, ELECTRON_RUN_AS_NODE) gesperrt.
 *
 *   npm run build && npx tsx tools/desktop/smoke.ts [--no-exe] [--no-faults]   → shots/desktop/report.json, Exit 1 bei Fehler
 *
 * Achtung: öffnet echte Fenster (B startet im Vollbild, weil A den Modus so gespeichert hat). Echte OS-Tasten gehen
 * nur an ein Fenster, dessen Prozess-ID geprüft vorn ist (fallen.md #287). Steam wird nie angefordert (kein --steam).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { _electron, chromium, type ElectronApplication, type Page } from 'playwright';
import { base64ToBytes, bytesToBase64, packReplay, unpackReplay } from '../../src/engine/replay/codec';
import { recordBotRun } from '../../src/engine/replay/botRun';
import { verifyReplay } from '../../src/engine/replay/verify';
import type { DesktopBridge } from '../../src/platform/bridgeTypes';
import { loadLevelById } from '../replay/levels';
import { detHash, mathHash } from './detProbe';

const ROOT = process.cwd();
const OUT = 'shots/desktop';
const DET_N = 200000;
const LEVELS = ['level1', 'level2', 'level3', 'level4'] as const;
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
  console.error(`Electron-Binary fehlt (${e instanceof Error ? e.message : String(e)}). Siehe fallen.md: Node < 22.12 → ` +
    'cd node_modules/electron && node --experimental-require-module install.js');
  process.exit(1);
}
execFileSync(process.execPath, [req.resolve('typescript/bin/tsc'), '-p', 'electron'], { cwd: ROOT, stdio: 'inherit' });
execFileSync(process.execPath, ['tools/desktop/config.mjs'], { cwd: ROOT, stdio: 'inherit' });

// detMath-Probe als IIFE für den Renderer (page.evaluate per CDP umgeht die CSP; das ist hier gewollt, Messung).
const probeJs = (
  await build({ entryPoints: ['tools/desktop/detProbe.ts'], bundle: true, format: 'iife', globalName: '__velDet', write: false, platform: 'neutral', target: 'es2022' })
).outputFiles[0].text;

const userData = mkdtempSync(join(tmpdir(), 'velocity-smoke-'));

/** detMath-Probe im Renderer (esbuild-IIFE aus detProbe.ts). */
interface DetProbe {
  detHash(n: number): string;
  mathHash(n: number): string;
}
type BridgeWin = Window & { velocityDesktop?: DesktopBridge; __velMarker?: number; __cspViolations?: string[]; __velDet?: DetProbe; __velKeys?: number };

/** Fehler- und CSP-Zähler je Seite. */
function watch(page: Page, tag: string): { errors: string[]; csp: string[] } {
  const w = { errors: [] as string[], csp: [] as string[] };
  page.on('pageerror', (e) => w.errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) w.csp.push(t);
    else w.errors.push(`${tag} console: ${t}`);
  });
  return w;
}

const CSP_INIT = `window.__cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI));`;

async function launchDev(args: string[]): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ executablePath: electronPath, args: ['.', ...args, `--user-data=${userData}`], cwd: ROOT });
  await app.context().addInitScript(CSP_INIT);
  const page = await app.firstWindow();
  return { app, page };
}

async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__vel?.ready === true, null, { timeout: 30000 });
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function cspCount(page: Page, w: { csp: string[] }): Promise<string[]> {
  const inPage = await page.evaluate(() => (window as BridgeWin).__cspViolations ?? null);
  // Konsole und Ereignis melden dieselben Verstöße doppelt — das Maximum zählt, Texte aus beiden Quellen.
  const ev = inPage ?? [];
  return ev.length > w.csp.length ? ev : w.csp;
}

/** Echte Tastendrücke über den Hauptprozess (CDP-Tasten lösen keine Kürzel aus, fallen.md #58). */
async function sendKey(app: ElectronApplication, keyCode: string, modifiers: string[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, k) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return;
    w.focus();
    const mods = k.modifiers as ('control' | 'shift' | 'alt')[];
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k.keyCode, modifiers: mods });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k.keyCode, modifiers: mods });
  }, { keyCode, modifiers });
}

/**
 * Echter Windows-Tastendruck ins VELOCITY-Fenster (WScript.Shell.SendKeys). Rückgabe: Fenster ließ sich aktivieren.
 * Nur so laufen Menü-Beschleuniger wie Strg+W durch den nativen Weg (sendInputEvent umgeht ihn teilweise).
 */
function osKey(pid: number, keys: string): string {
  // Über die PID aktivieren und vor dem Senden prüfen, dass wirklich UNSER Fenster vorn ist: AppActivate per Titel
  // traf nach dem Schließen ein anderes Fenster mit "Velocity" im Titel (Editor/Terminal) — Tasten gingen dorthin.
  const ps = [
    `Add-Type -Namespace VelSmoke -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'`,
    '$w = New-Object -ComObject WScript.Shell',
    `[void]$w.AppActivate(${pid})`,
    'Start-Sleep -Milliseconds 250',
    '$p = 0; [void][VelSmoke.U]::GetWindowThreadProcessId([VelSmoke.U]::GetForegroundWindow(), [ref]$p)',
    `if ($p -ne ${pid}) { "fg $p"; exit }`,
    `$w.SendKeys('${keys}'); 'ok'`,
  ].join('; ');
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    return `fehler ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`;
  }
}

/** Nur nach vorn holen (keine Tasten) und prüfen, dass das Vordergrundfenster zu `pid` gehört: 'ok' oder Grund. */
function osActivate(pid: number): string {
  const ps = [
    `Add-Type -Namespace VelSmoke -Name A -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'`,
    '$w = New-Object -ComObject WScript.Shell',
    `[void]$w.AppActivate(${pid})`,
    'Start-Sleep -Milliseconds 300',
    '$p = 0; [void][VelSmoke.A]::GetWindowThreadProcessId([VelSmoke.A]::GetForegroundWindow(), [ref]$p)',
    `if ($p -ne ${pid}) { "fg $p" } else { 'ok' }`,
  ].join('; ');
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    return `fehler ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`;
  }
}

/**
 * Hauptfenster des EIGENEN Testprozesses (per PID, nie per Titel) minimieren (6) / wiederherstellen (9) bzw. nur
 * abfragen (null). Rückgabe: Fenster-Handle ≠ 0 = ein sichtbares Hauptfenster existiert.
 */
function osWindow(pid: number, cmd: 6 | 9 | null): string {
  const ps = [
    `Add-Type -Namespace VelSmoke -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'`,
    `$h = (Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle`,
    cmd === null ? '"$h"' : `if ($h -eq 0) { '0' } else { [void][VelSmoke.W]::ShowWindow($h, ${cmd}); "$h" }`,
  ].join('; ');
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    return `fehler ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`;
  }
}

/** Rohes CDP (ohne Playwright, das Sichtbarkeit/Fokus emuliert): Runtime.evaluate auf der app://-Seite. */
interface RawCdp {
  ev<T>(expr: string): Promise<T | undefined>;
  close(): void;
}
interface CdpTarget {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}
interface CdpReply {
  readonly id?: number;
  readonly result?: { readonly result?: { readonly value?: unknown } };
}

async function cdpTargets(port: number): Promise<CdpTarget[]> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list: unknown = await r.json();
    return Array.isArray(list) ? list.filter((t): t is CdpTarget => typeof t === 'object' && t !== null && 'url' in t && 'type' in t) : [];
  } catch {
    return [];
  }
}

async function rawCdp(port: number, ms: number): Promise<RawCdp | null> {
  const until = Date.now() + ms;
  let url: string | undefined;
  while (!url && Date.now() < until) {
    url = (await cdpTargets(port)).find((t) => t.type === 'page' && t.url.startsWith('app://'))?.webSocketDebuggerUrl;
    if (!url) await sleep(250);
  }
  if (!url) return null;
  const sock = new WebSocket(url);
  const ok = await new Promise<boolean>((r) => {
    sock.addEventListener('open', () => r(true));
    sock.addEventListener('error', () => r(false));
  });
  if (!ok) return null;
  let next = 0;
  const waiting = new Map<number, (v: unknown) => void>();
  sock.addEventListener('message', (m) => {
    const d = JSON.parse(String(m.data)) as CdpReply;
    if (d.id === undefined) return;
    waiting.get(d.id)?.(d.result?.result?.value);
    waiting.delete(d.id);
  });
  // Geschlossen (Prozess weg): Wartende bekommen undefined statt ewig zu hängen.
  sock.addEventListener('close', () => {
    for (const fn of waiting.values()) fn(undefined);
    waiting.clear();
  });
  return {
    ev: <T>(expression: string) =>
      new Promise<T | undefined>((r) => {
        const id = ++next;
        waiting.set(id, (v) => r(v as T | undefined));
        sock.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        setTimeout(() => {
          if (waiting.delete(id)) r(undefined);
        }, 15000);
      }),
    close: () => sock.close(),
  };
}

/** Auf einen Wert warten (rohes CDP), z. B. `window.__vel?.ready === true`. */
async function cdpUntil(cdp: RawCdp, expr: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await cdp.ev<boolean>(expr)) === true) return true;
    await sleep(250);
  }
  return false;
}

/** Ende eines selbst gestarteten Prozesses (null = lief nach `ms` noch). */
function procExit(proc: ChildProcess, ms: number): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return Promise.race([new Promise<number | null>((r) => proc.once('exit', (c) => r(c))), sleep(ms).then(() => null)]);
}

/** Prozessbaum beenden (Renderer/GPU hielten sonst Dateien im userData offen → rmSync EBUSY). */
function killTree(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.pid === undefined) return;
  try {
    execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
  } catch {
    proc.kill();
  }
}

/** Temp-Verzeichnis löschen; was ein gerade beendeter Prozess noch hält, bleibt notfalls liegen (nur Temp). */
function rmQuiet(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.log(`  - ${dir} nicht gelöscht (${e instanceof Error ? e.message.slice(0, 60) : String(e)})`);
  }
}

/** Unverpackte Hülle ohne Playwright (eigene PID = Fenster-Besitzer). */
function spawnDev(args: string[]): ChildProcess {
  return spawn(electronPath, ['.', ...args], { cwd: ROOT, stdio: 'ignore' });
}

// ---- Fake-Pad ohne __vel: navigator.getGamepads ersetzen (Input fragt es jeden Frame bzw. sekündlich ab).
const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
/** Index im "standard"-Mapping (src/engine/pad/types.ts PAD_BUTTONS). */
const PAD_INDEX = { PadA: 0, PadB: 1, PadUp: 12, PadDown: 13, PadLeft: 14, PadRight: 15 } as const;
type PadKey = keyof typeof PAD_INDEX;
// Als Text: tsx (keepNames) setzte in evaluate-Funktionen __name(...) ein, das es im Renderer nicht gibt.
const PAD_INSTALL = `(() => {
  const b = [];
  for (let i = 0; i < 17; i++) b.push({ pressed: false, touched: false, value: 0 });
  window.__smokePad = { id: ${JSON.stringify(XBOX)}, index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: b };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__smokePad] });
  window.dispatchEvent(new Event('gamepadconnected'));
  return true;
})()`;
const padSet = (k: PadKey, on: boolean): string =>
  `(() => { const p = window.__smokePad; if (!p) return false; p.buttons[${PAD_INDEX[k]}] = { pressed: ${on}, touched: ${on}, value: ${on ? 1 : 0} }; p.timestamp++; return true; })()`;

interface SystemPanelResult {
  readonly sys: boolean;
  readonly items: string[];
  readonly afterF8: string | null;
  readonly armed: string | null;
  readonly nav: string[];
}

/**
 * Ohne __vel (Paket bzw. ohne --dev): Fake-Pad einstecken, Boot überspringen, im ps2-Hauptmenü bis "System",
 * F8 (darf nichts tun), "Beenden" wählen und scharf schalten. Den letzten Druck (= Beenden) macht der Aufrufer.
 */
async function padToQuitArmed(page: Page, tag: string): Promise<{ res: SystemPanelResult; tapA: () => Promise<void> }> {
  const tap = async (k: PadKey): Promise<void> => {
    await page.evaluate(padSet(k, true));
    await sleep(80);
    await page.evaluate(padSet(k, false));
    await sleep(120);
  };
  await page.evaluate(PAD_INSTALL);
  await sleep(1300); // Input probt ohne connected-Event höchstens sekündlich
  await tap('PadDown'); // weckt das Pad (der Druck, der ein Pad übernimmt, zählt erst nach dem Loslassen)
  // Boot per A überspringen, bis die Bühne lebt (is-live, kein .ps2-boot mehr); danach kurze Sperre abwarten.
  const live = (): Promise<boolean> => page.evaluate(() => document.querySelector('.ps2-ui.is-live') !== null && document.querySelector('.ps2-boot') === null);
  for (let i = 0; i < 6 && !(await live()); i++) await tap('PadA');
  await sleep(500);
  // System = letzter Hauptmenü-Eintrag. Der Pad-Fokus ist räumlich (kein Umlauf): rechts, und wo es nicht weitergeht,
  // runter — bis System gewählt ist.
  const nav: string[] = [];
  const selMain = (): Promise<string> => page.evaluate(() => document.querySelector('.ps2-item.is-selected')?.getAttribute('data-id') ?? '-');
  for (let i = 0; i < 12; i++) {
    const sel = await selMain();
    nav.push(sel);
    if (sel === 'system') break;
    await tap('PadRight');
    if ((await selMain()) === sel) await tap('PadDown');
  }
  await tap('PadA');
  const sys = await page.waitForSelector('.ps2-ui[data-view="system"]', { timeout: 5000 }).then(() => true, () => false);
  const items = await page.evaluate(() => Array.from(document.querySelectorAll('.ps2-sys-item .ps2-sys-label')).map((e) => e.textContent ?? ''));
  await page.keyboard.press('F8');
  await sleep(300);
  const afterF8 = await page.evaluate(() => document.querySelector('.vel-menu')?.getAttribute('data-screen') ?? null);
  // Beenden = letzter Eintrag: runter, bis er gewählt ist; A fragt nach, A beendet.
  for (let i = 0; i < 10; i++) {
    if ((await page.evaluate(() => document.querySelector('.ps2-sys-item.is-selected .ps2-sys-label')?.textContent ?? null)) === 'Beenden') break;
    await tap('PadDown');
  }
  await page.screenshot({ path: `${OUT}/${tag}-system.png` });
  await tap('PadA');
  const armed = await page.evaluate(() => document.querySelector('.ps2-sys-item.is-armed .ps2-sys-label')?.textContent ?? null);
  return { res: { sys, items, afterF8, armed, nav }, tapA: () => tap('PadA') };
}

/** Bereit ohne __vel: Menü-Tür offen (Titel steht). */
async function waitDoor(page: Page): Promise<boolean> {
  const ok = await page.waitForFunction(() => document.querySelector('.vel-menu[data-door="ready"]') !== null, null, { timeout: 30000 }).then(() => true, () => false);
  await page.waitForLoadState('networkidle').catch(() => {});
  return ok;
}

async function waitExit(app: ElectronApplication, ms: number): Promise<{ code: number | null; ms: number }> {
  const proc = app.process();
  const t0 = Date.now();
  if (proc.exitCode !== null) return { code: proc.exitCode, ms: 0 };
  const code = await Promise.race([new Promise<number | null>((r) => proc.once('exit', (c) => r(c))), sleep(ms).then(() => undefined)]);
  return code === undefined ? { code: null, ms: Date.now() - t0 } : { code, ms: Date.now() - t0 };
}

async function botToFinish(page: Page, seed: number, noise: number): Promise<number | null> {
  await page.evaluate(({ seed, noise }) => {
    const v = window.__vel;
    if (!v) throw new Error('kein __vel');
    v.useBot('route', { aimNoiseDeg: noise, seed, restart: true });
    v.freeze(true);
  }, { seed, noise });
  for (let k = 0; k < 400; k++) {
    const st = await page.evaluate(() => window.__vel?.stepTicks(256) ?? null);
    if (!st || st.gameState === 'finished') break;
  }
  await page.evaluate(() => window.__vel?.freeze(false));
  await page.waitForFunction(() => window.__vel?.state().menu === 'finish', null, { timeout: 20000 });
  return page.evaluate(() => window.__vel?.state().finish?.time ?? null);
}

// =====================================================================================================
// A — Dev-Start gegen dist/ (app://), Mock-Online
// =====================================================================================================
const SAVE_JSON = JSON.stringify({ v: 1, at: 1, data: { 'velocity.smoke': 'ok', 'velocity.best.v1': '{"level1":42}' } });
/** velocity.*-Stand von A beim Schließen (B prüft ihn nach gelöschtem Local Storage). */
let savedA: Record<string, string> = {};
{
  const { app, page } = await launchDev(['--dev', '--query=online=mock', '--window-mode=windowed']);
  const w = watch(page, 'A');
  try {
    await waitReady(page);
    const env = await page.evaluate(() => {
      const b = (window as BridgeWin).velocityDesktop;
      return {
        origin: location.origin,
        href: location.href,
        req: typeof (globalThis as { require?: unknown }).require,
        proc: typeof (globalThis as { process?: unknown }).process,
        bridge: b ? Object.keys(b).sort() : null,
        dev: b?.dev ?? null,
        versions: b?.versions ?? null,
        secure: window.isSecureContext,
        gamepad: typeof navigator.getGamepads,
      };
    });
    info.versions = env.versions;
    check('Origin app://velocity', env.origin === 'app://velocity', `${env.origin} (${env.href})`);
    check('Renderer ohne require/process', env.req === 'undefined' && env.proc === 'undefined', `require ${env.req}, process ${env.proc}`);
    check('Bridge velocityDesktop', env.bridge !== null && env.dev === true, `${env.bridge?.join(',')} · dev ${env.dev}`);
    check('Secure Context + Gamepad API', env.secure && env.gamepad === 'function', `isSecureContext ${env.secure}, getGamepads ${env.gamepad}`);
    console.log(`  Electron ${env.versions?.electron} · Chromium ${env.versions?.chrome}`);

    const lv = await page.evaluate(async () => {
      const r = await fetch('/levels/index.json');
      const idx = (await r.json()) as { id: string; file: string }[];
      const l1 = await fetch(`/levels/${idx[0]?.file ?? 'level1.json'}`);
      const ct = r.headers.get('content-type');
      const csp = (await fetch('/')).headers.get('content-security-policy');
      return { n: idx.length, ids: idx.map((e) => e.id), l1: l1.status, ct, csp };
    });
    info.csp = lv.csp;
    check('Levelliste über das Protokoll', lv.n >= 4 && lv.l1 === 200 && (lv.ct ?? '').startsWith('application/json'), `${lv.n} Level (${lv.ids.join(', ')}), ${lv.ct}`);
    // Aus dem Hauptprozess (net.fetch geht durch denselben Handler): im Renderer stünde jeder 404 als Konsolenfehler.
    // Ohne benannte Hilfsfunktion im evaluate: tsx (esbuild keepNames) setzt sonst __name(...) ein, das es dort nicht gibt.
    const esc = await app.evaluate(async ({ net }) => {
      const [dots, back, host] = await Promise.all(
        ['app://velocity/%2e%2e/package.json', 'app://velocity/..%5c..%5cpackage.json', 'app://evil/index.html'].map((u) => net.fetch(u).then((r) => r.status, () => -1)),
      );
      return { dots, back, host };
    });
    check('Pfad-Ausbruch / fremder Host → 404', esc.dots === 404 && esc.back === 404 && esc.host === 404, `%2e%2e ${esc.dots}, ..\\ ${esc.back}, app://evil ${esc.host}`);
    check('CSP-Header gesetzt', (lv.csp ?? '').includes("script-src 'self'"), lv.csp ?? '—');

    // Navigation / neue Fenster
    await page.evaluate(() => {
      (window as BridgeWin).__velMarker = 7;
    });
    const before = page.url();
    await page.evaluate(() => location.assign('https://example.com/')).catch(() => {});
    await sleep(1200);
    const nav = await page.evaluate(() => ({ href: location.href, marker: (window as BridgeWin).__velMarker ?? null }));
    check('location.assign(fremd) blockiert', nav.href === before && nav.marker === 7, `${nav.href}, Marker ${nav.marker}`);
    const opened = await page.evaluate(() => window.open('https://example.com/') === null);
    await sleep(300);
    check('window.open → null, kein neues Fenster', opened && app.windows().length === 1, `null ${opened}, Fenster ${app.windows().length}`);

    // Kürzel (ohne App-Menü wirkungslos). Strg+Shift+I: auch mit --dev kein Menü → keine DevTools.
    for (const [key, mods] of [['W', ['control']], ['R', ['control']], ['F5', []], ['I', ['control', 'shift']], ['Alt', []], ['F4', ['control']]] as const) {
      await sendKey(app, key, [...mods]);
      await sleep(500);
      const st = await app.evaluate(({ BrowserWindow }) => {
        const all = BrowserWindow.getAllWindows();
        const x = all[0];
        return { n: all.length, devtools: x ? x.webContents.isDevToolsOpened() : null, menu: x ? x.isMenuBarVisible() : null };
      });
      const marker = await page.evaluate(() => (window as BridgeWin).__velMarker ?? null).catch(() => null);
      const label = [...mods, key].join('+');
      check(`Kürzel ${label} ohne Wirkung`, st.n === 1 && marker === 7 && st.devtools === false && st.menu === false, `Fenster ${st.n}, Marker ${marker}, DevTools ${st.devtools}, Menüleiste ${st.menu}`);
    }
    // Gegenprobe gemessen (Standard-Menü drin): sendInputEvent löst Strg+Shift+I und Alt aus, aber NICHT die
    // Menü-Rollen close/reload (Strg+W, Strg+R, F5). Die prüft nur ein echter OS-Tastendruck (SendKeys).
    for (const [keys, label] of [['^w', 'Strg+W'], ['^r', 'Strg+R'], ['{F5}', 'F5'], ['^+i', 'Strg+Shift+I']] as const) {
      // Erst der Hauptprozess holt sein Fenster nach vorn (AppActivate allein reicht unter Windows nicht immer).
      // PID aus dem Hauptprozess selbst: app.process().pid ist unter Windows NICHT der Fenster-Besitzer (gemessen).
      const mainPid = await app.evaluate(({ BrowserWindow }) => {
        const x = BrowserWindow.getAllWindows()[0];
        x?.show();
        x?.focus();
        return process.pid;
      }).catch(() => -1);
      const act = osKey(mainPid, keys);
      await sleep(700);
      // Mit Zeitlimit: schließt Strg+W das Fenster (Gegenprobe), beendet sich die App und evaluate hinge sonst.
      const gone = { n: 0, devtools: null };
      const st = await Promise.race([
        app.evaluate(({ BrowserWindow }) => {
          const all = BrowserWindow.getAllWindows();
          return { n: all.length, devtools: all[0] ? all[0].webContents.isDevToolsOpened() : null };
        }).catch(() => gone),
        sleep(3000).then(() => gone),
      ]);
      const marker = await Promise.race([page.evaluate(() => (window as BridgeWin).__velMarker ?? null).catch(() => null), sleep(3000).then(() => null)]);
      check(`OS-Taste ${label} ohne Wirkung`, act === 'ok' && st.n === 1 && marker === 7 && st.devtools === false, `SendKeys ${act}, Fenster ${st.n}, Marker ${marker}, DevTools ${st.devtools}`);
    }

    // ---- S2b: Renderer an der Plattform
    const plat = await page.evaluate(() => ({
      platform: document.querySelector('.vel-menu')?.getAttribute('data-platform') ?? null,
      ctrl: window.__vel?.input().ctrlCrouch ?? null,
    }));
    check('Menü kennt die Plattform, Strg duckt ohne Vollbild', plat.platform === 'desktop' && plat.ctrl === true, JSON.stringify(plat));
    await page.evaluate(() => window.__vel?.start('level1', { lockless: true }));
    await page.waitForFunction(() => window.__vel?.state().gameState === 'playing', null, { timeout: 20000 });
    await page.waitForFunction(() => window.__vel?.state().onGround === true, null, { timeout: 5000 }).catch(() => {});
    await app.evaluate(({ BrowserWindow }) => {
      const x = BrowserWindow.getAllWindows()[0];
      x?.focus();
      x?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
    });
    await sleep(400);
    const ducked = await page.evaluate(() => window.__vel?.state().ducked ?? null);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' }));
    const fsNow = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? null);
    check('Strg duckt im Fenster-Modus', ducked === true && fsNow === false, `ducked ${ducked}, Vollbild ${fsNow}`);

    // Pointer Lock aus einer echten Geste (Klick auf "Weiter"), "Vollbild beim Start" an: der Modus darf NICHT umspringen.
    await page.evaluate(() => window.__vel?.setSettings({ fullscreenOnStart: true }));
    await page.evaluate(() => window.__vel?.start('level1'));
    // waitForSelector/click hängen hier: Playwright wartet seit dem blockierten location.assign auf eine Navigation.
    await page.waitForFunction(() => document.querySelector('.vel-menu[data-screen="pause"] .vel-btn--primary') !== null, null, { timeout: 20000 });
    await sleep(600); // Menü-Sperre
    const rb = await page.evaluate(() => {
      const r = document.querySelector('.vel-menu[data-screen="pause"] .vel-btn--primary')?.getBoundingClientRect();
      return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    });
    if (rb) await page.mouse.click(rb.x, rb.y);
    await page.waitForFunction(() => window.__vel?.input().locked === true, null, { timeout: 5000 }).catch(() => {});
    await sleep(800);
    const lk = await page.evaluate(() => window.__vel?.input() ?? null);
    const fsLevel = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? null);
    check('Pointer Lock roh (unadjustedMovement)', lk !== null && lk.locked && lk.rawInput && lk.rawStatus === 'active', lk ? `locked ${lk.locked}, raw ${lk.rawInput}, ${lk.rawStatus}` : '—');
    check('Levelstart mit "Vollbild beim Start": Modus springt nicht um', fsLevel === false, `isFullScreen ${fsLevel}`);
    await page.evaluate(() => window.__vel?.setSettings({ fullscreenOnStart: false }));
    // Esc im Lock: echte OS-Taste, nur wenn unser Fenster sicher vorn ist (osKey prüft die PID des Vordergrundfensters).
    if (lk?.locked) {
      const mainPid = await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.focus();
        return process.pid;
      }).catch(() => -1);
      const act = osKey(mainPid, '{ESC}');
      await sleep(900);
      const after = await page.evaluate(() => ({ st: window.__vel?.state().gameState ?? null, menu: window.__vel?.state().menu ?? null, locked: window.__vel?.input().locked ?? null }));
      if (act !== 'ok') console.log(`  - Esc im Lock übersprungen (Vordergrund nicht sicher: ${act})`);
      else {
        check('Esc im Lock → Pause, Lock frei', after.st === 'paused' && after.menu === 'pause' && after.locked === false, JSON.stringify(after));
        // Genau EINE Pause: eine zweite 'pause'-Aktion als Toggle hätte wieder fortgesetzt — kurz danach noch Pause.
        await sleep(600);
        const still = await page.evaluate(() => window.__vel?.state().gameState ?? null);
        check('Esc im Lock: genau eine Pause (bleibt pausiert)', still === 'paused', String(still));
      }
    } else console.log('  - Esc im Lock übersprungen (kein Lock)');
    await page.evaluate(() => window.__vel?.pause());

    // detMath-Hash Electron-Renderer ⇄ Node
    // evaluate(string) läuft in einer Funktion: die IIFE-Variable ausdrücklich global machen.
    await page.evaluate(`${probeJs}
window.__velDet = __velDet;`);
    const det = await page.evaluate((n) => {
      const d = (window as BridgeWin).__velDet;
      return d ? { det: d.detHash(n), math: d.mathHash(n) } : { det: 'keine Probe', math: '-' };
    }, DET_N);
    const nodeDet = detHash(DET_N);
    const nodeMath = mathHash(DET_N);
    info.detMath = { electron: det, node: { det: nodeDet, math: nodeMath } };
    check('detMath-Hash Electron = Node', det.det === nodeDet, `Electron ${det.det} / Node ${nodeDet} (Math.* informativ: Electron ${det.math} / Node ${nodeMath}${det.math === nodeMath ? ', gleich' : ', verschieden'})`);

    // Determinismus: Electron nimmt auf → Node prüft
    await page.evaluate(() => window.__vel?.setSettings({ playerName: 'Desktop' }));
    for (const [i, id] of LEVELS.entries()) {
      await page.evaluate((lid) => window.__vel?.start(lid, { lockless: true }), id);
      const time = await botToFinish(page, 3 + i, 1);
      await page.waitForFunction(() => window.__vel?.online().replay !== null, null, { timeout: 20000 }).catch(() => {});
      const b64 = await page.evaluate(() => window.__vel?.online().replay ?? null);
      if (!b64 || time === null) {
        check(`Electron-Replay ${id} → Node`, false, `Zeit ${time}, Replay ${b64 ? 'da' : 'fehlt'}`);
        continue;
      }
      writeFileSync(`${OUT}/run-${id}.b64`, b64);
      const res = verifyReplay(await unpackReplay(base64ToBytes(b64)), loadLevelById(id));
      check(`Electron-Replay ${id} → Node bitgleich`, res.valid && res.time === time, `Node ${res.valid ? res.time : `${res.reason} ${res.detail}`} / Electron ${time} · Ende ${res.endPos?.join(', ')}`);
    }
    // Node nimmt auf → Electron prüft
    for (const id of LEVELS) {
      const level = loadLevelById(id);
      const rep = recordBotRun(level, { follower: { aimNoiseDeg: 1.5, seed: 9 } });
      if (!rep) {
        check(`Node-Bot ${id}`, false, 'nicht im Ziel');
        continue;
      }
      const node = verifyReplay(rep, level);
      const b64 = bytesToBase64(await packReplay(rep));
      const br = await page.evaluate((b) => window.__vel?.verifyReplay(b) ?? null, b64);
      check(
        `Node-Replay ${id} → Electron bitgleich`,
        node.valid && br !== null && br.valid && br.time === node.time && JSON.stringify(br.endPos) === JSON.stringify(node.endPos) && JSON.stringify(br.splits) === JSON.stringify(node.splits),
        `Node ${node.time} · Electron ${br?.valid ? `${br.time} @ ${br.endPos?.join(', ')}` : `${br?.reason}: ${br?.detail}`}`,
      );
    }
    await page.screenshot({ path: `${OUT}/a-finish.png` });

    const isFs = (): Promise<boolean> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false);
    const savedMode = (): string | null => {
      try {
        return (JSON.parse(readFileSync(join(userData, 'desktop.json'), 'utf8')) as { mode?: string }).mode ?? null;
      } catch {
        return null;
      }
    };

    // C7: Alt+Enter / F11 schalten den Modus (gespeichert), die Seite sieht die Taste nicht; Enter allein schon.
    await page.evaluate('window.__velKeys = 0; window.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "F11") window.__velKeys++; }, true); 1');
    // Review N1: der Renderer erfährt den Wechsel (sonst zeigt die offene Einstellung den alten Modus).
    await page.evaluate('window.__velModes = []; window.velocityDesktop?.window.onModeChange?.((m) => window.__velModes.push(m)); 1');
    const fs0 = await isFs();
    await sendKey(app, 'Enter', ['alt']);
    await sleep(1200);
    const fsAlt = await isFs();
    const modeAlt = savedMode();
    await sendKey(app, 'F11', []);
    await sleep(1200);
    const fsF11 = await isFs();
    const modeF11 = savedMode();
    const seen = await page.evaluate(() => (window as BridgeWin).__velKeys ?? -1);
    const modes = await page.evaluate('JSON.stringify(window.__velModes ?? null)');
    await sendKey(app, 'Enter', []);
    await sleep(300);
    const seenPlain = await page.evaluate(() => (window as BridgeWin).__velKeys ?? -1);
    check(
      'Alt+Enter / F11 schalten den Anzeigemodus (gespeichert), Seite sieht sie nicht (C7)',
      !fs0 && fsAlt && modeAlt === 'fullscreen' && !fsF11 && modeF11 === 'windowed' && seen === 0 && seenPlain === 1 && (await isFs()) === false,
      `Fenster → Alt+Enter ${fsAlt}/${modeAlt} → F11 ${fsF11}/${modeF11}, Seite sah ${seen} (Enter allein ${seenPlain - seen})`,
    );
    check('Moduswechsel per Kürzel erreicht den Renderer (onModeChange, Review N1)', modes === '["fullscreen","windowed"]', `Ereignisse ${String(modes)}`);
    // Dasselbe mit echten OS-Tasten (nur nach PID-Prüfung des Vordergrundfensters).
    const pidA = await app.evaluate(({ BrowserWindow }) => {
      const x = BrowserWindow.getAllWindows()[0];
      x?.show();
      x?.focus();
      return process.pid;
    }).catch(() => -1);
    const actAlt = osKey(pidA, '%{ENTER}');
    await sleep(1200);
    const osAlt = await isFs();
    const actF11 = osKey(pidA, '{F11}');
    await sleep(1200);
    const osF11 = await isFs();
    if (actAlt !== 'ok' || actF11 !== 'ok') console.log(`  - OS-Tasten Alt+Enter/F11 übersprungen (Vordergrund nicht sicher: ${actAlt} / ${actF11})`);
    else check('OS-Taste Alt+Enter / F11 → Vollbild / Fenster', osAlt && !osF11, `Alt+Enter ${osAlt}, F11 ${osF11}`);
    if (await isFs()) await page.evaluate(() => (window as BridgeWin).velocityDesktop?.window.setMode('windowed'));

    // C3: Bildschirm wach nur, solange das Spiel vorn ist. C2: minimiert gedrosselt (rAF ≈ 0). Die Sichtbarkeit selbst
    // misst D ohne Playwright (das hält Seiten künstlich 'visible').
    const blocker = (): Promise<{ id: number | null; started: boolean; focused: boolean } | null> =>
      app.evaluate(({ BrowserWindow, powerSaveBlocker }) => {
        const g = (globalThis as { __velDisplaySleep?: { readonly blockerId: number | null } }).__velDisplaySleep;
        const x = BrowserWindow.getAllWindows()[0];
        if (!g || !x) return null;
        const id = g.blockerId;
        return { id, started: id !== null && powerSaveBlocker.isStarted(id), focused: x.isFocused() };
      });
    const rafPerSec = (): Promise<number> =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
          'new Promise((r) => { let n = 0; const f = () => { n++; requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => r(n), 1000); })',
        ) ?? -1,
      );
    const actFg = osActivate(pidA);
    await sleep(400);
    const bFg = await blocker();
    const rafFg = await rafPerSec();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    await sleep(800);
    const bMin = await blocker();
    const rafMin = await rafPerSec();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
    await sleep(500);
    const actBack = osActivate(pidA);
    await sleep(400);
    const bBack = await blocker();
    const rafBack = await rafPerSec();
    if (actFg !== 'ok' || actBack !== 'ok') console.log(`  - Bildschirm-wach im Vordergrund übersprungen (Vordergrund nicht sicher: ${actFg} / ${actBack})`);
    else check('Bildschirm wach im Vordergrund (powerSaveBlocker.isStarted, C3)', bFg?.started === true && bBack?.started === true, `vorn ${JSON.stringify(bFg)}, wieder vorn ${JSON.stringify(bBack)}`);
    check('Minimiert: Blocker frei (C3), Bildrate gedrosselt (C2)', bMin !== null && !bMin.started && rafMin <= 5 && rafFg > 20 && rafBack > 20, `Blocker ${JSON.stringify(bMin)}, rAF/s vorn ${rafFg} · minimiert ${rafMin} · zurück ${rafBack}`);

    // Anzeigemodus über die Bridge (Hauptprozess setzt Vollbild ohne Geste)
    const m1 = await page.evaluate(() => (window as BridgeWin).velocityDesktop?.window.setMode('fullscreen') ?? null);
    const fs1 = await isFs();
    const m2 = await page.evaluate(() => (window as BridgeWin).velocityDesktop?.window.setMode('windowed') ?? null);
    const fs2 = await isFs();
    const m3 = await page.evaluate(() => (window as BridgeWin).velocityDesktop?.window.setMode('fullscreen') ?? null);
    const fs3 = await isFs();
    const got = await page.evaluate(() => (window as BridgeWin).velocityDesktop?.window.getMode() ?? null);
    check('Anzeigemodus per Bridge', m1 === 'fullscreen' && fs1 && m2 === 'windowed' && !fs2 && m3 === 'fullscreen' && fs3 && got === 'fullscreen', `${m1}/${fs1} → ${m2}/${fs2} → ${m3}/${fs3}, getMode ${got}`);

    // Speicher-Spiegel (Bridge + Datei; Verdrahtung in main.ts ist S2b)
    const sv = await page.evaluate((json) => {
      const s = (window as BridgeWin).velocityDesktop?.saveMirror;
      if (!s) return null;
      return Promise.all([
        Promise.resolve(s.writeSync(json)),
        s.write('kein json'),
        s.write('x'.repeat(5 * 1024 * 1024)),
        s.write('[1,2]'),
      ]).then(([sync, bad, big, arr]) => ({ sync, bad, big, arr, back: s.readSync() }));
    }, SAVE_JSON);
    check('Spiegel schreiben/lesen, Müll abgelehnt', sv !== null && sv.sync && !sv.bad && !sv.big && !sv.arr && sv.back === SAVE_JSON, JSON.stringify(sv && { ...sv, back: sv.back === SAVE_JSON ? 'gleich' : sv.back }));
    check('Datei save.json liegt in userData', existsSync(join(userData, 'save', 'save.json')), join(userData, 'save', 'save.json'));

    const csp = await cspCount(page, w);
    check('A: 0 CSP-Verstöße', csp.length === 0, csp.slice(0, 4).join(' | ') || '0');
    check('A: 0 Konsolenfehler', w.errors.length === 0, w.errors.slice(0, 4).join(' | ') || '0');

    // Fenster-X trotz beforeunload-Wache (mit Nutzer-Aktivierung, sonst ignoriert Chromium die Wache ohnehin)
    // Kein accept/dismiss: Playwright würde den Dialog sonst selbst bestätigen und den Fix verdecken (fallen.md #21).
    const dialogs: string[] = [];
    page.on('dialog', (d) => dialogs.push(d.type()));
    await page.mouse.click(5, 5);
    await page.evaluate(() => {
      window.addEventListener('beforeunload', (e) => {
        e.preventDefault();
        e.returnValue = '';
      });
    });
    // Spiegel-Stand vor dem Schließen merken (der Spiegel schreibt ihn spätestens bei pagehide synchron). Eine frische
    // Änderung steht dabei noch im Debounce (2 s) — der Bridge-Test oben hat save.json überschrieben, ohne dass der
    // Spiegel es weiß: nur das synchrone Schreiben beim Schließen bringt den echten Stand zurück.
    savedA = await page.evaluate(() => {
      localStorage.setItem('velocity.smoke.close', String(Date.now()));
      const out: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('velocity.')) out[k] = localStorage.getItem(k) ?? '';
      }
      return out;
    });
    const t0 = Date.now();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const ex = await waitExit(app, 5000);
    check('Fenster-X (mit beforeunload) → Exit 0 < 1 s', ex.code === 0 && Date.now() - t0 < 1000, `Code ${ex.code}, ${Date.now() - t0} ms, Dialoge ${dialogs.join(',') || 'keine'}`);
    const file = join(userData, 'save', 'save.json');
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
    let fileData: Record<string, string> = {};
    try {
      fileData = (JSON.parse(raw) as { data?: Record<string, string> }).data ?? {};
    } catch {
      fileData = {};
    }
    const bestA = savedA['velocity.best.v1'] ?? null;
    const lost = Object.keys(savedA).filter((k) => fileData[k] !== savedA[k]);
    check(
      'Spiegel beim Schließen geschrieben (offene Änderung, Bestzeiten, alle Schlüssel, < 200 KB)',
      bestA !== null && lost.length === 0 && raw.length < 200 * 1024,
      `${Object.keys(fileData).length}/${Object.keys(savedA).length} Schlüssel, ${(raw.length / 1024).toFixed(1)} KB${lost.length ? `, abweichend: ${lost.join(', ')}` : ''}`,
    );
  } finally {
    await app.close().catch(() => {});
  }
}


// =====================================================================================================
// B — unverpackt OHNE --dev, gleiches userData (kein __vel: Bereitschaft über das DOM, Pad über navigator)
// =====================================================================================================
{
  // Local Storage löschen: B muss den Stand aus save.json einspielen, bevor die Stores lesen (Plan 011 §2.7).
  rmSync(join(userData, 'Local Storage'), { recursive: true, force: true });
  const { app, page } = await launchDev(['--query=online=mock', '--window-mode=windowed', '--fault=start']);
  const w = watch(page, 'B');
  try {
    const door = await waitDoor(page);
    const st = await app.evaluate(({ BrowserWindow }) => {
      const x = BrowserWindow.getAllWindows()[0];
      if (!x) return null;
      x.webContents.openDevTools();
      return { fs: x.isFullScreen(), devtools: x.webContents.isDevToolsOpened() };
    });
    await sleep(500);
    const dt2 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.isDevToolsOpened() ?? null);
    const pg = await page.evaluate(() => {
      const b = (window as BridgeWin).velocityDesktop;
      const keys: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('velocity.')) keys[k] = localStorage.getItem(k) ?? '';
      }
      return { dev: b?.dev ?? null, search: location.search, keys, vel: typeof window.__vel };
    });
    check('B: Titel steht ohne __vel (Menü-Tür offen), --fault ohne --dev wirkungslos', door, `data-door ready ${door}`);
    check('Modus aus desktop.json übernommen (Vollbild)', st?.fs === true, `isFullScreen ${st?.fs}`);
    check('Ohne --dev: Dev-Parameter ignoriert', pg.dev === false && pg.search === '', `dev ${pg.dev}, Query "${pg.search}"`);
    check('Ohne --dev: kein Debug-Handle window.__vel (C1)', pg.vel === 'undefined', `typeof __vel ${pg.vel}`);
    check('Ohne --dev: DevTools gesperrt', st?.devtools === false && dt2 === false, `openDevTools → ${st?.devtools}/${dt2}`);
    const missing = Object.keys(savedA).filter((k) => !(k in pg.keys));
    check(
      'Local Storage gelöscht → Spiegel eingespielt (Bestzeit, alle Schlüssel)',
      Object.keys(savedA).length > 0 && missing.length === 0 && pg.keys['velocity.best.v1'] === savedA['velocity.best.v1'],
      `${Object.keys(pg.keys).length}/${Object.keys(savedA).length} Schlüssel${missing.length ? `, fehlt: ${missing.join(', ')}` : ''}`,
    );
    await sleep(2500); // Supabase-SDK + erste Anfragen unter der CSP
    await page.screenshot({ path: `${OUT}/b-title.png` });
    const csp = await cspCount(page, w);
    check('B (echtes Online): 0 CSP-Verstöße', csp.length === 0, csp.slice(0, 4).join(' | ') || '0');
    info.errorsB = w.errors;
    check('B: 0 Konsolenfehler', w.errors.length === 0, w.errors.slice(0, 4).join(' | ') || '0');
    await page.evaluate(() => (window as BridgeWin).velocityDesktop?.window.setMode('windowed'));

    // Ohne --dev: kein Admin (Eintrag, F8), Beenden im ps2-System-Panel — nur mit dem Fake-Pad bedient.
    const { res, tapA } = await padToQuitArmed(page, 'b');
    info.bNav = res.nav;
    check('Ohne --dev: kein Admin-Eintrag, F8 ohne Wirkung', res.sys && !res.items.includes('Admin') && res.items.includes('Beenden') && res.afterF8 === 'title', `System ${res.sys}, Einträge ${res.items.join('/')}, nach F8 ${res.afterF8}`);
    await page.screenshot({ path: `${OUT}/b-quit-armed.png` });
    check('Beenden zweistufig ("Wirklich beenden?")', res.armed === 'Wirklich beenden?', String(res.armed));
    const tq = Date.now();
    await tapA().catch(() => {});
    const ex = await waitExit(app, 5000);
    check('Beenden per Fake-Pad über das System-Panel → Exit 0', ex.code === 0, `Code ${ex.code}, ${Date.now() - tq} ms`);
    if (ex.code === null) await page.evaluate(() => (window as BridgeWin).velocityDesktop?.quit()).catch(() => {});
  } finally {
    await app.close().catch(() => {});
  }
}

// =====================================================================================================
// D — Minimieren ohne Playwright (C2): echte Page Visibility, Pause, Bildrate
// =====================================================================================================
{
  const port = 9352;
  const dataD = mkdtempSync(join(tmpdir(), 'velocity-smoke-min-'));
  const proc = spawnDev(['--dev', '--query=online=mock', '--window-mode=windowed', `--remote-debugging-port=${port}`, `--user-data=${dataD}`]);
  try {
    const cdp = await rawCdp(port, 30000);
    if (!cdp || !(await cdpUntil(cdp, 'window.__vel?.ready === true', 30000))) check('D: Dev-Fenster per CDP', false, 'keine Verbindung/kein __vel');
    else {
      await cdp.ev(`window.__smokeVis = []; document.addEventListener('visibilitychange', () => window.__smokeVis.push(document.visibilityState)); window.__vel.start('level1', { lockless: true }); true`);
      await cdpUntil(cdp, `window.__vel.state().gameState === 'playing'`, 20000);
      await sleep(800);
      interface VisSample {
        readonly raf: number;
        readonly vis: string;
        readonly events: string[];
        readonly game: string;
      }
      const sample = (): Promise<VisSample | undefined> =>
        cdp.ev<VisSample>(
          `new Promise((r) => { let n = 0; const f = () => { n++; requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(() => r({ raf: n, vis: document.visibilityState, events: window.__smokeVis.slice(), game: window.__vel.state().gameState }), 1000); })`,
        );
      const before = await sample();
      const hMin = osWindow(proc.pid ?? -1, 6);
      await sleep(800);
      const min = await sample();
      const hBack = osWindow(proc.pid ?? -1, 9);
      await sleep(800);
      const back = await sample();
      info.minimize = { before, min, back, hMin, hBack };
      check(
        'Minimiert: visibilityState hidden + visibilitychange, Pause, rAF ≈ 0 (C2)',
        before?.vis === 'visible' && before.game === 'playing' && min?.vis === 'hidden' && min.events.includes('hidden') && min.game === 'paused' && min.raf <= 2,
        `vorher ${before?.vis}/${before?.game}/${before?.raf} rAF/s → minimiert ${min?.vis}/${min?.game}/${min?.raf} rAF/s, Ereignisse ${min?.events.join(',')} (Fenster ${hMin})`,
      );
      check(
        'Wiederhergestellt: sichtbar, volle Bildrate (C2)',
        back?.vis === 'visible' && (back.events.at(-1) ?? '') === 'visible' && back.raf > 20,
        `${back?.vis}, ${back?.raf} rAF/s, Ereignisse ${back?.events.join(',')} (Fenster ${hBack})`,
      );
      await cdp.ev('window.velocityDesktop.quit(); true');
      cdp.close();
    }
    const code = await procExit(proc, 5000);
    check('D: Beenden → Exit 0', code === 0, `Code ${code}`);
  } finally {
    killTree(proc);
    rmQuiet(dataD);
  }
}

// =====================================================================================================
// E — Fehler-Injektion (C4/C6), nur Dev-Modus
// =====================================================================================================
if (process.argv.includes('--no-faults')) console.log('- Fehler-Injektion übersprungen (--no-faults)');
else {
  /** Dev-Hülle mit Fehler starten; stderr mitschreiben (dort meldet main.ts Neuladen/Aufgeben). */
  const faultRun = (fault: string, port: number | null): { proc: ChildProcess; log: () => string; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), `velocity-smoke-${fault}-`));
    const args = ['.', '--dev', `--fault=${fault}`, '--query=online=mock', '--window-mode=windowed', `--user-data=${dir}`];
    if (port !== null) args.push(`--remote-debugging-port=${port}`);
    const proc = spawn(electronPath, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    return { proc, log: () => err, dir };
  };
  const lastLine = (log: string, re: RegExp): string => log.split(/\r?\n/).filter((l) => re.test(l)).slice(-1)[0]?.slice(0, 160) ?? '—';

  // Nicht zu retten: Fehlerdialog (im Test-Modus schließt er sich selbst), Exit 1 — kein unsichtbarer Prozess.
  for (const f of ['start', 'crash', 'load'] as const) {
    const r = faultRun(f, null);
    const t0 = Date.now();
    const code = await procExit(r.proc, 40000);
    if (code === null) killTree(r.proc);
    check(`Fehler ${f}: Fehlerdialog + Exit 1 (C4)`, code === 1 && /Fehlerdialog/.test(r.log()), `Code ${code}, ${Date.now() - t0} ms · ${lastLine(r.log(), /Fehlerdialog/)}`);
    rmQuiet(r.dir);
  }

  // Einmal-Fehler: neu geladen bzw. ohne Modul weiter — das Spiel steht, das Fenster ist sichtbar.
  const recover: readonly (readonly [string, RegExp, number])[] = [
    ['crash-once', /Renderer gone .*neu laden/, 40000],
    ['load-once', /Renderer load .*neu laden/, 40000],
    ['setup', /Modul .* nicht geladen/, 40000],
    ['hang', /Renderer unresponsive .*neu laden/, 120000],
  ];
  for (const [i, [f, re, ms]] of recover.entries()) {
    const port = 9354 + i;
    const r = faultRun(f, port);
    const t0 = Date.now();
    try {
      // Erst die Meldung im Log abwarten, dann muss die (neu geladene) Seite bereit sein.
      while (Date.now() - t0 < ms && !re.test(r.log()) && r.proc.exitCode === null) await sleep(250);
      const logged = re.test(r.log());
      // Erst nach dem Neuladen verbinden: eine Verbindung zum alten (gleich beendeten) Renderer bliebe stumm.
      if (logged) await sleep(2500);
      const cdp = logged ? await rawCdp(port, 15000) : null;
      const ready = cdp ? await cdpUntil(cdp, 'window.__vel?.ready === true', 30000) : false;
      const shown = osWindow(r.proc.pid ?? -1, null);
      await sleep(1500);
      const alive = r.proc.exitCode === null;
      check(
        `Fehler ${f}: weiter spielbar, Fenster sichtbar (C4/C6)`,
        logged && ready && alive && shown !== '0' && !shown.startsWith('fehler'),
        `${Date.now() - t0} ms · Log "${lastLine(r.log(), re)}" · bereit ${ready}, Fenster ${shown}, läuft ${alive}`,
      );
      await cdp?.ev('window.velocityDesktop.quit(); true');
      cdp?.close();
      const code = await procExit(r.proc, 5000);
      if (code !== 0) console.log(`  - ${f}: Beenden Code ${code}`);
    } finally {
      killTree(r.proc);
      rmQuiet(r.dir);
    }
  }

  // ready-to-show kommt nie: Fenster erst versteckt, nach dem Zeitlimit (10 s) trotzdem sichtbar.
  {
    const port = 9359;
    const r = faultRun('noshow', port);
    try {
      await sleep(4000);
      const early = osWindow(r.proc.pid ?? -1, null);
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && !/Kein erstes Bild/.test(r.log())) await sleep(250);
      await sleep(800);
      const late = osWindow(r.proc.pid ?? -1, null);
      check(
        'ready-to-show bleibt aus → Fenster nach Zeitlimit sichtbar (C4)',
        early === '0' && late !== '0' && !late.startsWith('fehler') && /Kein erstes Bild/.test(r.log()),
        `nach 4 s Fenster ${early}, danach ${late} · ${lastLine(r.log(), /Kein erstes Bild/)}`,
      );
      const cdp = await rawCdp(port, 5000);
      await cdp?.ev('window.velocityDesktop.quit(); true');
      cdp?.close();
      await procExit(r.proc, 5000);
    } finally {
      killTree(r.proc);
      rmQuiet(r.dir);
    }
  }
}

// =====================================================================================================
// C — gebaute exe (ohne Dev-Server, ohne Node, ohne __vel)
// =====================================================================================================
const exe = resolve(ROOT, 'release', 'win-unpacked', 'VELOCITY.exe');
if (process.argv.includes('--no-exe')) console.log('- exe übersprungen (--no-exe)');
else if (!existsSync(exe)) check('win-unpacked/VELOCITY.exe vorhanden', false, `${exe} fehlt → npm run desktop:build`);
else {
  const port = 9351;
  const dataC = mkdtempSync(join(tmpdir(), 'velocity-smoke-exe-'));
  // --dev, --query, --fault: im Paket wirkungslos (Review C1) — jeder Spieler kann sie als Steam-Startoption setzen.
  const proc = spawn(exe, ['--dev', '--query=online=mock', '--fault=start', `--remote-debugging-port=${port}`, `--user-data=${dataC}`], { stdio: 'ignore' });
  const exited = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
  const pid = proc.pid ?? -1;
  try {
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null = null;
    for (let k = 0; k < 40 && !browser; k++) {
      await sleep(250);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    }
    if (!browser) check('exe: CDP-Verbindung', false, 'keine Verbindung');
    else {
      let page: Page | undefined;
      for (let k = 0; k < 40 && !page; k++) {
        page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://'));
        if (!page) await sleep(250);
      }
      if (!page) check('exe: Spielseite', false, 'keine app://-Seite');
      else {
        const pg = page;
        const w = watch(pg, 'C');
        const door = await waitDoor(pg);
        const r = await pg.evaluate(async () => {
          const res = await fetch('/levels/index.json');
          const idx = (await res.json()) as unknown[];
          const b = (window as BridgeWin).velocityDesktop;
          return {
            origin: location.origin,
            n: idx.length,
            dev: b?.dev ?? null,
            v: b?.versions ?? null,
            req: typeof (globalThis as { require?: unknown }).require,
            proc: typeof (globalThis as { process?: unknown }).process,
            search: location.search,
            vel: typeof window.__vel,
            csp: (await fetch('/')).headers.get('content-security-policy'),
          };
        });
        check(
          'exe: startet (trotz --fault=start), app://velocity, Levelliste',
          door && r.origin === 'app://velocity' && r.n >= 4 && r.req === 'undefined' && r.proc === 'undefined',
          `${r.origin}, ${r.n} Level, require ${r.req}, process ${r.proc}, Electron ${r.v?.electron}`,
        );
        check('exe: --dev/--query wirkungslos, kein __vel (C1)', r.dev === false && r.search === '' && r.vel === 'undefined', `dev ${r.dev}, Query "${r.search}", typeof __vel ${r.vel}`);
        check('exe: CSP-Header gesetzt', (r.csp ?? '').includes("script-src 'self'"), r.csp ?? '—');
        await pg.screenshot({ path: `${OUT}/c-exe.png` });

        // Kürzel als echte OS-Tasten (nur nach PID-Prüfung des Vordergrundfensters).
        await pg.evaluate(() => {
          (window as BridgeWin).__velMarker = 7;
        });
        for (const [keys, label] of [['^w', 'Strg+W'], ['^r', 'Strg+R'], ['{F5}', 'F5'], ['^+i', 'Strg+Shift+I']] as const) {
          const act = osKey(pid, keys);
          await sleep(800);
          const marker = await Promise.race([pg.evaluate(() => (window as BridgeWin).__velMarker ?? null).catch(() => null), sleep(3000).then(() => null)]);
          const devtools = (await cdpTargets(port)).filter((t) => t.url.startsWith('devtools://')).length;
          if (act !== 'ok') console.log(`  - exe: OS-Taste ${label} übersprungen (Vordergrund nicht sicher: ${act})`);
          else check(`exe: OS-Taste ${label} ohne Wirkung`, marker === 7 && devtools === 0 && proc.exitCode === null, `Marker ${marker}, DevTools-Ziele ${devtools}, läuft ${proc.exitCode === null}`);
        }
        // Alt+Enter / F11 (C7): Modus wechselt und steht in desktop.json.
        const mode = (): Promise<string | null> => pg.evaluate(() => (window as BridgeWin).velocityDesktop?.window.getMode() ?? null);
        const fileMode = (): string | null => {
          try {
            return (JSON.parse(readFileSync(join(dataC, 'desktop.json'), 'utf8')) as { mode?: string }).mode ?? null;
          } catch {
            return null;
          }
        };
        const m0 = await mode();
        const a1 = osKey(pid, '%{ENTER}');
        await sleep(1500);
        const m1 = await mode();
        const f1 = fileMode();
        const a2 = osKey(pid, '{F11}');
        await sleep(1500);
        const m2 = await mode();
        if (a1 !== 'ok' || a2 !== 'ok') console.log(`  - exe: Alt+Enter/F11 übersprungen (Vordergrund nicht sicher: ${a1} / ${a2})`);
        else check('exe: Alt+Enter / F11 schalten den Anzeigemodus (gespeichert, C7)', m0 !== null && m1 !== m0 && f1 === m1 && m2 === m0, `${m0} → Alt+Enter ${m1} (Datei ${f1}) → F11 ${m2}`);

        // Speicher-Spiegel am Paket
        const sv = await pg.evaluate((json) => {
          const s = (window as BridgeWin).velocityDesktop?.saveMirror;
          if (!s) return null;
          return Promise.all([Promise.resolve(s.writeSync(json)), s.write('kein json')]).then(([sync, bad]) => ({ sync, bad }));
        }, SAVE_JSON);
        const saveFile = join(dataC, 'save', 'save.json');
        check('exe: Spiegel schreibt save.json, Müll abgelehnt', sv !== null && sv.sync && !sv.bad && existsSync(saveFile), `${JSON.stringify(sv)}, Datei ${existsSync(saveFile)}`);

        // Kein Admin ohne Dev-Modus, Beenden per Fake-Pad (navigator.getGamepads).
        if ((await mode()) === 'fullscreen') await pg.evaluate(() => (window as BridgeWin).velocityDesktop?.window.setMode('windowed'));
        const { res, tapA } = await padToQuitArmed(pg, 'c');
        check(
          'exe: kein Admin-Eintrag, F8 ohne Wirkung (--dev im Paket wirkungslos)',
          res.sys && !res.items.includes('Admin') && res.items.includes('Beenden') && res.afterF8 === 'title',
          `System ${res.sys}, Einträge ${res.items.join('/')}, nach F8 ${res.afterF8}`,
        );
        check('exe: 0 CSP-Verstöße / Fehler (ab Verbindung)', w.csp.length === 0 && w.errors.length === 0, [...w.csp, ...w.errors].slice(0, 4).join(' | ') || '0');
        check('exe: Beenden zweistufig', res.armed === 'Wirklich beenden?', String(res.armed));
        await tapA().catch(() => {});
      }
      await browser.close().catch(() => {});
    }
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)]);
    check('exe: Beenden per Fake-Pad → Exit 0', code === 0, `Code ${code}`);
  } finally {
    killTree(proc);
    rmQuiet(dataC);
  }

  // Fuses: --inspect und ELECTRON_RUN_AS_NODE sind im Paket gesperrt (electron-builder.yml electronFuses).
  {
    const dataF = mkdtempSync(join(tmpdir(), 'velocity-smoke-fuse-'));
    const inspectPort = 9362;
    const p1 = spawn(exe, [`--inspect=${inspectPort}`, `--user-data=${join(dataF, 'a')}`], { stdio: 'ignore' });
    await sleep(4000);
    const inspector = await fetch(`http://127.0.0.1:${inspectPort}/json/version`).then((x) => x.status, () => -1);
    killTree(p1);
    check('exe: --inspect gesperrt (Fuse)', inspector === -1, `Inspector-Port ${inspector === -1 ? 'zu' : `offen (${inspector})`}`);
    const p2 = spawn(exe, ['-e', 'process.exit(42)', `--user-data=${join(dataF, 'b')}`], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const c2 = await procExit(p2, 4000);
    killTree(p2);
    check('exe: ELECTRON_RUN_AS_NODE wirkungslos (Fuse)', c2 !== 42, `Code ${c2 === null ? 'läuft als Spiel' : c2}`);
    await sleep(500);
    rmQuiet(dataF);
  }
}

rmQuiet(userData);
writeFileSync(`${OUT}/report.json`, JSON.stringify({ checks, info }, null, 2));
const bad = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - bad.length}/${checks.length} grün${bad.length ? ` — rot: ${bad.map((c) => c.name).join('; ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
