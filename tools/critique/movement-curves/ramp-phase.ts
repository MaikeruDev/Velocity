/**
 * L1 Rampe (26.6°) und Treppe hochhüpfen: Phase des Anlaufs rastern (Auto-Hop gehalten, W, Sprint).
 * Original vs. SmartHop (Auto-Hop wartet unter 0.8·Wunschtempo am Boden) vs. AirStep+SmartHop.
 * npx tsx tools/critique/movement-curves/ramp-phase.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { compileLevel } from '../../../src/world/level/compileLevel';
import type { CollisionWorld } from '../../../src/world/collision/types';
import { readLevelFile } from '../../sim/levels';
import { makeInput } from '../../sim/harness';

const cfg = VELOCITY_DEFAULT;
const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
/* eslint-disable @typescript-eslint/no-explicit-any */
const base: any = PlayerMovement.prototype;
class SmartHop extends PlayerMovement {}
(SmartHop.prototype as any).checkJump = function (this: any): boolean {
  const moving = this.inForward !== 0 || this.inSide !== 0;
  const slow = this.s.onGround && Math.hypot(this.s.vel.x, this.s.vel.z) < 0.8 * (this.inSprint ? this.cfg.sprintSpeed : this.cfg.runSpeed);
  const buffered = (this.tickCount - this.jumpPressTick) * this.dt <= this.cfg.jumpBufferTime + 1e-9;
  if (!this.inJumpPressed && !buffered && moving && slow) return false;
  return base.checkJump.call(this);
};
class AirStepSmart extends SmartHop {}
(AirStepSmart.prototype as any).airMove = function (this: any, w: Vector3, ws: number): void {
  const orig = this.tryPlayerMove;
  const end = this.s.pos.clone(); end.y -= this.cfg.stepSize;
  const tr = this.world.traceBox(this.s.pos, end, this.mins, this.maxs, this.trAux);
  const groundBelow = tr.fraction < 1 && tr.normal.y >= 0.7;
  if (this.s.vel.y <= 0 || groundBelow) this.tryPlayerMove = function (this: any) { this.tryPlayerMove = orig; this.stepMove(); };
  try { base.airMove.call(this, w, ws); } finally { this.tryPlayerMove = orig; }
};
/** Restriktiv: nur stufen, wenn der direkte Weg an einer (fast) senkrechten Wand blockiert (|n.y| < 0.1). */
class WallStepSmart extends SmartHop {}
(WallStepSmart.prototype as any).airMove = function (this: any, w: Vector3, ws: number): void {
  const orig = this.tryPlayerMove;
  const self = this;
  this.tryPlayerMove = function (this: any) {
    self.tryPlayerMove = orig;
    const s = self.s;
    const end = s.pos.clone().addScaledVector(s.vel, self.dt);
    const tr = self.world.traceBox(s.pos, end, self.mins, self.maxs, self.trAux);
    const down = s.pos.clone(); down.y -= self.cfg.stepSize;
    const g = self.world.traceBox(s.pos, down, self.mins, self.maxs, self.trGround);
    const groundBelow = g.fraction < 1 && g.normal.y >= 0.7;
    if (tr.fraction < 1 && Math.abs(tr.normal.y) < 0.1 && (s.vel.y <= 0 || groundBelow)) self.stepMove();
    else orig.call(self);
  };
  try { base.airMove.call(this, w, ws); } finally { this.tryPlayerMove = orig; }
};
/* eslint-enable @typescript-eslint/no-explicit-any */
type C = new (w: CollisionWorld, c: MovementConfig) => PlayerMovement;
export { WallStepSmart };

for (const [where, x] of [['Rampe', 96], ['Treppe', -96]] as const) {
  console.log(`\n### ${where}: Speed beim Erreichen des Plateaus (z < −1600), Anlauf 320 (Sprint), 30 Phasen à 8 u`);
  for (const [name, K] of [['Original', PlayerMovement], ['SmartHop', SmartHop], ['AirStep+SmartHop', AirStepSmart], ['WallStep+SmartHop', WallStepSmart]] as Array<[string, C]>) {
    const speeds: number[] = [];
    const times: number[] = [];
    for (let ph = 0; ph < 240; ph += 8) {
      const pm = new K(L1.world, cfg);
      pm.teleport(new Vector3(x, 1, -1030 - ph));
      pm.state.vel.set(0, 0, -320);
      let t = 0;
      for (; t < 6 * 128; t++) {
        pm.tick(makeInput({ forward: 1, sprint: true, jumpHeld: true, jumpPressed: t === 0, yaw: 0 }));
        if (pm.state.pos.z < -1600) break;
      }
      speeds.push(pm.state.speed);
      times.push(t / 128);
    }
    speeds.sort((a, b) => a - b);
    const stuck = times.filter((t) => t >= 6).length;
    const med = speeds[Math.floor(speeds.length / 2)];
    console.log(`${name.padEnd(18)} min ${speeds[0].toFixed(0)}  Median ${med.toFixed(0)}  max ${speeds[speeds.length - 1].toFixed(0)}  <200 u/s: ${speeds.filter((s) => s < 200).length}/30  >6 s hängen: ${stuck}/30  Ø Zeit ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)} s`);
  }
}
