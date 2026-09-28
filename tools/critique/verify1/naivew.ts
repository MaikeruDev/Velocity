// Prüfer: gewinnt reines W beim Hüpfen Tempo? (air.ts 'nur W' 322→336)
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, CS2_CLASSIC, withMovement, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { makeInput } from '../../sim/harness';
import { flatWorld } from '../../sim/scenarios';
function run(name: string, cfg: MovementConfig, pressEvery: boolean, sprint: boolean): void {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 12000));
  pm.state.vel.set(0, 0, -320);
  const lands: string[] = [];
  let maxAir = 0;
  for (let t = 0; t < 12 * cfg.tickRate && lands.length < 10; t++) {
    const ev = pm.tick(makeInput({ yaw: 0, forward: 1, sprint, jumpHeld: true, jumpPressed: pressEvery || t === 0 }));
    if (!pm.state.onGround) maxAir = Math.max(maxAir, pm.state.speed);
    for (const e of ev) if (e.type === 'land') lands.push(e.speed.toFixed(1));
  }
  console.log(name.padEnd(40), lands.join(' '), 'maxAir', maxAir.toFixed(1));
}
for (const sp of [false, true]) for (const pe of [true, false]) {
  run(`VEL sprint=${sp} press=${pe}`, VELOCITY_DEFAULT, pe, sp);
  run(`VEL capLow0 sprint=${sp} press=${pe}`, withMovement(VELOCITY_DEFAULT, { airSpeedCapLow: 0 }), pe, sp);
  run(`CS2 sprint=${sp} press=${pe}`, CS2_CLASSIC, pe, sp);
}
