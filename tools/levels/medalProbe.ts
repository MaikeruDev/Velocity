/**
 * Medaillen-Probe: Spiel-Uhr-Median mehrerer Bot-Modelle je Level (Grundlage für die
 * VELOCITY-Medaille, level-design.md Regel 10). `npx tsx tools/levels/medalProbe.ts`
 */
import { compileLevel } from '../../src/world/level/compileLevel';
import { FULL_RUN_SEEDS } from '../validate-levels';
import { buildLevel1 } from './level1';
import { buildLevel2 } from './level2';
import { timedMedian, type StrafeModel } from './physics';

const MODELS: readonly StrafeModel[] = [{ sync: 1 }, { sync: 0.95 }, { sync: 0.9 }, { aimNoiseDeg: 0.5 }, { aimNoiseDeg: 1 }, { aimNoiseDeg: 1.5 }, { aimNoiseDeg: 2 }];

for (const lv of [buildLevel1(), buildLevel2()]) {
  const c = compileLevel(lv);
  for (const m of MODELS) {
    const r = timedMedian(c, m, FULL_RUN_SEEDS);
    const all = r.runs.map((x) => (x.time === null ? 'x' : x.time.toFixed(2))).join(' ');
    console.log(`${lv.id} ${JSON.stringify(m)}: Median ${r.median?.toFixed(2) ?? '–'} s  [${all}]`);
  }
}
