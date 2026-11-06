/**
 * Determinismus-Probe (fallen.md #203) für den Desktop-Smoke: Hash über die Bits von detMath (sin/cos/atan2/hypot)
 * und — nur informativ — über `Math.*`. Läuft in Node direkt und im Electron-Renderer als esbuild-IIFE.
 * detMath muss gleich sein; Math.* darf abweichen (genau deshalb gibt es detMath).
 */
import { datan2, dcos, dhypot, dsin } from '../../src/player/detMath';

type Fn2 = (a: number, b: number) => number;

function hashOf(n: number, sin: (x: number) => number, cos: (x: number) => number, atan2: Fn2, hypot: Fn2): string {
  const f = new Float64Array(1);
  const w = new Uint32Array(f.buffer);
  let h = 0x811c9dc5;
  let s = 12345;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
  const mix = (v: number): void => {
    f[0] = v;
    h = Math.imul(h ^ w[0], 0x01000193) >>> 0;
    h = Math.imul(h ^ w[1], 0x01000193) >>> 0;
  };
  for (let i = 0; i < n; i++) {
    // Bereiche wie in der Physik: Blick (auch ungewickelt), quantisierte Yaws, große Werte.
    const k = rnd();
    const x = k < 0.4 ? (rnd() - 0.5) * 2 * Math.PI : k < 0.7 ? (Math.floor(rnd() * 65536) * 2 * Math.PI) / 65536 : (rnd() - 0.5) * 4000;
    const y = (rnd() - 0.5) * 2000;
    mix(sin(x));
    mix(cos(x));
    mix(atan2(y, x));
    mix(hypot(x, y));
  }
  return h.toString(16).padStart(8, '0');
}

export function detHash(n: number): string {
  return hashOf(n, dsin, dcos, datan2, dhypot);
}

export function mathHash(n: number): string {
  return hashOf(n, Math.sin, Math.cos, Math.atan2, Math.hypot);
}
