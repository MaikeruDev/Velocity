import { PHYSICS_VERSION } from '../engine/replay/format';
import { levelHash } from '../engine/replay/hash';
import type { CompiledLevel } from '../world/level/compileLevel';
import type { BoardQuery, SessionInfo, SupabaseApi } from './supabaseApi';
import type { BoardRow } from './supabaseTypes';
import type { LeaderboardEntry, LeaderboardPage, LeaderboardRange, OnlineService, PlayerIdentity, PlayerProfile, SubmitResult } from './types';
import { OnlineError, displayName, sanitizeName } from './types';

/**
 * Supabase-Backend (Plan 009): Login NUR per Discord (Supabase Auth OAuth, PKCE). Ohne Login bleibt alles
 * spielbar und lesbar (Bestenliste, Ghosts aus dem öffentlichen Bucket); Einreichen braucht den Login.
 *
 *   auth()        stellt eine vorhandene Sitzung wieder her (auch direkt nach dem OAuth-Redirect — supabase-js
 *                 tauscht ?code= beim Start und räumt die URL), lädt das Profil. Nie ein Redirect.
 *   signIn()      signInWithOAuth('discord', redirectTo = Origin + Pfad) — VERLÄSST DIE SEITE.
 *   submitRun     Edge Function submit-run (verifiziert serverseitig mit demselben Verifier, rankt).
 *   getLeaderboard  RPC get_leaderboard / get_rank_around je Tafel (Level-ID + Level-Hash + PHYSICS_VERSION).
 *   getGhost      runs.replay_path → öffentliche Storage-URL. Das Spiel verifiziert das Replay danach selbst.
 */

export interface SupabaseServiceOptions {
  readonly api: SupabaseApi;
  /** Kompiliertes Level (für den Level-Hash der Tafel) — derselbe Cache wie beim Spielen. */
  readonly loadLevel: (levelId: string) => Promise<CompiledLevel>;
  /** Rücksprung nach dem Discord-Login. Default: location.origin + location.pathname. */
  readonly redirectTo?: () => string;
  /** Zeitlimit fürs Einreichen (ms). Default 20 000. */
  readonly submitTimeoutMs?: number;
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

  constructor(opts: SupabaseServiceOptions) {
    this.opts = opts;
    this.api = opts.api;
    this.api.onAuthChange((s) => void this.applySession(s));
  }

  get identity(): PlayerIdentity | null {
    return this.me;
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
    const [profile, bests, runs] = await Promise.all([this.api.getProfile(id), this.api.bestRuns(id), this.api.runCount(id)]);
    if (!profile) throw new OnlineError('notFound', `Spieler ${id} unbekannt`);
    const out: { levelId: string; time: number; rank: number; runId: string }[] = [];
    for (const b of bests) {
      if (b.physicsVersion !== PHYSICS_VERSION) continue;
      let q: BoardQuery;
      try {
        q = await this.board(b.levelId);
      } catch {
        continue;
      }
      // Nur die aktuelle Tafel (Level-Stand) zählt — alte Hashes sind eigene, eingefrorene Bestenlisten.
      if (q.levelHash !== b.levelHash) continue;
      const row = (await this.api.rankAround(q, id, 0))[0];
      out.push({ levelId: b.levelId, time: b.timeMs / 1000, rank: row ? Number(row.rank) : 0, runId: b.runId });
    }
    out.sort((a, b) => a.levelId.localeCompare(b.levelId));
    return { uid: id, name: displayName(profile.displayName, id), runs, bests: out };
  }

  // ------------------------------------------------------------------ intern

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
