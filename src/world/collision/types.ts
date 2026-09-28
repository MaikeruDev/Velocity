import { Box3, Vector3 } from 'three';
import type { MaterialId } from '../level/LevelFormat';

/**
 * Ebene in Hessescher Normalform: Punkte p mit dot(normal, p) = dist.
 * Das Brush-Innere liegt auf der Rückseite: dot(normal, p) < dist.
 */
export interface Plane {
  readonly normal: Vector3;
  readonly dist: number;
}

/** Sichtbare Fläche eines Brushes. Vertices gegen den Uhrzeigersinn, von außen gesehen. */
export interface BrushFace {
  readonly vertices: readonly Vector3[];
  readonly normal: Vector3;
  readonly plane: Plane;
  /** normal.y >= MIN_GROUND_NORMAL_Y — man kann darauf stehen. */
  readonly walkable: boolean;
  /** Steile, aber nicht senkrechte Fläche nach oben (0.05 < normal.y < 0.7) — Surf-Fläche. */
  readonly surf: boolean;
}

export interface CompiledBrush {
  readonly index: number;
  /** Kollisionsebenen inkl. achsparalleler Bevel-Ebenen (nur für Traces). */
  readonly planes: readonly Plane[];
  /** Sichtbare Flächen (ohne Bevels). */
  readonly faces: readonly BrushFace[];
  readonly bounds: Box3;
  readonly mat: MaterialId;
  readonly tint: string | null;
  readonly trim: boolean;
  readonly collide: boolean;
  readonly tag: string | null;
}

export interface TraceResult {
  /** 0..1 Anteil der Strecke, der frei war. 1 = nichts getroffen. */
  fraction: number;
  /** Endposition (Origin) nach dem Trace. */
  readonly endPos: Vector3;
  /** Normale der getroffenen Ebene; (0,0,0) wenn nichts getroffen. */
  readonly normal: Vector3;
  /** Start lag in einem Solid. */
  startSolid: boolean;
  /** Komplette Strecke lag im Solid. */
  allSolid: boolean;
  /** Index des getroffenen Brushes oder -1. */
  brushIndex: number;
}

export function makeTraceResult(): TraceResult {
  return {
    fraction: 1,
    endPos: new Vector3(),
    normal: new Vector3(),
    startSolid: false,
    allSolid: false,
    brushIndex: -1,
  };
}

/**
 * Kollisionswelt für achsparallele Boxen (Player-Hull), exakt wie
 * Quake/Source: die Box wird durch die Brushes "geschoben".
 * mins/maxs sind relativ zum Origin (Füße): z. B. (-16,0,-16) .. (16,72,16).
 */
export interface CollisionWorld {
  /** Box von start nach end sweepen. Schreibt in `out` (falls gegeben) und gibt es zurück. */
  traceBox(start: Vector3, end: Vector3, mins: Vector3, maxs: Vector3, out?: TraceResult): TraceResult;
  /** true, wenn die Box an `pos` ein Solid überlappt. */
  testBox(pos: Vector3, mins: Vector3, maxs: Vector3): boolean;
}

/** Abstand, den Traces zu Oberflächen halten (Quake: DIST_EPSILON = 1/32). */
export const DIST_EPSILON = 0.03125;
/** Ab dieser Normalen-Y-Komponente ist eine Fläche Boden (Source: 0.7). */
export const MIN_GROUND_NORMAL_Y = 0.7;
