import { BufferGeometry } from 'three';
import type { IUniform, Object3D } from 'three';
import type { ViewModelFrame } from '../../types';
import { VM_RIG } from '../../types';
import { capsuleGeometry, mergeGeometries, rgb, tubeGeometry } from '../vmGeometry';
import type { Ring } from '../vmGeometry';
import { ScalarUniform, createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import type { SkinFrameFx, SkinView, VmBuildCtx, VmRig } from '../vmBuild';

/**
 * Roboter-Hand (Plan 007, K4): eigene Geometrie an denselben Rig-Gruppen — kantige Metallhülsen
 * (Superellipse n = 4) mit Spalt an jedem Gelenk, dunkle Scharnier-Achsen quer, Sensor-Pads an
 * den Fingerkuppen, Nieten und Mittelnaht auf dem Handrücken, gerippter Unterarm und ein LED-Band,
 * das mit der Kick pulst und mit dem Tempo heller wird (die Hand spielt sichtbar mit der Musik).
 *
 * Je Slot EIN Lit-Mesh + EINE Hülle (Teile per Vertex-Farbe zusammengeführt) → 36 Draw Calls
 * wie der Handschuh. Farben: Metall 0xc3ccd8, dunkle Teile 0x3a414e, Nieten 0x1c2028.
 */

const METAL = rgb(0xc3ccd8);
const DARK = rgb(0x3a414e);
const RIVET = rgb(0x1c2028);
const ARM = rgb(0xa8b2c0);
/** Unterarm-Rippen: oberster Ring (y) und Periode (u). */
const ARM_TOP = 0.4;
const RIB = 2.8;

/** Fingerglied: Hülse mit Spalt zum Nachbarglied, Scharnier-Achse quer, Endglied mit Sensor-Pad. */
function segment(len: number, r: number, tip: boolean): BufferGeometry {
  const body = capsuleGeometry(len * 0.78, r * 0.74, r * 0.7, 10, 0.92, 2, { n: 4, color: METAL });
  body.translate(0, len * 0.12, 0);
  const hinge = tubeGeometry(
    [
      { y: -r * 0.8, rx: r * 0.5, rz: r * 0.5 },
      { y: r * 0.8, rx: r * 0.5, rz: r * 0.5 },
    ],
    8,
    { poleStart: -r * 0.9, poleEnd: r * 0.9, color: DARK },
  );
  hinge.rotateZ(Math.PI / 2);
  const list = [body, hinge];
  if (tip) {
    const pad = tubeGeometry(
      [
        { y: 0, rx: r * 0.42, rz: r * 0.2 },
        { y: len * 0.5, rx: r * 0.42, rz: r * 0.2 },
      ],
      8,
      { poleStart: -0.2, poleEnd: len * 0.5 + 0.2, color: DARK },
    );
    pad.translate(0, len * 0.25, -r * 0.62);
    list.push(pad);
  }
  const g = mergeGeometries(list);
  for (const p of list) p.dispose();
  return g;
}

function palmGeometry(): BufferGeometry {
  const rings: Ring[] = [
    { y: -0.6, rx: 2.9, rz: 1.9, n: 4 },
    { y: 0.8, rx: 3.6, rz: 2.05, n: 4 },
    { y: 4.0, rx: 4.2, rz: 2.1, n: 4 },
    { y: 7.2, rx: 4.3, rz: 2.0, n: 4 },
    { y: 8.3, rx: 4.05, rz: 1.8, n: 4 },
  ];
  const palm = tubeGeometry(rings, 16, {
    poleStart: -1.1,
    poleEnd: 8.8,
    color: METAL,
    colorAt: (x, y, z, c) => {
      // Mittelnaht und Querfuge auf dem Handrücken (+z).
      if (z > 1.5 && ((Math.abs(x) < 0.22 && y > 0.5 && y < 7.8) || (y > 3.6 && y < 3.9))) {
        c[0] = DARK[0];
        c[1] = DARK[1];
        c[2] = DARK[2];
      }
    },
  });
  const parts = [palm];
  for (const [x, y] of [
    [-2.9, 1.2],
    [2.9, 1.2],
    [-3.3, 6.6],
    [3.3, 6.6],
  ] as const) {
    const r = tubeGeometry(
      [
        { y: 0, rx: 0.42, rz: 0.42 },
        { y: 0.25, rx: 0.36, rz: 0.36 },
      ],
      6,
      { poleEnd: 0.4, color: RIVET },
    );
    r.rotateX(Math.PI / 2);
    r.translate(x, y, 1.95);
    parts.push(r);
  }
  // Knöchel-Achse quer über die Fingerwurzeln.
  const axle = tubeGeometry(
    [
      { y: -4.3, rx: 0.75, rz: 0.75 },
      { y: 4.3, rx: 0.75, rz: 0.75 },
    ],
    8,
    { poleStart: -4.6, poleEnd: 4.6, color: DARK },
  );
  axle.rotateZ(Math.PI / 2);
  axle.translate(0, 8.5, 0.3);
  parts.push(axle);
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

export function buildRobotSkin(ctx: VmBuildCtx, rig: VmRig): SkinView {
  const L = ctx.light;
  const lit = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.45, wrap: 0.2, ink: 0.2, inkColor: 0x10131a, sheen: 0.25, sheenColor: 0xe8f4ff, vertexColors: true }));
  const outline = ctx.track(createOutlineMaterial(L, 0x0c0e14, ctx.handPx));
  const glow: IUniform<number> = new ScalarUniform(0.6);
  const led = ctx.track(createLitMaterial(L, { color: 0x1a4a55, rim: 0, wrap: 0.3, emissive: 0x2fd8ff, glow }));
  const objects: Object3D[] = [];
  const add = (parent: Object3D, geo: BufferGeometry, mat = lit): void => {
    const p = ctx.part(parent, geo, mat, outline, null);
    objects.push(p.lit, p.hull);
  };

  add(rig.wrist, palmGeometry());
  VM_RIG.fingers.forEach((f, i) => {
    for (let k = 0; k < 3; k++) add(rig.fingers[i][k], segment(f.len[k], f.r, k === 2));
  });
  const t = VM_RIG.thumb;
  for (let k = 0; k < 3; k++) add(rig.thumb[k], segment(t.len[k], t.r[k], k === 2));

  // Unterarm: gerippte Metallröhre (Dreieck-Superellipse), läuft aus dem Bild. Grobe Rippen (Periode
  // 2.8 u) mit dunkler, 0.45 u tieferer Fuge (Vertex-Farbe, 0 Draw Calls) — feine 1.4-u-Rippen mit
  // 0.25 u Relief verschwammen im Low-Res-Bild zur glatten Röhre (der Unterarm ist stark verkürzt).
  const ribs: Ring[] = [];
  for (let y = ARM_TOP; y > -40; y -= RIB) {
    ribs.push({ y, rx: 4.15, rz: 3.4, n: 3 });
    ribs.push({ y: y - 1.8, rx: 4.15, rz: 3.4, n: 3 });
    ribs.push({ y: y - 1.95, rx: 3.7, rz: 3.0, n: 3 });
    ribs.push({ y: y - 2.65, rx: 3.7, rz: 3.0, n: 3 });
  }
  add(
    rig.arm,
    tubeGeometry(ribs, 12, {
      poleStart: 0.9,
      color: ARM,
      colorAt: (_x, y, _z, c) => {
        const u = (((ARM_TOP - y) % RIB) + RIB) % RIB;
        if (u > 1.9 && u < 2.7) {
          c[0] = DARK[0];
          c[1] = DARK[1];
          c[2] = DARK[2];
        }
      },
    }),
  );
  // LED-Band am Handgelenk: emissiv, glow = Kick × Tempo (apply).
  add(
    rig.arm,
    tubeGeometry(
      [
        { y: -1.0, rx: 4.3, rz: 3.55, n: 3 },
        { y: -2.0, rx: 4.3, rz: 3.55, n: 3 },
      ],
      12,
    ),
    led,
  );
  for (const o of objects) o.visible = false;

  return {
    setVisible(on: boolean): void {
      for (const o of objects) o.visible = on;
    },
    apply(f: ViewModelFrame, fx: SkinFrameFx): void {
      // Grundglühen + Tempostufe (skinFx aus der UI) + Kick-Puls (Renderer). Ohne Musik (Menü) glimmt es.
      const tier = f.skinFx > 0 ? (f.skinFx < 1 ? f.skinFx : 1) : 0;
      const kick = fx.kick > 0 ? (fx.kick < 1 ? fx.kick : 1) : 0;
      glow.value = 0.45 + 0.3 * tier + kick * (0.45 + 0.35 * tier);
    },
  };
}
