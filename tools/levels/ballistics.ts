/**
 * Sprung-Ballistik für Level-Bau und Validator.
 *
 * Werte kommen aus `VELOCITY_DEFAULT`, damit Level und Prüfung mitziehen,
 * wenn der Movement-Strang Gravitation/Sprungimpuls nachtunt. Die
 * Horizontalgeschwindigkeit gilt als konstant über den Flug (Strafen hält sie
 * etwa, S bremst) — das ist die Planungsannahme für alle Lücken.
 */
import { VELOCITY_DEFAULT } from '../../src/player/MovementConfig';

const cfg = VELOCITY_DEFAULT;

export const PHYS = {
  gravity: cfg.gravity,
  jumpImpulse: cfg.jumpImpulse,
  hullHalf: cfg.hull.halfWidth,
  standHeight: cfg.hull.standHeight,
  duckHeight: cfg.hull.duckHeight,
  /** Crouch-Jump: Füße wandern in der Luft um diese Höhe nach oben. */
  duckLift: cfg.hull.standHeight - cfg.hull.duckHeight,
  runSpeed: cfg.runSpeed,
  sprintSpeed: cfg.sprintSpeed,
  stepSize: cfg.stepSize,
} as const;

/** Mindestreserve jeder geplanten Lücke: Reichweite ≥ 1.1 × nötige Flugstrecke. */
export const RESERVE = 1.1;

/**
 * Überschieß-Band: so viel schneller als das Plan-Tempo soll man noch landen,
 * ohne stark zu bremsen. Plan = unteres Band (Sync 0.85) bzw. Mitte aus
 * perfektem und 0.85-Strafer; der perfekte Strafer liegt ≤ 1.2 × darüber.
 */
export const OVERSHOOT = 1.2;

/**
 * Flugzeit eines Sprungs bis zur Landung `drop` Units tiefer (negativ = höher).
 * `vy0` = vertikale Startgeschwindigkeit (Sprung = jumpImpulse, Abrollen von
 * einer Kante = 0). NaN, wenn die Höhe nicht erreichbar ist.
 */
export function airTime(drop: number, crouch = false, vy0: number = PHYS.jumpImpulse): number {
  const h = drop + (crouch ? PHYS.duckLift : 0);
  const g = PHYS.gravity;
  const disc = vy0 * vy0 + 2 * g * h;
  if (disc < 0) return Number.NaN;
  return (vy0 + Math.sqrt(disc)) / g;
}

/** Horizontale Flugstrecke bei `speed` u/s. */
export function reach(speed: number, drop: number, crouch = false, vy0?: number): number {
  return speed * airTime(drop, crouch, vy0);
}

/** Nötige Geschwindigkeit für `flight` Units Flug (mit optionaler Reserve). */
export function speedFor(flight: number, drop: number, crouch = false, reserve = 1, vy0?: number): number {
  return (flight * reserve) / airTime(drop, crouch, vy0);
}

/**
 * Zeitfenster [t0, t1] eines Sprungs, in dem die Füße mindestens `h` über dem
 * Absprung sind (bei Crouch mit Duck-Lift). Eine Kante der Höhe h wird genau
 * dann überwunden, wenn man sie in diesem Fenster erreicht. NaN, wenn nie.
 */
export function riseWindow(h: number, crouch = false): readonly [number, number] {
  const j = PHYS.jumpImpulse;
  const g = PHYS.gravity;
  const disc = j * j - 2 * g * (h - (crouch ? PHYS.duckLift : 0));
  if (disc < 0) return [Number.NaN, Number.NaN];
  return [(j - Math.sqrt(disc)) / g, (j + Math.sqrt(disc)) / g];
}

/** Maximale Sprunghöhe über dem Absprung (ohne Crouch). */
export function jumpApex(): number {
  return (PHYS.jumpImpulse * PHYS.jumpImpulse) / (2 * PHYS.gravity);
}
