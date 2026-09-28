import { airSpeedCapAt, type MovementConfig } from '../MovementConfig';
import type { MutablePlayerInput, PlayerSnapshot } from '../types';
import { gaussian, mulberry32, turnToward, wrapAngle } from './Bot';

export interface StrafeControllerOptions {
  /**
   * 1 = perfekt. Darunter: Winkelrauschen, Überdreh-/Unterdreh-Episoden, Ticks
   * ohne Taste — Fehlergrößen RELATIV zum Gewinnfenster (cap/|v|). Gut, um
   * "Anteil guter Ticks" (HUD-Sync) nachzustellen; ungeeignet, um airSpeedCap-
   * Werte zu vergleichen (der Fehler schrumpft mit dem Fenster). Dafür aimNoiseDeg/turnRateDeg.
   */
  readonly sync?: number;
  readonly seed?: number;
  /** Hysterese (Grad) beim Kurshalten: so weit darf die Geschwindigkeit vom Zielkurs abweichen. */
  readonly band?: number;
  /** Max. Drehrate des Blicks in Grad/s. Unbegrenzt = Formel-Optimum jeden Tick. */
  readonly maxTurnRate?: number;
  /** Nur am Boden wirksam (PlayerMovement). */
  readonly sprint?: boolean;
  /**
   * Menschenmodell A: absoluter Zielfehler des Blicks in Grad (1σ), zeitlich
   * korreliert (AR(1), ~AIM_NOISE_TAU) — die Hand kennt das Gewinnfenster nicht.
   */
  readonly aimNoiseDeg?: number;
  /**
   * Menschenmodell B: der Blick dreht in der Luft mit konstanter Rate (Grad/s)
   * statt dem Optimum zu folgen; Start jedes Strafes auf dem Optimum, Taste
   * passend zur Drehrichtung.
   */
  readonly turnRateDeg?: number;
  /**
   * Lenk-Vorrang (nur Menschenmodelle, sync < 1 oder aimNoiseDeg > 0): muss der
   * Kurs korrigiert werden (Fehler > band), landet ein Zielfehler nach vorn auf
   * der Dreh-Seite (gespiegelt, gleicher Betrag) — wer eine Kurve braucht und
   * merkt, dass nichts dreht, zieht die Maus weiter. Ohne das lag das Zielrauschen bei hohem Tempo (Fenster ±1.5° bei
   * 900 u/s) halb vor dem Fenster, dort wirkt AirAccelerate gar nicht, und die
   * Kurve blieb bis 0.5 s aus (L1-Slalom, Prüfung 27.09.). Default aus.
   */
  readonly steerPriority?: boolean;
}

/** Korrelationszeit des absoluten Zielfehlers (s). */
const AIM_NOISE_TAU = 0.15;

/** good · over: Blick zu weit vorn → kein Gewinn · loss: Blick zu weit hinten / Taste passt nicht zur Maus → Verlust · nokey: keine Strafe-Taste. */
type Mode = 'good' | 'over' | 'loss' | 'nokey';

/** Mittlere Länge einer Fehl-Episode in Ticks (~60 ms bei 128 Tick). */
const MEAN_BAD_TICKS = 8;

/**
 * Air-Strafe-Regler: rechnet pro Tick den optimalen Winkel zwischen
 * Geschwindigkeit und wishdir (cos θ = (cap − a)/|v|, a = min(airAccel·wishspeed·dt, cap))
 * und stellt den Yaw so, dass reines A/D genau diese wishdir ergibt.
 * Richtung: Bang-Bang mit Hysterese um einen Zielkurs, oder frei (zigzag).
 */
export class StrafeController {
  private cfg: MovementConfig;
  private readonly sync: number;
  private readonly rand: () => number;
  private readonly band: number;
  private readonly maxTurnDeg: number;
  readonly sprint: boolean;

  /** Aktueller Blick-Yaw (wird bei begrenzter Drehrate schrittweise nachgeführt). */
  yaw = 0;
  /** +1 = Linkskurve (A), −1 = Rechtskurve (D). */
  turnDir = 1;

  private mode: Mode = 'good';
  private modeTicks = 0;
  private noise = 0;
  private readonly aimNoise: number;
  private aim = 0;
  private readonly turnRate: number;
  private readonly steerPriority: boolean;
  /** Kurs muss korrigiert werden (Fehler > band) — Lenk-Vorrang. */
  private correcting = false;
  /** Konstant-Drehen: Strafe läuft (Blick wird nur noch gedreht). */
  private turning = false;

  constructor(cfg: MovementConfig, opts: StrafeControllerOptions = {}) {
    this.cfg = cfg;
    this.sync = Math.min(1, Math.max(0, opts.sync ?? 1));
    this.rand = mulberry32(opts.seed ?? 1);
    this.band = ((opts.band ?? 10) * Math.PI) / 180;
    this.maxTurnDeg = opts.maxTurnRate ?? Infinity;
    this.sprint = opts.sprint ?? false;
    this.aimNoise = ((opts.aimNoiseDeg ?? 0) * Math.PI) / 180;
    this.turnRate = ((opts.turnRateDeg ?? 0) * Math.PI) / 180;
    const human = this.sync < 1 || this.aimNoise > 0;
    this.steerPriority = human && opts.steerPriority === true;
  }

  setConfig(cfg: MovementConfig): void {
    this.cfg = cfg;
  }

  flip(): void {
    this.turnDir = -this.turnDir;
    this.turning = false;
  }

  private get maxTurnPerTick(): number {
    return this.maxTurnDeg < Infinity ? ((this.maxTurnDeg * Math.PI) / 180) / this.cfg.tickRate : Infinity;
  }

  /** Boden: W Richtung `heading`, Blick dorthin (mit Drehraten-Grenze). */
  ground(heading: number, out: MutablePlayerInput): void {
    this.turning = false;
    this.yaw = turnToward(this.yaw, heading, this.maxTurnPerTick);
    out.yaw = this.yaw;
    out.forward = 1;
    out.side = 0;
    out.sprint = this.sprint;
  }

  /**
   * Reiner A/D-Druck in Richtung (dx, dz) (normiert), Blick möglichst entlang
   * der Flugrichtung — beim Surfen "Taste in die Rampe". Drückt mit bis zu
   * airAccel·wishspeed·dt pro Tick statt nur cap wie der Gewinn-Winkel.
   */
  push(state: PlayerSnapshot, dx: number, dz: number, out: MutablePlayerInput): void {
    this.turning = false;
    // D: right(yaw) = d → yaw = atan2(-dz, dx). A: right(yaw) = -d → yaw = atan2(dz, -dx).
    const yawD = Math.atan2(-dz, dx);
    const yawA = Math.atan2(dz, -dx);
    // forward(yaw) = (-sin, -cos): die Variante, deren Blick eher in Flugrichtung zeigt.
    const fD = -Math.sin(yawD) * state.vel.x - Math.cos(yawD) * state.vel.z;
    const useD = fD >= 0;
    this.yaw = turnToward(this.yaw, useD ? yawD : yawA, this.maxTurnPerTick);
    out.yaw = this.yaw;
    out.forward = 0;
    out.side = useD ? 1 : -1;
    out.sprint = this.sprint;
  }

  /** Gleiten: keine Taste, Blick entlang der Flugrichtung. */
  glide(state: PlayerSnapshot, out: MutablePlayerInput): void {
    this.turning = false;
    const vx = state.vel.x;
    const vz = state.vel.z;
    if (vx * vx + vz * vz > 1) this.yaw = turnToward(this.yaw, Math.atan2(-vx, -vz), this.maxTurnPerTick);
    out.yaw = this.yaw;
    out.forward = 0;
    out.side = 0;
    out.sprint = this.sprint;
  }

  /** Luftbremse: Blick in Flugrichtung, S. AirAccelerate zieht dann bis zu airAccel·wishspeed·dt pro Tick ab. */
  brake(state: PlayerSnapshot, out: MutablePlayerInput): void {
    this.turning = false;
    const vx = state.vel.x;
    const vz = state.vel.z;
    if (vx * vx + vz * vz > 1) this.yaw = turnToward(this.yaw, Math.atan2(-vx, -vz), this.maxTurnPerTick);
    out.yaw = this.yaw;
    out.forward = -1;
    out.side = 0;
    out.sprint = this.sprint;
  }

  /**
   * Luft: optimales Strafen. `heading` = Zielkurs (rad) oder null (Richtung
   * bleibt, z. B. zigzag). Füllt yaw/forward/side/sprint.
   */
  air(state: PlayerSnapshot, heading: number | null, out: MutablePlayerInput): void {
    const cfg = this.cfg;
    const vx = state.vel.x;
    const vz = state.vel.z;
    const sp = Math.hypot(vx, vz);
    out.sprint = this.sprint;
    if (sp < 1) {
      // Keine Flugrichtung: geradeaus Richtung Ziel.
      if (heading !== null) this.yaw = turnToward(this.yaw, heading, this.maxTurnPerTick);
      out.yaw = this.yaw;
      out.forward = 1;
      out.side = 0;
      return;
    }
    const psiV = Math.atan2(-vx, -vz);
    if (heading !== null) {
      const err = wrapAngle(psiV - heading); // > 0: Flugrichtung links vom Ziel
      const before = this.turnDir;
      if (err > this.band) this.turnDir = -1;
      else if (err < -this.band) this.turnDir = 1;
      if (this.turnDir !== before) this.turning = false;
      this.correcting = Math.abs(err) > this.band;
    } else {
      this.correcting = false;
    }

    // In der Luft zählt immer runSpeed (Sprint wirkt nur am Boden).
    const ws = cfg.runSpeed;
    // Tempoabhängiger Cap wie in PlayerMovement.airAccelerate (Horizontal-Tempo vor dem Schub).
    const cap = airSpeedCapAt(cfg, sp);
    const a = Math.min((cfg.airAccelerate * ws) / cfg.tickRate, cap);
    let theta = Math.acos(Math.min(1, Math.max(-1, (cap - a) / sp)));
    const thetaOpt = theta;
    // Fehlerfenster mit dem Basis-Cap, nicht dem tempoabhängigen: sonst würde die
    // Hand bei niedrigem Tempo (Cap 32) absolut schlampiger (fallen.md #29/#50).
    theta += this.errorOffset(cfg.airSpeedCap / sp);
    if (this.aimNoise > 0) {
      const k = Math.exp(-1 / (AIM_NOISE_TAU * cfg.tickRate));
      this.aim = this.aim * k + gaussian(this.rand) * this.aimNoise * Math.sqrt(1 - k * k);
      theta += this.aim;
    }
    // Lenk-Vorrang: Fehler nach vorn (kein Schub, keine Drehung) auf die Dreh-Seite spiegeln.
    if (this.correcting && this.steerPriority && theta < thetaOpt) theta = 2 * thetaOpt - theta;

    const desired = psiV + this.turnDir * (theta - Math.PI / 2);
    if (this.turnRate > 0) {
      // Konstant drehen: Start auf dem Optimum, danach nur noch mit fester Rate weiter.
      if (!this.turning) {
        this.yaw = desired;
        this.turning = true;
      } else {
        this.yaw += (this.turnDir * this.turnRate) / cfg.tickRate;
      }
    } else {
      this.yaw = turnToward(this.yaw, desired, this.maxTurnPerTick);
    }
    out.yaw = this.yaw;
    out.forward = 0;
    out.side = this.mode === 'nokey' ? 0 : this.turnDir > 0 ? -1 : 1;
  }

  /** Neuer Luftabschnitt (Absprung): Konstant-Dreher setzen neu auf dem Optimum an. */
  resync(): void {
    this.turning = false;
  }

  /**
   * Menschliches Fehlermodell (nur sync < 1): Markov-Episoden aus "gut" und
   * "Fehler" mit stationärem Gut-Anteil = sync. `window` ≈ halbe Breite des
   * Gewinn-Fensters in rad (cap/|v|). Positiv = wishdir weiter hinten.
   */
  private errorOffset(window: number): number {
    if (this.sync >= 1) {
      this.mode = 'good';
      return 0;
    }
    if (this.modeTicks <= 0) {
      if (this.mode !== 'good') {
        this.mode = 'good';
        const meanGood = (this.sync * MEAN_BAD_TICKS) / Math.max(1e-3, 1 - this.sync);
        this.modeTicks = this.geometric(meanGood);
      } else {
        const r = this.rand();
        this.mode = r < 0.55 ? 'over' : r < 0.85 ? 'loss' : 'nokey';
        this.modeTicks = this.geometric(MEAN_BAD_TICKS);
      }
    }
    this.modeTicks--;
    switch (this.mode) {
      case 'good':
        // Langsam driftendes Rauschen innerhalb des Fensters (Hand ist nie exakt).
        this.noise = this.noise * 0.9 + gaussian(this.rand) * 0.436;
        return this.noise * 0.35 * window;
      case 'over':
        return -(1.4 + this.rand()) * window;
      case 'loss':
        return (1.3 + this.rand() * 1.2) * window;
      case 'nokey':
        return 0;
    }
  }

  private geometric(mean: number): number {
    const p = 1 / Math.max(1, mean);
    return Math.max(1, Math.ceil(Math.log(Math.max(this.rand(), 1e-12)) / Math.log(1 - p + 1e-12)));
  }
}
