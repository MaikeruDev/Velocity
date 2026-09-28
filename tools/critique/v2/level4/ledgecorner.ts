/**
 * Befund-Repro 3: Luft-Hänger in der Ecke zwischen einer 64-u-Kante (Crouch-Stufe) und einer
 * hohen Seitenwand (Bande), W diagonal in die Ecke, geduckt, Füße knapp unter der Kante.
 * Varianten: rechtwinklige Ecke (achsparallel), gedreht, und mit 45°-Fase in der Ecke.
 *   npx tsx tools/critique/v2/level4/ledgecorner.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { BrushDef, LevelFile } from '../../../../src/world/level/LevelFormat';

const cfg = VELOCITY_DEFAULT;
const ENV = { skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1, sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -3000 };
function run(rot: number, chamfer: number, look: number, duck: boolean, feet: number): number {
  // Ledge: x ≥ 0 ist 64 hoch (Stirn bei x = 0, Normale −x); Seitenwand: z ≥ 200 (Normale −z), 300 hoch.
  const b: BrushDef[] = [
    { type: 'box', min: [-2000, -64, -2000], max: [2000, 0, 2000], mat: 'floor' },
    { type: 'box', min: [0, 0, -2000], max: [2000, 64, 2000], mat: 'floor', rotY: rot, pivot: [0, 0, 200] },
    { type: 'box', min: [-2000, 0, 200], max: [2000, 300, 232], mat: 'wall', rotY: rot, pivot: [0, 0, 200] },
  ];
  if (chamfer > 0) b.push({ type: 'hull', rotY: rot, pivot: [0, 0, 200], mat: 'wall', points: [[-chamfer, 0, 200], [0, 0, 200 - chamfer], [0, 0, 200], [-chamfer, 300, 200], [0, 300, 200 - chamfer], [0, 300, 200]] });
  const def: LevelFile = { version: 1, id: 'lc', name: 'lc', spawn: { pos: [0, 0, 0], yaw: 0 }, killY: -4000, environment: ENV, brushes: b, triggers: [] };
  const lv = compileLevel(def);
  const pm = new PlayerMovement(lv.world, cfg);
  const a = (rot * Math.PI) / 180;
  // Start: in der Ecke (vor der Stirn, an der Wand), Füße `feet` über dem Boden, in Welt gedreht.
  const lx = -17 - chamfer, lz = 183 - chamfer * 0.2;
  const rx = lx * Math.cos(a) + (lz - 200) * Math.sin(a);
  const rz = -lx * Math.sin(a) + (lz - 200) * Math.cos(a) + 200;
  pm.teleport(new Vector3(rx, feet, rz));
  const inp = makeBotInput();
  // Blick: Richtung +x (yaw 270) plus Drehung, dazu `look` Grad zur Wand (+z = rechts).
  const yaw = ((270 + rot - look) * Math.PI) / 180;
  const y0 = pm.state.pos.y;
  let hang = 0;
  let maxHang = 0;
  let upTop = false;
  for (let k = 0; k < cfg.tickRate; k++) {
    inp.yaw = yaw; inp.forward = 1; inp.crouch = duck;
    pm.tick(inp);
    hang = !pm.state.onGround && Math.abs(pm.state.vel.y) < 12 ? hang + 1 : 0;
    maxHang = Math.max(maxHang, hang);
    if (pm.state.onGround && pm.state.pos.y > 60) upTop = true;
    if (pm.state.onGround) break;
  }
  void y0;
  return upTop ? -1 : maxHang / cfg.tickRate;
}
const rows = ['| Ecke | Fase | Blick zur Wand | Ducken | Füße | längster Luft-Hänger (s) |', '|---|---|---|---|---|---|'];
let hangs = 0;
let total = 0;
for (const rot of [0, 5, 30]) for (const chamfer of [0, 48]) for (const look of [10, 30, 45]) for (const duck of [true, false]) for (const feet of [50, 58]) {
  const h = run(rot, chamfer, look, duck, feet);
  total++;
  if (h > 0.25) { hangs++; rows.push(`| ${rot}° gedreht | ${chamfer ? `${chamfer} u` : '—'} | ${look}° | ${duck ? 'ja' : 'nein'} | ${feet} | **${h.toFixed(2)}** |`); }
}
console.log(rows.join('\n'));
console.log(`Hänger > 0.25 s: ${hangs}/${total}`);
for (const chamfer of [0, 48]) {
  let n = 0; let c = 0;
  for (const rot of [0, 5, 30]) for (const look of [10, 30, 45]) for (const duck of [true, false]) for (const feet of [50, 58]) { c++; if (run(rot, chamfer, look, duck, feet) > 0.25) n++; }
  console.log(`  Fase ${chamfer}: ${n}/${c}`);
}
