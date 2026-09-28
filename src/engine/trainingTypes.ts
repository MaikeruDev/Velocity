import type { Vector3 } from 'three';
import type { PlayerInput, PlayerSnapshot } from '../player/types';
import type { TrainingIndexEntry } from '../world/level/LevelFormat';
import type { LessonHud } from '../ui/types';
import type { GameEvent, RunEvent } from './events';

/**
 * Trainingsmodus (Plan 007): Vertrag zwischen der Lektions-Logik (engine/Training, Strang
 * training-core) und Game/HUD/Menü (Strang training-ui). Nur Typen und Konstanten — beide
 * Seiten bauen gegeneinander, ohne die Implementierung der anderen zu kennen.
 */

/**
 * Urteil des StrafeJudge über einen Luftabschnitt (Absprung → Landung, ohne Surf). 'good' = Gewinn
 * über der Schwelle, sonst die wahrscheinlichste Ursache für fehlenden Gewinn.
 */
export const VERDICTS = [
  'good',
  /** Nur W gehalten, kein A/D. */
  'wOnly',
  /** Weder A/D noch W (Maus allein strafet nicht). */
  'noSide',
  /** A/D ohne Mausdrehung. */
  'noMouse',
  /** Taste gegen die Drehrichtung der Maus. */
  'against',
  /** W zusätzlich zu A/D gehalten (ohne Strafe-Assist frisst das den Gewinn). */
  'wHeld',
  /** Maus zu schnell für das Tempo (Gewinnfenster überdreht). */
  'tooFast',
  /** A/D erst spät nach dem Absprung. */
  'late',
  /** Maus zu langsam gezogen. */
  'tooSlow',
  /** Knapp unter der Schwelle — alles richtig, nur nicht flüssig genug. */
  'weak',
] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Sterne einer Lektion: 0 = nicht bestanden, 1 = alle Pflichtstufen, 2 = + Bonus, 3 = + Meister. */
export type LessonStars = 0 | 1 | 2 | 3;

/** Respawn-Punkt einer Stufe: Füße und Blick in Grad (wie CompiledTrigger.spawnPos/spawnYaw). Nur lesen. */
export interface TrainingSpawn {
  readonly pos: Vector3;
  readonly yaw: number;
}

/** Zielband der Maus-Drehrate (°/s) am Drehbalken der Showkeys. */
export interface TurnBand {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Eine laufende Lektion (engine/Training implementiert sie in Phase 2). Game ruft sie statt
 * RunState-Timer/Bestzeit/Ghost; kein Tod, kein Timer.
 */
export interface TrainingSessionApi {
  /**
   * Pro Physik-Tick nach PlayerMovement.tick: Snapshots vor/nach dem Tick, Eingabe des Ticks und
   * aktuelle Hull-Höhe (Zonen-Test). Ereignisse ('lessonHop', 'lessonStage', 'gate') hängt die
   * Session an `out`; Game emittiert sie. Keine Allokation außer bei Ereignissen.
   */
  tick(dt: number, prev: PlayerSnapshot, cur: PlayerSnapshot, cmd: PlayerInput, hullH: number, out: RunEvent[]): void;
  /** Bewegungs- und Spiel-Ereignisse vom EventBus (Respawn setzt Kurs-/Surf-Zähler zurück usw.). */
  onEvent(e: GameEvent): void;
  /** Einmal pro Frame mit echter Framezeit: Tor-Auflösen, Tipp-Zeitgeber. */
  update(frameDt: number): void;
  /** Respawn-Punkt der aktuellen Stufe (Taste F, Fall). */
  respawnPoint(): TrainingSpawn;
  /** Admin/Pause: aktuelle Stufe als erledigt werten (öffnet ihre Tore). */
  skipStage(): void;
  /** Lektion von vorn (Fortschritt der Sitzung weg, gespeicherte Sterne bleiben). */
  restartLesson(): void;
  /** Zielband der Drehrate beim Tempo `speed` (u/s); null = kein Band (Stufe ohne Strafe-Aufgabe). */
  turnBand(speed: number): TurnBand | null;
  /** Lektionskarte fürs HUD — dasselbe Objekt in jedem Frame (HudData.lesson). */
  readonly hud: LessonHud;
  /** 0..1 je Tor in CompiledLevel.gates-Reihenfolge (1 = offen, aufgelöst) → RenderFx.gateOpen. */
  readonly gateOpen: Float32Array;
  /** true während der Vorführung (Taste H): nichts zählt, keine Tipps. */
  suspended: boolean;
  /** Alle Pflichtstufen erledigt. */
  readonly done: boolean;
  readonly stars: LessonStars;
  /** Erledigte Stufen (StageDef.id), auch Bonus/Meister — für TrainingProgress. */
  readonly completedStageIds: readonly string[];
}

/**
 * Gespeicherter Trainings-Fortschritt, lesend (engine/TrainingProgress, localStorage
 * 'velocity.training.v1'). Unlocks leitet daraus die Training-Freischaltungen ab.
 */
export interface TrainingProgressView {
  stars(lessonId: string): LessonStars;
  /** Alle Lektionen in Menü-Reihenfolge (training/index.json). */
  lessons(): readonly TrainingIndexEntry[];
}
