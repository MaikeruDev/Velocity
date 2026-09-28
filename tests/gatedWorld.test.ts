import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { RouteFollower, mulberry32 } from '../src/player/bots';
import { GatedWorld } from '../src/world/collision/GatedWorld';
import type { CollisionWorld, TraceResult } from '../src/world/collision/types';
import { makeTraceResult } from '../src/world/collision/types';
import { compileLevel } from '../src/world/level/compileLevel';
import type { CompiledGate, CompiledLevel } from '../src/world/level/compileLevel';
import type { GateDef, LevelFile, Vec3Tuple } from '../src/world/level/LevelFormat';
import { box, makeLevel } from '../tools/sim/levels';

/**
 * GatedWorld (Plan 007, TC2): BrushWorld + Tore der Lektion. Ohne geschlossenes Tor (keine Tore, alle offen,
 * geschlossene nur weit weg) ist jedes Trace-Ergebnis bitgleich zur BrushWorld — Abnahme: L1/L2-Bot-Läufe
 * über 8 Seeds positionsgleich in jedem Tick. Ein geschlossenes Tor blockiert, ein offenes nicht.
 */

const CFG = VELOCITY_DEFAULT;
const MINS = new Vector3(-16, 0, -16);
const MAXS = new Vector3(16, 72, 16);

function readLevel(file: string): LevelFile {
  return JSON.parse(readFileSync(`public/levels/${file}`, 'utf8')) as LevelFile;
}

/** Tore als CompiledGate (über eine Hilfs-Lektion kompiliert, nur die Tore werden benutzt). */
function gatesOf(defs: readonly GateDef[]): readonly CompiledGate[] {
  const lesson: LevelFile = {
    ...makeLevel([box([-64, -64, -64], [64, 0, 64])]),
    training: { lesson: 1, short: 'T0', group: 'basics', gates: defs, stages: [{ id: 's', title: 'S', text: 'S', task: { kind: 'hopChain', count: 1 } }] },
  };
  return compileLevel(lesson).gates;
}

/** Tor als Würfel um einen Punkt. */
function gateAt(id: string, p: Vec3Tuple, half: number): GateDef {
  return { id, min: [p[0] - half, p[1] - half, p[2] - half], max: [p[0] + half, p[1] + half, p[2] + half] };
}

function sameTrace(a: TraceResult, b: TraceResult): boolean {
  return (
    a.fraction === b.fraction &&
    a.endPos.equals(b.endPos) &&
    a.normal.equals(b.normal) &&
    a.startSolid === b.startSolid &&
    a.allSolid === b.allSolid &&
    a.brushIndex === b.brushIndex
  );
}

describe('GatedWorld — Tore', () => {
  // Gang entlang −Z, Tor quer darüber bei z −500.
  const level = compileLevel(makeLevel([box([-512, -64, -2000], [512, 0, 200])]));
  const gates = gatesOf([{ id: 'tor', min: [-512, 0, -524], max: [512, 300, -500] }, { id: 'fern', min: [5000, 0, 5000], max: [5100, 100, 5100] }]);

  it('geschlossen blockiert (fraction < 1, Tor-Brush), offen nicht', () => {
    const w = new GatedWorld(level.world, gates);
    const from = new Vector3(0, 1, 0);
    const to = new Vector3(0, 1, -1000);
    const closed = w.traceBox(from, to, MINS, MAXS);
    expect(closed.fraction).toBeLessThan(1);
    expect(closed.endPos.z).toBeGreaterThan(-500);
    expect(closed.brushIndex).toBe(gates[0].brush.index);
    expect(closed.normal.z).toBeCloseTo(1, 6);
    w.setOpen(w.indexOf('tor'), true);
    expect(w.isOpen(0)).toBe(true);
    expect(w.traceBox(from, to, MINS, MAXS).fraction).toBe(1);
    w.closeAll();
    expect(w.isOpen(0)).toBe(false);
    expect(w.traceBox(from, to, MINS, MAXS).fraction).toBeLessThan(1);
  });

  it('testBox im Tor: geschlossen solide, offen frei; unbekannte ids/Indizes schaden nicht', () => {
    const w = new GatedWorld(level.world, gates);
    const inGate = new Vector3(0, 10, -512);
    expect(w.testBox(inGate, MINS, MAXS)).toBe(true);
    w.setOpen(0, true);
    expect(w.testBox(inGate, MINS, MAXS)).toBe(false);
    expect(w.indexOf('gibtsnicht')).toBe(-1);
    w.setOpen(-1, true);
    w.setOpen(99, false);
    expect(w.isOpen(0)).toBe(true);
  });

  it('eine Wand der Basiswelt davor bleibt der Treffer (nur ein früherer Treffer ersetzt)', () => {
    const walled = compileLevel(makeLevel([box([-512, -64, -2000], [512, 0, 200]), box([-512, 0, -320], [512, 300, -300])]));
    const w = new GatedWorld(walled.world, gates);
    const base = walled.world.traceBox(new Vector3(0, 1, 0), new Vector3(0, 1, -1000), MINS, MAXS, makeTraceResult());
    const gated = w.traceBox(new Vector3(0, 1, 0), new Vector3(0, 1, -1000), MINS, MAXS, makeTraceResult());
    expect(sameTrace(base, gated)).toBe(true);
  });

  it('ohne geschlossenes Tor bitgleich zur Basiswelt (2000 Zufalls-Traces)', () => {
    const l1 = compileLevel(readLevel('level1.json'));
    const b = l1.bounds;
    const open = new GatedWorld(l1.world, gatesOf([gateAt('a', [0, 0, -1000], 400), gateAt('b', [0, 100, -3000], 600)]));
    open.setOpen(0, true);
    open.setOpen(1, true);
    const none = new GatedWorld(l1.world, []);
    const rand = mulberry32(42);
    const at = (): Vector3 => new Vector3(b.min.x + rand() * (b.max.x - b.min.x), b.min.y + rand() * (b.max.y - b.min.y), b.min.z + rand() * (b.max.z - b.min.z));
    const ra = makeTraceResult();
    const rb = makeTraceResult();
    const rc = makeTraceResult();
    for (let i = 0; i < 2000; i++) {
      const from = at();
      const to = rand() < 0.2 ? from.clone() : at();
      l1.world.traceBox(from, to, MINS, MAXS, ra);
      open.traceBox(from, to, MINS, MAXS, rb);
      none.traceBox(from, to, MINS, MAXS, rc);
      expect(sameTrace(ra, rb)).toBe(true);
      expect(sameTrace(ra, rc)).toBe(true);
      expect(open.testBox(from, MINS, MAXS)).toBe(l1.world.testBox(from, MINS, MAXS));
    }
  });
});

/**
 * Bot-Lauf in zwei Welten im Gleichschritt: gleiche Eingaben (Seed), jeder Tick positionsgleich. Die Welt
 * geht auch in die Landevorhersage des RouteFollowers — alles läuft durch die GatedWorld.
 */
function lockstep(level: CompiledLevel, a: CollisionWorld, b: CollisionWorld, seed: number, seconds: number): { ticks: number; firstDiff: number; reached: number; total: number } {
  const route = level.def.route ?? [];
  const pa = new PlayerMovement(a, CFG);
  const pb = new PlayerMovement(b, CFG);
  pa.teleport(level.spawnPos);
  pb.teleport(level.spawnPos);
  const opts = { aimNoiseDeg: 3, seed, killY: level.def.killY, start: { x: level.spawnPos.x, z: level.spawnPos.z } };
  const fa = new RouteFollower(route, CFG, { ...opts, world: a });
  const fb = new RouteFollower(route, CFG, { ...opts, world: b });
  const n = Math.ceil(seconds * CFG.tickRate);
  let i = 0;
  for (; i < n && fa.status === 'running'; i++) {
    pa.tick(fa.next(pa.state, pa.surfNormal));
    pb.tick(fb.next(pb.state, pb.surfNormal));
    if (!pa.state.pos.equals(pb.state.pos) || !pa.state.vel.equals(pb.state.vel)) return { ticks: i + 1, firstDiff: i, reached: fa.report.reached, total: route.length };
  }
  return { ticks: i, firstDiff: -1, reached: fa.report.reached, total: route.length };
}

describe('GatedWorld — L1/L2-Bot-Läufe positionsgleich zur BrushWorld (8 Seeds, jeder Tick)', () => {
  for (const file of ['level1.json', 'level2.json']) {
    const level = compileLevel(readLevel(file));
    const route = level.def.route ?? [];
    // Offene Tore genau auf der Route (würden geschlossen blockieren) und geschlossene weit draußen (AABB-Pfad).
    const onRoute = [3, Math.floor(route.length / 2), route.length - 3].map((k, i) => gateAt(`r${i}`, route[k].pos, 200));
    const far = [gateAt('fern0', [90000, 0, 90000], 100), gateAt('fern1', [-90000, 500, 0], 100)];
    const gates = gatesOf([...onRoute, ...far]);

    it(`${file}: offene Tore auf der Route, geschlossene weit weg → jeder Tick gleich`, () => {
      for (let seed = 1; seed <= 8; seed++) {
        const gated = new GatedWorld(level.world, gates);
        for (let i = 0; i < onRoute.length; i++) gated.setOpen(i, true);
        const r = lockstep(level, level.world, gated, seed, 60);
        expect(r.firstDiff, `Seed ${seed}: erste Abweichung in Tick ${r.firstDiff}`).toBe(-1);
        // Der Lauf muss weit kommen, sonst prüft er nichts (Hand 3° schafft L1/L2 in der Regel ganz).
        expect(r.reached, `Seed ${seed}: ${r.reached}/${r.total} Knoten in ${r.ticks} Ticks`).toBeGreaterThan(r.total * 0.8);
      }
    });

    it(`${file}: Gegenprobe — dasselbe Tor geschlossen verändert den Lauf`, () => {
      const gated = new GatedWorld(level.world, gates);
      const r = lockstep(level, level.world, gated, 1, 60);
      expect(r.firstDiff).toBeGreaterThanOrEqual(0);
    });
  }
});
