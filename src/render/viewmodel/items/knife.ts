import { BoxGeometry, Group, Mesh } from 'three';
import type { ViewModelFrame } from '../../types';
import { smoothBoxGeometry } from '../vmGeometry';
import { createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import { knifeBladeTexture, knifeHandleTexture } from '../vmTextures';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/**
 * Butterfly-Messer (Balisong-Trainer, Plan 006; seit Plan 007 in der Item-Registry): gehaltener
 * Griff am Ursprung, Klinge dreht um ihren Stift, zweiter Griff an der Klinge. Schmal → dünnere
 * Kontur (thinPx). Aufbau unverändert aus ViewModel.ts übernommen.
 */
export function buildKnife(ctx: VmBuildCtx): ItemView {
  const L = ctx.light;
  const ht = ctx.trackTex(knifeHandleTexture());
  const bt = ctx.trackTex(knifeBladeTexture());
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.thinPx));
  const hm = ctx.track(createLitMaterial(L, { color: 0xffffff, map: ht, rim: 0.3, wrap: 0.5 }));
  const bm = ctx.track(createLitMaterial(L, { color: 0xffffff, map: bt, rim: 0.2, wrap: 0.35 }));
  const pinM = ctx.track(createLitMaterial(L, { color: 0xd8dce4, rim: 0, wrap: 0.4 }));
  const HL = 10.5;
  const HW = 1.25;
  const HD = 0.95;
  const PIN = 0.9;
  const handle = (parent: Group): void => {
    const g = new Group();
    g.position.set(0, -HL / 2 + 0.3, 0);
    parent.add(g);
    ctx.part(g, new BoxGeometry(HW, HL, HD), hm, outline, null, smoothBoxGeometry(HW, HL, HD));
    const pin = new Mesh(ctx.trackGeo(new BoxGeometry(0.4, 0.4, HD + 0.12)), pinM);
    pin.position.set(0, HL / 2 - 0.3, 0);
    g.add(pin);
  };
  const group = new Group();
  // Gehaltener Griff (safe) am Ursprung, Klinge dreht um seinen Stift.
  handle(group);
  const blade = new Group();
  blade.rotation.order = 'XYZ';
  group.add(blade);
  const bladeGeo = new BoxGeometry(1.5, 8.6, 0.18);
  bladeGeo.translate(PIN, 4.3 + 0.2, 0);
  const bladeHull = smoothBoxGeometry(1.5, 8.6, 0.18);
  bladeHull.translate(PIN, 4.3 + 0.2, 0);
  ctx.part(blade, bladeGeo, bm, outline, null, bladeHull);
  // Spitze: schräg abgeschnitten (kleiner gedrehter Block).
  const tipGeo = new BoxGeometry(0.95, 0.95, 0.16);
  tipGeo.rotateZ(Math.PI / 4);
  tipGeo.translate(PIN + 0.12, 8.95, 0);
  ctx.part(blade, tipGeo, bm, outline, null);
  const bite = new Group();
  bite.position.set(PIN * 2, 0, 0);
  blade.add(bite);
  handle(bite);
  group.visible = false;
  return {
    group,
    apply(f: ViewModelFrame): void {
      blade.rotation.z = f.knifeBlade;
      bite.rotation.z = f.knifeBite;
    },
  };
}
