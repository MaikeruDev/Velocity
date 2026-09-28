/**
 * Kleine, allokationsfreie Animations-Helfer der View-Hand (Plan 004/006). DOM- und three-frei.
 * Alles framerate-unabhängig: Federn exakt gelöst, Glättung per exp(−dt/τ).
 */

/** Gedämpfte Feder (ζ < 1), pro Schritt in geschlossener Form gelöst. */
export class Spring {
  x: number;
  v = 0;
  private readonly omega: number;
  private readonly zeta: number;
  private readonly wd: number;

  constructor(x0: number, omega: number, zeta: number) {
    this.x = x0;
    this.omega = omega;
    this.zeta = zeta;
    this.wd = omega * Math.sqrt(1 - zeta * zeta);
  }

  step(target: number, dt: number): void {
    const w = this.omega;
    const z = this.zeta;
    const wd = this.wd;
    const x0 = this.x - target;
    const v0 = this.v;
    const e = Math.exp(-z * w * dt);
    const c = Math.cos(wd * dt);
    const s = Math.sin(wd * dt);
    this.x = target + e * (x0 * c + ((v0 + z * w * x0) / wd) * s);
    this.v = e * (v0 * c - ((w * w * x0 + z * w * v0) / wd) * s);
  }

  reset(x: number): void {
    this.x = x;
    this.v = 0;
  }
}

export function approach(v: number, target: number, tau: number, dt: number): number {
  return target + (v - target) * Math.exp(-dt / tau);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** Smoothstep 0..1. */
export function smooth(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Ease-out mit Überschwinger (Back), 0..1 → 0..~1.1..1. */
export function backOut(t: number, s = 1.7): number {
  const x = clamp(t, 0, 1) - 1;
  return 1 + x * x * ((s + 1) * x + s);
}

/** Glocke 0 → 1 → 0 über 0..1 (sin²). */
export function bell(t: number): number {
  const s = Math.sin(Math.PI * clamp(t, 0, 1));
  return s * s;
}

/** Wurfparabel 0 → 1 → 0. */
export function arc(t: number): number {
  const x = clamp(t, 0, 1);
  return 4 * x * (1 - x);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Tempo-Stufen (u/s): 0 Stand/Gehen, 1 Laufen/Bhop-Start, 2 Flow, 3 Overdrive. */
export const TIER_SPEED = [300, 500, 800] as const;

export function speedTier(speed: number): number {
  const s = Number.isFinite(speed) ? speed : 0;
  return s >= TIER_SPEED[2] ? 3 : s >= TIER_SPEED[1] ? 2 : s >= TIER_SPEED[0] ? 1 : 0;
}
