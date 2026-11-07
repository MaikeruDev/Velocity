/**
 * Electron-Hauptprozess der Desktop-Hülle (Plan 011 Phase 2, Windows). Lädt DIESELBE Vite-`dist/` wie Vercel
 * über `app://velocity/`. Sicherheit: contextIsolation + sandbox, kein nodeIntegration, kein App-Menü
 * (entfernt Strg+W/Strg+R/Strg+Shift+I/Alt), Navigation und neue Fenster gesperrt, CSP als Header,
 * nur pointerLock/fullscreen/keyboardLock. DevTools nur im Dev-Modus.
 *
 * Schalter:
 *   --dev                 Dev-Modus, NUR unverpackt (`electron .`): DevTools, Debug-Handle __vel, Admin/F8 und die
 *                         Schalter unten. Im Paket wirkungslos — dort ist --dev bloß eine Steam-Startoption (Review C1).
 *   --dev-url=<url>       (dev) statt app:// den Vite-Dev-Server laden (desktop:dev)
 *   --query=<qs>          (dev) Query an die Start-URL hängen (Smoke-Test: online=mock)
 *   --window-mode=<m>     (dev) Startmodus nur für diese Sitzung (fullscreen|windowed)
 *   --fault=<f>           (dev) Fehler-Injektion für den Smoke (policy.ts FAULTS)
 *   --user-data=<dir>     eigenes userData-Verzeichnis (Smoke-Test, getrennte Spielstände)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { ModuleRunner } from './moduleRunner.js';
import { DESKTOP_MODULES, MODULE_SETUP_TIMEOUT_MS, type DesktopModule, type DesktopModuleContext } from './modules.js';
import { ALLOWED_PERMISSIONS, APP_ORIGIN, buildCsp, faultArg, IPC, isAppUrl, isDevRun, isExternalAllowed, sanitizeOrigin } from './policy.js';
import type { DisplaySleepGuard } from './power.js';
import { handleAppProtocol, registerAppScheme } from './protocol.js';
import { FAULT_DIALOG_MS, fatalMessage, isLoadFailure, isRendererCrash, READY_FALLBACK_MS, RendererRecovery, type RendererFailure } from './recovery.js';
import { SaveStore } from './save.js';
import { createMainWindow, DesktopStateFile, isDisplayMode, setDisplayMode } from './window.js';

const here = dirname(fileURLToPath(import.meta.url));
/** out/electron/main.js → <app>/dist (im Paket: app.asar/dist). */
const distRoot = resolve(here, '..', '..', 'dist');

function arg(name: string): string | null {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : null;
}

const dev = isDevRun(process.argv, app.isPackaged);
const devUrl = dev ? arg('dev-url') : null;
const devOrigin = devUrl ? sanitizeDevOrigin(devUrl) : null;
const startQuery = dev ? arg('query') : null;
const modeArg = dev ? arg('window-mode') : null;
const fault = faultArg(process.argv, dev);
const userDataArg = arg('user-data');
/** --fault=load…: Port 9 (discard) ist zu → ERR_CONNECTION_REFUSED → did-fail-load. */
const FAULT_URL = 'http://127.0.0.1:9/';

function sanitizeDevOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    // Nur ein lokaler Dev-Server, nie eine fremde Seite mit Bridge-Zugriff.
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') ? u.origin : null;
  } catch {
    return null;
  }
}

interface DesktopConfig {
  readonly supabaseOrigin: string | null;
}

/** Zur Build-Zeit geschrieben (tools/desktop/config.mjs aus .env.local). Fehlt sie: Online am Desktop aus. */
function loadConfig(): DesktopConfig {
  try {
    const raw = JSON.parse(readFileSync(join(here, 'desktop-config.json'), 'utf8')) as { supabaseOrigin?: unknown };
    return { supabaseOrigin: typeof raw.supabaseOrigin === 'string' ? sanitizeOrigin(raw.supabaseOrigin) : null };
  } catch {
    return { supabaseOrigin: null };
  }
}

/** --fault=setup: jedes setup wirft, bevor es Kanäle anlegt (wie ein früher Fehler im Modul, Review C6). */
const modules: readonly DesktopModule[] =
  fault === 'setup'
    ? DESKTOP_MODULES.map((m) => ({
        ...m,
        setup: (): void => {
          throw new Error(`Fehler-Injektion: setup ${m.name}`);
        },
      }))
    : DESKTOP_MODULES;
const runner = new ModuleRunner(modules, (msg, err) => (err === undefined ? console.warn(msg) : console.error(msg, err)));

if (userDataArg) app.setPath('userData', resolve(userDataArg));
const config = loadConfig();
registerAppScheme();
// Ton ohne Geste: am Desktop gibt es keinen Grund für die Autoplay-Sperre (Plan 011 §2.2.6).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Kein App-Menü: entfernt die Standard-Kürzel (Strg+W schließt sonst das Fenster, Strg+R lädt neu).
Menu.setApplicationMenu(null);

let mainWindow: BrowserWindow | null = null;
let save: SaveStore | null = null;
let displaySleep: DisplaySleepGuard | null = null;
let quitting = false;
let fatalShown = false;

/** Zwei Instanzen teilen sich LevelDB (localStorage) — die zweite fokussiert nur die erste. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Vor app.ready und nur in der ersten Instanz: Module setzen Chromium-Schalter (Steam-Overlay, Plan 011 4.2).
  runner.beforeReady({ dev });
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('web-contents-created', (_e, contents) => hardenContents(contents));
  // Fehler aus whenReady UND aus start() (Review C4): nie ein unsichtbarer Prozess, der den Lock hält.
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      console.error('[velocity] Start fehlgeschlagen', err);
      void fatal('start', err instanceof Error ? err.message : String(err));
    });
}

/** Jedes WebContents (auch künftige): keine fremde Navigation, keine neuen Fenster, keine <webview>. */
function hardenContents(contents: WebContents): void {
  const guard = (e: { preventDefault(): void }, url: string): void => {
    if (!isAppUrl(url, devOrigin)) e.preventDefault();
  };
  contents.on('will-navigate', (e) => guard(e, e.url));
  contents.on('will-redirect', (e) => guard(e, e.url));
  contents.on('will-frame-navigate', (e) => guard(e, e.url));
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalAllowed(url, config.supabaseOrigin)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // beforeunload darf das Schließen nicht still abbrechen (sonst tut das Fenster-X nichts, Plan 011 §2.4).
  contents.on('will-prevent-unload', (e) => e.preventDefault());
}

/** IPC nur von der Hauptseite der eigenen Origin (kein Subframe, keine fremde Seite). */
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const f = e.senderFrame;
  return f !== null && f.parent === null && isAppUrl(f.url, devOrigin) && mainWindow !== null && e.sender === mainWindow.webContents;
}

/**
 * Antwortet null auf einen Kanal, den der Preload synchron fragt, falls ihn kein Modul bedient (setup warf vorher) —
 * sonst hinge sendSync und das Fenster bekäme nie ein erstes Bild (Review C6).
 */
function answerSyncIfMissing(channel: string): void {
  if (ipcMain.listenerCount(channel) > 0) return;
  console.warn(`[velocity] Kanal ${channel} ohne Modul — Antwort null`);
  ipcMain.on(channel, (e) => {
    // Ein spät fertiges setup hat sich inzwischen eingetragen: dessen Antwort gilt.
    if (ipcMain.listenerCount(channel) > 1) return;
    e.returnValue = null;
  });
}

/** Aufräumen beim Beenden (will-quit, Fehler-Ende, Abmeldung): Module einmal abmelden, offenen Spielstand schreiben. */
function cleanup(): void {
  runner.dispose();
  displaySleep?.dispose();
  if (save && !save.flushPendingSync()) console.error('[velocity] Spielstand-Spiegel beim Beenden nicht geschrieben');
}

/** Aufgeben: Fehlerdialog, aufräumen, Exit 1. Im Test-Modus (--fault) schließt sich der Dialog selbst. */
async function fatal(kind: RendererFailure | 'start', detail: string): Promise<void> {
  if (fatalShown) return;
  fatalShown = true;
  const message = fatalMessage(kind, detail);
  console.error(`[velocity] Fehlerdialog: ${message}`);
  try {
    await dialog.showMessageBox({
      type: 'error',
      title: 'VELOCITY',
      message,
      buttons: ['Beenden'],
      noLink: true,
      signal: fault ? AbortSignal.timeout(FAULT_DIALOG_MS) : undefined,
    });
  } catch (err) {
    console.error('[velocity] Fehlerdialog nicht anzeigbar', err);
  }
  cleanup();
  app.exit(1);
}

function startUrl(): string {
  const base = devOrigin ? `${devOrigin}/` : `${APP_ORIGIN}/index.html`;
  return startQuery ? `${base}?${startQuery.replace(/^\?/, '')}` : base;
}

/**
 * Renderer-Ausfälle (Review C4): einmal neu laden, sonst Fehlerdialog + Ende. Hängt der Renderer, hilft Laden allein
 * nicht — erst den Prozess beenden (forcefullyCrashRenderer) und laden, sobald dessen render-process-gone da ist.
 * Gemessen: loadURL/reload direkt nach forcefullyCrashRenderer gingen verloren (kein did-finish-load, Seite tot).
 * Dieses render-process-gone zählt nicht als zweiter Fehler.
 */
function watchRenderer(win: BrowserWindow, load: (attempt: number) => void): void {
  const recovery = new RendererRecovery();
  const wc = win.webContents;
  let attempt = 0;
  /** Eigenes Beenden nach einem Hänger läuft: das nächste render-process-gone lädt neu statt zu zählen. */
  let selfKill: ReturnType<typeof setTimeout> | null = null;
  const reloadAfterKill = (): void => {
    if (selfKill !== null) clearTimeout(selfKill);
    selfKill = null;
    if (!win.isDestroyed()) load(attempt);
  };
  /** kill = Hänger: erst den Prozess beenden, geladen wird danach. */
  const failed = (kind: RendererFailure, detail: string, kill = false): void => {
    if (quitting || fatalShown || win.isDestroyed() || selfKill !== null) return;
    const action = recovery.next(Date.now());
    console.error(`[velocity] Renderer ${kind} (${detail}) → ${action === 'reload' ? 'neu laden' : 'aufgeben'}`);
    if (action === 'fatal') {
      void fatal(kind, detail);
      return;
    }
    attempt++;
    if (!kill) {
      load(attempt);
      return;
    }
    // Kommt das Ende nicht (Prozess geteilt/schon weg), trotzdem laden.
    selfKill = setTimeout(reloadAfterKill, 3000);
    wc.forcefullyCrashRenderer();
  };
  wc.on('render-process-gone', (_e, d) => {
    if (selfKill !== null) {
      console.warn(`[velocity] Renderer beendet (${d.reason}) — lädt in neuem Prozess`);
      reloadAfterKill();
      return;
    }
    if (isRendererCrash(d.reason)) failed('gone', `${d.reason}, Code ${d.exitCode}`);
  });
  wc.on('unresponsive', () => failed('unresponsive', 'keine Antwort', true));
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    if (isLoadFailure(code, isMainFrame)) failed('load', `${desc} ${code}`);
  });
}

/** --fault=crash-once/crash/hang: nach dem Laden abstürzen bzw. hängen (Smoke, nur Dev-Modus). */
function injectRendererFault(win: BrowserWindow): void {
  if (fault !== 'crash' && fault !== 'crash-once' && fault !== 'hang') return;
  const wc = win.webContents;
  let fired = false;
  wc.on('did-finish-load', () => {
    if (fault !== 'crash' && fired) return;
    fired = true;
    setTimeout(() => {
      if (win.isDestroyed()) return;
      if (fault !== 'hang') {
        wc.forcefullyCrashRenderer();
        return;
      }
      void wc.executeJavaScript('for (;;) {}').catch(() => undefined);
      // Der Hang-Monitor schlägt erst an, wenn Eingaben unbeantwortet bleiben.
      let n = 0;
      const poke = setInterval(() => {
        if (win.isDestroyed()) clearInterval(poke);
        else wc.sendInputEvent({ type: 'mouseMove', x: 20 + (n++ % 40), y: 20 });
      }, 500);
      wc.once('unresponsive', () => clearInterval(poke));
    }, 500);
  });
}

async function start(): Promise<void> {
  if (fault === 'start') throw new Error('Fehler-Injektion: start');
  const ses = session.defaultSession;
  const csp = buildCsp(config.supabaseOrigin);
  handleAppProtocol(ses, distRoot, csp);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  const userData = app.getPath('userData');
  const state = new DesktopStateFile(userData);
  const store = new SaveStore(userData);
  save = store;

  ipcMain.on(IPC.info, (e) => {
    e.returnValue = trusted(e) && dev;
  });
  ipcMain.on(IPC.quit, (e) => {
    if (trusted(e)) app.quit();
  });
  ipcMain.handle(IPC.windowGet, (e) => {
    if (!trusted(e) || !mainWindow) return state.state.mode;
    return mainWindow.isFullScreen() ? 'fullscreen' : 'windowed';
  });
  ipcMain.handle(IPC.windowSet, (e, mode: unknown) => {
    if (!trusted(e) || !mainWindow || !isDisplayMode(mode)) return state.state.mode;
    return setDisplayMode(mainWindow, state, mode);
  });
  ipcMain.handle(IPC.openExternal, async (e, url: unknown) => {
    if (!trusted(e) || typeof url !== 'string' || !isExternalAllowed(url, config.supabaseOrigin)) return false;
    await shell.openExternal(url);
    return true;
  });
  ipcMain.on(IPC.saveRead, (e) => {
    e.returnValue = trusted(e) ? store.readSync() : null;
  });
  ipcMain.on(IPC.saveWriteSync, (e, json: unknown) => {
    e.returnValue = trusted(e) ? store.writeSync(json) : false;
  });
  ipcMain.handle(IPC.saveWrite, (e, json: unknown) => (trusted(e) ? store.write(json) : false));

  const ctx: DesktopModuleContext = {
    dev,
    userData,
    mainWindow: () => mainWindow,
    handle: (channel, fn) => ipcMain.handle(channel, (e, ...args: unknown[]) => (trusted(e) ? fn(e, ...args) : undefined)),
    // returnValue muss IMMER gesetzt werden — sonst wartet der sendSync-Aufrufer (Preload) vergeblich.
    handleSync: (channel, fn) =>
      ipcMain.on(channel, (e, ...args: unknown[]) => {
        try {
          e.returnValue = trusted(e) ? fn(e, ...args) : null;
        } catch (err) {
          console.error(`[velocity] IPC ${channel} fehlgeschlagen`, err);
          e.returnValue = null;
        }
      }),
  };
  // Ein Modul darf das Fenster nicht aufhalten (Review Phase 2 / C6): alle setups zusammen höchstens
  // MODULE_SETUP_TIMEOUT_MS, ein langsames läuft im Hintergrund zu Ende; seine Sync-Kanäle antworten notfalls null.
  await runner.setup(ctx, MODULE_SETUP_TIMEOUT_MS);
  for (const ch of runner.syncChannels) answerSyncIfMissing(ch);

  const created = createMainWindow({
    preload: join(here, 'preload.cjs'),
    dev,
    state,
    modeOverride: isDisplayMode(modeArg) ? modeArg : null,
  });
  const win = created.win;
  mainWindow = win;
  displaySleep = created.displaySleep;
  // Werkzeuge (Smoke, nur Dev-Modus) prüfen damit powerSaveBlocker.isStarted.
  if (dev) (globalThis as { __velDisplaySleep?: DisplaySleepGuard }).__velDisplaySleep = created.displaySleep;
  win.on('closed', () => {
    mainWindow = null;
  });

  // Windows-Abmeldung/Herunterfahren (Review C5): dort kommt im Renderer kein pagehide. Erst um synchrones Sichern
  // bitten (query-session-end), beim endgültigen Ende den offenen Stand im Hauptprozess selbst schreiben.
  win.on('query-session-end', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.saveFlush);
  });
  win.on('session-end', () => {
    if (!win.isDestroyed()) win.webContents.send(IPC.saveFlush);
    cleanup();
  });

  // Gezeigt wird beim ersten Bild — oder nach READY_FALLBACK_MS trotzdem (Renderer tot vor dem ersten Bild, C4).
  let revealed = false;
  const reveal = (late: boolean): void => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    clearTimeout(fallback);
    if (late) console.warn(`[velocity] Kein erstes Bild nach ${READY_FALLBACK_MS} ms — Fenster wird trotzdem gezeigt`);
    win.show();
    // Jetzt dürfen Module Langsames anstoßen — Steam-init blockiert so nie das Erscheinen des Fensters.
    runner.windowReady(win);
  };
  const fallback = setTimeout(() => reveal(true), READY_FALLBACK_MS);
  if (fault !== 'noshow') win.once('ready-to-show', () => reveal(false));

  const load = (attempt: number): void => {
    const broken = fault === 'load' || (fault === 'load-once' && attempt === 0);
    // Ein Fehlschlag meldet sich über did-fail-load (→ neu laden bzw. Dialog); das abgelehnte Promise ist kein zweiter.
    win.loadURL(broken ? FAULT_URL : startUrl()).catch(() => undefined);
  };
  watchRenderer(win, load);
  injectRendererFault(win);
  load(0);
}

app.on('before-quit', () => {
  quitting = true;
});
// Läuft auch in der Zweitinstanz (ohne setup) — ein Modul darf das Beenden nie abbrechen (ModuleRunner: einmal, try/catch).
app.on('will-quit', () => cleanup());
