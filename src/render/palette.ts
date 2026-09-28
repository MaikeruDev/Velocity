import type { MaterialId, TriggerKind } from '../world/level/LevelFormat';

/**
 * Feste Signalfarben der Route. Start/Checkpoint/Ziel haben eigene Töne, damit
 * man sie aus dem Augenwinkel von normalen Plattformen (trimColor) unterscheidet.
 */
export const KIND_COLORS: Record<Exclude<TriggerKind, 'kill'>, string> = {
  start: '#46ff9e',
  checkpoint: '#ffc23d',
  finish: '#fff27a',
};

/** Vertex-Farbe, wenn der Brush keinen tint hat. Texturen tragen sonst die Farbe selbst. */
export function defaultTint(mat: MaterialId): string {
  return mat === 'accent' ? '#ff5fa8' : '#ffffff';
}

/** Trim-Farbe nach Material (Start/Checkpoint/Ziel-Plattformen) — sonst null = Level-trimColor. */
export function materialTrimColor(mat: MaterialId): string | null {
  if (mat === 'start' || mat === 'checkpoint' || mat === 'finish') return KIND_COLORS[mat];
  return null;
}
