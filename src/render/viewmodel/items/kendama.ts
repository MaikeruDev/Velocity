import { Group } from 'three';
import type { BufferGeometry } from 'three';
import { capsuleGeometry, mergeGeometries, rgb, tubeGeometry } from '../vmGeometry';
import { createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/**
 * Kendama (Plan 007, KI6): Ken aus hellem Holz — Griff (y), Querstück mit großem (+x) und kleinem
 * (−x) Becher, Fußbecher unten, Spitze oben — und die Kugel (tama) als zweiter Körper: rot mit weißem
 * Streifen, Loch an +y. Maße hier = Fangpunkte in ui/hand/kendamaTricks (KEN_* dort, gleiche Zahlen).
 * Ken 2 Draw Calls, Kugel 2, Schnur 1.
 */

const WOOD = rgb(0xe3c08a);
const WOOD_D = rgb(0xb88d52);
const RED = rgb(0xd8263a);
const STRIPE = rgb(0xf4f4f4);
const HOLE = rgb(0x1a1016);

/** Becher als Schale entlang +y (Rand oben), dann um z gekippt und verschoben. */
function cup(x: number, y: number, r: number, tilt: number): BufferGeometry {
  const c = tubeGeometry(
    [
      { y: 0, rx: r * 0.55, rz: r * 0.55 },
      { y: 0.75, rx: r, rz: r },
      { y: 1.0, rx: r * 1.06, rz: r * 1.06 },
    ],
    12,
    { poleStart: -0.1, poleEnd: 0.55, color: WOOD_D },
  );
  c.rotateZ(tilt);
  c.translate(x, y, 0);
  return c;
}

function kenGeometry(): BufferGeometry {
  const handle = tubeGeometry(
    [
      { y: -4.0, rx: 1.0, rz: 1.0 },
      { y: -3.6, rx: 0.85, rz: 0.85 },
      { y: -0.4, rx: 0.72, rz: 0.72 },
      { y: 1.0, rx: 0.85, rz: 0.85 },
    ],
    10,
    { color: WOOD },
  );
  // Fußbecher (unten, nach unten offen).
  const base = tubeGeometry(
    [
      { y: -4.0, rx: 1.0, rz: 1.0 },
      { y: -4.5, rx: 1.45, rz: 1.45 },
      { y: -4.85, rx: 1.6, rz: 1.6 },
    ],
    10,
    { poleStart: -3.9, poleEnd: -4.55, color: WOOD_D },
  );
  const spike = tubeGeometry(
    [
      { y: 1.0, rx: 0.7, rz: 0.7 },
      { y: 3.0, rx: 0.36, rz: 0.36 },
    ],
    8,
    { poleEnd: 3.7, color: WOOD },
  );
  // Querstück (Sarado) quer über dem Griff.
  const cross = tubeGeometry(
    [
      { y: -2.3, rx: 0.95, rz: 0.95 },
      { y: 2.1, rx: 0.95, rz: 0.95 },
    ],
    10,
    { poleStart: -2.35, poleEnd: 2.15, color: WOOD_D },
  );
  cross.rotateZ(Math.PI / 2);
  cross.translate(0, 0.3, 0);
  // Großer Becher rechts (+x), kleiner links (−x), Öffnungen nach außen: in Ruhe fast waagerecht — für
  // einen Fang kippen Hand und Ken den Becher nach oben (beide Seiten gleich weit, ~70°).
  const big = cup(2.3, 0.3, 1.75, -Math.PI / 2);
  const small = cup(-2.1, 0.3, 1.35, Math.PI / 2);
  const parts = [handle, base, spike, cross, big, small];
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

export const TAMA_R = 1.9;

export function buildKendama(ctx: VmBuildCtx): ItemView {
  const L = ctx.light;
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.propPx));
  const lit = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.3, wrap: 0.45, vertexColors: true }));
  const group = new Group();
  ctx.part(group, kenGeometry(), lit, outline, null);
  group.visible = false;
  const sub = new Group();
  const ball = capsuleGeometry(0.01, TAMA_R, TAMA_R, 12, 1, 3, {
    color: RED,
    colorAt: (x, y, z, c) => {
      const col = Math.abs(y) < 0.3 ? STRIPE : y > TAMA_R * 0.82 && Math.sqrt(x * x + z * z) < 0.75 ? HOLE : null;
      if (col) {
        c[0] = col[0];
        c[1] = col[1];
        c[2] = col[2];
      }
    },
  });
  ctx.part(sub, ball, lit, outline, null);
  return { group, sub, stringColor: 0xe8dcc0, apply(): void {} };
}
