/**
 * Supabase-Sitzung am Desktop verschlüsselt ablegen (Plan 011 §3.1, Review Phase 2): Ohne das stünde das
 * Refresh-Token im Klartext in `userData/Local Storage/leveldb` — die Cookie-Encryption-Fuse deckt localStorage nicht
 * ab. Der Renderer leitet GENAU den einen Sitzungsschlüssel hierher (src/online/supabaseApi.ts `vaultStorage`); der
 * PKCE-Verifier und alles andere bleiben in localStorage.
 *
 * Datei `userData/auth/session.bin` = Electron `safeStorage` (Windows: DPAPI, an das Benutzerkonto gebunden).
 * Ohne OS-Schlüsselspeicher wird nichts geschrieben — die Sitzung lebt dann nur im Speicher, nie im Klartext.
 * Reine Logik, Verschlüsselung injiziert (Vitest: tests/desktopAuth.test.ts; Electron: electron/authModule.ts).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Eine supabase-Sitzung ist wenige KB groß; die Grenze verhindert Missbrauch als Datei-Ablage. */
export const SESSION_MAX_CHARS = 64 * 1024;

export interface SessionCipher {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(data: Buffer): Promise<string>;
}

/** supabase-js schreibt die Sitzung als JSON-Objekt — alles andere ist kein Sitzungsstand. */
export function isSessionValue(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > SESSION_MAX_CHARS) return false;
  try {
    const o: unknown = JSON.parse(v);
    return typeof o === 'object' && o !== null && !Array.isArray(o);
  } catch {
    return false;
  }
}

export class SecureSessionStore {
  /** Nacheinander: ein älteres Schreiben darf ein neueres (Token-Refresh, Abmelden) nie überholen. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly cipher: SessionCipher,
  ) {}

  read(): Promise<string | null> {
    return this.queue(async () => {
      let data: Buffer;
      try {
        data = readFileSync(this.file);
      } catch {
        return null;
      }
      try {
        const plain = await this.cipher.decrypt(data);
        if (isSessionValue(plain)) return plain;
      } catch {
        // anderes Benutzerkonto/kaputt → wie abgemeldet
      }
      rmSync(this.file, { force: true });
      return null;
    });
  }

  write(value: unknown): Promise<boolean> {
    if (!isSessionValue(value)) return Promise.resolve(false);
    return this.queue(async () => {
      try {
        if (!(await this.cipher.available())) return false;
        const data = await this.cipher.encrypt(value);
        mkdirSync(dirname(this.file), { recursive: true });
        // Atomar (tmp + rename): ein Absturz hinterlässt nie eine halbe Datei.
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, data);
        renameSync(tmp, this.file);
        return true;
      } catch {
        return false;
      }
    });
  }

  remove(): Promise<boolean> {
    return this.queue(async () => {
      try {
        rmSync(this.file, { force: true });
        return true;
      } catch {
        return false;
      }
    });
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }
}
