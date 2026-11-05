import { describe, expect, it } from 'vitest';
import { datan2, dcos, dhypot, dsin } from '../src/player/detMath';

/**
 * Plan 009: die deterministischen Ports müssen in Node bitgleich zu `Math.*` sein (V8 in Node 22 =
 * fdlibm) — sonst änderte der Umstieg die Physik (Sim, Medaillen). Chromium rechnet mit `Math.*`
 * andere Bits (fallen.md #203); mit den Ports rechnet es wie Node (Playwright-Probe im Plan).
 */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

function firstMismatch(n: number, gen: (r: () => number) => [number, number], a: (x: number, y: number) => number, b: (x: number, y: number) => number): string | null {
  const r = lcg(99);
  for (let i = 0; i < n; i++) {
    const [x, y] = gen(r);
    const u = a(x, y);
    const v = b(x, y);
    if (!Object.is(u, v)) return `${x}, ${y}: ${u} != ${v}`;
  }
  return null;
}

const angle = (r: () => number): [number, number] => {
  const k = r();
  // Physik-Bereiche: Blick (auch ungewickelt), quantisierte Yaws, atan2-Ergebnis + Schritt, große Werte.
  const x = k < 0.3 ? (r() - 0.5) * 2 * Math.PI : k < 0.5 ? (Math.floor(r() * 65536) * 2 * Math.PI) / 65536 : k < 0.8 ? (r() - 0.5) * 400 : (r() - 0.5) * 2e6;
  return [x, 0];
};

describe('detMath — bitgleich zu Node Math.*', () => {
  it('sin', () => {
    expect(firstMismatch(400000, angle, (x) => dsin(x), (x) => Math.sin(x))).toBeNull();
  });

  it('cos', () => {
    expect(firstMismatch(400000, angle, (x) => dcos(x), (x) => Math.cos(x))).toBeNull();
  });

  it('sin/cos an Sonderstellen (n·π/2, ±0, winzig, NaN, ∞)', () => {
    const xs = [0, -0, 1e-300, -1e-30, 5e-9, Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI, 3 * Math.PI / 4, 2 * Math.PI, 1e5 * Math.PI, NaN, Infinity, -Infinity];
    for (let n = 1; n <= 40; n++) xs.push((n * Math.PI) / 2, (-n * Math.PI) / 2, (n * Math.PI) / 2 + 1e-12);
    for (const x of xs) {
      expect(Object.is(dsin(x), Math.sin(x)), `sin ${x}`).toBe(true);
      expect(Object.is(dcos(x), Math.cos(x)), `cos ${x}`).toBe(true);
    }
  });

  it('atan2', () => {
    const gen = (r: () => number): [number, number] => {
      const k = r();
      const s = k < 0.5 ? 1 : k < 0.8 ? 1000 : 1e-6;
      return [(r() - 0.5) * s, (r() - 0.5) * s * (r() < 0.1 ? 1e-9 : 1)];
    };
    expect(firstMismatch(400000, gen, (y, x) => datan2(y, x), (y, x) => Math.atan2(y, x))).toBeNull();
    const special = [0, -0, 1, -1, 1e-300, Infinity, -Infinity, NaN, 1e20];
    for (const y of special) for (const x of special) expect(Object.is(datan2(y, x), Math.atan2(y, x)), `atan2(${y}, ${x})`).toBe(true);
  });

  it('hypot', () => {
    const gen = (r: () => number): [number, number] => {
      const s = r() < 0.5 ? 2000 : 1e-3;
      return [(r() - 0.5) * s, (r() - 0.5) * s * (r() < 0.1 ? 0 : 1)];
    };
    expect(firstMismatch(400000, gen, (x, z) => dhypot(x, z), (x, z) => Math.hypot(x, z))).toBeNull();
    for (const [x, z] of [[0, 0], [-0, 0], [Infinity, NaN], [NaN, 1], [3, 4], [1e300, 1e300]]) {
      expect(Object.is(dhypot(x, z), Math.hypot(x, z)), `hypot(${x}, ${z})`).toBe(true);
    }
  });
});
