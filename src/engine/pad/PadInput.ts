import type { InputAction } from '../InputState';
import { DEFAULT_LOOK_CURVE, boostFactor, digitizeMove, edgeClock, lookRate, stickMagnitude } from './stickCurve';
import type { LookCurveParams, LookRateOut, MoveOut } from './stickCurve';
import { padKindFromId } from './prompts';
import type { InputDevice, PadBindAction, PadButtonCode, PadSettings } from './types';
import {
  DEFAULT_PAD_SETTINGS,
  PAD_BUTTONS,
  PAD_CAPTURE_CANCEL_HOLD,
  PAD_CAPTURE_TIMEOUT,
  PAD_RESTART_HOLD,
  PAD_TRIGGER_OFF,
  PAD_TRIGGER_ON,
} from './types';

/**
 * Gamepad-Abfrage (Plan 011 §1.3), DOM-frei: die Quelle (navigator.getGamepads oder ein Fake) wird
 * hineingereicht, das Ergebnis geht an einen PadSink (InputState). Pro Frame genau ein poll() VOR
 * InputState.beginFrame — Flanken je Knopf, Trigger mit Hysterese, Stick → 8 Richtungen (digital,
 * volle wishspeed), Kamera-Stick → Drehrate (rad/s), ohne Glättung.
 *
 * Kontexte: Spiel = Knöpfe als Pseudo-Codes ins held-Set + Aktionen aus der Belegung; Menü = feste
 * Menü-Aktionen (A bestätigt, B/Start zurück, Steuerkreuz/Stick navigieren mit Wiederholung, LB/RB Tabs).
 * Beim Kontextwechsel gedrückte Knöpfe zählen erst nach dem Loslassen wieder (A bestätigt im Menü →
 * kein Sprung im Spiel), und Laufrichtung/Drehrate gehen auf 0 — InputState integriert die Rate jeden
 * Frame, auch hinter einem Menü (Review A1: sonst drehte die Welt hinter der Pause mit 630 °/s weiter).
 *
 * Nur Pads mit `mapping === 'standard'` (Review A8): sonst stimmen Knopf- und Achsen-Indizes nicht
 * (DirectInput: Trigger auf axes[2], Ruhewert −1 = Dauerdrehen).
 */

export interface GamepadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

/** Ausschnitt von `Gamepad`, den wir lesen (echte Gamepads erfüllen ihn strukturell). */
export interface GamepadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly buttons: readonly GamepadButtonLike[];
  readonly axes: readonly number[];
}

/** null = gerade nichts abzufragen (kein Pad verbunden) — spart den Aufruf von getGamepads. */
export type GamepadSource = () => ArrayLike<GamepadLike | null> | null;

/** Was PadInput an der Eingabe bewegt (InputState erfüllt das). */
export interface PadSink {
  padButton(code: PadButtonCode, down: boolean): void;
  setPadMove(fwd: number, side: number): void;
  setLookRate(yawRate: number, pitchRate: number): void;
  pushAction(a: InputAction): void;
}

const N = PAD_BUTTONS.length;
const I_A = 0;
const I_B = 1;
const I_X = 2;
const I_Y = 3;
const I_LB = 4;
const I_RB = 5;
const I_LT = 6;
const I_RT = 7;
const I_MENU = 9;
const I_HOME = 16;
const I_UP = 12;
const I_DOWN = 13;
const I_LEFT = 14;
const I_RIGHT = 15;

/** Stick-Betrag, ab dem er als "benutzt" zählt (Gerätewechsel) bzw. im Menü navigiert — Drift bleibt drunter. */
const STICK_ACTIVE = 0.5;
/** Menü-Navigation: erste Wiederholung nach DELAY, dann alle REPEAT Sekunden. */
const NAV_DELAY = 0.35;
const NAV_REPEAT = 0.12;

/** Nach Kontextwechsel: erst Neutralstellung abwarten. */
const NAV_WAIT = -1;
const NAV_NONE = 0;
const NAV_UP = 1;
const NAV_DOWN = 2;
const NAV_LEFT = 3;
const NAV_RIGHT = 4;
const NAV_ACTIONS: readonly InputAction[] = ['navUp', 'navUp', 'navDown', 'navLeft', 'navRight'];

/** Belegungs-Aufnahme: nächster Knopf, null = abgebrochen (B gehalten, Start, Zeit, Pad weg, Fokusverlust). */
export type PadCaptureCallback = (code: PadButtonCode | null) => void;

/** Spiel-Aktionen auf Knopfdruck (restart läuft über die Halte-Uhr). */
const PRESS_ACTIONS: readonly (PadBindAction & InputAction)[] = ['respawn', 'demo', 'pause'];

export class PadInput {
  private readonly sink: PadSink;
  private readonly source: GamepadSource;
  private settings: PadSettings = DEFAULT_PAD_SETTINGS;
  /** Kurve aus den Einstellungen; `flat` = dieselbe ohne Boost (der Boost wird über den Frame gemittelt). */
  private curve: LookCurveParams = DEFAULT_LOOK_CURVE;
  private flat: LookCurveParams = { ...DEFAULT_LOOK_CURVE, boost: 0 };
  /** Bitmaske je Spiel-Aktion (Index wie PAD_BUTTONS). */
  private actionMask: { [K in PadBindAction]: number } = { jump: 0, crouch: 0, sprint: 0, respawn: 0, demo: 0, restart: 0, pause: 0 };

  private menu = true;
  /** Index des Pads, das zuletzt Eingaben gemacht hat (−1 = keins). */
  private activeIndex = -1;
  private activeId = '';
  private padKind: InputDevice = 'generic';
  /** Knopfzustand des aktiven Pads (Bits wie PAD_BUTTONS). */
  private down = 0;
  /** Gedrückt beim Kontext-/Padwechsel: zählt erst nach dem Loslassen. */
  private suppressed = 0;
  /** An die Senke gemeldete gehaltene Codes (Spiel-Kontext). */
  private sent = 0;
  private restartHeld = 0;
  private restartFired = false;
  /** Boost-Uhr des Kamera-Sticks (s am Rand, stickCurve.edgeClock). */
  private edgeTime = 0;
  private navDir = NAV_NONE;
  private navTimer = 0;
  /** Seit dem letzten consumeActivity() Eingaben am Pad (Gerätewechsel): Knopfdruck oder Stick-Flanke. */
  private activity = false;
  /** Ein Stick stand im letzten Poll über STICK_ACTIVE — Aktivität zählt nur die Flanke (Review A4). */
  private stickHot = false;
  /** Sekunden seit der letzten Pad-Eingabe (Knopfdruck, Stick über STICK_ACTIVE); Infinity = noch nie. */
  private idle = Infinity;
  /** Pad seit dem Verbinden benutzt (nur dann pausiert ein Trennen im Spiel). */
  private used = false;
  /** Das aktive Pad ging verloren: beim nächsten Pad zählen schon gehaltene Knöpfe erst nach dem Loslassen. */
  private afterLoss = false;
  /** Knopf-Drücke seit consumePresses() (Vorführung endet mit "jeder Taste"; Sticks zählen nicht). */
  private presses = 0;
  /** Letzte Stick-Rohwerte (Debug/Test-Anzeige im Menü). */
  readonly sticks = { lx: 0, ly: 0, rx: 0, ry: 0 };
  /** Letzte Stellgrößen (Debug): digitale Richtung und Drehrate (rad/s, Yaw/Pitch-Raum). */
  readonly output = { fwd: 0, side: 0, yawRate: 0, pitchRate: 0 };

  /** Laufende Belegungs-Aufnahme (Menü): Knöpfe werden gemeldet statt zu Aktionen. */
  private captureCb: PadCaptureCallback | null = null;
  private captureLeft = 0;
  /** B gedrückt seit (s) während der Aufnahme; −1 = nicht gedrückt. B kurz = B belegen, lang = abbrechen. */
  private captureB = -1;

  private readonly move: MoveOut = { fwd: 0, side: 0 };
  private readonly rate: LookRateOut = { yaw: 0, pitch: 0 };

  constructor(sink: PadSink, source: GamepadSource) {
    this.sink = sink;
    this.source = source;
  }

  /** Einstellungen übernehmen (selten, darf allokieren). */
  configure(s: PadSettings): void {
    this.settings = s;
    this.curve = {
      ...DEFAULT_LOOK_CURVE,
      maxYawRate: s.yawRate,
      maxPitchRate: s.pitchRate,
      exponent: s.curve,
      inner: s.deadzoneInner,
      outer: s.deadzoneOuter,
      boost: s.boost,
    };
    this.flat = { ...this.curve, boost: 0 };
    const mask = (list: readonly PadButtonCode[]): number => {
      let m = 0;
      for (const c of list) {
        const i = PAD_BUTTONS.indexOf(c);
        if (i >= 0) m |= 1 << i;
      }
      return m;
    };
    const b = s.binds;
    this.actionMask = {
      jump: mask(b.jump),
      crouch: mask(b.crouch),
      sprint: mask(b.sprint),
      respawn: mask(b.respawn),
      demo: mask(b.demo),
      restart: mask(b.restart),
      pause: mask(b.pause),
    };
  }

  get padSettings(): PadSettings {
    return this.settings;
  }

  /** Höchst-Drehrate (°/s) der aktuellen Einstellung (Tools: `__vel.input().maxRate`). */
  get maxYawRate(): number {
    return this.curve.maxYawRate;
  }

  /** Menü sichtbar → Menü-Aktionen statt Spiel-Eingabe. */
  setMenuContext(on: boolean): void {
    if (on === this.menu) return;
    this.menu = on;
    this.releaseSent();
    this.suppressed = this.down;
    this.restartHeld = 0;
    this.restartFired = (this.down & this.actionMask.restart) !== 0;
    // Gehaltene Richtung (Stick zum Laufen) navigiert im Menü erst nach dem Loslassen.
    this.navDir = NAV_WAIT;
    // Die letzte Spiel-Rate stünde sonst in InputState und drehte jeden Frame weiter (Review A1).
    this.stopMotion();
  }

  get menuContext(): boolean {
    return this.menu;
  }

  /**
   * Nächsten Pad-Knopf aufnehmen (Belegungs-Dialog). Solange das läuft, erzeugt das Pad keine Aktionen und keine
   * Spiel-Eingabe. Was beim Start schon gedrückt ist (das A, das das Feld geöffnet hat), zählt erst nach dem
   * Loslassen. B wird beim LOSLASSEN gemeldet: B gehalten (PAD_CAPTURE_CANCEL_HOLD) bricht ab, Start bricht ab.
   * Rückgabe: still abbrechen (ohne Rückruf). Eine neue Aufnahme beendet eine laufende mit null.
   */
  capture(cb: PadCaptureCallback, timeout = PAD_CAPTURE_TIMEOUT): () => void {
    if (this.captureCb !== null) this.finishCapture(null);
    this.captureCb = cb;
    this.captureLeft = timeout > 0 ? timeout : PAD_CAPTURE_TIMEOUT;
    this.captureB = -1;
    this.suppressed = this.down;
    this.releaseSent();
    // Während der Aufnahme liest read() keine Sticks: eine stehengebliebene Rate drehte sonst weiter (Review A1).
    this.stopMotion();
    return () => {
      if (this.captureCb === cb) this.endCapture();
    };
  }

  get capturing(): boolean {
    return this.captureCb !== null;
  }

  private endCapture(): void {
    this.captureCb = null;
    this.captureB = -1;
    // Der aufgenommene Knopf ist noch gedrückt: weder Menü-Aktion noch Navigation, bis er los ist.
    this.suppressed = this.down;
    this.navDir = NAV_WAIT;
  }

  private finishCapture(code: PadButtonCode | null): void {
    const cb = this.captureCb;
    if (cb === null) return;
    this.endCapture();
    cb(code);
  }

  /** Belegungs-Aufnahme mit Pad (die Frist zählt poll() herunter, auch ohne Pad). */
  private readCapture(live: number, pressed: number, dt: number): void {
    if (this.captureB >= 0) {
      if ((live >> I_B) & 1) {
        this.captureB += dt;
        if (this.captureB >= PAD_CAPTURE_CANCEL_HOLD) this.finishCapture(null);
      } else this.finishCapture('PadB');
      return;
    }
    if (pressed & (1 << I_MENU)) {
      this.finishCapture(null);
      return;
    }
    for (let i = 0; i < N; i++) {
      if (((pressed >> i) & 1) === 0 || i === I_HOME) continue;
      if (i === I_B) {
        this.captureB = 0;
        return;
      }
      this.finishCapture(PAD_BUTTONS[i]);
      return;
    }
    if (this.captureLeft <= 0) this.finishCapture(null);
  }

  /** Erkannter Typ des aktiven Pads ('generic' ohne Pad). */
  get kind(): InputDevice {
    return this.padKind;
  }

  get connected(): boolean {
    return this.activeIndex >= 0;
  }

  /**
   * Gab es seit dem letzten Aufruf Pad-Eingaben? Setzt zurück. Zählt nur Flanken: Knopfdruck oder ein Stick, der
   * STICK_ACTIVE überschreitet — ein gehaltener Stick meldet nicht jeden Frame (Review A4: Stick + Maus im Lock
   * schaltete sonst zweimal je Frame das Gerät um).
   */
  consumeActivity(): boolean {
    const a = this.activity;
    this.activity = false;
    return a;
  }

  /** Sekunden seit der letzten Pad-Eingabe (Knopfdruck, Stick über STICK_ACTIVE); Infinity = keine seit dem Verbinden. */
  get idleSeconds(): number {
    return this.idle;
  }

  /** Knopf-Drücke seit dem letzten Aufruf? Setzt zurück. */
  consumePresses(): boolean {
    const any = this.presses > 0;
    this.presses = 0;
    return any;
  }

  /** Alles loslassen (Fokusverlust): Codes, Richtung, Drehrate; gedrückte Knöpfe erst nach Loslassen wieder. */
  releaseAll(): void {
    this.finishCapture(null);
    this.releaseSent();
    this.suppressed = this.down;
    this.restartHeld = 0;
    this.stopMotion();
  }

  /** Ein Frame: Pads lesen, Flanken und Stellgrößen an die Senke. frameDt = echte Framezeit (s). */
  poll(frameDt: number): void {
    const dt = frameDt > 0 && Number.isFinite(frameDt) ? frameDt : 0;
    // Aufnahme-Frist zählt auch ohne Pad (Review A5): per Maus geöffnet und kein Pad da → sonst nie Abbruch.
    if (this.captureCb !== null) this.captureLeft -= dt;
    const pads = this.source();
    let pad: GamepadLike | null = null;
    let other: GamepadLike | null = null;
    let first: GamepadLike | null = null;
    if (pads !== null) {
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p === null || p === undefined || !p.connected || p.mapping !== 'standard') continue;
        if (first === null) first = p;
        if (p.index === this.activeIndex) pad = p;
        else if (other === null && padBusy(p)) other = p;
      }
    }
    if (pad === null && this.activeIndex >= 0) {
      // Aktives Pad weg → immer loslassen und (im Spiel, benutzt) pausieren, auch wenn ein zweites verbunden ist
      // (Review A8: Steam-Input-Pad + HID-Pad). Ein anderes übernimmt frühestens im nächsten Poll.
      this.lost(first !== null);
      return;
    }
    // Ein anderes Pad, das gerade benutzt wird, übernimmt — nicht, solange das aktive selbst bedient wird.
    if (other !== null && (pad === null || !padBusy(pad))) {
      this.switchTo(other, true);
      pad = other;
    } else if (pad === null && first !== null) {
      // Verbunden, aber still: als aktives Pad merken (Typ für Prompts), ohne Gerätewechsel.
      this.switchTo(first, false);
      pad = first;
    }
    if (pad === null) {
      // Gar kein Pad mehr da: kein Spiegel möglich — kommt eines (auch dasselbe) zurück, zählt sein weckender Druck.
      this.afterLoss = false;
      this.idle += dt;
      if (this.captureCb !== null && this.captureLeft <= 0) this.finishCapture(null);
      return;
    }
    if (pad.id !== this.activeId) this.switchTo(pad, padBusy(pad));
    this.read(pad, dt);
  }

  // ------------------------------------------------------------------ intern

  /** Laufrichtung, Drehrate und Boost auf 0 — Kontextwechsel, Aufnahme, Fokus- und Pad-Verlust. */
  private stopMotion(): void {
    this.sink.setPadMove(0, 0);
    this.sink.setLookRate(0, 0);
    this.edgeTime = 0;
    this.move.fwd = this.move.side = 0;
    const o = this.output;
    o.fwd = o.side = o.yawRate = o.pitchRate = 0;
  }

  private switchTo(p: GamepadLike, busy: boolean): void {
    if (this.activeIndex >= 0) this.releaseSent();
    this.activeIndex = p.index;
    this.activeId = p.id;
    this.padKind = padKindFromId(p.id);
    // Der Druck, der das Pad übernimmt, zählt (Chrome zeigt ein Pad erst nach dem ersten Druck):
    // ab "nichts gedrückt", read() sieht ihn als Flanke. Nach dem Verlust des aktiven Pads nicht: dasselbe
    // Drücken erscheint dort oft auf beiden (Steam-Input-Spiegel) und bestätigte sonst gleich die Pause.
    this.down = this.afterLoss ? buttonBits(p, 0) : 0;
    this.suppressed = this.down;
    this.afterLoss = false;
    this.used = false;
    this.stickHot = false;
    // read() meldet die Aktivität des übernehmenden Drucks selbst.
    if (busy) {
      this.activity = true;
      this.idle = 0;
    }
  }

  /** mirror = beim Verlust war schon ein anderes Standard-Pad verbunden (möglicher Steam-Input-Spiegel). */
  private lost(mirror: boolean): void {
    this.releaseSent();
    this.stopMotion();
    const wasUsed = this.used;
    this.activeIndex = -1;
    this.activeId = '';
    this.down = 0;
    this.suppressed = 0;
    this.used = false;
    this.stickHot = false;
    // Nur dann den schon gehaltenen Druck sperren (Review N2): sonst schluckte das den Druck, der dasselbe Pad
    // nach Akku-Leer/Kabel wieder aufweckt — "Weiter" bräuchte zwei Drücke.
    this.afterLoss = mirror;
    // Pad im Spiel getrennt → Pause (Plan 011 §1.3); im Menü nichts.
    if (wasUsed && !this.menu) this.sink.pushAction('pause');
    this.finishCapture(null);
  }

  private releaseSent(): void {
    const sent = this.sent;
    if (sent === 0) return;
    for (let i = 0; i < N; i++) if ((sent >> i) & 1) this.sink.padButton(PAD_BUTTONS[i], false);
    this.sent = 0;
  }

  private read(p: GamepadLike, dt: number): void {
    const prev = this.down;
    const now = buttonBits(p, prev);
    this.down = now;
    // Losgelassene Knöpfe sind nicht mehr gesperrt.
    this.suppressed &= now;
    const live = now & ~this.suppressed;
    const pressed = now & ~prev & ~this.suppressed;
    if (pressed !== 0) {
      this.activity = this.used = true;
      this.presses++;
    }

    const ax = p.axes;
    const lx = axis(ax, 0);
    const ly = axis(ax, 1);
    const rx = axis(ax, 2);
    const ry = axis(ax, 3);
    const st = this.sticks;
    st.lx = lx;
    st.ly = ly;
    st.rx = rx;
    st.ry = ry;
    const hot = lx * lx + ly * ly > STICK_ACTIVE * STICK_ACTIVE || rx * rx + ry * ry > STICK_ACTIVE * STICK_ACTIVE;
    if (hot) {
      this.used = true;
      // Gerätewechsel nur auf der Flanke (Review A4) — gehalten zählt er weiter als "Pad in Benutzung" (idle).
      if (!this.stickHot) this.activity = true;
    }
    this.stickHot = hot;
    this.idle = hot || pressed !== 0 ? 0 : this.idle + dt;

    if (this.captureCb !== null) {
      this.readCapture(live, pressed, dt);
      return;
    }
    if (this.menu) this.readMenu(live, pressed, lx, ly, dt);
    else this.readGame(live, pressed, lx, ly, rx, ry, dt);
    this.updateRestart(live, dt);
  }

  private readGame(live: number, pressed: number, lx: number, ly: number, rx: number, ry: number, dt: number): void {
    // Gehaltene Codes an die Senke: nur Änderungen (Flanken), Index-Schleife ohne Allokation.
    const sent = this.sent;
    const change = sent ^ live;
    if (change !== 0) {
      for (let i = 0; i < N; i++) {
        if (((change >> i) & 1) === 0) continue;
        this.sink.padButton(PAD_BUTTONS[i], ((live >> i) & 1) !== 0);
      }
      this.sent = live;
    }
    const m = this.actionMask;
    for (let k = 0; k < PRESS_ACTIONS.length; k++) {
      const a = PRESS_ACTIONS[k];
      if (pressed & m[a]) this.sink.pushAction(a);
    }

    const s = this.settings;
    // Voriges Ergebnis als Hysterese-Zustand (Review A3): Bandkante und Deadzone flattern nicht.
    const mv = digitizeMove(lx, ly, s.moveDeadzone, s.diagonalBand, this.move, this.move);
    let fwd = mv.fwd;
    let side = mv.side;
    // Steuerkreuz bewegt auch (digital wie WASD), ODER mit dem Stick.
    const up = (live >> I_UP) & 1;
    const dn = (live >> I_DOWN) & 1;
    const lf = (live >> I_LEFT) & 1;
    const rt = (live >> I_RIGHT) & 1;
    if (fwd === 0) fwd = up - dn;
    if (side === 0) side = rt - lf;
    this.sink.setPadMove(fwd, side);

    const c = this.curve;
    // Boost-Uhr mit Hysterese (Review A3): läuft am Rand, steht im Band 0.85…0.95, fällt erst darunter auf 0.
    const t0 = this.edgeTime;
    const t1 = edgeClock(t0, stickMagnitude(rx, ry, c.inner, c.outer), dt);
    this.edgeTime = t1;
    // Läuft sie: Boost als Mittel über GENAU dieses Frame-Intervall — die Drehung hängt dann nicht davon ab, wie
    // die Zeit in Frames zerfällt (60/144/240 Hz drehen gleich weit, Muster fallen.md #45). Steht sie: der Wert.
    const k = t1 > t0 ? meanBoost(c, t0, t1) : boostFactor(c, t1);
    const r = lookRate(rx, ry, this.flat, 0, this.rate);
    // Stick rechts → Yaw kleiner (wie Maus rechts); Stick hoch (y < 0) → Pitch größer, außer invertiert.
    // Boost nur auf Yaw (Review A2): am Rand gekippt sollte der Blick nicht auch noch 1.5× schneller nicken.
    const yawRate = -r.yaw * k;
    const pitchRate = s.invertY ? r.pitch : -r.pitch;
    this.sink.setLookRate(yawRate, pitchRate);
    const o = this.output;
    o.fwd = fwd;
    o.side = side;
    o.yawRate = yawRate;
    o.pitchRate = pitchRate;
  }

  private readMenu(live: number, pressed: number, lx: number, ly: number, dt: number): void {
    const sink = this.sink;
    if (pressed & (1 << I_A)) sink.pushAction('confirm');
    if (pressed & ((1 << I_B) | (1 << I_MENU))) sink.pushAction('pause');
    if (pressed & (1 << I_LB)) sink.pushAction('tabPrev');
    if (pressed & (1 << I_RB)) sink.pushAction('tabNext');
    // Lektions-Pause: X/Y wie im Spiel (Vorführung / Stufe neu).
    if (pressed & (1 << I_X)) sink.pushAction('demo');
    if (pressed & (1 << I_Y)) sink.pushAction('respawn');
    // Laufrichtung/Drehrate hat setMenuContext auf 0 gesetzt; im Menü stellt sie niemand.

    let dir = NAV_NONE;
    if (live & (1 << I_UP)) dir = NAV_UP;
    else if (live & (1 << I_DOWN)) dir = NAV_DOWN;
    else if (live & (1 << I_LEFT)) dir = NAV_LEFT;
    else if (live & (1 << I_RIGHT)) dir = NAV_RIGHT;
    else if (lx * lx + ly * ly > STICK_ACTIVE * STICK_ACTIVE) {
      dir = Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? NAV_RIGHT : NAV_LEFT) : ly > 0 ? NAV_DOWN : NAV_UP;
    }
    if (this.navDir === NAV_WAIT) {
      if (dir === NAV_NONE) this.navDir = NAV_NONE;
      return;
    }
    if (dir !== this.navDir) {
      this.navDir = dir;
      if (dir !== NAV_NONE) {
        sink.pushAction(NAV_ACTIONS[dir]);
        this.navTimer = NAV_DELAY;
      }
      return;
    }
    if (dir === NAV_NONE) return;
    this.navTimer -= dt;
    if (this.navTimer <= 0) {
      sink.pushAction(NAV_ACTIONS[dir]);
      this.navTimer += NAV_REPEAT;
      if (this.navTimer <= 0) this.navTimer = NAV_REPEAT;
    }
  }

  /** Neustart = Knopf HALTEN (PAD_RESTART_HOLD), einmal je Druck. */
  private updateRestart(live: number, dt: number): void {
    if ((live & this.actionMask.restart) === 0) {
      this.restartHeld = 0;
      this.restartFired = false;
      return;
    }
    if (this.restartFired) return;
    this.restartHeld += dt;
    if (this.restartHeld >= PAD_RESTART_HOLD) {
      this.restartFired = true;
      this.sink.pushAction('restart');
    }
  }
}

/** Integral von (boostFactor − 1) / boost über [0, t]: 0 bis delay, quadratisch in der Rampe, dann linear. */
function boostArea(p: LookCurveParams, t: number): number {
  const u = t - p.boostDelay;
  if (!(u > 0)) return 0;
  const r = p.boostRamp;
  if (!(r > 0)) return u;
  return u <= r ? (u * u) / (2 * r) : r / 2 + (u - r);
}

/**
 * Mittlerer Boost-Faktor (≥ 1) über die Randzeit [t0, t1] — dieselbe Kurve wie stickCurve.boostFactor,
 * aber exakt integriert statt am Frame-Ende abgetastet.
 */
export function meanBoost(p: LookCurveParams, t0: number, t1: number): number {
  if (!(p.boost > 0)) return 1;
  if (!(t1 > t0)) return boostFactor(p, t0);
  return 1 + (p.boost * (boostArea(p, t1) - boostArea(p, t0))) / (t1 - t0);
}

function axis(ax: readonly number[], i: number): number {
  const v = i < ax.length ? ax[i] : 0;
  return Number.isFinite(v) ? v : 0;
}

/** Knöpfe als Bits; Trigger digital mit Hysterese (an ≥ 0.6, aus ≤ 0.4) gegen den vorigen Zustand. */
function buttonBits(p: GamepadLike, prev: number): number {
  const b = p.buttons;
  const n = b.length < N ? b.length : N;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const btn = b[i];
    if (i === I_LT || i === I_RT) {
      const v = Number.isFinite(btn.value) ? btn.value : btn.pressed ? 1 : 0;
      const was = ((prev >> i) & 1) !== 0;
      if (was ? v > PAD_TRIGGER_OFF : v >= PAD_TRIGGER_ON) bits |= 1 << i;
    } else if (btn.pressed) bits |= 1 << i;
  }
  return bits;
}

/** Wird dieses (nicht aktive) Pad gerade benutzt? Knopf gedrückt oder Stick deutlich ausgelenkt. */
function padBusy(p: GamepadLike): boolean {
  if (buttonBits(p, 0) !== 0) return true;
  const ax = p.axes;
  for (let i = 0; i + 1 < ax.length && i < 4; i += 2) {
    const x = axis(ax, i);
    const y = axis(ax, i + 1);
    if (x * x + y * y > STICK_ACTIVE * STICK_ACTIVE) return true;
  }
  return false;
}
