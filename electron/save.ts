/**
 * Speicher-Spiegel, Hauptprozess-Seite (Plan 011 Schritt 2.7): `userData/save/save.json`.
 * Der Renderer liefert fertiges JSON (src/platform/saveMirror.ts); hier nur Größe/JSON prüfen und haltbar schreiben:
 * tmp-Datei + fsync + rename, damit weder ein Absturz noch ein Stromausfall einen halben Spielstand hinterlässt.
 *
 * Review C5:
 * - Jede Anfrage bekommt eine laufende Nummer, der neueste Stand gewinnt. Das async-Schreiben benennt SYNCHRON um und
 *   prüft direkt davor, ob ein neuerer (z. B. ein writeSync beim Beenden) schon liegt — dazwischen kann kein anderes
 *   Schreiben laufen, ein älteres rename überholt nie einen neueren Stand.
 * - EPERM/EBUSY/EACCES (Defender/Cloud-Sync hält die Datei kurz): neuer Versuch mit Backoff. Was danach noch offen
 *   ist, bleibt `pending` — `flushPendingSync()` beim Beenden/Abmelden versucht es ein letztes Mal.
 * Dateisystem und Wartezeiten sind injizierbar (Vitest mit Fake-fs, tests/desktopPolicy.test.ts).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

/** Obergrenze: Plan rechnet mit < 200 KB inkl. Ghosts; 4 MB lässt Luft, verhindert aber Missbrauch als Datei-Ablage. */
export const SAVE_MAX_BYTES = 4 * 1024 * 1024;
/** Wartezeiten zwischen async-Versuchen (Summe ~8 s) — kurze Sperren durch Virenscanner/Sync-Clients überbrücken. */
export const SAVE_ASYNC_RETRY_MS: readonly number[] = [100, 250, 500, 1000, 2000, 4000];
/** Synchron (Beenden, Abmelden) nur kurz blockieren: Summe 170 ms. */
export const SAVE_SYNC_RETRY_MS: readonly number[] = [20, 50, 100];
/** Diese Fehler sind unter Windows meist vorübergehend (fremder Prozess hält die Datei offen). */
const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function isAcceptableSave(json: unknown): json is string {
  if (typeof json !== 'string' || json.length === 0 || json.length > SAVE_MAX_BYTES) return false;
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

export function isRetryableSaveError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' && RETRY_CODES.has(err.code);
}

export interface SaveFileHandle {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Ausschnitt aus node:fs, den der Spiegel braucht (Tests geben ein Fake). */
export interface SaveFs {
  mkdirSync(path: string, options: { recursive: true }): unknown;
  readFileSync(path: string, encoding: 'utf8'): string;
  openSync(path: string, flags: 'w'): number;
  writeSync(fd: number, data: string): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  openAsync(path: string, flags: 'w'): Promise<SaveFileHandle>;
}

export interface SaveTiming {
  /** Blockierend warten (nur in den kurzen synchronen Wiederholungen). */
  sleepSync(ms: number): void;
  delay(ms: number): Promise<void>;
}

export interface SaveStoreOptions {
  readonly fs?: SaveFs;
  readonly timing?: SaveTiming;
}

const NODE_FS: SaveFs = { mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, renameSync, openAsync: open };

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const NODE_TIMING: SaveTiming = {
  // Atomics.wait ist im Node-Hauptthread erlaubt — der einzige Weg, synchron (beim Beenden) kurz zu warten.
  sleepSync: (ms) => void Atomics.wait(sleeper, 0, 0, ms),
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
};

interface PendingSave {
  readonly gen: number;
  readonly json: string;
}

interface SaveWaiter {
  readonly gen: number;
  readonly resolve: (ok: boolean) => void;
}

export class SaveStore {
  private readonly dir: string;
  private readonly file: string;
  /** Getrennte tmp-Dateien: ein synchrones Schreiben darf das halb fertige async-tmp nie treffen. */
  private readonly syncTmp: string;
  private readonly asyncTmp: string;
  private readonly fs: SaveFs;
  private readonly timing: SaveTiming;
  /** Nummer der neuesten Anfrage. */
  private gen = 0;
  /** Nummer des Stands, der in save.json liegt. */
  private committed = 0;
  /** Neuester noch nicht geschriebener Stand (auch nach aufgegebenen Versuchen — für flushPendingSync). */
  private pendingSave: PendingSave | null = null;
  private waiters: SaveWaiter[] = [];
  private worker: Promise<void> | null = null;

  constructor(userData: string, opts: SaveStoreOptions = {}) {
    this.dir = join(userData, 'save');
    this.file = join(this.dir, 'save.json');
    this.syncTmp = `${this.file}.tmp`;
    this.asyncTmp = `${this.file}.atmp`;
    this.fs = opts.fs ?? NODE_FS;
    this.timing = opts.timing ?? NODE_TIMING;
  }

  /** Steht noch ein Stand aus, der nicht auf der Platte liegt? */
  get pending(): boolean {
    return this.pendingSave !== null;
  }

  /** Neuester bekannter Stand: ein noch offener schlägt die Datei. */
  readSync(): string | null {
    if (this.pendingSave) return this.pendingSave.json;
    try {
      const s = this.fs.readFileSync(this.file, 'utf8');
      return isAcceptableSave(s) ? s : null;
    } catch {
      return null;
    }
  }

  /** Synchron (pagehide, Beenden): mit kurzen Wiederholungen; false = (noch) nicht geschrieben, bleibt offen. */
  writeSync(json: unknown): boolean {
    if (!isAcceptableSave(json)) return false;
    const gen = ++this.gen;
    this.pendingSave = { gen, json };
    return this.commitSync(gen, json);
  }

  /** Entprellt aus dem Spiel. true auch, wenn ein neuerer Stand diesen überholt und geschrieben hat. */
  write(json: unknown): Promise<boolean> {
    if (!isAcceptableSave(json)) return Promise.resolve(false);
    const gen = ++this.gen;
    this.pendingSave = { gen, json };
    const done = new Promise<boolean>((resolve) => this.waiters.push({ gen, resolve }));
    this.kick();
    return done;
  }

  /** Beim Beenden / bei der Windows-Abmeldung: Offenes synchron schreiben (letzter Versuch). */
  flushPendingSync(): boolean {
    const p = this.pendingSave;
    return p === null || this.commitSync(p.gen, p.json);
  }

  /** Bis der Hintergrund-Schreiber nichts mehr anfasst (Tests; ein überholtes tmp-Schreiben kann noch laufen). */
  async whenIdle(): Promise<void> {
    while (this.worker !== null) await this.worker;
  }

  private commitSync(gen: number, json: string): boolean {
    for (let attempt = 0; ; attempt++) {
      if (this.committed >= gen) return true;
      try {
        this.fs.mkdirSync(this.dir, { recursive: true });
        const fd = this.fs.openSync(this.syncTmp, 'w');
        try {
          this.fs.writeSync(fd, json);
          this.fs.fsyncSync(fd);
        } finally {
          this.fs.closeSync(fd);
        }
        this.fs.renameSync(this.syncTmp, this.file);
        this.commit(gen);
        return true;
      } catch (err) {
        if (!isRetryableSaveError(err) || attempt >= SAVE_SYNC_RETRY_MS.length) {
          // Offen lassen: der Hintergrund versucht es weiter, flushPendingSync beim Beenden ein letztes Mal.
          this.kick();
          return false;
        }
        this.timing.sleepSync(SAVE_SYNC_RETRY_MS[attempt]);
      }
    }
  }

  private commit(gen: number): void {
    this.committed = gen;
    if (this.pendingSave !== null && this.pendingSave.gen <= gen) this.pendingSave = null;
    this.settle(gen, true);
  }

  /** Alle Wartenden bis einschließlich `gen` erfahren das Ergebnis (ein neuerer Stand ersetzt die älteren). */
  private settle(gen: number, ok: boolean): void {
    const rest: SaveWaiter[] = [];
    for (const w of this.waiters) {
      if (w.gen <= gen) w.resolve(ok);
      else rest.push(w);
    }
    this.waiters = rest;
  }

  private kick(): void {
    if (this.worker !== null) return;
    this.worker = this.drain().finally(() => {
      this.worker = null;
    });
  }

  /** Ein Schreiber im Hintergrund: immer der neueste offene Stand, ältere werden übersprungen. */
  private async drain(): Promise<void> {
    for (;;) {
      const p = this.pendingSave;
      if (p === null || p.gen <= this.committed) {
        this.settle(this.committed, true);
        return;
      }
      const ok = await this.writeAsync(p);
      if (!ok) {
        // Aufgegeben: Wartende erfahren es (der Renderer plant selbst neu), der Stand bleibt für flushPendingSync.
        this.settle(p.gen, false);
        return;
      }
    }
  }

  /** true = geschrieben oder von einem neueren Stand überholt; false = aufgegeben (Dauerfehler). */
  private async writeAsync(p: PendingSave): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      if (this.superseded(p)) return true;
      try {
        this.fs.mkdirSync(this.dir, { recursive: true });
        const fh = await this.fs.openAsync(this.asyncTmp, 'w');
        try {
          await fh.writeFile(p.json);
          await fh.sync();
        } finally {
          await fh.close();
        }
        // Ab hier synchron: Prüfung und rename ohne await dazwischen.
        if (this.superseded(p)) return true;
        this.fs.renameSync(this.asyncTmp, this.file);
        this.commit(p.gen);
        return true;
      } catch (err) {
        if (!isRetryableSaveError(err) || attempt >= SAVE_ASYNC_RETRY_MS.length) return false;
        await this.timing.delay(SAVE_ASYNC_RETRY_MS[attempt]);
      }
    }
  }

  /** Liegt schon ein neuerer Stand (committed) oder wartet einer (pending)? Dann diesen nicht mehr schreiben. */
  private superseded(p: PendingSave): boolean {
    return this.committed >= p.gen || (this.pendingSave !== null && this.pendingSave.gen > p.gen);
  }
}
