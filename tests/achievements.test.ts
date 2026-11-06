import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { parseIndex, parseTrainingIndex } from '../src/engine/Game';
import { ReplayRecorder } from '../src/engine/replay/recorder';
import { BestTimes } from '../src/engine/Settings';
import type { StorageLike } from '../src/engine/storage';
import { TrainingProgress, type StageRankRef } from '../src/engine/TrainingProgress';
import { UNLOCKS, UnlockStore } from '../src/engine/Unlocks';
import {
  ACHIEVEMENT_IDS,
  ACHIEVEMENTS_KEY,
  AchievementTracker,
  SPACEWAR_TEST_TABLE,
  STEAM_TEST_APP_ID,
  UNLOCK_ACHIEVEMENT,
  steamNameFor,
  type AchievementSink,
} from '../src/platform/achievements';
import { isCleanFinish, type LiveFinish, type LiveLesson } from '../src/platform/live';
import { adminTimeFor, type MedalId } from '../src/ui/medals';
import type { LevelMedals } from '../src/world/level/LevelFormat';

/** Plan 011 Schritt 4.3: Achievements nur aus Live-Ereignissen, idempotent über velocity.achv.v1, 480 = Test-Tabelle. */

class Mem implements StorageLike {
  readonly m = new Map<string, string>();
  writes = 0;
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.writes++;
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

class FakeSink implements AchievementSink {
  readonly calls: string[] = [];
  readonly fail = new Set<string>();
  constructor(readonly appId: number) {}
  unlock(name: string): Promise<boolean> {
    this.calls.push(name);
    return Promise.resolve(!this.fail.has(name));
  }
}

const LEVELS = parseIndex(JSON.parse(readFileSync('public/levels/index.json', 'utf8')));
const LESSONS = parseTrainingIndex(JSON.parse(readFileSync('public/levels/training/index.json', 'utf8')));
const SPACEWAR = ['ACH_WIN_ONE_GAME', 'ACH_WIN_100_GAMES', 'ACH_TRAVEL_FAR_ACCUM', 'ACH_TRAVEL_FAR_SINGLE'];
const REAL_APP = 4242;

function medalsOf(levelId: string): LevelMedals {
  const m = LEVELS.find((l) => l.id === levelId)?.medals;
  if (!m) throw new Error(`Level ${levelId} ohne Medaillen`);
  return m;
}
/** Laufzeit knapp innerhalb der Medaille (wie das Admin-Menü sie setzt). */
const timeFor = (levelId: string, medal: MedalId): number => adminTimeFor(medal, medalsOf(levelId));

function stagesOf(lessonId: string): StageRankRef[] {
  const raw: unknown = JSON.parse(readFileSync(`public/levels/training/${lessonId}.json`, 'utf8'));
  const stages = (raw as { training?: { stages?: unknown } }).training?.stages;
  if (!Array.isArray(stages)) throw new Error(`Lektion ${lessonId} ohne Stufen`);
  return stages.map((s: { id: string; rank?: 'required' | 'bonus' | 'master' }) => ({ id: s.id, rank: s.rank }));
}

const finish = (levelId: string, time: number, clean = true): LiveFinish => ({ kind: 'finish', levelId, time, clean, levels: LEVELS, lessons: LESSONS });

/** Sitzung einer Lektion: 'required' = alle Pflichtstufen, 'all' = alles, sonst diese Ränge. */
function lesson(lessonId: string, ranks: readonly ('required' | 'bonus' | 'master')[], clean = true): LiveLesson {
  const stages = stagesOf(lessonId);
  const completed = stages.filter((s) => ranks.includes(s.rank ?? 'required')).map((s) => s.id);
  return { kind: 'lesson', lessonId, stages, completed, clean, levels: LEVELS, lessons: LESSONS };
}

describe('isCleanFinish — dieselbe Regel wie die Bestenliste', () => {
  const meta = {
    levelId: 'level1',
    levelHash: 'h',
    configHash: 'c',
    tickRate: 128,
    settings: { preset: 'velocity', autoHop: true, strafeAssist: true, airControl: true },
  } as const;
  const run = (prep: (r: ReplayRecorder) => void): boolean => {
    const r = new ReplayRecorder();
    r.begin(meta);
    prep(r);
    for (let i = 0; i < 4; i++) r.record(0, 0, 0);
    const rep = r.finish(1, new Vector3());
    return isCleanFinish(rep, r.invalid);
  };

  it('gültige Aufnahme ohne Bot = sauber', () => {
    expect(run(() => {})).toBe(true);
  });

  it('F1-Tuning / Physik im Lauf geändert / Debug-Teleport (invalid) → zählt nicht', () => {
    expect(run((r) => r.invalidate('Physik per Tuning-Panel verändert'))).toBe(false);
    expect(run((r) => r.invalidate('Physik-Einstellung im Lauf geändert'))).toBe(false);
    expect(run((r) => r.invalidate('Teleport (Debug)'))).toBe(false);
  });

  it('Bot/Override (assisted) oder keine Aufnahme → zählt nicht', () => {
    expect(run((r) => r.markAssisted())).toBe(false);
    const none = new ReplayRecorder();
    expect(isCleanFinish(none.finish(1, new Vector3()), none.invalid)).toBe(false);
  });
});

describe('AchievementTracker', () => {
  it('Ziel mit Gold in L1 → L1_BRONZE + L1_GOLD genau einmal (dazu die Freischaltungen Jo-Jo + Neon), idempotent', async () => {
    const mem = new Mem();
    const sink = new FakeSink(STEAM_TEST_APP_ID);
    const t = new AchievementTracker(mem, sink);
    expect(t.record(finish('level1', timeFor('level1', 'gold')))).toEqual(['L1_BRONZE', 'L1_GOLD', 'UNLOCK_ITEM_YOYO', 'UNLOCK_GLOVE_NEON']);
    await t.settled();
    // 480: nur die Test-Tabelle, abgebildet auf Spacewar.
    expect(sink.calls).toEqual(['ACH_WIN_ONE_GAME', 'ACH_WIN_100_GAMES']);
    expect(t.record(finish('level1', timeFor('level1', 'gold')))).toEqual([]);
    await t.settled();
    expect(sink.calls).toHaveLength(2);
    // Neu geladen (gleicher Speicher): nichts doppelt.
    const again = new AchievementTracker(mem, sink);
    expect(again.earned()).toEqual(['L1_BRONZE', 'L1_GOLD', 'UNLOCK_ITEM_YOYO', 'UNLOCK_GLOVE_NEON']);
    expect(again.record(finish('level1', timeFor('level1', 'velocity')))).toEqual(['L1_VELOCITY', 'UNLOCK_ITEM_CARD']);
    await again.settled();
    expect(sink.calls).toHaveLength(2);
    expect(again.delivered(STEAM_TEST_APP_ID)).toEqual(['ACH_WIN_ONE_GAME', 'ACH_WIN_100_GAMES']);
  });

  it('ungültige Aufnahme (F1-Tuning, Bot) zählt nicht — auch nicht nachträglich', async () => {
    const sink = new FakeSink(REAL_APP);
    const t = new AchievementTracker(new Mem(), sink);
    expect(t.record(finish('level1', timeFor('level1', 'velocity'), false))).toEqual([]);
    expect(t.earned()).toEqual([]);
    expect(t.medal('level1')).toBeNull();
    // Ein späterer sauberer Bronze-Lauf bringt nur Bronze — das unsaubere VELOCITY wurde nie verbucht.
    expect(t.record(finish('level1', timeFor('level1', 'bronze')))).toEqual(['L1_BRONZE']);
    await t.settled();
    expect(sink.calls).toEqual(['L1_BRONZE']);
  });

  it('Admin (UnlockStore.set/grantEarnedFor/unlockAll, Medaille setzen, Sterne setzen) löst nichts aus', async () => {
    const mem = new Mem();
    const sink = new FakeSink(REAL_APP);
    const t = new AchievementTracker(mem, sink);
    const unlocks = new UnlockStore(mem);
    const best = new BestTimes(mem);
    const progress = new TrainingProgress(mem);
    progress.setLessons(LESSONS);
    // "Medaille setzen" im Admin-Menü = BestTimes.set + grantEarnedFor (Game.adminBest).
    for (const l of ['level1', 'level2', 'level3', 'level4']) {
      best.set(l, timeFor(l, 'velocity'));
      unlocks.grantEarnedFor(l, LEVELS, (id) => best.get(id));
    }
    unlocks.set('glove.cat', true);
    unlocks.set('item.knife', false);
    unlocks.unlockAll();
    for (const l of LESSONS) progress.setStars(l.id, stagesOf(l.id), 3);
    unlocks.sync(LEVELS, (id) => best.get(id), progress);
    await t.settled();
    expect(t.earned()).toEqual([]);
    expect(sink.calls).toEqual([]);
    expect(mem.getItem(ACHIEVEMENTS_KEY)).toBeNull();
    // Auch ein Tracker, der NACH den Admin-Aktionen startet, leitet nichts aus Bestzeiten/Freischaltungen ab.
    const later = new AchievementTracker(mem, sink);
    expect(later.earned()).toEqual([]);
    // Ein echter Lauf in L2 (Bronze) bringt genau das — nicht L1–L4 VELOCITY, Münze, Katzenpfote oder Training.
    expect(later.record(finish('level2', timeFor('level2', 'bronze')))).toEqual(['L2_BRONZE']);
    await later.settled();
    expect(sink.calls).toEqual(['L2_BRONZE']);
  });

  it('Lektionen: nur live geschaffte Stufen; T1–T4 ★ → TRAINING_BASICS + Spinner; Sitzungen vereinigt', async () => {
    const sink = new FakeSink(STEAM_TEST_APP_ID);
    const t = new AchievementTracker(new Mem(), sink);
    expect(t.record(lesson('t1', ['bonus', 'master']))).toEqual([]); // ohne Pflichtstufen kein Stern
    expect(t.record(lesson('t1', ['required']))).toEqual([]);
    expect(t.record(lesson('t2', ['required']))).toEqual([]);
    expect(t.record(lesson('t3', ['required'], false))).toEqual([]); // Bot/Debug in der Sitzung
    expect(t.record(lesson('t3', ['required']))).toEqual([]);
    expect(t.record(lesson('t4', ['required']))).toEqual(['TRAINING_BASICS', 'UNLOCK_ITEM_SPINNER']);
    await t.settled();
    expect(sink.calls).toEqual(['ACH_TRAVEL_FAR_SINGLE']);
    // T1 hatte Bonus+Meister schon in der ersten Sitzung: die Vereinigung macht ★★★ daraus.
    for (const id of ['t2', 't3', 't4', 't5', 't6', 't7', 't8']) t.record(lesson(id, ['required', 'bonus', 'master']));
    expect(t.earned()).toEqual(expect.arrayContaining(['TRAINING_ALL', 'TRAINING_MASTER', 'UNLOCK_GLOVE_ROBOT']));
    expect(t.earned().filter((id) => id.startsWith('L'))).toEqual([]);
  });

  it('erster verifizierter Online-Lauf: nur echte Online-Prüfung (Supabase), nicht der Mock', async () => {
    const sink = new FakeSink(STEAM_TEST_APP_ID);
    const t = new AchievementTracker(new Mem(), sink);
    expect(t.record({ kind: 'submit', backend: 'mock' })).toEqual([]);
    expect(t.record({ kind: 'submit', backend: 'supabase' })).toEqual(['FIRST_SUBMIT']);
    expect(t.record({ kind: 'submit', backend: 'supabase' })).toEqual([]);
    await t.settled();
    expect(sink.calls).toEqual(['ACH_TRAVEL_FAR_ACCUM']);
  });

  it('Zustellung gescheitert → beim nächsten Live-Ereignis erneut, nie doppelt; App-Wechsel stellt neu zu', async () => {
    const mem = new Mem();
    const sink = new FakeSink(STEAM_TEST_APP_ID);
    sink.fail.add('ACH_WIN_ONE_GAME');
    const t = new AchievementTracker(mem, sink);
    t.record(finish('level1', timeFor('level1', 'bronze')));
    await t.settled();
    expect(t.delivered(STEAM_TEST_APP_ID)).toEqual([]);
    sink.fail.clear();
    // Unsauberes Ziel: zählt gar nicht, also auch kein neuer Versuch.
    t.record(finish('level1', timeFor('level1', 'bronze'), false));
    await t.settled();
    expect(sink.calls).toEqual(['ACH_WIN_ONE_GAME']);
    t.record(finish('level1', timeFor('level1', 'bronze')));
    await t.settled();
    expect(sink.calls).toEqual(['ACH_WIN_ONE_GAME', 'ACH_WIN_ONE_GAME']);
    expect(t.delivered(STEAM_TEST_APP_ID)).toEqual(['ACH_WIN_ONE_GAME']);
    // Später die echte App-ID: alles Verdiente dort neu, unter den eigenen Namen.
    const real = new FakeSink(REAL_APP);
    const t2 = new AchievementTracker(mem, real);
    t2.record(finish('level1', timeFor('level1', 'bronze')));
    await t2.settled();
    expect(real.calls).toEqual(['L1_BRONZE']);
    expect(t2.delivered(STEAM_TEST_APP_ID)).toEqual(['ACH_WIN_ONE_GAME']);
  });

  it('kaputter oder fremder Stand = leeres Buch', () => {
    const mem = new Mem();
    mem.setItem(ACHIEVEMENTS_KEY, '{kaputt');
    expect(new AchievementTracker(mem).earned()).toEqual([]);
    mem.setItem(ACHIEVEMENTS_KEY, JSON.stringify({ v: 2, earned: ['L1_GOLD'] }));
    expect(new AchievementTracker(mem).earned()).toEqual([]);
    mem.setItem(ACHIEVEMENTS_KEY, JSON.stringify({ v: 1, earned: ['L1_GOLD', 'GIBTS_NICHT', 7], medals: { level1: 'platin' } }));
    const t = new AchievementTracker(mem);
    expect(t.earned()).toEqual(['L1_GOLD']);
    expect(t.medal('level1')).toBeNull();
  });
});

describe('Achievement-IDs und Test-Tabelle', () => {
  it('jede Freischaltung hat genau eine ID; IDs eindeutig und Steam-tauglich', () => {
    expect(Object.keys(UNLOCK_ACHIEVEMENT).sort()).toEqual(UNLOCKS.map((u) => u.id).sort());
    const values = Object.values(UNLOCK_ACHIEVEMENT);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(ACHIEVEMENT_IDS).size).toBe(ACHIEVEMENT_IDS.length);
    for (const id of ACHIEVEMENT_IDS) expect(id).toMatch(/^[A-Z0-9_]{1,64}$/);
  });

  it('App 480 nur über die Test-Tabelle auf Spacewar-IDs, sonst eigene Namen', () => {
    const mapped = Object.values(SPACEWAR_TEST_TABLE);
    expect(new Set(mapped).size).toBe(mapped.length);
    for (const n of mapped) expect(SPACEWAR).toContain(n);
    for (const id of ACHIEVEMENT_IDS) {
      const n = steamNameFor(id, STEAM_TEST_APP_ID);
      expect(n === null || SPACEWAR.includes(n)).toBe(true);
      expect(steamNameFor(id, REAL_APP)).toBe(id);
    }
    expect(steamNameFor('L2_GOLD', STEAM_TEST_APP_ID)).toBeNull();
    expect(steamNameFor('L1_GOLD', 0)).toBeNull();
  });
});
