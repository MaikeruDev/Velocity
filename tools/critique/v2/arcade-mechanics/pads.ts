/**
 * JUMP-PADS, BOOST-PADS, SPEED-RINGE — Messung gegen die echte Engine (Prototyp, kein Projektcode).
 *   npx tsx tools/critique/v2/arcade-mechanics/pads.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { RunState } from '../../../../src/engine/runState';
import type { RunEvent } from '../../../../src/engine/events';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { RouteFollower, StrafeBot } from '../../../../src/player/bots';
import type { PlayerInput } from '../../../../src/player/types';
import { NO_INPUT } from '../../../../src/player/types';
import { compileLevel, type CompiledLevel } from '../../../../src/world/level/compileLevel';
import { flatLevel, readLevelFile } from '../../../sim/levels';
import { resumeIndex } from '../../../levels/physics';
import { ArcadeMovement, arcadeStats, type ArcadeOpts, type PadDef, type RingDef } from './ArcadeMovement';

const OUT = 'shots/v2/arcade-mechanics';
mkdirSync(OUT, { recursive: true });
const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;
const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');
const result: Record<string, unknown> = {};
const flat = compileLevel(flatLevel());

// ---------------------------------------------------------------- P1 Jump-Pad auf flachem Boden
function p1(): void {
  console.log('\n## P1 Jump-Pad (flach, 128×128, setzt vy): Höhe, Luftzeit, Tempo bei der Landung — je Fahrer (Start 320 am Boden, Pad 200 u voraus)\n');
  console.log('| vy | Höhe | Luftzeit | W gehalten | perfekter Strafer | 3°-Hand | 5°-Hand | Vergleich: normaler Hop perfekt / 3° |');
  console.log('|---|---|---|---|---|---|---|---|');
  const rows: unknown[] = [];
  for (const vy of [500, 650, 800]) {
    const pad: PadDef = { kind: 'jump', bounds: new Box3(new Vector3(-64, -2, -264), new Vector3(64, 4, -136)), vy };
    const cells: string[] = [];
    let air = 0;
    let top = 0;
    for (const who of ['W', 0, 3, 5] as Array<'W' | number>) {
      const pm = new ArcadeMovement(flat.world, cfg, { pads: [pad] });
      pm.teleport(new Vector3(0, 1, 0));
      for (let k = 0; k < 20; k++) {
        pm.state.vel.set(0, pm.state.vel.y, -320);
        pm.tick({ ...NO_INPUT, forward: 1, sprint: true });
      }
      const bot = typeof who === 'number' ? new StrafeBot(cfg, { aimNoiseDeg: who, seed: 4, heading: 0 }) : null;
      let launched = -1;
      let y0 = pm.state.pos.y;
      let maxY = y0;
      let vLand = NaN;
      let vTake = NaN;
      for (let k = 0; k < 5 * cfg.tickRate; k++) {
        let inp: PlayerInput;
        if (launched < 0) inp = { ...NO_INPUT, forward: 1, sprint: true };
        else if (bot) {
          const b = bot.next(pm.state);
          inp = { ...b, jumpPressed: false, jumpHeld: false };
        } else inp = { ...NO_INPUT, forward: 1, sprint: true };
        pm.tick(inp);
        const s = pm.state;
        if (launched < 0 && pm.arcade.padHits > 0) {
          launched = k;
          y0 = s.pos.y;
          vTake = s.speed;
        }
        if (launched >= 0) {
          maxY = Math.max(maxY, s.pos.y);
          if (s.onGround && k > launched + 2) {
            vLand = s.speed;
            air = (k - launched) * DT;
            break;
          }
        }
      }
      top = maxY - y0;
      cells.push(`${f(vTake)} → ${f(vLand)}`);
    }
    // normaler Hop zum Vergleich
    const hop = (aim: number): string => {
      const pm = new PlayerMovement(flat.world, cfg);
      pm.teleport(new Vector3(0, 1, 0));
      for (let k = 0; k < 20; k++) {
        pm.state.vel.set(0, pm.state.vel.y, -320);
        pm.tick({ ...NO_INPUT, forward: 1, sprint: true });
      }
      const bot = new StrafeBot(cfg, { aimNoiseDeg: aim, seed: 4, heading: 0 });
      let jumped = false;
      for (let k = 0; k < 3 * cfg.tickRate; k++) {
        const b = bot.next(pm.state);
        const ev = pm.tick(jumped ? { ...b, jumpPressed: false, jumpHeld: false } : { ...b, jumpPressed: true, jumpHeld: true });
        if (ev.some((e) => e.type === 'jump')) jumped = true;
        if (jumped && pm.state.onGround) return `${f(pm.state.speed)}`;
      }
      return '–';
    };
    rows.push({ vy, top, air, cells });
    console.log(`| ${vy} | ${f(top)} u | ${f(air, 2)} s | ${cells[0]} | ${cells[1]} | ${cells[2]} | ${cells[3]} | 320 → ${hop(0)} / ${hop(3)} |`);
  }
  result.p1 = rows;
}

// ---------------------------------------------------------------- P2 Boost-Pad am Checkpoint-Respawn (L1)
function p2(): void {
  console.log('\n## P2 Boost-Pad (Mindesttempo entlang der Route) auf jedem CP-Spawn in L1 — RouteFollower aus dem Stand bis zum nächsten CP (8 Seeds)\n');
  const lv = compileLevel(readLevelFile('public/levels/level1.json'));
  const route = lv.def.route ?? [];
  const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const rows: unknown[] = [];
  for (const cp of cps) {
    const from = resumeIndex(route, cp);
    const next = route[Math.min(route.length - 1, from + 1)].pos;
    const dir = new Vector3(next[0] - cp.spawnPos.x, 0, next[2] - cp.spawnPos.z).normalize();
    for (const floor of [0, 450, 600]) {
      const pads: PadDef[] = floor
        ? [{ kind: 'boost', mode: 'floor', speed: floor, dir, bounds: new Box3(cp.spawnPos.clone().add(new Vector3(-48, -2, -48)).addScaledVector(dir, 64), cp.spawnPos.clone().add(new Vector3(48, 8, 48)).addScaledVector(dir, 64)) }]
        : [];
      for (const model of [{ aimNoiseDeg: 3 }, { sync: 0.8 }, { sync: 1 }]) {
        let ok = 0;
        const times: number[] = [];
        const fails: string[] = [];
        for (let seed = 1; seed <= 8; seed++) {
          const pm = new ArcadeMovement(lv.world, cfg, { pads });
          pm.teleport(new Vector3(cp.spawnPos.x, cp.spawnPos.y + 1, cp.spawnPos.z));
          const rf = new RouteFollower(route.slice(from), cfg, { ...model, seed, world: lv.world, start: { x: cp.spawnPos.x, z: cp.spawnPos.z }, killY: lv.def.killY });
          const run = new RunState(lv);
          run.reset(null);
          // Laufzustand: CP bereits erreicht (für "nächster CP").
          const evs: RunEvent[] = [];
          let out = 'timeout';
          let t = 0;
          let started = false;
          for (let k = 0; k < cfg.tickRate * 60; k++) {
            pm.tick(rf.next(pm.state, pm.surfNormal));
            const s = pm.state;
            if (!started && s.speed > 1) started = true;
            if (started) t += DT;
            const hmin = s.pos.clone().add(pm.hullMins);
            const hmax = s.pos.clone().add(pm.hullMaxs);
            const goal = cps.find((c) => c.order === cp.order + 1) ?? lv.triggers.find((x) => x.kind === 'finish');
            if (goal && goal.bounds.intersectsBox(new Box3(hmin, hmax))) { out = 'ok'; break; }
            const o = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
            if (o === 'fall' || o === 'kill') { out = o; break; }
            if (rf.status === 'failed') { out = `bot:${rf.report.reason}`; break; }
          }
          if (out === 'ok') { ok++; times.push(t); } else fails.push(`s${seed}:${out}`);
        }
        times.sort((a, b) => a - b);
        const med = times.length ? times[Math.floor((times.length - 1) / 2)] : NaN;
        rows.push({ cp: cp.order, floor, model, ok, med, fails });
        console.log(`- CP${cp.order} Pad ${floor || 'aus'} ${JSON.stringify(model).padEnd(18)} ${ok}/8, Median ${f(med, 2)} s ${fails.join(' ')}`);
      }
    }
  }
  result.p2 = rows;
}

// ---------------------------------------------------------------- P3 Speed-Ringe in der L1-Hop-Reihe
function p3(): void {
  console.log('\n## P3 Speed-Ringe in der L1-Hop-Reihe (Ring im Scheitel zwischen je zwei Plattformen, Radius r, +40 u/s bis 1000): Treffer je Lauf / Tempo an der Crouch-Kante (RouteFollower ab CP1, 8 Seeds)\n');
  const lv = compileLevel(readLevelFile('public/levels/level1.json'));
  const route = lv.def.route ?? [];
  const cp1 = lv.triggers.find((t) => t.kind === 'checkpoint' && t.order === 1);
  if (!cp1) throw new Error('cp1');
  const from = resumeIndex(route, cp1);
  const hop = route.map((n, i) => ({ n, i })).filter((x) => x.i >= 9 && x.i <= 16);
  const rows: unknown[] = [];
  for (const radius of [0, 64, 96, 128]) {
    const rings: RingDef[] = [];
    if (radius) for (let k = 0; k + 1 < hop.length; k++) {
      const a = hop[k].n.pos;
      const b = hop[k + 1].n.pos;
      rings.push({ center: new Vector3((a[0] + b[0]) / 2, a[1] + 50 + 36, (a[2] + b[2]) / 2), normal: new Vector3(0, 0, -1), radius, add: 40, cap: 1000 });
    }
    for (const model of [{ sync: 1 }, { aimNoiseDeg: 2 }, { aimNoiseDeg: 3 }]) {
      let hits = 0;
      let vEdge = 0;
      let n = 0;
      let dead = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const opts: ArcadeOpts = { rings };
        const pm = new ArcadeMovement(lv.world, cfg, opts);
        pm.teleport(new Vector3(cp1.spawnPos.x, cp1.spawnPos.y + 1, cp1.spawnPos.z));
        const rf = new RouteFollower(route.slice(from), cfg, { ...model, seed, world: lv.world, start: { x: cp1.spawnPos.x, z: cp1.spawnPos.z }, killY: lv.def.killY });
        for (let k = 0; k < cfg.tickRate * 30; k++) {
          pm.tick(rf.next(pm.state, pm.surfNormal));
          const s = pm.state;
          if (s.pos.z < -5114 && s.onGround && Math.abs(s.pos.y - 128) < 2) { vEdge += s.speed; n++; break; }
          if (s.pos.y < 40) { dead++; break; }
        }
        hits += arcadeStats(pm).ringHits;
      }
      rows.push({ radius, model, hits: hits / 8, vEdge: vEdge / Math.max(1, n), dead });
      console.log(`- Radius ${radius || '—'} ${JSON.stringify(model).padEnd(18)} Ringe ${f(hits / 8, 1)}/${rings.length} je Lauf · Tempo H7 Ø ${f(vEdge / Math.max(1, n))} · Graben ${dead}`);
    }
  }
  result.p3 = rows;
}

p1();
p3();
p2();
writeFileSync(`${OUT}/pads.json`, JSON.stringify(result, null, 2));
console.log(`\n→ ${OUT}/pads.json`);
