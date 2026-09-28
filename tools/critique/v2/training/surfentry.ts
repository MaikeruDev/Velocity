/**
 * Trainingsmodus-Entwurf (v2/training) — Surf-Einstieg: wie viel Reaktionszeit bekommt ein Neuling?
 *   npx tsx tools/critique/v2/training/surfentry.ts none
 * Raster Einstiegstiefe (unter dem First) × Drop × Reaktionszeit × Blickfehler; Grundtechnik-Hand
 * (A/D in die Rampe ab `react` s nach dem ersten Kontakt). Kennzahl: Anteil der 20 Seeds, die 3 s
 * am Stück surfen (LessonRun surfHold), und Zeit bis zum Fuß ohne Eingabe.
 */
import { writeFileSync } from 'node:fs';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { lessonSurf } from './lessons';
import { LessonRun } from './trainingProto';
import { SurfHand } from './validate';

const rows: string[] = [];
const out: unknown[] = [];
for (const depth of [120, 240, 360]) {
  for (const drop of [40, 100]) {
    process.env.ENTRY_DEPTH = String(depth);
    process.env.DROP = String(drop);
    const L = lessonSurf(3);
    const lv = compileLevel(L.level);
    const cells: string[] = [];
    for (const react of [0.3, 0.45, 0.6, 0.8, 1.0]) {
      for (const noise of [3, 6]) {
        let ok = 0;
        for (let seed = 1; seed <= 20; seed++) {
          const pm = new PlayerMovement(lv.world, VELOCITY_DEFAULT);
          pm.teleport(lv.spawnPos);
          const run = new LessonRun([L.stages[0]], []);
          const hand = new SurfHand(seed, 'grund', noise, react);
          const prev = PlayerMovement.createSnapshot();
          const cur = PlayerMovement.createSnapshot();
          for (let i = 0; i < 12 * 128 && !run.progress.done; i++) {
            const cmd = hand.next(pm.state, run, pm);
            pm.copySnapshot(prev);
            pm.tick(cmd);
            pm.copySnapshot(cur);
            run.tick(1 / 128, prev, cur, cmd, 72);
          }
          if (run.progress.done) ok++;
        }
        cells.push(`${react}s/${noise}°: ${ok}`);
        out.push({ depth, drop, react, noise, ok });
      }
    }
    rows.push(`Tiefe ${depth} Drop ${drop}: ${cells.join(' · ')}`);
  }
}
console.log(rows.join('\n'));
writeFileSync('shots/v2/training/surfentry.json', JSON.stringify(out, null, 1));
