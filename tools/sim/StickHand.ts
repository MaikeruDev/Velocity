import type { MovementConfig } from '../../src/player/MovementConfig';
import type { PlayerInput, PlayerSnapshot } from '../../src/player/types';
import { makeBotInput, mulberry32, StrafeController, wrapAngle, type Bot } from '../../src/player/bots';
import { gaussian } from '../../src/player/bots/Bot';
import { lookRate, stickMagnitude, STICK_EDGE, type LookCurveParams, type LookRateOut } from '../../src/engine/pad/stickCurve';

/**
 * Stick-Hand (Plan 011 §1.2): perfekter Strafer (StrafeController sync 1), der
 * den Blick aber nur über den Kamera-Stick drehen kann. Liegt bewusst in
 * tools/sim und nicht in player/bots — reines Messinstrument, kein Gameplay.
 *
 * Modell: Die Hand will den Rückstand zum optimalen Yaw in einem Tick
 * aufholen, wählt dafür die Auslenkung über die invertierte Kurve (sie "kennt"
 * ihren Stick), am Rand geklemmt. Darauf liegt Rauschen auf der Auslenkung
 * (AR(1), τ = 0.1 s) — am Anschlag kann es nur nach innen wirken.
 * Mit Boost reitet die Hand den Rand: Liegt der Wunsch zwischen Grundrate und
 * Boost-Rate, bleibt der Stick außen und der Schritt wird auf den Rückstand
 * gekappt (großzügig: ein Mensch moduliert dort schlechter).
 */
export interface StickHandOptions {
  readonly curve: LookCurveParams;
  /** Rauschen auf der Auslenkung (1σ, Anteil 0…1). */
  readonly noise?: number;
  readonly seed?: number;
  /** Zielkurs (rad), wie StrafeBot. */
  readonly heading?: number;
}

const NOISE_TAU = 0.1;
const DEG = Math.PI / 180;

export class StickHand implements Bot {
  private readonly ctl: StrafeController;
  private readonly out = makeBotInput();
  private readonly rate: LookRateOut = { yaw: 0, pitch: 0 };
  private readonly curve: LookCurveParams;
  private readonly noise: number;
  private readonly rand: () => number;
  private readonly heading: number;
  private readonly dt: number;
  private yaw: number;
  private edgeTime = 0;
  private n = 0;
  /** Höchste tatsächlich genutzte Rate (°/s) — Kontrolle im Bericht. */
  peakRate = 0;

  constructor(cfg: MovementConfig, opts: StickHandOptions) {
    this.ctl = new StrafeController(cfg, { sync: 1 });
    this.curve = opts.curve;
    this.noise = opts.noise ?? 0;
    this.rand = mulberry32(opts.seed ?? 1);
    this.heading = opts.heading ?? 0;
    this.dt = 1 / cfg.tickRate;
    this.yaw = this.heading;
    this.ctl.yaw = this.heading;
  }

  next(state: PlayerSnapshot): PlayerInput {
    const out = this.out;
    const c = this.curve;
    if (state.onGround) this.ctl.resync();
    // Optimum (unbegrenzt) berechnen lassen; danach dreht nur der Stick.
    this.ctl.air(state, this.heading, out);
    const err = wrapAngle(out.yaw - this.yaw);
    const want = Math.abs(err) / this.dt / DEG; // °/s
    const base = c.maxYawRate;
    let s: number;
    let ride = false;
    if (want >= base) {
      s = 1;
      ride = c.boost > 0;
    } else {
      s = Math.pow(want / base, 1 / c.exponent);
    }
    if (this.noise > 0) {
      const k = Math.exp(-this.dt / NOISE_TAU);
      this.n = this.n * k + gaussian(this.rand) * this.noise * Math.sqrt(1 - k * k);
      s = Math.min(1, Math.max(0, s + this.n));
    }
    // Rohwert so legen, dass nach der Deadzone genau `s` herauskommt.
    const raw = (c.inner + s * (c.outer - c.inner)) * (err >= 0 ? 1 : -1);
    const edge = stickMagnitude(raw, 0, c.inner, c.outer) >= STICK_EDGE;
    lookRate(raw, 0, c, this.edgeTime, this.rate);
    this.edgeTime = edge ? this.edgeTime + this.dt : 0;
    let step = this.rate.yaw * this.dt;
    if (ride && Math.abs(step) > Math.abs(err)) step = err;
    this.yaw += step;
    this.peakRate = Math.max(this.peakRate, Math.abs(step) / this.dt / DEG);
    // Controller arbeitet mit dem echten Blick weiter (Sync-Messung, Taste).
    this.ctl.yaw = this.yaw;
    out.yaw = this.yaw;
    out.jumpHeld = true;
    out.jumpPressed = state.onGround;
    out.crouch = false;
    out.pitch = 0;
    return out;
  }
}
