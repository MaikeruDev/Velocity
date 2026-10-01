import { beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import { VM_JOINT_COUNT, VM_PARAM } from '../src/render/types';
import { YoyoTricks } from '../src/ui/hand/yoyoTricks';
import { KEN_BIG_CUP, KEN_SMALL_CUP, KEN_SPIKE, KENDAMA_TIER_TRICKS, KendamaTricks } from '../src/ui/hand/kendamaTricks';
import { SPINNER_OMEGA_BASE, SPINNER_OMEGA_PER_SPEED, SpinnerTricks } from '../src/ui/hand/spinnerTricks';
import { POSE, POSE_JOINTS } from '../src/ui/hand/poses';
import type { PropControl, PropFrameInput } from '../src/ui/hand/propTricks';
import { ViewHand } from '../src/ui/hand/ViewHand';
import { makeHandInput } from '../src/ui/hand/handMotion';
import { fromEulerXYZ, mat3 } from '../src/ui/hand/rot';
import { itemPoints, measure } from '../tools/lib/handContact';
import { HAND_PART_NAMES, HandShape } from '../src/ui/hand/handShape';
import type { HeldItemId } from '../src/engine/settingsTypes';

/**
 * Plan 008 Schritt 2 — Jo-Jo, Kendama, Spinner: Würfe aus dem Handgelenk, echte Ballistik, Finger-Schutz (Gegenstand,
 * zweiter Körper und Schnur nicht durch die Hand). Geprüft: Stetigkeit (auch beim Übergang in die Ruhe), Framerate-
 * Unabhängigkeit 30–240 Hz gegen 1440 Hz inkl. jointAdd und zweitem Körper, keine NaN, keine Durchdringung gegen das
 * Hand-Modell (Gegenstand + Kugel/Jo-Jo > −0.35 wie die Ruhe-Griffe; Schnur-Sehnen ab der Schlaufe), allokationsfrei,
 * dazu Mechanik (Fang exakt, Drehzahl folgt dem Tempo, Abwechslung).
 */

type Item = 'yoyo' | 'kendama' | 'spinner';
interface Case {
  readonly item: Item;
  readonly trick: string;
  readonly dur: number;
  /** Surf-Zustand: so lange surfen (s), dann endet er. */
  readonly surf?: number;
}

const CASES: readonly Case[] = [
  { item: 'yoyo', trick: 'sleeper', dur: 1.3 },
  { item: 'yoyo', trick: 'snap', dur: 0.65 },
  { item: 'yoyo', trick: 'pass', dur: 0.75 },
  { item: 'yoyo', trick: 'breakaway', dur: 0.95 },
  { item: 'yoyo', trick: 'around', dur: 1.0 },
  { item: 'yoyo', trick: 'aroundDouble', dur: 1.5 },
  { item: 'yoyo', trick: 'cradle', dur: 2.15 },
  { item: 'yoyo', trick: 'walkDog', dur: 1.2 },
  { item: 'yoyo', trick: 'surfSleeper', dur: 2.6, surf: 2.0 },
  { item: 'kendama', trick: 'bigCup', dur: 1.3 },
  { item: 'kendama', trick: 'smallCup', dur: 1.3 },
  { item: 'kendama', trick: 'spike', dur: 1.55 },
  { item: 'kendama', trick: 'aroundJapan', dur: 2.2 },
  { item: 'kendama', trick: 'airplane', dur: 2.05 },
  { item: 'kendama', trick: 'cupRide', dur: 2.8, surf: 2.0 },
  { item: 'spinner', trick: 'flick', dur: 0.45 },
  { item: 'spinner', trick: 'swap', dur: 1.2 },
  { item: 'spinner', trick: 'toss', dur: 0.65 },
  { item: 'spinner', trick: 'ufo', dur: 1.3 },
  { item: 'spinner', trick: 'balance', dur: 2.6, surf: 2.0 },
];

const label = (c: Case): string => `${c.item}/${c.trick}`;

function make(item: Item): PropControl {
  return item === 'yoyo' ? new YoyoTricks() : item === 'kendama' ? new KendamaTricks() : new SpinnerTricks();
}
/** Ruhe-Pose je Gegenstand: afterPose bekommt sie fest (wie Proben ohne ViewHand). */
const REST_JOINTS: { readonly [K in Item]: Float32Array } = { yoyo: POSE_JOINTS[POSE.yoyo], kendama: POSE_JOINTS[POSE.ken], spinner: POSE_JOINTS[POSE.spin] };

const STILL: PropFrameInput = { speed: 0, onGround: true, surfing: false };
const SURFING: PropFrameInput = { speed: 800, onGround: false, surfing: true, surfSide: 0.4 };
const AIRBORNE: PropFrameInput = { speed: 800, onGround: false, surfing: false };

/** Kanäle: Lage (pos/rot/spin), Hand-Versatz, zweiter Körper, jointAdd. Spinner-Winkel/Unschärfe sind absichtlich je Frame (#111). */
const K_SUB = 13;
const K_JOINT = 16;
function sample(p: PropControl): number[] {
  const o = p.out;
  const s = [o.pos[0], o.pos[1], o.pos[2], o.rot[0], o.rot[1], o.rot[2], o.spin, o.hx, o.hy, o.hz, o.hpitch, o.hyaw, o.hroll, o.sub[0], o.sub[1], o.sub[2]];
  for (let i = 0; i < VM_JOINT_COUNT; i++) s.push(o.jointAdd[i]);
  return s;
}
const periodOf = (k: number): number => (k >= 3 && k <= 6 ? Math.PI * 2 : 0);
function diff(a: number, b: number, period: number): number {
  const d = Math.abs(a - b);
  return period > 0 ? Math.min(d % period, period - (d % period)) : d;
}

/** Trick ab Frame 1/6 s, jeder Frame mit afterPose (Schnur, zweiter Körper, Finger-Schutz); danach 0.5 s Ruhe. */
function run(c: Case, fps: number): number[][] {
  const p = make(c.item);
  const j = REST_JOINTS[c.item];
  const dt = 1 / fps;
  const start = Math.round(fps / 6);
  const total = Math.round(fps * (Math.ceil((1 / 6 + c.dur + 0.5) * 6) / 6));
  const surfEnd = c.surf ? start + Math.round(fps * c.surf) : -1;
  const out: number[][] = [];
  for (let f = 1; f <= total; f++) {
    if (f === start) {
      if (c.surf) p.onEvent({ type: 'surfStart' });
      else p.debugPlayName(c.trick, -1);
    }
    const inp = c.surf ? (f >= start && f < surfEnd ? SURFING : AIRBORNE) : AIRBORNE;
    p.update(dt, inp);
    p.afterPose(j, inp, dt);
    p.out.kickY = 0;
    p.out.kickSq = 0;
    out.push(sample(p));
  }
  return out;
}

describe('Jo-Jo/Kendama/Spinner (Plan 008 Schritt 2)', () => {
  beforeAll(() => {
    // Diese Datei ist rechenlastig (Mesh-Abtastung, 1440-Hz-Läufe, Kind-Prozesse der Allokationsprobe): mit niedriger
    // Priorität (vererbt an die Kind-Prozesse) behalten parallel laufende Dateien ihre Zeitlimits (viewHand.test: 3.7 s
    // allein, 5-s-Grenze). Nur wo das Betriebssystem es erlaubt.
    try {
      setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // ohne Recht zum Ändern der Priorität: Tests laufen trotzdem
    }
  });

  it('jeder Trick läuft wirklich und bewegt Hand oder Finger', () => {
    for (const c of CASES) {
      const p = make(c.item);
      p.update(1 / 60, STILL);
      if (c.surf) {
        p.update(1 / 60, SURFING);
        p.onEvent({ type: 'surfStart' });
      } else expect(p.debugPlayName(c.trick, -1), label(c)).toBe(true);
      let moved = 0;
      for (let f = 0; f < 60 * Math.min(c.dur, 1.2); f++) {
        p.update(1 / 60, c.surf ? SURFING : STILL);
        p.afterPose(REST_JOINTS[c.item], STILL, 1 / 60);
        if (f === 0) expect(p.trick, label(c)).toBe(c.trick);
        let s = 0;
        for (let i = 0; i < VM_JOINT_COUNT; i++) s += Math.abs(p.out.jointAdd[i]);
        moved = Math.max(moved, s + Math.abs(p.out.hy) + Math.abs(p.out.hx) + Math.abs(p.out.hroll));
      }
      expect(moved, label(c)).toBeGreaterThan(0.02);
    }
  });

  it('stetig bei 240 Hz: Lage, Gelenke, Hand, zweiter Körper — auch am Übergang in die Ruhe', () => {
    for (const c of CASES) {
      const r = run(c, 240);
      let worstPos = 0;
      let worstRot = 0;
      let worstJoint = 0;
      let worstHand = 0;
      let worstTurn = 0;
      let worstSub = 0;
      for (let i = 1; i < r.length; i++) {
        const a = r[i - 1];
        const b = r[i];
        worstPos = Math.max(worstPos, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
        const ra = fromEulerXYZ(mat3(), a[3], a[4], a[5]);
        const rb = fromEulerXYZ(mat3(), b[3], b[4], b[5]);
        let tr = 0;
        for (let k = 0; k < 9; k++) tr += ra[k] * rb[k];
        worstRot = Math.max(worstRot, Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))));
        for (let k = K_JOINT; k < K_JOINT + VM_JOINT_COUNT; k++) worstJoint = Math.max(worstJoint, Math.abs(a[k] - b[k]));
        for (let k = 7; k < 10; k++) worstHand = Math.max(worstHand, Math.abs(a[k] - b[k]) * (k === 9 ? 0.02 : 1));
        for (let k = 10; k < 13; k++) worstTurn = Math.max(worstTurn, Math.abs(a[k] - b[k]));
        worstSub = Math.max(worstSub, Math.hypot(a[K_SUB] - b[K_SUB], a[K_SUB + 1] - b[K_SUB + 1], a[K_SUB + 2] - b[K_SUB + 2]));
      }
      // 240 Hz: 2 Einheiten/Frame = 480 u/s (Würfe ~100–250), 0.25 rad/Frame, Gelenke 0.2 rad/Frame (Schnipp 30–50 rad/s),
      // zweiter Körper 1.6/Frame (Kugel-Würfe bis ~300 u/s), Unterarm-Drehung 0.06 rad/Frame (Around Japan kippt zwischen
      // den Bechern mit ~7 rad/s); ein Sprung wären ganze Posen-/Bahn-Differenzen.
      expect(worstPos, `${label(c)} Position`).toBeLessThan(2);
      expect(worstRot, `${label(c)} Lage`).toBeLessThan(0.25);
      expect(worstJoint, `${label(c)} Gelenke`).toBeLessThan(0.2);
      expect(worstHand, `${label(c)} Hand`).toBeLessThan(0.02);
      expect(worstTurn, `${label(c)} Hand-Drehung`).toBeLessThan(0.06);
      expect(worstSub, `${label(c)} zweiter Körper`).toBeLessThan(1.6);
    }
  });

  it('framerate-unabhängig: 30/60/144/240 Hz gegen 1440 Hz — Lage/Hand/jointAdd ≤ 0.01, zweiter Körper ≤ 0.25 (freies Pendel)', () => {
    const report: string[] = [];
    for (const c of CASES) {
      const ref = run(c, 1440);
      let worst = 0;
      let worstSub = 0;
      let where = '';
      for (const fps of [30, 60, 144, 240]) {
        const got = run(c, fps);
        for (let i = 0; i < got.length; i++) {
          const j = ((i + 1) * 1440) / fps - 1;
          for (let k = 0; k < got[i].length; k++) {
            const d = diff(got[i][k], ref[j][k], periodOf(k));
            if (k >= K_SUB && k < K_SUB + 3) worstSub = Math.max(worstSub, d);
            else if (d > worst) {
              worst = d;
              where = `${fps} Hz Frame ${i} Kanal ${k}`;
            }
          }
        }
      }
      report.push(`${label(c)} ${worst.toFixed(5)} / ${worstSub.toFixed(3)}`);
      expect(worst, `${label(c)} (${where})`).toBeLessThanOrEqual(0.01);
      // Geführt exakt (cosmetics.test, ≤ 0.01); das freie Pendel integriert auf festem Raster, nur der Frame-Anker
      // ist linear interpoliert — gemessen ≤ 0.19 Einheiten (unter 1 Low-Res-Pixel; cosmetics.test prüft das Pendel in px).
      expect(worstSub, `${label(c)} zweiter Körper`).toBeLessThanOrEqual(0.25);
    }
    expect(report.length).toBe(CASES.length);
  }, 120000);

  it('keine NaN bei wilden Eingaben (Lage, jointAdd, zweiter Körper, Schnur, Kanäle)', () => {
    for (const item of ['yoyo', 'kendama', 'spinner'] as const) {
      const p = make(item);
      let seed = 23;
      const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const joints = new Float32Array(REST_JOINTS[item]);
      for (let k = 0; k < 6000; k++) {
        const r = rnd();
        if (r < 0.04) p.onEvent({ type: 'jump', speed: rnd() * 3000, gain: 5, perfect: rnd() < 0.5, clean: rnd() < 0.5, chain: 3, sync: 0.9, crouched: false, coyote: false });
        else if (r < 0.05) p.onEvent({ type: 'finish', time: 9, best: rnd() < 0.5, previousBest: null });
        else if (r < 0.06) p.onEvent({ type: 'speedMilestone', speed: 1000 });
        else if (r < 0.065) p.onEvent({ type: rnd() < 0.5 ? 'surfStart' : 'surfEnd' });
        else if (r < 0.067) p.onEvent({ type: 'respawn', reason: 'fall' });
        else if (r < 0.068) p.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 3, split: rnd() < 0.5 ? -0.2 : 0.3 });
        if (rnd() < 0.002) p.debugPlayName(p.trickNames[Math.floor(rnd() * p.trickNames.length)], -1);
        const inp: PropFrameInput = { speed: rnd() < 0.01 ? Number.NaN : rnd() * 1500, onGround: rnd() < 0.5, surfing: rnd() < 0.3, surfSide: rnd() * 2 - 1, handX: rnd() < 0.01 ? Number.NaN : rnd() * 0.2 - 0.1, handY: rnd() * 0.2 - 0.1, handTilt: rnd() * 30 - 15 };
        const dt = rnd() < 0.01 ? Number.NaN : rnd() * 0.12;
        p.update(dt, inp);
        p.afterPose(joints, inp, dt);
        const o = p.out;
        let ok = Number.isFinite(o.hx + o.hy + o.hz + o.hpitch + o.hyaw + o.hroll + o.spin + o.pos[0] + o.pos[1] + o.pos[2] + o.rot[0] + o.rot[1] + o.rot[2]);
        ok = ok && Number.isFinite(o.sub[0] + o.sub[1] + o.sub[2] + o.subRot[0] + o.subRot[1] + o.subRot[2] + o.subSpin);
        for (let i = 0; i < VM_JOINT_COUNT; i++) ok = ok && Number.isFinite(o.jointAdd[i]);
        for (let i = 0; i < o.stringCount * 3; i++) ok = ok && Number.isFinite(o.string[i]);
        for (let i = 0; i < 4; i++) ok = ok && Number.isFinite(o.param[i]);
        if (!ok) expect.fail(`${item} Schritt ${k}: nicht endlich (${p.trick})`);
      }
    }
  });

  it('keine Durchdringung (echte ViewHand, 240 Hz, Stichprobe 1/30 s): Gegenstand + Kugel/Jo-Jo > −0.35, Schnur-Sehnen frei', () => {
    const shape = new HandShape();
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
        h.update(1 / 60, inp);
      }
      const rest = h.output(true);
      const restSub = [rest.subPos[0], rest.subPos[1], rest.subPos[2]];
      if (c.surf) {
        inp.surfing = true;
        inp.onGround = false;
        inp.speed = 800;
        inp.surfSide = 0.4;
        h.onEvent({ type: 'surfStart' });
      } else h.forceTrick(c.trick, -1);
      let worst = 0;
      let at = '';
      let strWorst = 0;
      let strFar = 0;
      let strFrames = 0;
      let strBad = 0;
      const n = Math.round(c.dur * 240);
      for (let i = 1; i <= n; i++) {
        if (c.surf && i / 240 > c.surf) inp.surfing = false;
        h.update(1 / 240, inp);
        // Stichprobe alle 1/30 s (dichte Mesh-Abtastung ist teuer; parallel laufende Testdateien liefen sonst in ihr
        // Zeitlimit). Die Werkzeug-Messung mit 1/120 s ergab dieselben Höchstwerte ±0.03.
        if (i % 8 !== 0) continue;
        const f = h.output(true);
        const r = measure(f, itemPoints(f));
        if (r.penetration > worst) {
          worst = r.penetration;
          let part = 0;
          r.perPart.forEach((d, k) => {
            if (d < r.perPart[part]) part = k;
          });
          at = `${(i / 240).toFixed(3)} s ${HAND_PART_NAMES[part]}`;
        }
        // Schnur: Sehnen ab der zweiten (die erste beginnt in der Schlaufe am Finger), Schnur-Radius 0.15. Ohne die
        // Wiegen-Figur (exakt vorgegeben: Daumen-/Zeigefingerspitze, Knoten — cosmetics.test; offen, siehe Inbox).
        const tt = h.state().trickTime;
        const figure = h.state().trick === 'cradle' && tt > 0.1 * 1.8 && tt < 0.9 * 1.8;
        if (f.stringCount > 1 && !figure) {
          shape.update(f.joints);
          const S = f.stringPts;
          let pen = 0;
          for (let k = 1; k + 1 < f.stringCount; k++) {
            const a = k * 3;
            const b = a + 3;
            for (let q = 0; q <= 8; q++) {
              const u = q / 8;
              const d = shape.distance(S[a] + (S[b] - S[a]) * u, S[a + 1] + (S[b + 1] - S[a + 1]) * u, S[a + 2] + (S[b + 2] - S[a + 2]) * u) - 0.15;
              if (-d > pen) pen = -d;
            }
          }
          strFrames++;
          if (pen > 0.35) strBad++;
          strWorst = Math.max(strWorst, pen);
          if (Math.hypot(f.subPos[0] - restSub[0], f.subPos[1] - restSub[1], f.subPos[2] - restSub[2]) > 6.5) strFar = Math.max(strFar, pen);
        }
      }
      report.push(`${label(c)} ${worst.toFixed(2)} ${at} | Schnur ${strWorst.toFixed(2)} weit ${strFar.toFixed(2)} (${strBad}/${strFrames})`);
      expect(worst, `${label(c)} bei ${at}`).toBeLessThan(0.35);
      // Schnur: weit vom Fangpunkt (> 6.5 ≈ 2.5 Jo-Jo-Radien) frei; davor läuft sie zwischen den sich öffnenden bzw.
      // gekrümmten Fingern in die Tasche (von der Faust verdeckt) — dort höchstens 1.2 und in ≤ 5 % der Frames über 0.35.
      expect(strFar, `${label(c)} Schnur weit vom Fang`).toBeLessThanOrEqual(0.35);
      expect(strWorst, `${label(c)} Schnur`).toBeLessThan(1.2);
      expect(strBad, `${label(c)} Schnur-Frames > 0.35`).toBeLessThanOrEqual(Math.ceil(strFrames * 0.05));
    }
    expect(report.length).toBe(CASES.length);
  }, 300000);

  it('Spinner: großer Checkpoint-Schnipp (×1.4 Impuls) taucht nicht in den Rotor ein (> −0.35)', () => {
    const h = new ViewHand();
    h.setAspect(16 / 9);
    h.setItem('spinner');
    const p = h.activeProp;
    if (!p) throw new Error('kein Gegenstand');
    const inp = makeHandInput();
    for (let i = 0; i < 60; i++) {
      p.stop();
      h.update(1 / 60, inp);
    }
    h.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 3, split: -0.5 });
    let worst = 0;
    let ran = false;
    for (let i = 1; i <= 120; i++) {
      h.update(1 / 240, inp);
      if (p.trick === 'flick') ran = true;
      if (i % 4 !== 0) continue;
      const f = h.output(true);
      worst = Math.max(worst, measure(f, itemPoints(f)).penetration);
    }
    expect(ran).toBe(true);
    expect(worst).toBeLessThan(0.35);
  });

  it('Ruhe-Griffe: Ken (Handfläche), hängende Kugel (Daumen), Jo-Jo und Spinner liegen an, keins steckt > 0.35', () => {
    for (const item of ['yoyo', 'kendama', 'spinner'] as const) {
      const h = new ViewHand();
      h.setAspect(16 / 9);
      h.setItem(item);
      const p = h.activeProp;
      if (!p) throw new Error('kein Gegenstand');
      const inp = makeHandInput();
      for (let i = 0; i < 240; i++) {
        p.stop();
        h.update(1 / 60, inp);
      }
      const f = h.output(true);
      const r = measure(f, itemPoints(f));
      expect(r.penetration, `${item} Ruhe`).toBeLessThan(0.35);
      expect(r.gap, `${item} liegt an`).toBeLessThan(0.3);
    }
  });

  it('Jo-Jo: Wurf rollt ab, schläft mit Reibung, Zupfen holt es exakt in die Ruhelage (ohne Sprung)', () => {
    const y = new YoyoTricks();
    const j = REST_JOINTS.yoyo;
    for (let f = 0; f < 10; f++) {
      y.update(1 / 120, STILL);
      y.afterPose(j, STILL, 1 / 120);
    }
    const rest = [y.out.sub[0], y.out.sub[1], y.out.sub[2]];
    y.debugPlayName('sleeper', -1);
    let maxSpinRate = 0;
    let lastSpin = y.out.subSpin;
    let rateEarly = 0;
    let rateLate = 0;
    let wasFree = false;
    for (let f = 0; f < 120 * 1.35; f++) {
      y.update(1 / 120, STILL);
      y.afterPose(j, STILL, 1 / 120);
      let d = y.out.subSpin - lastSpin;
      d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
      lastSpin = y.out.subSpin;
      const rate = Math.abs(d) * 120;
      maxSpinRate = Math.max(maxSpinRate, rate);
      if (y.trickTime > 0.3 && y.trickTime < 0.32) rateEarly = rate;
      if (y.trickTime > 0.9 && y.trickTime < 0.92) rateLate = rate;
      if (y.rope.freeEnd) wasFree = true;
    }
    // Wurf: Drehzahl aus dem abgewickelten Weg (Dutzende rad/s), im Schlaf langsam abnehmend (Reibung).
    expect(maxSpinRate).toBeGreaterThan(30);
    expect(wasFree).toBe(true);
    expect(rateLate).toBeLessThan(rateEarly);
    expect(rateLate).toBeGreaterThan(rateEarly * 0.7);
    expect(y.trick).toBe('none');
    const back = Math.hypot(y.out.sub[0] - rest[0], y.out.sub[1] - rest[1], y.out.sub[2] - rest[2]);
    expect(back, 'Jo-Jo zurück in der Ruhelage').toBeLessThan(1e-4);
  });

  it('Kendama: Kugel landet exakt in großem/kleinem Becher und auf der Spitze; Airplane fängt sie in der Hand', () => {
    for (const [trick, target] of [
      ['bigCup', KEN_BIG_CUP],
      ['smallCup', KEN_SMALL_CUP],
      ['spike', KEN_SPIKE],
    ] as const) {
      const k = new KendamaTricks();
      k.debugPlayName(trick, -1);
      let caught = false;
      for (let f = 0; f < 120 * 0.6; f++) {
        k.update(1 / 120, STILL);
        k.afterPose(REST_JOINTS.kendama, STILL, 1 / 120);
        if (k.caughtOn(target)) caught = true;
      }
      expect(caught, trick).toBe(true);
    }
    const a = new KendamaTricks();
    a.debugPlayName('airplane', -1);
    let inHand = false;
    for (let f = 0; f < 120 * 1.2; f++) {
      a.update(1 / 120, STILL);
      a.afterPose(REST_JOINTS.kendama, STILL, 1 / 120);
      if (a.ballInHand) inHand = true;
    }
    expect(inHand).toBe(true);
  });

  it('Kendama: Abwechslung — kein Trick dominiert die Sprung-Starts einer Stufe (Reihum je Stufe)', () => {
    for (const tier of [1, 2, 3]) {
      const k = new KendamaTricks();
      const counts = new Map<string, number>();
      for (let n = 0; n < 24; n++) {
        k.stop();
        k.onEvent({ type: 'jump', speed: [0, 400, 700, 1000][tier], gain: 5, perfect: false, clean: false, chain: 1, sync: 0.5, crouched: false, coyote: false });
        // Ein Frame, damit der Trick startet (Ereignisse gelten am Frame-Ende).
        k.update(1 / 60, AIRBORNE);
        if (k.trick !== 'none') counts.set(k.trick, (counts.get(k.trick) ?? 0) + 1);
      }
      const total = [...counts.values()].reduce((s, v) => s + v, 0);
      expect(total, `Stufe ${tier}`).toBeGreaterThan(0);
      for (const [t, v] of counts) expect(v / total, `Stufe ${tier}: ${t}`).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(counts.size, `Stufe ${tier}`).toBe(KENDAMA_TIER_TRICKS[tier].length);
    }
  });

  it('Spinner: Drehzahl folgt dem Tempo, Anschnippen gibt Drehimpuls, ab 0.9 rad/Frame Unschärfe statt Wagenrad', () => {
    const s = new SpinnerTricks();
    const fast: PropFrameInput = { speed: 1000, onGround: true, surfing: false };
    for (let f = 0; f < 60 * 5; f++) s.update(1 / 60, fast);
    expect(s.omega).toBeCloseTo(SPINNER_OMEGA_BASE + SPINNER_OMEGA_PER_SPEED * 1000, 0);
    expect(s.out.param[VM_PARAM.spinner.blur]).toBeGreaterThan(0);
    // Ausrollen mit Lager-Reibung: ohne Tempo fällt ω exponentiell, nie unter den Grundwert.
    for (let f = 0; f < 60; f++) s.update(1 / 60, STILL);
    const w1 = s.omega;
    for (let f = 0; f < 60; f++) s.update(1 / 60, STILL);
    expect(s.omega).toBeLessThan(w1);
    expect(s.omega).toBeGreaterThan(SPINNER_OMEGA_BASE);
    const before = s.omega;
    s.debugPlayName('flick', -1);
    for (let f = 0; f < 12; f++) s.update(1 / 120, STILL);
    expect(s.omega, 'Schnipp').toBeGreaterThan(before + 5);
  });

  it('allokationsfrei: je Trick höchstens 1 Scavenge in 12 000 Frames (Node, --trace-gc, 1-MB-Semispace)', async () => {
    // Wie anim-can-lighter-phone: je Trick ein Prozess, EINE Schleifen-Funktion für Aufwärmen und Messen, synchron
    // kompiliert. afterPose mit fester Pose (Schnur, zweiter Körper, Finger-Schutz laufen mit).
    const script = [
      "const mod = await import('./src/ui/hand/' + process.env.PROP_FILE);",
      "const poses = await import('./src/ui/hand/poses.ts');",
      'const p = new mod[process.env.PROP_CLASS]();',
      'const name = process.env.PROP_TRICK;',
      'const surf = name === process.env.PROP_STATE;',
      'const inp = { speed: 800.5, onGround: false, surfing: surf, surfSide: 0.5, handX: 0.01, handY: 0.02, handTilt: 3.5 };',
      'const joints = new Float32Array(poses.POSE_JOINTS[poses.POSE[process.env.PROP_POSE]]);',
      'const DT = 1 / 144;',
      "function step(n) { for (let f = 0; f < n; f++) { if (p.trick === 'none') { if (surf) p.onEvent({ type: 'surfStart' }); else p.debugPlayName(name, -1); } p.update(DT, inp); p.afterPose(joints, inp, DT); p.out.kickY = 0; p.out.kickSq = 0; } }",
      'for (let k = 0; k < 600; k++) step(100);',
      // Marken = gc() im selben Strom wie --trace-gc (console.log-Marken zählten den stdio-Puffer, fallen.md).
      'gc();',
      'for (let k = 0; k < 120; k++) step(100);',
      'gc();',
    ].join('\n');
    const specs: [string, string, string, string, string][] = [];
    for (const [file, cls, p, pose, state] of [
      ['yoyoTricks.ts', 'YoyoTricks', new YoyoTricks(), 'yoyo', 'surfSleeper'],
      ['kendamaTricks.ts', 'KendamaTricks', new KendamaTricks(), 'ken', 'cupRide'],
      ['spinnerTricks.ts', 'SpinnerTricks', new SpinnerTricks(), 'spin', 'balance'],
    ] as const) {
      for (const trick of p.trickNames) specs.push([file, cls, trick, pose, state]);
    }
    const probe = (file: string, cls: string, trick: string, pose: string, state: string): Promise<[string, number]> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--expose-gc', '--trace-gc', '--max-semi-space-size=1', '--no-concurrent-recompilation', '--no-concurrent-osr', '--single-threaded-gc', '--input-type=module', '-e', script], {
          cwd: process.cwd(),
          env: { ...process.env, PROP_FILE: file, PROP_CLASS: cls, PROP_TRICK: trick, PROP_POSE: pose, PROP_STATE: state },
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', () => {
          const lines = out.split('\n');
          const marks = lines.flatMap((l, i) => (/Mark-Compact.*testing/.test(l) ? [i] : []));
          resolve([`${cls}/${trick}`, marks.length !== 2 ? -1 : lines.slice(marks[0], marks[1]).filter((l) => l.includes('Scavenge')).length]);
        });
      });
    const res: [string, number][] = [];
    // Nacheinander: gleichzeitig bremste die Last parallel laufende Testdateien über ihr 5-s-Limit (viewHand.test).
    for (const [f, c, t, p, st] of specs) res.push(await probe(f, c, t, p, st));
    expect(res.length).toBe(specs.length);
    const bad = res.filter(([, n]) => n < 0 || n > 1);
    expect(bad, JSON.stringify(res)).toEqual([]);
  }, 300000);
});
