import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileLevel } from '../src/world/level/compileLevel';
import type { CompiledLevel } from '../src/world/level/compileLevel';
import type { LevelFile } from '../src/world/level/LevelFormat';
import type { StorageLike } from '../src/engine/Settings';
import { recordBotRun } from '../src/engine/replay/botRun';
import { packReplay, unpackReplay } from '../src/engine/replay/codec';
import { replayToGhost } from '../src/engine/replay/verify';
import { LocalMockService, OnlineError, createOnlineService, onlineBackend, sanitizeName } from '../src/online';

/** Plan 009: Online-Attrappe — verifiziert lokal, rankt nach nachgerechneter Zeit, liefert Ghosts. */

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const cache = new Map<string, CompiledLevel>();
async function loadLevel(id: string): Promise<CompiledLevel> {
  let lv = cache.get(id);
  if (!lv) {
    const dir = join(process.cwd(), 'public', 'levels');
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { id: string; file: string }[];
    const file = index.find((e) => e.id === id)?.file;
    if (!file) throw new Error(`Level ${id} unbekannt`);
    lv = compileLevel(JSON.parse(readFileSync(join(dir, file), 'utf8')) as LevelFile);
    cache.set(id, lv);
  }
  return lv;
}

describe('LocalMockService', () => {
  it('auth, einreichen (verifiziert), Rang, Bestenliste, Ghost, Profil, Persistenz', async () => {
    const storage = memStorage();
    const svc = new LocalMockService({ storage, loadLevel, latencyMs: 0, rivals: false });
    const me = await svc.auth('Michi');
    expect(me.name).toBe('Michi');
    const level = await loadLevel('level2');
    const slow = recordBotRun(level, { follower: { aimNoiseDeg: 2, seed: 1 } });
    const fast = recordBotRun(level, { follower: { aimNoiseDeg: 0.5, seed: 1 } });
    if (!slow || !fast) throw new Error('Bot kam nicht ins Ziel');
    expect(fast.header.time).toBeLessThan(slow.header.time);

    const r1 = await svc.submitRun(await packReplay(slow));
    expect(r1.status).toBe('accepted');
    expect(r1.time).toBe(slow.header.time);
    expect(r1.rank).toBe(1);
    expect(r1.personalBest).toBe(true);
    const r2 = await svc.submitRun(await packReplay(fast));
    expect(r2.personalBest).toBe(true);
    const r3 = await svc.submitRun(await packReplay(slow));
    expect(r3.status).toBe('accepted');
    expect(r3.personalBest).toBe(false);

    const page = await svc.getLeaderboard('level2', { kind: 'top', limit: 10 });
    expect(page.total).toBe(1);
    expect(page.entries[0].time).toBe(fast.header.time);
    expect(page.entries[0].bot).toBe(true); // Bot-Aufnahme ist als solche markiert
    expect(page.me?.rank).toBe(1);

    // Ghost aus dem gespeicherten Replay.
    const g = replayToGhost(await unpackReplay(await svc.getGhost(page.entries[0].runId)), level);
    expect(g?.time).toBe(fast.header.time);

    const prof = await svc.getProfile();
    expect(prof.runs).toBe(3);
    expect(prof.bests).toEqual([{ levelId: 'level2', time: fast.header.time, rank: 1, total: 1, runId: page.entries[0].runId, date: page.entries[0].date }]);
    expect(prof.worldRecords).toBe(1);
    expect(prof.dev).toBe(false);
    expect(typeof prof.memberSince).toBe('string');
    expect(svc.admin).toBeNull(); // ohne dev keine Werkzeuge

    // Neue Instanz auf demselben Storage: alles noch da.
    const svc2 = new LocalMockService({ storage, loadLevel, latencyMs: 0, rivals: false });
    expect(svc2.identity?.uid).toBe(me.uid);
    expect((await svc2.getLeaderboard('level2', { kind: 'top', limit: 3 })).entries.length).toBe(1);
  });

  it('manipuliertes Replay wird abgelehnt (Grund vom Verifier), kaputte Bytes auch', async () => {
    const svc = new LocalMockService({ storage: memStorage(), loadLevel, latencyMs: 0, rivals: false });
    const rep = recordBotRun(await loadLevel('level1'), { follower: { aimNoiseDeg: 1, seed: 3 } });
    if (!rep) throw new Error('Bot kam nicht ins Ziel');
    const fake = { ...rep, header: { ...rep.header, time: rep.header.time - 2 } };
    const res = await svc.submitRun(await packReplay(fake));
    expect(res.status).toBe('rejected');
    expect(res.reason).toBe('claim');
    expect((await svc.submitRun(new Uint8Array([9, 9, 9]))).reason).toBe('format');
    expect((await svc.getLeaderboard('level1', { kind: 'top', limit: 10 })).total).toBe(0);
  });

  it('Rivalen: Bot-Läufe mit Ghost, um-mich-herum-Ausschnitt', async () => {
    const svc = new LocalMockService({ storage: memStorage(), loadLevel, latencyMs: 0 });
    await svc.auth('Ich');
    const top = await svc.getLeaderboard('level1', { kind: 'top', limit: 10 });
    expect(top.total).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < top.entries.length; i++) expect(top.entries[i].time).toBeGreaterThanOrEqual(top.entries[i - 1].time);
    // Mittelmäßiger eigener Lauf → landet zwischen den Rivalen.
    const rep = recordBotRun(await loadLevel('level1'), { follower: { aimNoiseDeg: 2, seed: 5 } });
    if (!rep) throw new Error('Bot kam nicht ins Ziel');
    const sub = await svc.submitRun(await packReplay(rep));
    expect(sub.status).toBe('accepted');
    const around = await svc.getLeaderboard('level1', { kind: 'around', radius: 2 });
    expect(around.entries.some((e) => e.uid === svc.identity?.uid)).toBe(true);
    expect(around.entries.length).toBeLessThanOrEqual(5);
    const ghost = await svc.getGhost(top.entries[0].runId);
    expect((await unpackReplay(ghost)).header.levelId).toBe('level1');
  });

  it('simulierte Ausfälle werfen OnlineError offline', async () => {
    const svc = new LocalMockService({ storage: memStorage(), loadLevel, latencyMs: 0, failRate: 1 });
    await expect(svc.auth()).rejects.toBeInstanceOf(OnlineError);
    await expect(svc.getLeaderboard('level1', { kind: 'top', limit: 1 })).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('LocalMockService als Entwickler (dev: Moderation lokal)', () => {
  it('Läufe/Spieler listen, Bann blendet aus + sperrt Einreichen + Profil unbekannt, Umbenennen, Löschen, Protokoll', async () => {
    const svc = new LocalMockService({ storage: memStorage(), loadLevel, latencyMs: 0, dev: true });
    const me = await svc.auth('Dev');
    expect(me.dev).toBe(true);
    const admin = svc.admin;
    if (!admin) throw new Error('admin fehlt');
    await svc.ensureRivals('level1');
    const runs = await admin.listRuns({ levelId: 'level1', limit: 2 });
    expect(runs.items).toHaveLength(2);
    expect(runs.total).toBeGreaterThanOrEqual(4);
    const victim = runs.items[0];
    const players = await admin.listPlayers({ search: victim.name.slice(0, 4) });
    expect(players.items.some((p) => p.uid === victim.uid)).toBe(true);

    await expect(admin.setBan(victim.uid, true, '')).rejects.toMatchObject({ code: 'invalid' });
    await expect(admin.setBan(me.uid, true, 'x')).rejects.toMatchObject({ code: 'invalid' });
    const banned = await admin.setBan(victim.uid, true, 'Test-Bann');
    expect(banned).toMatchObject({ banned: true, banReason: 'Test-Bann' });
    const board = await svc.getLeaderboard('level1', { kind: 'top', limit: 50 });
    expect(board.entries.some((e) => e.uid === victim.uid)).toBe(false);
    await expect(svc.getProfile(victim.uid)).rejects.toMatchObject({ code: 'notFound' });
    expect((await admin.listPlayers({ bannedOnly: true })).items.map((p) => p.uid)).toEqual([victim.uid]);
    await admin.setBan(victim.uid, false);
    expect((await svc.getLeaderboard('level1', { kind: 'top', limit: 50 })).entries.some((e) => e.uid === victim.uid)).toBe(true);

    expect((await admin.renamePlayer(victim.uid, '  Neu<>Name ')).name).toBe('NeuName');
    await expect(admin.renamePlayer(victim.uid, '!')).rejects.toMatchObject({ code: 'invalid' });

    const del = await admin.deleteRun(victim.runId, 'Bug');
    expect(del).toMatchObject({ runId: victim.runId, uid: victim.uid, wasBest: true, newBest: null });
    await expect(admin.deleteRun(victim.runId, 'Bug')).rejects.toMatchObject({ code: 'notFound' });
    await expect(svc.getGhost(victim.runId)).rejects.toMatchObject({ code: 'notFound' });

    const log = await admin.auditLog({ uid: victim.uid });
    expect(log.items.map((e) => e.action)).toEqual(['delete_run', 'rename', 'unban', 'ban']);
    expect(log.items[1].detail).toMatchObject({ to: 'NeuName' });
    expect(log.items[0]).toMatchObject({ actorUid: me.uid, actorName: 'Dev', targetName: 'NeuName', runId: victim.runId });
  });

  it('gebannter eigener Spieler: Einreichen → banned, eigenes Profil ohne Bestzeiten', async () => {
    const storage = memStorage();
    const dev = new LocalMockService({ storage, loadLevel, latencyMs: 0, rivals: false, dev: true });
    const me = await dev.auth('Ich');
    const rep = recordBotRun(await loadLevel('level1'), { follower: { aimNoiseDeg: 1, seed: 9 } });
    if (!rep) throw new Error('Bot kam nicht ins Ziel');
    await dev.submitRun(await packReplay(rep));
    // Bann von außen (anderes Dev-Konto gibt es im Mock nicht) — direkt im Speicher wie ein Server-Bann.
    const raw = JSON.parse(storage.getItem('velocity.online.mock.v1') ?? '{}') as { users: Record<string, { banned?: boolean }> };
    raw.users[me.uid].banned = true;
    storage.setItem('velocity.online.mock.v1', JSON.stringify(raw));
    const svc = new LocalMockService({ storage, loadLevel, latencyMs: 0, rivals: false });
    await expect(svc.submitRun(await packReplay(rep))).rejects.toMatchObject({ code: 'banned' });
    const prof = await svc.getProfile();
    expect(prof.bests).toEqual([]);
    expect(prof.runs).toBe(1);
  });
});

describe('Online-Auswahl und Namen', () => {
  it('Backend: Query schlägt Env; ohne beides supabase, wenn URL+Key gesetzt, sonst mock; off = null', async () => {
    const sb = { VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'k' };
    expect(onlineBackend('off', sb)).toBe('off');
    expect(onlineBackend(null, {})).toBe('mock');
    expect(onlineBackend(null, sb)).toBe('supabase');
    expect(onlineBackend('mock', sb)).toBe('mock');
    expect(onlineBackend(null, { ...sb, VITE_ONLINE: 'mock' })).toBe('mock');
    expect(onlineBackend('firebase', {})).toBe('mock'); // verworfen → Default
    expect(await createOnlineService('off', { loadLevel })).toBeNull();
    expect(await createOnlineService('supabase', { loadLevel, env: {} })).toBeNull(); // ohne Konfig offline statt Absturz
    const mock = await createOnlineService('mock', { loadLevel, latencyMs: 0 });
    expect(mock?.loginRequired).toBe(false);
  });

  it('sanitizeName', () => {
    expect(sanitizeName('  Mi<script>chi  ')).toBe('Miscriptchi');
    expect(sanitizeName('x')).toBe('');
    expect(sanitizeName('Surf Königin 2000 und mehr')).toBe('Surf Königin 200');
    expect(sanitizeName('a_b-c.d')).toBe('a_b-c.d');
  });
});
