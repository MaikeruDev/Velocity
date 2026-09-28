// Diagnose L1-Slalom: Tempo am Einstieg, Absprung/Landung je Hop, Todesort (gute Hände).
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
const file = process.argv[2] ?? 'public/levels/level1.json';
const lv = compileLevel(JSON.parse(readFileSync(file, 'utf8')) as LevelFile);
const route = lv.def.route ?? [];
const slIdx = route.findIndex((n) => n.note === 'Slalom');
const only = process.env.SEEDS ? process.env.SEEDS.split(',').map(Number) : null;
for (const m of [{ n: 'Hand 1°', o: { aimNoiseDeg: 1 } }, { n: 'Hand 1.5°', o: { aimNoiseDeg: 1.5 } }, { n: 'sync 0.9', o: { sync: 0.9 } }, { n: 'Hand 2°', o: { aimNoiseDeg: 2 } }]) {
  for (let seed = 1; seed <= 20; seed++) {
    if (only && !only.includes(seed)) continue;
    const pm = new PlayerMovement(lv.world, cfg);
    pm.teleport(new Vector3(lv.spawnPos.x, lv.spawnPos.y + 1, lv.spawnPos.z));
    const rf = new RouteFollower(route, cfg, { ...m.o, seed, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z }, killY: lv.def.killY });
    const run = new RunState(lv);
    run.reset(null);
    const evs: RunEvent[] = [];
    const log: string[] = [];
    let entry = 0;
    let out = 'timeout';
    for (let k = 0; k < cfg.tickRate * 120; k++) {
      const was = pm.state.onGround;
      for (const e of pm.tick(rf.next(pm.state, pm.surfNormal))) {
        if (rf.nextIndex >= slIdx && rf.nextIndex <= slIdx + 7) {
          if (e.type === 'jump') log.push(`J n${rf.nextIndex} x${pm.state.pos.x.toFixed(0)} z${pm.state.pos.z.toFixed(0)} v${e.speed.toFixed(0)}`);
          if (e.type === 'land') log.push(`L x${pm.state.pos.x.toFixed(0)} z${pm.state.pos.z.toFixed(0)} v${e.speed.toFixed(0)}`);
        }
      }
      void was;
      if (!entry && rf.nextIndex === slIdx + 1) entry = pm.state.speed;
      const s = pm.state;
      const o = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
      if (o === 'finish') { out = 'finish'; break; }
      if (o === 'fall' || o === 'kill') { out = `${o}@${rf.nextIndex} x${s.pos.x.toFixed(0)} z${s.pos.z.toFixed(0)}`; break; }
    }
    if (out !== 'finish' || only) console.log(`${m.n} s${seed} Einstieg ${entry.toFixed(0)} → ${out}\n   ${log.join(' | ')}`);
    else console.log(`${m.n} s${seed} Einstieg ${entry.toFixed(0)} ok`);
  }
}
