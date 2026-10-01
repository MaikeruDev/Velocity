import { fromEulerXYZ, fromEulerXYZV, mat3 } from './rot';
import type { Mat3 } from './rot';

/**
 * Einfache Körper eines Gegenstands (Plan 008) für Finger-Kontakt und Abstands-Prüfungen: Quader,
 * Zylinder (Achse y), Kugeln, Kapseln (Achse y) — je mit Lage in einem "Glied" des Gegenstands. Glieder
 * sind Transformationen im Handgelenk-Raum, die der Aufrufer pro Frame setzt (setLink): 0 = Sockel
 * (propPos/propRot/propSpin/propScale), weitere für bewegliche Teile (Messer: Klinge, zweiter Griff;
 * Jo-Jo/Kendama-Kugel: zweiter Körper). Abstand vorzeichenbehaftet (< 0 = innen). Maße wie die Geometrie
 * in render/viewmodel/items (Zahlen dort nachschlagen, Tests vergleichen mit dem echten Mesh).
 * DOM-/three-frei; nach dem Aufbau keine Allokation.
 */

export const enum Prim {
  Box = 0,
  Cylinder = 1,
  Sphere = 2,
  Capsule = 3,
}

export interface PrimDef {
  readonly kind: Prim;
  /** Glied (0 = Sockel). */
  readonly link?: number;
  /** Mitte im Glied. */
  readonly at: readonly [number, number, number];
  /** Box: Halbmaße; Zylinder/Kapsel: [Radius, halbe Höhe (y), –]; Kugel: [Radius]. */
  readonly size: readonly number[];
  /** Euler XYZ im Glied (rad). */
  readonly rot?: readonly [number, number, number];
}

const MAX_LINKS = 4;

export class PropShape {
  readonly n: number;
  private readonly kind: Int8Array;
  private readonly link: Int8Array;
  /** Je Körper: Mitte (3) und Drehung (9) im Glied, Maße (3). */
  private readonly c: Float64Array;
  private readonly r: Float64Array;
  private readonly s: Float64Array;
  /** Glieder: Drehung (9), Verschiebung (3), Skalierung (1) im Handgelenk-Raum. */
  private readonly lr = new Float64Array(MAX_LINKS * 9);
  private readonly lt = new Float64Array(MAX_LINKS * 3);
  private readonly ls = new Float64Array(MAX_LINKS).fill(1);
  /** Glieder an/aus (unsichtbarer zweiter Körper zählt nicht). */
  readonly linkOn = new Uint8Array(MAX_LINKS).fill(1);

  constructor(defs: readonly PrimDef[]) {
    this.n = defs.length;
    this.kind = new Int8Array(this.n);
    this.link = new Int8Array(this.n);
    this.c = new Float64Array(this.n * 3);
    this.r = new Float64Array(this.n * 9);
    this.s = new Float64Array(this.n * 3);
    const m: Mat3 = mat3();
    defs.forEach((d, i) => {
      this.kind[i] = d.kind;
      this.link[i] = d.link ?? 0;
      this.c.set(d.at, i * 3);
      const e = d.rot ?? [0, 0, 0];
      fromEulerXYZ(m, e[0], e[1], e[2]);
      this.r.set(m, i * 9);
      for (let k = 0; k < 3; k++) this.s[i * 3 + k] = d.size[k] ?? 0;
    });
    for (let l = 0; l < MAX_LINKS; l++) {
      this.lr[l * 9] = 1;
      this.lr[l * 9 + 4] = 1;
      this.lr[l * 9 + 8] = 1;
    }
  }

  /** Glied l = Verschiebung t + Drehung R (Zeilen-Hauptordnung) · Skalierung s. */
  setLink(l: number, R: Mat3, tx: number, ty: number, tz: number, s: number): void {
    for (let k = 0; k < 9; k++) this.lr[l * 9 + k] = R[k];
    this.lt[l * 3] = tx;
    this.lt[l * 3 + 1] = ty;
    this.lt[l * 3 + 2] = tz;
    this.ls[l] = s;
  }

  /** Abstand eines Punkts (Handgelenk-Raum) zum ganzen Gegenstand. */
  distance(x: number, y: number, z: number): number {
    let best = 1e9;
    for (let i = 0; i < this.n; i++) {
      if (this.linkOn[this.link[i]] === 0) continue;
      const d = this.primDistance(i, x, y, z);
      if (d < best) best = d;
    }
    return best;
  }

  /** Abstand nur zu den Körpern eines Glieds (Messer: nur die Klinge). */
  linkDistance(l: number, x: number, y: number, z: number): number {
    let best = 1e9;
    for (let i = 0; i < this.n; i++) {
      if (this.link[i] !== l) continue;
      const d = this.primDistance(i, x, y, z);
      if (d < best) best = d;
    }
    return best;
  }

  private primDistance(i: number, x: number, y: number, z: number): number {
    const l = this.link[i];
    const L = this.lr;
    const o = l * 9;
    const sc = this.ls[l];
    // Ins Glied: (p − t) · Rᵀ / s
    const px = x - this.lt[l * 3];
    const py = y - this.lt[l * 3 + 1];
    const pz = z - this.lt[l * 3 + 2];
    const gx = (L[o] * px + L[o + 3] * py + L[o + 6] * pz) / sc;
    const gy = (L[o + 1] * px + L[o + 4] * py + L[o + 7] * pz) / sc;
    const gz = (L[o + 2] * px + L[o + 5] * py + L[o + 8] * pz) / sc;
    // Ins Körper-Lokale.
    const R = this.r;
    const q = i * 9;
    const dx = gx - this.c[i * 3];
    const dy = gy - this.c[i * 3 + 1];
    const dz = gz - this.c[i * 3 + 2];
    const lx = R[q] * dx + R[q + 3] * dy + R[q + 6] * dz;
    const ly = R[q + 1] * dx + R[q + 4] * dy + R[q + 7] * dz;
    const lz = R[q + 2] * dx + R[q + 5] * dy + R[q + 8] * dz;
    const s0 = this.s[i * 3];
    const s1 = this.s[i * 3 + 1];
    const s2 = this.s[i * 3 + 2];
    let d: number;
    switch (this.kind[i]) {
      case Prim.Box: {
        const ax = Math.abs(lx) - s0;
        const ay = Math.abs(ly) - s1;
        const az = Math.abs(lz) - s2;
        const ox = ax > 0 ? ax : 0;
        const oy = ay > 0 ? ay : 0;
        const oz = az > 0 ? az : 0;
        const inside = Math.max(ax, ay, az);
        d = Math.sqrt(ox * ox + oy * oy + oz * oz) + (inside < 0 ? inside : 0);
        break;
      }
      case Prim.Cylinder: {
        const rr = Math.sqrt(lx * lx + lz * lz) - s0;
        const hh = Math.abs(ly) - s1;
        const orr = rr > 0 ? rr : 0;
        const ohh = hh > 0 ? hh : 0;
        const inside = Math.max(rr, hh);
        d = Math.sqrt(orr * orr + ohh * ohh) + (inside < 0 ? inside : 0);
        break;
      }
      case Prim.Sphere:
        d = Math.sqrt(lx * lx + ly * ly + lz * lz) - s0;
        break;
      default: {
        const yy = ly > s1 ? ly - s1 : ly < -s1 ? ly + s1 : 0;
        d = Math.sqrt(lx * lx + yy * yy + lz * lz) - s0;
        break;
      }
    }
    return d * sc;
  }
}

/**
 * Sockel-Matrix wie der Renderer (ViewModel.applyItem): R = Euler XYZ(rot) · Ry(spin), t = pos, s = scale.
 * Schreibt in `out` (Mat3) — keine Allokation.
 */
export function socketMatrix(rot: Float32Array, spin: number, out: Mat3, tmp: Mat3): Mat3 {
  fromEulerXYZV(out, rot);
  const c = Math.cos(spin);
  const s = Math.sin(spin);
  // out · Ry(spin): Spalte 0 = c·col0 − s·col2, Spalte 2 = s·col0 + c·col2.
  for (let r = 0; r < 3; r++) {
    const a = out[r * 3];
    const b = out[r * 3 + 2];
    tmp[r * 3] = c * a - s * b;
    tmp[r * 3 + 1] = out[r * 3 + 1];
    tmp[r * 3 + 2] = s * a + c * b;
  }
  for (let k = 0; k < 9; k++) out[k] = tmp[k];
  return out;
}
