/**
 * Kritik-Linse LEVEL-FLOW — "Leertaste-Halter" genauer (ändert keinen Projektcode).
 *
 *   npx tsx tools/critique/level-flow/spaceholder.ts
 *
 * a) Flach: W ab t=0, Leertaste ab t=x gehalten → welches Tempo friert ein?
 * b) Level 1 Start → CP1 und Level 2 Start → Ring: W+Shift, Leertaste ab x s
 *    gehalten (Auto-Hop), Blick auf den nächsten Knoten, seitlicher Versatz.
 *    Wie viele Anläufe sterben, an welcher Lücke?
 */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { RunState } from '../../../src/engine/runState';
import type { RunEvent } from '../../../src/engine/events';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { yawOf } from '../../../src/player/bots';
import type { MutablePlayerInput } from '../../../src/player/types';
import { NO_INPUT } from '../../../src/player/types';
import { compileLevel, type CompiledLevel } from '../../../src/world/level/compileLevel';

const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;

function load(id: string): CompiledLevel {
  return compileLevel(JSON.parse(readFileSync(`public/levels/${id}.json`, 'utf8')));
}

// a) flach
{
  const lv = compileLevel({
    version: 1, id: 'flat', name: 'flat', spawn: { pos: [0, 0, 0], yaw: 0 }, killY: -2000,
    environment: {
      skyTop: '#000', skyHorizon: '#000', skyBottom: '#000', fogColor: '#000', fogNear: 0, fogFar: 1,
      sunDir: [0, 1, 0], sunColor: '#fff', ambientSky: '#fff', ambientGround: '#000', trimColor: '#fff', voidY: -2000,
    },
    brushes: [{ type: 'box', min: [-40000, -64, -40000], max: [40000, 0, 40000], mat: 'floor' }],
    triggers: [],
  });
  const row: string[] = [];
  for (const x of [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3]) {
    for (const sprint of [false, true]) {
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(new Vector3(0, 1, 0));
      const inp: MutablePlayerInput = { ...NO_INPUT };
      let first = -1;
      for (let k = 0; k < cfg.tickRate * 4; k++) {
        const t = k * DT;
        Object.assign(inp, NO_INPUT);
        inp.forward = 1;
        inp.sprint = sprint;
        inp.jumpHeld = t >= x;
        inp.jumpPressed = Math.abs(t - x) < DT / 2 || (x === 0 && k === 0);
        const ev = pm.tick(inp);
        if (first < 0 && ev.some((e) => e.type === 'jump')) first = t;
      }
      row.push(`Space ab ${x.toFixed(2)} s${sprint ? ' +Shift' : ''}: ${pm.state.speed.toFixed(0)} u/s nach 4 s`);
    }
  }
  console.log('=== a) Flach: W ab 0 s, Leertaste gehalten ab x ===');
  for (const r of row) console.log('  ' + r);
}

// b) Level-Starts
interface Probe {
  readonly id: string;
  readonly goalNode: number;
  readonly label: string;
}
const probes: Probe[] = [
  { id: 'level1', goalNode: 7, label: 'Level 1: Start → Rampe (Lauf 1-3)' },
  { id: 'level2', goalNode: 6, label: 'Level 2: Start → Ring (Anlauf-Hop-Linie)' },
];
for (const pr of probes) {
  const lv = load(pr.id);
  const route = lv.def.route ?? [];
  const goal = route[pr.goalNode].pos;
  let ok = 0;
  let total = 0;
  const deathBy: Record<string, number> = {};
  const crawl = { n: 0 };
  const buckets: Record<string, { ok: number; n: number }> = {};
  for (let x = 0; x <= 1.5 + 1e-9; x += 0.05) {
    for (const lateral of [-96, -48, 0, 48, 96]) {
      for (const sprint of [true, false]) {
        total++;
        const pm = new PlayerMovement(lv.world, cfg);
        const run = new RunState(lv);
        run.reset(null);
        const sp = lv.spawnPos;
        const yaw0 = (lv.spawnYaw * Math.PI) / 180;
        // seitlich versetzen (rechts vom Blick)
        const rx = Math.cos(yaw0);
        const rz = -Math.sin(yaw0);
        pm.teleport(new Vector3(sp.x + rx * lateral, sp.y + 1, sp.z + rz * lateral));
        const inp: MutablePlayerInput = { ...NO_INPUT };
        const evs: RunEvent[] = [];
        let node = 1;
        let result = 'timeout';
        for (let k = 0; k < cfg.tickRate * 20; k++) {
          const t = k * DT;
          const s = pm.state;
          // nächsten Knoten anpeilen (wie ein Mensch, der auf die nächste Plattform schaut)
          while (node < pr.goalNode) {
            const n = route[node].pos;
            if (Math.hypot(n[0] - s.pos.x, n[2] - s.pos.z) < 80 || (node > 0 && passed(route, node, s.pos))) node++;
            else break;
          }
          const n = route[node].pos;
          Object.assign(inp, NO_INPUT);
          inp.yaw = yawOf(n[0] - s.pos.x, n[2] - s.pos.z);
          inp.forward = 1;
          inp.sprint = sprint;
          inp.jumpHeld = t >= x;
          inp.jumpPressed = Math.abs(t - x) < DT / 2;
          pm.tick(inp);
          const o = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
          if (o === 'fall' || o === 'kill') {
            const lbl = route
              .slice(0, node + 1)
              .reverse()
              .find((q) => q.note)?.note ?? '?';
            result = `tot vor ${lbl}`;
            break;
          }
          if (Math.hypot(goal[0] - s.pos.x, goal[2] - s.pos.z) < 96 && Math.abs(goal[1] - s.pos.y) < 64) {
            result = 'ok';
            break;
          }
        }
        const bucket = `${x < 0.2 ? 'x<0.2' : 'x>=0.2'}${sprint ? '+Shift' : ''}`;
        (buckets[bucket] ??= { ok: 0, n: 0 }).n++;
        if (result === 'ok') buckets[bucket].ok++;
        if (result === 'ok') ok++;
        else deathBy[result] = (deathBy[result] ?? 0) + 1;
        if (result === 'timeout') crawl.n++;
      }
    }
  }
  console.log(`\n=== b) ${pr.label}: Leertaste ab 0…1.5 s gehalten × seitlich ±96 × mit/ohne Shift ===`);
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v.ok}/${v.n} durch`);
  console.log(`  durch: ${ok}/${total} (${((100 * ok) / total).toFixed(0)} %)  ${JSON.stringify(deathBy)}`);
}

function passed(route: readonly { pos: readonly number[] }[], i: number, p: Vector3): boolean {
  const a = route[i - 1].pos;
  const b = route[i].pos;
  const sx = b[0] - a[0];
  const sz = b[2] - a[2];
  const l2 = sx * sx + sz * sz;
  if (l2 < 1) return false;
  return ((p.x - a[0]) * sx + (p.z - a[2]) * sz) / l2 >= 1;
}
