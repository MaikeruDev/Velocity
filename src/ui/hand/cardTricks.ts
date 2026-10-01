import { VM_JOINT, VM_JOINT_COUNT, VM_RIG } from '../../render/types';
import { arc, smooth } from './anim';
import { Track, cubicInOut, cubicOut, phase, quadOut } from './curves';
import { thumbPoint } from './fk';
import { POSE, POSE_JOINTS } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { fromEulerXYZ, mat3 } from './rot';
import { viewPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Sammelkarte (Plan 006, Plan 008 Schritt 2: Tricks aus der Hand). Griff: Daumen flach VORN auf der Karte (sichtbar
 * wie Plan 006), die Karte lehnt hinten am gebeugten Zeigefinger. Die Finger bewegen sich je Trick über einen
 * Gelenk-Versatz zur Pose pinch (geschlossene Funktion der Trick-Zeit, in afterPose angelegt — nicht mit motionFx
 * skaliert, sonst stünde der Daumen bei halber Bewegung in der Karte).
 *
 * - spin ("card twirl"): die Karte gleitet am Daumenpolster hoch und steht dann mit der Unterkante auf der Daumenkuppe
 *   (Lage per FK aus dem Daumen dieses Frames — die Drehachse geht durch die Kuppe, kein Schweben), der Zeigefinger
 *   schnellt hinten gegen die linke untere Ecke → Drehung um die Hochachse (Vorder-/Rückseite im Wechsel), der Daumen
 *   balanciert mit, Reibung bremst, die Karte gleitet zurück in den Kniff (Nachfedern). Ein Twirl zwischen Daumen und
 *   Mittelfinger (Achse durch beide Kuppen) geht mit dieser Hand nicht: der Mittelfinger erreicht die Oberkante nicht.
 * - turn (Flip): Ausholen, der Zeigefinger schnellt von hinten hoch, die Karte fliegt eine kurze Parabel mit einer
 *   halben Drehung um die Querachse, der Daumen fängt sie gewendet (bleibt gewendet bis zum nächsten turn).
 * - tossSpin: Handgelenk holt aus, Wurf als Parabel mit Wirbel um die Hochachse, Fang mit Nachfedern.
 * - vanish (Back-Palm): die Karte klappt hinter die Finger (Handflächen-Seite, aus der Kamera verdeckt), die Hand
 *   streckt die Finger und dreht sich — leer; dann klappt sie mit Schwung wieder hervor (Funkeln).
 * - fan (Overdrive): die Karte steht auf der Daumenkuppe und schaukelt in ihrer Ebene (rollt über die runde Kuppe),
 *   dann ein Twirl mit Zeigefinger-Schnipp.
 * Plan 007 KI8, Surf ≥ 500 u/s: Zustand surfFan — die Hand hebt die Karte in den Fahrtwind und fächelt.
 */

export const CARD_TRICKS = ['none', 'spin', 'turn', 'tossSpin', 'vanish', 'surfFan', 'fan'] as const;
export type CardTrick = Exclude<(typeof CARD_TRICKS)[number], 'none'>;

const CARD_NAMES: readonly string[] = CARD_TRICKS.filter((t) => t !== 'none');

export const CARD_TIER_TRICKS: readonly (readonly CardTrick[])[] = [[], ['spin', 'turn'], ['tossSpin', 'spin', 'turn'], ['vanish', 'tossSpin', 'fan']];

const DEG = Math.PI / 180;
const J = VM_JOINT;
const TH = J.thumbAbd;
const IX = J.finger;
const MI = J.finger + 4;
const RI = J.finger + 8;
const PI_ = J.finger + 12;

/**
 * Karte im Pinch (Plan 008): Plan 006 hielt sie 2 Einheiten tiefer (Daumen sichtbar vorn, aber die Ecke steckte im
 * Zeigefinger), das Griff-Audit hob sie an (Daumen nur noch an der Unterkante). Jetzt 0.7 Einheiten über Plan 006
 * mit Daumen-Versatz (Gittersuche gegen den Kontakt-Körper): Daumenpolster 1.8 über der Unterkante flach vorn,
 * Zeigefinger hinten, kein Glied tiefer als 0.12 in der Karte.
 */
export const CARD_HOLD_POS = viewPoint([-5.6, 11.9, -1.2], 0, 0.68, -0.2);
const ROT_FRONT: V3 = viewRot([
  [1, 0.42],
  [2, 0.3],
]);
/** Gewendet (Rückseite vorn) = halbe Drehung um die eigene Querachse — wie Plan 006. */
const ROT_BACK: V3 = viewRot([
  [0, Math.PI],
  [1, 0.42],
  [2, 0.3],
]);
/** Achsen der Karte in Ruhe (Handgelenk-Raum): x quer, y hoch, z Normale (Vorderseite). */
const AX = ((): { x: V3; y: V3; z: V3 } => {
  const m = fromEulerXYZ(mat3(), ROT_FRONT[0], ROT_FRONT[1], ROT_FRONT[2]);
  return { x: [m[0], m[3], m[6]], y: [m[1], m[4], m[7]], z: [m[2], m[5], m[8]] };
})();

/** Gelenk-Versätze zur Pose pinch (rad, VM_JOINT-Layout), Ladezeit. */
function delta(thumb: readonly number[], fingers: readonly (readonly number[])[] = []): Float64Array {
  const d = new Float64Array(VM_JOINT_COUNT);
  for (let k = 0; k < 4; k++) d[TH + k] = (thumb[k] ?? 0) * DEG;
  fingers.forEach((f, i) => {
    for (let k = 0; k < 4; k++) d[J.finger + i * 4 + k] = (f[k] ?? 0) * DEG;
  });
  return d;
}
/** Ruhe-Griff: Daumen flach vorn (Suche: Polster 1.8 über der Kante, Kontakt −0.05), Zeigefinger stützt hinten. */
const D_GRIP = delta([2.2, -23.5, -10.3, -13.6], [[0, 13, 0, 0]]);
/**
 * Twirl/Fächer: Daumen steiler, die Kuppe steht unter der Kartenmitte (Suche: Endglied möglichst entlang Karten-y,
 * Kuppe nahe der Mittellinie) — die Karte steht mit der Unterkante darauf, die Drehachse geht durch die Kuppe.
 */
const D_TWIRL = delta([-6, -17.5, -12, -26], [[0, 13, 0, 0]]);
/** Daumen gibt frei (Wurf/Flip): weg von der Vorderseite, gestreckt. */
const D_RELEASE = delta([20, -22, -24, -24], [[0, 30, 6, 0]]);
/** Daumen lockert nur (Back-Palm: die Karte kippt von ihm weg nach hinten). */
const D_SOFT = delta([8, -20, -4, -6], [[0, 13, 0, 0]]);
/** Zeigefinger schnellt hoch (Flip). */
const D_IDX_PUSH = delta([], [[0, -30, -30, -40]]);

/**
 * Twirl-Anschnipp: der Zeigefinger (im Griff unten eingerollt) holt hinten aus und schnellt mit dem Mittelglied
 * gegen die linke untere Ecke (positive Drehung um Karten-y), dann fällt er zurück — die Unterkante fegt über ihn.
 * Weiter an die Ecke reicht er nicht, ohne dass Grund-/Mittelglied in die Karte stoßen (Suche gegen die ganze
 * Kette: Kuppe hinter der Ecke war unerreichbar). Zeitpunkte relativ zu SPIN_PREP.
 */
const IDX_KEYS: readonly (readonly [number, readonly number[]])[] = [
  [-0.14, [0, 13, 0, 0]],
  [-0.03, [8, -22, -30, -30]],
  [0.005, [17, -40, -40, -40]],
  [0.035, [22, -32, -38, -38]],
  [0.15, [0, 13, 0, 0]],
];
const IDX_TRACKS: readonly Track[] = [0, 1, 2, 3].map(
  // 0.18 = SPIN_PREP (weiter unten deklariert, hier noch nicht initialisiert).
  (k) => new Track(IDX_KEYS.map(([at, v]) => [0.18 + at, v[k] * DEG] as const), { smooth: true }),
);

/** Abklingzeiten (event-probe L1 sync: 45.5 % frei, 22.7/min; der Takt springt chaotisch zwischen Regimen — fallen.md). */
const COOLDOWN = { spin: 1.0, turn: 0.9, tossSpin: 0.85, vanish: 1.3, surfFan: 0.5, fan: 1.0 } as const;
const SURF_FROM = 500;
const SURF_MIN = 0.5;
const FAN_IN = 0.3;
const FAN_OUT = 0.3;
const FAN_HZ = 2.4;
const FAN_AMP = 0.75;

/** Twirl (s): Vorbereitung, Drehdauer je Umdrehungszahl, Klemmen. */
const SPIN_PREP = 0.18;
/** Kapsel-Radius der Daumenkuppe (HandShape: r[2]·0.96·0.95) + Luft: so hoch steht die Unterkante über der Kuppen-Mitte. */
const TIP_R = VM_RIG.thumb.r[2] * 0.96 * 0.95 + 0.05;
const TIP_LEN = VM_RIG.thumb.len[2];
/** Kartenmitte über der Kuppen-Mitte (halbe Kartenhöhe + Kuppe). */
const ON_TIP = 4.4 + TIP_R;
const SPIN_BASE = 0.32;
const SPIN_PER = 0.15;
const SPIN_SETTLE = 0.22;
/** Endgeschwindigkeit der Drehung als Anteil der Anfangsgeschwindigkeit beim Klemmen (Daumen stoppt sie). */
const SPIN_END = 0.3;
/** Flip (s): Ausholen, Flug, Scheitel (Einheiten), Nachfedern. */
const TURN_WIND = 0.13;
const TURN_AIR = 0.36;
const TURN_PEAK = 5.2;
const TURN_SETTLE = 0.22;
const TURN_TIME = TURN_WIND + TURN_AIR + TURN_SETTLE;
/** Wurf (s). */
const TOSS_WIND = 0.12;
const TOSS_AIR = 0.5;
const TOSS_SETTLE = 0.24;
const TOSS_TOTAL = TOSS_WIND + TOSS_AIR + TOSS_SETTLE;
/** Back-Palm (s): Ausholen, Abklappen, leer zeigen (Drehung), zurück, Hervorklappen. */
const V_WIND = 0.12;
const V_FOLD = 0.4;
const V_TURN = 0.62;
const V_BACK = 1.04;
const V_POP = 1.24;
const V_TOTAL = 1.72;
/** Back-Palm: Bahn der Karte über den Anteil f (Bildrichtungen rechts/oben/Kamera, Kippung rad). */
const V_PATH_R = new Track([[0, 0], [0.3, 0], [0.65, 2.2], [1, 4.0]], { smooth: true });
const V_PATH_U = new Track([[0, 0], [0.3, 2.5], [0.65, 1.4], [1, -3.5]], { smooth: true });
const V_PATH_C = new Track([[0, 0], [0.3, -0.3], [0.65, -4.5], [1, -7.5]], { smooth: true });
const V_PATH_TILT = new Track([[0, 0], [0.3, 0.05], [0.65, -0.8], [1, -1.2]], { smooth: true });
/** Fächer (s). */
const FAN_T = 1.08;
/** Fächer-Ausschlag (rad) in der Kartenebene. */
const FAN_SWING = 0.75;
/** Fächer: Versatz der Zeigefinger-Spur (Schluss-Twirl beginnt bei FAN_FLICK + SPIN_PREP). */
const FAN_FLICK = 0.42;

/**
 * Nachfedern wie rigid.settle(v, s, ω, ζ) = v · ring(s), mit festen ω/ζ je Konstante: rigid.settle mit vier Kommazahl-
 * Argumenten wurde im langen Trick-Pfad nicht geinlinet und boxte je Aufruf (Heap-Sampling: ~110 B/Frame im Twirl).
 * Geschlossen in der Zeit, 0 für s ≤ 0.
 */
function ring(omega: number, zeta: number): (s: number) => number {
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const zw = zeta * omega;
  return (s) => {
    const x = s > 0 ? s : 0;
    return (Math.exp(-zw * x) * Math.sin(wd * x)) / wd;
  };
}
const RING_4_45 = ring(Math.PI * 2 * 4, 0.45);
const RING_4_5 = ring(Math.PI * 2 * 4, 0.5);
const RING_5_45 = ring(Math.PI * 2 * 5, 0.45);
const RING_5_5 = ring(Math.PI * 2 * 5, 0.5);
const RING_6_4 = ring(Math.PI * 2 * 6, 0.4);

const TAU = Math.PI * 2;
const PINCH = POSE_JOINTS[POSE.pinch];
/** 0 → 1 → 0 über u (sin²-Glocke, Enden flach). */
function bell01(u: number): number {
  const s = Math.sin(Math.PI * u);
  return s * s;
}

export class CardTricks extends PropTricks<CardTrick> {
  /** Karte zeigt gerade die Rückseite (nach turn). */
  flipped = false;
  /** Tools/Tests: Karte war seit Trickstart unsichtbar bzw. ist wieder da. */
  vanished = false;
  private pick = 0;
  private idleCount = 0;
  private spins = 1;
  private surfOut = -1;
  /** Finger-Versatz dieses Frames (rad, zur Pose pinch) — afterPose legt ihn an. */
  readonly fingers = new Float64Array(VM_JOINT_COUNT);
  /** Abbruch durch das Ziel: Finger-Versatz beim Abbruch, dann Differenz zum neuen Trick (klingt mit fadeW ab). */
  private readonly xfFingers = new Float64Array(VM_JOINT_COUNT);
  private xfFingerState = 0;
  /** Trick-Zeit für die Teil-Methoden (Feld statt Argument, Double-Startwert — fallen.md #107). */
  private tt = 0.5;
  /** Gelenke Pose pinch + Finger-Versatz (FK der Daumenkuppe) und Kuppen-Mitte. */
  private readonly jw = new Float64Array(VM_JOINT_COUNT);
  private readonly tip = new Float64Array(3);

  override get trickNames(): readonly string[] {
    return CARD_NAMES;
  }

  protected override isState(id: CardTrick): boolean {
    return id === 'surfFan';
  }

  protected override start(id: CardTrick): void {
    super.start(id);
    this.surfOut = -1;
  }

  protected override onInterrupt(): void {
    this.xfFingers.set(this.fingers);
    this.xfFingerState = 1;
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('surfFan');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('surfFan');
  }

  /** Tools: wie früher __vel.forceTrick — Karten-Tricks mit der Wildheit von Stufe 3. */
  override debugPlayName(name: string, at: number): boolean {
    if (name !== 'none' && this.isTrick(name)) {
      this.debugPlayTier(name, 3, at);
      return true;
    }
    return super.debugPlayName(name, at);
  }

  protected resetRun(): void {
    this.flipped = false;
    this.vanished = false;
    this.writeRest(this.out);
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.pinch;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = CARD_HOLD_POS[0];
    o.pos[1] = CARD_HOLD_POS[1];
    o.pos[2] = CARD_HOLD_POS[2];
    const r = this.flipped ? ROT_BACK : ROT_FRONT;
    o.rot[0] = r[0];
    o.rot[1] = r[1];
    o.rot[2] = r[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
    this.fingers.set(D_GRIP);
  }

  protected cooldownOf(id: CardTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = CARD_TIER_TRICKS[tier];
    if (tier === 3 && good) this.startTrick(this.pick++ % 2 === 0 ? 'vanish' : 'fan', 3);
    else this.startTrick(list[this.pick++ % list.length], tier);
  }

  protected onMilestone(tier: number): void {
    if (tier >= 3) this.startTrick('vanish', 3);
    else if (tier === 2) this.startTrick('tossSpin', 2);
  }

  protected onIdle(): number {
    const k = this.idleCount++ % 4;
    this.startTrick(k === 3 ? 'vanish' : k === 1 ? 'turn' : 'spin', 0);
    return 2.8 + 2 * this.rand();
  }

  protected override onFinish(): void {
    this.startTrick('vanish', 3);
  }

  /** Training (KI9): Stufe = Spin (Jubel, zwei Umdrehungen), Lektion fertig = wie das Ziel. */
  protected override onLesson(done: boolean): void {
    if (done) this.onFinish();
    else this.startTrick('spin', 2);
  }

  private startTrick(id: CardTrick, tier: number): void {
    // Wildheit: Spin-Umdrehungen mit dem Tempo.
    this.spins = tier >= 3 ? 3 : tier === 2 ? 2 : 1;
    if (id === 'vanish') this.vanished = false;
    this.start(id);
  }

  /** Tools: Trick mit Wildheit einer Tempostufe starten. */
  debugPlayTier(id: CardTrick, tier: number, at = -1): void {
    this.debugPlay(id, at);
    this.spins = tier >= 3 ? 3 : tier === 2 ? 2 : 1;
  }

  /** Finger-Versatz anlegen (nach dem Überblenden der Pose, nicht mit motionFx skaliert); beim Ziel-Abbruch weich. */
  override afterPose(_joints: ArrayLike<number>, _inp: PropFrameInput, _dt: number): void {
    const f = this.fingers;
    const x = this.xfFingers;
    if (this.xfFingerState === 1) {
      // Erster Frame nach dem Abbruch: Versatz alt − neu festhalten (wie PropTricks.crossFade).
      for (let i = 0; i < x.length; i++) x[i] -= f[i];
      this.xfFingerState = 2;
    }
    const ja = this.out.jointAdd;
    if (this.xfFingerState === 0) {
      for (let i = 0; i < ja.length; i++) ja[i] += f[i];
      return;
    }
    // Nur im Ziel-Überblenden: Gewicht aus PropTricks (Getter mit Kommazahl — nicht je Frame in Ruhe aufrufen, #107.2).
    const w = this.fadeW;
    if (!(w > 0)) this.xfFingerState = 0;
    for (let i = 0; i < ja.length; i++) ja[i] += f[i] + x[i] * w;
  }

  /** fingers += d·w (Ladezeit-Versatz gewichtet). */
  private add(d: Float64Array, w: number): void {
    const f = this.fingers;
    for (let i = 0; i < f.length; i++) f[i] += d[i] * w;
  }

  /** Griff ganz durch d ersetzen (Gewicht w): fingers = GRIP·(1−w) + d·w. */
  private blend(d: Float64Array, w: number): void {
    const f = this.fingers;
    for (let i = 0; i < f.length; i++) f[i] = D_GRIP[i] + (d[i] - D_GRIP[i]) * w;
  }

  /** Lage an der Kartenmitte entlang der Kartenachsen verschieben (Einheiten). */
  private shiftCard(o: PropOut, x: number, y: number, z: number): void {
    for (let k = 0; k < 3; k++) o.pos[k] += AX.x[k] * x + AX.y[k] * y + AX.z[k] * z;
  }

  protected evaluate(id: CardTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'surfFan') return this.surfFan(t, inp, o);
    if (id === 'spin') return this.twirl(t, o);
    if (id === 'turn') return this.turn(t, o);
    if (id === 'tossSpin') return this.toss(t, o);
    if (id === 'fan') return this.fan(t, o);
    return this.vanish(t, o);
  }

  /**
   * Card twirl um die Hochachse (siehe Kopf). Alles geschlossen in t. In kleine Teile ohne Kommazahl-Argumente
   * zerlegt (Zeit über das Feld tt): als eine Methode sprengte sie das Inlining-Budget, jeder Helfer-Aufruf boxte
   * (fallen.md #107.5). Reihenfolge: erst alle Finger (Versatz), dann die Karte aus der FK dieser Finger.
   */
  private twirl(t: number, o: PropOut): boolean {
    this.tt = t;
    if (t >= SPIN_PREP + SPIN_BASE + SPIN_PER * this.spins + SPIN_SETTLE) return true;
    this.twirlFingers(o);
    this.twirlCard(o);
    this.twirlSpin(o);
    if (this.mark(0, SPIN_PREP, t)) this.kick(o, -0.06, 0.12);
    if (this.mark(1, SPIN_PREP + SPIN_BASE + SPIN_PER * this.spins, t)) this.kick(o, 0.08, -0.2);
    return false;
  }

  /**
   * Finger: Daumen richtet sich unter der Karte auf (Griff → D_TWIRL), balanciert während der Drehung (kleines
   * Wippen im Grundgelenk — die Karte reitet mit), Zeigefinger schnippt hinten die linke Ecke an und fällt weg.
   */
  private twirlFingers(o: PropOut): void {
    const t = this.tt;
    const tc = SPIN_PREP + SPIN_BASE + SPIN_PER * this.spins;
    const edge = smooth(phase(t, 0.03, SPIN_PREP - 0.03)) * (1 - smooth(phase(t, tc + 0.02, tc + 0.16)));
    const f = this.fingers;
    for (let i = 0; i < f.length; i++) f[i] = D_GRIP[i] + (D_TWIRL[i] - D_GRIP[i]) * edge;
    for (let k = 0; k < 4; k++) f[IX + k] = IDX_TRACKS[k].value(t);
    // Balancieren: Daumen wippt um die Drehachse (gedämpft, während die Karte läuft).
    const bal = smooth(phase(t, SPIN_PREP, SPIN_PREP + 0.1)) * (1 - smooth(phase(t, tc - 0.1, tc)));
    f[TH + 1] += 0.045 * Math.sin((t - SPIN_PREP) * 19) * bal;
    f[TH + 2] -= 0.03 * Math.sin((t - SPIN_PREP) * 19 + 0.8) * bal;
    // Klemmen: Daumen drückt nach, federt.
    f[TH + 3] += 0.3 * RING_5_45(t - tc - 0.17);
    o.jointAdd[J.wristTwist] += 0.1 * bell01(phase(t, SPIN_PREP - 0.06, SPIN_PREP + 0.12));
  }

  /**
   * Karte: am Daumenpolster hoch (wy), dann nach vorn auf die Kuppe (wxz) — die Unterkante steht dann TIP_R über der
   * Kuppen-Mitte (FK dieses Frames, die Karte reitet jedem Daumen-Wippen nach). Zum Klemmen dieselbe Bahn zurück.
   */
  private twirlCard(o: PropOut): void {
    const t = this.tt;
    const tc = SPIN_PREP + SPIN_BASE + SPIN_PER * this.spins;
    const wy = cubicOut(phase(t, 0, 0.11)) * (1 - cubicInOut(phase(t, tc + 0.05, tc + 0.19)));
    const wxz = cubicInOut(phase(t, 0.05, SPIN_PREP - 0.03)) * (1 - cubicInOut(phase(t, tc - 0.02, tc + 0.07)));
    this.onTip(o, wy, wxz);
    o.hroll = -0.05 * wy;
  }

  /**
   * Kartenmitte zwischen Ruhe und "steht auf der Daumenkuppe" (Karten-y-Anteil wy, Quer-/Normalanteil wxz), aus der
   * FK des Daumens mit dem aktuellen Finger-Versatz. Schreibt den Kuppen-Abstand in tipOff (Karten-Achsen).
   */
  private onTip(o: PropOut, wy: number, wxz: number): void {
    const jw = this.jw;
    const f = this.fingers;
    for (let i = 0; i < jw.length; i++) jw[i] = PINCH[i] + f[i];
    const c = this.tip;
    thumbPoint(jw, 2, 0, TIP_LEN, 0, c);
    // Abstand Ruhe → Ziel in Karten-Achsen.
    const dx0 = c[0] + AX.y[0] * ON_TIP - CARD_HOLD_POS[0];
    const dx1 = c[1] + AX.y[1] * ON_TIP - CARD_HOLD_POS[1];
    const dx2 = c[2] + AX.y[2] * ON_TIP - CARD_HOLD_POS[2];
    const lx = AX.x[0] * dx0 + AX.x[1] * dx1 + AX.x[2] * dx2;
    const ly = AX.y[0] * dx0 + AX.y[1] * dx1 + AX.y[2] * dx2;
    const lz = AX.z[0] * dx0 + AX.z[1] * dx1 + AX.z[2] * dx2;
    for (let k = 0; k < 3; k++) o.pos[k] += AX.y[k] * ly * wy + (AX.x[k] * lx + AX.z[k] * lz) * wxz;
  }

  /** Drehung: Schnipp-Impuls, Reibung bremst (quadratisch), am Ende steht die Vorderseite wieder vorn und federt. */
  private twirlSpin(o: PropOut): void {
    const t = this.tt;
    const n = this.spins;
    const ts = SPIN_BASE + SPIN_PER * n;
    const tc = SPIN_PREP + ts;
    const u = phase(t, SPIN_PREP, tc);
    const a = 2 - 2 * SPIN_END;
    const g = (2 * u - (a / 2) * u * u) / (2 - a / 2);
    const vEnd = (TAU * n * (2 - a)) / ((2 - a / 2) * ts);
    o.spin = TAU * n * g + vEnd * 0.12 * RING_6_4(t - tc);
  }

  /** Flip vom Zeigefinger: kurze Parabel mit halber Drehung um die Querachse, Fang gewendet. */
  private turn(t: number, o: PropOut): boolean {
    const tf = TURN_WIND + TURN_AIR;
    if (t >= TURN_TIME) {
      this.flipped = !this.flipped;
      return true;
    }
    // Ausholen: Karte und Hand sacken, Zeigefinger zieht zurück, Daumen lockert.
    const wind = smooth(phase(t, 0, TURN_WIND)) * (1 - smooth(phase(t, TURN_WIND, TURN_WIND + 0.08)));
    const push = quadOut(phase(t, TURN_WIND + 0.01, TURN_WIND + 0.08)) * (1 - cubicInOut(phase(t, TURN_WIND + 0.1, tf - 0.04)));
    const rel = smooth(phase(t, TURN_WIND - 0.04, TURN_WIND + 0.02)) * (1 - smooth(phase(t, tf - 0.06, tf + 0.03)));
    this.blend(D_RELEASE, rel);
    this.add(D_IDX_PUSH, push);
    o.jointAdd[J.wristFlex] += -0.16 * wind + 0.24 * push;
    o.hy = 0.012 * wind - 0.01 * push;
    // Flug: Parabel (Scheitel TURN_PEAK) mit konstanter Drehrate — π um die eigene Querachse.
    const s = phase(t, TURN_WIND, tf);
    this.shiftCard(o, 0, TURN_PEAK * arc(s), 0.6 * arc(s));
    // Rate am Fang klein (Zeigefinger bremst die Drehung): die Unterkante streift sonst die Zeigefinger-Wurzel.
    this.rotateLocal(o, AX.x[0], AX.x[1], AX.x[2], (Math.PI * (2 * s - 0.85 * s * s)) / 1.15);
    if (this.mark(0, TURN_WIND, t)) this.kick(o, -0.2, 0.15);
    if (this.mark(1, tf, t)) {
      this.kick(o, 0.25, -0.5);
      this.spinKick(0.6);
    }
    this.fingers[TH + 3] += (1.4) * RING_5_45(t - tf) * 0.3;
    o.hy += (0.12) * RING_4_5(t - tf);
    return false;
  }

  /** Wurf mit Wirbel um die Hochachse, Fang im Kniff. */
  private toss(t: number, o: PropOut): boolean {
    const tf = TOSS_WIND + TOSS_AIR;
    if (t >= TOSS_TOTAL) return true;
    const n = this.spins;
    const wind = smooth(phase(t, 0, TOSS_WIND)) * (1 - smooth(phase(t, TOSS_WIND, TOSS_WIND + 0.1)));
    const rel = smooth(phase(t, TOSS_WIND - 0.04, TOSS_WIND + 0.02)) * (1 - smooth(phase(t, tf - 0.02, tf + 0.06)));
    this.blend(D_RELEASE, rel);
    o.jointAdd[J.wristFlex] += -0.22 * wind + 0.3 * quadOut(phase(t, TOSS_WIND - 0.03, TOSS_WIND + 0.07)) * (1 - smooth(phase(t, TOSS_WIND + 0.1, tf)));
    o.hy = 0.018 * wind;
    const s = phase(t, TOSS_WIND, tf);
    const peak = 4.5 + 1.5 * n;
    this.shiftCard(o, 0.8 * Math.sin(Math.PI * s), peak * arc(s), 1.2 * Math.sin(Math.PI * s));
    // Luftwiderstand bremst den Wirbel: Rate am Fang 15 % des Starts (sonst fegte die Ecke durch den Zeigefinger).
    o.spin = (TAU * n * (2 * s - 0.85 * s * s)) / 1.15;
    // Leichtes Taumeln um die Querachse (eine Karte fliegt nie ganz flach).
    this.rotateLocal(o, AX.x[0], AX.x[1], AX.x[2], 0.35 * Math.sin(Math.PI * s));
    o.pose = POSE.pinch;
    if (this.mark(0, TOSS_WIND, t)) this.kick(o, -0.4, 0.2);
    if (this.mark(1, tf, t)) {
      this.kick(o, 0.35, -0.9);
      this.spinKick(-1.0);
    }
    const c = t - tf;
    o.spin += (-2.2) * RING_6_4(c);
    this.fingers[TH + 3] += (1.6) * RING_5_45(c) * 0.3;
    this.fingers[IX + 1] += (1.2) * RING_5_5(c) * 0.25;
    return false;
  }

  /**
   * Fächer: die Karte steht wie beim Twirl auf der Daumenkuppe und schaukelt in ihrer Ebene — sie rollt mit der
   * Unterkante über die runde Kuppe (Drehpunkt = Kuppen-Mitte, die Kante bleibt in Kontakt; Handgelenk führt mit,
   * Holo blitzt), zum Schluss ein Twirl, dann zurück in den Griff.
   */
  private fan(t: number, o: PropOut): boolean {
    if (t >= FAN_T) return true;
    const wy = cubicOut(phase(t, 0, 0.11)) * (1 - cubicInOut(phase(t, FAN_T - 0.17, FAN_T - 0.05)));
    const wxz = cubicInOut(phase(t, 0.08, 0.17)) * (1 - cubicInOut(phase(t, FAN_T - 0.26, FAN_T - 0.16)));
    const edge = smooth(phase(t, 0.03, 0.15)) * (1 - smooth(phase(t, FAN_T - 0.22, FAN_T - 0.08)));
    this.blend(D_TWIRL, edge);
    // Zum Schluss-Twirl schnippt der Zeigefinger wie im Twirl (dieselbe Spur, 0.42 s später).
    for (let k = 0; k < 4; k++) this.fingers[IX + k] = IDX_TRACKS[k].value(t - FAN_FLICK);
    this.onTip(o, wy, wxz);
    const lift = wy;
    // Schaukeln: Hüllkurve auf/ab, 3 Hz; am Ende ein voller Twirl (Rückseite blitzt) — Rate 0 vor dem Zurückklemmen.
    const env = smooth(phase(t, 0.17, 0.3)) * (1 - smooth(phase(t, 0.5, 0.62)));
    const ang = FAN_SWING * Math.sin(Math.PI * 2 * 3 * (t - 0.17)) * env;
    const tw = phase(t, FAN_FLICK + SPIN_PREP, FAN_T - 0.27);
    o.spin = TAU * (2 * tw - tw * tw);
    const h = ON_TIP;
    this.rotateLocal(o, AX.z[0], AX.z[1], AX.z[2], ang);
    this.shiftCard(o, -h * Math.sin(ang), h * Math.cos(ang) - h, 0);
    o.jointAdd[J.wristDev] += -0.18 * Math.sin(Math.PI * 2 * 3 * (t - 0.17) - 0.6) * env;
    o.hroll = -0.06 * lift;
    if (this.mark(0, 0.17, t)) this.kick(o, -0.1, 0.15);
    if (this.mark(1, FAN_T - 0.27, t)) {
      this.kick(o, 0.15, -0.35);
      this.spinKick(-0.5);
    }
    this.fingers[TH + 3] += (1.2) * RING_5_45(t - (FAN_T - 0.12)) * 0.25;
    return false;
  }

  /** Surf (KI8): Karte hoch in den Fahrtwind, fächeln (geschlossene Zeitfunktion), gegen die Rampe geneigt. */
  private surfFan(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const inE = smooth(t / FAN_IN);
    const outE = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / FAN_OUT);
    const e = inE * (1 - outE);
    this.offsetView(o, 0.6 * e, 2.2 * e, 1.4 * e);
    this.rotateView(o, 0, 0, 1, (0.2 - 0.35 * this.surfLean) * e);
    this.rotateView(o, 0, 1, 0, FAN_AMP * Math.sin(Math.PI * 2 * FAN_HZ * t) * e);
    o.hroll = -0.06 * e;
    // Einlage (PropTricks.beatU): die Karte hebt ab und wirbelt einmal um die Hochachse (Rückseite blitzt).
    const u = this.beatU;
    if (u < 1) {
      this.offsetView(o, 0, 1.6 * arc(u) * e, 0.4 * arc(u) * e);
      this.rotateView(o, 0, 1, 0, Math.PI * 2 * smooth(u));
    }
    if (this.beatEnd()) this.kick(o, 0.1, -0.25);
    if (this.mark(0, FAN_IN, t)) this.kick(o, 0.08, -0.2);
    return this.surfOut >= 0 && t >= this.surfOut + FAN_OUT && u >= 1;
  }

  /**
   * Back-Palm: Karte klappt um die Unterkante nach hinten hinter die Finger (Handflächen-Seite — aus der Kamera
   * verdeckt; dort löst sie sich im Dither auf, damit keine Ecke durchblitzt), Finger strecken sich, Hand dreht
   * (leer, beide Seiten), Finger schließen, die Karte klappt mit Schwung wieder hoch.
   */
  private vanish(t: number, o: PropOut): boolean {
    if (t >= V_TOTAL) return true;
    // Hand: Ausholen (hoch), beim Abklappen nach unten wischen, Drehen zum Zeigen, zurück; beim Hervorholen Ruck.
    const wind = smooth(phase(t, 0, V_WIND)) * (1 - smooth(phase(t, V_WIND, V_FOLD)));
    const turn = cubicInOut(phase(t, V_TURN, V_TURN + 0.26)) * (1 - cubicInOut(phase(t, V_BACK - 0.28, V_BACK)));
    o.hy = -0.015 * wind;
    o.hyaw = 0.55 * turn;
    o.hroll = -0.04 * wind - 0.18 * turn;
    o.jointAdd[J.wristTwist] += -0.5 * turn;
    o.jointAdd[J.wristFlex] += -0.12 * wind;
    // Weg der Karte über f (0 Griff … 1 hinter der Faust): erst aus dem Kniff hoch, dann nach hinten und hinter der
    // Faust nach unten (aus der Kamera verdeckt). Zurück dieselbe Bahn, schneller, mit Überschwinger der Kippung.
    const fold = cubicInOut(phase(t, V_WIND, V_FOLD));
    const pop = phase(t, V_POP, V_TOTAL - 0.16);
    const f = t < V_POP ? fold : 1 - cubicOut(pop);
    const tilt = V_PATH_TILT.value(f);
    this.rotateLocal(o, AX.x[0], AX.x[1], AX.x[2], tilt);
    // Ankommen mit Schwung: die Karte federt im Kniff kurz nach oben nach.
    this.offsetView(o, V_PATH_R.value(f), V_PATH_U.value(f) + (3.5) * RING_4_45(t - (V_TOTAL - 0.16)), V_PATH_C.value(f));
    // Daumen gibt frei, solange die Karte unterwegs ist; die Finger schließen sich darüber (Faust verdeckt).
    const rel = smooth(phase(t, V_WIND - 0.04, V_WIND + 0.06)) * (1 - smooth(phase(t, V_TOTAL - 0.2, V_TOTAL - 0.1)));
    this.blend(D_SOFT, rel);
    const show = smooth(phase(t, V_FOLD + 0.05, V_TURN)) * (1 - smooth(phase(t, V_BACK - 0.1, V_POP)));
    o.pose = show > 0.5 ? POSE.open : POSE.pinch;
    o.poseTau = 0.09;
    // Leere Hand: Finger wackeln einmal ("nichts drin").
    const wig = Math.sin((t - V_TURN) * 22) * smooth(phase(t, V_TURN + 0.2, V_TURN + 0.3)) * (1 - smooth(phase(t, V_BACK - 0.35, V_BACK - 0.2)));
    this.fingers[MI + 1] += 0.12 * wig;
    this.fingers[RI + 1] -= 0.12 * wig;
    this.fingers[PI_ + 1] += 0.1 * wig;
    // Sichtbarkeit: hinter den Fingern auflösen (Dither), zum Hervorklappen wieder da.
    const gone = smooth(phase(t, V_FOLD - 0.1, V_FOLD + 0.02));
    const vis = t < V_POP ? 1 - gone : smooth(phase(t, V_POP + 0.04, V_POP + 0.1));
    o.visible = vis;
    if (gone >= 1 && t < V_POP) this.vanished = true;
    if (this.mark(0, V_FOLD - 0.06, t)) this.kick(o, -0.15, 0.3);
    this.poofAt(o, (t - (V_FOLD - 0.08)) / 0.4);
    // Hervorklappen mit Schwung: kurzer Größen-Pop, Funkeln an der Karte.
    if (this.mark(1, V_POP, t)) {
      this.kick(o, 0.3, -0.8);
      this.spinKick(-0.8);
      this.vanished = false;
    }
    if (t >= V_POP) {
      const p = t - V_POP;
      o.scale = 1 + 0.1 * Math.sin(Math.PI * Math.min(1, p / 0.22)) * (p < 0.22 ? 1 : 0);
      this.poofAt(o, p / 0.4);
    }
    return false;
  }

  private poofAt(o: PropOut, u: number): void {
    if (u < 0 || u >= 1) return;
    o.poof = u;
    o.poofPos[0] = o.pos[0];
    o.poofPos[1] = o.pos[1];
    o.poofPos[2] = o.pos[2];
  }
}
