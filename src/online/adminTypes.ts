/**
 * Entwickler-Werkzeuge (Plan 009 §15) — Typen der Moderations-Schnittstelle `OnlineService.admin`, über online/index
 * re-exportiert. Eigene Datei statt online/types.ts (Bundle-Graph der Edge Function, siehe profileTypes.ts).
 */

/** Lauf in der Admin-Sicht (auch gebannter Spieler). */
export interface AdminRun {
  readonly runId: string;
  readonly uid: string;
  readonly name: string;
  readonly dev: boolean;
  readonly banned: boolean;
  readonly levelId: string;
  readonly levelHash: string;
  readonly physicsVersion: number;
  /** Verifizierte Zeit (s). */
  readonly time: number;
  readonly ticks: number;
  /** ISO-Datum der Einreichung. */
  readonly date: string;
  /** Storage-Pfad im Bucket 'replays' (nur PB-Läufe haben eines), sonst null. */
  readonly replayPath: string | null;
  /** Ist aktuell die Bestzeit des Spielers auf dieser Tafel. */
  readonly best: boolean;
}

export interface AdminRunQuery {
  readonly levelId?: string;
  readonly uid?: string;
  /** 1–200, Default 50. */
  readonly limit?: number;
  readonly offset?: number;
}

export interface AdminPage<T> {
  readonly items: readonly T[];
  /** Treffer insgesamt (für Seitenzahlen; 0 hinter der letzten Seite). */
  readonly total: number;
}

export interface AdminPlayer {
  readonly uid: string;
  readonly name: string;
  readonly discordName: string | null;
  readonly avatarUrl: string | null;
  readonly dev: boolean;
  readonly banned: boolean;
  readonly banReason: string | null;
  readonly bannedAt: string | null;
  readonly memberSince: string | null;
  readonly runs: number;
}

export interface AdminPlayerQuery {
  /** Teilstring von Anzeige-/Discord-Name oder exakte uid. */
  readonly search?: string;
  readonly bannedOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AdminDeleteResult {
  readonly runId: string;
  readonly uid: string;
  readonly levelId: string;
  /** Der Lauf war die Bestzeit seiner Tafel → best_runs neu bestimmt. */
  readonly wasBest: boolean;
  /** Neue Bestzeit des Spielers auf der Tafel (null = keine Läufe mehr dort bzw. nicht betroffen). */
  readonly newBest: { readonly runId: string; readonly time: number } | null;
  /** Replay-Objekt aus Storage gelöscht (false: hatte keins oder Löschen schlug fehl — Lauf ist trotzdem weg). */
  readonly replayRemoved: boolean;
}

export type AdminAction = 'ban' | 'unban' | 'rename' | 'delete_run';

export type AdminDetailValue = string | number | boolean | null;

export interface AdminAuditEntry {
  readonly id: number;
  readonly at: string;
  readonly actorUid: string;
  readonly actorName: string | null;
  readonly action: AdminAction;
  readonly targetUid: string | null;
  readonly targetName: string | null;
  readonly runId: string | null;
  /** z. B. reason, from/to (rename), level_id/time_ms/was_best (delete_run). Nur flache Werte. */
  readonly detail: Readonly<Record<string, AdminDetailValue>>;
}

export interface AdminAuditQuery {
  /** Nur Einträge, in denen dieser Spieler Ziel oder Akteur ist. */
  readonly uid?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Moderation — nur für Entwickler (identity.dev). Der Server prüft JEDEN Aufruf selbst (role = 'dev'); der Client
 * blendet nur aus. Fehler: OnlineError 'auth' (nicht angemeldet/kein Dev), 'invalid' (Eingabe, z. B. Begründung
 * fehlt, Dev/sich selbst bannen), 'notFound'.
 */
export interface AdminService {
  listRuns(q?: AdminRunQuery): Promise<AdminPage<AdminRun>>;
  listPlayers(q?: AdminPlayerQuery): Promise<AdminPage<AdminPlayer>>;
  /** Bannen (reason Pflicht, 1–200) blendet alle Bestenlisten-Einträge aus und sperrt das Einreichen; Entbannen blendet ein. */
  setBan(uid: string, banned: boolean, reason?: string): Promise<AdminPlayer>;
  /** Anzeigenamen moderieren (bereinigt wie sanitizeName; ungültig → 'invalid'). */
  renamePlayer(uid: string, name: string, reason?: string): Promise<AdminPlayer>;
  /** Lauf löschen (reason Pflicht): Lauf + Replay weg, Bestzeit der Tafel aus den restlichen Läufen neu. */
  deleteRun(runId: string, reason: string): Promise<AdminDeleteResult>;
  auditLog(q?: AdminAuditQuery): Promise<AdminPage<AdminAuditEntry>>;
}
