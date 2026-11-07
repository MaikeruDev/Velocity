import { describe, expect, it } from 'vitest';
import {
  boostFactor,
  DEFAULT_LOOK_CURVE,
  digitizeMove,
  edgeClock,
  lookRate,
  radialDeadzone,
  STICK_EDGE,
  STICK_EDGE_OFF,
  type LookRateOut,
  type MoveOut,
  type Vec2Out,
} from '../src/engine/pad/stickCurve';

const DEG = Math.PI / 180;

describe('stickCurve (Plan 011 §1.1)', () => {
  it('radialDeadzone: 0 unter inner, stetig an inner, 1 ab outer, Richtung bleibt', () => {
    const o: Vec2Out = { x: 0, y: 0 };
    const { inner, outer } = DEFAULT_LOOK_CURVE;
    radialDeadzone(inner * 0.99, 0, inner, outer, o);
    expect(o.x).toBe(0);
    radialDeadzone(inner + 1e-6, 0, inner, outer, o);
    expect(o.x).toBeLessThan(1e-4); // kein Sprung an inner
    radialDeadzone(0, outer, inner, outer, o);
    expect(o.y).toBeCloseTo(1, 9);
    radialDeadzone(0.8, 0.8, inner, outer, o); // Betrag > 1 (Ecke) → geklemmt
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(1, 9);
    expect(o.x).toBeCloseTo(o.y, 9);
  });

  it('lookRate: monoton im Betrag, Vollausschlag = Grundrate, Vorzeichen wie Stick', () => {
    const r: LookRateOut = { yaw: 0, pitch: 0 };
    let prev = -1;
    for (let m = 0; m <= 1.0001; m += 0.01) {
      lookRate(m, 0, DEFAULT_LOOK_CURVE, 0, r);
      expect(r.yaw).toBeGreaterThanOrEqual(prev - 1e-12); // über outer konstant (Rundung)
      prev = r.yaw;
    }
    lookRate(1, 0, DEFAULT_LOOK_CURVE, 0, r);
    expect(r.yaw).toBeCloseTo(DEFAULT_LOOK_CURVE.maxYawRate * DEG, 9);
    lookRate(-1, 0, DEFAULT_LOOK_CURVE, 0, r);
    expect(r.yaw).toBeCloseTo(-DEFAULT_LOOK_CURVE.maxYawRate * DEG, 9);
    lookRate(0, 1, DEFAULT_LOOK_CURVE, 0, r);
    expect(r.pitch).toBeCloseTo(DEFAULT_LOOK_CURVE.maxPitchRate * DEG, 9);
    expect(r.yaw).toBe(0);
  });

  it('Default ist feinzielbar: ≤ 25 °/s bei 30 % Auslenkung (Plan-Kriterium)', () => {
    const c = DEFAULT_LOOK_CURVE;
    const r: LookRateOut = { yaw: 0, pitch: 0 };
    const raw = c.inner + 0.3 * (c.outer - c.inner);
    lookRate(raw, 0, c, 0, r);
    expect(r.yaw / DEG).toBeLessThanOrEqual(25);
  });

  it('Boost: erst nach boostDelay, linear über boostRamp, dann 1 + boost', () => {
    const c = DEFAULT_LOOK_CURVE;
    expect(boostFactor(c, 0)).toBe(1);
    expect(boostFactor(c, c.boostDelay)).toBe(1);
    expect(boostFactor(c, c.boostDelay + c.boostRamp / 2)).toBeCloseTo(1 + c.boost / 2, 9);
    expect(boostFactor(c, c.boostDelay + c.boostRamp * 5)).toBeCloseTo(1 + c.boost, 9);
    expect(boostFactor({ ...c, boost: 0 }, 10)).toBe(1);
  });

  it('digitizeMove: 8 Sektoren, 20° neben links = reines A, 45° = Diagonale', () => {
    const o: MoveOut = { fwd: 0, side: 0 };
    const at = (deg: number, mag = 1): MoveOut => {
      // 0° = rechts, 90° = hoch; Gamepad-y zeigt nach unten.
      digitizeMove(Math.cos(deg * DEG) * mag, -Math.sin(deg * DEG) * mag, 0.2, 30, o);
      return { fwd: o.fwd, side: o.side };
    };
    expect(at(180 - 20)).toEqual({ fwd: 0, side: -1 });
    expect(at(180 + 20)).toEqual({ fwd: 0, side: -1 });
    expect(at(45)).toEqual({ fwd: 1, side: 1 });
    expect(at(135)).toEqual({ fwd: 1, side: -1 });
    expect(at(225)).toEqual({ fwd: -1, side: -1 });
    expect(at(315)).toEqual({ fwd: -1, side: 1 });
    expect(at(90)).toEqual({ fwd: 1, side: 0 });
    expect(at(270)).toEqual({ fwd: -1, side: 0 });
    expect(at(0)).toEqual({ fwd: 0, side: 1 });
    expect(at(359)).toEqual({ fwd: 0, side: 1 });
    expect(at(90, 0.1)).toEqual({ fwd: 0, side: 0 });
  });

  it('schreibt ins übergebene Objekt (keine Allokation)', () => {
    const r: LookRateOut = { yaw: 0, pitch: 0 };
    expect(lookRate(0.5, 0.5, DEFAULT_LOOK_CURVE, 0, r)).toBe(r);
    const m: MoveOut = { fwd: 0, side: 0 };
    expect(digitizeMove(1, 0, 0.2, 30, m)).toBe(m);
    expect(digitizeMove(1, 0, 0.2, 30, m, m)).toBe(m);
  });
});

describe('Pitch: Achsen-Deadzone, Boost nur Yaw (Review A2)', () => {
  const c = DEFAULT_LOOK_CURVE;
  const r: LookRateOut = { yaw: 0, pitch: 0 };
  /** Voller Ausschlag, `deg` über der Waagerechten (rechts), Boost-Uhr `t`. */
  const at = (deg: number, t = 0): LookRateOut => lookRate(Math.cos(deg * DEG), -Math.sin(deg * DEG), c, t, r);

  it('voller Seitenausschlag bis 11.5° neben der Waagerechten nickt nicht; darüber stetig ab 0', () => {
    // Vor dem Fix (radial): 5° → 19 °/s, 8° → 31 °/s, 12° → 46 °/s Pitch (× 1.5 mit Boost).
    expect(at(5).pitch).toBe(0);
    expect(at(8).pitch).toBe(0);
    expect(at(11).pitch).toBe(0);
    // Knapp über der Schwelle (asin 0.2 = 11.54°): fast 0, kein Sprung.
    const just = Math.abs(at(11.6).pitch) / DEG;
    expect(just).toBeGreaterThan(0);
    expect(just).toBeLessThan(0.5);
    expect(Math.abs(at(12).pitch) / DEG).toBeLessThan(2.5);
    // Senkrecht = volle Pitch-Rate wie vorher; Yaw bleibt radial (12° → cos 12°).
    lookRate(0, -1, c, 0, r);
    expect(r.pitch / DEG).toBeCloseTo(-c.maxPitchRate, 9);
    expect(at(12).yaw / DEG).toBeCloseTo(c.maxYawRate * Math.cos(12 * DEG), 9);
  });

  it('Pitch-Anteil steigt monoton mit dem Winkel (stetig nachskaliert)', () => {
    let prev = -1;
    for (let d = 0; d <= 90; d += 0.5) {
      const p = Math.abs(at(d).pitch);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
  });

  it('Boost wirkt nur auf Yaw: senkrecht am Rand bleibt Pitch bei der Grundrate', () => {
    const long = c.boostDelay + c.boostRamp * 3;
    lookRate(0, -1, c, long, r);
    expect(r.pitch / DEG).toBeCloseTo(-c.maxPitchRate, 9);
    lookRate(1, 0, c, long, r);
    expect(r.yaw / DEG).toBeCloseTo(c.maxYawRate * (1 + c.boost), 9);
  });

  it('Pitch-Rate 220 °/s plausibel: fein bei 30 %, 45° in ≤ 0.25 s, ganzer Bereich (±89°) unter 1 s', () => {
    const raw = c.inner + 0.3 * (c.outer - c.inner);
    lookRate(0, -raw, c, 0, r);
    // Gleiche Feinziel-Grenze wie Yaw (Plan 1.2: ≤ 25 °/s bei 30 % Auslenkung) — hier 12 °/s.
    expect(Math.abs(r.pitch) / DEG).toBeLessThanOrEqual(25);
    expect(45 / c.maxPitchRate).toBeLessThanOrEqual(0.25);
    expect(178 / c.maxPitchRate).toBeLessThan(1);
    // Vertikal langsamer als horizontal (Strafen braucht Yaw, nicht Pitch): ~0.5 der Grundrate.
    expect(c.maxPitchRate / c.maxYawRate).toBeGreaterThan(0.4);
    expect(c.maxPitchRate / c.maxYawRate).toBeLessThan(0.7);
  });
});

describe('Ränder mit Hysterese (Review A3)', () => {
  it('Boost-Uhr: läuft am Rand, steht im Band 0.85…0.95, fällt erst darunter auf 0', () => {
    expect(STICK_EDGE).toBe(0.95);
    expect(STICK_EDGE_OFF).toBe(0.85);
    expect(edgeClock(0, 0.96, 0.01)).toBeCloseTo(0.01, 12);
    expect(edgeClock(0.3, 0.9, 0.01)).toBe(0.3); // Zittern unter 0.95: kein Rücksprung
    expect(edgeClock(0, 0.9, 0.01)).toBe(0); // von unten ins Band: keine Uhr
    expect(edgeClock(0.3, 0.84, 0.01)).toBe(0);
  });

  /** Zählt Wechsel von fwd/side über 600 Polls, abwechselnd zwei Stick-Stände (wie Zittern). */
  function flips(a: readonly [number, number], b: readonly [number, number], hold: boolean): number {
    const o: MoveOut = { fwd: 0, side: 0 };
    let n = 0;
    let last = '';
    for (let i = 0; i < 600; i++) {
      const [x, y] = i % 2 === 0 ? a : b;
      digitizeMove(x, y, 0.3, 30, o, hold ? o : null);
      const k = `${o.fwd},${o.side}`;
      if (i > 0 && k !== last) n++;
      last = k;
    }
    return n;
  }
  const dir = (deg: number, mag = 1): [number, number] => [Math.cos(deg * DEG) * mag, -Math.sin(deg * DEG) * mag];

  it('8 Richtungen: Bandkante 30° ± 1° und Betrag 0.3 ± 0.01 flattern nicht mehr', () => {
    // Zustandslos (alter Aufruf) flattert es bei jedem Poll — das war der Befund.
    expect(flips(dir(29), dir(31), false)).toBe(599);
    expect(flips(dir(0, 0.29), dir(0, 0.31), false)).toBe(599);
    expect(flips(dir(29), dir(31), true)).toBe(0);
    expect(flips(dir(0, 0.31), dir(0, 0.29), true)).toBe(0);
    // Auch über die Grenze hinaus zittern (± 3°): bleibt.
    expect(flips(dir(27.5), dir(32.5), true)).toBe(0);
  });

  it('Hysterese hält nicht fest: klare Richtungswechsel und Loslassen wirken sofort', () => {
    const o: MoveOut = { fwd: 0, side: 0 };
    const step = (deg: number, mag = 1): string => {
      const [x, y] = dir(deg, mag);
      digitizeMove(x, y, 0.3, 30, o, o);
      return `${o.fwd},${o.side}`;
    };
    expect(step(0)).toBe('0,1'); // rechts
    expect(step(33)).toBe('0,1'); // 3° über der Kante: hält
    expect(step(34)).toBe('1,1'); // klar drüber: Diagonale
    expect(step(27)).toBe('1,1'); // zurück, aber in der Hysterese
    expect(step(26)).toBe('0,1');
    expect(step(180)).toBe('0,-1'); // Gegenrichtung in einem Poll
    expect(step(180, 0.25)).toBe('0,-1'); // unter 0.3, aber über 0.2: noch gehalten
    expect(step(180, 0.19)).toBe('0,0'); // unter 0.2: los
    expect(step(180, 0.25)).toBe('0,0'); // von los aus erst ab 0.3
    expect(step(180, 0.31)).toBe('0,-1');
  });

  it('ohne prev wie vorher (zustandslos): die Tabelle aus Plan 1.1 bleibt', () => {
    const o: MoveOut = { fwd: 0, side: 0 };
    for (const [deg, want] of [[160, '0,-1'], [45, '1,1'], [31, '1,1'], [29, '0,1'], [59, '1,1'], [61, '1,0']] as const) {
      const [x, y] = dir(deg);
      digitizeMove(x, y, 0.2, 30, o);
      expect(`${o.fwd},${o.side}`, `${deg}°`).toBe(want);
    }
  });
});
