// L1 ab CP3 aus dem Stand (Respawn vor dem Slalom): RouteFollower-Hände über viele Seeds.
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { RunState } from '../../../src/engine/runState';
import type { RunEvent } from '../../../src/engine/events';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../src/player/bots';
import { compileLevel } from '../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { resumeIndex } from '../../levels/physics';
const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;
const lv = compileLevel(JSON.parse(readFileSync('public/levels/level1.json', 'utf8')) as LevelFile);
const route = lv.def.route ?? [];
const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
const N = Number(process.env.SEEDS ?? 20);
for (const cp of cps) {
  const from = resumeIndex(route, cp);
  for (const m of [{ n: 'Hand 1°', o: { aimNoiseDeg: 1 } }, { n: 'Hand 2°', o: { aimNoiseDeg: 2 } }, { n: 'Hand 3°', o: { aimNoiseDeg: 3 } }, { n: 'Hand 5°', o: { aimNoiseDeg: 5 } }, { n: 'sync 0.8', o: { sync: 0.8 } }]) {
    let ok = 0;
    const fails: string[] = [];
    for (let seed = 1; seed <= N; seed++) {
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(new Vector3(cp.spawnPos.x, cp.spawnPos.y + 1, cp.spawnPos.z));
      const rf = new RouteFollower(route.slice(from), cfg, { ...m.o, seed, world: lv.world, start: { x: cp.spawnPos.x, z: cp.spawnPos.z }, killY: lv.def.killY });
      const run = new RunState(lv);
      run.reset(null);
      const evs: RunEvent[] = [];
      let out = 'timeout';
      for (let k = 0; k < cfg.tickRate * 90; k++) {
        pm.tick(rf.next(pm.state, pm.surfNormal));
        const s = pm.state;
        const o = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
        if (o === 'finish') { out = 'finish'; break; }
        if (o === 'fall' || o === 'kill') { out = `${o}@${from + rf.nextIndex}`; break; }
        if (rf.status === 'failed') { out = `bot:${rf.report.reason}@${from + rf.nextIndex}`; break; }
        if (rf.status === 'finished') { out = 'finish'; break; }
        // Nächster Checkpoint reicht.
        if (run.checkpoint > cp.order) { out = 'finish'; break; }
      }
      if (out === 'finish') ok++; else fails.push(`s${seed}:${out}`);
    }
    console.log(`CP${cp.order} ${m.n.padEnd(8)} ${ok}/${N}  ${fails.join(' ')}`);
  }
}
