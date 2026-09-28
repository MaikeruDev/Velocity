/**
 * PROTOTYP-Messung (Kosmetik v2): Wie oft feuern die Events, die Tricks auslösen — und wie viel
 * davon kommt bei den Gegenständen an? Echte Bot-Läufe (RouteFollower + PlayerMovement +
 * RunState, wie physics.timedRun) auf Level 1/2, Events wie im Spiel an die Trick-Maschinen
 * (Dose, Karte, Messer, Jo-Jo-Prototyp), Frames mit 60 Hz.
 *   npx tsx tools/critique/v2/kosmetik/event-probe.ts
 * Ausgabe: shots/v2/kosmetik/event-probe.json
 *
 * Gemessen je Gegenstand: Anteil der Laufzeit mit laufendem Trick (je Tempostufe), Tricks/min,
 * Anteil der Sprünge (Stufe ≥ 1) und der PERFEKTEN Hops, die einen Trick auslösen — und wie viel
 * ein 1-Platz-Puffer (Sprung merken, bis 0.25 s nachholen) daran ändert.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { CompiledLevel } from '../../../../src/world/level/compileLevel';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { RouteFollower } from '../../../../src/player/bots/RouteFollower';
import { RunState } from '../../../../src/engine/runState';
import type { GameEvent, RunEvent } from '../../../../src/engine/events';
import { CanTricks } from '../../../../src/ui/hand/canTricks';
import { CardTricks } from '../../../../src/ui/hand/cardTricks';
import { KnifeTricks } from '../../../../src/ui/hand/knifeTricks';
import type { PropControl, PropFrameInput } from '../../../../src/ui/hand/propTricks';
import { speedTier } from '../../../../src/ui/hand/anim';
import { resumeIndex } from '../../../levels/physics';
import { buildLevel1 } from '../../../levels/level1';
import { buildLevel2 } from '../../../levels/level2';
import { YoyoTricks } from './yoyoTricks';

interface Model {
  readonly name: string;
  readonly sync?: number;
  readonly aimNoiseDeg?: number;
}

const MODELS: readonly Model[] = [
  { name: 'sync1.0 (VELOCITY-Niveau)', sync: 1 },
  { name: 'Hand 1.5° (guter Mensch)', aimNoiseDeg: 1.5 },
];
const SEEDS = [1, 2, 3];
const FRAME = 1 / 60;
const QUEUE_WINDOW = 0.25;

interface PropStats {
  busy: number;
  busyTier: number[];
  timeTier: number[];
  starts: Record<string, number>;
  jumpsT1: number;
  jumpsT1Captured: number;
  perfect: number;
  perfectCaptured: number;
  queuedCaptured: number;
  queuedPerfectCaptured: number;
}

const newStats = (): PropStats => ({ busy: 0, busyTier: [0, 0, 0, 0], timeTier: [0, 0, 0, 0], starts: {}, jumpsT1: 0, jumpsT1Captured: 0, perfect: 0, perfectCaptured: 0, queuedCaptured: 0, queuedPerfectCaptured: 0 });

interface Slot {
  readonly name: string;
  readonly prop: PropControl;
  readonly queued: PropControl;
  readonly s: PropStats;
  pending: GameEvent | null;
  pendingAt: number;
}

const makeYoyo = (): YoyoTricks => new YoyoTricks([-0.95, 10.69, -3.57], [-1.36, 7.79, -4.42]);

function makeSlots(): Slot[] {
  const mk = (name: string, f: () => PropControl): Slot => ({ name, prop: f(), queued: f(), s: newStats(), pending: null, pendingAt: 0 });
  return [mk('can', () => new CanTricks()), mk('card', () => new CardTricks()), mk('knife', () => new KnifeTricks()), mk('yoyo (Prototyp)', makeYoyo)];
}

interface Global {
  time: number;
  timeTier: number[];
  air: number;
  surf: number;
  jumps: number[];
  perfect: number;
  milestones: number;
  checkpoints: number;
  deaths: number;
  finishes: number;
}

function runOnce(level: CompiledLevel, m: Model, seed: number, slots: Slot[], g: Global): void {
  const cfg = VELOCITY_DEFAULT;
  const route = level.def.route ?? [];
  const pm = new PlayerMovement(level.world, cfg);
  const run = new RunState(level);
  run.reset(null);
  const runEvents: RunEvent[] = [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const place = (p: Vector3): void => pm.teleport(new Vector3(p.x, p.y + 1, p.z));
  const follower = (from: number, start: Vector3): RouteFollower =>
    new RouteFollower(route.slice(from), cfg, { sync: m.sync, aimNoiseDeg: m.aimNoiseDeg, seed, killY: level.def.killY, world: level.world, start: { x: start.x, z: start.z }, stallTimeout: 12, timeout: 181 });
  place(level.spawnPos);
  let bot = follower(0, level.spawnPos);
  const dt = 1 / cfg.tickRate;
  let acc = 0;
  let now = 0;
  const inp: { speed: number; onGround: boolean; surfing: boolean } = { speed: 0, onGround: true, surfing: false };
  const deliver = (e: GameEvent): void => {
    for (const sl of slots) {
      const before = sl.prop.trick;
      sl.prop.onEvent(e);
      const qb = sl.queued.trick;
      sl.queued.onEvent(e);
      if (e.type === 'jump') {
        const tier = speedTier(e.speed);
        const good = e.perfect && e.gain > 0;
        if (tier >= 1) {
          sl.s.jumpsT1++;
          if (good) sl.s.perfect++;
          const got = before === 'none' && sl.prop.trick !== 'none';
          if (got) {
            sl.s.jumpsT1Captured++;
            if (good) sl.s.perfectCaptured++;
          }
          const qgot = qb === 'none' && sl.queued.trick !== 'none';
          if (qgot) {
            sl.s.queuedCaptured++;
            if (good) sl.s.queuedPerfectCaptured++;
            sl.pending = null;
          } else {
            sl.pending = e;
            sl.pendingAt = now;
          }
        }
      }
      if (sl.prop.trick !== before && sl.prop.trick !== 'none') sl.s.starts[sl.prop.trick] = (sl.s.starts[sl.prop.trick] ?? 0) + 1;
    }
  };
  for (let t = 0; t < 180 * cfg.tickRate; t++) {
    const evs = pm.tick(bot.next(pm.state, pm.surfNormal));
    const s = pm.state;
    for (const e of evs) {
      if (e.type === 'jump') {
        g.jumps[speedTier(e.speed)]++;
        if (e.perfect && e.gain > 0) g.perfect++;
      }
      deliver(e);
    }
    const out = run.tick(dt, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, runEvents);
    for (const e of runEvents) {
      if (e.type === 'speedMilestone') g.milestones++;
      if (e.type === 'checkpoint') g.checkpoints++;
      deliver(e);
    }
    acc += dt;
    while (acc >= FRAME) {
      acc -= FRAME;
      now += FRAME;
      inp.speed = s.speed;
      inp.onGround = s.onGround;
      inp.surfing = s.surfing;
      const tier = speedTier(s.speed);
      g.time += FRAME;
      g.timeTier[tier] += FRAME;
      if (!s.onGround) g.air += FRAME;
      if (s.surfing) g.surf += FRAME;
      for (const sl of slots) {
        // 1-Platz-Puffer: verpassten Sprung bis QUEUE_WINDOW nachholen.
        if (sl.pending && now - sl.pendingAt <= QUEUE_WINDOW && sl.queued.trick === 'none') {
          const e = sl.pending;
          sl.queued.onEvent(e);
          if (sl.queued.trick !== 'none') {
            sl.s.queuedCaptured++;
            if (e.type === 'jump' && e.perfect && e.gain > 0) sl.s.queuedPerfectCaptured++;
            sl.pending = null;
          }
        } else if (sl.pending && now - sl.pendingAt > QUEUE_WINDOW) sl.pending = null;
        sl.prop.update(FRAME, inp as PropFrameInput);
        sl.queued.update(FRAME, inp as PropFrameInput);
        sl.s.timeTier[tier] += FRAME;
        if (sl.prop.trick !== 'none') {
          sl.s.busy += FRAME;
          sl.s.busyTier[tier] += FRAME;
        }
      }
    }
    if (out === 'finish') {
      g.finishes++;
      const fin: RunEvent = { type: 'finish', time: run.time ?? 0, best: false, previousBest: null };
      deliver(fin);
      return;
    }
    if (out === 'fall' || out === 'kill') {
      g.deaths++;
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      place(sp.pos);
      deliver({ type: 'respawn', reason: 'fall' });
      const from = run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0;
      bot = follower(from, sp.pos);
      continue;
    }
    if (bot.status === 'failed') return;
  }
}

const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(0)} %` : '–');
const report: Record<string, unknown> = {};
for (const lv of [buildLevel1(), buildLevel2()]) {
  const level = compileLevel(lv);
  for (const m of MODELS) {
    const slots = makeSlots();
    const g: Global = { time: 0, timeTier: [0, 0, 0, 0], air: 0, surf: 0, jumps: [0, 0, 0, 0], perfect: 0, milestones: 0, checkpoints: 0, deaths: 0, finishes: 0 };
    for (const seed of SEEDS) {
      for (const sl of slots) {
        sl.prop.reset();
        sl.queued.reset();
      }
      runOnce(level, m, seed, slots, g);
    }
    const min = g.time / 60;
    const props: Record<string, unknown> = {};
    for (const sl of slots) {
      const s = sl.s;
      props[sl.name] = {
        busyShare: pct(s.busy, g.time),
        busyShareByTier: s.busyTier.map((b, i) => pct(b, s.timeTier[i])).join(' / '),
        tricksPerMin: +(Object.values(s.starts).reduce((a, b) => a + b, 0) / min).toFixed(1),
        starts: s.starts,
        'Sprünge (Stufe ≥1) mit Trick': pct(s.jumpsT1Captured, s.jumpsT1),
        'perfekte Hops mit Trick': pct(s.perfectCaptured, s.perfect),
        'mit 1-Platz-Puffer 0.25 s: Sprünge': pct(s.queuedCaptured, s.jumpsT1),
        'mit Puffer: perfekte Hops': pct(s.queuedPerfectCaptured, s.perfect),
      };
    }
    report[`${lv.id} · ${m.name}`] = {
      runs: SEEDS.length,
      finishes: g.finishes,
      deaths: g.deaths,
      seconds: +g.time.toFixed(1),
      'Zeit je Stufe (0/1/2/3)': g.timeTier.map((t) => pct(t, g.time)).join(' / '),
      airShare: pct(g.air, g.time),
      surfShare: pct(g.surf, g.time),
      'Sprünge/min je Stufe (0/1/2/3)': g.jumps.map((j) => +(j / min).toFixed(1)).join(' / '),
      perfectPerMin: +(g.perfect / min).toFixed(1),
      milestonesPerMin: +(g.milestones / min).toFixed(1),
      checkpointsPerMin: +(g.checkpoints / min).toFixed(1),
      props,
    };
  }
}
mkdirSync('shots/v2/kosmetik', { recursive: true });
writeFileSync('shots/v2/kosmetik/event-probe.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
