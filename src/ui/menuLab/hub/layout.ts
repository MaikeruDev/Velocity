// Stil 'hub' — Stationen im Raum. Reine Daten/Mathe, kein DOM.
import type { FrontDoorContext, FrontDoorLevel } from '../types';
import { levelTheme, PAL } from './theme';
import type { Rgb } from './theme';

export type StationKind = 'profile' | 'locker' | 'training' | 'portal' | 'trophy' | 'setup' | 'lab';

export interface Station {
  readonly kind: StationKind;
  /** Level-Index für Portale, sonst -1. */
  readonly level: number;
  /** Winkel um die Hub-Mitte (rad), 0 = geradeaus (−z), positiv = rechts. */
  readonly angle: number;
  /** Abstand der Station von der Mitte. */
  readonly radius: number;
  /** Kamera-Abstand vor der Station (größer = mehr Umgebung im Bild). */
  readonly view: number;
  /** Blickhöhe auf die Station (Mitte des Motivs). */
  readonly lookY: number;
  /** Höhe des schwebenden Namensschilds über dem Boden (DOM-Tag). */
  readonly tagY: number;
}

/** Ring der Stationen. Portale stehen enger (eine Reihe), die übrigen Stationen in weiterem Abstand. */
export const RING_R = 10;
const PORTAL_STEP = (19 * Math.PI) / 180;
const SIDE_STEP = (31 * Math.PI) / 180;
const SIDE_GAP = (36 * Math.PI) / 180;

/**
 * Reihenfolge links → rechts: Ausweis, Spind, Training | Portale | Trophäen, Werkbank, Labor-Tür.
 * Training steht direkt neben dem ersten Portal — der Neuling sieht es vom Start aus.
 */
export function buildStations(levels: readonly FrontDoorLevel[]): Station[] {
  const n = Math.max(1, levels.length);
  const half = ((n - 1) * PORTAL_STEP) / 2;
  const out: Station[] = [];
  const side = (kind: StationKind, angle: number, lookY: number, tagY: number, view = 6.6): Station => ({
    kind,
    level: -1,
    angle,
    radius: RING_R,
    view,
    lookY,
    tagY,
  });
  const left0 = -half - SIDE_GAP;
  out.push(side('profile', left0 - 2 * SIDE_STEP, 1.5, 3.3));
  out.push(side('locker', left0 - SIDE_STEP, 1.55, 3.55));
  out.push(side('training', left0, 1.35, 3.35, 7.0));
  for (let i = 0; i < levels.length; i++) {
    out.push({ kind: 'portal', level: i, angle: -half + i * PORTAL_STEP, radius: RING_R, view: 7.4, lookY: 2.05, tagY: 4.35 });
  }
  const right0 = half + SIDE_GAP;
  out.push(side('trophy', right0, 1.75, 3.75, 6.8));
  out.push(side('setup', right0 + SIDE_STEP, 1.35, 3.1));
  out.push(side('lab', right0 + 2 * SIDE_STEP, 1.5, 3.4));
  return out;
}

export function portalStation(stations: readonly Station[], level: number): number {
  for (let i = 0; i < stations.length; i++) if (stations[i].kind === 'portal' && stations[i].level === level) return i;
  for (let i = 0; i < stations.length; i++) if (stations[i].kind === 'portal') return i;
  return 0;
}

export function stationOfKind(stations: readonly Station[], kind: StationKind): number {
  for (let i = 0; i < stations.length; i++) if (stations[i].kind === kind) return i;
  return 0;
}

/** Weltposition eines Punkts im Stations-Raum (x rechts aus Kamerasicht, z zur Hub-Mitte). */
export function localToWorld(st: Station, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const s = Math.sin(st.angle);
  const c = Math.cos(st.angle);
  const px = s * st.radius;
  const pz = -c * st.radius;
  out.x = px + c * x - s * z;
  out.y = y;
  out.z = pz + s * x + c * z;
}

/** Leitfarbe der Station (Schild, Karte, Licht). */
export function stationColor(st: Station, ctx: FrontDoorContext): Rgb {
  switch (st.kind) {
    case 'portal': {
      const lv = ctx.levels[st.level];
      return levelTheme(lv ? lv.id : '', st.level).trim;
    }
    case 'training':
      return PAL.green;
    case 'locker':
      return PAL.magenta;
    case 'profile':
      return ctx.account.dev ? PAL.gold : PAL.magenta;
    case 'trophy':
      return PAL.gold;
    case 'setup':
      return PAL.cyan;
    case 'lab':
      return PAL.red;
  }
}

export const EASE = {
  inOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  },
  outCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  },
  inOutSine(t: number): number {
    return -(Math.cos(Math.PI * t) - 1) / 2;
  },
};
