import { describe, expect, it } from 'vitest';
import { FixedLoop } from '../src/engine/Loop';
import { InputState, PITCH_LIMIT } from '../src/engine/InputState';
import type { PlayerInput } from '../src/player/types';

const LOOK = { sensitivity: 1, mYaw: 0.022, invertY: false };
const DEG = Math.PI / 180;

describe('InputState — Subtick-Yaw im Zusammenspiel mit FixedLoop', () => {
  /** Loop wie im Spiel verdrahtet: Blick-Sample in jedem Frame, Tick-Zeit u an tickInput. */
  function wired(input: InputState, tickRate: number, onYaw: (yaw: number, i: number, n: number) => void): FixedLoop {
    return new FixedLoop({
      tickRate,
      onTick: (_dt, i, n, u) => onYaw(input.tickInput(i, n, u).yaw, i, n),
      onFrame: () => undefined,
      onFrameStart: () => input.beginFrame(),
      now: () => 0,
    });
  }

  it('verteilt die Mausbewegung eines Frames gleichmäßig über dessen Ticks', () => {
    const input = new InputState();
    const yaws: number[] = [];
    const loop = wired(input, 128, (y) => yaws.push(y));
    // 300 Counts nach links → +6.6°.
    input.look(-300, 0, LOOK);
    loop.advance(3 / 128); // genau 3 Ticks
    const total = 300 * 0.022 * DEG;
    expect(yaws.length).toBe(3);
    expect(yaws[0]).toBeCloseTo(total / 3, 10);
    expect(yaws[1]).toBeCloseTo((2 * total) / 3, 10);
    expect(yaws[2]).toBeCloseTo(total, 10);
  });

  it('Frames ohne Tick: der Tick bekommt die Drehung, die in seine Zeit fällt — nicht alles', () => {
    // 100 Tick, Frames à 4 ms: Frame 1 und 2 ohne Tick, Frame 3 hat den Tick bei t = 10 ms.
    const input = new InputState();
    const yaws: number[] = [];
    const loop = wired(input, 100, (y) => yaws.push(y));
    const perFrame = 100 * 0.022 * DEG;
    for (let f = 0; f < 3; f++) {
      input.look(-100, 0, LOOK);
      loop.advance(0.004);
    }
    expect(yaws.length).toBe(1);
    // Maus linear: 10 ms von 12 ms → 2,5 Frames Drehung (Index-Verteilung gäbe 3).
    expect(yaws[0]).toBeCloseTo(2.5 * perFrame, 10);
    // Der Rest (0,5 Frames) landet im nächsten Tick: Frame 4 leer, Frame 5 (t = 20 ms) tickt.
    input.look(-100, 0, LOOK);
    loop.advance(0.004);
    expect(yaws.length).toBe(1);
    input.look(-100, 0, LOOK);
    loop.advance(0.004);
    expect(yaws.length).toBe(2);
    expect(yaws[1]).toBeCloseTo(5 * perFrame, 10);
  });

  it('144 Hz bei 128 Tick: konstante Mausrate ergibt gleich große Yaw-Schritte pro Tick', () => {
    // Früher (Verteilung nach Index): Schritt 0,89×…1,78× des Ideals, 6–14 % weniger Strafe-Gewinn.
    for (const [hz, tick] of [[144, 128], [165, 128], [60, 128], [240, 128], [144, 64]] as const) {
      const input = new InputState();
      const yaws: number[] = [];
      const loop = wired(input, tick, (y) => yaws.push(y));
      loop.advance(0.37 / tick); // beliebige Phasenlage zwischen Frame- und Tick-Raster
      const countsPerFrame = 5;
      for (let f = 0; f < hz; f++) {
        input.look(-countsPerFrame, 0, LOOK);
        loop.advance(1 / hz);
      }
      const ideal = (countsPerFrame * 0.022 * DEG * hz) / tick;
      expect(yaws.length).toBeGreaterThan(tick - 3);
      for (let k = 1; k < yaws.length; k++) expect(yaws[k] - yaws[k - 1]).toBeCloseTo(ideal, 9);
    }
  });

  it('keine Frame-Latenz: jeder Tick sieht die Mausbewegung bis zu seinem Zeitpunkt', () => {
    // Tick-Ende liegt Rest·dt vor dem Frame (Simulation hinkt um den Akkumulator nach);
    // sein Yaw ist exakt der Maus-Stand zu dieser Zeit — nicht der des vorigen Frames.
    const input = new InputState();
    let lastTickYaw = 0;
    const loop = wired(input, 128, (y, i, n) => {
      if (i === n - 1) lastTickYaw = y;
    });
    const rate = 7 * 0.022 * DEG * 60; // rad/s bei 7 Counts pro 60-Hz-Frame
    let t = 0;
    for (let f = 0; f < 50; f++) {
      input.look(-7, 0, LOOK);
      const before = loop.tickCount;
      loop.advance(1 / 60);
      t += 1 / 60;
      expect(loop.tickCount).toBeGreaterThan(before);
      const simT = loop.tickCount / 128;
      expect(lastTickYaw).toBeCloseTo(rate * simT, 9);
      // Der Rückstand ist kleiner als ein Tick Drehung.
      expect(input.yaw - lastTickYaw).toBeLessThan(rate / 128 + 1e-12);
      expect(t - simT).toBeLessThan(1 / 128);
    }
  });

  it('ohne beginFrame (Aufrufer ohne Loop): Tick 0 sampelt selbst, Verteilung nach Index', () => {
    const input = new InputState();
    input.look(-100, 0, LOOK);
    input.look(-100, 0, LOOK);
    const a = input.tickInput(0, 2).yaw;
    const b = input.tickInput(1, 2).yaw;
    const total = 200 * 0.022 * DEG;
    expect(a).toBeCloseTo(total / 2, 10);
    expect(b).toBeCloseTo(total, 10);
  });

  it('Maus rechts = yaw kleiner, Maus runter = pitch kleiner, invertY dreht um, Pitch geklemmt', () => {
    const input = new InputState();
    input.look(100, 0, LOOK);
    expect(input.yaw).toBeLessThan(0);
    input.look(0, 50, LOOK);
    expect(input.pitch).toBeLessThan(0);
    input.setView(0, 0);
    input.look(0, 50, { ...LOOK, invertY: true });
    expect(input.pitch).toBeGreaterThan(0);
    input.look(0, 1e6, { ...LOOK, invertY: true });
    expect(input.pitch).toBeCloseTo(PITCH_LIMIT, 12);
  });

  it('tickInput liefert ein wiederverwendetes Objekt (keine Allokation pro Tick)', () => {
    const input = new InputState();
    const a = input.tickInput(0, 2);
    const b = input.tickInput(1, 2);
    expect(b).toBe(a);
  });

  it('setView verhindert einen Subtick-Schwenk über die alte Blickrichtung', () => {
    const input = new InputState();
    input.look(-1000, 0, LOOK);
    input.setView(Math.PI, 0);
    const first = input.tickInput(0, 3).yaw;
    expect(first).toBeCloseTo(Math.PI, 12);
  });

  it('Yaw-Wrap nach vielen Umdrehungen verschiebt nichts sichtbar', () => {
    const input = new InputState();
    input.setView(200 * Math.PI + 0.3, 0);
    input.look(-10, 0, LOOK);
    const y = input.tickInput(0, 1).yaw;
    const expected = 0.3 + 10 * 0.022 * DEG;
    const wrapped = ((y % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    expect(wrapped).toBeCloseTo(expected, 9);
    expect(Math.abs(y)).toBeLessThan(4 * Math.PI);
  });
});

describe('InputState — Tasten und Sprung-Flanken', () => {
  const tick = (s: InputState): PlayerInput => s.tickInput(0, 1);

  it('W/S und A/D heben sich auf wie in Source', () => {
    const s = new InputState();
    s.keyDown('KeyW', false);
    s.keyDown('KeyS', false);
    s.keyDown('KeyD', false);
    let inp = tick(s);
    expect(inp.forward).toBe(0);
    expect(inp.side).toBe(1);
    s.keyDown('KeyA', false);
    inp = tick(s);
    expect(inp.side).toBe(0);
    s.keyUp('KeyS');
    expect(tick(s).forward).toBe(1);
  });

  it('Druck + Loslassen zwischen zwei Ticks ergibt genau einen jumpPressed-Tick', () => {
    const s = new InputState();
    s.keyDown('Space', false);
    s.keyUp('Space');
    const a = tick(s);
    expect(a.jumpPressed).toBe(true);
    expect(a.jumpHeld).toBe(true);
    const b = tick(s);
    expect(b.jumpPressed).toBe(false);
    expect(b.jumpHeld).toBe(false);
  });

  it('gehaltene Leertaste: Flanke nur einmal, Auto-Repeat löst nichts aus, jumpHeld bleibt', () => {
    const s = new InputState();
    s.keyDown('Space', false);
    expect(tick(s).jumpPressed).toBe(true);
    s.keyDown('Space', true);
    const b = tick(s);
    expect(b.jumpPressed).toBe(false);
    expect(b.jumpHeld).toBe(true);
  });

  it('Mausrad: jedes Event ein Impuls, gilt genau einen Tick als gehalten', () => {
    const s = new InputState();
    s.wheel();
    const a = tick(s);
    expect(a.jumpPressed).toBe(true);
    expect(a.jumpHeld).toBe(true);
    const b = tick(s);
    expect(b.jumpPressed).toBe(false);
    expect(b.jumpHeld).toBe(false);
  });

  it('Sprung-Flanke landet im ersten Tick des Frames, nicht in allen', () => {
    const s = new InputState();
    s.keyDown('Space', false);
    s.keyUp('Space');
    const presses = [0, 1, 2].map((i) => s.tickInput(i, 3).jumpPressed);
    expect(presses).toEqual([true, false, false]);
  });

  it('Ducken über C und Strg, Sprint über Shift links', () => {
    const s = new InputState();
    s.keyDown('ControlLeft', false);
    expect(tick(s).crouch).toBe(true);
    s.keyUp('ControlLeft');
    s.keyDown('KeyC', false);
    expect(tick(s).crouch).toBe(true);
    s.keyDown('ShiftLeft', false);
    expect(tick(s).sprint).toBe(true);
  });

  it('Strg-Ducken abschaltbar (Fenstermodus), C duckt immer', () => {
    const s = new InputState();
    s.setCtrlCrouch(false);
    s.keyDown('ControlLeft', false);
    expect(tick(s).crouch).toBe(false);
    s.setCtrlCrouch(true);
    expect(tick(s).crouch).toBe(true);
    s.setCtrlCrouch(false);
    s.keyDown('KeyC', false);
    expect(tick(s).crouch).toBe(true);
  });

  it('releaseAll lässt alles los und verwirft wartende Sprünge', () => {
    const s = new InputState();
    s.keyDown('KeyW', false);
    s.keyDown('Space', false);
    s.releaseAll();
    const inp = tick(s);
    expect(inp.forward).toBe(0);
    expect(inp.jumpPressed).toBe(false);
    expect(inp.jumpHeld).toBe(false);
  });

  it('Aktionen: ohne Repeat, einmal konsumierbar', () => {
    const s = new InputState();
    s.keyDown('KeyR', false);
    s.keyDown('KeyR', true);
    s.keyDown('Escape', false);
    s.keyDown('F1', false);
    s.keyDown('KeyM', false);
    s.keyDown('Enter', false);
    s.keyDown('KeyF', false);
    expect(s.consumeActions()).toEqual(['restart', 'pause', 'toggleTuning', 'toggleMute', 'confirm', 'respawn']);
    expect(s.consumeActions()).toEqual([]);
  });

  it('Override ersetzt die Eingabe, verbraucht aber wartende Flanken', () => {
    const s = new InputState();
    s.keyDown('Space', false);
    s.setOverride((i, n) => ({ forward: 1, side: 0, jumpHeld: false, jumpPressed: false, crouch: false, sprint: false, yaw: i / n, pitch: 0 }));
    expect(s.tickInput(1, 2).yaw).toBeCloseTo(0.5, 12);
    s.setOverride(null);
    expect(tick(s).jumpPressed).toBe(false);
  });
});
