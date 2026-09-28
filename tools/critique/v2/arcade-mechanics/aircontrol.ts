/**
 * LUFTKONTROLLE MIT W (CPMA-artig, Tempo bleibt) — Messung gegen die echte Engine.
 *   npx tsx tools/critique/v2/arcade-mechanics/aircontrol.ts
 * Anfänger-Bots wie tools/critique/level-flow/novice.ts (zielen auf den nächsten Knoten,
 * Respawn am Checkpoint), dazu Strafe-Bots (A/D → Mechanik greift nie) und Spiel-Uhr-Läufe.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { RunState } from '../../../../src/engine/runState';
import type { RunEvent } from '../../../../src/engine/events';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { StrafeBot, yawOf } from '../../../../src/player/bots';
import type { MutablePlayerInput, PlayerInput } from '../../../../src/player/types';
import { NO_INPUT } from '../../../../src/player/types';
import type { CollisionWorld } from '../../../../src/world/collision/types';
import { makeTraceResult } from '../../../../src/world/collision/types';
import { compileLevel, type CompiledLevel } from '../../../../src/world/level/compileLevel';
import type { RouteNode } from '../../../../src/world/level/LevelFormat';
import { flatLevel, readLevelFile } from '../../../sim/levels';
import { resumeIndex, timedRun } from '../../../levels/physics';
import { AIR_DEFAULT, arcadeClass, arcadeStats, installGlobal, type AirControlOpts } from './ArcadeMovement';

const OUT = 'shots/v2/arcade-mechanics';
mkdirSync(OUT, { recursive: true });
const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;
const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');
const result: Record<string, unknown> = {};
type Ctor = new (w: CollisionWorld, c: MovementConfig) => PlayerMovement;
const AIR = (o: Partial<AirControlOpts> = {}): Ctor => arcadeClass({ air: { ...AIR_DEFAULT, ...o } });

class NodeTracker {
  idx: number;
  constructor(private readonly route: readonly RouteNode[], from: number) {
    this.idx = from;
  }
  update(p: Vector3): void {
    const r = this.route;
    for (let guard = 0; guard < 4 && this.idx < r.length; guard++) {
      const n = r[this.idx].pos;
      const dx = n[0] - p.x;
      const dz = n[2] - p.z;
      const below = n[1] - p.y;
      const hd = Math.hypot(dx, dz);
      let passed = false;
      if (this.idx > 0) {
        const a = r[this.idx - 1].pos;
        const sx = n[0] - a[0];
        const sz = n[2] - a[2];
        const len2 = sx * sx + sz * sz;
        if (len2 > 1) {
          const tt = ((p.x - a[0]) * sx + (p.z - a[2]) * sz) / len2;
          passed = tt >= 1 && hd < 400;
        }
      }
      if ((hd < 64 || passed) && below < 64) this.idx++;
      else break;
    }
  }
  target(): readonly number[] {
    return this.route[Math.min(this.idx, this.route.length - 1)].pos;
  }
}

type Kind = 'W+Space' | 'Edge' | 'W+Space, Blick 0.25 s voraus';

class Novice {
  private readonly out: MutablePlayerInput = { ...NO_INPUT };
  private readonly tr = makeTraceResult();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly pmin = new Vector3(-4, 0, -4);
  private readonly pmax = new Vector3(4, 4, 4);
  private readonly hmin = new Vector3(-16, 0, -16);
  private readonly hmax = new Vector3(16, 54, 16);
  private since = 0;
  constructor(private readonly kind: Kind, private readonly lv: CompiledLevel, readonly tracker: NodeTracker) {}
  next(pm: PlayerMovement): PlayerInput {
    const s = pm.state;
    this.since += DT;
    this.tracker.update(s.pos);
    const tgt = this.tracker.target();
    const o = this.out;
    Object.assign(o, NO_INPUT);
    o.yaw = yawOf(tgt[0] - s.pos.x, tgt[2] - s.pos.z);
    o.forward = 1;
    o.sprint = true;
    if (this.kind === 'Edge') {
      if (s.onGround && this.edgeAhead(pm, o.yaw)) o.jumpPressed = true;
    } else {
      o.jumpHeld = true;
      o.jumpPressed = this.since < DT * 1.5;
    }
    return o;
  }
  private edgeAhead(pm: PlayerMovement, yaw: number): boolean {
    const s = pm.state;
    const w = this.lv.world;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const ahead = 16 + 6 + Math.max(s.speed, 50) * DT * 1.5;
    this.a.set(s.pos.x + fx * ahead, s.pos.y + 8, s.pos.z + fz * ahead);
    this.b.set(this.a.x, s.pos.y - 40, this.a.z);
    w.traceBox(this.a, this.b, this.pmin, this.pmax, this.tr);
    if (this.tr.fraction >= 1 && !this.tr.startSolid) return true;
    this.a.set(s.pos.x, s.pos.y + 19, s.pos.z);
    this.b.set(s.pos.x + fx * 24, s.pos.y + 19, s.pos.z + fz * 24);
    w.traceBox(this.a, this.b, this.hmin, this.hmax, this.tr);
    return this.tr.fraction < 1 && this.tr.normal.y < 0.7;
  }
}

function sectionName(route: readonly RouteNode[], i: number): string {
  for (let k = Math.min(i, route.length - 1); k >= 0; k--) if (route[k].note) return route[k].note ?? '';
  return 'Start';
}

function play(K: Ctor, lv: CompiledLevel, kind: Kind, maxSeconds = 240) {
  const route = lv.def.route ?? [];
  const pm = new K(lv.world, cfg);
  const run = new RunState(lv);
  run.reset(null);
  const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((x, y) => x.order - y.order);
  pm.teleport(new Vector3(lv.spawnPos.x, lv.spawnPos.y + 1, lv.spawnPos.z));
  let nov = new Novice(kind, lv, new NodeTracker(route, 0));
  const evs: RunEvent[] = [];
  const spots: Record<string, number> = {};
  let deaths = 0;
  let lastKey = '';
  let lastT = 0;
  let stuck: string | null = null;
  let time: number | null = null;
  let cpAt90 = 0;
  for (let k = 0; k < maxSeconds * cfg.tickRate; k++) {
    const t = k * DT;
    pm.tick(nov.next(pm));
    const s = pm.state;
    const outc = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
    if (t < 90) cpAt90 = run.checkpoint;
    const key = `${run.checkpoint}:${nov.tracker.idx}`;
    if (key !== lastKey) { lastKey = key; lastT = t; }
    if (outc === 'finish') { time = run.time; break; }
    if (outc === 'fall' || outc === 'kill') {
      deaths++;
      const sec = sectionName(route, Math.max(0, nov.tracker.idx - 1));
      spots[sec] = (spots[sec] ?? 0) + 1;
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      pm.teleport(new Vector3(sp.pos.x, sp.pos.y + 1, sp.pos.z));
      const from = run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0;
      nov = new Novice(kind, lv, new NodeTracker(route, from));
    }
    if (t - lastT > 25) {
      stuck = `${sectionName(route, nov.tracker.idx)} (Knoten ${nov.tracker.idx})`;
      break;
    }
  }
  const st = K === PlayerMovement ? null : arcadeStats(pm);
  return { deaths, spots, stuck, time, cpAt90, airCtlDeg: st ? (st.airCtlRad * 180) / Math.PI : 0 };
}

const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
const L2 = compileLevel(readLevelFile('public/levels/level2.json'));

/** Ab Checkpoint `order` (Respawn dort) bis zum nächsten Checkpoint/Ziel: Tode, Zeit, Stau. */
function playFrom(K: Ctor, lv: CompiledLevel, kind: Kind, order: number, maxSeconds = 120) {
  const route = lv.def.route ?? [];
  const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((x, y) => x.order - y.order);
  const cp = cps.find((c) => c.order === order);
  if (!cp) throw new Error(`CP${order}`);
  const goal = cps.find((c) => c.order === order + 1) ?? lv.triggers.find((t) => t.kind === 'finish');
  if (!goal) throw new Error('goal');
  const from = Math.max(0, resumeIndex(route, cp));
  const pm = new K(lv.world, cfg);
  const run = new RunState(lv);
  run.reset(null);
  const evs: RunEvent[] = [];
  const spawn = (): Novice => {
    pm.teleport(new Vector3(cp.spawnPos.x, cp.spawnPos.y + 1, cp.spawnPos.z));
    return new Novice(kind, lv, new NodeTracker(route, from));
  };
  let nov = spawn();
  let deaths = 0;
  let lastKey = -1;
  let lastT = 0;
  const spots: Record<string, number> = {};
  const lo = new Vector3();
  const hi = new Vector3();
  for (let k = 0; k < maxSeconds * cfg.tickRate; k++) {
    const t = k * DT;
    pm.tick(nov.next(pm));
    const s = pm.state;
    lo.copy(s.pos).add(pm.hullMins);
    hi.copy(s.pos).add(pm.hullMaxs);
    if (goal.bounds.intersectsBox(new Box3(lo, hi))) return { ok: true, t, deaths, spots, stuck: null as string | null };
    const o = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
    if (o === 'fall' || o === 'kill') {
      deaths++;
      const sec = sectionName(route, Math.max(0, nov.tracker.idx - 1));
      spots[sec] = (spots[sec] ?? 0) + 1;
      nov = spawn();
    }
    if (nov.tracker.idx !== lastKey) { lastKey = nov.tracker.idx; lastT = t; }
    if (t - lastT > 25) return { ok: false, t, deaths, spots, stuck: `${sectionName(route, nov.tracker.idx)} (Knoten ${nov.tracker.idx})` };
  }
  return { ok: false, t: maxSeconds, deaths, spots, stuck: 'Zeit' };
}

function secFromCp(): void {
  console.log('\n## C Anfänger ab Checkpoints (Respawn am selben CP, bis zum nächsten CP/Ziel, 120 s)\n');
  const rows: unknown[] = [];
  const variants: Array<[string, Ctor]> = [['Original', PlayerMovement], ['Luftkontrolle', AIR()]];
  for (const [lv, orders] of [[L1, [2, 3]], [L2, [1]]] as Array<[CompiledLevel, number[]]>) {
    for (const order of orders) for (const kind of ['W+Space', 'Edge'] as Kind[]) {
      const cells: string[] = [];
      for (const [name, K] of variants) {
        const r = playFrom(K, lv, kind, order);
        rows.push({ level: lv.def.id, order, kind, name, ...r });
        cells.push(`${name}: ${r.ok ? `durch ${f(r.t, 1)} s` : `NICHT (${r.stuck})`}, Tode ${r.deaths} ${JSON.stringify(r.spots)}`);
      }
      console.log(`- ${lv.def.id} CP${order} ${kind.padEnd(8)} ${cells.join(' | ')}`);
    }
  }
  result.fromCp = rows;
}

function secNovice(): void {
  console.log('\n## N Anfänger (zielen auf den nächsten Knoten, Respawn am CP, 240 s): Ziel / Tode / Todesorte / Stau\n');
  const rows: unknown[] = [];
  const variants: Array<[string, Ctor]> = [['Original', PlayerMovement], ['Luftkontrolle 1.6→0.8 rad/s', AIR()], ['Luftkontrolle 3.0→1.5 rad/s', AIR({ rate: 3, rateHigh: 1.5 })]];
  for (const lv of [L1, L2]) {
    for (const kind of ['W+Space', 'Edge'] as Kind[]) {
      for (const [name, K] of variants) {
        const r = play(K, lv, kind);
        rows.push({ level: lv.def.id, kind, name, ...r });
        console.log(`- ${lv.def.id} ${kind.padEnd(8)} ${name.padEnd(28)} ${r.time !== null ? `ZIEL ${f(r.time, 1)} s` : 'kein Ziel'} · Tode ${r.deaths} · CP@90 ${r.cpAt90} · ${JSON.stringify(r.spots)}${r.stuck ? ` · STAU ${r.stuck}` : ''}${r.airCtlDeg ? ` · gelenkt ${f(r.airCtlDeg)}°` : ''}`);
      }
    }
  }
  result.novice = rows;
}

function secStrafe(): void {
  console.log('\n## S Strafe-Bots (A/D) unberührt? flach 10 s ab 320 — und Spiel-Uhr-Läufe (Seeds 1–4)\n');
  const flat = compileLevel(flatLevel());
  for (const aim of [0, 2, 3, 5]) {
    const cells: string[] = [];
    for (const K of [PlayerMovement, AIR()]) {
      const pm = new K(flat.world, cfg);
      pm.teleport(new Vector3(0, 1, 0));
      pm.state.vel.set(0, 0, -320);
      const bot = new StrafeBot(cfg, { aimNoiseDeg: aim, seed: 9, heading: 0 });
      for (let k = 0; k < 10 * cfg.tickRate; k++) pm.tick(bot.next(pm.state));
      cells.push(pm.state.speed.toFixed(3));
    }
    console.log(`- StrafeBot ${aim}°: Original ${cells[0]} | Luftkontrolle ${cells[1]}`);
  }
  const rows: unknown[] = [];
  for (const lv of [L1, L2]) {
    for (const model of [{ sync: 1 }, { aimNoiseDeg: 3 }]) {
      const a = [1, 2, 3, 4].map((s) => timedRun(lv, model, s, cfg).time);
      const undo = installGlobal({ air: AIR_DEFAULT });
      const b = [1, 2, 3, 4].map((s) => timedRun(lv, model, s, cfg).time);
      undo();
      rows.push({ level: lv.def.id, model, a, b });
      console.log(`- ${lv.def.id} ${JSON.stringify(model)}: Original ${a.map((t) => f(t ?? NaN, 3)).join(' ')} | Luftkontrolle ${b.map((t) => f(t ?? NaN, 3)).join(' ')}`);
    }
  }
  result.strafe = rows;
}

function secTurn(): void {
  console.log('\n## T Wendekreis: Blick springt um 90°, W gehalten (Luftkontrolle) vs. perfekter Strafer mit Ziel 90° seitlich — Drehung nach 0.3 s / Tempo\n');
  const flat = compileLevel(flatLevel());
  for (const v0 of [320, 600, 900]) {
    const pm = new (AIR())(flat.world, cfg);
    pm.teleport(new Vector3(0, 200, 0));
    pm.state.vel.set(0, 0, -v0);
    for (let k = 0; k < Math.round(0.3 * cfg.tickRate); k++) pm.tick({ ...NO_INPUT, forward: 1, yaw: Math.PI / 2 });
    const dirW = (Math.atan2(-pm.state.vel.x, -pm.state.vel.z) * 180) / Math.PI;
    const sW = pm.state.speed;
    const ps = new PlayerMovement(flat.world, cfg);
    ps.teleport(new Vector3(0, 200, 0));
    ps.state.vel.set(0, 0, -v0);
    const bot = new StrafeBot(cfg, { heading: Math.PI / 2 });
    for (let k = 0; k < Math.round(0.3 * cfg.tickRate); k++) ps.tick(bot.next(ps.state));
    const dirS = (Math.atan2(-ps.state.vel.x, -ps.state.vel.z) * 180) / Math.PI;
    console.log(`- ${v0} u/s: W-Lenken ${f(dirW)}° (Tempo ${f(sW)}) | perfekter Strafe ${f(dirS)}° (Tempo ${f(ps.state.speed)})`);
  }
}

secFromCp();
if (process.argv[2] !== "cp") {
secTurn();
secStrafe();
secNovice();
}
writeFileSync(`${OUT}/aircontrol.json`, JSON.stringify(result, null, 2));
console.log(`\n→ ${OUT}/aircontrol.json`);
