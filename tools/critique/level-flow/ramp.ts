/**
 * Kritik-Linse LEVEL-FLOW — Treppe vs. Rampe zum CP1-Plateau (L1) im Bhop-Tempo.
 *   npx tsx tools/critique/level-flow/ramp.ts
 */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../src/player/bots';
import { compileLevel } from '../../../src/world/level/compileLevel';

const cfg = VELOCITY_DEFAULT;
const lv = compileLevel(JSON.parse(readFileSync('public/levels/level1.json', 'utf8')));
for (const x of [-96, 96]) {
  for (const v0 of [320, 450, 550]) {
    for (const z0 of [-900, -950, -1000, -1050]) {
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(new Vector3(x, 1, z0));
      pm.state.vel.set(0, 0, -v0);
      const bot = new StrafeBot(cfg, { sync: 1, seed: 1, heading: 0 });
      let minSp = Infinity;
      let out = '';
      for (let k = 0; k < 128 * 4; k++) {
        pm.tick(bot.next(pm.state));
        const s = pm.state;
        if (s.pos.z < -1100 && s.pos.z > -1560) minSp = Math.min(minSp, s.speed);
        if (s.pos.z < -1560 && s.pos.y > 100) {
          out = `Plateau erreicht mit ${s.speed.toFixed(0)} u/s nach ${(k / 128).toFixed(2)} s, min unterwegs ${minSp.toFixed(0)}`;
          break;
        }
        if (s.pos.y < -100) {
          out = 'gefallen';
          break;
        }
      }
      console.log(`${x < 0 ? 'Treppe' : 'Rampe '} Start ${v0} u/s z0 ${z0}: ${out || 'nicht erreicht'}`);
    }
  }
}
