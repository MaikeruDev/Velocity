/**
 * Hauptfenster + Anzeigemodus (Plan 011 Schritt 2.3, Hauptprozess-Seite). Modus und Fenstergröße liegen in
 * `userData/desktop.json`. Vollbild macht der Hauptprozess — keine Geste, kein Keyboard Lock nötig.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, screen, type Rectangle } from 'electron';
import type { DisplayMode } from '../src/platform/bridgeTypes.js';

export const MIN_WIDTH = 1280;
export const MIN_HEIGHT = 720;

export interface DesktopState {
  mode: DisplayMode;
  /** Fenster-Bounds im Fenstermodus (null = zentriert, Standardgröße). */
  bounds: Rectangle | null;
}

const DEFAULT_STATE: DesktopState = { mode: 'fullscreen', bounds: null };

export function isDisplayMode(v: unknown): v is DisplayMode {
  return v === 'fullscreen' || v === 'windowed';
}

function isRect(v: unknown): v is Rectangle {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]));
}

export class DesktopStateFile {
  private readonly file: string;
  state: DesktopState;

  constructor(userData: string) {
    this.file = join(userData, 'desktop.json');
    this.state = this.load();
  }

  private load(): DesktopState {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { mode?: unknown; bounds?: unknown };
      return { mode: isDisplayMode(raw.mode) ? raw.mode : DEFAULT_STATE.mode, bounds: isRect(raw.bounds) ? raw.bounds : null };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.file);
    } catch {
      // Nicht schreibbar (Rechte): Modus gilt nur für diese Sitzung.
    }
  }
}

/** Gespeicherte Bounds nur nehmen, wenn sie noch auf einem Monitor liegen (Monitor abgesteckt). */
function visibleBounds(b: Rectangle | null): Rectangle | null {
  if (!b) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const overlapW = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  const overlapH = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
  return overlapW >= 200 && overlapH >= 100 ? b : null;
}

export interface MainWindowOptions {
  readonly preload: string;
  readonly dev: boolean;
  readonly state: DesktopStateFile;
  /** Startmodus nur für diese Sitzung überschreiben (Smoke-Test, `--window-mode`), nicht gespeichert. */
  readonly modeOverride: DisplayMode | null;
}

export function createMainWindow(o: MainWindowOptions): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  // Kleine Monitore (unter 1280×720 Arbeitsfläche) dürfen das Minimum nicht unerfüllbar machen.
  const minW = Math.min(MIN_WIDTH, area.width);
  const minH = Math.min(MIN_HEIGHT, area.height);
  const b = visibleBounds(o.state.state.bounds);
  const mode = o.modeOverride ?? o.state.state.mode;
  const win = new BrowserWindow({
    title: 'VELOCITY',
    width: b?.width ?? Math.max(minW, Math.min(1600, area.width)),
    height: b?.height ?? Math.max(minH, Math.min(900, area.height)),
    ...(b ? { x: b.x, y: b.y } : {}),
    minWidth: minW,
    minHeight: minH,
    fullscreen: mode === 'fullscreen',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: o.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: o.dev,
      // Spiel läuft weiter, wenn das Fenster kurz verdeckt ist (Pause regelt das Spiel selbst über Blur).
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // Bounds nur im Fenstermodus merken (getNormalBounds liefert auch aus dem Vollbild die Fenstergröße).
  win.on('close', () => {
    o.state.state.bounds = win.getNormalBounds();
    o.state.save();
  });
  return win;
}

/** Modus anwenden und speichern; löst auf, sobald das Fenster den Wechsel gemeldet hat (max. 1.5 s). */
export function setDisplayMode(win: BrowserWindow, state: DesktopStateFile, mode: DisplayMode): Promise<DisplayMode> {
  state.state.mode = mode;
  state.save();
  const want = mode === 'fullscreen';
  if (win.isFullScreen() === want) return Promise.resolve(mode);
  return new Promise((done) => {
    const ev = want ? 'enter-full-screen' : 'leave-full-screen';
    const finish = (): void => {
      clearTimeout(t);
      win.removeListener(ev as 'enter-full-screen', finish);
      done(win.isFullScreen() ? 'fullscreen' : 'windowed');
    };
    const t = setTimeout(finish, 1500);
    win.once(ev as 'enter-full-screen', finish);
    win.setFullScreen(want);
  });
}
