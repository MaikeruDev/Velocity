import { BoxGeometry, Group, Mesh } from 'three';
import { VM_KNIFE, VM_PARAM } from '../../types';
import type { ViewModelFrame } from '../../types';
import type { EulerTuple } from 'three';
import { mergeGeometries, smoothBoxGeometry } from '../vmGeometry';
import { createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import { knifeBladeTexture, knifeHandleTexture } from '../vmTextures';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/**
 * Butterfly-Messer (Balisong-Trainer, Plan 006; Plan 008 mit echter Mechanik): zwei Griffe an ZWEI Stiften
 * am Klingen-Tang (Maße VM_KNIFE). Safe Handle am Sockel (Stift im Ursprung), Klinge dreht um ihn
 * (knifeBlade), der Bite Handle um den zweiten Stift im Tang, pinGap quer zur Klinge (knifeBite relativ zur
 * Klinge). Schneide (helle Kante der Textur) zur Bite-Seite. Riegel am unteren Ende des Bite Handle: liegt
 * eingerastet quer unter beiden Griff-Enden, offen hängt er nach unten (VM_PARAM.knife.latch).
 * Schmal → dünnere Kontur (thinPx).
 */
export function buildKnife(ctx: VmBuildCtx): ItemView {
  const K = VM_KNIFE;
  const L = ctx.light;
  const ht = ctx.trackTex(knifeHandleTexture());
  const bt = ctx.trackTex(knifeBladeTexture());
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.thinPx));
  const hm = ctx.track(createLitMaterial(L, { color: 0xffffff, map: ht, rim: 0.3, wrap: 0.5 }));
  const bm = ctx.track(createLitMaterial(L, { color: 0xffffff, map: bt, rim: 0.2, wrap: 0.35 }));
  const pinM = ctx.track(createLitMaterial(L, { color: 0xd8dce4, rim: 0, wrap: 0.4 }));
  const latchM = ctx.track(createLitMaterial(L, { color: 0x9aa2bc, rim: 0.2, wrap: 0.4 }));
  const HL = K.handleLen;
  const HW = K.handleW;
  const HD = K.handleD;
  const mid = K.pinInset - HL / 2;
  const handle = (parent: Group): void => {
    const g = new Group();
    g.position.set(0, mid, 0);
    parent.add(g);
    ctx.part(g, new BoxGeometry(HW, HL, HD), hm, outline, null, smoothBoxGeometry(HW, HL, HD));
    // Stift-Kappe auf beiden Seiten (durchgehend).
    const pin = new Mesh(ctx.trackGeo(new BoxGeometry(0.42, 0.42, HD + 0.14)), pinM);
    pin.position.set(0, HL / 2 - K.pinInset, 0);
    g.add(pin);
  };
  const group = new Group();
  // Safe Handle am Ursprung, Klinge dreht um seinen Stift.
  handle(group);
  const blade = new Group();
  // Namen nur für Werkzeuge/Tests (Abstand Klinge ↔ Hand), ohne Einfluss aufs Bild.
  blade.name = 'knifeBlade';
  group.add(blade);
  const cx = K.pinGap / 2;
  const cy = K.bladeFrom + K.bladeLen / 2;
  const bladeGeo = new BoxGeometry(K.bladeW, K.bladeLen, K.bladeD);
  bladeGeo.translate(cx, cy, 0);
  const bladeHull = smoothBoxGeometry(K.bladeW, K.bladeLen, K.bladeD);
  bladeHull.translate(cx, cy, 0);
  // Spitze: schräg abgeschnitten (gedrehter Block), Tang: kurzer breiter Block über beiden Stiften. Alles in EINER
  // Geometrie (ein Mesh + eine Hülle): mit Tang und Riegel lag das Messer sonst über dem Draw-Call-Budget (51 > 50).
  const tip = K.bladeW * 0.62;
  const tipGeo = new BoxGeometry(tip, tip, K.bladeD * 0.9);
  tipGeo.rotateZ(Math.PI / 4);
  tipGeo.translate(cx + 0.12, K.bladeFrom + K.bladeLen + 0.2, 0);
  const tangGeo = new BoxGeometry(K.pinGap + 0.7, 0.9, K.bladeD * 1.4);
  tangGeo.translate(cx, 0.05, 0);
  const tangHull = smoothBoxGeometry(K.pinGap + 0.7, 0.9, K.bladeD * 1.4);
  tangHull.translate(cx, 0.05, 0);
  const litParts = [bladeGeo, tipGeo, tangGeo];
  const hullParts = [bladeHull, tipGeo, tangHull];
  const litGeo = mergeGeometries(litParts);
  const hullGeo = mergeGeometries(hullParts);
  for (const g of [bladeGeo, tipGeo, tangGeo, bladeHull, tangHull]) g.dispose();
  ctx.part(blade, litGeo, bm, outline, null, hullGeo);
  const bite = new Group();
  bite.name = 'knifeBite';
  bite.position.set(K.pinGap, 0, 0);
  blade.add(bite);
  handle(bite);
  // Riegel: Drehpunkt am unteren Ende des Bite Handle.
  const latch = new Group();
  latch.position.set(0, K.pinInset - HL - 0.15, 0);
  bite.add(latch);
  const latchGeo = new BoxGeometry(0.42, K.pinGap + 0.9, 0.34);
  latchGeo.translate(0, -(K.pinGap + 0.9) / 2 + 0.2, 0);
  ctx.part(latch, latchGeo, latchM, outline, null);
  group.visible = false;
  const P = VM_PARAM.knife;
  // Drehungen nur bei Änderung und über fromArray (three-Setter mit Kommazahl-Argumenten boxen, fallen.md #147).
  const seen = new Float64Array(3).fill(Number.NaN);
  const eul: EulerTuple = [0.5, 0.5, 0.5];
  eul[0] = 0;
  eul[1] = 0;
  return {
    group,
    apply(f: ViewModelFrame): void {
      if (f.knifeBlade !== seen[0]) {
        seen[0] = f.knifeBlade;
        eul[2] = f.knifeBlade;
        blade.rotation.fromArray(eul);
      }
      if (f.knifeBite !== seen[1]) {
        seen[1] = f.knifeBite;
        eul[2] = f.knifeBite;
        bite.rotation.fromArray(eul);
      }
      // Eingerastet (0): quer hinüber zum Safe Handle — offen liegt er bei −x im Bite-Raum, zu bei +x; offen (1): hängt nach unten.
      const l = f.propParam[P.latch];
      const side = f.knifeBlade > Math.PI / 2 ? 1 : -1;
      const a = side * (Math.PI / 2) * (1 - (l > 0 ? (l < 1 ? l : 1) : 0));
      if (a !== seen[2]) {
        seen[2] = a;
        eul[2] = a;
        latch.rotation.fromArray(eul);
      }
    },
  };
}
