/**
 * Electron-Hauptprozess der Desktop-Hülle (Plan 011 Phase 2, Windows). Lädt DIESELBE Vite-`dist/` wie Vercel
 * über `app://velocity/`. Sicherheit: contextIsolation + sandbox, kein nodeIntegration, kein App-Menü
 * (entfernt Strg+W/Strg+R/Strg+Shift+I/Alt), Navigation und neue Fenster gesperrt, CSP als Header,
 * nur pointerLock/fullscreen/keyboardLock. DevTools nur mit --dev.
 *
 * Schalter:
 *   --dev                 DevTools, Dev-Parameter (--dev-url, --query, --window-mode)
 *   --dev-url=<url>       statt app:// den Vite-Dev-Server laden (desktop:dev)
 *   --query=<qs>          Query an die Start-URL hängen (Smoke-Test: online=mock)
 *   --window-mode=<m>     Startmodus nur für diese Sitzung (fullscreen|windowed)
 *   --user-data=<dir>     eigenes userData-Verzeichnis (Smoke-Test, getrennte Spielstände)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, Menu, session, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { DESKTOP_MODULES, MODULE_SETUP_TIMEOUT_MS, type DesktopModuleContext } from './modules.js';
import { ALLOWED_PERMISSIONS, APP_ORIGIN, buildCsp, IPC, isAppUrl, isExternalAllowed, sanitizeOrigin } from './policy.js';
import { handleAppProtocol, registerAppScheme } from './protocol.js';
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

const dev = process.argv.includes('--dev');
const devUrl = dev ? arg('dev-url') : null;
const devOrigin = devUrl ? sanitizeDevOrigin(devUrl) : null;
const startQuery = dev ? arg('query') : null;
const modeArg = dev ? arg('window-mode') : null;
const userDataArg = arg('user-data');

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

if (userDataArg) app.setPath('userData', resolve(userDataArg));
const config = loadConfig();
registerAppScheme();
// Ton ohne Geste: am Desktop gibt es keinen Grund für die Autoplay-Sperre (Plan 011 §2.2.6).
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Kein App-Menü: entfernt die Standard-Kürzel (Strg+W schließt sonst das Fenster, Strg+R lädt neu).
Menu.setApplicationMenu(null);

let mainWindow: BrowserWindow | null = null;

/** Zwei Instanzen teilen sich LevelDB (localStorage) — die zweite fokussiert nur die erste. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Vor app.ready und nur in der ersten Instanz: Module setzen Chromium-Schalter (Steam-Overlay, Plan 011 4.2).
  for (const m of DESKTOP_MODULES) {
    try {
      m.beforeReady?.();
    } catch (err) {
      console.error(`[velocity] Modul ${m.name} (vor dem Start) fehlgeschlagen`, err);
    }
  }
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('web-contents-created', (_e, contents) => hardenContents(contents));
  app.whenReady().then(start, (err: unknown) => {
    console.error('[velocity] Start fehlgeschlagen', err);
    app.exit(1);
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

async function start(): Promise<void> {
  const ses = session.defaultSession;
  const csp = buildCsp(config.supabaseOrigin);
  handleAppProtocol(ses, distRoot, csp);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

  const userData = app.getPath('userData');
  const state = new DesktopStateFile(userData);
  const save = new SaveStore(userData);

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
    e.returnValue = trusted(e) ? save.readSync() : null;
  });
  ipcMain.on(IPC.saveWriteSync, (e, json: unknown) => {
    e.returnValue = trusted(e) ? save.writeSync(json) : false;
  });
  ipcMain.handle(IPC.saveWrite, (e, json: unknown) => (trusted(e) ? save.write(json) : false));

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
  // Ein Modul darf das Fenster nicht aufhalten (Review Phase 2): höchstens MODULE_SETUP_TIMEOUT_MS warten, ein
  // langsames setup läuft im Hintergrund zu Ende. Ein synchron hängendes setup hält trotzdem alles an — deshalb
  // gehört Langsames (Steam-init) in windowReady.
  for (const m of DESKTOP_MODULES) {
    const run = Promise.resolve()
      .then(() => m.setup(ctx))
      .then(
        () => true,
        (err: unknown) => {
          console.error(`[velocity] Modul ${m.name} nicht geladen`, err);
          return true;
        },
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([run, new Promise<false>((r) => (timer = setTimeout(() => r(false), MODULE_SETUP_TIMEOUT_MS)))]);
    clearTimeout(timer);
    if (!done) console.warn(`[velocity] Modul ${m.name}: setup braucht länger als ${MODULE_SETUP_TIMEOUT_MS} ms — Fenster startet ohne es`);
  }

  const win = createMainWindow({
    preload: join(here, 'preload.cjs'),
    dev,
    state,
    modeOverride: isDisplayMode(modeArg) ? modeArg : null,
  });
  mainWindow = win;
  win.on('closed', () => {
    mainWindow = null;
  });
  // Erstes Bild steht (window.ts zeigt das Fenster im selben Ereignis, vorher registriert): jetzt dürfen Module
  // Langsames anstoßen — Steam-init blockiert so nie das Erscheinen des Fensters.
  win.once('ready-to-show', () => {
    for (const m of DESKTOP_MODULES) {
      try {
        m.windowReady?.(win);
      } catch (err) {
        console.error(`[velocity] Modul ${m.name}: windowReady fehlgeschlagen`, err);
      }
    }
  });
  const base = devOrigin ? `${devOrigin}/` : `${APP_ORIGIN}/index.html`;
  await win.loadURL(startQuery ? `${base}?${startQuery.replace(/^\?/, '')}` : base);
}

app.on('will-quit', () => {
  // Läuft auch in der Zweitinstanz (ohne setup) — ein Modul darf das Beenden nie abbrechen.
  for (const m of DESKTOP_MODULES) {
    try {
      m.dispose?.();
    } catch (err) {
      console.error(`[velocity] Modul ${m.name}: dispose fehlgeschlagen`, err);
    }
  }
});
