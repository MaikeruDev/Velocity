/**
 * "Wow"-Idee: tempoabhängiger Luft-Cap (Anfänger-Boost bei niedrigem Tempo,
 * Skill-Kurve oben unverändert). Nur Sim-Unterklasse, KEIN Projektcode.
 * capAt(v) = capLow für v ≤ vLow, linear auf 24 bis vHigh.
 * npx tsx tools/critique/movement-curves/capcurve.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../src/player/bots';
import type { Bot } from '../../../src/player/bots';
import { flatWorld } from '../../sim/scenarios';
import { makeInput } from '../../sim/harness';
import type { CollisionWorld } from '../../../src/world/collision/types';

const f = (v: number): string => (Number.isFinite(v) ? v.toFixed(0) : '–');
const DEG = Math.PI / 180;
/* eslint-disable @typescript-eslint/no-explicit-any */
function dynCapClass(capLow: number, vLow: number, vHigh: number, capHigh: number): new (w: CollisionWorld, c: MovementConfig) => PlayerMovement {
  class Dyn extends PlayerMovement {}
  (Dyn.prototype as any).airAccelerate = function (this: any, wishdir: Vector3, wishspeed: number, accel: number): void {
    const v = this.s.vel;
    const sp = Math.hypot(v.x, v.z);
    const k = Math.min(1, Math.max(0, (sp - vLow) / (vHigh - vLow)));
    const cap = capLow + (capHigh - capLow) * k;
    const wishspd = Math.min(wishspeed, cap);
    const current = v.dot(wishdir);
    const add = wishspd - current;
    if (add <= 0) return;
    let accelspd = accel * wishspeed * this.dt * this.surfaceFriction;
    if (accelspd > add) accelspd = add;
    v.addScaledVector(wishdir, accelspd);
  };
  return Dyn;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Schwung-Hand wie air.ts: Blick startet auf Flugrichtung, dreht mit R °/s, A/D passend, Zickzack. */
class SwingBot implements Bot {
  private dir = 1;
  private yaw = 0;
  private air = false;
  private readonly out = makeInput();
  constructor(private readonly rate: number, private readonly holdW = false) {}
  next(s: { onGround: boolean; vel: Vector3 }): ReturnType<typeof makeInput> {
    const psi = Math.atan2(-s.vel.x, -s.vel.z);
    if (s.onGround) {
      if (this.air) this.dir = -this.dir;
      this.air = false;
      this.yaw = psi;
    } else {
      this.air = true;
      this.yaw += (this.dir * this.rate * DEG) / 128;
    }
    const o = this.out;
    o.yaw = this.yaw;
    o.side = this.dir > 0 ? -1 : 1;
    o.forward = this.holdW ? 1 : 0;
    o.jumpHeld = true;
    o.jumpPressed = s.onGround;
    return o;
  }
}

function lands(C: new (w: CollisionWorld, c: MovementConfig) => PlayerMovement, cfg: MovementConfig, bot: Bot, v0: number, n: number): number[] {
  const pm = new C(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 12000));
  pm.state.vel.set(0, 0, -v0);
  const out: number[] = [];
  for (let t = 0; t < 40 * 128 && out.length < n; t++) {
    for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land') out.push(e.speed);
  }
  return out;
}

const cfg = VELOCITY_DEFAULT;
const variants: Array<[string, new (w: CollisionWorld, c: MovementConfig) => PlayerMovement, MovementConfig]> = [
  ['Cap 24 (heute)', PlayerMovement, cfg],
  ['Cap 30 fix', PlayerMovement, withMovement(cfg, { airSpeedCap: 30 })],
  ['Cap 32→24 (≤350 … 700)', dynCapClass(32, 350, 700, 24), cfg],
  ['Cap 36→24 (≤350 … 700)', dynCapClass(36, 350, 700, 24), cfg],
];
console.log('| Variante | Schwung 90°/s H1/H3/H5 (ab 320) | Schwung 90° + W H3 | Schwung 135°/s H3/H10 | Hand 3° H1/H5/H10 (ab 250) | Hand 2° H10/H20 | perfekt H5/H10/H20 |');
console.log('|---|---|---|---|---|---|---|');
for (const [name, C, c] of variants) {
  const s90 = lands(C, c, new SwingBot(90), 320, 5);
  const s90w = lands(C, c, new SwingBot(90, true), 320, 5);
  const s135 = lands(C, c, new SwingBot(135), 320, 10);
  const avg = (mk: (seed: number) => Bot, v0: number, n: number): number[] => {
    const acc = new Array(n).fill(0);
    for (let s = 1; s <= 5; s++) { const r = lands(C, c, mk(s * 7919), v0, n); for (let i = 0; i < n; i++) acc[i] += r[i] / 5; }
    return acc;
  };
  const a3 = avg((seed) => new StrafeBot(c, { aimNoiseDeg: 3, seed, heading: 0 }), 250, 10);
  const a2 = avg((seed) => new StrafeBot(c, { aimNoiseDeg: 2, seed, heading: 0 }), 250, 20);
  const p = lands(C, c, new StrafeBot(c, { sync: 1, heading: 0 }), 250, 20);
  console.log(`| ${name} | ${f(s90[0])}/${f(s90[2])}/${f(s90[4])} | ${f(s90w[2])} | ${f(s135[2])}/${f(s135[9])} | ${f(a3[0])}/${f(a3[4])}/${f(a3[9])} | ${f(a2[9])}/${f(a2[19])} | ${f(p[4])}/${f(p[9])}/${f(p[19])} |`);
}
