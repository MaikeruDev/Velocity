/**
 * Plattform-Schicht (Plan 011 §2.1/§3): alles Desktop-Spezifische hinter einem Interface, Web ist der Default.
 * Spiel/Menü/Input reden nur mit `PlatformApi` (Verdrahtung in main.ts kommt mit S2b). Login (S3) und Steam (S4)
 * ergänzen später optionale Felder.
 */
import type { DesktopAuthBridge, DesktopSaveMirror, DisplayMode } from './bridgeTypes';

export type { DisplayMode } from './bridgeTypes';
export type { DesktopAuthBegin, DesktopAuthError, DesktopAuthFailure, DesktopAuthResult, DesktopSessionVault } from './bridgeTypes';

/** Desktop-Login (Plan 011 §3.1): System-Browser + Rücksprung auf 127.0.0.1 — dieselbe Form wie das Bridge-Feld. */
export type PlatformAuth = DesktopAuthBridge;

export type PlatformKind = 'web' | 'desktop';

/** Was die Plattform kann — die UI blendet danach Einträge ein/aus (z. B. "Beenden" nur am Desktop). */
export interface PlatformCaps {
  /** Programm beenden ist möglich. */
  readonly quit: boolean;
  /** Anzeigemodus über das Hauptprozess-Fenster (statt Browser-Vollbild mit Geste). */
  readonly displayMode: boolean;
  /** Speicherstände werden in eine Datei gespiegelt. */
  readonly saveMirror: boolean;
  /** Steamworks läuft (nach init, Plan 011 Phase 4) — davor und ohne Steam false. */
  readonly steam: boolean;
}

/** Steam-Sitzung nach erfolgreichem init (Plan 011 Phase 4). */
export interface PlatformSteamSession {
  readonly appId: number;
  /** false mit --dev oder Debug-Zugang (CDP) — dann setzt das Spiel keine Achievements (Review Phase 2). */
  readonly achievements: boolean;
  unlockAchievement(apiName: string): Promise<boolean>;
  /** Rich Presence Key/Value; null löscht den Schlüssel. */
  setPresence(key: string, value: string | null): Promise<boolean>;
  /** Overlay auf/zu. Rückgabe: abmelden. */
  onOverlay(cb: (active: boolean) => void): () => void;
}

/** Steam angefordert (--steam, Binding ladbar). Ob es läuft, sagt erst ready() — init kommt nach dem ersten Bild. */
export interface PlatformSteam {
  /** null = ohne Steam (Client fehlt, init gescheitert, Zeitlimit). Mehrfach aufrufbar, fragt nur einmal. */
  ready(): Promise<PlatformSteamSession | null>;
}

export interface PlatformWindow {
  getMode(): Promise<DisplayMode>;
  setMode(mode: DisplayMode): Promise<DisplayMode>;
}

export interface PlatformApi {
  readonly kind: PlatformKind;
  readonly caps: PlatformCaps;
  /** Desktop mit `--dev` (Admin/Dev-Parameter erlaubt, Plan 011 §2.2.13). Web: immer false. */
  readonly dev: boolean;
  /** Electron-/Chromium-Version (Determinismus-Protokoll, 2.6); im Web null. */
  readonly versions: { readonly electron: string; readonly chrome: string } | null;
  /** Web: no-op. */
  quit(): void;
  /** Web: null (Vollbild bleibt Browser-Sache mit Geste). */
  readonly window: PlatformWindow | null;
  /** Externe Seite öffnen. Desktop: System-Browser mit Allowlist; Web: neuer Tab. */
  openExternal(url: string): Promise<boolean>;
  /** Web: null. */
  readonly saveMirror: DesktopSaveMirror | null;
  /** Desktop-Login über System-Browser + Loopback (S3). Web: null — dort bleibt der Seiten-Redirect. */
  readonly auth: PlatformAuth | null;
  /** Steamworks (S4): nur am Desktop mit --steam. Web und Desktop ohne Steam: null. */
  readonly steam: PlatformSteam | null;
}
