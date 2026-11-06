import { describe, expect, it } from 'vitest';
import {
  boostFactor,
  DEFAULT_LOOK_CURVE,
  digitizeMove,
  lookRate,
  radialDeadzone,
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
  });
});
