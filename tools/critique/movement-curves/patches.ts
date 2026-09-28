/**
 * Kritiker-Linse "Movement-Kurven": Fix-Vorschläge als Unterklassen (nur Sim,
 * KEIN Projektcode) und A/B-Messung gegen das Original.
 *  - AirStep: Quake-3-PM_StepSlideMove in der Luft (nur fallend, vel.y ≤ 0):
 *    blockiert eine senkrechte Stirn, deren Oberkante ≤ stepSize über den Füßen
 *    liegt, steigt man auf. Surf-Flanken unberührt (Abwärts-Trace braucht n.y ≥ 0.7).
 *  - SmartHop: Auto-Hop (gehaltene Taste) springt erst, wenn Speed ≥ 0.8·runSpeed
 *    ODER keine Bewegungstaste gedrückt ist. Frischer Druck springt immer.
 *  - SurfDeadzone: an steiler Fläche wird ein Rückwärtsanteil der wishdir bis 10°
 *    ignoriert (Blick leicht in die Rampe bremst nicht).
 * npx tsx tools/critique/movement-curves/patches.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { compileLevel, type CompiledLevel } from '../../../src/world/level/compileLevel';
import type { CollisionWorld } from '../../../src/world/collision/types';
import { readLevelFile } from '../../sim/levels';
import { makeInput } from '../../sim/harness';
import { flatWorld } from '../../sim/scenarios';
import { SurfRider, routeAxis } from '../../levels/physics';

const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');
const cfg = VELOCITY_DEFAULT;
const L1: CompiledLevel = compileLevel(readLevelFile('public/levels/level1.json'));
const L2: CompiledLevel = compileLevel(readLevelFile('public/levels/level2.json'));

type Ctor = new (w: CollisionWorld, c: MovementConfig) => PlayerMovement;
/* eslint-disable @typescript-eslint/no-explicit-any */
const base: any = PlayerMovement.prototype;

class AirStepPM extends PlayerMovement {}
/** Quake 3 PM_StepSlideMove: steigend nur stufen, wenn innerhalb stepSize darunter begehbarer Boden liegt (gerade abgesprungen). */
function groundBelow(pm: any): boolean {
  const end = pm.s.pos.clone();
  end.y -= pm.cfg.stepSize;
  const tr = pm.world.traceBox(pm.s.pos, end, pm.mins, pm.maxs, pm.trAux);
  return tr.fraction < 1 && tr.normal.y >= 0.7;
}
(AirStepPM.prototype as any).airMove = function airMove(this: any, wishdir: Vector3, wishspeed: number): void {
  // Original-airMove, aber am Ende stepMove statt tryPlayerMove, wenn fallend oder gerade abgesprungen.
  const orig = this.tryPlayerMove;
  if (this.s.vel.y <= 0 || groundBelow(this)) this.tryPlayerMove = function (this: any) { this.tryPlayerMove = orig; this.stepMove(); };
  try { base.airMove.call(this, wishdir, wishspeed); } finally { this.tryPlayerMove = orig; }
};

class SmartHopPM extends PlayerMovement {}
(SmartHopPM.prototype as any).checkJump = function checkJump(this: any): boolean {
  const moving = this.inForward !== 0 || this.inSide !== 0;
  const slow = this.s.onGround && Math.hypot(this.s.vel.x, this.s.vel.z) < 0.8 * (this.inSprint ? this.cfg.sprintSpeed : this.cfg.runSpeed);
  const buffered = (this.tickCount - this.jumpPressTick) * this.dt <= this.cfg.jumpBufferTime + 1e-9;
  if (!this.inJumpPressed && !buffered && moving && slow) return false;
  return base.checkJump.call(this);
};

class SurfDeadzonePM extends PlayerMovement {}
const SIN10 = Math.sin((10 * Math.PI) / 180);
(SurfDeadzonePM.prototype as any).airAccelerate = function airAccelerate(this: any, wishdir: Vector3, wishspeed: number, accel: number): void {
  const v = this.s.vel;
  const sp = Math.hypot(v.x, v.z);
  if (this.steepBelow && sp > 1 && wishspeed > 0) {
    const fx = v.x / sp;
    const fz = v.z / sp;
    const back = wishdir.x * fx + wishdir.z * fz;
    const n = this.steepNormal;
    const into = -(wishdir.x * n.x + wishdir.z * n.z);
    if (back < 0 && back > -SIN10 && into > 0) {
      const w = new Vector3(wishdir.x - back * fx, 0, wishdir.z - back * fz).normalize();
      base.airAccelerate.call(this, w, wishspeed, accel);
      return;
    }
  }
  base.airAccelerate.call(this, wishdir, wishspeed, accel);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const VARIANTS: Array<[string, Ctor]> = [
  ['Original', PlayerMovement],
  ['AirStep', AirStepPM],
  ['SmartHop', SmartHopPM],
];

// 1) Treppe L1 mit W + Sprung gehalten
console.log('## 1) L1 Treppe, W + Sprung gehalten (Anlauf 250/320/500, 3 Phasen): Zeit bis Plateau, Speed oben\n');
console.log('| Variante | 250 | 320 | 500 |');
console.log('|---|---|---|---|');
for (const [name, C] of [...VARIANTS, ['AirStep+SmartHop', class extends AirStepPM {}] as [string, Ctor]]) {
  if (name === 'AirStep+SmartHop') ((C as unknown as { prototype: Record<string, unknown> }).prototype).checkJump = (SmartHopPM.prototype as unknown as Record<string, unknown>).checkJump;
  const cells: string[] = [];
  for (const v0 of [250, 320, 500]) {
    const res: string[] = [];
    for (const phase of [0, 60, 120]) {
      const pm = new C(L1.world, cfg);
      pm.teleport(new Vector3(-96, 1, -1030 - phase));
      pm.state.vel.set(0, 0, -v0);
      let t = 0;
      for (; t < 6 * cfg.tickRate; t++) {
        pm.tick(makeInput({ forward: 1, sprint: true, jumpHeld: true, jumpPressed: t === 0, yaw: 0 }));
        if (pm.state.pos.z < -1600) break;
      }
      res.push(t >= 6 * cfg.tickRate ? `>6s/${f(pm.state.speed)}` : `${f(t / cfg.tickRate, 2)}s/${f(pm.state.speed)}`);
    }
    cells.push(res.join(', '));
  }
  console.log(`| ${name} | ${cells.join(' | ')} |`);
}

// 2) Nach Stillstand mit W+Leertaste: Weg in 1 s / 2 s
console.log('\n## 2) Stillstand, W + Sprung gehalten (flach): Weg nach 1 s / 2 s, Speed nach 2 s\n');
for (const [name, C] of VARIANTS) {
  const pm = new C(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 0));
  let d1 = 0;
  for (let t = 1; t <= 2 * cfg.tickRate; t++) {
    pm.tick(makeInput({ forward: 1, sprint: true, jumpHeld: true, jumpPressed: t === 1, yaw: 0 }));
    if (t === cfg.tickRate) d1 = -pm.state.pos.z;
  }
  console.log(`${name}: ${f(d1)} u / ${f(-pm.state.pos.z)} u, ${f(pm.state.speed)} u/s`);
}

// 3) Hop-Reihe L1: Tode (W + Sprung, ohne Strafen) — AirStep
console.log('\n## 3) L1 Hop-Reihe, W+Sprung ohne Strafen, 500 Läufe (320–800 u/s × 20 Startpunkte): Tode\n');
for (const [name, C] of VARIANTS.slice(0, 2)) {
  let deaths = 0;
  let reached = 0;
  let runs = 0;
  for (let v0 = 320; v0 <= 800; v0 += 20) {
    for (let off = 0; off < 240; off += 12) {
      runs++;
      const pm = new C(L1.world, cfg);
      pm.teleport(new Vector3(0, 129, -1600 - off));
      pm.state.vel.set(0, 0, -v0);
      for (let t = 0; t < 8 * cfg.tickRate; t++) {
        pm.tick(makeInput({ forward: 1, jumpHeld: true, jumpPressed: t === 0, yaw: 0 }));
        if (pm.state.pos.y < 40) { deaths++; break; }
        if (pm.state.pos.z < -4430) { reached++; break; }
      }
    }
  }
  console.log(`${name}: ${deaths}/${runs} tot, ${reached} bis H7`);
}

// 4) Surf-Blickfenster mit Deadzone
console.log('\n## 4) L2 Surf ab CP2, Blick-Offset (Grundtechnik-Surfer): Original vs. SurfDeadzone\n');
{
  const route = L2.def.route ?? [];
  const axisAt = routeAxis(route);
  const cp2 = L2.triggers.find((t) => t.kind === 'checkpoint' && t.order === 2);
  if (!cp2) throw new Error('cp2');
  const offs = [-2, 0, 2, 3, 5, 7, 10];
  console.log(`| Variante | ${offs.map((o) => `${o}°`).join(' | ')} |`);
  console.log(`|---|${offs.map(() => '---').join('|')}|`);
  for (const [name, C] of [['Original', PlayerMovement], ['SurfDeadzone', SurfDeadzonePM]] as Array<[string, Ctor]>) {
    const cells = offs.map((o) => {
      const pm = new C(L2.world, cfg);
      pm.teleport(cp2.spawnPos.clone().add(new Vector3(0, 1, 0)));
      const rider = new SurfRider(cfg, L2.world, axisAt, (o * Math.PI) / 180);
      for (let t = 0; t < 25 * cfg.tickRate; t++) {
        pm.tick(rider.next(pm.state, pm.surfNormal));
        const s = pm.state;
        if (s.pos.z < -7300) return `${f(s.speed)} · ${f(t / cfg.tickRate, 1)}s`;
        if (s.pos.y < -2500) return `fällt`;
        for (const k of L2.triggers) {
          if (k.kind === 'kill' && k.bounds.containsPoint(s.pos)) return `kill z${f(s.pos.z)}`;
        }
      }
      return 'STALL';
    });
    console.log(`| ${name} | ${cells.join(' | ')} |`);
  }
}
