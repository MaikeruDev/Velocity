import { Vector3 } from 'three';
import type { CollisionWorld, CompiledBrush, Plane, TraceResult } from './types';
import { DIST_EPSILON, makeTraceResult } from './types';

/**
 * Box-Traces gegen konvexe Brushes — Portierung von Quake 3 `CM_TraceThroughBrush`.
 *
 * Die Player-Box wird nicht gegen die Brushes geschnitten, sondern jede
 * Brush-Ebene wird um die Box-Ausdehnung in Normalenrichtung verschoben
 * (Minkowski-Summe über Ebenen). Dann ist der Trace ein Strahl gegen einen
 * aufgeblähten konvexen Körper. Die achsparallelen Bevel-Ebenen, die
 * `compileLevel` jedem Brush mitgibt, halten diese Aufblähung an schrägen
 * Kanten exakt genug.
 *
 * Broadphase: uniformes 2D-Raster (XZ) über die Brush-Bounds. Levels haben
 * wenige hundert Brushes, pro Tick laufen ~10 Traces — mehr braucht es nicht.
 */
export class BrushWorld implements CollisionWorld {
  private readonly brushes: readonly CompiledBrush[];
  private readonly cellSize = 512;
  private readonly cells = new Map<number, number[]>();
  private readonly stamp: Uint32Array;
  private stampId = 1;

  // Scratch
  private readonly tmpMins = new Vector3();
  private readonly tmpMaxs = new Vector3();
  private readonly tmpResult = makeTraceResult();

  constructor(brushes: readonly CompiledBrush[]) {
    this.brushes = brushes.filter((b) => b.collide);
    this.stamp = new Uint32Array(this.brushes.length);
    this.brushes.forEach((b, i) => {
      const x0 = Math.floor(b.bounds.min.x / this.cellSize);
      const x1 = Math.floor(b.bounds.max.x / this.cellSize);
      const z0 = Math.floor(b.bounds.min.z / this.cellSize);
      const z1 = Math.floor(b.bounds.max.z / this.cellSize);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = cellKey(x, z);
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(i);
        }
      }
    });
  }

  get brushCount(): number {
    return this.brushes.length;
  }

  traceBox(start: Vector3, end: Vector3, mins: Vector3, maxs: Vector3, out: TraceResult = makeTraceResult()): TraceResult {
    out.fraction = 1;
    out.startSolid = false;
    out.allSolid = false;
    out.brushIndex = -1;
    out.normal.set(0, 0, 0);

    // Sweep-Bounds für die Broadphase.
    const bmin = this.tmpMins.set(
      Math.min(start.x, end.x) + mins.x - 1,
      Math.min(start.y, end.y) + mins.y - 1,
      Math.min(start.z, end.z) + mins.z - 1,
    );
    const bmax = this.tmpMaxs.set(
      Math.max(start.x, end.x) + maxs.x + 1,
      Math.max(start.y, end.y) + maxs.y + 1,
      Math.max(start.z, end.z) + maxs.z + 1,
    );

    const id = this.nextStamp();
    const x0 = Math.floor(bmin.x / this.cellSize);
    const x1 = Math.floor(bmax.x / this.cellSize);
    const z0 = Math.floor(bmin.z / this.cellSize);
    const z1 = Math.floor(bmax.z / this.cellSize);
    outer: for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const list = this.cells.get(cellKey(x, z));
        if (!list) continue;
        for (const bi of list) {
          if (this.stamp[bi] === id) continue;
          this.stamp[bi] = id;
          const b = this.brushes[bi];
          const bb = b.bounds;
          if (bb.min.x > bmax.x || bb.max.x < bmin.x) continue;
          if (bb.min.y > bmax.y || bb.max.y < bmin.y) continue;
          if (bb.min.z > bmax.z || bb.max.z < bmin.z) continue;
          clipBoxToBrush(b, start, end, mins, maxs, out);
          if (out.allSolid) break outer;
        }
      }
    }

    if (out.fraction === 1) out.endPos.copy(end);
    else out.endPos.copy(start).lerp(end, out.fraction);
    return out;
  }

  testBox(pos: Vector3, mins: Vector3, maxs: Vector3): boolean {
    const r = this.traceBox(pos, pos, mins, maxs, this.tmpResult);
    return r.startSolid;
  }

  private nextStamp(): number {
    this.stampId++;
    if (this.stampId >= 0xffffffff) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    return this.stampId;
  }
}

function cellKey(x: number, z: number): number {
  // Levels bleiben in ±2^20 Zellen — reicht dicke.
  return (x + 0x8000) * 0x10000 + (z + 0x8000);
}

/**
 * Quake 3 `CM_TraceThroughBrush` für eine Box. Aktualisiert `tr` nur, wenn
 * dieser Brush früher trifft als alles bisher Gefundene.
 */
function clipBoxToBrush(
  brush: CompiledBrush,
  start: Vector3,
  end: Vector3,
  mins: Vector3,
  maxs: Vector3,
  tr: TraceResult,
): void {
  let enterFrac = -1;
  let leaveFrac = 1;
  let clipPlane: Plane | null = null;
  let getOut = false;
  let startOut = false;

  for (const plane of brush.planes) {
    const n = plane.normal;
    // Ecke der Box, die in Normalenrichtung am weitesten "hinten" liegt.
    const ox = n.x < 0 ? maxs.x : mins.x;
    const oy = n.y < 0 ? maxs.y : mins.y;
    const oz = n.z < 0 ? maxs.z : mins.z;
    const dist = plane.dist - (ox * n.x + oy * n.y + oz * n.z);

    const d1 = start.x * n.x + start.y * n.y + start.z * n.z - dist;
    const d2 = end.x * n.x + end.y * n.y + end.z * n.z - dist;

    if (d2 > 0) getOut = true;
    if (d1 > 0) startOut = true;

    // Komplett vor dieser Fläche → trifft den Brush gar nicht.
    if (d1 > 0 && (d2 >= DIST_EPSILON || d2 >= d1)) return;
    // Kreuzt die Ebene nicht → irrelevant.
    if (d1 <= 0 && d2 <= 0) continue;

    if (d1 > d2) {
      // Eintritt
      let f = (d1 - DIST_EPSILON) / (d1 - d2);
      if (f < 0) f = 0;
      if (f > enterFrac) {
        enterFrac = f;
        clipPlane = plane;
      }
    } else {
      // Austritt
      let f = (d1 + DIST_EPSILON) / (d1 - d2);
      if (f > 1) f = 1;
      if (f < leaveFrac) leaveFrac = f;
    }
  }

  if (!startOut) {
    // Start liegt im Brush.
    tr.startSolid = true;
    if (!getOut) {
      tr.allSolid = true;
      tr.fraction = 0;
      tr.brushIndex = brush.index;
    }
    return;
  }

  if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < tr.fraction && clipPlane) {
    tr.fraction = Math.max(0, enterFrac);
    tr.normal.copy(clipPlane.normal);
    tr.brushIndex = brush.index;
  }
}
