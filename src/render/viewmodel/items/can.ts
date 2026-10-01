import { BoxGeometry, Group, Mesh } from 'three';
import type { ViewModelFrame } from '../../types';
import { discGeometry, tubeGeometry } from '../vmGeometry';
import type { Ring } from '../vmGeometry';
import { createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import { canLabelTexture, canLidTexture } from '../vmTextures';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/** Drehung von Lasche/Öffnung um die Dosenachse (rad): Laschen-Ende (−z) → Richtung (0.894, 0, −0.447). */
const LID_TURN = -1.107;

/**
 * Energy-Drink-Dose (Plan 005/006, seit Plan 007 in der Item-Registry): weiß mit eigenem grünem
 * Zacken-Blitz, Deckel mit Niete, Lasche und Trinköffnung. Aufbau-Reihenfolge unverändert aus
 * ViewModel.ts übernommen (Material-/Objekt-Reihenfolge = Sortierung = pixelgleiches Bild).
 */
export function buildCan(ctx: VmBuildCtx): ItemView {
  const L = ctx.light;
  const label = ctx.trackTex(canLabelTexture());
  const lidTex = ctx.trackTex(canLidTexture());
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.propPx));
  const body = ctx.track(createLitMaterial(L, { color: 0xffffff, map: label, rim: 0.25, wrap: 0.45 }));
  const alu = ctx.track(createLitMaterial(L, { color: 0xffffff, map: lidTex, rim: 0.2, wrap: 0.4 }));
  const aluPlain = ctx.track(createLitMaterial(L, { color: 0xf4f6fa, rim: 0.2, wrap: 0.4 }));
  const dark = ctx.track(createLitMaterial(L, { color: 0x0e0f14, rim: 0, wrap: 0.2 }));
  const group = new Group();
  const H = 7.8;
  const rings: Ring[] = [
    { y: -H, rx: 2.95, rz: 2.95 },
    { y: -H + 0.5, rx: 3.55, rz: 3.55 },
    { y: H - 1.6, rx: 3.55, rz: 3.55 },
    { y: H - 0.45, rx: 3.0, rz: 3.0 },
    { y: H, rx: 2.92, rz: 2.92 },
  ];
  ctx.part(group, tubeGeometry(rings, 10, { poleStart: -H + 0.1, poleEnd: H - 0.35, uvByY: true }), body, outline, null);
  // Deckel mit Niete, Lasche und Trinköffnung — ÜBER der Kegelkappe des Körpers (Pol tief
  // genug), sonst deckt der Kegel die Öffnung zu (fallen.md #83).
  const lid = new Mesh(ctx.trackGeo(discGeometry(2.8, 10, H - 0.06)), alu);
  lid.frustumCulled = false;
  group.add(lid);
  // Plan 008: Lasche und Öffnung um die Achse gedreht — das Laschen-Ende zeigt zum Zeigefinger, der sie im crack
  // aufhebelt (IK: nur dort erreicht er den Rand); die Öffnung liegt gegenüber, neben dem Daumen.
  const lidTurn = new Group();
  lidTurn.rotation.y = LID_TURN;
  group.add(lidTurn);
  const hole = new Mesh(ctx.trackGeo(discGeometry(1.0, 8, 0)), dark);
  hole.scale.set(1.15, 1, 0.85);
  hole.position.set(0, H - 0.02, 1.55);
  hole.visible = false;
  lidTurn.add(hole);
  const tab = new Group();
  // Drehpunkt an der Niete (Mitte), Lasche zeigt zur Öffnung hin (+z) und nach hinten (−z). Etwas größer als
  // Plan 006, damit das Aufhebeln bei 270 Zeilen lesbar ist.
  tab.position.set(0, H - 0.02, 0.1);
  const tabMesh = new Mesh(ctx.trackGeo(new BoxGeometry(1.25, 0.18, 2.5)), aluPlain);
  tabMesh.position.set(0, 0.09, -0.95);
  tabMesh.frustumCulled = false;
  tab.add(tabMesh);
  lidTurn.add(tab);
  group.visible = false;
  return {
    group,
    apply(f: ViewModelFrame): void {
      // Lasche: Hebel um die Niete — das hintere Ende steigt (bis ~75°).
      tab.rotation.x = f.canTab * 1.3;
      hole.visible = f.canOpen;
    },
  };
}
