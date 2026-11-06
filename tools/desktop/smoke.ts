/**
 * Desktop-Smoke (Plan 011 Schritte 2.1, 2.3 Hauptprozess, 2.4 Kürzel/Schließen Hauptprozess, 2.6, 2.7 Bridge).
 * Startet die ECHTE Electron-Hülle mit der gebauten dist/ über app://velocity (kein Dev-Server).
 *
 *  A  --dev, ?online=mock, Fenster: Origin, kein require/process, Bridge, CSP, Levelliste, Pfad-Ausbruch,
 *     Navigation/window.open gesperrt, Strg+W/Strg+R/F5/Strg+Shift+I/Alt (sendInputEvent), Determinismus L1–L4
 *     (Electron → Node und Node → Electron, bitgleich) + detMath-Hash, Anzeigemodus, Speicher-Spiegel,
 *     Fenster-X trotz beforeunload → Exit 0 in < 1 s.
 *     S2b (Renderer verdrahtet): Plattform im Menü, Strg duckt im Fenster, Pointer Lock roh, Esc im Lock (echte
 *     OS-Taste, nur nach PID-Prüfung des Vordergrundfensters) → genau eine Pause, Anzeigemodus springt beim
 *     Levelstart nicht um, Spiegel beim Schließen geschrieben.
 *  B  ohne --dev, gleiches userData, Local Storage GELÖSCHT: Spiegel eingespielt (Bestzeit/Schlüssel wie in A),
 *     Modus übernommen, DevTools gesperrt, kein Admin/F8, echtes Supabase unter der CSP, Beenden per Fake-Pad über
 *     das ps2-System-Panel (zweistufig) → Exit 0.
 *  C  release/win-unpacked/VELOCITY.exe (falls gebaut, `npm run desktop:build`): startet ohne Dev-Server,
 *     per CDP geprüft (Fuses sperren --inspect, daher kein _electron.launch).
 *
 *   npm run build && npx tsx tools/desktop/smoke.ts [--no-exe]   → shots/desktop/report.json, Exit 1 bei Fehler
 *
 * Achtung: öffnet echte Fenster (B startet im Vollbild, weil A den Modus so gespeichert hat).
 */
import { execFileSync, spawn } from 'node:child_process';
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

type BridgeWin = Window & { velocityDesktop?: DesktopBridge; __velMarker?: number; __cspViolations?: string[] };

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
      const d = (window as unknown as { __velDet: { detHash(n: number): string; mathHash(n: number): string } }).__velDet;
      return { det: d.detHash(n), math: d.mathHash(n) };
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

    // Anzeigemodus über die Bridge (Hauptprozess setzt Vollbild ohne Geste)
    const isFs = (): Promise<boolean> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false);
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
    // Spiegel-Stand vor dem Schließen merken (der Spiegel schreibt ihn spätestens bei pagehide synchron).
    savedA = await page.evaluate(() => {
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
    check(
      'Spiegel beim Schließen geschrieben (Bestzeiten, < 200 KB)',
      bestA !== null && fileData['velocity.best.v1'] === bestA && raw.length < 200 * 1024,
      `${Object.keys(fileData).length} Schlüssel, ${(raw.length / 1024).toFixed(1)} KB, best ${bestA ? 'gleich' : 'fehlt'}`,
    );
  } finally {
    await app.close().catch(() => {});
  }
}

// =====================================================================================================
// B — ohne --dev, gleiches userData
// =====================================================================================================
{
  // Local Storage löschen: B muss den Stand aus save.json einspielen, bevor die Stores lesen (Plan 011 §2.7).
  rmSync(join(userData, 'Local Storage'), { recursive: true, force: true });
  const { app, page } = await launchDev(['--query=online=mock', '--window-mode=windowed']);
  const w = watch(page, 'B');
  try {
    await waitReady(page);
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
      return { dev: b?.dev ?? null, search: location.search, keys };
    });
    check('Modus aus desktop.json übernommen (Vollbild)', st?.fs === true, `isFullScreen ${st?.fs}`);
    check('Ohne --dev: Dev-Parameter ignoriert', pg.dev === false && pg.search === '', `dev ${pg.dev}, Query "${pg.search}"`);
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
    const XBOX = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
    const tap = async (b: string): Promise<void> => {
      await page.evaluate((x) => window.__vel?.pad({ buttons: { [x]: true } }), b);
      await sleep(80);
      await page.evaluate((x) => window.__vel?.pad({ buttons: { [x]: false } }), b);
      await sleep(120);
    };
    const view = (): Promise<string | null> => page.evaluate(() => document.querySelector('.ps2-ui')?.getAttribute('data-view') ?? null);
    await page.evaluate((id) => window.__vel?.pad({ id }), XBOX);
    await page.waitForSelector('.vel-menu[data-door="ready"]', { timeout: 15000 }).catch(() => {});
    await tap('PadDown'); // weckt das Pad (der Druck, der ein Pad übernimmt, zählt erst nach dem Loslassen)
    // Boot per A überspringen, bis die Bühne lebt (is-live, kein .ps2-boot mehr); danach kurze Sperre abwarten.
    const live = (): Promise<boolean> => page.evaluate(() => document.querySelector('.ps2-ui.is-live') !== null && document.querySelector('.ps2-boot') === null);
    for (let i = 0; i < 6 && !(await live()); i++) await tap('PadA');
    await sleep(500);
    info.bView = await view();
    // System = letzter Hauptmenü-Eintrag. Der Pad-Fokus ist räumlich (kein Umlauf): rechts, und wo es nicht weitergeht,
    // runter — bis System gewählt ist.
    const navLog: string[] = [];
    const selMain = (): Promise<string> => page.evaluate(() => document.querySelector('.ps2-item.is-selected')?.getAttribute('data-id') ?? '-');
    for (let i = 0; i < 12; i++) {
      const sel = await selMain();
      navLog.push(sel);
      if (sel === 'system') break;
      await tap('PadRight');
      if ((await selMain()) === sel) await tap('PadDown');
    }
    info.bNav = navLog;
    await tap('PadA');
    const sys = await page.waitForSelector('.ps2-ui[data-view="system"]', { timeout: 5000 }).then(() => true, () => false);
    const items = await page.evaluate(() => Array.from(document.querySelectorAll('.ps2-sys-item .ps2-sys-label')).map((e) => e.textContent ?? ''));
    await page.keyboard.press('F8');
    await sleep(300);
    const scr = await page.evaluate(() => document.querySelector('.vel-menu')?.getAttribute('data-screen') ?? null);
    check('Ohne --dev: kein Admin-Eintrag, F8 ohne Wirkung', sys && !items.includes('Admin') && items.includes('Beenden') && scr === 'title', `System ${sys}, Einträge ${items.join('/')}, nach F8 ${scr}`);
    // Beenden = letzter Eintrag: runter, bis er gewählt ist; A fragt nach, A beendet.
    for (let i = 0; i < 10; i++) {
      if ((await page.evaluate(() => document.querySelector('.ps2-sys-item.is-selected .ps2-sys-label')?.textContent ?? null)) === 'Beenden') break;
      await tap('PadDown');
    }
    await page.screenshot({ path: `${OUT}/b-system.png` });
    await tap('PadA');
    const armed = await page.evaluate(() => document.querySelector('.ps2-sys-item.is-armed .ps2-sys-label')?.textContent ?? null);
    await page.screenshot({ path: `${OUT}/b-quit-armed.png` });
    check('Beenden zweistufig ("Wirklich beenden?")', armed === 'Wirklich beenden?', String(armed));
    const tq = Date.now();
    await tap('PadA').catch(() => {});
    const ex = await waitExit(app, 5000);
    check('Beenden per Fake-Pad über das System-Panel → Exit 0', ex.code === 0, `Code ${ex.code}, ${Date.now() - tq} ms`);
    if (ex.code === null) await page.evaluate(() => (window as BridgeWin).velocityDesktop?.quit()).catch(() => {});
  } finally {
    await app.close().catch(() => {});
  }
}

// =====================================================================================================
// C — gebaute exe (ohne Dev-Server, ohne Node)
// =====================================================================================================
const exe = resolve(ROOT, 'release', 'win-unpacked', 'VELOCITY.exe');
if (process.argv.includes('--no-exe')) console.log('- exe übersprungen (--no-exe)');
else if (!existsSync(exe)) check('win-unpacked/VELOCITY.exe vorhanden', false, `${exe} fehlt → npm run desktop:build`);
else {
  const port = 9351;
  const dataC = mkdtempSync(join(tmpdir(), 'velocity-smoke-exe-'));
  const proc = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data=${dataC}`], { stdio: 'ignore' });
  const exited = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
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
        const w = watch(page, 'C');
        await waitReady(page);
        const r = await page.evaluate(async () => {
          const idx = (await (await fetch('/levels/index.json')).json()) as unknown[];
          const b = (window as BridgeWin).velocityDesktop;
          return { origin: location.origin, n: idx.length, dev: b?.dev ?? null, v: b?.versions ?? null, req: typeof (globalThis as { require?: unknown }).require };
        });
        check('exe: startet, app://velocity, Levelliste', r.origin === 'app://velocity' && r.n >= 4 && r.dev === false && r.req === 'undefined', `${r.origin}, ${r.n} Level, dev ${r.dev}, Electron ${r.v?.electron}`);
        await page.screenshot({ path: `${OUT}/c-exe.png` });
        await sleep(1500);
        check('exe: 0 CSP-Verstöße / Fehler (ab Verbindung)', w.csp.length === 0 && w.errors.length === 0, [...w.csp, ...w.errors].slice(0, 4).join(' | ') || '0');
        await page.evaluate(() => (window as BridgeWin).velocityDesktop?.quit()).catch(() => {});
      }
      await browser.close().catch(() => {});
    }
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)]);
    check('exe: Beenden → Exit 0', code === 0, `Code ${code}`);
  } finally {
    if (proc.exitCode === null) proc.kill();
    rmSync(dataC, { recursive: true, force: true });
  }
}

rmSync(userData, { recursive: true, force: true });
writeFileSync(`${OUT}/report.json`, JSON.stringify({ checks, info }, null, 2));
const bad = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - bad.length}/${checks.length} grün${bad.length ? ` — rot: ${bad.map((c) => c.name).join('; ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
