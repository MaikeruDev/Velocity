/**
 * Hook-Liste für spätere Hauptprozess-Module (Plan 011 §5: S3 Login `auth.ts`, S4 Steam `steam.ts`).
 * Jedes Modul trägt sich hier ein, statt main.ts umzubauen — so kollidieren parallele Stränge nur in dieser Liste.
 * Der Preload bleibt eine Datei (Sandbox), dort ergänzt jedes Modul sein Bridge-Feld direkt.
 * Ausgeführt werden die Hooks von electron/moduleRunner.ts (Fehler-/Zeitgrenzen, einmaliges dispose).
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

/** Was ein Modul vor app.ready weiß. `dev` = unverpackt + --dev (policy.isDevRun) — im Paket nie. */
export interface DesktopStartInfo {
  readonly dev: boolean;
}

/** So lange wartet main.ts höchstens auf die setups (gemeinsam) — danach kommt das Fenster, die Module laufen weiter. */
export const MODULE_SETUP_TIMEOUT_MS = 3000;

export interface DesktopModule {
  readonly name: string;
  /**
   * Kanäle, die der Preload beim Laden per sendSync fragt. Hat das Modul sie nach setup nicht registriert (setup warf
   * vorher), antwortet main.ts dort mit null — sonst hinge der Preload und das Fenster bekäme nie ein erstes Bild.
   */
  readonly syncChannels?: readonly string[];
  /** Vor app.ready, nur in der ersten Instanz (Chromium-Schalter). Muss schnell sein; Fehler werden geloggt. */
  beforeReady?(info: DesktopStartInfo): void;
  /**
   * Nach app.ready, vor dem Fenster. Fehler werden geloggt, das Spiel startet trotzdem; länger als
   * MODULE_SETUP_TIMEOUT_MS wartet das Fenster nicht. Langsames (Steam-init) gehört nach windowReady.
   */
  setup(ctx: DesktopModuleContext): void | Promise<void>;
  /** Das Fenster zeigt sein erstes Bild (oder der Rückfall nach Zeitlimit greift). Einmal; Fehler werden geloggt. */
  windowReady?(win: BrowserWindow): void;
  /** Beim Beenden — auch in der Zweitinstanz, in der setup nie lief. Einmal; Fehler werden geloggt, nie geworfen. */
  dispose?(): void;
}

/** S3/S4 tragen sich hier ein. */
export const DESKTOP_MODULES: readonly DesktopModule[] = [
  authModule, // S3: Loopback-Login + verschlüsselte Sitzung (electron/authModule.ts)
  steamModule, // S4: Steamworks hinter --steam (electron/steam.ts)
];
