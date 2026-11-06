/**
 * Online-Schicht (Plan 009), anbieter-unabhängig: das Spiel spricht nur mit `OnlineService`.
 * Implementierungen: LocalMockService (localStorage, verifiziert lokal mit dem echten Verifier) und
 * SupabaseService (Discord-Login über Supabase Auth, Postgres-Bestenliste, Storage-Ghosts, Edge Function
 * `submit-run` mit demselben Verifier). Firebase (Plan 009 §7) wurde verworfen.
 * Kein SDK hier — Typen und Fehler sind reine Daten, damit Menü und Game ohne Backend testbar bleiben.
 */

import type { AdminService } from './adminTypes';
import type { PlayerProfile } from './profileTypes';

export type OnlineBackend = 'mock' | 'supabase' | 'off';

export interface PlayerIdentity {
  /** Stabile Spieler-ID (Supabase: auth.users.id). */
  readonly uid: string;
  /** Anzeigename (Supabase: profiles.display_name, vorbelegt mit dem Discord-Namen; Mock: Einstellung "Spielername"). */
  readonly name: string;
  readonly provider: 'discord' | 'local';
  /** Avatar-URL (Discord-CDN) oder null. */
  readonly avatarUrl: string | null;
  /** Entwickler des Spiels (profiles.role = 'dev'): eigener Namens-Effekt + DEV-Abzeichen im Menü. */
  readonly dev: boolean;
}

export type SubmitStatus = 'accepted' | 'rejected';

/** Antwort auf submitRun — der Server zählt seine nachgerechnete Zeit, nicht die behauptete. */
export interface SubmitResult {
  readonly status: SubmitStatus;
  readonly runId: string | null;
  /** Verifizierte Zeit (s), null bei Ablehnung. */
  readonly time: number | null;
  /** Rang des besten Laufs dieses Spielers im Level danach (1 = Weltrekord), null bei Ablehnung. */
  readonly rank: number | null;
  /** Spieler in der Bestenliste des Levels. */
  readonly total: number;
  /** Neue persönliche Online-Bestzeit (auch der erste Lauf). */
  readonly personalBest: boolean;
  /** Bestehende Online-Bestzeit verbessert (personalBest und es gab schon eine). */
  readonly improved: boolean;
  /** Ablehnungsgrund (VerifyReason des Verifiers, z. B. 'config', 'desync') + Klartext. */
  readonly reason: string | null;
  readonly detail: string | null;
}

export interface LeaderboardEntry {
  readonly rank: number;
  readonly runId: string;
  readonly uid: string;
  readonly name: string;
  /** Verifizierte Zeit (s). */
  readonly time: number;
  /** ISO-Datum des Laufs. */
  readonly date: string;
  /** Bot/Eingabe-Override bei der Aufnahme (Mock: Rivalen und Debug-Bots). */
  readonly bot: boolean;
  /** Avatar (Discord-CDN) oder null. */
  readonly avatarUrl: string | null;
  /** Entwickler (profiles.role = 'dev'). */
  readonly dev: boolean;
}

/** Ausschnitt: die besten `limit` oder `radius` Plätze um einen Spieler (Default: mich). */
export type LeaderboardRange = { readonly kind: 'top'; readonly limit: number } | { readonly kind: 'around'; readonly uid?: string; readonly radius: number };

export interface LeaderboardPage {
  readonly levelId: string;
  readonly entries: readonly LeaderboardEntry[];
  /** Spieler in der Bestenliste insgesamt. */
  readonly total: number;
  /** Mein Eintrag (null = noch kein Lauf). */
  readonly me: LeaderboardEntry | null;
}

export type OnlineErrorCode = 'offline' | 'timeout' | 'auth' | 'notFound' | 'server' | 'invalid' | 'unavailable' | 'rate' | 'banned';

export class OnlineError extends Error {
  readonly code: OnlineErrorCode;
  constructor(code: OnlineErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface OnlineService {
  readonly backend: OnlineBackend;
  /** Angemeldeter Spieler (null = nicht angemeldet bzw. vor auth()). */
  readonly identity: PlayerIdentity | null;
  /**
   * true: Einreichen braucht eine interaktive Anmeldung (signIn — Supabase: Discord). Lesen (Bestenliste,
   * Ghosts) geht immer ohne. false: auth() meldet still an (Mock).
   */
  readonly loginRequired: boolean;
  /**
   * Sitzung herstellen, OHNE die Seite zu verlassen. Mock: legt still einen lokalen Spieler an (name = Wunschname).
   * Supabase: stellt eine vorhandene Discord-Sitzung wieder her (auch direkt nach dem OAuth-Redirect), name wird
   * ignoriert. null = nicht angemeldet. Idempotent.
   */
  auth(name?: string): Promise<PlayerIdentity | null>;
  /** Interaktiv anmelden. Supabase: OAuth-Redirect zu Discord — VERLÄSST DIE SEITE. Mock: wie auth(). */
  signIn(): Promise<void>;
  /** Abmelden (Supabase: Sitzung beenden; lokale Bestzeiten/Ghosts bleiben). Mock: nichts. */
  signOut(): Promise<void>;
  /** Anmeldestand geändert (Login, Logout, Namenswechsel). Rückgabe: Abo beenden. */
  onIdentityChange(cb: (id: PlayerIdentity | null) => void): () => void;
  /** Anzeigenamen ändern (Einstellung "Spielername"). Wirft 'auth' ohne Anmeldung. */
  setName(name: string): Promise<PlayerIdentity>;
  /** Replay (packReplay-Bytes) einreichen; der Server verifiziert und rankt. Wirft OnlineError('auth') ohne Anmeldung. */
  submitRun(replay: Uint8Array): Promise<SubmitResult>;
  getLeaderboard(levelId: string, range: LeaderboardRange): Promise<LeaderboardPage>;
  /** Replay eines Eintrags (für den Ghost: replayToGhost). */
  getGhost(runId: string): Promise<Uint8Array>;
  /**
   * Profil eines Spielers (Default: ich — wirft 'auth' ohne Anmeldung). Fremde Profile ohne Login lesbar (z. B. Klick
   * auf einen Namen in der Bestenliste). Bestzeiten/Ränge nur auf den aktuellen Tafeln. Unbekannt/gebannt → 'notFound'.
   */
  getProfile(uid?: string): Promise<PlayerProfile>;
  /** Moderations-Werkzeuge; nicht null nur, solange identity.dev true ist (Server prüft trotzdem jeden Aufruf). */
  readonly admin: AdminService | null;
}

/** Spielername: 2–16 Zeichen, Buchstaben/Ziffern/Leerzeichen/_-. — sonst leer (= automatischer Name). */
export const NAME_MAX = 16;

export function sanitizeName(raw: string): string {
  const s = raw
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return s.length >= 2 ? s : '';
}

/** Anzeigename aus Name oder uid ("SPIELER-3F2A"). */
export function displayName(name: string, uid: string): string {
  return name !== '' ? name : `SPIELER-${uid.replace(/[^0-9a-z]/gi, '').slice(-4).toUpperCase()}`;
}
