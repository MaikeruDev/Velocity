/** Debug: Crouch-Hop bei 900 u/s mit Assist — wo scheitert er? npx tsx tools/critique/v2/arcade-mechanics/dbg-ledge.ts */
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { NO_INPUT } from '../../../../src/player/types';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { readLevelFile } from '../../../sim/levels';
import { ArcadeMovement, arcadeStats } from './ArcadeMovement';

const cfg = VELOCITY_DEFAULT;
const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
const h7 = L1.brushes.find((b) => b.tag === 'hop7')!;
const ledge = L1.brushes.find((b) => b.tag === 'ledge')!;
const lip = L1.brushes.find((b) => b.tag === 'ledgeLip')!;
console.log('h7', h7.bounds.min.toArray(), h7.bounds.max.toArray(), 'lip', lip.bounds.min.toArray(), lip.bounds.max.toArray(), 'ledge', ledge.bounds.min.toArray(), ledge.bounds.max.toArray());
const onLedge = new Box3(new Vector3(ledge.bounds.min.x, ledge.bounds.max.y - 2, ledge.bounds.min.z), ledge.bounds.max.clone().setY(ledge.bounds.max.y + 4));
const x = (h7.bounds.min.x + h7.bounds.max.x) / 2;
for (let z = h7.bounds.max.z - 16; z >= h7.bounds.min.z + 16.5; z -= 8) {
  const res: string[] = [];
  for (const mk of [() => new PlayerMovement(L1.world, cfg), () => new ArcadeMovement(L1.world, cfg, { ledge: { height: 5, memory: 0.2 } })]) {
    const pm = mk();
    pm.teleport(new Vector3(x, h7.bounds.max.y + 0.03125, z));
    pm.state.vel.set(0, 0, -900);
    let ok = false;
    const log: string[] = [];
    for (let k = 0; k < 1.5 * 128; k++) {
      pm.tick({ ...NO_INPUT, sprint: true, forward: 1, jumpPressed: k === 0, jumpHeld: k === 0, crouch: k >= 1 });
      const s = pm.state;
      const st = pm instanceof ArcadeMovement ? arcadeStats(pm).last : '';
      if (st) log.push(`${k}:${st}@y${s.pos.y.toFixed(1)} z${s.pos.z.toFixed(0)} v${s.speed.toFixed(0)}`);
      const hb = new Box3(s.pos.clone().add(pm.hullMins), s.pos.clone().add(pm.hullMaxs));
      if (onLedge.intersectsBox(hb)) { ok = true; break; }
      if (s.onGround && k > 10 && s.pos.y < h7.bounds.max.y + 1) break;
    }
    res.push(`${ok ? 'OK ' : 'NO '} end y${pm.state.pos.y.toFixed(1)} z${pm.state.pos.z.toFixed(0)} ${log.join(' ')}`);
  }
  if (res[0].slice(0, 3) !== res[1].slice(0, 3) || res[1].includes(':')) console.log(z.toFixed(0), '|', res.join(' || '));
}
