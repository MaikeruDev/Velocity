/**
 * Level-Neubau IM SPEICHER gegen eine Movement-Variante (schreibt nichts nach public/levels):
 * buildLevel1/2 mit der (per Patch/MOM_CFG veränderten) Physik, dann Voll-Läufe (8 Seeds, 5 Modelle),
 * Spiel-Uhr-Median (Medaillen-Basis) und die Design-Proben. Vergleichbar mit levels:check.
 *
 *   npx tsx --import ./tools/critique/v2/momentum/patch.ts tools/critique/v2/momentum/rebuild-check.ts
 *   MOM_CFG='{"airSpeedCapLow":40}' npx tsx --import ./tools/critique/v2/momentum/patch.ts tools/critique/v2/momentum/rebuild-check.ts
 */
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { buildLevel1 } from '../../../levels/level1';
import { buildLevel2 } from '../../../levels/level2';
import { designProbes } from '../../../levels/designProbes';
import { timedMedian, type StrafeModel } from '../../../levels/physics';
import { fullRuns } from '../../../validate-levels';
import { f } from './common';

const MODELS: Array<[string, StrafeModel]> = [
  ['sync 1.0', { sync: 1 }],
  ['sync 0.8', { sync: 0.8 }],
  ['Hand 2°', { aimNoiseDeg: 2 }],
  ['Hand 3°', { aimNoiseDeg: 3 }],
  ['sync 0.7', { sync: 0.7 }],
];

console.log(`Physik: airSpeedCapLow ${VELOCITY_DEFAULT.airSpeedCapLow}, FadeFrom ${VELOCITY_DEFAULT.airSpeedCapFadeFrom}, FadeTo ${VELOCITY_DEFAULT.airSpeedCapFadeTo}, MOM=${process.env.MOM ?? ''}`);
for (const [id, build] of [['level1', buildLevel1], ['level2', buildLevel2]] as const) {
  const def = build();
  const lv = compileLevel(def);
  console.log(`\n### ${id} (neu gebaut, ${def.brushes.length} Brushes)`);
  for (const [name, m] of MODELS) {
    const r = fullRuns(lv, m);
    console.log(`  Voll-Lauf ${name.padEnd(8)}: ${r.ok}/${r.runs} im Ziel, Median ${f(r.median ?? NaN, 1)} s, max ${f(r.maxSpeed)} u/s${r.failures.length ? ` — ${r.failures[0]}` : ''}`);
  }
  const clock = [['3°-Hand (Bronze÷1.05)', { aimNoiseDeg: 3 }], ['sync 1.0 (Autor)', { sync: 1 }]] as const;
  for (const [name, m] of clock) {
    const t = timedMedian(lv, m, [1, 2, 3, 4, 5, 6, 7, 8]);
    console.log(`  Spiel-Uhr ${name}: ${f(t.median ?? NaN, 2)} s`);
  }
  const d = designProbes(lv);
  for (const e of d.errors) console.log(`  ✗ ${e}`);
  for (const w of d.warnings) console.log(`  ! ${w}`);
  console.log(`  Design: ${d.errors.length} Fehler, ${d.warnings.length} Warnungen, ${d.info.length} ok`);
}
