import { VM_JOINT, VM_JOINT_COUNT, VM_RIG } from '../../render/types';
import { fingerPoint, thumbPoint } from './fk';
import { HandShape, partFinger, partThumb } from './handShape';
import type { PropShape } from './propShape';

/**
 * Finger-Kontakt (Plan 008): Finger und Daumen schließen sich wie beim Greifen von einer offenen Haltung in
 * Richtung einer "zu"-Haltung (z. B. Faust), bis sie den Gegenstand berühren — der Griff legt sich sichtbar
 * um das Item, statt durch es hindurch oder in der Luft zu greifen. Je Finger EIN Beuge-Parameter c ∈ [0, 1]
 * (open → closed; Grund-, Mittel-, Endgelenk gemeinsam, wie eine echte Greifbewegung), Kontakt per Bisektion
 * auf dem Abstand der Glied-Kapseln zum PropShape. Spreizen und Handgelenk bleiben wie in `joints`.
 *
 * Nutzung pro Frame (afterPose) oder einmal zum Backen einer Griff-Pose (tools/hand-grips.ts). Keine
 * Allokation nach dem Konstruktor.
 */

/** Bits der Finger-Maske: 1 Zeige, 2 Mittel, 4 Ring, 8 klein, 16 Daumen. */
export const GRIP_INDEX = 1;
export const GRIP_MIDDLE = 2;
export const GRIP_RING = 4;
export const GRIP_PINKY = 8;
export const GRIP_THUMB = 16;
export const GRIP_FINGERS = 15;
export const GRIP_ALL = 31;

const ITER = 14;
/** Abtastpunkte je Glied-Achse. */
const AXIS_N = 4;

export class GripSolver {
  readonly hand = new HandShape();
  /** Ergebnis je Finger (0..3, 4 = Daumen): Beugung je Gelenk-Stufe (3) und erreichter Abstand. */
  readonly curl = new Float64Array(15);
  readonly gap = new Float64Array(5);
  private readonly start = new Float32Array(VM_JOINT_COUNT);
  private readonly work = new Float32Array(VM_JOINT_COUNT);
  private readonly p = new Float64Array(3);
  private readonly c3 = new Float64Array(3);

  /**
   * Finger in `mask` von `open` Richtung `closed` schließen, bis der Abstand zu `shape` ≤ `squeeze`
   * (negativ = leicht eindrücken, weicher Handschuh). Wie ein echter Griff in Stufen: erst schließen alle
   * Gelenke gemeinsam, bis irgendein Glied anliegt; dann bleibt das Grundgelenk stehen und Mittel-/Endgelenk
   * schließen weiter, bis Mittel- oder Endglied anliegt; dann das Endgelenk allein — so legt sich der Finger
   * um den Gegenstand, statt mit der Spitze daran hängen zu bleiben. `limit` (0..1) begrenzt das Schließen
   * (Fang: die Hand ist erst halb zu). Schreibt die Beugung in `joints` (übrige Gelenke bleiben); Rückgabe:
   * Maske der Finger mit Kontakt.
   */
  close(joints: Float32Array, open: ArrayLike<number>, closed: ArrayLike<number>, shape: PropShape, mask: number, squeeze: number, limit = 1): number {
    this.start.set(joints);
    const lim = limit < 1 ? limit : 1;
    let touched = 0;
    for (let f = 0; f < 5; f++) {
      if ((mask & (1 << f)) === 0) continue;
      const c = this.c3;
      c[0] = 0;
      c[1] = 0;
      c[2] = 0;
      for (let s = 0; s < 3; s++) {
        // Stufe s: Gelenke ≥ s gemeinsam von c[s] (Stand der Vorstufe) bis lim, Kontakt nur an Gliedern ≥ s.
        let lo = c[s];
        let hi = lim;
        if (this.distStage(f, s, hi, open, closed, shape) > squeeze) {
          for (let k = s; k < 3; k++) c[k] = hi;
          continue;
        }
        if (this.distStage(f, s, lo, open, closed, shape) > squeeze) {
          for (let k = 0; k < ITER; k++) {
            const mid = (lo + hi) / 2;
            if (this.distStage(f, s, mid, open, closed, shape) > squeeze) lo = mid;
            else hi = mid;
          }
        }
        touched |= 1 << f;
        for (let k = s; k < 3; k++) c[k] = lo;
      }
      for (let k = 0; k < 3; k++) this.curl[f * 3 + k] = c[k];
      this.gap[f] = this.distStage(f, 2, c[2], open, closed, shape, 0);
      applyStages(joints, f, c, open, closed);
    }
    return touched;
  }

  /**
   * Griff anpassen (zum Backen von Posen, nicht pro Frame: ~9000 Proben je Finger): Gitter-Suche über die
   * drei Beugungen je Finger. Kosten: Durchdringung (stark) + Abstand jedes Glieds zum Gegenstand (jedes Glied
   * soll anliegen) − etwas Beugung (lieber umschließen als abstehen). Ergebnis wie close() in `joints`.
   * `wGap` je Glied (Grund, Mittel, End) gewichtet, welches Glied anliegen SOLL (0 = egal).
   */
  fit(joints: Float32Array, open: ArrayLike<number>, closed: ArrayLike<number>, shape: PropShape, mask: number, squeeze: number, wGap: readonly [number, number, number] = [0.6, 1, 1], steps = 20): number {
    this.start.set(joints);
    const c = this.c3;
    const best = new Float64Array(3);
    let touched = 0;
    for (let f = 0; f < 5; f++) {
      if ((mask & (1 << f)) === 0) continue;
      let bestCost = Infinity;
      for (let a = 0; a <= steps; a++) {
        for (let b = 0; b <= steps; b++) {
          for (let d = 0; d <= steps; d++) {
            c[0] = a / steps;
            c[1] = b / steps;
            c[2] = d / steps;
            // Lieber gemeinsam gebeugt (natürliche Greifkurve) als einzelne Gelenke im Zickzack.
            let cost = -0.04 * (c[0] + c[1] + c[2]) + 0.15 * (Math.abs(c[0] - c[1]) + Math.abs(c[1] - c[2]));
            for (let seg = 0; seg < 3; seg++) {
              const g = this.segDist(f, seg, open, closed, shape);
              if (g < squeeze) cost += 12 * (squeeze - g);
              else cost += 0.5 * wGap[seg] * Math.min(2, g - squeeze);
            }
            if (cost < bestCost) {
              bestCost = cost;
              best.set(c);
            }
          }
        }
      }
      c.set(best);
      for (let k = 0; k < 3; k++) this.curl[f * 3 + k] = c[k];
      let g = 1e9;
      for (let seg = 0; seg < 3; seg++) g = Math.min(g, this.segDist(f, seg, open, closed, shape));
      this.gap[f] = g;
      if (g < 0.35) touched |= 1 << f;
      applyStages(joints, f, c, open, closed);
    }
    return touched;
  }

  /** Abstand eines Glieds bei Beugung c3 (Gelenke aller Stufen aus c3). */
  private segDist(f: number, seg: number, open: ArrayLike<number>, closed: ArrayLike<number>, shape: PropShape): number {
    const w = this.work;
    w.set(this.start);
    applyStages(w, f, this.c3, open, closed);
    const p = this.p;
    const len = f < 4 ? VM_RIG.fingers[f].len[seg] : VM_RIG.thumb.len[seg];
    const r = this.hand.r[f < 4 ? partFinger(f, seg) : partThumb(seg)];
    const top = seg === 2 ? len + r * 0.8 : len;
    let best = 1e9;
    for (let i = seg === 0 ? 1 : 0; i <= AXIS_N; i++) {
      const y = (top * i) / AXIS_N;
      if (f < 4) fingerPoint(w, f, seg, 0, y, 0, p);
      else thumbPoint(w, seg, 0, y, 0, p);
      const d = shape.distance(p[0], p[1], p[2]) - (seg === 2 && i === AXIS_N ? r * 0.2 : r);
      if (d < best) best = d;
    }
    return best;
  }

  /** Abstand der Glieder ≥ `from` (Standard: die der Stufe) bei Gelenken < s auf c3, Gelenken ≥ s auf v. */
  private distStage(f: number, s: number, v: number, open: ArrayLike<number>, closed: ArrayLike<number>, shape: PropShape, from = s): number {
    const w = this.work;
    w.set(this.start);
    const c = this.c3;
    const k0 = c[0];
    const k1 = c[1];
    const k2 = c[2];
    c[0] = s <= 0 ? v : k0;
    c[1] = s <= 1 ? v : k1;
    c[2] = v;
    applyStages(w, f, c, open, closed);
    c[0] = k0;
    c[1] = k1;
    c[2] = k2;
    const p = this.p;
    let best = 1e9;
    for (let seg = from; seg < 3; seg++) {
      const len = f < 4 ? VM_RIG.fingers[f].len[seg] : VM_RIG.thumb.len[seg];
      const r = this.hand.r[f < 4 ? partFinger(f, seg) : partThumb(seg)];
      // Endglied bis in die Kuppe abtasten (Kugelkappe über die Gliedlänge hinaus).
      const top = seg === 2 ? len + r * 0.8 : len;
      // Die Wurzel des Glieds, das sich in dieser Stufe dreht, liegt im Gelenk: ihr Kontakt hält die Drehung nicht auf
      // (sonst bliebe ein Finger, der am Mittelgelenk anliegt, gestreckt hängen).
      const i0 = seg === from && from > 0 ? 2 : 0;
      for (let i = i0; i <= AXIS_N; i++) {
        const y = (top * i) / AXIS_N;
        if (f < 4) fingerPoint(w, f, seg, 0, y, 0, p);
        else thumbPoint(w, seg, 0, y, 0, p);
        const d = shape.distance(p[0], p[1], p[2]) - (seg === 2 && i === AXIS_N ? r * 0.2 : r);
        if (d < best) best = d;
      }
    }
    return best;
  }
}

/**
 * Finger f (0..3, 4 = Daumen) mit Stufen-Beugung c[0..2] setzen: Finger Grund-/Mittel-/Endgelenk = c[0]/c[1]/c[2];
 * Daumen: Abspreizen + Opposition = c[0], Grundgelenk c[1], Endgelenk c[2]. open → closed.
 */
export function applyStages(j: Float32Array, f: number, c: ArrayLike<number>, open: ArrayLike<number>, closed: ArrayLike<number>): void {
  if (f < 4) {
    const b = VM_JOINT.finger + f * 4;
    for (let k = 1; k < 4; k++) j[b + k] = open[b + k] + (closed[b + k] - open[b + k]) * c[k - 1];
  } else {
    const J = VM_JOINT;
    j[J.thumbAbd] = open[J.thumbAbd] + (closed[J.thumbAbd] - open[J.thumbAbd]) * c[0];
    j[J.thumbOpp] = open[J.thumbOpp] + (closed[J.thumbOpp] - open[J.thumbOpp]) * c[0];
    j[J.thumbMcp] = open[J.thumbMcp] + (closed[J.thumbMcp] - open[J.thumbMcp]) * c[1];
    j[J.thumbIp] = open[J.thumbIp] + (closed[J.thumbIp] - open[J.thumbIp]) * c[2];
  }
}

/** Gemeinsame Beugung c für alle Gelenke eines Fingers (Fang-Animation ohne Kontakt). */
export function setCurl(j: Float32Array, f: number, c: number, open: ArrayLike<number>, closed: ArrayLike<number>): void {
  SC[0] = c;
  SC[1] = c;
  SC[2] = c;
  applyStages(j, f, SC, open, closed);
}
const SC = new Float64Array(3);
