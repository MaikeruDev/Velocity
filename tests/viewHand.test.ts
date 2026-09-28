import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../src/engine/events';
import { HAND_LIMITS, HandMotion, makeHandInput, type HandFrameInput } from '../src/ui/hand/handMotion';
import { ViewHand } from '../src/ui/hand/ViewHand';
import { HAND_POSES, POSE, POSE_JOINTS } from '../src/ui/hand/poses';
import { VM_JOINT_COUNT } from '../src/render/types';
import { SAFE_ASPECT } from '../src/ui/safeFrame';

const JUMP = (chain = 1, perfect = false): GameEvent => ({ type: 'jump', speed: 300, gain: 10, perfect, chain, sync: 1, crouched: false, coyote: false });
const LAND = (impact: number, jumpQueued = false): GameEvent => ({ type: 'land', impact, speed: 300, airTime: 0.7, jumpQueued });

interface Sample {
  x: number;
  y: number;
  tilt: number;
  squash: number;
  yaw: number;
  pitch: number;
}

/**
 * Fester Ablauf bei beliebiger Framerate: Stehen, Laufen, Sprung bei 1.0 s mit Mausdrehung
 * in der Luft, Landung bei 2.0 s, danach Laufen mit Strafe. Ereigniszeiten liegen auf allen
 * getesteten Frame-Rastern (30/60/144/240 Hz), damit nur die Integration verglichen wird.
 */
function scenario(fps: number, sampleAt: readonly number[], motionFx = 1): Sample[] {
  const a = new HandMotion();
  a.motionFx = motionFx;
  a.reset();
  const inp = makeHandInput();
  const dt = 1 / fps;
  const out: Sample[] = [];
  const total = Math.round(3 * fps);
  let air = 0;
  for (let f = 1; f <= total; f++) {
    const t = f * dt;
    if (f === Math.round(1 * fps)) a.onEvent(JUMP());
    if (f === Math.round(2 * fps)) a.onEvent(LAND(420));
    const inAir = t > 1 && t <= 2;
    air = inAir ? air + dt : 0;
    inp.onGround = !inAir;
    inp.speed = t < 0.5 ? 0 : 310;
    inp.stridePhase = (t * 1.3) % 1;
    inp.airTime = air;
    inp.yawDelta = inAir ? 2.5 * dt : 0;
    inp.pitchDelta = inAir ? -0.8 * dt : 0;
    inp.side = t > 2.3 ? 1 : 0;
    a.update(dt, inp);
    for (const s of sampleAt) if (f === Math.round(s * fps)) out.push({ x: a.x, y: a.y, tilt: a.tilt, squash: a.squash, yaw: a.yaw, pitch: a.pitch });
  }
  return out;
}

describe('View-Hand: Bewegung (Plan 004/006)', () => {
  it('ist framerate-unabhängig (30/60/144/240 Hz gegen 1200 Hz)', () => {
    const at = [0.5, 1.5, 2.5, 3];
    const ref = scenario(1200, at);
    for (const fps of [30, 60, 144, 240]) {
      const got = scenario(fps, at);
      expect(got.length).toBe(at.length);
      for (let i = 0; i < at.length; i++) {
        expect(Math.abs(got[i].x - ref[i].x), `x @${at[i]} s, ${fps} Hz`).toBeLessThan(0.004);
        expect(Math.abs(got[i].y - ref[i].y), `y @${at[i]} s, ${fps} Hz`).toBeLessThan(0.004);
        expect(Math.abs(got[i].tilt - ref[i].tilt), `tilt @${at[i]} s, ${fps} Hz`).toBeLessThan(0.4);
        expect(Math.abs(got[i].squash - ref[i].squash), `squash @${at[i]} s, ${fps} Hz`).toBeLessThan(0.01);
        expect(Math.abs(got[i].yaw - ref[i].yaw), `yaw @${at[i]} s, ${fps} Hz`).toBeLessThan(0.01);
        expect(Math.abs(got[i].pitch - ref[i].pitch), `pitch @${at[i]} s, ${fps} Hz`).toBeLessThan(0.01);
      }
    }
  });

  it('bleibt bei wilden Eingaben in den Grenzen, endlich und ohne NaN', () => {
    const a = new ViewHand();
    const m = a.motion;
    const inp = makeHandInput();
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const L = HAND_LIMITS;
    for (let k = 0; k < 20000; k++) {
      const r = rnd();
      if (r < 0.03) a.onEvent(JUMP(1 + Math.floor(rnd() * 20), rnd() < 0.5));
      else if (r < 0.06) a.onEvent(LAND(rnd() * 1e5, rnd() < 0.5));
      else if (r < 0.065) a.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 5, split: null });
      else if (r < 0.067) a.onEvent({ type: 'finish', time: 9, best: true, previousBest: null });
      else if (r < 0.069) a.onEvent({ type: 'respawn', reason: 'fall' });
      inp.speed = rnd() * 5000;
      inp.onGround = rnd() < 0.5;
      inp.surfing = rnd() < 0.2;
      inp.ducked = rnd() < 0.3;
      inp.stridePhase = rnd();
      inp.airTime = rnd() * 10;
      inp.yawDelta = (rnd() - 0.5) * 100;
      inp.pitchDelta = (rnd() - 0.5) * 20;
      inp.side = Math.round(rnd() * 2 - 1);
      inp.surfSide = rnd() * 2 - 1;
      a.update(0.001 + rnd() * 0.12, inp);
      for (const v of [m.x, m.y, m.tilt, m.squash, m.yaw, m.pitch]) expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(m.x)).toBeLessThanOrEqual(L.x + 1e-9);
      expect(m.y).toBeGreaterThanOrEqual(-L.yUp - 1e-9);
      expect(m.y).toBeLessThanOrEqual(L.yDown + L.enter + 1e-9);
      expect(Math.abs(m.tilt)).toBeLessThanOrEqual(L.tilt + 1e-9);
      expect(m.squash).toBeGreaterThanOrEqual(L.squashMin - 1e-9);
      expect(m.squash).toBeLessThanOrEqual(L.squashMax + 1e-9);
      expect(Math.abs(m.yaw)).toBeLessThanOrEqual(L.yaw + 1e-9);
      expect(Math.abs(m.pitch)).toBeLessThanOrEqual(L.pitch + 1e-9);
      for (const j of a.frame.joints) expect(Number.isFinite(j)).toBe(true);
    }
  });

  it('NaN/Infinity in Eingaben und dt vergiften den Zustand nicht', () => {
    const a = new ViewHand();
    const inp: HandFrameInput = { ...makeHandInput(), speed: NaN, yawDelta: Infinity, pitchDelta: -Infinity, airTime: NaN, stridePhase: NaN, surfSide: NaN, side: NaN };
    a.onEvent(LAND(NaN));
    a.update(NaN, inp);
    a.update(Infinity, inp);
    a.update(1 / 60, inp);
    inp.surfing = true;
    a.update(1 / 60, inp);
    const f = a.output(true);
    for (const v of [f.x, f.y, f.z, f.roll, f.pitch, f.yaw, f.squash, ...f.joints]) expect(Number.isFinite(v)).toBe(true);
  });

  it('motionFx 0 = statisch: kein Versatz, keine Drehung, kein Squash — Posen wechseln trotzdem (ohne Überblenden)', () => {
    const a = new ViewHand();
    a.motionFx = 0;
    const inp = makeHandInput();
    const seen = new Set<string>();
    a.onEvent({ type: 'respawn', reason: 'restart' });
    for (let k = 0; k < 2000; k++) {
      if (k % 97 === 0) a.onEvent(JUMP());
      if (k % 97 === 50) a.onEvent(LAND(900));
      inp.speed = (k * 7) % 1400;
      inp.onGround = k % 97 < 50;
      inp.surfing = k % 400 > 330;
      inp.surfSide = 0.8;
      inp.yawDelta = Math.sin(k) * 0.3;
      inp.side = (k % 3) - 1;
      inp.stridePhase = (k * 0.01) % 1;
      a.update(1 / 144, inp);
      const m = a.motion;
      expect(m.x).toBe(0);
      expect(m.y).toBe(0);
      expect(m.tilt).toBe(0);
      expect(m.squash).toBe(1);
      expect(m.yaw).toBe(0);
      expect(m.pitch).toBe(0);
      const st = a.state();
      seen.add(st.pose);
      // Gelenke springen direkt auf die Pose.
      const target = POSE_JOINTS[HAND_POSES.findIndex((p) => p === st.pose)];
      for (let i = 0; i < VM_JOINT_COUNT; i++) expect(a.frame.joints[i]).toBeCloseTo(target[i], 5);
    }
    expect(seen.has('open')).toBe(true);
    expect(seen.has('run')).toBe(true);
  });

  it('Posen: Stand locker, Sprint lockere Faust, Luft gespreizt, Checkpoint Faust, Ziel Daumen hoch', () => {
    const a = new ViewHand();
    const inp = makeHandInput();
    const run = (n: number): void => {
      for (let k = 0; k < n; k++) a.update(1 / 120, inp);
    };
    run(30);
    expect(a.state().pose).toBe('relaxed');
    inp.speed = 320;
    run(30);
    expect(a.state().pose).toBe('run');
    inp.onGround = false;
    run(10);
    expect(a.state().pose).toBe('open');
    // Bhop: ein Tick Boden hält die Luft-Pose (kein Flackern).
    inp.onGround = true;
    run(2);
    expect(a.state().pose).toBe('open');
    inp.onGround = false;
    inp.surfing = true;
    run(5);
    expect(a.state().pose).toBe('open');
    inp.surfing = false;
    inp.onGround = true;
    a.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 4, split: null });
    run(10);
    expect(a.state().pose).toBe('fist');
    run(120);
    expect(a.state().pose).toBe('run');
    a.onEvent({ type: 'finish', time: 9, best: true, previousBest: 10 });
    run(60);
    expect(a.state().pose).toBe('thumbsUp');
  });

  it('Gelenke blenden weich über (kein Sprung) und kommen an', () => {
    const a = new ViewHand();
    const inp = makeHandInput();
    for (let k = 0; k < 60; k++) a.update(1 / 60, inp);
    a.force = POSE.fist;
    a.update(1 / 60, inp);
    const idx = 7 + 4 + 2; // Mittelfinger, Mittelgelenk
    const relaxed = POSE_JOINTS[POSE.relaxed][idx];
    const fist = POSE_JOINTS[POSE.fist][idx];
    const after1 = a.frame.joints[idx];
    expect(after1).toBeGreaterThan(relaxed + 1e-4);
    expect(after1).toBeLessThan(fist - (fist - relaxed) * 0.5);
    for (let k = 0; k < 60; k++) a.update(1 / 60, inp);
    expect(a.frame.joints[idx]).toBeCloseTo(fist, 3);
  });

  it('Bhop-Landungen drücken die Hand nur leicht (50 Hops sollen nicht nerven)', () => {
    const peak = (hop: boolean): number => {
      const a = new HandMotion();
      const inp = makeHandInput();
      a.onEvent(LAND(500, hop));
      let m = 0;
      for (let k = 0; k < 120; k++) {
        a.update(1 / 144, inp);
        m = Math.max(m, a.y);
      }
      return m;
    };
    const hard = peak(false);
    const hop = peak(true);
    expect(hard).toBeGreaterThan(0.02);
    expect(hop).toBeLessThan(hard * 0.3);
  });

  it('Landung ohne jumpQueued, auf die im Folgetick ein Sprung kommt, zählt als Bhop', () => {
    const a = new HandMotion();
    const b = new HandMotion();
    const inp = makeHandInput();
    a.onEvent(LAND(500, false));
    a.onEvent(JUMP(3, true));
    b.onEvent(LAND(500, false));
    let ma = 0;
    let mb = 0;
    for (let k = 0; k < 120; k++) {
      a.update(1 / 144, inp);
      b.update(1 / 144, inp);
      ma = Math.max(ma, 1 - a.squash);
      mb = Math.max(mb, 1 - b.squash);
    }
    expect(mb).toBeGreaterThan(0.05);
    expect(ma).toBeLessThan(mb * 0.3);
  });

  it('Maus-Sway: Linksdrehung lässt die Hand nach rechts zurückbleiben, Blick nach oben nach unten', () => {
    const a = new HandMotion();
    const inp = makeHandInput();
    inp.yawDelta = 3 / 144;
    inp.pitchDelta = 2 / 144;
    for (let k = 0; k < 40; k++) a.update(1 / 144, inp);
    expect(a.x).toBeGreaterThan(0.01);
    expect(a.y).toBeGreaterThan(0.005);
    expect(a.yaw).toBeGreaterThan(0.01);
  });

  it('Fahrtwind: ab ~500 u/s tiefer und nach außen', () => {
    const a = new HandMotion();
    const inp = makeHandInput();
    inp.onGround = false;
    inp.airTime = 0.2;
    for (let k = 0; k < 300; k++) a.update(1 / 144, inp);
    const slowY = a.y;
    inp.speed = 1200;
    for (let k = 0; k < 300; k++) a.update(1 / 144, inp);
    expect(a.y - slowY).toBeGreaterThan(0.025);
    expect(a.x).toBeGreaterThan(0.01);
  });

  it('Respawn: Hand fährt von unten ein', () => {
    const a = new HandMotion();
    const inp = makeHandInput();
    a.onEvent({ type: 'respawn', reason: 'fall' });
    a.update(1 / 60, inp);
    const first = a.y;
    for (let k = 0; k < 60; k++) a.update(1 / 60, inp);
    expect(first).toBeGreaterThan(0.25);
    expect(a.y).toBeLessThan(0.02);
  });
});

describe('View-Hand: Anker im Safe-Frame', () => {
  it('Handgelenk hat auf 21:9/32:9 denselben Abstand zur Bildmitte wie auf 16:9, auf 4:3 weiter innen', () => {
    const anchor = (aspect: number): number => {
      const a = new ViewHand();
      a.motionFx = 0;
      a.setAspect(aspect);
      a.update(1 / 60, makeHandInput());
      return a.output(true).x;
    };
    const wide = anchor(16 / 9);
    expect(anchor(21 / 9)).toBeCloseTo(wide, 6);
    expect(anchor(32 / 9)).toBeCloseTo(wide, 6);
    expect(anchor(4 / 3)).toBeLessThan(wide);
    // Innerhalb des Bildes (rechter Rand bei aspect/2).
    expect(wide).toBeLessThan(SAFE_ASPECT / 2);
    expect(wide).toBeGreaterThan(0.1);
  });

  it('output() respektiert "Hand anzeigen"', () => {
    const a = new ViewHand();
    expect(a.output(true).visible).toBe(true);
    a.enabled = false;
    expect(a.output(true).visible).toBe(false);
    a.enabled = true;
    expect(a.output(false).visible).toBe(false);
  });
});
