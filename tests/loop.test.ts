import { describe, expect, it } from 'vitest';
import { FixedLoop } from '../src/engine/Loop';

interface Recorded {
  ticks: { dt: number; i: number; n: number }[];
  frames: { alpha: number; frameDt: number }[];
}

function makeLoop(tickRate = 128, extra: { maxFrameTime?: number; maxTicksPerFrame?: number } = {}) {
  const rec: Recorded = { ticks: [], frames: [] };
  const loop = new FixedLoop({
    tickRate,
    onTick: (dt, i, n) => rec.ticks.push({ dt, i, n }),
    onFrame: (alpha, frameDt) => rec.frames.push({ alpha, frameDt }),
    now: () => 0,
    ...extra,
  });
  return { loop, rec };
}

describe('FixedLoop', () => {
  it('60-Hz-Frames bei 128 Hz ergeben über eine Sekunde exakt 128 Ticks', () => {
    const { loop, rec } = makeLoop(128);
    for (let f = 0; f < 60; f++) loop.advance(1 / 60);
    expect(rec.ticks.length).toBe(128);
    expect(rec.frames.length).toBe(60);
    // Pro Frame 2 oder 3 Ticks, nie 0 oder 4.
    const perFrame = new Map<number, number>();
    for (const t of rec.ticks) if (t.i === 0) perFrame.set(perFrame.size, t.n);
    for (const n of perFrame.values()) expect([2, 3]).toContain(n);
  });

  it('Tickzahl n steht vor dem ersten Tick fest und i läuft 0..n-1', () => {
    const { loop, rec } = makeLoop(128);
    loop.advance(3.5 / 128); // 3 Ticks + halber Rest
    expect(rec.ticks.map((t) => [t.i, t.n])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(rec.frames[0].alpha).toBeCloseTo(0.5, 6);
    expect(rec.ticks[0].dt).toBeCloseTo(1 / 128, 12);
  });

  it('Akkumulator trägt Reste über Frames (alpha steigt, dann Tick)', () => {
    const { loop, rec } = makeLoop(100);
    loop.advance(0.004); // 0 Ticks, alpha 0.4
    loop.advance(0.004); // 0 Ticks, alpha 0.8
    loop.advance(0.004); // 1 Tick, alpha 0.2
    expect(rec.ticks.length).toBe(1);
    expect(rec.frames.map((f) => f.alpha)).toEqual([expect.closeTo(0.4, 6), expect.closeTo(0.8, 6), expect.closeTo(0.2, 6)]);
  });

  it('exakte Vielfache verlieren durch Float-Summation keinen Tick', () => {
    const { loop, rec } = makeLoop(128);
    for (let f = 0; f < 1000; f++) loop.advance(1 / 64);
    expect(rec.ticks.length).toBe(2000);
    for (const t of rec.ticks) expect(t.n).toBe(2);
  });

  it('Spiral of Death: langer Frame wird gekappt statt nachgeholt', () => {
    const { loop, rec } = makeLoop(128, { maxFrameTime: 0.1 });
    loop.advance(5);
    expect(rec.ticks.length).toBeLessThanOrEqual(Math.ceil(0.1 * 128) + 1);
    expect(rec.frames[0].frameDt).toBeCloseTo(0.1, 9);
    expect(loop.droppedTime).toBeGreaterThan(4.8);
    // Danach normaler Takt ohne Nachholen.
    rec.ticks.length = 0;
    loop.advance(1 / 64);
    expect(rec.ticks.length).toBe(2);
  });

  it('maxTicksPerFrame begrenzt hart und verwirft den Überschuss', () => {
    const { loop, rec } = makeLoop(128, { maxFrameTime: 1, maxTicksPerFrame: 4 });
    loop.advance(0.5);
    expect(rec.ticks.length).toBe(4);
    expect(rec.ticks.every((t) => t.n === 4)).toBe(true);
    expect(rec.frames[0].alpha).toBeGreaterThanOrEqual(0);
    expect(rec.frames[0].alpha).toBeLessThan(1);
    rec.ticks.length = 0;
    loop.advance(0);
    expect(rec.ticks.length).toBe(0);
  });

  it('stepTicks: n × onTick mit (i, n), dann genau ein onFrame(alpha = 1)', () => {
    const { loop, rec } = makeLoop(128);
    loop.advance(0.5 / 128); // halber Tick im Akkumulator
    rec.frames.length = 0;
    loop.stepTicks(5);
    expect(rec.ticks.map((t) => t.i)).toEqual([0, 1, 2, 3, 4]);
    expect(rec.ticks.every((t) => t.n === 5)).toBe(true);
    expect(rec.frames).toEqual([{ alpha: 1, frameDt: 5 / 128 }]);
    expect(loop.tickCount).toBe(5);
    // Akkumulator unberührt: der halbe Tick ist noch da.
    rec.ticks.length = 0;
    loop.advance(0.5 / 128);
    expect(rec.ticks.length).toBe(1);
  });

  it('stepTicks(0) ruft nur onFrame', () => {
    const { loop, rec } = makeLoop(128);
    loop.stepTicks(0);
    expect(rec.ticks.length).toBe(0);
    expect(rec.frames.length).toBe(1);
  });

  it('setTickRate ändert dt und lässt keinen Tick-Stau entstehen', () => {
    const { loop, rec } = makeLoop(64);
    loop.advance(0.9 / 64);
    loop.setTickRate(128);
    expect(loop.dt).toBeCloseTo(1 / 128, 12);
    loop.advance(0);
    expect(rec.ticks.length).toBeLessThanOrEqual(1);
    expect(() => loop.setTickRate(0)).toThrow();
  });

  it('start/stop mit injiziertem Scheduler: erster Frame simuliert 0 s, danach echte Deltas', () => {
    const queue: ((t: number) => void)[] = [];
    let ticks = 0;
    let frames = 0;
    const loop = new FixedLoop({
      tickRate: 100,
      onTick: () => ticks++,
      onFrame: () => frames++,
      requestFrame: (cb) => queue.push(cb),
      cancelFrame: () => undefined,
      now: () => 0,
    });
    loop.start();
    expect(loop.running).toBe(true);
    const run = (t: number): void => {
      const cb = queue.shift();
      if (cb) cb(t);
    };
    run(1000); // Initial-Frame
    expect(ticks).toBe(0);
    run(1050); // 50 ms → 5 Ticks
    expect(ticks).toBe(5);
    loop.resetTiming(); // wie nach Tab-Wechsel
    run(9000); // Lücke wird nicht nachgeholt
    expect(ticks).toBe(5);
    run(9010);
    expect(ticks).toBe(6);
    loop.stop();
    expect(loop.running).toBe(false);
    const before = frames;
    run(9020);
    expect(frames).toBe(before);
  });
});
