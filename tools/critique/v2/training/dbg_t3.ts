/** Debug: Arena-Stufe "rechts" — Hop-Urteile und Wandkontakte einer Hand über die Zeit. */
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { HANDS, HumanHand } from './hands';
import { lessonArena } from './lessons';
import { LessonRun } from './trainingProto';

const CFG = VELOCITY_DEFAULT;
const DT = 1 / CFG.tickRate;
const L = lessonArena();
const lv = compileLevel(L.level);
const seed = Number(process.argv[2] ?? 3);
const pm = new PlayerMovement(lv.world, CFG);
pm.teleport(lv.spawnPos);
const run = new LessonRun(L.stages, L.zones);
let hand = new HumanHand(CFG, { ...HANDS.anfaenger, pattern: 'circle' }, seed, null, 0);
hand.side = 1;
let stage = 0;
let t = 0;
let walls = 0;
const log: string[] = [];
run.judge.onHop = ((o) => (r) => {
  log.push(`${t.toFixed(1)}s st${run.progress.stage} ${r.verdict} gain ${r.gain.toFixed(1)} v0 ${r.takeoffSpeed.toFixed(0)} side ${r.side} rate ${r.turnRate.toFixed(0)} share ${r.sideShare.toFixed(2)} pos ${pm.state.pos.x.toFixed(0)},${pm.state.pos.z.toFixed(0)}`);
  o(r);
})(run.judge.onHop);
const prev = PlayerMovement.createSnapshot();
const cur = PlayerMovement.createSnapshot();
for (let i = 0; i < 60 * CFG.tickRate && run.progress.stage < 2; i++) {
  if (run.progress.stage !== stage) {
    stage = run.progress.stage;
    const y = hand.yaw;
    hand = new HumanHand(CFG, { ...HANDS.anfaenger, pattern: 'circle' }, seed + 50, null, y);
    hand.yaw = y;
    hand.side = -1;
    log.push(`--- Stufe ${stage} bei ${t.toFixed(1)} s`);
  }
  const cmd = hand.next(pm.state);
  pm.copySnapshot(prev);
  pm.tick(cmd);
  pm.copySnapshot(cur);
  t += DT;
  if (prev.speed > 150 && cur.speed < prev.speed * 0.7) walls++;
  run.tick(DT, prev, cur, cmd, 72);
}
console.log(log.join('\n'));
console.log(`Wandkontakte ${walls}, Ende ${t.toFixed(1)} s, Stufe ${run.progress.stage}`);
