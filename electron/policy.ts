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
} as const;
