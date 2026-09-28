/**
 * Trainingsmodus-Entwurf (v2/training) — PROTOTYP der Lektionslogik (Kandidat für
 * src/engine/Training.ts + src/engine/strafeJudge.ts). DOM-frei, Tick-Pfad ohne Allokation
 * bis auf die Stufenwechsel (selten).
 *
 * Zwei Teile:
 *  1. StrafeJudge — bewertet jeden Luftabschnitt (Absprung → Landung, ohne Surf): Gewinn,
 *     A/D-Anteil, Maus-Drehrate, Taste passend/gegen die Maus, Reaktionszeit → Urteil
 *     'good' oder eine Diagnose (warum kein Gewinn). Schwellen aus turnwindow.ts/flat.ts.
 *  2. LessonRun — Stufen einer Lektion mit messbaren Aufgaben (TaskDef), Fortschritt,
 *     Tore (öffnen bei Stufenabschluss), Respawn-Punkt je Stufe.
 */
import type { PlayerInput, PlayerSnapshot } from '../../../../src/player/types';

// ------------------------------------------------------------------ Verträge (Entwurf LevelFormat)

export type Vec3 = readonly [number, number, number];

export interface ZoneDef {
  readonly id: string;
  readonly min: Vec3;
  readonly max: Vec3;
}

export type HopSide = 'left' | 'right' | 'alternate' | 'any';

export type TaskDef =
  | { readonly kind: 'reach'; readonly zone: string }
  | { readonly kind: 'hopChain'; readonly count: number }
  | { readonly kind: 'goodHops'; readonly count: number; readonly side: HopSide; readonly minGain?: number; readonly minSideShare?: number }
  | { readonly kind: 'speed'; readonly min: number; readonly holdHops?: number }
  | { readonly kind: 'surfHold'; readonly seconds: number; readonly minSpeed?: number }
  | { readonly kind: 'surfSpeed'; readonly min: number }
  | { readonly kind: 'crouchLand'; readonly zone: string; readonly count: number }
  | { readonly kind: 'course'; readonly zones: readonly string[]; readonly minSpeed: number; readonly airborne?: boolean };

export interface StageDef {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly task: TaskDef;
  /** Tore, die bei Abschluss aufgehen. */
  readonly opens?: readonly string[];
  /** Respawn-Punkt dieser Stufe (Füße, yaw °). */
  readonly spawn?: { readonly pos: Vec3; readonly yaw: number };
  /** Bonus-Stufe: zählt nur für Sterne, nicht für "bestanden". */
  readonly bonus?: boolean;
}

// ------------------------------------------------------------------ StrafeJudge

export type Verdict = 'good' | 'noSide' | 'wOnly' | 'noMouse' | 'against' | 'late' | 'tooSlow' | 'tooFast' | 'weak';

export interface HopReport {
  verdict: Verdict;
  gain: number;
  takeoffSpeed: number;
  sideShare: number;
  /** Mittlere Mausrate (°/s) während A/D gedrückt. */
  turnRate: number;
  /** Anteil der A/D-Ticks mit passender Drehrichtung (unter den gedrehten Ticks). */
  matchShare: number;
  firstSide: number;
  /** Überwiegende Seite: −1 links (A + Maus links), +1 rechts, 0 unklar. */
  side: number;
  air: number;
}

const DEG = 180 / Math.PI;
/** Guter Hop: so viel Gewinn (u/s) — wie Coach STRAFE_GOOD_GAIN. */
export const GOOD_GAIN = 8;
/** Kürzere Luftabschnitte (Stufen, Kanten) werden nicht bewertet. */
const MIN_AIR = 0.35;
const SIDE_MIN_SHARE = 0.25;
/** Hops mit weniger Absprungtempo werden nicht bewertet (aus dem Stand: +60 u/s ohne Strafe). */
const MIN_TAKEOFF = 200;
/** Unter dieser Rate (°/s) während A/D: "Maus steht". */
const NO_MOUSE_RATE = 12;
/** Maus dreht, aber zu zaghaft (Gewinn < GOOD bei 320 u/s braucht ≥ ~20 °/s ab Absprung). */
const SLOW_RATE = 35;
/** A/D erst so spät nach dem Absprung: verschenkt die Hälfte (turnwindow: −6 u/s je 0.1 s bei 120 °/s). */
const LATE_SIDE = 0.3;
/** "Zu schnell": Rate über der 50-%-Grenze aus turnwindow.ts (linear interpoliert über das Tempo). */
const FAST_TABLE: readonly (readonly [number, number])[] = [
  [250, 1380],
  [320, 1130],
  [450, 780],
  [600, 530],
  [800, 360],
  [1000, 290],
  [1400, 200],
];

export function tooFastRate(speed: number): number {
  const t = FAST_TABLE;
  if (speed <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (speed <= t[i][0]) {
      const f = (speed - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
      return t[i - 1][1] + f * (t[i][1] - t[i - 1][1]);
    }
  }
  return t[t.length - 1][1];
}

/** Bewertet Luftabschnitte. tick() nach jedem movement.tick mit Zustand davor/danach und der Eingabe. */
export class StrafeJudge {
  onHop: (r: HopReport) => void = () => undefined;
  readonly last: HopReport = { verdict: 'good', gain: 0, takeoffSpeed: 0, sideShare: 0, turnRate: 0, matchShare: 0, firstSide: 0, side: 0, air: 0 };
  private inAir = false;
  private surfed = false;
  private ticks = 0;
  private sideTicks = 0;
  private wTicks = 0;
  private turnSum = 0;
  private matchTicks = 0;
  private againstTicks = 0;
  private turnedTicks = 0;
  private sideSum = 0;
  private firstSide = -1;
  private startSpeed = 0;
  private prevYaw = 0;

  reset(): void {
    this.inAir = false;
  }

  tick(dt: number, prev: PlayerSnapshot, cur: PlayerSnapshot, cmd: PlayerInput): void {
    const air = !cur.onGround;
    if (air && !this.inAir) {
      this.inAir = true;
      this.surfed = false;
      this.ticks = 0;
      this.sideTicks = 0;
      this.wTicks = 0;
      this.turnSum = 0;
      this.matchTicks = 0;
      this.againstTicks = 0;
      this.turnedTicks = 0;
      this.sideSum = 0;
      this.firstSide = -1;
      this.startSpeed = prev.speed;
      this.prevYaw = cmd.yaw;
    }
    if (air) {
      this.ticks++;
      if (cur.surfing) this.surfed = true;
      const dYaw = cmd.yaw - this.prevYaw;
      this.prevYaw = cmd.yaw;
      if (cmd.side !== 0) {
        this.sideTicks++;
        if (this.firstSide < 0) this.firstSide = this.ticks * dt;
        // Netto-Drehung mit dem Vorzeichen der Taste: > 0 = Maus in Tastenrichtung (A + links).
        // Netto statt Σ|dYaw|: Zitter der Hand (Zielrauschen) ist keine Drehrate (judgehigh.ts).
        this.turnSum += -cmd.side * dYaw;
        // Linksdrehung (yaw steigt) passt zu A (side −1).
        if (Math.abs(dYaw) > 1e-5) {
          this.turnedTicks++;
          if (cmd.side * dYaw < 0) this.matchTicks++;
          else this.againstTicks++;
        }
        this.sideSum += cmd.side;
      } else if (cmd.forward > 0) this.wTicks++;
      return;
    }
    if (!this.inAir) return;
    this.inAir = false;
    // Sprung aus dem Stand/Kriechen: der Luft-Cap schenkt dort Gewinn ohne Technik — nicht bewerten.
    if (this.surfed || this.ticks * dt < MIN_AIR || this.startSpeed < MIN_TAKEOFF) return;
    this.judge(dt, cur.speed);
  }

  private judge(dt: number, landSpeed: number): void {
    const r = this.last;
    const n = this.ticks;
    r.gain = landSpeed - this.startSpeed;
    r.takeoffSpeed = this.startSpeed;
    r.air = n * dt;
    r.sideShare = this.sideTicks / n;
    r.turnRate = this.sideTicks > 0 ? (Math.abs(this.turnSum) / (this.sideTicks * dt)) * DEG : 0;
    r.matchShare = this.turnedTicks > 0 ? this.matchTicks / this.turnedTicks : 0;
    r.firstSide = this.firstSide;
    r.side = this.sideSum < 0 ? -1 : this.sideSum > 0 ? 1 : 0;
    let v: Verdict;
    if (r.gain >= GOOD_GAIN) v = 'good';
    else if (r.sideShare < SIDE_MIN_SHARE) v = this.wTicks > n * 0.5 ? 'wOnly' : 'noSide';
    else if (r.turnRate < NO_MOUSE_RATE) v = 'noMouse';
    else if (this.turnSum < 0) v = 'against';
    else if (r.turnRate > tooFastRate(this.startSpeed)) v = 'tooFast';
    else if (this.firstSide > LATE_SIDE) v = 'late';
    else if (r.turnRate < SLOW_RATE) v = 'tooSlow';
    else v = 'weak';
    r.verdict = v;
    this.onHop(r);
  }
}

/** Kurztexte fürs HUD (neben dem Gain-Popup) und lange Coach-Texte (unten). */
export const VERDICT_TEXT: Readonly<Record<Verdict, { readonly short: string; readonly long: string }>> = {
  good: { short: '', long: '' },
  noSide: { short: 'A/D!', long: 'IN DER LUFT A ODER D HALTEN\nUND DIE MAUS IN DIESELBE RICHTUNG ZIEHEN' },
  wOnly: { short: 'W LOS', long: 'IN DER LUFT W LOSLASSEN\nSTATTDESSEN A ODER D HALTEN' },
  noMouse: { short: 'MAUS!', long: 'DIE MAUS MITZIEHEN\nA + MAUS NACH LINKS · D + MAUS NACH RECHTS' },
  against: { short: 'FALSCHE SEITE', long: 'TASTE UND MAUS IN DIESELBE RICHTUNG\nA = MAUS LINKS · D = MAUS RECHTS' },
  late: { short: 'FRÜHER', long: 'GLEICH NACH DEM ABSPRUNG DRÜCKEN\nNICHT ERST OBEN IM SPRUNG' },
  tooSlow: { short: 'WEITER', long: 'DIE MAUS WEITER ZIEHEN\nEINE VIERTELDREHUNG PRO SPRUNG' },
  tooFast: { short: 'RUHIGER', long: 'LANGSAMER ZIEHEN\nJE SCHNELLER DU BIST, DESTO SANFTER' },
  weak: { short: 'KNAPP', long: 'FAST: FLÜSSIGER ZIEHEN\nUND DIE TASTE BIS ZUR LANDUNG HALTEN' },
};

// ------------------------------------------------------------------ LessonRun

interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

function hullIn(b: Box, s: PlayerSnapshot, hullH: number): boolean {
  const p = s.pos;
  return p.x - 16 < b.max[0] && p.x + 16 > b.min[0] && p.y < b.max[1] && p.y + hullH > b.min[1] && p.z - 16 < b.max[2] && p.z + 16 > b.min[2];
}

export interface LessonProgress {
  stage: number;
  /** Fortschritt der aktuellen Stufe (Zähler / Ziel). */
  count: number;
  goal: number;
  done: boolean;
  /** Stufen, die abgeschlossen sind (inkl. Bonus). */
  completed: number;
}

export class LessonRun {
  readonly judge = new StrafeJudge();
  readonly progress: LessonProgress = { stage: 0, count: 0, goal: 0, done: false, completed: 0 };
  onStage: (index: number, stage: StageDef) => void = () => undefined;
  onGate: (id: string) => void = () => undefined;
  readonly openGates = new Set<string>();
  private readonly zones = new Map<string, Box>();
  private lastSide = 0;
  private holdCount = 0;
  private surfTime = 0;
  private offSurf = 0;
  private coursePos = 0;
  private wasGround = true;
  private groundTime = 0;
  private inCrouchZone = false;
  private airStartY = 0;
  private ducked = false;

  constructor(readonly stages: readonly StageDef[], zones: readonly ZoneDef[]) {
    for (const z of zones) this.zones.set(z.id, z);
    this.judge.onHop = (r) => this.hop(r);
    this.enter(0);
  }

  get stage(): StageDef | null {
    return this.stages[this.progress.stage] ?? null;
  }

  private enter(i: number): void {
    const p = this.progress;
    p.stage = i;
    p.count = 0;
    this.lastSide = 0;
    this.holdCount = 0;
    this.surfTime = 0;
    this.coursePos = 0;
    const st = this.stages[i];
    if (!st) {
      p.done = true;
      p.goal = 0;
      return;
    }
    const t = st.task;
    p.goal =
      t.kind === 'goodHops' || t.kind === 'hopChain' || t.kind === 'crouchLand'
        ? t.count
        : t.kind === 'speed'
          ? t.holdHops ?? 1
          : t.kind === 'surfHold'
            ? t.seconds
            : t.kind === 'course'
              ? t.zones.length
              : 1;
    this.onStage(i, st);
  }

  private complete(): void {
    const st = this.stages[this.progress.stage];
    for (const g of st.opens ?? []) {
      this.openGates.add(g);
      this.onGate(g);
    }
    this.progress.completed++;
    this.enter(this.progress.stage + 1);
  }

  private hop(r: HopReport): void {
    const st = this.stage;
    if (!st || st.task.kind !== 'goodHops') return;
    const t = st.task;
    const ok = r.gain >= (t.minGain ?? GOOD_GAIN) && r.sideShare >= (t.minSideShare ?? 0.5);
    let sideOk = true;
    if (t.side === 'left') sideOk = r.side < 0;
    else if (t.side === 'right') sideOk = r.side > 0;
    else if (t.side === 'alternate') sideOk = this.lastSide === 0 || r.side === -this.lastSide;
    if (ok && sideOk) {
      this.lastSide = r.side;
      this.progress.count++;
      if (this.progress.count >= t.count) this.complete();
    }
    // Wechsel-Stufe verzeiht: ein schlechter Hop oder ein guter auf derselben Seite setzt nichts
    // zurück (strikte Serie: der ordentliche Anfänger schaffte 6 in Folge nur in 10/20 Läufen).
  }

  tick(dt: number, prev: PlayerSnapshot, cur: PlayerSnapshot, cmd: PlayerInput, hullH: number): void {
    this.judge.tick(dt, prev, cur, cmd);
    const st = this.stage;
    if (!st) return;
    const t = st.task;
    const p = this.progress;
    const landed = !this.wasGround && cur.onGround;
    const tookOff = this.wasGround && !cur.onGround;
    if (cur.onGround) this.groundTime += dt;
    else this.groundTime = 0;
    if (tookOff) {
      this.airStartY = prev.pos.y;
      this.ducked = false;
    }
    if (!cur.onGround && cur.ducked) this.ducked = true;
    this.wasGround = cur.onGround;
    switch (t.kind) {
      case 'reach': {
        const z = this.zones.get(t.zone);
        if (z && hullIn(z, cur, hullH)) this.complete();
        break;
      }
      case 'hopChain':
        p.count = Math.min(t.count, cur.hopChain);
        if (cur.hopChain >= t.count) this.complete();
        break;
      case 'speed':
        if (t.holdHops === undefined) {
          p.count = cur.speed >= t.min ? 1 : 0;
          if (cur.speed >= t.min) this.complete();
        } else if (landed) {
          this.holdCount = cur.speed >= t.min ? this.holdCount + 1 : 0;
          p.count = this.holdCount;
          if (this.holdCount >= t.holdHops) this.complete();
        }
        break;
      case 'surfHold':
        if (cur.surfing && cur.speed >= (t.minSpeed ?? 0)) {
          this.surfTime += dt;
          this.offSurf = 0;
        } else {
          // Kurze Lücken (Flankenwechsel, Clip-Tick) verzeihen: 0.15 s.
          this.offSurf += dt;
          if (this.offSurf > 0.15) this.surfTime = 0;
        }
        p.count = this.surfTime;
        if (this.surfTime >= t.seconds) this.complete();
        break;
      case 'surfSpeed':
        if (cur.surfing && cur.speed >= t.min) this.complete();
        break;
      case 'crouchLand': {
        const z = this.zones.get(t.zone);
        if (landed && z && hullIn(z, cur, hullH) && this.ducked && cur.pos.y > this.airStartY + 40) {
          p.count++;
          if (p.count >= t.count) this.complete();
        }
        break;
      }
      case 'course': {
        const id = t.zones[this.coursePos];
        const z = id ? this.zones.get(id) : undefined;
        if (z && hullIn(z, cur, hullH) && cur.speed >= t.minSpeed && (!t.airborne || !cur.onGround)) {
          this.coursePos++;
          p.count = this.coursePos;
          if (this.coursePos >= t.zones.length) this.complete();
        }
        // Kette gerissen (≥ 0.3 s am Boden) oder zu langsam: Kurs beginnt neu (kein Tod, einfach nochmal).
        if (this.coursePos > 0 && (this.groundTime > 0.3 || cur.speed < t.minSpeed * 0.8)) {
          this.coursePos = 0;
          p.count = 0;
        }
        break;
      }
      case 'goodHops':
        break;
    }
    void landed;
  }
}
