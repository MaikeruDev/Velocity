/**
 * Vertrag des Desktop-Bridges `window.velocityDesktop` (Plan 011 §3, Phase 2).
 *
 * NUR Typen: Die Datei wird vom sandboxed Preload (`electron/preload.cts`, CommonJS) und vom Renderer
 * (`src/platform/desktop.ts`) importiert, aber nie zur Laufzeit gebraucht. So landet kein Electron-Code im
 * Web-Bundle, und der Preload bleibt eine einzige Datei (Sandbox-Preloads dürfen keine eigenen Module laden).
 *
 * Das Objekt existiert nur in der Electron-Hülle. Fehlt es, ist die Plattform `web`.
 */

/**
 * Anzeigemodus des Hauptfensters. Kein eigener "randloser" Modus: Electron/Chromium kennt kein exklusives
 * Vollbild, `setFullScreen(true)` ist unter Windows bereits randloses Vollbild auf dem ganzen Monitor.
 */
export type DisplayMode = 'fullscreen' | 'windowed';

/** Speicher-Spiegel (Plan 011 §2.2.10): `velocity.*`-Schlüssel als JSON unter `userData/save/save.json`. */
export interface DesktopSaveMirror {
  /** Synchron (sendSync) — beim Start, bevor die Stores lesen. null = kein/kaputter Spiegel. */
  readSync(): string | null;
  /** Entprellt aus dem Spiel. false = abgelehnt (zu groß, kein JSON) oder Schreibfehler. */
  write(json: string): Promise<boolean>;
  /** Synchron beim Beenden (pagehide), damit der letzte Stand nicht im Debounce hängen bleibt. */
  writeSync(json: string): boolean;
}

export interface DesktopWindowBridge {
  getMode(): Promise<DisplayMode>;
  /** Setzt und speichert den Modus; Rückgabe = tatsächlich angewandter Modus (nach dem Fenster-Ereignis). */
  setMode(mode: DisplayMode): Promise<DisplayMode>;
}

/**
 * Warum der Desktop-Login (Plan 011 §3.1) keinen Code liefert: ports = alle Login-Ports belegt · url = Adresse nicht
 * erlaubt · open = Browser startet nicht · timeout = keine Rückmeldung in der Frist · denied = im Browser abgebrochen
 * oder abgelehnt · provider = anderer Fehler von Discord/Supabase · cancelled = Versuch ersetzt/abgebrochen.
 */
export type DesktopAuthError = 'ports' | 'url' | 'open' | 'timeout' | 'denied' | 'provider' | 'cancelled';

/** `detail`: fertiger deutscher Satz für die Meldung im Menü. */
export interface DesktopAuthFailure {
  readonly ok: false;
  readonly error: DesktopAuthError;
  readonly detail: string;
}

export type DesktopAuthBegin = { readonly ok: true; readonly redirectUrl: string } | DesktopAuthFailure;
export type DesktopAuthResult = { readonly ok: true; readonly code: string } | DesktopAuthFailure;

/**
 * Supabase-Sitzung (nur dieser EINE Schlüssel) verschlüsselt im Hauptprozess statt im Klartext-localStorage
 * (electron/session.ts, safeStorage). write false = abgelehnt (kein JSON-Objekt, > 64 KB) oder kein OS-Schlüsselspeicher.
 */
export interface DesktopSessionVault {
  read(): Promise<string | null>;
  write(value: string): Promise<boolean>;
  remove(): Promise<boolean>;
}

/** Desktop-Login: System-Browser + Rücksprung auf 127.0.0.1 (electron/auth.ts). Der PKCE-Verifier bleibt im Renderer. */
export interface DesktopAuthBridge {
  /** Empfänger starten (erster freier Login-Port) → Rücksprung-Adresse mit eigenem `state`. */
  begin(): Promise<DesktopAuthBegin>;
  /** Nur die Supabase-Authorize-URL mit genau dieser Rücksprung-Adresse; wartet auf den EINEN Rücksprung (Code). */
  openExternal(url: string): Promise<DesktopAuthResult>;
  /** Laufenden Versuch abbrechen (Empfänger zu). */
  cancel(): void;
  readonly session: DesktopSessionVault;
}

/** Spacewar (Steam-Test-App 480) kennt nur diese Achievements (Plan 011 4.3, Test-Tabelle in achievements.ts). */
export type SpacewarAchievement = 'ACH_WIN_ONE_GAME' | 'ACH_WIN_100_GAMES' | 'ACH_TRAVEL_FAR_ACCUM' | 'ACH_TRAVEL_FAR_SINGLE';

/** Ergebnis von steamworks `init` (electron/steam.ts, Kanal vel:steam:ready). */
export interface DesktopSteamStatus {
  readonly active: boolean;
  /** App-ID der Sitzung (480 = Test-App); null ohne Steam. */
  readonly appId: number | null;
  /** false mit --dev oder Debug-Zugang (--remote-debugging-port, --inspect): dann setzt das Spiel keine Achievements. */
  readonly achievements: boolean;
}

/** Steam (Plan 011 Phase 4) — Feld nur, wenn mit --steam gestartet und steamworks.js ladbar ist. */
export interface DesktopSteamBridge {
  /** Wartet auf init (läuft erst nach dem ersten Bild; Zeitlimit im Hauptprozess). */
  ready(): Promise<DesktopSteamStatus>;
  /** Achievement über den Steam-API-Namen setzen; false = abgelehnt (dev/Debug, 480 ohne Test-ID) oder Fehler. */
  achievement(apiName: string): Promise<boolean>;
  /** Rich Presence Key/Value; value null löscht den Schlüssel. */
  presence(key: string, value: string | null): Promise<boolean>;
  /** Overlay auf/zu (GameOverlayActivated, sofern steamworks.js es meldet). Rückgabe: abmelden. */
  onOverlay(cb: (active: boolean) => void): () => void;
}

export interface DesktopBridge {
  /** Bridge-Version: steigt, wenn sich dieses Interface inkompatibel ändert. */
  readonly version: 1;
  readonly versions: { readonly electron: string; readonly chrome: string };
  /** Mit `--dev` gestartet (DevTools, Dev-Parameter erlaubt). */
  readonly dev: boolean;
  /** Programm beenden (sofort, ohne Rückfrage). */
  quit(): void;
  readonly window: DesktopWindowBridge;
  /** Nur https-Adressen der Allowlist (Discord, eigenes Supabase) im System-Browser; sonst false. */
  openExternal(url: string): Promise<boolean>;
  readonly saveMirror: DesktopSaveMirror;
  /** Desktop-Login (Plan 011 §3.1); optional, damit ein Bridge ohne Login-Modul gültig bleibt. */
  readonly auth?: DesktopAuthBridge;
  /** Steamworks (Plan 011 Phase 4, electron/steam.ts); fehlt ohne --steam bzw. ohne ladbares steamworks.js. */
  readonly steam?: DesktopSteamBridge;
}

/** Name der globalen Eigenschaft (Preload und Renderer schreiben ihn je selbst aus — keine Laufzeit-Importe). */
export type DesktopBridgeKey = 'velocityDesktop';
