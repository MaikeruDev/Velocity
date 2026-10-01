import { VM_ARM_BASE, VM_KNIFE } from '../../render/types';
import { BASE_ANGLE, BASE_AX, BASE_AY, BASE_GX, BASE_GY, BASE_RATE, PlanarChain } from './chain';
import type { ChainDriver, LinkDef } from './chain';
import type { Track } from './curves';
import type { HandShape } from './handShape';
import type { PropShape } from './propShape';
import { fromEulerXYZV, toEulerXYZ } from './rot';
import type { Mat3 } from './rot';

/**
 * Butterfly-Messer als Mechanik (Plan 008): zwei Glieder an zwei Stiften — Klinge um den Stift des Safe
 * Handle (gehalten, Basis), Bite Handle um den zweiten Stift im Klingen-Tang. Maße aus VM_KNIFE (render/types,
 * gleich wie items/knife). Massen wie ein Trainer (~45 g Klinge, je ~55 g Griff), Trägheit als Stab.
 */

const K = VM_KNIFE;
export const KNIFE_HANDLE_MID = K.pinInset - K.handleLen / 2;
export const KNIFE_BLADE_MID = K.bladeFrom + K.bladeLen / 2;

const BLADE_M = 0.45;
const HANDLE_M = 0.55;
const rod = (m: number, l: number, w: number): number => (m * (l * l + w * w)) / 12;

/**
 * Glieder der Kette: 0 = Klinge (relativ zum Safe Handle, Grenzen 0 = offen … π = zu: Kicker am Stopp-Stift),
 * 1 = Bite Handle (relativ zur Klinge, frei — Griff gegen Griff ist ein Kontakt, kein Gelenk-Anschlag).
 */
export const KNIFE_LINKS: readonly LinkDef[] = [
  {
    mass: BLADE_M,
    inertia: rod(BLADE_M, K.bladeLen, K.bladeW),
    com: [K.pinGap / 2, KNIFE_BLADE_MID],
    next: [K.pinGap, 0],
    friction: 0.0025,
    limit: [0, Math.PI, 0.18],
  },
  {
    mass: HANDLE_M,
    inertia: rod(HANDLE_M, K.handleLen, K.handleW),
    com: [0, KNIFE_HANDLE_MID],
    friction: 0.0025,
  },
];

/**
 * Glieder des PropShape (Kontakt-Körper, propShapes.knife): 0 = Safe Handle am Sockel (R, pos, scale),
 * 1 = Klinge = Sockel · Rz(blade), 2 = Bite Handle = Klinge · T(pinGap, 0, 0) · Rz(bite). Keine Allokation.
 */
export function knifeLinks(shape: PropShape, R: Mat3, pos: ArrayLike<number>, scale: number, blade: number, bite: number): void {
  const m = LM;
  // Klinge: R · Rz(blade)
  rzMul(R, blade, m);
  shape.setLink(1, m, pos[0], pos[1], pos[2], scale);
  // Bite-Stift: pos + R·Rz(blade)·(pinGap, 0, 0)·scale
  const px = pos[0] + m[0] * K.pinGap * scale;
  const py = pos[1] + m[3] * K.pinGap * scale;
  const pz = pos[2] + m[6] * K.pinGap * scale;
  rzMul(m, bite, LM2);
  shape.setLink(2, LM2, px, py, pz, scale);
}

const LM = new Float64Array(9);
const LM2 = new Float64Array(9);

/** out = A · Rz(a) (A Zeilen-Hauptordnung). */
function rzMul(A: ArrayLike<number>, a: number, out: Float64Array): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let r = 0; r < 3; r++) {
    const x = A[r * 3];
    const y = A[r * 3 + 1];
    out[r * 3] = x * c + y * s;
    out[r * 3 + 1] = -x * s + y * c;
    out[r * 3 + 2] = A[r * 3 + 2];
  }
}

// ------------------------------------------------------------------ Simulation (Plan 008)

/** Kanäle einer Messer-Bewegung zur Trick-Zeit (KnifeMotion.at → out). */
export const KM = {
  /** Hand-Versatz wie PropOut: Bildhöhen (x rechts, y unten), Einheiten zur Kamera, rad (pitch, yaw, roll). */
  hx: 0,
  hy: 1,
  hz: 2,
  pitch: 3,
  yaw: 4,
  roll: 5,
  /** Handgelenk-Versatz (rad, wie jointAdd: Beugen, Neigen, Drehen). */
  flex: 6,
  dev: 7,
  twist: 8,
  /** Safe Handle relativ zur Ruhe-Lage im Sockel: Drehung in der Messer-Ebene (rad) um (cx, cy), Versatz (Einheiten). */
  spin: 9,
  ox: 10,
  oy: 11,
  /** Griff/Führung 0..1 (Finger schließen sich um die Griffe → zieht zu den Zielwinkeln) und Ziel der Klinge (0 offen, π zu). */
  grip: 12,
  gripBlade: 13,
  /** Riegel 0..1 (VM_PARAM.knife.latch). */
  latch: 14,
  /** Safe Handle aus der Ebene heraus (Einheiten entlang der Messer-Normalen, + = Daumenseite/Kamera). */
  oz: 15,
  /** Überschlag (rad) um die Achse flipAxis durch flipAt (Messer-Raum): Rollover über den Zeigefinger. */
  flip: 16,
  /** Bühne: zusätzlicher Hand-Versatz (Bildhöhen) während des Tricks — Tricks laufen rechts unten, nie im Blickzentrum. */
  sx: 17,
  sy: 18,
} as const;
export const KM_COUNT = 19;

export interface KnifeMotion {
  /** Drehpunkt der Sockel-Drehung `spin` im Safe-Handle-Raum (Konstante je Trick). */
  readonly cx: number;
  readonly cy: number;
  /** Achse (normiert) und Punkt des Überschlags `flip` im Safe-Handle-Raum; ohne = kein Überschlag. */
  readonly flipAxis?: readonly [number, number, number];
  readonly flipAt?: readonly [number, number, number];
  at(t: number, out: Float64Array): void;
}

/** Bildhöhe in Hand-Einheiten bei Spiel-Tiefe (ViewModel: 2 · VM_DEPTH 40 · tan(54°/2)). */
export const VIEW_UNIT = 2 * 40 * Math.tan((54 * Math.PI) / 360);
/** Schwerkraft (Hand-Einheiten ≈ cm/s²). */
export const KNIFE_G = 981;
/** Griff-Führung: Steifigkeit/Dämpfung (Drehmoment je rad bzw. rad/s) bei grip = 1. */
const GRIP_K = 42000;
const GRIP_D = 1300;
/** Hand gegen Bite Handle/Klinge: Feder-Dämpfer (weicher als Griff gegen Griff: Handschuh gibt nach). */
const HAND_K = 14000;
const HAND_D = 90;
/** Abtastpunkte entlang Bite Handle und Klinge für den Hand-Kontakt (je Kante). */
const HAND_PTS = 7;
/** Griff gegen Griff: Feder-Dämpfer-Kontakt (Kraft je Einheit Überlappung bzw. Einheit/s). */
const CONTACT_K = 120000;
const CONTACT_D = 300;
const TAU = Math.PI * 2;
const ZERO3: readonly [number, number, number] = [0, 0, 0];

/**
 * Butterfly-Simulation: Klinge und Bite Handle als Pendel-Kette am gehaltenen Safe Handle. Der Antrieb ist die
 * Bewegung der HAND (KnifeMotion: Handgelenk-Flicks, Arm, Sockel-Drehung, Überschlag beim Rollover, Wurfbahn beim
 * Aerial). Gerechnet wird im mitbewegten Messer-Raum: Drehung in der Ebene (θ, integriert aus der Winkel-
 * geschwindigkeit um die Messer-Normale), Stift-Beschleunigung und Schwerkraft in den aktuellen Messer-Achsen,
 * dazu die Fliehkraft aus Drehungen AUS der Ebene (Überschlag) — so bleibt die Kette auch richtig, wenn sich die
 * Messer-Ebene im Raum dreht. Die Bewegung ist eine geschlossene Funktion der Trick-Zeit (numerisch differenziert).
 * Ergebnis: Klinge/Bite relativ, wie ViewModelFrame.knifeBlade/knifeBite. Keine Allokation nach dem Konstruktor.
 */
export class KnifeSim implements ChainDriver {
  readonly chain: PlanarChain;
  motion: KnifeMotion | null = null;
  /** Ruhe-Lage des Safe Handle im Handgelenk-Raum (Stift) und Sockel-Drehung (Euler XYZ). */
  readonly restPos = new Float64Array(3);
  readonly restRot = new Float32Array(3);
  private readonly ch = new Float64Array(KM_COUNT);
  /** Winkel der Basis in der Ketten-Ebene (integriert), Rate um die Normale, Zeit des letzten base(). */
  private theta = 0.5;
  private rate = 0.5;
  private tLast = 0.5;
  private fresh = true;
  /** Winkelgeschwindigkeit AUS der Ebene (Messer-x/-y-Anteile) für die Fliehkraft. */
  private readonly omP = new Float64Array(2);
  // Scratch
  private readonly S = new Float64Array(9);
  private readonly R = new Float64Array(9);
  private readonly F = new Float64Array(9);
  /** Sockel im Handgelenk-Raum: Stift (0–2), Achsen x (3–5), y (6–8). */
  private readonly W = new Float64Array(9);
  private readonly A = new Float64Array(9);
  private readonly MT = new Float64Array(9);
  private readonly P = new Float64Array(3);
  private readonly Xv = new Float64Array(3);
  private readonly Yv = new Float64Array(3);
  private readonly Zv = new Float64Array(3);
  /** Achsen bei t − h / t + h (je 9: x, y, z). */
  private readonly Em = new Float64Array(9);
  private readonly Ep = new Float64Array(9);
  private readonly q2 = new Float64Array(2);
  private readonly v2 = new Float64Array(2);
  private readonly e3 = new Float32Array(3);
  /** Griff-Kontakt: größte Überlappung seit start() (Tests: kein Durchdringen). */
  contactMax = 0.5;
  /**
   * Hand als Hindernis (Pose des Tricks, Handgelenk-Raum): der Bite Handle prallt an Fingern/Handfläche ab statt
   * hindurchzuschwingen (so "landet" er in der Hand); die Klinge ebenso (Tests: sie darf nie berühren). null = aus.
   */
  hand: HandShape | null = null;
  /** Tiefste Hand-Überlappung je Glied seit start() (0 Klinge, 1 Bite Handle). */
  readonly handMax = new Float64Array(2);
  private handScale = 0.5;
  /** Überschlag: Achse (0–2), Punkt (3–5), an (6); Drehpunkt der Ebenen-Drehung (cx, cy) — bei start() kopiert. */
  private readonly fa = new Float64Array(7);
  private readonly faPt = new Float64Array(3);
  private readonly mc = new Float64Array(2);
  /** Zeit für socket()/frameAt() (Feld statt Argument, siehe ChainDriver). */
  private tq = 0.5;
  /** Argument-Puffer (Punkt lokal, Kraft) und Hand-Probe — Frame-Pfad ohne Kommazahl-Argumente (fallen.md #107). */
  private readonly arg = new Float64Array(4);
  private readonly hp = new Float64Array(3);

  constructor() {
    this.chain = new PlanarChain(KNIFE_LINKS, this, 1 / 960);
    this.theta = 0;
    this.rate = 0;
    this.tLast = 0;
    this.contactMax = 0;
    this.handScale = 1;
    rotZXY(VM_ARM_BASE.pitch, VM_ARM_BASE.twist, VM_ARM_BASE.roll, this.A);
  }

  /** Start: Ruhe-Lage, Bewegung, Startwinkel (Klinge relativ zum Safe Handle, Bite relativ zur Klinge), Trick-Zeit t0. */
  start(m: KnifeMotion, pos: ArrayLike<number>, rot: ArrayLike<number>, blade: number, bite: number, t0 = 0): void {
    this.motion = m;
    for (let k = 0; k < 3; k++) {
      this.restPos[k] = pos[k];
      this.restRot[k] = rot[k];
    }
    fromEulerXYZV(this.S, this.restRot);
    const ax = m.flipAxis;
    const at = m.flipAt ?? ZERO3;
    this.fa[6] = ax ? 1 : 0;
    for (let k = 0; k < 3; k++) {
      this.fa[k] = ax ? ax[k] : 0;
      this.fa[3 + k] = at[k];
    }
    this.mc[0] = m.cx;
    this.mc[1] = m.cy;
    this.theta = 0;
    this.rate = 0;
    this.fresh = true;
    this.q2[0] = blade;
    this.q2[1] = bite;
    this.chain.reset(t0, this.q2);
    this.contactMax = 0;
    this.handMax[0] = 0;
    this.handMax[1] = 0;
  }

  /** Bis Trick-Zeit t rechnen (festes Raster, framerate-unabhängig). */
  advanceTo(t: number): void {
    this.chain.advanceTo(t);
  }

  /** Klinge relativ zum Safe Handle zur Zeit t (nach advanceTo(t)). */
  bladeAt(t: number): number {
    // Basiswinkel zur Ausgabezeit: letzter Raster-Winkel + Rate (die Kette ist ebenfalls zwischen Raster-Punkten
    // interpoliert; beide gehören zur selben Zeit).
    return this.chain.outQ[0] - (this.theta + this.rate * (t - this.tLast));
  }

  /** Bite Handle relativ zur Klinge (nach advanceTo). */
  get bite(): number {
    return this.chain.outQ[1] - this.chain.outQ[0];
  }

  /**
   * ChainDriver: Basis (Safe Handle) zur Zeit t im mitbewegten Messer-Raum. Achsen bei t ± h → Winkel-
   * geschwindigkeit Ω = ½ Σ e × ė; Rate = Ω·z, θ trapezförmig integriert (Aufrufe in steigender Zeit, je Raster-
   * Schritt einer); Stift-Beschleunigung als zweite Differenz; Beschleunigung und Schwerkraft in den Achsen von t,
   * um θ in die Ketten-Ebene gedreht.
   */
  base(chain: PlanarChain, out: Float64Array): void {
    const t = chain.tEval;
    const h = 1e-3;
    const P = this.P;
    this.tq = t - h;
    this.frameAt(P, this.Xv, this.Yv);
    const xm = P[0];
    const ym = P[1];
    const zm = P[2];
    axes(this.Xv, this.Yv, this.Em);
    this.tq = t + h;
    this.frameAt(P, this.Xv, this.Yv);
    const xp = P[0];
    const yp = P[1];
    const zp = P[2];
    axes(this.Xv, this.Yv, this.Ep);
    this.tq = t;
    this.frameAt(P, this.Xv, this.Yv);
    const X = this.Xv;
    const Y = this.Yv;
    const Z = this.Zv;
    Z[0] = X[1] * Y[2] - X[2] * Y[1];
    Z[1] = X[2] * Y[0] - X[0] * Y[2];
    Z[2] = X[0] * Y[1] - X[1] * Y[0];
    // Ω = ½ Σ e × de/dt
    let ox = 0;
    let oy = 0;
    let oz = 0;
    const Em = this.Em;
    const Ep = this.Ep;
    for (let k = 0; k < 9; k += 3) {
      const ex = (Em[k] + Ep[k]) / 2;
      const ey = (Em[k + 1] + Ep[k + 1]) / 2;
      const ez = (Em[k + 2] + Ep[k + 2]) / 2;
      const dx = (Ep[k] - Em[k]) / (2 * h);
      const dy = (Ep[k + 1] - Em[k + 1]) / (2 * h);
      const dz = (Ep[k + 2] - Em[k + 2]) / (2 * h);
      ox += 0.5 * (ey * dz - ez * dy);
      oy += 0.5 * (ez * dx - ex * dz);
      oz += 0.5 * (ex * dy - ey * dx);
    }
    const w = ox * Z[0] + oy * Z[1] + oz * Z[2];
    if (this.fresh) {
      this.fresh = false;
      this.theta = 0;
    } else if (t > this.tLast) this.theta += 0.5 * (this.rate + w) * (t - this.tLast);
    this.rate = w;
    this.tLast = t;
    this.omP[0] = ox * X[0] + oy * X[1] + oz * X[2];
    this.omP[1] = ox * Y[0] + oy * Y[1] + oz * Y[2];
    const ax = (xp - 2 * P[0] + xm) / (h * h);
    const ay = (yp - 2 * P[1] + ym) / (h * h);
    const az = (zp - 2 * P[2] + zm) / (h * h);
    const alx = ax * X[0] + ay * X[1] + az * X[2];
    const aly = ax * Y[0] + ay * Y[1] + az * Y[2];
    // Schwerkraft: im Bild nach unten (Kamera-y −1).
    const glx = -KNIFE_G * X[1];
    const gly = -KNIFE_G * Y[1];
    const c = Math.cos(this.theta);
    const s = Math.sin(this.theta);
    out[BASE_AX] = alx * c - aly * s;
    out[BASE_AY] = alx * s + aly * c;
    out[BASE_ANGLE] = this.theta;
    out[BASE_RATE] = w;
    out[BASE_GX] = glx * c - gly * s;
    out[BASE_GY] = glx * s + gly * c;
  }

  /** ChainDriver: Fliehkraft (Überschlag), Griff gegen Griff, Führung durch die greifenden Finger, Hand. */
  forces(c: PlanarChain, Q: Float64Array): void {
    if (!this.motion) return;
    // Kanäle zur Zeit tEval hat base() eben gerechnet (letzter frameAt bei t) — kein zweiter Aufruf.
    const ch = this.ch;
    const th = this.theta;
    this.centrifugal(c, th, Q);
    // Führung: Relativwinkel zu den Zielen (Klinge: gripBlade; Bite: nächster Gleichwert von −gripBlade).
    const g = ch[KM.grip];
    if (g > 0) {
      const k = GRIP_K * g;
      const d = GRIP_D * Math.sqrt(g);
      const rho0 = c.q[0] - th;
      const rho1 = c.q[1] - c.q[0];
      const goal0 = ch[KM.gripBlade];
      const want1 = -goal0;
      const goal1 = want1 + TAU * Math.round((rho1 - want1) / TAU);
      const t0 = k * (goal0 - rho0) - d * (c.qd[0] - this.rate);
      const t1 = k * (goal1 - rho1) - d * (c.qd[1] - c.qd[0]);
      Q[0] += t0 - t1;
      Q[1] += t1;
    }
    this.handleContact(c, th, Q);
    // Greifen die Finger zu (grip), umschließen sie den Bite Handle statt ihn abzuweisen: Hand-Kontakt wird weicher.
    // Die Klinge weist die Hand immer ab (sie darf sie nie berühren).
    if (this.hand) {
      this.handScale = 1;
      this.handContact(c, th, 0, Q);
      this.handScale = 1 - 0.7 * (g < 1 ? g : 1);
      this.handContact(c, th, 1, Q);
    }
  }

  /** Fliehkraft aus der Drehung aus der Ebene (Ω_p in Messer-x/-y): a = |Ω_p|²·r − Ω_p(Ω_p·r) am Schwerpunkt. */
  private centrifugal(c: PlanarChain, th: number, Q: Float64Array): void {
    const wx = this.omP[0];
    const wy = this.omP[1];
    const w2 = wx * wx + wy * wy;
    if (!(w2 > 1e-6)) return;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    for (let i = 0; i < 2; i++) {
      const L = KNIFE_LINKS[i];
      const A = this.arg;
      A[0] = L.com[0];
      A[1] = L.com[1];
      c.pointOfA(i, A, this.v2);
      // Ketten-Ebene → Messer-Raum
      const rx = this.v2[0] * ct + this.v2[1] * st;
      const ry = -this.v2[0] * st + this.v2[1] * ct;
      const dot = wx * rx + wy * ry;
      const fx = L.mass * (w2 * rx - wx * dot);
      const fy = L.mass * (w2 * ry - wy * dot);
      A[2] = fx * ct - fy * st;
      A[3] = fx * st + fy * ct;
      c.applyForceA(i, A, Q);
    }
  }

  /**
   * Bite Handle gegen Safe Handle: zwei Strecken (Stift → Griff-Ende) mit Breite handleW; Überlappung → Feder-
   * Dämpfer am nächsten Punkt des Bite Handle (Safe Handle ist gehalten und nimmt die Gegenkraft auf).
   */
  private handleContact(c: PlanarChain, th: number, Q: Float64Array): void {
    const L = K.handleLen - K.pinInset;
    const sx = Math.sin(th) * L;
    const sy = -Math.cos(th) * L;
    const A = this.arg;
    A[0] = K.pinGap;
    A[1] = 0;
    c.pointOfA(0, A, this.v2);
    const bx0 = this.v2[0];
    const by0 = this.v2[1];
    const a1 = c.q[1];
    const bx1 = bx0 + Math.sin(a1) * L;
    const by1 = by0 - Math.cos(a1) * L;
    let best = 1e9;
    let nx = 0;
    let ny = 0;
    let along = 0;
    for (let i = 0; i < 4; i++) {
      // i 0/1: Bite-Endpunkte gegen den Safe Handle; 2/3: Safe-Endpunkte gegen den Bite Handle.
      const qx = i === 0 ? bx0 : i === 1 ? bx1 : i === 2 ? 0 : sx;
      const qy = i === 0 ? by0 : i === 1 ? by1 : i === 2 ? 0 : sy;
      const ox = i < 2 ? 0 : bx0;
      const oy = i < 2 ? 0 : by0;
      const dx = i < 2 ? sx : bx1 - bx0;
      const dy = i < 2 ? sy : by1 - by0;
      const ll = dx * dx + dy * dy;
      let u = ((qx - ox) * dx + (qy - oy) * dy) / ll;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const ex = qx - (ox + dx * u);
      const ey = qy - (oy + dy * u);
      const d = Math.sqrt(ex * ex + ey * ey);
      if (d < best) {
        best = d;
        const s = i < 2 ? 1 : -1;
        nx = d > 1e-9 ? (s * ex) / d : 0;
        ny = d > 1e-9 ? (s * ey) / d : 0;
        along = i === 0 ? 0 : i === 1 ? 1 : u;
      }
    }
    const pen = K.handleW - best;
    if (!(pen > 0)) return;
    if (pen > this.contactMax) this.contactMax = pen;
    A[0] = 0;
    A[1] = -along * L;
    c.velocityOfA(1, A, this.v2);
    const vn = this.v2[0] * nx + this.v2[1] * ny;
    const f = CONTACT_K * pen - CONTACT_D * (vn < 0 ? vn : 0);
    A[2] = f * nx;
    A[3] = f * ny;
    c.applyForceA(1, A, Q);
  }

  /**
   * Glied gegen die Hand: Punkte beider Kanten (Klinge bzw. Bite Handle) in den Handgelenk-Raum (Sockel dieser
   * Zeit, Drehung −θ aus der Ketten-Ebene), Abstand zur HandShape minus halbe Dicke (0.12 Toleranz: der Handschuh
   * gibt nach); Überlappung → Kraft entlang des Abstands-Gradienten, in die Ebene projiziert.
   */
  private handContact(c: PlanarChain, th: number, link: number, Q: Float64Array): void {
    const hand = this.hand;
    if (!hand || !(this.handScale > 0)) return;
    const W = this.W;
    const half = link === 0 ? K.bladeD / 2 : K.handleD / 2;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    for (let k = 0; k < HAND_PTS * 2; k++) {
      const i = (k >> 1) + 1;
      const s = i / HAND_PTS;
      const edge = (k & 1) === 0 ? -0.5 : 0.5;
      const lx = link === 0 ? K.pinGap / 2 + edge * K.bladeW : edge * K.handleW;
      const ly = link === 0 ? K.bladeFrom + K.bladeLen * s : -(K.handleLen - K.pinInset) * s;
      const A = this.arg;
      A[0] = lx;
      A[1] = ly;
      c.pointOfA(link, A, this.v2);
      const ux = this.v2[0] * ct + this.v2[1] * st;
      const uy = -this.v2[0] * st + this.v2[1] * ct;
      const px = W[0] + W[3] * ux + W[6] * uy;
      const py = W[1] + W[4] * ux + W[7] * uy;
      const pz = W[2] + W[5] * ux + W[8] * uy;
      // Bite Handle: 0.12 Toleranz (Handschuh gibt nach); Klinge: 0.2 Sicherheitsabstand (sie berührt nie).
      const hp = this.hp;
      hp[0] = px;
      hp[1] = py;
      hp[2] = pz;
      hand.measure(hp);
      const d = hand.res[0] - half + (link === 0 ? -0.2 : 0.12);
      if (!(d < 0)) continue;
      if (-d > this.handMax[link]) this.handMax[link] = -d;
      const e = 0.05;
      // Gradient (selten: nur bei Kontakt) über Puffer.
      hp[0] = px + e;
      hand.measure(hp);
      let gx = hand.res[0];
      hp[0] = px - e;
      hand.measure(hp);
      gx -= hand.res[0];
      hp[0] = px;
      hp[1] = py + e;
      hand.measure(hp);
      let gy = hand.res[0];
      hp[1] = py - e;
      hand.measure(hp);
      gy -= hand.res[0];
      hp[1] = py;
      hp[2] = pz + e;
      hand.measure(hp);
      let gz = hand.res[0];
      hp[2] = pz - e;
      hand.measure(hp);
      gz -= hand.res[0];
      const nu = gx * W[3] + gy * W[4] + gz * W[5];
      const nv = gx * W[6] + gy * W[7] + gz * W[8];
      const nl = Math.sqrt(nu * nu + nv * nv);
      if (!(nl > 1e-9)) continue;
      const nxl = nu / nl;
      const nyl = nv / nl;
      const nx = nxl * ct - nyl * st;
      const ny = nxl * st + nyl * ct;
      c.velocityOfA(link, A, this.v2);
      const vn = this.v2[0] * nx + this.v2[1] * ny;
      const f = (HAND_K * -d - HAND_D * (vn < 0 ? vn : 0)) * this.handScale;
      A[2] = f * nx;
      A[3] = f * ny;
      c.applyForceA(link, A, Q);
    }
  }

  /**
   * Sockel im Handgelenk-Raum zur Zeit t → W (Stift, Achsen x, y). Lokal: p' = Rf·(Rz(spin)·(p − cs) + cs − F) + F + o
   * (Drehung in der Ebene um cs, dann Überschlag um die Achse durch F, dann Versatz), Sockel-Drehung S·Rf·Rz.
   */
  private socket(): void {
    const m = this.motion;
    const c = this.ch;
    if (m) m.at(this.tq, c);
    else c.fill(0);
    const sp = c[KM.spin];
    const cs = Math.cos(sp);
    const sn = Math.sin(sp);
    const cx = this.mc[0];
    const cy = this.mc[1];
    // Stift nach der Drehung in der Ebene (z = 0)
    let px = cx - (cs * cx - sn * cy);
    let py = cy - (sn * cx + cs * cy);
    let pz = 0;
    // Achsen x = Rz·e_x, y = Rz·e_y
    let xx = cs;
    let xy = sn;
    let xz = 0;
    let yx = -sn;
    let yy = cs;
    let yz = 0;
    const fl = c[KM.flip];
    const FA = this.fa;
    if (fl !== 0 && FA[6] > 0) {
      // Achse/Punkt aus dem Puffer (bei start() kopiert): keine Kommazahl-Argumente im Takt der Physik.
      const R = this.F;
      const ax = FA[0];
      const ay = FA[1];
      const az = FA[2];
      const co = Math.cos(fl);
      const si = Math.sin(fl);
      const tt = 1 - co;
      R[0] = tt * ax * ax + co;
      R[1] = tt * ax * ay - si * az;
      R[2] = tt * ax * az + si * ay;
      R[3] = tt * ax * ay + si * az;
      R[4] = tt * ay * ay + co;
      R[5] = tt * ay * az - si * ax;
      R[6] = tt * ax * az - si * ay;
      R[7] = tt * ay * az + si * ax;
      R[8] = tt * az * az + co;
      const F = this.faPt;
      F[0] = FA[3];
      F[1] = FA[4];
      F[2] = FA[5];
      const qx = px - F[0];
      const qy = py - F[1];
      const qz = pz - F[2];
      px = R[0] * qx + R[1] * qy + R[2] * qz + F[0];
      py = R[3] * qx + R[4] * qy + R[5] * qz + F[1];
      pz = R[6] * qx + R[7] * qy + R[8] * qz + F[2];
      const x0 = xx;
      const x1 = xy;
      xx = R[0] * x0 + R[1] * x1;
      xy = R[3] * x0 + R[4] * x1;
      xz = R[6] * x0 + R[7] * x1;
      const y0 = yx;
      const y1 = yy;
      yx = R[0] * y0 + R[1] * y1;
      yy = R[3] * y0 + R[4] * y1;
      yz = R[6] * y0 + R[7] * y1;
    }
    px += c[KM.ox];
    py += c[KM.oy];
    pz += c[KM.oz];
    const S = this.S;
    const W = this.W;
    W[0] = this.restPos[0] + S[0] * px + S[1] * py + S[2] * pz;
    W[1] = this.restPos[1] + S[3] * px + S[4] * py + S[5] * pz;
    W[2] = this.restPos[2] + S[6] * px + S[7] * py + S[8] * pz;
    W[3] = S[0] * xx + S[1] * xy + S[2] * xz;
    W[4] = S[3] * xx + S[4] * xy + S[5] * xz;
    W[5] = S[6] * xx + S[7] * xy + S[8] * xz;
    W[6] = S[0] * yx + S[1] * yy + S[2] * yz;
    W[7] = S[3] * yx + S[4] * yy + S[5] * yz;
    W[8] = S[6] * yx + S[7] * yy + S[8] * yz;
  }

  /** Stift (Bildraum, relativ zum Anker-Ursprung) und Messer-Achsen x, y (Bildraum) zur Zeit t. */
  private frameAt(P: Float64Array, X: Float64Array, Y: Float64Array): void {
    this.socket();
    const c = this.ch;
    const W = this.W;
    // Bewegung (YXZ) · Arm (ZXY) · Handgelenk (ZXY: Rz(dev)·Rx(−flex)·Ry(twist))
    const R = this.R;
    rotZXY(-c[KM.flex], c[KM.twist], c[KM.dev], R);
    mul3(this.A, R, R);
    rotYXZ(c[KM.pitch], c[KM.yaw], c[KM.roll], this.MT);
    mul3(this.MT, R, R);
    P[0] = (c[KM.hx] + c[KM.sx]) * VIEW_UNIT + R[0] * W[0] + R[1] * W[1] + R[2] * W[2];
    P[1] = -(c[KM.hy] + c[KM.sy]) * VIEW_UNIT + R[3] * W[0] + R[4] * W[1] + R[5] * W[2];
    P[2] = c[KM.hz] + R[6] * W[0] + R[7] * W[1] + R[8] * W[2];
    X[0] = R[0] * W[3] + R[1] * W[4] + R[2] * W[5];
    X[1] = R[3] * W[3] + R[4] * W[4] + R[5] * W[5];
    X[2] = R[6] * W[3] + R[7] * W[4] + R[8] * W[5];
    Y[0] = R[0] * W[6] + R[1] * W[7] + R[2] * W[8];
    Y[1] = R[3] * W[6] + R[4] * W[7] + R[5] * W[8];
    Y[2] = R[6] * W[6] + R[7] * W[7] + R[8] * W[8];
  }

  /** Sockel (Handgelenk-Raum) zur Zeit t in pos/rot — für den Renderer (dieselbe Rechnung wie die Physik). */
  socketAt(t: number, pos: Float32Array, rot: Float32Array): void {
    this.tq = t;
    this.socket();
    const W = this.W;
    pos[0] = W[0];
    pos[1] = W[1];
    pos[2] = W[2];
    // Drehung: Spalten x, y, z = x × y.
    const T = this.MT;
    T[0] = W[3];
    T[3] = W[4];
    T[6] = W[5];
    T[1] = W[6];
    T[4] = W[7];
    T[7] = W[8];
    T[2] = W[4] * W[8] - W[5] * W[7];
    T[5] = W[5] * W[6] - W[3] * W[8];
    T[8] = W[3] * W[7] - W[4] * W[6];
    toEulerXYZ(T, this.e3);
    rot[0] = this.e3[0];
    rot[1] = this.e3[1];
    rot[2] = this.e3[2];
  }

  /**
   * Werkzeug/Tuning: Punkt (lx, ly) im Glied `link` (−1 = Safe Handle, 0 = Klinge, 1 = Bite Handle) zur Zeit t in den
   * Bildraum relativ zum Hand-Anker (Kamera-Achsen, Hand-Einheiten), nach advanceTo(t). Rechnet Sockel und Hand neu.
   */
  viewPointOf(t: number, link: number, lx: number, ly: number, out: Float64Array): void {
    this.tq = t;
    this.frameAt(this.P, this.Xv, this.Yv);
    let ux = lx;
    let uy = ly;
    if (link >= 0) {
      this.chain.pointOf(link, lx, ly, this.v2);
      const th = this.theta + this.rate * (t - this.tLast);
      const ct = Math.cos(th);
      const st = Math.sin(th);
      // pointOf rechnet mit dem Raster-Zustand q — für Werkzeuge genau genug (≤ 1 ms daneben).
      ux = this.v2[0] * ct + this.v2[1] * st;
      uy = -this.v2[0] * st + this.v2[1] * ct;
    }
    out[0] = this.P[0] + this.Xv[0] * ux + this.Yv[0] * uy;
    out[1] = this.P[1] + this.Xv[1] * ux + this.Yv[1] * uy;
    out[2] = this.P[2] + this.Xv[2] * ux + this.Yv[2] * uy;
  }

  /** Kanäle der Bewegung zur Zeit t (Hand-Kanäle, Griff, Riegel für die Ausgabe). */
  channels(t: number): Float64Array {
    const m = this.motion;
    if (m) m.at(t, this.ch);
    else this.ch.fill(0);
    return this.ch;
  }
}

/** Achsen x, y und z = x × y in out (9). */
function axes(X: Float64Array, Y: Float64Array, out: Float64Array): void {
  out[0] = X[0];
  out[1] = X[1];
  out[2] = X[2];
  out[3] = Y[0];
  out[4] = Y[1];
  out[5] = Y[2];
  out[6] = X[1] * Y[2] - X[2] * Y[1];
  out[7] = X[2] * Y[0] - X[0] * Y[2];
  out[8] = X[0] * Y[1] - X[1] * Y[0];
}


/** out = Rz(z)·Rx(x)·Ry(y) (three Euler 'ZXY' mit (x, y, z)), Zeilen-Hauptordnung. */
export function rotZXY(x: number, y: number, z: number, out: Float64Array): void {
  const a = Math.cos(x);
  const b = Math.sin(x);
  const c = Math.cos(y);
  const d = Math.sin(y);
  const e = Math.cos(z);
  const f = Math.sin(z);
  out[0] = c * e - b * d * f;
  out[1] = -a * f;
  out[2] = d * e + b * c * f;
  out[3] = c * f + b * d * e;
  out[4] = a * e;
  out[5] = d * f - b * c * e;
  out[6] = -a * d;
  out[7] = b;
  out[8] = a * c;
}

/** out = Ry(y)·Rx(x)·Rz(z) (three Euler 'YXZ' mit (x, y, z)), Zeilen-Hauptordnung. */
export function rotYXZ(x: number, y: number, z: number, out: Float64Array): void {
  const a = Math.cos(x);
  const b = Math.sin(x);
  const c = Math.cos(y);
  const d = Math.sin(y);
  const e = Math.cos(z);
  const f = Math.sin(z);
  out[0] = c * e + d * b * f;
  out[1] = d * b * e - c * f;
  out[2] = a * d;
  out[3] = a * f;
  out[4] = a * e;
  out[5] = -b;
  out[6] = c * b * f - d * e;
  out[7] = d * f + c * b * e;
  out[8] = a * c;
}

/** out = a·b (3×3, Zeilen-Hauptordnung; out darf a oder b sein). */
function mul3(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): void {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7], a8 = a[8];
  const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8];
  out[0] = a0 * b0 + a1 * b3 + a2 * b6;
  out[1] = a0 * b1 + a1 * b4 + a2 * b7;
  out[2] = a0 * b2 + a1 * b5 + a2 * b8;
  out[3] = a3 * b0 + a4 * b3 + a5 * b6;
  out[4] = a3 * b1 + a4 * b4 + a5 * b7;
  out[5] = a3 * b2 + a4 * b5 + a5 * b8;
  out[6] = a6 * b0 + a7 * b3 + a8 * b6;
  out[7] = a6 * b1 + a7 * b4 + a8 * b7;
  out[8] = a6 * b2 + a7 * b5 + a8 * b8;
}

/**
 * KnifeMotion aus Keyframe-Spuren (curves.Track) je Kanal (KM); fehlende Kanäle sind 0. Ladezeit-Aufbau,
 * at() ohne Allokation.
 */
export class TrackMotion implements KnifeMotion {
  readonly cx: number;
  readonly cy: number;
  readonly tracks: readonly (Track | null)[];
  readonly flipAxis?: readonly [number, number, number];
  readonly flipAt?: readonly [number, number, number];
  /**
   * Freier Flug (Aerial): [Abwurf t0, Flugzeit T, Drehungen, gx, gy] — Parabel zurück zum Start in ox/oy (Messer-
   * Ebene, Schwerkraft g), konstante Drehung in spin. In DIESER Klasse statt einer zweiten KnifeMotion: eine Klasse
   * hält die Aufrufe der Physik monomorph (zwei Klassen → nicht geinlinet → jede Kommazahl geboxt, fallen.md #107).
   */
  readonly toss: Float64Array | null;

  constructor(tracks: Partial<Record<keyof typeof KM, Track>>, cx = 0, cy = 0, flipAxis?: readonly [number, number, number], flipAt?: readonly [number, number, number], toss?: readonly number[]) {
    this.flipAxis = flipAxis;
    this.flipAt = flipAt;
    this.toss = toss ? Float64Array.from(toss) : null;
    const list: (Track | null)[] = new Array<Track | null>(KM_COUNT).fill(null);
    for (const [k, tr] of Object.entries(tracks)) if (tr) list[KM[k as keyof typeof KM]] = tr;
    this.tracks = list;
    this.cx = cx;
    this.cy = cy;
  }

  at(t: number, out: Float64Array): void {
    const tr = this.tracks;
    for (let i = 0; i < KM_COUNT; i++) {
      const x = tr[i];
      out[i] = x ? x.value(t) : 0;
    }
    const a = this.toss;
    if (a) {
      const T = a[1];
      let s = t - a[0];
      s = s < 0 ? 0 : s > T ? T : s;
      // Parabel zurück zum Start: v0 = −g·T/2 (je Achse), p(s) = v0·s + g·s²/2; Drehung mit konstanter Rate.
      out[KM.ox] += -a[3] * (T / 2) * s + 0.5 * a[3] * s * s;
      out[KM.oy] += -a[4] * (T / 2) * s + 0.5 * a[4] * s * s;
      out[KM.spin] += (-Math.PI * 2 * a[2] * s) / T;
    }
  }

  /** Ende der längsten Spur (s). */
  get duration(): number {
    let d = 0;
    for (const x of this.tracks) if (x) d = Math.max(d, x.end);
    return d;
  }
}
