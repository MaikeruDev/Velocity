import type { MutablePlayerInput, PlayerInput, PlayerSnapshot } from '../types';
import { NO_INPUT } from '../types';

/**
 * Ein Bot erzeugt pro Physik-Tick die Eingabe aus dem aktuellen Zustand —
 * genau wie die Engine es für den Spieler tut. Das zurückgegebene Objekt
 * wird wiederverwendet (vor dem nächsten next() konsumieren).
 */
export interface Bot {
  next(state: PlayerSnapshot): PlayerInput;
}

export interface Point2 {
  readonly x: number;
  readonly z: number;
}

export function makeBotInput(): MutablePlayerInput {
  return { ...NO_INPUT };
}

/** Yaw (three-Konvention: 0 = Blick nach -Z, positiv = links) für Richtung (dx, dz). */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Winkel auf (-π, π]. */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  else if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Von `from` höchstens `maxStep` rad Richtung `to` drehen (kürzester Weg). */
export function turnToward(from: number, to: number, maxStep: number): number {
  const d = wrapAngle(to - from);
  if (!(maxStep < Infinity) || Math.abs(d) <= maxStep) return from + d;
  return from + Math.sign(d) * maxStep;
}

/** Deterministischer PRNG (mulberry32) — Bots und Sims sollen reproduzierbar sein. */
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

/** Standardnormalverteilt (Box-Muller). */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
