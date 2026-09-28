import { Vector3 } from 'three';

/**
 * Farben laufen bewusst NICHT durch three.js' ColorManagement: die ganze
 * Pipeline rechnet in Anzeige-(sRGB-)Werten, wie die PS2 ohne Gamma-Korrektur.
 * Deshalb eigenes Hex-Parsing statt `new Color(hex)` (das linearisiert).
 */
export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = Number.parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [1, 0, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function setVecFromHex(v: Vector3, hex: string): Vector3 {
  const [r, g, b] = hexToRgb(hex);
  return v.set(r, g, b);
}

/** Deterministischer PRNG (mulberry32) — gleiche Texturen/Silhouetten bei jedem Laden. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Positionsabhängiges Rauschen 0..1 für gebackene Vertex-Variation (stabil über Brush-Grenzen). */
export function hash3(x: number, y: number, z: number): number {
  const xi = Math.round(x * 4) | 0;
  const yi = Math.round(y * 4) | 0;
  const zi = Math.round(z * 4) | 0;
  let h = Math.imul(xi, 374761393) ^ Math.imul(yi, 668265263) ^ Math.imul(zi, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
