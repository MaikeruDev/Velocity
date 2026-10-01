/**
 * Butterfly-Messer abstimmen (Plan 008): sucht Handgelenk-Flicks (Keyframes der Hand-Kanäle), mit denen die
 * Pendel-Physik (ui/hand/knifeRig) einen sauberen Trick ergibt — Ziel-Zustand zur Fangzeit, kein Griff-gegen-
 * Griff-Durchdringen, Klinge und Griffe weg von der Hand, wenig Handbewegung. Ergebnis: Keyframes zum Einfügen
 * in ui/hand/knifeTricks.ts.
 *   npx tsx tools/knife-tune.ts open|close [--iters 4000] [--seed 1] [--probe a,b,c,…]
 */
import { KnifeSim, VIEW_UNIT } from '../src/ui/hand/knifeRig';
/** Hand-Anker im Spiel (16:9): Bildhöhen rechts/unter der Bildmitte (ViewHand: safeHalf − 0.3, 0.5 − 0.17). */
const ANCHOR_X = 16 / 9 / 2 - 0.3;
const ANCHOR_Y = 0.33;
import type { TrackMotion } from '../src/ui/hand/knifeRig';
import { KNIFE_HOLD_POS, KNIFE_HOLD_ROT, flipMotion } from '../src/ui/hand/knifeTricks';
import { HandShape } from '../src/ui/hand/handShape';
import { POSE, POSE_JOINTS } from '../src/ui/hand/poses';
import { VM_KNIFE } from '../src/render/types';
import { fromEulerXYZ, mat3 } from '../src/ui/hand/rot';

const args = process.argv.slice(2);
const mode = (args[0] ?? 'open') as 'open' | 'close';
const opt = (k: string, d: string): string => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const iters = Number(opt('--iters', '3000'));
let seed = Number(opt('--seed', '1'));
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** Parameter: Rollwinkel an 3 Keys, deren Zeiten, Fangzeit, Hand-Hub. */
interface P {
  r1: number;
  r2: number;
  r3: number;
  t1: number;
  t2: number;
  t3: number;
  tc: number;
  lift: number;
}
const toArr = (p: P): number[] => [p.r1, p.r2, p.r3, p.t1, p.t2, p.t3, p.tc, p.lift];
const fromArr = (a: number[]): P => ({ r1: a[0], r2: a[1], r3: a[2], t1: a[3], t2: a[4], t3: a[5], tc: a[6], lift: a[7] });
const LO = [-0.7, -0.7, -0.7, 0.05, 0.1, 0.15, 0.24, -0.05];
const HI = [0.7, 0.7, 0.7, 0.2, 0.3, 0.42, 0.5, 0.05];

const start = mode === 'open' ? { blade: Math.PI, bite: -Math.PI, goal: 0 } : { blade: 0, bite: 0, goal: Math.PI };

function motion(p: P): TrackMotion {
  return flipMotion(toArr(p), start.goal).motion;
}

const KD = VM_KNIFE;
/** Punkte der Bild-Hülle: Klingenspitze, Bite-Ende, Safe-Stift (Glied, lokal x, y). */
const HULL_PTS: readonly (readonly [number, number, number])[] = [
  [0, KD.pinGap / 2, KD.bladeFrom + KD.bladeLen + 0.6],
  [0, KD.pinGap / 2, KD.bladeFrom + KD.bladeLen * 0.5],
  [1, 0, -(KD.handleLen - KD.pinInset)],
  [1, 0, 0],
  [-1, 0, 0],
  [-1, 0, -(KD.handleLen - KD.pinInset)],
];
const hand = new HandShape();
hand.update(POSE_JOINTS[POSE.balisong]);
const S = fromEulerXYZ(mat3(), KNIFE_HOLD_ROT[0], KNIFE_HOLD_ROT[1], KNIFE_HOLD_ROT[2]);
const K = VM_KNIFE;

/** Abstand Klinge/Bite-Handle zur Hand (Ruhe-Pose), Punkte entlang der Mittellinien. */
function handClear(blade: number, bite: number): { blade: number; bite: number } {
  let bmin = 1e9;
  let hmin = 1e9;
  const cb = Math.cos(blade);
  const sb = Math.sin(blade);
  const ca = Math.cos(blade + bite);
  const sa = Math.sin(blade + bite);
  const pw = (lx: number, ly: number): [number, number, number] => [
    KNIFE_HOLD_POS[0] + S[0] * lx + S[1] * ly,
    KNIFE_HOLD_POS[1] + S[3] * lx + S[4] * ly,
    KNIFE_HOLD_POS[2] + S[6] * lx + S[7] * ly,
  ];
  for (let i = 0; i <= 10; i++) {
    const s = K.bladeFrom + (K.bladeLen * i) / 10;
    for (const w of [0, K.bladeW]) {
      const lx = w * cb - s * sb;
      const ly = w * sb + s * cb;
      const p = pw(lx, ly);
      bmin = Math.min(bmin, hand.distance(p[0], p[1], p[2]) - K.bladeD / 2);
    }
  }
  const bpx = K.pinGap * cb;
  const bpy = K.pinGap * sb;
  for (let i = 1; i <= 10; i++) {
    const s = ((K.handleLen - K.pinInset) * i) / 10;
    const p = pw(bpx + s * sa, bpy - s * ca);
    hmin = Math.min(hmin, hand.distance(p[0], p[1], p[2]) - K.handleD / 2);
  }
  return { blade: bmin, bite: hmin };
}

function evaluate(p: P, log = false): number {
  const sim = new KnifeSim();
  sim.hand = hand;
  const m = motion(p);
  sim.start(m, KNIFE_HOLD_POS, KNIFE_HOLD_ROT, start.blade, start.bite);
  const tc = Math.max(p.tc, Math.max(p.t3, Math.max(p.t2, p.t1 + 0.03) + 0.03) + 0.1);
  let pen = 0;
  let effort = 0;
  let prevB = start.blade;
  let biteTurn = 0;
  let settleErr = 0;
  let hull = 0;
  const vp = new Float64Array(3);
  let prevRel = start.blade + start.bite;
  for (let t = 0; t <= tc + 0.25 + 1e-9; t += 1 / 240) {
    sim.advanceTo(t);
    const b = sim.bladeAt(t);
    const bi = sim.bite;
    const rel = b + bi; // Bite absolut relativ zum Safe Handle
    biteTurn += rel - prevRel;
    prevRel = rel;
    // Nach dem Fang: ruhig im Ziel (Abweichung über die Zeit).
    if (t > tc) {
      const rr2 = rel - 2 * Math.PI * Math.round(rel / (2 * Math.PI));
      settleErr += ((b - start.goal) ** 2 + rr2 * rr2) / 240;
    }
    const c = handClear(b, bi);
    if (c.blade < 0.15) pen += (0.15 - c.blade) * 3;
    if (c.bite < -0.3) pen += -0.3 - c.bite;
    effort += (m.tracks[6]?.value(t) ?? 0) ** 2 / 240;
    // Bild-Hülle (look.md: nie im Blickzentrum): Spitzen und Griff-Enden im Bild, Anker wie im Spiel.
    for (const [lk, lx, ly] of HULL_PTS) {
      sim.viewPointOf(t, lk, lx, ly, vp);
      const X = ANCHOR_X * VIEW_UNIT + vp[0];
      const Yv = -ANCHOR_Y * VIEW_UNIT + vp[1];
      const Z = -40 + vp[2];
      const s = 1 / (-Z * 2 * Math.tan((54 * Math.PI) / 360));
      const left = X * s;
      const up = -Yv * s;
      // Etwas Rand (Griffbreite, Hüllkörper der Meshes): −0.28 statt −0.314, 0.085 statt 0.055.
      hull += Math.max(0, -0.28 - up) + Math.max(0, 0.085 - left);
    }
    if (log && Math.round(t * 240) % 6 === 0) console.log(`t ${t.toFixed(3)} blade ${b.toFixed(2)} bite ${bi.toFixed(2)} abs ${rel.toFixed(2)} clearB ${c.blade.toFixed(2)} clearH ${c.bite.toFixed(2)}`);
    prevB = b;
  }
  void prevB;
  // Am Fang: Zustand vor der Führung (kurz vor tc) soll schon nahe am Ziel sein.
  const pre = new KnifeSim();
  pre.hand = hand;
  pre.start(m, KNIFE_HOLD_POS, KNIFE_HOLD_ROT, start.blade, start.bite);
  pre.advanceTo(tc - 0.06);
  const b0 = pre.bladeAt(tc - 0.06);
  const r0 = b0 + pre.bite;
  const rr = r0 - 2 * Math.PI * Math.round(r0 / (2 * Math.PI));
  const stateErr = (b0 - start.goal) ** 2 + rr * rr;
  // Ein echter Basic Opening dreht den Bite Handle einmal um den Safe Handle (≈ ±2π).
  const turnErr = (Math.abs(biteTurn) - 2 * Math.PI) ** 2 * 0.2;
  const cost = 3 * hull + 20 * settleErr + 4 * stateErr + turnErr + 0.5 * pen + 1.0 * effort + 20 * sim.contactMax + 3 * sim.handMax[0] + 2 * Math.max(0, sim.handMax[1] - 0.4) + 1.5 * tc;
  if (log) console.log(`hull ${hull.toFixed(3)} settle ${settleErr.toFixed(4)} handMax ${sim.handMax[0].toFixed(3)}/${sim.handMax[1].toFixed(3)} stateErr ${stateErr.toFixed(3)} turn ${biteTurn.toFixed(2)} pen ${pen.toFixed(3)} effort ${effort.toFixed(3)} contact ${sim.contactMax.toFixed(3)} tc ${tc.toFixed(3)} → ${cost.toFixed(4)}`);
  return cost;
}

const probe = opt('--probe', '');
if (probe) {
  evaluate(fromArr(probe.split(',').map(Number)), true);
  process.exit(0);
}

// Zufallssuche + lokale Verfeinerung (Koordinaten-Abstieg mit schrumpfender Schrittweite).
let best = toArr(fromArr(LO.map((l, i) => (l + HI[i]) / 2)));
let bestC = evaluate(fromArr(best));
for (let i = 0; i < iters; i++) {
  const cand = LO.map((l, k) => l + (HI[k] - l) * rnd());
  const c = evaluate(fromArr(cand));
  if (c < bestC) {
    bestC = c;
    best = cand;
    console.log(`#${i} ${c.toFixed(4)} ${best.map((v) => v.toFixed(3)).join(',')}`);
  }
}
let step = 0.15;
for (let round = 0; round < 40 && step > 0.002; round++) {
  let improved = false;
  for (let k = 0; k < best.length; k++) {
    for (const s of [-1, 1]) {
      const cand = best.slice();
      cand[k] = Math.min(HI[k], Math.max(LO[k], cand[k] + s * step * (HI[k] - LO[k])));
      const c = evaluate(fromArr(cand));
      if (c < bestC) {
        bestC = c;
        best = cand;
        improved = true;
      }
    }
  }
  if (!improved) step /= 2;
}
console.log(`BEST ${bestC.toFixed(4)} --probe ${best.map((v) => v.toFixed(4)).join(',')}`);
evaluate(fromArr(best), true);
