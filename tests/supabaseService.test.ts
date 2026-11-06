import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StorageLike } from '../src/engine/Settings';
import { PHYSICS_VERSION } from '../src/engine/replay/format';
import { levelHash } from '../src/engine/replay/hash';
import { PENDING_KEY, PENDING_MAX_AGE_MS, hasPendingRun, savePendingRun, takePendingRun } from '../src/online/pendingSubmit';
import { SupabaseService } from '../src/online/SupabaseService';
import type { BestRow, BoardQuery, ProfileRow, SessionInfo, SubmitResponse, SupabaseApi } from '../src/online/supabaseApi';
import type { BoardRow } from '../src/online/supabaseTypes';
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
  async runCount(): Promise<number> {
    return 7;
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
    const prof = await svc.getProfile();
    expect(prof).toEqual({ uid: ME, name: 'Fuchs', runs: 7, bests: [{ levelId: 'level1', time: 19.5, rank: 2, runId: 'run-1' }] });
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
