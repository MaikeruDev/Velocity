/**
 * Kritiker-Linse "Movement-Kurven": Surf-Blickfenster auf der echten L2-Kette.
 * Grundtechnik-Surfer (Taste in die Rampe, Blick entlang Achse + Offset) ab CP2,
 * Sweep über Offset und airAccelerate. Plus Stall-Analyse (+10°).
 * npx tsx tools/critique/movement-curves/surf.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { compileLevel } from '../../../src/world/level/compileLevel';
import { readLevelFile } from '../../sim/levels';
import { SurfRider, routeAxis } from '../../levels/physics';
import { mulberry32, gaussian } from '../../../src/player/bots/Bot';
import type { PlayerInput } from '../../../src/player/types';

const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');
const L2 = compileLevel(readLevelFile('public/levels/level2.json'));
const route = L2.def.route ?? [];
const axisAt = routeAxis(route);
const cp2 = L2.triggers.find((t) => t.kind === 'checkpoint' && t.order === 2);
if (!cp2) throw new Error('cp2');

interface Res { end: string; exit: number; time: number; surfT: number; stall: boolean }

function ride(cfg: MovementConfig, offDeg: number, noiseDeg = 0, seed = 1): Res {
  const pm = new PlayerMovement(L2.world, cfg);
  pm.teleport(cp2!.spawnPos.clone().add(new Vector3(0, 1, 0)));
  const rider = new SurfRider(cfg, L2.world, axisAt, (offDeg * Math.PI) / 180);
  const rand = mulberry32(seed);
  let aim = 0;
  const k = Math.exp(-1 / (0.15 * cfg.tickRate));
  let surfT = 0;
  let lastZ = pm.state.pos.z;
  let stallTicks = 0;
  for (let t = 0; t < 25 * cfg.tickRate; t++) {
    const base = rider.next(pm.state, pm.surfNormal);
    aim = aim * k + gaussian(rand) * noiseDeg * Math.PI / 180 * Math.sqrt(1 - k * k);
    const inp: PlayerInput = { ...base, yaw: base.yaw + (pm.state.onGround ? 0 : aim) };
    pm.tick(inp);
    const s = pm.state;
    if (s.surfing) surfT++;
    if (t % 128 === 0) {
      if (Math.abs(s.pos.z - lastZ) < 30 && s.pos.z < -1400) stallTicks++;
      lastZ = s.pos.z;
    }
    if (s.pos.z < -7300) return { end: 'Launch', exit: s.speed, time: t / cfg.tickRate, surfT: surfT / cfg.tickRate, stall: false };
    if (s.pos.y < -2500) return { end: `fällt z${f(s.pos.z)}`, exit: s.speed, time: t / cfg.tickRate, surfT: surfT / cfg.tickRate, stall: false };
    for (const kz of L2.triggers) {
      if (kz.kind !== 'kill') continue;
      const b = kz.bounds;
      if (s.pos.x > b.min.x && s.pos.x < b.max.x && s.pos.y > b.min.y && s.pos.y < b.max.y && s.pos.z > b.min.z && s.pos.z < b.max.z) {
        return { end: `kill z${f(s.pos.z)}`, exit: s.speed, time: t / cfg.tickRate, surfT: surfT / cfg.tickRate, stall: false };
      }
    }
  }
  return { end: `Stillstand z${f(pm.state.pos.z)} y${f(pm.state.pos.y)} v${f(pm.state.speed)}`, exit: pm.state.speed, time: 25, surfT: surfT / cfg.tickRate, stall: stallTicks > 3 };
}

const presets: Array<[string, MovementConfig]> = [
  ['aa40 (Default)', VELOCITY_DEFAULT],
  ['aa25', withMovement(VELOCITY_DEFAULT, { airAccelerate: 25 })],
  ['aa20', withMovement(VELOCITY_DEFAULT, { airAccelerate: 20 })],
  ['aa12', withMovement(VELOCITY_DEFAULT, { airAccelerate: 12 })],
  ['aa100', withMovement(VELOCITY_DEFAULT, { airAccelerate: 100 })],
];

console.log('## Surf-Blickfenster L2 ab CP2 bis Launch (Grundtechnik-Surfer)\n');
console.log('Zelle: Ergebnis · Launch-Speed · Zeit. Offset > 0 = Blick zur Rampe hin (Taste bleibt in die Rampe).\n');
const offs = [-4, -2, -1, 0, 1, 2, 3, 5, 7, 10];
console.log(`| Preset | ${offs.map((o) => `${o}°`).join(' | ')} |`);
console.log(`|---|${offs.map(() => '---').join('|')}|`);
for (const [name, cfg] of presets) {
  const cells = offs.map((o) => {
    const r = ride(cfg, o);
    return r.end === 'Launch' ? `${f(r.exit)} · ${f(r.time, 1)}s` : r.end.startsWith('Stillstand') ? `STALL` : `${r.end}`;
  });
  console.log(`| ${name} | ${cells.join(' | ')} |`);
}

console.log('\n## Surf mit zitternder Hand (AR(1)-Blickfehler 1σ, Offset 0), 6 Seeds\n');
console.log('| Preset | 1° | 2° | 3° |');
console.log('|---|---|---|---|');
for (const [name, cfg] of presets.slice(0, 4)) {
  const cells = [1, 2, 3].map((n) => {
    let ok = 0;
    let sum = 0;
    for (let s = 1; s <= 6; s++) {
      const r = ride(cfg, 0, n, s * 31);
      if (r.end === 'Launch') { ok++; sum += r.exit; }
    }
    return `${ok}/6 · Ø ${f(ok ? sum / ok : NaN)}`;
  });
  console.log(`| ${name} | ${cells.join(' | ')} |`);
}

console.log('\n## Stall-Analyse Default +10° (Zustand jede Sekunde)\n');
{
  const cfg = VELOCITY_DEFAULT;
  const pm = new PlayerMovement(L2.world, cfg);
  pm.teleport(cp2.spawnPos.clone().add(new Vector3(0, 1, 0)));
  const rider = new SurfRider(cfg, L2.world, axisAt, (10 * Math.PI) / 180);
  const rows: string[] = [];
  for (let t = 1; t <= 6 * cfg.tickRate; t++) {
    pm.tick(rider.next(pm.state, pm.surfNormal));
    if (t % 64 === 0) {
      const s = pm.state;
      rows.push(`t=${f(t / cfg.tickRate, 1)} pos(${f(s.pos.x)},${f(s.pos.y)},${f(s.pos.z)}) vel(${f(s.vel.x)},${f(s.vel.y)},${f(s.vel.z)}) surfing=${s.surfing} ground=${s.onGround}`);
    }
  }
  console.log(rows.join('\n'));
  // Und: Blick danach wieder auf 0° — kommt man aus dem Stand los?
  const rider0 = new SurfRider(cfg, L2.world, axisAt, 0);
  let t = 0;
  for (; t < 10 * cfg.tickRate; t++) {
    pm.tick(rider0.next(pm.state, pm.surfNormal));
    if (pm.state.speed > 300) break;
  }
  console.log(`danach Blick 0°: 300 u/s nach ${f(t / cfg.tickRate, 2)} s (z${f(pm.state.pos.z)})`);
}
