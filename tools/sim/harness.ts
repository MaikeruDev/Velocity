import { Vector3 } from 'three';
import { compileLevel, type CompiledLevel } from '../../src/world/level/compileLevel';
import type { LevelFile } from '../../src/world/level/LevelFormat';
import type { MovementConfig } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import type { MovementEvent, MutablePlayerInput, PlayerInput } from '../../src/player/types';
import { NO_INPUT } from '../../src/player/types';

export function makeInput(patch: Partial<PlayerInput> = {}): MutablePlayerInput {
  return { ...NO_INPUT, ...patch };
}

export interface SimPlayer {
  readonly level: CompiledLevel;
  readonly pm: PlayerMovement;
}

/** Spieler im Level an `pos` (oder Spawn) absetzen. */
export function spawnPlayer(level: LevelFile | CompiledLevel, cfg: MovementConfig, pos?: Vector3): SimPlayer {
  const compiled = 'world' in level ? level : compileLevel(level);
  const pm = new PlayerMovement(compiled.world, cfg);
  pm.teleport(pos ?? compiled.spawnPos);
  return { level: compiled, pm };
}

/** Ein Tick mit Event-Kopie (die Movement-Events sind wiederverwendete Objekte). */
export function tickCollect(pm: PlayerMovement, input: PlayerInput, out: MovementEvent[]): readonly MovementEvent[] {
  const ev = pm.tick(input);
  for (const e of ev) out.push({ ...e });
  return ev;
}

/** Yaw (three-Konvention, 0 = -Z) in Richtung (dx, dz). */
export function yawTo(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

export { mulberry32 as rng } from '../../src/player/bots/Bot';
