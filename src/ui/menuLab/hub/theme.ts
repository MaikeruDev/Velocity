// Stil 'hub' — Farben. Reine Daten, kein DOM (der Vitest-Test lädt das Modul in Node).
import type { MedalId } from '../types';

export type Rgb = readonly [number, number, number];

export function hex(h: string): Rgb {
  const v = parseInt(h.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function mul(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k];
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Himmel/Trim je Level — gespiegelt aus public/levels/*.json (environment). Die Front Door bekommt nur ids,
 * keine Level-Daten; ein fetch der JSONs nur für Farben wäre Kopplung ans Dateilayout. Unbekannte ids
 * (neue Level) nehmen reihum eine Palette — sieht dann nur nicht "echt" aus.
 */
export interface LevelTheme {
  readonly skyTop: Rgb;
  readonly skyHorizon: Rgb;
  readonly skyBottom: Rgb;
  readonly sun: Rgb;
  readonly moon: boolean;
  readonly trim: Rgb;
  readonly trimAlt: Rgb;
}

const THEMES: Readonly<Record<string, LevelTheme>> = {
  level1: { skyTop: hex('#1b0736'), skyHorizon: hex('#ff7a45'), skyBottom: hex('#2b0b3f'), sun: hex('#ffb27a'), moon: false, trim: hex('#33f0ff'), trimAlt: hex('#ff4fd8') },
  level2: { skyTop: hex('#1d1650'), skyHorizon: hex('#3a1f8a'), skyBottom: hex('#0a0c20'), sun: hex('#bce2ff'), moon: false, trim: hex('#9dff2e'), trimAlt: hex('#2ef0ff') },
  level3: { skyTop: hex('#03141c'), skyHorizon: hex('#0f5a66'), skyBottom: hex('#010608'), sun: hex('#d6fff5'), moon: true, trim: hex('#ff7a45'), trimAlt: hex('#ffd166') },
  level4: { skyTop: hex('#050814'), skyHorizon: hex('#2a4a7a'), skyBottom: hex('#1a0f1f'), sun: hex('#cfe0ff'), moon: true, trim: hex('#ff3848'), trimAlt: hex('#8fe3ff') },
};
const FALLBACK = ['level1', 'level2', 'level3', 'level4'];

export function levelTheme(id: string, index: number): LevelTheme {
  return THEMES[id] ?? THEMES[FALLBACK[index % FALLBACK.length]];
}

export function cssRgb(c: Rgb): string {
  const b = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return `rgb(${b(c[0])}, ${b(c[1])}, ${b(c[2])})`;
}

export const MEDAL_RGB: Readonly<Record<MedalId, Rgb>> = {
  velocity: hex('#33f0ff'),
  gold: hex('#ffd84a'),
  silver: hex('#cfd6e6'),
  bronze: hex('#e0915a'),
};

/** Hub-Palette: Dämmerung wie L1 (Lila/Orange), Flächen dunkles Navy, Trims Cyan/Magenta. */
export const PAL = {
  skyTop: hex('#12052a'),
  skyHorizon: hex('#ff6a4a'),
  skyMid: hex('#6a1f6e'),
  skyBottom: hex('#1a0828'),
  fog: hex('#5a1f5e'),
  sunTop: hex('#fff07a'),
  sunBottom: hex('#ff3f8a'),
  ambSky: hex('#7a62d6'),
  ambGround: hex('#3a1440'),
  sunCol: hex('#ffb07a'),
  floor: hex('#1c1f4a'),
  floorLine: hex('#33f0ff'),
  wall: hex('#2a2458'),
  dark: hex('#14102e'),
  metal: hex('#55588c'),
  steel: hex('#8a8fc0'),
  cyan: hex('#33f0ff'),
  magenta: hex('#ff3fd0'),
  gold: hex('#ffd84a'),
  green: hex('#46ff9e'),
  red: hex('#ff4d6d'),
  white: hex('#f1edff'),
  orange: hex('#ff8a3d'),
  city: hex('#1a1238'),
  window: hex('#ffb0e8'),
} as const;
