/**
 * Level 4 — nur das Surf-Raster des Validators (physics.surfGrid mit SURF_GRID) für
 * Parameter-Sweeps der Abfahrt: L4_D1/L4_S2/L4_N1 … über die Umgebung setzen.
 *   npx tsx tools/critique/v2/level4/grid.ts
 */
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { surfGrid, SURF_GRID, respawnSurf } from '../../../levels/physics';
import { buildLevel4 } from './level4';

const def = buildLevel4({ measure: process.env.L4_MEASURE !== '0' });
const lv = compileLevel(def);
const res = surfGrid(lv, SURF_GRID);
const fails = res.reduce((a, r) => a + r.failures.length, 0);
const runs = res.reduce((a, r) => a + r.runs, 0);
const cps = lv.triggers.filter((t) => t.kind === 'checkpoint' && t.order >= 4);
const stand = cps.flatMap((cp) => [0, 2].map((look) => respawnSurf(lv, cp, (look * Math.PI) / 180)));
console.log(`${process.env.L4_TAG ?? ''} Raster ${runs - fails}/${runs} ${res.map((r) => `${r.note}:${r.runs - r.failures.length}/${r.runs}`).join(' ')} · aus dem Stand ${stand.filter((s) => s.ok).length}/${stand.length}`);
