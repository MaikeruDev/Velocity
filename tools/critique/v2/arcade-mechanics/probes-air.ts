/**
 * Luftkontrolle gegen die Design-Proben: welche Variante hält die S0-Auffangprobe (L2) und die L1-Proben grün?
 *   npx tsx tools/critique/v2/arcade-mechanics/probes-air.ts
 */
import { writeFileSync } from 'node:fs';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { readLevelFile } from '../../../sim/levels';
import { designProbes } from '../../../levels/designProbes';
import { AIR_DEFAULT, installGlobal, type AirControlOpts } from './ArcadeMovement';

const cfg = VELOCITY_DEFAULT;
const levels = ['level1', 'level2'].map((id) => compileLevel(readLevelFile(`public/levels/${id}.json`)));
const base = new Map(levels.map((lv) => [lv.def.id, designProbes(lv, cfg)]));
const variants: Array<[string, AirControlOpts]> = [
  ['1.6→0.8, Surf-Pause 0', AIR_DEFAULT],
  ['1.6→0.8, Surf-Pause 0.5 s', { ...AIR_DEFAULT, surfGrace: 0.5 }],
  ['1.6→0.8, Surf-Pause 1.0 s', { ...AIR_DEFAULT, surfGrace: 1.0 }],
  ['1.0→0.5, Surf-Pause 0.5 s', { rate: 1.0, rateHigh: 0.5, fadeFrom: 350, fadeTo: 700, surfGrace: 0.5 }],
];
const out: unknown[] = [];
for (const [name, air] of variants) {
  const undo = installGlobal({ air });
  try {
    for (const lv of levels) {
      const r = designProbes(lv, cfg);
      const b = base.get(lv.def.id);
      const fresh = [...r.errors, ...r.warnings].filter((e) => !(b ? [...b.errors, ...b.warnings] : []).includes(e));
      out.push({ name, level: lv.def.id, fresh });
      console.log(`- ${name.padEnd(28)} ${lv.def.id}: neu ${fresh.length}${fresh.length ? ` — ${fresh.join(' | ')}` : ''}`);
    }
  } finally {
    undo();
  }
}
writeFileSync('shots/v2/arcade-mechanics/probes-air.json', JSON.stringify(out, null, 2));
