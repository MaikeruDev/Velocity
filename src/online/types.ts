/**
 * Online-Schicht (Plan 009), anbieter-unabhängig: das Spiel spricht nur mit `OnlineService`.
 * Implementierungen: LocalMockService (localStorage, verifiziert lokal mit dem echten Verifier) und
 * später FirebaseService (Auth, Firestore, Storage, Cloud Function) bzw. eine Supabase-Variante.
 * Kein SDK hier — Typen und Fehler sind reine Daten, damit Menü und Game ohne Backend testbar bleiben.
 */

export type OnlineBackend = 'mock' | 'firebase' | 'off';

export interface PlayerIdentity {
  /** Stabile Spieler-ID (Firebase: auth.uid). */
  readonly uid: string;
  /** Anzeigename (Einstellung "Spielername"); leer = "SPIELER-xxxx". */
  readonly name: string;
  readonly provider: 'anonymous' | 'google' | 'local';
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
  /** Neue persönliche Online-Bestzeit. */
  readonly personalBest: boolean;
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

export interface PlayerProfile {
  readonly uid: string;
  readonly name: string;
  /** Eingereichte (angenommene) Läufe insgesamt. */
  readonly runs: number;
  readonly bests: readonly { readonly levelId: string; readonly time: number; readonly rank: number; readonly runId: string }[];
}

export type OnlineErrorCode = 'offline' | 'timeout' | 'auth' | 'notFound' | 'server' | 'invalid' | 'unavailable';

export class OnlineError extends Error {
  readonly code: OnlineErrorCode;
  constructor(code: OnlineErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface OnlineService {
  readonly backend: OnlineBackend;
  /** Angemeldeter Spieler (null vor auth()). */
  readonly identity: PlayerIdentity | null;
  /** Anmelden (Firebase: anonym, später mit Google verknüpfbar). Idempotent. */
  auth(name?: string): Promise<PlayerIdentity>;
  /** Anzeigenamen ändern (Einstellung "Spielername"). */
  setName(name: string): Promise<PlayerIdentity>;
  /** Replay (packReplay-Bytes) einreichen; der Server verifiziert und rankt. */
  submitRun(replay: Uint8Array): Promise<SubmitResult>;
  getLeaderboard(levelId: string, range: LeaderboardRange): Promise<LeaderboardPage>;
  /** Replay eines Eintrags (für den Ghost: replayToGhost). */
  getGhost(runId: string): Promise<Uint8Array>;
  getProfile(uid?: string): Promise<PlayerProfile>;
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
