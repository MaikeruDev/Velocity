/**
 * Wie aimgain.ts, aber mit tempoabhängigem Cap (Sim-Unterklasse): 32 bis 350 u/s, linear auf 24 bei 700.
 * npx tsx tools/critique/movement-curves/aimgain-dyn.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../src/player/bots';
import { flatWorld } from '../../sim/scenarios';
import type { CollisionWorld } from '../../../src/world/collision/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
class Dyn extends PlayerMovement {}
(Dyn.prototype as any).airAccelerate = function (this: any, wishdir: Vector3, wishspeed: number, accel: number): void {
  const v = this.s.vel;
  const sp = Math.hypot(v.x, v.z);
  const k = Math.min(1, Math.max(0, (sp - 350) / 350));
  const cap = 32 + (24 - 32) * k;
  const add = Math.min(wishspeed, cap) - v.dot(wishdir);
  if (add <= 0) return;
  v.addScaledVector(wishdir, Math.min(accel * wishspeed * this.dt * this.surfaceFriction, add));
};
/* eslint-enable @typescript-eslint/no-explicit-any */
type C = new (w: CollisionWorld, c: MovementConfig) => PlayerMovement;
function run(K: C, cfg: MovementConfig, aim: number, seed: number, n: number): number[] {
  const pm = new K(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 12000));
  pm.state.vel.set(0, 0, -320);
  const bot = new StrafeBot(cfg, { aimNoiseDeg: aim, seed, heading: 0 });
  const out: number[] = [];
  for (let t = 0; t < 40 * cfg.tickRate && out.length < n; t++) for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land') out.push(e.speed);
  return out;
}
console.log('| Variante | Zielfehler | H1 | H3 | H5 | H10 | H20 |');
console.log('|---|---|---|---|---|---|---|');
for (const [name, K, cfg] of [['Cap 24', PlayerMovement, VELOCITY_DEFAULT], ['Cap 32→24', Dyn, VELOCITY_DEFAULT], ['Cap 30 fix', PlayerMovement, withMovement(VELOCITY_DEFAULT, { airSpeedCap: 30 })]] as Array<[string, C, MovementConfig]>) {
  for (const aim of [3, 4, 5, 6]) {
    const acc = new Array(20).fill(0);
    for (let s = 1; s <= 8; s++) { const r = run(K, cfg, aim, s * 997, 20); for (let i = 0; i < 20; i++) acc[i] += r[i] / 8; }
    console.log(`| ${name} | ${aim}° | ${acc[0].toFixed(0)} | ${acc[2].toFixed(0)} | ${acc[4].toFixed(0)} | ${acc[9].toFixed(0)} | ${acc[19].toFixed(0)} |`);
  }
}
