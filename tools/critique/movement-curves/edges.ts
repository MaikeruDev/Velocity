/**
 * Kanten: Landet man, wenn die Hull nur knapp über der Plattformkante hängt?
 * Achsparallele Plattform (L1 hop1) vs. gedrehte Kurven-Pads (L1 curve2, rotY 46°).
 * Fall senkrecht (vy −300) mit Überlappung o u, plus Anflug mit 500 u/s über die Kante.
 * npx tsx tools/critique/movement-curves/edges.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { compileLevel } from '../../../src/world/level/compileLevel';
import { readLevelFile } from '../../sim/levels';
import { makeInput } from '../../sim/harness';

const cfg = VELOCITY_DEFAULT;
const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
const def = L1.def.brushes.find((b) => b.tag === 'curve2');
if (!def || def.type !== 'box') throw new Error('curve2');
// curve2: box um Mittelpunkt gedreht (rotY Grad). Eine Kante: lokale +x-Seite.
const cx = (def.min[0] + def.max[0]) / 2;
const cz = (def.min[2] + def.max[2]) / 2;
const hx = (def.max[0] - def.min[0]) / 2;
const top = def.max[1];
const r = ((def.rotY ?? 0) * Math.PI) / 180;
// lokale +x-Achse nach three rotation.y: (cos r, 0, -sin r)
const ax = Math.cos(r);
const az = -Math.sin(r);

function drop(px: number, pz: number, y: number, vx: number, vz: number, topY: number): string {
  const pm = new PlayerMovement(L1.world, cfg);
  pm.teleport(new Vector3(px, y, pz));
  pm.state.vel.set(vx, -300, vz);
  for (let t = 0; t < 128; t++) {
    const ev = pm.tick(makeInput());
    if (ev.some((e) => e.type === 'land')) { for (let k = 0; k < 64; k++) pm.tick(makeInput()); return pm.state.onGround ? `steht (Füße ${(pm.state.pos.y - topY).toFixed(1)} über Top)` : 'rutscht ab'; }
    if (pm.state.surfing) return 'SURF/rutscht';
    if (pm.state.pos.y < topY - 40) return 'fällt vorbei';
  }
  return '?';
}

console.log('## Senkrechter Fall auf Kante, Überlappung o (Hull-Mitte außerhalb der Kante um 16 − o)');
for (const o of [0.5, 2, 4, 8, 12]) {
  // Gedrehtes Pad: Hull-Mitte außerhalb entlang lokaler +x
  const d = hx + 16 - o;
  const gx = cx + ax * d;
  const gz = cz + az * d;
  // Achsparallel hop1: +x-Kante bei x=128
  console.log(`o=${o} u: hop1 (achsparallel) ${drop(128 + 16 - o, -2157, 128 + 30, 0, 0, 128)} | curve2 (46° gedreht) ${drop(gx, gz, top + 30, 0, 0, top)}`);
}
