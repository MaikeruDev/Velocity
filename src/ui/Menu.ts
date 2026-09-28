import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import './menu.css';

import type { BestTimes, SettingsPatch, SettingsStore } from '../engine/Settings';
import type { BindAction, GameSettings, GloveId, HeldItemId } from '../engine/settingsTypes';
import type { UnlockId, UnlockStore } from '../engine/Unlocks';
import { PENDING_UNLOCKS, UNLOCKS, deriveUnlocks, gloveUnlock, itemUnlock, requirementMet, unlockDef } from '../engine/Unlocks';
import type { GameEvent } from '../engine/events';
import { ViewHand, hasPropTricks } from './hand/ViewHand';
import { makeHandInput } from './hand/handMotion';
import { ViewModelPreview } from '../render/viewmodel/ViewModelPreview';
import { hasItemView } from '../render/viewmodel/items';
import { hasSkin } from '../render/viewmodel/skins';
import { BIND_ACTIONS, GLOVE_IDS, HELD_ITEM_IDS } from '../engine/settingsTypes';
import type { InputAction } from '../engine/InputState';
import { MOUSE_CODES, isBindableCode, keyLabel } from '../engine/InputState';
import type { MovementPresetId } from '../player/MovementConfig';
import type { LevelIndexEntry, StageRank, TrainingIndexEntry } from '../world/level/LevelFormat';
import type { LessonStars, TrainingProgressView } from '../engine/trainingTypes';
import { formatDiff, formatTime } from './format';
import { MEDAL_NAMES, MEDAL_ORDER, adminTimeFor, medalFor, nextMedal } from './medals';
import type { MedalId } from './medals';
import { effectiveLines } from '../render/lowres';
import type { FinishResult, LessonResult, MenuEvents, MenuScreen, RawMouseStatus } from './types';

/**
 * HTML-Overlays: Titel, Pause, Einstellungen, Steuerung, Ergebnis — und das Training (Plan 007):
 * Knopf TRAINING + Neulings-Band im Titel, Lektionsliste ('training'), Ergebnis einer Lektion
 * ('lessonDone'), eigene Pause in Lektionen, Admin: Lektion abhaken/zurücksetzen.
 *
 * Tastatur: Das Menü hängt sich NICHT selbst an R/Enter/Esc — die Engine
 * reicht ihre InputActions per handleAction() durch, solange das Menü sichtbar
 * ist. So gibt es genau eine Quelle für Tastendrücke und keine Doppelauslösung.
 * Pfeiltasten in der Levelliste behandelt das Menü selbst (reine Fokus-Navigation).
 *
 * Ereignisse 'play' und 'resume' feuern synchron im Klick-/Tasten-Handler —
 * dort sofort InputManager.requestLock() und AudioApi.unlock() aufrufen (User-Geste).
 * Den Lock-Versuch mit trackLock() begleiten: sperrt die Knöpfe, solange er läuft,
 * und zeigt bei Ablehnung einen Hinweis statt stumm nichts zu tun.
 */

type Listener<K extends keyof MenuEvents> = (payload: MenuEvents[K]) => void;
type ListenerMap = { [K in keyof MenuEvents]: Set<Listener<K>> };

type Child = Node | string | null | undefined | false;

/** Nach dem Einblenden des Ergebnisses kurz keine Eingaben — sonst überspringt ein Bhop-Spam den Screen. */
const FINISH_INPUT_GUARD_MS = 450;

/** Rückmeldung zum Pointer-Lock-Versuch aus einer Menü-Geste (siehe setLockStatus). */
export interface LockStatus {
  /** Ein Versuch läuft — Startknöpfe gesperrt, weitere Klicks würden nur Chromes Drossel füttern. */
  readonly pending: boolean;
  /** Letzter Fehlgrund (InputManager.lockError), null = kein Fehler. */
  readonly error: string | null;
}

const LOCK_IDLE: LockStatus = { pending: false, error: null };

/** Nach einer Maustasten-Belegung Kontextmenü und Zurück/Vor-Navigation noch kurz schlucken. */
const CAPTURE_SUPPRESS_MS = 800;

/** Laufende Tastenbelegung: welche Aktion, welcher Platz, welcher Knopf zeigt "Taste …". */
interface BindCapture {
  readonly action: BindAction;
  readonly slot: number;
  readonly button: HTMLButtonElement;
}

const PERCENT = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Was das Menü vom Trainings-Fortschritt braucht (Game reicht engine/TrainingProgress durch).
 * Lesen wie TrainingProgressView, dazu Admin-Aktionen.
 */
export interface MenuTraining extends TrainingProgressView {
  /** Mindestens eine Stufe irgendeiner Lektion erledigt (sonst Neuling, sofern ohne Bestzeit). */
  readonly started: boolean;
  /** Lektionen spielbar (Lektions-Logik geladen). false = Liste nur ansehen. */
  readonly playable: boolean;
  /** Admin: Lektion komplett abhaken. false = die Lektion ist noch nicht geladen (Stufen unbekannt). */
  complete(lessonId: string): boolean;
  /** Admin: Lektion zurücksetzen. */
  reset(lessonId: string): void;
}

/** Laufende Lektion für die Pause (Plan 007). Aktionen ohne MenuEvent laufen über die Rückrufe. */
export interface LessonPauseInfo {
  readonly name: string;
  readonly stageTitle: string;
  /** Zähler je Rang, z. B. "Stufe 2/4" oder "Bonus 1/1" (hudLogic.stageLabel). */
  readonly stageLabel: string;
  /** Diese Stufe hat eine Vorführung. */
  readonly demo: boolean;
  /** Alle Pflichtstufen erledigt → "Ergebnis ansehen". */
  readonly done: boolean;
  /** Zurück an den Start der Stufe (wie Taste F). */
  respawnStage(): void;
  /** Lektion jetzt beenden und das Ergebnis zeigen (nur wenn done). */
  showResult(): void;
}

const STAR_ON = '★';
const STAR_OFF = '☆';

/** "★★☆" — gefüllte und leere Sterne. */
function starText(n: number): string {
  const k = Math.max(0, Math.min(3, n));
  return STAR_ON.repeat(k) + STAR_OFF.repeat(3 - k);
}

export class Menu {
  private readonly settings: SettingsStore;
  private readonly best: BestTimes;
  private readonly unlocks: UnlockStore;
  private readonly el: HTMLDivElement;
  /** Stoppt die Live-Vorschau der Hand (Kosmetik), null = keine aktiv. */
  private previewStop: (() => void) | null = null;
  private readonly listeners: ListenerMap = {
    play: new Set(),
    resume: new Set(),
    restart: new Set(),
    toTitle: new Set(),
    nextLevel: new Set(),
    fullscreen: new Set(),
    adminBest: new Set(),
    demo: new Set(),
    skipStage: new Set(),
  };

  private current: MenuScreen | null = null;
  /** Wohin "Zurück" aus Einstellungen/Steuerung führt. */
  private returnTo: MenuScreen = 'title';
  private levels: readonly LevelIndexEntry[] = [];
  private selected = 0;
  private finishResult: FinishResult | null = null;
  private guardUntil = 0;
  private refreshers: ((s: GameSettings) => void)[] = [];
  private readonly unsubscribe: () => void;
  private lockStatus: LockStatus = LOCK_IDLE;
  /** Zählt trackLock-Aufrufe — ein veraltetes Promise darf den Status nicht überschreiben. */
  private lockSeq = 0;
  private rawStatus: () => RawMouseStatus = () => 'unknown';
  private capture: BindCapture | null = null;
  private suppressUntil = 0;
  /** Vorschau, die render() nach dem Einhängen startet (Canvas muss im DOM sein). */
  private previewStart: (() => () => void) | null = null;
  /** Wohin das Admin-Menü zurückführt (Titel oder Pause). */
  private adminReturn: 'title' | 'pause' = 'title';
  /** Aktualisiert das offene Admin-Menü an Ort und Stelle (kein Neuaufbau: Scroll und Fokus bleiben). */
  private adminRefresh: (() => void) | null = null;
  /** Training (Plan 007): Lektionsliste + Fortschritt, null = (noch) keins. */
  private training: MenuTraining | null = null;
  private selectedLesson = 0;
  private lessonResult: LessonResult | null = null;
  private lessonPause: LessonPauseInfo | null = null;
  /** Taste der Vorführung (Anzeige im Pause-Menü), z. B. 'H'. */
  private demoKey = 'H';

  constructor(root: HTMLElement, settings: SettingsStore, best: BestTimes, unlocks: UnlockStore) {
    this.settings = settings;
    this.best = best;
    this.unlocks = unlocks;
    unlocks.subscribe(() => {
      if (this.current === 'cosmetics') this.showCosmetics();
      else if (this.current === 'admin') this.adminRefresh?.();
    });
    this.el = h('div', 'vel-menu');
    this.el.hidden = true;
    // An window statt am Menü: ohne Fokus im Menü (Normalfall) kämen die Pfeiltasten sonst nie an.
    window.addEventListener('keydown', this.onKeyDown);
    // Capture-Phase: die Tastenbelegung muss Tasten VOR InputManager und Menü-Aktionen abfangen.
    window.addEventListener('keydown', this.onCaptureKey, true);
    window.addEventListener('mousedown', this.onCaptureMouse, true);
    window.addEventListener('mouseup', this.onSuppressMouse, true);
    window.addEventListener('auxclick', this.onSuppressMouse, true);
    window.addEventListener('contextmenu', this.onSuppressMouse, true);
    root.appendChild(this.el);
    // Änderungen von außen (Tuning-Panel, Reset) sofort in offenen Reglern zeigen.
    this.unsubscribe = settings.subscribe((s) => {
      for (const r of this.refreshers) r(s);
    });
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  get screen(): MenuScreen | null {
    return this.current;
  }

  /** Aktuell ausgewählte Level-ID (Titel). */
  get selectedLevelId(): string | null {
    return this.levels[this.selected]?.id ?? null;
  }

  on<K extends keyof MenuEvents>(k: K, fn: Listener<K>): () => void {
    const set: Set<Listener<K>> = this.listeners[k];
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Woher Einstellungen und Steuerung den Raw-Maus-Status lesen (InputManager.rawStatus). */
  setRawStatusProvider(fn: () => RawMouseStatus): void {
    this.rawStatus = fn;
  }

  setLevels(levels: readonly LevelIndexEntry[]): void {
    this.levels = levels;
    this.selected = Math.min(this.selected, Math.max(0, levels.length - 1));
    if (this.current === 'title') this.showTitle();
    else if (this.current === 'admin') this.showAdmin();
  }

  /**
   * Training (Plan 007): Lektionen + Fortschritt. Game ruft das nach dem Laden von
   * training/index.json und nach jeder Änderung des Fortschritts (offene Screens bauen neu).
   */
  setTraining(t: MenuTraining | null): void {
    this.training = t;
    const n = t ? t.lessons().length : 0;
    this.selectedLesson = Math.min(this.selectedLesson, Math.max(0, n - 1));
    if (this.current === 'title') this.showTitle();
    else if (this.current === 'training') this.showTraining();
    else if (this.current === 'admin') this.adminRefresh?.();
  }

  /** Beschriftung der Vorführungs-Taste (KeyBinds.demo) für Pause und Liste. */
  setDemoKey(label: string): void {
    this.demoKey = label;
  }

  /** Lektionsliste (aus dem Titel oder nach einer Lektion). */
  showTraining(): void {
    this.lockStatus = LOCK_IDLE;
    const t = this.training;
    if (t) {
      const lessons = t.lessons();
      // Auswahl auf die empfohlene Lektion, solange man nichts anderes gewählt hat.
      const rec = recommendedIndex(t);
      if (this.current !== 'training' && rec >= 0) this.selectedLesson = rec;
      this.selectedLesson = Math.min(this.selectedLesson, Math.max(0, lessons.length - 1));
    }
    this.render('training', this.buildTraining());
  }

  /** Ergebnis einer Lektion: Sterne, Stufenliste, Weiter/Nochmal/Übersicht. */
  showLessonDone(r: LessonResult): void {
    this.lessonResult = r;
    this.lockStatus = LOCK_IDLE;
    this.guardUntil = performance.now() + FINISH_INPUT_GUARD_MS;
    this.render('lessonDone', this.buildLessonDone(r));
  }

  /** Level in der Titel-Liste vorauswählen (z. B. das zuletzt gespielte). */
  select(levelId: string): void {
    const i = this.levels.findIndex((l) => l.id === levelId);
    if (i >= 0) this.selected = i;
    if (this.current === 'title') this.showTitle();
  }

  showTitle(): void {
    this.lockStatus = LOCK_IDLE;
    this.render('title', this.buildTitle());
  }

  /**
   * Pause-Screen; ein alter Lock-Fehler wird verworfen (danach ggf. setLockStatus). In einer
   * Lektion (lesson) mit eigenen Einträgen: Vorführung, Stufe neu, Stufe überspringen, Lektion neu.
   */
  showPause(lesson: LessonPauseInfo | null = null): void {
    this.lockStatus = LOCK_IDLE;
    this.lessonPause = lesson;
    this.render('pause', lesson ? this.buildLessonPause(lesson) : this.buildPause());
  }

  /**
   * Rückmeldung zum Pointer Lock nach play/resume/restart/nextLevel: pending sperrt
   * die Startknöpfe, error zeigt im Titel/in der Pause einen lesbaren Hinweis und
   * „Klicken zum Fortsetzen“. Bequemer: trackLock().
   */
  setLockStatus(status: LockStatus): void {
    this.lockStatus = status;
    this.applyLockStatus();
  }

  /**
   * Lock-Versuch begleiten: sofort pending, danach Fehler oder Ruhe. Aufruf im
   * Menü-Handler direkt nach input.requestLock(), z. B.
   * `menu.trackLock(input.requestLock(), () => input.lockError)`.
   */
  trackLock(p: Promise<boolean>, error: () => string | null): void {
    const seq = ++this.lockSeq;
    this.setLockStatus({ pending: true, error: null });
    void p.then(
      (ok) => {
        if (seq === this.lockSeq) this.setLockStatus(ok ? LOCK_IDLE : { pending: false, error: error() ?? 'unbekannt' });
      },
      () => {
        if (seq === this.lockSeq) this.setLockStatus({ pending: false, error: error() ?? 'unbekannt' });
      },
    );
  }

  showFinish(r: FinishResult): void {
    this.finishResult = r;
    this.lockStatus = LOCK_IDLE;
    this.guardUntil = performance.now() + FINISH_INPUT_GUARD_MS;
    this.render('finish', this.buildFinish(r));
  }

  showSettings(): void {
    if (this.current && this.current !== 'settings' && this.current !== 'controls') this.returnTo = this.current;
    this.render('settings', this.buildSettings());
  }

  /** Kosmetik: Handschuh und Gegenstand der View-Hand, mit Live-Vorschau (Plan 005). */
  showCosmetics(): void {
    this.render('cosmetics', this.buildCosmetics());
  }

  /**
   * Admin-Menü (Freischaltungen und Medaillen von Hand setzen): aus Titel oder Pause,
   * über den Knopf im System-Panel oder F8. Kein Passwort — Einzelspieler.
   */
  showAdmin(): void {
    if (this.current === 'title' || this.current === 'pause') this.adminReturn = this.current;
    this.render('admin', this.buildAdmin());
  }

  showControls(): void {
    if (this.current && this.current !== 'settings' && this.current !== 'controls') this.returnTo = this.current;
    this.render('controls', this.buildControls());
  }

  hide(): void {
    this.stopPreview();
    this.endCapture();
    this.el.hidden = true;
    this.current = null;
    this.adminRefresh = null;
    this.refreshers = [];
    this.el.replaceChildren();
  }

  /**
   * Eine Engine-Aktion im Menü anwenden. true = verbraucht (die Engine soll sie
   * nicht selbst ausführen). toggleTuning/toggleMute bleiben immer bei der Engine.
   */
  handleAction(a: InputAction): boolean {
    if (!this.visible || this.current === null) return false;
    if (a === 'toggleTuning' || a === 'toggleMute') return false;
    if (performance.now() < this.guardUntil) return true;
    // Lock-Versuch läuft: Enter/R-Spam nicht als neue Anfragen durchreichen (Chrome drosselt).
    if (this.lockStatus.pending && (a === 'confirm' || a === 'restart')) return true;
    switch (this.current) {
      case 'title':
        if (a === 'confirm') this.playSelected();
        return true;
      case 'pause':
        if (a === 'confirm') this.emit('resume', undefined);
        else if (a === 'restart') this.emit('restart', undefined);
        else if (this.lessonPause) {
          // Lektion: H = Vorführung, F = Stufe neu (beides wie im Spiel).
          if (a === 'demo' && this.lessonPause.demo) this.emit('demo', undefined);
          else if (a === 'respawn') this.lessonPause.respawnStage();
        }
        // Esc ist keine User-Aktivierung → Pointer Lock ginge nicht; Weiter nur per Klick/Enter.
        return true;
      case 'finish': {
        const r = this.finishResult;
        if (a === 'restart') this.emit('restart', undefined);
        else if (a === 'confirm') this.emit(r?.hasNext ? 'nextLevel' : 'restart', undefined);
        else if (a === 'pause') this.emit('toTitle', undefined);
        return true;
      }
      case 'settings':
      case 'controls':
        if (a === 'pause' || a === 'confirm') this.back();
        return true;
      case 'cosmetics':
        if (a === 'pause' || a === 'confirm') this.showTitle();
        return true;
      case 'admin':
        if (a === 'pause' || a === 'confirm') this.leaveAdmin();
        return true;
      case 'training':
        if (a === 'pause') this.showTitle();
        else if (a === 'confirm') this.playSelectedLesson();
        return true;
      case 'lessonDone': {
        const r = this.lessonResult;
        if (a === 'confirm') {
          if (r?.nextLessonId) this.emit('play', { levelId: r.nextLessonId });
          else this.emit('toTitle', undefined);
        } else if (a === 'restart') this.emit('restart', undefined);
        else if (a === 'pause') this.emit('toTitle', undefined);
        return true;
      }
    }
  }

  dispose(): void {
    this.stopPreview();
    this.unsubscribe();
    this.endCapture();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keydown', this.onCaptureKey, true);
    window.removeEventListener('mousedown', this.onCaptureMouse, true);
    window.removeEventListener('mouseup', this.onSuppressMouse, true);
    window.removeEventListener('auxclick', this.onSuppressMouse, true);
    window.removeEventListener('contextmenu', this.onSuppressMouse, true);
    this.el.remove();
    for (const k of Object.keys(this.listeners)) {
      if (isMenuEvent(k)) this.listeners[k].clear();
    }
  }

  // ------------------------------------------------------------------ intern

  private emit<K extends keyof MenuEvents>(k: K, payload: MenuEvents[K]): void {
    const set: Set<Listener<K>> = this.listeners[k];
    for (const fn of [...set]) fn(payload);
  }

  private render(id: MenuScreen, screen: HTMLElement): void {
    // Vorschau des alten Screens stoppen — die neue startet buildCosmetics nach dem Einhängen.
    const pending = this.previewStart;
    this.previewStart = null;
    this.stopPreview();
    this.endCapture();
    if (id !== 'admin') this.adminRefresh = null;
    this.current = id;
    this.el.dataset.screen = id;
    this.el.replaceChildren(screen);
    this.el.hidden = false;
    this.applyLockStatus();
    if (pending) this.previewStop = pending();
    // Fokus nicht automatisch auf Buttons: eine Leertaste aus dem Spiel würde sie sonst auslösen.
    const active = document.activeElement;
    if (active instanceof HTMLElement && !this.el.contains(active) && active !== document.body) active.blur();
  }

  private back(): void {
    switch (this.returnTo) {
      case 'pause':
        this.showPause(this.lessonPause);
        break;
      case 'finish':
        if (this.finishResult) this.render('finish', this.buildFinish(this.finishResult));
        else this.showTitle();
        break;
      default:
        this.showTitle();
    }
  }

  private playSelected(): void {
    const lv = this.levels[this.selected];
    if (lv) this.emit('play', { levelId: lv.id });
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // F8: Admin-Menü aus Titel/Pause auf und wieder zu. Hier statt als InputAction: reine
    // Menü-Navigation; im Spiel (Pointer Lock) ist das Menü unsichtbar und F8 tut nichts.
    if (e.code === 'F8' && this.visible && !e.repeat && this.capture === null) {
      if (this.current === 'title' || this.current === 'pause') {
        e.preventDefault();
        this.showAdmin();
      } else if (this.current === 'admin') {
        e.preventDefault();
        this.leaveAdmin();
      }
      return;
    }
    if (!this.visible || (this.current !== 'title' && this.current !== 'training')) return;
    if (e.code !== 'ArrowUp' && e.code !== 'ArrowDown') return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (this.current === 'training') {
      const n = this.training?.lessons().length ?? 0;
      if (n === 0) return;
      e.preventDefault();
      this.setSelectedLesson((this.selectedLesson + (e.code === 'ArrowDown' ? 1 : n - 1)) % n, true);
      return;
    }
    if (this.levels.length === 0) return;
    e.preventDefault();
    const n = this.levels.length;
    this.setSelected((this.selected + (e.code === 'ArrowDown' ? 1 : n - 1)) % n, true);
  };

  // ------------------------------------------------------------------ Tastenbelegung

  private startCapture(action: BindAction, slot: number, button: HTMLButtonElement): void {
    const same = this.capture?.button === button;
    this.endCapture();
    if (same) return; // zweiter Klick auf dasselbe Feld = abbrechen
    this.capture = { action, slot, button };
    button.textContent = 'Taste …';
    button.setAttribute('aria-pressed', 'true');
  }

  private endCapture(): void {
    if (!this.capture) return;
    this.capture = null;
    // Beschriftungen aus dem aktuellen Stand neu (auch des abgebrochenen Feldes).
    const s = this.settings.get();
    for (const r of this.refreshers) r(s);
  }

  /** Code einer Aktion zuweisen (null = Platz leeren). Derselbe Code verschwindet aus allen anderen Aktionen. */
  private assignBind(action: BindAction, slot: number, code: string | null): void {
    const cur = this.settings.get().keybinds;
    const next: Record<BindAction, string[]> = { jump: [...cur.jump], crouch: [...cur.crouch], sprint: [...cur.sprint], demo: [...cur.demo] };
    if (code !== null) for (const a of BIND_ACTIONS) next[a] = next[a].filter((c) => c !== code);
    const list = next[action];
    if (code === null) {
      if (slot < list.length) list.splice(slot, 1);
    } else if (slot < list.length) list[slot] = code;
    else list.push(code);
    this.capture = null;
    this.settings.update({ keybinds: next });
    // Auch ohne Änderung (dieselbe Taste erneut) muss "Taste …" verschwinden.
    const s = this.settings.get();
    for (const r of this.refreshers) r(s);
  }

  private readonly onCaptureKey = (e: KeyboardEvent): void => {
    const cap = this.capture;
    if (!cap) return;
    // Nichts davon darf das Spiel oder die Menü-Aktionen erreichen (Esc hieße sonst "Zurück").
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.code === 'Escape') this.endCapture();
    else if (e.code === 'Backspace' || e.code === 'Delete') this.assignBind(cap.action, cap.slot, null);
    else if (isBindableCode(e.code)) this.assignBind(cap.action, cap.slot, e.code);
    else cap.button.textContent = `${keyLabel(e.code)} geht nicht`;
  };

  private readonly onCaptureMouse = (e: MouseEvent): void => {
    const cap = this.capture;
    if (!cap) return;
    if (e.button === 0) {
      // Linksklick bedient das Menü; außerhalb der Belegungsfelder bricht er ab.
      if (!(e.target instanceof Element && e.target.closest('.vel-bind'))) this.endCapture();
      return;
    }
    const code = MOUSE_CODES[e.button];
    e.preventDefault();
    e.stopImmediatePropagation();
    this.suppressUntil = performance.now() + CAPTURE_SUPPRESS_MS;
    if (code !== undefined && isBindableCode(code)) this.assignBind(cap.action, cap.slot, code);
  };

  /** Rechtsklick-Menü und Browser-Zurück/Vor der gerade belegten Maustaste schlucken. */
  private readonly onSuppressMouse = (e: MouseEvent): void => {
    if (this.capture === null && performance.now() > this.suppressUntil) return;
    if (e.type === 'mouseup' && e.button === 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  /** Eine Zeile "Aktion: [Taste 1] [Taste 2]" mit Belegung per Klick. */
  private bindRow(action: BindAction, label: (s: GameSettings) => string): HTMLElement {
    const wrap = h('div', 'vel-seg vel-bind');
    const buttons = [0, 1].map((slot) => {
      const b = h('button', 'vel-btn', '');
      b.type = 'button';
      b.addEventListener('click', () => this.startCapture(action, slot, b));
      wrap.append(b);
      return b;
    });
    const r = row(label(this.settings.get()), wrap, null);
    const labelEl = r.querySelector('.vel-setting-label');
    const refresh = (s: GameSettings): void => {
      const list = s.keybinds[action];
      buttons.forEach((b, i) => {
        const capturing = this.capture?.button === b;
        if (capturing) return;
        const c = list[i];
        b.textContent = c !== undefined ? keyLabel(c) : '—';
        b.setAttribute('aria-pressed', 'false');
      });
      if (labelEl) labelEl.textContent = label(s);
    };
    refresh(this.settings.get());
    this.refreshers.push(refresh);
    return r;
  }

  private setSelected(i: number, focus = false): void {
    this.selected = i;
    const buttons = this.el.querySelectorAll<HTMLButtonElement>('.vel-level');
    buttons.forEach((b, j) => b.classList.toggle('is-selected', j === i));
    const label = this.el.querySelector('.vel-start-level');
    if (label) label.textContent = this.startLabel();
    if (focus) buttons[i]?.focus();
  }

  /** Welches Level „Klicken zum Starten“ startet — steht auf dem Knopf, damit es keine Überraschung gibt. */
  private startLabel(): string {
    const lv = this.levels[this.selected];
    return lv ? `${String(this.selected + 1).padStart(2, '0')} ${listName(lv.name)}` : '';
  }

  private applyLockStatus(): void {
    const st = this.lockStatus;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('button[data-lock]')) {
      b.disabled = st.pending || b.dataset.off === '1';
    }
    const resume = this.el.querySelector('.vel-resume-label');
    if (resume) resume.textContent = st.error !== null ? 'Klicken zum Fortsetzen' : 'Weiter';
    const hint = this.el.querySelector<HTMLElement>('.vel-lock-hint');
    if (hint) {
      const base = hint.dataset.base ?? '';
      hint.textContent = st.error !== null ? lockErrorText(st.error) : base;
      hint.title = st.error ?? '';
      hint.classList.toggle('is-error', st.error !== null);
      hint.hidden = hint.textContent === '';
    }
  }

  /**
   * Zeile "Rohdaten: …": ob die Maus ohne Zeigerbeschleunigung läuft. Ohne Rohdaten
   * hängt der Drehwinkel von der Handgeschwindigkeit ab — die Strafe-Motorik aus CS passt dann nicht.
   */
  private rawHint(): HTMLElement {
    const st = this.rawStatus();
    const el = h('div', 'vel-setting-hint vel-raw-status');
    el.dataset.raw = st;
    if (st === 'active') el.append('Rohdaten: ', h('b', '', 'aktiv'), ' — ohne Zeigerbeschleunigung.');
    else if (st === 'unavailable') {
      el.append(
        'Rohdaten: ',
        h('b', '', 'nicht verfügbar'),
        ' — der Browser liefert beschleunigte Werte. Windows: „Zeigerbeschleunigung verbessern“ ausschalten.',
      );
    } else el.append('Rohdaten: werden beim ersten Start geprüft.');
    return el;
  }

  /** Hinweiszeile für Lock-Fehler; `base` steht dort, solange alles gut ist. */
  private lockHint(base: string): HTMLElement {
    const p = h('p', 'vel-hint vel-lock-hint', base);
    p.dataset.base = base;
    p.hidden = base === '';
    p.setAttribute('role', 'status');
    return p;
  }

  private btn(label: Child, cls: string, onClick: () => void, kbd?: string): HTMLButtonElement {
    const b = h('button', `vel-btn ${cls}`.trim(), h('span', '', label), kbd ? h('span', 'vel-kbd', kbd) : null);
    b.type = 'button';
    b.addEventListener('click', () => {
      if (performance.now() < this.guardUntil) return;
      onClick();
    });
    return b;
  }

  // ------------------------------------------------------------------ Titel

  private buildTitle(): HTMLElement {
    const list = h('div', 'vel-levels');
    if (this.levels.length === 0) {
      list.append(h('div', 'vel-hint', 'Level werden geladen …'));
    }
    this.levels.forEach((lv, i) => {
      const bestTime = this.best.get(lv.id);
      const medal = medalFor(bestTime, lv.medals);
      const b = h(
        'button',
        `vel-btn vel-level${i === this.selected ? ' is-selected' : ''}`,
        h('span', 'vel-level-num', String(i + 1).padStart(2, '0')),
        h('span', 'vel-level-name', listName(lv.name), lv.subtitle ? h('span', 'vel-level-sub', lv.subtitle) : null),
        h(
          'span',
          'vel-level-best',
          h('small', '', 'Bestzeit'),
          bestTime !== null ? formatTime(bestTime) : '--:--.--',
          medal !== null ? medalBadge(medal) : null,
        ),
      );
      b.type = 'button';
      b.dataset.lock = '1';
      b.addEventListener('click', () => {
        this.setSelected(i);
        this.emit('play', { levelId: lv.id });
      });
      // Nur Fokus (Tab) wählt aus, nicht Hover: die Liste liegt über dem Start-Knopf, auf dem
      // Weg dorthin würde sonst das zuletzt überfahrene Level gestartet.
      b.addEventListener('focus', () => this.setSelected(i));
      list.append(b);
    });

    const start = h(
      'button',
      'vel-btn vel-btn--primary vel-start',
      h('span', 'vel-start-main', 'Klicken zum Starten'),
      h('span', 'vel-start-level', this.startLabel()),
    );
    start.type = 'button';
    start.dataset.lock = '1';
    start.addEventListener('click', () => this.playSelected());
    if (this.levels.length === 0) {
      start.dataset.off = '1';
      start.disabled = true;
    }

    const levelPanel = h('div', 'vel-panel', h('h2', 'vel-h2', 'Levelauswahl'), list);
    const newbie = this.isNewbie();
    const t = this.training;
    const rec = t ? recommendedIndex(t) : -1;
    const recEntry = t && rec >= 0 ? t.lessons()[rec] : null;
    // Neuling (keine Bestzeit, kein Trainingsfortschritt): Training groß anbieten, nie erzwingen.
    let band: HTMLElement | null = null;
    if (newbie && recEntry && t?.playable) {
      // Keine Tasten-Kappe: "T1" in einer Kappe las sich wie eine Taste. Lektion als zweite Zeile.
      const go = this.btn(
        h('span', 'vel-newbie-go-label', 'Training starten', h('small', 'vel-newbie-go-sub', `${recEntry.short} · ${recEntry.name}`)),
        'vel-btn--primary vel-newbie-go',
        () => this.emit('play', { levelId: recEntry.id }),
      );
      go.dataset.lock = '1';
      band = h(
        'div',
        'vel-newbie',
        h('div', 'vel-newbie-text', h('strong', '', 'Neu hier?'), ' In 15 Minuten lernst du Bhop, Strafen und Surfen.'),
        go,
      );
    }
    const trainingBtn = this.btn(
      h('span', 'vel-training-label', 'Training', t ? h('small', 'vel-training-count', trainingCount(t)) : null),
      'vel-training-btn',
      () => this.showTraining(),
    );
    const side = h(
      'div',
      'vel-panel vel-side',
      h('h2', 'vel-h2', 'System'),
      trainingBtn,
      this.btn('Einstellungen', '', () => this.showSettings()),
      this.btn('Kosmetik', 'vel-cosmetics-btn', () => this.showCosmetics()),
      this.btn('Steuerung', '', () => this.showControls()),
      this.btn('Vollbild', '', () => this.emit('fullscreen', undefined)),
      h(
        'p',
        'vel-tip',
        h('strong', '', 'Tipp: '),
        'In der Luft W loslassen, A oder D halten und die Maus flüssig in dieselbe Richtung ziehen.',
      ),
      // Bewusst unauffällig: klein, gedämpft, ganz unten — ein Werkzeug, kein Spielinhalt.
      this.btn('Admin', 'vel-btn--small vel-admin-btn', () => this.showAdmin(), 'F8'),
    );

    return h(
      'section',
      'vel-screen vel-title-screen',
      h('div', '', h('h1', 'vel-logo', 'VELOCITY'), h('div', 'vel-logo-bar'), h('p', 'vel-subtitle', 'Bunnyhop · Air-Strafe · Surf — Neon-Parcours mit 128 Tick')),
      h('div', 'vel-title-grid', h('div', 'vel-col', band, levelPanel, start, this.lockHint('')), side),
    );
  }

  /** Neuling: keine Bestzeit in irgendeinem Level und kein Trainingsfortschritt. */
  private isNewbie(): boolean {
    if (this.training?.started) return false;
    return this.levels.every((lv) => this.best.get(lv.id) === null);
  }

  private playSelectedLesson(): void {
    const t = this.training;
    const lv = t?.lessons()[this.selectedLesson];
    if (lv && t?.playable) this.emit('play', { levelId: lv.id });
  }

  private setSelectedLesson(i: number, focus = false): void {
    this.selectedLesson = i;
    const buttons = this.el.querySelectorAll<HTMLButtonElement>('.vel-lesson');
    buttons.forEach((b, j) => b.classList.toggle('is-selected', j === i));
    const label = this.el.querySelector('.vel-start-level');
    const lv = this.training?.lessons()[i];
    if (label && lv) label.textContent = `${lv.short} ${lessonName(lv)}`;
    if (focus) buttons[i]?.focus();
  }

  // ------------------------------------------------------------------ Training (Plan 007)

  /**
   * Lektionsliste: Grundlagen und Fortgeschritten, je Zeile Nr · Name · Kurzziel · Sterne ·
   * EMPFOHLEN (erste Lektion ohne Stern). Klick/Enter startet. Bei 1080p ohne Scrollen.
   */
  private buildTraining(): HTMLElement {
    const t = this.training;
    const lessons = t ? t.lessons() : [];
    const rec = t ? recommendedIndex(t) : -1;
    const playable = t?.playable ?? false;
    const group = (g: 'basics' | 'advanced', title: string, reward: string): HTMLElement | null => {
      const rows = lessons.map((lv, i) => ({ lv, i })).filter((x) => x.lv.group === g);
      if (rows.length === 0) return null;
      const list = h('div', 'vel-lessons');
      for (const { lv, i } of rows) {
        const stars = t ? t.stars(lv.id) : 0;
        const b = h(
          'button',
          `vel-btn vel-level vel-lesson${i === this.selectedLesson ? ' is-selected' : ''}`,
          h('span', 'vel-level-num', lv.short),
          h('span', 'vel-level-name', lessonName(lv), lv.subtitle ? h('span', 'vel-level-sub', lv.subtitle) : null),
          h(
            'span',
            'vel-lesson-side',
            i === rec ? h('small', 'vel-lesson-rec', 'Empfohlen') : null,
            h('span', `vel-stars vel-stars--${stars}`, starText(stars)),
          ),
        );
        b.type = 'button';
        b.dataset.lock = '1';
        b.dataset.lesson = lv.id;
        if (!playable) {
          b.dataset.off = '1';
          b.disabled = true;
        }
        b.addEventListener('click', () => {
          this.setSelectedLesson(i);
          this.playSelectedLesson();
        });
        b.addEventListener('focus', () => this.setSelectedLesson(i));
        list.append(b);
      }
      return h('div', 'vel-panel', h('div', 'vel-lesson-head', h('h2', 'vel-h2', title), h('small', 'vel-lesson-reward', reward)), list);
    };
    const sel = lessons[this.selectedLesson];
    const start = h(
      'button',
      'vel-btn vel-btn--primary vel-start',
      h('span', 'vel-start-main', 'Klicken zum Starten'),
      h('span', 'vel-start-level', sel ? `${sel.short} ${lessonName(sel)}` : ''),
    );
    start.type = 'button';
    start.dataset.lock = '1';
    start.addEventListener('click', () => this.playSelectedLesson());
    if (!sel || !playable) {
      start.dataset.off = '1';
      start.disabled = true;
    }
    const empty = lessons.length === 0 ? h('div', 'vel-panel', h('div', 'vel-hint', t ? 'Keine Lektionen gefunden.' : 'Lektionen werden geladen …')) : null;
    return h(
      'section',
      'vel-screen vel-training-screen',
      h(
        'div',
        'vel-head-row',
        h('h1', 'vel-h1', 'Training'),
        h('div', 'vel-row', this.btn('Zurück', 'vel-btn--small', () => this.showTitle(), 'Esc')),
      ),
      h(
        'p',
        'vel-hint vel-training-intro',
        'Kurze Lektionen, kein Tod, kein Timer. Jede Stufe misst, was du tust, und sagt dir, was fehlt. ',
        h('span', 'vel-mono', `[${this.demoKey}]`),
        ' zeigt es dir vor.',
      ),
      empty,
      h(
        'div',
        'vel-training-grid',
        group('basics', 'Grundlagen', `bestanden → Fidget-Spinner${soon('item.spinner')}`),
        group('advanced', 'Fortgeschritten', `alles bestanden → Roboter-Hand${soon('glove.robot')}`),
      ),
      start,
      playable || lessons.length === 0 ? this.lockHint('') : h('p', 'vel-hint vel-lock-hint', 'Die Lektions-Logik fehlt in diesem Build — Lektionen lassen sich nur ansehen.'),
    );
  }

  /** Ergebnis einer Lektion. Enter = nächste Lektion (oder Übersicht nach der letzten). */
  private buildLessonDone(r: LessonResult): HTMLElement {
    const stored = this.training ? this.training.stars(r.lessonId) : r.stars;
    const rankName = (rank: StageRank): string => (rank === 'bonus' ? 'Bonus' : rank === 'master' ? 'Meister' : '');
    const body = h('tbody', '');
    for (const st of r.stages) {
      body.append(
        h(
          'tr',
          st.done ? 'is-done' : '',
          h('td', 'vel-stage-mark', st.done ? '✓' : '·'),
          h('td', '', st.title),
          h('td', 'vel-dim', rankName(st.rank)),
        ),
      );
    }
    const next = r.nextLessonId
      ? this.btn('Nächste Lektion', 'vel-btn--primary', () => {
          if (r.nextLessonId) this.emit('play', { levelId: r.nextLessonId });
        }, 'Enter')
      : null;
    if (next) next.dataset.lock = '1';
    const again = this.btn('Nochmal', '', () => this.emit('restart', undefined), 'R');
    again.dataset.lock = '1';
    const overview = r.nextLessonId
      ? this.btn('Übersicht', '', () => this.emit('toTitle', undefined), 'Esc')
      : this.btn('Übersicht', 'vel-btn--primary', () => this.emit('toTitle', undefined), 'Enter');
    const missing = r.stages.filter((s) => !s.done && s.rank !== 'required').length;
    return h(
      'section',
      (r.unlocked.length > 0 ? 'vel-screen vel-finish-screen vel-finish-screen--unlock' : 'vel-screen vel-finish-screen') + ' vel-lesson-done',
      h('h1', 'vel-h1', r.stars > 0 ? 'Geschafft!' : 'Beendet', h('span', 'vel-dim', `· ${r.name}`)),
      h('p', `vel-lesson-stars vel-stars--${r.stars}`, starText(r.stars)),
      stored > r.stars ? h('p', 'vel-hint', `Dein Bestwert in dieser Lektion: ${starText(stored)}`) : null,
      this.unlockBanner(r.unlocked),
      h(
        'div',
        'vel-panel',
        h('h2', 'vel-h2', 'Stufen'),
        h('table', 'vel-splits vel-stages', body),
        missing > 0 ? h('p', 'vel-hint', `Noch ${missing} Bonus-/Meisterstufe${missing === 1 ? '' : 'n'} offen — mehr Sterne mit „Nochmal“.`) : null,
      ),
      h('div', 'vel-row', next, again, overview),
    );
  }

  /** Pause in einer Lektion: Stufe im Blick, Vorführung und Stufen-Aktionen statt Neustart/Level. */
  private buildLessonPause(L: LessonPauseInfo): HTMLElement {
    const resume = this.btn(h('span', 'vel-resume-label', 'Weiter'), 'vel-btn--primary', () => this.emit('resume', undefined), 'Enter');
    resume.dataset.lock = '1';
    const demo = L.demo ? this.btn('Vorführung ansehen', '', () => this.emit('demo', undefined), this.demoKey) : null;
    if (demo) demo.dataset.lock = '1';
    const again = this.btn('Stufe neu', '', () => L.respawnStage(), 'F');
    // 'zählt nicht' sichtbar, nicht nur im Tooltip: wer überspringt, soll wissen, dass es keine Sterne gibt.
    const skip = this.btn(h('span', '', 'Stufe überspringen ', h('small', 'vel-dim', '· zählt nicht')), '', () => this.emit('skipStage', undefined));
    skip.dataset.lock = '1';
    skip.title = 'Zählt nicht für die Sterne.';
    const restart = this.btn('Lektion neu', '', () => this.emit('restart', undefined), 'R');
    restart.dataset.lock = '1';
    const result = L.done ? this.btn('Ergebnis ansehen', '', () => L.showResult()) : null;
    return h(
      'section',
      'vel-screen vel-pause-screen vel-lesson-pause',
      h('h1', 'vel-h1', 'Pause'),
      h('p', 'vel-lesson-where', h('span', 'vel-dim', `${L.name} · ${L.stageLabel}`), h('strong', '', L.stageTitle)),
      h(
        'div',
        'vel-panel vel-col',
        resume,
        demo,
        again,
        skip,
        restart,
        result,
        this.btn('Einstellungen', '', () => this.showSettings()),
        this.btn('Trainingsübersicht', '', () => this.emit('toTitle', undefined)),
      ),
      this.lockHint('Die Maus ist frei. Klick auf „Weiter“, um zurück ins Spiel zu kommen.'),
    );
  }

  // ------------------------------------------------------------------ Pause

  private buildPause(): HTMLElement {
    const resume = this.btn(h('span', 'vel-resume-label', 'Weiter'), 'vel-btn--primary', () => this.emit('resume', undefined), 'Enter');
    resume.dataset.lock = '1';
    const restart = this.btn('Neustart', '', () => this.emit('restart', undefined), 'R');
    restart.dataset.lock = '1';
    const screen = h(
      'section',
      'vel-screen vel-pause-screen',
      h('h1', 'vel-h1', 'Pause'),
      h(
        'div',
        'vel-panel vel-col',
        resume,
        restart,
        this.btn('Einstellungen', '', () => this.showSettings()),
        this.btn('Steuerung', '', () => this.showControls()),
        this.btn('Levelauswahl', '', () => this.emit('toTitle', undefined)),
      ),
      this.lockHint('Die Maus ist frei. Klick auf „Weiter“, um zurück ins Spiel zu kommen.'),
    );
    return screen;
  }

  // ------------------------------------------------------------------ Ergebnis

  private buildFinish(r: FinishResult): HTMLElement {
    const stats = h('div', 'vel-stats');
    const bestNow = r.isBest ? r.time : r.previousBest;
    const bestDiff = r.previousBest !== null ? r.time - r.previousBest : null;
    stats.append(
      stat(
        'Bestzeit',
        bestNow !== null ? formatTime(bestNow) : '-',
        bestDiff !== null ? diffEl(bestDiff, r.isBest ? 'vorher ' + formatTime(r.previousBest ?? 0) : null) : null,
      ),
    );
    if (r.parTime !== null) {
      const d = r.time - r.parTime;
      stats.append(stat('Par', formatTime(r.parTime), h('span', d <= 0 ? 'vel-good' : 'vel-bad', d <= 0 ? 'unter Par!' : htmlDiff(d))));
    }
    if (r.topSpeed !== undefined) stats.append(stat('Top-Speed', `${Math.round(r.topSpeed)} u/s`, null));
    if (r.medals) {
      // Medaille dieses Laufs und das nächste Ziel mit dem Abstand, der noch fehlt.
      const got = medalFor(r.time, r.medals);
      const next = nextMedal(r.time, r.medals);
      const value = h('div', `vel-stat-value vel-medal vel-medal--${got ?? 'none'}`, got !== null ? MEDAL_NAMES[got] : '—');
      // Entwickler-Zeit als Referenz — keine Medaille, aber die Zahl, die man schlagen will.
      const dev = r.time <= r.medals.author ? h('div', 'vel-hint vel-good', `Entwickler-Zeit ${formatSecs(r.medals.author)} geschlagen!`) : null;
      const box = h('div', 'vel-stat vel-medal-stat', h('div', 'vel-stat-label', 'Medaille'), value);
      box.append(
        h(
          'div',
          'vel-hint',
          next !== null
            ? h('span', '', `Nächstes Ziel: ${MEDAL_NAMES[next.id]} ${formatSecs(next.limit)} `, h('span', 'vel-bad', `(noch ${gapSecs(r.time - next.limit)} s)`))
            : h('span', 'vel-good', 'Alle Medaillen!'),
        ),
      );
      if (dev) box.append(dev);
      stats.append(box);
    }

    let splits: HTMLElement | null = null;
    if (r.splits.length > 0) {
      const body = h('tbody', '');
      r.splits.forEach((t, i) => {
        const ref = r.bestSplits?.[i];
        const d = ref !== undefined ? t - ref : null;
        body.append(
          h(
            'tr',
            '',
            h('td', '', `CP ${i + 1}`),
            h('td', '', formatTime(t)),
            h('td', d === null ? 'vel-dim' : d < 0 ? 'vel-good' : d > 0 ? 'vel-bad' : '', d === null ? '-' : htmlDiff(d)),
          ),
        );
      });
      splits = h(
        'div',
        'vel-panel',
        h('h2', 'vel-h2', 'Zwischenzeiten'),
        h('table', 'vel-splits', h('thead', '', h('tr', '', h('th', '', 'Checkpoint'), h('th', '', 'Zeit'), h('th', '', 'Diff'))), body),
      );
    }

    // Letztes Level: "Nochmal" ist das Ziel (Primärknopf, Enter) statt eines ausgegrauten "Nächstes Level".
    const next = r.hasNext ? this.btn('Nächstes Level', 'vel-btn--primary', () => this.emit('nextLevel', undefined), 'Enter') : null;
    if (next) next.dataset.lock = '1';
    const again = r.hasNext
      ? this.btn('Nochmal', '', () => this.emit('restart', undefined), 'R')
      : this.btn('Nochmal', 'vel-btn--primary vel-again', () => this.emit('restart', undefined), 'Enter');
    again.dataset.lock = '1';

    return h(
      'section',
      (r.unlocked ?? []).length > 0 ? 'vel-screen vel-finish-screen vel-finish-screen--unlock' : 'vel-screen vel-finish-screen',
      h('h1', 'vel-h1', 'Ziel', h('span', 'vel-dim', `· ${r.levelName}`)),
      h('p', 'vel-finish-time', formatTime(r.time)),
      r.isBest ? h('div', 'vel-record', 'NEUE BESTZEIT!') : null,
      this.unlockBanner(r.unlocked ?? []),
      stats,
      splits,
      h(
        'div',
        'vel-row',
        again,
        next,
        this.btn('Menü', '', () => this.emit('toTitle', undefined), 'Esc'),
      ),
    );
  }

  // ------------------------------------------------------------------ Kosmetik

  private stopPreview(): void {
    this.previewStop?.();
    this.previewStop = null;
  }

  /** Effektive Wahl (gesperrt → Standard), wie Game.applyCosmetics. */
  private effectiveCosmetics(s: GameSettings): { glove: GloveId; item: HeldItemId } {
    const g = gloveUnlock(s.glove);
    const i = itemUnlock(s.heldItem);
    return {
      glove: g === null || this.unlocks.has(g) ? s.glove : 'classic',
      item: i === null || this.unlocks.has(i) ? s.heldItem : 'none',
    };
  }

  /** Bedingung einer Freischaltung als Satz: "VELOCITY-Medaille in 02 SCHLEIFE (16.70 s)" (+ weitere). */
  private unlockCondition(id: UnlockId): string {
    return unlockDef(id)
      .requires.map((r) => {
        if (r.kind === 'training') {
          const what = r.group === 'basics' ? 'Training Grundlagen' : 'Training komplett';
          return r.minStars >= 3 ? `${what} mit ★★★` : `${what} bestanden`;
        }
        const lv = this.levels.find((l) => l.id === r.levelId);
        const limit = lv?.medals ? ` (${formatSecs(lv.medals[r.medal])} s)` : '';
        return `${MEDAL_NAMES[r.medal]}-Medaille in ${lv?.name ?? r.levelId}${limit}`;
      })
      .join(' + ');
  }

  /**
   * Bedingung kompakt für Kacheln und Admin (Plan 007 K6): Medaille in ihrer Farbe, Level als Kürzel
   * ("SILBER · L1", "GOLD in L1–L4"), Training mit Stern; Sammelziele (mehrere Bedingungen) mit
   * Fortschritt "2/4". Der ganze Satz steht im Tooltip (unlockCondition).
   */
  private unlockCompact(id: UnlockId): { readonly el: HTMLElement; readonly progress: string | null } {
    const reqs = unlockDef(id).requires;
    const el = h('span', 'vel-cond');
    const groups = new Map<MedalId, string[]>();
    for (const r of reqs) {
      if (r.kind === 'training') {
        if (el.childNodes.length > 0) el.append(' + ');
        el.append(h('span', 'vel-cond-training', r.group === 'basics' ? 'TRAINING Grundlagen' : 'TRAINING komplett'), r.minStars >= 3 ? ' ★★★' : ' ★');
        continue;
      }
      const list = groups.get(r.medal) ?? [];
      list.push(r.levelId);
      groups.set(r.medal, list);
    }
    for (const [medal, ids] of groups) {
      if (el.childNodes.length > 0) el.append(' + ');
      el.append(h('span', `vel-medal vel-medal--${medal}`, MEDAL_NAMES[medal]), ` ${ids.length === 1 ? '·' : 'in'} `, h('span', 'vel-cond-levels', levelRange(ids)));
    }
    const best = (levelId: string): number | null => this.best.get(levelId);
    const progress = reqs.length > 1 ? `${reqs.filter((r) => requirementMet(r, this.levels, best)).length}/${reqs.length}` : null;
    return { el, progress };
  }

  private buildCosmetics(): HTMLElement {
    this.refreshers = [];
    const canvas = h('canvas', 'vel-hand-preview');
    const tier = h('div', 'vel-preview-tier', '');
    this.previewStart = () => this.startPreview(canvas, tier, () => this.effectiveCosmetics(this.settings.get()));

    /** Eine Kachel: Name, Schloss + Bedingung (Medaillenfarbe) + Fortschritt, "in Arbeit" ohne Umsetzung. */
    const tile = <T extends string>(label: string, value: T, lock: UnlockId | null, ready: boolean, get: (s: GameSettings) => T, set: (v: T) => SettingsPatch): HTMLElement => {
      const locked = lock !== null && !this.unlocks.has(lock);
      const cond = locked && lock !== null ? this.unlockCompact(lock) : null;
      const b = h(
        'button',
        `vel-btn vel-cosm${locked ? ' is-locked' : ''}${ready ? '' : ' is-pending'}`,
        // Schloss vor der Bedingung, nicht vor dem Namen: im 5er-Raster bekäme der Name sonst zu wenig
        // Breite und bräche mitten im Wort (STURMFEU-ERZEUG).
        h('span', 'vel-cosm-name', label),
        cond ? h('span', 'vel-cosm-cond', h('span', 'vel-lock', ''), cond.el) : null,
        cond?.progress ? h('span', 'vel-cosm-progress', cond.progress) : null,
        !locked && !ready ? h('span', 'vel-cosm-pending', 'in Arbeit') : null,
      );
      b.type = 'button';
      b.dataset.cosmetic = value;
      if (locked && lock !== null) {
        b.setAttribute('aria-disabled', 'true');
        b.title = `Gesperrt: ${this.unlockCondition(lock)}`;
      } else if (!ready) {
        // Freigeschaltet (z. B. per Admin), aber Hand/Renderer kennen den Gegenstand noch nicht (Plan 007 Phase 2).
        b.setAttribute('aria-disabled', 'true');
        b.title = 'Kommt mit dem nächsten Update';
      } else b.addEventListener('click', () => this.settings.update(set(value)));
      // Markiert ist die WIRKSAME Wahl: zeigt die gespeicherte auf etwas Gesperrtes, ist Standard/Nichts aktiv.
      const refresh = (s: GameSettings): void => {
        const eff = this.effectiveCosmetics(s);
        b.setAttribute('aria-pressed', String(!locked && ready && get({ ...s, glove: eff.glove, heldItem: eff.item }) === value));
      };
      refresh(this.settings.get());
      this.refreshers.push(refresh);
      return b;
    };

    // Reihenfolge: Standard/Nichts zuerst, dann die Freischalt-Leiter (UNLOCKS, Plan 007 §7).
    const byLadder = (id: UnlockId | null): number => (id === null ? -1 : UNLOCKS.findIndex((u) => u.id === id));
    const nameOf = (id: UnlockId | null, fallback: string): string => (id === null ? fallback : unlockDef(id).name);
    const gloveIds = [...GLOVE_IDS].sort((a, b) => byLadder(gloveUnlock(a)) - byLadder(gloveUnlock(b)));
    const itemIds = [...HELD_ITEM_IDS].sort((a, b) => byLadder(itemUnlock(a)) - byLadder(itemUnlock(b)));
    const gloves = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Hand'),
      h(
        'div',
        'vel-cosm-tiles vel-cosm-tiles--hand',
        ...gloveIds.map((g) => tile<GloveId>(nameOf(gloveUnlock(g), 'Standard'), g, gloveUnlock(g), hasSkin(g), (s) => s.glove, (v) => ({ glove: v }))),
      ),
    );
    const items = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'In der Hand'),
      h(
        'div',
        'vel-cosm-tiles vel-cosm-tiles--item',
        ...itemIds.map((i) => tile<HeldItemId>(nameOf(itemUnlock(i), 'Nichts'), i, itemUnlock(i), i === 'none' || (hasItemView(i) && hasPropTricks(i)), (s) => s.heldItem, (v) => ({ heldItem: v }))),
      ),
      h('p', 'vel-hint', 'Mit einem Gegenstand macht die Hand Tricks — je schneller du bist, desto wilder. Bewegungs-Feedback 0 % = sie hält still.'),
    );
    const preview = h('div', 'vel-panel vel-preview', h('h2', 'vel-h2', 'Vorschau'), canvas, tier);
    return h(
      'section',
      'vel-screen vel-cosmetics-screen',
      h('div', 'vel-head-row', h('h1', 'vel-h1', 'Kosmetik'), h('div', 'vel-row', this.btn('Zurück', 'vel-btn--small', () => this.showTitle(), 'Esc'))),
      h('div', 'vel-cosm-grid', h('div', 'vel-col', gloves, items), preview),
      h('p', 'vel-hint', 'Freigeschaltet wird über Medaillen und das Training — Sammelziele zeigen, wie weit du bist.'),
    );
  }

  // ------------------------------------------------------------------ Admin

  private leaveAdmin(): void {
    if (this.adminReturn === 'pause') this.showPause(this.lessonPause);
    else this.showTitle();
  }

  /**
   * Admin-Menü: Freischaltungen einzeln/alle setzen, Medaille je Level setzen (schreibt eine
   * passende Bestzeit), Bestzeit samt Ghost löschen. Alles wirkt wie echt erspielt.
   * Menü-Code, kein Frame-Pfad: Closures und Neuaufbau sind hier unkritisch.
   */
  private buildAdmin(): HTMLElement {
    this.refreshers = [];
    const refreshers: (() => void)[] = [];
    const refreshAll = (): void => {
      for (const r of refreshers) r();
    };
    this.adminRefresh = refreshAll;
    const bestFn = (id: string): number | null => this.best.get(id);

    // --- Freischaltungen
    const unlockRows = UNLOCKS.map((u) => {
      const b = h('button', 'vel-btn vel-toggle');
      b.type = 'button';
      b.dataset.unlock = u.id;
      b.addEventListener('click', () => this.unlocks.set(u.id, !this.unlocks.has(u.id)));
      const state = h('span', 'vel-admin-state', '');
      refreshers.push(() => {
        const on = this.unlocks.has(u.id);
        b.setAttribute('aria-pressed', String(on));
        b.textContent = on ? 'An' : 'Aus';
        state.textContent = on ? 'frei' : this.unlocks.isLocked(u.id) ? 'von Hand gesperrt' : 'gesperrt';
      });
      const cond = this.unlockCompact(u.id);
      const small = h('small', 'vel-admin-cond', cond.el, cond.progress ? h('span', 'vel-cosm-progress', cond.progress) : null);
      small.title = this.unlockCondition(u.id);
      return h('div', 'vel-admin-row', h('span', 'vel-admin-name', u.name, small), state, b);
    });
    const unlockPanel = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Freischaltungen'),
      h(
        'div',
        'vel-row vel-admin-actions',
        this.btn('Alles freischalten', 'vel-btn--small', () => this.unlocks.unlockAll()),
        this.btn('Alles sperren', 'vel-btn--small', () => this.unlocks.reset()),
      ),
      ...unlockRows,
    );

    // --- Medaillen je Level
    const levelRows = this.levels.map((lv) => {
      const time = h('span', 'vel-admin-time', '');
      const del = this.btn('Bestzeit löschen', 'vel-btn--small vel-admin-del', () => {
        this.best.clear(lv.id);
        this.emit('adminBest', { levelId: lv.id });
        refreshAll();
      });
      const medals = lv.medals;
      let seg: HTMLElement = h('div', 'vel-hint', 'Keine Medaillen in diesem Level.');
      if (medals) {
        // Schlechteste zuerst, wie man sie erspielt: keine → Bronze → … → VELOCITY.
        const opts: readonly (MedalId | null)[] = [null, ...[...MEDAL_ORDER].reverse()];
        const wrap = h('div', 'vel-seg vel-admin-seg');
        const buttons = opts.map((m) => {
          const b = h('button', `vel-btn vel-admin-medal vel-admin-medal--${m ?? 'none'}`, m === null ? 'keine' : MEDAL_NAMES[m]);
          b.type = 'button';
          b.dataset.medal = m ?? 'none';
          b.addEventListener('click', () => {
            this.best.set(lv.id, adminTimeFor(m, medals));
            // Verdientes dieses Levels sofort frei — auch wenn es vorher von Hand gesperrt war.
            this.unlocks.grantEarnedFor(lv.id, this.levels, bestFn);
            this.emit('adminBest', { levelId: lv.id });
            refreshAll();
          });
          wrap.append(b);
          return b;
        });
        refreshers.push(() => {
          const t = this.best.get(lv.id);
          const got = medalFor(t, medals);
          opts.forEach((m, i) => buttons[i].setAttribute('aria-pressed', String(t !== null && m === got)));
        });
        seg = wrap;
      }
      refreshers.push(() => {
        const t = this.best.get(lv.id);
        time.textContent = t !== null ? formatTime(t) : '--:--.--';
        del.disabled = t === null;
      });
      return h(
        'div',
        'vel-admin-level',
        h('div', 'vel-admin-level-head', h('span', 'vel-admin-name', lv.name), h('span', 'vel-admin-best', h('small', '', 'Bestzeit '), time)),
        h('div', 'vel-admin-level-ctl', seg, del),
      );
    });
    const levelPanel = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Medaillen'),
      levelRows.length > 0 ? null : h('div', 'vel-hint', 'Level werden geladen …'),
      ...levelRows,
      h('p', 'vel-hint', 'Medaille setzen schreibt eine Bestzeit knapp unter der Grenze. „Bestzeit löschen“ entfernt auch den Ghost.'),
    );

    // --- Training (Plan 007): Lektion abhaken/zurücksetzen; Abhaken schaltet über die Ableitung frei.
    const t = this.training;
    const lessonRows = (t ? t.lessons() : []).map((lv) => {
      const stars = h('span', 'vel-admin-time vel-stars', '');
      const done = this.btn('Abhaken', 'vel-btn--small', () => {
        if (!t || !t.complete(lv.id)) {
          stars.textContent = 'nicht geladen';
          return;
        }
        this.grantTraining();
        refreshAll();
      });
      done.dataset.lesson = lv.id;
      const reset = this.btn('Zurücksetzen', 'vel-btn--small', () => {
        t?.reset(lv.id);
        refreshAll();
      });
      refreshers.push(() => {
        const n = t ? t.stars(lv.id) : 0;
        stars.textContent = starText(n);
        stars.className = `vel-admin-time vel-stars vel-stars--${n}`;
        reset.disabled = n === 0;
      });
      return h(
        'div',
        'vel-admin-level vel-admin-lesson',
        h('div', 'vel-admin-level-head', h('span', 'vel-admin-name', `${lv.short} ${lessonName(lv)}`), stars),
        h('div', 'vel-admin-level-ctl', h('div', 'vel-row', done, reset)),
      );
    });
    const trainingPanel = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Training'),
      lessonRows.length > 0 ? null : h('div', 'vel-hint', t ? 'Keine Lektionen gefunden.' : 'Lektionen werden geladen …'),
      ...lessonRows,
      h('p', 'vel-hint', 'Abhaken = alle Stufen (★★★). Freischaltungen aus dem Training (Spinner, Roboter) folgen sofort.'),
    );

    refreshAll();
    return h(
      'section',
      'vel-screen vel-admin-screen',
      h('div', 'vel-head-row', h('h1', 'vel-h1', 'Admin'), h('div', 'vel-row', this.btn('Zurück', 'vel-btn--small', () => this.leaveAdmin(), 'Esc'))),
      h('p', 'vel-hint vel-admin-note', 'Admin-Freischaltungen gelten wie echte.'),
      h('div', 'vel-admin-grid', unlockPanel, h('div', 'vel-col', levelPanel, trainingPanel)),
    );
  }

  /**
   * Admin hat Training abgehakt: alles, was laut Ableitung (deriveUnlocks mit Trainings-Fortschritt)
   * am Training hängt und jetzt erfüllt ist, freischalten — auch vor Phase 3 (PENDING_UNLOCKS gilt
   * nur für die automatische Ableitung; Admin darf alles, wie "Alles freischalten").
   */
  private grantTraining(): void {
    const t = this.training;
    if (!t) return;
    const best = (id: string): number | null => this.best.get(id);
    for (const id of deriveUnlocks(this.levels, best, t)) {
      if (!unlockDef(id).requires.some((r) => r.kind === 'training')) continue;
      if (!this.unlocks.has(id)) this.unlocks.set(id, true);
    }
  }

  /**
   * Live-Vorschau: eigener kleiner WebGL-Kontext (ViewModelPreview) mit derselben 3D-Hand,
   * Kontur und Quantisierung wie im Spiel, per CSS ganzzahlig hochskaliert. Ein Demo-Ablauf
   * spielt die Tempostufen durch, damit man die Tricks sieht: Stand → Lauf → Flow → Overdrive.
   * Menü-Code: hier darf allokiert werden (Events), der Spiel-Frame läuft pausiert.
   * Der Kontext wird beim Verlassen sofort freigegeben (Browser erlauben nur wenige).
   */
  private startPreview(canvas: HTMLCanvasElement, label: HTMLElement, get: () => { glove: GloveId; item: HeldItemId }, compact = false): () => void {
    // Kompakt (Ergebnis-Banner): kleineres Raster, nur Stand.
    const W = compact ? 96 : 150;
    const H = compact ? 80 : 176;
    let preview: ViewModelPreview;
    try {
      preview = new ViewModelPreview(canvas, W, H);
    } catch {
      // Kein WebGL-Kontext mehr frei: Vorschau fehlt, Menü geht trotzdem.
      label.textContent = '';
      return () => undefined;
    }
    preview.vm.depth = compact ? 27 : 25;
    const hand = new ViewHand();
    hand.setAspect(W / H);
    hand.anchorRight = 0.3;
    hand.anchorBottom = compact ? 0.36 : 0.33;
    const inp = makeHandInput();
    // Plan 007: zusätzlich Surf (Surf-Zustände der Gegenstände) und Checkpoint (vorn, dann zurück).
    const all: readonly { readonly name: string; readonly speed: number; readonly jumpEvery: number; readonly surf?: boolean; readonly checkpoint?: boolean }[] = [
      { name: 'Stand', speed: 0, jumpEvery: 0 },
      { name: 'Lauf · 420 u/s', speed: 420, jumpEvery: 1.5 },
      { name: 'Flow · 650 u/s', speed: 650, jumpEvery: 1.2 },
      { name: 'Overdrive · 950 u/s', speed: 950, jumpEvery: 1.0 },
      { name: 'Surf · 800 u/s', speed: 800, jumpEvery: 0, surf: true },
      { name: 'Checkpoint', speed: 420, jumpEvery: 0, checkpoint: true },
    ];
    const phases = compact ? all.slice(0, 1) : all;
    const PHASE = 6;
    let t = 0;
    let phase = -1;
    let phaseStart = 0;
    let cps = 0;
    let nextJump = 0;
    let air = 0;
    let chain = 0;
    let last = performance.now();
    let raf = 0;
    let warmed = '';
    const emit = (e: GameEvent): void => hand.onEvent(e);
    const frame = (now: number): void => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const c = get();
      hand.setGlove(c.glove);
      hand.setItem(c.item);
      if (warmed !== `${c.item}/${c.glove}`) {
        warmed = `${c.item}/${c.glove}`;
        preview.prewarm(c.item, c.glove);
      }
      hand.motionFx = this.settings.get().motionFx;
      t += dt;
      const p = Math.floor(t / PHASE) % phases.length;
      const ph = phases[p];
      if (p !== phase) {
        if (phase >= 0 && phases[phase].surf) emit({ type: 'surfEnd' });
        phase = p;
        phaseStart = t;
        cps = 0;
        nextJump = t + 0.6;
        chain = 0;
        label.textContent = ph.name;
        if (ph.surf) emit({ type: 'surfStart' });
      }
      // Checkpoint-Phase: erst vor der Bestzeit (−0.30), dann dahinter (+0.40).
      if (ph.checkpoint && cps < 2 && t - phaseStart >= (cps === 0 ? 0.8 : 3.4)) {
        emit({ type: 'checkpoint', index: cps + 1, total: 3, time: 10 + cps * 6, split: cps === 0 ? -0.3 : 0.4 });
        label.textContent = cps === 0 ? 'Checkpoint · vorn' : 'Checkpoint · zurück';
        cps++;
      }
      if (ph.jumpEvery > 0 && t >= nextJump && air <= 0) {
        chain++;
        emit({ type: 'jump', speed: ph.speed, gain: 8, perfect: chain > 1, clean: chain > 1, chain, sync: 0.9, crouched: false, coyote: false });
        air = 0.62;
        nextJump = t + ph.jumpEvery;
      }
      const wasAir = air > 0;
      air = Math.max(0, air - dt);
      if (wasAir && air <= 0) emit({ type: 'land', impact: 300, speed: ph.speed, airTime: 0.62, jumpQueued: true });
      inp.speed = ph.speed;
      inp.onGround = air <= 0 && !ph.surf;
      inp.surfing = ph.surf === true;
      inp.airTime = ph.surf ? 0 : 0.62 - air;
      inp.stridePhase = (t * 1.6) % 1;
      inp.yawDelta = 0;
      inp.pitchDelta = 0;
      inp.side = 0;
      inp.surfSide = ph.surf ? 0.6 * Math.sin(t * 1.3) : 0;
      hand.update(dt, inp);
      // Synthetischer Takt (132 BPM) für Skin-Effekte im Takt (Roboter-LED) — im Spiel kommt er aus der Musik.
      const kick = Math.exp(-((t * 132) / 60 - Math.floor((t * 132) / 60)) * 7);
      preview.render(hand.output(true), t, kick);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      preview.dispose();
    };
  }

  /** Ergebnis: neue Freischaltungen groß, mit Live-Hand. */
  private unlockBanner(names: readonly string[]): HTMLElement | null {
    if (names.length === 0) return null;
    const canvas = h('canvas', 'vel-hand-preview vel-hand-preview--small');
    const tier = h('div', 'vel-preview-tier', '');
    this.previewStart = () => this.startPreview(canvas, tier, () => this.effectiveCosmetics(this.settings.get()), true);
    return h(
      'div',
      'vel-unlock',
      h(
        'div',
        'vel-unlock-text',
        h('div', 'vel-unlock-label', 'Freigeschaltet'),
        ...names.map((n) => h('div', 'vel-unlock-name', n)),
        h('p', 'vel-hint', 'Schon angelegt. Ändern im Titel unter „Kosmetik“.'),
      ),
      h('div', 'vel-unlock-preview', canvas),
    );
  }

  // ------------------------------------------------------------------ Steuerung

  private buildControls(): HTMLElement {
    const s = this.settings.get();
    const b = s.keybinds;
    const labels = (codes: readonly string[]): string[] => codes.map(keyLabel);
    const raw = this.rawStatus();
    const look =
      raw === 'active'
        ? 'Blick (roh, ohne Beschleunigung)'
        : raw === 'unavailable'
          ? 'Blick — der Browser liefert keine Rohdaten: Zeigerbeschleunigung im System ausschalten'
          : 'Blick (Rohdaten werden beim Start geprüft)';
    const keys: [string[], Child | readonly Child[]][] = [
      [['W', 'A', 'S', 'D'], 'Laufen und Strafen'],
      [['Maus'], look],
      [[...labels(b.jump), 'Mausrad'], 'Springen — Mausrad in beide Richtungen, Taste halten = Auto-Hop'],
      [labels(b.sprint), s.autoSprint ? 'Langsamer laufen (Auto-Sprint: sonst immer volles Tempo)' : 'Sprint am Boden'],
      [labels(b.crouch), 'Ducken — in der Luft geduckt = 18 u höhere Kanten'],
      [['R'], 'Neustart (im Training: Lektion neu)'],
      [['F'], ['Zurück zum letzten ', mono('CP'), ' (Timer läuft weiter; im Training: Start der Stufe)']],
      [labels(b.demo), 'Training: Vorführung der Stufe — jede Taste übernimmt wieder'],
      [['Esc'], 'Pause'],
      [['F1'], 'Tuning-Panel (Movement live einstellen)'],
      [['M'], 'Ton an/aus'],
    ];
    const dl = h('dl', 'vel-keys');
    for (const [ks, what] of keys) {
      dl.append(h('dt', '', ...ks.map((k) => h('span', 'vel-kbd', k))), h('dd', 'vel-text', ...(Array.isArray(what) ? what : [what])));
    }
    return h(
      'section',
      'vel-screen',
      h('h1', 'vel-h1', 'Steuerung'),
      h(
        'div',
        'vel-title-grid',
        h(
          'div',
          'vel-panel',
          h('h2', 'vel-h2', 'Tasten'),
          dl,
          h(
            'p',
            'vel-hint',
            mono('Strg'),
            ' zählt nur im Vollbild — sonst macht ',
            mono('Strg'),
            '+',
            mono('W'),
            ' den Tab zu. „Vollbild beim Start“ (Einstellungen) erledigt das. Belegung: Einstellungen → Tasten.',
          ),
        ),
        h(
          'div',
          'vel-col',
          h(
            'div',
            'vel-panel vel-howto',
            h('h2', 'vel-h2', 'So geht Air-Strafing'),
            h('p', '', 'In der Luft W loslassen, A oder D halten und die Maus flüssig in dieselbe Richtung ziehen — jede saubere Kurve macht dich schneller.'),
            h('p', '', 'Am Scheitel der Kurve die Seite wechseln (A ↔ D), synchron bleiben und bei der Landung sofort wieder abspringen, dann bleibt der Speed erhalten.'),
            h('p', '', 'Crouch-Jump: springen und in der Luft ducken — die Füße gehen 18 u hoch, so kommst du auf Kanten, die ein normaler Sprung nicht schafft.'),
            h('p', 'vel-hint', 'Unten links zeigen die Tasten, ob es sitzt: A/D grün = passt zur Maus, rot = gegen die Maus.'),
          ),
          h(
            'div',
            'vel-panel vel-howto',
            h('h2', 'vel-h2', 'So geht Surfen'),
            h('p', '', 'Auf der schrägen Rampe W loslassen — W schiebt dich dort nur nach unten.'),
            h('p', '', 'Die Taste zur Rampe hin halten (Rampe links: A, rechts: D), dann trägt sie dich, statt dass du abrutschst.'),
            h('p', '', 'Mit der Maus entlang der Rampe schauen und der Kurve sanft folgen — so wirst du auf der Rampe schneller.'),
          ),
        ),
      ),
      h('div', 'vel-row', this.btn('Zurück', '', () => this.back(), 'Esc')),
    );
  }

  // ------------------------------------------------------------------ Einstellungen

  private buildSettings(): HTMLElement {
    this.refreshers = [];
    const s = this.settings.get();

    const countsPer360 = h('b', '', '');
    const mouse = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Maus und Sicht'),
      this.slider({
        label: 'Empfindlichkeit',
        min: 0.1,
        max: 10,
        step: 0.01,
        get: (v) => v.sensitivity,
        set: (v) => ({ sensitivity: v }),
        fmt: (v) => v.toFixed(2),
        numberInput: true,
      }),
      h('div', 'vel-setting-hint', mono('CS-Sens 1:1'), ' — gleiche Formel wie ', mono('CS2'), '. 360° = ', countsPer360),
      this.rawHint(),
      this.toggle('Y invertieren', (v) => v.invertY, (v) => ({ invertY: v })),
      this.slider({
        label: 'Sichtfeld (FOV)',
        min: 70,
        max: 120,
        step: 1,
        get: (v) => v.fov,
        set: (v) => ({ fov: v }),
        fmt: (v) => `${Math.round(v)}°`,
      }),
      h('div', 'vel-setting-hint', '90° wie in ', mono('CS'), ' (horizontal bei 4:3).'),
    );
    const updateCounts = (v: GameSettings): void => {
      countsPer360.textContent = `${Math.round(360 / (v.sensitivity * v.mYaw))} Counts`;
    };
    updateCounts(s);
    this.refreshers.push(updateCounts);

    const movement = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Movement'),
      this.toggle('Auto-Hop', (v) => v.autoHop, (v) => ({ autoHop: v })),
      h('div', 'vel-setting-hint', 'Sprungtaste halten = bei jeder Landung perfekt weiter.'),
      this.toggle('Auto-Sprint', (v) => v.autoSprint, (v) => ({ autoSprint: v })),
      h('div', 'vel-setting-hint', 'Am Boden immer volles Tempo (320). ', mono('Shift'), ' = langsamer (250). Aus: ', mono('Shift'), ' halten = Sprint.'),
      this.toggle('Strafe-Assist', (v) => v.strafeAssist, (v) => ({ strafeAssist: v })),
      h('div', 'vel-setting-hint', mono('W'), ' zählt in der Luft nicht, solange ', mono('A'), '/', mono('D'), ' gehalten wird — für Half-Sideways ausschalten.'),
      this.toggle('Luftlenkung mit W', (v) => v.airControl, (v) => ({ airControl: v })),
      h('div', 'vel-setting-hint', 'Nur ', mono('W'), ' in der Luft dreht den Flug sanft zur Blickrichtung, ohne Tempo zu gewinnen. Beschleunigen bleibt ', mono('A'), '/', mono('D'), ' + Maus.'),
      this.segmented<MovementPresetId>(
        'Preset',
        [
          { value: 'velocity', label: 'Velocity' },
          { value: 'cs2', label: 'CS2 Klassik' },
        ],
        (v) => v.movementPreset,
        // Strafe-Assist und Luftlenkung folgen dem Preset (CS2: aus) — die Regel lebt in SettingsStore.update,
        // damit Menü und F1-Panel gleich handeln. Danach frei umschaltbar.
        (v) => ({ movementPreset: v }),
      ),
      h('div', 'vel-setting-hint', mono('CS2'), ': 64 Tick, airaccelerate 12, kein Puffer, Strafe-Assist und Luftlenkung aus — viel härter.'),
    );

    const audio = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Audio'),
      this.percent('Gesamt', (v) => v.masterVolume, (v) => ({ masterVolume: v })),
      this.percent('Musik', (v) => v.musicVolume, (v) => ({ musicVolume: v })),
      this.percent('Effekte', (v) => v.sfxVolume, (v) => ({ sfxVolume: v })),
    );

    const camera = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Kamera und HUD'),
      this.percent('Head-Bob', (v) => v.headBob, (v) => ({ headBob: v })),
      h('div', 'vel-setting-hint', 'Nur das Wippen beim Laufen.'),
      this.percent('Bewegungs-Feedback', (v) => v.motionFx, (v) => ({ motionFx: v })),
      h('div', 'vel-setting-hint', 'Landung, Hop-Pop, Luft-Roll, Surf-Neigung — das Gefühl in der Luft.'),
      this.percent('Screenshake', (v) => v.screenShake, (v) => ({ screenShake: v })),
      this.percent('FOV-Kick', (v) => v.fovKick, (v) => ({ fovKick: v })),
      this.toggle('Speedometer', (v) => v.showSpeedometer, (v) => ({ showSpeedometer: v })),
      this.toggle('Tasten anzeigen', (v) => v.showKeys, (v) => ({ showKeys: v })),
      h('div', 'vel-setting-hint', 'Unten links: gedrückte Tasten, Mausdrehung, ', mono('A'), '/', mono('D'), ' grün = passt zur Maus.'),
      this.toggle('Hand anzeigen', (v) => v.showHand, (v) => ({ showHand: v })),
      h('div', 'vel-setting-hint', 'Cartoon-Handschuh unten rechts. Schwingt mit dem Bewegungs-Feedback (0 % = steht still).'),
      this.toggle('Ghost der Bestzeit', (v) => v.ghost, (v) => ({ ghost: v })),
      h('div', 'vel-setting-hint', 'Dein bester Lauf fährt als Hologramm mit. Oben: Abstand an jedem ', mono('CP'), '.'),
      this.toggle('Hinweise', (v) => v.showHints, (v) => ({ showHints: v })),
      h('div', 'vel-setting-hint', 'Kurze Tipps im richtigen Moment (Ducken, Surfen, Strafen) — nur bis es einmal klappt.'),
    );

    const keys = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Tasten'),
      this.bindRow('jump', () => 'Springen'),
      this.bindRow('crouch', () => 'Ducken'),
      this.bindRow('sprint', (v) => (v.autoSprint ? 'Langsamer' : 'Sprint')),
      this.bindRow('demo', () => 'Vorführung'),
      h('div', 'vel-setting-hint', 'Feld anklicken, dann Taste oder Maustaste drücken. ', mono('Esc'), ' bricht ab, ', mono('Entf'), ' leert. Mausrad springt immer.'),
      this.toggle('Vollbild beim Start', (v) => v.fullscreenOnStart, (v) => ({ fullscreenOnStart: v })),
      h('div', 'vel-setting-hint', 'Mit Vollbild duckt ', mono('Strg'), ' sofort, und ', mono('Strg'), '+', mono('W'), ' schließt nicht den Tab.'),
    );

    const gfx = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Grafik'),
      this.segmented<number>(
        'Pixelauflösung',
        [240, 270, 360, 448].map((p) => ({ value: p, label: String(p) })),
        (v) => v.render.pixelHeight,
        (v) => ({ render: { pixelHeight: v } }),
      ),
      this.linesHint(),
      this.toggle('Dithering', (v) => v.render.dither, (v) => ({ render: { dither: v } })),
      this.percent('Textur-Warp', (v) => v.render.affine, (v) => ({ render: { affine: v } })),
      this.percent('Vertex-Snap', (v) => v.render.vertexSnap, (v) => ({ render: { vertexSnap: v } })),
      this.percent('Farbsaum', (v) => v.render.chromatic, (v) => ({ render: { chromatic: v } })),
      this.percent('Scanlines', (v) => v.render.scanlines, (v) => ({ render: { scanlines: v } })),
      this.percent('Speed-Streifen', (v) => v.render.speedLines ?? 1, (v) => ({ render: { speedLines: v } })),
      h('div', 'vel-setting-hint', 'Leuchtende Streifen am Bildrand ab ~380 u/s. 0 = aus.'),
      this.toggle('Niedrige Latenz', (v) => v.render.lowLatency ?? false, (v) => ({ render: { lowLatency: v } })),
      h('div', 'vel-setting-hint', 'Bild ohne Compositor-Umweg (kann reißen). Wirkt nach dem Neuladen der Seite.'),
    );

    return h(
      'section',
      'vel-screen vel-settings-screen',
      h(
        'div',
        'vel-head-row',
        h('h1', 'vel-h1', 'Einstellungen'),
        h(
          'div',
          'vel-row',
          this.btn('Standard', 'vel-btn--small', () => {
            this.settings.reset();
          }),
          this.btn('Zurück', 'vel-btn--small', () => this.back(), 'Esc'),
        ),
      ),
      h('div', 'vel-settings-grid', h('div', 'vel-col', mouse, movement, keys), h('div', 'vel-col', camera, audio, gfx)),
    );
  }

  /**
   * Echte Zeilenzahl zur Pixelhöhe: das Raster skaliert ganzzahlig, die Einstellung ist
   * eine Obergrenze (1080p: 270 → 270, 360 → 270). Neu bei jeder Änderung und beim Öffnen.
   */
  private linesHint(): HTMLElement {
    const real = h('b', '', '');
    const el = h('div', 'vel-setting-hint', 'Bildzeilen (Obergrenze). Jetzt echt: ', real, ' — ganzzahlig skaliert, 270 ist der PS2-Sweetspot.');
    const refresh = (s: GameSettings): void => {
      const n = effectiveLines(window.innerHeight, s.render.pixelHeight, window.devicePixelRatio || 1);
      real.textContent = `${n} Zeilen`;
      el.dataset.lines = String(n);
    };
    refresh(this.settings.get());
    this.refreshers.push(refresh);
    return el;
  }

  private slider(o: {
    label: string;
    min: number;
    max: number;
    step: number;
    get: (s: GameSettings) => number;
    set: (v: number) => SettingsPatch;
    fmt: (v: number) => string;
    /** Anzeige-Faktor (Prozent: 100). */
    factor?: number;
    numberInput?: boolean;
  }): HTMLElement {
    const f = o.factor ?? 1;
    const input = h('input', 'vel-range');
    input.type = 'range';
    input.min = String(o.min);
    input.max = String(o.max);
    input.step = String(o.step);
    input.setAttribute('aria-label', o.label);
    let valueEl: HTMLElement;
    let num: HTMLInputElement | null = null;
    if (o.numberInput) {
      num = h('input', 'vel-number');
      num.type = 'number';
      num.step = String(o.step);
      num.setAttribute('aria-label', `${o.label} (Zahl)`);
      valueEl = num;
    } else {
      valueEl = h('span', 'vel-setting-value');
    }
    const refresh = (s: GameSettings): void => {
      const v = o.get(s);
      const shown = v * f;
      input.value = String(shown);
      const fill = ((Math.min(o.max, Math.max(o.min, shown)) - o.min) / (o.max - o.min)) * 100;
      input.style.setProperty('--fill', `${fill}%`);
      if (num) {
        if (document.activeElement !== num) num.value = o.fmt(v);
      } else {
        valueEl.textContent = o.fmt(v);
      }
    };
    input.addEventListener('input', () => {
      const v = Number(input.value) / f;
      if (Number.isFinite(v)) this.settings.update(o.set(v));
    });
    if (num) {
      const n = num;
      // Zahlfeld erlaubt Werte außerhalb der Slider-Spanne (z. B. CS-Sens 0.05) — die Store-Validierung klemmt.
      n.addEventListener('change', () => {
        const v = Number(n.value.replace(',', '.'));
        if (Number.isFinite(v) && v > 0) this.settings.update(o.set(v));
        refresh(this.settings.get());
      });
    }
    refresh(this.settings.get());
    this.refreshers.push(refresh);
    return row(o.label, input, valueEl);
  }

  private percent(label: string, get: (s: GameSettings) => number, set: (v: number) => SettingsPatch): HTMLElement {
    return this.slider({ label, min: 0, max: 100, step: 1, get, set, fmt: PERCENT, factor: 100 });
  }

  private toggle(label: string, get: (s: GameSettings) => boolean, set: (v: boolean) => SettingsPatch): HTMLElement {
    const b = h('button', 'vel-btn vel-toggle');
    b.type = 'button';
    const refresh = (s: GameSettings): void => {
      const on = get(s);
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? 'An' : 'Aus';
    };
    b.addEventListener('click', () => this.settings.update(set(!get(this.settings.get()))));
    refresh(this.settings.get());
    this.refreshers.push(refresh);
    return row(label, b, null);
  }

  private segmented<T extends string | number>(
    label: string,
    options: readonly { readonly value: T; readonly label: string }[],
    get: (s: GameSettings) => T,
    set: (v: T) => SettingsPatch,
  ): HTMLElement {
    const wrap = h('div', 'vel-seg');
    const buttons = options.map((opt) => {
      const b = h('button', 'vel-btn', opt.label);
      b.type = 'button';
      b.addEventListener('click', () => this.settings.update(set(opt.value)));
      wrap.append(b);
      return b;
    });
    const refresh = (s: GameSettings): void => {
      const v = get(s);
      options.forEach((opt, i) => buttons[i].setAttribute('aria-pressed', String(opt.value === v)));
    };
    refresh(this.settings.get());
    this.refreshers.push(refresh);
    return row(label, wrap, null);
  }
}

// ------------------------------------------------------------------ DOM-Helfer

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

function row(label: string, control: HTMLElement, value: HTMLElement | null): HTMLElement {
  const r = h('div', 'vel-setting', h('span', 'vel-setting-label', label), control);
  if (value) r.append(value);
  else control.style.gridColumn = '2 / 4';
  return r;
}

/** Level-Kürzel für Kacheln: level3 → L3; eine lückenlose Folge ab 3 Leveln als "L1–L4", sonst "L1 + L2". */
function levelRange(ids: readonly string[]): string {
  const nums = ids.map((id) => {
    const m = /^level(\d+)$/.exec(id);
    return m ? Number(m[1]) : Number.NaN;
  });
  const shorts = ids.map((id, i) => (Number.isNaN(nums[i]) ? id : `L${nums[i]}`));
  const run = ids.length > 2 && nums.every((n, i) => !Number.isNaN(n) && (i === 0 || n === nums[i - 1] + 1));
  return run ? `${shorts[0]}–${shorts[shorts.length - 1]}` : shorts.join(' + ');
}

/** Medaille als kleines Abzeichen; VELOCITY schimmert (CSS), die Metalle sind flach. */
function medalBadge(m: MedalId): HTMLElement {
  return h('small', 'vel-medal vel-medal--' + m, MEDAL_NAMES[m]);
}

function stat(label: string, value: string, extra: Child): HTMLElement {
  return h('div', 'vel-stat', h('div', 'vel-stat-label', label), h('div', 'vel-stat-value', value), extra ? h('div', 'vel-hint', extra) : null);
}

function diffEl(d: number, prefix: string | null): HTMLElement {
  const cls = d < 0 ? 'vel-good' : d > 0 ? 'vel-bad' : '';
  return h('span', '', prefix ? `${prefix} ` : '', h('span', cls, htmlDiff(d)));
}

/** Medaillen-Grenze kurz: "24.50" unter einer Minute, sonst mm:ss.cc. */
function formatSecs(t: number): string {
  return t < 60 ? (Math.floor(t * 100 + 1e-6) / 100).toFixed(2) : formatTime(t);
}

/**
 * Fehlender Abstand zum nächsten Ziel, immer positiv ("noch 0.21 s"). Vorher stand dort
 * "(−0.21)" neben der Bestzeit-Zeile "+2.47" — beides hieß "zu langsam" (Prüfung 27.09.).
 */
function gapSecs(d: number): string {
  return (Math.ceil(Math.max(0, d) * 100 - 1e-6) / 100).toFixed(2);
}

/** Webfonts haben kein U+2212 — im HTML das normale Minus. */
function htmlDiff(d: number): string {
  return formatDiff(d).replace('\u2212', '-');
}

/** Browser-Fehler beim Pointer Lock → Satz für Spielerinnen (Rohtext steht im title-Attribut). */
function lockErrorText(err: string): string {
  if (/too many|NotAllowed/i.test(err)) return 'Der Browser verweigert die Maussteuerung gerade. Kurz warten, dann erneut klicken.';
  if (/WrongDocument|focus/i.test(err)) return 'Erst ins Fenster klicken, dann erneut versuchen.';
  return 'Die Maus konnte nicht gefangen werden. Bitte erneut klicken.';
}

/**
 * Level-Namen tragen ihre Nummer oft selbst ("01 GRUNDKURS") — die Liste zeigt die Nummer
 * schon in eigener Spalte, sonst stünde dort "01 01 GRUNDKURS".
 */
function listName(name: string): string {
  const stripped = name.replace(/^\d+\s+/, '');
  return stripped.length > 0 ? stripped : name;
}

/** Kürzel/Tasten im Fließtext: Silkscreen, weil Pixelify Sans' C wie ein O aussieht. */
function mono(text: string): HTMLElement {
  return h('span', 'vel-mono', text);
}

function isMenuEvent(k: string): k is keyof MenuEvents {
  return (
    k === 'play' ||
    k === 'resume' ||
    k === 'restart' ||
    k === 'toTitle' ||
    k === 'nextLevel' ||
    k === 'fullscreen' ||
    k === 'adminBest' ||
    k === 'demo' ||
    k === 'skipStage'
  );
}

/**
 * " (bald)", solange die Ableitung eine Freischaltung noch zurückhält (Unlocks.PENDING_UNLOCKS bis Phase 3) —
 * die Liste soll nichts versprechen, was ein bestandener Lauf heute nicht vergibt. Leert Phase 3 die Menge,
 * verschwindet der Zusatz von selbst.
 */
function soon(id: UnlockId): string {
  return PENDING_UNLOCKS.has(id) ? ' (bald)' : '';
}

/** Index der empfohlenen Lektion: die erste ohne Stern (−1 = alle bestanden oder keine). */
function recommendedIndex(t: TrainingProgressView): number {
  return t.lessons().findIndex((l) => t.stars(l.id) === 0);
}

/** "3/8" bestandene Lektionen (Titel-Knopf). */
function trainingCount(t: TrainingProgressView): string {
  const lessons = t.lessons();
  if (lessons.length === 0) return '';
  const passed = lessons.filter((l) => t.stars(l.id) > 0).length;
  return `${passed}/${lessons.length}`;
}

/** Lektionsname ohne vorangestelltes Kürzel ("T3 AIR-STRAFE" → "AIR-STRAFE"; die Liste zeigt es eigen). */
function lessonName(lv: TrainingIndexEntry): string {
  const n = lv.name.startsWith(lv.short) ? lv.name.slice(lv.short.length).replace(/^[\s·:.-]+/, '') : lv.name;
  return n.length > 0 ? n : lv.name;
}
