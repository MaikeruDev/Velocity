import type { MovementEvent } from '../player/types';
import type { StageRank } from '../world/level/LevelFormat';
import type { Verdict } from './trainingTypes';

/**
 * Alles, worauf Audio, Kamera, HUD und Renderer reagieren. Bewegungs-
 * Ereignisse kommen aus PlayerMovement, der Rest aus dem Spielablauf (Game).
 */
export type RunEvent =
  /** Timer startet (Start-Zone verlassen). */
  | { readonly type: 'runStart' }
  /**
   * index ab 1 (in Reihenfolge), time = Laufzeit beim Erreichen.
   * split = Laufzeit − Zwischenzeit der Bestzeit an diesem Checkpoint
   * (negativ = schneller), null = keine Referenz.
   */
  | { readonly type: 'checkpoint'; readonly index: number; readonly total: number; readonly time: number; readonly split: number | null }
  | { readonly type: 'finish'; readonly time: number; readonly best: boolean; readonly previousBest: number | null }
  /** manual = Taste "zurück zum Checkpoint" (Timer läuft weiter, kein voller Tape-Stop). */
  | { readonly type: 'respawn'; readonly reason: RespawnReason }
  /** Geschwindigkeitsschwelle erstmals in diesem Luftabschnitt überschritten (500, 750, 1000, …). */
  | { readonly type: 'speedMilestone'; readonly speed: number }
  | { readonly type: 'levelLoaded'; readonly id: string; readonly name: string; readonly subtitle?: string }
  /**
   * Trainingsmodus (Plan 007, aus TrainingSessionApi.tick): Urteil über einen Hop. counted = zählt
   * für die Aufgabe der Stufe; count/goal = Stand danach (für HUD-Pips und Hand).
   */
  | {
      readonly type: 'lessonHop';
      readonly verdict: Verdict;
      readonly gain: number;
      readonly counted: boolean;
      readonly count: number;
      readonly goal: number;
    }
  /** Stufe index (ab 0) von total erledigt; lessonDone = damit sind alle Pflichtstufen erledigt. */
  | { readonly type: 'lessonStage'; readonly index: number; readonly total: number; readonly rank: StageRank; readonly lessonDone: boolean }
  /** Tor (GateDef.id) geht auf oder wieder zu (Lektion neu). */
  | { readonly type: 'gate'; readonly id: string; readonly open: boolean };

export type RespawnReason = 'fall' | 'kill' | 'restart' | 'manual';

export type GameEvent = MovementEvent | RunEvent;

export type GameEventType = GameEvent['type'];

type Listener = (e: GameEvent) => void;

/**
 * Minimaler synchroner Event-Bus. emit() läuft im Tick-Pfad: Array mit
 * Index-Schleife statt Set-Iterator (kein Objekt pro Event); on/off bauen ein
 * neues Array, damit ein Abmelden während emit() die Schleife nicht stört.
 */
export class EventBus {
  private listeners: readonly Listener[] = [];

  on(fn: Listener): () => void {
    if (!this.listeners.includes(fn)) this.listeners = [...this.listeners, fn];
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  emit(e: GameEvent): void {
    const ls = this.listeners;
    for (let i = 0; i < ls.length; i++) ls[i](e);
  }
}
