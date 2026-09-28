import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FixedLoop } from '../src/engine/Loop';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { CS2_CLASSIC, VELOCITY_DEFAULT, type MovementConfig } from '../src/player/MovementConfig';
import { NaiveBot, StrafeBot, type Bot } from '../src/player/bots';
import type { PlayerInput } from '../src/player/types';
import { compileLevel } from '../src/world/level/compileLevel';
import { AirDisplay, CENTER_BAND_TOP, LESSON_PIP, SpeedTrend, hudScale, lessonCardLayout, makeLessonCardLayout, turnBarLength, type Trend } from '../src/ui/hudLogic';
import { flatLevel } from '../tools/sim/levels';

/**
 * HUD-Logik im echten Takt: FixedLoop + PlayerMovement + Bot, HUD-Update pro
 * Frame wie im Spiel. Prüft, dass die Speedometer-Farbe dem tatsächlichen
 * Gewinn folgt (auch bei hohem Tempo) und die Luft-Zeile beim Bhop nicht zuckt.
 */

const FLAT = compileLevel(flatLevel(30000));

interface FrameSample {
  readonly speed: number;
  readonly trend: Trend;
  readonly air: boolean;
  readonly onGround: boolean;
}

function run(cfg: MovementConfig, bot: Bot, fps: number, seconds: number, startSpeed = cfg.runSpeed): FrameSample[] {
  const pm = new PlayerMovement(FLAT.world, cfg);
  pm.state.vel.set(0, 0, -startSpeed);
  pm.teleport(new Vector3(0, 0, 28000), { keepVelocity: true });
  const trend = new SpeedTrend(cfg);
  const air = new AirDisplay();
  const out: FrameSample[] = [];
  const loop = new FixedLoop({
    tickRate: cfg.tickRate,
    onTick: () => {
      pm.tick(bot.next(pm.state));
    },
    onFrame: (_alpha, frameDt) => {
      trend.update(frameDt, pm.state.speed);
      air.update(frameDt, pm.state.onGround, pm.state.surfing);
      out.push({ speed: pm.state.speed, trend: trend.trend, air: air.air, onGround: pm.state.onGround });
    },
    now: () => 0,
  });
  for (let i = 0; i < Math.round(fps * seconds); i++) loop.advance(1 / fps);
  return out;
}

function share(samples: readonly FrameSample[], pred: (s: FrameSample) => boolean): number {
  return samples.length === 0 ? 0 : samples.filter(pred).length / samples.length;
}

function band(samples: readonly FrameSample[], lo: number, hi: number): FrameSample[] {
  return samples.filter((s) => s.speed >= lo && s.speed < hi);
}

describe('SpeedTrend — Speedometer-Farbe folgt dem echten Gewinn', () => {
  it.each([60, 144])('StrafeBot sync 0.85 bei 700–1100 u/s ist überwiegend grün (%i fps)', (fps) => {
    const s = run(VELOCITY_DEFAULT, new StrafeBot(VELOCITY_DEFAULT, { sync: 0.85, seed: 7, heading: 0 }), fps, 40);
    const fast = band(s, 700, 1100);
    // Der Bot baut hier tatsächlich weiter Speed auf — sonst wäre der Test sinnlos.
    expect(fast.length).toBeGreaterThan(fps * 5);
    expect(Math.max(...s.map((x) => x.speed))).toBeGreaterThan(1000);
    // Vorher (absolute Schwelle 30 u/s²): 0 % grün in diesem Bereich.
    expect(share(fast, (x) => x.trend === 1)).toBeGreaterThan(0.75);
    expect(share(fast, (x) => x.trend === -1)).toBeLessThan(0.15);
  });

  it('perfekter Strafe-Bot ist durchgehend grün, auch jenseits von 1000 u/s', () => {
    const s = run(VELOCITY_DEFAULT, new StrafeBot(VELOCITY_DEFAULT, { sync: 1, heading: 0 }), 144, 40);
    const fast = band(s, 300, Infinity);
    expect(Math.max(...fast.map((x) => x.speed))).toBeGreaterThan(1150);
    expect(share(fast, (x) => x.trend === 1)).toBeGreaterThan(0.98);
  });

  it('CS2-Preset (64 Tick, Cap 30): sync 0.85 ebenfalls überwiegend grün', () => {
    const s = run(CS2_CLASSIC, new StrafeBot(CS2_CLASSIC, { sync: 0.85, seed: 7, heading: 0 }), 144, 30);
    const fast = band(s, 600, 1200);
    expect(fast.length).toBeGreaterThan(144 * 3);
    expect(share(fast, (x) => x.trend === 1)).toBeGreaterThan(0.75);
  });

  it('Bhop ohne Strafe (W gehalten) bleibt weiß — kein Rauschen', () => {
    const s = run(VELOCITY_DEFAULT, new NaiveBot(VELOCITY_DEFAULT, { heading: 0 }), 144, 10);
    // Erste Sekunde: Anlauf von der Startgeschwindigkeit.
    const steady = s.slice(144);
    expect(share(steady, (x) => x.trend === 0)).toBeGreaterThan(0.97);
  });

  it('Bremsen am Boden wird sofort rot', () => {
    const stand: Bot = {
      next: (): PlayerInput => ({ forward: 0, side: 0, jumpHeld: false, jumpPressed: false, crouch: false, sprint: false, yaw: 0, pitch: 0 }),
    };
    const s = run(VELOCITY_DEFAULT, stand, 144, 0.5, 800);
    // Nach 0.1 s Friction (800 → ~500 u/s) ist die Anzeige rot.
    expect(s[Math.round(0.1 * 144)].trend).toBe(-1);
  });
});

describe('AirDisplay — Luft-Zeile entprellt', () => {
  it.each([60, 144])('Bhop-Kette: SYNC bleibt über alle Landungen stehen (%i fps)', (fps) => {
    const s = run(VELOCITY_DEFAULT, new StrafeBot(VELOCITY_DEFAULT, { sync: 0.85, seed: 7, heading: 0 }), fps, 20);
    const firstAir = s.findIndex((x) => x.air);
    expect(firstAir).toBeGreaterThanOrEqual(0);
    const after = s.slice(firstAir);
    // Es gibt Frames mit Bodenkontakt (Landungen) …
    const groundFrames = after.filter((x) => x.onGround).length;
    expect(groundFrames).toBeGreaterThan(10);
    // … aber die Anzeige springt nie auf "Boden" zurück.
    expect(after.every((x) => x.air)).toBe(true);
  });

  it('echtes Stehenbleiben blendet die Luft-Zeile nach kurzer Zeit aus', () => {
    const d = new AirDisplay();
    d.update(1 / 60, false, false);
    expect(d.air).toBe(true);
    for (let i = 0; i < 6; i++) d.update(1 / 60, true, false);
    expect(d.air).toBe(true);
    for (let i = 0; i < 12; i++) d.update(1 / 60, true, false);
    expect(d.air).toBe(false);
  });
});

describe('Lektions-HUD (Plan 007 TU2) — Karte und Drehbalken', () => {
  it('Karte (Titel + ≤ 2 Textzeilen + Fortschritt) endet über dem Speedometer und dem mittleren Band', () => {
    const lay = makeLessonCardLayout();
    // Alle Pixelhöhen von 240 bis 1080 Zeilen (Einstellung pixelHeight), 0–2 Textzeilen (mehr kappt das Layout).
    for (let h = 240; h <= 1080; h += 2) {
      for (let lines = 0; lines <= 3; lines++) {
        lessonCardLayout(h, lines, lay);
        const s = hudScale(h);
        // Speedometer-Ziffern beginnen bei 0.30 h (Hud SPEED_TOP), Bildmitte ab 0.35 h.
        expect(lay.bottom).toBeLessThan(Math.round(h * 0.3));
        expect(lay.bottom).toBeLessThan(h * CENTER_BAND_TOP);
        // Reihenfolge: Titel über Text über Fortschritt, Pips passen ins Band.
        expect(lay.top).toBeLessThan(lay.titleY);
        expect(lay.titleY).toBeLessThan(lay.textY);
        expect(lay.progressY).toBeGreaterThanOrEqual(lay.textY);
        expect(lay.progressY + LESSON_PIP * s).toBeLessThan(lay.bottom);
      }
    }
  });

  it('Drehbalken: Ganzzahl, monoton, voll bei 360 °/s, Vorzeichen egal', () => {
    const half = 20;
    let prev = 0;
    for (let d = 0; d <= 1000; d++) {
      const len = turnBarLength(d, half);
      expect(Number.isInteger(len)).toBe(true);
      expect(len).toBeGreaterThanOrEqual(prev);
      expect(turnBarLength(-d, half)).toBe(len);
      prev = len;
    }
    expect(turnBarLength(360, half)).toBe(half - 1);
    expect(turnBarLength(5000, half)).toBe(turnBarLength(360, half));
    // Zielband 40–300 °/s liegt sichtbar getrennt (lo < hi).
    expect(turnBarLength(40, half)).toBeLessThan(turnBarLength(300, half));
  });
});
