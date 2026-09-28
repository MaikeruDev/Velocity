/** Debug: Surf-Lektion — W+D gegen reines D, wo reißt das Halten? (npx tsx … dbg_t7.ts none) */
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { lessonSurf } from './lessons';
import { LessonRun } from './trainingProto';
import { SurfHand } from './validate';

const CFG = VELOCITY_DEFAULT;
const L = lessonSurf(3);
const lv = compileLevel(L.level);
for (const mode of ['grund', 'wa'] as const) {
  for (const seed of [1, 2, 3]) {
    const pm = new PlayerMovement(lv.world, CFG);
    pm.teleport(lv.spawnPos);
    const run = new LessonRun(L.stages, L.zones);
    const hand = new SurfHand(seed, mode, 3, 0.3);
    const prev = PlayerMovement.createSnapshot();
    const cur = PlayerMovement.createSnapshot();
    let ground = 0;
    let off = 0;
    let lastSurf = false;
    const ev: string[] = [];
    for (let i = 0; i < 20 * 128; i++) {
      const cmd = hand.next(pm.state, run, pm);
      pm.copySnapshot(prev);
      pm.tick(cmd);
      pm.copySnapshot(cur);
      run.tick(1 / 128, prev, cur, cmd, 72);
      if (cur.onGround && i > 400) ground++;
      if (lastSurf && !cur.surfing) { off++; if (ev.length < 4) ev.push(`${(i / 128).toFixed(2)}s off: y ${cur.pos.y.toFixed(0)} x ${cur.pos.x.toFixed(0)} v ${cur.speed.toFixed(0)} g ${cur.onGround} n ${pm.surfNormal.x.toFixed(2)}`); }
      lastSurf = cur.surfing;
    }
    console.log(mode, seed, 'stage', run.progress.stage, 'groundTicks', ground, 'surf-exits', off, ev.join(' | '));
  }
}
