import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StorageLike } from '../src/engine/Settings';
import { PHYSICS_VERSION } from '../src/engine/replay/format';
import { levelHash } from '../src/engine/replay/hash';
import { PENDING_KEY, PENDING_MAX_AGE_MS, hasPendingRun, savePendingRun, takePendingRun } from '../src/online/pendingSubmit';
import { SupabaseService } from '../src/online/SupabaseService';
import type { ExternalLogin } from '../src/online/SupabaseService';
import { parseAdminDelete, parseProfileRpc, sessionStorageKey, vaultStorage } from '../src/online/supabaseApi';
import type { AdminDeleteResponse, AdminPlayerFilter, AdminRunFilter, BestRow, BoardQuery, DiscordAuthUrl, ProfileRow, SessionInfo, SubmitResponse, SupabaseApi } from '../src/online/supabaseApi';
import type { DesktopAuthBegin, DesktopAuthResult, DesktopSessionVault } from '../src/platform/types';
import type { AdminAuditRow, AdminPlayerRow, AdminRunRow, BoardRow, ProfileRpc } from '../src/online/supabaseTypes';
import { OnlineError } from '../src/online/types';
import type { PlayerIdentity } from '../src/online/types';
import { compileLevel } from '../src/world/level/compileLevel';
import type { CompiledLevel } from '../src/world/level/compileLevel';
import type { LevelFile } from '../src/world/level/LevelFormat';

/** Plan 009 (Supabase): SupabaseService gegen eine Attrappe des supabase-js-Adapters, Replay-Sicherung beim Login-Redirect. */

const level1 = compileLevel(JSON.parse(readFileSync(join(process.cwd(), 'public', 'levels', 'level1.json'), 'utf8')) as LevelFile);
const loadLevel = async (id: string): Promise<CompiledLevel> => {
  if (id !== 'level1') throw new Error(`unbekannt ${id}`);
  return level1;
};
const HASH = levelHash(level1);

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function row(rank: number, uid: string, name: string, ms: number, total: number): BoardRow {
  return { rank, user_id: uid, display_name: name, avatar_url: uid === ME ? 'https://cdn.discordapp.com/avatars/1/a.png' : null, role: uid === OTHER ? 'dev' : 'player', time_ms: ms, run_id: `run-${uid.slice(0, 1)}`, achieved_at: '2026-11-06T10:00:00Z', total };
}

class FakeApi implements SupabaseApi {
  session: SessionInfo | null = null;
  profile: ProfileRow | null = null;
  authCb: ((s: SessionInfo | null) => void) | null = null;
  redirects: string[] = [];
  boardQueries: BoardQuery[] = [];
  board: BoardRow[] = [];
  submits = 0;
  submitAnswer: SubmitResponse | OnlineError = { valid: true, runId: 'r1', time: 20.0078125, rank: 2, total: 5, personalBest: true, improved: false };
  names: string[] = [];
  paths = new Map<string, string | null>();
  downloads: string[] = [];
  profileCalls: { uid: string; boards: readonly BoardQuery[] }[] = [];
  profiles = new Map<string, ProfileRpc>();
  adminCalls: string[] = [];
  adminError: OnlineError | null = null;
  runRows: AdminRunRow[] = [];
  auditRows: AdminAuditRow[] = [];
  deleteAnswer: AdminDeleteResponse = { runId: 'run-x', userId: OTHER, levelId: 'level1', wasBest: true, newBestRunId: 'run-y', newBestMs: 19250, replayRemoved: true };

  async getSession(): Promise<SessionInfo | null> {
    return this.session;
  }
  onAuthChange(cb: (s: SessionInfo | null) => void): () => void {
    this.authCb = cb;
    return () => {
      this.authCb = null;
    };
  }
  async signInWithDiscord(redirectTo: string): Promise<void> {
    this.redirects.push(redirectTo);
  }
  // ---- Desktop-Login (Plan 011 §3.1): Auth-URL ohne Seitenwechsel, Code-Tausch → Sitzung + Ereignis wie supabase-js
  authUrlCalls: string[] = [];
  exchanges: { code: string; flowId: string | null }[] = [];
  exchangeAnswer: SessionInfo | OnlineError = { uid: ME, metaName: 'Fuchs', metaAvatar: null };
  async discordAuthUrl(redirectTo: string): Promise<DiscordAuthUrl> {
    this.authUrlCalls.push(redirectTo);
    return { url: `https://abc.supabase.co/auth/v1/authorize?provider=discord&redirect_to=${encodeURIComponent(redirectTo)}`, flowId: 'flow-1' };
  }
  async exchangeCode(code: string, flowId: string | null): Promise<SessionInfo> {
    this.exchanges.push({ code, flowId });
    if (this.exchangeAnswer instanceof OnlineError) throw this.exchangeAnswer;
    this.session = this.exchangeAnswer;
    this.authCb?.(this.exchangeAnswer);
    return this.exchangeAnswer;
  }
  async signOut(): Promise<void> {
    this.session = null;
  }
  async getProfile(uid: string): Promise<ProfileRow | null> {
    return this.profile && this.profile.id === uid ? this.profile : null;
  }
  async updateDisplayName(_uid: string, name: string): Promise<void> {
    this.names.push(name);
  }
  async leaderboard(q: BoardQuery, limit: number): Promise<BoardRow[]> {
    this.boardQueries.push(q);
    return this.board.slice(0, limit);
  }
  async rankAround(q: BoardQuery, uid: string, radius: number): Promise<BoardRow[]> {
    this.boardQueries.push(q);
    const i = this.board.findIndex((r) => r.user_id === uid);
    return i < 0 ? [] : this.board.slice(Math.max(0, i - radius), i + radius + 1);
  }
  async bestRuns(uid: string): Promise<BestRow[]> {
    return uid === ME ? [{ levelId: 'level1', levelHash: HASH, physicsVersion: PHYSICS_VERSION, timeMs: 19500, runId: 'run-1' }, { levelId: 'level1', levelHash: 'alt', physicsVersion: PHYSICS_VERSION, timeMs: 18000, runId: 'old' }] : [];
  }
  async playerProfile(uid: string, boards: readonly BoardQuery[]): Promise<ProfileRpc | null> {
    this.profileCalls.push({ uid, boards });
    return this.profiles.get(uid) ?? null;
  }
  async replayPath(runId: string): Promise<string | null> {
    if (!this.paths.has(runId)) throw new OnlineError('notFound', 'nicht gefunden');
    return this.paths.get(runId) ?? null;
  }
  async downloadReplay(path: string): Promise<Uint8Array> {
    this.downloads.push(path);
    return new Uint8Array([0x56, 0x52, 0x50]);
  }
  async submitRun(): Promise<SubmitResponse> {
    this.submits++;
    if (this.submitAnswer instanceof OnlineError) throw this.submitAnswer;
    return this.submitAnswer;
  }
  private admin(call: string): void {
    this.adminCalls.push(call);
    if (this.adminError) throw this.adminError;
  }
  async adminListRuns(f: AdminRunFilter): Promise<AdminRunRow[]> {
    this.admin(`runs ${JSON.stringify(f)}`);
    return this.runRows;
  }
  async adminListPlayers(f: AdminPlayerFilter): Promise<AdminPlayerRow[]> {
    this.admin(`players ${JSON.stringify(f)}`);
    return [playerRow(OTHER, false, null)];
  }
  async adminSetBan(uid: string, banned: boolean, reason: string | null): Promise<AdminPlayerRow | null> {
    this.admin(`ban ${uid} ${banned} ${reason}`);
    return uid === OTHER ? playerRow(uid, banned, banned ? reason : null) : null;
  }
  async adminRename(uid: string, name: string, reason: string | null): Promise<AdminPlayerRow | null> {
    this.admin(`rename ${uid} ${name} ${reason}`);
    return { ...playerRow(uid, false, null), display_name: name };
  }
  async adminAudit(limit: number, offset: number, uid: string | null): Promise<AdminAuditRow[]> {
    this.admin(`audit ${limit} ${offset} ${uid}`);
    return this.auditRows;
  }
  async adminDeleteRun(runId: string, reason: string, timeoutMs: number): Promise<AdminDeleteResponse> {
    this.admin(`delete ${runId} ${reason} ${timeoutMs}`);
    return this.deleteAnswer;
  }
}

function playerRow(uid: string, banned: boolean, reason: string | null): AdminPlayerRow {
  return {
    user_id: uid,
    display_name: 'Beta',
    discord_name: 'beta_dc',
    avatar_url: null,
    role: 'player',
    is_banned: banned,
    ban_reason: reason,
    banned_at: banned ? '2026-11-06T12:00:00Z' : null,
    created_at: '2026-11-01T00:00:00Z',
    runs: 4,
    total: 1,
  };
}

function profileRpc(uid: string): ProfileRpc {
  return {
    id: uid,
    display_name: 'Fuchs',
    avatar_url: 'https://cdn.discordapp.com/avatars/1/a.png',
    role: 'dev',
    created_at: '2026-11-01T09:00:00Z',
    runs: 7,
    world_records: 1,
    bests: [{ level_id: 'level1', level_hash: HASH, physics_version: PHYSICS_VERSION, time_ms: 19500, run_id: 'run-1', achieved_at: '2026-11-05T10:00:00Z', rank: 1, total: 3 }],
  };
}

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function service(api: FakeApi): SupabaseService {
  return new SupabaseService({ api, loadLevel, redirectTo: () => 'http://localhost:5173/' });
}

describe('SupabaseService (gemockter Client)', () => {
  it('ohne Sitzung: nicht angemeldet, Login nötig, Einreichen wirft auth, Bestenliste lesen geht', async () => {
    const api = new FakeApi();
    api.board = [row(1, OTHER, 'Beta', 18000, 1)];
    const svc = service(api);
    expect(svc.loginRequired).toBe(true);
    expect(await svc.auth('egal')).toBeNull();
    expect(svc.identity).toBeNull();
    await expect(svc.submitRun(new Uint8Array([1]))).rejects.toMatchObject({ code: 'auth' });
    expect(api.submits).toBe(0);
    await expect(svc.setName('Neu')).rejects.toMatchObject({ code: 'auth' });
    const top = await svc.getLeaderboard('level1', { kind: 'top', limit: 10 });
    expect(top.entries).toHaveLength(1);
    expect(top.entries[0]).toMatchObject({ rank: 1, name: 'Beta', time: 18, uid: OTHER, bot: false, avatarUrl: null });
    expect(top.total).toBe(1);
    expect(top.me).toBeNull();
    // Tafel = Level-ID + Hash des kompilierten Levels + Physik-Version (wie der Server sie schreibt).
    expect(api.boardQueries[0]).toEqual({ levelId: 'level1', levelHash: HASH, physics: PHYSICS_VERSION });
    const around = await svc.getLeaderboard('level1', { kind: 'around', radius: 3 });
    expect(around.entries).toEqual([]);
  });

  it('signIn = Discord-Redirect zur eigenen Seite (verlässt die Seite, kein Login im Hintergrund)', async () => {
    const api = new FakeApi();
    const svc = service(api);
    await svc.signIn();
    expect(api.redirects).toEqual(['http://localhost:5173/']);
    // Web-Pfad unverändert: kein Desktop-Login, kein Code-Tausch im Dienst.
    expect(api.authUrlCalls).toEqual([]);
    expect(api.exchanges).toEqual([]);
    expect(svc.identity).toBeNull();
  });

  it('Sitzung nach dem Redirect: Identität aus Profil (umbenannter Name schlägt Discord-Metadaten), Ereignisse', async () => {
    const api = new FakeApi();
    api.session = { uid: ME, metaName: 'Pixel Fuchs 🦊', metaAvatar: 'https://cdn.discordapp.com/avatars/1/meta.png' };
    api.profile = { id: ME, displayName: 'Fuchs', avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png', dev: true };
    const svc = service(api);
    const seen: (PlayerIdentity | null)[] = [];
    svc.onIdentityChange((id) => seen.push(id));
    const id = await svc.auth();
    expect(id).toEqual({ uid: ME, name: 'Fuchs', provider: 'discord', avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png', dev: true });
    expect(seen.at(-1)?.name).toBe('Fuchs');
    // Logout aus einem anderen Tab (onAuthStateChange) → null.
    api.authCb?.(null);
    await Promise.resolve();
    expect(svc.identity).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it('einreichen: Antwort der Edge Function → SubmitResult; ungültig → rejected mit Verifier-Grund', async () => {
    const api = new FakeApi();
    api.session = { uid: ME, metaName: 'Fuchs', metaAvatar: null };
    const svc = service(api);
    await svc.auth();
    const ok = await svc.submitRun(new Uint8Array([1, 2, 3]));
    expect(ok).toEqual({ status: 'accepted', runId: 'r1', time: 20.0078125, rank: 2, total: 5, personalBest: true, improved: false, reason: null, detail: null });
    api.submitAnswer = { valid: false, reason: 'desync', detail: 'Tick 384' };
    const bad = await svc.submitRun(new Uint8Array([1]));
    expect(bad).toMatchObject({ status: 'rejected', reason: 'desync', detail: 'Tick 384', rank: null });
    api.submitAnswer = new OnlineError('rate', 'Höchstens 20 Läufe pro Minute');
    await expect(svc.submitRun(new Uint8Array([1]))).rejects.toMatchObject({ code: 'rate' });
  });

  it('Bestenliste mit mir: DU-Eintrag (me) auch im Top-Ausschnitt, um-mich-herum, Profil nur aktuelle Tafel', async () => {
    const api = new FakeApi();
    api.session = { uid: ME, metaName: 'Fuchs', metaAvatar: null };
    api.profile = { id: ME, displayName: 'Fuchs', avatarUrl: null, dev: false };
    api.board = [row(1, OTHER, 'Beta', 18000, 2), row(2, ME, 'Fuchs', 19500, 2)];
    const svc = service(api);
    await svc.auth();
    const top = await svc.getLeaderboard('level1', { kind: 'top', limit: 1 });
    expect(top.entries.map((e) => e.uid)).toEqual([OTHER]);
    expect(top.entries[0]?.dev).toBe(true);
    expect(top.me?.dev).toBe(false);
    expect(top.me).toMatchObject({ uid: ME, rank: 2, time: 19.5, avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png' });
    expect(top.total).toBe(2);
    const around = await svc.getLeaderboard('level1', { kind: 'around', radius: 3 });
    expect(around.entries.map((e) => e.rank)).toEqual([1, 2]);
    expect(around.me?.rank).toBe(2);
  });

  it('Profil: RPC mit den aktuellen Tafeln aller Level (levelIds), Zuordnung, fremde Profile ohne Login, unbekannt/gebannt', async () => {
    const api = new FakeApi();
    api.profiles.set(ME, profileRpc(ME));
    const svc = new SupabaseService({ api, loadLevel, levelIds: () => ['level1', 'kaputt'], redirectTo: () => '/' });
    // Ohne Login: eigenes Profil → auth; fremdes lesbar.
    await expect(svc.getProfile()).rejects.toMatchObject({ code: 'auth' });
    const prof = await svc.getProfile(ME);
    // 'kaputt' ist nicht ladbar → nur die Tafel von level1, mit Hash des kompilierten Levels + PHYSICS_VERSION.
    expect(api.profileCalls.at(-1)).toEqual({ uid: ME, boards: [{ levelId: 'level1', levelHash: HASH, physics: PHYSICS_VERSION }] });
    expect(prof).toEqual({
      uid: ME,
      name: 'Fuchs',
      avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
      dev: true,
      memberSince: '2026-11-01T09:00:00Z',
      runs: 7,
      worldRecords: 1,
      bests: [{ levelId: 'level1', time: 19.5, rank: 1, total: 3, runId: 'run-1', date: '2026-11-05T10:00:00Z' }],
    });
    // Unbekannt oder gebannt → RPC null → notFound.
    await expect(svc.getProfile(OTHER)).rejects.toMatchObject({ code: 'notFound' });
  });

  it('Profil ohne levelIds: Tafeln aus den Leveln mit Bestzeiten (alter Hash wird zur aktuellen Tafel)', async () => {
    const api = new FakeApi();
    api.session = { uid: ME, metaName: 'Fuchs', metaAvatar: null };
    api.profiles.set(ME, profileRpc(ME));
    const svc = service(api);
    await svc.auth();
    await svc.getProfile();
    expect(api.profileCalls.at(-1)?.boards).toEqual([{ levelId: 'level1', levelHash: HASH, physics: PHYSICS_VERSION }]);
  });

  it('Name ändern: bereinigt, nur bei Änderung, Ereignis', async () => {
    const api = new FakeApi();
    api.session = { uid: ME, metaName: 'Fuchs', metaAvatar: null };
    const svc = service(api);
    await svc.auth();
    let last: string | null = null;
    svc.onIdentityChange((id) => {
      last = id?.name ?? null;
    });
    expect((await svc.setName('  Neo<b>Fuchs  ')).name).toBe('NeobFuchs');
    expect(api.names).toEqual(['NeobFuchs']);
    expect(last).toBe('NeobFuchs');
    await svc.setName('NeobFuchs');
    await svc.setName('x'); // zu kurz → kein Aufruf
    expect(api.names).toEqual(['NeobFuchs']);
  });

  it('Ghost: Pfad aus runs, Download aus dem öffentlichen Bucket; ohne Replay notFound', async () => {
    const api = new FakeApi();
    api.paths.set('run-a', 'level1/run-a.vrp');
    api.paths.set('run-b', null);
    const svc = service(api);
    expect(await svc.getGhost('run-a')).toEqual(new Uint8Array([0x56, 0x52, 0x50]));
    expect(api.downloads).toEqual(['level1/run-a.vrp']);
    await expect(svc.getGhost('run-b')).rejects.toMatchObject({ code: 'notFound' });
    await expect(svc.getGhost('fehlt')).rejects.toMatchObject({ code: 'notFound' });
  });

  it('signOut meldet ab', async () => {
    const api = new FakeApi();
    api.session = { uid: ME, metaName: 'Fuchs', metaAvatar: null };
    const svc = service(api);
    await svc.auth();
    await svc.signOut();
    expect(svc.identity).toBeNull();
    expect(await svc.auth()).toBeNull();
  });
});

describe('Replay-Sicherung beim Login-Redirect (pendingSubmit)', () => {
  const bytes = new Uint8Array([0x56, 0x52, 0x50, 1, 0, 200, 7, 0, 255]);

  it('sichern → genau einmal entnehmen, Bytes unverändert', () => {
    const st = memStorage();
    expect(savePendingRun(st, { bytes, levelId: 'level2', time: 16.6 }, 1000)).toBe(true);
    expect(hasPendingRun(st)).toBe(true);
    const run = takePendingRun(st, 2000);
    expect(run).toEqual({ bytes, levelId: 'level2', time: 16.6, savedAt: 1000 });
    expect(hasPendingRun(st)).toBe(false);
    expect(takePendingRun(st, 2000)).toBeNull();
  });

  it('abgelaufen, kaputt oder ohne Speicher → null (und weg)', () => {
    const st = memStorage();
    savePendingRun(st, { bytes, levelId: 'level1', time: 20 }, 0);
    expect(takePendingRun(st, PENDING_MAX_AGE_MS + 1)).toBeNull();
    expect(st.data.has(PENDING_KEY)).toBe(false);
    st.setItem(PENDING_KEY, '{kaputt');
    expect(takePendingRun(st)).toBeNull();
    st.setItem(PENDING_KEY, JSON.stringify({ v: 1, b64: 'AAA', levelId: 3, time: 1, savedAt: Date.now() }));
    expect(takePendingRun(st)).toBeNull();
    expect(savePendingRun(null, { bytes, levelId: 'level1', time: 1 })).toBe(false);
    expect(takePendingRun(null)).toBeNull();
    const full: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => undefined,
    };
    expect(savePendingRun(full, { bytes, levelId: 'level1', time: 1 })).toBe(false);
  });
});

describe('Profil-/Admin-Antworten parsen (supabaseApi)', () => {
  it('get_player_profile: null/kaputt → null, Bestzeiten ohne Pflichtfelder fallen raus, Zahlen aus bigint', () => {
    expect(parseProfileRpc(null)).toBeNull();
    expect(parseProfileRpc({ display_name: 'x' })).toBeNull();
    const p = parseProfileRpc({
      id: ME,
      display_name: 'Fuchs',
      avatar_url: null,
      role: 'player',
      created_at: '2026-11-01T00:00:00Z',
      runs: 3,
      world_records: 0,
      bests: [{ level_id: 'level1', level_hash: 'h', physics_version: 2, time_ms: 1000, run_id: 'r', achieved_at: 'd', rank: 2, total: 5 }, { level_id: 'kaputt' }],
    });
    expect(p?.bests).toHaveLength(1);
    expect(p?.bests[0]).toMatchObject({ rank: 2, total: 5, physics_version: 2 });
  });

  it('admin deleteRun: ok-Antwort → Felder, sonst server-Fehler', () => {
    expect(parseAdminDelete({ ok: true, runId: 'a', userId: 'u', levelId: 'level1', wasBest: false, newBestRunId: null, newBestMs: null, replayRemoved: false })).toEqual({
      runId: 'a',
      userId: 'u',
      levelId: 'level1',
      wasBest: false,
      newBestRunId: null,
      newBestMs: null,
      replayRemoved: false,
    });
    expect(() => parseAdminDelete({ error: 'forbidden' })).toThrow(OnlineError);
  });
});

describe('SupabaseService.admin (gemockter Client)', () => {
  function devService(dev: boolean): { api: FakeApi; svc: SupabaseService } {
    const api = new FakeApi();
    api.session = { uid: ME, metaName: 'Fuchs', metaAvatar: null };
    api.profile = { id: ME, displayName: 'Fuchs', avatarUrl: null, dev };
    return { api, svc: service(api) };
  }

  it('nur für Devs sichtbar: ohne Login und als Spieler null', async () => {
    const anon = service(new FakeApi());
    await anon.auth();
    expect(anon.admin).toBeNull();
    const { svc } = devService(false);
    await svc.auth();
    expect(svc.admin).toBeNull();
    const d = devService(true);
    await d.svc.auth();
    expect(d.svc.admin).not.toBeNull();
    await d.svc.signOut();
    expect(d.svc.admin).toBeNull();
  });

  it('Läufe: Filter/Seiten geklemmt, Zeilen → AdminRun, total aus der Zeile', async () => {
    const { api, svc } = devService(true);
    await svc.auth();
    api.runRows = [
      {
        run_id: 'run-9',
        user_id: OTHER,
        display_name: '',
        role: 'player',
        is_banned: true,
        level_id: 'level1',
        level_hash: HASH,
        physics_version: PHYSICS_VERSION,
        time_ms: 21125,
        ticks: 2704,
        created_at: '2026-11-06T08:00:00Z',
        replay_path: 'level1/run-9.vrp',
        replay_bytes: 900,
        is_best: true,
        total: 37,
      },
    ];
    const admin = svc.admin;
    if (!admin) throw new Error('admin fehlt');
    const page = await admin.listRuns({ levelId: 'level1', limit: 9999, offset: -5 });
    expect(api.adminCalls.at(-1)).toBe(`runs ${JSON.stringify({ levelId: 'level1', uid: null, limit: 200, offset: 0 })}`);
    expect(page.total).toBe(37);
    expect(page.items[0]).toEqual({
      runId: 'run-9',
      uid: OTHER,
      name: 'SPIELER-2222',
      dev: false,
      banned: true,
      levelId: 'level1',
      levelHash: HASH,
      physicsVersion: PHYSICS_VERSION,
      time: 21.125,
      ticks: 2704,
      date: '2026-11-06T08:00:00Z',
      replayPath: 'level1/run-9.vrp',
      best: true,
    });
    api.runRows = [];
    expect(await admin.listRuns()).toEqual({ items: [], total: 0 });
  });

  it('Bann: Begründung Pflicht (vorab, ohne Aufruf), Entbannen ohne; Umbenennen bereinigt; unbekannt → notFound', async () => {
    const { api, svc } = devService(true);
    await svc.auth();
    const admin = svc.admin;
    if (!admin) throw new Error('admin fehlt');
    await expect(admin.setBan(OTHER, true, '   ')).rejects.toMatchObject({ code: 'invalid' });
    expect(api.adminCalls).toEqual([]);
    const banned = await admin.setBan(OTHER, true, '  Speedhack ');
    expect(api.adminCalls.at(-1)).toBe(`ban ${OTHER} true Speedhack`);
    expect(banned).toMatchObject({ uid: OTHER, banned: true, banReason: 'Speedhack', discordName: 'beta_dc', runs: 4, memberSince: '2026-11-01T00:00:00Z' });
    expect((await admin.setBan(OTHER, false)).banned).toBe(false);
    expect(api.adminCalls.at(-1)).toBe(`ban ${OTHER} false null`);
    await expect(admin.setBan(ME, true, 'x')).rejects.toMatchObject({ code: 'notFound' });
    await expect(admin.renamePlayer(OTHER, 'x')).rejects.toMatchObject({ code: 'invalid' });
    const renamed = await admin.renamePlayer(OTHER, ' Böse<b>Name ', 'beleidigend');
    expect(api.adminCalls.at(-1)).toBe(`rename ${OTHER} BösebName beleidigend`);
    expect(renamed.name).toBe('BösebName');
  });

  it('Lauf löschen: Begründung Pflicht, Antwort der Function → AdminDeleteResult; Serverfehler werden durchgereicht', async () => {
    const { api, svc } = devService(true);
    await svc.auth();
    const admin = svc.admin;
    if (!admin) throw new Error('admin fehlt');
    await expect(admin.deleteRun('run-x', '')).rejects.toMatchObject({ code: 'invalid' });
    const res = await admin.deleteRun('run-x', 'Clip durch Wand');
    expect(api.adminCalls.at(-1)).toBe('delete run-x Clip durch Wand 20000');
    expect(res).toEqual({ runId: 'run-x', uid: OTHER, levelId: 'level1', wasBest: true, newBest: { runId: 'run-y', time: 19.25 }, replayRemoved: true });
    api.deleteAnswer = { ...api.deleteAnswer, newBestRunId: null, newBestMs: null };
    expect((await admin.deleteRun('run-x', 'x')).newBest).toBeNull();
    // Server sagt "kein Dev" (z. B. Rolle inzwischen entzogen) → auth.
    api.adminError = new OnlineError('auth', 'Löschen: keine Berechtigung');
    await expect(admin.deleteRun('run-x', 'x')).rejects.toMatchObject({ code: 'auth' });
  });

  it('Protokoll: unbekannte Aktionen fallen raus, detail nur flache Werte, Filter je Spieler', async () => {
    const { api, svc } = devService(true);
    await svc.auth();
    api.auditRows = [
      { id: 2, at: '2026-11-06T09:00:00Z', actor_id: ME, actor_name: 'Fuchs', action: 'rename', target_user: OTHER, target_name: 'Neu', target_run: null, detail: { from: 'Alt', to: 'Neu', nested: { x: 1 } }, total: 2 },
      { id: 1, at: '2026-11-06T08:00:00Z', actor_id: ME, actor_name: 'Fuchs', action: 'teleport', target_user: null, target_name: null, target_run: null, detail: {}, total: 2 },
    ];
    const admin = svc.admin;
    if (!admin) throw new Error('admin fehlt');
    const log = await admin.auditLog({ uid: OTHER, limit: 10 });
    expect(api.adminCalls.at(-1)).toBe(`audit 10 0 ${OTHER}`);
    expect(log.total).toBe(2);
    expect(log.items).toEqual([{ id: 2, at: '2026-11-06T09:00:00Z', actorUid: ME, actorName: 'Fuchs', action: 'rename', targetUid: OTHER, targetName: 'Neu', runId: null, detail: { from: 'Alt', to: 'Neu' } }]);
  });
});

// ------------------------------------------------------------------ Desktop-Login (Plan 011 §3.1)

const LOOPBACK = 'http://127.0.0.1:47823/auth/callback?state=0123456789abcdef0123456789abcdef';

/** Attrappe von platform.auth: der Test spielt den Browser-Rücksprung von Hand. */
class FakeLogin implements ExternalLogin {
  begins = 0;
  cancels = 0;
  opened: string[] = [];
  beginAnswer: DesktopAuthBegin | Error = { ok: true, redirectUrl: LOOPBACK };
  /** Antwort statt des wartenden Ergebnisses (z. B. unlesbar = fremder Absender). */
  openAnswer: unknown = null;
  private pending: Promise<DesktopAuthResult> | null = null;
  private settle: ((r: DesktopAuthResult) => void) | null = null;
  async begin(): Promise<DesktopAuthBegin> {
    this.begins++;
    if (this.beginAnswer instanceof Error) throw this.beginAnswer;
    return this.beginAnswer;
  }
  openExternal(url: string): Promise<DesktopAuthResult> {
    this.opened.push(url);
    if (this.openAnswer !== null) return Promise.resolve(this.openAnswer as DesktopAuthResult);
    // Wie der Hauptprozess: jedes Öffnen wartet auf DENSELBEN Rücksprung.
    if (!this.pending) {
      this.pending = new Promise((r) => {
        this.settle = r;
      });
    }
    return this.pending;
  }
  cancel(): void {
    this.cancels++;
  }
  callback(r: DesktopAuthResult): void {
    this.settle?.(r);
    this.pending = null;
    this.settle = null;
  }
}

const ticks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function desktopService(api: FakeApi, login: FakeLogin): SupabaseService {
  return new SupabaseService({ api, loadLevel, externalLogin: login });
}

describe('SupabaseService Desktop-Login (externalLogin = platform.auth)', () => {
  it('Code → Sitzung: Empfänger, Auth-URL mit der Loopback-Adresse, Browser, Tausch mit flowId; kein Seiten-Redirect', async () => {
    const api = new FakeApi();
    api.profile = { id: ME, displayName: 'Fuchs', avatarUrl: null, dev: false };
    const login = new FakeLogin();
    const svc = desktopService(api, login);
    const seen: (PlayerIdentity | null)[] = [];
    svc.onIdentityChange((id) => seen.push(id));
    let done = false;
    const p = svc.signIn().then(() => {
      done = true;
    });
    await ticks();
    expect(login.begins).toBe(1);
    expect(api.authUrlCalls).toEqual([LOOPBACK]);
    expect(login.opened).toEqual([`https://abc.supabase.co/auth/v1/authorize?provider=discord&redirect_to=${encodeURIComponent(LOOPBACK)}`]);
    // signIn wartet auf den Rücksprung — die Seite bleibt stehen, noch niemand angemeldet.
    expect(done).toBe(false);
    expect(svc.identity).toBeNull();
    login.callback({ ok: true, code: 'code-1234' });
    await p;
    expect(api.exchanges).toEqual([{ code: 'code-1234', flowId: 'flow-1' }]);
    expect(svc.identity).toMatchObject({ uid: ME, name: 'Fuchs', provider: 'discord' });
    expect(seen.at(-1)?.uid).toBe(ME);
    expect(api.redirects).toEqual([]);
    expect(login.cancels).toBe(0);
  });

  it('Zeitüberschreitung → OnlineError timeout mit dem Text des Hauptprozesses; kein Tausch; danach neuer Versuch', async () => {
    const api = new FakeApi();
    const login = new FakeLogin();
    const svc = desktopService(api, login);
    const p = svc.signIn();
    await ticks();
    login.callback({ ok: false, error: 'timeout', detail: 'Keine Rückmeldung aus dem Browser (5 min).' });
    await expect(p).rejects.toMatchObject({ code: 'timeout', message: 'Keine Rückmeldung aus dem Browser (5 min).' });
    await expect(p).rejects.toBeInstanceOf(OnlineError);
    expect(api.exchanges).toEqual([]);
    expect(svc.identity).toBeNull();
    const again = svc.signIn();
    await ticks();
    expect(login.begins).toBe(2);
    login.callback({ ok: true, code: 'code-5678' });
    await again;
    expect(svc.identity?.uid).toBe(ME);
  });

  it('zweiter Klick während des Wartens: Browser erneut mit DERSELBEN URL, ein Versuch, ein Tausch', async () => {
    const api = new FakeApi();
    const login = new FakeLogin();
    const svc = desktopService(api, login);
    const p1 = svc.signIn();
    await ticks();
    const p2 = svc.signIn();
    await ticks();
    expect(login.begins).toBe(1);
    expect(login.opened).toHaveLength(2);
    expect(login.opened[1]).toBe(login.opened[0]);
    login.callback({ ok: true, code: 'code-1234' });
    await Promise.all([p1, p2]);
    expect(api.exchanges).toHaveLength(1);
    expect(api.authUrlCalls).toHaveLength(1);
  });

  it('Fehler lesbar abbilden: abgebrochen → auth, Ports belegt → unavailable ohne Browser, Bridge weg/unlesbar → unavailable', async () => {
    const api = new FakeApi();
    const login = new FakeLogin();
    const svc = desktopService(api, login);
    const denied = svc.signIn();
    await ticks();
    login.callback({ ok: false, error: 'denied', detail: 'Anmeldung abgebrochen oder abgelehnt.' });
    await expect(denied).rejects.toMatchObject({ code: 'auth', message: 'Anmeldung abgebrochen oder abgelehnt.' });

    login.beginAnswer = { ok: false, error: 'ports', detail: 'Die Login-Ports 47823–47825 sind belegt — ein anderes Programm nutzt sie.' };
    const opened = login.opened.length;
    await expect(svc.signIn()).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('47823–47825') });
    expect(login.opened).toHaveLength(opened);

    // Kein Login-Modul im Hauptprozess: invoke lehnt ab.
    login.beginAnswer = new Error("No handler registered for 'vel:auth:begin'");
    await expect(svc.signIn()).rejects.toMatchObject({ code: 'unavailable' });
    // Fremder Absender (Hauptprozess antwortet undefined) bzw. unbekannter Grund → unlesbar.
    login.beginAnswer = { ok: true, redirectUrl: LOOPBACK };
    login.openAnswer = { unerwartet: true };
    await expect(svc.signIn()).rejects.toMatchObject({ code: 'unavailable' });
    login.openAnswer = { ok: false, error: 'erfunden', detail: 'x' };
    await expect(svc.signIn()).rejects.toMatchObject({ code: 'unavailable' });
    expect(api.exchanges).toEqual([]);
    expect(svc.identity).toBeNull();
  });

  it('Auth-URL nicht erzeugbar → Empfänger sofort zu (cancel); Tausch scheitert → auth, nicht angemeldet', async () => {
    const api = new FakeApi();
    const login = new FakeLogin();
    const svc = desktopService(api, login);
    api.discordAuthUrl = () => Promise.reject(new OnlineError('offline', 'Discord-Anmeldung: keine Verbindung'));
    await expect(svc.signIn()).rejects.toMatchObject({ code: 'offline' });
    expect(login.cancels).toBe(1);
    expect(login.opened).toEqual([]);

    const api2 = new FakeApi();
    api2.exchangeAnswer = new OnlineError('auth', 'Anmeldung nicht abgeschlossen — bitte erneut anmelden (invalid flow state)');
    const login2 = new FakeLogin();
    const svc2 = desktopService(api2, login2);
    const p = svc2.signIn();
    await ticks();
    login2.callback({ ok: true, code: 'verbraucht-1' });
    await expect(p).rejects.toMatchObject({ code: 'auth' });
    expect(svc2.identity).toBeNull();
  });
});

describe('Sitzungs-Tresor am Desktop (supabaseApi.vaultStorage)', () => {
  /** Tresor-Attrappe; `gate` hält das nächste Lesen fest (Rennen Lesen ⇄ Schreiben). */
  class FakeVault implements DesktopSessionVault {
    value: string | null = null;
    reads = 0;
    writes = 0;
    gate: Promise<void> | null = null;
    async read(): Promise<string | null> {
      this.reads++;
      const v = this.value;
      if (this.gate) await this.gate;
      return v;
    }
    async write(v: string): Promise<boolean> {
      this.writes++;
      this.value = v;
      return true;
    }
    async remove(): Promise<boolean> {
      this.value = null;
      return true;
    }
  }
  const KEY = sessionStorageKey('https://abc.supabase.co');

  it('nur der Sitzungsschlüssel geht in den Tresor — PKCE-Verifier und Flow-Index bleiben in localStorage', async () => {
    expect(KEY).toBe('sb-abc-auth-token');
    const st = memStorage();
    st.setItem(KEY, '{"refresh_token":"alt-klartext"}');
    const vault = new FakeVault();
    const s = vaultStorage(vault, KEY, st);
    // Klartext-Altstand wird beim Einrichten entfernt.
    expect(st.data.has(KEY)).toBe(false);
    expect(await s.getItem(KEY)).toBeNull();
    await s.setItem(KEY, '{"refresh_token":"geheim"}');
    expect(vault.value).toBe('{"refresh_token":"geheim"}');
    // Schlüssel aus supabase-js 2.119 (lib/helpers: pkceVerifierSlotKey, Flow-Index, fester Verifier-Schlüssel).
    for (const k of [`${KEY}-code-verifier`, `${KEY}-flow-f1-code-verifier`, `${KEY}-flows-code-verifier`]) {
      await s.setItem(k, '"verifier"');
      expect(st.getItem(k)).toBe('"verifier"');
      expect(await s.getItem(k)).toBe('"verifier"');
      await s.removeItem(k);
      expect(st.data.has(k)).toBe(false);
    }
    expect(vault.writes).toBe(1);
    expect([...st.data.values()].join('|')).not.toContain('geheim');
    expect(await s.getItem(KEY)).toBe('{"refresh_token":"geheim"}');
    await s.removeItem(KEY);
    expect(vault.value).toBeNull();
    expect(await s.getItem(KEY)).toBeNull();
  });

  it('Datei einmal lesen; Schreiben während des Lesens gewinnt; Tresor kaputt → nur im Speicher, nie Klartext', async () => {
    const vault = new FakeVault();
    vault.value = '{"a":1}';
    const st = memStorage();
    const s = vaultStorage(vault, KEY, st);
    expect(await s.getItem(KEY)).toBe('{"a":1}');
    expect(await s.getItem(KEY)).toBe('{"a":1}');
    expect(vault.reads).toBe(1);

    const slow = new FakeVault();
    slow.value = '{"alt":1}';
    let open = (): void => {};
    slow.gate = new Promise((r) => {
      open = r;
    });
    const s2 = vaultStorage(slow, KEY, memStorage());
    const reading = s2.getItem(KEY);
    await s2.setItem(KEY, '{"neu":1}');
    open();
    expect(await reading).toBe('{"neu":1}');

    const broken: DesktopSessionVault = {
      read: () => Promise.reject(new Error('kein Login-Modul')),
      write: () => Promise.reject(new Error('kein Login-Modul')),
      remove: () => Promise.reject(new Error('kein Login-Modul')),
    };
    const st3 = memStorage();
    const s3 = vaultStorage(broken, KEY, st3);
    expect(await s3.getItem(KEY)).toBeNull();
    await s3.setItem(KEY, '{"refresh_token":"geheim"}');
    expect(await s3.getItem(KEY)).toBe('{"refresh_token":"geheim"}');
    expect(st3.data.size).toBe(0);
    await s3.removeItem(KEY);
    expect(await s3.getItem(KEY)).toBeNull();
  });
});
