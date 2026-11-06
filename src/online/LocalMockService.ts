import type { StorageLike } from '../engine/Settings';
import { defaultStorage } from '../engine/Settings';
import { BotRun } from '../engine/replay/botRun';
import { base64ToBytes, bytesToBase64, packReplay, ReplayFormatError, unpackReplay } from '../engine/replay/codec';
import { levelHash } from '../engine/replay/hash';
import { verifyReplay } from '../engine/replay/verify';
import type { CompiledLevel } from '../world/level/compileLevel';
import { PHYSICS_VERSION } from '../engine/replay/format';
import type { AdminAction, AdminAuditEntry, AdminAuditQuery, AdminDeleteResult, AdminDetailValue, AdminPage, AdminPlayer, AdminPlayerQuery, AdminRun, AdminRunQuery, AdminService } from './adminTypes';
import type { PlayerProfile, ProfileBest } from './profileTypes';
import type { LeaderboardEntry, LeaderboardPage, LeaderboardRange, OnlineService, PlayerIdentity, SubmitResult } from './types';
import { OnlineError, displayName, sanitizeName } from './types';

/**
 * Online-Attrappe (Plan 009): alles in localStorage, aber mit dem ECHTEN Ablauf — das Replay wird
 * entpackt und mit dem Verifier gegen das Level nachgerechnet, gezählt wird die nachgerechnete Zeit,
 * je Spieler und Level bleibt der beste Lauf (mit Replay für den Ghost). Latenz und Ausfälle lassen
 * sich simulieren, damit das Spiel seine Lade-/Fehlerzustände zeigt.
 *
 * Rivalen: beim ersten Blick auf eine Bestenliste fährt der RouteFollower das Level mit
 * verschiedenen Zielfehlern (BotRun, stückweise mit Pausen — der Browser bleibt bedienbar). Neu,
 * sobald sich der Level-Hash ändert. So gibt es ohne Server Einträge, deren Ghost man laden kann.
 */

export const MOCK_KEY = 'velocity.online.mock.v1';

export interface MockOptions {
  readonly storage?: StorageLike | null;
  /** Kompiliertes Level zur Prüfung (Game: derselbe Cache wie beim Spielen). */
  readonly loadLevel: (levelId: string) => Promise<CompiledLevel>;
  /** Simulierte Latenz (ms) je Aufruf; Default 120 (+ bis 50 % Zufall). */
  readonly latencyMs?: number;
  /** Anteil der Aufrufe, die mit 'offline' scheitern (0..1). Default 0. */
  readonly failRate?: number;
  /** Bot-Rivalen erzeugen. Default true. */
  readonly rivals?: boolean;
  readonly random?: () => number;
  /**
   * Lokaler Spieler ist Entwickler (identity.dev, `admin` verfügbar) — zum Bauen der Moderations-UI ohne Server
   * (`?online=mock&mockdev`). Der Mock kennt keine Rechteprüfung; er hält nur dieselben Regeln ein.
   */
  readonly dev?: boolean;
}

interface StoredRun {
  readonly runId: string;
  readonly uid: string;
  readonly levelId: string;
  readonly time: number;
  readonly date: string;
  readonly bot: boolean;
  readonly replay: string;
}

interface StoredUser {
  readonly uid: string;
  name: string;
  runs: number;
  /** ISO-Datum des Anlegens (fehlt bei älteren Mock-Daten). */
  created?: string;
  banned?: boolean;
  banReason?: string | null;
  bannedAt?: string | null;
}

interface StoredAudit {
  readonly id: number;
  readonly at: string;
  readonly actor: string;
  readonly action: AdminAction;
  readonly target: string | null;
  readonly run: string | null;
  readonly detail: Record<string, AdminDetailValue>;
}

interface MockDb {
  v: 1;
  me: string | null;
  users: Record<string, StoredUser>;
  /** Bester Lauf je (uid, level): Schlüssel `${levelId}/${uid}`. */
  runs: Record<string, StoredRun>;
  /** Level-Hash, für den die Rivalen erzeugt wurden. */
  rivals: Record<string, string>;
  /** Moderations-Protokoll (nur mit dev). */
  audit: StoredAudit[];
}

/** Rivalen: Name und Zielfehler der Hand (Grad). */
const RIVALS: readonly { readonly name: string; readonly noise: number; readonly seed: number }[] = [
  { name: 'NEONHAWK', noise: 0.5, seed: 11 },
  { name: 'b4nnyb0y', noise: 1, seed: 23 },
  { name: 'SURF_KÖNIGIN', noise: 1.5, seed: 37 },
  { name: 'Pixelfuchs', noise: 2, seed: 41 },
  { name: 'Gelegenheit', noise: 3, seed: 53 },
  { name: 'W-Halter', noise: 4.5, seed: 67 },
];

/** Ticks je Häppchen, bevor der Rivalen-Bau an den Browser abgibt. */
const RIVAL_SLICE = 2048;

const ACTIONS: readonly AdminAction[] = ['ban', 'unban', 'rename', 'delete_run'];

function emptyDb(): MockDb {
  return { v: 1, me: null, users: {}, runs: {}, rivals: {}, audit: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseDb(raw: unknown): MockDb {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.users) || !isRecord(raw.runs) || !isRecord(raw.rivals)) return emptyDb();
  const db = emptyDb();
  db.me = typeof raw.me === 'string' ? raw.me : null;
  for (const [k, u] of Object.entries(raw.users)) {
    if (isRecord(u) && typeof u.uid === 'string' && typeof u.name === 'string' && typeof u.runs === 'number') {
      db.users[k] = {
        uid: u.uid,
        name: u.name,
        runs: u.runs,
        created: typeof u.created === 'string' ? u.created : undefined,
        banned: u.banned === true,
        banReason: typeof u.banReason === 'string' ? u.banReason : null,
        bannedAt: typeof u.bannedAt === 'string' ? u.bannedAt : null,
      };
    }
  }
  for (const [k, r] of Object.entries(raw.runs)) {
    if (
      isRecord(r) &&
      typeof r.runId === 'string' &&
      typeof r.uid === 'string' &&
      typeof r.levelId === 'string' &&
      typeof r.time === 'number' &&
      typeof r.date === 'string' &&
      typeof r.bot === 'boolean' &&
      typeof r.replay === 'string'
    ) {
      db.runs[k] = { runId: r.runId, uid: r.uid, levelId: r.levelId, time: r.time, date: r.date, bot: r.bot, replay: r.replay };
    }
  }
  for (const [k, h] of Object.entries(raw.rivals)) if (typeof h === 'string') db.rivals[k] = h;
  if (Array.isArray(raw.audit)) {
    for (const a of raw.audit) {
      const action = isRecord(a) ? ACTIONS.find((x) => x === a.action) : undefined;
      if (!isRecord(a) || !action || typeof a.id !== 'number' || typeof a.at !== 'string' || typeof a.actor !== 'string') continue;
      const detail: Record<string, AdminDetailValue> = {};
      if (isRecord(a.detail)) for (const [k, v] of Object.entries(a.detail)) if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') detail[k] = v;
      db.audit.push({ id: a.id, at: a.at, actor: a.actor, action, target: typeof a.target === 'string' ? a.target : null, run: typeof a.run === 'string' ? a.run : null, detail });
    }
  }
  return db;
}

export class LocalMockService implements OnlineService {
  readonly backend = 'mock' as const;
  /** Der Mock meldet still an — kein Login-Knopf, Einreichen geht immer. */
  readonly loginRequired = false;
  private readonly identityListeners = new Set<(id: PlayerIdentity | null) => void>();
  private readonly storage: StorageLike | null;
  private readonly opts: MockOptions;
  private readonly random: () => number;
  private db: MockDb;
  /** Laufender Rivalen-Bau je Level (nur einer gleichzeitig je Level). */
  private readonly building = new Map<string, Promise<void>>();

  constructor(opts: MockOptions) {
    this.opts = opts;
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.random = opts.random ?? Math.random;
    this.db = this.read();
  }

  get identity(): PlayerIdentity | null {
    const me = this.db.me;
    const u = me ? this.db.users[me] : undefined;
    return u ? { uid: u.uid, name: displayName(u.name, u.uid), provider: 'local', avatarUrl: null, dev: this.opts.dev ?? false } : null;
  }

  /** Nur mit MockOptions.dev (lokale Moderation für UI-Entwicklung). */
  get admin(): AdminService | null {
    return this.opts.dev ? this.adminTools : null;
  }

  private readonly adminTools: AdminService = {
    listRuns: (q) => this.adminListRuns(q),
    listPlayers: (q) => this.adminListPlayers(q),
    setBan: (uid, banned, reason) => this.adminSetBan(uid, banned, reason),
    renamePlayer: (uid, name, reason) => this.adminRename(uid, name, reason),
    deleteRun: (runId, reason) => this.adminDeleteRun(runId, reason),
    auditLog: (q) => this.adminAudit(q),
  };

  onIdentityChange(cb: (id: PlayerIdentity | null) => void): () => void {
    this.identityListeners.add(cb);
    return () => this.identityListeners.delete(cb);
  }

  async signIn(): Promise<void> {
    await this.auth();
  }

  async signOut(): Promise<void> {
    // Lokaler Spieler bleibt — der Mock kennt kein Abmelden.
  }

  async auth(name?: string): Promise<PlayerIdentity> {
    await this.net();
    let changed = false;
    if (this.db.me === null || !this.db.users[this.db.me]) {
      const uid = `local-${this.hex(8)}`;
      this.db.users[uid] = { uid, name: sanitizeName(name ?? ''), runs: 0, created: new Date().toISOString() };
      this.db.me = uid;
      this.write();
      changed = true;
    } else if (name !== undefined && sanitizeName(name) !== this.db.users[this.db.me].name) {
      this.db.users[this.db.me].name = sanitizeName(name);
      this.write();
      changed = true;
    }
    const id = this.identity;
    if (!id) throw new OnlineError('auth', 'Anmeldung fehlgeschlagen');
    if (changed) for (const cb of this.identityListeners) cb(id);
    return id;
  }

  async setName(name: string): Promise<PlayerIdentity> {
    return this.auth(name);
  }

  async submitRun(bytes: Uint8Array): Promise<SubmitResult> {
    const me = await this.auth();
    await this.net();
    if (this.db.users[me.uid]?.banned) throw new OnlineError('banned', 'Konto gesperrt');
    let rep;
    try {
      rep = await unpackReplay(bytes);
    } catch (err) {
      return reject('format', err instanceof ReplayFormatError ? err.message : 'Replay unlesbar');
    }
    const levelId = rep.header.levelId;
    let level: CompiledLevel;
    try {
      level = await this.opts.loadLevel(levelId);
    } catch {
      return reject('level', `Level ${levelId} unbekannt`);
    }
    const res = verifyReplay(rep, level);
    if (!res.valid || res.time === null) return reject(res.reason ?? 'invalid', res.detail);
    const user = this.db.users[me.uid];
    user.runs++;
    const key = `${levelId}/${me.uid}`;
    const prev = this.db.runs[key];
    const runId = `run-${this.hex(10)}`;
    const personalBest = !prev || res.time < prev.time;
    const improved = personalBest && prev !== undefined;
    if (personalBest) {
      this.db.runs[key] = { runId, uid: me.uid, levelId, time: res.time, date: new Date().toISOString(), bot: rep.header.assisted, replay: bytesToBase64(bytes) };
    }
    this.write();
    const board = this.board(levelId);
    const mine = board.find((e) => e.uid === me.uid) ?? null;
    return { status: 'accepted', runId, time: res.time, rank: mine ? mine.rank : null, total: board.length, personalBest, improved, reason: null, detail: null };
  }

  async getLeaderboard(levelId: string, range: LeaderboardRange): Promise<LeaderboardPage> {
    await this.net();
    if (this.opts.rivals ?? true) await this.ensureRivals(levelId);
    const board = this.board(levelId);
    const meId = this.db.me;
    const me = board.find((e) => e.uid === meId) ?? null;
    let entries: LeaderboardEntry[];
    if (range.kind === 'top') entries = board.slice(0, Math.max(0, range.limit));
    else {
      const uid = range.uid ?? meId;
      const i = board.findIndex((e) => e.uid === uid);
      entries = i < 0 ? [] : board.slice(Math.max(0, i - range.radius), i + range.radius + 1);
    }
    return { levelId, entries, total: board.length, me };
  }

  async getGhost(runId: string): Promise<Uint8Array> {
    await this.net();
    const run = Object.values(this.db.runs).find((r) => r.runId === runId);
    if (!run) throw new OnlineError('notFound', `Lauf ${runId} nicht gefunden`);
    return base64ToBytes(run.replay);
  }

  async getProfile(uid?: string): Promise<PlayerProfile> {
    const me = await this.auth();
    const id = uid ?? me.uid;
    const u = this.db.users[id];
    // Gebannte sind öffentlich unbekannt (wie Supabase); nur sie selbst sehen ihr Profil — ohne Bestzeiten.
    if (!u || (u.banned && id !== me.uid)) throw new OnlineError('notFound', `Spieler ${id} unbekannt`);
    const bests: ProfileBest[] = [];
    if (!u.banned) {
      for (const r of Object.values(this.db.runs)) {
        if (r.uid !== id) continue;
        const board = this.board(r.levelId);
        const rank = board.find((e) => e.uid === id)?.rank ?? 0;
        bests.push({ levelId: r.levelId, time: r.time, rank, total: board.length, runId: r.runId, date: r.date });
      }
    }
    bests.sort((a, b) => a.levelId.localeCompare(b.levelId));
    return {
      uid: id,
      name: displayName(u.name, u.uid),
      avatarUrl: null,
      dev: id === me.uid && (this.opts.dev ?? false),
      memberSince: u.created ?? null,
      runs: u.runs,
      worldRecords: bests.filter((b) => b.rank === 1).length,
      bests,
    };
  }

  /** Test/Tools: alles löschen. */
  reset(): void {
    this.db = emptyDb();
    this.write();
  }

  /** Rivalen eines Levels jetzt bauen (Tests, Tools); sonst lazy beim ersten getLeaderboard. */
  ensureRivals(levelId: string): Promise<void> {
    let p = this.building.get(levelId);
    if (!p) {
      p = this.buildRivals(levelId).finally(() => this.building.delete(levelId));
      this.building.set(levelId, p);
    }
    return p;
  }

  // ------------------------------------------------------------------ intern

  private async buildRivals(levelId: string): Promise<void> {
    let level: CompiledLevel;
    try {
      level = await this.opts.loadLevel(levelId);
    } catch {
      return;
    }
    if (!level.def.route || level.def.route.length === 0) return;
    const hash = levelHash(level);
    if (this.db.rivals[levelId] === hash) return;
    // Alte Rivalen (anderer Level-Stand) weg — ihre Replays verifizieren nicht mehr.
    for (const [k, r] of Object.entries(this.db.runs)) if (r.levelId === levelId && r.uid.startsWith('rival-')) delete this.db.runs[k];
    for (const rv of RIVALS) {
      const run = new BotRun(level, { follower: { aimNoiseDeg: rv.noise, seed: rv.seed } });
      while (run.step(RIVAL_SLICE) === 'running') await pause();
      const rep = run.result;
      if (!rep) continue;
      const uid = `rival-${rv.seed}`;
      this.db.users[uid] ??= { uid, name: rv.name, runs: 0 };
      this.db.users[uid].runs++;
      const bytes = await packReplay(rep);
      this.db.runs[`${levelId}/${uid}`] = {
        runId: `rival-${levelId}-${rv.seed}`,
        uid,
        levelId,
        time: rep.header.time,
        // Feste Daten: Rivalen sind "schon immer" da.
        date: '2026-09-30T12:00:00.000Z',
        bot: true,
        replay: bytesToBase64(bytes),
      };
    }
    this.db.rivals[levelId] = hash;
    this.write();
  }

  private board(levelId: string): LeaderboardEntry[] {
    const runs = Object.values(this.db.runs).filter((r) => r.levelId === levelId && !this.db.users[r.uid]?.banned);
    runs.sort((a, b) => a.time - b.time || a.date.localeCompare(b.date) || a.uid.localeCompare(b.uid));
    return runs.map((r, i) => {
      const u = this.db.users[r.uid];
      return { rank: i + 1, runId: r.runId, uid: r.uid, name: displayName(u ? u.name : '', r.uid), time: r.time, date: r.date, bot: r.bot, avatarUrl: null, dev: false };
    });
  }

  // ---- Moderation (nur mit dev). Der Mock speichert je Spieler und Level nur den besten Lauf — "alle Läufe" sind
  // also die Bestzeiten, und nach dem Löschen bleibt keine Bestzeit übrig.

  private requireDev(): string {
    const me = this.db.me;
    if (!this.opts.dev || !me) throw new OnlineError('auth', 'Nur für Entwickler');
    return me;
  }

  private log(action: AdminAction, target: string | null, run: string | null, detail: Record<string, AdminDetailValue>): void {
    const id = (this.db.audit.at(-1)?.id ?? 0) + 1;
    this.db.audit.push({ id, at: new Date().toISOString(), actor: this.requireDev(), action, target, run, detail });
  }

  private adminPlayer(u: StoredUser): AdminPlayer {
    return {
      uid: u.uid,
      name: displayName(u.name, u.uid),
      discordName: null,
      avatarUrl: null,
      dev: u.uid === this.db.me && (this.opts.dev ?? false),
      banned: u.banned ?? false,
      banReason: u.banReason ?? null,
      bannedAt: u.bannedAt ?? null,
      memberSince: u.created ?? null,
      runs: u.runs,
    };
  }

  private async adminListRuns(q: AdminRunQuery = {}): Promise<AdminPage<AdminRun>> {
    this.requireDev();
    await this.net();
    const all = Object.values(this.db.runs)
      .filter((r) => (q.levelId === undefined || r.levelId === q.levelId) && (q.uid === undefined || r.uid === q.uid))
      .sort((a, b) => b.date.localeCompare(a.date) || b.runId.localeCompare(a.runId));
    const off = Math.max(0, Math.floor(q.offset ?? 0));
    const lim = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
    const items = all.slice(off, off + lim).map((r): AdminRun => {
      const u = this.db.users[r.uid];
      return {
        runId: r.runId,
        uid: r.uid,
        name: displayName(u ? u.name : '', r.uid),
        dev: false,
        banned: u?.banned ?? false,
        levelId: r.levelId,
        levelHash: '',
        physicsVersion: PHYSICS_VERSION,
        time: r.time,
        ticks: 0,
        date: r.date,
        replayPath: `mock/${r.runId}`,
        best: true,
      };
    });
    return { items, total: all.length };
  }

  private async adminListPlayers(q: AdminPlayerQuery = {}): Promise<AdminPage<AdminPlayer>> {
    this.requireDev();
    await this.net();
    const needle = (q.search ?? '').trim().toLowerCase();
    const all = Object.values(this.db.users)
      .filter((u) => (!q.bannedOnly || u.banned) && (needle === '' || u.uid === needle || displayName(u.name, u.uid).toLowerCase().includes(needle)))
      .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? '') || a.uid.localeCompare(b.uid));
    const off = Math.max(0, Math.floor(q.offset ?? 0));
    const lim = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
    return { items: all.slice(off, off + lim).map((u) => this.adminPlayer(u)), total: all.length };
  }

  private async adminSetBan(uid: string, banned: boolean, reason?: string): Promise<AdminPlayer> {
    const me = this.requireDev();
    await this.net();
    const why = (reason ?? '').trim() || null;
    if (banned && why === null) throw new OnlineError('invalid', 'Begründung nötig');
    if (why !== null && why.length > 200) throw new OnlineError('invalid', 'Begründung zu lang (max. 200)');
    const u = this.db.users[uid];
    if (!u) throw new OnlineError('notFound', `Spieler ${uid} unbekannt`);
    if (banned && uid === me) throw new OnlineError('invalid', 'Sich selbst bannen geht nicht');
    if ((u.banned ?? false) !== banned || (banned && u.banReason !== why)) {
      this.log(banned ? 'ban' : 'unban', uid, null, { reason: why, previous_reason: u.banReason ?? null, was_banned: u.banned ?? false });
      u.bannedAt = banned ? (u.banned ? (u.bannedAt ?? new Date().toISOString()) : new Date().toISOString()) : null;
      u.banned = banned;
      u.banReason = banned ? why : null;
      this.write();
    }
    return this.adminPlayer(u);
  }

  private async adminRename(uid: string, name: string, reason?: string): Promise<AdminPlayer> {
    this.requireDev();
    await this.net();
    const clean = sanitizeName(name);
    if (clean === '') throw new OnlineError('invalid', 'Name ungültig (2–16 Zeichen: Buchstaben, Ziffern, Leerzeichen, _ - .)');
    const u = this.db.users[uid];
    if (!u) throw new OnlineError('notFound', `Spieler ${uid} unbekannt`);
    if (u.name !== clean) {
      this.log('rename', uid, null, { from: u.name, to: clean, reason: (reason ?? '').trim() || null });
      u.name = clean;
      this.write();
      if (uid === this.db.me) {
        const id = this.identity;
        for (const cb of this.identityListeners) cb(id);
      }
    }
    return this.adminPlayer(u);
  }

  private async adminDeleteRun(runId: string, reason: string): Promise<AdminDeleteResult> {
    this.requireDev();
    await this.net();
    const why = reason.trim();
    if (why === '') throw new OnlineError('invalid', 'Begründung nötig');
    const entry = Object.entries(this.db.runs).find(([, r]) => r.runId === runId);
    if (!entry) throw new OnlineError('notFound', `Lauf ${runId} nicht gefunden`);
    const [key, run] = entry;
    delete this.db.runs[key];
    this.log('delete_run', run.uid, run.runId, { reason: why, level_id: run.levelId, time_ms: Math.round(run.time * 1000), was_best: true });
    this.write();
    return { runId, uid: run.uid, levelId: run.levelId, wasBest: true, newBest: null, replayRemoved: true };
  }

  private async adminAudit(q: AdminAuditQuery = {}): Promise<AdminPage<AdminAuditEntry>> {
    this.requireDev();
    await this.net();
    const name = (uid: string | null): string | null => {
      const u = uid ? this.db.users[uid] : undefined;
      return u ? displayName(u.name, u.uid) : null;
    };
    const all = this.db.audit.filter((a) => q.uid === undefined || a.target === q.uid || a.actor === q.uid).reverse();
    const off = Math.max(0, Math.floor(q.offset ?? 0));
    const lim = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
    const items = all.slice(off, off + lim).map(
      (a): AdminAuditEntry => ({ id: a.id, at: a.at, actorUid: a.actor, actorName: name(a.actor), action: a.action, targetUid: a.target, targetName: name(a.target), runId: a.run, detail: { ...a.detail } }),
    );
    return { items, total: all.length };
  }

  private async net(): Promise<void> {
    const base = this.opts.latencyMs ?? 120;
    if (base > 0) await new Promise((res) => setTimeout(res, base * (1 + this.random() * 0.5)));
    if ((this.opts.failRate ?? 0) > 0 && this.random() < (this.opts.failRate ?? 0)) throw new OnlineError('offline', 'Keine Verbindung (simuliert)');
  }

  private hex(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(this.random() * 16).toString(16);
    return s;
  }

  private read(): MockDb {
    if (!this.storage) return emptyDb();
    try {
      const s = this.storage.getItem(MOCK_KEY);
      return s === null ? emptyDb() : parseDb(JSON.parse(s));
    } catch {
      return emptyDb();
    }
  }

  private write(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(MOCK_KEY, JSON.stringify(this.db));
    } catch {
      // Quota: der Mock läuft im Speicher weiter.
    }
  }
}

function reject(reason: string, detail: string | null): SubmitResult {
  return { status: 'rejected', runId: null, time: null, rank: null, total: 0, personalBest: false, improved: false, reason, detail };
}

function pause(): Promise<void> {
  return new Promise((res) => setTimeout(res, 0));
}
