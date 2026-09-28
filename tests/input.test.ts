import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FixedLoop } from '../src/engine/Loop';
import { InputState, isBindableCode, keyShortLabel } from '../src/engine/InputState';
import { InputManager } from '../src/engine/Input';
import type { PointerLockTarget } from '../src/engine/Input';
import { DEFAULT_KEYBINDS, DEFAULT_SETTINGS } from '../src/engine/settingsTypes';
import { PlayerMovement } from '../src/player/PlayerMovement';
import { VELOCITY_DEFAULT } from '../src/player/MovementConfig';
import type { PlayerInput } from '../src/player/types';
import { compileLevel } from '../src/world/level/compileLevel';
import { flatLevel } from '../tools/sim/levels';

const tick = (s: InputState): PlayerInput => s.tickInput(0, 1);

describe('Tastenbelegung (U3)', () => {
  it('an Mouse4 gebundener Sprung erzeugt jumpPressed, Loslassen wirkt', () => {
    const s = new InputState({ ...DEFAULT_KEYBINDS, jump: ['Space', 'Mouse4'] });
    expect(s.isGameCode('Mouse4')).toBe(true);
    s.keyDown('Mouse4', false);
    const a = tick(s);
    expect(a.jumpPressed).toBe(true);
    expect(a.jumpHeld).toBe(true);
    // Gehalten: Auto-Hop sieht jumpHeld ohne neue Flanke.
    const b = tick(s);
    expect(b.jumpPressed).toBe(false);
    expect(b.jumpHeld).toBe(true);
    s.keyUp('Mouse4');
    expect(tick(s).jumpHeld).toBe(false);
  });

  it('Neubelegung: alte Taste gehört nicht mehr zum Spiel, neue schon', () => {
    const s = new InputState();
    s.setBindings({ ...DEFAULT_KEYBINDS, crouch: ['Mouse5'] });
    expect(s.isGameCode('KeyC')).toBe(false);
    s.keyDown('KeyC', false);
    expect(tick(s).crouch).toBe(false);
    s.keyDown('Mouse5', false);
    expect(tick(s).crouch).toBe(true);
  });

  it('reservierte Codes sind nicht belegbar (Aktionen, WASD, Linksklick, F-Tasten)', () => {
    for (const c of ['KeyR', 'KeyF', 'KeyM', 'Escape', 'Enter', 'KeyW', 'KeyA', 'Mouse1', 'F5', 'Backspace', 'MetaLeft']) {
      expect(isBindableCode(c), c).toBe(false);
    }
    for (const c of ['Space', 'KeyC', 'ControlLeft', 'ShiftLeft', 'Mouse2', 'Mouse4', 'Mouse5', 'KeyE', 'Digit1']) {
      expect(isBindableCode(c), c).toBe(true);
    }
    expect(keyShortLabel('Mouse4')).toBe('M4');
    expect(keyShortLabel('KeyC')).toBe('C');
    expect(keyShortLabel('ControlLeft')).toBe('STRG');
  });
});

describe('Auto-Sprint (U4)', () => {
  it('an: ohne Taste Sprint, mit Shift langsamer; aus: altes Verhalten', () => {
    const s = new InputState();
    s.setAutoSprint(true);
    expect(tick(s).sprint).toBe(true);
    s.keyDown('ShiftLeft', false);
    expect(tick(s).sprint).toBe(false);
    s.keyUp('ShiftLeft');
    s.setAutoSprint(false);
    expect(tick(s).sprint).toBe(false);
    s.keyDown('ShiftLeft', false);
    expect(tick(s).sprint).toBe(true);
  });

  it('Override-Pfad (Bots) bleibt unberührt', () => {
    const s = new InputState();
    s.setAutoSprint(true);
    s.setOverride(() => ({ forward: 1, side: 0, jumpHeld: false, jumpPressed: false, crouch: false, sprint: false, yaw: 0, pitch: 0 }));
    expect(tick(s).sprint).toBe(false);
  });

  /** W halten auf flachem Boden, Zeit bis 99 % Zieltempo und Endtempo. */
  function walk(autoSprint: boolean, shift: boolean): { t320: number; t250: number; top: number } {
    const lvl = compileLevel(flatLevel(8000));
    const pm = new PlayerMovement(lvl.world, VELOCITY_DEFAULT);
    pm.teleport(new Vector3(0, 1, 6000));
    const s = new InputState();
    s.setAutoSprint(autoSprint);
    s.setView(0, 0);
    s.keyDown('KeyW', false);
    if (shift) s.keyDown('ShiftLeft', false);
    let t = 0;
    let t320 = Infinity;
    let t250 = Infinity;
    const dt = 1 / VELOCITY_DEFAULT.tickRate;
    // Erst auf dem Boden absetzen lassen.
    for (let i = 0; i < 32; i++) pm.tick({ ...tick(s), forward: 0 });
    for (let i = 0; i < VELOCITY_DEFAULT.tickRate; i++) {
      pm.tick(tick(s));
      t += dt;
      if (t320 === Infinity && pm.state.speed >= 0.99 * 320) t320 = t;
      if (t250 === Infinity && pm.state.speed >= 0.99 * 250) t250 = t;
    }
    return { t320, t250, top: pm.state.speed };
  }

  it('flach: W allein erreicht 320 u/s in ≤ 0.25 s, Shift+W bleibt bei 250', () => {
    const w = walk(true, false);
    expect(w.t320).toBeLessThanOrEqual(0.25);
    expect(w.top).toBeCloseTo(VELOCITY_DEFAULT.sprintSpeed, 0);
    const slow = walk(true, true);
    expect(slow.top).toBeCloseTo(VELOCITY_DEFAULT.runSpeed, 0);
    expect(slow.t250).toBeLessThanOrEqual(0.25);
  });

  it('aus: W = 250, Shift+W = 320 (wie vorher)', () => {
    expect(walk(false, false).top).toBeCloseTo(VELOCITY_DEFAULT.runSpeed, 0);
    expect(walk(false, true).top).toBeCloseTo(VELOCITY_DEFAULT.sprintSpeed, 0);
  });
});

describe('Tipp-Klammer (U7)', () => {
  it('Druck + Loslassen vor dem Tick wirkt genau einen Tick (C, D, W, Shift)', () => {
    const s = new InputState();
    s.keyDown('KeyC', false);
    s.keyUp('KeyC');
    s.keyDown('KeyD', false);
    s.keyUp('KeyD');
    s.keyDown('KeyW', false);
    s.keyUp('KeyW');
    const a = tick(s);
    expect(a.crouch).toBe(true);
    expect(a.side).toBe(1);
    expect(a.forward).toBe(1);
    const b = tick(s);
    expect(b.crouch).toBe(false);
    expect(b.side).toBe(0);
    expect(b.forward).toBe(0);
  });

  it('Frame ohne Tick (144 Hz): die Klammer wartet auf den nächsten Tick', () => {
    const s = new InputState();
    const seen: number[] = [];
    let tapNow = false;
    const loop = new FixedLoop({
      tickRate: 128,
      onFrameStart: () => s.beginFrame(),
      onTick: (_dt, i, n, u) => seen.push(s.tickInput(i, n, u).side),
      onFrame: () => {
        if (tapNow) {
          s.keyDown('KeyA', false);
          s.keyUp('KeyA');
          tapNow = false;
        }
      },
      now: () => 0,
    });
    // 144 Hz: jeder ~9. Frame hat keinen Tick. Tipper in jedem 5. Frame, jeder muss genau einmal ankommen.
    let taps = 0;
    for (let f = 0; f < 144; f++) {
      if (f % 5 === 0) {
        tapNow = true;
        taps++;
      }
      loop.advance(1 / 144);
    }
    loop.advance(1 / 144);
    expect(seen.filter((v) => v === -1).length).toBe(taps);
  });

  it('Strg ohne Keyboard Lock setzt keine Klammer', () => {
    const s = new InputState();
    s.setCtrlCrouch(false);
    s.keyDown('ControlLeft', false);
    s.keyUp('ControlLeft');
    expect(tick(s).crouch).toBe(false);
  });
});

// ------------------------------------------------------------------ InputManager mit Fake-DOM (U8)

/** Nur was InputManager vom document liest. */
class FakeDocument extends EventTarget {
  pointerLockElement: object | null = null;
  fullscreenElement: object | null = null;
  activeElement: object | null = null;
  visibilityState = 'visible';
  exitPointerLock(): void {
    this.pointerLockElement = null;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

interface FakeDom {
  readonly target: PointerLockTarget;
  readonly doc: FakeDocument;
}

const saved: Record<string, PropertyDescriptor | undefined> = {};

function installDom(mode: 'promise' | 'undefined' | 'notSupported'): FakeDom {
  const doc = new FakeDocument();
  const lockNow = (): void => {
    doc.pointerLockElement = target;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const target: PointerLockTarget = {
    requestPointerLock(options?: PointerLockOptions): Promise<void> | undefined {
      if (mode === 'undefined') {
        // Älterer Browser: kein Promise, Lock kommt nur per Event (Option wird still ignoriert).
        lockNow();
        return undefined;
      }
      if (mode === 'notSupported' && options?.unadjustedMovement) {
        return Promise.reject(new DOMException('unadjustedMovement nicht unterstützt', 'NotSupportedError'));
      }
      lockNow();
      return Promise.resolve();
    },
  };
  for (const k of ['document', 'window', 'HTMLElement']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: class {}, configurable: true, writable: true });
  return { target, doc };
}

function restoreDom(): void {
  for (const [k, d] of Object.entries(saved)) {
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
}

describe('Raw-Maus erkennen (U8)', () => {
  let dom: FakeDom | null = null;
  beforeEach(() => {
    dom = null;
  });
  afterEach(() => {
    restoreDom();
  });

  it('requestPointerLock ohne Promise → gefangen, aber nicht roh', async () => {
    dom = installDom('undefined');
    const im = new InputManager(dom.target, () => DEFAULT_SETTINGS);
    expect(im.rawStatus).toBe('unknown');
    expect(await im.requestLock()).toBe(true);
    expect(im.locked).toBe(true);
    expect(im.rawInput).toBe(false);
    expect(im.rawStatus).toBe('unavailable');
    im.dispose();
  });

  it('Promise mit unadjustedMovement → roh', async () => {
    dom = installDom('promise');
    const im = new InputManager(dom.target, () => DEFAULT_SETTINGS);
    expect(await im.requestLock()).toBe(true);
    expect(im.rawInput).toBe(true);
    expect(im.rawStatus).toBe('active');
    im.dispose();
  });

  it('NotSupportedError → Rückfall ohne Raw, Status "nicht verfügbar"', async () => {
    dom = installDom('notSupported');
    const im = new InputManager(dom.target, () => DEFAULT_SETTINGS);
    expect(await im.requestLock()).toBe(true);
    expect(im.rawInput).toBe(false);
    expect(im.rawStatus).toBe('unavailable');
    im.dispose();
  });

  it('Maustasten im Lock landen als Pseudo-Code im held-Set (Mouse4 = Sprung)', async () => {
    dom = installDom('promise');
    const im = new InputManager(dom.target, () => DEFAULT_SETTINGS);
    im.configure({ ...DEFAULT_KEYBINDS, jump: ['Space', 'Mouse4'] }, true);
    await im.requestLock();
    const down = Object.assign(new Event('mousedown', { cancelable: true }), { button: 3 });
    window.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true); // Browser-Zurück geschluckt
    const a = im.tickInput(0, 1);
    expect(a.jumpPressed).toBe(true);
    expect(a.sprint).toBe(true); // Auto-Sprint aus configure
    window.dispatchEvent(Object.assign(new Event('mouseup', { cancelable: true }), { button: 3 }));
    expect(im.tickInput(0, 1).jumpHeld).toBe(false);
    im.dispose();
  });
});
