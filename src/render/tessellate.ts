import { Vector3 } from 'three';

/**
 * Tesselierung konvexer Brush-Flächen in ~64-u-Zellen.
 *
 * Geschnitten wird an den Welt-Gitterebenen x = k·cell, y = k·cell, z = k·cell
 * (nicht im lokalen 2D-Raster der Fläche). Grund: zwei Flächen, die sich eine
 * Kante teilen, bekommen so auf dieser Kante exakt dieselben Schnittpunkte —
 * keine T-Junctions, keine Risse, wenn Vertex-Snapping die Punkte verschiebt.
 * Für achsparallele Flächen ist das identisch mit einem 2D-Gitter.
 */

const EPS = 1e-4;

export type Axis = 0 | 1 | 2;

export function axisCoord(v: Vector3, axis: Axis): number {
  return axis === 0 ? v.x : axis === 1 ? v.y : v.z;
}

/** Lexikografische Ordnung — Schnittpunkte werden immer von derselben Seite interpoliert (bitgleich). */
function lexLess(a: Vector3, b: Vector3): boolean {
  if (a.x !== b.x) return a.x < b.x;
  if (a.y !== b.y) return a.y < b.y;
  return a.z < b.z;
}

export function intersectAxis(a: Vector3, b: Vector3, axis: Axis, value: number): Vector3 {
  const [p, q] = lexLess(a, b) ? [a, b] : [b, a];
  const pa = axisCoord(p, axis);
  const t = (value - pa) / (axisCoord(q, axis) - pa);
  const r = new Vector3().lerpVectors(p, q, t);
  if (axis === 0) r.x = value;
  else if (axis === 1) r.y = value;
  else r.z = value;
  return r;
}

/** Teilt ein konvexes Polygon an der Ebene axis = value in [unterhalb, oberhalb]. */
function splitAt(poly: readonly Vector3[], axis: Axis, value: number): [Vector3[], Vector3[]] {
  const below: Vector3[] = [];
  const above: Vector3[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const da = axisCoord(a, axis) - value;
    const db = axisCoord(b, axis) - value;
    if (da <= EPS) below.push(a);
    if (da >= -EPS) above.push(a);
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const p = intersectAxis(a, b, axis, value);
      below.push(p);
      above.push(p);
    }
  }
  return [below, above];
}

function sliceAxis(polys: readonly Vector3[][], axis: Axis, cell: number): Vector3[][] {
  const out: Vector3[][] = [];
  for (const poly of polys) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of poly) {
      const c = axisCoord(v, axis);
      if (c < min) min = c;
      if (c > max) max = c;
    }
    let rest: Vector3[] = poly;
    const k0 = Math.ceil(min / cell);
    const k1 = Math.floor(max / cell);
    for (let k = k0; k <= k1; k++) {
      const v = k * cell;
      if (v <= min + EPS || v >= max - EPS) continue;
      const [lo, hi] = splitAt(rest, axis, v);
      if (lo.length >= 3) out.push(lo);
      rest = hi;
    }
    if (rest.length >= 3) out.push(rest);
  }
  return out;
}

function polygonArea(poly: readonly Vector3[]): number {
  const acc = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  const c = new Vector3();
  for (let i = 1; i + 1 < poly.length; i++) {
    e1.subVectors(poly[i], poly[0]);
    e2.subVectors(poly[i + 1], poly[0]);
    acc.add(c.crossVectors(e1, e2));
  }
  return acc.length() * 0.5;
}

/**
 * Zerlegt eine konvexe Fläche in konvexe Stücke entlang der Weltgitter-Ebenen.
 * Achsen, zu denen die Fläche parallel liegt, werden übersprungen.
 */
export function tessellateFace(vertices: readonly Vector3[], normal: Vector3, cell: number): Vector3[][] {
  let pieces: Vector3[][] = [vertices.slice()];
  const n = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
  for (const axis of [0, 1, 2] as const) {
    if (n[axis] > 0.999) continue;
    pieces = sliceAxis(pieces, axis, cell);
  }
  return pieces.filter((p) => p.length >= 3 && polygonArea(p) > 1e-3);
}
