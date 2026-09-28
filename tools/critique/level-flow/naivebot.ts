/** NaiveBot (Projekt-Bot) aus dem Stand am Spawn von L1/L2: Tempo nach 1/3/5 s. npx tsx tools/critique/level-flow/naivebot.ts */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { NaiveBot } from '../../../src/player/bots';
import { compileLevel } from '../../../src/world/level/compileLevel';
for (const id of ['level1', 'level2']) {
  const lv = compileLevel(JSON.parse(readFileSync(`public/levels/${id}.json`, 'utf8')));
  for (const sprint of [false, true]) {
    const pm = new PlayerMovement(lv.world, VELOCITY_DEFAULT);
    pm.teleport(new Vector3(lv.spawnPos.x, lv.spawnPos.y + 1, lv.spawnPos.z));
    const bot = new NaiveBot(VELOCITY_DEFAULT, { heading: (lv.spawnYaw * Math.PI) / 180, sprint });
    const out: string[] = [];
    const p0 = pm.state.pos.clone();
    for (let k = 1; k <= 128 * 5; k++) {
      pm.tick(bot.next(pm.state));
      if (k % 128 === 0) out.push(`${k / 128}s ${pm.state.speed.toFixed(0)} u/s (${pm.state.pos.distanceTo(p0).toFixed(0)} u)`);
    }
    console.log(`${id} NaiveBot${sprint ? '+Sprint' : ''}: ${out.join(', ')}`);
  }
}
