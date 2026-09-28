import { Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import type { ViewModelFrame } from '../../types';
import { VM_RIG } from '../../types';
import { boneGeometry, capsuleGeometry, mergeGeometries, rgb, tubeGeometry } from '../vmGeometry';
import { createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import type { SkinFrameFx, SkinView, VmBuildCtx, VmRig } from '../vmBuild';

/**
 * Skelett-Hand (Plan 007, KI4): Knochen an denselben Rig-Slots — Mittelhandknochen fächern vom
 * Handgelenk zu den Fingerwurzeln (plus Handwurzel-Knöpfe), Glieder als Knochen (Knopf–Schaft–Knopf,
 * ~0.5 × Handschuh-Radius), Endglieder als kurze Kapseln, Elle und Speiche laufen aus dem Bild, ein
 * schwarzes Schweißband hält die Silhouette lesbar. Cartoon-Knochen: etwas dicker als echt, sonst
 * zerfallen sie im Low-Res-Bild zu Strichen. Klappern (skinFx) macht die UI an den Gelenken (skinFx.ts).
 * Je Slot ein Mesh + eine Hülle → 36 Draw Calls wie der Handschuh.
 */

const BONE = rgb(0xf0e8d0);
const BONE_D = rgb(0xcfc3a0);
const KNOB_SHADE = 0.35;

/** Knochen mit leicht dunkleren Knöpfen (Vertex-Farbe nach Abstand zur Schaft-Mitte). */
function bone(len: number, knob: number, shaft: number): BufferGeometry {
  return boneGeometry(len, knob, shaft, 8, {
    color: BONE,
    colorAt: (_x, y, _z, c) => {
      const k = Math.abs(y - len / 2) / (len / 2 + knob);
      if (k > 1 - KNOB_SHADE) {
        c[0] = BONE_D[0];
        c[1] = BONE_D[1];
        c[2] = BONE_D[2];
      }
    },
  });
}

function palmGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const up = new Vector3(0, 1, 0);
  for (const f of VM_RIG.fingers) {
    const from = new Vector3(f.x * 0.45, 1.1, -0.2);
    const to = new Vector3(f.x, f.y - 0.5, f.z);
    const d = to.clone().sub(from);
    const b = bone(d.length(), f.r * 0.56, f.r * 0.33);
    b.applyQuaternion(new Quaternion().setFromUnitVectors(up, d.normalize()));
    b.translate(from.x, from.y, from.z);
    parts.push(b);
  }
  // Handwurzel: fünf Knöpfe.
  for (const [x, y, r] of [
    [-1.9, 0.2, 0.95],
    [-0.3, -0.1, 1.05],
    [1.4, 0.1, 0.95],
    [2.6, 0.7, 0.8],
    [-2.4, 1.3, 0.8],
  ] as const) {
    const c = capsuleGeometry(0.3, r, r, 8, 1, 2, { color: BONE_D });
    c.translate(x, y, -0.2);
    parts.push(c);
  }
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

function armGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const x of [-1.6, 1.7]) {
    const b = bone(38, 1.35, 0.85);
    b.rotateZ(Math.PI);
    b.translate(x, -1.2, -0.2);
    parts.push(b);
  }
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

export function buildSkeletonSkin(ctx: VmBuildCtx, rig: VmRig): SkinView {
  const L = ctx.light;
  const lit = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.35, wrap: 0.35, ink: 0.26, inkColor: 0x2b2216, vertexColors: true }));
  const outline = ctx.track(createOutlineMaterial(L, 0x1c160e, ctx.handPx));
  const band = ctx.track(createLitMaterial(L, { color: 0x17161c, rim: 0.15, wrap: 0.5 }));
  const objects: Object3D[] = [];
  const add = (parent: Object3D, geo: BufferGeometry, mat = lit): void => {
    const p = ctx.part(parent, geo, mat, outline, null);
    objects.push(p.lit, p.hull);
  };
  add(rig.wrist, palmGeometry());
  VM_RIG.fingers.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      const len = f.len[k];
      const g = k < 2 ? bone(len * 0.92, f.r * 0.56, f.r * 0.33) : capsuleGeometry(len * 0.7, f.r * 0.5, f.r * 0.32, 8, 1, 2, { color: BONE });
      if (k < 2) g.translate(0, len * 0.04, 0);
      add(rig.fingers[i][k], g);
    }
  });
  const t = VM_RIG.thumb;
  for (let k = 0; k < 3; k++) {
    const len = t.len[k];
    const g = k < 2 ? bone(len * 0.9, t.r[k] * 0.54, t.r[k] * 0.33) : capsuleGeometry(len * 0.7, t.r[k] * 0.46, t.r[k] * 0.3, 8, 1, 2, { color: BONE });
    add(rig.thumb[k], g);
  }
  add(rig.arm, armGeometry());
  // Schwarzes Schweißband: gibt dem offenen Unterarm eine lesbare Kante.
  add(
    rig.arm,
    tubeGeometry(
      [
        { y: -3.6, rx: 3.3, rz: 2.4 },
        { y: -4.2, rx: 3.45, rz: 2.55 },
        { y: -6.4, rx: 3.5, rz: 2.6 },
        { y: -6.9, rx: 3.35, rz: 2.45 },
      ],
      12,
    ),
    band,
  );
  for (const o of objects) o.visible = false;
  return {
    setVisible(on: boolean): void {
      for (const o of objects) o.visible = on;
    },
    apply(_f: ViewModelFrame, _fx: SkinFrameFx): void {},
  };
}
