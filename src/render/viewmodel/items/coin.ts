import { Group, Mesh } from 'three';
import type { BufferAttribute, BufferGeometry } from 'three';
import { VM_PARAM } from '../../types';
import type { ViewModelFrame } from '../../types';
import { discGeometry, rgb, tubeGeometry } from '../vmGeometry';
import { createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import { coinFaceTexture } from '../vmTextures';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/**
 * Münze (Plan 007, KI5): Goldscheibe r 2.1 mit Rand, Kopf = eigenes geprägtes V, Zahl = Blitz,
 * Glanzband wie der Gold-Handschuh. Achse z = Flächennormale (Vorderseite +z). Kanal side (0 Kopf,
 * 1 Zahl) legt fest, welches Motiv VORN liegt — so zeigt die Münze nach einem Wurf mit gerader Zahl
 * halber Drehungen das gewünschte Ergebnis, ohne dass die Zeitleiste davon abhängt.
 */

export const COIN_R = 2.1;
const THICK = 0.21;

/** Scheibe in der xy-Ebene, Normale ±z, Textur aufrecht (von vorn bzw. hinten gesehen lesbar). */
function face(side: 1 | -1): BufferGeometry {
  const d = discGeometry(COIN_R * 0.93, 14, 0);
  d.rotateX((side * Math.PI) / 2);
  const uv = d.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    // Vorn: v umdrehen (rotateX kippt die Textur), hinten: u spiegeln (von hinten gesehen).
    if (side > 0) uv.setY(i, 1 - uv.getY(i));
    else uv.setX(i, 1 - uv.getX(i));
  }
  d.translate(0, 0, (THICK + 0.005) * side);
  return d;
}

export function buildCoin(ctx: VmBuildCtx): ItemView {
  const L = ctx.light;
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.propPx));
  const rimMat = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.5, wrap: 0.15, sheen: 0.5, vertexColors: true }));
  const heads = ctx.trackTex(coinFaceTexture('heads'));
  const tails = ctx.trackTex(coinFaceTexture('tails'));
  const headsMat = ctx.track(createLitMaterial(L, { color: 0xffffff, map: heads, rim: 0.3, wrap: 0.2, sheen: 0.35 }));
  const tailsMat = ctx.track(createLitMaterial(L, { color: 0xffffff, map: tails, rim: 0.3, wrap: 0.2, sheen: 0.35 }));
  const group = new Group();
  const rim = tubeGeometry(
    [
      { y: -THICK, rx: COIN_R, rz: COIN_R },
      { y: THICK, rx: COIN_R, rz: COIN_R },
    ],
    14,
    { poleStart: -THICK - 0.01, poleEnd: THICK + 0.01, color: rgb(0xd49a30) },
  );
  rim.rotateX(Math.PI / 2);
  ctx.part(group, rim, rimMat, outline, null);
  const front = new Mesh(ctx.trackGeo(face(1)), headsMat);
  const back = new Mesh(ctx.trackGeo(face(-1)), tailsMat);
  front.frustumCulled = false;
  back.frustumCulled = false;
  group.add(front, back);
  group.visible = false;
  const P = VM_PARAM.coin;
  return {
    group,
    apply(f: ViewModelFrame): void {
      const tailsFront = f.propParam[P.side] > 0.5;
      front.material = tailsFront ? tailsMat : headsMat;
      back.material = tailsFront ? headsMat : tailsMat;
    },
  };
}
