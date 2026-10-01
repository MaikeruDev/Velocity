/**
 * Griff-Messung (Plan 008): Gegenstand gegen das Kollisionsmodell der Hand (ui/hand/handShape). Baut das
 * echte ViewModel in Node (three ohne WebGL, wie tests/fk.test), wendet einen ViewModelFrame an und tastet
 * die Oberflächen der sichtbaren Gegenstands-Meshes ab (Ecken + Dreiecks-Mitten + Kanten-Mitten), im
 * Handgelenk-Raum. Ergebnis je Handteil: kleinster vorzeichenbehafteter Abstand (< 0 = Durchdringung).
 * Genutzt von tools/hand-contact.ts (Audit-Tabelle) und tests (Klinge berührt nie die Hand).
 */
import { BackSide, Matrix4, Mesh, Vector3 } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import { ViewModel } from '../../src/render/viewmodel/ViewModel';
import type { ViewModelFrame } from '../../src/render/types';
import { HAND_PART_COUNT, HandShape } from '../../src/ui/hand/handShape';

export interface ContactReport {
  /** Kleinster Abstand je Handteil (HAND_PART_NAMES), +Infinity ohne Punkte. */
  readonly perPart: Float64Array;
  /** Tiefste Durchdringung (≥ 0) und kleinster Abstand insgesamt. */
  readonly penetration: number;
  readonly gap: number;
  /** Zahl der Abtastpunkte. */
  readonly samples: number;
}

let shared: ViewModel | null = null;

/** Ein ViewModel für alle Messungen (Aufbau kostet ~100 ms). */
export function contactViewModel(): ViewModel {
  if (!shared) shared = new ViewModel();
  return shared;
}

function visibleUpTo(o: Object3D, root: Object3D): boolean {
  let p: Object3D | null = o;
  while (p && p !== root) {
    if (!p.visible) return false;
    p = p.parent;
  }
  return true;
}

/**
 * Punkte der sichtbaren Gegenstands-Meshes im Handgelenk-Raum. `filter(mesh)` = nur diese Meshes (z. B.
 * nur die Klinge des Messers). Allokiert — Werkzeug/Test, nicht Frame-Pfad.
 */
export function itemPoints(f: ViewModelFrame, filter?: (m: Mesh) => boolean): Float64Array {
  const vm = contactViewModel();
  vm.apply(f);
  vm.scene.updateMatrixWorld(true);
  const inv = new Matrix4().copy(vm.rig.wrist.matrixWorld).invert();
  const out: number[] = [];
  const v = new Vector3();
  const roots: Object3D[] = [vm.itemSocket];
  const sub = vm.subSocketGroup;
  if (sub && f.subVisible > 0.001) roots.push(sub);
  for (const root of roots) {
    root.traverse((o) => {
      if (!(o instanceof Mesh) || !visibleUpTo(o, root.parent ?? root)) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mat.side === BackSide) return;
      if (filter && !filter(o)) return;
      const m = new Matrix4().multiplyMatrices(inv, o.matrixWorld);
      samplePoints(o.geometry, m, v, out);
    });
  }
  return Float64Array.from(out);
}

/** Oberfläche dicht abtasten: je Dreieck ein baryzentrisches Raster mit Kantenschritt ≤ STEP (Ecken inklusive). */
const STEP = 0.35;
function samplePoints(g: BufferGeometry, m: Matrix4, v: Vector3, out: number[]): void {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const vi = (i: number): number => (idx ? idx.getX(i) : i);
  for (let t = 0; t + 2 < n; t += 3) {
    a.fromBufferAttribute(pos, vi(t)).applyMatrix4(m);
    b.fromBufferAttribute(pos, vi(t + 1)).applyMatrix4(m);
    c.fromBufferAttribute(pos, vi(t + 2)).applyMatrix4(m);
    const e = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    const k = Math.max(1, Math.ceil(e / STEP));
    for (let i = 0; i <= k; i++) {
      for (let j = 0; i + j <= k; j++) {
        const u = i / k;
        const w = j / k;
        const r = 1 - u - w;
        v.set(a.x * r + b.x * u + c.x * w, a.y * r + b.y * u + c.y * w, a.z * r + b.z * u + c.z * w);
        out.push(v.x, v.y, v.z);
      }
    }
  }
}

/** Punkte gegen die Hand dieses Frames. */
export function measure(f: ViewModelFrame, pts: Float64Array, shape = new HandShape()): ContactReport {
  shape.update(f.joints);
  const perPart = new Float64Array(HAND_PART_COUNT).fill(Infinity);
  for (let k = 0; k < pts.length; k += 3) {
    for (let i = 0; i < HAND_PART_COUNT; i++) {
      const d = shape.partDistance(i, pts[k], pts[k + 1], pts[k + 2]);
      if (d < perPart[i]) perPart[i] = d;
    }
  }
  let gap = Infinity;
  for (const d of perPart) gap = Math.min(gap, d);
  return { perPart, penetration: Math.max(0, -gap), gap, samples: pts.length / 3 };
}
