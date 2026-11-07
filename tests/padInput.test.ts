import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vector3 } from 'three';
import { FixedLoop } from '../src/engine/Loop';
import { InputState } from '../src/engine/InputState';
import type { InputAction } from '../src/engine/InputState';
import { PadInput, meanBoost } from '../src/engine/pad/PadInput';
import type { GamepadLike } from '../src/engine/pad/PadInput';
import { DEFAULT_LOOK_CURVE, boostFactor } from '../src/engine/pad/stickCurve';
import { DEFAULT_PAD_SETTINGS, PAD_BUTTONS, PAD_PRESETS, PAD_RESTART_HOLD } from '../src/engine/pad/types';
import type { PadButtonCode, PadSettings } from '../src/engine/pad/types';
import { PAD_SETTINGS_KEY, PadSettingsStore, padPresetOf, sanitizePadSettings } from '../src/engine/pad/padSettings';
import { padKindFromId, promptLabelFor } from '../src/engine/pad/prompts';
import { DEFAULT_KEYBINDS } from '../src/engine/settingsTypes';
import { InputQuantizer, YAW_UNIT, inputFromQuantized, replayConfig } from '../src/engine/replay/format';
import type { Replay } from '../src/engine/replay/format';
import { configHash, levelHash } from '../src/engine/replay/hash';
import { ReplayRecorder } from '../src/engine/replay/recorder';
import { RunSimulator } from '../src/engine/replay/runSim';
import { DEFAULT_REPLAY_SETTINGS } from '../src/engine/replay/botRun';
import { verifyReplay } from '../src/engine/replay/verify';
import { RouteFollower } from '../src/player/bots';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import type { MutablePlayerInput } from '../src/player/types';
import { compileLevel } from '../src/world/level/compileLevel';
import type { LevelFile } from '../src/world/level/LevelFormat';
import { flatLevel } from '../tools/sim/levels';

/**
 * Plan 011 §1.3: Gamepad → InputState. Stick digital (8 Richtungen, volle wishspeed), Knöpfe als Pseudo-Codes
 * (latch/Sprung-Flanke wie Tastatur), Kamera-Stick als Drehrate über den Subtick-Yaw, Replays bitgleich.
 */

interface FakeButton {
  pressed: boolean;
  value: number;
}
interface FakePad extends GamepadLike {
  id: string;
  connected: boolean;
  readonly buttons: FakeButton[];
  readonly axes: number[];
}

function fakePad(id = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'): FakePad {
  return { id, index: 0, connected: true, mapping: 'standard', buttons: PAD_BUTTONS.map(() => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
}

function press(p: FakePad, code: PadButtonCode, on: boolean | number): void {
  const b = p.buttons[PAD_BUTTONS.indexOf(code)];
  b.value = typeof on === 'number' ? on : on ? 1 : 0;
  b.pressed = b.value > 0.5;
}

/** InputState + PadInput wie im InputManager verdrahtet (poll vor beginFrame). */
function rig(settings: PadSettings = DEFAULT_PAD_SETTINGS): { s: InputState; pad: PadInput; p: FakePad; frame(dt?: number): void } {
  const s = new InputState();
  const p = fakePad();
  const pads: (GamepadLike | null)[] = [p];
  const pad = new PadInput(s, () => pads);
  pad.configure(settings);
  s.setPadBindings(settings.binds);
  pad.setMenuContext(false);
  return {
    s,
    pad,
    p,
    frame(dt = 1 / 128): void {
      pad.poll(dt);
      s.beginFrame(dt);
    },
  };
}

const DEG = Math.PI / 180;

describe('Pad: Bewegung digital (Plan 011 §2.2.1)', () => {
  it('Stick links 0.7 → side −1, volle Richtung; 20° neben links bleibt reines A, 45° = Diagonale', () => {
    const r = rig();
    r.p.axes[0] = -0.7;
    r.frame();
    let t = r.s.tickInput(0, 1);
    expect(t.side).toBe(-1);
    expect(t.forward).toBe(0);
    // 20° über links (Gamepad-y nach oben = negativ).
    r.p.axes[0] = -Math.cos(20 * DEG);
    r.p.axes[1] = -Math.sin(20 * DEG);
    r.frame();
    t = r.s.tickInput(0, 1);
    expect([t.forward, t.side]).toEqual([0, -1]);
    r.p.axes[0] = Math.cos(45 * DEG);
    r.p.axes[1] = -Math.sin(45 * DEG);
    r.frame();
    t = r.s.tickInput(0, 1);
    expect([t.forward, t.side]).toEqual([1, 1]);
    // Unter der Bewegungs-Deadzone: nichts.
    r.p.axes[0] = 0.2;
    r.p.axes[1] = 0;
    r.frame();
    t = r.s.tickInput(0, 1);
    expect([t.forward, t.side]).toEqual([0, 0]);
  });

  it('Pad + Tastatur gleichzeitig: ODER je Richtung, W + Stick zurück hebt sich auf', () => {
    const r = rig();
    r.s.keyDown('KeyW', false);
    r.p.axes[0] = 1;
    r.frame();
    let t = r.s.tickInput(0, 1);
    expect([t.forward, t.side]).toEqual([1, 1]);
    r.p.axes[0] = 0;
    r.p.axes[1] = 1; // Stick zurück
    r.frame();
    t = r.s.tickInput(0, 1);
    expect(t.forward).toBe(0);
    r.s.keyUp('KeyW');
    r.frame();
    expect(r.s.tickInput(0, 1).forward).toBe(-1);
  });

  it('Steuerkreuz bewegt wie WASD', () => {
    const r = rig();
    press(r.p, 'PadUp', true);
    press(r.p, 'PadLeft', true);
    r.frame();
    const t = r.s.tickInput(0, 1);
    expect([t.forward, t.side]).toEqual([1, -1]);
  });
});

describe('Pad: Knöpfe (Plan 011 §2.2.3)', () => {
  it('LB-Druck zwischen zwei Ticks → jumpPressed genau einmal (Tipp-Klammer wie Tastatur)', () => {
    const r = rig();
    // Frame mit LB, aber ohne Tick (144 Hz), dann losgelassen, dann der Tick.
    press(r.p, 'PadLB', true);
    r.frame(1 / 144);
    press(r.p, 'PadLB', false);
    r.frame(1 / 144);
    const a = r.s.tickInput(0, 1);
    expect(a.jumpPressed).toBe(true);
    expect(a.jumpHeld).toBe(true);
    const b = r.s.tickInput(0, 1);
    expect(b.jumpPressed).toBe(false);
    expect(b.jumpHeld).toBe(false);
  });

  it('gehaltener Bumper = gehaltene Sprungtaste (Auto-Hop), A und RB/B wie belegt', () => {
    const r = rig();
    press(r.p, 'PadA', true);
    press(r.p, 'PadRB', true);
    r.frame();
    expect(r.s.tickInput(0, 1).jumpPressed).toBe(true);
    const held = r.s.tickInput(0, 1);
    expect(held.jumpHeld).toBe(true);
    expect(held.jumpPressed).toBe(false);
    expect(held.crouch).toBe(true);
  });

  it('Trigger digital mit Hysterese (an ≥ 0.6, aus ≤ 0.4)', () => {
    const r = rig({ ...DEFAULT_PAD_SETTINGS, binds: { ...DEFAULT_PAD_SETTINGS.binds, crouch: ['PadRT'] } });
    const crouch = (v: number): boolean => {
      press(r.p, 'PadRT', v);
      r.frame();
      return r.s.tickInput(0, 1).crouch;
    };
    expect(crouch(0.55)).toBe(false);
    expect(crouch(0.6)).toBe(true);
    expect(crouch(0.45)).toBe(true);
    expect(crouch(0.4)).toBe(false);
    expect(crouch(0.59)).toBe(false);
  });

  it('Aktionen: Y = Checkpoint, X = Vorführung, Menu = Pause, View erst nach 0.4 s halten = Neustart', () => {
    const r = rig();
    press(r.p, 'PadY', true);
    press(r.p, 'PadX', true);
    press(r.p, 'PadMenu', true);
    r.frame();
    expect([...r.s.consumeActions()].sort()).toEqual(['demo', 'pause', 'respawn']);
    r.frame();
    expect(r.s.consumeActions()).toEqual([]); // gehalten = kein neuer Druck
    press(r.p, 'PadView', true);
    const actions: InputAction[] = [];
    let t = 0;
    while (t < PAD_RESTART_HOLD - 0.05) {
      r.frame(1 / 60);
      t += 1 / 60;
      actions.push(...r.s.consumeActions());
    }
    expect(actions).toEqual([]);
    for (let i = 0; i < 30; i++) {
      r.frame(1 / 60);
      actions.push(...r.s.consumeActions());
    }
    expect(actions).toEqual(['restart']); // genau einmal je Druck
  });

  it('Menü-Kontext: A/B/Start/LB/RB → confirm/pause/tab…, Stick/Steuerkreuz → nav mit Wiederholung, keine Spiel-Eingabe', () => {
    const r = rig();
    r.pad.setMenuContext(true);
    press(r.p, 'PadA', true);
    r.frame();
    expect(r.s.consumeActions()).toEqual(['confirm']);
    expect(r.s.tickInput(0, 1).jumpPressed).toBe(false);
    press(r.p, 'PadA', false);
    press(r.p, 'PadB', true);
    press(r.p, 'PadRB', true);
    r.frame();
    expect([...r.s.consumeActions()].sort()).toEqual(['pause', 'tabNext']);
    press(r.p, 'PadB', false);
    press(r.p, 'PadRB', false);
    r.p.axes[1] = 0.9; // Stick runter
    const nav: InputAction[] = [];
    for (let i = 0; i < 60; i++) {
      r.frame(1 / 60);
      nav.push(...r.s.consumeActions());
    }
    // Sofort, nach 0.35 s, dann alle 0.12 s: in 1 s also 1 + floor((1 − 0.35) / 0.12) + 1 = 7.
    expect(nav.every((a) => a === 'navDown')).toBe(true);
    expect(nav.length).toBe(7);
    expect(r.s.tickInput(0, 1).forward).toBe(0);
  });

  it('Kontextwechsel: A bestätigt im Menü → kein Sprung im Spiel, bis A losgelassen ist; Stick navigiert erst nach Neutral', () => {
    const r = rig();
    r.pad.setMenuContext(true);
    press(r.p, 'PadA', true);
    r.frame();
    expect(r.s.consumeActions()).toEqual(['confirm']);
    r.pad.setMenuContext(false);
    r.frame();
    const t = r.s.tickInput(0, 1);
    expect(t.jumpPressed).toBe(false);
    expect(t.jumpHeld).toBe(false);
    press(r.p, 'PadA', false);
    r.frame();
    press(r.p, 'PadA', true);
    r.frame();
    expect(r.s.tickInput(0, 1).jumpPressed).toBe(true);
    // Mit gehaltenem Stick (Laufen) in die Pause: keine Navigation, bis er einmal neutral war.
    r.p.axes[1] = -1;
    r.frame();
    r.pad.setMenuContext(true);
    r.frame();
    expect(r.s.consumeActions().filter((a) => a.startsWith('nav'))).toEqual([]);
    r.p.axes[1] = 0;
    r.frame();
    r.p.axes[1] = -1;
    r.frame();
    expect(r.s.consumeActions()).toContain('navUp');
  });

  it('Pad getrennt im Spiel → alles los und Pause; im Menü nichts', () => {
    const r = rig();
    press(r.p, 'PadLB', true);
    r.p.axes[0] = 1;
    r.p.axes[2] = 1;
    r.frame();
    expect(r.s.tickInput(0, 1).jumpHeld).toBe(true);
    r.s.consumeActions();
    r.p.connected = false;
    r.frame();
    expect(r.s.consumeActions()).toEqual(['pause']);
    const t = r.s.tickInput(0, 1);
    expect([t.side, t.jumpHeld]).toEqual([0, false]);
    expect(r.pad.connected).toBe(false);
    // Im Menü: wieder verbinden, benutzen, trennen → keine Pause.
    r.p.connected = true;
    r.pad.setMenuContext(true);
    press(r.p, 'PadA', false);
    r.frame();
    press(r.p, 'PadA', true);
    r.frame();
    r.s.consumeActions();
    r.p.connected = false;
    r.frame();
    expect(r.s.consumeActions()).toEqual([]);
  });
});

describe('Pad: Kamera-Stick als Drehrate (Plan 011 §2.2.2)', () => {
  /** Volle Auslenkung rechts über `seconds` mit Frames à 1/hz, FixedLoop wie im Spiel; quantisierter Yaw je Tick. */
  function spin(hz: number, seconds: number, settings: PadSettings, rx = 1): number[] {
    const r = rig(settings);
    r.p.axes[2] = rx;
    const q = new InputQuantizer();
    const yaws: number[] = [];
    const loop = new FixedLoop({
      tickRate: 128,
      onFrameStart: (dt) => {
        r.pad.poll(dt);
        r.s.beginFrame(dt);
      },
      onTick: (_dt, i, n, u) => {
        q.apply(r.s.tickInput(i, n, u));
        yaws.push(q.yawQ);
      },
      onFrame: () => undefined,
      now: () => 0,
    });
    // Frames zählen statt Zeit summieren: k/hz exakt, kein Float-Drift in der Tickzahl.
    const frames = Math.round(seconds * hz);
    for (let f = 0; f < frames; f++) loop.advance(1 / hz);
    return yaws;
  }

  it('Rate 1.0 über 1 s bei 60/144/240 Hz: Gesamt-Yaw identisch ±1 YAW_UNIT, Schritt je Tick gleichmäßig (ohne Boost)', () => {
    const s = { ...DEFAULT_PAD_SETTINGS, boost: 0 };
    const expected = -(s.yawRate * DEG) / YAW_UNIT; // Stick rechts → Yaw fällt
    for (const hz of [60, 144, 240]) {
      const y = spin(hz, 1, s);
      expect(y.length, `${hz} Hz Ticks`).toBeGreaterThanOrEqual(127);
      // Bis zum letzten Tick: Zeit = Tickzahl / 128.
      const want = (expected * y.length) / 128;
      expect(Math.abs(y[y.length - 1] - want), `${hz} Hz`).toBeLessThanOrEqual(1);
      const step = expected / 128;
      for (let i = 1; i < y.length; i++) expect(Math.abs(y[i] - y[i - 1] - step), `${hz} Hz Tick ${i}`).toBeLessThanOrEqual(1.01);
    }
  });

  it('mit Boost: Gesamt-Yaw unabhängig von der Bildrate (Boost über das Frame gemittelt)', () => {
    const s = DEFAULT_PAD_SETTINGS;
    const totals = [60, 144, 240].map((hz) => {
      const y = spin(hz, 1, s);
      return y[127];
    });
    for (const t of totals) expect(Math.abs(t - totals[0])).toBeLessThanOrEqual(1);
    // Und der Boost wirkt: mehr als die Grundrate.
    expect(Math.abs(totals[0])).toBeGreaterThan((s.yawRate * DEG) / YAW_UNIT);
  });

  it('meanBoost = Integral von boostFactor (Riemann-Summe)', () => {
    const p = DEFAULT_LOOK_CURVE;
    for (const [t0, t1] of [[0, 0.1], [0.1, 0.2], [0.14, 0.31], [0.3, 0.5]] as const) {
      let sum = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) sum += boostFactor(p, t0 + ((i + 0.5) / n) * (t1 - t0));
      expect(meanBoost(p, t0, t1)).toBeCloseTo(sum / n, 5);
    }
  });

  it('Pitch: Stick hoch = Blick hoch, invertY dreht um, geklemmt; Mauspfad unberührt', () => {
    const r = rig();
    r.p.axes[3] = -1;
    for (let i = 0; i < 64; i++) r.frame(1 / 64);
    expect(r.s.pitch).toBeGreaterThan(80 * DEG);
    expect(r.s.pitch).toBeLessThanOrEqual(89 * DEG + 1e-12);
    const inv = rig({ ...DEFAULT_PAD_SETTINGS, invertY: true });
    inv.p.axes[3] = -0.8;
    inv.frame(0.1);
    expect(inv.s.pitch).toBeLessThan(0);
    // Ohne Stick: Maus wie immer.
    const m = rig();
    m.s.look(100, 0, { sensitivity: 1, mYaw: 0.022, invertY: false });
    m.frame();
    expect(m.s.yaw).toBeCloseTo(-2.2 * DEG, 12);
  });

  it('Deadzone: Drift unter inner dreht nicht', () => {
    const r = rig();
    r.p.axes[2] = DEFAULT_PAD_SETTINGS.deadzoneInner * 0.9;
    r.p.axes[3] = 0.05;
    for (let i = 0; i < 128; i++) r.frame();
    expect(r.s.yaw).toBe(0);
    expect(r.s.pitch).toBe(0);
  });
});

describe('Pad-Einstellungen (velocity.pad.v1)', () => {
  function mem(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  }

  it('kaputter/alter Stand → Defaults, Werte geklemmt, unbekannte Knöpfe raus', () => {
    expect(sanitizePadSettings(null)).toBe(DEFAULT_PAD_SETTINGS);
    const s = sanitizePadSettings({ yawRate: 99999, curve: -3, deadzoneInner: 0.4, deadzoneOuter: 0.45, glyphs: 'nintendo', binds: { jump: ['PadLB', 'Bogus', 'PadHome', 'PadLB'], crouch: 'x' } });
    expect(s.yawRate).toBe(900);
    expect(s.curve).toBe(1);
    expect(s.deadzoneOuter).toBeGreaterThanOrEqual(s.deadzoneInner + 0.1 - 1e-12);
    expect(s.glyphs).toBe('auto');
    expect(s.binds.jump).toEqual(['PadLB']);
    expect(s.binds.crouch).toEqual(DEFAULT_PAD_SETTINGS.binds.crouch);
  });

  it('Store: speichert, lädt, Preset Klassisch, andere Version → Defaults', () => {
    const st = mem();
    const a = new PadSettingsStore(st);
    expect(padPresetOf(a.get().binds)).toBe('bumper');
    a.update({ yawRate: 500, invertY: true });
    a.applyPreset('classic');
    const b = new PadSettingsStore(st);
    expect(b.get().yawRate).toBe(500);
    expect(b.get().invertY).toBe(true);
    expect(b.get().binds).toEqual(PAD_PRESETS.classic);
    st.data.set(PAD_SETTINGS_KEY, JSON.stringify({ v: 99, yawRate: 700 }));
    expect(new PadSettingsStore(st).get()).toBe(DEFAULT_PAD_SETTINGS);
  });
});

describe('Pad: Gerät und Prompts', () => {
  it('Typ aus Gamepad.id (Chrome, XInput, Firefox)', () => {
    expect(padKindFromId('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('playstation');
    expect(padKindFromId('054c-09cc-Wireless Controller')).toBe('playstation');
    expect(padKindFromId('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox');
    expect(padKindFromId('45e-b13-Xbox Wireless Controller')).toBe('xbox');
    expect(padKindFromId('8BitDo Pro 2 (Vendor: 2dc8 Product: 6006)')).toBe('generic');
  });

  it('Prompt je Gerät: Bumper-Sprung zeigt LB / L1, Bestätigen = A / ×, Tastatur wie bisher', () => {
    const pad = DEFAULT_PAD_SETTINGS.binds;
    expect(promptLabelFor('jump', 'xbox', DEFAULT_KEYBINDS, pad)).toBe('LB');
    expect(promptLabelFor('jump', 'playstation', DEFAULT_KEYBINDS, pad)).toBe('L1');
    expect(promptLabelFor('confirm', 'playstation', DEFAULT_KEYBINDS, pad)).toBe('×');
    expect(promptLabelFor('demo', 'generic', DEFAULT_KEYBINDS, pad)).toBe('X');
    expect(promptLabelFor('jump', 'keyboard', DEFAULT_KEYBINDS, pad)).toBe('SPACE');
    expect(promptLabelFor('demo', 'keyboard', DEFAULT_KEYBINDS, pad)).toBe('H');
  });
});

// ------------------------------------------------------------------ Determinismus

function loadLevel(id: string): ReturnType<typeof compileLevel> {
  const dir = join(process.cwd(), 'public', 'levels');
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { id: string; file: string }[];
  const file = index.find((e) => e.id === id)?.file ?? `${id}.json`;
  return compileLevel(JSON.parse(readFileSync(join(dir, file), 'utf8')) as LevelFile);
}

describe('Pad-Replay bitgleich (Plan 011 §1.3)', () => {
  it('L1: RouteFollower am Pad (Stick + LB/RB/L3, Blick als Drehrate) → Replay verifiziert, Zeit bitgleich', () => {
    const level = loadLevel('level1');
    const settings = DEFAULT_REPLAY_SETTINGS;
    const cfg = replayConfig(settings);
    const sim = new RunSimulator(level, cfg);
    const bot = new RouteFollower(level.def.route ?? [], cfg, {
      killY: level.def.killY,
      world: level.world,
      start: { x: level.spawnPos.x, z: level.spawnPos.z },
      stallTimeout: 12,
      aimNoiseDeg: 1,
      seed: 3,
    });
    const r = rig();
    const q = new InputQuantizer();
    const rec = new ReplayRecorder();
    sim.start();
    rec.begin({ levelId: level.def.id, levelHash: levelHash(level), configHash: configHash(cfg), tickRate: cfg.tickRate, settings });
    const dt = 1 / cfg.tickRate;
    let replay: Replay | null = null;
    for (let tick = 0; tick < 180 * 128 && replay === null; tick++) {
      const m = sim.movement;
      const want = bot.next(m.state, m.surfNormal);
      // Pad stellen: Bewegung als Stick-Vektor, Knöpfe gehalten, Blick als Rate, die genau dorthin dreht.
      r.p.axes[0] = want.side;
      r.p.axes[1] = -want.forward;
      press(r.p, 'PadLB', want.jumpHeld || want.jumpPressed);
      press(r.p, 'PadRB', want.crouch);
      press(r.p, 'PadLT', want.sprint); // ohne Auto-Sprint: LT = Sprint (Review A9)
      r.pad.poll(dt);
      r.s.setLookRate((want.yaw - r.s.yaw) / dt, (want.pitch - r.s.pitch) / dt);
      r.s.beginFrame(dt);
      const cmd = q.apply(r.s.tickInput(0, 1, 1));
      rec.record(q.buttons, q.yawQ, q.pitchQ);
      const out = sim.step(cmd);
      for (const e of sim.runEvents) {
        if (e.type === 'runStart') rec.markStart();
        else if (e.type === 'checkpoint') rec.markSplit();
      }
      rec.after(m.state.pos);
      if (out === 'finish') replay = rec.finish(sim.run.time ?? 0, m.state.pos);
      else if (sim.respawned || bot.status === 'failed') break;
    }
    expect(replay, 'Pad-Bot kam nicht ins Ziel').not.toBeNull();
    if (!replay) return;
    const res = verifyReplay(replay, level);
    expect(res.reason, res.detail ?? '').toBeNull();
    expect(res.valid).toBe(true);
    expect(res.time).toBe(replay.header.time);
  });

  it('flach, 144 Hz, echter Kamera-Stick mit Kurve + Boost und Bumper-Hops: Nachspielen der Bits = Live-Bahn, bitgleich', () => {
    const lvl = compileLevel(flatLevel(8000));
    const live = new PlayerMovement(lvl.world, VELOCITY_DEFAULT);
    live.teleport(new Vector3(0, 1, 0));
    const r = rig();
    r.s.setAutoSprint(true);
    const q = new InputQuantizer();
    const bits: number[] = [];
    const yq: number[] = [];
    const pq: number[] = [];
    const pos: number[] = [];
    const loop = new FixedLoop({
      tickRate: 128,
      onFrameStart: (dt) => {
        r.pad.poll(dt);
        r.s.beginFrame(dt);
      },
      onTick: (_dt, i, n, u) => {
        const cmd = q.apply(r.s.tickInput(i, n, u));
        bits.push(q.buttons);
        yq.push(q.yawQ);
        pq.push(q.pitchQ);
        live.tick(cmd);
        pos.push(live.state.pos.x, live.state.pos.y, live.state.pos.z);
      },
      onFrame: () => undefined,
      now: () => 0,
    });
    // Strafe-Rhythmus: 0.6 s rechts drehen + D, dann links + A, Sprung mit LB getippt, Stick-Teilausschlag mit Rauschen.
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
    for (let f = 0; f < 144 * 6; f++) {
      const phase = Math.floor(f / 86) % 2;
      r.p.axes[0] = phase === 0 ? 1 : -1;
      r.p.axes[1] = f < 144 ? -1 : -0.2;
      r.p.axes[2] = (phase === 0 ? 0.97 : -0.6) + rnd() * 0.06;
      r.p.axes[3] = rnd() * 0.3;
      press(r.p, 'PadLB', f % 40 < 3);
      loop.advance(1 / 144);
    }
    expect(bits.length).toBeGreaterThan(700);
    // Nachspielen wie der Verifier: nur die quantisierten Werte.
    const re = new PlayerMovement(lvl.world, VELOCITY_DEFAULT);
    re.teleport(new Vector3(0, 1, 0));
    const inp: MutablePlayerInput = { forward: 0, side: 0, jumpHeld: false, jumpPressed: false, crouch: false, sprint: false, yaw: 0, pitch: 0 };
    let same = true;
    for (let k = 0; k < bits.length; k++) {
      re.tick(inputFromQuantized(bits[k], yq[k], pq[k], inp));
      const p = re.state.pos;
      if (p.x !== pos[k * 3] || p.y !== pos[k * 3 + 1] || p.z !== pos[k * 3 + 2]) {
        same = false;
        break;
      }
    }
    expect(same).toBe(true);
    // Die Bahn hat wirklich gedreht und ist gesprungen (sonst prüft der Test nichts).
    expect(new Set(yq).size).toBeGreaterThan(100);
    expect(live.state.speed).toBeGreaterThan(250);
  });
});

describe('Pad: Belegungs-Aufnahme (InputManager.capturePadButton)', () => {
  /** Menü-Kontext, Pad schon aktiv (ein Druck hat es übernommen). */
  function menuRig(): ReturnType<typeof rig> & { actions(): readonly InputAction[] } {
    const r = rig();
    r.pad.setMenuContext(true);
    r.frame(1 / 60);
    r.s.consumeActions();
    return { ...r, actions: () => r.s.consumeActions() };
  }

  it('meldet den nächsten Knopf (auch A), ohne Menü-Aktion; das öffnende A zählt erst nach dem Loslassen', () => {
    const r = menuRig();
    press(r.p, 'PadA', true);
    r.frame(1 / 60);
    expect(r.actions()).toContain('confirm');
    const got: (PadButtonCode | null)[] = [];
    r.pad.capture((c) => got.push(c));
    r.frame(1 / 60); // A noch gehalten → nichts
    press(r.p, 'PadA', false);
    r.frame(1 / 60);
    expect(got).toEqual([]);
    press(r.p, 'PadA', true);
    r.frame(1 / 60);
    expect(got).toEqual(['PadA']);
    expect(r.actions()).toEqual([]);
    // Gehaltenes A nach der Aufnahme: kein confirm, bis es los ist.
    r.frame(1 / 60);
    expect(r.actions()).toEqual([]);
    expect(r.pad.capturing).toBe(false);
  });

  it('Trigger (RT) und LB werden als Code gemeldet', () => {
    const r = menuRig();
    const got: (PadButtonCode | null)[] = [];
    r.pad.capture((c) => got.push(c));
    press(r.p, 'PadRT', 0.8);
    r.frame(1 / 60);
    expect(got).toEqual(['PadRT']);
  });

  it('B kurz = B belegen, B gehalten = Abbruch, ohne "zurück"', () => {
    const r = menuRig();
    const got: (PadButtonCode | null)[] = [];
    r.pad.capture((c) => got.push(c));
    press(r.p, 'PadB', true);
    for (let i = 0; i < 5; i++) r.frame(1 / 60);
    press(r.p, 'PadB', false);
    r.frame(1 / 60);
    expect(got).toEqual(['PadB']);
    r.pad.capture((c) => got.push(c));
    press(r.p, 'PadB', true);
    for (let i = 0; i < 60; i++) r.frame(1 / 60);
    expect(got).toEqual(['PadB', null]);
    press(r.p, 'PadB', false);
    r.frame(1 / 60);
    expect(r.actions()).toEqual([]);
  });

  it('Start bricht ab, Zeitüberschreitung bricht ab, stilles Stoppen ruft nicht zurück', () => {
    const r = menuRig();
    const got: (PadButtonCode | null)[] = [];
    r.pad.capture((c) => got.push(c));
    press(r.p, 'PadMenu', true);
    r.frame(1 / 60);
    expect(got).toEqual([null]);
    expect(r.actions()).toEqual([]);
    press(r.p, 'PadMenu', false);
    r.frame(1 / 60);
    r.pad.capture((c) => got.push(c), 0.5);
    for (let i = 0; i < 40; i++) r.frame(1 / 60);
    expect(got).toEqual([null, null]);
    const stop = r.pad.capture((c) => got.push(c));
    stop();
    press(r.p, 'PadX', true);
    r.frame(1 / 60);
    expect(got).toEqual([null, null]);
    expect(r.actions()).toContain('demo');
  });

  it('Pad weg während der Aufnahme → null', () => {
    const r = menuRig();
    const got: (PadButtonCode | null)[] = [];
    r.pad.capture((c) => got.push(c));
    r.p.connected = false;
    r.frame(1 / 60);
    expect(got).toEqual([null]);
  });

  it('ohne Pad (Feld per Maus geöffnet): die Frist läuft trotzdem ab (Review A5)', () => {
    const s = new InputState();
    const pad = new PadInput(s, () => null);
    pad.setMenuContext(true);
    const got: (PadButtonCode | null)[] = [];
    pad.capture((c) => got.push(c), 0.5);
    for (let i = 0; i < 25; i++) pad.poll(1 / 60);
    expect(got).toEqual([]); // 0.42 s: läuft noch
    for (let i = 0; i < 10; i++) pad.poll(1 / 60);
    expect(got).toEqual([null]);
    expect(pad.capturing).toBe(false);
  });
});

// ------------------------------------------------------------------ Review-Fixes (Strang pad-core)

describe('Pad: Kontextwechsel nullt Stellgrößen (Review A1)', () => {
  it('Kamera-Stick rechts → Pause → Stick los: Blick steht hinter dem Menü (vorher 630 °/s weiter)', () => {
    const r = rig();
    r.p.axes[0] = -1;
    r.p.axes[2] = 1;
    for (let i = 0; i < 30; i++) r.frame(1 / 60);
    expect(r.s.tickInput(0, 1).side).toBe(-1);
    r.pad.setMenuContext(true);
    r.p.axes[0] = 0;
    r.p.axes[2] = 0;
    const y0 = r.s.yaw;
    for (let i = 0; i < 60; i++) r.frame(1 / 60);
    expect(r.s.yaw).toBe(y0);
    expect(r.s.tickInput(0, 1).side).toBe(0);
    // Auch gehalten dreht der Stick im Menü nicht.
    r.p.axes[2] = 1;
    for (let i = 0; i < 60; i++) r.frame(1 / 60);
    expect(r.s.yaw).toBe(y0);
    expect(r.pad.output.yawRate).toBe(0);
    // Zurück im Spiel: die Boost-Uhr beginnt neu — erster Frame mit der Grundrate, nicht mit der Spitze.
    r.pad.setMenuContext(false);
    r.frame(1 / 60);
    expect((-(r.s.yaw - y0) / DEG) * 60).toBeCloseTo(DEFAULT_PAD_SETTINGS.yawRate, 6);
  });

  it('Belegungs-Aufnahme im Spiel-Kontext: Rate und Richtung auf 0', () => {
    const r = rig();
    r.p.axes[1] = -1;
    r.p.axes[2] = 1;
    for (let i = 0; i < 30; i++) r.frame(1 / 60);
    r.pad.capture(() => undefined);
    const y0 = r.s.yaw;
    for (let i = 0; i < 30; i++) r.frame(1 / 60);
    expect(r.s.yaw).toBe(y0);
    expect(r.s.tickInput(0, 1).forward).toBe(0);
  });
});

describe('Pad: Pitch beim Strafen (Review A2)', () => {
  /** Voller Ausschlag `deg` über der Waagerechten nach rechts, `seconds` lang bei 60 Hz (mit Boost). */
  function strafe(deg: number, seconds: number): number {
    const r = rig();
    r.p.axes[2] = Math.cos(deg * DEG);
    r.p.axes[3] = -Math.sin(deg * DEG);
    for (let i = 0; i < Math.round(seconds * 60); i++) r.frame(1 / 60);
    return r.s.pitch / DEG;
  }

  it('Strafe 0.6 s voll seitlich: 5°/8° daneben → kein Pitch (vorher 15°/24.5°), 12° → unter 2° (vorher 37°)', () => {
    expect(strafe(5, 0.6)).toBe(0);
    expect(strafe(8, 0.6)).toBe(0);
    expect(Math.abs(strafe(12, 0.6))).toBeLessThan(2);
  });

  it('Boost nur auf Yaw: senkrecht am Rand 1 s → Pitch-Rate bleibt 220 °/s (vorher bis 330)', () => {
    const r = rig();
    r.p.axes[3] = -1;
    for (let i = 0; i < 60; i++) r.frame(1 / 60);
    expect(r.pad.output.pitchRate / DEG).toBeCloseTo(DEFAULT_PAD_SETTINGS.pitchRate, 9);
  });

  it('Strafe-Rhythmus mit zitternder Hand (Vertikalfehler σ 4°, 10 s): Pitch-Drift unter 3°', () => {
    const r = rig();
    let seed = 11;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) - 0.5;
    let err = 0;
    let max = 0;
    for (let f = 0; f < 600; f++) {
      // AR(1), τ ≈ 0.1 s: Daumen wackelt beim Seitwärtsdrücken; Seite wechselt alle 0.6 s.
      err = err * 0.85 + rnd() * 4 * Math.sqrt(12) * Math.sqrt(1 - 0.85 * 0.85);
      const side = Math.floor(f / 36) % 2 === 0 ? 1 : -1;
      r.p.axes[2] = side * Math.cos(err * DEG);
      r.p.axes[3] = -Math.sin(err * DEG);
      r.frame(1 / 60);
      max = Math.max(max, Math.abs(r.s.pitch / DEG));
    }
    expect(max).toBeLessThan(3);
  });
});

describe('Pad: Boost-Rand mit Hysterese (Review A3)', () => {
  /** Mittlere Yaw-Rate (°/s) über 2 s nach 1 s Anlauf; stick(f) liefert die Auslenkung je Frame. */
  function meanRate(stick: (f: number) => number): number {
    const r = rig();
    for (let f = 0; f < 60; f++) {
      r.p.axes[2] = stick(f);
      r.frame(1 / 60);
    }
    const y0 = r.s.yaw;
    for (let f = 60; f < 180; f++) {
      r.p.axes[2] = stick(f);
      r.frame(1 / 60);
    }
    return -(r.s.yaw - y0) / DEG / 2;
  }

  it('Zittern am Rand (0.93 ± 0.03) hält den Boost (vorher ~400 °/s, jetzt nahe der Spitze)', () => {
    let seed = 3;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
    const jitter = meanRate(() => 0.93 + rnd() * 0.03);
    // Spitze = Grundrate · (1 + Boost); vorher fiel Zittern auf die Grundkurve (~0.95 · Grundrate).
    expect(jitter).toBeGreaterThan(DEFAULT_PAD_SETTINGS.yawRate * 1.238);
  });

  it('0.90 von unten = Grundkurve; vom Rand auf 0.90 zurückgenommen = Boost bleibt; unter 0.85 aus', () => {
    const below = meanRate(() => 0.9);
    expect(below / DEFAULT_PAD_SETTINGS.yawRate).toBeCloseTo(362 / 420, 1);
    const fromRim = meanRate((f) => (f < 30 ? 1 : 0.9));
    expect(fromRim).toBeCloseTo(below * (1 + DEFAULT_PAD_SETTINGS.boost), 0);
    // Betrag 0.84 nach Deadzone = roh 0.12 + 0.84 · 0.83 → Uhr fällt auf 0, nur die Kurve.
    const raw = 0.12 + 0.84 * 0.83;
    const dropped = meanRate((f) => (f < 30 ? 1 : raw));
    expect(dropped).toBeCloseTo(DEFAULT_PAD_SETTINGS.yawRate * Math.pow(0.84, DEFAULT_PAD_SETTINGS.curve), 0);
  });

  it('8 Richtungen am Bewegungs-Stick: an der Bandkante W+A ↔ A kein Flattern mehr (vorher jeder Poll)', () => {
    const r = rig();
    const flips: string[] = [];
    let last = '';
    for (let i = 0; i < 600; i++) {
      // Links-vorn knapp an der Bandkante (150° ± 1°), wie ein Daumen beim W+A-Anlauf.
      const a = (150 + (i % 2 === 0 ? 1 : -1)) * DEG;
      r.p.axes[0] = Math.cos(a);
      r.p.axes[1] = -Math.sin(a);
      r.frame(1 / 128);
      const t = r.s.tickInput(0, 1);
      const k = `${t.forward},${t.side}`;
      if (k !== last) flips.push(k);
      last = k;
    }
    expect(flips.length).toBe(1);
  });
});

describe('Pad-Auswahl (Review A8)', () => {
  function twoPads(): { s: InputState; pad: PadInput; a: FakePad; b: FakePad; frame(dt?: number): void } {
    const s = new InputState();
    const a = fakePad();
    const b = { ...fakePad('Steam Virtual Gamepad (STANDARD GAMEPAD Vendor: 28de Product: 11ff)'), index: 1 };
    const pads: (GamepadLike | null)[] = [a, b];
    const pad = new PadInput(s, () => pads);
    pad.configure(DEFAULT_PAD_SETTINGS);
    s.setPadBindings(DEFAULT_PAD_SETTINGS.binds);
    pad.setMenuContext(false);
    return { s, pad, a, b, frame: (dt = 1 / 60) => { pad.poll(dt); s.beginFrame(dt); } };
  }

  it('aktives Pad weg, zweites verbunden → Pause und alles los (vorher: still weiter mit dem zweiten)', () => {
    const r = twoPads();
    press(r.a, 'PadLB', true);
    r.a.axes[0] = 1;
    r.frame();
    expect(r.s.tickInput(0, 1).jumpHeld).toBe(true);
    r.s.consumeActions();
    r.a.connected = false;
    r.frame();
    expect(r.s.consumeActions()).toEqual(['pause']);
    const t = r.s.tickInput(0, 1);
    expect([t.side, t.jumpHeld]).toEqual([0, false]);
  });

  it('nach dem Verlust zählt ein auf dem zweiten Pad schon gehaltener Knopf erst nach dem Loslassen', () => {
    const r = twoPads();
    press(r.a, 'PadA', true);
    r.frame();
    r.s.consumeActions();
    // Steam-Input-Spiegel: dasselbe A liegt auf beiden; das aktive verschwindet, das Spiel pausiert.
    press(r.b, 'PadA', true);
    r.a.connected = false;
    r.frame();
    expect(r.s.consumeActions()).toEqual(['pause']);
    r.pad.setMenuContext(true);
    for (let i = 0; i < 5; i++) r.frame();
    expect(r.s.consumeActions()).toEqual([]); // kein confirm aus dem gehaltenen A (würde die Pause sofort beenden)
    press(r.b, 'PadA', false);
    r.frame();
    press(r.b, 'PadA', true);
    r.frame();
    expect(r.s.consumeActions()).toEqual(['confirm']);
  });

  it('einziges Pad weg (Akku), kommt mit gehaltenem A wieder → dieser Druck zählt (Review N2)', () => {
    const r = rig();
    press(r.p, 'PadA', true);
    r.frame();
    press(r.p, 'PadA', false);
    r.frame();
    r.s.consumeActions();
    r.p.connected = false;
    r.frame();
    expect(r.s.consumeActions()).toEqual(['pause']);
    r.pad.setMenuContext(true);
    for (let i = 0; i < 60; i++) r.frame();
    // Chrome meldet das Pad erst mit dem weckenden Druck: erster Snapshot hat A schon gehalten.
    press(r.p, 'PadA', true);
    r.p.connected = true;
    r.frame();
    expect(r.s.consumeActions()).toEqual(['confirm']);
  });

  it('Pads ohne Standard-Mapping werden ignoriert (DirectInput: Trigger auf axes[2] ruht bei −1)', () => {
    const s = new InputState();
    const di: FakePad = { ...fakePad('USB Gamepad (Vendor: 0079 Product: 0006)'), mapping: '' };
    di.axes[2] = -1;
    const pad = new PadInput(s, () => [di]);
    pad.configure(DEFAULT_PAD_SETTINGS);
    pad.setMenuContext(false);
    for (let i = 0; i < 60; i++) {
      pad.poll(1 / 60);
      s.beginFrame(1 / 60);
    }
    expect(s.yaw).toBe(0); // vorher 588° in 1 s
    expect(pad.connected).toBe(false);
    expect(pad.consumeActivity()).toBe(false);
  });
});

describe('Pad-Belegung: Sprint/Langsamer auf LT, L3 frei (Review A9)', () => {
  it('beide Presets: sprint = LT, L3 nirgends belegt, LT sonst frei', () => {
    for (const id of ['bumper', 'classic'] as const) {
      const b = PAD_PRESETS[id];
      expect(b.sprint, id).toEqual(['PadLT']);
      for (const [action, codes] of Object.entries(b)) {
        expect(codes.includes('PadL3'), `${id}.${action}`).toBe(false);
        if (action !== 'sprint') expect(codes.includes('PadLT'), `${id}.${action}`).toBe(false);
      }
    }
    expect(DEFAULT_PAD_SETTINGS.binds).toBe(PAD_PRESETS.bumper);
  });

  it('Auto-Sprint: L3 hart gedrückt bremst nicht mehr, LT = langsamer', () => {
    const r = rig();
    r.s.setAutoSprint(true);
    r.p.axes[1] = -1;
    press(r.p, 'PadL3', true);
    r.frame();
    expect(r.s.tickInput(0, 1).sprint).toBe(true);
    press(r.p, 'PadL3', false);
    press(r.p, 'PadLT', 0.8);
    r.frame();
    expect(r.s.tickInput(0, 1).sprint).toBe(false);
  });
});
