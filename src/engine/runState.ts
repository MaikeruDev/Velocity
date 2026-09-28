import type { Box3, Vector3 } from 'three';
import type { CompiledLevel, CompiledTrigger } from '../world/level/compileLevel';
import type { RunEvent } from './events';

/**
 * Lauf-Logik eines Levels, DOM-frei (Vitest): Start-Zone, Timer, Checkpoints
 * in Reihenfolge, Ziel, Kill-Zonen und Speed-Meilensteine. Game ruft tick()
 * nach jedem movement.tick() auf und setzt Teleport, Fade und Bestzeiten um.
 *
 * Timer tickgenau: im Tick, in dem die Hull die Start-Zone verlässt, steht er
 * auf 0, danach +dt pro Tick (1/128 ist binär exakt, es summiert sich kein Fehler).
 */

/** Geschwindigkeiten (u/s), deren erstes Überschreiten pro Luftabschnitt gemeldet wird. */
export const SPEED_MILESTONES: readonly number[] = [500, 750, 1000, 1250, 1500];

/** Ergebnis eines Ticks für Game: was außer den Events zu tun ist. */
export type RunOutcome = 'none' | 'finish' | 'fall' | 'kill';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type CheckpointEvent = Mutable<Extract<RunEvent, { type: 'checkpoint' }>>;
type MilestoneEvent = Mutable<Extract<RunEvent, { type: 'speedMilestone' }>>;

const RUN_START: RunEvent = Object.freeze({ type: 'runStart' });

/** Ohne Start-Zone startet der Timer, sobald sich der Spieler bewegt. */
const NO_ZONE_START_SPEED = 1;

/** Kleiner Ring, damit ein Listener, der ein Event kurz behält, nicht sofort überschrieben wird. */
const RING = 4;

export class RunState {
  readonly level: CompiledLevel;
  private readonly starts: readonly CompiledTrigger[];
  private readonly checkpoints: readonly CompiledTrigger[];
  private readonly finishes: readonly CompiledTrigger[];
  private readonly kills: readonly CompiledTrigger[];

  private started = false;
  private isFinished = false;
  private runTime = 0;
  private cpReached = 0;
  private readonly splitTimes: Float64Array;
  private bestSplits: readonly number[] | null = null;
  private top = 0;
  /** Höchster Meilenstein-Index (Anzahl überschrittener Schwellen) im aktuellen Luftabschnitt. */
  private airLevel = 0;

  private readonly cpEvents: CheckpointEvent[];
  private readonly msEvents: MilestoneEvent[];
  private cpRing = 0;
  private msRing = 0;

  constructor(level: CompiledLevel) {
    this.level = level;
    const byKind = (k: CompiledTrigger['kind']): CompiledTrigger[] => level.triggers.filter((t) => t.kind === k);
    this.starts = byKind('start');
    // compileLevel sortiert bereits nach order — hier nochmals, damit die Reihenfolge nicht an einem Detail dort hängt.
    this.checkpoints = byKind('checkpoint').sort((a, b) => a.order - b.order);
    this.finishes = byKind('finish');
    this.kills = byKind('kill');
    this.splitTimes = new Float64Array(Math.max(1, this.checkpoints.length));
    const total = this.checkpoints.length;
    this.cpEvents = Array.from({ length: RING }, () => ({ type: 'checkpoint', index: 0, total, time: 0, split: null }));
    this.msEvents = Array.from({ length: RING }, () => ({ type: 'speedMilestone', speed: 0 }));
  }

  /** Anzahl der Checkpoints im Level. */
  get total(): number {
    return this.checkpoints.length;
  }

  /** Zuletzt erreichter Checkpoint (0 = keiner). */
  get checkpoint(): number {
    return this.cpReached;
  }

  /** Timer läuft (Start-Zone verlassen, Ziel noch nicht erreicht). */
  get running(): boolean {
    return this.started && !this.isFinished;
  }

  get finished(): boolean {
    return this.isFinished;
  }

  /** Laufzeit in s; null, solange der Timer nicht gestartet ist. */
  get time(): number | null {
    return this.started ? this.runTime : null;
  }

  /** Höchster Horizontal-Speed seit dem Start des Timers. */
  get topSpeed(): number {
    return this.top;
  }

  /** Kumulierte Zwischenzeiten dieses Laufs (Kopie — nicht im Tick-Pfad aufrufen). */
  splits(): number[] {
    return Array.from(this.splitTimes.subarray(0, this.cpReached));
  }

  /** Respawn-Punkt: Spawn des letzten erreichten Checkpoints, sonst Level-Spawn. yaw in Grad. */
  respawnPoint(): { readonly pos: Vector3; readonly yaw: number } {
    if (this.cpReached > 0) {
      const cp = this.checkpoints[this.cpReached - 1];
      return { pos: cp.spawnPos, yaw: cp.spawnYaw };
    }
    return { pos: this.level.spawnPos, yaw: this.level.spawnYaw };
  }

  /** Neuer Lauf (Levelstart, R). bestSplits = Zwischenzeiten der Bestzeit für die Split-Anzeige. */
  reset(bestSplits: readonly number[] | null): void {
    this.bestSplits = bestSplits;
    this.started = false;
    this.isFinished = false;
    this.runTime = 0;
    this.cpReached = 0;
    this.top = 0;
    this.airLevel = 0;
  }

  /**
   * Ein Physik-Tick. `pos` sind die Füße, mins/maxs die aktuelle Hull relativ
   * dazu. Events landen in `out` (vorher geleert); Rückgabe sagt Game, ob ein
   * Respawn oder das Ziel ansteht.
   */
  tick(dt: number, pos: Vector3, mins: Vector3, maxs: Vector3, speed: number, onGround: boolean, out: RunEvent[]): RunOutcome {
    out.length = 0;
    this.milestones(speed, onGround, out);
    if (this.isFinished) return this.hazard(pos, mins, maxs);

    // --- Start-Zone / Timer
    if (this.started) this.runTime += dt;
    if (this.starts.length > 0) {
      const inStart = this.inAny(this.starts, pos, mins, maxs);
      if (!this.started && !inStart) this.startTimer(out);
      // Zurück in die Start-Zone vor dem ersten Checkpoint = Fehlstart: Timer aus (KZ-Konvention).
      else if (this.started && inStart && this.cpReached === 0) {
        this.started = false;
        this.top = 0;
      }
    } else if (!this.started && (speed > NO_ZONE_START_SPEED || !onGround)) {
      this.startTimer(out);
    }
    if (this.started && speed > this.top) this.top = speed;

    // --- Checkpoints (nur der nächste in Reihenfolge) und Ziel (erst nach allen)
    if (this.started) {
      const next = this.checkpoints[this.cpReached];
      if (next !== undefined && overlaps(next.bounds, pos, mins, maxs)) this.reachCheckpoint(out);
      if (this.cpReached === this.checkpoints.length && this.inAny(this.finishes, pos, mins, maxs)) {
        this.isFinished = true;
        return 'finish';
      }
    }
    return this.hazard(pos, mins, maxs);
  }

  // ------------------------------------------------------------------ intern

  private startTimer(out: RunEvent[]): void {
    this.started = true;
    this.runTime = 0;
    out.push(RUN_START);
  }

  private reachCheckpoint(out: RunEvent[]): void {
    const i = this.cpReached;
    this.splitTimes[i] = this.runTime;
    this.cpReached = i + 1;
    const ref = this.bestSplits !== null && i < this.bestSplits.length ? this.bestSplits[i] : null;
    const e = this.cpEvents[this.cpRing];
    this.cpRing = (this.cpRing + 1) % RING;
    e.index = i + 1;
    e.total = this.checkpoints.length;
    e.time = this.runTime;
    e.split = ref !== null && Number.isFinite(ref) ? this.runTime - ref : null;
    out.push(e);
  }

  private hazard(pos: Vector3, mins: Vector3, maxs: Vector3): RunOutcome {
    if (this.inAny(this.kills, pos, mins, maxs)) return 'kill';
    if (pos.y < this.level.def.killY) return 'fall';
    return 'none';
  }

  /**
   * Meilenstein = Schwelle erstmals in diesem Luftabschnitt überschritten. Am
   * Boden wird nur die Basis nachgeführt — wer schon mit 520 abspringt, hat
   * die 500 in diesem Abschnitt nicht überschritten.
   */
  private milestones(speed: number, onGround: boolean, out: RunEvent[]): void {
    let level = 0;
    while (level < SPEED_MILESTONES.length && speed >= SPEED_MILESTONES[level]) level++;
    if (onGround) {
      this.airLevel = level;
      return;
    }
    if (level <= this.airLevel) return;
    this.airLevel = level;
    const e = this.msEvents[this.msRing];
    this.msRing = (this.msRing + 1) % RING;
    e.speed = SPEED_MILESTONES[level - 1];
    out.push(e);
  }

  private inAny(list: readonly CompiledTrigger[], pos: Vector3, mins: Vector3, maxs: Vector3): boolean {
    // Index-Schleife: Tick-Pfad, kein Iterator-Objekt.
    for (let i = 0; i < list.length; i++) if (overlaps(list[i].bounds, pos, mins, maxs)) return true;
    return false;
  }
}

/** Hull-AABB (pos + mins/maxs) schneidet die Trigger-Box — echte Überlappung, Berührung zählt nicht. */
export function overlaps(b: Box3, pos: Vector3, mins: Vector3, maxs: Vector3): boolean {
  return (
    pos.x + mins.x < b.max.x &&
    pos.x + maxs.x > b.min.x &&
    pos.y + mins.y < b.max.y &&
    pos.y + maxs.y > b.min.y &&
    pos.z + mins.z < b.max.z &&
    pos.z + maxs.z > b.min.z
  );
}
