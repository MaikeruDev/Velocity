/**
 * Öffentliches Spielerprofil (Plan 009 §15) — Typen für `OnlineService.getProfile`, über online/index re-exportiert.
 * Eigene Datei statt online/types.ts: types.ts liegt im Modulgraph des Verifier-Bundles der Edge Function, und jede
 * Textänderung dort lässt esbuild beim Minifizieren anders umbenennen → gepinntes Bundle "veraltet" (fallen.md).
 */

/** Bestzeit eines Spielers auf einer AKTUELLEN Tafel (Level-Hash + PHYSICS_VERSION des laufenden Spiels). */
export interface ProfileBest {
  readonly levelId: string;
  /** Verifizierte Zeit (s). */
  readonly time: number;
  /** Rang auf der Tafel (1 = Weltrekord). */
  readonly rank: number;
  /** Spieler auf der Tafel. */
  readonly total: number;
  /** Lauf (für den Ghost: getGhost). */
  readonly runId: string;
  /** ISO-Datum der Bestzeit. */
  readonly date: string;
}

/**
 * Öffentliches Profil (Plan 009 §15). Lesbar ohne Login. Gebannte Spieler sind öffentlich unbekannt (getProfile
 * wirft 'notFound'); nur sie selbst sehen ihr Profil, dann ohne Bestzeiten.
 */
export interface PlayerProfile {
  readonly uid: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  /** Entwickler (profiles.role = 'dev'). */
  readonly dev: boolean;
  /** ISO-Datum der Registrierung ("Mitglied seit"); null, wenn unbekannt (Mock-Altbestand). */
  readonly memberSince: string | null;
  /** Angenommene Läufe insgesamt (alle Level, auch alte Tafeln). */
  readonly runs: number;
  /** Tafeln (unter den aktuellen), auf denen der Spieler Rang 1 hat. */
  readonly worldRecords: number;
  /** Je aktuellem Level die Bestzeit (nach levelId sortiert); Level ohne Lauf fehlen. */
  readonly bests: readonly ProfileBest[];
}
