import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RunState } from '../src/engine/runState';
import type { RunEvent } from '../src/engine/events';
import { compileLevel } from '../src/world/level/compileLevel';
import type { LevelFile } from '../src/world/level/LevelFormat';

/**
 * Lauf-Logik ohne Browser: Start-Zone, Timer tickgenau, Checkpoints nur in
 * Reihenfolge, Ziel erst nach allen, Kill/Fall, Meilensteine pro Luftabschnitt.
 */

const DEF: LevelFile = {
  version: 1,
  id: 'runstate',
  name: 'RUNSTATE',
  spawn: { pos: [0, 0, 0], yaw: 0 },
  killY: -500,
  environment: {
    skyTop: '#000000',
    skyHorizon: '#000000',
    skyBottom: '#000000',
    fogColor: '#000000',
    fogNear: 1000,
    fogFar: 5000,
    sunDir: [0, 1, 0],
    sunColor: '#ffffff',
    ambientSky: '#ffffff',
    ambientGround: '#000000',
    trimColor: '#33f0ff',
    voidY: -1000,
  },
  brushes: [{ type: 'box', mat: 'floor', min: [-128, -32, -2000], max: [128, 0, 128] }],
  triggers: [
    { kind: 'start', min: [-128, 0, -64], max: [128, 128, 64] },
    // Absichtlich vertauschte Reihenfolge in der Datei: order zählt, nicht die Position im Array.
    { kind: 'checkpoint', order: 2, min: [-128, 0, -1064], max: [128, 128, -1000], spawn: { pos: [0, 0, -1032], yaw: 90 } },
    { kind: 'checkpoint', order: 1, min: [-128, 0, -564], max: [128, 128, -500], spawn: { pos: [0, 0, -532], yaw: 0 } },
    { kind: 'finish', min: [-128, 0, -1564], max: [128, 128, -1500] },
    { kind: 'kill', min: [500, -100, -100], max: [600, 0, 100] },
  ],
};

const LEVEL = compileLevel(DEF);
const MINS = new Vector3(-16, 0, -16);
const MAXS = new Vector3(16, 72, 16);
const DT = 1 / 128;

function harness(best: readonly number[] | null = null) {
  const run = new RunState(LEVEL);
  run.reset(best);
  const out: RunEvent[] = [];
  const pos = new Vector3();
  const tick = (x: number, y: number, z: number, speed = 250, onGround = true) => {
    pos.set(x, y, z);
    const outcome = run.tick(DT, pos, MINS, MAXS, speed, onGround, out);
    return { outcome, events: out.map((e) => ({ ...e })) };
  };
  return { run, tick };
}

describe('RunState — Timer und Start-Zone', () => {
  it('startet im Tick, in dem die Hull die Start-Zone verlässt, und zählt dann tickgenau', () => {
    const { run, tick } = harness();
    expect(tick(0, 0, 0).events).toEqual([]);
    expect(run.time).toBeNull();
    // Hull-Vorderkante −16: bei z = −80 reicht sie bis −64 (Berührung zählt nicht als drin).
    const leave = tick(0, 0, -81);
    expect(leave.events.map((e) => e.type)).toEqual(['runStart']);
    expect(run.time).toBe(0);
    expect(run.running).toBe(true);
    for (let i = 0; i < 128; i++) tick(0, 0, -200);
    expect(run.time).toBe(1); // 128 × 1/128 ist binär exakt
  });

  it('zurück in die Start-Zone vor dem ersten Checkpoint = Fehlstart, Timer aus', () => {
    const { run, tick } = harness();
    tick(0, 0, -200);
    tick(0, 0, -200);
    expect(run.running).toBe(true);
    tick(0, 0, 0);
    expect(run.time).toBeNull();
    expect(tick(0, 0, -200).events.map((e) => e.type)).toEqual(['runStart']);
  });

  it('nach dem ersten Checkpoint ignoriert die Start-Zone den Spieler', () => {
    const { run, tick } = harness();
    tick(0, 0, -200);
    tick(0, 0, -532);
    expect(run.checkpoint).toBe(1);
    tick(0, 0, 0);
    expect(run.running).toBe(true);
  });
});

describe('RunState — Checkpoints und Ziel', () => {
  it('zählt Checkpoints nur in Reihenfolge; split null ohne Bestzeit', () => {
    const { run, tick } = harness();
    tick(0, 0, -200);
    expect(tick(0, 0, -1032).events).toEqual([]);
    expect(run.checkpoint).toBe(0);
    const cp1 = tick(0, 0, -532).events;
    expect(cp1).toHaveLength(1);
    expect(cp1[0]).toMatchObject({ type: 'checkpoint', index: 1, total: 2, split: null });
    expect(run.respawnPoint().pos.z).toBe(-532);
    tick(0, 0, -1032);
    expect(run.checkpoint).toBe(2);
    expect(run.respawnPoint().yaw).toBe(90);
  });

  it('split = Laufzeit − Zwischenzeit der Bestzeit', () => {
    const { tick } = harness([0.5, 10]);
    tick(0, 0, -200);
    for (let i = 0; i < 63; i++) tick(0, 0, -300);
    const e = tick(0, 0, -532).events[0];
    expect(e).toMatchObject({ type: 'checkpoint', index: 1, time: 0.5 });
    expect(e.type === 'checkpoint' ? e.split : NaN).toBeCloseTo(0, 9);
  });

  it('Ziel zählt erst nach allen Checkpoints; danach steht der Timer', () => {
    const { run, tick } = harness();
    tick(0, 0, -200);
    tick(0, 0, -532);
    expect(tick(0, 0, -1532).outcome).toBe('none');
    tick(0, 0, -1032);
    expect(tick(0, 0, -1532).outcome).toBe('finish');
    expect(run.finished).toBe(true);
    expect(run.running).toBe(false);
    const t = run.time;
    tick(0, 0, -1532);
    expect(run.time).toBe(t);
    expect(run.splits()).toHaveLength(2);
  });

  it('meldet Kill-Zone und Fall unter killY', () => {
    const { run, tick } = harness();
    expect(tick(550, -50, 0).outcome).toBe('kill');
    expect(tick(0, -501, -300).outcome).toBe('fall');
    expect(run.respawnPoint().pos.z).toBe(0); // noch kein Checkpoint → Level-Spawn
  });
});

describe('RunState — Speed-Meilensteine', () => {
  it('einmal pro Luftabschnitt; wer schon schneller abspringt, bekommt die Schwelle nicht', () => {
    const { tick } = harness();
    const ms = (speed: number, ground: boolean) =>
      tick(0, 0, -300, speed, ground).events.filter((e) => e.type === 'speedMilestone').map((e) => (e.type === 'speedMilestone' ? e.speed : 0));
    expect(ms(520, true)).toEqual([]);
    expect(ms(530, false)).toEqual([]);
    expect(ms(760, false)).toEqual([750]);
    expect(ms(700, false)).toEqual([]);
    expect(ms(780, false)).toEqual([]);
    expect(ms(1100, false)).toEqual([1000]);
    expect(ms(690, true)).toEqual([]);
    expect(ms(760, false)).toEqual([750]);
  });
});
