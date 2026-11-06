/**
 * Persistenz-Grundlage ohne Abhängigkeiten. Eigene Datei, damit Ghost.ts (und damit das Verifier-Bundle der
 * Edge Function) nicht über Settings.ts an settingsTypes/InputState/render/online hängt — jede Textänderung dort
 * würde sonst esbuilds Minifier-Namen verschieben und das Bundle "veraltet" machen (fallen.md #210, #214).
 */

/** Minimaler Storage-Ausschnitt — Tests geben ein Map-basiertes Fake hinein. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** localStorage kann fehlen oder werfen (Privatmodus, gesperrte Cookies) — dann null, alles läuft im Speicher. */
export function defaultStorage(): StorageLike | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}
