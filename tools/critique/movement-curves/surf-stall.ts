/**
 * Warum stallt der Grundtechnik-Surfer bei Blick +7° in die Rampe?
 * Tick-Protokoll ab Kontakt mit S1: Achs-Speed, Falllinien-Speed, wishdir-Rückwärtsanteil, steepBelow.
 * npx tsx tools/critique/movement-curves/surf-stall.ts [offsetDeg]
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { compileLevel } from '../../../src/world/level/compileLevel';
import { readLevelFile } from '../../sim/levels';
import { SurfRider, routeAxis } from '../../levels/physics';

const cfg = VELOCITY_DEFAULT;
const off = Number(process.argv[2] ?? 7);
const L2 = compileLevel(readLevelFile('public/levels/level2.json'));
const axisAt = routeAxis(L2.def.route ?? []);
const cp2 = L2.triggers.find((t) => t.kind === 'checkpoint' && t.order === 2);
if (!cp2) throw new Error('cp2');
const pm = new PlayerMovement(L2.world, cfg);
pm.teleport(cp2.spawnPos.clone().add(new Vector3(0, 1, 0)));
const rider = new SurfRider(cfg, L2.world, axisAt, (off * Math.PI) / 180);
let contact = -1;
for (let t = 0; t < 6 * cfg.tickRate; t++) {
  const inp = rider.next(pm.state, pm.surfNormal);
  const n = pm.surfNormal.clone();
  const before = pm.state.vel.clone();
  pm.tick(inp);
  const s = pm.state;
  if (contact < 0 && s.surfing) contact = t;
  if (contact >= 0 && (t - contact) % 4 === 0 && t - contact < 120) {
    const fx = -Math.sin(inp.yaw) * 0 + Math.cos(inp.yaw) * inp.side; // wishdir x (forward=0)
    const fz = -Math.sin(inp.yaw) * inp.side;
    const sp = Math.hypot(before.x, before.z);
    const back = sp > 1 ? (fx * before.x + fz * before.z) / sp : 0;
    console.log(`+${t - contact} pos(${s.pos.x.toFixed(0)},${s.pos.y.toFixed(0)},${s.pos.z.toFixed(0)}) vel(${s.vel.x.toFixed(0)},${s.vel.y.toFixed(0)},${s.vel.z.toFixed(0)}) n(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}) side${inp.side} yaw${(inp.yaw * 180 / Math.PI).toFixed(1)} wish·v̂=${back.toFixed(3)}`);
  }
}
