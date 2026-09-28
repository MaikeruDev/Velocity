// Einzel-Lauf im L1-Slalom tick-genau ab dem letzten Absprung vor dem Tod.
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { RunState } from '../../../src/engine/runState';
import type { RunEvent } from '../../../src/engine/events';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../src/player/bots';
import { compileLevel } from '../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../src/world/level/LevelFormat';
const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;
const lv = compileLevel(JSON.parse(readFileSync(process.env.LEVEL ?? 'public/levels/level1.json', 'utf8')) as LevelFile);
const route = lv.def.route ?? [];
const o = process.env.SYNC ? { sync: Number(process.env.SYNC) } : { aimNoiseDeg: Number(process.env.AIM ?? 1.5) };
const seed = Number(process.env.SEED ?? 2);
const pm = new PlayerMovement(lv.world, cfg);
pm.teleport(new Vector3(lv.spawnPos.x, lv.spawnPos.y + 1, lv.spawnPos.z));
const rf = new RouteFollower(route, cfg, { ...o, seed, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z }, killY: lv.def.killY });
const run = new RunState(lv);
run.reset(null);
const evs: RunEvent[] = [];
let lines: string[] = [];
for (let k = 0; k < cfg.tickRate * 120; k++) {
  const inp = rf.next(pm.state, pm.surfNormal);
  const ev = pm.tick(inp);
  const s = pm.state;
  if (ev.some((e) => e.type === 'jump')) lines = [];
  if (k % 4 === 0 || ev.length) lines.push(`t${k} n${rf.nextIndex} x${s.pos.x.toFixed(0)} y${s.pos.y.toFixed(0)} z${s.pos.z.toFixed(0)} vx${s.vel.x.toFixed(0)} vz${s.vel.z.toFixed(0)} g${s.onGround ? 1 : 0} f${inp.forward} s${inp.side} ${ev.map((e) => e.type).join(',')}`);
  const r = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
  if (r === 'finish' || r === 'fall' || r === 'kill') { console.log(r); break; }
}
console.log(lines.slice(0, 80).join('\n'));
