import { VM_RIG } from '../../render/types';
import { fingerPoint, thumbPoint } from './fk';

/**
 * Kollisionsmodell der View-Hand (Plan 008): Handfläche als elliptische Röhre (wie skins/glove), Finger-
 * und Daumenglieder als Kapseln aus der Vorwärtskinematik (fk.ts). Vorzeichenbehafteter Abstand eines
 * Punkts im Handgelenk-Raum zur Hand — Grundlage für Griff-Audit (Kontakt/Durchdringung/Schweben), Finger-
 * Kontakt (Griff schließt sich ums Item) und den Test "Klinge berührt nie den Handschuh".
 * DOM-/three-frei, keine Allokation nach dem Konstruktor. Skins mit eigener Geometrie (Roboter, Skelett,
 * Katze) hängen an denselben Gliedern — das Modell gilt für alle bis auf wenige Zehntel.
 */

/** Teile: 0 Handfläche, 1 + 3·f + seg Fingerglieder (f 0 Zeige … 3 klein), 13 + seg Daumenglieder. */
export const HAND_PART_COUNT = 16;
export const PART_PALM = 0;
export const partFinger = (f: number, seg: number): number => 1 + f * 3 + seg;
export const partThumb = (seg: number): number => 13 + seg;
export const HAND_PART_NAMES: readonly string[] = ['palm', 'idx0', 'idx1', 'idx2', 'mid0', 'mid1', 'mid2', 'ring0', 'ring1', 'ring2', 'pinky0', 'pinky1', 'pinky2', 'thumb0', 'thumb1', 'thumb2'];

/** Handfläche (wie skins/glove buildHand): Ringe y, Halbachsen rx/rz, Mitte cx/cz; Pole. */
const PALM_Y = [-0.9, 0.8, 3.8, 7.0, 8.9] as const;
const PALM_RX = [3.0, 3.75, 4.45, 4.6, 4.4] as const;
const PALM_RZ = [2.2, 2.35, 2.4, 2.25, 1.95] as const;
const PALM_CX = [0, 0, -0.1, 0, 0] as const;
const PALM_CZ = [0.1, 0.05, -0.1, -0.05, 0.05] as const;
const PALM_POLE0 = -1.5;
const PALM_POLE1 = 10.1;
/** Kapsel-Radius = Mittel der Glied-Radien × Abflachung der Glove-Kapseln (capsuleGeometry …, 0.92). */
const FLAT = 0.95;

export class HandShape {
  /** Je Kapsel: A (xyz), B (xyz), Radius — Teile 1..15. */
  readonly a = new Float64Array(HAND_PART_COUNT * 3);
  readonly b = new Float64Array(HAND_PART_COUNT * 3);
  readonly r = new Float64Array(HAND_PART_COUNT);
  /** Teil mit dem kleinsten Abstand beim letzten distance(). */
  lastPart = 0;
  private readonly tmp = new Float64Array(3);

  constructor() {
    for (let f = 0; f < 4; f++) {
      const rr = VM_RIG.fingers[f].r;
      this.r[partFinger(f, 0)] = rr * 0.975 * FLAT;
      this.r[partFinger(f, 1)] = rr * 0.925 * FLAT;
      this.r[partFinger(f, 2)] = rr * 0.885 * FLAT;
    }
    const t = VM_RIG.thumb.r;
    this.r[partThumb(0)] = ((t[0] + t[1]) / 2) * FLAT;
    this.r[partThumb(1)] = ((t[1] + t[2]) / 2) * FLAT;
    this.r[partThumb(2)] = t[2] * 0.96 * FLAT;
  }

  /** Kapseln aus den Gelenkwinkeln (VM_JOINT-Layout) neu setzen. */
  update(joints: ArrayLike<number>): void {
    const p = this.tmp;
    for (let f = 0; f < 4; f++) {
      const len = VM_RIG.fingers[f].len;
      for (let s = 0; s < 3; s++) {
        const i = partFinger(f, s) * 3;
        fingerPoint(joints, f, s, 0, 0, 0, p);
        this.a[i] = p[0];
        this.a[i + 1] = p[1];
        this.a[i + 2] = p[2];
        fingerPoint(joints, f, s, 0, len[s], 0, p);
        this.b[i] = p[0];
        this.b[i + 1] = p[1];
        this.b[i + 2] = p[2];
      }
    }
    const tl = VM_RIG.thumb.len;
    for (let s = 0; s < 3; s++) {
      const i = partThumb(s) * 3;
      thumbPoint(joints, s, 0, 0, 0, p);
      this.a[i] = p[0];
      this.a[i + 1] = p[1];
      this.a[i + 2] = p[2];
      thumbPoint(joints, s, 0, tl[s], 0, p);
      this.b[i] = p[0];
      this.b[i + 1] = p[1];
      this.b[i + 2] = p[2];
    }
  }

  /** Vorzeichenbehafteter Abstand zu Teil i (< 0 = innen). */
  partDistance(i: number, x: number, y: number, z: number): number {
    if (i === PART_PALM) return palmDistance(x, y, z);
    const k = i * 3;
    const ax = this.a[k];
    const ay = this.a[k + 1];
    const az = this.a[k + 2];
    const dx = this.b[k] - ax;
    const dy = this.b[k + 1] - ay;
    const dz = this.b[k + 2] - az;
    const px = x - ax;
    const py = y - ay;
    const pz = z - az;
    const ll = dx * dx + dy * dy + dz * dz;
    let t = ll > 0 ? (px * dx + py * dy + pz * dz) / ll : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = px - dx * t;
    const qy = py - dy * t;
    const qz = pz - dz * t;
    return Math.sqrt(qx * qx + qy * qy + qz * qz) - this.r[i];
  }

  /** Ergebnis von measure(): [0] kleinster Abstand. */
  readonly res = new Float64Array(1);

  /**
   * Wie distance(), Punkt aus p[0..2], Ergebnis in res[0] (setzt lastPart). Für den Frame-Pfad: Kommazahlen als
   * Argumente bzw. Rückgabe eines nicht geinlineten Aufrufs boxt V8 (fallen.md #107) — hier nur Puffer.
   */
  measure(p: ArrayLike<number>): void {
    const x = p[0];
    const y = p[1];
    const z = p[2];
    let best = 1e9;
    let part = 0;
    for (let i = 1; i < HAND_PART_COUNT; i++) {
      const k = i * 3;
      const ax = this.a[k];
      const ay = this.a[k + 1];
      const az = this.a[k + 2];
      const dx = this.b[k] - ax;
      const dy = this.b[k + 1] - ay;
      const dz = this.b[k + 2] - az;
      const px = x - ax;
      const py = y - ay;
      const pz = z - az;
      const ll = dx * dx + dy * dy + dz * dz;
      let t = ll > 0 ? (px * dx + py * dy + pz * dz) / ll : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - dx * t;
      const qy = py - dy * t;
      const qz = pz - dz * t;
      const d = Math.sqrt(qx * qx + qy * qy + qz * qz) - this.r[i];
      if (d < best) {
        best = d;
        part = i;
      }
    }
    // Handfläche (wie palmDistance, hier eingebettet).
    const n = PALM_Y.length;
    let s = 0;
    while (s < n - 2 && y > PALM_Y[s + 1]) s++;
    let u = (y - PALM_Y[s]) / (PALM_Y[s + 1] - PALM_Y[s]);
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const rx = PALM_RX[s] + (PALM_RX[s + 1] - PALM_RX[s]) * u;
    const rz = PALM_RZ[s] + (PALM_RZ[s + 1] - PALM_RZ[s]) * u;
    const cx = PALM_CX[s] + (PALM_CX[s + 1] - PALM_CX[s]) * u;
    const cz = PALM_CZ[s] + (PALM_CZ[s + 1] - PALM_CZ[s]) * u;
    const ex = (x - cx) / rx;
    const ez = (z - cz) / rz;
    const rmin = rx < rz ? rx : rz;
    let pd: number;
    if (y < PALM_Y[0] || y > PALM_Y[n - 1]) {
      const below = y < PALM_Y[0] ? 1 : 0;
      const h = below * (PALM_Y[0] - PALM_POLE0) + (1 - below) * (PALM_POLE1 - PALM_Y[n - 1]);
      const yy = below * (PALM_Y[0] - y) + (1 - below) * (y - PALM_Y[n - 1]);
      const ey = Math.sqrt(ex * ex + ez * ez + (yy / h) * (yy / h));
      pd = (ey - 1) * (rmin < h ? rmin : h);
    } else {
      const e = Math.sqrt(ex * ex + ez * ez);
      const gx = ex / rx;
      const gz = ez / rz;
      const g = Math.sqrt(gx * gx + gz * gz);
      const v = g > 1e-9 ? (e * e - 1) / (2 * g) : -rmin;
      pd = v > -rmin ? v : -rmin;
    }
    if (pd < best) {
      best = pd;
      part = PART_PALM;
    }
    this.res[0] = best;
    this.lastPart = part;
  }

  /** Kleinster Abstand zur ganzen Hand (setzt lastPart). */
  distance(x: number, y: number, z: number): number {
    let best = palmDistance(x, y, z);
    let part = PART_PALM;
    for (let i = 1; i < HAND_PART_COUNT; i++) {
      const d = this.partDistance(i, x, y, z);
      if (d < best) {
        best = d;
        part = i;
      }
    }
    this.lastPart = part;
    return best;
  }
}

/** Handfläche: elliptische Röhre, zwischen den Ringen linear; jenseits der Pole Abstand zur Polkappe (genähert). */
export function palmDistance(x: number, y: number, z: number): number {
  const n = PALM_Y.length;
  let k = 0;
  while (k < n - 2 && y > PALM_Y[k + 1]) k++;
  const y0 = PALM_Y[k];
  const y1 = PALM_Y[k + 1];
  let u = (y - y0) / (y1 - y0);
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const rx = PALM_RX[k] + (PALM_RX[k + 1] - PALM_RX[k]) * u;
  const rz = PALM_RZ[k] + (PALM_RZ[k + 1] - PALM_RZ[k]) * u;
  const cx = PALM_CX[k] + (PALM_CX[k + 1] - PALM_CX[k]) * u;
  const cz = PALM_CZ[k] + (PALM_CZ[k + 1] - PALM_CZ[k]) * u;
  const ex = (x - cx) / rx;
  const ez = (z - cz) / rz;
  const e = Math.sqrt(ex * ex + ez * ez);
  // Abstand zur Ellipse (Näherung über den Gradienten der normierten Form).
  const gx = ex / rx;
  const gz = ez / rz;
  // f = e² − 1, |∇f| = 2g → d ≈ f / |∇f| (exakt auf der Fläche, gut in deren Nähe; innen nach unten begrenzt).
  const g = Math.sqrt(gx * gx + gz * gz);
  const side = g > 1e-9 ? Math.max((e * e - 1) / (2 * g), -Math.min(rx, rz)) : -Math.min(rx, rz);
  // Pole: Kappe als Halbellipsoid bis PALM_POLE0/1.
  if (y < PALM_Y[0] || y > PALM_Y[n - 1]) {
    const yy = y < PALM_Y[0] ? (PALM_Y[0] - y) / (PALM_Y[0] - PALM_POLE0) : (y - PALM_Y[n - 1]) / (PALM_POLE1 - PALM_Y[n - 1]);
    const ey = Math.sqrt(ex * ex + ez * ez + yy * yy);
    const h = y < PALM_Y[0] ? PALM_Y[0] - PALM_POLE0 : PALM_POLE1 - PALM_Y[n - 1];
    return (ey - 1) * Math.min(rx, rz, h);
  }
  return side;
}
