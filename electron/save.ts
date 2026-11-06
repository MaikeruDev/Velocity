/**
 * Speicher-Spiegel, Hauptprozess-Seite (Plan 011 Schritt 2.7): `userData/save/save.json`.
 * Der Renderer liefert fertiges JSON (src/platform/saveMirror.ts); hier nur Größe/JSON prüfen und atomar schreiben
 * (tmp + rename), damit ein Absturz mitten im Schreiben nie einen halben Spielstand hinterlässt.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Obergrenze: Plan rechnet mit < 200 KB inkl. Ghosts; 4 MB lässt Luft, verhindert aber Missbrauch als Datei-Ablage. */
export const SAVE_MAX_BYTES = 4 * 1024 * 1024;

export function isAcceptableSave(json: unknown): json is string {
  if (typeof json !== 'string' || json.length === 0 || json.length > SAVE_MAX_BYTES) return false;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

export class SaveStore {
  private readonly dir: string;
  private readonly file: string;
  /** Asynchrone Schreibvorgänge nacheinander (sonst überholt ein älterer Stand einen neueren). */
  private chain: Promise<boolean> = Promise.resolve(true);

  constructor(userData: string) {
    this.dir = join(userData, 'save');
    this.file = join(this.dir, 'save.json');
  }

  readSync(): string | null {
    try {
      const s = readFileSync(this.file, 'utf8');
      return isAcceptableSave(s) ? s : null;
    } catch {
      return null;
    }
  }

  writeSync(json: unknown): boolean {
    if (!isAcceptableSave(json)) return false;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, json);
      renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }

  write(json: unknown): Promise<boolean> {
    if (!isAcceptableSave(json)) return Promise.resolve(false);
    this.chain = this.chain.then(async () => {
      try {
        mkdirSync(this.dir, { recursive: true });
        const tmp = `${this.file}.atmp`;
        await writeFile(tmp, json);
        await rename(tmp, this.file);
        return true;
      } catch {
        return false;
      }
    });
    return this.chain;
  }
}
