/**
 * Kritik-Linse AUDIO: Stereobreite je Band (Seiten- zu Mitten-Energie) aus WAVs.
 *   node tools/critique/audio/width.mjs a.wav b.wav ...
 */
import { readFileSync } from 'node:fs';

function readWav(path) {
  const b = readFileSync(path);
  const ch = b.readUInt16LE(22);
  const sr = b.readUInt32LE(24);
  let off = 12;
  while (off < b.length) {
    const id = b.toString('ascii', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = len / 2 / ch;
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        L[i] = b.readInt16LE(off + 8 + (i * ch) * 2) / 32768;
        R[i] = ch > 1 ? b.readInt16LE(off + 8 + (i * ch + 1) * 2) / 32768 : L[i];
      }
      return { L, R, sr };
    }
    off += 8 + len;
  }
  throw new Error('no data');
}

function biquad(x, type, f, sr, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f) / sr;
  const a = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  let b0, b1, b2;
  if (type === 'hp') [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  else [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
  const a0 = 1 + a;
  const a1 = -2 * c;
  const a2 = 1 - a;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

function sm(L, R, a = 0, b = L.length) {
  let m = 0;
  let s = 0;
  for (let i = a; i < b; i++) {
    const mi = (L[i] + R[i]) / 2;
    const si = (L[i] - R[i]) / 2;
    m += mi * mi;
    s += si * si;
  }
  return m > 0 ? 10 * Math.log10(s / m + 1e-12) : NaN;
}

for (const p of process.argv.slice(2)) {
  const { L, R, sr } = readWav(p);
  const hpL = biquad(L, 'hp', 1000, sr);
  const hpR = biquad(R, 'hp', 1000, sr);
  const loL = biquad(L, 'lp', 150, sr);
  const loR = biquad(R, 'lp', 150, sr);
  const segs = [];
  const seg = 5 * sr;
  for (let a = 0; a + seg <= L.length; a += seg) segs.push(`${(a / sr).toFixed(0)}s:${sm(hpL, hpR, a, a + seg).toFixed(1)}`);
  console.log(`${p}\n  S/M gesamt ${sm(L, R).toFixed(1)} dB · >1 kHz ${sm(hpL, hpR).toFixed(1)} dB · <150 Hz ${sm(loL, loR).toFixed(1)} dB\n  >1 kHz je 5 s: ${segs.join(' ')}`);
}
