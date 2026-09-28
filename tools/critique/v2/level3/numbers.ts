/** Kennzahlen des Prototyps für den Entwurf (Höhen, Längen, Radien). npx tsx tools/critique/v2/level3/numbers.ts */
import { buildLevel3, DEFAULT_L3 } from './level3';

const b = buildLevel3(DEFAULT_L3);
const P = b.paths;
const f = (n: number): string => n.toFixed(0);
for (const [k, p] of Object.entries(P)) {
  const s = p.at(0);
  const e = p.end;
  console.log(`${k.padEnd(10)} ${p.half.padEnd(5)} B ${p.o.width} ${p.flankDeg}° H ${f(p.height)} | Länge ${f(p.length)} | Grat ${f(s.apex)} → ${f(e.apex)} | Start (${f(s.x)}, ${f(s.z)}) yaw ${s.yaw.toFixed(1)} → Ende (${f(e.x)}, ${f(e.z)}) yaw ${e.yaw.toFixed(1)} | Stücke ${p.pieces.length}`);
}
for (const n of b.notes) console.log(n);
const cps = b.fast.triggers.filter((t) => t.kind === 'checkpoint');
for (const c of cps) console.log(`${c.tag}: Spawn ${c.spawn?.pos.map(f).join(', ')} yaw ${c.spawn?.yaw} | Trigger ${c.min.map(f).join(',')} … ${c.max.map(f).join(',')}`);
console.log(`Kill-Zonen ${b.fast.triggers.filter((t) => t.kind === 'kill').length}, Brushes ${b.fast.brushes.length} (Kollision ${b.fast.brushes.filter((x) => x.collide !== false).length})`);
