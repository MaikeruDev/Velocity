/**
 * Trainingsmodus-Entwurf (v2/training): Menschen-Hände für Lektions-Validierung.
 *
 * Anders als StrafeController (Start jedes Strafes auf dem Formel-Optimum) arbeitet diese Hand
 * wie ein Mensch ohne Formel: nach dem Absprung reagiert sie mit Verzug, drückt A oder D und
 * zieht die Maus mit einer (pro Hop streuenden) konstanten Rate in dieselbe Richtung. Fehler-
 * Hops (Taste gegen die Maus, Maus steht, nur W) mit fester Wahrscheinlichkeit. Deterministisch
 * (mulberry32). Prototyp — Kandidat für src/player/bots/BeginnerHand.ts.
 */
import type { MovementConfig } from '../../../../src/player/MovementConfig';
import type { MutablePlayerInput, PlayerInput, PlayerSnapshot } from '../../../../src/player/types';
import { NO_INPUT } from '../../../../src/player/types';
import { mulberry32, wrapAngle, yawOf } from '../../../../src/player/bots/Bot';

const DEG = Math.PI / 180;

export type HopMode = 'match' | 'against' | 'noMouse' | 'wOnly' | 'nothing';

export interface HandModel {
  readonly name: string;
  /** Mittlere Mausrate in der Luft (°/s). */
  readonly rateDeg: number;
  /** Lognormal-Streuung der Rate pro Hop (σ von ln). */
  readonly rateJitter: number;
  /** Reaktionsverzug nach dem Absprung (s), Mittel und Streuung (gleichverteilt ±). */
  readonly delay: number;
  readonly delayJitter: number;
  /** Wahrscheinlichkeiten der Fehler-Hops; Rest = match. */
  readonly pAgainst: number;
  readonly pNoMouse: number;
  readonly pWOnly: number;
  /** W in der Luft zusätzlich halten (mit Strafe-Assist egal, ohne Assist teuer). */
  readonly holdW: boolean;
  /** 'zigzag' = Seite wechselt jede Landung (Kurs im Mittel gerade), 'circle' = immer dieselbe Seite, 'steer' = Seite zum Ziel. */
  readonly pattern: 'zigzag' | 'circle' | 'steer';
  /** Überhaupt strafen (false = nur W + Leertaste, der Neuling vor der Lektion). */
  readonly strafe: boolean;
  /** Blick-Richtung am Boden ausrichten (°/s) — Mensch dreht nach der Landung zum Ziel zurück. */
  readonly groundTurn: number;
}

export const HANDS: Record<string, HandModel> = {
  // Neuling vor der Lektion: W + Leertaste, Blick aufs Ziel.
  neuling: { name: 'Neuling (W+Space)', rateDeg: 0, rateJitter: 0, delay: 0, delayJitter: 0, pAgainst: 0, pNoMouse: 0, pWOnly: 0, holdW: true, pattern: 'steer', strafe: false, groundTurn: 360 },
  // Der "ordentliche Anfänger": hat die Anweisung verstanden, zieht die Maus langsam (60 °/s),
  // reagiert spät (0.2 s), jeder 5. Hop geht schief.
  anfaenger: { name: 'ordentlicher Anfänger', rateDeg: 60, rateJitter: 0.35, delay: 0.2, delayJitter: 0.1, pAgainst: 0.08, pNoMouse: 0.08, pWOnly: 0.04, holdW: true, pattern: 'zigzag', strafe: true, groundTurn: 240 },
  // Etwas geübter: 100 °/s, 0.12 s Verzug, jeder 10. Hop schief.
  geuebt: { name: 'geübter Anfänger', rateDeg: 100, rateJitter: 0.3, delay: 0.12, delayJitter: 0.06, pAgainst: 0.04, pNoMouse: 0.04, pWOnly: 0.02, holdW: false, pattern: 'zigzag', strafe: true, groundTurn: 300 },
  // Fehlerbilder (für die Diagnose: dürfen die Lektion NICHT bestehen)
  nurW: { name: 'Fehler: nur W + Maus', rateDeg: 60, rateJitter: 0.35, delay: 0.2, delayJitter: 0.1, pAgainst: 0, pNoMouse: 0, pWOnly: 1, holdW: true, pattern: 'zigzag', strafe: true, groundTurn: 240 },
  gegen: { name: 'Fehler: Taste gegen Maus', rateDeg: 60, rateJitter: 0.35, delay: 0.2, delayJitter: 0.1, pAgainst: 1, pNoMouse: 0, pWOnly: 0, holdW: true, pattern: 'zigzag', strafe: true, groundTurn: 240 },
  keineMaus: { name: 'Fehler: A/D ohne Maus', rateDeg: 60, rateJitter: 0.35, delay: 0.2, delayJitter: 0.1, pAgainst: 0, pNoMouse: 1, pWOnly: 0, holdW: true, pattern: 'zigzag', strafe: true, groundTurn: 240 },
};

export function withPattern(m: HandModel, pattern: HandModel['pattern'], extra: Partial<HandModel> = {}): HandModel {
  return { ...m, ...extra, pattern };
}

/**
 * Pro Tick Eingabe. `goal` (XZ) steuert Blick am Boden und bei 'steer' die Seite.
 * Zählt eigene Luftabschnitte mit (Modus, Rate), damit Messungen sie auswerten können.
 */
export class HumanHand {
  private readonly rand: () => number;
  private readonly out: MutablePlayerInput = { ...NO_INPUT };
  yaw = 0;
  private wasGround = true;
  /** +1 = Linkskurve (A), −1 = Rechtskurve (D). Öffentlich: Stufenwechsel setzt die Seite. */
  side = 1;
  /** zigzag: ab dieser Kursabweichung zum Ziel (rad) dreht die Hand zurück (Mensch korrigiert Drift). */
  driftLimit = (60 * Math.PI) / 180;
  private mode: HopMode = 'match';
  private rate = 0;
  private delay = 0;
  private airT = 0;
  private pressed = false;
  hops = 0;
  readonly modes: HopMode[] = [];

  constructor(
    private readonly cfg: MovementConfig,
    readonly m: HandModel,
    seed: number,
    public goal: { x: number; z: number } | null = null,
    public heading = 0,
  ) {
    this.rand = mulberry32(seed * 7919 + 17);
    this.yaw = heading;
  }

  private gauss(): number {
    const u = Math.max(this.rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  next(s: PlayerSnapshot): PlayerInput {
    const o = this.out;
    const dt = 1 / this.cfg.tickRate;
    const target = this.goal ? yawOf(this.goal.x - s.pos.x, this.goal.z - s.pos.z) : this.heading;
    o.jumpHeld = true;
    o.jumpPressed = !this.pressed;
    this.pressed = true;
    o.sprint = true;
    o.crouch = false;
    o.pitch = 0;
    if (s.onGround) {
      // Landung: neuen Hop planen (gilt ab dem Absprung).
      if (!this.wasGround) this.planHop(s, target);
      const d = wrapAngle(target - this.yaw);
      const step = this.m.groundTurn * DEG * dt;
      this.yaw += Math.abs(d) <= step ? d : Math.sign(d) * step;
      o.yaw = this.yaw;
      o.forward = 1;
      o.side = 0;
      this.airT = 0;
      this.wasGround = true;
      return o;
    }
    if (this.wasGround) {
      // Absprung: dieser Luftabschnitt bekommt den geplanten Modus.
      this.hops++;
      if (this.hops === 1) this.planHop(s, target);
      this.modes.push(this.mode);
    }
    this.wasGround = false;
    this.airT += dt;
    o.forward = this.m.holdW ? 1 : 0;
    o.side = 0;
    if (!this.m.strafe || this.mode === 'nothing') {
      o.forward = 1;
      o.yaw = this.yaw;
      return o;
    }
    if (this.airT >= this.delay) {
      const turn = this.mode === 'noMouse' ? 0 : this.side * this.rate * dt;
      this.yaw += turn;
      if (this.mode === 'wOnly') {
        o.forward = 1;
        o.side = 0;
      } else {
        const matchSide = this.side > 0 ? -1 : 1; // Linkskurve ↔ A
        o.side = this.mode === 'against' ? -matchSide : matchSide;
      }
    }
    o.yaw = this.yaw;
    return o;
  }

  private planHop(s: PlayerSnapshot, target: number): void {
    const m = this.m;
    const r = this.rand();
    this.mode = r < m.pAgainst ? 'against' : r < m.pAgainst + m.pNoMouse ? 'noMouse' : r < m.pAgainst + m.pNoMouse + m.pWOnly ? 'wOnly' : 'match';
    this.rate = m.rateDeg * DEG * Math.exp(this.gauss() * m.rateJitter);
    this.delay = Math.max(0, m.delay + (this.rand() * 2 - 1) * m.delayJitter);
    if (m.pattern === 'zigzag') {
      this.side = -this.side;
      if (this.goal) {
        const psi = Math.hypot(s.vel.x, s.vel.z) > 1 ? Math.atan2(-s.vel.x, -s.vel.z) : this.yaw;
        const err = wrapAngle(psi - target);
        if (Math.abs(err) > this.driftLimit) this.side = err > 0 ? -1 : 1;
      }
    } else if (m.pattern === 'steer') {
      // Zur Zielseite drehen: Flugrichtung links vom Ziel → rechts drehen.
      const psi = Math.hypot(s.vel.x, s.vel.z) > 1 ? Math.atan2(-s.vel.x, -s.vel.z) : this.yaw;
      const err = wrapAngle(psi - target);
      this.side = err > 0 ? -1 : 1;
    }
  }
}
