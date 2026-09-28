import type { MutablePlayerInput, PlayerInput } from '../player/types';
import type { KeyBinds } from './settingsTypes';
import { DEFAULT_KEYBINDS } from './settingsTypes';

/**
 * DOM-freier Kern der Eingabe: Tastenzustand, Belegung, Sprung-Flanken,
 * Tipp-Klammern, Blickwinkel und Subtick-Verteilung. `InputManager` füttert
 * ihn mit Browser-Events; Tests und Tools können ihn direkt benutzen.
 */

/** 'demo' (Plan 007) kommt aus der Belegung (KeyBinds.demo, Default H), die übrigen aus ACTION_CODES. */
export type InputAction = 'restart' | 'respawn' | 'pause' | 'toggleTuning' | 'toggleMute' | 'confirm' | 'demo';

export type InputOverride = (tickIndex: number, ticksThisFrame: number) => PlayerInput;

/** Hinweise der Eingabe an die Spielerin (HUD zeigt den Text, siehe Hud.onInputNotice). */
export type InputNotice = 'ctrlCrouchNeedsFullscreen';

/** Bewegungstasten (fest, physische Codes — layoutunabhängig, AZERTY bekommt automatisch ZQSD). */
export const MOVE_CODES = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
} as const;

/**
 * Maustasten als Pseudo-Codes im selben held-Set wie die Tastatur — Flanken,
 * Auto-Hop und Tipp-Klammer funktionieren so ohne Sonderfall. Index =
 * MouseEvent.button, Namen nach CS-Zählung (MOUSE1 links, MOUSE2 rechts, MOUSE3 Mitte).
 */
export const MOUSE_CODES: readonly string[] = ['Mouse1', 'Mouse3', 'Mouse2', 'Mouse4', 'Mouse5'];

export const ACTION_CODES: Readonly<Record<string, InputAction>> = {
  KeyR: 'restart',
  // Zurück zum letzten Checkpoint (Üben ohne Absturz abzuwarten, wie Teleport auf Bhop-/KZ-Servern).
  KeyF: 'respawn',
  Escape: 'pause',
  F1: 'toggleTuning',
  KeyM: 'toggleMute',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
};

/**
 * Belegbare Codes. Keine F-Tasten (F5/F11/F12 gehören dem Browser), kein
 * Backspace/Entf (löschen im Belegungs-Dialog), keine Linksklick-Belegung
 * (Mouse1 ist Fortsetzen/Bedienen), keine Meta-Taste (nicht sperrbar).
 */
const BINDABLE =
  /^(Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal)|Space|Tab|CapsLock|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|IntlBackslash|Semicolon|Quote|Comma|Period|Slash|Shift(?:Left|Right)|Control(?:Left|Right)|Alt(?:Left|Right)|Arrow(?:Up|Down|Left|Right)|Insert|Home|End|PageUp|PageDown|Mouse[2-5])$/;

const RESERVED: ReadonlySet<string> = new Set<string>([...Object.keys(ACTION_CODES), ...Object.values(MOVE_CODES)]);

/** Darf dieser Code einer Aktion (Springen/Ducken/Sprint) zugewiesen werden? */
export function isBindableCode(code: string): boolean {
  return BINDABLE.test(code) && !RESERVED.has(code);
}

function isCtrl(code: string): boolean {
  return code === 'ControlLeft' || code === 'ControlRight';
}

const SHORT_LABELS: Readonly<Record<string, string>> = {
  Space: 'SPACE',
  ShiftLeft: 'SHIFT',
  ShiftRight: 'SHIFT',
  ControlLeft: 'STRG',
  ControlRight: 'STRG',
  AltLeft: 'ALT',
  AltRight: 'ALTGR',
  CapsLock: 'CAPS',
  Tab: 'TAB',
};

/** Kurzname für HUD und Hinweise (Versalien, ≤ 5 Zeichen): KeyC → C, Mouse4 → M4. */
export function keyShortLabel(code: string): string {
  const fixed = SHORT_LABELS[code];
  if (fixed !== undefined) return fixed;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Mouse')) return `M${code.slice(5)}`;
  if (code.startsWith('Numpad')) return `N${code.slice(6, 9).toUpperCase()}`;
  if (code.startsWith('Arrow')) return code.slice(5, 10).toUpperCase();
  return code.slice(0, 5).toUpperCase();
}

const LONG_LABELS: Readonly<Record<string, string>> = {
  Space: 'Leertaste',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift rechts',
  ControlLeft: 'Strg',
  ControlRight: 'Strg rechts',
  AltLeft: 'Alt',
  AltRight: 'AltGr',
  CapsLock: 'Feststell',
  Tab: 'Tab',
  Mouse2: 'Maus rechts',
  Mouse3: 'Maus Mitte',
  Mouse4: 'Maus 4',
  Mouse5: 'Maus 5',
};

/** Lesbarer Name fürs Menü: KeyC → C, Space → Leertaste, Mouse4 → Maus 4. */
export function keyLabel(code: string): string {
  return LONG_LABELS[code] ?? keyShortLabel(code);
}

const DEG2RAD = Math.PI / 180;
/** ±89°: bei exakt 90° kippt die Kamerabasis (Gimbal), Source klemmt genauso. */
export const PITCH_LIMIT = 89 * DEG2RAD;
const TWO_PI = Math.PI * 2;

export interface LookSettings {
  readonly sensitivity: number;
  readonly mYaw: number;
  readonly invertY: boolean;
}

// Logische Knöpfe (Bit-Index in Masken).
const B_FORWARD = 0;
const B_BACK = 1;
const B_LEFT = 2;
const B_RIGHT = 3;
const B_JUMP = 4;
const B_CROUCH = 5;
const B_SPRINT = 6;
const BUTTON_COUNT = 7;
const JUMP_BIT = 1 << B_JUMP;

export class InputState {
  private readonly held = new Set<string>();
  /** Codes je logischem Knopf (Index B_*): WASD fest, der Rest aus der Belegung. */
  private buttonCodes: string[][] = [];
  /** Code → Bitmaske der Knöpfe, die er auslöst (ein Code darf mehrere Aktionen haben). */
  private codeMask = new Map<string, number>();
  /** Codes der Vorführung (KeyBinds.demo): lösen die Aktion 'demo' aus, kein gehaltener Knopf. */
  private demoCodes: ReadonlySet<string> = new Set<string>();
  private binds: KeyBinds = DEFAULT_KEYBINDS;
  /**
   * Tipp-Klammer: Knöpfe, die seit dem letzten Tick gedrückt wurden. Gelten im
   * nächsten Tick als gehalten, auch wenn sie schon wieder los sind — ein
   * Tipper unter einem Frame (Rapid-Trigger-Tastatur) wirkt so mindestens einen Tick.
   */
  private latch = 0;
  /** Sprung-Flanke seit dem letzten Tick (Sprungtaste ohne repeat oder Mausrad). */
  private pendingJump = false;
  /** Mausrad-Impuls: gilt genau einen Tick als gehaltene Taste. */
  private pendingWheel = false;
  private actions: InputAction[] = [];
  private override: InputOverride | null = null;
  /** Auto-Sprint: am Boden immer Sprint, die Sprint-Taste läuft langsamer. */
  private autoSprint = false;

  /** Aktueller Blick (roh, sofort) — Kamera nutzt diesen Wert, nie den interpolierten. */
  private curYaw = 0;
  private curPitch = 0;
  /** Blick-Sample des vorigen Frames (Start der Subtick-Interpolation). */
  private startYaw = 0;
  private startPitch = 0;
  /** Blick-Sample dieses Frames (Ziel der Subtick-Interpolation). */
  private frameYaw = 0;
  private framePitch = 0;
  /** beginFrame() lief seit dem letzten Tick-Block — sonst holt Tick 0 das Sample selbst nach. */
  private frameSampled = false;
  private ctrlCrouch = true;
  /** Wiederverwendetes Ergebnis von tickInput — kein Objekt pro Tick (AGENTS.md §4). */
  private readonly out: MutablePlayerInput = {
    forward: 0,
    side: 0,
    jumpHeld: false,
    jumpPressed: false,
    crouch: false,
    sprint: false,
    yaw: 0,
    pitch: 0,
  };

  constructor(binds: KeyBinds = DEFAULT_KEYBINDS) {
    this.setBindings(binds);
  }

  get yaw(): number {
    return this.curYaw;
  }

  get pitch(): number {
    return this.curPitch;
  }

  /** Aktuelle Belegung (für Keyboard Lock und Anzeigen). */
  get bindings(): KeyBinds {
    return this.binds;
  }

  /** Belegung setzen (selten: Einstellungen) — baut die Code-Tabellen neu. */
  setBindings(binds: KeyBinds): void {
    this.binds = binds;
    const codes: string[][] = [];
    for (let b = 0; b < BUTTON_COUNT; b++) codes.push([]);
    codes[B_FORWARD].push(MOVE_CODES.forward);
    codes[B_BACK].push(MOVE_CODES.back);
    codes[B_LEFT].push(MOVE_CODES.left);
    codes[B_RIGHT].push(MOVE_CODES.right);
    for (const c of binds.jump) codes[B_JUMP].push(c);
    for (const c of binds.crouch) codes[B_CROUCH].push(c);
    for (const c of binds.sprint) codes[B_SPRINT].push(c);
    const mask = new Map<string, number>();
    for (let b = 0; b < BUTTON_COUNT; b++) {
      for (const c of codes[b]) mask.set(c, (mask.get(c) ?? 0) | (1 << b));
    }
    this.buttonCodes = codes;
    this.codeMask = mask;
    this.demoCodes = new Set(binds.demo);
  }

  /** Auto-Sprint an/aus (Einstellung autoSprint). */
  setAutoSprint(on: boolean): void {
    this.autoSprint = on;
  }

  get autoSprintEnabled(): boolean {
    return this.autoSprint;
  }

  /** true, wenn die Taste zum Spiel gehört (Aufrufer entscheidet über preventDefault). */
  isGameCode(code: string): boolean {
    return this.codeMask.has(code) || this.demoCodes.has(code) || ACTION_CODES[code] !== undefined;
  }

  /** Strg ist einer Aktion zugewiesen, zählt aber gerade nicht (Fenstermodus ohne Keyboard Lock). */
  isBlockedCtrl(code: string): boolean {
    return !this.ctrlCrouch && isCtrl(code) && this.codeMask.has(code);
  }

  keyDown(code: string, repeat: boolean): boolean {
    const action = ACTION_CODES[code];
    if (action !== undefined) {
      if (!repeat) this.actions.push(action);
      return true;
    }
    const demo = this.demoCodes.has(code);
    if (demo && !repeat) this.actions.push('demo');
    const mask = this.codeMask.get(code);
    if (mask === undefined) return demo;
    if (!repeat) {
      // Jede echte Druck-Flanke zählt — auch wenn ein keyup verloren ging und die Taste noch als gehalten gilt.
      const live = isCtrl(code) && !this.ctrlCrouch ? 0 : mask;
      if (live & JUMP_BIT) this.pendingJump = true;
      this.latch |= live;
    }
    this.held.add(code);
    return true;
  }

  keyUp(code: string): boolean {
    const had = this.held.delete(code);
    return had || this.isGameCode(code);
  }

  /** Ein Mausrad-Event (egal welche Richtung) = ein Sprung-Impuls. */
  wheel(): void {
    this.pendingJump = true;
    this.pendingWheel = true;
  }

  pushAction(a: InputAction): void {
    this.actions.push(a);
  }

  /** Fokusverlust, Tab-Wechsel, Lock-Verlust: sonst läuft man mit "klemmender" Taste weiter. */
  releaseAll(): void {
    this.held.clear();
    this.clearEdges();
  }

  /** Nur wartende Flanken und Tipp-Klammern verwerfen, gehaltene Tasten bleiben. */
  clearEdges(): void {
    this.pendingJump = false;
    this.pendingWheel = false;
    this.latch = 0;
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  /** Zählt Strg als Taste? (Default an; InputManager schaltet es nur mit Keyboard Lock ein.) */
  get ctrlCrouchEnabled(): boolean {
    return this.ctrlCrouch;
  }

  setCtrlCrouch(on: boolean): void {
    this.ctrlCrouch = on;
  }

  consumeActions(): readonly InputAction[] {
    if (this.actions.length === 0) return EMPTY_ACTIONS;
    const out = this.actions;
    this.actions = [];
    return out;
  }

  setOverride(fn: InputOverride | null): void {
    this.override = fn;
  }

  /**
   * Rohe Maus-Counts → Blick. Grad = Counts × sensitivity × m_yaw (CS-Formel),
   * keine Glättung, keine Beschleunigung. Maus nach rechts (dx > 0) → yaw kleiner.
   */
  look(dx: number, dy: number, s: LookSettings): void {
    const radPerCount = s.sensitivity * s.mYaw * DEG2RAD;
    this.curYaw -= dx * radPerCount;
    const dPitch = dy * radPerCount * (s.invertY ? 1 : -1);
    this.curPitch = clamp(this.curPitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Blick hart setzen (Spawn/Respawn) — ohne Subtick-Schwenk über die alte Richtung. */
  setView(yaw: number, pitch: number): void {
    this.curYaw = yaw;
    this.curPitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.startYaw = this.frameYaw = this.curYaw;
    this.startPitch = this.framePitch = this.curPitch;
  }

  /**
   * Blick-Sample dieses Frames, VOR seinen Ticks und in JEDEM Frame — auch ohne
   * Tick (FixedLoop.onFrameStart). Sonst bekäme bei 144 Hz / 128 Tick der Tick
   * nach einem leeren Frame zwei Frames Drehung (fallen.md #45). Keine Latenz:
   * Maus-Events kommen nie während der Ticks, das Sample ist der aktuelle Blick.
   */
  beginFrame(): void {
    // Yaw nicht unbegrenzt wachsen lassen (Float-Präzision nach vielen Drehungen);
    // alle Werte gemeinsam verschieben, damit die Interpolation unverändert bleibt.
    if (Math.abs(this.curYaw) > 64 * Math.PI) {
      const shift = Math.round(this.curYaw / TWO_PI) * TWO_PI;
      this.curYaw -= shift;
      this.startYaw -= shift;
      this.frameYaw -= shift;
    }
    this.startYaw = this.frameYaw;
    this.startPitch = this.framePitch;
    this.frameYaw = this.curYaw;
    this.framePitch = this.curPitch;
    this.frameSampled = true;
  }

  /**
   * Eingabe für Tick i von n dieses Frames. Der Blick wird zwischen den Samples
   * des vorigen und dieses Frames interpoliert, bei u = Zeitpunkt des Tick-Endes
   * im Frame-Intervall (FixedLoop liefert u). So dreht jeder Tick genau den
   * Anteil, der in seine Zeit fällt — gleich große Schritte bei jeder Bildrate.
   * Ohne u (Aufrufer ohne Loop) gilt der Index-Anteil (i+1)/n.
   *
   * Das zurückgegebene Objekt wird wiederverwendet: gültig bis zum nächsten tickInput.
   */
  tickInput(i: number, n: number, u?: number): PlayerInput {
    if (i === 0 && !this.frameSampled) this.beginFrame();
    const t = u !== undefined ? clamp(u, 0, 1) : n > 0 ? Math.min(1, (i + 1) / n) : 1;
    const yaw = this.startYaw + (this.frameYaw - this.startYaw) * t;
    const pitch = this.startPitch + (this.framePitch - this.startPitch) * t;

    const pressed = this.pendingJump;
    const wheelHeld = this.pendingWheel;
    const latch = this.latch;
    this.pendingJump = false;
    this.pendingWheel = false;
    this.latch = 0;

    if (i >= n - 1) this.frameSampled = false;

    if (this.override) return this.override(i, n);

    const out = this.out;
    out.forward = (this.on(B_FORWARD, latch) ? 1 : 0) - (this.on(B_BACK, latch) ? 1 : 0);
    out.side = (this.on(B_RIGHT, latch) ? 1 : 0) - (this.on(B_LEFT, latch) ? 1 : 0);
    // Druck + Loslassen zwischen zwei Ticks zählt in diesem Tick als gehalten (wie Source-Kbutton).
    out.jumpHeld = this.on(B_JUMP, latch) || pressed || wheelHeld;
    out.jumpPressed = pressed;
    out.crouch = this.on(B_CROUCH, latch);
    const speedKey = this.on(B_SPRINT, latch);
    out.sprint = this.autoSprint ? !speedKey : speedKey;
    out.yaw = yaw;
    out.pitch = pitch;
    return out;
  }

  /** Knopf gehalten oder seit dem letzten Tick getippt. Index-Schleife: for-of allokiert Iteratoren (alloc-probe). */
  private on(button: number, latch: number): boolean {
    if ((latch >> button) & 1) return true;
    const codes = this.buttonCodes[button];
    const held = this.held;
    const skipCtrl = !this.ctrlCrouch;
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      if (skipCtrl && isCtrl(c)) continue;
      if (held.has(c)) return true;
    }
    return false;
  }
}

const EMPTY_ACTIONS: readonly InputAction[] = Object.freeze([]);

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
