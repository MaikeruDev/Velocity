/**
 * Validator-Gegenprobe: designProbes (L1/L2) und Spiel-Uhr-Läufe mit global installierten Mechaniken.
 *   npx tsx tools/critique/v2/arcade-mechanics/probes.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { readLevelFile } from '../../../sim/levels';
import { designProbes } from '../../../levels/designProbes';
import { timedMedian } from '../../../levels/physics';
import { AIR_DEFAULT, LEDGE_DEFAULT, SLIDE_DEFAULT, installGlobal, type ArcadeOpts } from './ArcadeMovement';

const OUT = 'shots/v2/arcade-mechanics';
mkdirSync(OUT, { recursive: true });
const cfg = VELOCITY_DEFAULT;
const levels = ['level1', 'level2'].map((id) => compileLevel(readLevelFile(`public/levels/${id}.json`)));
const variants: Array<[string, ArcadeOpts | null]> = [
  ['Original', null],
  ['Slide', { slide: SLIDE_DEFAULT }],
  ['Kanten-Assist', { ledge: LEDGE_DEFAULT }],
  ['Luftkontrolle', { air: AIR_DEFAULT }],
  ['Alle drei', { slide: SLIDE_DEFAULT, ledge: LEDGE_DEFAULT, air: AIR_DEFAULT }],
];
const out: unknown[] = [];
const baseErr = new Map<string, string[]>();
const f = (v: number | null): string => (v === null ? '–' : v.toFixed(2));
for (const [name, opts] of variants) {
  const undo = opts ? installGlobal(opts) : () => undefined;
  try {
    for (const lv of levels) {
      const r = designProbes(lv, cfg);
      const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
      const med = {
        velocity: timedMedian(lv, { sync: 1 }, seeds, cfg).median,
        silver: timedMedian(lv, { aimNoiseDeg: 2 }, seeds, cfg).median,
        bronze: timedMedian(lv, { aimNoiseDeg: 3 }, seeds, cfg).median,
      };
      const key = lv.def.id;
      if (!opts) baseErr.set(key, [...r.errors, ...r.warnings]);
      const base = baseErr.get(key) ?? [];
      const fresh = [...r.errors, ...r.warnings].filter((e) => !base.includes(e));
      out.push({ name, level: key, errors: r.errors, warnings: r.warnings, fresh, med });
      console.log(`- ${name.padEnd(14)} ${key}: Fehler ${r.errors.length}, Warnungen ${r.warnings.length}, neu ${fresh.length} · Median sync1 ${f(med.velocity)} s · 2° ${f(med.silver)} s · 3° ${f(med.bronze)} s`);
      for (const e of fresh) console.log(`    NEU: ${e}`);
    }
  } finally {
    undo();
  }
}
writeFileSync(`${OUT}/probes.json`, JSON.stringify(out, null, 2));
console.log(`\n→ ${OUT}/probes.json`);
