/**
 * Tempo-Gefühl 300–600 u/s (wo Anfänger leben): Luft-Cap-Varianten gegen absolute Menschenmodelle.
 * npx tsx tools/critique/v2/momentum/feel.ts
 *
 * StrafeBot mit Zielfehler n° (AR(1), wie movement-tuning.md), Start 320 (Sprint), flach, 8 Seeds.
 * Ausgabe je Hand: Landetempo H3/H5/H10/H20 (Median) und Zeit bis 400/500/600 u/s (Median, "–" = nie in 20 Hops).
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { flatLevel } from '../../../sim/levels';
import { f, stats } from './common';

const FLAT = compileLevel(flatLevel(40000));

function run(cfg: MovementConfig, aim: number, seed: number): { lands: number[]; tReach: Record<number, number> } {
  const pm = new PlayerMovement(FLAT.world, cfg);
  pm.teleport(new Vector3(0, 0, 30000));
  pm.state.vel.set(0, 0, -cfg.sprintSpeed);
  const bot = new StrafeBot(cfg, aim > 0 ? { heading: 0, aimNoiseDeg: aim, seed: seed * 7919 } : { heading: 0 });
  const lands: number[] = [];
  const tReach: Record<number, number> = { 400: NaN, 500: NaN, 600: NaN };
  for (let t = 0; t < 30 * cfg.tickRate && lands.length < 20; t++) {
    for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land') lands.push(e.speed);
    for (const k of [400, 500, 600]) if (Number.isNaN(tReach[k]) && pm.state.speed >= k) tReach[k] = t / cfg.tickRate;
  }
  return { lands, tReach };
}

const VARIANTS: Array<[string, Partial<MovementConfig>]> = [
  ['jetzt 32/350/700', {}],
  ['36/350/700', { airSpeedCapLow: 36 }],
  ['40/350/700', { airSpeedCapLow: 40 }],
  ['32/450/800', { airSpeedCapFadeFrom: 450, airSpeedCapFadeTo: 800 }],
  ['36/450/800', { airSpeedCapLow: 36, airSpeedCapFadeFrom: 450, airSpeedCapFadeTo: 800 }],
  ['44/350/550', { airSpeedCapLow: 44, airSpeedCapFadeFrom: 350, airSpeedCapFadeTo: 550 }],
  ['40/400/600', { airSpeedCapLow: 40, airSpeedCapFadeFrom: 400, airSpeedCapFadeTo: 600 }],
];

console.log('\n## Tempo-Gefühl: Landetempo H3/H5/H10/H20 · Zeit bis 400/500/600 u/s (Median 8 Seeds, Start 320)\n');
console.log(`| Hand | ${VARIANTS.map(([n]) => n).join(' | ')} |`);
console.log(`|---|${VARIANTS.map(() => '---').join('|')}|`);
for (const aim of [0, 2, 3, 4, 5, 6]) {
  const cols: string[] = [];
  for (const [, patch] of VARIANTS) {
    const cfg = withMovement(VELOCITY_DEFAULT, patch);
    const seeds = aim > 0 ? [1, 2, 3, 4, 5, 6, 7, 8] : [1];
    const H: number[][] = [[], [], [], []];
    const T: number[][] = [[], [], []];
    for (const s of seeds) {
      const r = run(cfg, aim, s);
      [2, 4, 9, 19].forEach((i, k) => H[k].push(r.lands[i] ?? NaN));
      [400, 500, 600].forEach((v, k) => T[k].push(Number.isNaN(r.tReach[v]) ? 99 : r.tReach[v]));
    }
    const h = H.map((xs) => f(stats(xs).med)).join('/');
    const t = T.map((xs) => {
      const m = stats(xs).med;
      return m >= 50 ? '–' : f(m, 1);
    }).join('/');
    cols.push(`${h} · ${t} s`);
  }
  console.log(`| ${aim === 0 ? 'perfekt' : `${aim}°`} | ${cols.join(' | ')} |`);
}
