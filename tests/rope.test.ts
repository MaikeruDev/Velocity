import { describe, expect, it } from 'vitest';
import { ROPE_CAP_G, ROPE_G, Rope, RopeDrive, UNITS_PER_IMAGE_HEIGHT, driveRope } from '../src/ui/hand/rope';
import { VIEW_AXES } from '../src/ui/hand/rot';
import { PX_PER_UNIT, deviation, hang, recordHandPath } from '../tools/cosmetics/rope-hang';

/**
 * Schnur (Plan 007, K9): Verlet-Kette mit festem Unterschritt 1/240 s. Maßstab (Plan 007):
 * geführte Enden exakt, freies Pendel framerate-unabhängig, nie NaN, nie über dem Anker.
 */

describe('Schnur: geführte Enden', () => {
  it('Anfang und geführtes Ende liegen in jedem Frame EXAKT auf den Vorgaben (0 px)', () => {
    for (const fps of [30, 60, 144, 240]) {
      const rope = new Rope({ segments: 8, length: 9 });
      const dt = 1 / fps;
      let worst = 0;
      for (let i = 0; i <= Math.round(2 * fps); i++) {
        const t = i * dt;
        // Around-the-World (Kreis r 8.5) mit wiegender Hand.
        const sx = 1.5 * Math.sin(9 * t);
        const sy = 0.4 * Math.cos(7 * t);
        const ex = 8.5 * Math.sin(2 * Math.PI * 1.8 * t);
        const ey = -8.5 * Math.cos(2 * Math.PI * 1.8 * t);
        rope.update(dt, sx, sy, 0, ex, ey, 0.3);
        const o = rope.out;
        const e = (rope.n - 1) * 3;
        worst = Math.max(worst, Math.abs(o[0] - Math.fround(sx)), Math.abs(o[1] - Math.fround(sy)), Math.abs(o[2]), Math.abs(o[e] - Math.fround(ex)), Math.abs(o[e + 1] - Math.fround(ey)), Math.abs(o[e + 2] - Math.fround(0.3)));
      }
      expect(worst, `${fps} Hz`).toBe(0);
    }
  });
});

describe('Schnur: freies Pendel an der echten HandMotion (Bhop-Kette, harte Landung, Maus-Flick)', () => {
  const REF = 2400;

  it('gleiche Handbahn: ≤ 2.5 px bei 30 Hz, ≤ 1.3 px bei 60 Hz gegen 2400 Hz (Schnur allein)', () => {
    for (const grid of [false, true]) {
      const path = recordHandPath(REF, grid);
      const ref = hang(REF, { grid, path });
      const px30 = deviation(hang(30, { grid, path }), ref, REF) * PX_PER_UNIT;
      const px60 = deviation(hang(60, { grid, path }), ref, REF) * PX_PER_UNIT;
      expect(px30, `30 Hz${grid ? ' Raster' : ''}`).toBeLessThanOrEqual(2.5);
      expect(px60, `60 Hz${grid ? ' Raster' : ''}`).toBeLessThanOrEqual(1.3);
    }
  });

  it('ganze Kette (HandMotion je Framerate, Maßstab des Entwurfs): ≤ 2.5 px bei 30 Hz, ≤ 1.3 px bei 60 Hz', () => {
    // Vorher (Hand-Impulse am Frame-Anfang, Blick-Delta aus dem Zustand am Frame-Ende): 5.84 / 2.91 px.
    for (const grid of [false, true]) {
      const ref = hang(REF, { grid });
      const px30 = deviation(hang(30, { grid }), ref, REF) * PX_PER_UNIT;
      const px60 = deviation(hang(60, { grid }), ref, REF) * PX_PER_UNIT;
      expect(px30, `30 Hz${grid ? ' Raster' : ''}`).toBeLessThanOrEqual(2.5);
      expect(px60, `60 Hz${grid ? ' Raster' : ''}`).toBeLessThanOrEqual(1.3);
    }
  });

  it('die Hand selbst ist auf dem 1/6-s-Raster framerate-unabhängig (≤ 0.2 px, vorher 6.6 px)', () => {
    const path = recordHandPath(REF, true);
    for (const fps of [30, 60, 144, 240]) {
      const own = recordHandPath(fps, true);
      let hand = 0;
      const warm = Math.round(2 * fps);
      for (let i = warm; i < own.x.length; i++) {
        const j = Math.min(path.x.length - 1, Math.round(((i + 1) * REF) / fps) - 1);
        hand = Math.max(hand, Math.hypot(own.x[i] - path.x[j], own.y[i] - path.y[j]));
      }
      expect(hand * UNITS_PER_IMAGE_HEIGHT * PX_PER_UNIT, `${fps} Hz`).toBeLessThanOrEqual(0.2);
    }
  });

  it('höchster Punkt nie über dem Anker; das Pendel schwingt sichtbar (Bhop)', () => {
    for (const fps of [30, 60, 144, 240]) {
      for (const grid of [false, true]) {
        const r = hang(fps, { grid });
        expect(r.top, `${fps} Hz`).toBeLessThan(0);
        expect(r.swing * PX_PER_UNIT, `${fps} Hz`).toBeGreaterThan(10);
      }
    }
  });

  it('motionFx 0 (Hand statisch, keine Scheinkraft): die Schnur hängt still', () => {
    const r = hang(60, { motionFx: 0 });
    expect(r.swing * PX_PER_UNIT).toBeLessThan(0.05);
  });

  it('Deckel: die Scheinkraft bleibt ≤ 0.6 g, egal wie heftig die Hand ruckt', () => {
    const rope = new Rope({ segments: 8, length: 9 });
    const drive = new RopeDrive();
    rope.drive = drive;
    rope.freeEnd = true;
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      // Rechteck-Sprünge von ±0.2 Bildhöhen pro Frame (weit mehr als jede echte Hand).
      drive.setFrame((i & 1) * 0.2, ((i >> 1) & 1) * 0.2, 0, 1);
      rope.update(1 / 60, 0, 0, 0, 0, 0, 0);
      worst = Math.max(worst, Math.hypot(rope.accel[0], rope.accel[1], rope.accel[2]));
    }
    expect(worst).toBeLessThanOrEqual(ROPE_CAP_G * ROPE_G + 1e-6);
    expect(worst).toBeGreaterThan(ROPE_CAP_G * ROPE_G * 0.99);
  });
});

describe('Schnur: Robustheit', () => {
  it('20 000 wilde Schritte (NaN, negative/riesige dt, Teleports, freies Ende im Wechsel): nie NaN', () => {
    const rope = new Rope({ segments: 8, length: 9 });
    const drive = new RopeDrive();
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const dts = [Number.NaN, -1, 0, 1e-6, 0.0041, 1 / 60, 0.1, 5, Infinity];
    let nan = 0;
    for (let i = 0; i < 20000; i++) {
      if (i % 997 === 0) rope.freeEnd = !rope.freeEnd;
      if (i % 3001 === 0) rope.drive = rope.drive ? null : drive;
      if (i % 1499 === 0) rope.setLength(rnd() < 0.1 ? Number.NaN : 1 + rnd() * 10);
      const dt = rnd() < 0.3 ? dts[Math.floor(rnd() * dts.length)] : rnd() * 0.05;
      const big = rnd() < 0.01 ? 1e6 : rnd() < 0.005 ? Number.NaN : 10;
      if (rope.drive) drive.setFrame(rnd() < 0.01 ? Number.NaN : (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.3, rnd() < 0.01 ? Infinity : (rnd() - 0.5) * 30, rnd());
      else driveRope(rope, rnd() < 0.01 ? 1e9 : (rnd() - 0.5) * 3000, rnd() < 0.01 ? Number.NaN : 0, (rnd() - 0.5) * 30);
      rope.update(dt, (rnd() - 0.5) * 2, (rnd() - 0.5) * 2, 0, (rnd() - 0.5) * big, -8 + (rnd() - 0.5) * 4, (rnd() - 0.5) * 3);
      for (const v of rope.out) if (!Number.isFinite(v)) nan++;
    }
    expect(nan).toBe(0);
  });

  it('hängend in Ruhe: Ende eine Schnurlänge unter dem Anker (Bild-unten, schweres Ende dehnt ≤ 3 %)', () => {
    const rope = new Rope({ segments: 8, length: 9 });
    rope.freeEnd = true;
    driveRope(rope, 0, 0, 0);
    rope.reset(0, 0, 0, 0.5, -3, 0);
    for (let i = 0; i < 600; i++) rope.update(1 / 60, 0, 0, 0, 0, 0, 0);
    const A = VIEW_AXES;
    const down = -(rope.endX * A.up[0] + rope.endY * A.up[1] + rope.endZ * A.up[2]);
    expect(down).toBeGreaterThan(8.8);
    expect(down).toBeLessThan(9.27);
  });
});
