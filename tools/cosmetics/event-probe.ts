/**
 * Abnahme-Werkzeug (Plan 007): Trick-Takt der Gegenstände in echten Bot-Läufen. RouteFollower +
 * PlayerMovement + RunState (wie physics.timedRun) auf Level 1/2, Events wie im Spiel an die
 * Trick-Maschinen aus PROP_FACTORIES, Frames mit 60 Hz.
 *   npx tsx tools/cosmetics/event-probe.ts [item …]   → shots/v2/kosmetik/event-probe-core.json
 *
 * Gemessen je Gegenstand und Level × Spielertyp (sync 1.0 und 1.5°-Hand, je 3 Seeds):
 * - Trick-Anteil der Laufzeit OHNE Zustands-Tricks (Surf-Balance zählt nicht) — Ziel 25–45 %; zusätzlich
 *   bezogen auf die Zeit außerhalb der Zustände (dort hat ein Gegenstand ohne Surf-Zustand Platz für Tricks),
 * - Tricks pro Minute (Starts ohne Zustände) — Ziel 20–32,
 * - Surf-Abdeckung: Anteil der Surf-Zeit ≥ 500 u/s, in der ein Surf-Zustand sichtbar läuft.
 * Referenz Dose/Karte/Messer (Plan 006): 22–42 %, 21–32/min. (Ursprung: tools/critique/v2/kosmetik/event-probe.ts)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { compileLevel } from '../../src/world/level/compileLevel';
import type { CompiledLevel } from '../../src/world/level/compileLevel';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { VELOCITY_DEFAULT } from '../../src/player/MovementConfig';
import { RouteFollower } from '../../src/player/bots/RouteFollower';
import { RunState } from '../../src/engine/runState';
import type { GameEvent, RunEvent } from '../../src/engine/events';
import type { HeldItemId } from '../../src/engine/settingsTypes';
import { PROP_FACTORIES } from '../../src/ui/hand/ViewHand';
import type { PropControl } from '../../src/ui/hand/propTricks';
import { speedTier } from '../../src/ui/hand/anim';
import { resumeIndex } from '../levels/physics';
import { buildLevel1 } from '../levels/level1';
import { buildLevel2 } from '../levels/level2';

interface Model {
  readonly name: string;
  readonly sync?: number;
  readonly aimNoiseDeg?: number;
}

const MODELS: readonly Model[] = [
  { name: 'sync1.0', sync: 1 },
  { name: 'Hand 1.5°', aimNoiseDeg: 1.5 },
];
const SEEDS = [1, 2, 3];
const FRAME = 1 / 60;
const SURF_FROM = 500;

interface Stats {
  busy: number;
  /** Zeit in Zustands-Tricks (Surf-Balance …) — dort ist kein Platz für Tricks. */
  state: number;
  starts: Record<string, number>;
  surfFast: number;
  surfShown: number;
}

interface Slot {
  readonly item: HeldItemId;
  readonly prop: PropControl;
  readonly s: Stats;
}

interface Global {
  time: number;
  surf: number;
  finishes: number;
  deaths: number;
}

const requested = process.argv.slice(2);
const ITEMS = (Object.keys(PROP_FACTORIES) as HeldItemId[]).filter((i) => PROP_FACTORIES[i] !== undefined && (requested.length === 0 || requested.includes(i)));

function makeSlots(): Slot[] {
  const out: Slot[] = [];
  for (const item of ITEMS) {
    const make = PROP_FACTORIES[item];
    if (make) out.push({ item, prop: make(), s: { busy: 0, state: 0, starts: {}, surfFast: 0, surfShown: 0 } });
  }
  return out;
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
  const inp = { speed: 0, onGround: true, surfing: false, surfSide: 0 };
  const deliver = (e: GameEvent): void => {
    for (const sl of slots) {
      const before = sl.prop.trick;
      sl.prop.onEvent(e);
      const now = sl.prop.trick;
      if (now !== before && now !== 'none' && !sl.prop.inState) sl.s.starts[now] = (sl.s.starts[now] ?? 0) + 1;
    }
  };
  for (let t = 0; t < 180 * cfg.tickRate; t++) {
    const evs = pm.tick(bot.next(pm.state, pm.surfNormal));
    const s = pm.state;
    for (const e of evs) deliver(e);
    const out = run.tick(dt, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, runEvents);
    for (const e of runEvents) deliver(e);
    acc += dt;
    while (acc >= FRAME) {
      acc -= FRAME;
      inp.speed = s.speed;
      inp.onGround = s.onGround;
      inp.surfing = s.surfing;
      g.time += FRAME;
      if (s.surfing) g.surf += FRAME;
      for (const sl of slots) {
        const before = sl.prop.trick;
        sl.prop.update(FRAME, inp);
        const now = sl.prop.trick;
        // Leerlauf-Tricks und Zustände starten im update (nicht über Events).
        if (now !== before && now !== 'none' && !sl.prop.inState) sl.s.starts[now] = (sl.s.starts[now] ?? 0) + 1;
        if (sl.prop.trick !== 'none' && !sl.prop.inState) sl.s.busy += FRAME;
        if (sl.prop.inState) sl.s.state += FRAME;
        if (s.surfing && s.speed >= SURF_FROM) {
          sl.s.surfFast += FRAME;
          if (sl.prop.inState) sl.s.surfShown += FRAME;
        }
      }
    }
    if (out === 'finish') {
      g.finishes++;
      deliver({ type: 'finish', time: run.time ?? 0, best: false, previousBest: null });
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

const pct = (a: number, b: number): number => (b > 0 ? Math.round((1000 * a) / b) / 10 : 0);
const report: Record<string, unknown> = {};
const table: string[] = [];
for (const lv of [buildLevel1(), buildLevel2()]) {
  const level = compileLevel(lv);
  for (const m of MODELS) {
    const slots = makeSlots();
    const g: Global = { time: 0, surf: 0, finishes: 0, deaths: 0 };
    for (const seed of SEEDS) {
      for (const sl of slots) sl.prop.reset();
      runOnce(level, m, seed, slots, g);
    }
    const min = g.time / 60;
    const props: Record<string, unknown> = {};
    for (const sl of slots) {
      const n = Object.values(sl.s.starts).reduce((a, b) => a + b, 0);
      const row = {
        busyShare: pct(sl.s.busy, g.time),
        /** Anteil an der Zeit OHNE Zustände (vergleichbar mit Gegenständen ohne Surf-Zustand). */
        busyShareFree: pct(sl.s.busy, g.time - sl.s.state),
        tricksPerMin: Math.round((n / min) * 10) / 10,
        surfShown: sl.s.surfFast > 0 ? pct(sl.s.surfShown, sl.s.surfFast) : null,
        starts: sl.s.starts,
      };
      props[sl.item] = row;
      table.push(`${lv.id} · ${m.name} · ${sl.item}: ${row.busyShare} % Trick (${row.busyShareFree} % ohne Zustandszeit), ${row.tricksPerMin}/min${row.surfShown !== null ? `, Surf-Zustand ${row.surfShown} %` : ''}`);
    }
    report[`${lv.id} · ${m.name}`] = { runs: SEEDS.length, finishes: g.finishes, deaths: g.deaths, seconds: Math.round(g.time * 10) / 10, surfShare: pct(g.surf, g.time), props };
  }
}
mkdirSync('shots/v2/kosmetik', { recursive: true });
writeFileSync('shots/v2/kosmetik/event-probe-core.json', JSON.stringify(report, null, 2));
console.log(table.join('\n'));
