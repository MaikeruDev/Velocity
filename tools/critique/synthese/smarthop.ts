/**
 * Synthese-Stichprobe (kein Projektcode): gemergter Smart-Auto-Hop als Sim-Unterklasse.
 * Gehaltener Sprung (kein frischer Druck, kein Puffer) springt am Boden erst, wenn
 *   horizontal >= 0.95 * Boden-Wunschtempo  ODER  >= 0.2 s Bodenkontakt  ODER  keine Bewegungstaste.
 * npx tsx tools/critique/synthese/smarthop.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../src/player/bots';
import { flatWorld } from '../../sim/scenarios';
import { makeInput } from '../../sim/harness';

/* eslint-disable @typescript-eslint/no-explicit-any */
class Smart extends PlayerMovement {}
const orig = (PlayerMovement.prototype as any).checkJump;
(Smart.prototype as any).checkJump = function (this: any): boolean {
  const cfg = this.cfg;
  const s = this.s;
  const buffered = (this.tickCount - this.jumpPressTick) * this.dt <= cfg.jumpBufferTime + 1e-9;
  const heldOnly = !this.inJumpPressed && !buffered && cfg.autoHop && this.inJumpHeld;
  if (heldOnly && s.onGround) {
    const moving = this.inForward !== 0 || this.inSide !== 0;
    const groundWish = this.inSprint ? cfg.sprintSpeed : cfg.runSpeed;
    const h = Math.hypot(s.vel.x, s.vel.z);
    const groundT = this.frictionTicks * this.dt;
    if (moving && h < 0.95 * groundWish && groundT < 0.2) return false;
  }
  return orig.call(this);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const cfg = VELOCITY_DEFAULT;
for (const [name, K] of [['Original', PlayerMovement], ['SmartHop', Smart]] as const) {
  for (const sprint of [false, true]) {
    const pm = new K(flatWorld().world, cfg);
    pm.teleport(new Vector3(0, 0, 0));
    const inp = makeInput({ forward: 1, jumpHeld: true, sprint });
    let jumps = 0;
    for (let t = 0; t < 2 * cfg.tickRate; t++) { const ev = pm.tick(inp); for (const e of ev) if (e.type === 'jump') jumps++; inp.jumpPressed = false; }
    const p = pm.state.pos;
    console.log(`${name} W+Space ${sprint ? '+Shift' : '      '} 2 s: Weg ${Math.hypot(p.x, p.z).toFixed(0)} u, Speed ${pm.state.speed.toFixed(0)} u/s, Sprünge ${jumps}`);
  }
  // Perfekter Bot ab 320: Landungs-Speeds H1/H5/H10
  const pm = new K(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 12000));
  pm.state.vel.set(0, 0, -320);
  const bot = new StrafeBot(cfg, { seed: 7, heading: 0 });
  const out: number[] = [];
  for (let t = 0; t < 30 * cfg.tickRate && out.length < 10; t++) for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land') out.push(e.speed);
  console.log(`${name} perfekter Bot H1/H5/H10: ${out[0]?.toFixed(0)} / ${out[4]?.toFixed(0)} / ${out[9]?.toFixed(0)}`);
}
