/**
 * Kritik-Linse LEVEL-FLOW — Veteranen-Sicht (ändert keinen Projektcode).
 *
 *   npx tsx tools/critique/level-flow/veteran.ts
 *
 * a) Abschnitts-Profil (perfekter Bot, Hand 2°): Zeit, Ø-Speed, Bodenzeit,
 *    Sprünge, längste Phase ohne Eingabe-Entscheidung (Fall/Flug/Surf ohne Wechsel).
 * b) Könner-Inseln L1: Route über cut1..3 statt Kehren-Pads 2..5 — spart das Zeit?
 * c) Wie oft trifft sync 1.0 / Hand 2° die Meilensteine 500/750/1000?
 */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { RunState } from '../../../src/engine/runState';
import type { RunEvent } from '../../../src/engine/events';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../src/player/bots';
import { compileLevel, type CompiledLevel } from '../../../src/world/level/compileLevel';
import type { BrushDef, LevelFile, RouteNode } from '../../../src/world/level/LevelFormat';

const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;

function loadFile(id: string): LevelFile {
  return JSON.parse(readFileSync(`public/levels/${id}.json`, 'utf8')) as LevelFile;
}

interface Tick {
  t: number;
  speed: number;
  ground: boolean;
  surf: boolean;
  node: number;
  y: number;
}

function runOnce(lv: CompiledLevel, route: readonly RouteNode[], opts: { sync?: number; aimNoiseDeg?: number; seed: number }) {
  const pm = new PlayerMovement(lv.world, cfg);
  pm.teleport(new Vector3(lv.spawnPos.x, lv.spawnPos.y + 1, lv.spawnPos.z));
  const rf = new RouteFollower(route, cfg, { ...opts, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z }, killY: lv.def.killY });
  const run = new RunState(lv);
  run.reset(null);
  const evs: RunEvent[] = [];
  const ticks: Tick[] = [];
  const milestones: number[] = [];
  let jumps = 0;
  let outcome = 'timeout';
  for (let k = 0; k < cfg.tickRate * 120; k++) {
    const inp = rf.next(pm.state, pm.surfNormal);
    const ev = pm.tick(inp);
    for (const e of ev) if (e.type === 'jump') jumps++;
    const s = pm.state;
    const o = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
    for (const e of evs) if (e.type === 'speedMilestone') milestones.push(e.speed);
    if (run.running) ticks.push({ t: run.time ?? 0, speed: s.speed, ground: s.onGround, surf: s.surfing, node: rf.nextIndex, y: s.pos.y });
    if (o === 'finish') {
      outcome = 'finish';
      break;
    }
    if (o === 'fall' || o === 'kill') {
      outcome = o;
      break;
    }
    if (rf.status === 'failed') {
      outcome = `bot:${rf.report.reason}`;
      break;
    }
  }
  return { outcome, time: run.time, ticks, jumps, milestones };
}

function sectionOf(route: readonly RouteNode[], i: number): string {
  for (let k = Math.min(i - 1, route.length - 1); k >= 0; k--) if (route[k].note) return route[k].note ?? '';
  return 'Start';
}

function profile(id: string, label: string, opts: { sync?: number; aimNoiseDeg?: number; seed: number }): void {
  const file = loadFile(id);
  const lv = compileLevel(file);
  const route = file.route ?? [];
  const r = runOnce(lv, route, opts);
  console.log(`\n=== ${id} ${label}: ${r.outcome} ${r.time?.toFixed(2)} s, Sprünge ${r.jumps}, Meilensteine ${r.milestones.join(',')} ===`);
  const secs = new Map<string, Tick[]>();
  for (const tk of r.ticks) {
    const s = sectionOf(route, tk.node);
    if (!secs.has(s)) secs.set(s, []);
    secs.get(s)!.push(tk);
  }
  console.log('  Abschnitt          Zeit    Anteil  Ø u/s  max u/s  Boden%  Surf%  längste Luft/Surf-Phase ohne Bodenkontakt');
  const total = r.ticks.length * DT;
  for (const [s, ts] of secs) {
    const t = ts.length * DT;
    const avg = ts.reduce((a, x) => a + x.speed, 0) / ts.length;
    const mx = Math.max(...ts.map((x) => x.speed));
    const g = ts.filter((x) => x.ground).length / ts.length;
    const sf = ts.filter((x) => x.surf).length / ts.length;
    let longest = 0;
    let cur = 0;
    for (const x of ts) {
      if (!x.ground) cur += DT;
      else cur = 0;
      longest = Math.max(longest, cur);
    }
    console.log(
      `  ${s.padEnd(16)} ${t.toFixed(2).padStart(6)} s ${((100 * t) / total).toFixed(0).padStart(5)} % ${avg.toFixed(0).padStart(6)} ${mx.toFixed(0).padStart(8)} ${(100 * g).toFixed(0).padStart(6)} % ${(100 * sf).toFixed(0).padStart(5)} %  ${longest.toFixed(2)} s`,
    );
  }
  // Zeit unter 400 u/s
  const slow = r.ticks.filter((x) => x.speed < 400).length * DT;
  console.log(`  Zeit < 400 u/s: ${slow.toFixed(1)} s von ${total.toFixed(1)} s (${((100 * slow) / total).toFixed(0)} %)`);
}

// a)
profile('level1', 'sync 1.0', { sync: 1, seed: 11 });
profile('level1', 'Hand 2°', { aimNoiseDeg: 2, seed: 3 });
profile('level2', 'sync 1.0', { sync: 1, seed: 11 });
profile('level2', 'Hand 2°', { aimNoiseDeg: 2, seed: 3 });

// b) Könner-Inseln
{
  const file = loadFile('level1');
  const lv = compileLevel(file);
  const route = file.route ?? [];
  const cuts = file.brushes
    .filter((b: BrushDef) => b.tag !== undefined && /^cut\d$/.test(b.tag))
    .map((b) => center(b))
    .sort((a, b) => 0);
  const i18 = 18;
  const i23 = 23;
  console.log(`\n=== Könner-Inseln: ${cuts.length} Inseln, Mitten ${cuts.map((c) => c.map((v) => v.toFixed(0)).join('/')).join('  ')} ===`);
  // Kehren-Pad 1 (Knoten 18) → cut1..3 → Pad 6 (Knoten 23)
  const cutRoute: RouteNode[] = [
    ...route.slice(0, i18 + 1),
    ...cuts.map((c) => ({ pos: [c[0], 192, c[2]] as const, jump: true, minSpeed: 685, note: 'Insel' })),
    ...route.slice(i23),
  ];
  for (const m of [{ n: 'sync 1.0', o: { sync: 1 } }, { n: 'sync 0.9', o: { sync: 0.9 } }, { n: 'Hand 1°', o: { aimNoiseDeg: 1 } }, { n: 'Hand 2°', o: { aimNoiseDeg: 2 } }]) {
    const base: string[] = [];
    const cut: string[] = [];
    let saved = 0;
    let nOk = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const a = runOnce(lv, route, { ...m.o, seed });
      const b = runOnce(lv, cutRoute, { ...m.o, seed });
      base.push(a.outcome === 'finish' ? a.time!.toFixed(1) : a.outcome);
      cut.push(b.outcome === 'finish' ? b.time!.toFixed(1) : b.outcome);
      if (a.outcome === 'finish' && b.outcome === 'finish') {
        saved += a.time! - b.time!;
        nOk++;
      }
    }
    console.log(`  ${m.n.padEnd(9)} Kehre: ${base.join(' ')}   Inseln: ${cut.join(' ')}   Ø Ersparnis ${(nOk ? saved / nOk : 0).toFixed(2)} s (${nOk} Paare)`);
  }
  // Tempo am Kehren-Eingang (Knoten 17/18) für sync 1.0
  const r = runOnce(lv, route, { sync: 1, seed: 11 });
  const at = r.ticks.find((x) => x.node >= 19);
  console.log(`  sync 1.0 Tempo beim Erreichen von Pad 1: ${at?.speed.toFixed(0)} u/s (Insel-Plan 685)`);
}

function center(b: BrushDef): [number, number, number] {
  if (b.type === 'box' || b.type === 'wedge') return [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2];
  if (b.type === 'hull') {
    const xs = b.points.map((p) => p[0]);
    const zs = b.points.map((p) => p[2]);
    const ys = b.points.map((p) => p[1]);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...ys), (Math.min(...zs) + Math.max(...zs)) / 2];
  }
  if (b.type === 'prism') return [0, 0, (b.from + b.to) / 2];
  return [0, 0, 0];
}
