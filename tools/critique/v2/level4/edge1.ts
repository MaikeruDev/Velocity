/** Level 4 — Einzelfall Crouch-Kante 1 bei 700 u/s (Diagnose zu probes.ts C). */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { buildLevel4, level4Info } from './level4';

const cfg = VELOCITY_DEFAULT;
const def = buildLevel4({ measure: false });
const info = level4Info();
const lv = compileLevel(def);
const h = info.helix;
const wall = info.crouchWalls[Number(process.argv[2] ?? 0)];
const v = Number(process.argv[3] ?? 700);
const r = Number(process.argv[4] ?? 900);
const phase = Number(process.argv[5] ?? 0);
const start = wall - 45 - phase * 2;
const pm = new PlayerMovement(lv.world, cfg);
const [x, z] = h.xz(start, r);
pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
const inp = makeBotInput();
const th = (): number => { let t = (Math.atan2(-pm.state.pos.z, pm.state.pos.x) * 180) / Math.PI - 270; while (t < start - 180) t += 360; while (t > start + 180) t -= 360; return t; };
for (let k = 0; k < 4 * cfg.tickRate; k++) {
  const yaw = (h.yawAt(th()) * Math.PI) / 180;
  if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
  inp.yaw = yaw; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = k === 0; inp.crouch = !pm.state.onGround;
  const ev = pm.tick(inp);
  const s = pm.state;
  const tags = ev.map((e) => e.type).filter((t) => t === 'jump' || t === 'land').join(',');
  if (k % 8 === 0 || tags) console.log(`${(k / 128).toFixed(2)} θ ${th().toFixed(1)} (Kante ${wall.toFixed(1)}) y ${s.pos.y.toFixed(0)} v ${s.speed.toFixed(0)} vy ${s.vel.y.toFixed(0)} ${s.onGround ? 'G' : 'A'}${s.ducked ? 'd' : ''} ${tags}`);
}
{
  const s = pm.state;
  console.log('surfing', s.surfing, 'surfNormal', pm.surfNormal.toArray().map((q) => q.toFixed(3)).join(','), 'ground', s.onGround, 'ducked', s.ducked);
  const tr = lv.world.traceBox(new Vector3(s.pos.x, s.pos.y + 1, s.pos.z), new Vector3(s.pos.x, s.pos.y - 40, s.pos.z), pm.hullMins, pm.hullMaxs);
  console.log('down-trace frac', tr.fraction.toFixed(3), 'normal', tr.normal.toArray().map((q) => q.toFixed(3)).join(','), 'brush', lv.brushes[tr.brushIndex]?.tag, 'startSolid', tr.startSolid);
  const yaw = (h.yawAt(th()) * Math.PI) / 180;
  const f = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const tr2 = lv.world.traceBox(new Vector3(s.pos.x, s.pos.y + 1, s.pos.z), new Vector3(s.pos.x + f.x * 20, s.pos.y + 1, s.pos.z + f.z * 20), pm.hullMins, pm.hullMaxs);
  console.log('fwd-trace frac', tr2.fraction.toFixed(3), 'normal', tr2.normal.toArray().map((q) => q.toFixed(3)).join(','), 'brush', lv.brushes[tr2.brushIndex]?.tag);
  console.log('hull', pm.hullMins.toArray(), pm.hullMaxs.toArray(), 'pos', s.pos.toArray().map((q) => q.toFixed(1)).join(','));
}
{
  const s = pm.state;
  const p = s.pos.clone();
  const t0 = lv.world.traceBox(p, p.clone(), pm.hullMins, pm.hullMaxs);
  const t1 = lv.world.traceBox(p, p.clone().setY(p.y - 8), pm.hullMins, pm.hullMaxs);
  console.log('at pos startSolid', t0.startSolid, 'allSolid', t0.allSolid, '| down 8: frac', t1.fraction.toFixed(3), 'startSolid', t1.startSolid, 'normal', t1.normal.toArray().map((q) => q.toFixed(3)).join(','), 'brush', lv.brushes[t1.brushIndex]?.tag);
  // 5 weitere Ticks ohne Eingabe: fällt er dann?
  const inp2 = makeBotInput();
  for (let k = 0; k < 64; k++) pm.tick(inp2);
  console.log('ohne Eingabe nach 0.5 s: y', pm.state.pos.y.toFixed(1), 'vy', pm.state.vel.y.toFixed(1), 'ground', pm.state.onGround);
}
{
  // Handnachbau von TryPlayerMove an der Hänge-Stelle (vor dem Fall-Test oben neu aufsetzen).
  const pm2 = new PlayerMovement(lv.world, cfg);
  const p0 = new Vector3(-116.1, 876.0, 1127.8);
  const mins = new Vector3(-16, 0, -16);
  const maxs = new Vector3(16, 54, 16);
  void pm2;
  const yaw = (h.yawAt(354.1) * Math.PI) / 180;
  const f = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  let vel = new Vector3(f.x * 32, -6.25, f.z * 32);
  let pos = p0.clone();
  const dt = 1 / 128;
  for (let bump = 0; bump < 4; bump++) {
    const end = pos.clone().addScaledVector(vel, dt);
    const tr = lv.world.traceBox(pos, end, mins, maxs);
    console.log(`bump ${bump}: vel ${vel.toArray().map((q) => q.toFixed(2)).join(',')} frac ${tr.fraction.toFixed(4)} startSolid ${tr.startSolid} normal ${tr.normal.toArray().map((q) => q.toFixed(4)).join(',')} brush ${lv.brushes[tr.brushIndex]?.tag} planeDist ${(tr as unknown as { plane?: { dist: number } }).plane?.dist ?? ''}`);
    if (tr.fraction === 1) break;
    pos = tr.endPos.clone();
    const n = tr.normal.clone();
    const back = vel.dot(n);
    vel = vel.clone().addScaledVector(n, -back);
  }
}
{
  const p0 = new Vector3(-116.1, 876.0, 1127.8);
  const mins = new Vector3(-16, 0, -16);
  const maxs = new Vector3(16, 54, 16);
  // exakt an die Wand schieben (so wie der Spieler dort liegt)
  const yaw = (h.yawAt(354.1) * Math.PI) / 180;
  const f = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const t = lv.world.traceBox(p0, p0.clone().addScaledVector(f, 40), mins, maxs);
  const p = t.endPos.clone();
  console.log('an der Wand bei', p.toArray().map((q) => q.toFixed(3)).join(','), 'normal', t.normal.toArray().map((q) => q.toFixed(4)).join(','));
  for (const [name, d] of [['runter', [0, -1, 0]], ['+z', [0, 0, 1]], ['-z', [0, 0, -1]], ['+x', [1, 0, 0]], ['-x', [-1, 0, 0]], ['entlang Wand +', [0.0872, 0, -0.9962]], ['entlang Wand −', [-0.0872, 0, 0.9962]], ['weg von Wand', [-0.9962, 0, -0.0872]]] as const) {
    const e = p.clone().add(new Vector3(d[0], d[1], d[2]).multiplyScalar(4));
    const r = lv.world.traceBox(p, e, mins, maxs);
    console.log(`  ${name.padEnd(16)} frac ${r.fraction.toFixed(4)} normal ${r.normal.toArray().map((q) => q.toFixed(4)).join(',')} ${lv.brushes[r.brushIndex]?.tag ?? ''}`);
  }
}
