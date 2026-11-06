/**
 * Steamworks-Gerüst im Hauptprozess (Plan 011 Phase 4, S4).
 *
 * - Nur mit `--steam` oder VELOCITY_STEAM=1. steamworks.js wird vor app.ready per require in try/catch geladen (nur
 *   das Binding, kein Kontakt zum Client), `init(480)` läuft erst, wenn das Fenster sein erstes Bild zeigt:
 *   SteamAPI_Init ist synchron und kann bei einem startenden Client dauern — das Fenster wartet nie darauf (Review
 *   Phase 2). Scheitert Laden oder init, läuft das Spiel ohne Steam weiter: genau EIN Log-Eintrag, kein Steam im
 *   Renderer (caps.steam bleibt false).
 * - Overlay-Schalter (steamworks.js `electronEnableSteamOverlay`: in-process-gpu, disable-direct-composition,
 *   Neuzeichnen je Frame) nur mit Steam-Flag und ladbarem Modul — sie können Frametime kosten (Plan 4.2).
 * - Achievements nie mit `--dev` oder Debug-Zugang (--remote-debugging-port/-pipe, --inspect…): darüber erreicht man
 *   window.__vel und das Bridge-Objekt direkt (Review Phase 2). Rich Presence und Overlay bleiben.
 * - App 480 (Spacewar): nur dessen Test-IDs — die Abbildung macht src/platform/achievements.ts, hier nur die Prüfung.
 *
 * Ohne Electron-Laufzeitimport: Fenster und IPC kommen über den Modul-Kontext, das Binding über `load` — Vitest prüft
 * das Modul mit dem Fake (createSteamModule), die Hülle mit `--dev --steam --steam-fake[=fail]` (steamFake.ts).
 */
import { createRequire } from 'node:module';
import type { DesktopSteamStatus, SpacewarAchievement } from '../src/platform/bridgeTypes.js';
import type { DesktopModule } from './modules.js';
import { createFakeSteamworks } from './steamFake.js';

/** Steam-Test-App (Spacewar) — eigene App-ID ist eine offene Betreiber-Frage (Plan 011 §8.1). */
export const STEAM_APP_ID = 480;
/** So lange wartet ein `ready()` des Renderers höchstens auf init; danach gilt: ohne Steam. */
export const STEAM_READY_TIMEOUT_MS = 15000;

/** IPC-Kanäle (gespiegelt in preload.cts, das als Sandbox-Preload nichts importieren darf). */
export const STEAM_IPC = {
  /** sendSync → boolean: Steam angefordert und Binding geladen (Preload legt dann das Bridge-Feld an). */
  requested: 'vel:steam:requested',
  /** invoke → DesktopSteamStatus, sobald init durch ist (oder nach STEAM_READY_TIMEOUT_MS). */
  ready: 'vel:steam:ready',
  achievement: 'vel:steam:achievement',
  presence: 'vel:steam:presence',
  /** Hauptprozess → Renderer: Overlay auf (true) / zu (false). */
  overlay: 'vel:steam:overlay',
} as const;

/** Was wir von steamworks.js (0.4.0) brauchen; der Fake erfüllt dasselbe. */
export interface SteamClientLike {
  readonly achievement: { activate(name: string): boolean };
  readonly localplayer: { setRichPresence(key: string, value?: string | null): void };
  readonly utils: { getAppId(): number };
  readonly callback: { register(callback: number, handler: (value: unknown) => void): { disconnect(): void } };
}

export interface SteamworksLike {
  init(appId: number): SteamClientLike;
  electronEnableSteamOverlay(disableEachFrameInvalidation?: boolean): void;
  readonly SteamCallback: Readonly<Record<string, unknown>>;
}

/** off = nicht angefordert · real = steamworks.js · fake/fake-fail = Fake (nur mit --dev) · blocked = Fake ohne --dev. */
export type SteamMode = 'off' | 'real' | 'fake' | 'fake-fail' | 'blocked';

export function steamMode(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): SteamMode {
  if (!argv.includes('--steam') && env.VELOCITY_STEAM !== '1') return 'off';
  const fake = argv.find((a) => a === '--steam-fake' || a.startsWith('--steam-fake='));
  if (fake === undefined) return 'real';
  // Wer einen Fake verlangt, bekommt NIE stillschweigend das echte Modul (sonst "Spielt Spacewar" beim Testen).
  if (!argv.includes('--dev')) return 'blocked';
  return fake === '--steam-fake=fail' ? 'fake-fail' : 'fake';
}

const DEBUG_ARG = /^--(remote-debugging-(port|pipe|address)|inspect(-brk|-port|-publish-uid)?|debug(-brk)?)(=|$)/;

/** CDP-/Inspector-Zugang im argv (Playwright startet so, ebenso --remote-debugging-port an der exe). */
export function hasDebugAccess(argv: readonly string[]): boolean {
  return argv.some((a) => DEBUG_ARG.test(a));
}

const SPACEWAR: Readonly<Record<SpacewarAchievement, true>> = {
  ACH_WIN_ONE_GAME: true,
  ACH_WIN_100_GAMES: true,
  ACH_TRAVEL_FAR_ACCUM: true,
  ACH_TRAVEL_FAR_SINGLE: true,
};

export function isSpacewarAchievement(name: string): name is SpacewarAchievement {
  return Object.hasOwn(SPACEWAR, name);
}

const ACHIEVEMENT_NAME = /^[A-Za-z0-9_]{1,128}$/;
/** Steam: Schlüssel höchstens 64 Zeichen (k_cchMaxRichPresenceKeyLength); wir nehmen nur kleine ASCII-Namen. */
const PRESENCE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
/** Steam: Wert höchstens 256 Byte inklusive Nullbyte (k_cchMaxRichPresenceValueLength). */
const PRESENCE_VALUE_MAX_BYTES = 255;
/** Steuerzeichen haben in einem Freundeslisten-Text nichts verloren (Zeilenumbrüche zerlegten die Anzeige). */
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isFn = (v: unknown): boolean => typeof v === 'function';

function isSteamworks(m: unknown): m is SteamworksLike {
  return isRecord(m) && isFn(m.init) && isFn(m.electronEnableSteamOverlay) && isRecord(m.SteamCallback);
}

function isSteamClient(c: unknown): c is SteamClientLike {
  return (
    isRecord(c) &&
    isRecord(c.achievement) && isFn(c.achievement.activate) &&
    isRecord(c.localplayer) && isFn(c.localplayer.setRichPresence) &&
    isRecord(c.utils) && isFn(c.utils.getAppId) &&
    isRecord(c.callback) && isFn(c.callback.register)
  );
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200);

export interface SteamModuleDeps {
  /** process.argv + execArgv (Flags, Debug-Zugang). */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Lädt steamworks.js (Standard: require). Nur im Modus 'real' aufgerufen; ein Wurf = ohne Steam. */
  readonly load: () => unknown;
  readonly log: (msg: string) => void;
  /** Aufschub für init nach dem ersten Bild (Standard: setImmediate). */
  readonly defer?: (fn: () => void) => void;
  /** Ersatz für den eingebauten Fake (Tests). */
  readonly fake?: (failInit: boolean) => SteamworksLike;
}

/** Was das Steam-Modul vom Fenster braucht (BrowserWindow erfüllt es). */
export interface SteamWindowLike {
  isDestroyed(): boolean;
  readonly webContents: { send(channel: string, ...args: unknown[]): void };
}

/** Schmaler Ausschnitt aus DesktopModuleContext — Tests geben ein Fake, ohne Electron. */
export interface SteamContext {
  readonly dev: boolean;
  mainWindow(): SteamWindowLike | null;
  handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void;
  handleSync(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface SteamModule extends DesktopModule {
  /** DesktopModuleContext erfüllt SteamContext. */
  setup(ctx: SteamContext): void;
  /** Das Fenster selbst braucht das Modul nicht (Overlay-Ereignisse gehen über ctx.mainWindow). */
  windowReady(): void;
  /** Stand jetzt (Tests, Werkzeuge). */
  status(): DesktopSteamStatus;
  /** Gewählter Modus (nach beforeReady). */
  readonly mode: SteamMode;
}

export function createSteamModule(deps: SteamModuleDeps): SteamModule {
  let mode: SteamMode = 'off';
  let sw: SteamworksLike | null = null;
  let client: SteamClientLike | null = null;
  let appId: number | null = null;
  let achievementsAllowed = false;
  let overlayHandle: { disconnect(): void } | null = null;
  let ctxRef: SteamContext | null = null;
  let settled = false;
  let markSettled: () => void = () => {};
  const settledP = new Promise<void>((resolve) => {
    markSettled = resolve;
  });

  const settle = (): void => {
    settled = true;
    markSettled();
  };
  /** Der eine Log-Eintrag, wenn Steam angefordert war, aber nicht geht. */
  const unavailable = (stage: string, err: unknown): void => {
    sw = null;
    client = null;
    deps.log(`[velocity] Steam nicht verfügbar (${stage}: ${message(err)}) — Spiel läuft ohne Steam`);
    settle();
  };
  const status = (): DesktopSteamStatus => ({
    active: client !== null,
    appId: client !== null ? appId : null,
    achievements: client !== null && achievementsAllowed,
  });

  const sendOverlay = (active: boolean): void => {
    const w = ctxRef?.mainWindow() ?? null;
    if (w && !w.isDestroyed()) w.webContents.send(STEAM_IPC.overlay, active);
  };

  const init = (): void => {
    const mod = sw;
    if (mod === null || settled) return;
    let c: unknown;
    try {
      c = mod.init(STEAM_APP_ID);
      if (!isSteamClient(c)) throw new Error('unerwartete Client-Form');
    } catch (err) {
      unavailable('init', err);
      return;
    }
    client = c;
    let id: number = STEAM_APP_ID;
    try {
      const got = c.utils.getAppId();
      if (Number.isInteger(got) && got > 0) id = got;
    } catch {
      // App-ID nicht lesbar: bei der angefragten bleiben.
    }
    appId = id;
    // steamworks.js 0.4.0 kennt GameOverlayActivated nicht (nur 10 Callbacks) — ein Build mit dem Callback meldet es.
    const cb = mod.SteamCallback.GameOverlayActivated;
    let overlayEvent = false;
    if (typeof cb === 'number') {
      try {
        overlayHandle = c.callback.register(cb, (v) => sendOverlay(isRecord(v) && v.active === true));
        overlayEvent = true;
      } catch {
        overlayHandle = null;
      }
    }
    deps.log(
      `[velocity] Steam aktiv: App ${id}, Achievements ${achievementsAllowed ? 'an' : 'aus (--dev/Debug-Zugang)'}, ` +
        `Overlay-Ereignis ${overlayEvent ? 'ja' : 'nein (fehlt in steamworks.js)'}`,
    );
    settle();
  };

  const activate = (name: unknown): boolean => {
    if (client === null || !achievementsAllowed || typeof name !== 'string' || !ACHIEVEMENT_NAME.test(name)) return false;
    // Test-App: nur Spacewar-Namen (echte eigene IDs gibt es dort nicht; ein Tippfehler setzte sonst nichts Sinnvolles).
    if (appId === STEAM_APP_ID && !isSpacewarAchievement(name)) return false;
    try {
      return client.achievement.activate(name) === true;
    } catch {
      return false;
    }
  };

  const presence = (key: unknown, value: unknown): boolean => {
    if (client === null || typeof key !== 'string' || !PRESENCE_KEY.test(key)) return false;
    if (value !== null && (typeof value !== 'string' || CONTROL_CHAR.test(value) || Buffer.byteLength(value, 'utf8') > PRESENCE_VALUE_MAX_BYTES)) return false;
    try {
      client.localplayer.setRichPresence(key, value);
      return true;
    } catch {
      return false;
    }
  };

  const waitReady = async (): Promise<DesktopSteamStatus> => {
    if (!settled) {
      const timer: { id: ReturnType<typeof setTimeout> | null } = { id: null };
      await Promise.race([settledP, new Promise<void>((r) => (timer.id = setTimeout(r, STEAM_READY_TIMEOUT_MS)))]);
      if (timer.id !== null) clearTimeout(timer.id);
    }
    return status();
  };

  return {
    name: 'steam',
    get mode() {
      return mode;
    },
    status,
    beforeReady() {
      mode = steamMode(deps.argv, deps.env);
      if (mode === 'off') {
        settle();
        return;
      }
      if (mode === 'blocked') {
        deps.log('[velocity] --steam-fake gilt nur mit --dev — Steam bleibt aus');
        settle();
        return;
      }
      const makeFake = deps.fake ?? ((fail: boolean): SteamworksLike => createFakeSteamworks({ failInit: fail }));
      let mod: unknown;
      try {
        mod = mode === 'real' ? deps.load() : makeFake(mode === 'fake-fail');
        if (!isSteamworks(mod)) throw new Error('unerwartete Modulform');
      } catch (err) {
        unavailable('laden', err);
        return;
      }
      sw = mod;
      try {
        // Muss vor app.ready laufen (Chromium-Schalter) — deshalb hier und nicht erst nach init.
        mod.electronEnableSteamOverlay();
      } catch (err) {
        deps.log(`[velocity] Steam-Overlay-Schalter nicht gesetzt: ${message(err)}`);
      }
    },
    setup(ctx) {
      ctxRef = ctx;
      achievementsAllowed = !ctx.dev && !hasDebugAccess(deps.argv);
      // Immer registrieren: der Preload fragt bei jedem Laden synchron (ohne Antwort hinge er).
      ctx.handleSync(STEAM_IPC.requested, () => sw !== null);
      ctx.handle(STEAM_IPC.ready, () => waitReady());
      ctx.handle(STEAM_IPC.achievement, (_e, name) => activate(name));
      ctx.handle(STEAM_IPC.presence, (_e, key, value) => presence(key, value));
    },
    windowReady() {
      if (sw === null || settled) return;
      // Nach dem Zeigen: das erste Bild steht, bevor SteamAPI_Init den Hauptprozess belegt.
      (deps.defer ?? ((fn: () => void) => void setImmediate(fn)))(init);
    },
    dispose() {
      // Läuft auch in der Zweitinstanz (ohne setup/init) — dann gibt es nichts zu lösen.
      try {
        overlayHandle?.disconnect();
      } catch {
        // beim Beenden egal
      }
      overlayHandle = null;
    },
  };
}

const req = createRequire(import.meta.url);

/** Das Modul der Hülle (electron/modules.ts). */
export const steamModule: SteamModule = createSteamModule({
  argv: [...process.argv, ...process.execArgv],
  env: process.env,
  load: () => req('steamworks.js'),
  log: (m) => console.log(m),
});
