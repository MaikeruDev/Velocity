import type { GameSettings, KeyBinds } from './settingsTypes';
import type { PlayerInput } from '../player/types';
import { InputState, MOUSE_CODES } from './InputState';
import type { InputAction, InputNotice, InputOverride } from './InputState';
import type { RawMouseStatus } from '../ui/types';
import { PadInput } from './pad/PadInput';
import type { GamepadLike, GamepadSource, PadCaptureCallback } from './pad/PadInput';
import { promptLabelFor } from './pad/prompts';
import type { InputDevice, PadButtonCode, PadSettings, PromptAction } from './pad/types';
import { DEFAULT_PAD_SETTINGS, PAD_CAPTURE_TIMEOUT } from './pad/types';
import type { DisplayMode, PlatformApi } from '../platform/types';
import { WEB_PLATFORM } from '../platform/web';

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
 *   anyKeyDown()            — Vorführung (Plan 007): "beliebige Taste beendet sie"
 *
 * Controller (Plan 011): beginFrame(frameDt) fragt zuerst das Gamepad ab (PadInput), dann sampelt
 * InputState. Game meldet per setMenuContext, ob das Menü die Pad-Knöpfe bekommt. `device` ist das
 * zuletzt benutzte Gerät (Prompts), onDevice meldet Wechsel.
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
type DeviceListener = (d: InputDevice) => void;

/** Ohne gamepadconnected-Event trotzdem gelegentlich nachsehen (Pads, die schon vor dem Laden da waren). */
const PAD_PROBE_SECONDS = 1;
/**
 * Mausbewegung im Lock schaltet erst auf Tastatur, wenn das Pad so lange still war (s) — Review A4: linker Stick +
 * Maus (Deck-Trackpad) wechselte sonst zweimal je Frame das Gerät (Prompts, Menü, Allokation im Frame-Pfad).
 * Tasten und Klicks schalten sofort.
 */
const MOUSE_DEVICE_DEBOUNCE = 0.25;

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
  /** Tasten-/Maustasten-/Rad-Drücke seit dem letzten anyKeyDown() (ohne Wiederholungen). */
  private presses = 0;
  /** Laufende Pad-Aufnahme: Esc bricht sie ab (Pad hat kein Esc, die Tastatur schon). */
  private captureEsc: (() => void) | null = null;
  private readonly deviceListeners = new Set<DeviceListener>();
  /** Zuletzt benutzt: Tastatur/Maus oder der erkannte Pad-Typ (ohne Glyphen-Einstellung). */
  private rawDevice: InputDevice = 'keyboard';
  private effDevice: InputDevice = 'keyboard';
  private padSettings: PadSettings = DEFAULT_PAD_SETTINGS;
  /** Verbundene Pads laut Events — 0 = getGamepads() nicht jeden Frame aufrufen (allokiert ein Array). */
  private padCount = 0;
  private padProbe = 0;
  /** Debug/Tools (`__vel.pad`): ersetzt navigator.getGamepads komplett. */
  private fakePads: (GamepadLike | null)[] | null = null;
  /** Gamepad-Abfrage (Plan 011, DOM-frei); Tools lesen sticks/output. */
  readonly pad: PadInput;
  /** Plattform (Plan 011 §2.3/§2.4): am Desktop Vollbild über das Hauptprozess-Fenster, Strg duckt immer. */
  private readonly platform: PlatformApi;
  /** Desktop: zuletzt bekannter Anzeigemodus (getMode ist async, `fullscreen` muss synchron antworten). */
  private desktopMode: DisplayMode = 'windowed';

  constructor(target: PointerLockTarget, getSettings: () => GameSettings, platform: PlatformApi = WEB_PLATFORM) {
    this.target = target;
    this.getSettings = getSettings;
    this.platform = platform;
    this.pad = new PadInput(this.state, this.padSource);
    this.pad.configure(this.padSettings);
    this.state.setPadBindings(this.padSettings.binds);
    // Web: Strg-Ducken erst mit Keyboard Lock — im Fenster schließt Strg+W den Tab (nicht abfangbar).
    // Desktop: kein App-Menü, also keine Browser-Kürzel → Strg duckt immer (Plan 011 §2.4).
    this.state.setCtrlCrouch(this.desktop);
    platform.window
      ?.getMode()
      .then((m) => {
        this.desktopMode = m;
      })
      .catch(() => undefined);
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
    window.addEventListener('gamepadconnected', this.onPadConnected);
    window.addEventListener('gamepaddisconnected', this.onPadDisconnected);
    this.isLocked = document.pointerLockElement === this.target;
  }

  // ---------------------------------------------------------------- Controller (Plan 011)

  /** Pad-Einstellungen übernehmen (selten, darf allokieren). */
  configurePad(s: PadSettings): void {
    this.padSettings = s;
    this.pad.configure(s);
    if (s.binds !== this.state.padBindings) this.state.setPadBindings(s.binds);
    this.updateDevice();
  }

  /**
   * Zuletzt benutztes Eingabegerät für Prompts/Glyphen: 'keyboard' nach Taste/Klick/Maus im Lock, sonst der
   * Pad-Typ. Die Einstellung "Tasten-Symbole" (glyphs ungleich auto) schlägt die Erkennung.
   */
  get device(): InputDevice {
    return this.effDevice;
  }

  /** Letzte Eingabe kam vom Pad (Game: Start ohne Pointer Lock). Unabhängig von der Glyphen-Einstellung. */
  get usingPad(): boolean {
    return this.rawDevice !== 'keyboard';
  }

  onDevice(cb: DeviceListener): () => void {
    this.deviceListeners.add(cb);
    return () => this.deviceListeners.delete(cb);
  }

  /** Tasten-Hinweis für eine Aktion auf dem aktuellen Gerät ("SPACE", "LB", "×" …). */
  promptLabel(a: PromptAction): string {
    return promptLabelFor(a, this.effDevice, this.state.bindings, this.padSettings.binds);
  }

  /** Menü sichtbar → Pad-Knöpfe werden Menü-Aktionen (confirm/pause/nav…/tab…), keine Spiel-Eingabe. */
  setMenuContext(on: boolean): void {
    this.pad.setMenuContext(on);
  }

  /**
   * Belegungs-Dialog: den NÄCHSTEN Pad-Knopf melden statt Menü-Aktionen (auch A/B). Abbruch → cb(null): B halten
   * (0.6 s), Start, Esc auf der Tastatur, Zeitüberschreitung (s), Pad weg, Fokusverlust. Rückgabe = still abbrechen.
   */
  capturePadButton(cb: PadCaptureCallback, timeout = PAD_CAPTURE_TIMEOUT): () => void {
    const stop = this.pad.capture((code) => {
      this.captureEsc = null;
      cb(code);
    }, timeout);
    this.captureEsc = () => {
      this.captureEsc = null;
      stop();
      cb(null);
    };
    return () => {
      this.captureEsc = null;
      stop();
    };
  }

  /** Wie capturePadButton als Promise (null = abgebrochen). */
  nextPadButton(timeout = PAD_CAPTURE_TIMEOUT): Promise<PadButtonCode | null> {
    return new Promise((resolve) => {
      this.capturePadButton(resolve, timeout);
    });
  }

  /** Tools (`__vel.pad`): Fake-Pad statt navigator.getGamepads; null = echte Pads. */
  setFakePad(pad: GamepadLike | null): void {
    this.fakePads = pad ? [pad] : null;
  }

  /** Ein Fake-Pad stellt die Eingabe (Skript) — Game markiert Läufe dann als assistiert (Review A6). */
  get fakePadActive(): boolean {
    return this.fakePads !== null;
  }

  private readonly padSource: GamepadSource = () => {
    if (this.fakePads !== null) return this.fakePads;
    if (this.padCount <= 0 && this.padProbe > 0) return null;
    this.padProbe = this.padCount <= 0 ? PAD_PROBE_SECONDS : 0;
    const nav: Navigator & { getGamepads?: () => (Gamepad | null)[] } = navigator;
    try {
      const pads = nav.getGamepads ? nav.getGamepads() : null;
      // Probe fand ein Pad ohne Event (schon vor dem Laden verbunden) → ab jetzt jeden Frame abfragen.
      if (pads !== null && this.padCount <= 0) {
        for (const p of pads) {
          if (p !== null && p.connected) {
            this.padCount = 1;
            break;
          }
        }
      }
      return pads;
    } catch {
      // Unsicherer Kontext / Permissions-Policy: kein Pad.
      return null;
    }
  };

  private setRawDevice(d: InputDevice): void {
    if (d === this.rawDevice) return;
    this.rawDevice = d;
    this.updateDevice();
  }

  private updateDevice(): void {
    const raw = this.rawDevice;
    const g = this.padSettings.glyphs;
    const eff: InputDevice = raw === 'keyboard' || g === 'auto' ? raw : g;
    if (eff === this.effDevice) return;
    this.effDevice = eff;
    for (const fn of this.deviceListeners) fn(eff);
  }

  private readonly onPadConnected = (): void => {
    this.padCount++;
    this.padProbe = 0;
  };

  private readonly onPadDisconnected = (): void => {
    this.padCount = Math.max(0, this.padCount - 1);
    // Der nächste poll sieht das Pad nicht mehr, PadInput lässt los und pausiert im Spiel.
    this.padProbe = 0;
  };

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

  /** Desktop-Hülle: Vollbild/Kürzel regelt der Hauptprozess. */
  get desktop(): boolean {
    return this.platform.kind === 'desktop';
  }

  /**
   * Entwickler-Werkzeuge (F1-Tuning) erlaubt: Web immer, Desktop nur mit `--dev` — dieselbe Regel wie
   * Menu.adminAllowed für F8 (Review A10: sonst Physik-Cheats für Medaillen/Kosmetik in der Release-exe).
   */
  get devTools(): boolean {
    return this.platform.kind === 'web' || this.platform.dev;
  }

  /** Vollbild ist ein Anzeigemodus der Plattform (Desktop) statt Browser-Vollbild mit Geste. */
  get platformFullscreen(): boolean {
    return this.platform.window !== null;
  }

  /** Strg zählt gerade als Ducken (Web: nur im Vollbild mit Keyboard Lock; Desktop: immer). */
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

  /**
   * Vor den Ticks jedes Frames (FixedLoop.onFrameStart): Gamepad abfragen, dann Blick-Sample.
   * frameDt = simulierte Framezeit (Kamera-Stick-Rate mal frameDt).
   */
  beginFrame(frameDt = 0): void {
    if (this.padProbe > 0) this.padProbe -= frameDt > 0 ? frameDt : 0;
    const wasConnected = this.pad.connected;
    this.pad.poll(frameDt);
    // Pad weg ohne Event: wieder nur proben statt jeden Frame getGamepads().
    if (wasConnected && !this.pad.connected && this.fakePads === null) this.padCount = 0;
    if (this.pad.consumeActivity()) this.setRawDevice(this.pad.kind);
    else if (!this.pad.connected && this.rawDevice !== 'keyboard') this.setRawDevice('keyboard');
    if (this.pad.consumePresses()) this.presses++;
    this.state.beginFrame(frameDt);
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

  /**
   * Seit dem letzten Aufruf eine Taste, Maustaste (im Lock) oder das Mausrad gedrückt? Setzt zurück.
   * Zählt auch, während ein Bot/Override die Tick-Eingabe stellt — genau dann braucht man es: die
   * Vorführung endet mit jeder Taste. Mausbewegung zählt nicht (Zittern der Hand).
   */
  anyKeyDown(): boolean {
    const any = this.presses > 0;
    this.presses = 0;
    return any;
  }

  /** Bots/Playwright: ersetzt die Tick-Eingabe komplett; null = wieder echte Eingabe. */
  setOverride(fn: InputOverride | null): void {
    this.state.setOverride(fn);
  }

  /** Vollbild umschalten; im Vollbild zusätzlich Keyboard Lock (falls verfügbar). Aus einer User-Geste aufrufen. */
  async toggleFullscreen(): Promise<boolean> {
    const w = this.platform.window;
    if (w) {
      // Desktop: Anzeigemodus des Fensters, frisch gelesen (kann auch aus den Einstellungen geändert sein).
      const cur = await w.getMode().catch(() => this.desktopMode);
      this.desktopMode = await w.setMode(cur === 'fullscreen' ? 'windowed' : 'fullscreen').catch(() => cur);
      return this.desktopMode === 'fullscreen';
    }
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
    const w = this.platform.window;
    if (w) {
      // Desktop: ohne Geste und ohne Keyboard Lock (Strg duckt dort ohnehin).
      return w.setMode('fullscreen').then(
        (m) => {
          this.desktopMode = m;
          return m === 'fullscreen';
        },
        () => false,
      );
    }
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
    if (this.platform.window) return this.desktopMode === 'fullscreen';
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
    window.removeEventListener('gamepadconnected', this.onPadConnected);
    window.removeEventListener('gamepaddisconnected', this.onPadDisconnected);
    this.lockListeners.clear();
    this.noticeListeners.clear();
    this.deviceListeners.clear();
    this.state.releaseAll();
    if (document.pointerLockElement === this.target) document.exitPointerLock();
  }

  // ---------------------------------------------------------------- intern

  private setKeyboardLocked(on: boolean): void {
    this.keyboardLocked = on;
    this.state.setCtrlCrouch(on || this.desktop);
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
    // Maus im Lock = Spielen mit der Maus (ohne Lock zählt Bewegung nicht: Zittern neben dem Pad) — aber erst, wenn
    // das Pad kurz still war: Stick + Maus zugleich (Deck-Trackpad) flatterte sonst je Frame (Review A4).
    if (this.rawDevice !== 'keyboard' && this.pad.idleSeconds >= MOUSE_DEVICE_DEBOUNCE) this.setRawDevice('keyboard');
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
    if (this.captureEsc !== null && e.code === 'Escape') {
      // Esc bricht nur die Aufnahme ab, nicht noch "Zurück" im Menü.
      e.preventDefault();
      this.captureEsc();
      return;
    }
    if (this.rawDevice !== 'keyboard') this.setRawDevice('keyboard');
    if (this.isLocked && e.code === 'Escape') {
      // Nur mit Keyboard Lock (Vollbild) kommt Esc im Lock hier an — Chrome lässt den
      // Pointer Lock dann stehen. Ohne Freigabe hinge die Maus unsichtbar hinter dem
      // Pause-Menü und drehte die Kamera. exitLock unterdrückt die zweite Pause aus
      // dem Lock-Verlust: genau ein 'pause' und eine freie Maus.
      e.preventDefault();
      if (!e.repeat) this.presses++;
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
    if (!e.repeat) this.presses++;
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
    // Klick (auch im Menü) = Maus-Bedienung: Prompts wechseln, Start fordert wieder den Lock an.
    if (this.rawDevice !== 'keyboard') this.setRawDevice('keyboard');
    if (!this.isLocked) return;
    const code = MOUSE_CODES[e.button];
    if (code === undefined) return;
    if (e.button !== 0) e.preventDefault();
    this.presses++;
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
    this.presses++;
    this.state.wheel();
  };

  private readonly onBlur = (): void => {
    this.state.releaseAll();
    this.pad.releaseAll();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState !== 'visible') {
      this.state.releaseAll();
      this.pad.releaseAll();
    }
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    if (this.isLocked) e.preventDefault();
  };

  /**
   * Sicherheitsnetz gegen Strg+W (Ducken + vorwärts) im Fenstermodus: der Browser
   * fragt „Seite verlassen?“ statt den Tab samt Lauf sofort zu schließen.
   */
  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    // Desktop: keine Wache — in Electron bricht preventDefault das Schließen still ab (Fenster-X täte nichts).
    // Der Lauf ist beim Schließen verloren wie beim Alt-F4 in jedem Spiel (Plan 011 §2.4).
    if (this.desktop) return;
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
