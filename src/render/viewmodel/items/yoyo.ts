import { Group } from 'three';
import type { BufferGeometry } from 'three';
import { mergeGeometries, rgb, tubeGeometry } from '../vmGeometry';
import { createLitMaterial, createOutlineMaterial } from '../vmMaterials';
import { PROP_OUTLINE } from '../vmBuild';
import type { ItemView, VmBuildCtx } from '../vmBuild';

/**
 * Jo-Jo (Plan 007, KI1): zwei Hälften (Magenta) mit Cyan-Rand, gelbem Stern-Muster auf den Flanken
 * und weißer Kappe, dunkle Achse in der Nut. Achse = y des Körpers (subSpin dreht um sie). Das Jo-Jo
 * ist der zweite Körper (`sub`), die Schnur zeichnet das ViewModel (stringPts). Im Sockel liegt nichts.
 */

const BODY = rgb(0xe8308c);
const RIM = rgb(0x3cf0ff);
const CAP = rgb(0xf6f6f6);
const STAR = rgb(0xffd23c);
const AXLE = rgb(0x303038);

function half(y0: number, y1: number): BufferGeometry {
  const d = y1 - y0;
  return tubeGeometry(
    [
      { y: y0, rx: 1.4, rz: 1.4 },
      { y: y0 + d * 0.15, rx: 2.5, rz: 2.5 },
      { y: y0 + d * 0.75, rx: 2.6, rz: 2.6 },
      { y: y1, rx: 2.2, rz: 2.2 },
    ],
    12,
    {
      poleStart: y0 - d * 0.1,
      poleEnd: y1 + d * 0.05,
      color: BODY,
      colorAt: (x, y, z, c) => {
        const r = Math.sqrt(x * x + z * z);
        const flank = Math.abs(y) > 0.9;
        let col: readonly [number, number, number] | null = null;
        if (r > 2.35) col = RIM;
        else if (r < 0.95 && flank) col = CAP;
        else if (flank && Math.sin(Math.atan2(x, z) * 3) > 0.55) col = STAR;
        if (col) {
          c[0] = col[0];
          c[1] = col[1];
          c[2] = col[2];
        }
      },
    },
  );
}

export function buildYoyo(ctx: VmBuildCtx): ItemView {
  const L = ctx.light;
  const outline = ctx.track(createOutlineMaterial(L, PROP_OUTLINE, ctx.propPx));
  const lit = ctx.track(createLitMaterial(L, { color: 0xffffff, rim: 0.3, wrap: 0.4, vertexColors: true }));
  const axle = tubeGeometry(
    [
      { y: -0.2, rx: 0.55, rz: 0.55 },
      { y: 0.2, rx: 0.55, rz: 0.55 },
    ],
    8,
    { color: AXLE },
  );
  const parts = [half(0.15, 1.15), half(-0.15, -1.15), axle];
  const body = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const sub = new Group();
  ctx.part(sub, body, lit, outline, null);
  const group = new Group();
  group.visible = false;
  return {
    group,
    sub,
    stringColor: 0xf3efd6,
    apply(): void {},
  };
}
