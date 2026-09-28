/**
 * Level 4 — Bot-Trace (wie tools/levels/trace.ts, aber für den Prototyp).
 *   npx tsx tools/critique/v2/level4/trace.ts [cp] [sync|hN] [seed] [everyTicks]
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { resumeIndex } from '../../../levels/physics';
import { buildLevel4 } from './level4';

const cfg = VELOCITY_DEFAULT;
const [cpArg = '0', modelArg = '1', seedArg = '1', everyArg = '32'] = process.argv.slice(2);
const def = buildLevel4({ measure: false });
const lv = compileLevel(def);
const route = def.route ?? [];
const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
const cp = Number(cpArg);
const start = cp > 0 ? cps[cp - 1].spawnPos : lv.spawnPos;
const from = cp > 0 ? resumeIndex(route, cps[cp - 1]) : 0;
const model = modelArg.startsWith('h') ? { aimNoiseDeg: Number(modelArg.slice(1)) } : { sync: Number(modelArg) };
const pm = new PlayerMovement(lv.world, cfg);
pm.teleport(new Vector3(start.x, start.y + 1, start.z));
const bot = new RouteFollower(route.slice(from), cfg, { ...model, seed: Number(seedArg), killY: def.killY, world: lv.world, start: { x: start.x, z: start.z }, stallTimeout: 12 });
const kills = lv.triggers.filter((t) => t.kind === 'kill');
const fin = lv.triggers.find((t) => t.kind === 'finish');
const every = Number(everyArg);
const hmin = new Vector3();
const hmax = new Vector3();
for (let k = 0; k < 90 * cfg.tickRate; k++) {
  pm.tick(bot.next(pm.state, pm.surfNormal));
  const s = pm.state;
  hmin.copy(s.pos).add(pm.hullMins);
  hmax.copy(s.pos).add(pm.hullMaxs);
  const kill = kills.find((z) => z.bounds.intersectsBox({ min: hmin, max: hmax } as never));
  const node = from + bot.nextIndex;
  if (k % every === 0 || kill || bot.status !== 'running') {
    console.log(`${(k / cfg.tickRate).toFixed(2)}s pos ${s.pos.x.toFixed(0)},${s.pos.y.toFixed(0)},${s.pos.z.toFixed(0)} v ${s.speed.toFixed(0)} vy ${s.vel.y.toFixed(0)} ${s.onGround ? 'G' : s.surfing ? 'S' : 'A'} → Knoten ${node} ${route[node]?.note ?? ''} ${kill ? `KILL ${kill.tag}` : ''} ${bot.status}`);
  }
  if (kill || bot.status !== 'running') break;
  if (fin && fin.bounds.intersectsBox({ min: hmin, max: hmax } as never)) {
    console.log(`ZIEL nach ${(k / cfg.tickRate).toFixed(2)} s`);
    break;
  }
}
console.log(JSON.stringify(bot.report.reason), bot.report.reached, '/', bot.report.total);
