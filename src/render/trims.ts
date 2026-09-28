import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import type { BrushFace, CompiledBrush } from '../world/collision/types';
import type { CompiledLevel } from '../world/level/compileLevel';
import { KIND_COLORS, materialTrimColor } from './palette';
import { BrushGrid, TESS_CELL } from './levelMesh';
import { hexToRgb } from './util';
import type { Rgb } from './util';

/**
 * Neon-Trims an den Außenkanten begehbarer Oberseiten.
 *
 * Pro Kante zwei Bänder, die die Kante umgreifen: ~3 u auf der Oberseite nach
 * innen und ~4 u die Seitenfläche hinunter. Die Bänder liegen knapp über den
 * Flächen (polygonOffset gegen Z-Fighting) und werden im Vertex-Shader auf eine
 * Mindestbreite in Low-Res-Pixeln aufgeweitet, und zwar nach AUSSEN über die
 * Kante (siehe trimMaterial.ts) — sonst würden sie in der Ferne sub-pixel dünn
 * und flackern. Lesbarkeit geht vor Maßstab.
 *
 * Kanten, hinter denen eine begehbare Fläche gleicher Höhe weitergeht oder die an
 * einer aufragenden Wand liegen, bekommen keinen Trim (dort ist keine Kante).
 */

export const TRIM_TOP_WIDTH = 3;
export const TRIM_SIDE_DEPTH = 4;
/** Physischer Abstand der Bänder über ihrer Fläche (statt großem polygonOffset-Faktor, s. u.). */
const LIFT = 0.35;
const PROBE = 4;

class TrimBuilder {
  readonly pos: number[] = [];
  readonly lift: number[] = [];
  readonly ext: number[] = [];
  readonly other: number[] = [];
  readonly col: number[] = [];
  readonly edge: number[] = [];
  readonly idx: number[] = [];
  count = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();

  /**
   * Band an der Brush-Kante p..q (exakte Flächen-Vertices, damit der Shader den
   * Snap-Versatz der Fläche übernehmen kann), um `lift` abgehoben, zweite Seite um
   * `dir·width` versetzt. Einseitig: die Wicklung wird so gewählt, dass die
   * Vorderseite nach `facing` zeigt — von innen/unten sieht man das Band nicht.
   */
  band(p: Vector3, q: Vector3, lift: Vector3, dir: Vector3, width: number, facing: Vector3, c: Rgb): void {
    const b = this.count;
    const ex = dir.x * width;
    const ey = dir.y * width;
    const ez = dir.z * width;
    const px = p.x;
    const py = p.y;
    const pz = p.z;
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    this.pos.push(px, py, pz, qx, qy, qz, px, py, pz, qx, qy, qz);
    for (let i = 0; i < 4; i++) this.lift.push(lift.x, lift.y, lift.z);
    // Extrusion an allen vier Vertices: der Shader braucht an den Kanten-Vertices die
    // Bandrichtung, um sie bei Unterschreiten der Mindestbreite nach außen zu schieben.
    this.ext.push(ex, ey, ez, ex, ey, ez, ex, ey, ez, ex, ey, ez);
    // Anderes Kantenende: der Shader braucht die Bildschirmrichtung der Kante.
    this.other.push(qx, qy, qz, px, py, pz, qx, qy, qz, px, py, pz);
    for (let i = 0; i < 4; i++) this.col.push(c[0], c[1], c[2]);
    this.edge.push(1, 1, 0, 0);
    const front = this.tmp.subVectors(q, p).cross(this.tmp2.copy(dir)).dot(facing) > 0;
    if (front) this.idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
    else this.idx.push(b, b + 3, b + 1, b, b + 2, b + 3);
    this.count += 4;
  }

  build(): BufferGeometry | null {
    if (this.count === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('aLift', new BufferAttribute(new Float32Array(this.lift), 3));
    g.setAttribute('aExtrude', new BufferAttribute(new Float32Array(this.ext), 3));
    g.setAttribute('aOther', new BufferAttribute(new Float32Array(this.other), 3));
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aEdge', new BufferAttribute(new Float32Array(this.edge), 1));
    const index = this.count > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx);
    g.setIndex(new BufferAttribute(index, 1));
    g.computeBoundingSphere();
    return g;
  }
}

function sharesEdge(face: BrushFace, a: Vector3, b: Vector3): boolean {
  let hits = 0;
  for (const v of face.vertices) {
    if (v.distanceToSquared(a) < 0.01 || v.distanceToSquared(b) < 0.01) hits++;
  }
  return hits >= 2;
}

/** Punkt (x,z) in der XZ-Projektion eines konvexen Polygons (Orientierung egal). */
function insideXZ(x: number, z: number, verts: readonly Vector3[], tol: number): boolean {
  let sign = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len = Math.hypot(ex, ez);
    if (len < 1e-6) continue;
    const cross = (ex * (z - a.z) - ez * (x - a.x)) / len;
    if (Math.abs(cross) <= tol) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Geht hinter der Kante eine begehbare Fläche auf gleicher Höhe weiter? */
function continues(m: Vector3, out: Vector3, self: CompiledBrush, brushes: readonly CompiledBrush[]): boolean {
  const qx = m.x + out.x * PROBE;
  const qz = m.z + out.z * PROBE;
  for (const b of brushes) {
    if (b === self) continue;
    const bb = b.bounds;
    if (qx < bb.min.x - 1 || qx > bb.max.x + 1 || qz < bb.min.z - 1 || qz > bb.max.z + 1) continue;
    if (m.y < bb.min.y - 3 || m.y > bb.max.y + 3) continue;
    for (const f of b.faces) {
      if (!f.walkable) continue;
      const y = (f.plane.dist - f.normal.x * qx - f.normal.z * qz) / f.normal.y;
      if (Math.abs(y - m.y) > 2) continue;
      if (insideXZ(qx, qz, f.vertices, 0.5)) return true;
    }
  }
  return false;
}

/** Ragt direkt hinter der Kante ein anderer Brush auf (Stufe, Wand)? */
function blocked(m: Vector3, out: Vector3, self: CompiledBrush, brushes: readonly CompiledBrush[]): boolean {
  const rx = m.x + out.x * PROBE;
  const ry = m.y + 4;
  const rz = m.z + out.z * PROBE;
  for (const b of brushes) {
    if (b === self) continue;
    const bb = b.bounds;
    if (rx < bb.min.x || rx > bb.max.x || ry < bb.min.y || ry > bb.max.y || rz < bb.min.z || rz > bb.max.z) continue;
    let inside = true;
    for (const f of b.faces) {
      if (f.normal.x * rx + f.normal.y * ry + f.normal.z * rz - f.plane.dist > -0.01) {
        inside = false;
        break;
      }
    }
    if (inside) return true;
  }
  return false;
}

/** Parameter t der Weltgitter-Durchgänge — gleiche Stützstellen wie die Flächen-Tesselierung. */
function gridSplits(a: Vector3, b: Vector3): number[] {
  const ts = [0, 1];
  const ca = [a.x, a.y, a.z];
  const cb = [b.x, b.y, b.z];
  for (let axis = 0; axis < 3; axis++) {
    const lo = Math.min(ca[axis], cb[axis]);
    const hi = Math.max(ca[axis], cb[axis]);
    if (hi - lo < 1e-4) continue;
    for (let k = Math.ceil(lo / TESS_CELL); k * TESS_CELL <= hi; k++) {
      const t = (k * TESS_CELL - ca[axis]) / (cb[axis] - ca[axis]);
      if (t > 1e-4 && t < 1 - 1e-4) ts.push(t);
    }
  }
  ts.sort((x, y) => x - y);
  return ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-4);
}

function zoneColor(m: Vector3, level: CompiledLevel): string | null {
  for (const t of level.triggers) {
    if (t.kind === 'kill') continue;
    const b = t.bounds;
    if (m.x < b.min.x - 8 || m.x > b.max.x + 8 || m.z < b.min.z - 8 || m.z > b.max.z + 8) continue;
    if (m.y < b.min.y - 16 || m.y > b.max.y) continue;
    return KIND_COLORS[t.kind];
  }
  return null;
}

export function buildTrims(level: CompiledLevel): BufferGeometry | null {
  const tb = new TrimBuilder();
  const env = level.def.environment;
  // Nachbarschaft nur aus sichtbaren Brushes: eine Kante ist eine Kante, die man sieht
  // (ein unsichtbarer Clip über einer Treppe nimmt ihr keinen Trim).
  const grid = new BrushGrid(level.brushes.filter((b) => b.visible && b.mat !== 'marking'), PROBE + 8);
  const colorCache = new Map<string, Rgb>();
  const rgb = (hex: string): Rgb => {
    let c = colorCache.get(hex);
    if (!c) {
      c = hexToRgb(hex);
      colorCache.set(hex, c);
    }
    return c;
  };

  const centroid = new Vector3();
  const dir = new Vector3();
  const out = new Vector3();
  const inward = new Vector3();
  const down = new Vector3();
  const sideFacing = new Vector3();
  const mid = new Vector3();
  const p = new Vector3();
  const q = new Vector3();
  const lift = new Vector3();

  for (const brush of level.brushes) {
    if (!brush.trim || brush.mat === 'marking') continue;
    const brushColor = materialTrimColor(brush.mat) ?? env.trimColor;
    for (const face of brush.faces) {
      if (!face.walkable) continue;
      const n = face.normal;
      const verts = face.vertices;
      centroid.set(0, 0, 0);
      for (const v of verts) centroid.add(v);
      centroid.multiplyScalar(1 / verts.length);

      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const adj = brush.faces.find((f) => f !== face && sharesEdge(f, a, b));
        if (adj?.walkable) continue; // Knick zwischen zwei Laufflächen ist keine Kante.

        dir.subVectors(b, a).normalize();
        mid.addVectors(a, b).multiplyScalar(0.5);
        out.subVectors(mid, centroid);
        out.addScaledVector(dir, -out.dot(dir));
        out.addScaledVector(n, -out.dot(n));
        if (out.lengthSq() < 1e-8) continue;
        out.normalize();
        inward.copy(out).negate();

        // Seitenband: in der Nachbarfläche senkrecht zur Kante, von der Oberseite weg.
        if (adj) {
          down.crossVectors(dir, adj.normal);
          if (down.dot(n) > 0) down.negate();
          if (down.lengthSq() < 1e-8) down.set(0, -1, 0);
          else down.normalize();
          sideFacing.copy(adj.normal);
        } else {
          down.set(0, -1, 0);
          sideFacing.copy(out);
        }

        const ts = gridSplits(a, b);
        for (let k = 0; k + 1 < ts.length; k++) {
          p.lerpVectors(a, b, ts[k]);
          q.lerpVectors(a, b, ts[k + 1]);
          mid.addVectors(p, q).multiplyScalar(0.5);
          const near = grid.near(mid.x, mid.z);
          if (continues(mid, out, brush, near)) continue;
          if (blocked(mid, out, brush, near)) continue;
          const c = rgb(zoneColor(mid, level) ?? brushColor);
          // Gemeinsame Kante beider Bänder: nach oben UND außen abgehoben. Getrennte
          // Offsets ließen dazwischen eine ~1-px-Lücke, durch die die Kante dunkel blitzt.
          lift.copy(n).multiplyScalar(LIFT).addScaledVector(sideFacing, LIFT);
          tb.band(p, q, lift, inward, TRIM_TOP_WIDTH + LIFT, n, c);
          tb.band(p, q, lift, down, TRIM_SIDE_DEPTH + LIFT, sideFacing, c);
        }
      }
    }
  }
  buildSurfTrims(level, tb, rgb);
  buildMarkings(level, tb, rgb);
  buildUnderTrims(level, tb, rgb, grid);
  return tb.build();
}

/** Breite und Helligkeit des Unterkanten-Bands (LevelFormat.BrushCommon.underTrim). */
const UNDER_WIDTH = 4;
const UNDER_DIM = 0.6;

/**
 * Zweites Leuchtband an der Unterkante der Seitenflächen (underTrim), dunkler in
 * trimColorAlt: ein schwebender Körper hat im Dunkeln sonst nur eine Oberkante —
 * der Ring in Level 2 las sich als Knäuel aus Linien ohne Volumen (Look-Kritik).
 * Kanten, hinter denen ein anderer Brush anschließt (Nachbarsegment, Bande), bleiben frei.
 */
function buildUnderTrims(level: CompiledLevel, tb: TrimBuilder, rgb: (hex: string) => Rgb, grid: BrushGrid): void {
  const env = level.def.environment;
  const alt = rgb(env.trimColorAlt ?? env.trimColor);
  const color: Rgb = [alt[0] * UNDER_DIM, alt[1] * UNDER_DIM, alt[2] * UNDER_DIM];
  const edge = new Vector3();
  const up = new Vector3();
  const out = new Vector3();
  const mid = new Vector3();
  const cen = new Vector3();
  const lift = new Vector3();
  const p = new Vector3();
  const q = new Vector3();
  for (const brush of level.brushes) {
    if (!brush.underTrim) continue;
    for (const face of brush.faces) {
      if (face.normal.y > -0.9) continue;
      const verts = face.vertices;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const side = brush.faces.find((f) => f !== face && sharesEdge(f, a, b));
        if (!side || Math.abs(side.normal.y) > 0.5) continue;
        // In der Seitenfläche senkrecht zur Kante, von der Unterkante weg.
        edge.subVectors(b, a).normalize();
        up.crossVectors(edge, side.normal).normalize();
        cen.set(0, 0, 0);
        for (const v of side.vertices) cen.add(v);
        cen.multiplyScalar(1 / side.vertices.length);
        if (up.dot(mid.subVectors(cen, a)) < 0) up.negate();
        out.set(side.normal.x, 0, side.normal.z).normalize();
        lift.copy(side.normal).multiplyScalar(LIFT).addScaledVector(face.normal, LIFT);
        const ts = gridSplits(a, b);
        for (let k = 0; k + 1 < ts.length; k++) {
          p.lerpVectors(a, b, ts[k]);
          q.lerpVectors(a, b, ts[k + 1]);
          mid.addVectors(p, q).multiplyScalar(0.5);
          if (blocked(mid, out, brush, grid.near(mid.x, mid.z))) continue;
          tb.band(p, q, lift, up, UNDER_WIDTH + LIFT, side.normal, color);
        }
      }
    }
  }
}

/**
 * Bodenmarkierungen (mat 'marking', z. B. Chevrons): die Oberseite als gefülltes,
 * selbstleuchtendes Parallelogramm in der Brush-Farbe — ein einziges Band von
 * einer Kante zur gegenüberliegenden. Kantenscharf und im Trim-Raster statt
 * Textur-Pixeln (Textur-Pfeile zerfielen nah vor der Kamera in Kammzähne,
 * Look-Kritik). Nicht-Parallelogramme werden übersprungen (Validator meldet sie).
 */
function buildMarkings(level: CompiledLevel, tb: TrimBuilder, rgb: (hex: string) => Rgb): void {
  const d = new Vector3();
  const e = new Vector3();
  const lift = new Vector3();
  for (const brush of level.brushes) {
    if (brush.mat !== 'marking' || !brush.visible) continue;
    const top = brush.faces.find((f) => f.normal.y > 0.7);
    if (!top || !isParallelogram(top.vertices)) continue;
    const [v0, v1, , v3] = top.vertices;
    d.subVectors(v3, v0);
    const w = d.length();
    if (w < 1e-3) continue;
    d.multiplyScalar(1 / w);
    e.subVectors(v1, v0);
    if (e.lengthSq() < 1e-6) continue;
    lift.copy(top.normal).multiplyScalar(LIFT);
    tb.band(v0, v1, lift, d, w, top.normal, rgb(brush.tint ?? '#ffffff'));
  }
}

/** Vier Ecken mit v0 + v2 = v1 + v3 (Parallelogramm), Toleranz 0.05 u. */
export function isParallelogram(v: readonly Vector3[]): boolean {
  if (v.length !== 4) return false;
  return Math.abs(v[0].x + v[2].x - v[1].x - v[3].x) < 0.05 && Math.abs(v[0].y + v[2].y - v[1].y - v[3].y) < 0.05 && Math.abs(v[0].z + v[2].z - v[1].z - v[3].z) < 0.05;
}

/** Breite der Gratlinie je Flanke und der Fußlinie (u, vor der Mindestbreite im Shader). */
const RIDGE_WIDTH = 4;
const FOOT_WIDTH = 4;
/** Fußlinie dunkler als der Grat: sie zeigt nur, wo die Flanke endet. */
const FOOT_DIM = 0.55;

/**
 * Surf-Rampen (mat 'surf'): Neonlinie auf dem Grat — der Kante zwischen zwei
 * Surf-Flanken — und eine dunklere in trimColorAlt am Fuß (Kante Flanke/Unterseite).
 * Die Flanken sind nicht begehbar und bekamen bisher gar keinen Trim; Grat und Fuß
 * waren nur als Silhouette gegen den dunklen Himmel lesbar. Beim Surfen ist der Grat
 * die Linie, an der man sich hält. Zwei Bänder je Kante, eins auf jeder Fläche,
 * gemeinsamer Kantenvertex (wie oben, fallen.md #5).
 */
function buildSurfTrims(level: CompiledLevel, tb: TrimBuilder, rgb: (hex: string) => Rgb): void {
  const env = level.def.environment;
  const ridgeColor = rgb(env.trimColor);
  const alt = rgb(env.trimColorAlt ?? env.trimColor);
  const footColor: Rgb = [alt[0] * FOOT_DIM, alt[1] * FOOT_DIM, alt[2] * FOOT_DIM];
  const dir = new Vector3();
  const d1 = new Vector3();
  const d2 = new Vector3();
  const c1 = new Vector3();
  const lift = new Vector3();
  const p = new Vector3();
  const q = new Vector3();
  /** Richtung in der Fläche f senkrecht zur Kante, zur Flächenmitte hin. */
  const into = (f: BrushFace, edge: Vector3, centroid: Vector3, a: Vector3, out: Vector3): Vector3 => {
    out.crossVectors(edge, f.normal).normalize();
    if (out.dot(c1.subVectors(centroid, a)) < 0) out.negate();
    return out;
  };
  const centroidOf = (f: BrushFace, out: Vector3): Vector3 => {
    out.set(0, 0, 0);
    for (const v of f.vertices) out.add(v);
    return out.multiplyScalar(1 / f.vertices.length);
  };
  const m1 = new Vector3();
  const m2 = new Vector3();
  for (const brush of level.brushes) {
    if (brush.mat !== 'surf' || !brush.visible) continue;
    for (const face of brush.faces) {
      if (!face.surf) continue;
      const verts = face.vertices;
      centroidOf(face, m1);
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const adj = brush.faces.find((f) => f !== face && sharesEdge(f, a, b));
        if (!adj) continue;
        const ridge = adj.surf && adj.normal.y > 0;
        const foot = adj.normal.y < -0.9;
        if (!ridge && !foot) continue;
        // Jede Gratkante nur einmal (von der Fläche mit dem kleineren Index aus).
        if (ridge && brush.faces.indexOf(adj) < brush.faces.indexOf(face)) continue;
        dir.subVectors(b, a).normalize();
        into(face, dir, m1, a, d1);
        if (ridge) into(adj, dir, centroidOf(adj, m2), a, d2);
        // Getönte Rampen (Level 2: Tempo-Stufen S1/S2) tragen ihre Farbe auch am Grat.
        const color = ridge ? (brush.tint ? rgb(brush.tint) : ridgeColor) : footColor;
        // Gemeinsame Kante nach außen (beide Normalen) abgehoben, wie bei den Lauf-Trims.
        lift.copy(face.normal).multiplyScalar(LIFT).addScaledVector(adj.normal, LIFT);
        const ts = gridSplits(a, b);
        for (let k = 0; k + 1 < ts.length; k++) {
          p.lerpVectors(a, b, ts[k]);
          q.lerpVectors(a, b, ts[k + 1]);
          tb.band(p, q, lift, d1, (ridge ? RIDGE_WIDTH : FOOT_WIDTH) + LIFT, face.normal, color);
          if (ridge) tb.band(p, q, lift, d2, RIDGE_WIDTH + LIFT, adj.normal, color);
        }
      }
    }
  }
}
