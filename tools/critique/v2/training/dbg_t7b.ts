/** Debug: Surf-Einstieg mittig — Verlauf 2.2–3.4 s (npx tsx … dbg_t7b.ts none). */
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { lessonSurf } from './lessons';
import { LessonRun } from './trainingProto';
import { SurfHand } from './validate';

const L = lessonSurf(3);
const lv = compileLevel(L.level);
const pm = new PlayerMovement(lv.world, VELOCITY_DEFAULT);
pm.teleport(lv.spawnPos);
const run = new LessonRun(L.stages, L.zones);
const hand = new SurfHand(1, 'grund', 3, 0.3);
for (let i = 0; i < 3.6 * 128; i++) {
  const cmd = hand.next(pm.state, run, pm);
  pm.tick(cmd);
  const s = pm.state;
  if (i > 2.0 * 128 && i % 4 === 0) console.log((i / 128).toFixed(2), 'pos', s.pos.x.toFixed(0), s.pos.y.toFixed(0), s.pos.z.toFixed(0), 'vel', s.vel.x.toFixed(0), s.vel.y.toFixed(0), s.vel.z.toFixed(0), 'g', s.onGround, 'surf', s.surfing, 'n', pm.surfNormal.x.toFixed(2), 'in', cmd.side, cmd.forward);
}
