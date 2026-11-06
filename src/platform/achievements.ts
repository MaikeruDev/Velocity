/**
 * Achievements (Plan 011 Schritt 4.3) — DOM-frei und ohne Steam-Bezug: Live-Ereignisse (live.ts) → eigene
 * Achievement-IDs → Zustellung an eine Senke (platform/steam.ts → Bridge → electron/steam.ts).
 *
 * Grundregel (Plan 011 §2.2.13 + Review): verdient wird NUR aus dem, was ein Live-Ereignis selbst beweist — ein
 * sauberes Ziel (isCleanFinish), die live geschafften Stufen einer Lektion, ein vom Server angenommener Lauf. Der
 * Tracker liest weder BestTimes noch UnlockStore noch den Trainings-Fortschritt. Admin-Aktionen (UnlockStore.set,
 * grantEarnedFor, unlockAll, "Medaille setzen" = BestTimes.set, Sterne setzen) und gespeicherte Bestzeiten können
 * deshalb nichts auslösen, auch nicht über eine spätere Ableitung. Dafür führt er ein eigenes Buch in
 * `velocity.achv.v1`: beste live bewiesene Medaille je Level, live geschaffte Stufen je Lektion, verdiente IDs und
 * je App-ID die zugestellten Steam-Namen. Idempotent: jede ID wird je App-ID genau einmal zugestellt; ein Wechsel
 * von der Test-App 480 auf die echte App-ID stellt das Verdiente dort neu zu.
 *
 * Zugestellt wird nur im Moment eines Live-Ereignisses (auch Liegengebliebenes, z. B. nach einem Steam-Fehler) —
 * nie beim Start. Ob überhaupt ein Tracker läuft (nicht mit --dev/CDP), entscheidet platform/steam.ts.
 */
import type { SpacewarAchievement } from './bridgeTypes';
import type { LiveProgress } from './live';
import type { StorageLike } from '../engine/storage';
import { defaultStorage } from '../engine/storage';
import { starsFor } from '../engine/TrainingProgress';
import type { TrainingProgressView, LessonStars } from '../engine/trainingTypes';
import { requirementMet, UNLOCKS, type UnlockId, type UnlockRequirement } from '../engine/Unlocks';
import { medalAtLeast, medalFor, type MedalId } from '../ui/medals';
import type { TrainingIndexEntry } from '../world/level/LevelFormat';

export const ACHIEVEMENTS_KEY = 'velocity.achv.v1';
const VERSION = 1;

/**
 * Alle IDs = Steamworks-API-Namen der echten App (Plan 011 4.3): je Level Bronze/Gold/VELOCITY, Training, je
 * Freischaltung eine, erster verifizierter Online-Lauf. Reihenfolge = Zustell-Reihenfolge.
 */
export const ACHIEVEMENT_IDS = [
  'L1_BRONZE', 'L1_GOLD', 'L1_VELOCITY',
  'L2_BRONZE', 'L2_GOLD', 'L2_VELOCITY',
  'L3_BRONZE', 'L3_GOLD', 'L3_VELOCITY',
  'L4_BRONZE', 'L4_GOLD', 'L4_VELOCITY',
  'TRAINING_BASICS', 'TRAINING_ALL', 'TRAINING_MASTER',
  'UNLOCK_ITEM_SPINNER', 'UNLOCK_GLOVE_ROBOT', 'UNLOCK_ITEM_COIN', 'UNLOCK_ITEM_YOYO', 'UNLOCK_ITEM_LIGHTER',
  'UNLOCK_ITEM_KENDAMA', 'UNLOCK_ITEM_PHONE', 'UNLOCK_GLOVE_NEON', 'UNLOCK_GLOVE_SKELETON', 'UNLOCK_ITEM_CARD',
  'UNLOCK_ITEM_CAN', 'UNLOCK_ITEM_KNIFE', 'UNLOCK_GLOVE_GOLD', 'UNLOCK_GLOVE_CAT',
  'FIRST_SUBMIT',
] as const;

export type AchievementId = (typeof ACHIEVEMENT_IDS)[number];

/** Medaillen-Achievements je Level (nur die vier Hauptlevel; Sandbox/Dev-Level zählen nie). */
export const LEVEL_ACHIEVEMENTS: readonly { readonly levelId: string; readonly medals: Readonly<Record<'bronze' | 'gold' | 'velocity', AchievementId>> }[] = [
  { levelId: 'level1', medals: { bronze: 'L1_BRONZE', gold: 'L1_GOLD', velocity: 'L1_VELOCITY' } },
  { levelId: 'level2', medals: { bronze: 'L2_BRONZE', gold: 'L2_GOLD', velocity: 'L2_VELOCITY' } },
  { levelId: 'level3', medals: { bronze: 'L3_BRONZE', gold: 'L3_GOLD', velocity: 'L3_VELOCITY' } },
  { levelId: 'level4', medals: { bronze: 'L4_BRONZE', gold: 'L4_GOLD', velocity: 'L4_VELOCITY' } },
];

/** Je Freischaltung (engine/Unlocks) genau ein Achievement — Record erzwingt Vollständigkeit. */
export const UNLOCK_ACHIEVEMENT: Readonly<Record<UnlockId, AchievementId>> = {
  'item.spinner': 'UNLOCK_ITEM_SPINNER',
  'glove.robot': 'UNLOCK_GLOVE_ROBOT',
  'item.coin': 'UNLOCK_ITEM_COIN',
  'item.yoyo': 'UNLOCK_ITEM_YOYO',
  'item.lighter': 'UNLOCK_ITEM_LIGHTER',
  'item.kendama': 'UNLOCK_ITEM_KENDAMA',
  'item.phone': 'UNLOCK_ITEM_PHONE',
  'glove.neon': 'UNLOCK_GLOVE_NEON',
  'glove.skeleton': 'UNLOCK_GLOVE_SKELETON',
  'item.card': 'UNLOCK_ITEM_CARD',
  'item.can': 'UNLOCK_ITEM_CAN',
  'item.knife': 'UNLOCK_ITEM_KNIFE',
  'glove.gold': 'UNLOCK_GLOVE_GOLD',
  'glove.cat': 'UNLOCK_GLOVE_CAT',
};

/** Steam-Test-App (Spacewar), bis es eine eigene App-ID gibt (Plan 011 §8.1). */
export const STEAM_TEST_APP_ID = 480;

/**
 * Test-Tabelle für App 480: Spacewar kennt nur seine eigenen Achievements. Nur diese vier eigenen IDs werden dort
 * (auf die Spacewar-Namen abgebildet) gesetzt, alles andere bleibt bei 480 liegen.
 */
export const SPACEWAR_TEST_TABLE: Readonly<Partial<Record<AchievementId, SpacewarAchievement>>> = {
  L1_BRONZE: 'ACH_WIN_ONE_GAME',
  L1_GOLD: 'ACH_WIN_100_GAMES',
  TRAINING_BASICS: 'ACH_TRAVEL_FAR_SINGLE',
  FIRST_SUBMIT: 'ACH_TRAVEL_FAR_ACCUM',
};

/** Steam-API-Name einer eigenen ID für diese App (null = dort nicht zustellen). */
export function steamNameFor(id: AchievementId, appId: number): string | null {
  if (appId === STEAM_TEST_APP_ID) return SPACEWAR_TEST_TABLE[id] ?? null;
  return Number.isInteger(appId) && appId > 0 ? id : null;
}

/** Zustellung: setzt einen Steam-API-Namen (true = gesetzt). */
export interface AchievementSink {
  readonly appId: number;
  unlock(apiName: string): Promise<boolean>;
}

interface LessonRecord {
  readonly stages: readonly string[];
  readonly stars: LessonStars;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MEDALS: readonly MedalId[] = ['velocity', 'gold', 'silver', 'bronze'];
const isMedal = (v: unknown): v is MedalId => MEDALS.some((m) => m === v);
const isAchievementId = (v: unknown): v is AchievementId => ACHIEVEMENT_IDS.some((id) => id === v);
const isStars = (v: unknown): v is LessonStars => v === 0 || v === 1 || v === 2 || v === 3;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

export class AchievementTracker {
  private readonly storage: StorageLike | null;
  private sink: AchievementSink | null;
  private readonly medals = new Map<string, MedalId>();
  private readonly lessonsDone = new Map<string, LessonRecord>();
  private submitted = false;
  private readonly earnedList: AchievementId[] = [];
  private readonly earnedSet = new Set<AchievementId>();
  /** App-ID (als Text) → zugestellte Steam-Namen. */
  private readonly sent = new Map<string, Set<string>>();
  private readonly inflight = new Set<string>();
  private readonly running: Promise<void>[] = [];

  constructor(storage: StorageLike | null = defaultStorage(), sink: AchievementSink | null = null) {
    this.storage = storage;
    this.sink = sink;
    this.load();
  }

  setSink(sink: AchievementSink | null): void {
    this.sink = sink;
  }

  /** Verdiente IDs in Verdienst-Reihenfolge. */
  earned(): AchievementId[] {
    return this.earnedList.slice();
  }

  /** Zugestellte Steam-Namen dieser App-ID. */
  delivered(appId: number): string[] {
    return [...(this.sent.get(String(appId)) ?? [])];
  }

  /** Beste live bewiesene Medaille eines Levels (Tests/Werkzeuge). */
  medal(levelId: string): MedalId | null {
    return this.medals.get(levelId) ?? null;
  }

  /**
   * Live-Ereignis verbuchen. Unsaubere Ziele/Sitzungen und Mock-Einreichungen zählen gar nicht (auch keine
   * Zustellung von Liegengebliebenem). Rückgabe = durch DIESES Ereignis neu verdiente IDs.
   */
  record(e: LiveProgress): AchievementId[] {
    let lessons: readonly TrainingIndexEntry[] | null = null;
    if (e.kind === 'finish') {
      if (!e.clean) return [];
      const lv = e.levels.find((l) => l.id === e.levelId);
      const m = lv?.medals ? medalFor(e.time, lv.medals) : null;
      // Nur nach oben: eine langsamere Fahrt nimmt nichts weg.
      if (m !== null && !medalAtLeast(this.medals.get(e.levelId) ?? null, m)) this.medals.set(e.levelId, m);
      lessons = e.lessons;
    } else if (e.kind === 'lesson') {
      if (!e.clean) return [];
      const known = new Set(e.stages.map((s) => s.id));
      const prev = this.lessonsDone.get(e.lessonId);
      const merged = new Set(prev?.stages ?? []);
      for (const id of e.completed) if (known.has(id)) merged.add(id);
      // Vereinigung über die Sitzungen wie TrainingProgress, Sterne nur nach oben — aber nur aus Live-Stufen.
      const derived = starsFor(e.stages, merged);
      const old = prev?.stars ?? 0;
      this.lessonsDone.set(e.lessonId, { stages: [...merged], stars: derived > old ? derived : old });
      lessons = e.lessons;
    } else {
      if (e.backend !== 'supabase') return [];
      this.submitted = true;
    }
    const fresh = this.evaluate(lessons);
    this.save();
    this.deliver();
    return fresh;
  }

  /** Wartet auf laufende Zustellungen (Tests, Werkzeuge). */
  async settled(): Promise<void> {
    while (this.running.length > 0) await Promise.all(this.running.splice(0));
  }

  // ---------------------------------------------------------------- intern

  private lessonStars(id: string): LessonStars {
    return this.lessonsDone.get(id)?.stars ?? 0;
  }

  /** Training-Anforderung mit DERSELBEN Regel wie die Freischaltungen (Unlocks.requirementMet), nur aus dem Buch. */
  private trainingMet(group: 'basics' | 'all', minStars: 1 | 3, lessons: readonly TrainingIndexEntry[] | null): boolean {
    if (lessons === null) return false;
    const view: TrainingProgressView = { stars: (id) => this.lessonStars(id), lessons: () => lessons };
    return requirementMet({ kind: 'training', group, minStars }, [], () => null, view);
  }

  private met(r: UnlockRequirement, lessons: readonly TrainingIndexEntry[] | null): boolean {
    // Medaille: die live bewiesene, nicht die gespeicherte Bestzeit (Admin "Medaille setzen" bleibt außen vor).
    if (r.kind === 'medal') return medalAtLeast(this.medals.get(r.levelId) ?? null, r.medal);
    return this.trainingMet(r.group, r.minStars, lessons);
  }

  /** Alles, was das Buch beweist, zu `earned` hinzufügen (nur hinzufügen, nie entfernen). */
  private evaluate(lessons: readonly TrainingIndexEntry[] | null): AchievementId[] {
    const fresh: AchievementId[] = [];
    const add = (id: AchievementId): void => {
      if (this.earnedSet.has(id)) return;
      this.earnedSet.add(id);
      this.earnedList.push(id);
      fresh.push(id);
    };
    for (const la of LEVEL_ACHIEVEMENTS) {
      const m = this.medals.get(la.levelId) ?? null;
      if (medalAtLeast(m, 'bronze')) add(la.medals.bronze);
      if (medalAtLeast(m, 'gold')) add(la.medals.gold);
      if (medalAtLeast(m, 'velocity')) add(la.medals.velocity);
    }
    if (this.trainingMet('basics', 1, lessons)) add('TRAINING_BASICS');
    if (this.trainingMet('all', 1, lessons)) add('TRAINING_ALL');
    if (this.trainingMet('all', 3, lessons)) add('TRAINING_MASTER');
    for (const u of UNLOCKS) if (u.requires.every((r) => this.met(r, lessons))) add(UNLOCK_ACHIEVEMENT[u.id]);
    if (this.submitted) add('FIRST_SUBMIT');
    return fresh;
  }

  /** Verdientes, das diese App noch nicht hat, zustellen. Fehlschlag → beim nächsten Live-Ereignis erneut. */
  private deliver(): void {
    const sink = this.sink;
    if (sink === null) return;
    const key = String(sink.appId);
    let sent = this.sent.get(key);
    if (!sent) {
      sent = new Set();
      this.sent.set(key, sent);
    }
    const done = sent;
    for (const id of this.earnedList) {
      const name = steamNameFor(id, sink.appId);
      if (name === null || done.has(name)) continue;
      const tag = `${key}:${name}`;
      // Zwei Ereignisse kurz hintereinander: dieselbe ID nicht doppelt anfragen, solange die erste läuft.
      if (this.inflight.has(tag)) continue;
      this.inflight.add(tag);
      const p = sink
        .unlock(name)
        .then(
          (ok) => {
            if (ok) {
              done.add(name);
              this.save();
            }
          },
          () => undefined,
        )
        .finally(() => this.inflight.delete(tag));
      this.running.push(p);
    }
  }

  private load(): void {
    let raw: unknown = null;
    try {
      const s = this.storage?.getItem(ACHIEVEMENTS_KEY) ?? null;
      raw = s === null ? null : JSON.parse(s);
    } catch {
      raw = null;
    }
    // Kaputter/fremder Stand = leeres Buch (kein Wurf). Verloren ist dann nur, was Steam ohnehin schon hat.
    if (!isRecord(raw) || raw.v !== VERSION) return;
    if (isRecord(raw.medals)) for (const [id, m] of Object.entries(raw.medals)) if (isMedal(m)) this.medals.set(id, m);
    if (isRecord(raw.lessons)) {
      for (const [id, r] of Object.entries(raw.lessons)) {
        if (isRecord(r)) this.lessonsDone.set(id, { stages: [...new Set(strings(r.stages))], stars: isStars(r.stars) ? r.stars : 0 });
      }
    }
    this.submitted = raw.submitted === true;
    for (const id of strings(raw.earned)) {
      if (isAchievementId(id) && !this.earnedSet.has(id)) {
        this.earnedSet.add(id);
        this.earnedList.push(id);
      }
    }
    if (isRecord(raw.sent)) for (const [app, names] of Object.entries(raw.sent)) this.sent.set(app, new Set(strings(names)));
  }

  private save(): void {
    if (!this.storage) return;
    const medals: Record<string, MedalId> = {};
    for (const [id, m] of this.medals) medals[id] = m;
    const lessons: Record<string, LessonRecord> = {};
    for (const [id, r] of this.lessonsDone) lessons[id] = r;
    const sent: Record<string, string[]> = {};
    for (const [app, names] of this.sent) sent[app] = [...names];
    try {
      this.storage.setItem(ACHIEVEMENTS_KEY, JSON.stringify({ v: VERSION, medals, lessons, submitted: this.submitted, earned: this.earnedList, sent }));
    } catch {
      // Quota/Privatmodus: gilt für diese Sitzung; Steam selbst behält, was schon zugestellt ist.
    }
  }
}
