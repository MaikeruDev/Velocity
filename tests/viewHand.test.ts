import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { GameEvent } from '../src/engine/events';
import type { HeldItemId } from '../src/engine/settingsTypes';
import { compileLevel } from '../src/world/level/compileLevel';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { flatLevel } from '../tools/sim/levels';
import { makeInput } from '../tools/sim/harness';
import { HAND_LIMITS, HandMotion, makeHandInput, type HandFrameInput } from '../src/ui/hand/handMotion';
import { ViewHand } from '../src/ui/hand/ViewHand';
import { HAND_POSES, POSE, POSE_JOINTS } from '../src/ui/hand/poses';
import { VM_JOINT_COUNT } from '../src/render/types';
import { SAFE_ASPECT } from '../src/ui/safeFrame';

const JUMP = (chain = 1, perfect = false): GameEvent => ({ type: 'jump', speed: 300, gain: 10, perfect, clean: perfect, chain, sync: 1, crouched: false, coyote: false });
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
 * Fester Ablauf bei beliebiger Framerate: Stehen, Laufen ab 0.5 s, Sprung bei 1.0 s mit Mausdrehung
 * in der Luft, harte Landung bei 2.0 s, Strafe ab 2.5 s. Alle Wechsel liegen auf allen getesteten
 * Frame-Rastern (30/60/144/240/1200 Hz). Abgetastet wie im Spiel: der Zustand am Frame-Ende enthält
 * einen Wechsel in genau diesem Moment (Snapshot nach dem Tick), das Blick-Delta ist die Drehung
 * im Frame-Intervall. Ergebnis: jeder Frame (Zeit t) als Sample.
 */
function scenario(fps: number, motionFx = 1): Sample[] {
  const a = new HandMotion();
  a.motionFx = motionFx;
  a.reset();
  const inp = makeHandInput();
  const dt = 1 / fps;
  const out: Sample[] = [];
  const total = Math.round(3 * fps);
  const f1 = Math.round(1 * fps);
  const f2 = Math.round(2 * fps);
  for (let f = 1; f <= total; f++) {
    const t = f * dt;
    if (f === f1) a.onEvent(JUMP());
    if (f === f2) a.onEvent(LAND(420));
    const inAir = f >= f1 && f < f2;
    // Drehung im Intervall (t − dt, t] ∩ Luftzeit [1, 2).
    const turning = f > f1 && f <= f2;
    inp.onGround = !inAir;
    inp.speed = f >= Math.round(0.5 * fps) ? 310 : 0;
    inp.stridePhase = (t * 1.3) % 1;
    inp.airTime = inAir ? (f - f1) * dt : 0;
    inp.yawDelta = turning ? 2.5 * dt : 0;
    inp.pitchDelta = turning ? -0.8 * dt : 0;
    inp.side = f >= Math.round(2.5 * fps) ? 1 : 0;
    a.update(dt, inp);
    out.push({ x: a.x, y: a.y, tilt: a.tilt, squash: a.squash, yaw: a.yaw, pitch: a.pitch });
  }
  return out;
}

describe('View-Hand: Bewegung (Plan 004/006)', () => {
  it('ist framerate-unabhängig: JEDER Frame bei 30/60/144/240 Hz gegen 1200 Hz (Events am Frame-Ende, #77)', () => {
    const REF = 1200;
    const ref = scenario(REF);
    const worst = { x: 0, y: 0, tilt: 0, squash: 0, yaw: 0, pitch: 0 };
    for (const fps of [30, 60, 144, 240]) {
      const got = scenario(fps);
      for (let i = 0; i < got.length; i++) {
        const j = Math.round(((i + 1) * REF) / fps) - 1;
        for (const k of ['x', 'y', 'tilt', 'squash', 'yaw', 'pitch'] as const) worst[k] = Math.max(worst[k], Math.abs(got[i][k] - ref[j][k]));
      }
    }
    // Vorher (Impulse am Frame-Anfang, Zustände über den ganzen Frame): y 0.023 (6.3 px), Squash 0.05,
    // Pitch 0.036, Neigung 0.57°. Jetzt: y 0.0004, Squash 0.0007, Pitch 0.0004, Neigung 0.006°.
    expect(worst.x).toBeLessThan(0.001);
    expect(worst.y).toBeLessThan(0.001);
    expect(worst.tilt).toBeLessThan(0.05);
    expect(worst.squash).toBeLessThan(0.002);
    expect(worst.yaw).toBeLessThan(0.001);
    expect(worst.pitch).toBeLessThan(0.001);
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
    // Eigenes Timeout: ViewHand rechnet die 20 000 Frames in ~30 ms, die ~720 000 expect-Aufrufe kosten isoliert ~2.3 s
    // und im parallelen Gesamtlauf 5.0–5.2 s (riss das 5-s-Default) — Testumfang, keine Verlangsamung im Code.
  }, 20000);

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

const FAST_JUMP: GameEvent = { type: 'jump', speed: 950, gain: 10, perfect: true, clean: true, chain: 3, sync: 1, crouched: false, coyote: false };

describe('View-Hand: Reaktionen auf Movement-Events (Plan 007 K8)', () => {
  const SLIDE_START: GameEvent = { type: 'slideStart', speed: 420, boost: true };
  const SLIDE_END: GameEvent = { type: 'slideEnd', speed: 150 };

  /** Hand am Boden mit Tempo einschwingen. */
  function groundHand(motionFx = 1): { h: ViewHand; inp: HandFrameInput } {
    const h = new ViewHand();
    h.motionFx = motionFx;
    const inp = makeHandInput();
    inp.speed = 400;
    for (let k = 0; k < 120; k++) h.update(1 / 120, inp);
    return { h, inp };
  }

  it('Rutschen: Pose flach binnen 0.1 s, Hand tief und außen; nach slideEnd zurück', () => {
    const { h, inp } = groundHand();
    expect(h.state().pose).toBe('run');
    const y0 = h.motion.y;
    const x0 = h.motion.x;
    h.onEvent(SLIDE_START);
    let t = 0;
    while (h.state().pose !== 'flat' && t < 0.2) {
      h.update(1 / 120, inp);
      t += 1 / 120;
    }
    expect(t).toBeLessThanOrEqual(0.1);
    for (let k = 0; k < 60; k++) h.update(1 / 120, inp);
    expect(h.state().sliding).toBe(true);
    expect(h.motion.y - y0).toBeGreaterThan(0.03);
    expect(h.motion.x - x0).toBeGreaterThan(0.015);
    // Gelenke nähern sich der flachen Hand (Überblenden, kein Sprung).
    const flat = POSE_JOINTS[POSE.flat];
    const idx = 7 + 4 + 1;
    expect(Math.abs(h.frame.joints[idx] - flat[idx])).toBeLessThan(0.05);
    h.onEvent(SLIDE_END);
    for (let k = 0; k < 24; k++) h.update(1 / 120, inp);
    expect(h.state().pose).toBe('run');
    expect(h.state().sliding).toBe(false);
  });

  it('motionFx 0: Pose wechselt trotzdem, aber kein Versatz (statisch)', () => {
    const { h, inp } = groundHand(0);
    h.onEvent(SLIDE_START);
    for (let k = 0; k < 30; k++) {
      h.update(1 / 120, inp);
      expect(h.motion.x).toBe(0);
      expect(h.motion.y).toBe(0);
      expect(h.motion.tilt).toBe(0);
    }
    expect(h.state().pose).toBe('flat');
  });

  it('mit Gegenstand: beim Rutschen keine Trick-Starts (Meilenstein, Leerlauf, Checkpoint); danach wieder', () => {
    for (const item of ['can', 'card', 'knife', 'spinner'] as const) {
      const h = new ViewHand();
      h.setItem(item);
      const inp = makeHandInput();
      inp.speed = 0;
      h.onEvent(SLIDE_START);
      for (let k = 0; k < 60 * 20; k++) {
        if (k % 90 === 45) h.onEvent({ type: 'speedMilestone', speed: 1000 });
        if (k % 90 === 60) h.onEvent({ type: 'checkpoint', index: 1, total: 3, time: 5, split: -0.2 });
        h.update(1 / 60, inp);
        expect(h.state().trick, `${item} @${k}`).toBe('none');
      }
      h.onEvent(SLIDE_END);
      h.update(1 / 60, inp);
      h.onEvent(FAST_JUMP);
      expect(h.state().trick, item).not.toBe('none');
    }
  });

  it('Slide-Hop: ein Sprung beendet die Rutsche — die Physik schickt [jump, slideEnd], der Trick startet trotzdem', () => {
    for (const item of ['can', 'card', 'knife', 'spinner'] as const) {
      const h = new ViewHand();
      h.setItem(item);
      const inp = makeHandInput();
      inp.speed = 420;
      h.onEvent(SLIDE_START);
      for (let k = 0; k < 30; k++) h.update(1 / 60, inp);
      expect(h.state().sliding).toBe(true);
      // Reihenfolge wie PlayerMovement im Sprung-Tick: jump (Stufe 1) vor slideEnd.
      h.onEvent({ ...FAST_JUMP, speed: 420, chain: 1 });
      h.onEvent(SLIDE_END);
      expect(h.state().sliding, item).toBe(false);
      expect(h.state().trick, item).not.toBe('none');
    }
  });

  it('Slide-Hop mit der echten PlayerMovement: Events im Sprung-Tick [jump, slideEnd], Trick startet', () => {
    const level = compileLevel(flatLevel(8192));
    for (const item of ['knife', 'spinner'] as const) {
      const pm = new PlayerMovement(level.world, VELOCITY_DEFAULT);
      pm.teleport(new Vector3(0, 0, 0));
      const h = new ViewHand();
      h.setItem(item);
      const inp = makeHandInput();
      const dt = 1 / VELOCITY_DEFAULT.tickRate;
      const run = (n: number, patch: Parameters<typeof makeInput>[0]): string[] => {
        const seen: string[] = [];
        for (let i = 0; i < n; i++) {
          for (const e of pm.tick(makeInput(patch))) {
            seen.push(e.type);
            h.onEvent(e);
          }
          inp.speed = pm.state.speed;
          h.update(dt, inp);
        }
        return seen;
      };
      run(64, { forward: 1, sprint: true });
      expect(run(40, { forward: 1, sprint: true, crouch: true })).toContain('slideStart');
      expect(h.state().sliding).toBe(true);
      expect(h.state().trick).toBe('none');
      const jumpTick = run(1, { forward: 1, sprint: true, crouch: true, jumpPressed: true, jumpHeld: true });
      expect(jumpTick).toEqual(['jump', 'slideEnd']);
      expect(h.state().trick, item).not.toBe('none');
    }
  });

  it('ein laufender Trick wird beim Rutschen nicht abgebrochen', () => {
    const h = new ViewHand();
    h.setItem('knife');
    h.onEvent(FAST_JUMP);
    const trick = h.state().trick;
    expect(trick).not.toBe('none');
    h.onEvent(SLIDE_START);
    h.update(1 / 60, makeHandInput());
    expect(h.state().trick).toBe(trick);
  });

  it('Kanten-Assist: Lip-Step = kurzer Griff, Vault = flache Hand (Abdrücken); mit Gegenstand hält sie fest', () => {
    const { h, inp } = groundHand();
    h.onEvent({ type: 'ledge', kind: 'step', speed: 400, dy: 4 });
    h.update(1 / 120, inp);
    expect(h.state().pose).toBe('grip');
    for (let k = 0; k < 40; k++) h.update(1 / 120, inp);
    expect(h.state().pose).toBe('run');
    const yBefore = h.motion.y;
    h.onEvent({ type: 'ledge', kind: 'vault', speed: 400, dy: 30 });
    let maxY = yBefore;
    for (let k = 0; k < 20; k++) {
      h.update(1 / 120, inp);
      maxY = Math.max(maxY, h.motion.y);
      if (k === 0) expect(h.state().pose).toBe('flat');
    }
    expect(maxY - yBefore).toBeGreaterThan(0.02);
    const c = new ViewHand();
    c.setItem('can');
    c.onEvent({ type: 'ledge', kind: 'vault', speed: 400, dy: 30 });
    c.update(1 / 120, makeHandInput());
    expect(c.state().pose).toBe('grip');
  });

  it('Rutsch-Zustand fällt ohne slideEnd nach 0.25 s Luft weg (Absicherung) und beim Respawn', () => {
    const { h, inp } = groundHand();
    h.onEvent(SLIDE_START);
    inp.onGround = false;
    for (let k = 0; k < 40; k++) {
      inp.airTime = k / 120;
      h.update(1 / 120, inp);
    }
    expect(h.state().sliding).toBe(false);
    h.onEvent(SLIDE_START);
    h.onEvent({ type: 'respawn', reason: 'fall' });
    expect(h.state().sliding).toBe(false);
  });
});

describe('View-Hand: Reaktion aufs Training (Plan 007 KI9)', () => {
  const STAGE = (lessonDone: boolean): GameEvent => ({ type: 'lessonStage', index: 1, total: 4, rank: 'required', lessonDone });
  const HOP = (counted: boolean): GameEvent => ({ type: 'lessonHop', verdict: 'good', gain: 12, counted, count: 2, goal: 5 });

  function standing(motionFx = 1, item: 'none' | 'spinner' | 'coin' | 'phone' = 'none'): { h: ViewHand; inp: HandFrameInput } {
    const h = new ViewHand();
    h.motionFx = motionFx;
    h.setItem(item);
    const inp = makeHandInput();
    for (let k = 0; k < 120; k++) h.update(1 / 120, inp);
    return { h, inp };
  }

  /** Zeit (s) bis die Pose `pose` erscheint und wie lange sie hält (120 Hz). */
  function poseTiming(h: ViewHand, inp: HandFrameInput, pose: string): { after: number; held: number } {
    let after = -1;
    let held = 0;
    for (let k = 1; k <= 120 * 4; k++) {
      h.update(1 / 120, inp);
      if (h.state().pose === pose) {
        if (after < 0) after = k / 120;
        held += 1 / 120;
      } else if (after >= 0) break;
    }
    return { after, held };
  }

  it('Stufe geschafft → Faust binnen 0.1 s für ~0.6 s; Lektion fertig → Daumen hoch binnen 0.1 s für ~2.4 s', () => {
    for (const fps of [30, 60, 144]) {
      const { h, inp } = standing();
      h.onEvent(STAGE(false));
      let t = 0;
      while (h.state().pose !== 'fist' && t < 0.3) {
        h.update(1 / fps, inp);
        t += 1 / fps;
      }
      expect(t, `${fps} Hz`).toBeLessThanOrEqual(0.1);
    }
    const a = standing();
    a.h.onEvent(STAGE(false));
    const fist = poseTiming(a.h, a.inp, 'fist');
    expect(fist.after).toBeLessThanOrEqual(0.1);
    expect(fist.held).toBeGreaterThan(0.5);
    expect(fist.held).toBeLessThan(0.7);
    const b = standing();
    b.h.onEvent(STAGE(true));
    const up = poseTiming(b.h, b.inp, 'thumbsUp');
    expect(up.after).toBeLessThanOrEqual(0.1);
    expect(up.held).toBeGreaterThan(2.3);
    expect(up.held).toBeLessThan(2.5);
  });

  it('gezählter Hop = kleiner Ruck (ungezählter keiner); Stufe = Ruck wie am Checkpoint', () => {
    // Gegen eine Hand ohne Event (die Ruhe-Hand atmet leicht): größte Abweichung in y.
    const drop = (e: GameEvent): number => {
      const a = standing();
      const b = standing();
      a.h.onEvent(e);
      let d = 0;
      for (let k = 0; k < 60; k++) {
        a.h.update(1 / 120, a.inp);
        b.h.update(1 / 120, b.inp);
        d = Math.max(d, Math.abs(a.h.motion.y - b.h.motion.y));
      }
      return d;
    };
    const counted = drop(HOP(true));
    const notCounted = drop(HOP(false));
    const stage = drop(STAGE(false));
    expect(counted).toBeGreaterThan(0.002);
    expect(notCounted).toBeLessThan(1e-6);
    // Klein: deutlich schwächer als der Stufen-Ruck.
    expect(counted).toBeLessThan(stage);
  });

  it('mit Gegenstand: Stufe/Abschluss = Checkpoint ohne Referenz (Spinner schnippt, Münze Kopf, Handy vibriert — kein Foto)', () => {
    const sp = standing(1, 'spinner');
    sp.h.onEvent(STAGE(false));
    expect(sp.h.state().trick).not.toBe('none');
    expect(sp.h.state().pose).not.toBe('fist');
    const coin = standing(1, 'coin');
    coin.h.onEvent(STAGE(true));
    expect(coin.h.state().trick).toBe('call');
    for (let k = 0; k < 240; k++) coin.h.update(1 / 120, coin.inp);
    expect(coin.h.frame.propParam[0]).toBe(0);
    const ph = standing(1, 'phone');
    ph.h.onEvent(STAGE(true));
    expect(ph.h.state().trick).toBe('buzz');
    for (let k = 0; k < 360; k++) ph.h.update(1 / 120, ph.inp);
    expect(ph.h.takeShutter()).toBe(false);
  });

  it('mit JEDEM Gegenstand: Jubel sofort — auch mitten in einem Leerlauf-Trick (Abbruch am Frame-Ende wie das Ziel)', () => {
    // Review Phase 2: als Checkpoint verpuffte die Reaktion, sobald ein Trick lief (Dose/Karte/Messer nie).
    const stageTrick = (item: HeldItemId, h: ViewHand): string => {
      if (item === 'knife') return h.knife.isOpen ? 'close' : 'open';
      const t: Record<string, string> = { can: 'twirl', card: 'spin', spinner: 'flick', yoyo: 'around', lighter: 'strike', coin: 'call', kendama: 'smallCup', phone: 'buzz' };
      return t[item];
    };
    const doneTrick = (item: HeldItemId, h: ViewHand): string => {
      if (item === 'can') return h.can.opened ? 'sip' : 'behindThrow';
      const t: Record<string, string> = { card: 'vanish', knife: 'doubleAerial', spinner: 'ufo', yoyo: 'cradle', lighter: 'finale', coin: 'call', kendama: 'spike', phone: 'buzz' };
      return t[item];
    };
    const ITEMS: readonly HeldItemId[] = ['can', 'card', 'knife', 'spinner', 'yoyo', 'lighter', 'coin', 'kendama', 'phone'];
    for (const item of ITEMS) {
      for (const done of [false, true]) {
        const h = new ViewHand();
        h.setItem(item);
        const inp = makeHandInput();
        // Stehen, bis ein Leerlauf-Trick seit 0.1 s läuft (erster nach 2.2 s, Dose: vorher die Lasche).
        let k = 0;
        while (!(h.state().trick !== 'none' && h.state().trickTime > 0.1) && k < 120 * 8) {
          h.update(1 / 120, inp);
          k++;
        }
        const running = h.state().trick;
        expect(running, `${item}: läuft ein Leerlauf-Trick?`).not.toBe('none');
        const knifeWasOpen = item === 'knife' ? h.knife.isOpen : false;
        h.onEvent(STAGE(done));
        h.update(1 / 120, inp);
        const want = done ? doneTrick(item, h) : item === 'knife' ? (knifeWasOpen ? 'close' : 'open') : stageTrick(item, h);
        expect(h.state().trick, `${item} ${done ? 'Lektion' : 'Stufe'} (lief: ${running})`).toBe(want);
        expect(h.state().trickTime, `${item} beginnt bei Trick-Zeit 0`).toBe(0);
        for (let f = 0; f < 10; f++) h.update(1 / 120, inp);
        expect(h.state().trick, `${item} läuft weiter`).toBe(want);
        expect(h.state().pose, `${item}: mit Gegenstand keine Faust`).not.toBe('fist');
        if (item === 'phone') {
          for (let f = 0; f < 120 * 3; f++) h.update(1 / 120, inp);
          expect(h.takeShutter(), 'kein Selfie in der Lektion').toBe(false);
        }
      }
    }
  });

  it('motionFx 0: nur die Pose wechselt, keine Bewegung (kein Ruck, kein Versatz)', () => {
    const { h, inp } = standing(0);
    h.onEvent(STAGE(false));
    h.onEvent(HOP(true));
    for (let k = 0; k < 12; k++) {
      h.update(1 / 120, inp);
      expect(h.motion.x).toBe(0);
      expect(h.motion.y).toBe(0);
      expect(h.motion.tilt).toBe(0);
      expect(h.motion.squash).toBe(1);
    }
    expect(h.state().pose).toBe('fist');
    h.onEvent(STAGE(true));
    h.update(1 / 120, inp);
    expect(h.state().pose).toBe('thumbsUp');
    expect(h.motion.y).toBe(0);
  });
});
