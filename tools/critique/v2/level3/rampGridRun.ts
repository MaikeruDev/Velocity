/**
 * Surf-Raster des Validators, aber mit RampRider (Blick entlang der Rampe unter dem Fahrer statt entlang des
 * Routen-Segments) — Vorschlag für physics.SurfRider. Gleiches Raster, gleiche Startpunkte, gleiches Ziel.
 *   PMFIX=retrace node --import tsx --import ./tools/critique/v2/level3/pmFix/hook.mjs tools/critique/v2/level3/rampGridRun.ts [datei.json …]
 * Ohne Argumente: Level-3-Prototyp (beide Linien) und zur Gegenprobe public/levels/level1.json, level2.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../../src/world/level/LevelFormat';
import { SURF_GRID, flankTag, reachedOrder, routeAxis, surfSectionStarts } from '../../../levels/physics';
import { rampGrid } from './gridLocal';

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['shots/v2/level3/level3-safe.json', 'shots/v2/level3/level3-fast.json', 'public/levels/level1.json', 'public/levels/level2.json'];
const out: string[] = [];
for (const f of files) {
  const def = JSON.parse(readFileSync(f, 'utf8')) as LevelFile;
  const lv = compileLevel(def);
  const route = def.route ?? [];
  const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const fin = lv.triggers.find((t) => t.kind === 'finish');
  const axis = routeAxis(route);
  for (const i of surfSectionStarts(lv.world, route)) {
    const n = route[i];
    const next = route[i + 1];
    if (!next) continue;
    const goal = cps.find((t) => t.order > reachedOrder(route, i, cps)) ?? fin;
    if (!goal) continue;
    const p = new Vector3(...n.pos);
    const dir = new Vector3(next.pos[0] - p.x, 0, next.pos[2] - p.z).normalize();
    const g = rampGrid(lv, p, dir, goal.bounds, axis, SURF_GRID);
    const fails = g.fails.slice(0, 3).map((x) => `${x.speed}/${x.lateral}/${x.look}° ${x.out.reason}`);
    const line = `${f.split('/').pop()} ${flankTag(lv, n)} → ${goal.kind === 'finish' ? 'Ziel' : `CP${goal.order}`}: ${g.runs - g.fails.length}/${g.runs}, ${g.seams} Nähte${fails.length ? ` — ${fails.join('; ')}` : ''}`;
    out.push(line);
    console.log(line);
  }
}
writeFileSync(`shots/v2/level3/rampGrid${process.env.PMFIX && process.env.PMFIX !== '0' ? '-fix' : ''}.txt`, `${out.join('\n')}\n`);
