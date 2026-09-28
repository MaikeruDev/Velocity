import type { GameSettings, KeyBinds } from './settingsTypes';
import type { PlayerInput } from '../player/types';
import { InputState, MOUSE_CODES } from './InputState';
import type { InputAction, InputNotice, InputOverride } from './InputState';
import type { RawMouseStatus } from '../ui/types';

export type { InputAction, InputNotice, InputOverride } from './InputState';

/**
 * Browser-Eingabe: Pointer Lock mit Raw-Input, Tastatur, Mausrad-Sprung.
 * Die eigentliche Logik (Flanken, Subtick-Yaw) steckt im DOM-freien InputState.
 *
 * Lebenszyklus pro Frame (siehe engine/Loop.ts):
 *   beginFrame()            — in onFrameStart, JEDEN Frame (Blick-Sample, auch ohne Tick)
 *   tickInput(i, n, u) × n  — in onTick (Yaw nach Tick-Zeit u interpoliert)
 *   yaw / pitch             — in onFrame für die Kamera (roh, sofort)
 *   consumeActions()        — jeden Frame, auch im Menü (sonst stauen sich Aktionen)
 */

/** Keyboard Lock API (Chromium) — fehlt in lib.dom, daher lokal. */
interface KeyboardLockApi {
  lock(keyCodes?: readonly string[]): Promise<void>;
  unlock(): void;
}

/**
 * Tasten, die im Vollbild per Keyboard Lock beim Spiel bleiben. Wichtigster Grund:
 * Strg (Ducken) + W (vorwärts) schließt sonst den Tab — nicht per preventDefault abfangbar.
 * Escape gehört dazu, damit ein kurzer Druck pausiert statt das Vollbild zu beenden
 * (Chrome: Esc gedrückt halten verlässt das Vollbild weiterhin). Achtung: Chrome lässt
 * dann auch den Pointer Lock stehen — onKeyDown gibt ihn deshalb selbst frei.
 */
const KEYBOARD_LOCK_CODES: readonly string[] = [
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyR', 'KeyF', 'KeyM', 'KeyQ', 'KeyE', 'KeyN', 'KeyT',
  'Space', 'ShiftLeft', 'ControlLeft', 'Tab', 'Escape', 'Enter', 'F1',
];

/** Fester Satz plus die aktuelle Belegung (ohne Maus-Pseudo-Codes). */
function lockCodesFor(binds: KeyBinds): string[] {
  const out = [...KEYBOARD_LOCK_CODES];
  for (const list of [binds.jump, binds.crouch, binds.sprint]) {
    for (const c of list) if (!c.startsWith('Mouse') && !out.includes(c)) out.push(c);
  }
  return out;
}

/** Zustand der Raw-Maus (unadjustedMovement) für die Einstellungen. */
export type RawStatus = RawMouseStatus;

/**
 * Was der InputManager vom Lock-Ziel braucht (im Spiel der Canvas). Ältere
 * Browser liefern statt eines Promise `undefined` — daher der weite Rückgabetyp.
 */
export interface PointerLockTarget {
  requestPointerLock(options?: PointerLockOptions): Promise<void> | undefined;
}

/**
 * Chrome liefert direkt nach Lock-Erhalt gelegentlich einen einzelnen absurden
 * movementX/Y-Sprung (Distanz Cursor → Lock-Punkt, crbug 781182 u. a.) — ein
 * Artefakt des normalen Cursor-Pfads, den der Raw-Pfad (unadjustedMovement)
 * nicht hat. Das würde den Blick beim Klick ins Spiel herumreißen. Geprüft
 * werden daher nur die ersten zwei Events nach Lock-Erhalt und nur ohne Raw;
 * danach wird NIE gefiltert — ein echter Flick hat locker 1000+ Counts pro Event.
 */
const LOCK_GRACE_EVENTS = 2;
const LOCK_GRACE_MS = 250;
const LOCK_GRACE_MAX_COUNTS = 150;

type LockListener = (locked: boolean) => void;
type NoticeListener = (n: InputNotice) => void;

export class InputManager {
  /** DOM-freier Kern (für Tools/Tests zugänglich). */
  readonly state = new InputState();

  private readonly target: PointerLockTarget;
  private readonly getSettings: () => GameSettings;
  private readonly lockListeners = new Set<LockListener>();
  private readonly noticeListeners = new Set<NoticeListener>();
  private isLocked = false;
  private raw = false;
  private lockAcquiredAt = 0;
  /** Wie viele Maus-Events seit Lock-Erhalt noch durch den Grace-Filter laufen. */
  private graceEvents = 0;
  /** Wir selbst haben den Lock freigegeben → kein automatisches 'pause'. */
  private exitRequested = false;
  /** null = noch nicht probiert; false = unadjustedMovement hier nicht verfügbar. */
  private rawSupported: boolean | null = null;
  private pendingLock: Promise<boolean> | null = null;
  private lastError: string | null = null;
  /** Keyboard Lock im Vollbild aktiv → Strg+W erreicht den Browser nicht, Strg darf ducken. */
  private keyboardLocked = false;
  private leaveGuard = false;
  private disposed = false;

  constructor(target: PointerLockTarget, getSettings: () => GameSettings) {
    this.target = target;
    this.getSettings = getSettings;
    // Strg-Ducken erst mit Keyboard Lock: im Fenster schließt Strg+W den Tab (nicht abfangbar).
    this.state.setCtrlCrouch(false);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('auxclick', this.onAuxClick);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('beforeunload', this.onBeforeUnload);
    this.isLocked = document.pointerLockElement === this.target;
  }

  /** Belegung und Auto-Sprint aus den Einstellungen übernehmen (selten, darf allokieren). */
  configure(binds: KeyBinds, autoSprint: boolean): void {
    const changed = binds !== this.state.bindings;
    this.state.setBindings(binds);
    this.state.setAutoSprint(autoSprint);
    // Neue Tasten auch im Vollbild beim Spiel halten.
    if (changed && this.keyboardLocked) {
      keyboardLock()
        ?.lock(lockCodesFor(binds))
        .catch(() => undefined);
    }
  }

  /**
   * Raw-Maus: 'active' = der letzte Lock lief mit unadjustedMovement, 'unavailable' =
   * der Browser kann es nicht (dann greift die Zeigerbeschleunigung des Systems),
   * 'unknown' = noch nie gefangen.
   */
  get rawStatus(): RawStatus {
    if (this.rawSupported === null) return 'unknown';
    return this.rawSupported ? 'active' : 'unavailable';
  }

  get locked(): boolean {
    return this.isLocked;
  }

  /** true, wenn der aktuelle Lock mit unadjustedMovement (ohne OS-Mausbeschleunigung) läuft. */
  get rawInput(): boolean {
    return this.isLocked && this.raw;
  }

  /** Grund des letzten gescheiterten Lock-Versuchs (Diagnose/Hinweistext), sonst null. */
  get lockError(): string | null {
    return this.lastError;
  }

  /** Läuft gerade ein Lock-Versuch? (Menü sperrt dann „Weiter“.) */
  get lockPending(): boolean {
    return this.pendingLock !== null;
  }

  /** Strg zählt gerade als Ducken (nur im Vollbild mit Keyboard Lock). */
  get ctrlCrouch(): boolean {
    return this.state.ctrlCrouchEnabled;
  }

  get yaw(): number {
    return this.state.yaw;
  }

  get pitch(): number {
    return this.state.pitch;
  }

  /**
   * Muss direkt aus einer User-Geste (Klick, Taste außer Esc) kommen. Resolved
   * mit false, wenn der Browser ablehnt — z. B. Chrome kurz nach einem
   * Esc-Unlock. Dann Menu.setLockStatus mit lockError füttern. Maßgeblich für den
   * Zustand bleibt onLockChange / `locked`.
   */
  requestLock(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.isLocked) return Promise.resolve(true);
    // Klick + Enter kurz hintereinander: ein Versuch statt zwei — Chrome drosselt Lock-Anfragen
    // ("Too many pointer lock requests in a short window of time").
    if (this.pendingLock) return this.pendingLock;
    const p = this.doRequestLock().finally(() => {
      this.pendingLock = null;
    });
    this.pendingLock = p;
    return p;
  }

  private async doRequestLock(): Promise<boolean> {
    this.lastError = null;
    // Raw zuerst (ohne OS-Mausbeschleunigung = CS-Parität). Einmal "nicht unterstützt" wird
    // gemerkt, sonst kostet jeder Wiedereinstieg zwei Anfragen und läuft in Chromes Drossel.
    if (this.rawSupported !== false) {
      const r = await this.tryLock(true);
      if (r === 'ok') {
        this.rawSupported = true;
        this.raw = true;
        return true;
      }
      if (r === 'ok-untracked') {
        // Lock ohne Promise-Rückgabe: solche Browser ignorieren die Option still — nicht als roh zählen.
        this.rawSupported = false;
        this.raw = false;
        return true;
      }
      if (r === 'failed') return false;
      this.rawSupported = false;
    }
    this.raw = false;
    const r = await this.tryLock(false);
    return r === 'ok' || r === 'ok-untracked';
  }

  /**
   * Ein Lock-Versuch. Chrome liefert ein Promise, ältere Browser `undefined` und
   * melden nur per Event — daher zusätzlich auf pointerlockchange/-error warten.
   * 'ok-untracked' = gefangen, aber ohne Promise (Optionen evtl. ignoriert).
   */
  private async tryLock(raw: boolean): Promise<'ok' | 'ok-untracked' | 'unsupported' | 'failed'> {
    const waiter = this.waitForLockEvent();
    let promised = false;
    try {
      const pending: Promise<void> | undefined = raw
        ? this.target.requestPointerLock({ unadjustedMovement: true })
        : this.target.requestPointerLock();
      if (pending) {
        promised = true;
        await pending;
      }
    } catch (err) {
      waiter.cancel();
      if (err instanceof DOMException && err.name === 'NotSupportedError') return 'unsupported';
      this.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return 'failed';
    }
    if (document.pointerLockElement === this.target) {
      waiter.cancel();
      return promised ? 'ok' : 'ok-untracked';
    }
    const ok = await waiter.done;
    if (!ok && this.lastError === null) this.lastError = 'pointerlockerror';
    if (!ok) return 'failed';
    return promised ? 'ok' : 'ok-untracked';
  }

  private waitForLockEvent(): { readonly done: Promise<boolean>; cancel(): void } {
    let finish: (ok: boolean) => void = () => undefined;
    const done = new Promise<boolean>((resolve) => {
      const onChange = (): void => finish(document.pointerLockElement === this.target);
      const onError = (): void => finish(false);
      const timer = setTimeout(() => finish(document.pointerLockElement === this.target), 1000);
      finish = (ok: boolean): void => {
        clearTimeout(timer);
        document.removeEventListener('pointerlockchange', onChange);
        document.removeEventListener('pointerlockerror', onError);
        resolve(ok);
      };
      document.addEventListener('pointerlockchange', onChange);
      document.addEventListener('pointerlockerror', onError);
    });
    return { done, cancel: () => finish(false) };
  }

  /** Lock freigeben, ohne dass daraus eine 'pause'-Aktion wird. */
  exitLock(): void {
    if (document.pointerLockElement !== this.target) return;
    this.exitRequested = true;
    document.exitPointerLock();
  }

  onLockChange(cb: LockListener): () => void {
    this.lockListeners.add(cb);
    return () => this.lockListeners.delete(cb);
  }

  /** Hinweise für die Spielerin (z. B. Strg-Ducken im Fenster) → Hud.onInputNotice. */
  onNotice(cb: NoticeListener): () => void {
    this.noticeListeners.add(cb);
    return () => this.noticeListeners.delete(cb);
  }

  /**
   * Zusätzlicher Schutz vor versehentlichem Schließen (Strg+W): bei true fragt der
   * Browser beim Verlassen nach, auch ohne Lock — z. B. solange ein Lauf läuft.
   * Im Lock fragt er immer.
   */
  setLeaveGuard(on: boolean): void {
    this.leaveGuard = on;
  }

  /** Blick-Sample vor den Ticks jedes Frames (FixedLoop.onFrameStart). */
  beginFrame(): void {
    this.state.beginFrame();
  }

  /** Eingabe für Tick i von n, u = Tick-Zeit im Frame (Subtick-Yaw). Das Objekt wird wiederverwendet — gültig bis zum nächsten Aufruf. */
  tickInput(i: number, n: number, u?: number): PlayerInput {
    return this.state.tickInput(i, n, u);
  }

  /** Blick setzen (Spawn/Respawn, Radiant). */
  setView(yaw: number, pitch: number): void {
    this.state.setView(yaw, pitch);
  }

  consumeActions(): readonly InputAction[] {
    return this.state.consumeActions();
  }

  /** Bots/Playwright: ersetzt die Tick-Eingabe komplett; null = wieder echte Eingabe. */
  setOverride(fn: InputOverride | null): void {
    this.state.setOverride(fn);
  }

  /** Vollbild umschalten; im Vollbild zusätzlich Keyboard Lock (falls verfügbar). Aus einer User-Geste aufrufen. */
  async toggleFullscreen(): Promise<boolean> {
    if (document.fullscreenElement) {
      keyboardLock()?.unlock();
      this.setKeyboardLocked(false);
      try {
        await document.exitFullscreen();
      } catch {
        // Vollbild war schon weg (z. B. per F11/Esc) — nichts zu tun.
      }
      return false;
    }
    return this.enterFullscreen();
  }

  /**
   * Vollbild + Keyboard Lock (Strg duckt, Strg+W und Esc bleiben beim Spiel).
   * Aus derselben User-Geste, aber erst NACHDEM der Lock-Versuch entschieden ist
   * (Game.fullscreenFromGesture): requestFullscreen verbraucht die Nutzeraktivierung,
   * requestPointerLock prüft sie nur — auch sein Rückfall ohne Raw nach einem await.
   * Schon im Vollbild: nur der Keyboard Lock wird (erneut) angefordert.
   */
  enterFullscreen(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const el = document.documentElement;
    const wasFull = document.fullscreenElement !== null;
    let req: Promise<void>;
    try {
      req = wasFull ? Promise.resolve() : el.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      return Promise.resolve(false);
    }
    return req.then(
      async () => {
        const kb = keyboardLock();
        if (kb && !this.keyboardLocked) {
          try {
            await kb.lock(lockCodesFor(this.state.bindings));
            // Zwischendurch wieder raus (Esc gehalten)? Dann gilt der Lock nicht.
            this.setKeyboardLocked(document.fullscreenElement !== null);
          } catch {
            // Keyboard Lock ist Komfort; ohne ihn bleibt Ducken auf C.
          }
        }
        return document.fullscreenElement !== null;
      },
      () => false,
    );
  }

  /** Vollbild aktiv? */
  get fullscreen(): boolean {
    return document.fullscreenElement !== null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('auxclick', this.onAuxClick);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    this.lockListeners.clear();
    this.noticeListeners.clear();
    this.state.releaseAll();
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  // ---------------------------------------------------------------- intern

  private setKeyboardLocked(on: boolean): void {
    this.keyboardLocked = on;
    this.state.setCtrlCrouch(on);
  }

  private notify(n: InputNotice): void {
    for (const fn of this.noticeListeners) fn(n);
  }

  // ---------------------------------------------------------------- Handler

  private readonly onPointerLockChange = (): void => {
    const now = document.pointerLockElement === this.target;
    if (now === this.isLocked) return;
    this.isLocked = now;
    if (now) {
      // Sprung-Flanken aus dem Menü verwerfen (Leertaste im Menü → sonst Sprung beim Fortsetzen);
      // gehaltene Tasten bleiben: wer beim Klick auf "Weiter" schon W hält, läuft sofort los.
      this.state.clearEdges();
      this.lockAcquiredAt = performance.now();
      this.graceEvents = LOCK_GRACE_EVENTS;
      // Fokus aus Menü-/Tuning-Feldern lösen, sonst schlucken sie WASD nach dem Wiedereinstieg.
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
    } else {
      this.state.releaseAll();
      // Esc im Lock kommt in Chrome (ohne Keyboard Lock) nie als keydown an — der Lock-Verlust IST der Pause-Wunsch.
      if (!this.exitRequested) this.state.pushAction('pause');
      this.exitRequested = false;
    }
    for (const fn of this.lockListeners) fn(now);
  };

  private readonly onFullscreenChange = (): void => {
    // Vollbild weg (Esc gehalten, F11, Alt-Tab) → Keyboard Lock wirkt nicht mehr.
    if (!document.fullscreenElement && this.keyboardLocked) this.setKeyboardLocked(false);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.isLocked) return;
    const dx = e.movementX;
    const dy = e.movementY;
    if (dx === 0 && dy === 0) return;
    if (this.graceEvents > 0) {
      this.graceEvents--;
      if (
        !this.raw &&
        performance.now() - this.lockAcquiredAt < LOCK_GRACE_MS &&
        (Math.abs(dx) > LOCK_GRACE_MAX_COUNTS || Math.abs(dy) > LOCK_GRACE_MAX_COUNTS)
      ) {
        return;
      }
    }
    // Sofort anwenden: der Blick ist nie älter als das letzte Maus-Event.
    this.state.look(dx, dy, this.getSettings());
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.isLocked && e.code === 'Escape') {
      // Nur mit Keyboard Lock (Vollbild) kommt Esc im Lock hier an — Chrome lässt den
      // Pointer Lock dann stehen. Ohne Freigabe hinge die Maus unsichtbar hinter dem
      // Pause-Menü und drehte die Kamera. exitLock unterdrückt die zweite Pause aus
      // dem Lock-Verlust: genau ein 'pause' und eine freie Maus.
      e.preventDefault();
      this.state.keyDown(e.code, e.repeat);
      this.exitLock();
      return;
    }
    // Im Lock gehört die Tastatur immer dem Spiel, egal wo der Fokus noch hängt.
    if (!this.isLocked && isTextEntry(e.target)) {
      // In Eingabefeldern (Tuning-Panel, Slider) gehört die Tastatur dem Feld — nur F1 und Esc
      // bleiben global (Esc = zurück aus dem Menü, Felder brauchen es nicht).
      if (e.code === 'F1' || e.code === 'Escape') {
        if (e.code === 'F1') e.preventDefault();
        this.state.keyDown(e.code, e.repeat);
      }
      return;
    }
    // Enter/Leertaste auf einem fokussierten Button: native Aktivierung, kein zweites 'confirm'/Sprung.
    if (
      !this.isLocked &&
      e.target instanceof HTMLButtonElement &&
      (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')
    ) {
      return;
    }
    if (this.isLocked && !e.repeat && this.state.isBlockedCtrl(e.code)) {
      this.notify('ctrlCrouchNeedsFullscreen');
    }
    const handled = this.state.keyDown(e.code, e.repeat);
    if (
      handled ||
      e.code === 'F1' ||
      // Tab nur im Spiel schlucken — im Menü ist es Fokus-Navigation.
      (e.code === 'Tab' && this.isLocked) ||
      // Strg+S/D/A (Ducken + Laufen) würden Speichern/Lesezeichen/Alles-markieren auslösen.
      (e.ctrlKey && this.isLocked)
    ) {
      e.preventDefault();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    // keyup immer auswerten, auch in Feldern — sonst klemmt eine Taste, die vor dem Fokuswechsel gedrückt wurde.
    if (this.state.keyUp(e.code) && !isTextEntry(e.target)) e.preventDefault();
  };

  /**
   * Maustasten nur im Lock als Pseudo-Codes (Mouse1…Mouse5) ins held-Set. Ohne
   * Lock gehören Klicks dem Menü. Mitte (Autoscroll) und 4/5 (Browser zurück/vor)
   * werden im Lock geschluckt — sonst verlässt eine Sprungtaste die Seite.
   */
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.isLocked) return;
    const code = MOUSE_CODES[e.button];
    if (code === undefined) return;
    if (e.button !== 0) e.preventDefault();
    this.state.keyDown(code, false);
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    const code = MOUSE_CODES[e.button];
    if (code === undefined) return;
    // Loslassen immer auswerten (Lock kann dazwischen weg sein), sonst klemmt die Taste.
    this.state.keyUp(code);
    if (this.isLocked && e.button !== 0) e.preventDefault();
  };

  private readonly onAuxClick = (e: MouseEvent): void => {
    if (this.isLocked) e.preventDefault();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    // Ohne Lock ist das Rad zum Scrollen im Menü da.
    if (!this.isLocked) return;
    e.preventDefault();
    if (e.deltaY === 0 && e.deltaX === 0) return;
    this.state.wheel();
  };

  private readonly onBlur = (): void => {
    this.state.releaseAll();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') this.state.releaseAll();
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.isLocked) e.preventDefault();
  };

  /**
   * Sicherheitsnetz gegen Strg+W (Ducken + vorwärts) im Fenstermodus: der Browser
   * fragt „Seite verlassen?“ statt den Tab samt Lauf sofort zu schließen.
   */
  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!this.isLocked && !this.leaveGuard) return;
    e.preventDefault();
    // Ältere Browser zeigen den Dialog nur mit gesetztem returnValue.
    e.returnValue = '';
  };
}

function keyboardLock(): KeyboardLockApi | null {
  const nav: Navigator & { readonly keyboard?: KeyboardLockApi } = navigator;
  return nav.keyboard ?? null;
}

/** Elemente, die Tastatureingaben selbst brauchen (Textfelder, Slider, Auswahllisten). */
function isTextEntry(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    const type = t.type;
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
  }
  return false;
}
