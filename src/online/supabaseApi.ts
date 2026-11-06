import { createClient, FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { AdminAuditRow, AdminPlayerRow, AdminRunRow, BoardRow, Database, Json, ProfileRpc, ProfileRpcBest } from './supabaseTypes';
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

/** Antwort der Edge Function admin (action deleteRun; supabase/functions/admin/index.ts). */
export interface AdminDeleteResponse {
  readonly runId: string;
  readonly userId: string;
  readonly levelId: string;
  readonly wasBest: boolean;
  readonly newBestRunId: string | null;
  readonly newBestMs: number | null;
  readonly replayRemoved: boolean;
}

export interface AdminRunFilter {
  readonly levelId: string | null;
  readonly uid: string | null;
  readonly limit: number;
  readonly offset: number;
}

export interface AdminPlayerFilter {
  readonly search: string | null;
  readonly bannedOnly: boolean;
  readonly limit: number;
  readonly offset: number;
}

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
  /** RPC get_player_profile: Profil + Bestzeiten/Ränge auf genau diesen Tafeln. null = unbekannt oder gebannt. */
  playerProfile(uid: string, boards: readonly BoardQuery[]): Promise<ProfileRpc | null>;
  /** Storage-Pfad des Replays eines Laufs (null = kein Replay gespeichert). Wirft notFound ohne Lauf. */
  replayPath(runId: string): Promise<string | null>;
  /** Öffentliche Replay-Bytes (Bucket 'replays', ohne Login). */
  downloadReplay(path: string): Promise<Uint8Array>;
  submitRun(bytes: Uint8Array, timeoutMs: number): Promise<SubmitResponse>;
  // ---- Entwickler (Server prüft role = 'dev'; Fehler 42501 → 'auth', 22023 → 'invalid', P0002 → 'notFound')
  adminListRuns(f: AdminRunFilter): Promise<AdminRunRow[]>;
  adminListPlayers(f: AdminPlayerFilter): Promise<AdminPlayerRow[]>;
  adminSetBan(uid: string, banned: boolean, reason: string | null): Promise<AdminPlayerRow | null>;
  adminRename(uid: string, name: string, reason: string | null): Promise<AdminPlayerRow | null>;
  adminAudit(limit: number, offset: number, uid: string | null): Promise<AdminAuditRow[]>;
  /** Edge Function admin (deleteRun): Lauf + Replay löschen, Bestzeit neu bestimmen. */
  adminDeleteRun(runId: string, reason: string, timeoutMs: number): Promise<AdminDeleteResponse>;
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
  // Admin-RPCs: 22023 = Eingabe ungültig (Text nach "invalid: "), P0002 = Ziel unbekannt.
  if (err?.code === '22023') return new OnlineError('invalid', `${what}: ${msg.replace(/^invalid:\s*/, '')}`);
  if (err?.code === 'P0002') return new OnlineError('notFound', `${what}: nicht gefunden`);
  return new OnlineError('server', `${what}: ${msg}`);
}

function isBoardRow(v: unknown): v is BoardRow {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.rank === 'number' && typeof r.user_id === 'string' && typeof r.display_name === 'string' && typeof r.time_ms === 'number' && typeof r.run_id === 'string';
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const optStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseProfileBest(v: unknown): ProfileRpcBest | null {
  const r = rec(v);
  if (!r || typeof r.level_id !== 'string' || typeof r.level_hash !== 'string' || typeof r.time_ms !== 'number' || typeof r.run_id !== 'string') return null;
  return {
    level_id: r.level_id,
    level_hash: r.level_hash,
    physics_version: Number(r.physics_version),
    time_ms: r.time_ms,
    run_id: r.run_id,
    achieved_at: optStr(r.achieved_at) ?? '',
    rank: Number(r.rank),
    total: Number(r.total),
  };
}

/** jsonb von get_player_profile prüfen (null = unbekannt/gebannt). */
export function parseProfileRpc(v: unknown): ProfileRpc | null {
  const r = rec(v);
  if (!r || typeof r.id !== 'string' || typeof r.display_name !== 'string') return null;
  const bests = Array.isArray(r.bests) ? r.bests.map(parseProfileBest).filter((b): b is ProfileRpcBest => b !== null) : [];
  return {
    id: r.id,
    display_name: r.display_name,
    avatar_url: optStr(r.avatar_url),
    role: optStr(r.role) ?? 'player',
    created_at: optStr(r.created_at) ?? '',
    runs: Number(r.runs ?? 0),
    world_records: Number(r.world_records ?? 0),
    bests,
  };
}

function isAdminRunRow(v: unknown): v is AdminRunRow {
  const r = rec(v);
  return !!r && typeof r.run_id === 'string' && typeof r.user_id === 'string' && typeof r.level_id === 'string' && typeof r.time_ms === 'number' && typeof r.created_at === 'string';
}

function isAdminPlayerRow(v: unknown): v is AdminPlayerRow {
  const r = rec(v);
  return !!r && typeof r.user_id === 'string' && typeof r.display_name === 'string' && typeof r.is_banned === 'boolean';
}

function isAdminAuditRow(v: unknown): v is AdminAuditRow {
  const r = rec(v);
  return !!r && typeof r.id === 'number' && typeof r.at === 'string' && typeof r.actor_id === 'string' && typeof r.action === 'string';
}

function rows<T>(data: unknown, guard: (v: unknown) => v is T): T[] {
  return Array.isArray(data) ? data.filter(guard) : [];
}

/** Antwort der Edge Function admin (deleteRun) prüfen. */
export function parseAdminDelete(v: unknown): AdminDeleteResponse {
  const r = rec(v);
  if (!r || r.ok !== true || typeof r.runId !== 'string' || typeof r.userId !== 'string' || typeof r.levelId !== 'string') {
    throw new OnlineError('server', 'Antwort des Servers unlesbar');
  }
  return {
    runId: r.runId,
    userId: r.userId,
    levelId: r.levelId,
    wasBest: r.wasBest === true,
    newBestRunId: optStr(r.newBestRunId),
    newBestMs: typeof r.newBestMs === 'number' ? r.newBestMs : null,
    replayRemoved: r.replayRemoved === true,
  };
}

/** Fehler aus functions.invoke (submit-run, admin) → OnlineError. */
async function invokeError(error: unknown, what: string): Promise<OnlineError> {
  if (error instanceof FunctionsHttpError) {
    const ctx: unknown = error.context;
    if (ctx instanceof Response) return httpError(ctx);
    return new OnlineError('server', error.message);
  }
  if (error instanceof FunctionsFetchError) {
    const m = String(error.message ?? '');
    return new OnlineError(/abort|timeout/i.test(m) ? 'timeout' : 'offline', 'Server nicht erreichbar');
  }
  if (error instanceof FunctionsRelayError) return new OnlineError('offline', 'Server nicht erreichbar');
  return new OnlineError('server', error instanceof Error ? error.message : `${what} fehlgeschlagen`);
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
  if (res.status === 404) return new OnlineError('notFound', msg);
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
    async playerProfile(uid, boards) {
      const p_boards: Json = boards.map((b) => ({ level: b.levelId, level_hash: b.levelHash, physics: b.physics }));
      const { data, error } = await sb.rpc('get_player_profile', { p_user: uid, p_boards });
      // 22P02: keine gültige UUID → wie unbekannt.
      if (error) throw error.code === '22P02' ? new OnlineError('notFound', `Spieler ${uid} unbekannt`) : dbError(error, 'Profil');
      return parseProfileRpc(data);
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
      if (error) throw await invokeError(error, 'Einreichen');
      const body: unknown = data;
      return parseSubmit(body);
    },
    async adminListRuns(f) {
      const { data, error } = await sb.rpc('admin_list_runs', { p_level: f.levelId ?? undefined, p_user: f.uid ?? undefined, p_limit: f.limit, p_offset: f.offset });
      if (error) throw dbError(error, 'Läufe');
      return rows(data, isAdminRunRow);
    },
    async adminListPlayers(f) {
      const { data, error } = await sb.rpc('admin_list_players', { p_search: f.search ?? undefined, p_banned_only: f.bannedOnly, p_limit: f.limit, p_offset: f.offset });
      if (error) throw dbError(error, 'Spieler');
      return rows(data, isAdminPlayerRow);
    },
    async adminSetBan(uid, banned, reason) {
      const { data, error } = await sb.rpc('admin_set_ban', { p_user: uid, p_banned: banned, p_reason: reason ?? undefined });
      if (error) throw dbError(error, banned ? 'Bannen' : 'Entbannen');
      return rows(data, isAdminPlayerRow)[0] ?? null;
    },
    async adminRename(uid, name, reason) {
      const { data, error } = await sb.rpc('admin_rename_player', { p_user: uid, p_name: name, p_reason: reason ?? undefined });
      if (error) throw dbError(error, 'Umbenennen');
      return rows(data, isAdminPlayerRow)[0] ?? null;
    },
    async adminAudit(limit, offset, uid) {
      const { data, error } = await sb.rpc('admin_audit_log', { p_limit: limit, p_offset: offset, p_user: uid ?? undefined });
      if (error) throw dbError(error, 'Protokoll');
      return rows(data, isAdminAuditRow);
    },
    async adminDeleteRun(runId, reason, timeoutMs) {
      const { data, error } = await sb.functions.invoke('admin', { body: { action: 'deleteRun', runId, reason }, timeout: timeoutMs });
      if (error) throw await invokeError(error, 'Löschen');
      const body: unknown = data;
      return parseAdminDelete(body);
    },
  };
}
