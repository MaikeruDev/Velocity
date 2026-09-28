/**
 * Trainingsmodus-Entwurf (v2/training) — Urteile des StrafeJudge bei Tempo (Coach in normalen Leveln):
 * StrafeBot perfekt / 1° / 2° / 3° Zielfehler, zigzag, 20 Hops ab 320 u/s, 8 Seeds.
 * Frage: Welche Gewinn-Schwelle trennt "gut" bei hohem Tempo? (GOOD_GAIN 8 gilt bei 320 u/s.)
 *   npx tsx tools/critique/v2/training/judgehigh.ts
 */
import { writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { flatLevel } from '../../../sim/levels';
import { StrafeJudge } from './trainingProto';

const CFG = VELOCITY_DEFAULT;
const lv = compileLevel(flatLevel(80000));
const bands = [[300, 450], [450, 600], [600, 800], [800, 1000], [1000, 1300]] as const;
const out: Record<string, unknown> = {};
for (const [name, opts] of [
  ['perfekt', { sync: 1 }],
  ['Hand 1°', { aimNoiseDeg: 1 }],
  ['Hand 2°', { aimNoiseDeg: 2 }],
  ['Hand 3°', { aimNoiseDeg: 3 }],
] as const) {
  const gains: Record<string, number[]> = {};
  const verdicts: Record<string, Record<string, number>> = {};
  for (let seed = 1; seed <= 8; seed++) {
    const pm = new PlayerMovement(lv.world, CFG);
    pm.state.vel.set(0, 0, -320);
    pm.teleport(new Vector3(0, 0.01, 70000), { keepVelocity: true });
    const bot = new StrafeBot(CFG, { ...opts, seed, mode: 'zigzag', heading: 0 });
    const judge = new StrafeJudge();
    judge.onHop = (r) => {
      const b = bands.find(([lo, hi]) => r.takeoffSpeed >= lo && r.takeoffSpeed < hi);
      if (!b) return;
      const k = `${b[0]}-${b[1]}`;
      (gains[k] ??= []).push(r.gain);
      const v = (verdicts[k] ??= {});
      v[r.verdict] = (v[r.verdict] ?? 0) + 1;
    };
    const prev = PlayerMovement.createSnapshot();
    const cur = PlayerMovement.createSnapshot();
    for (let i = 0; i < 40 * 128; i++) {
      const cmd = bot.next(pm.state);
      pm.copySnapshot(prev);
      pm.tick(cmd);
      pm.copySnapshot(cur);
      judge.tick(1 / 128, prev, cur, cmd);
      if (pm.state.speed > 1300) break;
    }
  }
  const line: string[] = [];
  for (const [lo, hi] of bands) {
    const k = `${lo}-${hi}`;
    const g = (gains[k] ?? []).slice().sort((a, b) => a - b);
    if (g.length === 0) continue;
    const q = (p: number): number => g[Math.min(g.length - 1, Math.floor(p * g.length))];
    const v = verdicts[k];
    line.push(`${k}: n ${g.length}, Gewinn p10/p50 ${q(0.1).toFixed(0)}/${q(0.5).toFixed(0)}, gut ${Math.round(((v.good ?? 0) / g.length) * 100)} %, ${Object.entries(v).filter(([x]) => x !== 'good').map(([x, c]) => `${x} ${c}`).join(' ')}`);
  }
  console.log(`${name}\n  ${line.join('\n  ')}`);
  out[name] = { gains, verdicts };
}
writeFileSync('shots/v2/training/judgehigh.json', JSON.stringify(out));
