import { readFileSync } from 'node:fs';
import type { BrushDef, LevelFile, TriggerDef, Vec3Tuple } from '../../src/world/level/LevelFormat';

/** Neutrale Umgebung für synthetische Test-/Sim-Level (Optik egal). */
export const SIM_ENV: LevelFile['environment'] = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0], sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -2000,
};

export function makeLevel(
  brushes: BrushDef[],
  opts: { spawn?: Vec3Tuple; yaw?: number; killY?: number; triggers?: TriggerDef[]; id?: string } = {},
): LevelFile {
  return {
    version: 1,
    id: opts.id ?? 'sim',
    name: opts.id ?? 'sim',
    spawn: { pos: opts.spawn ?? [0, 0, 0], yaw: opts.yaw ?? 0 },
    killY: opts.killY ?? -2000,
    environment: SIM_ENV,
    brushes,
    triggers: opts.triggers ?? [],
  };
}

export function box(min: Vec3Tuple, max: Vec3Tuple, tag?: string): BrushDef {
  return { type: 'box', min, max, mat: 'floor', ...(tag ? { tag } : {}) };
}

/** Große ebene Fläche, Oberkante y = 0. */
export function flatLevel(half = 16384): LevelFile {
  return makeLevel([box([-half, -64, -half], [half, 0, half], 'floor')]);
}

/** Level-JSON von der Platte (kein JSON-Import: der hängt unter tsx, siehe learnings). */
export function readLevelFile(path: string): LevelFile {
  return JSON.parse(readFileSync(path, 'utf8')) as LevelFile;
}
