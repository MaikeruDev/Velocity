/**
 * PROTOTYP-Messung (Kosmetik v2): Schnur (rope.ts) — Framerate-Einfluss, Überlänge, Kosten,
 * Robustheit und Nachschwingen eines hängenden Jo-Jos an der ECHTEN HandMotion.
 *   npx tsx tools/critique/v2/kosmetik/rope-bench.ts
 * Ausgabe: shots/v2/kosmetik/rope-bench.json
 *
 * "Framerate-Einfluss" = Abweichung der Innenpunkte bei 30/60/144/240 Hz gegen DIESELBE Physik bei
 * 2400 Hz Frames (fest: gleiche 1/240-Unterschritte; naiv: ein Schritt pro Frame → Grenzwert
 * 1/2400). Das ist, was ein Spieler mit anderem Monitor anders sähe.
 * 1 Hand-Einheit ≈ 6.6 Low-Res-Pixel bei 270 Zeilen (Tiefe 40, vFOV 54°).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { HandMotion, makeHandInput } from '../../../../src/ui/hand/handMotion';
import type { GameEvent } from '../../../../src/engine/events';
import { Rope } from './rope';

const HH2 = 2 * 40 * Math.tan((54 * Math.PI) / 360);
const PX_PER_UNIT_270 = 270 / HH2;

interface Pose {
  sx: number;
  sy: number;
  sz: number;
  ex: number;
  ey: number;
  ez: number;
}

type Scenario = { readonly name: string; readonly length: number; readonly duration: number; readonly at: (t: number, o: Pose) => void };

const sm = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

const SCENARIOS: readonly Scenario[] = [
  {
    // Jo-Jo-Wurf nach unten und zurück (geführtes Ende), Hand wiegt seitlich.
    name: 'yoyo-throw',
    length: 9.5,
    duration: 1.6,
    at: (t, o) => {
      const sway = t > 0.3 && t < 1.3 ? 1.5 * Math.sin(2 * Math.PI * 1.5 * (t - 0.3)) : 0;
      o.sx = sway;
      o.sy = 0;
      o.sz = 0;
      let y = -1;
      if (t < 0.25) y = -1 - 8 * sm(t / 0.25);
      else if (t < 1.25) y = -9 + 0.2 * Math.sin(30 * t);
      else if (t < 1.45) y = -9 + 8 * sm((t - 1.25) / 0.2);
      o.ex = sway * 0.4;
      o.ey = y;
      o.ez = 0;
    },
  },
  {
    // Around the World: Kreis r 8.5 in der Bildebene, 1.8 U/s — Schnur gespannt.
    name: 'yoyo-around',
    length: 9,
    duration: 1.3,
    at: (t, o) => {
      const w = 2 * Math.PI * 1.8 * t;
      o.sx = 0;
      o.sy = 0;
      o.sz = 0;
      o.ex = 8.5 * Math.sin(w);
      o.ey = -8.5 * Math.cos(w);
      o.ez = 0;
    },
  },
  {
    // Kendama: Kugel wird hochgezogen (Schnur locker), landet im großen Becher.
    name: 'kendama-bigcup',
    length: 9,
    duration: 1.4,
    at: (t, o) => {
      o.sx = 0;
      o.sy = 0;
      o.sz = 0;
      if (t < 0.3) {
        o.ex = 0.3;
        o.ey = -8;
        o.ez = 0;
        return;
      }
      const s = Math.min(1, (t - 0.3) / 0.55);
      o.ex = 0.3 * (1 - s) + 2.5 * Math.sin(Math.PI * s);
      o.ey = -8 + 11.5 * sm(s) + 4 * Math.sin(Math.PI * s);
      o.ez = 1 * sm(s) + 2 * Math.sin(Math.PI * s);
    },
  },
];

interface Run {
  readonly frames: Float32Array[];
  readonly times: number[];
  readonly maxStretch: number;
}

function runScenario(sc: Scenario, fps: number, substep: number): Run {
  const rope = new Rope({ segments: 8, length: sc.length, substep, iterations: 4 });
  const o: Pose = { sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0 };
  sc.at(0, o);
  rope.reset(o.sx, o.sy, o.sz, o.ex, o.ey, o.ez);
  const dt = 1 / fps;
  const frames: Float32Array[] = [rope.out.slice()];
  const times: number[] = [0];
  let maxStretch = 0;
  const n = Math.round(sc.duration * fps);
  for (let i = 1; i <= n; i++) {
    const t = i * dt;
    sc.at(t, o);
    rope.update(dt, o.sx, o.sy, o.sz, o.ex, o.ey, o.ez);
    frames.push(rope.out.slice());
    times.push(t);
    maxStretch = Math.max(maxStretch, rope.stretch);
  }
  return { frames, times, maxStretch };
}

/** Größte Abweichung (Einheiten) der Punkte from..to gegen die Referenz, an jedem Frame. */
function compare(a: Run, ref: Run, refFps: number, from: number, to: number): number {
  let worst = 0;
  for (let f = 0; f < a.frames.length; f++) {
    const x = a.times[f] * refFps;
    const i = Math.min(ref.frames.length - 2, Math.floor(x));
    const u = x - i;
    const A = ref.frames[i];
    const B = ref.frames[i + 1];
    const cur = a.frames[f];
    for (let k = from * 3; k < to * 3; k++) {
      const r = A[k] + (B[k] - A[k]) * u;
      worst = Math.max(worst, Math.abs(cur[k] - r));
    }
  }
  return worst;
}

const f2 = (u: number): string => `${u.toFixed(3)} u = ${(u * PX_PER_UNIT_270).toFixed(2)} px`;
const RATES = [30, 60, 144, 240];
const REF = 2400;
const result: Record<string, unknown> = { pxPerUnit270: +PX_PER_UNIT_270.toFixed(3) };
const table: Record<string, Record<string, string>> = {};
for (const sc of SCENARIOS) {
  const refFixed = runScenario(sc, REF, 1 / 240);
  const refNaive = runScenario(sc, REF, 0);
  const row: Record<string, string> = {};
  for (const fps of RATES) {
    const fixed = runScenario(sc, fps, 1 / 240);
    const naive = runScenario(sc, fps, 0);
    row[`${fps} Hz fest`] = `${f2(compare(fixed, refFixed, REF, 1, 8))}, Überlänge ${(fixed.maxStretch * 100).toFixed(1)} %`;
    row[`${fps} Hz naiv`] = `${f2(compare(naive, refNaive, REF, 1, 8))}, Überlänge ${(naive.maxStretch * 100).toFixed(1)} %`;
  }
  table[sc.name] = row;
}
result.framerateInfluence = table;

// --- Hängendes Jo-Jo (freies Ende) an der echten HandMotion: Bhop mit A/D-Wechsel, harte
// Landung, Maus-Flick. Schwerkraft dreht mit der Hand-Neigung (tilt), Scheinkraft aus der
// Anker-Bewegung — gedeckelt auf capG × g, sonst wird die Schnur beim Sprung-Kick schlaff und
// das Pendel überschlägt sich (Messung ohne Deckel: siehe capG = 99).
interface HangRun {
  readonly endX: number[];
  readonly endY: number[];
  readonly times: number[];
}

const G = 980;

function hang(fps: number, cartoon: number, capG: number): HangRun {
  const hm = new HandMotion();
  const inp = makeHandInput();
  const rope = new Rope({ segments: 8, length: 9, substep: 1 / 240, iterations: 4, endWeight: 0.15 });
  rope.freeEnd = true;
  rope.reset(0, 0, 0, 0, -8.99, 0);
  const dt = 1 / fps;
  let px = 0;
  let py = 0;
  let vx = 0;
  let vy = 0;
  let primed = 0;
  const hops: GameEvent[] = [];
  const out: HangRun = { endX: [], endY: [], times: [] };
  const step = (t: number, active: boolean): void => {
    // 0.5–2.3 s: Bhop-Kette (Sprung alle 0.66 s, Luft 0.62 s), A/D wechselt je Luftphase.
    let onGround = true;
    let side = 0;
    let airT = 0;
    if (active && t >= 0.5 && t < 2.3) {
      const k = Math.floor((t - 0.5) / 0.66);
      const u = (t - 0.5) - k * 0.66;
      onGround = u >= 0.62;
      side = k % 2 === 0 ? 1 : -1;
      airT = onGround ? 0 : u;
      const ev = hops[k];
      if (ev === undefined) {
        const jump: GameEvent = { type: 'jump', speed: 450 + 40 * k, gain: 20, perfect: k > 0, clean: k > 0, chain: k + 1, sync: 0.9, crouched: false, coyote: false };
        hops[k] = jump;
        hm.onEvent(jump);
      }
      if (onGround && hops[k + 100] === undefined) {
        const land: GameEvent = { type: 'land', impact: k === 2 ? 650 : 300, speed: 500, airTime: 0.62, jumpQueued: k !== 2 };
        hops[k + 100] = land;
        hm.onEvent(land);
      }
    }
    inp.onGround = onGround;
    inp.airTime = airT;
    inp.side = side;
    // Maus: Strafe-Schwenk während der Luft (±1.6 rad/s), Flick 2.6–2.7 s.
    inp.yawDelta = active ? (!onGround ? side * 1.6 * dt : t >= 2.6 && t < 2.7 ? 2.2 * dt : 0) : 0;
    hm.update(dt, inp);
    const ax = hm.x * HH2;
    const ay = -hm.y * HH2;
    const nvx = (ax - px) / dt;
    const nvy = (ay - py) / dt;
    let aX = primed > 1 ? cartoon * ((nvx - vx) / dt) : 0;
    let aY = primed > 1 ? cartoon * ((nvy - vy) / dt) : 0;
    const l = Math.hypot(aX, aY);
    if (l > capG * G) {
      aX *= (capG * G) / l;
      aY *= (capG * G) / l;
    }
    primed++;
    rope.accel[0] = aX;
    rope.accel[1] = aY;
    // Schwerkraft im Handraum: Bild-unten um die Hand-Neigung gedreht (tilt in Grad, + = gegen UZS).
    const r = (hm.tilt * Math.PI) / 180;
    rope.gravity[0] = -G * Math.sin(r);
    rope.gravity[1] = -G * Math.cos(r);
    px = ax;
    py = ay;
    vx = nvx;
    vy = nvy;
    rope.update(dt, 0, 0, 0, 0, 0, 0);
  };
  // 2 s Einschwingen in Ruhe (primt auch die Differenzen).
  for (let i = 0; i < 2 * fps; i++) step(0, false);
  const n = Math.round(3.4 * fps);
  for (let i = 1; i <= n; i++) {
    const t = i * dt;
    step(t, true);
    out.endX.push(rope.endX);
    out.endY.push(rope.endY);
    out.times.push(t);
  }
  return out;
}

function swing(r: HangRun, from: number, to: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < r.times.length; i++) {
    if (r.times[i] < from || r.times[i] > to) continue;
    lo = Math.min(lo, r.endX[i]);
    hi = Math.max(hi, r.endX[i]);
  }
  return hi - lo;
}

function lowest(r: HangRun): number {
  let hi = -Infinity;
  for (const y of r.endY) hi = Math.max(hi, y);
  return hi;
}

function hangDiff(a: HangRun, ref: HangRun, refFps: number): number {
  let worst = 0;
  for (let i = 0; i < a.times.length; i++) {
    const j = Math.min(ref.times.length - 1, Math.max(0, Math.round(a.times[i] * refFps) - 1));
    worst = Math.max(worst, Math.hypot(a.endX[i] - ref.endX[j], a.endY[i] - ref.endY[j]));
  }
  return worst;
}

{
  const res: Record<string, unknown> = {};
  for (const [cartoon, capG] of [
    [1, 99],
    [1, 0.6],
    [2, 0.6],
  ] as const) {
    const ref = hang(REF, cartoon, capG);
    const row: Record<string, string> = {
      'Bhop-Kette (0.5–2.3 s) Pendel-Ausschlag x': f2(swing(ref, 0.5, 2.3)),
      'Maus-Flick (2.6–3.4 s)': f2(swing(ref, 2.6, 3.4)),
      'höchster Punkt des Jo-Jos (y, Finger = 0)': f2(lowest(ref)),
    };
    for (const fps of RATES) row[`${fps} Hz Abweichung Jo-Jo-Position`] = f2(hangDiff(hang(fps, cartoon, capG), ref, REF));
    res[`Scheinkraft × ${cartoon}, Deckel ${capG} g`] = row;
  }
  result.hangingYoyo = res;
}

// --- Kosten: 8 Segmente, 4 Iterationen, 1/240-Unterschritte.
{
  const sc = SCENARIOS[1];
  const o: Pose = { sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0 };
  const bench = (fps: number): number => {
    const rope = new Rope({ segments: 8, length: sc.length, substep: 1 / 240, iterations: 4 });
    rope.reset(0, 0, 0, 0, -8.5, 0);
    const N = 200_000;
    for (let i = 0; i < 5000; i++) {
      sc.at((i / fps) % sc.duration, o);
      rope.update(1 / fps, o.sx, o.sy, o.sz, o.ex, o.ey, o.ez);
    }
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      sc.at((i / fps) % sc.duration, o);
      rope.update(1 / fps, o.sx, o.sy, o.sz, o.ex, o.ey, o.ez);
    }
    return Number(process.hrtime.bigint() - t0) / N / 1000;
  };
  result.costMicrosPerFrame = { '30 Hz': +bench(30).toFixed(2), '60 Hz': +bench(60).toFixed(2), '144 Hz': +bench(144).toFixed(2), note: 'Node 22, ein Kern, inkl. Szenario-Auswertung' };
}

// --- Robustheit: wilde Eingaben (NaN, negative/riesige dt, Teleports, freies Ende).
{
  const rope = new Rope({ segments: 8, length: 9, substep: 1 / 240, iterations: 4 });
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let nan = 0;
  const dts = [Number.NaN, -1, 0, 1e-6, 0.0041, 1 / 60, 0.1, 5, Infinity];
  for (let i = 0; i < 20_000; i++) {
    if (i % 997 === 0) rope.freeEnd = !rope.freeEnd;
    const dt = rnd() < 0.3 ? dts[Math.floor(rnd() * dts.length)] : rnd() * 0.05;
    const big = rnd() < 0.01 ? 1e6 : rnd() < 0.005 ? Number.NaN : 10;
    rope.accel[0] = rnd() < 0.01 ? 1e5 : 0;
    rope.update(dt, (rnd() - 0.5) * 2, (rnd() - 0.5) * 2, 0, (rnd() - 0.5) * big, -8 + (rnd() - 0.5) * 4, (rnd() - 0.5) * 3);
    for (const v of rope.out) if (!Number.isFinite(v)) nan++;
  }
  result.robustness = { steps: 20000, nanValues: nan };
}

mkdirSync('shots/v2/kosmetik', { recursive: true });
writeFileSync('shots/v2/kosmetik/rope-bench.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
