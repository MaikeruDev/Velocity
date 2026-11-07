/**
 * Speicher-Spiegel (Plan 011 §2.2.10, Schritt 2.7): localStorage bleibt Single Source of Truth, am Desktop
 * werden die `velocity.*`-Schlüssel zusätzlich als JSON-Datei gespiegelt (Steam Auto-Cloud kann LevelDB nicht
 * sauber syncen). Beim Start mit leerem localStorage wird der Spiegel eingespielt — BEVOR die Stores lesen.
 *
 * DOM-frei testbar: Speicher, Bridge und Timer kommen von außen. Die Verdrahtung in main.ts (vor
 * `new SettingsStore`) ist Teil von S2b: `installSaveMirror(platform().saveMirror, localStorage, window)`.
 */
import type { DesktopSaveMirror } from './bridgeTypes';

export const SAVE_PREFIX = 'velocity.';
export const SAVE_FORMAT = 1;
/** Entprellung nach der letzten Änderung (Plan: 2 s). */
export const SAVE_DEBOUNCE_MS = 2000;

/** Das, was der Spiegel vom Speicher braucht (localStorage erfüllt es). */
export interface MirrorStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MirrorTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

interface SaveFileV1 {
  readonly v: 1;
  readonly at: number;
  readonly data: Record<string, string>;
}

const isSaveKey = (k: string | null): k is string => k !== null && k.startsWith(SAVE_PREFIX);

/** Alle `velocity.*`-Schlüssel als Spiegel-JSON (sortiert → gleicher Stand = gleiche Bytes). */
export function serializeSave(storage: MirrorStorage, now = Date.now()): string {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (isSaveKey(k)) keys.push(k);
  }
  keys.sort();
  const data: Record<string, string> = {};
  for (const k of keys) {
    const v = storage.getItem(k);
    if (v !== null) data[k] = v;
  }
  const file: SaveFileV1 = { v: SAVE_FORMAT, at: now, data };
  return JSON.stringify(file);
}

/** Spiegel-JSON lesen; alles Unerwartete (fremde Schlüssel, Nicht-Strings, kaputtes JSON) → null bzw. verworfen. */
export function parseSave(json: string | null): Map<string, string> | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as { v?: unknown; data?: unknown };
  if (f.v !== SAVE_FORMAT || typeof f.data !== 'object' || f.data === null) return null;
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(f.data as Record<string, unknown>)) {
    if (isSaveKey(k) && typeof v === 'string') out.set(k, v);
  }
  return out;
}

export function hasSaveKeys(storage: MirrorStorage): boolean {
  for (let i = 0; i < storage.length; i++) if (isSaveKey(storage.key(i))) return true;
  return false;
}

/**
 * Spiegel einspielen, aber nur in einen leeren Spielstand (kein `velocity.*`-Schlüssel): Ein vorhandener
 * localStorage ist immer neuer als die Datei. Rückgabe = Anzahl eingespielter Schlüssel.
 */
export function restoreSave(storage: MirrorStorage, mirror: Pick<DesktopSaveMirror, 'readSync'>): number {
  if (hasSaveKeys(storage)) return 0;
  const data = parseSave(mirror.readSync());
  if (!data) return 0;
  let n = 0;
  for (const [k, v] of data) {
    try {
      storage.setItem(k, v);
      n++;
    } catch {
      // Quota: der Rest fehlt, das Spiel startet trotzdem (die Stores fallen auf Defaults zurück).
      break;
    }
  }
  return n;
}

const DEFAULT_TIMERS: MirrorTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Nach einem gescheiterten Schreiben: neuer Versuch nach delay × 2^n, höchstens so lange warten. */
export const SAVE_RETRY_MAX_MS = 60000;

interface MirrorSnapshot {
  /** Stand ohne Zeitstempel (Vergleich "unverändert"). */
  readonly key: string;
  readonly json: string;
}

/** Entprelltes Schreiben: `markDirty()` nach jeder Änderung, `flush()` synchron beim Beenden. */
export class SaveMirror {
  private timer: unknown = null;
  private dirty = false;
  /** Zuletzt ERFOLGREICH geschriebener Stand (ohne Zeitstempel) — erst nach dem Schreiben gesetzt (Review C5). */
  private last: string | null = null;
  private failures = 0;
  /** Laufende Nummer der async-Schreibvorgänge: ein später fertiges älteres Ergebnis überschreibt nichts. */
  private seq = 0;
  private doneSeq = 0;
  /** Stand, der gerade asynchron geschrieben wird — derselbe Stand wird nicht doppelt angestoßen. */
  private inflight: string | null = null;

  constructor(
    private readonly storage: MirrorStorage,
    private readonly mirror: DesktopSaveMirror,
    private readonly delayMs = SAVE_DEBOUNCE_MS,
    private readonly timers: MirrorTimers = DEFAULT_TIMERS,
  ) {}

  get pending(): boolean {
    return this.dirty;
  }

  markDirty(): void {
    this.dirty = true;
    this.schedule(this.delayMs);
  }

  /** Synchron schreiben, falls etwas offen ist (pagehide/Beenden/Abmelden). false = nicht geschrieben, bleibt offen. */
  flush(): boolean {
    this.cancelTimer();
    if (!this.dirty) return true;
    // Gegen den bestätigten Stand vergleichen (nicht gegen einen noch laufenden): beim Beenden lieber doppelt schreiben.
    const snap = this.snapshot(false);
    if (snap === null) {
      this.dirty = false;
      return true;
    }
    const ok = this.mirror.writeSync(snap.json);
    if (ok) this.succeeded(snap.key);
    return ok;
  }

  dispose(): void {
    this.cancelTimer();
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.writeAsync();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private succeeded(key: string): void {
    this.last = key;
    this.dirty = false;
    this.failures = 0;
  }

  private async writeAsync(): Promise<void> {
    if (!this.dirty) return;
    const snap = this.snapshot(true);
    if (snap === null) {
      this.dirty = false;
      return;
    }
    // Während des Schreibens gilt der Stand als gesichert; eine neue Änderung setzt dirty wieder.
    this.dirty = false;
    this.inflight = snap.key;
    const seq = ++this.seq;
    const ok = await this.mirror.write(snap.json).catch(() => false);
    if (this.inflight === snap.key) this.inflight = null;
    if (seq < this.doneSeq) return;
    this.doneSeq = seq;
    if (ok) {
      this.last = snap.key;
      this.failures = 0;
      return;
    }
    // Gescheitert (Datei gesperrt, Hauptprozess gab auf): offen lassen und selbst neu planen — sonst ginge der Stand
    // erst mit der nächsten Änderung (oder nie) auf die Platte.
    this.dirty = true;
    this.failures++;
    this.schedule(Math.min(SAVE_RETRY_MAX_MS, this.delayMs * 2 ** this.failures));
  }

  /** Spiegel-JSON ohne Zeitstempel mit dem zuletzt geschriebenen (und ggf. dem laufenden) vergleichen: gleich → null. */
  private snapshot(skipInflight: boolean): MirrorSnapshot | null {
    const key = serializeSave(this.storage, 0);
    if (key === this.last || (skipInflight && key === this.inflight)) return null;
    return { key, json: serializeSave(this.storage) };
  }
}

/** Was am Storage-Prototyp gepatcht wird (Storage.prototype erfüllt es). */
export interface StorageProtoLike {
  setItem(this: unknown, key: string, value: string): void;
  removeItem(this: unknown, key: string): void;
  clear(this: unknown): void;
}

/**
 * Schreibzugriffe auf `velocity.*` melden. Gepatcht wird der PROTOTYP: Eine Zuweisung `localStorage.setItem = …`
 * würde laut Web-Storage-Spec einen Schlüssel "setItem" anlegen statt die Methode zu ersetzen. `localStorage`
 * feuert im eigenen Fenster kein 'storage'-Ereignis, daher dieser Weg. Rückgabe: Patch wieder entfernen.
 */
/** `target`: nur dieser Speicher zählt (der Prototyp gilt auch für sessionStorage). */
export function hookStorageWrites(proto: StorageProtoLike, target: object, onWrite: () => void): () => void {
  const { setItem, removeItem, clear } = proto;
  proto.setItem = function (this: unknown, key: string, value: string): void {
    setItem.call(this, key, value);
    if (this === target && key.startsWith(SAVE_PREFIX)) onWrite();
  };
  proto.removeItem = function (this: unknown, key: string): void {
    removeItem.call(this, key);
    if (this === target && key.startsWith(SAVE_PREFIX)) onWrite();
  };
  proto.clear = function (this: unknown): void {
    clear.call(this);
    if (this === target) onWrite();
  };
  return () => {
    proto.setItem = setItem;
    proto.removeItem = removeItem;
    proto.clear = clear;
  };
}

/**
 * Komplettpaket für main.ts (S2b): einspielen, Schreibzugriffe beobachten, beim Verlassen synchron sichern — auch
 * auf Bitten des Hauptprozesses (Windows-Abmeldung/Herunterfahren: dort kommt kein pagehide, Review C5).
 */
export function installSaveMirror(
  mirror: DesktopSaveMirror | null,
  storage: MirrorStorage & object,
  win: { addEventListener(type: 'pagehide', fn: () => void): void },
): SaveMirror | null {
  if (!mirror) return null;
  restoreSave(storage, mirror);
  const sm = new SaveMirror(storage, mirror);
  const proto = Object.getPrototypeOf(storage) as StorageProtoLike;
  hookStorageWrites(proto, storage, () => sm.markDirty());
  win.addEventListener('pagehide', () => sm.flush());
  mirror.onFlushRequest?.(() => {
    if (!sm.flush()) console.warn('[velocity] Spielstand-Spiegel nicht geschrieben — der Hauptprozess versucht es beim Beenden erneut');
  });
  return sm;
}
