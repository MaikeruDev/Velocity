import type { MovementConfig } from '../MovementConfig';
import type { PlayerInput, PlayerSnapshot } from '../types';
import type { Bot, Point2 } from './Bot';
import { makeBotInput, yawOf } from './Bot';
import { StrafeController, type StrafeControllerOptions } from './StrafeController';

export interface StrafeBotOptions extends StrafeControllerOptions {
  /** 'steer' (Default): Kurve zum Ziel/Kurs mit Hysterese. 'zigzag': Strafe-Richtung wechselt pro Hop. */
  readonly mode?: 'steer' | 'zigzag';
  /** Zielpunkt (XZ). Hat Vorrang vor `heading`. */
  readonly target?: Point2 | null;
  /** Zielkurs als Yaw (rad), falls kein Zielpunkt. Default 0 (= -Z). */
  readonly heading?: number;
  /** In der Luft geduckt (Crouch-Hops). */
  readonly crouchInAir?: boolean;
}

/**
 * Perfekter (sync 1) bzw. menschlich unsauberer Bhopper: am Boden springt er
 * sofort (Sprung gehalten), in der Luft reines A/D mit optimalem Winkel.
 * Die Luft-Eingabe wird schon im Landetick gesetzt, weil der Sprung dort vor
 * der Bewegung passiert — so geht kein Tick verloren.
 */
export class StrafeBot implements Bot {
  private readonly ctl: StrafeController;
  private readonly out = makeBotInput();
  private readonly mode: 'steer' | 'zigzag';
  private target: Point2 | null;
  private heading: number;
  private readonly crouchInAir: boolean;
  private wasOnGround = true;

  constructor(config: MovementConfig, opts: StrafeBotOptions = {}) {
    this.ctl = new StrafeController(config, opts);
    this.mode = opts.mode ?? 'steer';
    this.target = opts.target ?? null;
    this.heading = opts.heading ?? 0;
    this.crouchInAir = opts.crouchInAir ?? false;
    this.ctl.yaw = this.heading;
  }

  setConfig(config: MovementConfig): void {
    this.ctl.setConfig(config);
  }

  setTarget(target: Point2 | null): void {
    this.target = target;
  }

  setHeading(yaw: number): void {
    this.heading = yaw;
    this.target = null;
  }

  /** Aktueller Blick-Yaw des Bots. */
  get yaw(): number {
    return this.ctl.yaw;
  }

  next(state: PlayerSnapshot): PlayerInput {
    const out = this.out;
    const heading = this.target ? yawOf(this.target.x - state.pos.x, this.target.z - state.pos.z) : this.heading;
    if (state.onGround && this.mode === 'zigzag' && !this.wasOnGround) this.ctl.flip();
    // Jeder Absprung beginnt einen neuen Strafe (Konstant-Dreher setzen neu an).
    if (state.onGround) this.ctl.resync();
    this.wasOnGround = state.onGround;
    this.ctl.air(state, this.mode === 'zigzag' ? null : heading, out);
    out.jumpHeld = true;
    // Flanke bei jeder Bodenberührung — damit hüpft er auch ohne autoHop (CS-Preset).
    out.jumpPressed = state.onGround;
    out.crouch = this.crouchInAir && !state.onGround;
    out.pitch = 0;
    return out;
  }
}

export interface NaiveBotOptions {
  readonly target?: Point2 | null;
  readonly heading?: number;
  /** Default true: Sprung halten. */
  readonly jump?: boolean;
  readonly sprint?: boolean;
  /**
   * 'hold' (Default): Taste einmal drücken und halten — der echte Neuling, für den
   * der Smart-Auto-Hop gebaut ist. 'spam': frischer Druck bei jeder Bodenberührung
   * (Mausrad-Spammer) — der umgeht den Smart-Hop und kriecht mit dem Luft-Cap.
   */
  readonly press?: 'hold' | 'spam';
}

/** Der Anfänger: W + Sprung halten, Blick aufs Ziel. Gewinnt in der Luft nichts. */
export class NaiveBot implements Bot {
  private readonly out = makeBotInput();
  private readonly target: Point2 | null;
  private readonly heading: number;
  private readonly jump: boolean;
  private readonly sprint: boolean;
  private readonly spam: boolean;
  private pressedOnce = false;

  constructor(_config: MovementConfig, opts: NaiveBotOptions = {}) {
    this.target = opts.target ?? null;
    this.heading = opts.heading ?? 0;
    this.jump = opts.jump ?? true;
    this.sprint = opts.sprint ?? false;
    this.spam = opts.press === 'spam';
  }

  next(state: PlayerSnapshot): PlayerInput {
    const out = this.out;
    out.yaw = this.target ? yawOf(this.target.x - state.pos.x, this.target.z - state.pos.z) : this.heading;
    out.pitch = 0;
    out.forward = 1;
    out.side = 0;
    out.sprint = this.sprint;
    out.crouch = false;
    out.jumpHeld = this.jump;
    // Gehalten: nur der erste Tick ist ein Druck (früher bei jeder Landung — fallen.md #68).
    out.jumpPressed = this.jump && (this.spam ? state.onGround : !this.pressedOnce);
    if (this.jump) this.pressedOnce = true;
    return out;
  }
}
