import { Vector3 } from 'three';

/**
 * Konvexe Hülle kleiner Punktmengen (≤ ~32 Punkte) per Brute Force über alle
 * Tripel. Für Level-Brushes (Box = 8, Prisma = 2n Punkte) ist das schneller
 * zu schreiben als Quickhull und robust genug; kompiliert wird nur beim Laden.
 */

export interface HullPlane {
  normal: Vector3;
  dist: number;
}

export interface HullFace {
  plane: HullPlane;
  /** CCW von außen gesehen (Normale zeigt zum Betrachter). */
  vertices: Vector3[];
}

export interface Hull {
  planes: HullPlane[];
  faces: HullFace[];
  points: Vector3[];
}

const POINT_EPS = 1e-3;
const PLANE_EPS = 1e-2;

export function dedupePoints(points: readonly Vector3[]): Vector3[] {
  const out: Vector3[] = [];
  for (const p of points) {
    if (!out.some((q) => q.distanceToSquared(p) < POINT_EPS * POINT_EPS)) out.push(p.clone());
  }
  return out;
}

export function computeHull(input: readonly Vector3[]): Hull {
  const pts = dedupePoints(input);
  if (pts.length < 4) throw new Error(`Hülle braucht ≥ 4 verschiedene Punkte, hat ${pts.length}`);

  const planes: HullPlane[] = [];
  const e1 = new Vector3();
  const e2 = new Vector3();
  const n = new Vector3();

  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      for (let k = j + 1; k < pts.length; k++) {
        e1.subVectors(pts[j], pts[i]);
        e2.subVectors(pts[k], pts[i]);
        n.crossVectors(e1, e2);
        const len = n.length();
        if (len < 1e-6) continue;
        n.divideScalar(len);
        const d = n.dot(pts[i]);
        let front = 0;
        let back = 0;
        for (const p of pts) {
          const s = n.dot(p) - d;
          if (s > PLANE_EPS) front++;
          else if (s < -PLANE_EPS) back++;
          if (front && back) break;
        }
        if (front && back) continue;
        if (front === 0 && back === 0) continue; // alle koplanar
        // Normale muss nach außen zeigen: alle Punkte dahinter.
        const normal = front === 0 ? n.clone() : n.clone().negate();
        const dist = front === 0 ? d : -d;
        if (!planes.some((q) => q.normal.dot(normal) > 1 - 1e-6 && Math.abs(q.dist - dist) < PLANE_EPS * 4)) {
          planes.push({ normal, dist });
        }
      }
    }
  }
  if (planes.length < 4) throw new Error('Degenerierte Hülle (koplanare Punkte?)');

  const faces: HullFace[] = planes.map((plane) => ({ plane, vertices: faceVertices(plane, pts) }));
  return { planes, faces: faces.filter((f) => f.vertices.length >= 3), points: pts };
}

function faceVertices(plane: HullPlane, pts: readonly Vector3[]): Vector3[] {
  const on = pts.filter((p) => Math.abs(plane.normal.dot(p) - plane.dist) < PLANE_EPS * 4);
  const c = new Vector3();
  for (const p of on) c.add(p);
  c.divideScalar(on.length);
  // Basis (u, v) mit u × v = normal → steigender Winkel ist CCW um die Normale.
  const u = Math.abs(plane.normal.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  u.cross(plane.normal).normalize();
  const v = new Vector3().crossVectors(plane.normal, u);
  const tmp = new Vector3();
  const sorted = on
    .map((p) => {
      tmp.subVectors(p, c);
      return { p, a: Math.atan2(tmp.dot(v), tmp.dot(u)) };
    })
    .sort((a, b) => a.a - b.a)
    .map((x) => x.p);
  return removeCollinear(sorted);
}

function removeCollinear(poly: Vector3[]): Vector3[] {
  if (poly.length <= 3) return poly;
  const out: Vector3[] = [];
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 0; i < poly.length; i++) {
    const prev = poly[(i + poly.length - 1) % poly.length];
    const cur = poly[i];
    const next = poly[(i + 1) % poly.length];
    a.subVectors(cur, prev);
    b.subVectors(next, cur);
    if (a.cross(b).lengthSq() > 1e-6 * Math.max(1, prev.distanceToSquared(next))) out.push(cur);
  }
  return out.length >= 3 ? out : poly;
}
