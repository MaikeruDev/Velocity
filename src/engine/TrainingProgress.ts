import type { StageRank, TrainingIndexEntry } from '../world/level/LevelFormat';
import type { StorageLike } from './Settings';
import { defaultStorage } from './Settings';
import type { LessonStars, TrainingProgressView } from './trainingTypes';

/**
 * Gespeicherter Trainings-Fortschritt (Plan 007, TC2): localStorage 'velocity.training.v1',
 * `{v: 1, lessons: {[lessonId]: {stages: string[], stars: 0..3, at: ISO}}}`.
 *
 * Gespeichert werden die erledigten Stufen-IDs (Vereinigung über alle Sitzungen). Die Sterne leiten
 * sich daraus gegen die Stufen der Lektion ab (★ = alle Pflichtstufen, ★★ = + Bonus, ★★★ = + Meister)
 * und werden mitgespeichert — Menü und Freischaltungen brauchen sie, ohne jede Lektion zu laden, und
 * verdiente Sterne bleiben, wenn eine Lektion später neue Stufen bekommt (nur steigen, nie fallen).
 * Kaputter oder fremder Stand lädt leer, ohne Fehler. Admin: `complete`/`reset`.
 */
export const TRAINING_KEY = 'velocity.training.v1';
const VERSION = 1;

export interface StageRankRef {
  readonly id: string;
  readonly rank?: StageRank;
}

interface LessonRecord {
  readonly stages: readonly string[];
  readonly stars: LessonStars;
  readonly at: string;
}

/** Sterne aus erledigten Stufen-IDs: 1 = alle Pflichtstufen, +1 alle Bonus-, +1 alle Meisterstufen. */
export function starsFor(stages: readonly StageRankRef[], done: ReadonlySet<string>): LessonStars {
  const all = (rank: StageRank): boolean => stages.every((s) => (s.rank ?? 'required') !== rank || done.has(s.id));
  if (!stages.some((s) => (s.rank ?? 'required') === 'required') || !all('required')) return 0;
  // Ohne Bonus-/Meisterstufe ist die Stufe erfüllt: jede Lektion kann 3 Sterne geben.
  const bonus = all('bonus');
  return bonus && all('master') ? 3 : bonus ? 2 : 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStars(v: unknown): v is LessonStars {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

/** Stand lesen; alles Unbekannte fällt weg (kein Wurf: ein kaputter Stand ist ein leerer Stand). */
export function parseTrainingProgress(raw: unknown): Map<string, LessonRecord> {
  const out = new Map<string, LessonRecord>();
  if (!isRecord(raw) || raw.v !== VERSION || !isRecord(raw.lessons)) return out;
  for (const [id, rec] of Object.entries(raw.lessons)) {
    if (!isRecord(rec) || !Array.isArray(rec.stages)) continue;
    const stages = rec.stages.filter((s): s is string => typeof s === 'string');
    out.set(id, { stages: [...new Set(stages)], stars: isStars(rec.stars) ? rec.stars : 0, at: typeof rec.at === 'string' ? rec.at : '' });
  }
  return out;
}

export class TrainingProgress implements TrainingProgressView {
  private readonly storage: StorageLike | null;
  private readonly items: Map<string, LessonRecord>;
  private entries: readonly TrainingIndexEntry[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
    let raw: unknown = null;
    try {
      const s = storage?.getItem(TRAINING_KEY) ?? null;
      raw = s === null ? null : JSON.parse(s);
    } catch {
      raw = null;
    }
    this.items = parseTrainingProgress(raw);
  }

  /** Lektionsliste (public/levels/training/index.json), Menü-Reihenfolge. */
  setLessons(entries: readonly TrainingIndexEntry[]): void {
    this.entries = entries.slice();
    this.emit();
  }

  lessons(): readonly TrainingIndexEntry[] {
    return this.entries;
  }

  stars(lessonId: string): LessonStars {
    return this.items.get(lessonId)?.stars ?? 0;
  }

  /** Erledigte Stufen-IDs (über alle Sitzungen). */
  completedStages(lessonId: string): readonly string[] {
    return this.items.get(lessonId)?.stages ?? [];
  }

  /** Irgendeine Lektion angefangen (mindestens eine Stufe erledigt)? — Menü: Neulings-Band. */
  get started(): boolean {
    for (const r of this.items.values()) if (r.stages.length > 0) return true;
    return false;
  }

  /**
   * Stufen einer Sitzung eintragen (Vereinigung mit dem Gespeicherten) und die Sterne gegen die Stufen
   * der Lektion neu ableiten — nur nach oben. Gibt die Sterne danach zurück.
   */
  record(lessonId: string, stages: readonly StageRankRef[], doneIds: readonly string[]): LessonStars {
    const prev = this.items.get(lessonId);
    const known = new Set(stages.map((s) => s.id));
    const merged = new Set(prev?.stages ?? []);
    for (const id of doneIds) if (known.has(id)) merged.add(id);
    const derived = starsFor(stages, merged);
    const old = prev?.stars ?? 0;
    const stars = derived > old ? derived : old;
    const changed = !prev || prev.stars !== stars || merged.size !== prev.stages.length;
    if (!changed) return stars;
    this.items.set(lessonId, { stages: [...merged], stars, at: new Date().toISOString() });
    this.save();
    this.emit();
    return stars;
  }

  /** Admin: Lektion komplett abhaken (alle Stufen, 3 Sterne). */
  complete(lessonId: string, stages: readonly StageRankRef[]): void {
    this.record(lessonId, stages, stages.map((s) => s.id));
  }

  /** Admin: eine Lektion (oder alle) zurücksetzen. */
  reset(lessonId?: string): void {
    if (lessonId === undefined) this.items.clear();
    else this.items.delete(lessonId);
    this.save();
    this.emit();
  }

  /** Änderungen beobachten (Menü, Freischaltungen). Rückgabe = abmelden. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    if (!this.storage) return;
    const lessons: Record<string, LessonRecord> = {};
    for (const [id, r] of this.items) lessons[id] = r;
    try {
      this.storage.setItem(TRAINING_KEY, JSON.stringify({ v: VERSION, lessons }));
    } catch {
      // Quota/Privatmodus: der Fortschritt gilt trotzdem für diese Sitzung.
    }
  }
}
