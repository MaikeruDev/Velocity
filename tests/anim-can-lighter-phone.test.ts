import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { BoxGeometry } from 'three';
import type { Mesh } from 'three';
import { VM_JOINT_COUNT, VM_PARAM } from '../src/render/types';
import { CanTricks } from '../src/ui/hand/canTricks';
import { LighterTricks } from '../src/ui/hand/lighterTricks';
import { PhoneTricks } from '../src/ui/hand/phoneTricks';
import type { PropControl, PropFrameInput } from '../src/ui/hand/propTricks';
import { ViewHand } from '../src/ui/hand/ViewHand';
import { makeHandInput } from '../src/ui/hand/handMotion';
import { fromEulerXYZ, mat3 } from '../src/ui/hand/rot';
import { itemPoints, measure } from '../tools/lib/handContact';
import { HAND_PART_NAMES } from '../src/ui/hand/handShape';
import type { HeldItemId } from '../src/engine/settingsTypes';

/**
 * Plan 008 Schritt 2 — Dose, Sturmfeuerzeug, Handy: Animationen aus der Hand (Würfe als Parabel, Finger/Daumen über
 * jointAdd, Fang mit Nachgeben). Geprüft: Stetigkeit (auch beim Übergang in die Ruhe), Framerate-Unabhängigkeit
 * 30–240 Hz gegen 1440 Hz INKLUSIVE jointAdd (cosmetics.test vergleicht ihn nicht), keine NaN, keine Durchdringung
 * Gegenstand ↔ Hand-Modell (> 0.35 Einheiten, wie die Ruhe-Griffe), allokationsfrei.
 */

type Item = 'can' | 'lighter' | 'phone';
interface Case {
  readonly item: Item;
  readonly trick: string;
  readonly dur: number;
  readonly setup?: { readonly opened?: boolean; readonly lidOpen?: boolean; readonly lit?: boolean };
  /** Surf-Zustand: so lange surfen (s), dann endet er. */
  readonly surf?: number;
}

const CASES: readonly Case[] = [
  { item: 'can', trick: 'flip', dur: 0.8 },
  { item: 'can', trick: 'highFlip', dur: 0.95 },
  { item: 'can', trick: 'twirl', dur: 0.8 },
  { item: 'can', trick: 'doubleFlip', dur: 1.0 },
  { item: 'can', trick: 'behindThrow', dur: 1.2 },
  { item: 'can', trick: 'crack', dur: 1.15 },
  { item: 'can', trick: 'sip', dur: 1.8, setup: { opened: true } },
  { item: 'can', trick: 'tilt', dur: 1.0, setup: { opened: true } },
  { item: 'can', trick: 'tilt', dur: 1.0 },
  { item: 'lighter', trick: 'flickOpen', dur: 0.35 },
  { item: 'lighter', trick: 'strike', dur: 0.6 },
  { item: 'lighter', trick: 'strike', dur: 0.5, setup: { lidOpen: true } },
  { item: 'lighter', trick: 'snapClose', dur: 0.3, setup: { lidOpen: true, lit: true } },
  { item: 'lighter', trick: 'lidFlick', dur: 0.5 },
  { item: 'lighter', trick: 'lidFlick', dur: 0.5, setup: { lidOpen: true, lit: true } },
  { item: 'lighter', trick: 'twirl', dur: 0.72, setup: { lidOpen: true, lit: true } },
  { item: 'lighter', trick: 'twirl', dur: 0.72 },
  { item: 'lighter', trick: 'tossOpen', dur: 0.9 },
  { item: 'lighter', trick: 'finale', dur: 2.0 },
  { item: 'lighter', trick: 'surfFlame', dur: 2.6, surf: 2.0 },
  { item: 'phone', trick: 'scroll', dur: 1.5 },
  { item: 'phone', trick: 'tap', dur: 0.6 },
  { item: 'phone', trick: 'flipCatch', dur: 0.82 },
  { item: 'phone', trick: 'spinToss', dur: 1.0 },
  { item: 'phone', trick: 'buzz', dur: 0.5 },
  { item: 'phone', trick: 'photo', dur: 2.2 },
  { item: 'phone', trick: 'record', dur: 1.6 },
  { item: 'phone', trick: 'gimbal', dur: 2.6, surf: 2.0 },
];

const label = (c: Case): string => `${c.item}/${c.trick}${c.setup ? ' ' + JSON.stringify(c.setup) : ''}`;

function applySetup(p: PropControl, c: Case): void {
  if (p instanceof CanTricks) p.opened = c.setup?.opened ?? false;
  if (p instanceof LighterTricks) {
    p.lidOpen = c.setup?.lidOpen ?? false;
    p.lit = c.setup?.lit ?? false;
  }
}

function make(item: Item): PropControl {
  return item === 'can' ? new CanTricks() : item === 'lighter' ? new LighterTricks() : new PhoneTricks();
}

const STILL: PropFrameInput = { speed: 0, onGround: true, surfing: false };
const SURFING: PropFrameInput = { speed: 800, onGround: false, surfing: true, surfSide: 0.4 };
const AIRBORNE: PropFrameInput = { speed: 800, onGround: false, surfing: false };

/** Alles, was die Hand aus dem Gegenstand übernimmt (Position, Lage, Spin, Hand-Versatz, jointAdd, Deckel/Rad). */
function sample(p: PropControl, item: Item): number[] {
  const o = p.out;
  const s = [o.pos[0], o.pos[1], o.pos[2], o.rot[0], o.rot[1], o.rot[2], o.spin, o.hx, o.hy, o.hz, o.hpitch, o.hyaw, o.hroll, o.canTab];
  for (let i = 0; i < VM_JOINT_COUNT; i++) s.push(o.jointAdd[i]);
  if (item === 'lighter') s.push(o.param[VM_PARAM.lighter.lid], o.param[VM_PARAM.lighter.wheel]);
  return s;
}
/** Winkel-Kanäle (rot, spin, Rad) modulo 2π vergleichen. */
function periodOf(item: Item, k: number): number {
  if ((k >= 3 && k <= 6) || (item === 'lighter' && k === 14 + VM_JOINT_COUNT + 1)) return Math.PI * 2;
  return 0;
}
function diff(a: number, b: number, period: number): number {
  const d = Math.abs(a - b);
  return period > 0 ? Math.min(d % period, period - (d % period)) : d;
}

/** Trick ab Frame 1 (bei 1/6 s), jeder Frame; danach 0.5 s Ruhe (Übergang in die Ruhe gehört dazu). */
function run(c: Case, fps: number): number[][] {
  const p = make(c.item);
  const dt = 1 / fps;
  const start = Math.round(fps / 6);
  const total = Math.round(fps * (Math.ceil((1 / 6 + c.dur + 0.5) * 6) / 6));
  const surfEnd = c.surf ? start + Math.round(fps * c.surf) : -1;
  const out: number[][] = [];
  applySetup(p, c);
  for (let f = 1; f <= total; f++) {
    if (f === start) {
      if (c.surf) p.onEvent({ type: 'surfStart' });
      else p.debugPlayName(c.trick, -1);
    }
    // In der Luft (wie cosmetics.runTrick): am Boden kämen Leerlauf-Tricks/crack dazu, die nicht rückdatiert starten.
    const inp = c.surf ? (f >= start && f < surfEnd ? SURFING : AIRBORNE) : AIRBORNE;
    p.update(dt, inp);
    p.out.kickY = 0;
    p.out.kickSq = 0;
    out.push(sample(p, c.item));
  }
  return out;
}

describe('Dose/Feuerzeug/Handy (Plan 008 Schritt 2)', () => {
  it('jeder Trick läuft wirklich (Zustand stimmt) und bewegt Hand oder Finger', () => {
    for (const c of CASES) {
      const p = make(c.item);
      applySetup(p, c);
      p.update(1 / 60, STILL);
      if (c.surf) {
        p.update(1 / 60, SURFING);
        p.onEvent({ type: 'surfStart' });
      } else expect(p.debugPlayName(c.trick, -1), label(c)).toBe(true);
      let moved = 0;
      for (let f = 0; f < 60 * c.dur; f++) {
        p.update(1 / 60, c.surf ? SURFING : STILL);
        if (f === 0) expect(p.trick, label(c)).toBe(c.trick);
        let s = 0;
        for (let i = 0; i < VM_JOINT_COUNT; i++) s += Math.abs(p.out.jointAdd[i]);
        moved = Math.max(moved, s + Math.abs(p.out.hy) + Math.abs(p.out.hz) * 0.01);
      }
      expect(moved, label(c)).toBeGreaterThan(0.02);
    }
  });

  it('stetig bei 240 Hz: kein Sprung in Lage, Gelenken, Deckel — auch nicht am Übergang in die Ruhe', () => {
    for (const c of CASES) {
      const r = run(c, 240);
      let worstPos = 0;
      let worstRot = 0;
      let worstJoint = 0;
      let worstHand = 0;
      for (let i = 1; i < r.length; i++) {
        const a = r[i - 1];
        const b = r[i];
        worstPos = Math.max(worstPos, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
        const ra = fromEulerXYZ(mat3(), a[3], a[4], a[5]);
        const rb = fromEulerXYZ(mat3(), b[3], b[4], b[5]);
        let tr = 0;
        for (let k = 0; k < 9; k++) tr += ra[k] * rb[k];
        worstRot = Math.max(worstRot, Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))));
        for (let k = 14; k < 14 + VM_JOINT_COUNT; k++) worstJoint = Math.max(worstJoint, Math.abs(a[k] - b[k]));
        for (let k = 7; k < 10; k++) worstHand = Math.max(worstHand, Math.abs(a[k] - b[k]) * (k === 9 ? 0.02 : 1));
      }
      // 240 Hz: 2 Einheiten/Frame = 480 u/s (Würfe ~100), 0.25 rad/Frame (Doppel-Twirl ~0.13), Gelenke 0.2 rad/Frame
      // (48 rad/s — ein Daumen-Schnipp erreicht echt 30–50 rad/s; ein Sprung wären ganze Posen-Differenzen ≥ 0.5).
      expect(worstPos, `${label(c)} Position`).toBeLessThan(2);
      expect(worstRot, `${label(c)} Lage`).toBeLessThan(0.25);
      expect(worstJoint, `${label(c)} Gelenke`).toBeLessThan(0.2);
      expect(worstHand, `${label(c)} Hand`).toBeLessThan(0.02);
    }
  });

  it('framerate-unabhängig: jeder Frame 30/60/144/240 Hz gegen 1440 Hz ≤ 0.01 (inkl. jointAdd)', () => {
    const report: string[] = [];
    for (const c of CASES) {
      const ref = run(c, 1440);
      let worst = 0;
      let where = '';
      for (const fps of [30, 60, 144, 240]) {
        const got = run(c, fps);
        for (let i = 0; i < got.length; i++) {
          const j = ((i + 1) * 1440) / fps - 1;
          for (let k = 0; k < got[i].length; k++) {
            const d = diff(got[i][k], ref[j][k], periodOf(c.item, k));
            if (d > worst) {
              worst = d;
              where = `${fps} Hz Frame ${i} Kanal ${k}`;
            }
          }
        }
      }
      report.push(`${label(c)} ${worst.toFixed(5)}`);
      expect(worst, `${label(c)} (${where})`).toBeLessThanOrEqual(0.01);
    }
    expect(report.length).toBe(CASES.length);
  }, 60000);

  it('keine NaN bei wilden Eingaben (auch jointAdd und Kanäle)', () => {
    for (const item of ['can', 'lighter', 'phone'] as const) {
      const p = make(item);
      let seed = 11;
      const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      for (let k = 0; k < 8000; k++) {
        const r = rnd();
        if (r < 0.04) p.onEvent({ type: 'jump', speed: rnd() * 3000, gain: 5, perfect: rnd() < 0.5, clean: rnd() < 0.5, chain: 3, sync: 0.9, crouched: false, coyote: false });
        else if (r < 0.05) p.onEvent({ type: 'finish', time: 9, best: rnd() < 0.5, previousBest: null });
        else if (r < 0.06) p.onEvent({ type: 'speedMilestone', speed: 1000 });
        else if (r < 0.065) p.onEvent({ type: rnd() < 0.5 ? 'surfStart' : 'surfEnd' });
        else if (r < 0.067) p.onEvent({ type: 'respawn', reason: 'fall' });
        if (rnd() < 0.002) p.debugPlayName(p.trickNames[Math.floor(rnd() * p.trickNames.length)], -1);
        const inp: PropFrameInput = { speed: rnd() < 0.01 ? Number.NaN : rnd() * 1500, onGround: rnd() < 0.5, surfing: rnd() < 0.3, surfSide: rnd() * 2 - 1, handX: rnd() < 0.01 ? Number.NaN : rnd() * 0.2 - 0.1, handY: rnd() * 0.2 - 0.1, handTilt: rnd() * 30 - 15 };
        p.update(rnd() < 0.01 ? Number.NaN : rnd() * 0.12, inp);
        const o = p.out;
        let ok = Number.isFinite(o.hx + o.hy + o.hz + o.hpitch + o.hyaw + o.hroll + o.spin + o.pos[0] + o.pos[1] + o.pos[2] + o.rot[0] + o.rot[1] + o.rot[2]);
        for (let i = 0; i < VM_JOINT_COUNT; i++) ok = ok && Number.isFinite(o.jointAdd[i]);
        for (let i = 0; i < 4; i++) ok = ok && Number.isFinite(o.param[i]);
        if (!ok) expect.fail(`${item} Schritt ${k}: nicht endlich (${p.trick})`);
      }
    }
  });

  it('keine Durchdringung: Gegenstand ↔ Hand-Modell in jedem 1/60-s-Frame jedes Tricks > −0.35', () => {
    // Die Lasche der Dose zählt nicht: der Zeigefinger hakt sichtbar unter ihr Ende (gewollt).
    const noTab = (m: Mesh): boolean => !(m.geometry instanceof BoxGeometry);
    const report: string[] = [];
    for (const c of CASES) {
      const h = new ViewHand();
      h.setAspect(16 / 9);
      h.setItem(c.item as HeldItemId);
      const p = h.activeProp;
      if (!p) throw new Error('kein Gegenstand');
      const inp = makeHandInput();
      for (let i = 0; i < 60; i++) {
        p.stop();
        applySetup(p, c);
        h.update(1 / 60, inp);
      }
      if (c.surf) {
        inp.surfing = true;
        inp.onGround = false;
        inp.speed = 800;
        inp.surfSide = 0.4;
        h.onEvent({ type: 'surfStart' });
      } else h.forceTrick(c.trick, -1);
      let worst = 0;
      let at = '';
      const n = Math.round(c.dur * 240);
      for (let i = 1; i <= n; i++) {
        if (c.surf && i / 240 > c.surf) inp.surfing = false;
        h.update(1 / 240, inp);
        if (i % 4 !== 0) continue;
        const f = h.output(true);
        const r = measure(f, itemPoints(f, c.item === 'can' ? noTab : undefined));
        if (r.penetration > worst) {
          worst = r.penetration;
          let part = 0;
          r.perPart.forEach((d, k) => {
            if (d < r.perPart[part]) part = k;
          });
          at = `${(i / 240).toFixed(3)} s ${HAND_PART_NAMES[part]}`;
        }
      }
      report.push(`${label(c)} ${worst.toFixed(2)} ${at}`);
      expect(worst, `${label(c)} bei ${at}`).toBeLessThan(0.35);
    }
    expect(report.length).toBe(CASES.length);
  }, 240000);

  it('allokationsfrei: je Trick höchstens 1 Scavenge in 12 000 Frames (Node, --trace-gc, 1-MB-Semispace)', async () => {
    // 1-MB-Semispace: 1 Scavenge ≈ 1 MB ≈ 85 B/Frame über 12 000 Frames. Je Trick ein eigener Prozess mit EINER
    // Schleifen-Funktion für Aufwärmen und Messen (gemischt schwankte die JIT-Stufe, fallen.md #186).
    // Marken = erzwungene Mark-Compacts (`gc()`, "testing") IM SELBEN Strom wie --trace-gc: V8 schreibt die Trace-Zeilen
    // über einen eigenen stdio-Puffer (4 KiB ≈ 24 Zeilen), console.log-Marken landeten davor/dahinter je nach
    // Puffer-Leerung — die Probe zählte 0 oder ~24 statt der echten Zahl (fallen.md).
    const script = [
      "const mod = await import('./src/ui/hand/' + process.env.PROP_FILE);",
      'const p = new mod[process.env.PROP_CLASS]();',
      'const name = process.env.PROP_TRICK;',
      'const inp = { speed: 0.5, onGround: false, surfing: false, surfSide: 0.5, handX: 0.01, handY: 0.02, handTilt: 3.5 };',
      'const joints = new Float32Array(23);',
      'const DT = 1 / 144;',
      "function step(n) { for (let f = 0; f < n; f++) { if (p.trick === 'none') p.debugPlayName(name, -1); p.update(DT, inp); p.afterPose(joints, inp, DT); p.out.kickY = 0; p.out.kickSq = 0; } }",
      // Viele kurze Aufrufe: step wird als Funktion optimiert (nicht nur per OSR in einem langen Aufruf — der zweite Aufruf
      // lief sonst bis zur Neu-Optimierung im Baseline-Code und die Probe zählte dessen Boxing).
      'for (let k = 0; k < 600; k++) step(100);',
      'gc();',
      'for (let k = 0; k < 120; k++) step(100);',
      'gc();',
    ].join('\n');
    const specs: [string, string, string][] = [];
    for (const [file, cls, p] of [
      ['canTricks.ts', 'CanTricks', new CanTricks()],
      ['lighterTricks.ts', 'LighterTricks', new LighterTricks()],
      ['phoneTricks.ts', 'PhoneTricks', new PhoneTricks()],
    ] as const) {
      for (const trick of p.trickNames) if (trick !== 'gimbal' && trick !== 'surfFlame' && trick !== 'surfBalance') specs.push([file, cls, trick]);
    }
    const probe = (file: string, cls: string, trick: string): Promise<[string, number]> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--expose-gc', '--trace-gc', '--max-semi-space-size=1', '--no-concurrent-recompilation', '--no-concurrent-osr', '--single-threaded-gc', '--input-type=module', '-e', script], {
          cwd: process.cwd(),
          env: { ...process.env, PROP_FILE: file, PROP_CLASS: cls, PROP_TRICK: trick },
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', () => {
          const lines = out.split('\n');
          const marks = lines.flatMap((l, i) => (/Mark-Compact.*testing/.test(l) ? [i] : []));
          resolve([`${cls}/${trick}`, marks.length !== 2 ? -1 : lines.slice(marks[0], marks[1]).filter((l) => l.includes('Scavenge')).length]);
        });
      });
    // Höchstens 3 gleichzeitig und synchron kompiliert (--no-concurrent-recompilation/-osr): Hintergrund-Kompilierung
    // unter Last verschiebt die JIT-Stufe im Messfenster.
    const res: [string, number][] = [];
    for (let i = 0; i < specs.length; i += 3) res.push(...(await Promise.all(specs.slice(i, i + 3).map(([f, c, t]) => probe(f, c, t)))));
    expect(res.length).toBeGreaterThan(18);
    const bad = res.filter(([, n]) => n < 0 || n > 1);
    expect(bad, JSON.stringify(res)).toEqual([]);
  }, 240000);
});
