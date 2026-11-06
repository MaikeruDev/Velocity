import { PHYSICS_VERSION } from '../engine/replay/format';
import { levelHash } from '../engine/replay/hash';
import type { DesktopAuthError, DesktopAuthFailure, PlatformAuth } from '../platform/types';
import type { CompiledLevel } from '../world/level/compileLevel';
import type { BoardQuery, SessionInfo, SupabaseApi } from './supabaseApi';
import type { AdminAuditRow, AdminPlayerRow, AdminRunRow, BoardRow, Json } from './supabaseTypes';
import type { AdminAction, AdminAuditEntry, AdminAuditQuery, AdminDeleteResult, AdminDetailValue, AdminPage, AdminPlayer, AdminPlayerQuery, AdminRun, AdminRunQuery, AdminService } from './adminTypes';
import type { PlayerProfile, ProfileBest } from './profileTypes';
import type { LeaderboardEntry, LeaderboardPage, LeaderboardRange, OnlineErrorCode, OnlineService, PlayerIdentity, SubmitResult } from './types';
import { OnlineError, displayName, sanitizeName } from './types';

/**
 * Supabase-Backend (Plan 009): Login NUR per Discord (Supabase Auth OAuth, PKCE). Ohne Login bleibt alles
 * spielbar und lesbar (Bestenliste, Ghosts aus dem öffentlichen Bucket); Einreichen braucht den Login.
 *
 *   auth()        stellt eine vorhandene Sitzung wieder her (auch direkt nach dem OAuth-Redirect — supabase-js
 *                 tauscht ?code= beim Start und räumt die URL), lädt das Profil. Nie ein Redirect.
 *   signIn()      Web: signInWithOAuth('discord', redirectTo = Origin + Pfad) — VERLÄSST DIE SEITE.
 *                 Desktop (externalLogin, Plan 011 §3.1): System-Browser + Rücksprung auf 127.0.0.1, Code-Tausch hier
 *                 im Renderer (PKCE-Verifier aus dem eigenen Storage); löst erst mit stehender Identität auf.
 *   submitRun     Edge Function submit-run (verifiziert serverseitig mit demselben Verifier, rankt).
 *   getLeaderboard  RPC get_leaderboard / get_rank_around je Tafel (Level-ID + Level-Hash + PHYSICS_VERSION).
 *   getGhost      runs.replay_path → öffentliche Storage-URL. Das Spiel verifiziert das Replay danach selbst.
 *   getProfile    RPC get_player_profile mit den AKTUELLEN Tafeln aller Level (levelIds) — öffentlich lesbar.
 *   admin         nur bei identity.dev: Admin-RPCs + Edge Function admin (deleteRun). Der Server prüft die Rolle.
 */

export interface SupabaseServiceOptions {
  readonly api: SupabaseApi;
  /** Kompiliertes Level (für den Level-Hash der Tafel) — derselbe Cache wie beim Spielen. */
  readonly loadLevel: (levelId: string) => Promise<CompiledLevel>;
  /** Rücksprung nach dem Discord-Login. Default: location.origin + location.pathname. */
  readonly redirectTo?: () => string;
  /** Zeitlimit fürs Einreichen (ms). Default 20 000. */
  readonly submitTimeoutMs?: number;
  /**
   * Alle spielbaren Level (Game.levelIds). getProfile fragt Ränge für deren aktuelle Tafeln ab. Fehlt sie oder ist
   * sie leer, nimmt getProfile die Level, in denen der Spieler Bestzeiten hat.
   */
  readonly levelIds?: () => readonly string[];
  /** Zeitlimit für Admin-Aktionen über die Edge Function (ms). Default 20 000. */
  readonly adminTimeoutMs?: number;
  /**
   * Desktop (Plan 011 §3.1): Login im System-Browser mit Rücksprung auf einen lokalen Port statt Seiten-Redirect
   * (Electron blockiert die Navigation). Fehlt sie (Web), bleibt signIn() exakt der Redirect von bisher.
   */
  readonly externalLogin?: ExternalLogin | null;
}

/** Was SupabaseService vom Desktop-Login braucht (platform.auth ohne den Sitzungstresor, den nutzt supabaseApi). */
export type ExternalLogin = Pick<PlatformAuth, 'begin' | 'openExternal' | 'cancel'>;

/** Gründe des Hauptprozesses → OnlineError-Code (der Text kommt fertig mit). */
const LOGIN_ERROR_CODES: Readonly<Record<DesktopAuthError, OnlineErrorCode>> = {
  ports: 'unavailable',
  url: 'unavailable',
  open: 'unavailable',
  timeout: 'timeout',
  denied: 'auth',
  provider: 'auth',
  cancelled: 'auth',
};

const LOGIN_UNAVAILABLE = 'Desktop-Login nicht verfügbar — bitte das Spiel neu starten';

function isLoginFailure(v: unknown): v is DesktopAuthFailure {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return r.ok === false && typeof r.error === 'string' && Object.hasOwn(LOGIN_ERROR_CODES, r.error) && typeof r.detail === 'string';
}

function isLoginBegin(v: unknown): v is { readonly ok: true; readonly redirectUrl: string } | DesktopAuthFailure {
  if (isLoginFailure(v)) return true;
  const r = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  return r !== null && r.ok === true && typeof r.redirectUrl === 'string';
}

function isLoginResult(v: unknown): v is { readonly ok: true; readonly code: string } | DesktopAuthFailure {
  if (isLoginFailure(v)) return true;
  const r = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  return r !== null && r.ok === true && typeof r.code === 'string' && r.code !== '';
}

/** IPC-Aufruf: abgelehnt (kein Login-Modul) oder unlesbare Antwort → 'unavailable' statt eines rohen Fehlers. */
async function bridgeCall<T>(call: () => Promise<unknown>, valid: (v: unknown) => v is T): Promise<T> {
  let v: unknown;
  try {
    v = await call();
  } catch {
    throw new OnlineError('unavailable', LOGIN_UNAVAILABLE);
  }
  if (!valid(v)) throw new OnlineError('unavailable', LOGIN_UNAVAILABLE);
  return v;
}

function loginError(f: DesktopAuthFailure): OnlineError {
  return new OnlineError(LOGIN_ERROR_CODES[f.error], f.detail.trim().slice(0, 300) || 'Anmeldung fehlgeschlagen');
}

export class SupabaseService implements OnlineService {
  readonly backend = 'supabase' as const;
  readonly loginRequired = true;
  private readonly api: SupabaseApi;
  private readonly opts: SupabaseServiceOptions;
  private me: PlayerIdentity | null = null;
  private restoring: Promise<PlayerIdentity | null> | null = null;
  private readonly listeners = new Set<(id: PlayerIdentity | null) => void>();
  private readonly hashes = new WeakMap<CompiledLevel, string>();
  private readonly adminTools: AdminService;
  /** Laufender Desktop-Login (ein Versuch zur Zeit) und seine Auth-URL (für einen zweiten Klick). */
  private loginRun: Promise<void> | null = null;
  private loginUrl: string | null = null;

  constructor(opts: SupabaseServiceOptions) {
    this.opts = opts;
    this.api = opts.api;
    this.adminTools = new SupabaseAdmin(opts.api, opts.adminTimeoutMs ?? 20_000);
    this.api.onAuthChange((s) => void this.applySession(s));
  }

  get identity(): PlayerIdentity | null {
    return this.me;
  }

  /** Nur für Entwickler sichtbar — Sicherheit hängt NICHT daran (jede Admin-RPC prüft role = 'dev' selbst). */
  get admin(): AdminService | null {
    return this.me?.dev ? this.adminTools : null;
  }

  onIdentityChange(cb: (id: PlayerIdentity | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Sitzung wiederherstellen (kein Redirect). Der Wunschname wird ignoriert — der Name steht im Profil. */
  async auth(_name?: string): Promise<PlayerIdentity | null> {
    if (this.me) return this.me;
    if (!this.restoring) {
      this.restoring = this.api
        .getSession()
        .then((s) => this.applySession(s))
        .finally(() => {
          this.restoring = null;
        });
    }
    return this.restoring;
  }

  async signIn(): Promise<void> {
    const ext = this.opts.externalLogin;
    if (ext) return this.signInExternal(ext);
    const to = this.opts.redirectTo ? this.opts.redirectTo() : `${location.origin}${location.pathname}`;
    await this.api.signInWithDiscord(to);
  }

  async signOut(): Promise<void> {
    await this.api.signOut();
    this.setMe(null);
  }

  async setName(name: string): Promise<PlayerIdentity> {
    const me = this.requireMe();
    const clean = sanitizeName(name);
    if (clean === '' || clean === me.name) return me;
    await this.api.updateDisplayName(me.uid, clean);
    const next: PlayerIdentity = { ...me, name: clean };
    this.setMe(next);
    return next;
  }

  async submitRun(bytes: Uint8Array): Promise<SubmitResult> {
    await this.auth();
    this.requireMe();
    const res = await this.api.submitRun(bytes, this.opts.submitTimeoutMs ?? 20_000);
    if (!res.valid) {
      return { status: 'rejected', runId: null, time: null, rank: null, total: 0, personalBest: false, improved: false, reason: res.reason, detail: res.detail };
    }
    return { status: 'accepted', runId: res.runId, time: res.time, rank: res.rank, total: res.total, personalBest: res.personalBest, improved: res.improved, reason: null, detail: null };
  }

  async getLeaderboard(levelId: string, range: LeaderboardRange): Promise<LeaderboardPage> {
    const q = await this.board(levelId);
    const meId = this.me?.uid ?? null;
    let rows: BoardRow[];
    let mine: BoardRow[] = [];
    if (range.kind === 'top') {
      const limit = Math.max(0, Math.min(100, Math.floor(range.limit)));
      [rows, mine] = await Promise.all([this.api.leaderboard(q, limit, 0), meId ? this.api.rankAround(q, meId, 0) : Promise.resolve([])]);
    } else {
      const uid = range.uid ?? meId;
      rows = uid ? await this.api.rankAround(q, uid, Math.max(0, Math.min(50, Math.floor(range.radius)))) : [];
      mine = meId ? rows.filter((r) => r.user_id === meId) : [];
    }
    const entries = rows.map(toEntry);
    const meRow = mine.find((r) => r.user_id === meId) ?? null;
    // total steht in jeder Zeile; ohne Zeilen (leere Tafel bzw. "um mich" ohne eigenen Lauf) ist es 0/unbekannt.
    const total = Number(rows[0]?.total ?? meRow?.total ?? 0);
    return { levelId, entries, total, me: meRow ? toEntry(meRow) : null };
  }

  async getGhost(runId: string): Promise<Uint8Array> {
    const path = await this.api.replayPath(runId);
    if (path === null) throw new OnlineError('notFound', 'Zu diesem Lauf gibt es kein Replay');
    return this.api.downloadReplay(path);
  }

  async getProfile(uid?: string): Promise<PlayerProfile> {
    await this.auth();
    const id = uid ?? this.me?.uid;
    if (!id) throw new OnlineError('auth', 'Nicht angemeldet');
    let ids: string[] = this.opts.levelIds ? [...this.opts.levelIds()] : [];
    if (ids.length === 0) ids = [...new Set((await this.api.bestRuns(id)).map((b) => b.levelId))];
    // Nur die aktuellen Tafeln (Level-Stand + Physik) — alte Hashes sind eigene, eingefrorene Bestenlisten.
    const boards: BoardQuery[] = [];
    for (const lv of ids) {
      try {
        boards.push(await this.board(lv));
      } catch {
        // Level nicht ladbar → ohne diese Tafel
      }
    }
    const p = await this.api.playerProfile(id, boards);
    if (!p) throw new OnlineError('notFound', `Spieler ${id} unbekannt`);
    const bests: ProfileBest[] = p.bests
      .map((b) => ({ levelId: b.level_id, time: b.time_ms / 1000, rank: b.rank, total: b.total, runId: b.run_id, date: b.achieved_at }))
      .sort((a, b) => a.levelId.localeCompare(b.levelId));
    return {
      uid: p.id,
      name: displayName(p.display_name, p.id),
      avatarUrl: p.avatar_url,
      dev: p.role === 'dev',
      memberSince: p.created_at || null,
      runs: p.runs,
      worldRecords: p.world_records,
      bests,
    };
  }

  // ------------------------------------------------------------------ intern

  /**
   * Desktop-Login: ein Versuch zur Zeit. Ein zweiter Klick (Browser-Tab geschlossen?) öffnet dieselbe Auth-URL erneut —
   * gleicher Verifier, gleicher state, der Hauptprozess wartet weiter auf denselben Rücksprung — statt neu zu beginnen.
   */
  private signInExternal(ext: ExternalLogin): Promise<void> {
    if (this.loginRun) {
      const url = this.loginUrl;
      if (url !== null) void bridgeCall(() => ext.openExternal(url), isLoginResult).catch(() => undefined);
      return this.loginRun;
    }
    const run = this.runExternalLogin(ext).finally(() => {
      this.loginRun = null;
      this.loginUrl = null;
    });
    this.loginRun = run;
    return run;
  }

  private async runExternalLogin(ext: ExternalLogin): Promise<void> {
    const begin = await bridgeCall(() => ext.begin(), isLoginBegin);
    if (!begin.ok) throw loginError(begin);
    let auth: { readonly url: string; readonly flowId: string | null };
    try {
      auth = await this.api.discordAuthUrl(begin.redirectUrl);
    } catch (err) {
      // Ohne Auth-URL wartet niemand auf den Empfänger — sofort zu statt erst nach der Frist.
      try {
        ext.cancel();
      } catch {
        // Bridge weg: der Hauptprozess schließt ihn spätestens nach der Frist
      }
      throw err;
    }
    this.loginUrl = auth.url;
    const res = await bridgeCall(() => ext.openExternal(auth.url), isLoginResult);
    if (!res.ok) throw loginError(res);
    // supabase-js holt den Verifier dieses Flows aus dem eigenen Storage, speichert die Sitzung und meldet SIGNED_IN.
    const s = await this.api.exchangeCode(res.code, auth.flowId);
    await this.applySession(s);
  }

  private requireMe(): PlayerIdentity {
    if (!this.me) throw new OnlineError('auth', 'Mit Discord anmelden, um Läufe einzureichen');
    return this.me;
  }

  private async board(levelId: string): Promise<BoardQuery> {
    const level = await this.opts.loadLevel(levelId);
    let h = this.hashes.get(level);
    if (h === undefined) {
      h = levelHash(level);
      this.hashes.set(level, h);
    }
    return { levelId, levelHash: h, physics: PHYSICS_VERSION };
  }

  private async applySession(s: SessionInfo | null): Promise<PlayerIdentity | null> {
    if (!s) {
      this.setMe(null);
      return null;
    }
    if (this.me?.uid === s.uid) return this.me;
    // Sofort mit den Discord-Metadaten anmelden, Profilname (ggf. umbenannt) nachziehen.
    this.setMe({ uid: s.uid, name: displayName(sanitizeName(s.metaName ?? ''), s.uid), provider: 'discord', avatarUrl: s.metaAvatar, dev: false });
    try {
      const p = await this.api.getProfile(s.uid);
      if (p && this.me?.uid === s.uid) this.setMe({ uid: s.uid, name: displayName(p.displayName, s.uid), provider: 'discord', avatarUrl: p.avatarUrl ?? s.metaAvatar, dev: p.dev });
    } catch {
      // Profil (noch) nicht lesbar — der Metadaten-Name reicht für die Anzeige.
    }
    return this.me;
  }

  private setMe(id: PlayerIdentity | null): void {
    const prev = this.me;
    this.me = id;
    if (prev?.uid === id?.uid && prev?.name === id?.name && prev?.avatarUrl === id?.avatarUrl && prev?.dev === id?.dev) return;
    for (const cb of this.listeners) cb(id);
  }
}

function toEntry(r: BoardRow): LeaderboardEntry {
  return {
    rank: Number(r.rank),
    runId: r.run_id,
    uid: r.user_id,
    name: displayName(r.display_name, r.user_id),
    time: r.time_ms / 1000,
    date: r.achieved_at,
    bot: false,
    avatarUrl: r.avatar_url ?? null,
    dev: r.role === 'dev',
  };
}

// ------------------------------------------------------------------ Entwickler-Werkzeuge

const ADMIN_ACTIONS: readonly AdminAction[] = ['ban', 'unban', 'rename', 'delete_run'];

function clampLimit(v: number | undefined): number {
  return Math.max(1, Math.min(200, Math.floor(v ?? 50)));
}

function clampOffset(v: number | undefined): number {
  return Math.max(0, Math.floor(v ?? 0));
}

function cleanText(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

/** total steht in jeder Zeile (count over ()); hinter der letzten Seite gibt es keine Zeile → 0. */
function page<R extends { readonly total: number }, T>(rows: readonly R[], map: (r: R) => T): AdminPage<T> {
  return { items: rows.map(map), total: Number(rows[0]?.total ?? 0) };
}

function toAdminRun(r: AdminRunRow): AdminRun {
  return {
    runId: r.run_id,
    uid: r.user_id,
    name: displayName(r.display_name, r.user_id),
    dev: r.role === 'dev',
    banned: r.is_banned,
    levelId: r.level_id,
    levelHash: r.level_hash,
    physicsVersion: Number(r.physics_version),
    time: r.time_ms / 1000,
    ticks: Number(r.ticks),
    date: r.created_at,
    replayPath: r.replay_path ?? null,
    best: r.is_best,
  };
}

function toAdminPlayer(r: AdminPlayerRow): AdminPlayer {
  return {
    uid: r.user_id,
    name: displayName(r.display_name, r.user_id),
    discordName: r.discord_name ?? null,
    avatarUrl: r.avatar_url ?? null,
    dev: r.role === 'dev',
    banned: r.is_banned,
    banReason: r.ban_reason ?? null,
    bannedAt: r.banned_at ?? null,
    memberSince: r.created_at || null,
    runs: Number(r.runs),
  };
}

function flatDetail(d: Json): Record<string, AdminDetailValue> {
  const out: Record<string, AdminDetailValue> = {};
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return out;
  for (const [k, v] of Object.entries(d)) {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

function toAudit(r: AdminAuditRow): AdminAuditEntry | null {
  const action = ADMIN_ACTIONS.find((a) => a === r.action);
  if (!action) return null;
  return {
    id: Number(r.id),
    at: r.at,
    actorUid: r.actor_id,
    actorName: r.actor_name ?? null,
    action,
    targetUid: r.target_user ?? null,
    targetName: r.target_name ?? null,
    runId: r.target_run ?? null,
    detail: flatDetail(r.detail),
  };
}

/** AdminService über den Adapter. Prüft Eingaben vorab (spart Rundreisen) — maßgeblich ist der Server. */
class SupabaseAdmin implements AdminService {
  constructor(
    private readonly api: SupabaseApi,
    private readonly timeoutMs: number,
  ) {}

  async listRuns(q: AdminRunQuery = {}): Promise<AdminPage<AdminRun>> {
    const rows = await this.api.adminListRuns({ levelId: q.levelId ?? null, uid: q.uid ?? null, limit: clampLimit(q.limit), offset: clampOffset(q.offset) });
    return page(rows, toAdminRun);
  }

  async listPlayers(q: AdminPlayerQuery = {}): Promise<AdminPage<AdminPlayer>> {
    const rows = await this.api.adminListPlayers({ search: cleanText(q.search), bannedOnly: q.bannedOnly ?? false, limit: clampLimit(q.limit), offset: clampOffset(q.offset) });
    return page(rows, toAdminPlayer);
  }

  async setBan(uid: string, banned: boolean, reason?: string): Promise<AdminPlayer> {
    const why = cleanText(reason);
    if (banned && why === null) throw new OnlineError('invalid', 'Begründung nötig');
    const row = await this.api.adminSetBan(uid, banned, why);
    if (!row) throw new OnlineError('notFound', `Spieler ${uid} unbekannt`);
    return toAdminPlayer(row);
  }

  async renamePlayer(uid: string, name: string, reason?: string): Promise<AdminPlayer> {
    const clean = sanitizeName(name);
    if (clean === '') throw new OnlineError('invalid', 'Name ungültig (2–16 Zeichen: Buchstaben, Ziffern, Leerzeichen, _ - .)');
    const row = await this.api.adminRename(uid, clean, cleanText(reason));
    if (!row) throw new OnlineError('notFound', `Spieler ${uid} unbekannt`);
    return toAdminPlayer(row);
  }

  async deleteRun(runId: string, reason: string): Promise<AdminDeleteResult> {
    const why = cleanText(reason);
    if (why === null) throw new OnlineError('invalid', 'Begründung nötig');
    const r = await this.api.adminDeleteRun(runId, why, this.timeoutMs);
    return {
      runId: r.runId,
      uid: r.userId,
      levelId: r.levelId,
      wasBest: r.wasBest,
      newBest: r.newBestRunId !== null && r.newBestMs !== null ? { runId: r.newBestRunId, time: r.newBestMs / 1000 } : null,
      replayRemoved: r.replayRemoved,
    };
  }

  async auditLog(q: AdminAuditQuery = {}): Promise<AdminPage<AdminAuditEntry>> {
    const rows = await this.api.adminAudit(clampLimit(q.limit), clampOffset(q.offset), q.uid ?? null);
    return { items: rows.map(toAudit).filter((e): e is AdminAuditEntry => e !== null), total: Number(rows[0]?.total ?? 0) };
  }
}
