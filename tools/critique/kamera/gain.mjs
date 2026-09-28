/** Kamera-Kritik: Speed-Gewinnrate in der Luft (tangential) als Qualitätssignal für einen FOV-"Surge". VERALTET (altes Rig, siehe derive.mjs) — analyze.mjs. */
import { load, r, pct, mean } from './derive.mjs';
export function gain(rows, { tau = 0.25, full = 150, maxDeg = 3 } = {}) {
  let g = 0; const out = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i]; const dt = b.t - a.t;
    if (!(dt > 0)) continue;
    const inst = !b.onGround && !a.onGround ? (b.speed - a.speed) / dt : 0;
    g += (Math.max(-2000, Math.min(2000, inst)) - g) * (1 - Math.exp(-dt / tau));
    out.push({ t: b.t, g, surge: maxDeg * Math.max(0, Math.min(1, g / full)), speed: b.speed, air: !b.onGround });
  }
  return out;
}
if (process.argv[1].endsWith('gain.mjs')) {
  for (const n of ['bhop', 'bhophuman', 'level1', 'level1h', 'level2']) {
    const x = gain(load(n).rows).filter((q) => q.air && q.speed > 250);
    const band = (lo, hi) => x.filter((q) => q.speed >= lo && q.speed < hi);
    const s = (arr) => arr.length ? `Ø ${r(mean(arr.map((q) => q.g)), 0)} u/s² · Surge Ø ${r(mean(arr.map((q) => q.surge)), 2)}°` : '-';
    console.log(n.padEnd(10), '| 250-600:', s(band(250, 600)), '| 600-1000:', s(band(600, 1000)), '| 1000+:', s(band(1000, 3000)), '| Surge p90', r(pct(x.map((q) => q.surge), 0.9), 2));
  }
}
