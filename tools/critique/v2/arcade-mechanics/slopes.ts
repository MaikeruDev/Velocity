/** Begehbare Schrägen in L1/L2 (0.7 ≤ n.y < 0.995): wo könnte Rutschen Tempo bringen? npx tsx tools/critique/v2/arcade-mechanics/slopes.ts */
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { readLevelFile } from '../../../sim/levels';

for (const id of ['level1', 'level2']) {
  const lv = compileLevel(readLevelFile(`public/levels/${id}.json`));
  const rows: string[] = [];
  for (const b of lv.brushes) {
    if (!b.collide) continue;
    for (const f of b.faces) {
      const ny = f.normal.y;
      if (ny < 0.7 || ny >= 0.995) continue;
      const deg = (Math.acos(ny) * 180) / Math.PI;
      const ys = f.vertices.map((v) => v.y);
      const drop = Math.max(...ys) - Math.min(...ys);
      // Hangabtrieb horizontal g·sinθ·cosθ gegen Rutsch-Verzögerung 0.3·v + 80: Gleichgewichtstempo.
      const acc = 800 * Math.sin((deg * Math.PI) / 180) * ny;
      const vEq = (acc - 80) / 0.3;
      rows.push(`${(b.tag ?? `#${b.index}`).padEnd(18)} ${deg.toFixed(1).padStart(5)}°  Fall ${drop.toFixed(0).padStart(5)} u  Rutsch-Gleichgewicht ${vEq > 0 ? vEq.toFixed(0) : '–'} u/s`);
    }
  }
  console.log(`== ${id}: ${rows.length} begehbare Schrägen\n${rows.join('\n')}`);
}
