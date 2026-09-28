/**
 * Kritik-Linse AUDIO: spielt die aufgezeichneten Drives (rec_*.json) durch das
 * aktuelle und ein vorgeschlagenes Energiemodell und vergleicht, wann Layer 2/3/4
 * kommen. Layer-Regeln wie Music.onBeat (auf, sobald die Energie auf einem Beat
 * drüber ist; ab, nach > 8 Beats unter der Halteschwelle auf einer Taktgrenze).
 * Variante "latch": Aufstieg zählt die höchste Energie seit dem letzten Beat;
 * Abstieg nur, wenn auch die Ziel-Energie unter der Halteschwelle liegt.
 *
 *   npx tsx tools/critique/audio/proposeEnergy.ts
 */
import { readFileSync } from 'node:fs';
import { targetEnergy, ENERGY_ATTACK, ENERGY_RELEASE, LAYER_THRESHOLDS, LAYER_HYSTERESIS } from '../../../src/audio/energy';
import type { MusicDrive } from '../../../src/audio/types';
import { clamp01, smoothstep } from '../../../src/audio/dsp';

interface Frame { t: number; sp: number; g: boolean; ch: number; sy: number; sf: boolean; gs: string; m: string | null; l: number }

/** Vorschlag: Speed-Anteil kleiner, Flow (Chain-Länge, nur mit Vortrieb) progressiv. */
function proposed(d: MusicDrive): number {
  const s = smoothstep(150, 1000, d.speed);
  let e = 0.72 * Math.pow(s, 0.75);
  const moving = smoothstep(150, 260, d.speed);
  e += 0.26 * smoothstep(1, 10, d.hopChain) * moving;
  if (d.surfing) e += 0.15;
  if (d.strafeSync > 0.7) e += 0.07 * moving;
  return clamp01(e);
}
const TH_PROP = [0, 0.04, 0.25, 0.55, 0.86];
/** Vorschlag B: zusätzlich Speed-Kurve auf den Bereich gestaucht, den Menschen erreichen (Sättigung 800 statt 1000). */
function proposedB(d: MusicDrive): number {
  const s = smoothstep(150, 800, d.speed);
  let e = 0.72 * Math.pow(s, 0.75);
  const moving = smoothstep(150, 260, d.speed);
  e += 0.26 * smoothstep(1, 10, d.hopChain) * moving;
  if (d.surfing) e += 0.15;
  if (d.strafeSync > 0.7) e += 0.07 * moving;
  return clamp01(e);
}

function run(frames: Frame[], target: (d: MusicDrive) => number, th: readonly number[], latch: boolean) {
  const beat = 60 / 132;
  let e = 0;
  let layer = 0;
  let below = 0;
  let nextBeat = 0.02;
  let beatIdx = 0;
  let maxSince = 0;
  let lastT = frames[0].t;
  let tgt = 0;
  const first: Record<number, number> = {};
  const share = [0, 0, 0, 0, 0];
  const flaps: string[] = [];
  let lastDrop = -1;
  const hold = (x: number) => { let l = 0; for (let i = 1; i <= 4; i++) if (x >= th[i] - LAYER_HYSTERESIS[i]) l = i; return l; };
  const up = (x: number) => { let l = 0; for (let i = 1; i <= 4; i++) if (x >= th[i]) l = i; return l; };
  const move = frames.find((f) => f.sp > 20)?.t ?? 0;
  for (const f of frames) {
    const dt = f.t - lastT;
    lastT = f.t;
    const active = f.m === null && (f.gs === 'playing' || f.gs === 'finished');
    if (active) {
      tgt = target({ speed: f.sp, onGround: f.g, hopChain: f.ch, strafeSync: f.sy, airTime: 0, surfing: f.sf, active: true });
      const tau = tgt > e ? ENERGY_ATTACK : ENERGY_RELEASE;
      e += (tgt - e) * (1 - Math.exp(-Math.min(dt, 0.25) / tau));
    }
    maxSince = Math.max(maxSince, e);
    while (f.t >= nextBeat) {
      const eu = latch ? maxSince : e;
      const u = up(eu);
      const st = hold(e);
      if (u > layer) {
        layer = u;
        below = 0;
        if (first[layer] === undefined) first[layer] = +(nextBeat - move).toFixed(2);
        if (lastDrop >= 0 && nextBeat - lastDrop < 4) flaps.push(`${(lastDrop - move).toFixed(1)}→${(nextBeat - move).toFixed(1)}s`);
      } else if (st < layer && (!latch || hold(tgt) < layer)) {
        below++;
        if (beatIdx % 4 === 0 && below > 8) {
          layer = Math.max(st, layer - 1);
          below = 5;
          lastDrop = nextBeat;
        }
      } else below = 0;
      maxSince = e;
      nextBeat += beat;
      beatIdx++;
    }
    if (f.gs === 'playing' && f.t >= move) share[layer] += dt;
  }
  const tot = share.reduce((a, b) => a + b, 0);
  return { first, share: share.map((x) => Math.round((x / tot) * 100)), flaps };
}

for (const id of ['l1', 'l1mid', 'l2', 'l2mid', 'beginner']) {
  const rec = JSON.parse(readFileSync(`shots/critique/audio/rec_${id}.json`, 'utf8')) as { frames: Frame[] };
  const fr = rec.frames;
  const move = fr.find((f) => f.sp > 20)?.t ?? 0;
  const real: Record<number, number> = {};
  for (const f of fr) if (real[f.l] === undefined && f.l > 0) real[f.l] = +(f.t - move).toFixed(2);
  const a = run(fr, targetEnergy, LAYER_THRESHOLDS, false);
  const b = run(fr, targetEnergy, LAYER_THRESHOLDS, true);
  const c = run(fr, proposed, TH_PROP, true);
  const dB = run(fr, proposedB, TH_PROP, true);
  const fmt = (r: ReturnType<typeof run>) => `L2 ${r.first[2] ?? '—'} · L3 ${r.first[3] ?? '—'} · L4 ${r.first[4] ?? '—'} s | Anteil L0..4 ${r.share.join('/')} % | Flaps ${r.flaps.join(', ') || '0'}`;
  console.log(`\n${id}  (im Spiel gemessen: L2 ${real[2] ?? '—'} · L3 ${real[3] ?? '—'} · L4 ${real[4] ?? '—'} s)`);
  console.log(`  aktuell (Nachbau)     ${fmt(a)}`);
  console.log(`  aktuell + Latch       ${fmt(b)}`);
  console.log(`  Vorschlag A + Latch   ${fmt(c)}`);
  console.log(`  Vorschlag B + Latch   ${fmt(dB)}`);
}
console.log('\nVorschlag, Ziel-Energie/Layer:');
for (const [n, p] of [['W 250, Chain 0', { speed: 250 }], ['Auto-Hop 250, Chain 6', { speed: 250, hopChain: 6 }], ['Auto-Hop 320, Chain 10', { speed: 320, hopChain: 10 }], ['Wand-Hüpfen 24, Chain 11', { speed: 24, hopChain: 11 }], ['Mid 450, Chain 10, sync .75', { speed: 450, hopChain: 10, strafeSync: 0.75 }], ['Bhop 600, Chain 10, sync .8', { speed: 600, hopChain: 10, strafeSync: 0.8 }], ['Bhop 700, Chain 12, sync .8', { speed: 700, hopChain: 12, strafeSync: 0.8 }], ['Surf 900', { speed: 900, surfing: true, strafeSync: 0.8 }]] as [string, Partial<MusicDrive>][]) {
  const d: MusicDrive = { speed: 0, onGround: false, hopChain: 0, strafeSync: 0, airTime: 0, surfing: false, active: true, ...p };
  const e = proposedB(d);
  let l = 0;
  for (let i = 1; i <= 4; i++) if (e >= TH_PROP[i]) l = i;
  const e0 = targetEnergy(d);
  let l0 = 0;
  for (let i = 1; i <= 4; i++) if (e0 >= LAYER_THRESHOLDS[i]) l0 = i;
  console.log(`  ${n.padEnd(30)} jetzt ${e0.toFixed(2)}/L${l0}  →  Vorschlag B ${e.toFixed(2)}/L${l}`);
}
