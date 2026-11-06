/**
 * Hook-Liste für spätere Hauptprozess-Module (Plan 011 §5: S3 Login `auth.ts`, S4 Steam `steam.ts`).
 * Jedes Modul trägt sich hier ein, statt main.ts umzubauen — so kollidieren parallele Stränge nur in dieser Liste.
 * Der Preload bleibt eine Datei (Sandbox), dort ergänzt jedes Modul sein Bridge-Feld direkt.
 */
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { authModule } from './authModule.js';
import { steamModule } from './steam.js';

export interface DesktopModuleContext {
  readonly dev: boolean;
  readonly userData: string;
  /** Hauptfenster (null vor dem Erzeugen / nach dem Schließen). */
  mainWindow(): BrowserWindow | null;
  /** IPC-Handler mit Absender-Prüfung (nur die eigene Seite darf rufen). */
  handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
  /** Synchroner IPC (sendSync, z. B. aus dem Preload) mit derselben Prüfung; fremde Absender/Fehler → null. */
  handleSync(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => unknown): void;
}

/** So lange wartet main.ts höchstens auf ein `setup` — danach kommt das Fenster, das Modul läuft weiter. */
export const MODULE_SETUP_TIMEOUT_MS = 3000;

export interface DesktopModule {
  readonly name: string;
  /** Vor app.ready, nur in der ersten Instanz (Chromium-Schalter). Muss schnell sein; Fehler werden geloggt. */
  beforeReady?(): void;
  /**
   * Nach app.ready, vor dem Fenster. Fehler werden geloggt, das Spiel startet trotzdem; länger als
   * MODULE_SETUP_TIMEOUT_MS wartet das Fenster nicht. Langsames (Steam-init) gehört nach windowReady.
   */
  setup(ctx: DesktopModuleContext): void | Promise<void>;
  /** Das Fenster zeigt sein erstes Bild. Fehler werden geloggt. */
  windowReady?(win: BrowserWindow): void;
  /** Beim Beenden — auch in der Zweitinstanz, in der setup nie lief. Fehler werden geloggt, nie geworfen. */
  dispose?(): void;
}

/** S3/S4 tragen sich hier ein. */
export const DESKTOP_MODULES: readonly DesktopModule[] = [
  authModule, // S3: Loopback-Login + verschlüsselte Sitzung (electron/authModule.ts)
  steamModule, // S4: Steamworks hinter --steam (electron/steam.ts)
];
