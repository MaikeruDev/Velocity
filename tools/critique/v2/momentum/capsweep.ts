/**
 * Cap-Sweep gegen die Test-Grenzen: perfekter Bot ab 250 (tests/movement.test.ts: H5 640–700, H10 820–880,
 * H20 ≤ 1140 = Decke +5 %) und Anfänger-Hände ab 320 (Median 8 Seeds): Zeit bis 500 u/s, H10.
 * npx tsx tools/critique/v2/momentum/capsweep.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { flatLevel } from '../../../sim/levels';
import { f, stats } from './common';

const FLAT = compileLevel(flatLevel(40000));
function lands(cfg: MovementConfig, v0: number, aim: number, seed: number, n = 20): { l: number[]; t500: number } {
  const pm = new PlayerMovement(FLAT.world, cfg);
  pm.teleport(new Vector3(0, 0, 30000));
  pm.state.vel.set(0, 0, -v0);
  const bot = new StrafeBot(cfg, aim > 0 ? { heading: 0, aimNoiseDeg: aim, seed: seed * 7919 } : { heading: 0, sync: 1 });
  const l: number[] = [];
  let t500 = 99;
  for (let t = 0; t < 30 * cfg.tickRate && l.length < n; t++) {
    for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land') l.push(e.speed);
    if (t500 === 99 && pm.state.speed >= 500) t500 = t / cfg.tickRate;
  }
  return { l, t500 };
}
const combos: Array<[number, number, number]> = [
  [32, 350, 700], [36, 350, 700], [40, 350, 700], [40, 300, 600], [40, 350, 600], [40, 400, 600], [44, 300, 550], [44, 350, 550], [38, 350, 650], [40, 330, 620],
];
console.log('| low/from/to | perfekt ab 250 H5/H10/H20 (Test 640–700 / 820–880 / ≤1140) | 3° H10 · t500 | 4° H10 · t500 | 5° H10 · t500 | 6° H10 · t500 |');
console.log('|---|---|---|---|---|---|');
for (const [low, from, to] of combos) {
  const cfg = withMovement(VELOCITY_DEFAULT, { airSpeedCapLow: low, airSpeedCapFadeFrom: from, airSpeedCapFadeTo: to });
  const p = lands(cfg, 250, 0, 1).l;
  const ok = p[4] > 640 && p[4] < 700 && p[9] > 820 && p[9] < 880 && p[19] <= 1140;
  const hands = [3, 4, 5, 6].map((aim) => {
    const rs = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => lands(cfg, 320, aim, s));
    const h10 = stats(rs.map((r) => r.l[9] ?? NaN)).med;
    const t = rs.map((r) => r.t500).sort((a, b) => a - b);
    const med = 0.5 * (t[3] + t[4]);
    const reached = t.filter((x) => x < 99).length;
    return `${f(h10)} · ${med < 99 ? `${f(med, 1)} s` : `–`} (${reached}/8)`;
  });
  console.log(`| ${low}/${from}/${to} | ${f(p[4])}/${f(p[9])}/${f(p[19])} ${ok ? '✓' : '✗'} | ${hands.join(' | ')} |`);
}
