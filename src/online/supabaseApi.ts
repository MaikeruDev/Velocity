import { createClient, FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { BoardRow, Database } from './supabaseTypes';
import { OnlineError } from './types';

/**
 * Dünner Adapter über supabase-js (Plan 009): genau die Aufrufe, die SupabaseService braucht, mit festen Typen
 * und OnlineError statt SDK-Fehlern. SupabaseService hängt nur an diesem Interface — Tests geben eine Attrappe.
 */

export interface SessionInfo {
  readonly uid: string;
  /** Aus den Discord-Metadaten (Fallback, bis das Profil geladen ist). */
  readonly metaName: string | null;
  readonly metaAvatar: string | null;
}

export interface ProfileRow {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly dev: boolean;
}

export interface BestRow {
  readonly levelId: string;
  readonly levelHash: string;
  readonly physicsVersion: number;
  readonly timeMs: number;
  readonly runId: string;
}

export interface BoardQuery {
  readonly levelId: string;
  readonly levelHash: string;
  readonly physics: number;
}

/** Antwort der Edge Function submit-run (supabase/functions/submit-run/index.ts). */
export type SubmitResponse =
  | {
      readonly valid: true;
      readonly runId: string;
      readonly time: number;
      readonly rank: number;
      readonly total: number;
      readonly personalBest: boolean;
      readonly improved: boolean;
    }
  | { readonly valid: false; readonly reason: string; readonly detail: string | null };

export interface SupabaseApi {
  getSession(): Promise<SessionInfo | null>;
  onAuthChange(cb: (s: SessionInfo | null) => void): () => void;
  /** OAuth-Redirect zu Discord (verlässt die Seite). */
  signInWithDiscord(redirectTo: string): Promise<void>;
  signOut(): Promise<void>;
  getProfile(uid: string): Promise<ProfileRow | null>;
  updateDisplayName(uid: string, name: string): Promise<void>;
  leaderboard(q: BoardQuery, limit: number, offset: number): Promise<BoardRow[]>;
  rankAround(q: BoardQuery, uid: string, radius: number): Promise<BoardRow[]>;
  bestRuns(uid: string): Promise<BestRow[]>;
  runCount(uid: string): Promise<number>;
  /** Storage-Pfad des Replays eines Laufs (null = kein Replay gespeichert). Wirft notFound ohne Lauf. */
  replayPath(runId: string): Promise<string | null>;
  /** Öffentliche Replay-Bytes (Bucket 'replays', ohne Login). */
  downloadReplay(path: string): Promise<Uint8Array>;
  submitRun(bytes: Uint8Array, timeoutMs: number): Promise<SubmitResponse>;
}

// ------------------------------------------------------------------ Umsetzung mit supabase-js

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function sessionInfo(s: Session | null): SessionInfo | null {
  if (!s) return null;
  const meta: Record<string, unknown> = s.user.user_metadata ?? {};
  const claims = meta.custom_claims;
  const global = typeof claims === 'object' && claims !== null ? str((claims as Record<string, unknown>).global_name) : null;
  return { uid: s.user.id, metaName: global ?? str(meta.full_name) ?? str(meta.name), metaAvatar: str(meta.avatar_url) ?? str(meta.picture) };
}

/** Netz-/Server-Fehler auf OnlineError abbilden. */
function dbError(err: { message: string; code?: string } | null, what: string): OnlineError {
  const msg = err?.message ?? 'unbekannt';
  if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(msg)) return new OnlineError('offline', `${what}: keine Verbindung`);
  if (err?.code === '42501' || /permission denied|JWT/i.test(msg)) return new OnlineError('auth', `${what}: keine Berechtigung`);
  return new OnlineError('server', `${what}: ${msg}`);
}

function isBoardRow(v: unknown): v is BoardRow {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.rank === 'number' && typeof r.user_id === 'string' && typeof r.display_name === 'string' && typeof r.time_ms === 'number' && typeof r.run_id === 'string';
}

function parseSubmit(v: unknown): SubmitResponse {
  if (typeof v !== 'object' || v === null) throw new OnlineError('server', 'Antwort des Servers unlesbar');
  const r = v as Record<string, unknown>;
  if (r.valid === true && typeof r.runId === 'string' && typeof r.time === 'number' && typeof r.rank === 'number' && typeof r.total === 'number') {
    return { valid: true, runId: r.runId, time: r.time, rank: r.rank, total: r.total, personalBest: r.personalBest === true, improved: r.improved === true };
  }
  if (r.valid === false) return { valid: false, reason: typeof r.reason === 'string' ? r.reason : 'invalid', detail: typeof r.detail === 'string' ? r.detail : null };
  throw new OnlineError('server', 'Antwort des Servers unlesbar');
}

async function httpError(res: Response): Promise<OnlineError> {
  let body: Record<string, unknown> = {};
  try {
    const j: unknown = await res.json();
    if (typeof j === 'object' && j !== null) body = j as Record<string, unknown>;
  } catch {
    // kein JSON
  }
  const msg = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
  // 401 kommt vom Gateway (verify_jwt: Token abgelaufen/ungültig) oder vom Handler (kein Nutzer).
  if (res.status === 401) return new OnlineError('auth', body.error === 'auth' ? msg : 'Anmeldung abgelaufen — bitte neu mit Discord anmelden');
  if (res.status === 403) return new OnlineError(body.error === 'banned' ? 'banned' : 'auth', msg);
  if (res.status === 429) return new OnlineError('rate', msg);
  if (res.status === 413 || res.status === 400) return new OnlineError('invalid', msg);
  return new OnlineError('server', msg);
}

export function createSupabaseApi(url: string, key: string): SupabaseApi {
  const sb: SupabaseClient<Database> = createClient<Database>(url, key, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  return {
    async getSession() {
      const { data, error } = await sb.auth.getSession();
      if (error) throw dbError(error, 'Anmeldung');
      return sessionInfo(data.session);
    },
    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_event, s) => cb(sessionInfo(s)));
      return () => data.subscription.unsubscribe();
    },
    async signInWithDiscord(redirectTo) {
      // scopes 'identify': nur Name/Avatar, keine E-Mail-Freigabe nötig (Supabase fragt 'email' trotzdem mit an).
      const { error } = await sb.auth.signInWithOAuth({ provider: 'discord', options: { redirectTo, scopes: 'identify' } });
      if (error) throw dbError(error, 'Discord-Anmeldung');
    },
    async signOut() {
      const { error } = await sb.auth.signOut({ scope: 'local' });
      if (error) throw dbError(error, 'Abmelden');
    },
    async getProfile(uid) {
      const { data, error } = await sb.from('profiles').select('id, display_name, avatar_url, role').eq('id', uid).maybeSingle();
      if (error) throw dbError(error, 'Profil');
      return data ? { id: data.id, displayName: data.display_name, avatarUrl: data.avatar_url, dev: data.role === 'dev' } : null;
    },
    async updateDisplayName(uid, name) {
      const { error, count } = await sb.from('profiles').update({ display_name: name }, { count: 'exact' }).eq('id', uid);
      if (error) throw error.code === '23514' ? new OnlineError('invalid', 'Name ungültig (2–16 Zeichen: Buchstaben, Ziffern, Leerzeichen, _ - .)') : dbError(error, 'Name');
      if (count === 0) throw new OnlineError('auth', 'Name nicht geändert (nicht angemeldet oder gesperrt)');
    },
    async leaderboard(q, limit, offset) {
      const { data, error } = await sb.rpc('get_leaderboard', { p_level: q.levelId, p_level_hash: q.levelHash, p_physics: q.physics, p_limit: limit, p_offset: offset });
      if (error) throw dbError(error, 'Bestenliste');
      const rows: unknown = data;
      return Array.isArray(rows) ? rows.filter(isBoardRow) : [];
    },
    async rankAround(q, uid, radius) {
      const { data, error } = await sb.rpc('get_rank_around', { p_level: q.levelId, p_level_hash: q.levelHash, p_physics: q.physics, p_user: uid, p_radius: radius });
      if (error) throw dbError(error, 'Bestenliste');
      const rows: unknown = data;
      return Array.isArray(rows) ? rows.filter(isBoardRow) : [];
    },
    async bestRuns(uid) {
      const { data, error } = await sb.from('best_runs').select('level_id, level_hash, physics_version, time_ms, run_id').eq('user_id', uid).eq('hidden', false);
      if (error) throw dbError(error, 'Bestzeiten');
      return (data ?? []).map((r) => ({ levelId: r.level_id, levelHash: r.level_hash, physicsVersion: r.physics_version, timeMs: r.time_ms, runId: r.run_id }));
    },
    async runCount(uid) {
      const { count, error } = await sb.from('runs').select('id', { count: 'exact', head: true }).eq('user_id', uid);
      if (error) throw dbError(error, 'Läufe');
      return count ?? 0;
    },
    async replayPath(runId) {
      const { data, error } = await sb.from('runs').select('replay_path').eq('id', runId).maybeSingle();
      if (error) throw dbError(error, 'Lauf');
      if (!data) throw new OnlineError('notFound', `Lauf ${runId} nicht gefunden`);
      return data.replay_path;
    },
    async downloadReplay(path) {
      const { data } = sb.storage.from('replays').getPublicUrl(path);
      let res: Response;
      try {
        res = await fetch(data.publicUrl);
      } catch {
        throw new OnlineError('offline', 'Ghost: keine Verbindung');
      }
      if (res.status === 404 || res.status === 400) throw new OnlineError('notFound', 'Ghost-Replay nicht gefunden');
      if (!res.ok) throw new OnlineError('server', `Ghost: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async submitRun(bytes, timeoutMs) {
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      const { data, error } = await sb.functions.invoke('submit-run', {
        body: new Blob([copy.buffer], { type: 'application/octet-stream' }),
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: timeoutMs,
      });
      if (error) {
        if (error instanceof FunctionsHttpError) {
          const ctx: unknown = error.context;
          if (ctx instanceof Response) throw await httpError(ctx);
          throw new OnlineError('server', error.message);
        }
        if (error instanceof FunctionsFetchError) {
          const m = String(error.message ?? '');
          throw new OnlineError(/abort|timeout/i.test(m) ? 'timeout' : 'offline', 'Server nicht erreichbar');
        }
        if (error instanceof FunctionsRelayError) throw new OnlineError('offline', 'Server nicht erreichbar');
        throw new OnlineError('server', error instanceof Error ? error.message : 'Einreichen fehlgeschlagen');
      }
      const body: unknown = data;
      return parseSubmit(body);
    },
  };
}
