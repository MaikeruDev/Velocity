import type { StorageLike } from '../engine/Settings';
import { base64ToBytes, bytesToBase64 } from '../engine/replay/codec';

/**
 * Lauf über den Discord-Login retten (Plan 009, Supabase): der OAuth-Login VERLÄSST die Seite, das Replay des
 * gerade gefahrenen Laufs läge danach nicht mehr im Speicher. Deshalb vor dem Redirect in sessionStorage
 * (überlebt den Redirect im selben Tab, nicht das Schließen) und nach der Rückkehr einmal einreichen.
 * Nur EIN Lauf (der zuletzt nicht eingereichte), 30 min gültig.
 */

export const PENDING_KEY = 'velocity.online.pending.v1';
export const PENDING_MAX_AGE_MS = 30 * 60 * 1000;

export interface PendingRun {
  readonly bytes: Uint8Array;
  readonly levelId: string;
  /** Lokal gemessene Zeit (s) — nur für die Meldung, gewertet wird serverseitig. */
  readonly time: number;
  readonly savedAt: number;
}

export function defaultSessionStorage(): StorageLike | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Vor dem Login-Redirect sichern. false = kein Speicher (privater Modus, Quota). */
export function savePendingRun(storage: StorageLike | null, run: Omit<PendingRun, 'savedAt'>, now = Date.now()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PENDING_KEY, JSON.stringify({ v: 1, b64: bytesToBase64(run.bytes), levelId: run.levelId, time: run.time, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}

/** Gesicherten Lauf holen UND entfernen (genau einmal einreichen). null = keiner, abgelaufen oder kaputt. */
export function takePendingRun(storage: StorageLike | null, now = Date.now()): PendingRun | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(PENDING_KEY);
    storage.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (o.v !== 1 || typeof o.b64 !== 'string' || typeof o.levelId !== 'string' || typeof o.time !== 'number' || typeof o.savedAt !== 'number') return null;
    if (now - o.savedAt > PENDING_MAX_AGE_MS || now < o.savedAt - 60_000) return null;
    return { bytes: base64ToBytes(o.b64), levelId: o.levelId, time: o.time, savedAt: o.savedAt };
  } catch {
    return null;
  }
}

/** Liegt ein Lauf bereit (ohne ihn zu entnehmen)? */
export function hasPendingRun(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(PENDING_KEY) != null;
  } catch {
    return false;
  }
}
