import type { GameEvent } from '../../engine/events';
import { VM_JOINT, VM_JOINT_COUNT, VM_PARAM, VM_RIG } from '../../render/types';
import { arc, backOut, bell, clamp, smooth } from './anim';
import { Track, cubicInOut, cubicOut, phase, quadOut, smootherstep } from './curves';
import { fingerPoint, fingerTip, thumbPoint } from './fk';
import { POSE, POSE_JOINTS } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_AXES, fromEulerXYZ, mat3, toEulerXYZ } from './rot';
import { HandShape } from './handShape';
import { relRot, viewPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Münze (Plan 007, KI5; Plan 008 Schritt 2: Tricks aus der Hand). Kopf oder Zahl zeigt deinen Split. Ruhe: Daumen-
 * Klemme an der Seite des Zeigefinger-Endglieds (Pose coin). Finger und Daumen bewegen sich je Trick über einen
 * Gelenk-Versatz zur Pose (geschlossene Funktion der Trick-Zeit, in afterPose angelegt, nicht mit motionFx skaliert —
 * die Münzlage hängt an genau diesen Fingern).
 *
 * - Stand: knuckleRoll — echter Coin Walk: der Daumen schiebt die Münze auf den Zeigefinger-Knöchel, sie kippt über
 *   die Kerbe zwischen zwei Fingern auf den nächsten Knöchel (halbe Drehung um die Fingerrichtung, steht dabei kurz
 *   hochkant in der Kerbe), der empfangende Finger hebt sich, der abgebende drückt nach und senkt sich; nach dem
 *   kleinen Finger kippt sie über die Kante, rutscht unter der Hand zurück und der Daumen holt sie in die Klemme,
 * - Lauf: flip (Daumen-Flip: Daumen spannt, schnippt, fängt), Flow: flip / roll (schneller Knöchel-Lauf),
 * - Overdrive: highFlip (hoher Wurf, Fang flach auf dem Handrücken, zurück in die Klemme) / vanish (Classic Palm:
 *   die Finger schließen die Münze in die Hand, die Hand öffnet sich und dreht — leer —, schließt, und die Münze
 *   springt mit einem kleinen Flip zurück in die Klemme),
 * - Surf ≥ 500: Zustand edgeSpin — tanzt auf der Kante über der Faust, Ende = Klatsch,
 * - Checkpoint: call — Flip, die Landung zeigt KOPF, wenn split < 0 oder ohne Referenz, sonst ZAHL; läuft
 *   gerade ein Trick oder ist man in der Luft/im Surf, kommt der call danach (≤ 1.5 s, s. call()).
 * - Ziel: call sofort (bricht laufende Tricks und den Surf-Zustand ab, PropTricks), Kopf bei neuer
 *   Bestzeit, sonst Zahl.
 * Würfe drehen immer um eine gerade Zahl halber Drehungen: vorn liegt am Ende wieder die Vorderseite,
 * das Motiv vorn wählt der Kanal side — umgeschaltet, während die Münze hochkant steht (unsichtbar).
 */

export const COIN_TRICKS = ['none', 'knuckleRoll', 'roll', 'flip', 'highFlip', 'vanish', 'call', 'edgeSpin'] as const;
export type CoinTrick = Exclude<(typeof COIN_TRICKS)[number], 'none'>;
const COIN_NAMES: readonly string[] = COIN_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). */
export const COIN_TIER_TRICKS: readonly (readonly CoinTrick[])[] = [[], ['flip'], ['roll', 'flip'], ['highFlip', 'vanish']];

export const HEADS = 0;
export const TAILS = 1;

/**
 * Abklingzeiten: kalibriert mit event-probe (vorher 49–73 % Trick-Anteil, bis 36.7 Tricks/min). Flip/roll 0.6/0.8 →
 * 1.0/0.9: das schnellere L1 (Phase 3) schob die Münze auf 45.4 % bzw. 32.6/min über das Band.
 */
const COOLDOWN: { readonly [K in CoinTrick]: number } = { knuckleRoll: 0.6, roll: 0.9, flip: 1.0, highFlip: 1.2, vanish: 1.3, call: 1.0, edgeSpin: 0.5 };
const WALK_T = 2.02;
const WALK_PITCH = 1.25;
const WALK_YAW = 0.3;
const ROLL_T = 0.82;
/** Anteile der Lauf-Zeitleiste: auf den Knöchel, drei Wenden, zurück. */
const W_UP = 0.16;
const W_STEPS = 0.4;
const W_BACK = 1 - W_UP - W_STEPS;
const FLIP_WIND = 0.08;
const FLIP_AIR = 0.42;
const FLIP_T = 0.64;
const HIGH_AIR = 0.7;
const HIGH_SLAP = 0.2;
const HIGH_BACK = 0.2;
const HIGH_T = FLIP_WIND + HIGH_AIR + HIGH_SLAP + HIGH_BACK;
/** Der call ist kürzer als ein Flip (kommt an jedem Checkpoint): niedriger Wurf, kurz zeigen. */
const CALL_AIR = 0.36;
const CALL_SHOW = 0.32;
const CALL_T = FLIP_WIND + CALL_AIR + CALL_SHOW + 0.06;
/**
 * French Drop (s): zeigen, Daumen gibt frei, die Münze fällt (Schwerkraft, V_DROP s) in die gewölbten Finger, die
 * Faust schließt sich darüber (V_PUSH), offen zeigen, schließen, hervorschnippen.
 */
const V_DROP0 = 0.2;
const V_DROP = 0.17;
const V_LAND = V_DROP0 + V_DROP;
const V_PUSH = V_LAND + 0.05;
const V_OPEN = 0.58;
const V_CLOSE = 1.06;
const V_POP = 1.22;
const V_TOTAL = 1.56;
const SURF_FROM = 500;
const SURF_MIN = 0.5;
const PENDING = 1.5;
const SPIN_RATE = 17;

const P = VM_PARAM.coin;
const J = VM_JOINT;
const TH = J.thumbAbd;
const DEG = Math.PI / 180;
const J0 = POSE_JOINTS[POSE.coin];

type M = V3;

function sub(a: M, b: M): M {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function norm(a: M): M {
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function cross(a: M, b: M): M {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function fp(f: number, seg: number, x: number, y: number, z: number): M {
  const o: [number, number, number] = [0, 0, 0];
  fingerPoint(J0, f, seg, x, y, z, o);
  return o;
}

/** Knöchel-Punkte: Mitte des Grundglieds (Längsanteil) und Oberfläche des Fingerrückens (Kapsel-Radius). */
const KN_AT = VM_RIG.fingers.map((r) => r.len[0] * 0.55);
const KN_UP = VM_RIG.fingers.map((r) => r.r * 0.93);

/**
 * Rücken der Grundglieder (Pose coin, Ladezeit): gemeinsame Normale N (vom Handrücken weg), Fingerrichtung, Quer-
 * richtung S (Zeige → kleiner Finger) und FP = N × S (Drehachse der Wenden: dreht −S nach N).
 */
const BACK = ((): { n: M; s: M; fp: M; k: M[] } => {
  const k: M[] = [];
  let n: M = [0, 0, 0];
  let d: M = [0, 0, 0];
  for (let f = 0; f < 4; f++) {
    const c = fp(f, 0, 0, KN_AT[f], 0);
    const top = fp(f, 0, 0, KN_AT[f], KN_UP[f]);
    k.push(top);
    const nf = norm(sub(top, c));
    const df = norm(sub(fp(f, 0, 0, VM_RIG.fingers[f].len[0], 0), fp(f, 0, 0, 0, 0)));
    n = [n[0] + nf[0], n[1] + nf[1], n[2] + nf[2]];
    d = [d[0] + df[0], d[1] + df[1], d[2] + df[2]];
  }
  n = norm(n);
  let s = norm(cross(n, norm(d)));
  const across = sub(k[3], k[0]);
  if (s[0] * across[0] + s[1] * across[1] + s[2] * across[2] < 0) s = [-s[0], -s[1], -s[2]];
  return { n, s, fp: norm(cross(n, s)), k };
})();
/** Münze flach auf den Knöcheln, Vorderseite (+z) = N: Spalten (S, FP, N). */
const FLAT_M = ((): Float64Array => {
  const m = mat3();
  const { s, fp: f, n } = BACK;
  for (let k = 0; k < 3; k++) {
    m[k * 3] = s[k];
    m[k * 3 + 1] = f[k];
    m[k * 3 + 2] = n[k];
  }
  return m;
})();
const FLAT_ROT: M = ((): M => {
  const e = new Float32Array(3);
  toEulerXYZ(FLAT_M, e);
  return [e[0], e[1], e[2]];
})();
/** Wenden über den Knöcheln: aus der Lücke Zeige|Mittel über Mittel- und Ringfinger auf Ring|klein, dann über den kleinen Finger. */
const W_FLIPS = 2;
/**
 * Lücken-Lagen (Ladezeit, Pose coin): die Münze liegt flach quer über zwei Knöcheln — Mitte über der Mitte ihrer
 * Rücken, so hoch, dass keine Probe die Hand berührt (Bisektion gegen HandShape). Echter Coin Walk: sie liegt auf
 * zwei Fingern und kippt über den mittleren.
 */
const GAP_H = ((): number[] => {
  const hs = new HandShape();
  hs.update(J0);
  const pts: M[] = [];
  for (let i = 0; i < 16; i++) for (const z of [-0.21, 0.21]) pts.push([2.1 * Math.cos((i * Math.PI) / 8), 2.1 * Math.sin((i * Math.PI) / 8), z]);
  for (const z of [-0.21, 0.21]) pts.push([0, 0, z]);
  const m = FLAT_M;
  const clear = (c: M): number => {
    let b = 1e9;
    for (const p of pts) {
      const x = c[0] + m[0] * p[0] + m[1] * p[1] + m[2] * p[2];
      const y = c[1] + m[3] * p[0] + m[4] * p[1] + m[5] * p[2];
      const z = c[2] + m[6] * p[0] + m[7] * p[1] + m[8] * p[2];
      b = Math.min(b, hs.distance(x, y, z));
    }
    return b;
  };
  const out: number[] = [];
  for (let g = 0; g < 3; g++) {
    const a = BACK.k[g];
    const b = BACK.k[g + 1];
    let lo = 0;
    let hi = 5;
    for (let i = 0; i < 30; i++) {
      const h = (lo + hi) / 2;
      const c: M = [(a[0] + b[0]) / 2 + BACK.n[0] * h, (a[1] + b[1]) / 2 + BACK.n[1] * h, (a[2] + b[2]) / 2 + BACK.n[2] * h];
      if (clear(c) > 0.02) hi = h;
      else lo = h;
    }
    out.push(hi);
  }
  return out;
})();
/** Hüpfer je Wende (Einheiten über der Bahn bei 90°): die hochkant stehende Münze steht mit der Kante auf dem Knöchel. */
const W_HOP = 2.2;
/** Lage nach 2 Wenden + Viertel über den kleinen Finger (hochkant außen). */
const SIDE_ROT: M = ((): M => {
  const r = mat3();
  const a = BACK.fp;
  const ang = Math.PI * (W_FLIPS + 0.5);
  const c = Math.cos(ang);
  const sn = Math.sin(ang);
  const t = 1 - c;
  r[0] = t * a[0] * a[0] + c;
  r[1] = t * a[0] * a[1] - sn * a[2];
  r[2] = t * a[0] * a[2] + sn * a[1];
  r[3] = t * a[0] * a[1] + sn * a[2];
  r[4] = t * a[1] * a[1] + c;
  r[5] = t * a[1] * a[2] - sn * a[0];
  r[6] = t * a[0] * a[2] - sn * a[1];
  r[7] = t * a[1] * a[2] + sn * a[0];
  r[8] = t * a[2] * a[2] + c;
  const m = FLAT_M;
  const o = mat3();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = r[i * 3] * m[j] + r[i * 3 + 1] * m[3 + j] + r[i * 3 + 2] * m[6 + j];
  const e = new Float32Array(3);
  toEulerXYZ(o, e);
  return [e[0], e[1], e[2]];
})();

/**
 * Ruhe (Plan 008, Griff-Audit): Daumen-Klemme — die Münze steht an der Seite des Zeigefinger-Endglieds, der Daumen
 * drückt von der anderen Seite (Ausgangslage für Flip und Knöchel-Lauf). Gesucht mit Kontakt-Körpern (Münze r 2.1 gegen
 * HandShape: kein Teil durchdringt, Zeigefinger und Daumen liegen an, Vorderseite zur Kamera n·cam 0.82). Vorher
 * steckte die Münze 1.06 cm im Daumen und schwebte vor dem Zeigefinger.
 */
export const COIN_REST_POS: V3 = [-4.3, 6.81, -4.44];
export const COIN_REST_ROT: V3 = [2.717, -0.846, 2.815];
/** Drehungen Ruhe → flach auf den Knöcheln bzw. hochkant neben dem kleinen Finger → Ruhe (Achse-Winkel, Ladezeit). */
const REST_TO_FLAT = relRot(COIN_REST_ROT, FLAT_ROT);
const SIDE_TO_REST = relRot(SIDE_ROT, COIN_REST_ROT);
/** Lücke g in Ruhe-Pose (Ladezeit). */
function gapAt(g: number): M {
  const a = BACK.k[g];
  const b = BACK.k[g + 1];
  const h = GAP_H[g];
  return [(a[0] + b[0]) / 2 + BACK.n[0] * h, (a[1] + b[1]) / 2 + BACK.n[1] * h, (a[2] + b[2]) / 2 + BACK.n[2] * h];
}
/** Hinter dem kleinen Finger (gespiegelte Lücke) — Ziel der letzten Viertelwende. */
const GAP_OUT: M = ((): M => {
  const g = gapAt(2);
  const k = BACK.k[3];
  return [2 * k[0] - g[0] + BACK.n[0] * 2 * GAP_H[2], 2 * k[1] - g[1] + BACK.n[1] * 2 * GAP_H[2], 2 * k[2] - g[2] + BACK.n[2] * 2 * GAP_H[2]];
})();
/** Hochkant über der Außenkante des kleinen Fingers (Ende der Viertelwende, Ruhe-Pose). */
const SIDE_POS: M = ((): M => {
  const g = gapAt(2);
  return [(g[0] + GAP_OUT[0]) / 2 + BACK.n[0] * W_HOP, (g[1] + GAP_OUT[1]) / 2 + BACK.n[1] * W_HOP, (g[2] + GAP_OUT[2]) / 2 + BACK.n[2] * W_HOP];
})();
/**
 * Rückweg: hochkant außen am kleinen Finger hinunter, unter den Kuppen vorbei, vor den Fingern hoch und von oben in die
 * Klemme (von der Daumenseite käme sie durch den Daumen). Wegpunkte in Bildrichtungen, per Suche gegen HandShape
 * gesetzt (größter Abstand entlang der Bahn bei kurzem Weg).
 */
const BACK_PATH = ((): Track[] => {
  const pt: [number, number, number] = [0, 0, 0];
  fingerTip(J0, 3, pt);
  const r = COIN_REST_POS;
  const pts = [SIDE_POS, viewPoint(SIDE_POS, 0.33, -3.73, 1.52), viewPoint(pt, -0.52, -1.67, 0.05), viewPoint(r, 3.43, -4.13, 4.98), viewPoint(r, -0.59, -0.13, 2.09), r];
  const at = [0, 0.18, 0.38, 0.6, 0.82, 1];
  return [0, 1, 2].map((c) => new Track(pts.map((p, i) => [at[i], p[c]] as const), { smooth: true }));
})();
/** Auf den Zeigefinger: aus der Klemme hoch, über den Zeigefinger-Knöchel in die erste Lücke (Wegpunkte wie oben gesucht). */
const UP_PATH = ((): Track[] => {
  const g0 = gapAt(0);
  const pts = [COIN_REST_POS, viewPoint(COIN_REST_POS, 0.12, 2.7, -2.26), viewPoint(g0, -0.84, 1.26, 1.75), g0];
  const at = [0, 0.4, 0.75, 1];
  return [0, 1, 2].map((c) => new Track(pts.map((p, i) => [at[i], p[c]] as const), { smooth: true }));
})();
/** Handrücken-Mitte (Klatsch beim highFlip): flach auf der mittleren Lücke. */
const SLAP_POS: V3 = gapAt(1);
/**
 * Drehwinkel um die Bild-Querachse (negativ, wie toss), bei dem die Ruhe-Normale zum ersten Mal senkrecht zum Blick
 * steht (nur die Kante sichtbar → dort wechselt das Motiv). Aus der Ruhe-Lage berechnet (Ladezeit).
 */
const EDGE_TURN = ((): number => {
  const m = fromEulerXYZ(mat3(), COIN_REST_ROT[0], COIN_REST_ROT[1], COIN_REST_ROT[2]);
  const n = [m[2], m[5], m[8]];
  const A = VIEW_AXES;
  const u = n[0] * A.up[0] + n[1] * A.up[1] + n[2] * A.up[2];
  const c = n[0] * A.cam[0] + n[1] * A.cam[1] + n[2] * A.cam[2];
  // c'(−β) = c·cosβ − u·sinβ = 0
  return Math.atan2(c, u);
})();
/** Classic Palm: die Münze kommt zwischen Daumen- und Zeigefingerkuppe aus der Faust (unter der Klemme). */
const POP_POS: V3 = viewPoint(COIN_REST_POS, -2, 0, 2);
/**
 * French Drop: Fallbahn in Bildrichtungen (rechts, oben, Kamera) und Kippung um Bild-rechts (rad) über den Bahn-
 * Anteil. Direkt nach hinten geht nicht (der Zeigefinger liegt hinter der Münze): erst nach links unten vom Zeigefinger
 * ab, dann hinter ihn auf die Kuppen von Mittel-/Ringfinger (Kontakt 0.09, Suche gegen HandShape mit Pose coin + DROP_CUP).
 */
const DROP_PATH: readonly Track[] = ((): Track[] => {
  const w: readonly (readonly number[])[] = [
    [0, 0, 0, 0, 0],
    [0.55, -1.6, -2.6, 0, 0.5],
    [1, -1.4, -4.6, -2.2, 1.2],
  ];
  return [1, 2, 3, 4].map((c) => new Track(w.map((r) => [r[0], r[c]] as const), { smooth: true }));
})();
/** Daumen gibt frei (weg von der Münze) und Mittel-/Ring-/kleiner Finger wölben sich auf (Grund −10°, Mittel −35°). */
const D_DROP_THUMB = delta([-15, 15, 15, 10]);
const D_DROP_CUP = ((): Float64Array => {
  const d = new Float64Array(VM_JOINT_COUNT);
  for (let f = 1; f < 4; f++) {
    d[J.finger + f * 4 + 1] = -10 * DEG;
    d[J.finger + f * 4 + 2] = -35 * DEG;
  }
  return d;
})();
/** Auf der Kante über der Faust (Surf), Vorderseite zur Kamera. */
const EDGE_ROT: V3 = viewRot([]);
const EDGE_POS: V3 = viewPoint(COIN_REST_POS, 0.4, 2.2, 0.4);

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
const RING_3_4_3 = ring(Math.PI * 2 * 3.4, 0.3);
const RING_5_45 = ring(Math.PI * 2 * 5, 0.45);
const RING_5_5 = ring(Math.PI * 2 * 5, 0.5);
const RING_6_3 = ring(Math.PI * 2 * 6, 0.3);
const RING_7_35 = ring(Math.PI * 2 * 7, 0.35);

/** Drehanteil über die Flugzeit (Abwurf ruhig, Fang auslaufend). */
const TOSS_TURN = new Track([[0, 0], [0.16, 0.04], [0.84, 0.95], [1, 1]], { smooth: true });

/** Gelenk-Versatz zur Pose coin (Grad → rad), Ladezeit. */
function delta(thumb: readonly number[]): Float64Array {
  const d = new Float64Array(VM_JOINT_COUNT);
  for (let k = 0; k < 4; k++) d[TH + k] = (thumb[k] ?? 0) * DEG;
  return d;
}
/** Daumen spannt (unter der Münze eingerollt) bzw. schnippt (gestreckt, wie Daumen hoch). */
const D_COCK = delta([-2, 4, 4, 6]);
const D_FLICK = delta([15, -30, -20, -20]);
/** Daumen schiebt die Münze auf den Zeigefinger-Knöchel. */
const D_PUSH = delta([8, -14, -16, -20]);

export class CoinTricks extends PropTricks<CoinTrick> {
  /** Motiv vorn (HEADS/TAILS) — bleibt bis zum nächsten Wurf. */
  side = HEADS;
  private target = HEADS;
  private pendingSide = -1;
  private pendingUntil = 0;
  private pick = 0;
  private idleCount = 0;
  private flips = 0;
  private halfTurns = 4;
  private surfOut = -1;
  /** Letzter Frame: am Boden, nicht surfend (dort darf der call sofort starten). */
  private grounded = true;
  /** Finger-Versatz dieses Frames (rad, zur Pose coin) — afterPose legt ihn an. */
  readonly fingers = new Float64Array(VM_JOINT_COUNT);
  private readonly xfFingers = new Float64Array(VM_JOINT_COUNT);
  private xfFingerState = 0;
  /** Gelenke für die Knöchel-FK (Pose coin + Finger-Versatz) und Puffer für Knöchelpunkte. */
  private readonly jw = new Float32Array(VM_JOINT_COUNT);
  private readonly ka = new Float64Array(3);
  private readonly kb = new Float64Array(3);
  private readonly ga = new Float64Array(3);
  private readonly gb = new Float64Array(3);

  override get trickNames(): readonly string[] {
    return COIN_NAMES;
  }

  protected override isState(id: CoinTrick): boolean {
    return id === 'edgeSpin';
  }

  protected resetRun(): void {
    this.side = HEADS;
    this.target = HEADS;
    this.pendingSide = -1;
    this.writeRest(this.out);
  }

  protected override start(id: CoinTrick): void {
    super.start(id);
    this.surfOut = -1;
    if (id === 'flip') this.halfTurns = 4;
    else if (id === 'highFlip') this.halfTurns = 8;
    else if (id === 'call') this.halfTurns = 4;
    if (id === 'flip' || id === 'highFlip') {
      // Normale Würfe: mal Kopf, mal Zahl (fest verteilt, kein Zufall im Test).
      this.target = this.flips++ % 3 === 1 ? 1 - this.side : this.side;
    }
  }

  protected override onInterrupt(): void {
    this.xfFingers.set(this.fingers);
    this.xfFingerState = 1;
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.coin;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = COIN_REST_POS[0];
    o.pos[1] = COIN_REST_POS[1];
    o.pos[2] = COIN_REST_POS[2];
    o.rot[0] = COIN_REST_ROT[0];
    o.rot[1] = COIN_REST_ROT[1];
    o.rot[2] = COIN_REST_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
    o.param[P.side] = this.side;
    this.fingers.fill(0);
  }

  protected cooldownOf(id: CoinTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (this.takePending()) return;
    if (tier === 0) return;
    const list = COIN_TIER_TRICKS[tier];
    if (tier === 3 && good) this.start('highFlip');
    else this.start(list[this.pick++ % list.length]);
  }

  protected onMilestone(tier: number): void {
    // Meilensteine achten hier auf die Abklingzeit (sonst L1 bei sync 1.0: 12 von 38 Tricks, 48 % Trick-Anteil).
    if (this.now < this.cooldownUntil) return;
    if (tier >= 3) this.start('vanish');
    // Stufe 2 = roll: flip kommt schon aus Sprüngen und Leerlauf (L2 sync 1.0 sonst 52 % flip).
    else if (tier === 2) this.start('roll');
  }

  protected onIdle(): number {
    this.start(this.idleCount++ % 3 === 2 ? 'flip' : 'knuckleRoll');
    return 2.8 + 1.8 * this.rand();
  }

  /** Checkpoint: Kopf/Zahl merken — auch wenn gerade ein Trick läuft (dann kommt der call direkt danach). */
  override onEvent(e: GameEvent): void {
    if (e.type === 'checkpoint') this.call(e.split === null || e.split < 0 ? HEADS : TAILS);
    else super.onEvent(e);
  }

  /** Ziel: sofort (PropTricks bricht Laufendes ab) — auf Landung oder Surf-Ende zu warten hieß oft, dass nie einer kam. */
  protected override onFinish(best: boolean): void {
    this.pendingSide = -1;
    this.target = best ? HEADS : TAILS;
    this.start('call');
  }

  /** Training (KI9): Stufe und Lektion = call mit KOPF, sofort (wie das Ziel mit Bestzeit, auch in der Luft). */
  protected override onLesson(): void {
    this.onFinish(true);
  }

  private call(side: number): void {
    if (this.motionFx <= 0) return;
    this.target = side;
    // In der Luft wartet er bis zur Landung oder zum nächsten Sprung: sonst blockiert er einen Surf,
    // der gleich beginnt (Checkpoint vor der Rampe — event-probe: Surf-Zustand nur 74–76 %).
    if (this.free && this.grounded) this.start('call');
    else {
      this.pendingSide = side;
      this.pendingUntil = this.now + PENDING;
    }
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('edgeSpin');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) {
      this.start('edgeSpin');
      return;
    }
    if (inp.onGround && !inp.surfing) this.takePending();
  }

  protected override onLand(): void {
    this.takePending();
  }

  /** Wartenden call starten (sofern nicht verfallen). true = gestartet. */
  private takePending(): boolean {
    if (this.pendingSide < 0) return false;
    const s = this.pendingSide;
    this.pendingSide = -1;
    if (this.now > this.pendingUntil) return false;
    this.target = s;
    this.start('call');
    return true;
  }

  override update(dt: number, inp: PropFrameInput): void {
    this.grounded = inp.onGround && !inp.surfing;
    super.update(dt, inp);
    // Ein call, der auf Surf-Ende oder Landung wartet, verfällt nicht, solange das dauert.
    if (this.pendingSide >= 0 && (this.inState || !this.grounded)) this.pendingUntil = this.now + PENDING;
  }

  /** Finger-Versatz anlegen (nach dem Überblenden, unskaliert); beim Ziel-Abbruch klingt der alte Versatz ab. */
  override afterPose(_joints: ArrayLike<number>, _inp: PropFrameInput, _dt: number): void {
    const f = this.fingers;
    const x = this.xfFingers;
    if (this.xfFingerState === 1) {
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

  private add(d: Float64Array, w: number): void {
    const f = this.fingers;
    for (let i = 0; i < f.length; i++) f[i] += d[i] * w;
  }

  protected evaluate(id: CoinTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'edgeSpin') return this.edgeSpin(t, inp, o);
    const done = id === 'knuckleRoll' ? this.walk(t, WALK_T, o) : id === 'roll' ? this.walk(t, ROLL_T, o) : id === 'highFlip' ? this.highFlip(t, o) : id === 'vanish' ? this.vanish(t, o) : this.flip(id, t, o);
    return done;
  }

  /** Knöchel-Punkt von Finger f mit den Fingern dieses Frames (Pose coin + Versatz) → out. */
  private knuckle(f: number, out: Float64Array): void {
    // fk.fingerPoint für das Grundglied, hier ausgeschrieben: Kommazahlen aus Tabellen als Argumente eines nicht
    // geinlineten Aufrufs boxten (fallen.md #107.3, Heap-Probe Knöchel-Lauf).
    const r = VM_RIG.fingers[f];
    const b = J.finger + f * 4;
    const jw = this.jw;
    const ly = KN_AT[f];
    const lz = KN_UP[f];
    let c = Math.cos(-jw[b + 1]);
    let sn = Math.sin(-jw[b + 1]);
    const y = ly * c - lz * sn;
    const z = ly * sn + lz * c;
    c = Math.cos(jw[b] + r.splay);
    sn = Math.sin(jw[b] + r.splay);
    out[0] = r.x - y * sn;
    out[1] = r.y + y * c;
    out[2] = r.z + z;
  }

  /** Lücke g (Mitte zweier Knöchel + Liegehöhe) mit den Fingern dieses Frames → out. */
  private gap(g: number, out: Float64Array): void {
    this.knuckle(g, this.ka);
    this.knuckle(g + 1, this.kb);
    const h = GAP_H[g];
    const n = BACK.n;
    for (let k = 0; k < 3; k++) out[k] = (this.ka[k] + this.kb[k]) / 2 + n[k] * h;
  }

  /**
   * Coin Walk (siehe Kopf). Die Münze liegt quer auf zwei Knöcheln; Wende k kippt sie über Finger k+1 in die nächste
   * Lücke: θ = π·e um FP, Mitte auf der Bahn zwischen den Lücken (FK dieses Frames) mit Hüpfer — bei 90° steht sie
   * mit der Kante auf dem Knöchel. Der Drehfinger hebt sich und schiebt, der empfangende hebt sich, der abgebende
   * sinkt. Danach Viertelwende über den kleinen Finger, außen hinunter, der Daumen holt sie unter der Hand zurück.
   */
  private walk(t: number, T: number, o: PropOut): boolean {
    const u = t / T;
    if (u >= 1) return true;
    // Handrücken zur Kamera gedreht: sonst sähe man die liegende Münze nur als Strich.
    const env = smooth(u / 0.12) * (1 - smooth((u - 0.86) / 0.14));
    o.hpitch = WALK_PITCH * env;
    o.hyaw = WALK_YAW * env;
    o.hroll = 0.15 * env;
    const ws = ((u - W_UP) / W_STEPS) * W_FLIPS;
    const wb = (u - W_UP - W_STEPS) / W_BACK;
    // Finger heben/senken sich im Wechsel (Grundgelenk, rad; − = heben).
    let l0 = 0;
    let l1 = 0;
    let l2 = 0;
    let l3 = 0;
    const s0 = clamp(ws, 0, 1);
    const s1 = clamp(ws - 1, 0, 1);
    // Deutlich sichtbar (0.18 rad ≈ 10°): der Drehfinger hebt sich unter der Münze, der abgebende sinkt nach.
    l1 += -0.18 * bell(clamp(s0 / 0.6, 0, 1));
    l2 += -0.18 * bell(clamp((s0 - 0.4) / 0.6, 0, 1)) - 0.24 * bell(clamp(s1 / 0.6, 0, 1));
    l0 += 0.12 * bell(clamp((s0 - 0.3) / 0.6, 0, 1));
    l1 += 0.12 * bell(clamp((s1 - 0.3) / 0.6, 0, 1));
    l3 += -0.18 * bell(clamp((s1 - 0.4) / 0.6, 0, 1)) - 0.28 * bell(clamp(wb / 0.25, 0, 1));
    l2 += 0.1 * bell(clamp(wb / 0.25, 0, 1));
    const f = this.fingers;
    f[J.finger + 1] = l0;
    f[J.finger + 5] = l1;
    f[J.finger + 9] = l2;
    f[J.finger + 13] = l3;
    const jw = this.jw;
    for (let i = 0; i < jw.length; i++) jw[i] = J0[i] + f[i];
    const { n, fp: ax } = BACK;
    if (u < W_UP) {
      // Daumen schiebt die Münze aus der Klemme über den Zeigefinger-Knöchel in die erste Lücke (dreht dabei flach).
      const e = cubicInOut(u / W_UP);
      o.pos[0] = UP_PATH[0].value(e);
      o.pos[1] = UP_PATH[1].value(e);
      o.pos[2] = UP_PATH[2].value(e);
      this.rotateLocal(o, REST_TO_FLAT[0], REST_TO_FLAT[1], REST_TO_FLAT[2], REST_TO_FLAT[3] * e);
      this.add(D_PUSH, bell(u / W_UP));
      if (this.mark(4, W_UP * T, t)) this.kick(o, 0.03, -0.06);
      return false;
    }
    if (u < W_UP + W_STEPS) {
      const step = ws < 1 ? 0 : 1;
      const s = ws - step;
      // Kippen langsam (auf die Kante), Fallen schnell (Schwerkraft), Landen.
      const e = smootherstep(s);
      const th = Math.PI * e;
      this.gap(step, this.ga);
      this.gap(step + 1, this.gb);
      const a = (1 - Math.cos(th)) / 2;
      const h = W_HOP * Math.sin(th);
      for (let k = 0; k < 3; k++) o.pos[k] = this.ga[k] + (this.gb[k] - this.ga[k]) * a + n[k] * h;
      o.rot[0] = FLAT_ROT[0];
      o.rot[1] = FLAT_ROT[1];
      o.rot[2] = FLAT_ROT[2];
      // Nachwippen der vorigen Landung (geschlossen, je Wende).
      const land = (W_UP + (step / W_FLIPS) * W_STEPS) * T;
      const rock = step > 0 ? (-3) * RING_7_35(t - land) : 0;
      this.rotateLocal(o, ax[0], ax[1], ax[2], Math.PI * (step + e) + rock);
      if (this.mark(step, (W_UP + ((step + 1) / W_FLIPS) * W_STEPS) * T - 1e-9, t)) this.kick(o, 0.03, -0.08);
      return false;
    }
    if (wb < 0.25) {
      // Viertelwende über den kleinen Finger: hochkant über seiner Außenkante.
      const e = cubicInOut(wb / 0.25);
      const th = (Math.PI / 2) * e;
      this.gap(2, this.ga);
      const a = (1 - Math.cos(th)) / 2;
      const h = W_HOP * Math.sin(th);
      for (let k = 0; k < 3; k++) o.pos[k] = this.ga[k] + (GAP_OUT[k] - this.ga[k]) * a + n[k] * h;
      o.rot[0] = FLAT_ROT[0];
      o.rot[1] = FLAT_ROT[1];
      o.rot[2] = FLAT_ROT[2];
      this.rotateLocal(o, ax[0], ax[1], ax[2], Math.PI * W_FLIPS + th);
      return false;
    }
    // Außen hinunter, unter den Kuppen durch, Daumen holt sie in die Klemme (Lage weich in die Ruhe).
    const s = smooth((wb - 0.25) / 0.75);
    o.pos[0] = BACK_PATH[0].value(s);
    o.pos[1] = BACK_PATH[1].value(s);
    o.pos[2] = BACK_PATH[2].value(s);
    o.rot[0] = SIDE_ROT[0];
    o.rot[1] = SIDE_ROT[1];
    o.rot[2] = SIDE_ROT[2];
    this.rotateLocal(o, SIDE_TO_REST[0], SIDE_TO_REST[1], SIDE_TO_REST[2], SIDE_TO_REST[3] * smooth(s / 0.8));
    // Klemme schließt: der Daumen federt nach, wenn sie ankommt.
    this.fingers[TH + 3] += (1.4) * RING_5_45(t - T * 0.985) * 0.3;
    if (this.mark(3, T * 0.985, t)) this.kick(o, 0.06, -0.15);
    return false;
  }

  /** Daumen-Flip (auch der call): Daumen spannt, schnippt, Scheitel über dem Daumen, gerade Zahl halber Drehungen, Fang. */
  private flip(id: CoinTrick, t: number, o: PropOut): boolean {
    const call = id === 'call';
    const air = call ? CALL_AIR : FLIP_AIR;
    const tf = FLIP_WIND + air;
    this.thumbFlick(t, tf);
    if (t < FLIP_WIND) {
      if (this.mark(0, 0, t)) this.kick(o, 0.15, 0);
      o.pose = POSE.coin;
      this.offsetView(o, 0, -0.4 * Math.sin(Math.PI * (t / FLIP_WIND)), 0);
      return false;
    }
    if (this.mark(1, FLIP_WIND, t)) this.kick(o, -0.35, 0);
    const s = (t - FLIP_WIND) / air;
    if (s < 1) {
      this.toss(o, s, call ? 4.5 : 5, 0.5);
      return false;
    }
    if (this.mark(2, tf, t)) {
      this.kick(o, 0.25, -0.6);
    }
    // Fang-Wackeln um die Blickachse, geschlossen (wie die PropTricks-Wackelfeder, aber vor der Kontaktprüfung).
    this.rotateView(o, 0, 0, 1, (-0.8) * RING_3_4_3(t - tf));
    this.side = this.target;
    o.param[P.side] = this.side;
    // Fang: die Münze sackt in der Klemme nach (Hand gibt nach) und federt zurück.
    this.offsetView(o, 0, -(4) * RING_5_45(t - tf), 0);
    if (call) {
      // Zeigen: Münze kippt kurz zur Kamera — Kopf oder Zahl liest sich.
      const c = t - tf;
      const show = bell(clamp(c / CALL_SHOW, 0, 1));
      this.offsetView(o, 0, 0.9 * show, 0.8 * show);
      this.rotateView(o, 1, 0, 0, 0.8 * show);
      o.hpitch = 0.12 * show;
      return t >= CALL_T;
    }
    return t >= FLIP_T;
  }

  /** Daumen: spannen (Ausholen), schnippen (Abwurf), zum Fang zurück in die Klemme, nachfedern. */
  private thumbFlick(t: number, tf: number): void {
    const cock = smooth(phase(t, 0, FLIP_WIND)) * (1 - phase(t, FLIP_WIND, FLIP_WIND + 0.03));
    const flick = cubicInOut(phase(t, FLIP_WIND, FLIP_WIND + 0.16)) * (1 - cubicInOut(phase(t, FLIP_WIND + 0.08, tf - 0.04)));
    this.add(D_COCK, cock);
    this.add(D_FLICK, flick);
    this.fingers[TH + 3] += (1.5) * RING_5_45(t - tf) * 0.3;
    this.fingers[J.finger + 3] += (1.0) * RING_5_5(t - tf) * 0.25;
  }

  /** Wurfbahn ab der Ruhe: Scheitel `peak`, halbe Drehungen um die Bild-Querachse, Seite am Hochkant-Punkt. */
  private toss(o: PropOut, s: number, peak: number, drift: number): void {
    const turns = this.halfTurns;
    this.offsetView(o, drift * Math.sin(Math.PI * s), peak * arc(s), 0.6 * Math.sin(Math.PI * s));
    // Die Drehung setzt erst ein, wenn die Münze den Zeigefinger verlassen hat, und läuft zum Fang aus (Daumen und
    // Zeigefinger bremsen sie in die Klemme) — sonst fegte die Kante durch das Zeigefinger-Endglied.
    const g = TOSS_TURN.value(s);
    this.rotateView(o, 1, 0, 0, -Math.PI * turns * g);
    // Zum ersten Mal hochkant zur Kamera (Normale ⟂ Blick, EDGE_TURN): nur die Kante ist sichtbar — dort das
    // Motiv wechseln, dann springt kein Bild.
    if (g >= EDGE_TURN / (Math.PI * turns)) this.side = this.target;
    o.param[P.side] = this.side;
  }

  /** Hoher Wurf, Fang flach auf dem Handrücken (Hand dreht ihn hin), kurz liegen lassen, zurück in die Klemme. */
  private highFlip(t: number, o: PropOut): boolean {
    const tf = FLIP_WIND + HIGH_AIR;
    // Daumen schnippt und entspannt sich gleich wieder (der Fang ist auf dem Handrücken).
    this.thumbFlick(t, FLIP_WIND + 0.26);
    if (t < FLIP_WIND) {
      if (this.mark(0, 0, t)) this.kick(o, 0.22, 0);
      this.offsetView(o, 0, -0.6 * Math.sin(Math.PI * (t / FLIP_WIND)), 0);
      return false;
    }
    if (this.mark(1, FLIP_WIND, t)) this.kick(o, -0.6, 0);
    const s = (t - FLIP_WIND) / HIGH_AIR;
    // Handrücken zum Fang hin drehen (vorher), danach zurück.
    const turn = smooth(phase(t, FLIP_WIND + HIGH_AIR * 0.45, tf)) * (1 - smooth(phase(t, tf + HIGH_SLAP, HIGH_T)));
    o.hpitch = WALK_PITCH * turn;
    o.hyaw = WALK_YAW * turn;
    o.hroll = 0.15 * turn;
    if (s < 1) {
      // Wurf zur Kamera hin und über den Handrücken: Landepunkt = Mitte der Knöchel.
      // Lage: Ruhe → flach (Achse-Winkel, stetig) innerhalb der Wurfdrehung; nach geraden halben Drehungen liegt sie
      // genau flach (vorher Euler-Mischung: sprang um bis zu 1.4 rad je Frame).
      const e = smooth((s - 0.55) / 0.45);
      this.rotateLocal(o, REST_TO_FLAT[0], REST_TO_FLAT[1], REST_TO_FLAT[2], REST_TO_FLAT[3] * e);
      this.toss(o, s, 9, 0.8);
      for (let k = 0; k < 3; k++) o.pos[k] += (SLAP_POS[k] - COIN_REST_POS[k]) * e;
      return false;
    }
    const c = t - tf;
    if (this.mark(2, tf, t)) {
      this.kick(o, 0.45, -1.1);
    }
    this.side = this.target;
    o.param[P.side] = this.side;
    // Klatsch: liegt flach auf dem Handrücken (wippt nach), dann ein kleiner Hüpfer zurück in die Klemme.
    const back = smooth((c - HIGH_SLAP) / HIGH_BACK);
    for (let k = 0; k < 3; k++) o.pos[k] = SLAP_POS[k] + (COIN_REST_POS[k] - SLAP_POS[k]) * back + VIEW_AXES.up[k] * 4.2 * arc(back) + BACK.n[k] * 1.5 * arc(back);
    o.rot[0] = FLAT_ROT[0];
    o.rot[1] = FLAT_ROT[1];
    o.rot[2] = FLAT_ROT[2];
    const ax = BACK.fp;
    this.rotateLocal(o, ax[0], ax[1], ax[2], (-4) * RING_6_3(c) * (1 - back));
    this.rotateLocal(o, REST_TO_FLAT[0], REST_TO_FLAT[1], REST_TO_FLAT[2], -REST_TO_FLAT[3] * back);
    return t >= HIGH_T;
  }

  /**
   * French Drop (einhändig, aus Sicht des Zauberers): die Münze wird gezeigt, der Daumen gibt frei, sie fällt mit
   * Schwerkraft am Zeigefinger vorbei in die gewölbten Finger, die Faust schließt sich darüber (verdeckt — dort löst
   * sie sich im Dither auf), die Hand öffnet sich und dreht (leer), schließt sich wieder, und der Daumen schnippt die
   * Münze mit einer ganzen Drehung zurück in die Klemme (Funkeln).
   */
  private vanish(t: number, o: PropOut): boolean {
    if (t >= V_TOTAL) return true;
    // Zeigen: Hand hebt die Münze etwas an und kippt sie zur Kamera, dann der Ruck des Loslassens.
    const present = bell(phase(t, 0, V_DROP0 + 0.06));
    o.hy = 0.012 * present;
    o.hpitch = 0.1 * present;
    const rel = smooth(phase(t, V_DROP0 - 0.05, V_DROP0 + 0.01)) * (1 - smooth(phase(t, V_PUSH, V_PUSH + 0.1)));
    const cup = smooth(phase(t, V_DROP0 - 0.1, V_DROP0)) * (1 - smooth(phase(t, V_PUSH, V_PUSH + 0.1)));
    this.add(D_DROP_THUMB, rel);
    this.add(D_DROP_CUP, cup);
    // Fall: Bahn-Anteil quadratisch in der Zeit (aus der Ruhe beschleunigt), Landung auf den Kuppen.
    const u = phase(t, V_DROP0, V_LAND);
    const sDrop = u * u;
    this.offsetView(o, DROP_PATH[0].value(sDrop), DROP_PATH[1].value(sDrop), DROP_PATH[2].value(sDrop));
    this.rotateView(o, 1, 0, 0, DROP_PATH[3].value(sDrop));
    if (this.mark(3, V_LAND, t)) this.kick(o, 0.12, -0.25);
    o.pose = t < V_PUSH ? POSE.coin : t < V_OPEN ? POSE.fist : t < V_CLOSE ? POSE.open : t < V_POP - 0.1 ? POSE.fist : POSE.coin;
    o.poseTau = 0.06;
    const show = cubicInOut(phase(t, V_OPEN, V_OPEN + 0.18)) * (1 - cubicInOut(phase(t, V_CLOSE - 0.16, V_CLOSE)));
    o.hyaw = 0.4 * show;
    o.hroll = -0.12 * show + 0.06 * bell(phase(t, 0, V_OPEN));
    o.jointAdd[J.wristTwist] += -0.35 * show;
    // Leere Hand: Finger wackeln ("nichts drin").
    const wig = Math.sin((t - V_OPEN) * 24) * show;
    this.fingers[J.finger + 1] += 0.1 * wig;
    this.fingers[J.finger + 9] -= 0.1 * wig;
    // Sichtbarkeit: in der Faust auflösen (verdeckt), zum Hervorschnippen wieder da.
    const gone = smooth(phase(t, V_LAND + 0.005, V_PUSH));
    if (t < V_POP) {
      o.visible = 1 - gone;
      return false;
    }
    // Hervorschnippen: aus der Faust an die Klemme, kleiner Wurf mit einer ganzen Drehung (Motiv bleibt), Fang.
    const p = phase(t, V_POP, V_TOTAL - 0.1);
    const e = cubicOut(p);
    for (let k = 0; k < 3; k++) o.pos[k] = POP_POS[k] + (COIN_REST_POS[k] - POP_POS[k]) * e;
    o.rot[0] = COIN_REST_ROT[0];
    o.rot[1] = COIN_REST_ROT[1];
    o.rot[2] = COIN_REST_ROT[2];
    this.offsetView(o, 0.6 * arc(p), 2.6 * arc(p), 2.2 * arc(p));
    this.rotateView(o, 1, 0, 0, -Math.PI * 2 * smooth(p / 0.7));
    o.visible = smooth(phase(t, V_POP, V_POP + 0.05));
    o.scale = backOut(smooth(phase(t, V_POP, V_POP + 0.2)), 2.4) * 0.15 + 0.85;
    this.add(D_COCK, bell(phase(t, V_POP - 0.04, V_POP + 0.12)));
    if (this.mark(1, V_POP, t)) this.kick(o, 0.3, -0.8);
    if (this.mark(2, V_TOTAL - 0.1, t)) this.kick(o, 0.15, -0.4);
    this.poofAt(o, (t - V_POP) / 0.35);
    return false;
  }

  /** Surf: tanzt auf der Kante über der Faust, neigt sich mit der Rampe; Ende = Klatsch zurück. */
  private edgeSpin(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const inE = smooth(t / 0.25);
    const out = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / 0.3);
    const e = inE * (1 - out);
    for (let k = 0; k < 3; k++) o.pos[k] = COIN_REST_POS[k] + (EDGE_POS[k] - COIN_REST_POS[k]) * e;
    this.blendRot(o, COIN_REST_ROT, EDGE_ROT, e);
    // Dreht auf der Kante (Eigenachse = Bild-oben), taumelt leicht, neigt sich mit der Rampe.
    o.spin = SPIN_RATE * t * e;
    this.rotateView(o, 0, 0, 1, (0.12 * Math.sin(t * 7) - 0.3 * this.surfLean) * e);
    // Einlage (PropTricks.beatU): springt von der Kante, überschlägt sich einmal (ganze Drehung: das Motiv vorn
    // bleibt) und landet wieder auf der Kante.
    const u = this.beatU;
    if (u < 1) {
      this.offsetView(o, 0, 2.4 * arc(u) * e, 0.5 * arc(u) * e);
      this.rotateView(o, 1, 0, 0, Math.PI * 2 * smooth(u));
    }
    if (this.beatEnd()) this.kick(o, 0.1, -0.25);
    if (this.mark(0, 0.25, t)) this.kick(o, 0.05, -0.1);
    if (this.surfOut >= 0 && this.mark(1, this.surfOut + 0.3, t)) this.kick(o, 0.2, -0.5);
    // Endet erst nach einer laufenden Einlage (sonst spränge der Überschlag zurück).
    return this.surfOut >= 0 && t >= this.surfOut + 0.3 && u >= 1;
  }

  /** Euler-Mischung (kleine Winkeldifferenzen zwischen nahen Lagen — reicht für Übergänge). */
  private blendRot(o: PropOut, a: M, b: M, s: number): void {
    for (let k = 0; k < 3; k++) {
      let d = b[k] - a[k];
      if (d > Math.PI) d -= Math.PI * 2;
      else if (d < -Math.PI) d += Math.PI * 2;
      o.rot[k] = a[k] + d * s;
    }
  }

  private poofAt(o: PropOut, u: number): void {
    if (u < 0 || u >= 1) return;
    o.poof = u;
    o.poofPos[0] = o.pos[0];
    o.poofPos[1] = o.pos[1];
    o.poofPos[2] = o.pos[2];
  }
}
