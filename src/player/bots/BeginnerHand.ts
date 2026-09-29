import type { Vector3 } from 'three';
import type { DemoDef } from '../../world/level/LevelFormat';
import type { MovementConfig } from '../MovementConfig';
import type { PlayerInput, PlayerSnapshot } from '../types';
import type { Bot, Point2 } from './Bot';
import { gaussian, makeBotInput, mulberry32, wrapAngle, yawOf } from './Bot';

/**
 * Menschen-Hand für den Trainingsmodus (Plan 007, TC3; Prototyp tools/critique/v2/training/hands.ts):
 * Vorführung per Taste H (fehlerfreier Demo-Modus) und Bot-Matrix der Lektionen.
 *
 * Anders als der StrafeController (Start jedes Strafes auf dem Formel-Optimum) arbeitet sie wie ein
 * Mensch ohne Formel: nach dem Absprung reagiert sie mit Verzug, drückt A oder D und zieht die Maus
 * mit einer pro Hop streuenden, konstanten Rate in dieselbe Richtung. Fehler-Hops (Taste gegen die
 * Maus, Maus steht, nur W) kommen mit fester Wahrscheinlichkeit. Sprung wie ein Mensch, der die Taste
 * hält (nur der erste Tick ist ein Druck → Smart-Auto-Hop wird wirklich benutzt, fallen.md #68). Ist
 * Auto-Hop aus (cfg.autoHop === false), drückt sie wie ein Mensch bei jeder Landung frisch (und nach
 * RUNUP s Anlauf) — sonst hüpfte die Vorführung genau einmal.
 * Deterministisch (mulberry32), next() ohne Allokation.
 */

/** Was die Hand in einem Luftabschnitt tut. */
export type HopMode = 'match' | 'against' | 'noMouse' | 'wOnly' | 'nothing';

export interface HandModel {
  readonly name: string;
  /** Mittlere Mausrate in der Luft (°/s). */
  readonly rateDeg: number;
  /** Lognormal-Streuung der Rate je Hop (σ von ln). */
  readonly rateJitter: number;
  /** Reaktionsverzug nach dem Absprung (s): Mittel und gleichverteilte Streuung ±. */
  readonly delay: number;
  readonly delayJitter: number;
  /** Wahrscheinlichkeiten der Fehler-Hops; Rest = match. */
  readonly pAgainst: number;
  readonly pNoMouse: number;
  readonly pWOnly: number;
  /** W in der Luft zusätzlich halten (mit Strafe-Assist egal, ohne teuer). */
  readonly holdW: boolean;
  /**
   * zigzag = Seite wechselt jede Landung (Kurs im Mittel gerade, Drift wird korrigiert),
   * circle = immer dieselbe Seite, steer = Seite zum Ziel.
   */
  readonly pattern: 'zigzag' | 'circle' | 'steer';
  /** false = gar nicht strafen (nur W + Leertaste, der Neuling vor der Lektion). */
  readonly strafe: boolean;
  /** Blick am Boden zurück zum Ziel/Kurs (°/s). */
  readonly groundTurn: number;
  /**
   * Nur 'steer': Rate je Hop aus der Kursabweichung zum Ziel (einholen in einem Hop, höchstens rateDeg) statt fest.
   * So fliegt die Vorführung eine Kurve durch Tore: fest 120 °/s überzog sie bei 700+ u/s und verfehlte das Tor.
   */
  readonly aimRate?: boolean;
}

const BASE: HandModel = {
  name: '',
  rateDeg: 60,
  rateJitter: 0.35,
  delay: 0.2,
  delayJitter: 0.1,
  pAgainst: 0,
  pNoMouse: 0,
  pWOnly: 0,
  holdW: true,
  pattern: 'zigzag',
  strafe: true,
  groundTurn: 240,
};

/** Hand-Modelle der Lektions-Validierung (Namen = Bot-Matrix in tools/levels/training/check.ts). */
export const HAND_MODELS = {
  /** Vorführung: 120 °/s, 0.1 s Verzug, fehlerfrei. */
  demo: { ...BASE, name: 'Demo-Hand', rateDeg: 120, rateJitter: 0, delay: 0.1, delayJitter: 0, holdW: false, groundTurn: 300 },
  /** Vorführung entlang einer Route (T5-Tore): wie demo, Seite zum nächsten Tor, Rate aus der Kursabweichung (60–120 °/s). */
  demoLenker: { ...BASE, name: 'Demo-Hand (Tore)', rateDeg: 120, rateJitter: 0, delay: 0.1, delayJitter: 0, holdW: false, groundTurn: 300, pattern: 'steer', aimRate: true },
  /** Hat die Anweisung verstanden: 60 °/s, 0.2 s Verzug, jeder 5. Hop geht schief. */
  anfaenger: { ...BASE, name: 'ordentlicher Anfänger', pAgainst: 0.08, pNoMouse: 0.08, pWOnly: 0.04 },
  geuebt: { ...BASE, name: 'geübter Anfänger', rateDeg: 100, rateJitter: 0.3, delay: 0.12, delayJitter: 0.06, pAgainst: 0.04, pNoMouse: 0.04, pWOnly: 0.02, holdW: false, groundTurn: 300 },
  zaghaft: { ...BASE, name: 'zaghaft (30 °/s)', rateDeg: 30, pAgainst: 0.08, pNoMouse: 0.08, pWOnly: 0.04 },
  /** Neuling vor der Lektion: W + Leertaste, Blick aufs Ziel. */
  neuling: { ...BASE, name: 'Neuling W+Leertaste', rateDeg: 0, rateJitter: 0, delay: 0, delayJitter: 0, pattern: 'steer', strafe: false, groundTurn: 360 },
  // Fehlerbilder: dürfen Strafe-Aufgaben nie bestehen; der Judge muss sie erkennen.
  nurW: { ...BASE, name: 'Fehler: nur W + Maus', pWOnly: 1 },
  gegen: { ...BASE, name: 'Fehler: Taste gegen Maus', pAgainst: 1 },
  // Dieselben Fehler mit schneller Maus (Neulinge ziehen oft 180–360 °/s): der Blick streicht zufällig durchs
  // Gewinnfenster — mit 60 °/s allein blieb verdeckt, dass "nur W" T4/T5 bestand (Review rv-tc3).
  nurWSchnell: { ...BASE, name: 'Fehler: nur W + schnelle Maus (360 °/s)', rateDeg: 360, pWOnly: 1 },
  gegenSchnell: { ...BASE, name: 'Fehler: Taste gegen schnelle Maus (360 °/s)', rateDeg: 360, pAgainst: 1 },
  keineMaus: { ...BASE, name: 'Fehler: A/D ohne Maus', pNoMouse: 1 },
  spaet: { ...BASE, name: 'Fehler: zu spät (0.45 s)', rateDeg: 25, delay: 0.45, delayJitter: 0.05 },
  // 10 °/s: sicher unter der Gut-Schwelle (0.8 × Gewinn bei 20 °/s ≈ 16 °/s ohne Verzug) — 16 °/s lag genau darauf.
  langsam: { ...BASE, name: 'Fehler: zu langsam (10 °/s)', rateDeg: 10, rateJitter: 0.15, delay: 0.1, delayJitter: 0.05 },
} as const satisfies Record<string, HandModel>;

export type HandModelId = keyof typeof HAND_MODELS;

/** Fester Seed der Vorführung: jede Demo derselben Stufe sieht gleich aus. */
export const DEMO_SEED = 7;

/** Vorführungs-Hand aus einer Stufen-Demo (DemoDef kind 'hand'). */
export function demoModel(def: Extract<DemoDef, { kind: 'hand' }>): HandModel {
  return { ...HAND_MODELS.demo, rateDeg: def.rateDeg, pattern: def.pattern };
}

export interface BeginnerHandOptions {
  readonly seed?: number;
  /** Ziel (XZ): Blick am Boden und Seite bei 'steer'; Drift-Bezug bei 'zigzag'. */
  readonly goal?: Point2 | null;
  /** Kurs (yaw, rad) ohne Ziel; Default 0 (= −Z). Auch Anfangsblick. */
  readonly heading?: number;
  /** Erste Kurve: 'left' = A + Maus links. Default links. */
  readonly side?: 'left' | 'right';
}

const DEG = Math.PI / 180;
/** Double-Startwert für Kommazahl-Felder (vor dem ersten Lesen überschrieben; s. engine/strafeJudge). */
const D0 = 0.5;
/** Ohne Auto-Hop: erster Sprung nach so viel Anlauf am Boden (s), wie der Smart-Auto-Hop (autoHopGroundTime). */
const RUNUP = 0.2;
/** Zigzag: ab dieser Kursabweichung zum Ziel dreht die Hand zurück (Mensch korrigiert Drift). */
const DRIFT_LIMIT = 60 * DEG;
/** aimRate: typische Luftzeit eines Hops (s), in der der Blick die Kursabweichung einholen soll. */
const AIM_HOP = 0.65;
/** aimRate: langsamste Rate (rad/s) — 40 °/s sind bei 300–1000 u/s noch sicher 'good' (turnwindow.ts). */
const AIM_MIN_RATE = 40 * DEG;
/**
 * aimRate: mindestens dieser Anteil von rateDeg — auch geradeaus zieht die Hand zügig (Tempo für Bonus/Meister).
 * T5-Bogen, Demo-Hand 120–240 °/s, Tor-Reichweite 300/400: mit 0.5 alle Stufen 380/300/450/600 in 14–16 s; mit 0.33
 * reichte das Tempo für 600 nicht, mit 0.66 überzog sie bei 1100+ u/s und verfehlte Tore.
 */
const AIM_MIN_SHARE = 0.5;

export class BeginnerHand implements Bot {
  private readonly rand: () => number;
  private readonly out = makeBotInput();
  private readonly dt: number;
  /** Auto-Hop aus: bei jeder Landung frisch drücken. */
  private readonly manualHop: boolean;
  // Kommazahl-Felder mit Double-Startwert (D0), im Konstruktor gesetzt: mit Smi-Start (0, Blick 0 am Spawn) boxte
  // next() je Tick ~29 B — die Vorführung läuft im Tick-Pfad (fallen.md #107 Punkt 4).
  private groundT = D0;
  private model: HandModel;
  /** Aktueller Blick (rad). */
  yaw = D0;
  /** +1 = Linkskurve (A, yaw steigt), −1 = Rechtskurve (D). Stufenwechsel dürfen sie setzen. */
  side: 1 | -1;
  goal: Point2 | null;
  heading = D0;
  /** Blick zum Ziel in diesem Tick (rad). */
  private target = D0;
  private wasGround = true;
  private pressed = false;
  private rate = D0;
  private delay = D0;
  private airT = D0;
  private planned = false;
  /** Modus des laufenden bzw. letzten Luftabschnitts. */
  mode: HopMode = 'match';
  /** Anzahl Absprünge. */
  hops = 0;

  constructor(cfg: Pick<MovementConfig, 'tickRate'> & Partial<Pick<MovementConfig, 'autoHop'>>, model: HandModel, opts: BeginnerHandOptions = {}) {
    this.dt = 1 / cfg.tickRate;
    this.manualHop = cfg.autoHop === false;
    this.model = model;
    this.rand = mulberry32((opts.seed ?? DEMO_SEED) * 7919 + 17);
    this.goal = opts.goal ?? null;
    this.heading = opts.heading ?? 0;
    this.yaw = this.heading;
    this.side = opts.side === 'right' ? -1 : 1;
    this.groundT = 0;
    this.rate = 0;
    this.delay = 0;
    this.airT = 0;
  }

  get handModel(): HandModel {
    return this.model;
  }

  /** Modell wechseln (Stufenwechsel der Validierung); Blick und Zustand bleiben. */
  setModel(model: HandModel): void {
    this.model = model;
    this.planned = false;
  }

  next(s: PlayerSnapshot): PlayerInput {
    const o = this.out;
    const m = this.model;
    const dt = this.dt;
    // Ziel-Blick als Feld, Drehschritte als Klemme (min/max): ein Zweig um Kommazahlen boxt am Zusammenfluss (#107).
    this.target = this.heading;
    if (this.goal) this.target = yawOf(this.goal.x - s.pos.x, this.goal.z - s.pos.z);
    const target = this.target;
    o.jumpHeld = true;
    if (this.manualHop) {
      // Landung (vorher Luft) oder genug Anlauf: frischer Druck; sonst nichts (gehalten springt ohne Auto-Hop nicht).
      o.jumpPressed = s.onGround && (!this.wasGround || this.groundT + dt >= RUNUP);
      this.groundT = (this.groundT + dt) * (s.onGround ? 1 : 0);
    } else o.jumpPressed = !this.pressed;
    this.pressed = true;
    o.sprint = true;
    o.crouch = false;
    o.pitch = 0;
    if (s.onGround) {
      // Landung: nächsten Hop planen (gilt ab dem Absprung).
      if (!this.wasGround || !this.planned) this.planHop(s, target);
      const d = wrapAngle(target - this.yaw);
      const step = m.groundTurn * DEG * dt;
      this.yaw += Math.max(-step, Math.min(step, d));
      o.yaw = this.yaw;
      o.forward = 1;
      o.side = 0;
      this.airT = 0;
      this.wasGround = true;
      return o;
    }
    if (this.wasGround) this.hops++;
    this.wasGround = false;
    this.airT += dt;
    o.forward = m.holdW ? 1 : 0;
    o.side = 0;
    if (!m.strafe || this.mode === 'nothing') {
      o.forward = 1;
      o.yaw = this.yaw;
      return o;
    }
    if (this.airT < this.delay) {
      // Reaktionszeit: der Mensch schaut erst dorthin, wohin er fliegt, dann zieht er. Ohne das blieb
      // der Blick nach einem Gegen-Hop 80° neben der Flugrichtung, und die nächste Taste bremste
      // 613 → 223 u/s in drei Ticks (T5-Messung).
      const vx = s.vel.x;
      const vz = s.vel.z;
      if (vx * vx + vz * vz > 1) {
        const d = wrapAngle(Math.atan2(-vx, -vz) - this.yaw);
        const step = m.groundTurn * DEG * dt;
        this.yaw += Math.max(-step, Math.min(step, d));
      }
    } else {
      if (this.mode !== 'noMouse') this.yaw += this.side * this.rate * dt;
      if (this.mode === 'wOnly') o.forward = 1;
      else {
        const matchSide = this.side > 0 ? -1 : 1; // Linkskurve ↔ A
        o.side = this.mode === 'against' ? -matchSide : matchSide;
      }
    }
    o.yaw = this.yaw;
    return o;
  }

  private planHop(s: PlayerSnapshot, target: number): void {
    const m = this.model;
    this.planned = true;
    const r = this.rand();
    this.mode = r < m.pAgainst ? 'against' : r < m.pAgainst + m.pNoMouse ? 'noMouse' : r < m.pAgainst + m.pNoMouse + m.pWOnly ? 'wOnly' : 'match';
    if (!m.strafe) this.mode = 'nothing';
    this.rate = m.rateDeg * DEG * Math.exp(gaussian(this.rand) * m.rateJitter);
    this.delay = Math.max(0, m.delay + (this.rand() * 2 - 1) * m.delayJitter);
    if (m.pattern === 'circle') return;
    const vx = s.vel.x;
    const vz = s.vel.z;
    const psi = vx * vx + vz * vz > 1 ? Math.atan2(-vx, -vz) : this.yaw;
    const err = wrapAngle(psi - target);
    if (m.pattern === 'zigzag') {
      // Nur bei echten Landungen wechseln (der erste Plan am Spawn behält die Startseite).
      if (this.hops > 0) this.side = this.side > 0 ? -1 : 1;
      if (Math.abs(err) > DRIFT_LIMIT) this.side = err > 0 ? -1 : 1;
    } else {
      // steer: Flugrichtung links vom Ziel → rechts drehen.
      this.side = err > 0 ? -1 : 1;
      // aimRate: so fest ziehen, dass der Blick die Abweichung in einem Hop einholt (Mensch sieht das Tor und zieht hin) —
      // höchstens rateDeg, mindestens AIM_MIN_SHARE davon (≥ AIM_MIN_RATE, darunter kein guter Hop mehr).
      if (m.aimRate === true) this.rate = Math.max(Math.max(AIM_MIN_RATE, m.rateDeg * DEG * AIM_MIN_SHARE), Math.min(m.rateDeg * DEG, Math.abs(err) / AIM_HOP));
    }
  }
}

/** Prestrafe-Hand: so lange (s) nur W (mit Sprint) geradeaus, bevor A/D und Maus einsetzen — Anlauf auf Lauftempo. */
export const PRESTRAFE_RUNUP = 0.5;

export interface PrestrafeHandOptions {
  /** Mausrate (°/s), konstant. Gemessen tragen 150–300 °/s über 350 u/s (T4, drivers.prestrafeRate). */
  readonly rateDeg: number;
  /** 'left' = W + A, Maus nach links (Default); 'right' = W + D, Maus nach rechts. */
  readonly side?: 'left' | 'right';
  /** Anfangsblick (yaw, rad). */
  readonly heading?: number;
  /** Anlauf nur mit W (s), Default PRESTRAFE_RUNUP. */
  readonly runUp?: number;
}

/**
 * Prestrafe-Hand (T4-Bonus, Vorführung per H): wie ein Mensch nach dem Stufentext "W + A HALTEN, MAUS ZÜGIG LINKS" —
 * erst Anlauf mit W, dann W + A/D und die Maus mit konstanter Rate in Tastenrichtung. Am Boden, nie ein Sprung (vorher
 * gab es für PRESTRAFE keine Vorführung, nur Text). Deterministisch, next() ohne Allokation.
 */
export class PrestrafeHand {
  private readonly out = makeBotInput();
  private readonly dt: number;
  /** Drehrate mit Vorzeichen (rad/s, + = links wie yaw). */
  private readonly rate: number;
  private readonly key: -1 | 1;
  private readonly runUp: number;
  /** Zeit seit dem Start (s) und Blick (rad): Double-Startwert (D0), im Konstruktor gesetzt (fallen.md #107). */
  private t = D0;
  yaw = D0;

  constructor(cfg: Pick<MovementConfig, 'tickRate'>, opts: PrestrafeHandOptions) {
    this.dt = 1 / cfg.tickRate;
    const left = opts.side !== 'right';
    this.rate = (left ? 1 : -1) * opts.rateDeg * DEG;
    this.key = left ? -1 : 1;
    this.runUp = opts.runUp ?? PRESTRAFE_RUNUP;
    this.t = 0;
    this.yaw = opts.heading ?? 0;
  }

  next(): PlayerInput {
    const o = this.out;
    this.t += this.dt;
    // Ganzzahliger Schalter statt Zweig um die Kommazahl-Rechnung (fallen.md #107.2).
    const turning = this.t > this.runUp ? 1 : 0;
    this.yaw += this.rate * this.dt * turning;
    o.yaw = this.yaw;
    o.pitch = 0;
    o.forward = 1;
    o.side = this.key * turning;
    o.sprint = true;
    o.crouch = false;
    o.jumpHeld = false;
    o.jumpPressed = false;
    return o;
  }
}

/**
 * Was die Surf-Hand an der Flanke tut: grund = Taste in die Rampe (Seite aus der Surf-Normale), wa = zusätzlich W
 * (mit Strafe-Assist gleich), w = nur W, nichts, weg = Taste von der Rampe weg (Fehlerbilder der Lektion T7).
 */
export type SurfMode = 'grund' | 'wa' | 'w' | 'nichts' | 'weg';

export interface SurfHandOptions {
  readonly seed?: number;
  readonly mode?: SurfMode;
  /** Zielfehler des Blicks entlang der Rampe (Grad, 1σ, AR(1) mit 0.15 s). 0 = exakt. */
  readonly noiseDeg?: number;
  /**
   * Fester Blickfehler an der Flanke (Grad): > 0 = in die Rampe hinein, < 0 = die Flanke hinab. Der typische
   * Neulingsfehler; das Rauschen allein ist mittelwertfrei und zeigt das Toleranzband der Lektion nicht.
   */
  readonly biasDeg?: number;
  /** Reaktion: so lange (s) nach dem ersten Flankenkontakt drückt die Hand noch nichts. */
  readonly react?: number;
  /** Rampenachse (yaw, rad): Anlauf und Blick. Default 0 (= −Z). */
  readonly heading?: number;
}

/**
 * Surf-Hand (T7/T8, Vorführung und Bot-Matrix): läuft mit W + Sprint entlang der Achse, fällt über die Kante
 * auf die Flanke und hält dann die Taste zur Rampe hin, Blick entlang der Achse (so wie die Lektion es lehrt:
 * "W los, Taste in die Rampe, Blick entlang"). Kein Regler auf eine Linie — Höhe und Tempo ergeben sich wie
 * bei einem Menschen, der nur die Grundtechnik kann. Deterministisch, next() ohne Allokation.
 */
export class SurfHand {
  private readonly rand: () => number;
  private readonly out = makeBotInput();
  private readonly dt: number;
  private readonly mode: SurfMode;
  private readonly noise: number;
  private readonly bias: number;
  private readonly react: number;
  private readonly heading: number;
  private grounded = false;
  private flying = false;
  private contact = 0;
  private aim = 0;
  private rampSide = 0;

  constructor(cfg: Pick<MovementConfig, 'tickRate'>, opts: SurfHandOptions = {}) {
    this.dt = 1 / cfg.tickRate;
    this.rand = mulberry32((opts.seed ?? DEMO_SEED) * 977 + 3);
    this.mode = opts.mode ?? 'grund';
    this.noise = ((opts.noiseDeg ?? 0) * Math.PI) / 180;
    this.bias = ((opts.biasDeg ?? 0) * Math.PI) / 180;
    this.react = opts.react ?? 0;
    this.heading = opts.heading ?? 0;
  }

  /** Neuer Versuch (Respawn an der Plattform). */
  reset(): void {
    this.grounded = false;
    this.flying = false;
    this.contact = 0;
    this.aim = 0;
    this.rampSide = 0;
  }

  /** surfNormal = PlayerMovement.surfNormal (Seite der Rampe). */
  next(s: PlayerSnapshot, surfNormal: Vector3): PlayerInput {
    const o = this.out;
    const dt = this.dt;
    o.pitch = 0;
    o.sprint = true;
    o.crouch = false;
    o.jumpHeld = false;
    o.jumpPressed = false;
    if (s.onGround) this.grounded = true;
    if (!this.flying) {
      // Anlauf: geradeaus über die Kante (erst in der Luft, nachdem man stand).
      o.yaw = this.heading;
      o.forward = 1;
      o.side = 0;
      if (this.grounded && !s.onGround) this.flying = true;
      return o;
    }
    const n = surfNormal;
    if (s.surfing || n.x !== 0 || n.z !== 0) this.contact += dt;
    if (n.x !== 0 || n.z !== 0) {
      // Rampe rechts von der Blickrichtung (Normale zeigt nach links) → D, sonst A.
      const rx = Math.cos(this.heading);
      const rz = -Math.sin(this.heading);
      this.rampSide = n.x * rx + n.z * rz < 0 ? 1 : -1;
    }
    const into = this.rampSide !== 0 ? this.rampSide : 1;
    if (this.noise > 0) {
      const k = Math.exp(-dt / 0.15);
      this.aim = this.aim * k + gaussian(this.rand) * this.noise * Math.sqrt(1 - k * k);
    }
    // Blickfehler erst, wenn die Seite der Rampe bekannt ist. Rampe rechts (D, into = 1) → hinein = nach rechts
    // drehen (yaw sinkt); Rampe links (A) → nach links (yaw steigt).
    o.yaw = this.heading + this.aim - (this.rampSide !== 0 ? this.rampSide * this.bias : 0);
    o.forward = 0;
    o.side = 0;
    if (this.contact < this.react) return o;
    switch (this.mode) {
      case 'grund':
        o.side = into;
        break;
      case 'wa':
        o.side = into;
        o.forward = 1;
        break;
      case 'w':
        o.forward = 1;
        break;
      case 'weg':
        o.side = -into;
        break;
      case 'nichts':
        break;
    }
    return o;
  }
}
