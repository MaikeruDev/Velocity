import { Vector3 } from 'three';
import type { MovementConfig } from '../../player/MovementConfig';
import { PlayerMovement } from '../../player/PlayerMovement';
import type { PlayerInput } from '../../player/types';
import type { CollisionWorld, TraceResult } from '../../world/collision/types';
import { makeTraceResult } from '../../world/collision/types';
import type { CompiledLevel } from '../../world/level/compileLevel';
import type { RunEvent } from '../events';
import type { RunOutcome } from '../runState';
import { RunState } from '../runState';

/**
 * Lauf-Simulation eines normalen Levels ohne Spiel drumherum (Plan 009): genau die Tick-Semantik von
 * Game.onTick/runTick/respawn/placeAt für Levels ohne Lektion — Verifier, Ghost aus Replay und
 * Bot-Läufe der Mock-Bestenliste benutzen sie. DOM-frei.
 *
 * Game teilt sich mit ihr `placeFeet` (Spawn absetzen); der Rest ist bewusst eine Kopie der wenigen
 * Zeilen aus Game.runTick — der Playwright-Check (tools/replay/online-check.mjs) und der Verifier-
 * Test fahren beide Wege gegeneinander (im Browser aufgenommen, in Node nachgespielt).
 */

/** Spawn-Anhebung (u): Füße auf der Fläche gelten als Solid (fallen.md #14). Wie Game.SPAWN_LIFT. */
export const SPAWN_LIFT = 1;

/**
 * Füße an `pos` absetzen wie Game.placeAt: 1 u anheben, per Trace bis 1 u unter den Punkt absetzen.
 * Schreibt in `out` und gibt es zurück. world null = nur anheben (kein Level geladen).
 */
export function placeFeet(world: CollisionWorld | null, pos: Vector3, standMins: Vector3, standMaxs: Vector3, tr: TraceResult, out: Vector3, scratch: Vector3): Vector3 {
  out.set(pos.x, pos.y + SPAWN_LIFT, pos.z);
  if (world) {
    scratch.set(pos.x, pos.y - SPAWN_LIFT, pos.z);
    const r = world.traceBox(out, scratch, standMins, standMaxs, tr);
    if (!r.startSolid && !r.allSolid) out.copy(r.endPos);
  }
  return out;
}

export class RunSimulator {
  readonly level: CompiledLevel;
  readonly cfg: MovementConfig;
  readonly movement: PlayerMovement;
  readonly run: RunState;
  /** Run-Events des letzten Ticks (runStart, checkpoint, speedMilestone) — wiederverwendet. */
  readonly runEvents: RunEvent[] = [];
  /** Respawns durch Absturz/Kill im letzten Tick (0/1). */
  respawned = false;
  private readonly dt: number;
  private readonly standMins = new Vector3();
  private readonly standMaxs = new Vector3();
  private readonly tr = makeTraceResult();
  private readonly a = new Vector3();
  private readonly b = new Vector3();

  constructor(level: CompiledLevel, cfg: MovementConfig) {
    this.level = level;
    this.cfg = cfg;
    this.dt = 1 / cfg.tickRate;
    this.movement = new PlayerMovement(level.world, cfg);
    this.run = new RunState(level);
    const h = cfg.hull;
    this.standMins.set(-h.halfWidth, 0, -h.halfWidth);
    this.standMaxs.set(h.halfWidth, h.standHeight, h.halfWidth);
  }

  /** Neuer Lauf am Level-Spawn (Levelstart, R, Tod vor CP 1). */
  start(): void {
    this.run.reset(null);
    this.place(this.level.spawnPos);
  }

  /** Taste F (Game.respawn('manual') ohne Lektion). Vor CP 1 = neuer Versuch. */
  manualRespawn(): void {
    if (this.run.checkpoint === 0) this.run.reset(null);
    this.place(this.run.respawnPoint().pos);
  }

  /** Ein Tick wie Game.onTick → runTick (ohne Lektion, vor dem Ziel). */
  step(cmd: PlayerInput): RunOutcome {
    const m = this.movement;
    m.tick(cmd);
    const s = m.state;
    const out = this.run.tick(this.dt, s.pos, m.hullMins, m.hullMaxs, s.speed, s.onGround, this.runEvents);
    this.respawned = false;
    if (out === 'fall' || out === 'kill') {
      // Game.respawn: vor dem ersten Checkpoint zurück an den Start (Timer aus), sonst an den letzten CP.
      if (this.run.checkpoint === 0) this.run.reset(null);
      this.place(this.run.respawnPoint().pos);
      this.respawned = true;
    }
    return out;
  }

  private place(pos: Vector3): void {
    this.movement.teleport(placeFeet(this.level.world, pos, this.standMins, this.standMaxs, this.tr, this.a, this.b));
  }
}
