import { VM_ARM_BASE } from '../../render/types';

/**
 * 3×3-Rotationen ohne Allokation (Zeilen-Hauptordnung, Float64Array(9)) für die Tricks der
 * Gegenstände. DOM- und three-frei. Konvention wie three.js: Euler 'XYZ' = Rx·Ry·Rz.
 */

export type Mat3 = Float64Array;

export function mat3(): Mat3 {
  const m = new Float64Array(9);
  m[0] = 1;
  m[4] = 1;
  m[8] = 1;
  return m;
}

/** m = Drehung um die (normierte) Achse a um den Winkel. */
export function axisAngle(m: Mat3, ax: number, ay: number, az: number, angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  m[0] = t * ax * ax + c;
  m[1] = t * ax * ay - s * az;
  m[2] = t * ax * az + s * ay;
  m[3] = t * ax * ay + s * az;
  m[4] = t * ay * ay + c;
  m[5] = t * ay * az - s * ax;
  m[6] = t * ax * az - s * ay;
  m[7] = t * ay * az + s * ax;
  m[8] = t * az * az + c;
  return m;
}

/**
 * Wie axisAngle, Achse (normiert) und Winkel aus q[0..3] — für den Frame-Pfad: Kommazahlen als Argumente
 * eines nicht geinlineten Aufrufs boxt V8 (je Aufruf eine HeapNumber), Plätze eines Float64Array nicht.
 * Gleiche Rechnung in gleicher Reihenfolge wie axisAngle (bitgleich).
 */
export function axisAngleQ(m: Mat3, q: Float64Array): Mat3 {
  const ax = q[0];
  const ay = q[1];
  const az = q[2];
  const c = Math.cos(q[3]);
  const s = Math.sin(q[3]);
  const t = 1 - c;
  m[0] = t * ax * ax + c;
  m[1] = t * ax * ay - s * az;
  m[2] = t * ax * az + s * ay;
  m[3] = t * ax * ay + s * az;
  m[4] = t * ay * ay + c;
  m[5] = t * ay * az - s * ax;
  m[6] = t * ax * az - s * ay;
  m[7] = t * ay * az + s * ax;
  m[8] = t * az * az + c;
  return m;
}

/** out = a · b (out darf a oder b sein). */
export function mul(out: Mat3, a: Mat3, b: Mat3): Mat3 {
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
  return out;
}

/** out = a · bᵀ (out darf weder a noch b sein) — bei Drehungen: die Drehung, die b in a überführt. */
export function mulT(out: Mat3, a: Mat3, b: Mat3): Mat3 {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 3 + j] = a[i * 3] * b[j * 3] + a[i * 3 + 1] * b[j * 3 + 1] + a[i * 3 + 2] * b[j * 3 + 2];
  }
  return out;
}

/**
 * Drehmatrix → Achse (normiert) und Winkel 0..π in q[0..3] (kürzester Weg; Quaternion nach Shepperd,
 * stabil auch nahe π). Ohne Drehung: Achse x, Winkel 0.
 */
export function toAxisAngleQ(m: Mat3, q: Float64Array): void {
  const tr = m[0] + m[4] + m[8];
  let w: number;
  let x: number;
  let y: number;
  let z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s;
    x = (m[7] - m[5]) / s;
    y = (m[2] - m[6]) / s;
    z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s;
    x = 0.25 * s;
    y = (m[1] + m[3]) / s;
    z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s;
    x = (m[1] + m[3]) / s;
    y = 0.25 * s;
    z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s;
    x = (m[2] + m[6]) / s;
    y = (m[5] + m[7]) / s;
    z = 0.25 * s;
  }
  // q und −q sind dieselbe Drehung: w ≥ 0 wählt den kürzeren Weg (Winkel ≤ π).
  const sign = w < 0 ? -1 : 1;
  const l = Math.sqrt(x * x + y * y + z * z);
  if (!(l > 1e-12)) {
    q[0] = 1;
    q[1] = 0;
    q[2] = 0;
    q[3] = 0;
    return;
  }
  q[0] = (sign * x) / l;
  q[1] = (sign * y) / l;
  q[2] = (sign * z) / l;
  q[3] = 2 * Math.atan2(l, sign * w);
}

/** Euler XYZ (Rx·Ry·Rz) → m. */
export function fromEulerXYZ(m: Mat3, x: number, y: number, z: number): Mat3 {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  m[0] = c * e;
  m[1] = -c * f;
  m[2] = d;
  m[3] = a * f + b * e * d;
  m[4] = a * e - b * f * d;
  m[5] = -b * c;
  m[6] = b * f - a * e * d;
  m[7] = b * e + a * f * d;
  m[8] = a * c;
  return m;
}

/** Wie fromEulerXYZ, Winkel aus e[0..2] (Frame-Pfad, siehe axisAngleQ; bitgleich). */
export function fromEulerXYZV(m: Mat3, e: Float32Array): Mat3 {
  const a = Math.cos(e[0]), b = Math.sin(e[0]), c = Math.cos(e[1]), d = Math.sin(e[1]), g = Math.cos(e[2]), f = Math.sin(e[2]);
  m[0] = c * g;
  m[1] = -c * f;
  m[2] = d;
  m[3] = a * f + b * g * d;
  m[4] = a * g - b * f * d;
  m[5] = -b * c;
  m[6] = b * f - a * g * d;
  m[7] = b * g + a * f * d;
  m[8] = a * c;
  return m;
}

/** m → Euler XYZ in out[0..2] (wie three.Euler.setFromRotationMatrix). */
export function toEulerXYZ(m: Mat3, out: Float32Array): void {
  const m13 = Math.max(-1, Math.min(1, m[2]));
  out[1] = Math.asin(m13);
  if (Math.abs(m13) < 0.9999999) {
    out[0] = Math.atan2(-m[5], m[8]);
    out[2] = Math.atan2(-m[1], m[0]);
  } else {
    out[0] = Math.atan2(m[7], m[4]);
    out[2] = 0;
  }
}

/**
 * Bildachsen im Handgelenk-Raum (aus VM_ARM_BASE, Handgelenk-Gelenke vernachlässigt — die
 * Tricks laufen in Posen mit geradem Handgelenk): UP = oben im Bild, RIGHT = rechts,
 * CAM = zur Kamera hin. Damit fliegt eine geworfene Dose im Bild nach oben, egal wie der
 * Arm im Raum liegt.
 */
function viewAxes(): { up: readonly [number, number, number]; right: readonly [number, number, number]; cam: readonly [number, number, number] } {
  // R = Rz(roll)·Rx(pitch)·Ry(twist) (three Euler 'ZXY'); lokal = Rᵀ·Bild → Spalte j von Rᵀ = Zeile j von R.
  const { pitch, twist, roll } = VM_ARM_BASE;
  const rz = axisAngle(mat3(), 0, 0, 1, roll);
  const rx = axisAngle(mat3(), 1, 0, 0, pitch);
  const ry = axisAngle(mat3(), 0, 1, 0, twist);
  const r = mul(mat3(), mul(mat3(), rz, rx), ry);
  return {
    right: [r[0], r[1], r[2]],
    up: [r[3], r[4], r[5]],
    cam: [r[6], r[7], r[8]],
  };
}

export const VIEW_AXES = viewAxes();

/**
 * Euler XYZ einer Drehung, die die Achsen eines Gegenstands mit den BILDachsen zur Deckung
 * bringt (x rechts, y oben, z zur Kamera) — Ausgangspunkt für Karte und Messer, deren Lage
 * man im Bild denkt, nicht im Handgelenk-Raum.
 */
function viewAligned(): readonly [number, number, number] {
  const A = VIEW_AXES;
  const m = mat3();
  // Spalten = Bildachsen im Handgelenk-Raum.
  m[0] = A.right[0];
  m[3] = A.right[1];
  m[6] = A.right[2];
  m[1] = A.up[0];
  m[4] = A.up[1];
  m[7] = A.up[2];
  m[2] = A.cam[0];
  m[5] = A.cam[1];
  m[8] = A.cam[2];
  const e = new Float32Array(3);
  toEulerXYZ(m, e);
  return [e[0], e[1], e[2]];
}

export const VIEW_ALIGNED = viewAligned();
