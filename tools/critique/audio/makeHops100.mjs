/**
 * Kritik-Linse AUDIO: synthetische Aufzeichnung "100 Hops am Stück" (flacher Bhop,
 * 0.755 s Luftzeit, menschliche Speed-Kurve 320 → ~1000 u/s) im Format von record.mjs.
 * Danach: node tools/critique/audio/replay.mjs hops100
 */
import { writeFileSync } from 'node:fs';

const OUT = 'shots/critique/audio';
const AIR = 0.755;
const frames = [];
const events = [];
const dt = 1 / 60;
const T_RUN = 4;
const T_HOP0 = 5;
const HOPS = 100;
const T_END = T_HOP0 + HOPS * AIR;
const TOTAL = T_END + 7;
const speedAt = (n) => Math.min(1100, Math.sqrt(320 * 320 + n * 30000));
events.push({ type: 'runStart', t: T_RUN + 0.2 });
for (let i = 0; i < 4; i++) events.push({ type: 'footstep', speed: 320, left: i % 2 === 0, t: T_RUN + 0.1 + i * 0.3 });
let prev = 320;
const ms = [500, 750, 1000];
for (let n = 1; n <= HOPS; n++) {
  const t = T_HOP0 + (n - 1) * AIR;
  const sp = speedAt(n - 1);
  if (n > 1) events.push({ type: 'land', impact: 302, speed: sp, airTime: AIR, t });
  events.push({ type: 'jump', speed: sp, gain: n > 1 ? sp - prev : 0, perfect: true, chain: n, sync: 0.8, crouched: false, coyote: false, t: t + 0.0001 });
  for (const m of ms) if (prev < m && sp >= m) events.push({ type: 'speedMilestone', speed: m, t: t + 0.3 });
  prev = sp;
}
events.push({ type: 'land', impact: 302, speed: prev, airTime: AIR, t: T_END });
for (let t = 0; t < TOTAL; t += dt) {
  let sp = 0;
  let g = true;
  let ch = 0;
  if (t >= T_RUN && t < T_HOP0) sp = 320;
  else if (t >= T_HOP0 && t < T_END) {
    const n = Math.floor((t - T_HOP0) / AIR);
    const u = (t - T_HOP0 - n * AIR) / AIR;
    sp = speedAt(n) + (speedAt(n + 1) - speedAt(n)) * u;
    g = false;
    ch = n + 1;
  } else if (t >= T_END) sp = Math.max(0, prev - (t - T_END) * 800);
  frames.push({ t, sp, g, ch, sy: ch > 0 ? 0.8 : 0, sf: false, e: 0, l: 0, k: 0, bt: 0, gs: 'playing', m: null, cp: 0, y: 0 });
}
events.sort((a, b) => a.t - b.t);
writeFileSync(`${OUT}/rec_hops100.json`, JSON.stringify({ id: 'hops100', level: 'level1', result: 'synthetic', duration: TOTAL, frames, events }));
console.log(`hops100: ${frames.length} Frames, ${events.length} Events, ${TOTAL.toFixed(1)} s, Endspeed ${prev.toFixed(0)}`);
