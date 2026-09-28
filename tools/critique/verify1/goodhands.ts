// Prüfer: Sterben GUTE Hände (sync 0.9/0.95, Hand 1°/1.5°) im Standard-Kurs? levels:check prüft nur sync 1.0/0.8/0.7 und Hand 2°/3°.
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
for (const id of ['level1', 'level2']) {
  const lv = compileLevel(JSON.parse(readFileSync(`public/levels/${id}.json`, 'utf8')) as LevelFile);
  const route = lv.def.route ?? [];
  for (const m of [{ n: 'sync 0.95', o: { sync: 0.95 } }, { n: 'sync 0.9', o: { sync: 0.9 } }, { n: 'Hand 1°', o: { aimNoiseDeg: 1 } }, { n: 'Hand 1.5°', o: { aimNoiseDeg: 1.5 } }, { n: 'Hand 2°', o: { aimNoiseDeg: 2 } }]) {
    const res: string[] = [];
    let ok = 0;
    const times: number[] = [];
    for (let seed = 1; seed <= Number(process.env.SEEDS ?? 20); seed++) {
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(new Vector3(lv.spawnPos.x, lv.spawnPos.y + 1, lv.spawnPos.z));
      const rf = new RouteFollower(route, cfg, { ...m.o, steerPriority: !process.env.NOSTEER, seed, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z }, killY: lv.def.killY });
      const run = new RunState(lv);
      run.reset(null);
      const evs: RunEvent[] = [];
      let out = 'timeout';
      for (let k = 0; k < cfg.tickRate * 120; k++) {
        pm.tick(rf.next(pm.state, pm.surfNormal));
        const s = pm.state;
        const o = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
        if (o === 'finish') { out = 'finish'; times.push(run.time ?? 0); break; }
        if (o === 'fall' || o === 'kill') { out = `${o}@${rf.nextIndex}(${route[rf.nextIndex - 1]?.note ?? ''})`; break; }
        if (rf.status === 'failed') { out = `bot:${rf.report.reason}@${rf.nextIndex}`; break; }
      }
      if (out === 'finish') ok++; else res.push(`s${seed}:${out}`);
    }
    times.sort((a, b) => a - b);
    console.log(`${id} ${m.n.padEnd(9)} ${ok}/${process.env.SEEDS ?? 20} im Ziel, Median ${times[times.length >> 1]?.toFixed(2)} s  ${res.join(' ')}`);
  }
}
