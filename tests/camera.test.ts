import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { compileLevel, type CompiledLevel } from '../src/world/level/compileLevel';
import type { BrushDef } from '../src/world/level/LevelFormat';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { lerpSnapshot } from '../src/player/interpolate';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import { NO_INPUT, type MovementEvent, type PlayerInput, type PlayerSnapshot } from '../src/player/types';
import { StrafeBot } from '../src/player/bots';
import { box, flatLevel, makeLevel, readLevelFile } from '../tools/sim/levels';
import {
  CameraRig,
  DEFAULT_CAMERA_SETTINGS,
  cameraViewFromSnapshot,
  landDipDepth,
  makeCameraView,
  softCapFov,
  speedFovKick,
  verticalFovFromHorizontal43,
  type CameraRigSettings,
  type MutableCameraView,
} from '../src/player/CameraRig';

const DEG = Math.PI / 180;
/** Alle abschaltbaren Effekte aus (Stufen- und Duck-Glättung bleiben — Ruck-Schutz). */
const OFF: CameraRigSettings = { headBob: 0, screenShake: 0, fovKick: 0, fov: 90, motionFx: 0 };
const FRAME = 1 / 144;

function rig(settings: CameraRigSettings = DEFAULT_CAMERA_SETTINGS, aspect = 16 / 9): { cam: PerspectiveCamera; rig: CameraRig } {
  const cam = new PerspectiveCamera(70, aspect);
  const r = new CameraRig(cam);
  r.setSettings(settings);
  r.setAspect(aspect);
  return { cam, rig: r };
}

function view(patch: Partial<MutableCameraView> = {}): MutableCameraView {
  return Object.assign(makeCameraView(), patch);
}

/** Horizontales FOV bei 4:3 (Grad) aus der Kamera (Breitbild ≥ 4:3). */
function hfov43(cam: PerspectiveCamera): number {
  return (2 * Math.atan(Math.tan((cam.fov * DEG) / 2) / 0.75)) / DEG;
}

/** Horizontales FOV (Grad) im Bildformat der Kamera. */
function hfovAspect(cam: PerspectiveCamera): number {
  return (2 * Math.atan(Math.tan((cam.fov * DEG) / 2) * cam.aspect)) / DEG;
}

/** Läuft `seconds` mit gegebener View; stridePhase wandert wie beim Laufen mit. */
function simulate(r: CameraRig, v: MutableCameraView, seconds: number, yaw = 0, pitch = 0, each?: () => void): void {
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) {
    if (v.onGround && v.speed > 0) v.stridePhase = (v.stridePhase + (v.speed * FRAME) / 150) % 1;
    r.update(FRAME, v, yaw, pitch);
    each?.();
  }
}

const JUMP_PERFECT = (gain = 30): MovementEvent => ({ type: 'jump', speed: 800, gain, perfect: true, clean: true, chain: 5, sync: 0.9, crouched: false, coyote: false });
const JUMP_MISSED: MovementEvent = { type: 'jump', speed: 300, gain: -20, perfect: false, clean: false, chain: 2, sync: 0.5, crouched: false, coyote: false };
const land = (impact: number, jumpQueued = false): MovementEvent => ({ type: 'land', impact, speed: 500, airTime: 0.8, jumpQueued });

describe('FOV (Hor+)', () => {
  it('90° horizontal bei 4:3 → 73.74° vertikal, unabhängig vom Breitbild', () => {
    expect(verticalFovFromHorizontal43(90, 4 / 3)).toBeCloseTo(73.74, 2);
    expect(verticalFovFromHorizontal43(90, 16 / 9)).toBeCloseTo(73.74, 2);
    expect(verticalFovFromHorizontal43(90, 21 / 9)).toBeCloseTo(73.74, 2);
    // Hochkant: horizontal bleibt 90°
    expect(verticalFovFromHorizontal43(90, 1)).toBeCloseTo(90, 6);
    const { cam } = rig(OFF);
    expect(cam.fov).toBeCloseTo(73.74, 2);
    expect(cam.aspect).toBeCloseTo(16 / 9, 9);
    // effektiv horizontal bei 16:9: 106.26°
    const h = 2 * Math.atan(Math.tan((cam.fov * DEG) / 2) * cam.aspect);
    expect(h / DEG).toBeCloseTo(106.26, 1);
  });

  it('near 1–2 u, far ≥ 20000', () => {
    const { cam } = rig();
    expect(cam.near).toBeGreaterThanOrEqual(1);
    expect(cam.near).toBeLessThanOrEqual(2);
    expect(cam.far).toBeGreaterThanOrEqual(20000);
    expect(cam.rotation.order).toBe('YXZ');
  });
});

describe('Effekte bei Einstellung 0 exakt aus', () => {
  it('Position = Auge, Rotation = Blick, FOV = Basis — bei Laufen, Landen, perfektem Hop, Surfen mit Rumpeln, 1200 u/s', () => {
    const { cam, rig: r } = rig(OFF);
    const v = view({ eyePos: new Vector3(10, 64, -20), speed: 250, vel: new Vector3(250, 0, 0), onGround: true, sprinting: true });
    const check = (yaw: number, pitch: number): void => {
      expect(cam.position.x).toBe(v.eyePos.x);
      expect(cam.position.y).toBe(v.eyePos.y);
      expect(cam.position.z).toBe(v.eyePos.z);
      expect(cam.rotation.x).toBe(pitch);
      expect(cam.rotation.y).toBe(yaw);
      expect(cam.rotation.z === 0).toBe(true); // -0 zählt auch
      expect(cam.fov).toBeCloseTo(73.7398, 3);
    };
    simulate(r, v, 1, 0.4, -0.2, () => check(0.4, -0.2));
    r.onEvent(land(900));
    r.onEvent(JUMP_PERFECT());
    r.onEvent(land(1400));
    Object.assign(v, { onGround: false, surfing: true, surfNormal: new Vector3(0.8, 0.6, 0), strafeInput: 1, speed: 1200, vel: new Vector3(0, -100, -1200) });
    simulate(r, v, 1, 1.1, 0.3, () => check(1.1, 0.3));
    // Rutschen (Plan 007): kein Rumpeln, kein Roll.
    Object.assign(v, { onGround: true, surfing: false, surfNormal: new Vector3(), sliding: true, speed: 900, vel: new Vector3(0, 0, -900) });
    simulate(r, v, 1, 0.2, 0, () => check(0.2, 0));
  });
});

describe('Einzelne Schalter auf 0 (Runde 2): headBob, motionFx, fovKick exakt aus', () => {
  it('fovKick 0: FOV = Basis bit-genau bei 1800 u/s, perfektem Strafe und Pops (16:9)', () => {
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, fovKick: 0 }, 16 / 9);
    const base = verticalFovFromHorizontal43(90, 16 / 9);
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: false, speed: 1800, vel: new Vector3(0, 0, -1800) });
    for (let i = 0; i < 600; i++) {
      v.speed += ((24 * 24 * 128) / (2 * v.speed)) * FRAME;
      if (i % 100 === 99) r.onEvent(JUMP_PERFECT(40));
      r.update(FRAME, v, 0, 0);
      expect(cam.fov).toBe(base);
      expect(r.fxState.fovOffset).toBe(0);
    }
  });

  it('headBob 0 (Rest voll an): Laufen am Boden → Position exakt das Auge', () => {
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
    const v = view({ eyePos: new Vector3(5, 64, 7), onGround: true, speed: 320, vel: new Vector3(0, 0, -320), sprinting: true });
    simulate(r, v, 2, 0.3, 0.1, () => {
      expect(cam.position.x).toBe(v.eyePos.x);
      expect(cam.position.y).toBe(v.eyePos.y);
      expect(cam.position.z).toBe(v.eyePos.z);
      expect(cam.rotation.x).toBe(0.1);
    });
  });

  it('motionFx 0 (Bob und Shake aus, FOV-Kick an): kein Dip, Pop, Roll, Surge, Lean — auch bei 1200 u/s und Surf', () => {
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, motionFx: 0, headBob: 0, screenShake: 0 });
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true, speed: 250, vel: new Vector3(0, 0, -250) });
    const check = (): void => {
      expect(cam.position.equals(v.eyePos)).toBe(true);
      expect(cam.rotation.z === 0).toBe(true);
      expect(r.fxState.pop).toBe(0);
      expect(r.fxState.surge).toBe(0);
      expect(r.fxState.fovOffset).toBe(softCapFov(r.fxState.speedKick));
    };
    simulate(r, v, 0.5, 0, 0, check);
    r.onEvent(land(900));
    simulate(r, v, 0.3, 0, 0, check);
    r.onEvent(land(300));
    r.onEvent(JUMP_PERFECT(40));
    Object.assign(v, { onGround: false, speed: 1200, vel: new Vector3(-300, 0, -1160) });
    simulate(r, v, 0.5, 0.5, 0, () => {
      v.speed += 40 * FRAME;
      check();
    });
    Object.assign(v, { surfing: true, surfNormal: new Vector3(0.7, 0.714, 0) });
    simulate(r, v, 0.5, 0, 0, check);
  });
});

describe('Blick unverzögert', () => {
  it('Yaw geht exakt durch, Pitch nur mit winzigen Effekt-Offsets — auch bei Sprüngen im Blick', () => {
    const { cam, rig: r } = rig(DEFAULT_CAMERA_SETTINGS);
    const v = view({ eyePos: new Vector3(0, 64, 0), speed: 250, vel: new Vector3(0, 0, -250), onGround: true });
    let yaw = 0;
    let pitch = 0;
    for (let i = 0; i < 300; i++) {
      yaw = i % 50 === 0 ? yaw + 1.3 : yaw + 0.01; // Flicks
      pitch = Math.sin(i * 0.1) * 0.8;
      v.stridePhase = (v.stridePhase + 0.01) % 1;
      r.update(FRAME, v, yaw, pitch);
      expect(cam.rotation.y).toBe(yaw);
      expect(Math.abs(cam.rotation.x - pitch)).toBeLessThan(0.5 * DEG);
    }
  });
});

describe('Head-Bob', () => {
  it('im Stand 0, beim Laufen ~1–1.5 u vertikal, in der Luft ausgeblendet, geduckt halb', () => {
    const measure = (patch: Partial<MutableCameraView>, seconds = 1): number => {
      const { cam, rig: r } = rig();
      const v = view({ eyePos: new Vector3(0, 64, 0), ...patch });
      simulate(r, v, 0.5);
      let lo = Infinity;
      let hi = -Infinity;
      simulate(r, v, seconds, 0, 0, () => {
        lo = Math.min(lo, cam.position.y);
        hi = Math.max(hi, cam.position.y);
      });
      return hi - lo;
    };
    expect(measure({ speed: 0, onGround: true })).toBe(0);
    const run = measure({ speed: 250, vel: new Vector3(0, 0, -250), onGround: true });
    expect(run).toBeGreaterThan(1.0);
    expect(run).toBeLessThan(1.5);
    const sprint = measure({ speed: 320, vel: new Vector3(0, 0, -320), onGround: true });
    expect(sprint).toBeGreaterThan(run);
    expect(sprint).toBeLessThanOrEqual(1.5 + 1e-9);
    // Geduckt: Augenhöhe 46 (Ende des Duck-Wegs → keine Duck-Glättung), Bob halb.
    const ducked = measure({ speed: 250, vel: new Vector3(0, 0, -250), onGround: true, ducked: true, eyeHeight: 46, eyePos: new Vector3(0, 46, 0) });
    expect(ducked).toBeCloseTo(run / 2, 1);

    // Abheben: Bob klingt schnell ab
    const { cam, rig: r } = rig();
    const v = view({ eyePos: new Vector3(0, 64, 0), speed: 250, vel: new Vector3(0, 0, -250), onGround: true });
    simulate(r, v, 0.5);
    v.onGround = false;
    simulate(r, v, 0.5);
    const y0 = cam.position.y;
    v.stridePhase = 0.25;
    r.update(FRAME, v, 0, 0);
    expect(Math.abs(cam.position.y - y0)).toBeLessThan(0.02);
  });
});

describe('FOV-Kick (C1): Log-Kurve relativ zu runSpeed, kein Sprint-Term', () => {
  it('speedFovKick: 320 → 2.1°, 500 → 6°, 1000 → 12°, bis 250 → 0, gekappt', () => {
    expect(speedFovKick(0)).toBe(0);
    expect(speedFovKick(250)).toBe(0);
    expect(Math.abs(speedFovKick(320) - 2.1)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(speedFovKick(500) - 6)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(speedFovKick(1000) - 12)).toBeLessThanOrEqual(0.5);
    // Jede Verdopplung gleich viel, bis zur Kappe
    expect(speedFovKick(800) - speedFovKick(400)).toBeCloseTo(6, 6);
    expect(speedFovKick(3000)).toBeLessThanOrEqual(16);
  });

  it('im Rig: Gleichgewicht = Kurve, hoch ~0.2 s, runter ~0.6 s; fovKick 0 → exakt 90° auch mit Pop und Surge', () => {
    // Kernband 300–800: exakt die Log-Kurve; darüber weich gesättigt (Runde 2).
    for (const speed of [320, 500, 800, 1000]) {
      const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, motionFx: 0 }, 4 / 3);
      const v = view({ eyePos: new Vector3(0, 64, 0), onGround: false, speed });
      simulate(r, v, 3);
      expect(hfov43(cam) - 90).toBeCloseTo(softCapFov(speedFovKick(speed)), 2);
      if (speed <= 800) expect(softCapFov(speedFovKick(speed))).toBe(speedFovKick(speed));
    }
    const up = rig(DEFAULT_CAMERA_SETTINGS, 4 / 3);
    const vu = view({ eyePos: new Vector3(0, 64, 0), onGround: false, speed: 1000 });
    simulate(up.rig, vu, 0.2);
    const down = rig(DEFAULT_CAMERA_SETTINGS, 4 / 3);
    const vd = view({ eyePos: new Vector3(0, 64, 0), onGround: false, speed: 1000 });
    simulate(down.rig, vd, 3);
    const full = hfov43(down.cam) - 90;
    vd.speed = 0;
    simulate(down.rig, vd, 0.2);
    expect((hfov43(up.cam) - 90) / full).toBeGreaterThan(0.5);
    expect((hfov43(down.cam) - 90) / full).toBeGreaterThan(0.6); // nach 0.2 s noch > 60 % da

    const off = rig({ ...DEFAULT_CAMERA_SETTINGS, fovKick: 0 }, 4 / 3);
    const vo = view({ eyePos: new Vector3(0, 64, 0), onGround: false, speed: 400, vel: new Vector3(0, 0, -400) });
    for (let i = 0; i < 300; i++) {
      vo.speed += 60 * FRAME; // Surge-würdige Gewinnrate
      if (i % 100 === 50) off.rig.onEvent(JUMP_PERFECT());
      off.rig.update(FRAME, vo, 0, 0);
      expect(off.cam.fov).toBe(verticalFovFromHorizontal43(90, 4 / 3));
    }
  });

  it('Sprint am Boden → Absprung: FOV fällt nicht (heute 92.0 → 90.8)', () => {
    const { cam, rig: r } = rig(DEFAULT_CAMERA_SETTINGS, 4 / 3);
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true, speed: 320, vel: new Vector3(0, 0, -320), sprinting: true });
    simulate(r, v, 2);
    const atJump = hfov43(cam);
    expect(atJump - 90).toBeCloseTo(speedFovKick(320), 2);
    r.onEvent({ type: 'jump', speed: 320, gain: 0, perfect: false, clean: false, chain: 1, sync: 0, crouched: false, coyote: false });
    v.onGround = false;
    let min = Infinity;
    simulate(r, v, 1, 0, 0, () => {
      v.speed += 60 * FRAME; // leicht beschleunigen wie beim ersten Strafe
      min = Math.min(min, hfov43(cam));
    });
    expect(atJump - min).toBeLessThanOrEqual(0.2);
  });

  it('Gesamtkappe: Speed + Pop + Surge bleibt ≤ 11° (4:3) = 116.5° bei 16:9, auch bei 1800 u/s und perfektem Strafe', () => {
    const { cam, rig: r } = rig(DEFAULT_CAMERA_SETTINGS, 16 / 9);
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: false, speed: 1800, vel: new Vector3(0, 0, -1800) });
    let max = 0;
    for (let i = 0; i < 1000; i++) {
      v.speed += (24 * 24 * 128) / (2 * v.speed) * FRAME; // theoretisch maximaler Gewinn
      if (i % 100 === 99) r.onEvent(JUMP_PERFECT(40));
      r.update(FRAME, v, 0, 0);
      max = Math.max(max, hfov43(cam) - 90);
    }
    expect(r.fxState.surge).toBeGreaterThan(2);
    expect(max).toBeGreaterThan(10.9);
    expect(max).toBeLessThanOrEqual(11 + 1e-9);
    expect(hfovAspect(cam)).toBeLessThanOrEqual(116.6);
    expect(cam.fov).toBeLessThanOrEqual(84.6);
  });

  it('Kappe greift erst oben: Log-Kurve 300–800 exakt, bei 500 u/s addieren Pop und Surge ungekappt; monoton und stetig', () => {
    for (let sp = 300; sp <= 800; sp += 10) expect(softCapFov(speedFovKick(sp))).toBe(speedFovKick(sp));
    // 500 u/s mit vollem Surge (2.5°) und Pop (1.2°) liegt noch unter dem Knie.
    const k500 = speedFovKick(500) + 2.5 + 1.2;
    expect(softCapFov(k500)).toBe(k500);
    let prev = 0;
    for (let k = 0; k <= 30; k += 0.01) {
      const c = softCapFov(k);
      expect(c).toBeGreaterThanOrEqual(prev);
      expect(c - prev).toBeLessThanOrEqual(0.0100001);
      expect(c).toBeLessThanOrEqual(11);
      prev = c;
    }
    // 1000 u/s liest sich noch schneller als 800.
    expect(softCapFov(speedFovKick(1000)) - softCapFov(speedFovKick(800))).toBeGreaterThan(0.8);
  });
});

describe('Perfekter Hop (C2): Pop statt Dip', () => {
  it('Landung + perfekter Sprung im Folgetick: kein Dip, kein Nicken, Pop 0.6–1.2° mit kurzem Anstieg', () => {
    for (const [gain, lo, hi] of [[0, 0.59, 0.61], [15, 0.89, 0.91], [60, 1.19, 1.21]] as const) {
      for (const sameFrame of [true, false]) {
        const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 }, 4 / 3);
        const v = view({ eyePos: new Vector3(0, 64, 0), onGround: false, speed: 0 });
        simulate(r, v, 0.2);
        const base = hfov43(cam);
        r.onEvent(land(650, sameFrame)); // Abstiegs-Aufprall
        v.onGround = true;
        if (!sameFrame) r.update(FRAME, v, 0, 0); // Sprung erst im nächsten Frame (144 Hz)
        r.onEvent(JUMP_PERFECT(gain));
        v.onGround = false;
        let peak = 0;
        let firstFrame = -1;
        simulate(r, v, 0.5, 0, 0, () => {
          expect(cam.position.y).toBe(64);
          expect(cam.rotation.x).toBe(0);
          const d = hfov43(cam) - base;
          if (firstFrame < 0) firstFrame = d;
          peak = Math.max(peak, d);
        });
        expect(peak).toBeGreaterThan(lo);
        expect(peak).toBeLessThan(hi);
        expect(firstFrame).toBeLessThan(0.7 * peak); // kein 1-Frame-Sprung
        expect(hfov43(cam) - base).toBeLessThan(0.05); // klingt ab (τ 0.12 s)
      }
    }
  });

  it('Landung ohne Sprung: voller Dip nach ≤ 2 Frames; verpatzter Hop behält ihn (> 3 u bei Aufprall 300)', () => {
    for (const hz of [60, 144, 240]) {
      const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
      const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true });
      r.update(1 / hz, v, 0, 0);
      r.onEvent(land(300));
      r.update(1 / hz, v, 0, 0); // Frame des Land-Ticks: noch nichts
      expect(cam.position.y).toBe(64);
      let started = -1;
      let max = 0;
      for (let i = 1; i < hz * 0.4; i++) {
        if (i === 3) r.onEvent(JUMP_MISSED); // Sprung nach Friction-Ticks
        r.update(1 / hz, v, 0, 0);
        if (started < 0 && cam.position.y < 64) started = i;
        max = Math.max(max, 64 - cam.position.y);
      }
      expect(started).toBeGreaterThan(0);
      expect(started).toBeLessThanOrEqual(2);
      expect(max).toBeGreaterThan(3);
    }
  });

  const flat = compileLevel(flatLevel(8192));

  /** PlayerMovement + Loop + Interpolation + Rig; Treiber bekommt den Zustand vor dem Tick. */
  function playDriven(level: CompiledLevel, start: Vector3, driver: (s: PlayerSnapshot) => PlayerInput, hz: number, seconds: number, settings: CameraRigSettings, startVel?: Vector3): { cam: number[]; eye: number[]; fov: number[]; jumps: { perfect: boolean; frame: number }[]; surge: number[]; roll: number[]; speed: number[]; air: boolean[] } {
    const cfg = VELOCITY_DEFAULT;
    const pm = new PlayerMovement(level.world, cfg);
    pm.teleport(start);
    if (startVel) pm.state.vel.copy(startVel);
    const prev = PlayerMovement.createSnapshot();
    const curr = PlayerMovement.createSnapshot();
    const interp = PlayerMovement.createSnapshot();
    pm.copySnapshot(prev);
    pm.copySnapshot(curr);
    const { cam, rig: r } = rig(settings, 4 / 3);
    r.setMovement(cfg);
    const v = makeCameraView();
    const tickDt = 1 / cfg.tickRate;
    let acc = 0;
    let last: PlayerInput = NO_INPUT;
    const out = { cam: [] as number[], eye: [] as number[], fov: [] as number[], jumps: [] as { perfect: boolean; frame: number }[], surge: [] as number[], roll: [] as number[], speed: [] as number[], air: [] as boolean[] };
    for (let f = 0; f < Math.round(hz * seconds); f++) {
      acc += 1 / hz;
      while (acc >= tickDt) {
        pm.copySnapshot(prev);
        last = driver(pm.state);
        for (const e of pm.tick(last)) {
          r.onEvent(e);
          if (e.type === 'jump') out.jumps.push({ perfect: e.perfect, frame: f });
        }
        pm.copySnapshot(curr);
        acc -= tickDt;
      }
      lerpSnapshot(prev, curr, acc / tickDt, interp);
      cameraViewFromSnapshot(interp, last.sprint, last.side, v);
      r.update(1 / hz, v, last.yaw, 0);
      out.cam.push(cam.position.y);
      out.eye.push(v.eyePos.y);
      out.fov.push(hfov43(cam));
      out.surge.push(r.fxState.surge);
      out.roll.push(r.fxState.roll);
      out.speed.push(v.speed);
      out.air.push(!v.onGround);
    }
    return out;
  }

  it('Integration: Auto-Hop-Kette → |Kamera − Auge| < 1 u in jedem Frame, jeder perfekte Hop poppt (60/144 Hz)', () => {
    const input: PlayerInput = { ...NO_INPUT, forward: 1, sprint: true, jumpHeld: true, jumpPressed: true };
    for (const hz of [60, 144]) {
      const res = playDriven(flat, new Vector3(0, 0, 4000), () => input, hz, 6, DEFAULT_CAMERA_SETTINGS);
      const perfect = res.jumps.filter((j) => j.perfect);
      expect(perfect.length).toBeGreaterThanOrEqual(5);
      const first = perfect[0].frame;
      for (let i = first; i < res.cam.length; i++) expect(Math.abs(res.cam[i] - res.eye[i]), `Frame ${i} @${hz} Hz`).toBeLessThan(1);
      for (const j of perfect) {
        const w = res.fov.slice(j.frame, j.frame + Math.round(hz * 0.15));
        const before = res.fov[j.frame - 1];
        expect(Math.max(...w) - before).toBeGreaterThan(0.5);
      }
    }
  });

  it('Integration: frisch gedrückt genau im Tick nach der Landung (kein Puffer, jumpQueued=false) → ebenfalls kein Dip', () => {
    for (const hz of [30, 60, 144]) {
      // Druck nur am Boden (in der Luft losgelassen) → im Land-Tick nichts gepuffert.
      const driver = (s: PlayerSnapshot): PlayerInput => ({ ...NO_INPUT, forward: 1, sprint: true, jumpHeld: s.onGround, jumpPressed: s.onGround });
      const res = playDriven(flat, new Vector3(0, 0, 4000), driver, hz, 5, { ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
      const perfect = res.jumps.filter((j) => j.perfect);
      expect(perfect.length).toBeGreaterThanOrEqual(4);
      for (let i = perfect[0].frame; i < res.cam.length; i++) expect(Math.abs(res.cam[i] - res.eye[i]), `Frame ${i} @${hz} Hz`).toBeLessThan(1e-6);
    }
  });

  it('Sync-Surge (C3): perfekter Strafe ≥ 2° im Band 250–600 u/s, 3°-Hand ≤ 0.8°; nach Strafe-Stopp < 0.5° in ≤ 0.15 s', () => {
    const band = (res: ReturnType<typeof playDriven>): number[] => res.surge.filter((_, i) => res.air[i] && res.speed[i] >= 250 && res.speed[i] < 600);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const perfectBot = new StrafeBot(VELOCITY_DEFAULT, { mode: 'zigzag', sync: 1 });
    const perfect = playDriven(flat, new Vector3(0, 0, 0), (s) => perfectBot.next(s), 60, 8, DEFAULT_CAMERA_SETTINGS, new Vector3(0, 0, -320));
    const humanBot = new StrafeBot(VELOCITY_DEFAULT, { mode: 'zigzag', sync: 1, aimNoiseDeg: 3, seed: 5 });
    const human = playDriven(flat, new Vector3(0, 0, 0), (s) => humanBot.next(s), 60, 20, DEFAULT_CAMERA_SETTINGS, new Vector3(0, 0, -320));
    expect(band(perfect).length).toBeGreaterThan(60);
    expect(mean(band(perfect))).toBeGreaterThanOrEqual(2);
    expect(mean(band(human))).toBeLessThanOrEqual(0.8);

    // Strafe-Stopp mitten im Flug (ab Hop 6): keine Tasten, Maus still.
    const bot = new StrafeBot(VELOCITY_DEFAULT, { mode: 'zigzag', sync: 1 });
    let hops = 0;
    let wasGround = true;
    let stopped = false;
    let hold = 0;
    const res = playDriven(flat, new Vector3(0, 0, 0), (s) => {
      if (s.onGround && !wasGround) hops++;
      wasGround = s.onGround;
      const inp = bot.next(s);
      if (!stopped && hops >= 6 && !s.onGround && s.airTime > 0.3) {
        stopped = true;
        hold = inp.yaw;
      }
      return stopped ? { ...NO_INPUT, yaw: hold } : inp;
    }, 60, 8, DEFAULT_CAMERA_SETTINGS, new Vector3(0, 0, -320));
    // Stopp-Frame: erster Frame, ab dem der Speed nicht mehr steigt
    let stopFrame = -1;
    for (let i = 1; i < res.speed.length; i++) if (res.air[i] && res.surge[i - 1] > 2 && res.speed[i] === res.speed[i - 1] && res.speed[i + 1] === res.speed[i]) { stopFrame = i; break; }
    expect(stopFrame).toBeGreaterThan(0);
    const below = res.surge.findIndex((s, i) => i >= stopFrame && s < 0.5);
    expect((below - stopFrame) / 60).toBeLessThanOrEqual(0.15);
  });

  it('Carve-Roll (C4) in der Bhop-Kette: |roll| p50 2–3°, Vorzeichen folgt der Kurve', () => {
    const bot = new StrafeBot(VELOCITY_DEFAULT, { mode: 'zigzag', sync: 1 });
    const res = playDriven(flat, new Vector3(0, 0, 0), (s) => bot.next(s), 60, 10, DEFAULT_CAMERA_SETTINGS, new Vector3(0, 0, -320));
    const air = res.roll.filter((_, i) => res.air[i]).map(Math.abs).sort((a, b) => a - b);
    const p50 = air[Math.floor(air.length / 2)];
    expect(p50).toBeGreaterThanOrEqual(2);
    expect(p50).toBeLessThanOrEqual(3);
  });
});

describe('Lande-Dip & Shake (C6)', () => {
  /** Dip ohne Shake-Anteil (screenShake 0), sofern nicht anders gewünscht. */
  function dipCurve(impact: number, settings: CameraRigSettings = { ...DEFAULT_CAMERA_SETTINGS, screenShake: 0 }): { max: number; after: number; maxNodDeg: number; rollOrYawDev: number } {
    const { cam, rig: r } = rig(settings);
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true });
    r.update(FRAME, v, 0, 0);
    r.onEvent(land(impact));
    let max = 0;
    let maxNod = 0;
    let dev = 0;
    for (let t = 0; t < 0.3; t += FRAME) {
      r.update(FRAME, v, 0, 0);
      max = Math.max(max, 64 - cam.position.y);
      maxNod = Math.max(maxNod, -cam.rotation.x / DEG);
      dev = Math.max(dev, Math.abs(cam.rotation.y), Math.abs(cam.rotation.z));
    }
    return { max, after: 64 - cam.position.y, maxNodDeg: maxNod, rollOrYawDev: dev };
  }

  it('weich fast nichts, Sprung-Landung ~3 u, 600 u/s ≈ 8 u, weich gesättigt ≤ 14 u, zurück in ~0.3 s', () => {
    expect(dipCurve(100).max).toBeLessThan(0.05);
    const bhop = dipCurve(300);
    expect(bhop.max).toBeGreaterThan(3);
    expect(bhop.max).toBeLessThan(3.5);
    const hard = dipCurve(600);
    expect(hard.max).toBeGreaterThan(7);
    expect(hard.max).toBeLessThan(9);
    expect(hard.after).toBeLessThan(1.5);
    expect(hard.maxNodDeg).toBeLessThanOrEqual(1.5);
    expect(dipCurve(3000).max).toBeLessThanOrEqual(14 + 1e-6);
  });

  it('harte Landungen bleiben unterscheidbar: Dip(1400) ≥ Dip(800) + 1 u', () => {
    expect(landDipDepth(1400)).toBeGreaterThanOrEqual(landDipDepth(800) + 1);
    expect(dipCurve(1400).max).toBeGreaterThanOrEqual(dipCurve(800).max + 1);
  });

  it('Screenshake nur als Translation: Yaw und Pitch exakt der Blick; Aufprall 650 rumpelt ≥ 0.12 s mit ≥ 0.6 u; klingt ganz ab', () => {
    expect(dipCurve(500, DEFAULT_CAMERA_SETTINGS).rollOrYawDev).toBe(0); // unter der Schwelle kein Shake
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0, motionFx: 0 });
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true });
    r.update(FRAME, v, 0.7, -0.1);
    r.onEvent(land(650));
    let moved = 0;
    let t = 0;
    let envOk = 0;
    for (; t < 1; t += FRAME) {
      r.update(FRAME, v, 0.7, -0.1);
      expect(cam.rotation.y).toBe(0.7);
      expect(cam.rotation.x).toBe(-0.1);
      expect(Math.abs(cam.rotation.z)).toBeLessThan(0.3 * DEG + 1e-12);
      moved = Math.max(moved, cam.position.distanceTo(v.eyePos));
      if (r.fxState.shake >= 0.6) envOk = t;
    }
    // ≥ 0.6 u Hüllkurve ≈ 1 Low-Res-px am unteren Bildrand (Boden in ~107 u, 270 Zeilen)
    expect(envOk).toBeGreaterThanOrEqual(0.12);
    expect(moved).toBeGreaterThan(0.5);
    expect(cam.position.toArray()).toEqual([0, 64, 0]);
  });
});

describe('Roll (C4 Carve, C5 Surf-Lean)', () => {
  /** Fliegt mit |v| = speed eine Kurve mit Querbeschleunigung aLat (+ = rechts). */
  function carve(aLat: number, speed = 700, seconds = 1, patch: Partial<MutableCameraView> = {}): { roll: number; cam: PerspectiveCamera } {
    const { cam, rig: r } = rig();
    const v = view({ eyePos: new Vector3(0, 200, 0), onGround: false, speed, ...patch });
    let heading = 0;
    const omega = aLat / speed;
    for (let i = 0; i < Math.round(seconds / FRAME); i++) {
      heading -= omega * FRAME; // Rechtskurve: Yaw nimmt ab
      v.vel.set(-Math.sin(heading) * speed, 0, -Math.cos(heading) * speed);
      r.update(FRAME, v, heading, 0);
    }
    return { roll: -cam.rotation.z / DEG, cam };
  }

  it('Luft: Roll folgt der Kurve — rechts = rechts neigen, voll 2.5° bei airSpeedCap·tickRate, halb bei halber', () => {
    const full = VELOCITY_DEFAULT.airSpeedCap * VELOCITY_DEFAULT.tickRate;
    expect(carve(full).roll).toBeCloseTo(2.5, 2);
    expect(carve(-full).roll).toBeCloseTo(-2.5, 2);
    expect(carve(full / 2).roll).toBeCloseTo(1.25, 2);
    expect(Math.abs(carve(3 * full).roll)).toBeLessThanOrEqual(2.5 + 1e-9);
  });

  it('A/D ohne Kurve (W+A ohne Maus): |roll| < 0.1°', () => {
    for (const strafeInput of [-1, 1]) expect(Math.abs(carve(0, 700, 1, { strafeInput }).roll)).toBeLessThan(0.1);
  });

  it('Boden: Quergeschwindigkeit, ≤ 0.7°', () => {
    const { cam, rig: r } = rig();
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true, speed: 250, vel: new Vector3(250, 0, 0), strafeInput: 1 });
    simulate(r, v, 1);
    const roll = -cam.rotation.z / DEG;
    expect(roll).toBeGreaterThan(0.5);
    expect(roll).toBeLessThanOrEqual(0.7 + 1e-9);
  });

  it('Surf: Kamera-Oben kippt zur Rampennormale (45° → 5.4°), A/D-Tipps ändern nichts (Std < 0.5°)', () => {
    const a = 45 * DEG;
    for (const side of [1, -1]) {
      const { cam, rig: r } = rig();
      // yaw 0 → rechts = +x; Rampe links (Normale zeigt nach rechts) bei side = 1
      const v = view({ eyePos: new Vector3(0, 200, 0), onGround: false, surfing: true, surfNormal: new Vector3(side * Math.sin(a), Math.cos(a), 0), speed: 900, vel: new Vector3(0, -50, -900) });
      simulate(r, v, 1);
      const rolls: number[] = [];
      simulate(r, v, 1, 0, 0, () => {
        v.strafeInput = Math.floor(rolls.length / 7) % 2 === 0 ? -1 : 1; // Tipps alle ~50 ms
        rolls.push(-cam.rotation.z / DEG);
      });
      const m = rolls.reduce((x, y) => x + y, 0) / rolls.length;
      const std = Math.sqrt(rolls.reduce((x, y) => x + (y - m) ** 2, 0) / rolls.length);
      expect(m).toBeCloseTo(side * 0.12 * 45, 1);
      expect(std).toBeLessThan(0.5);
    }
  });

  it('Surf-Rumpeln: nur Translation (Yaw/Pitch exakt), 0.3–0.8 u, Ziel in 500 u wandert < 0.1°', () => {
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
    const n = new Vector3(0.866, 0.5, 0);
    const v = view({ eyePos: new Vector3(0, 200, 0), onGround: false, surfing: true, surfNormal: n, speed: 1500, vel: new Vector3(0, 0, -1500) });
    const yaw = 0.3;
    const pitch = -0.2;
    const fwd = new Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    const target = v.eyePos.clone().addScaledVector(fwd, 500);
    let maxDrift = 0;
    let maxAmp = 0;
    const a = new Vector3();
    const b = new Vector3();
    simulate(r, v, 2, yaw, pitch, () => {
      expect(cam.rotation.y).toBe(yaw);
      expect(cam.rotation.x).toBe(pitch);
      a.copy(target).sub(v.eyePos).normalize();
      b.copy(target).sub(cam.position).normalize();
      maxDrift = Math.max(maxDrift, a.angleTo(b) / DEG);
      maxAmp = Math.max(maxAmp, cam.position.distanceTo(v.eyePos));
    });
    expect(r.fxState.rumble).toBeCloseTo(0.8, 6);
    expect(maxAmp).toBeGreaterThan(0.3);
    expect(maxDrift).toBeLessThan(0.1);
    // Langsam (unter ~330 u/s) kein Rumpeln
    const slow = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
    const vs = view({ eyePos: new Vector3(0, 200, 0), onGround: false, surfing: true, surfNormal: n, speed: 320, vel: new Vector3(0, 0, -320) });
    simulate(slow.rig, vs, 0.5);
    expect(slow.rig.fxState.rumble).toBe(0);
  });
});

describe('Einstellungen (C7): headBob nur Lauf-Bob, motionFx für Dip/Pop/Roll/Surge/Lean', () => {
  /** Landung + perfekter Hop + Kurve + Surf, liefert Maxima der Abweichungen. */
  function exercise(settings: CameraRigSettings): { pos: number; roll: number; pitch: number; fovExtra: number } {
    const { cam, rig: r } = rig(settings, 4 / 3);
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true, speed: 250, vel: new Vector3(0, 0, -250) });
    let pos = 0;
    let roll = 0;
    let pitch = 0;
    let fovExtra = 0;
    const each = (): void => {
      pos = Math.max(pos, cam.position.distanceTo(v.eyePos));
      roll = Math.max(roll, Math.abs(cam.rotation.z));
      pitch = Math.max(pitch, Math.abs(cam.rotation.x));
      fovExtra = Math.max(fovExtra, hfov43(cam) - 90 - r.fxState.speedKick);
    };
    simulate(r, v, 0.5, 0, 0, each);
    r.onEvent(land(700));
    simulate(r, v, 0.3, 0, 0, each); // verpatzte Landung: Dip
    r.onEvent(land(300));
    r.onEvent(JUMP_PERFECT(30)); // perfekter Hop: Pop
    Object.assign(v, { onGround: false, speed: 500 });
    let heading = 0;
    for (let i = 0; i < 144; i++) {
      heading -= (2000 / 500) * FRAME;
      v.speed += 70 * FRAME; // Surge
      v.vel.set(-Math.sin(heading) * v.speed, 0, -Math.cos(heading) * v.speed);
      r.update(FRAME, v, heading, 0);
      each();
    }
    Object.assign(v, { surfing: true, surfNormal: new Vector3(0.7, 0.714, 0) });
    simulate(r, v, 0.5, 0, 0, each);
    return { pos, roll, pitch, fovExtra };
  }

  it('headBob 0 lässt Dip, Pop, Roll aktiv; motionFx 0 schaltet sie exakt ab; beide 0 → Kamera = Auge', () => {
    const noBob = exercise({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0, screenShake: 0 });
    expect(noBob.pos).toBeGreaterThan(5); // Dip
    expect(noBob.roll).toBeGreaterThan(1 * DEG); // Carve + Lean
    expect(noBob.pitch).toBeGreaterThan(0.3 * DEG); // Lande-Nicken
    expect(noBob.fovExtra).toBeGreaterThan(1); // Pop + Surge

    const noFx = exercise({ ...DEFAULT_CAMERA_SETTINGS, motionFx: 0, screenShake: 0 });
    expect(noFx.roll).toBe(0);
    expect(noFx.fovExtra).toBeLessThan(1e-9);
    expect(noFx.pos).toBeLessThan(0.8); // nur Lauf-Bob

    const none = exercise({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0, motionFx: 0, screenShake: 0 });
    expect(none.pos).toBe(0);
    expect(none.roll).toBe(0);
    expect(none.pitch).toBe(0);
    expect(none.fovExtra).toBeLessThan(1e-9);
  });

  it('fehlendes motionFx (alte Settings aus Game) → 1', () => {
    const legacy = exercise({ headBob: 1, screenShake: 1, fovKick: 1, fov: 90 });
    const full = exercise(DEFAULT_CAMERA_SETTINGS);
    expect(legacy).toEqual(full);
  });
});

describe('Duck-Glättung (C8)', () => {
  it('am Boden: smoothstep statt linear — ohne Knicke, am Ende exakt am Auge', () => {
    const { cam, rig: r } = rig(OFF);
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true });
    simulate(r, v, 0.1);
    const camY: number[] = [cam.position.y];
    const eyeY: number[] = [v.eyePos.y];
    for (let dir = -1; dir <= 1; dir += 2) {
      for (let t = 0; t < 0.3; t += FRAME) {
        v.eyeHeight = Math.min(64, Math.max(46, v.eyeHeight + dir * (18 / 0.15) * FRAME));
        v.eyePos.y = v.eyeHeight;
        r.update(FRAME, v, 0, 0);
        camY.push(cam.position.y);
        eyeY.push(v.eyePos.y);
        expect(Math.abs(cam.position.y - v.eyePos.y)).toBeLessThanOrEqual(0.0963 * 18 + 1e-9);
      }
      expect(cam.position.y).toBe(v.eyePos.y);
    }
    // Knick = Sprung der Frame-Geschwindigkeit; linear: 120 u/s auf einen Schlag,
    // smoothstep: stetig, Änderung pro Frame nur a·dt (max. 4800 u/s² · 1/144 ≈ 33 u/s).
    const maxAccelJump = (ys: number[]): number => {
      let m = 0;
      for (let i = 2; i < ys.length; i++) m = Math.max(m, Math.abs(ys[i] - 2 * ys[i - 1] + ys[i - 2]) / FRAME);
      return m;
    };
    expect(maxAccelJump(eyeY)).toBeGreaterThan(100);
    expect(maxAccelJump(camY)).toBeLessThan(0.3 * maxAccelJump(eyeY));
  });

  it('in der Luft unverändert: Crouch-Jump-Augenhöhe in Weltkoordinaten bleibt exakt', () => {
    const { cam, rig: r } = rig(OFF);
    const v = view({ eyePos: new Vector3(0, 200, 0), onGround: false, eyeHeight: 64 });
    simulate(r, v, 0.2);
    // Hull duckt von unten: Füße +18, eyeHeight −18, Welt-Auge gleich (auch interpoliert).
    for (let k = 0; k <= 4; k++) {
      v.eyeHeight = 64 - (18 * k) / 4;
      r.update(FRAME, v, 0, 0);
      expect(cam.position.y).toBe(200);
    }
  });
});

describe('Stufen-Glättung', () => {
  it('16-u-Stufe am Boden springt nicht, sondern baut sich in ~0.1 s ab; Ducken ist keine Stufe', () => {
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true, speed: 250, vel: new Vector3(0, 0, -250) });
    simulate(r, v, 0.2);
    v.eyePos.y = 80;
    r.update(FRAME, v, 0, 0);
    expect(cam.position.y).toBeLessThan(66);
    simulate(r, v, 0.12);
    expect(cam.position.y).toBeGreaterThan(79);
    // Ducken: 18 u in 0.15 s (Augenhöhe sinkt, Füße bleiben) → nur die Duck-Glättung (≤ 1.73 u), kein Stufen-Versatz
    const d = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
    const vd = view({ eyePos: new Vector3(0, 64, 0), onGround: true });
    simulate(d.rig, vd, 0.1);
    for (let t = 0; t < 0.2; t += FRAME) {
      vd.eyeHeight = Math.max(46, vd.eyeHeight - (18 / 0.15) * FRAME);
      vd.eyePos.y = vd.eyeHeight;
      d.rig.update(FRAME, vd, 0, 0);
      expect(Math.abs(d.cam.position.y - vd.eyePos.y)).toBeLessThan(1.8);
    }
    expect(d.cam.position.y).toBe(46);
  });

  it('eine Stufe, die die Interpolation auf zwei Frames verteilt, wird trotzdem ganz ausgeglichen', () => {
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true, speed: 250, vel: new Vector3(0, 0, -250) });
    simulate(r, v, 0.2);
    const y0 = cam.position.y;
    v.eyePos.y += 7; // erster Teil der Stufe
    r.update(FRAME, v, 0, 0);
    v.eyePos.y += 9; // Rest im nächsten Frame
    r.update(FRAME, v, 0, 0);
    expect(cam.position.y - y0).toBeLessThan(2 * (160 * FRAME) + 1e-6);
  });

  it('Rampe (Bodennormale erklärt die Höhe) wird nicht geglättet', () => {
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
    // 40°-Rampe, steigt Richtung -z: n = (0, cos, sin)
    const a = (40 * Math.PI) / 180;
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true, speed: 320, vel: new Vector3(0, 0, -320), groundNormal: new Vector3(0, Math.cos(a), Math.sin(a)) });
    simulate(r, v, 0.1);
    for (let i = 0; i < 60; i++) {
      v.eyePos.z -= 320 * FRAME;
      v.eyePos.y += 320 * FRAME * Math.tan(a);
      r.update(FRAME, v, 0, 0);
      expect(cam.position.y).toBeCloseTo(v.eyePos.y, 6);
    }
  });

  it('respawn setzt alles zurück', () => {
    const { cam, rig: r } = rig();
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true });
    r.update(FRAME, v, 0, 0);
    r.onEvent(land(1200));
    r.update(FRAME, v, 0, 0);
    r.update(FRAME, v, 0, 0);
    r.onEvent(JUMP_PERFECT());
    r.onEvent({ type: 'respawn', reason: 'fall' });
    v.eyePos.set(500, 100, 500);
    r.update(FRAME, v, 0.5, 0);
    expect(cam.position.toArray()).toEqual([500, 100, 500]);
    expect(cam.rotation.y).toBe(0.5);
    expect(cam.rotation.z === 0).toBe(true);
    expect(cam.fov).toBeCloseTo(verticalFovFromHorizontal43(90, 16 / 9), 9);
  });
});

/**
 * Echte Bewegung + Fixed-Step-Loop + lerpSnapshot + Rig, wie im Spiel.
 * Liefert je Frame Kamera- und Augenhöhe.
 */
function playFrames(level: CompiledLevel, start: Vector3, input: PlayerInput, hz: number, seconds: number, settings: CameraRigSettings): { cam: number[]; eye: number[] } {
  const cfg = VELOCITY_DEFAULT;
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(start);
  const prev = PlayerMovement.createSnapshot();
  const curr = PlayerMovement.createSnapshot();
  const interp = PlayerMovement.createSnapshot();
  pm.copySnapshot(prev);
  pm.copySnapshot(curr);
  const { cam, rig: r } = rig(settings);
  const v = makeCameraView();
  const tickDt = 1 / cfg.tickRate;
  let acc = 0;
  const out = { cam: [] as number[], eye: [] as number[] };
  for (let f = 0; f < Math.round(hz * seconds); f++) {
    acc += 1 / hz;
    while (acc >= tickDt) {
      pm.copySnapshot(prev);
      for (const e of pm.tick(input)) r.onEvent(e);
      pm.copySnapshot(curr);
      acc -= tickDt;
    }
    lerpSnapshot(prev, curr, acc / tickDt, interp);
    cameraViewFromSnapshot(interp, input.sprint, input.side, v);
    r.update(1 / hz, v, input.yaw, 0);
    out.cam.push(cam.position.y);
    out.eye.push(v.eyePos.y);
  }
  return out;
}

function stairLevel(rise: number, run: number, n = 12): CompiledLevel {
  const brushes: BrushDef[] = [box([-512, -64, -4000], [512, 0, 512])];
  for (let k = 0; k < n; k++) brushes.push(box([-256, 0, -100 - (k + 1) * run], [256, rise * (k + 1), -100 - k * run]));
  brushes.push(box([-256, 0, -3000], [256, rise * n, -100 - n * run]));
  return compileLevel(makeLevel(brushes));
}

describe('Integration mit PlayerMovement + Interpolation', () => {
  it.each([
    [8, 16],
    [16, 32],
    [8, 32],
  ])('Treppe %i/%i: Kamera steigt gleichmäßig (max. Frame-Sprung < 1.5 × mittlerer Anstieg) bei 30/60/144 Hz', (rise, run) => {
    const level = stairLevel(rise, run);
    for (const hz of [30, 60, 144]) {
      for (const sprint of [false, true]) {
        const input: PlayerInput = { ...NO_INPUT, forward: 1, sprint };
        const { cam, eye } = playFrames(level, new Vector3(0, 0, 40), input, hz, 4, { ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
        // Steigdauer: erster bis letzter Frame, in dem sich das (ungeglättete) Auge hebt.
        let first = -1;
        let last = -1;
        for (let i = Math.round(hz * 0.2); i < eye.length; i++) {
          if (eye[i] - eye[i - 1] > 1e-6) {
            if (first < 0) first = i;
            last = i;
          }
        }
        const meanRise = (eye[last] - eye[first - 1]) / (last - first + 1);
        let maxCam = 0;
        let maxRaw = 0;
        for (let i = 1; i < cam.length; i++) {
          maxCam = Math.max(maxCam, Math.abs(cam[i] - cam[i - 1]));
          maxRaw = Math.max(maxRaw, Math.abs(eye[i] - eye[i - 1]));
        }
        expect(eye[eye.length - 1] - eye[0]).toBeCloseTo(12 * rise, 0);
        expect(maxRaw).toBeGreaterThanOrEqual(rise * 0.5); // ungeglättet springt es
        expect(maxCam, `${rise}/${run} ${hz} Hz sprint=${sprint}`).toBeLessThan(1.5 * meanRise);
        // Oben angekommen ist die Kamera wieder exakt am Auge.
        expect(cam[cam.length - 1]).toBeCloseTo(eye[eye.length - 1], 6);
      }
    }
  });

  it('Rampen 25° und 40° hoch und runter: Kamera bleibt am Auge (keine Stufen-Glättung)', () => {
    for (const deg of [25, 40]) {
      const h = Math.tan((deg * Math.PI) / 180) * 400;
      const level = compileLevel(makeLevel([
        box([-512, -64, -3000], [512, 0, 512]),
        { type: 'wedge', min: [-256, 0, -500], max: [256, h, -100], rise: '-z', mat: 'floor' },
        box([-256, 0, -1500], [256, h, -500]),
      ]));
      for (const hz of [60, 144]) {
        const up = playFrames(level, new Vector3(0, 0, 0), { ...NO_INPUT, forward: 1, sprint: true }, hz, 2.5, OFF);
        const down = playFrames(level, new Vector3(0, h, -900), { ...NO_INPUT, forward: 1, sprint: true, yaw: Math.PI }, hz, 3, OFF);
        for (const r of [up, down]) {
          let lag = 0;
          r.cam.forEach((c, i) => (lag = Math.max(lag, Math.abs(c - r.eye[i]))));
          // Nur an den Knicken (Übergang flach ↔ Rampe) bleibt ein Rest der Frame-Strecke.
          expect(lag, `${deg}° ${hz} Hz`).toBeLessThan(2);
        }
        expect(up.eye[up.eye.length - 1]).toBeGreaterThan(h);
      }
    }
  });

  it('Bhop auf flachem Boden mit allen Effekten aus: Kamera = Auge in jedem Frame (Landungen sind keine Stufen)', () => {
    const level = compileLevel(flatLevel(8192));
    const input: PlayerInput = { ...NO_INPUT, forward: 1, jumpHeld: true, jumpPressed: true };
    for (const hz of [60, 144]) {
      const { cam, eye } = playFrames(level, new Vector3(0, 0, 4000), input, hz, 3, OFF);
      cam.forEach((c, i) => expect(c).toBe(eye[i]));
    }
  });

  it('Sandbox-Treppe hoch: Kamera springt pro Frame nie eine ganze Stufe (60 und 144 Hz)', () => {
    const level = compileLevel(readLevelFile('public/levels/sandbox.json'));
    const yaw = -Math.PI / 2; // Blick +x
    const input = { ...NO_INPUT, forward: 1, yaw };
    for (const hz of [60, 144]) {
      const pm = new PlayerMovement(level.world, VELOCITY_DEFAULT);
      pm.teleport(new Vector3(272, 16, 360));
      const prev = PlayerMovement.createSnapshot();
      const curr = PlayerMovement.createSnapshot();
      const interp = PlayerMovement.createSnapshot();
      pm.copySnapshot(prev);
      pm.copySnapshot(curr);
      const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0 });
      const v = makeCameraView();
      const tickDt = 1 / VELOCITY_DEFAULT.tickRate;
      let acc = 0;
      let lastY = Number.NaN;
      let maxRawJump = 0;
      let maxCamJump = 0;
      let lastEye = Number.NaN;
      for (let f = 0; f < hz * 1.2 && curr.pos.x < 430; f++) {
        acc += 1 / hz;
        while (acc >= tickDt) {
          pm.copySnapshot(prev); // Zustand vor dem Tick
          pm.tick(input);
          pm.copySnapshot(curr);
          acc -= tickDt;
        }
        lerpSnapshot(prev, curr, acc / tickDt, interp);
        cameraViewFromSnapshot(interp, false, 0, v);
        r.update(1 / hz, v, yaw, 0);
        if (!Number.isNaN(lastY)) {
          maxCamJump = Math.max(maxCamJump, Math.abs(cam.position.y - lastY));
          maxRawJump = Math.max(maxRawJump, Math.abs(v.eyePos.y - lastEye));
        }
        lastY = cam.position.y;
        lastEye = v.eyePos.y;
      }
      expect(curr.pos.y).toBeCloseTo(96, 0);
      expect(maxRawJump).toBeGreaterThan(8); // ungeglättet springt es
      expect(maxCamJump).toBeLessThan(0.6 * maxRawJump);
    }
  });
});

// ============================================================ Arcade-Pass (Plan 007): Rutschen und Kanten-Assist

describe('Rutschen (Plan 007 A7): Rückmeldung', () => {
  const sliding = (patch: Partial<MutableCameraView> = {}): MutableCameraView =>
    view({ eyePos: new Vector3(0, 46, 0), eyeHeight: 46, ducked: true, onGround: true, sliding: true, speed: 700, vel: new Vector3(0, 0, -700), ...patch });

  it('kein Head-Bob beim Rutschen (Schrittphase steht), Bob kommt beim Aufstehen zurück', () => {
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, screenShake: 0 });
    const v = sliding({ stridePhase: 0.25 });
    simulate(r, v, 0.5);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 144; i++) {
      v.stridePhase = (v.stridePhase + 0.02) % 1; // selbst wenn sie liefe: kein Bob
      r.update(FRAME, v, 0, 0);
      lo = Math.min(lo, cam.position.y - v.eyePos.y);
      hi = Math.max(hi, cam.position.y - v.eyePos.y);
    }
    expect(hi - lo).toBeLessThan(0.02);
  });

  it('Rutsch-Rumpeln: nur Translation (Yaw/Pitch exakt), 0.15–0.5 u mit dem Tempo, × screenShake und × motionFx', () => {
    const amp = (settings: CameraRigSettings, speed: number): number => {
      const { cam, rig: r } = rig({ ...settings, headBob: 0 });
      const v = sliding({ speed, vel: new Vector3(0, 0, -speed) });
      simulate(r, v, 0.3);
      let m = 0;
      for (let i = 0; i < 144; i++) {
        r.update(FRAME, v, 0.3, -0.1);
        expect(cam.rotation.y).toBe(0.3);
        m = Math.max(m, r.fxState.slideRumble);
      }
      return m;
    };
    const slow = amp(DEFAULT_CAMERA_SETTINGS, 300);
    const fast = amp(DEFAULT_CAMERA_SETTINGS, 1000);
    expect(slow).toBeGreaterThan(0.1);
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(amp({ ...DEFAULT_CAMERA_SETTINGS, screenShake: 0 }, 1000)).toBe(0);
    expect(amp({ ...DEFAULT_CAMERA_SETTINGS, motionFx: 0 }, 1000)).toBe(0);
    // Pitch bleibt bis auf das Lande-Nicken der Blick (hier keine Landung): exakt.
    const { cam, rig: r } = rig(DEFAULT_CAMERA_SETTINGS);
    const v = sliding();
    simulate(r, v, 0.5, 0, -0.2, () => expect(cam.rotation.x).toBe(-0.2));
  });

  it('motionFx 0 und screenShake 0: Rutschen ohne jede Kamera-Reaktion (Position = Auge, kein Roll)', () => {
    const { cam, rig: r } = rig(OFF);
    const v = sliding();
    let yaw = 0;
    simulate(r, v, 1, 0, 0, () => {
      // Lenken: die Geschwindigkeit dreht (Carve), die Kamera bleibt trotzdem exakt.
      yaw += 0.01;
      v.vel.set(-Math.sin(yaw) * 700, 0, -Math.cos(yaw) * 700);
      expect(cam.position.equals(v.eyePos)).toBe(true);
      expect(cam.rotation.z === 0).toBe(true);
    });
  });

  it('Carve-Roll beim Lenken in der Rutsche (Querbeschleunigung), Vorzeichen folgt der Kurve', () => {
    const { rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, screenShake: 0 });
    const v = sliding();
    let a = 0;
    simulate(r, v, 0.5, 0, 0, () => {
      a -= 1.4 * FRAME; // Rechtskurve mit slideSteerRate
      v.vel.set(-Math.sin(a) * 700, 0, -Math.cos(a) * 700);
    });
    expect(r.fxState.roll).toBeGreaterThan(0.2);
  });
});

describe('Lande-Gnade (Plan 007 A3): verlustfreier Hop wird gelobt', () => {
  it('Sprung 4 Ticks nach der Landung (clean, nicht perfekt): Pop wie beim perfekten Hop, der Dip läuft ohne Sprung aus', () => {
    const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0, screenShake: 0 });
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true, speed: 700, vel: new Vector3(0, 0, -700) });
    r.update(FRAME, v, 0, 0);
    r.onEvent(land(600));
    for (let i = 0; i < 4; i++) r.update(FRAME, v, 0, 0); // Landung ist als Dip nachgeholt
    const before = cam.position.y;
    r.onEvent({ type: 'jump', speed: 700, gain: 25, perfect: false, clean: true, chain: 4, sync: 0.9, crouched: false, coyote: false });
    let pop = 0;
    let maxStep = 0;
    let last = before;
    simulate(r, v, 0.2, 0, 0, () => {
      pop = Math.max(pop, r.fxState.pop);
      maxStep = Math.max(maxStep, Math.abs(cam.position.y - last));
      last = cam.position.y;
    });
    expect(pop).toBeGreaterThan(0.5);
    expect(maxStep).toBeLessThan(1);
  });
});

describe('Kanten-Assist (Plan 007 A6): Lip-Step glätten', () => {
  const STEP = (dy: number): MovementEvent => ({ type: 'ledge', kind: 'step', speed: 400, dy });

  it('Stufe im neuesten Tick: nur der schon sichtbare Teil (tickAlpha · dy) wird ausgeglichen, dann linear in 0.1 s', () => {
    const { cam, rig: r } = rig(OFF);
    // Der Lip-Step passiert in der Luft (vel.y ≠ 0): die Boden-Stufenglättung sieht ihn nicht.
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: false, vel: new Vector3(0, -50, -400) });
    r.update(FRAME, v, 0, 0);
    r.onTick();
    r.onEvent(STEP(4));
    // Interpolation zeigt 30 % der Stufe; der Abbau (4 u in 0.1 s) beginnt in diesem Frame.
    v.eyePos.y = 64 + 0.3 * 4;
    v.tickAlpha = 0.3;
    r.update(FRAME, v, 0, 0);
    expect(cam.position.y).toBeCloseTo(64 + FRAME * 40, 9);
    // Nächster Tick: Stufe voll sichtbar (gelandet), Versatz = Rest nach zwei Frames Abbau.
    r.onTick();
    Object.assign(v, { onGround: true, vel: new Vector3(0, 0, -400) });
    v.eyePos.y = 68;
    v.tickAlpha = 0.5;
    r.update(FRAME, v, 0, 0);
    expect(cam.position.y).toBeCloseTo(68 - (4 - 2 * FRAME * 40), 6);
    simulate(r, v, 0.1);
    expect(cam.position.y).toBe(68);
    expect(r.fxState.ledgeOffset).toBe(0);
  });

  it('Integration: Lip-Step auf eine 60-u-Kiste — kein Frame springt mehr als 1.5 × der mittlere Anstieg der Glättung (60/144 Hz)', () => {
    const lvl = compileLevel(makeLevel([box([-512, -64, -1024], [512, 0, 512]), box([-256, 0, -700], [256, 60, -300])]));
    let checked = 0;
    for (const hz of [60, 144]) {
      for (const [z0, v0] of [[-180, 250], [-170, 250], [-190, 260], [-200, 280]] as const) {
        const pm = new PlayerMovement(lvl.world, VELOCITY_DEFAULT);
        pm.state.vel.set(0, 0, -v0);
        pm.teleport(new Vector3(0, 0, z0), { keepVelocity: true });
        const prev = PlayerMovement.createSnapshot();
        const curr = PlayerMovement.createSnapshot();
        const interp = PlayerMovement.createSnapshot();
        pm.copySnapshot(prev);
        pm.copySnapshot(curr);
        const { cam, rig: r } = rig({ ...DEFAULT_CAMERA_SETTINGS, headBob: 0, screenShake: 0, motionFx: 0 });
        const v = makeCameraView();
        const tickDt = 1 / VELOCITY_DEFAULT.tickRate;
        let acc = 0;
        let k = 0;
        let stepFrame = -1;
        let dy = 0;
        const camY: number[] = [];
        const eyeY: number[] = [];
        for (let f = 0; f < hz; f++) {
          acc += 1 / hz;
          while (acc >= tickDt) {
            pm.copySnapshot(prev);
            const ev = pm.tick({ ...NO_INPUT, forward: 1, jumpPressed: k === 0, jumpHeld: k === 0 });
            r.onTick();
            for (const e of ev) {
              r.onEvent(e);
              if (e.type === 'ledge' && e.kind === 'step' && stepFrame < 0) {
                stepFrame = f;
                dy = e.dy;
              }
            }
            pm.copySnapshot(curr);
            acc -= tickDt;
            k++;
          }
          lerpSnapshot(prev, curr, acc / tickDt, interp);
          cameraViewFromSnapshot(interp, false, 0, v, acc / tickDt);
          r.update(1 / hz, v, 0, 0);
          camY.push(cam.position.y);
          eyeY.push(v.eyePos.y);
        }
        if (stepFrame < 0) continue;
        checked++;
        // Mittlerer Anstieg der Glättung: dy über 0.1 s; dazu die Bewegung vor der Stufe (Fall/Steigen).
        const meanRise = (dy / 0.1) / hz;
        const before = Math.abs(eyeY[stepFrame - 1] - eyeY[stepFrame - 2]);
        let rawMax = 0;
        let camMax = 0;
        for (let i = stepFrame; i < Math.min(camY.length, stepFrame + Math.ceil(0.15 * hz)); i++) {
          rawMax = Math.max(rawMax, Math.abs(eyeY[i] - eyeY[i - 1]));
          camMax = Math.max(camMax, Math.abs(camY[i] - camY[i - 1]));
        }
        expect(rawMax, `${hz} Hz z0 ${z0}: ungeglättet springt es`).toBeGreaterThan(0.5 * dy);
        expect(camMax, `${hz} Hz z0 ${z0}`).toBeLessThanOrEqual(1.5 * meanRise + before);
        // Nach der Glättung wieder exakt am Auge.
        expect(camY[camY.length - 1]).toBeCloseTo(eyeY[eyeY.length - 1], 9);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('respawn setzt den Versatz zurück; der Vault (ohne Höhensprung) versetzt nichts', () => {
    const { cam, rig: r } = rig(OFF);
    const v = view({ eyePos: new Vector3(0, 64, 0), onGround: true });
    r.onTick();
    r.onEvent({ type: 'ledge', kind: 'vault', speed: 500, dy: 0 });
    r.update(FRAME, v, 0, 0);
    expect(cam.position.y).toBe(64);
    r.onEvent(STEP(5));
    r.onTick();
    r.onEvent({ type: 'respawn', reason: 'fall' });
    r.update(FRAME, v, 0, 0);
    expect(cam.position.y).toBe(64);
  });
});
