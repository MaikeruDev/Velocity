/**
 * Medaillen-Probe: Spiel-Uhr-Median mehrerer Bot-Modelle je Level (Grundlage für die
 * VELOCITY-Medaille, level-design.md Regel 10). `npx tsx tools/levels/medalProbe.ts [id …]`
 *
 * Alle Level der build.ts-Registry (Stubs werden übersprungen); bei einer Gabel beide Linien.
 * Der perfekte Bot zusätzlich als Median über die Start-Jitter — so misst build.ts Gold/VELOCITY/Autor —,
 * samt Zweigen (physics.jitterBranches), wenn die Läufe in zwei Gruppen zerfallen.
 */
import { compileLevel } from '../../src/world/level/compileLevel';
import { FULL_RUN_SEEDS } from '../validate-levels';
import { LEVELS } from './build';
import { describeBranches, jitterMedian, timedMedian, withRoute, type StrafeModel } from './physics';

const MODELS: readonly StrafeModel[] = [{ sync: 1 }, { sync: 0.95 }, { sync: 0.9 }, { aimNoiseDeg: 0.5 }, { aimNoiseDeg: 1 }, { aimNoiseDeg: 1.5 }, { aimNoiseDeg: 2 }];
const only = process.argv.slice(2);

for (const e of LEVELS) {
  if (only.length && !only.includes(e.id)) continue;
  const lv = e.build();
  if (!lv) {
    console.log(`${e.id}: noch kein Builder (Stub)`);
    continue;
  }
  const c = compileLevel(lv);
  for (const [line, level] of lv.safeRoute ? ([['route', c], ['safeRoute', withRoute(c, 'safeRoute')]] as const) : ([['', c]] as const)) {
    const tag = line ? ` [${line}]` : '';
    for (const m of MODELS) {
      const r = timedMedian(level, m, FULL_RUN_SEEDS);
      const all = r.runs.map((x) => (x.time === null ? 'x' : x.time.toFixed(2))).join(' ');
      console.log(`${lv.id}${tag} ${JSON.stringify(m)}: Median ${r.median?.toFixed(2) ?? '–'} s  [${all}]`);
    }
    const j = jitterMedian(level, { sync: 1 });
    console.log(`${lv.id}${tag} {"sync":1} über ${j.runs.length} Start-Jitter: Median ${j.median?.toFixed(2) ?? '–'} s  [${j.runs.map((x) => (x.time === null ? 'x' : x.time.toFixed(2))).join(' ')}]`);
    if (j.branches) console.log(`${lv.id}${tag}   ! zwei Zweige: ${describeBranches(j.branches)}`);
  }
}
