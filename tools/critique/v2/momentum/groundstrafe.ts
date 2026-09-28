/**
 * Boden-Kurven: Prestrafe (Ground-Strafe mit W+D und Mausdrehung) und Carving.
 * npx tsx tools/critique/v2/momentum/groundstrafe.ts
 *
 * Boden-Accelerate hat keinen Cap wie die Luft: accelspd = accel·wish·dt = 20 u/s pro Tick (Sprint).
 * Mit v·cosθ = wish − 20 steigt |v| jeden Tick um ≈ (2·20·300 + 400)/(2v) — gegen Friction v·5.2/128.
 * Gleichgewicht analytisch: v² ≈ (2·a·(wish−a) + a²)·128/(2·5.2) → a=20, wish=320: ≈ 391 u/s.
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { flatWorld } from '../../../sim/scenarios';
import { makeInput } from '../../../sim/harness';
import { DEG, f } from './common';

const cfg = VELOCITY_DEFAULT;
const TR = cfg.tickRate;

/** Optimaler Prestrafe-Bot (W+D, Blick so, dass v·wishdir = wish − a) bzw. konstante Drehrate. */
function prestrafe(v0: number, sprint: boolean, turnDegPerS: number | null, secs: number[]): number[] {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 0));
  pm.state.vel.set(0, 0, -v0);
  const wish = sprint ? cfg.sprintSpeed : cfg.runSpeed;
  const a = (cfg.accelerate * wish) / TR;
  const out: number[] = [];
  let yaw = 0;
  for (let t = 1; t <= Math.max(...secs) * TR; t++) {
    const s = pm.state;
    if (turnDegPerS === null) {
      const v = Math.max(s.speed, 1);
      const velYaw = s.speed > 1 ? Math.atan2(-s.vel.x, -s.vel.z) : 0;
      const theta = Math.acos(Math.min(1, Math.max(-1, (wish - a) / v)));
      yaw = velYaw - theta + Math.PI / 4;
    } else {
      yaw -= (turnDegPerS * DEG) / TR;
    }
    pm.tick(makeInput({ yaw, forward: 1, side: 1, sprint }));
    for (const sec of secs) if (t === Math.round(sec * TR)) out.push(pm.state.speed);
  }
  return out;
}

console.log('\n## A) Prestrafe am Boden (W+D, Blick nachgeführt), Tempo nach 0.25 / 0.5 / 1 / 2 / 4 s\n');
console.log('| Start | Sprint | Hand | 0.25 s | 0.5 s | 1 s | 2 s | 4 s |');
console.log('|---|---|---|---|---|---|---|---|');
const secs = [0.25, 0.5, 1, 2, 4];
for (const v0 of [0, 320]) {
  for (const sprint of [true, false]) {
    console.log(`| ${v0} | ${sprint ? 'ja' : 'nein'} | optimal | ${prestrafe(v0, sprint, null, secs).map((x) => f(x)).join(' | ')} |`);
    for (const rate of [45, 90, 135, 180]) {
      console.log(`| ${v0} | ${sprint ? 'ja' : 'nein'} | konst. ${rate}°/s | ${prestrafe(v0, sprint, rate, secs).map((x) => f(x)).join(' | ')} |`);
    }
  }
}

/** Carving: Tempo v am Boden, W (Sprint) gehalten, Blick dreht mit konstanter Rate um 90°. */
function carve(v0: number, rateDeg: number): { t90: number; speedEnd: number; minSpeed: number } {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 0));
  pm.state.vel.set(0, 0, -v0);
  let yaw = 0;
  let minSpeed = Infinity;
  for (let t = 1; t <= 4 * TR; t++) {
    yaw = Math.max(yaw - (rateDeg * DEG) / TR, -Math.PI / 2);
    pm.tick(makeInput({ yaw, forward: 1, sprint: true }));
    const s = pm.state;
    minSpeed = Math.min(minSpeed, s.speed);
    const velYaw = Math.atan2(-s.vel.x, -s.vel.z);
    if (velYaw <= -Math.PI / 2 + 5 * DEG) return { t90: t / TR, speedEnd: s.speed, minSpeed };
  }
  return { t90: Number.NaN, speedEnd: pm.state.speed, minSpeed };
}

console.log('\n## B) Carving am Boden: 90°-Kurve mit W+Sprint und Mausdrehung (Geschwindigkeits-Richtung bis 85°)\n');
console.log('| Tempo | Maus 90°/s | 180°/s | 360°/s | Sprung-Kurve Luft (Referenz) |');
console.log('|---|---|---|---|---|');
for (const v of [320, 500, 800]) {
  const cols = [90, 180, 360].map((r) => {
    const c = carve(v, r);
    return `${f(c.t90, 2)} s, Ende ${f(c.speedEnd)}`;
  });
  // Luft: max. Drehrate beim Strafen = cap/v rad pro Tick.
  const airRate = ((24 / v) * TR) / DEG;
  console.log(`| ${v} | ${cols.join(' | ')} | Luft max. ≈ ${f(airRate)}°/s |`);
}
