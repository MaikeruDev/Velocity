/**
 * Zeit und Tempo in der Kehre je Linie (Bot ab Start): Zeit CP1 → CP2, Tempo bei CP1/CP2, Minimum dazwischen.
 *   PMFIX=retrace node --import tsx --import ./tools/critique/v2/level3/pmFix/hook.mjs tools/critique/v2/level3/kehreSplit.ts
 */
import { readFileSync } from 'node:fs';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../../src/world/level/LevelFormat';

for (const variant of ['fast', 'safe']) {
  const def = JSON.parse(readFileSync(`shots/v2/level3/level3-${variant}.json`, 'utf8')) as LevelFile;
  const lv = compileLevel(def);
  const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  for (const m of [{ sync: 1 }, { sync: 0.8 }, { aimNoiseDeg: 2 }, { aimNoiseDeg: 3 }]) {
    const pm = new PlayerMovement(lv.world, VELOCITY_DEFAULT);
    pm.teleport(lv.spawnPos);
    const bot = new RouteFollower(def.route ?? [], VELOCITY_DEFAULT, { ...m, seed: 1, killY: def.killY, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z } });
    let t1 = -1;
    let t2 = -1;
    let v1 = 0;
    let v2 = 0;
    let vmin = Infinity;
    let vmax = 0;
    let air = 0;
    for (let t = 0; t < 128 * 60 && t2 < 0 && bot.status === 'running'; t++) {
      pm.tick(bot.next(pm.state, pm.surfNormal));
      const s = pm.state;
      if (t1 < 0 && cps[0].bounds.containsPoint(s.pos)) [t1, v1] = [t / 128, s.speed];
      if (t1 >= 0 && t2 < 0) {
        vmin = Math.min(vmin, s.speed);
        vmax = Math.max(vmax, s.speed);
        if (!s.onGround && !s.surfing) air++;
      }
      if (t1 >= 0 && cps[1].bounds.containsPoint(s.pos)) [t2, v2] = [t / 128, s.speed];
    }
    console.log(`${variant.padEnd(5)} ${JSON.stringify(m).padEnd(20)} Kehre ${(t2 - t1).toFixed(2)} s, Tempo CP1 ${v1.toFixed(0)} → CP2 ${v2.toFixed(0)} (min ${vmin.toFixed(0)}, max ${vmax.toFixed(0)}), frei in der Luft ${(air / 128).toFixed(2)} s`);
  }
}
