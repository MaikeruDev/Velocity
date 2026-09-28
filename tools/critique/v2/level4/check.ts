/**
 * Level 4 (Turm) — Bau + Prüfung des Prototyps mit den ECHTEN Projekt-Werkzeugen.
 *
 *   npx tsx tools/critique/v2/level4/check.ts [--fast]
 *
 * 1) buildLevel4() → shots/v2/level4/level4.json (inkl. gemessener Medaillen wie build.ts)
 * 2) validateLevel() aus tools/validate-levels.ts (statisch + Physik: Abschnitt × Bot,
 *    Voll-Läufe über 8 Seeds, Surf-Raster, Deko auf der Flugbahn)
 * 3) Spiel-Uhr-Mediane je Medaillen-Modell (physics.timedMedian)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile, LevelMedals } from '../../../../src/world/level/LevelFormat';
import { FULL_RUN_SEEDS, validateLevel } from '../../../validate-levels';
import { timedMedian, type StrafeModel } from '../../../levels/physics';
import { buildLevel4, level4Info } from './level4';

const OUT = 'shots/v2/level4';
mkdirSync(OUT, { recursive: true });
const fast = process.argv.includes('--fast');

const t0 = performance.now();
const raw = buildLevel4({ measure: !fast });
const info = level4Info();
console.log(`gebaut in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${raw.brushes.length} Brushes, ${raw.triggers.length} Trigger, ${raw.route?.length} Knoten; Krone y ${info.kroneTop}, Ziel y ${info.finTop}, Ziel-Lücke ${info.finLip} u (Launch-Band ${info.launchMin} u/s)`);

const MEDALS: Record<keyof LevelMedals, { model: StrafeModel; factor: number }> = {
  bronze: { model: { aimNoiseDeg: 3 }, factor: 1.05 },
  silver: { model: { aimNoiseDeg: 2 }, factor: 1.05 },
  gold: { model: { sync: 1 }, factor: 1.1 },
  velocity: { model: { sync: 1 }, factor: 1.05 },
  author: { model: { sync: 1 }, factor: 1 },
};
const up01 = (t: number): number => Number((Math.ceil(t * 10 - 1e-6) / 10).toFixed(1));

let level: LevelFile = raw;
const extra: Record<string, unknown> = {};
{
  const c = compileLevel(raw);
  const med = new Map<string, number | null>();
  const rows: string[] = [];
  const models: Array<[string, StrafeModel]> = [
    ['sync 1.0', { sync: 1 }],
    ['sync 0.8', { sync: 0.8 }],
    ['Hand 2°', { aimNoiseDeg: 2 }],
    ['Hand 3°', { aimNoiseDeg: 3 }],
    ['sync 0.7', { sync: 0.7 }],
  ];
  for (const [name, m] of models) {
    const t1 = performance.now();
    const r = timedMedian(c, m, FULL_RUN_SEEDS);
    med.set(JSON.stringify(m), r.median);
    const times = r.runs.map((x) => (x.time === null ? `✗(${x.reason})` : x.time.toFixed(2)));
    const deaths = r.runs.reduce((a, x) => a + x.deaths, 0);
    rows.push(`${name.padEnd(9)} Median ${r.median === null ? '—' : r.median.toFixed(2)} s · Tode ${deaths} · [${times.join(' ')}]  (${((performance.now() - t1) / 1000).toFixed(1)} s)`);
  }
  console.log('\nSpiel-Uhr (Median Seeds 1–8):');
  for (const l of rows) console.log(`  ${l}`);
  extra.timed = rows;
  const get = (m: StrafeModel): number | null => med.get(JSON.stringify(m)) ?? null;
  const t = (k: keyof LevelMedals): number => {
    const m = get(MEDALS[k].model);
    if (m === null) return NaN;
    return k === 'author' ? Number((Math.ceil(m * 100 - 1e-6) / 100).toFixed(2)) : up01(MEDALS[k].factor * m);
  };
  const medals: LevelMedals = { bronze: t('bronze'), silver: t('silver'), gold: t('gold'), velocity: t('velocity'), author: t('author') };
  console.log(`Medaillen: ${JSON.stringify(medals)}`);
  if (Object.values(medals).every((x) => Number.isFinite(x))) level = { ...raw, parTime: Math.ceil(medals.bronze), medals };
}
writeFileSync(`${OUT}/level4.json`, JSON.stringify(level));

if (!process.argv.includes('--novalidate')) {
  const t2 = performance.now();
  const r = validateLevel('level4.json', level);
  console.log(`\n${r.errors.length ? '✗' : '✓'} Validator (${((performance.now() - t2) / 1000).toFixed(1)} s)`);
  for (const l of r.info) console.log(`    ${l}`);
  for (const l of r.warnings) console.log(`  ! ${l}`);
  for (const l of r.errors) console.log(`  ✗ ${l}`);
  writeFileSync(`${OUT}/validate.txt`, [...r.info.map((l) => `    ${l}`), ...r.warnings.map((l) => `  ! ${l}`), ...r.errors.map((l) => `  ✗ ${l}`)].join('\n') + '\n');
}
