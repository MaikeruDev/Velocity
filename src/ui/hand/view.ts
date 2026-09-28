import { VIEW_ALIGNED, VIEW_AXES, axisAngle, fromEulerXYZ, mat3, mul, toEulerXYZ } from './rot';
import type { Mat3 } from './rot';

/**
 * Bild-Richtungen für Gegenstände (Plan 007): Punkte und Lagen im Handgelenk-Raum, gedacht in
 * Bildachsen (rechts, oben, zur Kamera). Die *Ladezeit*-Helfer (viewPoint, viewRot) allokieren;
 * socketPoint rechnet pro Frame ohne Allokation (Scratch-Matrix).
 */

export type V3 = readonly [number, number, number];

/** base + Bildrichtungen (Einheiten) — Ladezeit. */
export function viewPoint(base: V3, right: number, up: number, cam: number): V3 {
  const A = VIEW_AXES;
  return [base[0] + A.right[0] * right + A.up[0] * up + A.cam[0] * cam, base[1] + A.right[1] * right + A.up[1] * up + A.cam[1] * cam, base[2] + A.right[2] * right + A.up[2] * up + A.cam[2] * cam];
}

/** Euler XYZ: VIEW_ALIGNED, danach Drehungen um Bildachsen (0 rechts, 1 oben, 2 Kamera; nacheinander vorangestellt) — Ladezeit. */
export function viewRot(turns: readonly (readonly [0 | 1 | 2, number])[]): V3 {
  const A = VIEW_AXES;
  const axes = [A.right, A.up, A.cam];
  const m = fromEulerXYZ(mat3(), VIEW_ALIGNED[0], VIEW_ALIGNED[1], VIEW_ALIGNED[2]);
  const r = mat3();
  for (const [ax, angle] of turns) {
    const a = axes[ax];
    axisAngle(r, a[0], a[1], a[2], angle);
    mul(m, r, m);
  }
  const e = new Float32Array(3);
  toEulerXYZ(m, e);
  return [e[0], e[1], e[2]];
}

/**
 * Achse (Handgelenk-Raum, normiert) und Winkel der Drehung Q mit Q·R(from) = R(to) — Ladezeit. Pro Frame
 * blendet `rotateLocal(o, ax, ay, az, angle·s)` auf R(from) weich von der einen Lage in die andere
 * (Surf-Zustände: aus dem Griff auf die Fingerspitze). Winkel < π vorausgesetzt (sonst Achse unbestimmt).
 */
export function relRot(from: V3, to: V3): readonly [number, number, number, number] {
  const a = fromEulerXYZ(mat3(), from[0], from[1], from[2]);
  const b = fromEulerXYZ(mat3(), to[0], to[1], to[2]);
  // a⁻¹ = aᵀ (Drehmatrix): Q = b·aᵀ.
  const at = mat3();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) at[r * 3 + c] = a[c * 3 + r];
  const q = mul(mat3(), b, at);
  const cos = Math.max(-1, Math.min(1, (q[0] + q[4] + q[8] - 1) / 2));
  const angle = Math.acos(cos);
  const s = Math.sin(angle);
  if (s < 1e-6) return [0, 1, 0, 0];
  return [(q[7] - q[5]) / (2 * s), (q[2] - q[6]) / (2 * s), (q[3] - q[1]) / (2 * s), angle];
}

const SM: Mat3 = mat3();

/** Lage eines Gegenstands (PropOut) — nur die Felder, die socketOf liest. */
export interface SocketPose {
  readonly pos: ArrayLike<number>;
  readonly rot: ArrayLike<number>;
  readonly spin: number;
  readonly scale: number;
}

/**
 * Wie socketPoint, Lage aus `o` und lokaler Punkt aus einem Puffer: im Frame-Pfad keine Kommazahlen als
 * Argumente (V8 legt für jede an einen nicht geinlineten Aufruf übergebene Kommazahl eine HeapNumber an).
 */
export function socketOf(o: SocketPose, local: ArrayLike<number>, out: Float32Array | Float64Array): void {
  const c = Math.cos(o.spin);
  const s = Math.sin(o.spin);
  const k = o.scale;
  const x = (local[0] * c + local[2] * s) * k;
  const y = local[1] * k;
  const z = (-local[0] * s + local[2] * c) * k;
  const r = o.rot;
  const m = fromEulerXYZ(SM, r[0], r[1], r[2]);
  const p = o.pos;
  out[0] = p[0] + m[0] * x + m[1] * y + m[2] * z;
  out[1] = p[1] + m[3] * x + m[4] * y + m[5] * z;
  out[2] = p[2] + m[6] * x + m[7] * y + m[8] * z;
}

/**
 * Punkt im Gegenstands-Raum → Handgelenk-Raum, genau wie der Renderer den Sockel aufbaut:
 * pos + R_xyz(rot) · (scale · Ry(spin) · p). Pro Frame, keine Allokation. Für Fangpunkte
 * (Kendama-Becher) und Anker am Gegenstand.
 */
export function socketPoint(pos: ArrayLike<number>, rot: ArrayLike<number>, spin: number, scale: number, lx: number, ly: number, lz: number, out: Float32Array | Float64Array): void {
  const c = Math.cos(spin);
  const s = Math.sin(spin);
  // Ry(spin): x' = x c + z s, z' = −x s + z c (three-Konvention).
  const x = (lx * c + lz * s) * scale;
  const y = ly * scale;
  const z = (-lx * s + lz * c) * scale;
  const m = fromEulerXYZ(SM, rot[0], rot[1], rot[2]);
  out[0] = pos[0] + m[0] * x + m[1] * y + m[2] * z;
  out[1] = pos[1] + m[3] * x + m[4] * y + m[5] * z;
  out[2] = pos[2] + m[6] * x + m[7] * y + m[8] * z;
}
