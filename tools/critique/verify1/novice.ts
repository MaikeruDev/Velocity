/**
 * Kritik-Linse LEVEL-FLOW & ONBOARDING — headless Mess-Skript (ändert keinen Projektcode).
 *
 *   npx tsx tools/critique/level-flow/novice.ts
 *
 * 1) Flach: was passiert mit W+Leertaste aus dem Stand, mit/ohne Shift?
 * 2) Level 1/2 mit "Anfängern", die wie ein echter Mensch weiterspielen
 *    (Respawn am CP statt Abbruch): W-Halter, Space-Halter, Kantenspringer,
 *    Kantenspringer + Crouch in der Luft; dazu RouteFollower mit Zielfehler
 *    2/3/5° und Respawn. Ausgabe: Todesorte, Stau-Orte, CP nach 90 s, Zielzeit.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { RunState } from '../../../src/engine/runState';
import type { RunEvent } from '../../../src/engine/events';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { RouteFollower, yawOf } from '../../../src/player/bots';
import type { MutablePlayerInput, PlayerInput } from '../../../src/player/types';
import { NO_INPUT } from '../../../src/player/types';
import { makeTraceResult } from '../../../src/world/collision/types';
import { compileLevel, type CompiledLevel } from '../../../src/world/level/compileLevel';
import type { RouteNode } from '../../../src/world/level/LevelFormat';
import { resumeIndex } from '../../levels/physics';

const OUT = 'shots/verify1/crit/level-flow';
mkdirSync(OUT, { recursive: true });
const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;

function load(id: string): CompiledLevel {
  return compileLevel(JSON.parse(readFileSync(`public/levels/${id}.json`, 'utf8')));
}

// ------------------------------------------------------------------ 1) flach
function flat(): Record<string, unknown> {
  const lv = compileLevel({
    version: 1, id: 'flat', name: 'flat', spawn: { pos: [0, 0, 0], yaw: 0 }, killY: -2000,
    environment: {
      skyTop: '#000', skyHorizon: '#000', skyBottom: '#000', fogColor: '#000', fogNear: 0, fogFar: 1,
      sunDir: [0, 1, 0], sunColor: '#fff', ambientSky: '#fff', ambientGround: '#000', trimColor: '#fff', voidY: -2000,
    },
    brushes: [{ type: 'box', min: [-40000, -64, -40000], max: [40000, 0, 40000], mat: 'floor' }],
    triggers: [],
  });
  const res: Record<string, unknown> = {};
  const scen: [string, (t: number) => Partial<PlayerInput>][] = [
    ['W+Space aus dem Stand', () => ({ forward: 1, jumpHeld: true })],
    ['W+Shift+Space aus dem Stand', () => ({ forward: 1, sprint: true, jumpHeld: true })],
    ['W+Shift 0.3 s, dann +Space', (t) => ({ forward: 1, sprint: true, jumpHeld: t > 0.3 })],
    ['W+Shift 1 s, dann +Space', (t) => ({ forward: 1, sprint: true, jumpHeld: t > 1 })],
    ['W+Shift (kein Sprung)', () => ({ forward: 1, sprint: true })],
    ['Space getippt je Landung (W+Shift, kein Auto-Hop-Halten)', () => ({ forward: 1, sprint: true })],
  ];
  for (const [name, fn] of scen) {
    const pm = new PlayerMovement(lv.world, cfg);
    pm.teleport(new Vector3(0, 1, 0));
    const inp: MutablePlayerInput = { ...NO_INPUT };
    const samples: string[] = [];
    let jumps = 0;
    const tapMode = name.startsWith('Space getippt');
    let wasGround = true;
    for (let k = 0; k < cfg.tickRate * 5; k++) {
      const t = k * DT;
      Object.assign(inp, NO_INPUT, fn(t));
      inp.yaw = 0;
      if (tapMode) {
        // Tippt Leertaste 60 ms nach jeder Landung (menschliche Reaktion ohne Puffer-Nutzen) — erst nach 0.5 s Anlauf.
        inp.jumpPressed = t > 0.5 && pm.state.onGround && (k % 8 === 0);
      } else inp.jumpPressed = inp.jumpHeld && k === 0;
      const ev = pm.tick(inp);
      for (const e of ev) if (e.type === 'jump') jumps++;
      if ([0.5, 1, 2, 3, 5].some((x) => Math.abs(t + DT - x) < DT / 2)) samples.push(`${(t + DT).toFixed(1)}s: ${pm.state.speed.toFixed(0)} u/s, z ${(-pm.state.pos.z).toFixed(0)} u`);
      wasGround = pm.state.onGround;
    }
    void wasGround;
    res[name] = { jumps, samples };
  }
  return res;
}

// ------------------------------------------------------------------ 2) Level mit Anfängern
type NoviceKind = 'W' | 'W+Space' | 'Walk-then-Space' | 'Edge' | 'Edge+Crouch';

interface Death {
  readonly t: number;
  readonly cp: number;
  readonly node: number;
  readonly note: string;
  readonly pos: string;
  readonly why: 'fall' | 'kill';
}

interface RunResult {
  readonly bot: string;
  readonly level: string;
  readonly finished: boolean;
  readonly time: number | null;
  readonly wall: number;
  readonly deaths: number;
  readonly deathsBySection: Record<string, number>;
  readonly deathSpots: Record<string, number>;
  readonly cpAt90: number;
  readonly cpAt30: number;
  readonly cpAt60: number;
  readonly stuck: string | null;
  readonly maxSpeed: number;
  readonly firstDeaths: Death[];
}

/** Knoten-Notiz rückwärts suchen (Abschnittsname). */
function sectionName(route: readonly RouteNode[], i: number): string {
  for (let k = Math.min(i, route.length - 1); k >= 0; k--) if (route[k].note) return route[k].note ?? '';
  return 'Start';
}

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

class Novice {
  private readonly out: MutablePlayerInput = { ...NO_INPUT };
  private readonly tr = makeTraceResult();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly pmin = new Vector3(-4, 0, -4);
  private readonly pmax = new Vector3(4, 4, 4);
  private readonly hmin = new Vector3(-16, 0, -16);
  private readonly hmax = new Vector3(16, 54, 16);
  private sinceSpawn = 0;
  constructor(private readonly kind: NoviceKind, private readonly lv: CompiledLevel, private readonly tracker: NodeTracker) {}
  respawned(): void {
    this.sinceSpawn = 0;
  }
  next(pm: PlayerMovement): PlayerInput {
    const s = pm.state;
    this.sinceSpawn += DT;
    this.tracker.update(s.pos);
    const tgt = this.tracker.target();
    const o = this.out;
    Object.assign(o, NO_INPUT);
    o.yaw = yawOf(tgt[0] - s.pos.x, tgt[2] - s.pos.z);
    o.pitch = 0;
    o.forward = 1;
    o.sprint = true;
    switch (this.kind) {
      case 'W':
        break;
      case 'W+Space':
        o.jumpHeld = true;
        o.jumpPressed = this.sinceSpawn < DT * 1.5;
        break;
      case 'Walk-then-Space':
        o.jumpHeld = this.sinceSpawn > 0.4;
        break;
      case 'Edge':
      case 'Edge+Crouch': {
        if (s.onGround && this.edgeAhead(pm, o.yaw)) o.jumpPressed = true;
        if (this.kind === 'Edge+Crouch' && !s.onGround) o.crouch = true;
        break;
      }
    }
    return o;
  }
  /** Kante oder Wand direkt voraus (in Blickrichtung, 12 u Vorlauf + 1.5 Ticks Weg). */
  private edgeAhead(pm: PlayerMovement, yaw: number): boolean {
    const s = pm.state;
    const w = this.lv.world;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const ahead = 16 + 6 + Math.max(s.speed, 50) * DT * 1.5;
    // Boden voraus?
    this.a.set(s.pos.x + fx * ahead, s.pos.y + 8, s.pos.z + fz * ahead);
    this.b.set(this.a.x, s.pos.y - 40, this.a.z);
    w.traceBox(this.a, this.b, this.pmin, this.pmax, this.tr);
    if (this.tr.fraction >= 1 && !this.tr.startSolid) return true;
    // Wand voraus, höher als eine Stufe?
    this.a.set(s.pos.x, s.pos.y + 19, s.pos.z);
    this.b.set(s.pos.x + fx * 24, s.pos.y + 19, s.pos.z + fz * 24);
    w.traceBox(this.a, this.b, this.hmin, this.hmax, this.tr);
    return this.tr.fraction < 1 && this.tr.normal.y < 0.7;
  }
}

function playLevel(id: string, botName: string, make: (lv: CompiledLevel, from: number, pos: Vector3) => { next(pm: PlayerMovement): PlayerInput; respawned?(): void; tracker?: NodeTracker }, maxSeconds = 300): RunResult {
  const lv = load(id);
  const route = lv.def.route ?? [];
  const pm = new PlayerMovement(lv.world, cfg);
  const run = new RunState(lv);
  run.reset(null);
  const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((x, y) => x.order - y.order);
  pm.teleport(new Vector3(lv.spawnPos.x, lv.spawnPos.y + 1, lv.spawnPos.z));
  let ctl = make(lv, 0, lv.spawnPos);
  let nodeFrom = 0;
  const evs: RunEvent[] = [];
  const deaths: Death[] = [];
  const bySec: Record<string, number> = {};
  const spots: Record<string, number> = {};
  let cpAt30 = 0;
  let cpAt60 = 0;
  let cpAt90 = 0;
  let finished = false;
  let time: number | null = null;
  let maxSpeed = 0;
  let lastProgressT = 0;
  let lastProgressKey = '';
  let stuck: string | null = null;
  const ticks = Math.round(maxSeconds / DT);
  let k = 0;
  for (; k < ticks; k++) {
    const t = k * DT;
    const inp = ctl.next(pm);
    pm.tick(inp);
    const s = pm.state;
    if (s.speed > maxSpeed) maxSpeed = s.speed;
    const outc = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, evs);
    if (t < 30) cpAt30 = run.checkpoint;
    if (t < 60) cpAt60 = run.checkpoint;
    if (t < 90) cpAt90 = run.checkpoint;
    const nodeIdx = ctl.tracker ? ctl.tracker.idx : -1;
    const key = `${run.checkpoint}:${nodeIdx}`;
    if (key !== lastProgressKey) {
      lastProgressKey = key;
      lastProgressT = t;
    }
    if (outc === 'finish') {
      finished = true;
      time = run.time;
      break;
    }
    if (outc === 'fall' || outc === 'kill') {
      const ni = ctl.tracker ? ctl.tracker.idx : nodeFrom;
      const sec = sectionName(route, Math.max(0, ni - 1));
      const spot = `${sec} (→Knoten ${ni})`;
      bySec[sec] = (bySec[sec] ?? 0) + 1;
      spots[spot] = (spots[spot] ?? 0) + 1;
      deaths.push({ t: Math.round(t * 10) / 10, cp: run.checkpoint, node: ni, note: sec, pos: `${s.pos.x.toFixed(0)},${s.pos.y.toFixed(0)},${s.pos.z.toFixed(0)}`, why: outc });
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      pm.teleport(new Vector3(sp.pos.x, sp.pos.y + 1, sp.pos.z));
      nodeFrom = run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0;
      ctl = make(lv, nodeFrom, sp.pos);
      ctl.respawned?.();
    }
    if (ctl.tracker && t - lastProgressT > 25) {
      stuck = `${sectionName(route, ctl.tracker.idx)} (Knoten ${ctl.tracker.idx}, pos ${s.pos.x.toFixed(0)},${s.pos.y.toFixed(0)},${s.pos.z.toFixed(0)}, ${s.speed.toFixed(0)} u/s)`;
      break;
    }
  }
  return {
    bot: botName,
    level: id,
    finished,
    time: time !== null ? Math.round(time * 10) / 10 : null,
    wall: Math.round(k * DT * 10) / 10,
    deaths: deaths.length,
    deathsBySection: bySec,
    deathSpots: spots,
    cpAt30,
    cpAt60,
    cpAt90,
    stuck,
    maxSpeed: Math.round(maxSpeed),
    firstDeaths: deaths.slice(0, 6),
  };
}

function noviceMaker(kind: NoviceKind) {
  return (lv: CompiledLevel, from: number) => {
    const tracker = new NodeTracker(lv.def.route ?? [], from);
    const n = new Novice(kind, lv, tracker);
    return { next: (pm: PlayerMovement) => n.next(pm), respawned: () => n.respawned(), tracker };
  };
}

function followerMaker(opts: { sync?: number; aimNoiseDeg?: number; seed: number }) {
  return (lv: CompiledLevel, from: number, pos: Vector3) => {
    const route = lv.def.route ?? [];
    const rf = new RouteFollower(route.slice(from), cfg, {
      sync: opts.sync,
      aimNoiseDeg: opts.aimNoiseDeg,
      seed: opts.seed,
      world: lv.world,
      start: { x: pos.x, z: pos.z },
      timeout: 1e9,
      stallTimeout: 1e9,
    });
    const tracker = new NodeTracker(route, from);
    return {
      next: (pm: PlayerMovement) => {
        tracker.update(pm.state.pos);
        return rf.next(pm.state, pm.surfNormal);
      },
      tracker,
    };
  };
}

const results: RunResult[] = [];
const flatRes = flat();
console.log('\n=== Flach (5 s) ===');
for (const [k, v] of Object.entries(flatRes)) console.log(k.padEnd(52), JSON.stringify(v));

for (const id of ['level1', 'level2']) {
  console.log(`\n=== ${id}: Anfänger (zielen auf nächsten Knoten, Respawn am CP, Abbruch nach 25 s ohne Fortschritt) ===`);
  for (const kind of ['W', 'W+Space', 'Walk-then-Space', 'Edge', 'Edge+Crouch'] as NoviceKind[]) {
    const r = playLevel(id, kind, noviceMaker(kind));
    results.push(r);
    console.log(
      `${kind.padEnd(16)} ${r.finished ? `ZIEL ${r.time} s (Wand ${r.wall} s)` : `kein Ziel (Wand ${r.wall} s)`}  Tode ${r.deaths}  CP@30/60/90 ${r.cpAt30}/${r.cpAt60}/${r.cpAt90}  max ${r.maxSpeed}` +
        (r.stuck ? `\n${''.padEnd(17)}STAU: ${r.stuck}` : '') +
        (r.deaths ? `\n${''.padEnd(17)}Tode: ${JSON.stringify(r.deathSpots)}` : ''),
    );
  }
  console.log(`--- ${id}: RouteFollower mit Respawn (8 Seeds) ---`);
  for (const m of [{ n: 'sync 1.0', o: { sync: 1 } }, { n: 'Hand 2°', o: { aimNoiseDeg: 2 } }, { n: 'Hand 3°', o: { aimNoiseDeg: 3 } }, { n: 'Hand 5°', o: { aimNoiseDeg: 5 } }]) {
    const rs: RunResult[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      const r = playLevel(id, `${m.n} s${seed}`, followerMaker({ ...m.o, seed }));
      rs.push(r);
      results.push(r);
    }
    const fin = rs.filter((r) => r.finished);
    const times = fin.map((r) => r.time ?? 0).sort((a, b) => a - b);
    const agg: Record<string, number> = {};
    for (const r of rs) for (const [s, c] of Object.entries(r.deathSpots)) agg[s] = (agg[s] ?? 0) + c;
    const stuck = rs.filter((r) => r.stuck).map((r) => r.stuck);
    console.log(
      `${m.n.padEnd(10)} Ziel ${fin.length}/8, Zeit (inkl. Tode) min/med/max ${times[0] ?? '-'} / ${times[Math.floor(times.length / 2)] ?? '-'} / ${times[times.length - 1] ?? '-'} s, Tode Σ ${rs.reduce((a, r) => a + r.deaths, 0)}` +
        (Object.keys(agg).length ? `\n${''.padEnd(11)}Todesorte: ${JSON.stringify(agg)}` : '') +
        (stuck.length ? `\n${''.padEnd(11)}Stau: ${stuck.join(' | ')}` : ''),
    );
  }
}
writeFileSync(`${OUT}/novice.json`, JSON.stringify({ flat: flatRes, results }, null, 2));
console.log(`\n→ ${OUT}/novice.json`);
