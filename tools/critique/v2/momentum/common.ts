/**
 * Gemeinsame Welten und Helfer für die Momentum-Messungen (tools/critique/v2/momentum).
 */
import { Vector3 } from 'three';
import { compileLevel, type CompiledLevel } from '../../../../src/world/level/compileLevel';
import type { BrushDef } from '../../../../src/world/level/LevelFormat';
import { box, makeLevel } from '../../../sim/levels';

export const DEG = Math.PI / 180;
export const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');

/** Median/Min/Max einer Zahlenliste. */
export function stats(xs: number[]): { min: number; med: number; max: number; mean: number } {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return { min: s[0], med: n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]), max: s[n - 1], mean: s.reduce((a, b) => a + b, 0) / n };
}

const slopeCache = new Map<string, CompiledLevel>();
/**
 * Lange Gefälle-Fläche: Oberkante y(z) = z · tanθ für z ∈ [−len, 0] (bergab Richtung −z),
 * danach flach weiter auf y = −len·tanθ. Breite ±4096.
 */
export function slopeWorld(deg: number, len = 8192): CompiledLevel {
  const key = `${deg}|${len}`;
  let c = slopeCache.get(key);
  if (!c) {
    const low = -len * Math.tan(deg * DEG);
    const brushes: BrushDef[] = [];
    if (deg > 0) brushes.push({ type: 'wedge', min: [-4096, low - 64, -len], max: [4096, 0, 0], rise: '+z', lowY: low, mat: 'floor' });
    else brushes.push(box([-4096, -64, -len], [4096, 0, 0]));
    brushes.push(box([-4096, low - 64, -len - 16384], [4096, low, -len]));
    brushes.push(box([-4096, -64, 0], [4096, 0, 16384]));
    c = compileLevel(makeLevel(brushes));
    slopeCache.set(key, c);
  }
  return c;
}

/** Höhe der Gefälle-Fläche bei z (für slopeWorld). */
export function slopeY(deg: number, z: number, len = 8192): number {
  if (z >= 0) return 0;
  if (z <= -len) return -len * Math.tan(deg * DEG);
  return z * Math.tan(deg * DEG);
}

const kickCache = new Map<string, CompiledLevel>();
/**
 * Kicker: flacher Anlauf (y = 0) für z > 0, Rampe θ steigt Richtung −z auf Höhe `h`
 * (Länge h/tanθ), endet in einer Kante; dahinter nach `gap` u tiefer (drop) eine flache Landefläche.
 */
export function kickerWorld(deg: number, h: number, drop = 128): { level: CompiledLevel; edgeZ: number; landY: number } {
  const len = h / Math.tan(deg * DEG);
  const edgeZ = -len;
  const key = `${deg}|${h}|${drop}`;
  let c = kickCache.get(key);
  if (!c) {
    c = compileLevel(makeLevel([
      box([-4096, -64, 0], [4096, 0, 16384]),
      { type: 'wedge', min: [-4096, -64, edgeZ], max: [4096, h, 0], rise: '-z', lowY: 0, mat: 'floor' },
      box([-4096, -drop - 64, edgeZ - 30000], [4096, -drop, edgeZ - 1]),
    ]));
    kickCache.set(key, c);
  }
  return { level: c, edgeZ, landY: -drop };
}

export const ORIGIN = new Vector3();
