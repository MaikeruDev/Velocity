import { PerformanceObserver } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { CardTricks } from '../src/ui/hand/cardTricks';
import { COIN_REST_POS, CoinTricks } from '../src/ui/hand/coinTricks';
import { HandShape } from '../src/ui/hand/handShape';
import { ViewHand } from '../src/ui/hand/ViewHand';
import { makeHandInput } from '../src/ui/hand/handMotion';
import { POSE, POSE_JOINTS } from '../src/ui/hand/poses';
import type { PropControl, PropFrameInput } from '../src/ui/hand/propTricks';
import { socketMatrix } from '../src/ui/hand/propShape';
import { thumbPoint } from '../src/ui/hand/fk';
import { VIEW_AXES, fromEulerXYZV, mat3 } from '../src/ui/hand/rot';
import { VM_JOINT_COUNT, VM_RIG } from '../src/render/types';
import { itemPoints } from '../tools/lib/handContact';

/**
 * Plan 008 Schritt 2 — Karte, Münze, Messer-Feinschliff: Griff (Daumen vorn auf der Karte), keine Durchdringung über
 * alle Frames (HandShape gegen die Item-Oberfläche), Stetigkeit, Framerate-Unabhängigkeit inkl. Finger-Versatz,
 * allokationsfreier Frame-Pfad, Rollover-Abstand Klinge–Hand.
 */

const CARD_TRICKS = ['spin', 'turn', 'tossSpin', 'vanish', 'fan'] as const;
const COIN_TRICKS = ['knuckleRoll', 'roll', 'flip', 'highFlip', 'vanish', 'call'] as const;

/** Oberflächen-Punkte im Gegenstands-Raum (Karte 64 × 88 × 1.2 mm, Münze r 2.1, Dicke 0.42). */
function surface(item: 'card' | 'coin'): number[][] {
  const pts: number[][] = [];
  if (item === 'card') {
    for (let i = 0; i <= 12; i++) for (let k = 0; k <= 16; k++) for (const z of [-0.06, 0.06]) pts.push([-3.2 + (6.4 * i) / 12, -4.4 + (8.8 * k) / 16, z]);
  } else {
    for (let r = 0; r <= 4; r++) for (let a = 0; a < 24; a++) for (const z of [-0.21, 0.21]) pts.push([((2.1 * r) / 4) * Math.cos((a * Math.PI) / 12), ((2.1 * r) / 4) * Math.sin((a * Math.PI) / 12), z]);
  }
  return pts;
}

interface Sample {
  readonly t: number;
  readonly gap: number;
  readonly visible: number;
  readonly pos: number[];
  readonly m: Float64Array;
  readonly joints: number[];
}

/** Echte ViewHand, Trick frei mit `rate` Hz; je Frame kleinster Abstand der sichtbaren Item-Oberfläche zur Hand. */
function play(item: 'card' | 'coin', trick: string, rate: number, secs: number): Sample[] {
  const h = new ViewHand();
  h.setAspect(16 / 9);
  h.setItem(item);
  const inp = makeHandInput();
  for (let i = 0; i < 90; i++) h.update(1 / 60, inp);
  h.forceTrick(trick, -1);
  const hs = new HandShape();
  const M = mat3();
  const T = mat3();
  const pts = surface(item);
  const out: Sample[] = [];
  for (let f = 1; f <= Math.round(secs * rate); f++) {
    h.update(1 / rate, inp);
    const fr = h.frame;
    hs.update(fr.joints);
    socketMatrix(fr.propRot, fr.propSpin, M, T);
    let gap = 1e9;
    if (fr.propVisible > 0.01) {
      for (const l of pts) {
        const s = fr.propScale;
        const x = fr.propPos[0] + (M[0] * l[0] + M[1] * l[1] + M[2] * l[2]) * s;
        const y = fr.propPos[1] + (M[3] * l[0] + M[4] * l[1] + M[5] * l[2]) * s;
        const z = fr.propPos[2] + (M[6] * l[0] + M[7] * l[1] + M[8] * l[2]) * s;
        gap = Math.min(gap, hs.distance(x, y, z));
      }
    }
    out.push({ t: f / rate, gap, visible: fr.propVisible, pos: Array.from(fr.propPos), m: Float64Array.from(M), joints: Array.from(fr.joints) });
  }
  return out;
}

/** Winkel zwischen zwei Drehmatrizen (rad). */
function angle(a: Float64Array, b: Float64Array): number {
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) tr += a[k * 3 + i] * b[k * 3 + i];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
}

describe('Karte: Griff (Plan 008 Schritt 2)', () => {
  it('Ruhe: Daumenpolster liegt VORN auf der Karte (sichtbar wie Plan 006), über der Unterkante, ohne Durchdringung', () => {
    const s = play('card', 'none', 60, 0.5);
    const last = s[s.length - 1];
    // Kein Teil der Hand steckt tiefer als 0.2 in der Karte, und sie liegt an (kein Schweben).
    expect(last.gap).toBeGreaterThan(-0.2);
    expect(last.gap).toBeLessThan(0.1);
    // Daumenpolster in Karten-Koordinaten: vor der Vorderseite (+z), innerhalb der Breite, ≥ 1 über der Unterkante.
    const p = new Float64Array(3);
    thumbPoint(last.joints, 2, 0, VM_RIG.thumb.len[2] * 0.6, 0, p);
    const d = [p[0] - last.pos[0], p[1] - last.pos[1], p[2] - last.pos[2]];
    const m = last.m;
    const lx = m[0] * d[0] + m[3] * d[1] + m[6] * d[2];
    const ly = m[1] * d[0] + m[4] * d[1] + m[7] * d[2];
    const lz = m[2] * d[0] + m[5] * d[1] + m[8] * d[2];
    expect(lz).toBeGreaterThan(0.5);
    expect(Math.abs(lx)).toBeLessThan(2.5);
    expect(ly).toBeGreaterThan(-4.4 + 1.0);
    // Die Vorderseite zeigt zur Kamera (Daumen also im Bild vor der Karte).
    const nz = m[2] * VIEW_AXES.cam[0] + m[5] * VIEW_AXES.cam[1] + m[8] * VIEW_AXES.cam[2];
    expect(nz).toBeGreaterThan(0.3);
  });
});

describe('Karte und Münze: keine Durchdringung, stetig (240 Hz, jeder Frame)', () => {
  for (const [item, list, secs] of [
    ['card', CARD_TRICKS, 2.2],
    ['coin', COIN_TRICKS, 2.3],
  ] as const) {
    for (const trick of list) {
      it(`${item} ${trick}`, () => {
        const s = play(item, trick, 240, secs);
        let worst = 1e9;
        let worstT = 0;
        for (const x of s) {
          if (x.gap < worst) {
            worst = x.gap;
            worstT = x.t;
          }
          for (const v of x.pos) expect(Number.isFinite(v)).toBe(true);
        }
        // Handschuh drückt höchstens 3 mm ein (Ruhe-Griffe −0.12, Plan-008-Grenze 0.35).
        expect(worst, `${item} ${trick} t=${worstT.toFixed(3)}`).toBeGreaterThan(-0.3);
        // Stetig: sichtbare Lage springt nie (240 Hz: ≤ 1.2 Einheiten und ≤ 0.6 rad je Frame), Gelenke ≤ 0.12 rad je Frame.
        for (let i = 1; i < s.length; i++) {
          const a = s[i - 1];
          const b = s[i];
          if (a.visible > 0.01 && b.visible > 0.01) {
            const dp = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]);
            expect(dp, `${item} ${trick} Lage t=${b.t.toFixed(3)}`).toBeLessThan(1.2);
            expect(angle(a.m, b.m), `${item} ${trick} Drehung t=${b.t.toFixed(3)}`).toBeLessThan(0.6);
          }
          let dj = 0;
          for (let k = 0; k < VM_JOINT_COUNT; k++) dj = Math.max(dj, Math.abs(b.joints[k] - a.joints[k]));
          expect(dj, `${item} ${trick} Gelenke t=${b.t.toFixed(3)}`).toBeLessThan(0.12);
        }
      });
    }
  }
});

/** Ausgabe je Frame inkl. Finger-Versatz (afterPose mit fester Pose), Trick ab t = 1/6 s. */
function run(make: () => PropControl, name: string, fps: number, secs: number): number[][] {
  const p = make();
  const inp: PropFrameInput = { speed: 0, onGround: true, surfing: false, surfSide: 0 };
  const out: number[][] = [];
  const start = Math.round(fps / 6);
  const R = mat3();
  for (let f = 1; f <= Math.round(secs * fps); f++) {
    if (f === start) p.debugPlayName(name, -1);
    p.update(1 / fps, inp);
    p.afterPose(POSE_JOINTS[POSE.pinch], inp, 1 / fps);
    const o = p.out;
    fromEulerXYZV(R, o.rot);
    out.push([o.pos[0], o.pos[1], o.pos[2], ...Array.from(R), o.spin, o.visible, o.scale, o.hx, o.hy, o.hpitch, o.hyaw, o.hroll, ...Array.from(o.jointAdd)]);
  }
  return out;
}

describe('Framerate-unabhängig: jeder Frame 30/60/144/240 Hz gegen 1440 Hz ≤ 0.01 (Lage als Matrix, Finger-Versatz inklusive)', () => {
  const cases: [string, () => PropControl, readonly string[]][] = [
    ['card', () => new CardTricks(), CARD_TRICKS],
    ['coin', () => new CoinTricks(), COIN_TRICKS],
  ];
  for (const [item, make, list] of cases) {
    it(item, () => {
      for (const name of list) {
        const ref = run(make, name, 1440, 2.5);
        for (const fps of [30, 60, 144, 240]) {
          const got = run(make, name, fps, 2.5);
          let worst = 0;
          for (let i = 0; i < got.length; i++) {
            const b = ref[((i + 1) * 1440) / fps - 1];
            const a = got[i];
            for (let k = 0; k < a.length; k++) {
              // Eigendrehung (Index 12) ist ein Winkel.
              let d = Math.abs(a[k] - b[k]);
              if (k === 12) d = Math.min(d % (Math.PI * 2), Math.PI * 2 - (d % (Math.PI * 2)));
              worst = Math.max(worst, d);
            }
          }
          expect(worst, `${item} ${name} @ ${fps} Hz`).toBeLessThanOrEqual(0.01);
        }
      }
    });
  }
});

describe('Frame-Pfad allokationsfrei', () => {
  /**
   * Node-Probe (wie fallen.md #199): Tricks im Wechsel, 144 Hz, inkl. afterPose. Neustarts sind Ereignisse (dürfen
   * allokieren); Dauer-Müll aus dem Frame-Pfad zeigte sich als 4–9 Scavenges je 100 000 Frames (Inlining-Budget, #107.5).
   * Grenze: höchstens 2 Scavenges in 30 000 Frames (≈ 200 Neustarts) — gemessen 1, die alte Fassung ebenso.
   */
  for (const [item, make, names] of [
    ['card', () => new CardTricks(), CARD_TRICKS],
    ['coin', () => new CoinTricks(), COIN_TRICKS],
  ] as const) {
    it(item, async () => {
      const p: PropControl = make();
      const inp: PropFrameInput = { speed: 0, onGround: true, surfing: false, surfSide: 0 };
      const joints = POSE_JOINTS[POSE.pinch];
      const loop = (frames: number): void => {
        for (let f = 0; f < frames; f++) {
          if (p.trick === 'none') p.debugPlayName(names[(f >> 7) % names.length], -1);
          p.update(1 / 144, inp);
          p.afterPose(joints, inp, 1 / 144);
        }
      };
      loop(40000);
      let scavenges = 0;
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if ((e as unknown as { detail?: { kind?: number } }).detail?.kind === 1) scavenges++;
      });
      obs.observe({ entryTypes: ['gc'] });
      loop(30000);
      await new Promise((r) => setTimeout(r, 50));
      obs.disconnect();
      expect(scavenges).toBeLessThanOrEqual(2);
    });
  }
});

describe('Münze: Ruhe-Klemme unverändert', () => {
  it('Ruhe-Lage wie Plan 008 Schritt 1 (Daumen-Klemme)', () => {
    const c = new CoinTricks();
    c.reset();
    expect(Array.from(c.out.pos).map((v) => Math.round(v * 100) / 100)).toEqual(COIN_REST_POS.map((v) => Math.round(v * 100) / 100));
  });
});

describe('Butterfly-Feinschliff', () => {
  function bladeClearance(trick: string, open: boolean, rate: number): number {
    const h = new ViewHand();
    h.setAspect(16 / 9);
    h.setItem('knife');
    h.knife.isOpen = open;
    const inp = makeHandInput();
    for (let i = 0; i < 30; i++) h.update(1 / 60, inp);
    h.forceTrick(trick, -1);
    const shape = new HandShape();
    let worst = Infinity;
    for (let i = 0; i < Math.round(1.0 * rate); i++) {
      h.update(1 / rate, inp);
      const f = h.output(true);
      if (f.knifeBlade > Math.PI - 0.25) {
        if (h.activeProp?.trick === 'none') break;
        continue;
      }
      const pts = itemPoints(f, (m) => m.parent?.name === 'knifeBlade');
      shape.update(f.joints);
      for (let k = 0; k < pts.length; k += 3) worst = Math.min(worst, shape.distance(pts[k], pts[k + 1], pts[k + 2]));
      if (h.activeProp?.trick === 'none') break;
    }
    return worst;
  }

  it('Rollover: Klinge hält ≥ 0.12 Abstand zur Hand (vorher 0.06 an der Handfläche), offen und zu, 60/144 Hz', () => {
    for (const open of [false, true]) for (const rate of [60, 144]) expect(bladeClearance('rollover', open, rate), `${open} ${rate}`).toBeGreaterThan(0.12);
  });

  it('Fang ohne Posen-Sprung: der Daumen schließt stetig (≤ 0.12 rad je 240-Hz-Frame) und steht danach im Ruhe-Griff', () => {
    for (const trick of ['rollover', 'aerial', 'doubleAerial']) {
      const h = new ViewHand();
      h.setItem('knife');
      const inp = makeHandInput();
      for (let i = 0; i < 60; i++) h.update(1 / 60, inp);
      h.forceTrick(trick, -1);
      let prev = Array.from(h.frame.joints);
      let opened = 0;
      for (let f = 0; f < 240 * 1.3; f++) {
        h.update(1 / 240, inp);
        const j = Array.from(h.frame.joints);
        for (let k = 3; k <= 6; k++) expect(Math.abs(j[k] - prev[k]), `${trick} Daumen ${k}`).toBeLessThan(0.12);
        opened = Math.max(opened, Math.abs(j[3] - POSE_JOINTS[POSE.balisong][3]));
        prev = j;
      }
      // Der Daumen hat wirklich freigegeben …
      expect(opened, trick).toBeGreaterThan(0.3);
      // … und steht am Ende wieder im Griff.
      for (let k = 3; k <= 6; k++) expect(Math.abs(prev[k] - POSE_JOINTS[POSE.balisong][k]), `${trick} Ende ${k}`).toBeLessThan(0.02);
    }
  });
});
