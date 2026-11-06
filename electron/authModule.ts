/**
 * Hauptprozess-Modul "auth" (Plan 011 §3.1, eingetragen in electron/modules.ts): verdrahtet den Loopback-Login
 * (electron/auth.ts) und den verschlüsselten Sitzungsspeicher (electron/session.ts) mit Electron und IPC.
 * main.ts bleibt dafür unverändert — IPC nur über `ctx.handle` (Absender-Prüfung wie die bestehenden Kanäle).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeStorage, shell } from 'electron';
import { AUTH_IPC, authFailure, LoopbackLogin } from './auth.js';
import type { DesktopModule } from './modules.js';
import { isExternalAllowed, sanitizeOrigin } from './policy.js';
import { SecureSessionStore } from './session.js';

/** Dieselbe Datei wie `loadConfig` in main.ts (zur Build-Zeit aus .env.local); fehlt sie, ist Online am Desktop aus. */
function supabaseOrigin(): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'desktop-config.json'), 'utf8'));
    const o = typeof raw === 'object' && raw !== null ? (raw as { supabaseOrigin?: unknown }).supabaseOrigin : null;
    return typeof o === 'string' ? sanitizeOrigin(o) : null;
  } catch {
    return null;
  }
}

let login: LoopbackLogin | null = null;

export const authModule: DesktopModule = {
  name: 'auth',
  setup(ctx) {
    const origin = supabaseOrigin();
    // Nur mit --dev (tools/desktop/authSmoke.ts): kein System-Browser — die geprüfte Adresse bleibt im Hauptprozess
    // (globalThis.__velAuthOpened), damit der Test den Rücksprung selbst spielt, ohne dass ein Fenster aufgeht.
    const noBrowser = ctx.dev && process.argv.includes('--auth-no-browser');
    const opened: string[] = [];
    if (noBrowser) (globalThis as { __velAuthOpened?: string[] }).__velAuthOpened = opened;
    const l = new LoopbackLogin({
      supabaseOrigin: origin,
      openExternal: async (url) => {
        // Zweites Tor: dieselbe Allowlist wie der allgemeine Kanal — nie ein beliebiges openExternal.
        if (!isExternalAllowed(url, origin)) return false;
        if (noBrowser) opened.push(url);
        else await shell.openExternal(url);
        return true;
      },
      onReturn: () => {
        // Nach dem Login zurück ins Spiel (Windows lässt evtl. nur die Taskleiste blinken — die Seite sagt es auch).
        const w = ctx.mainWindow();
        if (!w) return;
        if (w.isMinimized()) w.restore();
        w.focus();
      },
    });
    login = l;
    const vault = new SecureSessionStore(join(ctx.userData, 'auth', 'session.bin'), {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptStringAsync(plain),
      decrypt: async (data) => (await safeStorage.decryptStringAsync(data)).result,
    });
    ctx.handle(AUTH_IPC.begin, () => l.begin());
    ctx.handle(AUTH_IPC.open, (_e, url) => (typeof url === 'string' ? l.open(url) : authFailure('url', 'Keine Anmelde-Adresse.')));
    ctx.handle(AUTH_IPC.cancel, () => l.cancel());
    ctx.handle(AUTH_IPC.sessionRead, () => vault.read());
    ctx.handle(AUTH_IPC.sessionWrite, (_e, value) => vault.write(value));
    ctx.handle(AUTH_IPC.sessionRemove, () => vault.remove());
  },
  dispose() {
    void login?.cancel();
    login = null;
  },
};
