/**
 * Kritik-Linse LEVEL-FLOW — L2 Ring: Innenbahn statt Außenbahn (Route radial auf r 1152 gelegt).
 *   npx tsx tools/critique/level-flow/ring.ts
 */
import { readFileSync } from 'node:fs';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { runRoute } from '../../../src/player/bots';
import { compileLevel } from '../../../src/world/level/compileLevel';
import type { RouteNode } from '../../../src/world/level/LevelFormat';

const lv = compileLevel(JSON.parse(readFileSync('public/levels/level2.json', 'utf8')));
const route = lv.def.route ?? [];
for (const r of [1408, 1280, 1216, 1152]) {
  const alt: RouteNode[] = route.map((n, i) => {
    if (i < 7 || i > 14) return n;
    const [x, y, z] = n.pos;
    const r0 = Math.hypot(x, z);
    const k = r / r0;
    return { ...n, pos: [x * k, y - Math.tan((10 * Math.PI) / 180) * (r0 - r), z * k] as const };
  });
  const res: string[] = [];
  for (const m of [{ sync: 1 }, { aimNoiseDeg: 1 }, { aimNoiseDeg: 2 }]) {
    const ts: string[] = [];
    for (let seed = 1; seed <= 4; seed++) {
      const o = runRoute(lv, VELOCITY_DEFAULT, { ...m, seed, route: alt });
      ts.push(o.touchedFinish ? o.time.toFixed(1) : o.reason ?? o.status);
    }
    res.push(`${JSON.stringify(m)} ${ts.join(' ')}`);
  }
  console.log(`r ${r}: ${res.join(' | ')}`);
}
