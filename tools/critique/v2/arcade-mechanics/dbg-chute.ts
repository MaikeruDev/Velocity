/** Debug: L1 chuteCatch-Fehlschlag mit Kanten-Assist (Knoten 31, 840 u/s, Versatz 48). */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { NO_INPUT } from '../../../../src/player/types';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { makeTraceResult } from '../../../../src/world/collision/types';
import { readLevelFile } from '../../../sim/levels';
import { SurfRider, routeAxis } from '../../../levels/physics';
import { ArcadeMovement, arcadeStats } from './ArcadeMovement';

const cfg = VELOCITY_DEFAULT;
const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
const route = L1.def.route ?? [];
const i = 31;
const A = route[i];
const B = route[i + 1];
const dir = new Vector3(B.pos[0] - A.pos[0], 0, B.pos[2] - A.pos[2]).normalize();
const yaw = Math.atan2(-dir.x, -dir.z);
const lat = Number(process.argv[2] ?? 48);
const v = Number(process.argv[3] ?? 840);
const p = new Vector3(A.pos[0] - dir.z * lat, A.pos[1], A.pos[2] + dir.x * lat);
const tr = L1.world.traceBox(p.clone().setY(p.y + 48), p.clone().setY(p.y - 64), new Vector3(-16, 0, -16), new Vector3(16, 72, 16), makeTraceResult());
const start = tr.endPos.clone();
const axis = routeAxis(route);
const fin = L1.triggers.find((t) => t.kind === 'finish')!;
for (const mk of [() => new PlayerMovement(L1.world, cfg), () => new ArcadeMovement(L1.world, cfg, { ledge: { height: 5, memory: 0.2 } })]) {
  const pm = mk();
  pm.teleport(start);
  pm.state.vel.set(dir.x * v, 0, dir.z * v);
  const rider = new SurfRider(cfg, L1.world, axis, 0);
  let first = true;
  const log: string[] = [];
  let res = 'timeout';
  for (let k = 0; k < 14 * 128; k++) {
    const s = pm.state;
    let inp;
    inp = { ...NO_INPUT, yaw, jumpHeld: true, jumpPressed: first };
    first = false;
    void rider;
    pm.tick(inp);
    const st = pm instanceof ArcadeMovement ? arcadeStats(pm).last : '';
    if (st) log.push(`${k}:${st}@${s.pos.x.toFixed(0)},${s.pos.y.toFixed(0)},${s.pos.z.toFixed(0)} v${s.speed.toFixed(0)}`);
    if (fin.bounds.containsPoint(s.pos)) { res = `ZIEL ${(k / 128).toFixed(2)} s`; break; }
    let dead = false;
    for (const t of L1.triggers) if (t.kind === 'kill' && t.bounds.containsPoint(s.pos)) dead = true;
    if (dead || s.pos.y < L1.def.killY) { res = `tot @${s.pos.x.toFixed(0)},${s.pos.y.toFixed(0)},${s.pos.z.toFixed(0)} t ${(k / 128).toFixed(2)}`; break; }
    if (k % 64 === 0) log.push(`  [${k}] ${s.pos.x.toFixed(0)},${s.pos.y.toFixed(0)},${s.pos.z.toFixed(0)} v${s.speed.toFixed(0)} g${s.onGround ? 1 : 0} surf${s.surfing ? 1 : 0}`);
  }
  console.log(pm.constructor.name, res);
  console.log(log.join('\n'));
}
