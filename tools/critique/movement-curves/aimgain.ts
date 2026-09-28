/**
 * Gewinn pro Hop bei 3–6° absolutem Zielfehler (StrafeBot aimNoiseDeg), Start 320 (Sprint),
 * Mittel über 8 Seeds. VELOCITY vs. CS2.
 * npx tsx tools/critique/movement-curves/aimgain.ts
 */
import { Vector3 } from 'three';
import { CS2_CLASSIC, VELOCITY_DEFAULT, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../src/player/bots';
import { flatWorld } from '../../sim/scenarios';

function run(cfg: MovementConfig, aim: number, seed: number, n: number): number[] {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 12000));
  pm.state.vel.set(0, 0, -320);
  const bot = new StrafeBot(cfg, aim > 0 ? { aimNoiseDeg: aim, seed, heading: 0 } : { heading: 0 });
  const out: number[] = [];
  for (let t = 0; t < 40 * cfg.tickRate && out.length < n; t++) for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land') out.push(e.speed);
  return out;
}
console.log('| Preset | Zielfehler | H1 | H2 | H3 | H5 | H10 | Ø Gewinn/Hop H1–H3 | Sättigung (H20) |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [name, cfg] of [['VELOCITY', VELOCITY_DEFAULT], ['CS2', CS2_CLASSIC]] as const) {
  for (const aim of [0, 3, 4, 5, 6]) {
    const acc = new Array(20).fill(0);
    const seeds = aim > 0 ? 8 : 1;
    for (let s = 1; s <= seeds; s++) { const r = run(cfg, aim, s * 997, 20); for (let i = 0; i < 20; i++) acc[i] += r[i] / seeds; }
    const g = (acc[2] - 320) / 3;
    console.log(`| ${name} | ${aim === 0 ? 'perfekt' : aim + '°'} | ${acc[0].toFixed(0)} | ${acc[1].toFixed(0)} | ${acc[2].toFixed(0)} | ${acc[4].toFixed(0)} | ${acc[9].toFixed(0)} | +${g.toFixed(0)} (${((g / 320) * 100).toFixed(0)} %) | ${acc[19].toFixed(0)} |`);
  }
}
