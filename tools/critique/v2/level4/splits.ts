/**
 * Level 4 — Splits je Bot-Modell (Spiel-Uhr, wie physics.timedRun, aber mit Zwischenzeiten
 * an jedem Checkpoint und Tempo an markierten Knoten). Zeigt, wo sich Können auszahlt.
 *   npx tsx tools/critique/v2/level4/splits.ts
 */
import { Vector3 } from 'three';
import { writeFileSync } from 'node:fs';
import { RunState } from '../../../../src/engine/runState';
import type { RunEvent } from '../../../../src/engine/events';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../../src/world/level/LevelFormat';
import { resumeIndex, type StrafeModel } from '../../../levels/physics';
import { buildLevel4 } from './level4';

const cfg = VELOCITY_DEFAULT;
export function splits(def: LevelFile, model: StrafeModel, seed: number): { cps: number[]; fin: number | null; deaths: number; vmax: number[]; vAt: Record<string, number> } {
  const lv = compileLevel(def);
  const route = def.route ?? [];
  const pm = new PlayerMovement(lv.world, cfg);
  const run = new RunState(lv);
  run.reset(null);
  const events: RunEvent[] = [];
  const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const mk = (from: number, p: Vector3): RouteFollower =>
    new RouteFollower(route.slice(from), cfg, { ...model, seed, killY: def.killY, world: lv.world, start: { x: p.x, z: p.z }, stallTimeout: 12, timeout: 181 });
  pm.teleport(new Vector3(lv.spawnPos.x, lv.spawnPos.y + 1, lv.spawnPos.z));
  let bot = mk(0, lv.spawnPos);
  let from = 0;
  let deaths = 0;
  const cpT: number[] = [];
  const vmax: number[] = [0];
  const vAt: Record<string, number> = {};
  for (let t = 0; t < 180 * cfg.tickRate; t++) {
    pm.tick(bot.next(pm.state, pm.surfNormal));
    const s = pm.state;
    const prevCp = run.checkpoint;
    const out = run.tick(1 / cfg.tickRate, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, events);
    if (run.checkpoint > prevCp) {
      cpT[run.checkpoint - 1] = run.time ?? Number.NaN;
      vAt[`CP${run.checkpoint}`] = s.speed;
      vmax.push(0);
    }
    vmax[vmax.length - 1] = Math.max(vmax[vmax.length - 1], s.speed);
    const node = route[from + bot.nextIndex - 1];
    if (node?.note && vAt[node.note] === undefined) vAt[node.note] = s.speed;
    if (out === 'finish') return { cps: cpT, fin: run.time, deaths, vmax, vAt };
    if (out === 'fall' || out === 'kill') {
      deaths++;
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      pm.teleport(new Vector3(sp.pos.x, sp.pos.y + 1, sp.pos.z));
      from = run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0;
      bot = mk(from, sp.pos);
      continue;
    }
    if (bot.status === 'failed') return { cps: cpT, fin: null, deaths, vmax, vAt };
  }
  return { cps: cpT, fin: null, deaths, vmax, vAt };
}

if (process.argv[1]?.endsWith('splits.ts')) {
  const def = buildLevel4({ measure: true });
  const models: Array<[string, StrafeModel]> = [['sync 1.0', { sync: 1 }], ['Hand 1°', { aimNoiseDeg: 1 }], ['Hand 2°', { aimNoiseDeg: 2 }], ['Hand 3°', { aimNoiseDeg: 3 }], ['sync 0.8', { sync: 0.8 }]];
  const lines: string[] = [];
  const keys = ['E1 Wendel', 'CP1', 'Graben 1', 'Graben 3', 'CP2', 'Kante 1', 'Kante 3', 'CP3', 'Steg', 'Krone', 'CP4', 'CP5', 'Launch'];
  lines.push(`| Modell | ${['CP1', 'CP2', 'CP3', 'CP4', 'CP5', 'Ziel'].join(' | ')} | Tempo an: ${keys.join(' / ')} |`);
  for (const [name, m] of models) {
    const rs = [1, 2, 3, 4, 5, 6, 7, 8].map((sd) => splits(def, m, sd));
    const med = (xs: number[]): number => { const a = xs.filter(Number.isFinite).sort((p, q) => p - q); return a[Math.floor((a.length - 1) / 2)] ?? NaN; };
    const cps = [0, 1, 2, 3, 4].map((i) => med(rs.map((r) => r.cps[i] ?? NaN)));
    const fin = med(rs.map((r) => r.fin ?? NaN));
    const v = keys.map((k) => med(rs.map((r) => r.vAt[k] ?? NaN)).toFixed(0));
    lines.push(`| ${name} | ${cps.map((x) => x.toFixed(2)).join(' | ')} | ${fin.toFixed(2)} | ${v.join(' / ')} | Tode ${rs.reduce((a, r) => a + r.deaths, 0)}`);
  }
  console.log(lines.join('\n'));
  writeFileSync('shots/v2/level4/splits.md', lines.join('\n') + '\n');
}
