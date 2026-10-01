import { VM_JOINT, VM_JOINT_COUNT } from '../../render/types';
import { POSE, POSE_JOINTS } from './poses';
import { arc, clamp, smooth } from './anim';
import { Track, cubicIn, cubicInOut, quadIn, quadOut, sineInOut } from './curves';
import type { Ease, Key } from './curves';
import { fingerTip } from './fk';
import { PropTricks, XFADE } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { Toss, settle } from './rigid';
import { UNITS_PER_IMAGE_HEIGHT } from './rope';
import { VIEW_AXES, axisAngleQ, fromEulerXYZV, mat3, mul, mulT, toAxisAngleQ, toEulerXYZ } from './rot';
import { relRot, socketPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Energy-Drink-Dose (Plan 006, Animation Plan 008 Schritt 2): seitlich in der Faust wie in den Referenzen.
 *
 * Alles entsteht aus der Hand (Plan 008): Würfe sind echte Parabeln (rigid.Toss) mit konstanter Drehung, die Hand
 * holt aus (Handgelenk spannt, Finger drücken), schnippt, öffnet sich im Flug, greift dem Fang entgegen und gibt
 * beim Fang nach (Handgelenk und Höhe federn in geschlossener Form, Finger schließen sichtbar mit Nachdrücken).
 * Finger, Daumen und Handgelenk laufen über `PropOut.jointAdd` auf der festen Griff-Pose — deterministische
 * Spuren (curves.Track), keine exponentiell überblendeten Posenwechsel.
 *
 * - Einmal pro Leben "crack": die Dose rutscht im Griff ein Stück nach unten (Nachgreifen), der Zeigefinger
 *   streckt sich über den Rand, hakt unter die Lasche und hebelt sie hoch; sie schnappt über den Finger hinaus
 *   auf ("Pssht", die Dose zuckt), der Finger drückt sie wieder flach, die Hand hüpft die Dose zurück in den Griff.
 * - Schluck (nur offen, nur in Ruhe): Ease-in/out zum Mund, drei Schlucke mit zunehmender Neigung, zurück mit
 *   Nachwippen. Leerlauf offen: "tilt" schwenkt die Flüssigkeit (Handgelenk kreist).
 * - Tempo-Tricks an Sprüngen: Flip → hoher Flip/Twirl → Doppel-Flip / Wurf hinter die Hand.
 * - Surf ≥ 500 u/s: surfBalance (Plan 007 KI8) — die Dose balanciert auf der Zeigefinger-Kuppe.
 */

export const CAN_TRICKS = ['none', 'tilt', 'crack', 'sip', 'flip', 'highFlip', 'twirl', 'doubleFlip', 'behindThrow', 'surfBalance'] as const;
export type CanTrick = Exclude<(typeof CAN_TRICKS)[number], 'none'>;

const CAN_NAMES: readonly string[] = CAN_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const CAN_TIER_TRICKS: readonly (readonly CanTrick[])[] = [[], ['flip'], ['highFlip', 'twirl', 'flip'], ['doubleFlip', 'behindThrow', 'highFlip', 'twirl']];

/**
 * Dose in der Faust (Plan 008, Griff-Audit): Achse quer über die Handfläche, Rücken an der Handfläche, alle
 * Fingerglieder liegen an (Pose grip, mit Finger-Kontakt gebacken). Vorher 1 Einheit tiefer: der Daumenballen
 * steckte 1.1 cm in der Dose, die Finger 1.3 cm.
 */
export const CAN_HOLD_POS = [1.6, 8.2, -5.6] as const;
export const CAN_HOLD_ROT = [0, 0, Math.PI / 2] as const;

// ------------------------------------------------------------------ gemeinsame Bausteine (auch Feuerzeug/Handy)

const TAU = Math.PI * 2;
const JA = VM_JOINT;

/** Gelenk-Differenz zweier Posen (nur Daumen und Finger; Handgelenk 0) — Ladezeit. */
export function poseDelta(from: number, to: number): Float32Array {
  const d = new Float32Array(VM_JOINT_COUNT);
  for (let i = JA.thumbAbd; i < VM_JOINT_COUNT; i++) d[i] = POSE_JOINTS[to][i] - POSE_JOINTS[from][i];
  return d;
}

/**
 * Gelenk-Versatz eines Fingers (0..3) bzw. des Daumens (4) — Werte in rad: Finger [Spreizen, Grund, Mittel, End],
 * Daumen [Abspreizen, Opposition, Grund, End]. Ladezeit (gebackene Schlüssel-Posen, IK gegen das Griff-Modell).
 */
export function fingerKey(f: number, d: readonly [number, number, number, number]): Float32Array {
  const k = new Float32Array(VM_JOINT_COUNT);
  const idx = f < 4 ? JA.finger + f * 4 : JA.thumbAbd;
  for (let i = 0; i < 4; i++) k[idx + i] = d[i];
  return k;
}

/** Bild-oben ohne Anteil entlang der Handflächen-Normale (Handgelenk-z), normiert. */
const PLANE_UP: V3 = ((): V3 => {
  const u = VIEW_AXES.up;
  const l = Math.sqrt(u[0] * u[0] + u[1] * u[1]);
  return [u[0] / l, u[1] / l, 0];
})();

/**
 * Freier Flug eines Gegenstands (Plan 008): echte Parabel in Bildrichtung "unten" mit konstanter Drehung (Achse
 * `axis`), im Raum des RUHENDEN Handgelenks. Die Hand darf sich währenddessen bewegen (Hand-Versatz
 * hx/hy/hz und Handgelenk-Gelenke aus jointAdd): place() rechnet diese Bewegung pro Frame heraus — der
 * Gegenstand hängt sonst am Handgelenk und flöge jede Ausholbewegung mit. Abwurf und Fang liegen exakt im Griff
 * der Hand zu diesen Zeiten (Hand-Zustände rel/cat), damit Loslassen und Fangen ohne Sprung passieren.
 * Rechnung geschlossen in der Flugzeit → jede Framerate zeigt dieselbe Bahn. Keine Allokation nach dem Aufbau.
 */
export class PropFlight {
  readonly toss = new Toss(500);
  /** Haltelage (Handgelenk-Raum) und Euler XYZ. */
  readonly holdPos = new Float64Array(3);
  readonly holdRot = new Float32Array(3);
  /** Hand beim Abwurf und beim Fang: hx, hy, hz (wie PropOut, schon × motionFx), Beugen, Seitneigen, Drehen. */
  readonly rel = new Float64Array(6);
  readonly cat = new Float64Array(6);
  /** Drehung über den Flug (rad, Vielfaches von 2π) um `axis` (Handgelenk-Raum, normiert). */
  turns = 0.5;
  /**
   * Drehachse: Standard = Handflächen-Normale (Handgelenk-z). Dann laufen die Enden eines langen Gegenstands parallel
   * zur Handfläche um — um die Bild-Tiefenachse schlugen die Dosen-Enden kurz nach dem Abwurf durch Handfläche und
   * Finger (−2.3 Einheiten). Im Bild ein Überschlag nach vorn (Deckel kippt von der Kamera weg).
   */
  readonly axis = new Float64Array(3);
  /**
   * Flugrichtung "oben" (Schwerkraft entgegen), Handgelenk-Raum: Bild-oben zeigt hier 0.39 IN die Handfläche (die
   * Faust liegt im Bild über der Dose) — gerade hoch geworfen flog die Dose durch sie hindurch (−2.3). Darum schräg:
   * Bild-oben ohne Handflächen-Anteil plus `away` × von der Handfläche weg (−z); die Dose springt aus der Faust
   * schräg nach oben-links und fällt dorthin zurück.
   */
  readonly up = new Float64Array(3);
  private readonly rRel = mat3();
  private readonly dq = new Float64Array(4);
  private readonly q = new Float64Array(4);
  private readonly p = new Float64Array(3);
  private readonly from = new Float64Array(3);
  private readonly to = new Float64Array(3);
  private readonly h = new Float64Array(6);
  private readonly mW = mat3();
  private readonly mA = mat3();
  private readonly mB = mat3();
  private readonly mH = mat3();

  constructor(away = 0.52) {
    this.turns = 0;
    this.carryAngle = 0;
    this.axis[2] = 1;
    this.setAway(away);
  }

  setAway(away: number): void {
    const x = PLANE_UP[0];
    const y = PLANE_UP[1];
    const z = -away;
    const l = Math.sqrt(x * x + y * y + z * z);
    this.up[0] = x / l;
    this.up[1] = y / l;
    this.up[2] = z / l;
  }

  setHold(pos: ArrayLike<number>, rot: ArrayLike<number>): void {
    for (let k = 0; k < 3; k++) {
      this.holdPos[k] = pos[k];
      this.holdRot[k] = rot[k];
    }
  }

  /** Flug über T s, Scheitel ~apex (Einheiten) bei gleicher Höhe; rel/cat vorher gesetzt. */
  plan(T: number, apex: number, turns: number): void {
    const g = (8 * apex) / (T * T);
    for (let k = 0; k < 3; k++) this.toss.g[k] = -this.up[k] * g;
    this.turns = turns;
    fromEulerXYZV(this.mH, this.holdRot);
    this.h.set(this.rel);
    this.forward(this.from);
    mul(this.rRel, this.mW, this.mH);
    // Rest-Drehung Abwurf → Fang (Handgelenk anders gestellt): D = W_fang · W_abwurfᵀ, über den Flug verteilt.
    const wRel = this.mA;
    wRel.set(this.mW);
    this.h.set(this.cat);
    this.forward(this.to);
    mulT(this.mB, this.mW, wRel);
    toAxisAngleQ(this.mB, this.dq);
    this.toss.plan(this.from, this.to, T, 0, turns);
  }

  /** Haltepunkt bei Hand-Zustand h → Ruhe-Handgelenk-Raum (W·p + d); setzt mW. */
  private forward(out: Float64Array): void {
    this.wrist(this.h[3], this.h[4], this.h[5]);
    const W = this.mW;
    const p = this.holdPos;
    for (let r = 0; r < 3; r++) out[r] = W[r * 3] * p[0] + W[r * 3 + 1] * p[1] + W[r * 3 + 2] * p[2];
    this.offset(out, 1);
  }

  /** out += sign · Hand-Versatz aus h (Bildhöhen → Einheiten; hz zur Kamera). */
  private offset(out: Float64Array, sign: number): void {
    const A = VIEW_AXES;
    const x = this.h[0] * UNITS_PER_IMAGE_HEIGHT * sign;
    const y = -this.h[1] * UNITS_PER_IMAGE_HEIGHT * sign;
    const z = this.h[2] * sign;
    for (let k = 0; k < 3; k++) out[k] += A.right[k] * x + A.up[k] * y + A.cam[k] * z;
  }

  /** mW = Handgelenk wie ViewModel (Euler ZXY aus [−Beugen, Drehen, Seitneigen]) = Rz·Rx·Ry. */
  private wrist(flex: number, dev: number, twist: number): void {
    const q = this.q;
    q[0] = 0;
    q[1] = 0;
    q[2] = 1;
    q[3] = dev;
    axisAngleQ(this.mW, q);
    q[0] = 1;
    q[2] = 0;
    q[3] = -flex;
    axisAngleQ(this.mB, q);
    mul(this.mW, this.mW, this.mB);
    q[0] = 0;
    q[1] = 1;
    q[3] = twist;
    axisAngleQ(this.mB, q);
    mul(this.mW, this.mW, this.mB);
  }

  /** Nachdrehen nach dem Fang (rad, um `axis`) für carry() — als Feld, nicht als Argument (fallen.md #107.3). */
  carryAngle = 0.5;

  /**
   * Restdrall nach dem Fang: die Hand nimmt die Drehung auf, der Gegenstand dreht um `axis` nach und federt zurück
   * (Winkel carryAngle, vom Aufrufer geschlossen gerechnet). Eigene Matrizen statt PropTricks.spinKick: dessen
   * Wackelfeder erzeugte in Node bei Dosen-Würfen Dauer-Müll (24 Scavenges je 24 000 Frames, 1-MB-Semispace).
   */
  carry(o: PropOut): void {
    const q = this.q;
    const c = this.axis;
    q[0] = c[0];
    q[1] = c[1];
    q[2] = c[2];
    q[3] = this.carryAngle;
    axisAngleQ(this.mA, q);
    fromEulerXYZV(this.mB, o.rot);
    // Drehung im Raum des Handgelenks um den Mittelpunkt: R' = A · R
    mul(this.mB, this.mA, this.mB);
    toEulerXYZ(this.mB, o.rot);
  }

  /**
   * Lage zur Flugzeit s in o.pos/o.rot schreiben. Liest die Hand dieses Frames aus o (hx/hy/hz, jointAdd 0..2,
   * vor der motionFx-Skalierung — daher m) und rechnet sie heraus.
   */
  place(o: PropOut, s: number, m: number): void {
    const h = this.h;
    h[0] = o.hx * m;
    h[1] = o.hy * m;
    h[2] = o.hz * (0.6 + 0.4 * m);
    const ja = o.jointAdd;
    const ang = this.toss.at(s, this.p);
    this.offset(this.p, -1);
    this.wrist(ja[0] * m, ja[1] * m, ja[2] * m);
    const W = this.mW;
    const p = this.p;
    for (let k = 0; k < 3; k++) o.pos[k] = W[k] * p[0] + W[3 + k] * p[1] + W[6 + k] * p[2];
    // Lage: Wᵀ · Rcam(Winkel) · D(u) · R_abwurf
    const u = clamp(s / this.toss.T, 0, 1);
    const q = this.q;
    q[0] = this.dq[0];
    q[1] = this.dq[1];
    q[2] = this.dq[2];
    q[3] = this.dq[3] * u;
    axisAngleQ(this.mA, q);
    mul(this.mA, this.mA, this.rRel);
    const c = this.axis;
    q[0] = c[0];
    q[1] = c[1];
    q[2] = c[2];
    q[3] = ang;
    axisAngleQ(this.mB, q);
    mul(this.mA, this.mB, this.mA);
    // mB = Wᵀ · mA
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) this.mB[r * 3 + k] = W[r] * this.mA[k] + W[3 + r] * this.mA[3 + k] + W[6 + r] * this.mA[6 + k];
    toEulerXYZ(this.mB, o.rot);
  }
}

/**
 * Folge von Schlüssel-Posen über die Zeit: Eintrag [Zeit, Schlüssel-Index, Easing bis zum nächsten]. Anders als eine
 * Phasen-Spur (addKeys) springt sie direkt von Schlüssel zu Schlüssel — ein Daumen, der wischt, abhebt und oben neu
 * ansetzt, liefe über eine Phase durch den unteren Schlüssel zurück. Ladezeit.
 */
export class KeySeq {
  readonly t: Float64Array;
  readonly k: Int32Array;
  readonly e: readonly (Ease | null)[];
  constructor(entries: readonly (readonly [number, number, Ease?])[]) {
    this.t = Float64Array.from(entries.map((x) => x[0]));
    this.k = Int32Array.from(entries.map((x) => x[1]));
    this.e = entries.map((x) => x[2] ?? null);
    for (let i = 1; i < entries.length; i++) if (!(this.t[i] > this.t[i - 1])) throw new Error('KeySeq: Zeiten müssen steigen');
  }
}

/**
 * Nachfedern, das bis `len` s nach dem Ereignis sanft auf 0 ausläuft (am Trick-Ende kein Sprung, wenn der
 * Ruhezustand übernimmt). Geschlossene Form (rigid.settle).
 */
export function settleIn(v: number, s: number, len: number, omega: number, zeta: number): number {
  if (!(s > 0) || s >= len) return 0;
  const k = (s - 0.6 * len) / (0.4 * len);
  return settle(v, s, omega, zeta) * (1 - smooth(k));
}

/** Spuren eines Wurfs (Ladezeit): Hand-Versatz, Handgelenk-Beugen, Finger/Daumen/Ring-Gewichte — fehlende = 0. */
export interface TossTrackSet {
  readonly hx?: Track;
  readonly hy: Track;
  readonly hz?: Track;
  readonly flex: Track;
  readonly open: Track;
  readonly thumb?: Track;
  readonly ring?: Track;
}

/** Nachgeben beim Fang (geschlossene Form): Startgeschwindigkeiten und Feder. */
export interface CatchGive {
  /** Hand (Bildhöhen/s), Handgelenk (rad/s), Finger (Anteil/s), Restdrall (Anteil der Flug-Drehrate). */
  readonly hy: number;
  readonly flex: number;
  readonly fingers: number;
  readonly carry: number;
  readonly omega: number;
  readonly zeta: number;
}

const ZERO = new Track([[0, 0]]);
const TOSS_IO = new Float64Array(1);
/** Kanäle von TossRig.out. */
export const TR_HX = 0;
export const TR_HY = 1;
export const TR_HZ = 2;
export const TR_FLEX = 3;
export const TR_OPEN = 4;
export const TR_THUMB = 5;
export const TR_RING = 6;
export const TR_CARRY = 7;

/**
 * Hand-Kanäle eines Wurfs zur Zeit `time` (Feld, kein Argument) in `out` — Spuren plus Nachgeben nach dem Fang. Eine
 * kleine Methode ohne Kommazahl-Argumente und -Rückgaben: verteilt auf die große Trick-Methode verlor V8 das Inlining
 * von Track.value/settle, jede zurückgegebene Kommazahl wurde eine HeapNumber (Dosen-Würfe ~80 B/Frame, fallen.md #107).
 */
export class TossRig {
  readonly out = new Float64Array(8);
  time = 0.5;
  /** Abwurf, Fang (Trick-Zeit), Ende; Drehrate des Flugs (rad/s) für den Restdrall. */
  readonly rel: number;
  readonly cat: number;
  readonly total: number;
  readonly spinRate: number;
  /** Scheitel (Einheiten), Drehungen um die Flugachse, Anteil "von der Handfläche weg" (PropFlight.setAway). */
  readonly apex: number;
  readonly turns: number;
  readonly away: number;
  /** Eigendrehung im Flug (rad/s, Twirl) — vorberechnet: aus einer Ganzzahl-Eigenschaft gerechnet boxte V8 je Frame. */
  readonly twirlRate: number;
  private readonly hx: Track;
  private readonly hy: Track;
  private readonly hz: Track;
  private readonly flex: Track;
  private readonly open: Track;
  private readonly thumb: Track;
  private readonly ring: Track;
  /** Nachgeben je Kanal: [Start, ω, ζ] für hy, flex, Finger, Restdrall (aus CatchGive, Ladezeit). */
  private readonly gp: Float64Array;
  /** Zeit, Zeit seit dem Fang, Nachgeben-Dauer (eval). */
  private readonly tb = new Float64Array(3);

  constructor(rel: number, air: number, total: number, apex: number, turns: number, away: number, tracks: TossTrackSet, give: CatchGive, spins = 0) {
    this.time = 0;
    this.twirlRate = (TAU * spins) / air;
    this.apex = apex;
    this.turns = turns;
    this.away = away;
    this.rel = rel;
    this.cat = rel + air;
    this.total = total;
    this.spinRate = (TAU * turns) / air;
    this.hx = tracks.hx ?? ZERO;
    this.hy = tracks.hy;
    this.hz = tracks.hz ?? ZERO;
    this.flex = tracks.flex;
    this.open = tracks.open;
    this.thumb = tracks.thumb ?? ZERO;
    this.ring = tracks.ring ?? ZERO;
    this.gp = Float64Array.of(give.hy, give.omega, give.zeta, give.flex, give.omega, give.zeta, give.fingers, TAU * 4.5, 0.5, -this.spinRate * give.carry, TAU * 3.4, 0.38);
  }

  /**
   * Alle Kanäle zur Zeit `time`. Je Kanal ein kleiner void-Helfer ohne Kommazahl-Argumente: in einer Methode sprengten
   * 7× Track.value + 4× settleIn das Inlining-Budget, Rückgaben/Argumente wurden HeapNumbers (~100 B/Frame je Wurf).
   */
  eval(): void {
    const tb = this.tb;
    tb[0] = this.time;
    tb[1] = this.time - this.cat;
    tb[2] = this.total - this.cat;
    this.track(this.hx, TR_HX);
    this.track(this.hy, TR_HY);
    this.give(TR_HY, 0);
    this.track(this.hz, TR_HZ);
    this.track(this.flex, TR_FLEX);
    this.give(TR_FLEX, 3);
    this.track(this.open, TR_OPEN);
    this.give(TR_OPEN, 6);
    this.track(this.thumb, TR_THUMB);
    this.track(this.ring, TR_RING);
    this.carry();
  }

  private track(tr: Track, k: number): void {
    tr.evalInto(this.tb, 0, this.out, k);
  }

  /** out[k] += Nachgeben nach dem Fang (Parameter gp[j..j+2]). */
  private give(k: number, j: number): void {
    this.settleAt(j, TOSS_IO, 0);
    this.out[k] += TOSS_IO[0];
  }

  private carry(): void {
    this.settleAt(9, this.out, TR_CARRY);
  }

  /**
   * dst[d] = settleIn(gp[j], tb[1], tb[2], gp[j+1], gp[j+2]) — dieselben Formeln wie settleIn/settle/smooth (bitgleich),
   * aber inline: als Aufrufe nicht immer geinlinet, Argumente und Rückgabe wurden HeapNumbers.
   */
  private settleAt(j: number, dst: Float64Array, d: number): void {
    const p = this.gp;
    const s = this.tb[1];
    const len = this.tb[2];
    if (!(s > 0) || s >= len) {
      dst[d] = 0;
      return;
    }
    const v = p[j];
    const omega = p[j + 1];
    const zeta = p[j + 2];
    const k = (s - 0.6 * len) / (0.4 * len);
    const x = k < 0 ? 0 : k > 1 ? 1 : k;
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    dst[d] = (v / wd) * Math.exp(-zeta * omega * s) * Math.sin(wd * s) * (1 - x * x * (3 - 2 * x));
  }

  /** Hand-Zustand zur Zeit `time` in den Flug (rel/cat von PropFlight), × motionFx. */
  handInto(dst: Float64Array, m: number): void {
    this.eval();
    const o = this.out;
    dst[0] = o[TR_HX] * m;
    dst[1] = o[TR_HY] * m;
    dst[2] = o[TR_HZ] * (0.6 + 0.4 * m);
    dst[3] = o[TR_FLEX] * m;
    dst[4] = 0;
    dst[5] = 0;
  }
}

/**
 * Gegenstand mit Griff (Plan 008): Finger-Versatz über jointAdd, freier Flug, und ein Abbruch (Ziel) blendet auch
 * die Finger über XFADE aus (PropTricks überblendet nur Hand und Handgelenk).
 */
export abstract class GripTricks<T extends string> extends PropTricks<T> {
  protected readonly flight = new PropFlight();
  /** Finger-Versatz beim Abbruch (schon × motionFx) und ob der laufende Trick ihn ausblendet. */
  private readonly ffStore = new Float32Array(VM_JOINT_COUNT);
  private ffPending = false;
  private ffActive = false;

  /** o.jointAdd += d · w (Daumen und Finger). */
  protected addJoints(o: PropOut, d: Float32Array, w: number): void {
    const ja = o.jointAdd;
    for (let i = JA.thumbAbd; i < VM_JOINT_COUNT; i++) ja[i] += d[i] * w;
  }

  /** Zeit und motionFx für flyToss (Felder statt Argumente, fallen.md #107.3). */
  protected ftT = 0.5;
  protected ftM = 0.5;
  private ftPlanned = false;

  /** Neuer Wurf: beim nächsten flyToss planen. */
  protected resetToss(): void {
    this.ftPlanned = false;
  }

  /**
   * Wurf mit TossRig zur Zeit ftT: planen (einmal, Abwurf/Fang exakt im Griff der Hand), Hand-Kanäle, Finger
   * (open > 0 öffnet, < 0 drückt mit `squeeze`), Daumen/Ring-Gewichte, Flug, Restdrall nach dem Fang. Rückgabe-frei.
   */
  protected flyToss(o: PropOut, rig: TossRig, openD: Float32Array, squeezeD: Float32Array | null, thumbD: Float32Array | null, ringD: Float32Array | null): void {
    const m = this.ftM;
    const f = this.flight;
    if (!this.ftPlanned) {
      this.ftPlanned = true;
      rig.time = rig.rel;
      rig.handInto(f.rel, m);
      rig.time = rig.cat;
      rig.handInto(f.cat, m);
      f.setAway(rig.away);
      f.plan(rig.cat - rig.rel, rig.apex, -TAU * rig.turns);
    }
    const t = this.ftT;
    rig.time = t;
    rig.eval();
    const v = rig.out;
    o.hx = v[TR_HX];
    o.hy = v[TR_HY];
    o.hz = v[TR_HZ];
    o.jointAdd[JA.wristFlex] += v[TR_FLEX];
    const fo = v[TR_OPEN];
    // Ohne Zusammenfluss aus Kommazahl und Ganzzahl-Konstante (fallen.md #107.2: `fo > 0 ? fo : 0` boxte zeitweise).
    this.addJoints(o, openD, Math.max(fo, 0.0));
    if (squeezeD) this.addJoints(o, squeezeD, Math.max(-fo, 0.0));
    if (thumbD) this.addJoints(o, thumbD, v[TR_THUMB]);
    if (ringD) this.addJoints(o, ringD, v[TR_RING]);
    if (t >= rig.rel && t < rig.cat) f.place(o, t - rig.rel, m);
    else if (t >= rig.cat && rig.turns !== 0) {
      f.carryAngle = v[TR_CARRY];
      f.carry(o);
    }
  }

  /** Stückweise linear durch Schlüssel-Posen keys[0..n] (Phase 0..n, 0 = Ruhe) — für einen Finger. */
  protected addKeys(o: PropOut, keys: readonly Float32Array[], phase: number): void {
    const n = keys.length - 1;
    const x = phase < 0 ? 0 : phase > n ? n : phase;
    const i = x >= n ? n - 1 : Math.floor(x);
    const f = x - i;
    const a = keys[i];
    const b = keys[i + 1];
    const ja = o.jointAdd;
    for (let k = JA.thumbAbd; k < VM_JOINT_COUNT; k++) ja[k] += a[k] + (b[k] - a[k]) * f;
  }

  /** Schlüssel-Folge zur Zeit t (vor dem ersten / nach dem letzten Eintrag: dessen Schlüssel). */
  protected addSeq(o: PropOut, keys: readonly Float32Array[], seq: KeySeq, time: number): void {
    const T = seq.t;
    const n = T.length;
    let i = 0;
    while (i < n - 2 && time >= T[i + 1]) i++;
    let f = n > 1 ? (time - T[i]) / (T[i + 1] - T[i]) : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const ease = seq.e[i];
    if (ease) f = ease(f);
    const a = keys[seq.k[i]];
    const b = keys[seq.k[n > 1 ? i + 1 : i]];
    const ja = o.jointAdd;
    for (let k = JA.thumbAbd; k < VM_JOINT_COUNT; k++) ja[k] += a[k] + (b[k] - a[k]) * f;
  }

  protected override onInterrupt(): void {
    this.ffStore.set(this.out.jointAdd);
    this.ffPending = true;
  }

  protected override start(id: T): void {
    super.start(id);
    this.ftPlanned = false;
    this.ffActive = this.ffPending;
    this.ffPending = false;
  }

  /** Nach einem Abbruch: alter Finger-Versatz klingt über XFADE ab (Trick-Zeit t des Belohnungs-Tricks). */
  protected fadeFingers(o: PropOut, t: number, m: number): void {
    if (!this.ffActive) return;
    const w = 1 - smooth(t / XFADE);
    if (w <= 0) {
      this.ffActive = false;
      return;
    }
    const s = this.ffStore;
    const ja = o.jointAdd;
    const k = w / m;
    for (let i = JA.thumbAbd; i < VM_JOINT_COUNT; i++) ja[i] += s[i] * k;
  }
}

// ------------------------------------------------------------------ Dose

/** Finger-Richtungen: offen (Hand öffnet im Flug) und Drücken (Richtung Faust). */
const OPEN_D = poseDelta(POSE.grip, POSE.open);
const SQUEEZE_D = poseDelta(POSE.grip, POSE.fist);

interface TossSpec {
  /** Abwurf (s), Flugzeit (s), Scheitel (Einheiten), Drehungen um die Bild-Tiefenachse, Eigendrehungen. */
  readonly rel: number;
  readonly air: number;
  readonly apex: number;
  readonly turns: number;
  readonly twirl: number;
  /** Fang woanders (Wurf hinter die Hand): Hand nach rechts (Bildhöhen) und von der Kamera weg (Einheiten). */
  readonly catchHx: number;
  readonly catchHz: number;
  readonly total: number;
  /** Ruck an die Hand beim Fang (Bildhöhen/s), Stauchen. */
  readonly catchKick: number;
  readonly catchSquash: number;
  /** Anteil "von der Handfläche weg" der Flugrichtung (PropFlight.setAway): Doppel-Drehungen brauchen mehr Abstand. */
  readonly away: number;
}

const TOSS: { readonly [K in CanTrick]?: TossSpec } = {
  flip: { rel: 0.16, air: 0.38, apex: 8.5, turns: 1, twirl: 0, catchHx: 0, catchHz: 0, total: 0.8, catchKick: 0.35, catchSquash: 1.0, away: 0.52 },
  highFlip: { rel: 0.18, air: 0.46, apex: 11.5, turns: 1, twirl: 0, catchHx: 0, catchHz: 0, total: 0.95, catchKick: 0.42, catchSquash: 1.2, away: 0.52 },
  twirl: { rel: 0.13, air: 0.3, apex: 3.5, turns: 0, twirl: 2, catchHx: 0, catchHz: 0, total: 0.8, catchKick: 0.25, catchSquash: 0.7, away: 0.52 },
  doubleFlip: { rel: 0.19, air: 0.52, apex: 13, turns: 2, twirl: 1, catchHx: 0, catchHz: 0, total: 1.0, catchKick: 0.48, catchSquash: 1.3, away: 0.7 },
  behindThrow: { rel: 0.2, air: 0.56, apex: 11, turns: 2, twirl: 1, catchHx: -0.02, catchHz: 7, total: 1.2, catchKick: 0.5, catchSquash: 1.3, away: 0.85 },
};

/** Spuren eines Wurfs (Ladezeit, je Trick): Hand-Höhe, Handgelenk, Finger, Hand-Weg zum Fang. */
function tossTracks(s: TossSpec): TossTrackSet {
  const r = s.rel;
  const c = s.rel + s.air;
  const big = s.apex / 10;
  // Ausholen: Hand sinkt, Handgelenk spannt (Dose kippt nach unten/zur Kamera), Finger drücken — dann der Schnipp
  // nach oben (Handgelenk über die Neutrale hinaus), Abwurf am schnellsten Punkt, Hand federt zurück, greift dem
  // Fang ein Stück entgegen und gibt beim Fang nach (Nachfedern kommt geschlossen dazu, siehe evaluate).
  const hy: Key[] = [
    [0, 0, sineInOut],
    [r - 0.09, 0.016 + 0.01 * big, quadIn],
    [r, -0.022 - 0.01 * big, quadOut],
    [r + 0.14, -0.004, sineInOut],
    [c - 0.09, -0.013, sineInOut],
    [c, -0.008, sineInOut],
    [c + 0.3, 0],
  ];
  const flex: Key[] = [
    [0, 0, sineInOut],
    [r - 0.09, 0.3 + 0.05 * big, quadIn],
    [r, -0.26 - 0.06 * big, quadOut],
    [r + 0.16, -0.05, sineInOut],
    [c, -0.04, sineInOut],
    [c + 0.32, 0],
  ];
  const open: Key[] = [
    [0, 0, sineInOut],
    [r - 0.05, 0, quadIn],
    [r + 0.025, 0.78, quadOut],
    [r + 0.1, 1, sineInOut],
    [c - 0.12, 0.85, sineInOut],
    [c - 0.02, 0.62, quadIn],
    [c + 0.04, 0, quadOut],
    [c + 0.25, 0],
  ];
  // Die Dose fliegt schräg (von der Handfläche weg nach links oben): die Hand zieht beim Wurf nach rechts mit, damit der
  // Bogen rechts von der Bildmitte bleibt (Bild-Hülle der abgenommenen Tricks, look.md).
  const drift = 0.085 * big * (s.away / 0.52) + s.catchHx;
  const hx: Key[] = [
    [0, 0, sineInOut],
    [r, 0.4 * drift, sineInOut],
    [c, drift, sineInOut],
    [c + 0.12, drift, cubicInOut],
    [s.total - 0.02, 0],
  ];
  const hz: Key[] = s.catchHz !== 0 ? [[0, 0], [r, 1, sineInOut], [c, s.catchHz, sineInOut], [c + 0.12, s.catchHz, cubicInOut], [s.total - 0.02, 0]] : [[0, 0]];
  return { hy: new Track(hy), flex: new Track(flex), open: new Track(open), hx: new Track(hx), hz: new Track(hz) };
}

function canRig(s: TossSpec): TossRig {
  const k = s.catchKick / 0.4;
  return new TossRig(
    s.rel,
    s.air,
    s.total,
    s.apex,
    s.turns,
    s.away,
    tossTracks(s),
    {
      hy: CATCH_HY_V * k,
      flex: CATCH_FLEX_V * k,
      fingers: CATCH_FING_V,
      carry: CATCH_SPIN_CARRY,
      omega: CATCH_W,
      zeta: CATCH_Z,
    },
    s.twirl,
  );
}

/** Nachgeben beim Fang: Hand (Bildhöhen/s), Handgelenk (rad/s), Finger (Anteil/s) — Eigenfrequenz, Dämpfung. */
const CATCH_HY_V = 0.55;
const CATCH_FLEX_V = 3.2;
const CATCH_FING_V = 1.6;
const CATCH_W = TAU * 3.3;
const CATCH_Z = 0.42;
const CATCH_SPIN_CARRY = 0.06;

const CAN_RIGS: { readonly [K in CanTrick]?: TossRig } = {
  flip: canRig(TOSS.flip as TossSpec),
  highFlip: canRig(TOSS.highFlip as TossSpec),
  twirl: canRig(TOSS.twirl as TossSpec),
  doubleFlip: canRig(TOSS.doubleFlip as TossSpec),
  behindThrow: canRig(TOSS.behindThrow as TossSpec),
};

const COOLDOWN = { tilt: 0.3, crack: 0.6, sip: 0.8, flip: 1.3, highFlip: 0.95, twirl: 0.95, doubleFlip: 0.7, behindThrow: 0.7, surfBalance: 0.5 } as const;

/** Surf-Balance (KI8): Dosen-Boden (Halbhöhe 7.8 + Luft) auf der Zeigefinger-Kuppe der Pose point. */
const SURF_FROM = 500;
const SURF_MIN = 0.5;
const BAL_IN = 0.35;
const BAL_OUT = 0.3;
const BAL_HOP = 2.2;
const BAL_LOWER = 0.07;
const BAL_AWAY = 6;
/** Einlage im Surf-Zustand: Scheitel des Hüpfers (Einheiten, wie der Hopser beim Wechsel). */
const BEAT_HOP = 2.4;
/** Halbhöhe + Luft über der Kuppe (0.25 → 0.7: der Dosenboden steckte 0.45 in der Kuppe). */
const CAN_HALF = 7.8 + 0.7;
const BAL_TIP: V3 = ((): V3 => {
  const t: [number, number, number] = [0, 0, 0];
  fingerTip(POSE_JOINTS[POSE.point], 0, t, 0.6);
  return t;
})();
/** Aufrecht, Blitz leicht zur Bildmitte gedreht (man sieht das Etikett). */
const BAL_ROT: V3 = viewRot([[1, -0.5]]);
const BAL_REL = relRot(CAN_HOLD_ROT, BAL_ROT);

// ---------------------------------------------------------------- crack (Lasche)

const CRACK_TIME = 1.15;
const CRACK_CALM_AFTER = 1.2;
const CRACK_LATEST = 12;
/** Pssht: ab hier offen (Tests: Lasche bei 0.2 s zu, bei 0.45 s oben, bei 1.0 s wieder flach). */
const PSSHT = 0.46;
/**
 * Nachgreifen: die Dose rutscht 2.5 Einheiten entlang ihrer Achse nach unten (Handgelenk +x), damit der Zeigefinger
 * den Deckelrand erreicht (IK: ohne Rutschen fehlten 1.5 Einheiten bei 45° Spreizung).
 */
const CRACK_SLIDE = new Track([
  [0, 0, quadIn],
  [0.1, 2.65, quadOut],
  [0.15, 2.5, sineInOut],
  [0.86, 2.5, cubicIn],
  [0.95, -0.25, quadOut],
  [1.02, 0, sineInOut],
]);
/**
 * Zeigefinger (gebackene IK gegen das Griff-Modell der gerutschten Dose, tools/hand-grips-Stil): 1 über dem Rand,
 * 2 unter dem Laschen-Ende, 3 Lasche ~37° hochgezogen (weiter reicht der Finger nicht — sie schnappt allein auf),
 * 4 abgerutscht/eingerollt. Phase-Spur läuft 0 → 4 → 2 (drückt die Lasche flach) → 0.
 */
const INDEX_KEYS: readonly Float32Array[] = [
  fingerKey(0, [0, 0, 0, 0]),
  fingerKey(0, [0.647, 0.165, 0.12, -0.152]),
  fingerKey(0, [0.723, -0.04, 0.63, -0.344]),
  fingerKey(0, [0.764, -0.143, 0.644, -0.107]),
  fingerKey(0, [0.809, -0.196, 0.536, 0.191]),
];
const INDEX_PHASE = new Track([
  [0, 0],
  [0.07, 0, sineInOut],
  [0.2, 1, sineInOut],
  [0.27, 2, cubicIn],
  [0.42, 3, quadOut],
  [0.5, 4, sineInOut],
  [0.58, 2.6, sineInOut],
  [0.7, 2, sineInOut],
  [0.76, 1, sineInOut],
  [0.9, 0],
]);
/** Daumen weicht vom Deckel an dessen Rand (die Dose ist weggerutscht). */
const THUMB_CRACK = fingerKey(4, [0.006, -0.319, 0.41, 0.666]);
const THUMB_CRACK_W = new Track([
  [0, 0, sineInOut],
  [0.12, 1],
  [0.86, 1, sineInOut],
  [0.98, 0],
]);
/** Lasche: Finger zieht bis ~0.5, dann schnappt sie auf (Überschwinger), wird flach gedrückt. */
const CRACK_TAB = new Track([
  [0, 0],
  [0.27, 0, sineInOut],
  [0.41, 0.5, quadIn],
  [0.445, 1.06, quadOut],
  [0.5, 1, sineInOut],
  [0.58, 1, sineInOut],
  [0.72, 0.06, quadOut],
  [0.9, 0],
]);
/** Finger lösen sich kurz beim Nachgreifen (rutschen) und beim Zurückhüpfen. */
const CRACK_LOOSE = new Track([
  [0, 0, sineInOut],
  [0.04, 0.2, sineInOut],
  [0.13, 0, sineInOut],
  [0.84, 0, sineInOut],
  [0.89, 0.22, sineInOut],
  [0.99, 0],
]);
/** Hand: hebt den Deckel ins Bild (Neigung) und hüpft die Dose zurück (Höhe). */
const CRACK_LIFT = new Track([
  [0, 0],
  [0.1, 0, sineInOut],
  [0.3, 1, sineInOut],
  [0.75, 1, sineInOut],
  [1.05, 0],
]);
const CRACK_HOP = new Track([
  [0, 0, sineInOut],
  [0.06, 0.012, sineInOut],
  [0.14, 0, sineInOut],
  [0.82, 0, sineInOut],
  [0.88, 0.016, quadOut],
  [0.95, -0.014, sineInOut],
  [1.06, 0.002, sineInOut],
  [1.15, 0],
]);

// ---------------------------------------------------------------- Schluck, Schwenken

const SIP_TIME = 1.8;
const SIP_EVERY = 5.5;
/** Weg zum Mund 0..1 mit kleinem Ausholen und Überschwingen, zurück mit Ease-in/out. */
const SIP_UP = new Track([
  [0, 0, sineInOut],
  [0.1, -0.05, cubicInOut],
  [0.5, 1.03, sineInOut],
  [0.62, 1, sineInOut],
  [1.22, 1, cubicInOut],
  [1.62, -0.025, sineInOut],
  [1.72, 0.008, sineInOut],
  [1.8, 0],
]);
/** Dose kippt beim Trinken weiter (Seitneigung des Handgelenks: Deckel zur Kamera), drei Schlucke. */
const SIP_TILT = new Track([
  [0, 0],
  [0.35, 0, sineInOut],
  [0.62, 0.14, sineInOut],
  [1.12, 0.3, sineInOut],
  [1.45, 0],
]);
const GULPS = [0.66, 0.88, 1.1] as const;
const GULP_T = 0.16;

const TILT_TIME = 1.0;

export class CanTricks extends GripTricks<CanTrick> {
  /** Dose in diesem Leben geöffnet. */
  opened = false;
  /** Crack-Ereignis seit dem letzten Abholen (Zisch-Sound, Tools). */
  cracked = false;
  private groundTime = 0;
  private sipNext = 0;
  private pick2 = 0;
  private pick3 = 0;
  private idleCount = 0;
  private surfOut = -1;
  private readonly tmp = new Float64Array(3);

  constructor() {
    super();
    this.flight.setHold(CAN_HOLD_POS, CAN_HOLD_ROT);
  }

  override get trickNames(): readonly string[] {
    return CAN_NAMES;
  }

  protected override isState(id: CanTrick): boolean {
    return id === 'surfBalance';
  }

  protected override start(id: CanTrick): void {
    super.start(id);
    this.surfOut = -1;
  }

  protected resetRun(): void {
    this.opened = false;
    this.cracked = false;
    this.groundTime = 0;
    this.sipNext = 0;
    this.writeRest(this.out);
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.grip;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = CAN_HOLD_POS[0];
    o.pos[1] = CAN_HOLD_POS[1];
    o.pos[2] = CAN_HOLD_POS[2];
    o.rot[0] = CAN_HOLD_ROT[0];
    o.rot[1] = CAN_HOLD_ROT[1];
    o.rot[2] = CAN_HOLD_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.canTab = 0;
    o.canOpen = this.opened;
    o.poof = -1;
  }

  protected cooldownOf(id: CanTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    if (tier === 1) this.start('flip');
    else if (tier === 2) this.start(good ? (this.pick2++ % 2 === 0 ? 'highFlip' : 'twirl') : CAN_TIER_TRICKS[2][this.pick2++ % 3]);
    else this.start(good ? (this.pick3++ % 2 === 0 ? 'doubleFlip' : 'behindThrow') : CAN_TIER_TRICKS[3][this.pick3++ % 4]);
  }

  protected onMilestone(tier: number): void {
    if (tier >= 3) this.start('behindThrow');
    else if (tier === 2) this.start('highFlip');
  }

  protected onIdle(): number {
    if (this.opened && this.now >= this.sipNext) {
      this.start('sip');
      this.sipNext = this.now + SIP_EVERY;
    } else this.start(this.idleCount++ % 2 === 0 ? 'tilt' : 'twirl');
    return 2.6 + 1.8 * this.rand();
  }

  protected override onLand(k: number, queued: boolean, speed: number): void {
    // Ruhige Landung (kein Bhop, langsam, nicht zu hart): ab und zu ein Schluck.
    if (!queued && speed < 250 && k < 0.9 && this.opened && this.now >= this.sipNext && this.rand() < 0.5) {
      this.start('sip');
      this.sipNext = this.now + SIP_EVERY;
    }
  }

  protected override onFinish(): void {
    if (this.opened) this.start('sip');
    else this.start('behindThrow');
  }

  /** Training (KI9): Stufe = Twirl (Jubel), Lektion fertig = wie das Ziel. */
  protected override onLesson(done: boolean): void {
    if (done) this.onFinish();
    else this.start('twirl');
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('surfBalance');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) {
      this.start('surfBalance');
      return;
    }
    if (this.opened) return;
    const calm = inp.onGround && !inp.surfing && speed < 300;
    if (calm && this.groundTime >= CRACK_CALM_AFTER) this.start('crack');
    else if (inp.onGround && this.groundTime >= CRACK_LATEST) this.start('crack');
  }

  override update(dt: number, inp: PropFrameInput): void {
    const d = dt - dt === 0 ? clamp(dt, 0, 0.1) : 0;
    // Ruhezeit für den Crack: am Boden zählen, im Tempo-Flow nur langsam.
    if (inp.onGround && !inp.surfing) this.groundTime += inp.speed < 300 ? d : d * 0.1;
    super.update(dt, inp);
  }

  protected evaluate(id: CanTrick, t: number, _dt: number, inp: PropFrameInput, m: number, o: PropOut): boolean {
    let done: boolean;
    if (id === 'tilt') done = this.tilt(t, o);
    else if (id === 'crack') done = this.crack(t, o);
    else if (id === 'sip') done = this.sip(t, o);
    else if (id === 'surfBalance') done = this.surfBalance(t, inp, o);
    else done = this.toss(id, t, m, o);
    this.fadeFingers(o, t, m);
    return done;
  }

  /**
   * Wurf (Flip, Twirl, Doppel-Flip, hinter die Hand): Ausholen → Schnipp → echte Parabel mit konstanter Drehung →
   * Fang am Griff mit Nachgeben (Hand, Handgelenk, Finger federn) und mitgenommenem Restdrall.
   */
  private toss(id: CanTrick, t: number, m: number, o: PropOut): boolean {
    const s = TOSS[id];
    const rig = CAN_RIGS[id];
    if (!s || !rig) return true;
    this.ftT = t;
    this.ftM = m;
    this.flyToss(o, rig, OPEN_D, SQUEEZE_D, null, null);
    rig.time = t;
    this.spinOf(o, rig);
    if (this.mark(2, rig.cat, t)) this.kick(o, s.catchKick, -s.catchSquash);
    return t >= s.total;
  }

  /** Eigendrehung im Flug (Twirl): konstante Rate, Zeit aus rig.time (Felder statt Kommazahl-Argumenten). */
  private spinOf(o: PropOut, rig: TossRig): void {
    const t = rig.time;
    if (t >= rig.rel && t < rig.cat) o.spin = rig.twirlRate * (t - rig.rel);
  }

  /**
   * Leerlauf: offen schwenkt die Hand die Dose (Handgelenk kreist zweimal — Flüssigkeit schwappt), zu dreht sie die
   * Dose prüfend ins Licht.
   */
  private tilt(t: number, o: PropOut): boolean {
    const u = t / TILT_TIME;
    if (u >= 1) return true;
    const env = Math.sin(Math.PI * u);
    const e2 = env * env;
    if (this.opened) {
      const a = TAU * 2 * u;
      o.jointAdd[JA.wristFlex] += 0.11 * e2 * Math.sin(a);
      o.jointAdd[JA.wristDev] += 0.11 * e2 * (1 - Math.cos(a)) * 0.5;
      o.hx = 0.004 * e2 * Math.cos(a);
      o.hy = -0.004 * e2 * Math.sin(a);
      // Die schwappende Flüssigkeit zieht nach: kleiner Nachlauf um die Bild-Tiefenachse.
      this.rotateView(o, 0, 0, 1, 0.05 * e2 * Math.sin(a - 0.9));
    } else {
      o.jointAdd[JA.wristTwist] += 0.32 * e2;
      o.jointAdd[JA.wristFlex] -= 0.1 * e2;
      o.hy = -0.012 * e2;
    }
    return false;
  }

  /** Lasche: Nachgreifen, Zeigefinger hebelt, Pssht, flach drücken, zurückhüpfen (siehe Kopf). */
  private crack(t: number, o: PropOut): boolean {
    if (t >= CRACK_TIME) return true;
    o.pos[0] += CRACK_SLIDE.value(t);
    const lift = CRACK_LIFT.value(t);
    o.hy = -0.025 * lift + CRACK_HOP.value(t);
    o.hpitch = 0.3 * lift;
    o.hroll = 0.1 * lift;
    o.jointAdd[JA.wristDev] += 0.12 * lift;
    this.addKeys(o, INDEX_KEYS, INDEX_PHASE.value(t));
    this.addJoints(o, THUMB_CRACK, THUMB_CRACK_W.value(t));
    this.addJoints(o, OPEN_D, CRACK_LOOSE.value(t));
    o.canTab = CRACK_TAB.value(t);
    // Pssht: die Dose zuckt (Handgelenk federt kurz), offen bis Respawn.
    const sp = t - PSSHT;
    o.jointAdd[JA.wristDev] += settleIn(-2.2, sp, 0.4, TAU * 6, 0.35);
    o.jointAdd[JA.wristFlex] += settleIn(1.2, sp, 0.4, TAU * 6, 0.35);
    if (this.mark(0, PSSHT, t) || (t >= PSSHT && !this.opened)) {
      if (!this.opened) this.cracked = true;
      this.opened = true;
      this.kick(o, 0.12, -0.3);
    }
    o.canOpen = this.opened;
    return false;
  }

  /**
   * Surf-Balance (KI8): Hopser aus dem Griff auf die Zeigefinger-Kuppe, aufrecht balancieren (Boden auf
   * der Kuppe — Drehpunkt dort, nicht in der Dosen-Mitte), gegen die Rampe lehnen, leise wackeln.
   */
  private surfBalance(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const inE = smooth(t / BAL_IN);
    const outE = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / BAL_OUT);
    const e = inE * (1 - outE);
    this.rotateLocal(o, BAL_REL[0], BAL_REL[1], BAL_REL[2], BAL_REL[3] * e);
    const wob = 0.07 * Math.sin(t * 5.3) + 0.04 * Math.sin(t * 8.9 + 1);
    // Leicht nach rechts (weg von der Bildmitte), gegen die Rampe gelehnt.
    this.rotateView(o, 0, 0, 1, (0.3 * this.surfLean - 0.14 + wob) * e);
    const p = this.tmp;
    socketPoint(BAL_TIP, o.rot, 0, 1, 0, CAN_HALF, 0, p);
    // Hopser beim Wechsel (rein und raus), Bogen über die Bahn.
    const hop = BAL_HOP * (this.surfOut < 0 ? Math.sin(Math.PI * clamp(t / BAL_IN, 0, 1)) : Math.sin(Math.PI * clamp((t - this.surfOut) / BAL_OUT, 0, 1)));
    for (let k = 0; k < 3; k++) o.pos[k] = CAN_HOLD_POS[k] + (p[k] - CAN_HOLD_POS[k]) * e;
    // Plan 008: auf dem Weg Griff ↔ Kuppe springt die Dose von der Handfläche weg (Handgelenk −z) — geradlinig
    // überblendet lief sie durch Handfläche und Zeigefinger (−2.0).
    const hopE = Math.sin(Math.PI * e);
    o.pos[2] -= BAL_AWAY * hopE;
    // −z zeigt im Bild nach links unten (Richtung Bildmitte): diesen Anteil zurücknehmen — bleibt der Weg zur Kamera.
    this.offsetView(o, 0.87 * BAL_AWAY * hopE, 0.39 * BAL_AWAY * hopE, 0);
    // Finger lassen los, solange die Dose springt (sonst lag sie in den eingerollten Fingern).
    this.addJoints(o, OPEN_D, 0.9 * hopE);
    this.offsetView(o, 0, hop, 0);
    // Einlage (PropTricks.beatU): Dose hüpft von der Kuppe, dreht sich einmal um die eigene Achse, landet wieder.
    const u = this.beatU;
    if (u < 1) {
      this.offsetView(o, 0, BEAT_HOP * arc(u) * e, 0);
      o.spin = TAU * smooth(u);
    }
    if (this.beatEnd()) this.kick(o, 0.14, -0.35);
    o.pose = e > 0.35 ? POSE.point : POSE.grip;
    o.poseTau = 0.06;
    // Hand tiefer: die aufrechte Dose ragt sonst bis an die Hülle der Tricks (−0.31 Bildhöhen).
    o.hy = BAL_LOWER * e;
    if (this.mark(0, BAL_IN, t)) this.kick(o, 0.12, -0.3);
    if (this.surfOut >= 0 && this.mark(1, this.surfOut + BAL_OUT, t)) this.kick(o, 0.2, -0.5);
    // Endet erst nach einer laufenden Einlage (sonst spränge die Drehung auf 0).
    return this.surfOut >= 0 && t >= this.surfOut + BAL_OUT && u >= 1;
  }

  /**
   * Schluck: Ease-in/out zum Mund (links oben, zur Kamera, Deckel kippt zu uns), drei Schlucke — jeder kippt die
   * Dose ein Stück weiter, die Hand drückt kurz nach —, zurück mit Nachwippen.
   */
  private sip(t: number, o: PropOut): boolean {
    if (t >= SIP_TIME) return true;
    const up = SIP_UP.value(t);
    o.hx = -0.145 * up;
    o.hy = -0.08 * up;
    o.hz = 8 * up;
    o.hpitch = 1.45 * up;
    o.hroll = 0.5 * up;
    o.hyaw = 0.3 * up;
    // Verzweigungsfrei (fallen.md #107.2): außerhalb eines Schlucks ist sin(π·clamp(u)) = 0.
    const g0 = Math.sin(Math.PI * clamp((t - GULPS[0]) / GULP_T, 0, 1));
    const g1 = Math.sin(Math.PI * clamp((t - GULPS[1]) / GULP_T, 0, 1));
    const g2 = Math.sin(Math.PI * clamp((t - GULPS[2]) / GULP_T, 0, 1));
    const g = g0 * g0 + g1 * g1 + g2 * g2;
    o.jointAdd[JA.wristDev] += SIP_TILT.value(t) + 0.06 * g;
    o.hy += 0.004 * g;
    this.addJoints(o, SQUEEZE_D, 0.012 * g);
    return false;
  }
}

