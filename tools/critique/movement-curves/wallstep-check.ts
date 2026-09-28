/**
 * Gegenprobe WallStep (Luft-Stufe nur an senkrechten Wänden, Q3-Bedingung):
 * ändert es Surf (L2 ab CP2, Blick 0/±2°), Terrassen und die Hop-Reihe?
 * npx tsx tools/critique/movement-curves/wallstep-check.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../src/player/bots';
import { compileLevel } from '../../../src/world/level/compileLevel';
import type { CollisionWorld } from '../../../src/world/collision/types';
import { readLevelFile } from '../../sim/levels';
import { makeInput } from '../../sim/harness';
import { SurfRider, routeAxis } from '../../levels/physics';

const cfg = VELOCITY_DEFAULT;
const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
const L2 = compileLevel(readLevelFile('public/levels/level2.json'));
/* eslint-disable @typescript-eslint/no-explicit-any */
const base: any = PlayerMovement.prototype;
class WallStep extends PlayerMovement {}
let steps = 0;
(WallStep.prototype as any).airMove = function (this: any, w: Vector3, ws: number): void {
  const orig = this.tryPlayerMove;
  const self = this;
  this.tryPlayerMove = function () {
    self.tryPlayerMove = orig;
    const s = self.s;
    const end = s.pos.clone().addScaledVector(s.vel, self.dt);
    const tr = self.world.traceBox(s.pos, end, self.mins, self.maxs, self.trAux);
    const down = s.pos.clone(); down.y -= self.cfg.stepSize;
    const g = self.world.traceBox(s.pos, down, self.mins, self.maxs, self.trGround);
    const groundBelow = g.fraction < 1 && g.normal.y >= 0.7;
    if (tr.fraction < 1 && Math.abs(tr.normal.y) < 0.1 && (s.vel.y <= 0 || groundBelow)) {
      const y0 = s.pos.y;
      self.stepMove();
      if (s.pos.y > y0 + 0.5) steps++;
    } else orig.call(self);
  };
  try { base.airMove.call(this, w, ws); } finally { this.tryPlayerMove = orig; }
};
/* eslint-enable @typescript-eslint/no-explicit-any */
type C = new (w: CollisionWorld, c: MovementConfig) => PlayerMovement;
const f = (v: number): string => v.toFixed(0);

const axisAt = routeAxis(L2.def.route ?? []);
const cp2 = L2.triggers.find((t) => t.kind === 'checkpoint' && t.order === 2)!;
for (const [name, K] of [['Original', PlayerMovement], ['WallStep', WallStep]] as Array<[string, C]>) {
  steps = 0;
  const cells: string[] = [];
  for (const o of [-2, 0, 2]) {
    const pm = new K(L2.world, cfg);
    pm.teleport(cp2.spawnPos.clone().add(new Vector3(0, 1, 0)));
    const r = new SurfRider(cfg, L2.world, axisAt, (o * Math.PI) / 180);
    let res = 'STALL';
    for (let t = 0; t < 25 * 128; t++) {
      pm.tick(r.next(pm.state, pm.surfNormal));
      if (pm.state.pos.z < -7300) { res = `${f(pm.state.speed)}@${(t / 128).toFixed(1)}s`; break; }
      if (pm.state.pos.y < -2500) { res = 'fällt'; break; }
    }
    cells.push(`${o}°: ${res}`);
  }
  // Hop-Reihe mit Hand 3° (StrafeBot Kurs Nord), 8 Seeds × 3 Tempi: bis H7?
  let ok = 0;
  let n = 0;
  for (let seed = 1; seed <= 8; seed++) {
    for (const v0 of [320, 400, 480]) {
      n++;
      const pm = new K(L1.world, cfg);
      pm.teleport(new Vector3(0, 129, -1700));
      pm.state.vel.set(0, 0, -v0);
      const bot = new StrafeBot(cfg, { aimNoiseDeg: 3, seed: seed * 17, heading: 0 });
      for (let t = 0; t < 10 * 128; t++) {
        pm.tick(bot.next(pm.state));
        if (pm.state.pos.y < 40) break;
        if (pm.state.pos.z < -4430) { ok++; break; }
      }
    }
  }
  // Terrassen perfekter Strafer
  const pm = new K(L1.world, cfg);
  pm.teleport(new Vector3(-2403, 193, -520));
  pm.state.vel.set(0, 0, 807);
  const bot = new StrafeBot(cfg, { heading: Math.PI });
  for (let t = 0; t < 8 * 128; t++) { pm.tick(bot.next(pm.state)); if (pm.state.pos.z > 3740 || pm.state.pos.y < -900) break; }
  console.log(`${name.padEnd(9)} Surf L2 ${cells.join(', ')} | Hop-Reihe Hand 3° (ohne Zielen) bis H7: ${ok}/${n} | Terrassen Ende ${f(pm.state.speed)} | Luft-Stufen ausgelöst: ${steps}`);
  void makeInput;
}
