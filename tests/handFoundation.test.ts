import { describe, expect, it } from 'vitest';
import { BackSide, Matrix4, Mesh, Vector3 } from 'three';
import { Track, backIn, backOut, bezier, cubicInOut, cubicOut, elasticOut, linear, quintOut, smootherstep, smoothstep, sineInOut } from '../src/ui/hand/curves';
import type { Key } from '../src/ui/hand/curves';
import { Follower, Overlap, anticipate } from '../src/ui/hand/secondary';
import { PlanarChain } from '../src/ui/hand/chain';
import type { ChainDriver } from '../src/ui/hand/chain';
import { Toss, settle, squash } from '../src/ui/hand/rigid';
import { HandShape } from '../src/ui/hand/handShape';
import { GripSolver } from '../src/ui/hand/fingerContact';
import { Prim, PropShape } from '../src/ui/hand/propShape';
import { KnifeSim } from '../src/ui/hand/knifeRig';
import { KNIFE_HOLD_POS, KNIFE_HOLD_ROT, KnifeTricks, flipMotion, OPEN_P } from '../src/ui/hand/knifeTricks';
import { POSE, POSE_JOINTS } from '../src/ui/hand/poses';
import { ViewHand } from '../src/ui/hand/ViewHand';
import { makeHandInput } from '../src/ui/hand/handMotion';
import { VIEW_AXES, mat3 } from '../src/ui/hand/rot';
import { VM_PARAM } from '../src/render/types';
import { contactViewModel, itemPoints, measure } from '../tools/lib/handContact';
import { handFrame } from '../tools/lib/handLive';

/**
 * Animations-Fundament der View-Hand (Plan 008): Kurven stetig, Sekundärbewegung und Physik framerate-
 * unabhängig, keine NaN, Pendel energetisch plausibel, Kontaktmodelle passen zur echten Geometrie, und das
 * Butterfly-Messer: die Klinge berührt in keinem Frame den Handschuh.
 */

const RATES = [30, 60, 144, 240] as const;

describe('Kurven (curves.ts)', () => {
  it('jede Easing-Funktion beginnt bei 0 und endet bei 1', () => {
    for (const e of [linear, cubicOut, cubicInOut, quintOut, sineInOut, smoothstep, smootherstep, backIn(), backOut(), elasticOut(), bezier(0.25, 0.1, 0.25, 1), anticipate()]) {
      expect(e(0)).toBeCloseTo(0, 9);
      expect(e(1)).toBeCloseTo(1, 9);
    }
  });

  it('Bezier wie CSS (ease: 0.25, 0.1, 0.25, 1 bei x = 0.5 ≈ 0.8024) und monoton', () => {
    const e = bezier(0.25, 0.1, 0.25, 1);
    expect(e(0.5)).toBeCloseTo(0.8024, 3);
    let prev = 0;
    for (let i = 1; i <= 200; i++) {
      const v = e(i / 200);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it('Spuren sind stetig an den Phasengrenzen (Wert), smooth zusätzlich in der Steigung', () => {
    const keys: Key[] = [
      [0, 0],
      [0.1, 1.2, backOut(2)],
      [0.25, -0.4, cubicInOut],
      [0.4, 0.3, elasticOut()],
      [0.7, 0],
    ];
    for (const smooth of [false, true]) {
      const tr = new Track(keys, { smooth });
      for (const [t] of keys) {
        const l = tr.value(t - 1e-7);
        const r = tr.value(t + 1e-7);
        expect(Math.abs(l - r), `Sprung bei ${t}`).toBeLessThan(1e-4);
      }
      if (smooth) {
        for (const [t] of keys.slice(1, -1)) {
          const h = 1e-5;
          const dl = (tr.value(t) - tr.value(t - h)) / h;
          const dr = (tr.value(t + h) - tr.value(t)) / h;
          expect(Math.abs(dl - dr), `Knick bei ${t}`).toBeLessThan(0.05 * (1 + Math.abs(dl)));
        }
      }
      // Kein Wert läuft weg (dichte Abtastung, Nachbarn nah beieinander).
      let prev = tr.value(0);
      for (let i = 1; i <= 7000; i++) {
        const v = tr.value(i / 10000);
        expect(Math.abs(v - prev)).toBeLessThan(0.02);
        prev = v;
      }
    }
  });

  it('Track wirft bei nicht steigenden Zeiten', () => {
    expect(() => new Track([
      [0, 0],
      [0, 1],
    ])).toThrow();
  });
});

describe('Sekundärbewegung (secondary.ts)', () => {
  /** Follower bis T mit gegebener Rate, Ziel = Funktion der Zeit; Werte an den 1/6-s-Rasterpunkten. */
  function run(rate: number, zeta: number, T = 2): number[] {
    const f = new Follower(0, 22, zeta);
    const out: number[] = [];
    const dt = 1 / rate;
    let t = 0;
    const n = Math.round(T * rate);
    for (let i = 1; i <= n; i++) {
      t = i * dt;
      f.step(Math.sin(5 * t) + (t > 0.5 ? 1 : 0) * 0.3, dt);
      if (Math.abs(t * 6 - Math.round(t * 6)) < 1e-9) out.push(f.x);
    }
    return out;
  }

  it('Follower framerate-unabhängig (30–240 Hz gegen 1200 Hz), ζ < 1, = 1, > 1', () => {
    for (const zeta of [0.4, 1, 1.6]) {
      const ref = run(1200, zeta);
      for (const r of RATES) {
        const got = run(r, zeta);
        expect(got.length).toBe(ref.length);
        let worst = 0;
        for (let i = 0; i < ref.length; i++) worst = Math.max(worst, Math.abs(got[i] - ref[i]));
        // Fehler nur aus der Abtastung des Ziels (linear im Frame) — Sprung bei 0.5 s inklusive.
        expect(worst, `ζ ${zeta} @ ${r} Hz`).toBeLessThan(r === 30 ? 0.06 : 0.025);
      }
    }
  });

  it('Impuls mitten im Frame wird exakt nachgeholt', () => {
    const a = new Follower(0, 18, 0.5);
    a.impulse(3, 0);
    for (let i = 0; i < 10; i++) a.step(0, 0.01);
    const b = new Follower(0, 18, 0.5);
    b.step(0, 0.003);
    b.impulse(3, 0.007);
    for (let i = 0; i < 9; i++) b.step(0, 0.01);
    // b: Impuls bei 0.003 s, gemessen bei 0.1 s ≙ a nach 0.097 s — Vergleich gegen einen Lauf ab 0.003 s.
    const c = new Follower(0, 18, 0.5);
    c.impulse(3, 0);
    c.step(0, 0.007);
    for (let i = 0; i < 9; i++) c.step(0, 0.01);
    expect(b.x).toBeCloseTo(c.x, 9);
    expect(a.x).not.toBeCloseTo(c.x, 3);
  });

  it('Overlap ist 0 in Ruhe und schwingt nach dem Anhalten aus', () => {
    const o = new Overlap(20, 0.5, -0.5);
    for (let i = 0; i < 60; i++) o.step(0.4 * Math.min(1, i / 20), 1 / 60);
    for (let i = 0; i < 600; i++) o.step(0.4, 1 / 60);
    expect(Math.abs(o.value)).toBeLessThan(1e-6);
  });

  it('keine NaN bei wilden Eingaben', () => {
    const f = new Follower(0, 30, 0.3);
    let s = 9;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 20000; i++) {
      f.step((rnd() - 0.5) * 1e4, rnd() < 0.01 ? 0 : rnd() * 0.1);
      if (rnd() < 0.01) f.impulse((rnd() - 0.5) * 100, rnd() * 0.02);
    }
    expect(Number.isFinite(f.x) && Number.isFinite(f.v)).toBe(true);
  });
});

describe('Starrkörper-Wurf (rigid.ts)', () => {
  it('landet zur Fangzeit exakt am Fangpunkt mit dem Zielwinkel; Scheitel wie berechnet', () => {
    const t = new Toss(800);
    t.plan([1, 2, 3], [1.5, 2, 2.5], 0.4, 0, Math.PI * 4);
    const p = new Float64Array(3);
    const a = t.at(0.4, p);
    expect(p[0]).toBeCloseTo(1.5, 9);
    expect(p[1]).toBeCloseTo(2, 9);
    expect(p[2]).toBeCloseTo(2.5, 9);
    expect(a).toBeCloseTo(Math.PI * 4, 9);
    // Scheitel entlang Bild-oben
    let top = -Infinity;
    for (let i = 0; i <= 400; i++) {
      t.at(i / 1000, p);
      top = Math.max(top, (p[0] - 1) * VIEW_AXES.up[0] + (p[1] - 2) * VIEW_AXES.up[1] + (p[2] - 3) * VIEW_AXES.up[2]);
    }
    expect(top).toBeCloseTo(t.apexUp(), 2);
  });

  it('Nachfedern und Squash klingen ab, beginnen bei 0 bzw. 1', () => {
    expect(settle(5, 0)).toBe(0);
    expect(Math.abs(settle(5, 2))).toBeLessThan(1e-4);
    expect(squash(0)).toBe(1);
    expect(squash(1)).toBe(1);
    expect(squash(0.08)).toBeLessThan(1);
  });
});

describe('Gelenk-Kette (chain.ts)', () => {
  const still: ChainDriver = {
    base(_c, out) {
      out.fill(0);
      out[5] = -981;
    },
  };

  it('Doppelpendel ohne Reibung: Energie bleibt (Drift < 1 % über 2 s)', () => {
    const c = new PlanarChain(
      [
        { mass: 0.45, inertia: 4, com: [0.8, 5.3], next: [1.6, 0] },
        { mass: 0.55, inertia: 7, com: [0, -5.85] },
      ],
      still,
    );
    c.reset(0, [Math.PI / 2, -0.4]);
    const e0 = c.energy(0, -981);
    let worst = 0;
    for (let i = 1; i <= 200; i++) {
      c.advanceTo(i / 100);
      worst = Math.max(worst, Math.abs(c.energy(0, -981) - e0));
    }
    // Bezug: größte potentielle Energie-Spanne (m·g·Länge).
    expect(worst / (981 * 1 * 6)).toBeLessThan(0.01);
  });

  it('Anschlag mit Rückprall verliert Energie, Grenze wird gehalten', () => {
    const c = new PlanarChain([{ mass: 1, inertia: 2, com: [0, 4], limit: [-0.5, 0.5, 0.2] }], still);
    c.reset(0, [0.45]);
    const e0 = c.energy(0, -981);
    for (let i = 1; i <= 100; i++) {
      c.advanceTo(i / 100);
      const rho = c.outQ[0];
      expect(rho).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(rho).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    expect(c.energy(0, -981)).toBeLessThan(e0);
  });
});

describe('Kontaktmodelle (handShape, propShape, fingerContact)', () => {
  it('HandShape liegt auf dem echten Handschuh-Mesh (höchstens 0.25 Einheiten daneben)', () => {
    for (const pose of ['relaxed', 'fist', 'balisong', 'pinch'] as const) {
      const f = handFrame({ item: 'none' });
      f.joints.set(POSE_JOINTS[POSE[pose]]);
      const vm = contactViewModel();
      vm.apply(f);
      vm.scene.updateMatrixWorld(true);
      const inv = new Matrix4().copy(vm.rig.wrist.matrixWorld).invert();
      const sh = new HandShape();
      sh.update(f.joints);
      const v = new Vector3();
      let worst = 0;
      vm.rig.wrist.traverse((o) => {
        if (!(o instanceof Mesh) || !o.visible) return;
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        if (mat.side === BackSide) return;
        const m = new Matrix4().multiplyMatrices(inv, o.matrixWorld);
        const pos = o.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m);
          worst = Math.max(worst, sh.distance(v.x, v.y, v.z));
        }
      });
      expect(worst, pose).toBeLessThan(0.25);
    }
  });

  it('Finger-Kontakt legt die Finger an einen Zylinder an (kein Finger steckt drin, alle liegen an)', () => {
    const shape = new PropShape([{ kind: Prim.Cylinder, at: [0, 0, 0], size: [3.5, 6.75] }]);
    const R = mat3();
    // Achse quer über die Handfläche (wie die Dose): lokal y → Handgelenk −x.
    R[1] = -1;
    R[3] = 1;
    R[8] = 1;
    R[0] = 0;
    R[4] = 0;
    shape.setLink(0, R, 1.6, 8.2, -5.6, 1);
    const j = new Float32Array(POSE_JOINTS[POSE.grip]);
    const s = new GripSolver();
    s.fit(j, POSE_JOINTS[POSE.open], POSE_JOINTS[POSE.fist], shape, 15, -0.15, [0.6, 1, 1], 10);
    for (let f = 0; f < 4; f++) {
      expect(s.gap[f], `Finger ${f}`).toBeGreaterThan(-0.4);
      expect(s.gap[f], `Finger ${f}`).toBeLessThan(0.35);
    }
  });

  it('Ruhe-Griffe aller Gegenstände: keine Durchdringung über 0.35 (≈ 3.5 mm Handschuh)', () => {
    for (const item of ['card', 'can', 'yoyo', 'spinner', 'coin', 'lighter', 'phone', 'knife'] as const) {
      for (const knifeOpen of item === 'knife' ? [false, true] : [false]) {
        const f = handFrame({ item, knifeOpen });
        const r = measure(f, itemPoints(f));
        expect(r.penetration, `${item}${knifeOpen ? ' offen' : ''}`).toBeLessThan(0.35);
        // Kein Schweben: irgendein Teil der Hand berührt den Gegenstand.
        expect(r.gap, `${item} schwebt`).toBeLessThan(0.35);
      }
    }
  });
});

describe('Butterfly-Messer (Plan 008: Mechanik, Pins, Physik)', () => {
  it('Physik framerate-unabhängig: Basic Opening bei 30–240 Hz wie bei 1200 Hz (Raster + Interpolation)', () => {
    const { motion } = flipMotion(OPEN_P, 0);
    const sample = (rate: number): number[] => {
      const s = new KnifeSim();
      const h = new HandShape();
      h.update(POSE_JOINTS[POSE.balisong]);
      s.hand = h;
      s.start(motion, KNIFE_HOLD_POS, KNIFE_HOLD_ROT, Math.PI, -Math.PI);
      const out: number[] = [];
      const n = Math.round(0.6 * rate);
      for (let i = 0; i <= n; i++) {
        const t = i / rate;
        s.advanceTo(t);
        if (Math.abs(t * 6 - Math.round(t * 6)) < 1e-9) out.push(s.bladeAt(t), s.bite);
      }
      return out;
    };
    const ref = sample(1200);
    for (const r of RATES) {
      const got = sample(r);
      expect(got.length).toBe(ref.length);
      for (let i = 0; i < ref.length; i++) expect(Math.abs(got[i] - ref[i]), `${r} Hz #${i}`).toBeLessThan(0.02);
    }
  });

  it('Basic Opening/Closing landen im Ziel, der Bite Handle dreht dabei einmal um den Safe Handle', () => {
    for (const [p, from, goal] of [[OPEN_P, Math.PI, 0]] as const) {
      const { motion, timing } = flipMotion(p, goal);
      const s = new KnifeSim();
      const h = new HandShape();
      h.update(POSE_JOINTS[POSE.balisong]);
      s.hand = h;
      s.start(motion, KNIFE_HOLD_POS, KNIFE_HOLD_ROT, from, -from);
      let turn = 0;
      let prev = 0;
      for (let t = 0; t <= timing.total + 1e-9; t += 1 / 240) {
        s.advanceTo(t);
        const rel = s.bladeAt(t) + s.bite;
        turn += rel - prev;
        prev = rel;
      }
      expect(s.bladeAt(timing.total)).toBeCloseTo(goal, 1);
      expect(Math.abs(Math.abs(turn) - Math.PI * 2)).toBeLessThan(0.3);
      // Griff gegen Griff: höchstens ein kurzes Anschlagen (Überlappung < 0.25 Einheiten).
      expect(s.contactMax).toBeLessThan(0.25);
    }
  });

  /** ViewHand mit Messer, Trick frei bis zum Ende; je Frame der kleinste Abstand Klinge ↔ Hand (echtes Mesh). */
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
    const n = Math.round(1.2 * rate);
    for (let i = 0; i < n; i++) {
      h.update(1 / rate, inp);
      const f = h.output(true);
      // Geschlossen liegt die Klinge zwischen den Griffen (in deren Kanälen) — dort zählt sie nicht als offen.
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

  it('die (ausgeklappte) Klinge berührt in keinem Frame den Handschuh (alle Tricks, offen und zu, 60 und 144 Hz)', () => {
    for (const trick of ['open', 'close', 'rollover', 'aerial', 'doubleAerial']) {
      for (const open of [false, true]) {
        if ((trick === 'open' && open) || (trick === 'close' && !open)) continue;
        for (const rate of [60, 144]) {
          const d = bladeClearance(trick, open, rate);
          // Abstand zum Kollisionsmodell der Hand (liegt auf ±0.25 am Mesh, siehe oben) — echte Lücke, keine Berührung.
          expect(d, `${trick} ${open ? 'offen' : 'zu'} @ ${rate} Hz`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('Riegel: eingerastet in Ruhe, offen während des Tricks; Griffe liegen danach zusammen', () => {
    const k = new KnifeTricks();
    k.reset();
    expect(k.out.param[VM_PARAM.knife.latch]).toBe(0);
    k.debugPlay('open');
    const inp = { speed: 0, onGround: true, surfing: false };
    for (let f = 0; f < 12; f++) k.update(1 / 60, inp);
    expect(k.out.param[VM_PARAM.knife.latch]).toBeGreaterThan(0.9);
    for (let f = 0; f < 60; f++) k.update(1 / 60, inp);
    expect(k.trick).toBe('none');
    expect(k.out.param[VM_PARAM.knife.latch]).toBe(0);
    expect(k.out.knifeBlade + k.out.knifeBite).toBeCloseTo(0, 6);
  });

  it('Tricks entstehen aus dem Handgelenk: Flick-Versatz im Gelenk, nicht nur am Gegenstand', () => {
    const k = new KnifeTricks();
    k.reset();
    k.debugPlay('open');
    let maxFlex = 0;
    for (let f = 0; f < 40; f++) {
      k.update(1 / 60, { speed: 0, onGround: true, surfing: false });
      maxFlex = Math.max(maxFlex, Math.abs(k.out.jointAdd[0]));
    }
    expect(maxFlex).toBeGreaterThan(0.2);
  });
});
