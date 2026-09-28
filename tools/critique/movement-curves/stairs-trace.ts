/**
 * Treppe L1: was passiert Tick für Tick beim Hochhüpfen (W + Sprung gehalten)?
 * npx tsx tools/critique/movement-curves/stairs-trace.ts [v0] [phase]
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { compileLevel } from '../../../src/world/level/compileLevel';
import { readLevelFile } from '../../sim/levels';
import { makeInput } from '../../sim/harness';

const cfg = VELOCITY_DEFAULT;
const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
const v0 = Number(process.argv[2] ?? 320);
const phase = Number(process.argv[3] ?? 0);
const pm = new PlayerMovement(L1.world, cfg);
pm.teleport(new Vector3(-96, 1, -1030 - phase));
pm.state.vel.set(0, 0, -v0);
let prev = pm.state.speed;
for (let t = 0; t < 3 * cfg.tickRate; t++) {
  const ev = pm.tick(makeInput({ forward: 1, sprint: true, jumpHeld: true, jumpPressed: t === 0, yaw: 0 }));
  const s = pm.state;
  const tags = ev.map((e) => e.type).filter((x) => x !== 'footstep').join(',');
  if (tags || s.speed < 0.75 * prev || t % 16 === 0) {
    console.log(`t${t} z${s.pos.z.toFixed(1)} y${s.pos.y.toFixed(1)} vy${s.vel.y.toFixed(0)} v${s.speed.toFixed(0)} g${s.onGround ? 1 : 0} ${tags}${s.speed < 0.75 * prev ? ' BONK' : ''}`);
  }
  prev = s.speed;
  if (s.pos.z < -1600) break;
}
