import { BoxGeometry, Group, Mesh, PlaneGeometry } from 'three';
import type { IUniform } from 'three';
import type { ViewModelFrame } from '../../types';
import { smoothBoxGeometry } from '../vmGeometry';
import { ScalarUniform, createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import { cardBackTexture, cardFrontTexture } from '../vmTextures';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/**
 * Sammelkarte (Plan 006, seit Plan 007 in der Item-Registry): eigenes Monster, Holo-Streifen per
 * Shader, beide Seiten texturiert. Sichtbarkeit = Bayer-Screen-Door über ein geteiltes uVis
 * (Zaubertrick). Aufbau unverändert aus ViewModel.ts übernommen.
 */
export function buildCard(ctx: VmBuildCtx): ItemView {
  const L = ctx.light;
  const front = ctx.trackTex(cardFrontTexture());
  const back = ctx.trackTex(cardBackTexture());
  const vis: IUniform<number> = new ScalarUniform(1);
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.propPx));
  const fm = ctx.track(createLitMaterial(L, { color: 0xffffff, map: front, holo: true, rim: 0.15, wrap: 0.7 }));
  const bm = ctx.track(createLitMaterial(L, { color: 0xffffff, map: back, rim: 0.15, wrap: 0.7 }));
  const em = ctx.track(createLitMaterial(L, { color: 0xe8e8f0, rim: 0, wrap: 0.7 }));
  for (const m of [outline, fm, bm, em]) m.uniforms.uVis = vis;
  const W = 6.4;
  const H = 8.8;
  const D = 0.12;
  const group = new Group();
  const f = new Mesh(ctx.trackGeo(new PlaneGeometry(W, H)), fm);
  f.position.z = D / 2 + 0.001;
  const b = new Mesh(ctx.trackGeo(new PlaneGeometry(W, H)), bm);
  b.rotation.y = Math.PI;
  b.position.z = -D / 2 - 0.001;
  const edge = new Mesh(ctx.trackGeo(new BoxGeometry(W, H, D)), em);
  const hull = new Mesh(ctx.trackGeo(smoothBoxGeometry(W, H, D)), outline);
  for (const o of [f, b, edge, hull]) {
    o.frustumCulled = false;
    group.add(o);
  }
  group.visible = false;
  return {
    group,
    apply(fr: ViewModelFrame): void {
      vis.value = fr.propVisible;
    },
  };
}
