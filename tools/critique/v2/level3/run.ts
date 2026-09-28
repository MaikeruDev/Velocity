/**
 * Level-3-Prototyp bauen und messen wie levels:build + levels:check — für BEIDE Linien.
 *   PMFIX=retrace node --import tsx --import ./tools/critique/v2/level3/pmFix/hook.mjs tools/critique/v2/level3/run.ts [--quick] [--json k=v,...]
 *   (ohne Hook = heutige Engine ohne Rampbug-Fix)
 *
 * 1. Tempo-Band an den Surf-Knoten (physics.measureSurfSpeeds, Surfer 0°/2° + 3°-Hand + Surf-Raster)
 *    → minSpeed (90 % des Langsamsten), unteres Band am Launch → Strand-Lücke (zweiter Bau).
 * 2. validateLevel (statisch + Physik: Bots, Respawns, Surf-Raster, Deko auf der Flugbahn).
 * 3. Medaillen mit Spiel-Uhr: Bronze/Silber auf der sicheren Linie, Gold/VELOCITY/Autor auf der
 *    schnellen; Gegenproben (perfekter Bot sicher, Hände schnell).
 * Ausgaben: shots/v2/level3/run-<tag>.txt, level3-fast.json, level3-safe.json.
 */
import { writeFileSync } from 'node:fs';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile, RouteNode } from '../../../../src/world/level/LevelFormat';
import { FULL_RUN_SEEDS, validateLevel } from '../../../validate-levels';
import { measureSurfSpeeds, SURF_GRID, timedMedian, type StrafeModel } from '../../../levels/physics';
import { buildLevel3, DEFAULT_L3, type L3Params } from './level3';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const patch: Record<string, number> = {};
const ji = args.indexOf('--json');
if (ji >= 0) for (const kv of (args[ji + 1] ?? '').split(',')) if (kv) patch[kv.split('=')[0]] = Number(kv.split('=')[1]);
const tag = `${process.env.PMFIX && process.env.PMFIX !== '0' ? 'fix' : 'nofix'}${Object.keys(patch).length ? `-${Object.entries(patch).map(([k, v]) => `${k}${v}`).join('_')}` : ''}`;
const out: string[] = [];
const log = (s: string): void => {
  out.push(s);
  console.log(s);
};

function withSpeeds(def: LevelFile): { def: LevelFile; launchLow: number; slowest: string } {
  const measured = measureSurfSpeeds(def, [{ surfer: 0 }, { surfer: 2 }, { bot: { aimNoiseDeg: 3 } }], { grid: SURF_GRID });
  const route: RouteNode[] = (def.route ?? []).map((n, i) => (n.surf && Number.isFinite(measured[i]) ? { ...n, minSpeed: Math.round(0.9 * measured[i]) } : n));
  const missing = (def.route ?? []).map((n, i) => (n.surf && !Number.isFinite(measured[i]) ? i : -1)).filter((i) => i >= 0);
  const li = route.findIndex((n) => n.note === 'Launch');
  const launchLow = li >= 0 ? route[li].minSpeed ?? 0 : 0;
  return { def: { ...def, route }, launchLow, slowest: missing.length ? `nicht erreicht: Knoten ${missing.join(',')}` : '' };
}

const strPatch: Record<string, string> = {};
const si = args.indexOf('--str');
if (si >= 0) for (const kv of (args[si + 1] ?? '').split(',')) if (kv) strPatch[kv.split('=')[0]] = kv.split('=')[1];
const params: L3Params = { ...DEFAULT_L3, ...patch, ...(strPatch as Partial<L3Params>) };
let b = buildLevel3(params);
for (const n of b.notes) log(`  ${n}`);
// Zweiter Bau: Strand-Lücke aus dem gemessenen unteren Band am Launch (minimum beider Linien).
const f1 = withSpeeds(b.fast);
const s1 = withSpeeds(b.safe);
const low = Math.min(f1.launchLow, s1.launchLow);
log(`Tempo-Band Launch: schnell ${f1.launchLow} u/s, sicher ${s1.launchLow} u/s (90 % des Langsamsten) ${f1.slowest} ${s1.slowest}`);
if (low > 0) {
  // 5 % Luft: der zweite Bau verschiebt das gemessene Band leicht (Knoten, Kill-Kacheln).
  b = buildLevel3({ ...params, launchLow: Math.round(low * 0.95) });
  log(`  ${b.notes.find((n) => n.startsWith('Strand')) ?? ''}`);
}
const fast = withSpeeds(b.fast).def;
const safe = withSpeeds(b.safe).def;
writeFileSync('shots/v2/level3/level3-fast.json', JSON.stringify(fast));
writeFileSync('shots/v2/level3/level3-safe.json', JSON.stringify(safe));

for (const [name, def] of [['SCHNELLE Linie (route)', fast], ['SICHERE Linie (safeRoute)', safe]] as const) {
  const t0 = performance.now();
  const r = validateLevel(`level3 ${name}`, def, { physics: !quick });
  log(`\n${r.errors.length ? '✗' : '✓'} ${name} (${((performance.now() - t0) / 1000).toFixed(1)} s): ${r.errors.length} Fehler, ${r.warnings.length} Warnungen`);
  for (const l of r.info) log(`    ${l}`);
  for (const l of r.warnings) log(`  ! ${l}`);
  for (const l of r.errors) log(`  ✗ ${l}`);
}

if (!quick) {
  const cf = compileLevel(fast);
  const cs = compileLevel(safe);
  const med = (c: typeof cf, m: StrafeModel): string => {
    const r = timedMedian(c, m, FULL_RUN_SEEDS);
    return `${r.median?.toFixed(2) ?? '–'} s [${r.runs.map((x) => (x.time === null ? 'x' : x.time.toFixed(1))).join(' ')}] Tode ${r.runs.reduce((a, x) => a + x.deaths, 0)}`;
  };
  log('\nSpiel-Uhr (Median Seeds 1–8):');
  for (const m of [{ sync: 1 }, { sync: 0.8 }, { aimNoiseDeg: 1 }, { aimNoiseDeg: 2 }, { aimNoiseDeg: 3 }] as StrafeModel[]) {
    log(`  ${JSON.stringify(m).padEnd(20)} schnell ${med(cf, m)}   |   sicher ${med(cs, m)}`);
  }
}
writeFileSync(`shots/v2/level3/run-${tag}.txt`, `${out.join('\n')}\n`);
