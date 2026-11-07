/**
 * Reine Sicherheits-/Protokoll-Regeln der Desktop-Hülle (Plan 011 §2.1) — ohne Electron-Import,
 * damit Vitest sie direkt prüfen kann (tests/desktopPolicy.test.ts).
 */
import { extname, resolve, sep } from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'velocity';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** Nur diese Browser-Berechtigungen bekommt das Spiel (Rest: abgelehnt). */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['pointerLock', 'fullscreen', 'keyboardLock']);

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * `app://velocity/<pfad>` → absolute Datei unter `root`, oder null (fremder Host, Pfad-Ausbruch).
 * Query/Hash zählen nicht (`?online=mock` lädt index.html). "/" → index.html.
 */
export function resolveAppPath(root: string, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  // ':' gibt es in dist/ nie — sperrt Laufwerkspfade und NTFS-Datenströme (index.html::$DATA).
  if (p.includes('\0') || p.includes(':')) return null;
  if (p === '' || p === '/') p = '/index.html';
  const base = resolve(root);
  const full = resolve(base, `.${p}`);
  // Ausbruch per ../ oder absolutem Laufwerkspfad verhindern.
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/**
 * Content-Security-Policy als Antwort-Header des Protokolls. `supabaseOrigin` kommt zur Build-Zeit aus
 * .env.local (tools/desktop/config.mjs); ohne ihn ist Online am Desktop aus (das Spiel fällt auf offline zurück).
 * style-src 'unsafe-inline': Menüs und lil-gui setzen Inline-Styles; Skripte dagegen nur aus dem Paket.
 */
export function buildCsp(supabaseOrigin: string | null): string {
  const sb = supabaseOrigin ? ` ${supabaseOrigin} ${supabaseOrigin.replace(/^https:/, 'wss:')}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://cdn.discordapp.com",
    `connect-src 'self'${sb}`,
    // data: — Vite bettet kleine woff-Dateien (< 4 KB, assetsInlineLimit) als data:-URL ins CSS ein.
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Nur ein https-Ursprung ohne Pfad wird als Supabase-Origin akzeptiert (sonst null). */
export function sanitizeOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Darf die Seite dorthin navigieren? Nur die eigene Origin (bzw. der Dev-Server). */
export function isAppUrl(url: string, devOrigin: string | null): boolean {
  try {
    const o = new URL(url).origin;
    // Eigene Schemes liefern origin "null" in Node — daher Präfixvergleich.
    return url.startsWith(`${APP_ORIGIN}/`) || url === APP_ORIGIN || (devOrigin !== null && o === devOrigin);
  } catch {
    return false;
  }
}

/** Externe Seiten im System-Browser: nur https auf Discord und dem eigenen Supabase. */
export function isExternalAllowed(url: string, supabaseOrigin: string | null): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  if (h === 'discord.com' || h.endsWith('.discord.com')) return true;
  return supabaseOrigin !== null && u.origin === supabaseOrigin;
}

/**
 * Dev-Modus (DevTools, Admin, F8, `__vel`, --query/--dev-url/--window-mode, Fehler-Injektion) nur UNVERPACKT
 * (`electron .`): im Paket ist `--dev` bloß eine Steam-Startoption, die jeder Spieler setzen kann (Review C1).
 */
export function isDevRun(argv: readonly string[], packaged: boolean): boolean {
  return !packaged && argv.includes('--dev');
}

/** Was der Hauptprozess von einer Taste wissen muss (Electron `Input` aus before-input-event erfüllt es). */
export interface KeyInputLike {
  readonly type: string;
  readonly key: string;
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly isAutoRepeat: boolean;
}

/**
 * Alt+Enter und F11 schalten den Anzeigemodus — das App-Menü, das solche Kürzel sonst trüge, gibt es nicht
 * (Strg+W/Strg+R/F5/Strg+Shift+I bleiben deshalb wirkungslos). Gehaltene Tasten zählen einmal (Review C7).
 */
export function isDisplayModeToggle(i: KeyInputLike): boolean {
  if (i.type !== 'keyDown' || i.isAutoRepeat || i.control || i.meta || i.shift) return false;
  return i.key === 'F11' ? !i.alt : i.key === 'Enter' && i.alt;
}

/**
 * Fehler-Injektion für den Desktop-Smoke (Review C4/C6), nur mit Dev-Modus (unverpackt + --dev):
 * start = start() wirft · setup = jedes Modul-setup wirft vor seinen Kanälen · crash-once / crash = Renderer stürzt
 * nach dem Laden ab (einmal / jedes Mal) · load-once / load = Laden scheitert (einmal / jedes Mal) · noshow =
 * ready-to-show wird ignoriert · hang = Renderer hängt einmal (Endlosschleife) bis 'unresponsive'.
 */
export const FAULTS = ['start', 'setup', 'crash-once', 'crash', 'load-once', 'load', 'noshow', 'hang'] as const;
export type Fault = (typeof FAULTS)[number];

export function faultArg(argv: readonly string[], dev: boolean): Fault | null {
  if (!dev) return null;
  const hit = argv.find((a) => a.startsWith('--fault='));
  const name = hit ? hit.slice('--fault='.length) : null;
  return FAULTS.find((f) => f === name) ?? null;
}

/** IPC-Kanäle (gespiegelt in preload.cts, das als Sandbox-Preload nichts importieren darf). */
export const IPC = {
  info: 'vel:info',
  quit: 'vel:quit',
  windowGet: 'vel:window:get',
  windowSet: 'vel:window:set',
  openExternal: 'vel:open-external',
  saveRead: 'vel:save:read',
  saveWrite: 'vel:save:write',
  saveWriteSync: 'vel:save:write-sync',
  /** Hauptprozess → Renderer: jetzt synchron sichern (Windows-Abmeldung: kein pagehide, Review C5). */
  saveFlush: 'vel:save:flush',
  /** Hauptprozess → Renderer: Modus hat gewechselt (Alt+Enter/F11 ohne Umweg über das Menü). */
  windowMode: 'vel:window:mode',
} as const;
