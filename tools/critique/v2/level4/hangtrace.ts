/** Level 4 — Luft-Hänger instrumentieren: TryPlayerMove und Traces an der Hänge-Stelle protokollieren. */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { TraceResult } from '../../../../src/world/collision/types';
import { buildLevel4, level4Info } from './level4';

const cfg = VELOCITY_DEFAULT;
const def = buildLevel4({ measure: false });
const info = level4Info();
const lv = compileLevel(def);
const h = info.helix;
const wall = info.crouchWalls[0];
const start = wall - 45 - 3 * 2;
const pm = new PlayerMovement(lv.world, cfg);
const [x, z] = h.xz(start, 790);
pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
const inp = makeBotInput();
const th = (): number => { let t = (Math.atan2(-pm.state.pos.z, pm.state.pos.x) * 180) / Math.PI - 270; while (t < start - 180) t += 360; while (t > start + 180) t -= 360; return t; };
type Dyn = Record<string, unknown>;
const pmd = pm as unknown as Dyn;
const world = lv.world as unknown as Dyn;
let logOn = false;
const origTrace = (world.traceBox as (...a: unknown[]) => TraceResult).bind(lv.world);
world.traceBox = (a: Vector3, b: Vector3, mi: Vector3, ma: Vector3, out?: TraceResult): TraceResult => {
  const r = origTrace(a, b, mi, ma, out);
  if (logOn) console.log(`      trace ${a.toArray().map((q) => q.toFixed(3)).join(',')} → ${b.toArray().map((q) => q.toFixed(3)).join(',')} frac ${r.fraction.toFixed(4)} ss ${r.startSolid} as ${r.allSolid} n ${r.normal.toArray().map((q) => q.toFixed(3)).join(',')} ${lv.brushes[r.brushIndex]?.tag ?? ''}`);
  return r;
};
const origTest = (world.testBox as (...a: unknown[]) => boolean).bind(lv.world);
world.testBox = (p: Vector3, mi: Vector3, ma: Vector3): boolean => {
  const r = origTest(p, mi, ma);
  if (logOn) console.log(`      testBox ${p.toArray().map((q) => q.toFixed(3)).join(',')} → ${r}`);
  return r;
};
const origTPM = (pmd.tryPlayerMove as () => void).bind(pm);
pmd.tryPlayerMove = (): void => {
  const v0 = pm.state.vel.clone();
  if (logOn) console.log(`    TPM vor: vel ${v0.toArray().map((q) => q.toFixed(3)).join(',')} pos ${pm.state.pos.toArray().map((q) => q.toFixed(3)).join(',')}`);
  origTPM();
  if (logOn) console.log(`    TPM nach: vel ${pm.state.vel.toArray().map((q) => q.toFixed(3)).join(',')}`);
};
let hang = 0;
for (let k = 0; k < 4 * cfg.tickRate; k++) {
  const yaw = (h.yawAt(th()) * Math.PI) / 180;
  if (k === 0) pm.state.vel.set(-Math.sin(yaw) * 250, 0, -Math.cos(yaw) * 250);
  inp.yaw = yaw; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = k === 0; inp.crouch = !pm.state.onGround;
  if (hang >= 40 && hang < 43) { logOn = true; console.log(`TICK ${k} (Hänger seit ${hang} Ticks)`); }
  pm.tick(inp);
  logOn = false;
  const s = pm.state;
  hang = !s.onGround && Math.abs(s.vel.y) < 12 && s.speed < 40 ? hang + 1 : 0;
  if (hang >= 43) break;
}
{
  // Nachbau von TryPlayerMove (Code wie src/player/PlayerMovement.ts) mit Protokoll.
  const mins = pm.hullMins.clone();
  const maxs = pm.hullMaxs.clone();
  const pos = new Vector3(-16.031, 879.797, 1135.267);
  const vel = new Vector3(31.997, -6.25, 0.452);
  const dt = 1 / 128;
  const original = vel.clone();
  const primal = vel.clone();
  const newVel = new Vector3();
  const planes: Vector3[] = [];
  let allFraction = 0;
  let timeLeft = dt;
  const clip = (inp: Vector3, n: Vector3, out: Vector3): void => {
    const b = inp.dot(n);
    out.set(inp.x - n.x * b, inp.y - n.y * b, inp.z - n.z * b);
    const adj = out.dot(n);
    if (adj < 0) out.addScaledVector(n, -adj);
  };
  for (let bump = 0; bump < 4; bump++) {
    if (vel.x === 0 && vel.y === 0 && vel.z === 0) { console.log('  bump', bump, 'vel 0 → break'); break; }
    const end = pos.clone().addScaledVector(vel, timeLeft);
    const tr = origTrace(pos, end, mins, maxs);
    allFraction += tr.fraction;
    console.log(`  bump ${bump}: vel ${vel.toArray().map((q) => q.toFixed(4)).join(',')} frac ${tr.fraction} n ${tr.normal.toArray().join(',')} ${lv.brushes[tr.brushIndex]?.tag ?? ''} allSolid ${tr.allSolid}`);
    if (tr.allSolid) { vel.set(0, 0, 0); console.log('  allSolid → 0'); break; }
    if (tr.fraction > 0) { pos.copy(tr.endPos); original.copy(vel); planes.length = 0; }
    if (tr.fraction === 1) break;
    timeLeft -= timeLeft * tr.fraction;
    const n = tr.normal.clone();
    if (planes.some((p) => n.dot(p) > 0.99)) { vel.add(n); console.log('  duplicate'); continue; }
    planes.push(n);
    if (planes.length === 1) { clip(original, planes[0], newVel); vel.copy(newVel); original.copy(newVel); }
    else {
      let i = 0;
      for (; i < planes.length; i++) {
        clip(original, planes[i], vel);
        let j = 0;
        for (; j < planes.length; j++) if (j !== i && vel.dot(planes[j]) < 0) break;
        if (j === planes.length) break;
      }
      console.log(`   i-Schleife endet mit i=${i}, vel ${vel.toArray().map((q) => q.toFixed(4)).join(',')}`);
      if (i === planes.length) { if (planes.length !== 2) { vel.set(0, 0, 0); break; } const d = new Vector3().crossVectors(planes[0], planes[1]).normalize(); vel.copy(d).multiplyScalar(d.dot(vel)); }
      if (vel.dot(primal) <= 0) { console.log('   primal → 0'); vel.set(0, 0, 0); break; }
    }
  }
  if (allFraction === 0) { console.log('  allFraction 0 → vel 0'); vel.set(0, 0, 0); }
  console.log('  Nachbau Ergebnis vel', vel.toArray().map((q) => q.toFixed(4)).join(','), 'pos', pos.toArray().map((q) => q.toFixed(3)).join(','));
}
