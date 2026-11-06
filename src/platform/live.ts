/**
 * Live-Ereignisse für Achievements (Plan 011 Schritt 4.3): Game meldet hierüber NUR echte Ziele, live geschaffte
 * Lektionsstufen und angenommene Online-Läufe. Eigene kleine Datei, damit Game (Haupt-Bundle) nur diese Typen und
 * `isCleanFinish` zieht — die Achievement-Tabellen (achievements.ts) laden am Desktop als eigener Chunk.
 */
import type { MedalSource } from '../engine/Unlocks';
import type { StageRankRef } from '../engine/TrainingProgress';
import type { TrainingIndexEntry } from '../world/level/LevelFormat';

/** Ein Ziel in einem normalen Level. `clean` = Aufnahme gültig und ohne Bot/Override (isCleanFinish). */
export interface LiveFinish {
  readonly kind: 'finish';
  readonly levelId: string;
  /** Laufzeit (s, RunState-Uhr) — DIESES Laufs, nicht die gespeicherte Bestzeit. */
  readonly time: number;
  readonly clean: boolean;
  /** Levelliste mit Medaillen (index.json); nur gelesen. */
  readonly levels: readonly MedalSource[];
  /** Lektionsliste (training/index.json); nur gelesen — Freischaltungen aus dem Training. */
  readonly lessons: readonly TrainingIndexEntry[];
}

/** Stufen einer Lektion, die DIESE Sitzung live geschafft hat (übersprungene zählen nie). */
export interface LiveLesson {
  readonly kind: 'lesson';
  readonly lessonId: string;
  readonly stages: readonly StageRankRef[];
  /** Erledigte Stufen-IDs der Sitzung (Live-Array der Session — nur lesen, nicht festhalten). */
  readonly completed: readonly string[];
  /** false = Bot, Eingabe-Override, Vorführung als Spieler oder Debug-Eingriff in dieser Sitzung. */
  readonly clean: boolean;
  readonly levels: readonly MedalSource[];
  readonly lessons: readonly TrainingIndexEntry[];
}

/** Ein Lauf wurde vom Server geprüft und angenommen. */
export interface LiveSubmit {
  readonly kind: 'submit';
  /** OnlineService.backend — nur 'supabase' ist eine echte Online-Prüfung (der Mock prüft lokal). */
  readonly backend: string;
}

export type LiveProgress = LiveFinish | LiveLesson | LiveSubmit;

/**
 * Zählt ein Ziel für Achievements? Dieselbe Regel wie die Bestenliste: es gibt eine Aufnahme, sie ist gültig
 * (`ReplayRecorder.invalid` null — kein F1-Tuning, keine Config im Lauf geändert, kein Debug-Teleport) und kein
 * Tick kam von Bot/Override (`header.assisted`). Gespeicherte Bestzeit und Freischaltungen spielen keine Rolle.
 */
export function isCleanFinish(replay: { readonly header: { readonly assisted: boolean } } | null, invalid: string | null): boolean {
  return replay !== null && invalid === null && !replay.header.assisted;
}
