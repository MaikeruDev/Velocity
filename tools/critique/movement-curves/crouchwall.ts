/**
 * Gegenprobe: macht eine Luft-Stufe (WallStep, 18 u bzw. 6 u) die Crouch-Kante in L1 (64 u) ohne Crouch-Jump schaffbar?
 * Anlauf auf H7 (y 128) Richtung Wand bei z −4691, W + Sprung gehalten, ohne Ducken, 20 Absprungpunkte × 4 Tempi.
 * npx tsx tools/critique/movement-curves/crouchwall.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { compileLevel } from '../../../src/world/level/compileLevel';
import type { CollisionWorld } from '../../../src/world/collision/types';
import { readLevelFile } from '../../sim/levels';
import { makeInput } from '../../sim/harness';

const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
/* eslint-disable @typescript-eslint/no-explicit-any */
const base: any = PlayerMovement.prototype;
function wallStep(size: number): new (w: CollisionWorld, c: MovementConfig) => PlayerMovement {
  class WS extends PlayerMovement {}
  (WS.prototype as any).airMove = function (this: any, w: Vector3, ws: number): void {
    const orig = this.tryPlayerMove;
    const self = this;
    this.tryPlayerMove = function () {
      self.tryPlayerMove = orig;
      const s = self.s;
      const end = s.pos.clone().addScaledVector(s.vel, self.dt);
      const tr = self.world.traceBox(s.pos, end, self.mins, self.maxs, self.trAux);
      const down = s.pos.clone(); down.y -= size;
      const g = self.world.traceBox(s.pos, down, self.mins, self.maxs, self.trGround);
      const groundBelow = g.fraction < 1 && g.normal.y >= 0.7;
      if (tr.fraction < 1 && Math.abs(tr.normal.y) < 0.1 && (s.vel.y <= 0 || groundBelow)) {
        const saved = self.cfg;
        self.cfg = withMovement(saved, { stepSize: size });
        self.stepMove();
        self.cfg = saved;
      } else orig.call(self);
    };
    try { base.airMove.call(this, w, ws); } finally { this.tryPlayerMove = orig; }
  };
  return WS;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
for (const [name, K] of [['Original', PlayerMovement], ['WallStep 18', wallStep(18)], ['WallStep 6', wallStep(6)]] as Array<[string, new (w: CollisionWorld, c: MovementConfig) => PlayerMovement]>) {
  let up = 0;
  let n = 0;
  for (const v0 of [400, 500, 600, 700]) {
    for (let off = 0; off < 300; off += 15) {
      n++;
      const pm = new K(L1.world, VELOCITY_DEFAULT);
      pm.teleport(new Vector3(0, 129, -4390 - off));
      pm.state.vel.set(0, 0, -v0);
      for (let t = 0; t < 4 * 128; t++) {
        pm.tick(makeInput({ forward: 1, jumpHeld: true, jumpPressed: t === 0, yaw: 0 }));
        if (pm.state.pos.y > 190 && pm.state.pos.z < -4700 && pm.state.onGround) { up++; break; }
      }
    }
  }
  console.log(`${name.padEnd(12)} ohne Crouch auf der 64-u-Kante: ${up}/${n}`);
}
