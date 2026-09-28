/**
 * Inventar begehbarer Schrägen (0.7 ≤ n.y < 0.999) in den Leveln: Winkel, Fläche, Tag.
 * npx tsx tools/critique/v2/momentum/slopes.ts
 */
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { readLevelFile } from '../../../sim/levels';

for (const id of ['level1', 'level2']) {
  const lv = compileLevel(readLevelFile(`public/levels/${id}.json`));
  const agg = new Map<string, { area: number; n: number }>();
  for (const b of lv.brushes) {
    if (!b.collide) continue;
    for (const face of b.faces) {
      if (!face.walkable || face.normal.y > 0.999) continue;
      const deg = Math.round((Math.acos(face.normal.y) * 180) / Math.PI);
      const v = face.vertices;
      let area = 0;
      for (let i = 1; i + 1 < v.length; i++) area += v[i].clone().sub(v[0]).cross(v[i + 1].clone().sub(v[0])).length() / 2;
      const tag = (b.tag ?? '?').replace(/[0-9.]+$/, '');
      const key = `${deg}°  ${tag}`;
      const a = agg.get(key) ?? { area: 0, n: 0 };
      a.area += area;
      a.n++;
      agg.set(key, a);
    }
  }
  console.log(`\n${id}: begehbare Schrägen (Winkel, Tag, Anzahl Flächen, Fläche in 1000 u²)`);
  for (const [k, a] of [...agg.entries()].sort((x, y) => y[1].area - x[1].area)) console.log(`  ${k.padEnd(28)} ${String(a.n).padStart(3)}  ${(a.area / 1000).toFixed(0).padStart(6)}`);
}
