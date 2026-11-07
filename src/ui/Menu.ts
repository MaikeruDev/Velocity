import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import './menu.css';

import type { BestTimes, SettingsPatch, SettingsStore } from '../engine/Settings';
import type { BindAction, GameSettings, GloveId, HeldItemId, MenuStyleId } from '../engine/settingsTypes';
import type { UnlockId, UnlockStore } from '../engine/Unlocks';
import { UNLOCKS, deriveUnlocks, gloveUnlock, itemUnlock, requirementMet, unlockDef } from '../engine/Unlocks';
import type { GameEvent } from '../engine/events';
import { ViewHand, hasPropTricks } from './hand/ViewHand';
import { makeHandInput } from './hand/handMotion';
import { ViewModelPreview } from '../render/viewmodel/ViewModelPreview';
import { hasItemView } from '../render/viewmodel/items';
import { hasSkin } from '../render/viewmodel/skins';
import { BIND_ACTIONS, GLOVE_IDS, HELD_ITEM_IDS } from '../engine/settingsTypes';
import type { InputAction } from '../engine/InputState';
import { MOUSE_CODES, isBindableCode, keyLabel } from '../engine/InputState';
import type { GlyphStyle, InputDevice, PadBindAction, PadButtonCode, PadSettings } from '../engine/pad/types';
import { PAD_CAPTURE_TIMEOUT, PAD_LIMITS, PAD_PRESETS, isBindablePadCode } from '../engine/pad/types';
import type { PadSettingsPatch, PadSettingsStore } from '../engine/pad/padSettings';
import { padPresetOf } from '../engine/pad/padSettings';
import { devToolsAllowed, type DisplayMode, type PlatformApi } from '../platform';
import { WEB_PLATFORM } from '../platform/web';
import { PadNav, hoverSync } from './padNav';
import { fillGlyphs, glyphFamily, glyphNode, padCodeGlyph, promptGlyphs, refreshGlyphs, stickGlyph } from './padGlyphs';
import type { FrontDoorGlyph, FrontDoorGlyphFamily, FrontDoorInput, FrontDoorPrompt } from './menuLab/types';
import type { MovementPresetId } from '../player/MovementConfig';
import type { LevelIndexEntry, StageRank, TrainingIndexEntry } from '../world/level/LevelFormat';
import type { LessonStars, TrainingProgressView } from '../engine/trainingTypes';
import { formatDiff, formatTime } from './format';
import { MEDAL_NAMES, MEDAL_ORDER, adminTimeFor, medalFor, nextMedal } from './medals';
import type { MedalId } from './medals';
import { effectiveLines } from '../render/lowres';
import type { FinishResult, LessonResult, MenuEvents, MenuScreen, OnlineStatus, RawMouseStatus } from './types';
import type { LeaderboardEntry, LeaderboardPage } from '../online/types';
import { NAME_MAX, OnlineError, sanitizeName } from '../online/types';
import type { LevelMedals } from '../world/level/LevelFormat';
import { GAME_VERSION, PHYSICS_VERSION } from '../engine/replay/format';
import type {
  FrontDoor,
  FrontDoorContext,
  FrontDoorCosmetic,
  FrontDoorLesson,
  FrontDoorLessonGroup,
  FrontDoorLevelTheme,
  FrontDoorRequest,
  FrontDoorStyleId,
  FrontDoorView,
} from './menuLab/types';
import type { PlayerProfile } from '../online/profileTypes';
import type { AdminService } from '../online/adminTypes';
import { loadFrontDoor, MENU_STYLES } from './menuLab/registry';
import { BeatClock } from './menuLab/beatClock';
import { doorBoard } from './menuLab/doorData';
import type { MenuAudio } from './menuLab/beatClock';
import { FRONT_DOOR_ASSETS } from './menuLab/assets';
import { menuSound } from './menuSound';

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

/** Gemountete Front Door (Menü-Labor, Plan 010) — ersetzt den klassischen Titel-Screen. */
interface MountedDoor {
  readonly id: FrontDoorStyleId;
  readonly inst: FrontDoor;
  readonly root: HTMLElement;
}

/** Die stabilen Funktionen eines FrontDoorContext (einmal gebaut, in jeden Schnappschuss kopiert). */
type FrontDoorCalls = Pick<
  FrontDoorContext,
  | 'beat'
  | 'select'
  | 'play'
  | 'playSelected'
  | 'openTraining'
  | 'openCosmetics'
  | 'openLeaderboard'
  | 'openSettings'
  | 'openControls'
  | 'openProfile'
  | 'openAdmin'
  | 'openLab'
  | 'signIn'
  | 'signOut'
  | 'fullscreen'
  | 'quit'
  | 'startMusic'
  | 'markLockButton'
  | 'board'
  | 'raceGhost'
  | 'getProfile'
  | 'admin'
  | 'equip'
  | 'mountHandPreview'
>;

/** Lektionsgruppen (Titel + Belohnung) — klassische Liste und FrontDoorTraining.groups. */
const LESSON_GROUPS: readonly FrontDoorLessonGroup[] = [
  { id: 'basics', title: 'Grundlagen', reward: 'bestanden → Fidget-Spinner' },
  { id: 'advanced', title: 'Fortgeschritten', reward: 'alles bestanden → Roboter-Hand' },
];

/** Nach einer Maustasten-Belegung Kontextmenü und Zurück/Vor-Navigation noch kurz schlucken. */
const CAPTURE_SUPPRESS_MS = 800;

/** Kurzer Hinweis über allen Screens (showNotice), so lange sichtbar. */
const NOTICE_MS = 2600;
/** Web: requestFullscreen braucht eine Nutzeraktivierung — ein Pad-Druck ist laut HTML-Spec keine (Review B2). */
const FULLSCREEN_NEEDS_GESTURE = 'Vollbild braucht einen Klick oder eine Taste';
/** fullscreenerror zählt nur so lange nach einer Anfrage aus dem Menü (sonst gehört er "Vollbild beim Start"). */
const FULLSCREEN_ERROR_WINDOW_MS = 1500;
/**
 * Tasten, die während eines wartenden Logins weiterlaufen: Esc (= Abbrechen über die Engine), Enter/Leertaste/Tab auf den
 * Knöpfen des Hinweises, F-Tasten, Modifikatoren, M (Ton). Alles andere würde die Front Door darunter steuern — die
 * Stile lauschen selbst am window (Pfeile, WASD, Ziffern, Arcade: jede Taste = Münze).
 */
const LOGIN_WAIT_KEYS = /^(Escape|Enter|NumpadEnter|Tab|Space|F\d+|Shift|Control|Alt|Meta|CapsLock|KeyM)/;

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
  /** Admin: Sterne genau setzen (0 = zurücksetzen, auch senken). false = Lektion noch nicht geladen. */
  setStars(lessonId: string, stars: LessonStars): boolean;
  /** Admin: Lektion zurücksetzen. */
  reset(lessonId: string): void;
}

/**
 * Was das Menü von der Online-Schicht braucht (Plan 009) — Game reicht es durch (setOnline). null =
 * offline: Bestenliste und Statuszeilen sagen das, statt zu laden.
 */
export interface MenuOnline {
  /** 'mock' (lokal) oder 'supabase' — nur Anzeige. */
  readonly backend: string;
  /** true: Einreichen braucht den Discord-Login — Menü zeigt "Mit Discord anmelden" bzw. Avatar + Abmelden. */
  readonly loginRequired: boolean;
  /** Eigene Spieler-ID/Anzeigename/Avatar (null = nicht angemeldet). */
  myUid(): string | null;
  myName(): string | null;
  myAvatar(): string | null;
  /** Ich bin Entwickler (profiles.role = 'dev') → Namens-Effekt + DEV-Abzeichen. */
  myDev(): boolean;
  /**
   * Discord-Login (Game sichert vorher einen nicht eingereichten Lauf). Web: verlässt die Seite. Desktop (platform.auth):
   * wartet auf den System-Browser — das Menü zeigt solange "Login läuft" mit Abbrechen; das Ende (Erfolg, Fehler, Abbruch)
   * meldet refreshOnline() (OnlineService.onIdentityChange feuert auch ohne neue Identität).
   */
  signIn(): void;
  signOut(): void;
  /** Top 10 und der Ausschnitt um mich herum. Wirft bei Netzfehlern. */
  board(levelId: string): Promise<{ readonly top: LeaderboardPage; readonly around: LeaderboardPage }>;
  /** Spielerprofil (Plan 009 §15); ohne uid ich. Wirft OnlineError ('notFound' = gebannt/unbekannt, 'auth' = Login fehlt). */
  profile(uid?: string): Promise<PlayerProfile>;
  /** Moderation, nur solange ich Entwickler bin; sonst null. */
  admin(): AdminService | null;
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

/**
 * Was das Menü vom Pad live braucht (Einstellungen → Controller). Game reicht ein Objekt über `input.pad`
 * (connected/sticks) und `input.capturePadButton` durch.
 */
export interface MenuPadDevice {
  /** Ein Pad ist verbunden und wurde benutzt. */
  readonly connected: boolean;
  /** Rohwerte der Sticks (−1…1, y nach unten positiv) für die Test-Anzeige. */
  readonly sticks: { readonly lx: number; readonly ly: number; readonly rx: number; readonly ry: number };
  /**
   * Belegungs-Dialog: den NÄCHSTEN gedrückten Pad-Knopf melden, statt daraus Menü-Aktionen zu machen (auch A/B).
   * null = abgebrochen (B halten, Start, Esc, Zeitüberschreitung). Rückgabe bricht still ab.
   */
  captureButton(onCode: (code: PadButtonCode | null) => void): () => void;
}

/** Pad-Belegung im Menü: welche Aktionen, in dieser Reihenfolge ('pause' ist fest auf Start/Menu). */
const PAD_BIND_ROWS: readonly PadBindAction[] = ['jump', 'crouch', 'sprint', 'respawn', 'demo', 'restart'];

/** Grundlagen-Lektionen, die das Ergebnis ohne Medaille anbietet (nach den prepLessons des Levels): Strafen, Tempo. */
const TIP_LESSONS: readonly string[] = ['t3', 't4'];

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
    raceGhost: new Set(),
    quit: new Set(),
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
  /** Online-Schicht (Plan 009), null = offline. */
  private online: MenuOnline | null = null;
  /** Bestenliste: gewähltes Level, Rückweg, Lade-Zähler (veraltete Antworten verwerfen). */
  private boardLevel: string | null = null;
  private boardReturn: 'title' | 'finish' = 'title';
  private boardSeq = 0;
  /** Menü-Labor (Plan 010): ?menu=<id> gilt nur für die Sitzung und schlägt die Einstellung. */
  private styleOverride: MenuStyleId | null = null;
  private door: MountedDoor | null = null;
  /** Zählt Ladeversuche — ein veralteter Import darf nicht mehr mounten. */
  private doorSeq = 0;
  /** Stile, die in dieser Sitzung schon einmal gemountet waren (FrontDoorContext.entry). */
  private readonly doorsSeen = new Set<FrontDoorStyleId>();
  private doorCalls: FrontDoorCalls | null = null;
  private readonly beatClock = new BeatClock();
  private labReturn: 'title' | 'admin' = 'title';
  /** Anfrage an die Front Door (Stil baut den Screen selbst), wird mit dem nächsten mount/update zugestellt. */
  private doorRequest: FrontDoorRequest | null = null;
  /** Level-Farben (Game liest die Level-Dateien im Hintergrund). */
  private levelThemes = new Map<string, FrontDoorLevelTheme>();
  /** Profil-Screen (Bestand): fremder Spieler oder null = ich. */
  private profileUid: string | null = null;
  private profileSeq = 0;
  private profileReturn: 'title' | 'leaderboard' = 'title';
  /** Zuletzt benutztes Eingabegerät (InputManager.onDevice → setInputDevice). */
  private device: InputDevice = 'keyboard';
  /** Pad-Einstellungen (velocity.pad.v1) und Live-Pad, null = kein Controller-Kern. */
  private pad: PadSettingsStore | null = null;
  private padDevice: MenuPadDevice | null = null;
  private padUnsub: (() => void) | null = null;
  /** Zuletzt gesehene Symbol-Familie (Wechsel → Glyphen neu). */
  private lastFamily: FrontDoorGlyphFamily = 'keyboard';
  /** Pad-Fokus der Bestands-Screens. */
  private readonly nav = new PadNav({ onFocus: (el) => el.dispatchEvent(new FocusEvent('focus')) });
  /** Pad-Fokus für Front Doors ohne onNavigate (hub/rave/arcade): Hover-Zustand des Stils nachziehen. */
  private readonly doorNav = new PadNav({ onFocus: (el) => hoverSync(el, this.door?.root ?? null) });
  /**
   * Erst nach der ersten Pad-Richtung klickt A den räumlichen Fokus solcher Stile — davor ist A ihre eigene Taste
   * (Boot/Intro überspringen, Münze, Start), wie Enter.
   */
  private doorNavUsed = false;
  /** Aktualisiert Pad-Felder (Belegung, Werte) bei Store- oder Familienwechsel. Pro Screen neu. */
  private padRefreshers: (() => void)[] = [];
  /** Aufräumen beim Screenwechsel (Stick-Test-rAF). */
  private screenCleanups: (() => void)[] = [];
  /** Während des Aufbaus gesammelt, render() übernimmt sie (die alten laufen vorher ab). */
  private nextPadRefreshers: (() => void)[] = [];
  private nextCleanups: (() => void)[] = [];
  private padCapture: { readonly button: HTMLButtonElement; readonly stop: () => void } | null = null;
  /** Lebendiges Eingabe-Objekt für Front Doors (FrontDoorContext.input). */
  private readonly inputApi: FrontDoorInput;
  /** Plattform (Plan 011): Beenden, Anzeigemodus, Admin nur mit --dev. main.ts setzt sie vor dem ersten Screen. */
  private platform: PlatformApi = WEB_PLATFORM;
  /** Zuletzt bekannter Anzeigemodus am Desktop (Einstellungen zeigen ihn ohne await). */
  private displayMode: DisplayMode = 'windowed';
  /** Abo auf Moduswechsel von außen (Alt+Enter/F11 im Hauptprozess, Review N1 desktop). */
  private modeUnsub: (() => void) | null = null;
  /**
   * Desktop-Login wartet auf den System-Browser (bis zu 5 min): Hinweis "Login läuft" mit Abbrechen über dem Screen
   * (Review B4), null = keiner. Überlebt Neuaufbauten des Screens (render hängt ihn wieder an).
   */
  private loginWait: HTMLElement | null = null;
  /** Kurzer Hinweis über dem Screen (z. B. Vollbild ohne Geste), null = keiner. */
  private notice: HTMLElement | null = null;
  private noticeTimer = 0;
  /** Zeitpunkt der letzten Vollbild-Anfrage aus dem Menü (für fullscreenerror). */
  private fullscreenAskedAt = -Infinity;

  constructor(root: HTMLElement, settings: SettingsStore, best: BestTimes, unlocks: UnlockStore) {
    const menu = this;
    this.inputApi = {
      get family(): FrontDoorGlyphFamily {
        return menu.family;
      },
      get pad(): boolean {
        return menu.padMode;
      },
      glyphs: (p) => this.glyphs(p),
    };
    this.settings = settings;
    this.best = best;
    this.unlocks = unlocks;
    unlocks.subscribe(() => {
      if (this.current === 'cosmetics') this.showCosmetics();
      else if (this.current === 'admin') this.adminRefresh?.();
      else if (this.current === 'title') this.updateDoor();
    });
    this.el = h('div', 'vel-menu');
    this.el.hidden = true;
    // Menü-Klänge: Fokus/Hover = move, Klick = confirm bzw. back (Zurück-Knöpfe). Was ohne DOM-Fokus läuft
    // (PS2-Disc-Bahn, Enter/Esc in Front Doors), meldet der Stil selbst.
    this.el.addEventListener('focusin', this.onSoundFocus);
    this.el.addEventListener('pointerover', this.onSoundHover);
    this.el.addEventListener('click', this.onSoundClick, true);
    // An window statt am Menü: ohne Fokus im Menü (Normalfall) kämen die Pfeiltasten sonst nie an.
    window.addEventListener('keydown', this.onKeyDown);
    // Capture-Phase: die Tastenbelegung muss Tasten VOR InputManager und Menü-Aktionen abfangen.
    window.addEventListener('keydown', this.onCaptureKey, true);
    window.addEventListener('mousedown', this.onCaptureMouse, true);
    window.addEventListener('mouseup', this.onSuppressMouse, true);
    window.addEventListener('auxclick', this.onSuppressMouse, true);
    window.addEventListener('contextmenu', this.onSuppressMouse, true);
    document.addEventListener('fullscreenerror', this.onFullscreenError);
    root.appendChild(this.el);
    // Änderungen von außen (Tuning-Panel, Reset) sofort in offenen Reglern zeigen.
    this.unsubscribe = settings.subscribe((s, prev) => {
      for (const r of this.refreshers) r(s);
      if (s.menuStyle !== prev.menuStyle) this.styleChanged();
      else if (this.current === 'title') this.updateDoor();
    });
    this.applyStyleClass();
    this.el.dataset.input = 'keyboard';
    this.el.dataset.glyphs = 'keyboard';
  }

  // ------------------------------------------------------------------ Plattform (Plan 011 §2.3/§2.5)

  /** Plattform übernehmen (main.ts, vor dem ersten Screen). Front-Door-Rückrufe werden neu gebaut (quit). */
  setPlatform(p: PlatformApi): void {
    this.platform = p;
    this.doorCalls = null;
    this.el.dataset.platform = p.kind;
    this.modeUnsub?.();
    this.modeUnsub =
      p.window?.onModeChange((m) => {
        this.displayMode = m;
        for (const r of this.refreshers) r(this.settings.get());
      }) ?? null;
    p.window
      ?.getMode()
      .then((m) => {
        this.displayMode = m;
        for (const r of this.refreshers) r(this.settings.get());
      })
      .catch(() => undefined);
    if (this.current === 'title') this.showTitle();
  }

  /** Admin-Menü/F8: im Web immer, am Desktop nur mit --dev (sonst entwertet es Achievements, Plan 011 §2.2.13). */
  get adminAllowed(): boolean {
    return this.platform.kind === 'web' || this.platform.dev;
  }

  /** Anzeigemodus am Desktop setzen (Einstellungen); der Hauptprozess merkt ihn sich in desktop.json. */
  private setDisplayMode(m: DisplayMode): void {
    const w = this.platform.window;
    if (!w) return;
    this.displayMode = m;
    for (const r of this.refreshers) r(this.settings.get());
    void w
      .setMode(m)
      .then((got) => {
        this.displayMode = got;
        for (const r of this.refreshers) r(this.settings.get());
      })
      .catch(() => undefined);
  }

  /** "Beenden" zweistufig: erster Druck fragt nach, zweiter beendet; nach 3 s ohne Bestätigung zurück. */
  private quitBtn(label: string, cls: string): HTMLButtonElement {
    let armed = 0;
    const b = this.btn(label, `vel-quit-btn ${cls}`.trim(), () => {
      if (armed !== 0) {
        window.clearTimeout(armed);
        armed = 0;
        this.emit('quit', undefined);
        return;
      }
      text.textContent = 'Wirklich beenden?';
      b.classList.add('is-armed');
      armed = window.setTimeout(() => {
        armed = 0;
        text.textContent = label;
        b.classList.remove('is-armed');
      }, 3000);
    });
    const text = b.firstElementChild ?? b;
    return b;
  }

  /**
   * Vollbild aus dem Menü (classic "Vollbild", ctx.fullscreen aller Stile). Web: requestFullscreen braucht eine
   * Nutzeraktivierung, ein Pad-Druck ist laut HTML-Spec keine — der Versuch scheiterte still (Review B2). Ohne Aktivierung
   * darum gleich der Hinweis (die Anfrage brächte nur eine Konsolen-Warnung); fullscreenerror fängt Browser ohne
   * navigator.userActivation. Verlassen geht ohne Geste. Desktop: Anzeigemodus des Fensters, keine Geste nötig.
   */
  private requestFullscreen(): void {
    if (this.platform.window === null && document.fullscreenElement === null) {
      const ua: UserActivation | undefined = navigator.userActivation;
      if (ua !== undefined && !ua.isActive) {
        this.showNotice(FULLSCREEN_NEEDS_GESTURE);
        return;
      }
      this.fullscreenAskedAt = performance.now();
    }
    this.emit('fullscreen', undefined);
  }

  private readonly onFullscreenError = (): void => {
    if (!this.visible || performance.now() - this.fullscreenAskedAt > FULLSCREEN_ERROR_WINDOW_MS) return;
    this.showNotice(FULLSCREEN_NEEDS_GESTURE);
  };

  /** Kurzer Hinweis über dem aktuellen Screen (role=status, nicht klickbar); ein neuer ersetzt den laufenden. */
  private showNotice(text: string): void {
    window.clearTimeout(this.noticeTimer);
    const n = this.notice ?? h('div', 'vel-menu-notice');
    n.setAttribute('role', 'status');
    n.textContent = text;
    this.notice = n;
    if (!this.el.hidden) this.el.append(n);
    this.noticeTimer = window.setTimeout(() => this.dropNotice(), NOTICE_MS);
  }

  private dropNotice(): void {
    window.clearTimeout(this.noticeTimer);
    this.notice?.remove();
    this.notice = null;
  }

  // ------------------------------------------------------------------ Desktop-Login (Plan 011 §3.1, Review B4)

  /**
   * "Mit Discord anmelden" (alle Knöpfe, auch die der Front Doors). Desktop (platform.auth): der Login läuft im
   * System-Browser und die Seite bleibt stehen — bis zum Rücksprung "Login läuft" mit Abbrechen zeigen. Web: Redirect,
   * die Seite geht weg — unverändert ohne Hinweis.
   */
  private startSignIn(): void {
    const on = this.online;
    if (!on) return;
    const waits = this.platform.auth !== null && on.loginRequired && on.myUid() === null;
    on.signIn();
    if (waits) this.showLoginWait();
  }

  /** Modaler Hinweis über dem Screen: Pad-Fokus darin, Screen darunter inert (Maus, Tab, Pad-Fokus der Stile). */
  private showLoginWait(): void {
    if (this.loginWait) return;
    // Erneut öffnen: SupabaseService öffnet dieselbe Auth-URL noch einmal (gleicher Versuch, gleicher state).
    const again = this.btn('Browser erneut öffnen', 'vel-login-again', () => this.online?.signIn());
    again.title = 'Dieselbe Anmeldeseite noch einmal öffnen (Tab geschlossen?)';
    // Startfokus auf dem harmlosen Knopf: ein doppeltes A soll den Login nicht abbrechen.
    again.dataset.padInitial = '';
    const cancel = this.btn('Abbrechen', 'vel-login-cancel', () => this.cancelLogin(), 'Esc');
    const box = h(
      'section',
      'vel-panel vel-login-box',
      h('h2', 'vel-h2', 'Login läuft', h('span', 'vel-login-dots')),
      h('p', 'vel-text', 'Im Browser bei Discord fortfahren — danach geht es hier von selbst weiter.'),
      // Keine Frist im Text: die steht im Hauptprozess (electron/auth.ts) und meldet sich beim Ablauf selbst.
      h('p', 'vel-hint', 'Kein Browser aufgegangen oder Tab zu? Erneut öffnen. Spielen geht auch ohne Konto.'),
      h('div', 'vel-row vel-login-actions', again, cancel),
    );
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Login läuft');
    const wrap = h('div', 'vel-login-wait', box);
    this.loginWait = wrap;
    this.attachLayers();
    this.nav.setRoot(wrap);
    if (this.padMode) this.nav.ensure();
  }

  /** Hinweis weg, Screen wieder bedienbar, Pad-Fokus zurück an Screen bzw. Front Door. */
  private endLoginWait(): void {
    const w = this.loginWait;
    if (!w) return;
    this.loginWait = null;
    w.remove();
    const screen = this.el.firstElementChild;
    if (!(screen instanceof HTMLElement)) {
      this.nav.setRoot(null);
      return;
    }
    screen.inert = false;
    const isDoor = screen.classList.contains('vel-frontdoor');
    this.nav.setRoot(isDoor ? null : screen);
    if (!this.padMode) return;
    if (!isDoor) this.nav.ensure();
    else if (this.door && !this.door.inst.onNavigate) this.doorNav.ensure();
  }

  /**
   * Abbrechen (Knopf, Esc, Pad-B): Empfänger im Hauptprozess zu — derselbe Weg wie SupabaseService externalLogin.cancel
   * (platform.auth ist genau das Objekt), signIn() löst dann ohne Fehler auf. Der Hinweis geht sofort, nicht erst mit
   * der Antwort des Hauptprozesses.
   */
  private cancelLogin(): void {
    if (!this.loginWait) return;
    try {
      this.platform.auth?.cancel();
    } catch {
      // Bridge weg: der Empfänger schließt spätestens nach seiner Frist von selbst.
    }
    this.endLoginWait();
  }

  /** Während des Wartens: Steuerkreuz/A im Hinweis, B/Esc bricht ab, alles andere ist geschluckt. */
  private loginWaitAction(a: InputAction): boolean {
    switch (a) {
      case 'navUp':
        this.nav.move(0, -1);
        break;
      case 'navDown':
        this.nav.move(0, 1);
        break;
      case 'navLeft':
        this.nav.move(-1, 0);
        break;
      case 'navRight':
        this.nav.move(1, 0);
        break;
      case 'pause':
        this.cancelLogin();
        break;
      case 'confirm':
        // Tastatur-Enter ohne Fokus tut nichts (Enter auf einem fokussierten Knopf löst ihn nativ aus).
        if (this.padMode && this.nav.ensure() !== null) this.nav.activate();
        break;
      default:
        break;
    }
    return true;
  }

  /** Hinweise über dem Screen nach jedem Aufbau wieder anhängen; der wartende Login macht den Screen darunter inert. */
  private attachLayers(): void {
    const w = this.loginWait;
    if (w) {
      const screen = this.el.firstElementChild;
      if (screen instanceof HTMLElement && screen !== w) screen.inert = true;
      this.el.append(w);
      refreshGlyphs(w, (p) => this.glyphs(p));
    }
    if (this.notice) this.el.append(this.notice);
  }

  // ------------------------------------------------------------------ Eingabegerät / Controller (Plan 011)

  /** Symbol-Familie der Hinweise: Gerät + Einstellung "Tasten-Symbole". */
  get family(): FrontDoorGlyphFamily {
    return glyphFamily(this.device, this.pad?.get().glyphs ?? 'auto');
  }

  /** Zuletzt wurde ein Gamepad benutzt. */
  get padMode(): boolean {
    return this.device !== 'keyboard';
  }

  /** Symbole eines Hinweises in der aktuellen Familie (Pad-Aktionen folgen der Belegung). */
  glyphs(p: FrontDoorPrompt): readonly FrontDoorGlyph[] {
    return promptGlyphs(p, this.family, { demoKey: this.demoKey, padBinds: this.pad?.get().binds ?? null });
  }

  /**
   * Zuletzt benutztes Gerät (InputManager.onDevice). Schaltet im selben Aufruf: Fokus-Rahmen, Glyphen der Hinweise,
   * Front Door (onInput bzw. update).
   */
  setInputDevice(d: InputDevice): void {
    if (d === this.device) return;
    this.device = d;
    this.applyInput();
  }

  /** Controller-Kern (Game/main): Einstellungs-Speicher + Live-Pad. null = keiner (Abschnitt zeigt das). */
  setPad(store: PadSettingsStore | null, dev: MenuPadDevice | null): void {
    this.padUnsub?.();
    this.padUnsub = null;
    this.pad = store;
    this.padDevice = dev;
    if (store) {
      this.padUnsub = store.subscribe(() => {
        for (const r of this.padRefreshers) r();
        this.applyInput();
      });
    }
    // Offene Screens mit Controller-Abschnitt neu bauen (Kern kam nach dem Öffnen).
    if (this.current === 'settings') this.render('settings', this.buildSettings());
    else if (this.current === 'controls') this.render('controls', this.buildControls());
    this.applyInput();
  }

  /** Gerät/Familie am Root spiegeln (CSS: Fokus-Rahmen nur am Pad) und Hinweise neu füllen, ohne Neuaufbau. */
  private applyInput(): void {
    const fam = this.family;
    const famChanged = fam !== this.lastFamily;
    const modeChanged = this.el.dataset.input !== (this.padMode ? 'pad' : 'keyboard');
    this.lastFamily = fam;
    this.el.dataset.input = this.padMode ? 'pad' : 'keyboard';
    this.el.dataset.glyphs = fam;
    if (!famChanged && !modeChanged) return;
    for (const r of this.padRefreshers) r();
    const wait = this.loginWait;
    if (wait) {
      // Wartender Login ist modal: Symbole und Fokus im Hinweis (der Screen darunter ist inert).
      refreshGlyphs(wait, (p) => this.glyphs(p));
      if (this.padMode) this.nav.ensure();
    }
    const d = this.door;
    if (d !== null && this.current === 'title') {
      if (d.inst.onInput) d.inst.onInput();
      else this.updateDoor();
      if (this.padMode && !d.inst.onNavigate && !wait) this.doorNav.ensure();
      return;
    }
    refreshGlyphs(this.el, (p) => this.glyphs(p));
    for (const e of this.el.querySelectorAll('.vel-start-main')) e.textContent = this.startMain();
    if (this.padMode) this.nav.ensure();
  }

  /** Beschriftung des großen Startknopfs: am Pad gibt es nichts zu klicken. */
  private startMain(): string {
    return this.padMode ? 'Starten' : 'Klicken zum Starten';
  }

  private padNavigate(dx: number, dy: number): void {
    const d = this.door;
    if (this.current === 'title' && d !== null) {
      if (d.inst.onNavigate?.(dx, dy)) return;
      this.doorNavUsed = true;
      this.doorNav.move(dx, dy);
      return;
    }
    this.nav.move(dx, dy);
  }

  /** LB/RB: Reiter des Screens (Bestenliste: Strecke), sonst Abschnitt (Panel) springen. */
  private padTab(dir: -1 | 1): void {
    const d = this.door;
    if (this.current === 'title' && d !== null) {
      d.inst.onTab?.(dir);
      return;
    }
    if (this.current === 'leaderboard' && this.levels.length > 0) {
      const i = Math.max(0, this.levels.findIndex((l) => l.id === this.boardLevel));
      const n = this.levels.length;
      this.showLeaderboard(this.levels[(((i + dir) % n) + n) % n].id);
      return;
    }
    this.nav.jumpSection(dir, '.vel-panel');
  }

  /** A am Pad: fokussiertes Element auslösen. false = keins (dann gilt die Bildschirm-Standardaktion). */
  private padConfirm(): boolean {
    const d = this.door;
    if (this.current === 'title' && d !== null) {
      // Stile mit eigener Navigation klicken selbst (onAction 'confirm'); sonst der räumliche Fokus.
      if (d.inst.onNavigate || !this.doorNavUsed) return false;
      return this.doorNav.ensure() !== null && this.doorNav.activate();
    }
    return this.nav.ensure() !== null && this.nav.activate();
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

  /** Level-Farben (LevelFile.environment) für Front Doors; Game liefert sie nach dem Hintergrund-Laden. */
  setLevelThemes(themes: ReadonlyMap<string, FrontDoorLevelTheme>): void {
    this.levelThemes = new Map(themes);
    this.updateDoor();
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

  /** Online-Schicht (Plan 009) setzen; null = offline. Offene Bestenliste lädt neu. */
  setOnline(o: MenuOnline | null): void {
    this.online = o;
    if (this.current === 'leaderboard') this.showLeaderboard();
  }

  /**
   * Bestenliste eines Levels (Plan 009): Top 10, um mich herum, Ghost-Auswahl. Ohne levelId das zuletzt
   * gezeigte bzw. das in der Titel-Liste gewählte Level. Aus dem Ergebnis führt "Zurück" wieder dorthin.
   */
  showLeaderboard(levelId?: string): void {
    // Vom Titel aus baut ein Stil mit eigener Bestenlisten-Ansicht sie selbst (aus dem Ergebnis bleibt der Bestand,
    // damit "Zurück" dorthin führt).
    if (this.current === 'title' && this.delegate({ view: 'leaderboard', levelId: levelId ?? this.selectedLevelId ?? undefined })) return;
    if (this.current !== 'leaderboard') this.boardReturn = this.current === 'finish' ? 'finish' : 'title';
    this.boardLevel = levelId ?? this.boardLevel ?? this.selectedLevelId;
    this.render('leaderboard', this.buildLeaderboard());
    void this.loadBoard();
  }

  /** Stand der Online-Einreichung im Ergebnis nachziehen (kommt asynchron nach showFinish). */
  setOnlineStatus(st: OnlineStatus): void {
    if (this.finishResult) this.finishResult = { ...this.finishResult, online: st };
    const el = this.el.querySelector<HTMLElement>('.vel-online-status');
    if (el && this.current === 'finish') el.replaceWith(this.onlineLine(st));
  }

  /**
   * Anmeldestand geändert (Login/Logout/Name): offene Screens mit Konto-Anzeige neu bauen. Ein wartender Desktop-Login
   * ist damit vorbei — angemeldet, gescheitert oder abgebrochen (SupabaseService meldet auch das Ende ohne Login).
   */
  refreshOnline(): void {
    this.endLoginWait();
    switch (this.current) {
      case 'title':
        this.showTitle();
        break;
      case 'settings':
        // Nicht neu bauen, solange ein Textfeld Fokus hat (Tippen nicht unterbrechen) — nur die Konto-Zeile.
        this.el.querySelector('.vel-online-panel .vel-account')?.replaceWith(this.accountBlock() ?? h('div', 'vel-account'));
        this.el.querySelector('.vel-online-panel .vel-online-name-hint')?.replaceWith(this.nameHint());
        break;
      case 'leaderboard':
        this.showLeaderboard();
        break;
      case 'finish': {
        const st = this.finishResult?.online;
        const el = this.el.querySelector<HTMLElement>('.vel-online-status');
        if (st && el) el.replaceWith(this.onlineLine(st));
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ Menü-Labor (Plan 010)

  /** Wirksamer Hauptmenü-Stil: ?menu=<id> (Sitzung) vor der Einstellung. */
  get menuStyle(): MenuStyleId {
    return this.styleOverride ?? this.settings.get().menuStyle;
  }

  /** main.ts: ?menu=<id> — gilt nur für diese Sitzung, wird nicht gespeichert. null = Einstellung. */
  setStyleOverride(id: MenuStyleId | null): void {
    if (id === this.styleOverride) return;
    this.styleOverride = id;
    this.styleChanged();
  }

  /** Audio-Engine für FrontDoorContext.beat()/startMusic() (main.ts). Ohne: Ersatz-Uhr, startMusic tut nichts. */
  setAudio(a: MenuAudio | null): void {
    this.beatClock.audio = a;
  }

  /** Menü-Labor: die fünf Stile als Karten, "Ansehen" speichert den Stil und zeigt den Titel. */
  showLab(): void {
    if (this.current === 'title' || this.current === 'admin') this.labReturn = this.current;
    this.render('lab', this.buildLab());
  }

  /** Profil (Plan 009 §15): eigenes (ohne uid) oder das eines anderen Spielers (Klick auf einen Namen). */
  showProfile(uid?: string): void {
    if (this.delegate(uid !== undefined ? { view: 'profile', uid } : { view: 'profile' })) return;
    if (this.current !== 'profile') this.profileReturn = this.current === 'leaderboard' ? 'leaderboard' : 'title';
    this.profileUid = uid ?? null;
    this.render('profile', this.buildProfile());
    void this.loadProfile();
  }

  /** Moderation (nur Front Doors mit 'moderation'; klassisch gibt es dafür keinen Screen). */
  showModeration(): void {
    this.delegate({ view: 'moderation' });
  }

  /** Front-Door-Stil mit eigener Ansicht? Dann den Titel mit Anfrage zeigen (true) statt des Bestands-Screens. */
  private delegate(req: FrontDoorRequest): boolean {
    const style = this.menuStyle;
    if (style === 'classic') return false;
    const views: readonly FrontDoorView[] = MENU_STYLES.find((st) => st.id === style)?.views ?? [];
    if (!views.includes(req.view)) return false;
    this.doorRequest = req;
    this.showTitle();
    return true;
  }

  private leaveLab(): void {
    if (this.labReturn === 'admin') this.showAdmin();
    else this.showTitle();
  }

  /** Stil gewechselt (Einstellung/Override): Klasse am Root, offener Titel baut neu, offenes Labor markiert neu. */
  private styleChanged(): void {
    this.applyStyleClass();
    if (this.current === 'title') this.showTitle();
    else if (this.current === 'lab') this.render('lab', this.buildLab());
  }

  /** `vel-style--<id>` am Menü-Root, auf ALLEN Screens — Stile färben darüber auch die Bestands-Screens um. */
  private applyStyleClass(): void {
    const id = this.menuStyle;
    for (const s of MENU_STYLES) this.el.classList.toggle(`vel-style--${s.id}`, s.id === id);
    this.el.dataset.menuStyle = id;
  }

  /** Front Door laden (lazy) und in einen vollflächigen Container mounten; Fehler → klassischer Titel. */
  private renderDoor(id: FrontDoorStyleId): void {
    const root = h('div', `vel-frontdoor vel-frontdoor--${id}`, h('div', 'vel-frontdoor-loading', 'Lädt …'));
    root.dataset.style = id;
    this.render('title', root);
    const seq = ++this.doorSeq;
    loadFrontDoor(id).then(
      (factory) => {
        if (seq !== this.doorSeq || this.current !== 'title' || !root.isConnected) return;
        root.replaceChildren();
        const inst = factory();
        this.door = { id, inst, root };
        try {
          const c = this.doorCtx(id);
          this.doorRequest = null;
          inst.mount(root, c);
        } catch (err) {
          console.error(`Menü-Stil "${id}" konnte nicht starten`, err);
          this.unmountDoor();
          this.render('title', this.buildTitle());
          return;
        }
        this.doorsSeen.add(id);
        // Für Werkzeuge (tools/menu/shot.ts): Front Door steht.
        this.el.dataset.door = 'ready';
        this.applyLockStatus();
        // Stile ohne eigene Pad-Navigation: räumlicher Fokus über ihre Knöpfe.
        this.doorNav.setRoot(inst.onNavigate ? null : root);
        this.doorNavUsed = false;
        if (this.padMode && !inst.onNavigate) this.doorNav.ensure();
      },
      (err: unknown) => {
        console.error(`Menü-Stil "${id}" konnte nicht geladen werden`, err);
        if (seq === this.doorSeq && this.current === 'title' && root.isConnected) this.render('title', this.buildTitle());
      },
    );
  }

  /** Neue Daten an die gemountete Front Door (nur auf dem Titel). */
  private updateDoor(): void {
    const d = this.door;
    if (d === null || this.current !== 'title') return;
    const c = this.doorCtx(d.id);
    this.doorRequest = null;
    d.inst.update(c);
    this.applyLockStatus();
  }

  private unmountDoor(): void {
    const d = this.door;
    if (d === null) return;
    this.door = null;
    this.doorSeq++;
    this.doorNav.setRoot(null);
    delete this.el.dataset.door;
    try {
      d.inst.unmount();
    } catch (err) {
      console.error(`Menü-Stil "${d.id}" hat beim Abbau geworfen`, err);
    }
    d.root.replaceChildren();
  }

  /** Schnappschuss aller Titel-Daten für eine Front Door. Menü-Code, kein Frame-Pfad. */
  private doorCtx(style: FrontDoorStyleId): FrontDoorContext {
    const t = this.training;
    const lessons = t ? t.lessons() : [];
    const passed = t ? lessons.filter((l) => t.stars(l.id) > 0).length : 0;
    const rec = t ? recommendedIndex(t) : -1;
    const recEntry = t && rec >= 0 ? lessons[rec] : undefined;
    const lesson = (lv: TrainingIndexEntry): FrontDoorLesson => ({
      id: lv.id,
      short: lv.short,
      name: lessonName(lv),
      subtitle: lv.subtitle ?? null,
      stars: t ? t.stars(lv.id) : 0,
      group: lv.group,
    });
    const eff = this.effectiveCosmetics(this.settings.get());
    const g = gloveUnlock(eff.glove);
    const it = itemUnlock(eff.item);
    let latest: string | null = null;
    let latestDate = '';
    for (const id of this.unlocks.list()) {
      const d = this.unlocks.date(id) ?? '';
      if (latest === null || d > latestDate) {
        latest = unlockDef(id).name;
        latestDate = d;
      }
    }
    const on = this.online;
    const st = this.lockStatus;
    return {
      style,
      entry: this.doorsSeen.has(style) || this.doorRequest !== null ? 'return' : 'boot',
      request: this.doorRequest,
      levels: this.levels.map((lv, i) => {
        const best = this.best.get(lv.id);
        return {
          id: lv.id,
          index: i,
          num: String(i + 1).padStart(2, '0'),
          name: listName(lv.name),
          subtitle: lv.subtitle ?? null,
          medals: lv.medals ?? null,
          bestTime: best,
          bestText: best !== null ? formatTime(best) : '--:--.--',
          medal: medalFor(best, lv.medals),
          nextMedal: lv.medals ? nextMedal(best, lv.medals) : null,
          locked: false,
          recommended: this.prepText(lv),
          theme: this.levelThemes.get(lv.id) ?? null,
        };
      }),
      selected: Math.min(this.selected, Math.max(0, this.levels.length - 1)),
      loading: this.levels.length === 0,
      training: {
        available: lessons.length > 0,
        playable: t?.playable ?? false,
        passed,
        total: lessons.length,
        countText: t ? trainingCount(t) : '',
        recommended: recEntry ? lesson(recEntry) : null,
        newbie: this.isNewbie(),
        lessons: lessons.map(lesson),
        groups: LESSON_GROUPS.filter((g) => lessons.some((l) => l.group === g.id)),
        demoKey: this.demoKey,
      },
      cosmetics: {
        unlocked: this.unlocks.list().length,
        total: UNLOCKS.length,
        gloveName: g === null ? 'Standard' : unlockDef(g).name,
        itemName: it === null ? 'Nichts' : unlockDef(it).name,
        latest,
        ...this.cosmeticLists(),
      },
      account: {
        online: on !== null,
        backend: on ? on.backend : 'off',
        loginRequired: on?.loginRequired ?? false,
        signedIn: on !== null && on.myUid() !== null,
        name: on ? on.myName() : null,
        avatarUrl: on ? on.myAvatar() : null,
        dev: on ? on.myDev() : false,
      },
      lock: { pending: st.pending, error: st.error !== null ? lockErrorText(st.error) : null },
      version: `v${GAME_VERSION} · Physik ${PHYSICS_VERSION} · ${import.meta.env.DEV ? 'dev' : 'build'}`,
      reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
      assets: FRONT_DOOR_ASSETS,
      input: this.inputApi,
      platform: this.platform.kind,
      adminMenu: this.adminAllowed,
      ...this.frontDoorCalls(),
    };
  }

  /** Stabile Rückrufe — einmal gebaut, damit Stile sie sich merken dürfen. */
  private frontDoorCalls(): FrontDoorCalls {
    if (this.doorCalls) return this.doorCalls;
    const play = (levelId: string): void => {
      // Wie die klassischen data-lock-Knöpfe: während eines Lock-Versuchs keine neuen (Chrome drosselt).
      if (this.lockStatus.pending || performance.now() < this.guardUntil) return;
      const i = this.levels.findIndex((l) => l.id === levelId);
      if (i >= 0) this.selected = i;
      this.emit('play', { levelId });
    };
    this.doorCalls = {
      beat: () => this.beatClock.read(performance.now()),
      select: (i) => {
        if (this.levels.length > 0) this.selected = Math.max(0, Math.min(this.levels.length - 1, Math.floor(i)));
      },
      play,
      playSelected: () => {
        const lv = this.levels[this.selected];
        if (lv) play(lv.id);
      },
      openTraining: () => this.showTraining(),
      openCosmetics: () => this.showCosmetics(),
      openLeaderboard: (levelId) => this.showLeaderboard(levelId ?? this.selectedLevelId ?? undefined),
      openSettings: () => this.showSettings(),
      openControls: () => this.showControls(),
      openProfile: (uid) => this.showProfile(uid),
      openAdmin: () => this.showAdmin(),
      openLab: () => this.showLab(),
      signIn: () => this.startSignIn(),
      signOut: () => this.online?.signOut(),
      fullscreen: () => this.requestFullscreen(),
      quit: this.platform.caps.quit ? () => this.emit('quit', undefined) : null,
      startMusic: () => {
        this.beatClock.audio?.unlock().catch(() => undefined);
      },
      markLockButton: (el) => {
        el.dataset.lock = '1';
        el.disabled = this.lockStatus.pending;
      },
      board: async (levelId) => {
        const on = this.online;
        if (!on) throw new OnlineError('offline', 'Offline — keine Bestenliste.');
        const data = await on.board(levelId);
        return doorBoard(levelId, data.top, data.around, on.myUid());
      },
      raceGhost: (levelId, runId, label) => {
        if (this.lockStatus.pending || performance.now() < this.guardUntil) return;
        this.emit('raceGhost', { levelId, runId, label });
      },
      getProfile: (uid) => {
        const on = this.online;
        if (!on) return Promise.reject(new OnlineError('offline', 'Offline — kein Profil.'));
        return on.profile(uid);
      },
      admin: () => this.online?.admin() ?? null,
      equip: (kind, id) => {
        const list = kind === 'glove' ? this.cosmeticLists().gloves : this.cosmeticLists().items;
        const c = list.find((x) => x.id === id);
        if (!c || !c.unlocked || !c.implemented) return;
        if (kind === 'glove') this.settings.update({ glove: c.id as GloveId });
        else this.settings.update({ heldItem: c.id as HeldItemId });
      },
      mountHandPreview: (canvas, label) => this.startPreview(canvas, label ?? h('span', ''), () => this.effectiveCosmetics(this.settings.get())),
    };
    return this.doorCalls;
  }

  private buildLab(): HTMLElement {
    const active = this.menuStyle;
    const cards = MENU_STYLES.map((st) => {
      const on = st.id === active;
      const look = this.btn(on ? 'Aktiv' : 'Ansehen', `vel-btn--small vel-lab-go${on ? '' : ' vel-btn--primary'}`, () => {
        // Speichern UND Sitzungs-Override lösen — sonst bliebe ?menu=… stärker als die Wahl.
        this.styleOverride = null;
        this.settings.update({ menuStyle: st.id });
        this.applyStyleClass();
        this.showTitle();
      });
      look.dataset.style = st.id;
      if (on) look.setAttribute('aria-pressed', 'true');
      return h('div', `vel-panel vel-lab-card${on ? ' is-active' : ''}`, h('h2', 'vel-h2', st.name), h('p', 'vel-text vel-lab-desc', st.description), look);
    });
    const forced = this.styleOverride !== null ? h('p', 'vel-hint', `Gerade per Adresse erzwungen: ?menu=${this.styleOverride} (gilt bis zum Neuladen).`) : null;
    return h(
      'section',
      'vel-screen vel-lab-screen',
      h('div', 'vel-head-row', h('h1', 'vel-h1', 'Menü-Labor'), h('div', 'vel-row', this.btn('Zurück', 'vel-btn--small', () => this.leaveLab(), 'Esc'))),
      h('p', 'vel-hint', 'Fünf Hauptmenüs zum Ausprobieren. Die Wahl wird gespeichert; zurück geht es jederzeit hierüber.'),
      forced,
      h('div', 'vel-lab-grid', ...cards),
    );
  }

  private leaveProfile(): void {
    this.profileSeq++;
    if (this.profileReturn === 'leaderboard') this.showLeaderboard();
    else this.showTitle();
  }

  /** Profil (Bestand): Kopf + Bestzeiten je Level, gefüllt von loadProfile. */
  private buildProfile(): HTMLElement {
    const mine = this.profileUid === null || this.profileUid === this.online?.myUid();
    const on = this.online;
    const body = h('div', 'vel-panel vel-profile-body', h('p', 'vel-hint', on ? 'Lade …' : 'Offline — kein Profil.'));
    const login = mine && on?.loginRequired && on.myUid() === null ? h('div', 'vel-hint vel-board-who vel-board-who--out', h('span', '', 'Nicht angemeldet — dein Profil braucht den Discord-Login.'), this.discordButton()) : null;
    return h(
      'section',
      'vel-screen vel-profile-screen',
      h('div', 'vel-head-row', h('h1', 'vel-h1', mine ? 'Profil' : 'Spieler'), h('div', 'vel-row', this.btn('Zurück', 'vel-btn--small', () => this.leaveProfile(), 'Esc'))),
      login,
      body,
    );
  }

  private async loadProfile(): Promise<void> {
    const seq = ++this.profileSeq;
    const on = this.online;
    const body = (): Element | null => this.el.querySelector('.vel-profile-body');
    if (!on) return;
    const uid = this.profileUid ?? undefined;
    if (uid === undefined && on.loginRequired && on.myUid() === null) {
      body()?.replaceChildren(h('p', 'vel-hint', 'Melde dich an, um dein Online-Profil zu sehen. Deine lokalen Bestzeiten stehen in der Levelauswahl.'));
      return;
    }
    try {
      const p = await on.profile(uid);
      if (seq !== this.profileSeq || this.current !== 'profile') return;
      const rows = p.bests.map((b) => {
        const lv = this.levels.find((l) => l.id === b.levelId);
        const medal = lv?.medals ? medalFor(b.time, lv.medals) : null;
        const ghost = this.btn('Ghost', 'vel-btn--small vel-board-ghost', () => this.emit('raceGhost', { levelId: b.levelId, runId: b.runId, label: `${p.name} ${formatTime(b.time)}` }));
        ghost.dataset.lock = '1';
        return h(
          'tr',
          '',
          h('td', '', lv?.name ?? b.levelId),
          h('td', '', formatTime(b.time)),
          h('td', '', `#${b.rank} / ${b.total}`),
          h('td', '', medal !== null ? medalBadge(medal) : h('span', 'vel-dim', '—')),
          h('td', '', ghost),
        );
      });
      const since = p.memberSince ? new Date(p.memberSince).toLocaleDateString('de-DE') : '—';
      body()?.replaceChildren(
        h('div', 'vel-profile-head', pixelAvatar(p.avatarUrl, p.name, 32), playerName(p.name, p.dev, 'vel-account-name', 'b')),
        h('p', 'vel-hint', `Dabei seit ${since} · ${p.runs} ${p.runs === 1 ? 'Lauf' : 'Läufe'} · ${p.worldRecords} ${p.worldRecords === 1 ? 'Weltrekord' : 'Weltrekorde'}`),
        rows.length > 0
          ? h('table', 'vel-splits vel-board', h('thead', '', h('tr', '', h('th', '', 'Level'), h('th', '', 'Zeit'), h('th', '', 'Rang'), h('th', '', 'Medaille'), h('th', '', 'Ghost'))), h('tbody', '', ...rows))
          : h('p', 'vel-hint', 'Noch keine Bestzeit auf den aktuellen Strecken.'),
      );
    } catch (err) {
      if (seq !== this.profileSeq || this.current !== 'profile') return;
      const nf = err instanceof OnlineError && err.code === 'notFound';
      body()?.replaceChildren(h('p', 'vel-hint vel-bad', nf ? 'Spieler nicht gefunden.' : `Profil nicht geladen — ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // ------------------------------------------------------------------ Discord-Konto (Plan 009, Supabase)

  /** Konto-Zeile (nur Backends mit Login): angemeldet Avatar + Name + Abmelden, sonst "Mit Discord anmelden". */
  private accountBlock(): HTMLElement | null {
    const on = this.online;
    if (!on || !on.loginRequired) return null;
    const name = on.myName();
    if (on.myUid() === null || name === null) return h('div', 'vel-account', this.discordButton());
    const out = this.btn('Abmelden', 'vel-btn--small vel-account-out', () => on.signOut());
    return h('div', 'vel-account vel-account--in', pixelAvatar(on.myAvatar(), name, 32), playerName(name, on.myDev(), 'vel-account-name'), out);
  }

  /** Discord-Blurple-Knopf (ohne Logo, Text reicht). Kein data-lock: der Login verlässt die Seite, kein Pointer Lock. */
  private discordButton(label = 'Mit Discord anmelden'): HTMLButtonElement {
    const b = this.btn(label, 'vel-discord-btn', () => this.startSignIn());
    b.title = 'Anmeldung über Discord — du kommst danach hierher zurück';
    return b;
  }

  private nameHint(): HTMLElement {
    const on = this.online;
    if (!on || !on.loginRequired) return h('div', 'vel-setting-hint vel-online-name-hint', 'Steht in der Bestenliste. 2–16 Zeichen; leer = automatischer Name.');
    const me = on.myName();
    return me !== null && on.myUid() !== null
      ? h('div', 'vel-setting-hint vel-online-name-hint', 'Steht in der Bestenliste — jetzt: ', h('b', 'vel-mono', me), '. 2–16 Zeichen; leer = Namen behalten.')
      : h('div', 'vel-setting-hint vel-online-name-hint', 'Spielen und lokale Bestzeiten gehen ohne Konto. Zum Einreichen mit Discord anmelden.');
  }

  /** Statuszeile der Online-Einreichung im Ergebnis (Plan 009); ohne Login mit Anmelde-Knopf. */
  private onlineLine(st: OnlineStatus): HTMLElement {
    const el = h('div', `vel-online-status vel-online-status--${st.state}`, h('span', 'vel-online-label', 'Online'), h('span', 'vel-online-text', st.text));
    if (st.state === 'login' && this.online?.loginRequired) el.append(this.discordButton());
    el.dataset.state = st.state;
    el.setAttribute('role', 'status');
    return el;
  }

  /** Beschriftung der Vorführungs-Taste (KeyBinds.demo) für Pause und Liste. */
  setDemoKey(label: string): void {
    this.demoKey = label;
  }

  /** Lektionsliste (aus dem Titel oder nach einer Lektion). */
  showTraining(): void {
    if ((this.current === 'title' || this.current === 'lessonDone' || this.current === null) && this.delegate({ view: 'training' })) return;
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
    const style = this.menuStyle;
    if (style === 'classic') this.render('title', this.buildTitle());
    else if (this.door?.id === style && this.current === 'title') this.updateDoor();
    else this.renderDoor(style);
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
    this.updateDoor();
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
    if (this.current === 'title' && this.delegate({ view: 'cosmetics' })) return;
    this.render('cosmetics', this.buildCosmetics());
  }

  /**
   * Admin-Menü (Freischaltungen und Medaillen von Hand setzen): aus Titel oder Pause,
   * über den Knopf im System-Panel oder F8. Kein Passwort — Einzelspieler.
   */
  showAdmin(): void {
    if (!this.adminAllowed) return;
    if (this.current === 'title' || this.current === 'pause') this.adminReturn = this.current;
    this.render('admin', this.buildAdmin());
  }

  showControls(): void {
    if (this.current && this.current !== 'settings' && this.current !== 'controls') this.returnTo = this.current;
    this.render('controls', this.buildControls());
  }

  hide(): void {
    this.unmountDoor();
    this.stopPreview();
    this.endCapture();
    this.endPadCapture();
    this.dropNotice();
    // Ein wartender Login bleibt gemerkt (render hängt den Hinweis beim nächsten Screen wieder an).
    for (const c of this.screenCleanups) c();
    this.screenCleanups = [];
    this.padRefreshers = [];
    this.nav.setRoot(null);
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
    if (this.loginWait) return this.loginWaitAction(a);
    // Pad-Richtungen (PadInput im Menü-Kontext, mit Wiederholung) gehören immer dem Menü, auch während der
    // Ergebnis-Sperre (nur Fokus, kein Auslösen).
    switch (a) {
      case 'navUp':
        this.padNavigate(0, -1);
        return true;
      case 'navDown':
        this.padNavigate(0, 1);
        return true;
      case 'navLeft':
        this.padNavigate(-1, 0);
        return true;
      case 'navRight':
        this.padNavigate(1, 0);
        return true;
      default:
        break;
    }
    if (performance.now() < this.guardUntil) return true;
    // Titel mit Front Door: der Stil meldet selbst (sonst doppelt bzw. falsch, z. B. Esc ohne Wirkung).
    // Esc ohne Wirkung (Pause: Weiter nur per Klick/Enter, Klassik-Titel) bleibt still.
    if (this.current !== 'title' || this.menuStyle === 'classic') {
      if (a === 'pause' && this.current !== 'pause' && this.current !== 'title') menuSound('back');
      else if (a === 'confirm') menuSound('confirm');
    }
    if (a === 'tabPrev' || a === 'tabNext') {
      this.padTab(a === 'tabPrev' ? -1 : 1);
      return true;
    }
    // Lock-Versuch läuft: Enter/R-Spam nicht als neue Anfragen durchreichen (Chrome drosselt).
    if (this.lockStatus.pending && (a === 'confirm' || a === 'restart')) return true;
    if (this.padMode) {
      // Pad: A klickt den sichtbaren Fokus (sonst wüsste man nicht, was A tut).
      if (a === 'confirm' && this.padConfirm()) return true;
      if (a === 'pause') {
        // B in einem Textfeld: nur das Feld verlassen.
        const ae = document.activeElement;
        if ((ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) && this.el.contains(ae)) {
          ae.blur();
          return true;
        }
        if (this.padCapture) {
          this.endPadCapture();
          return true;
        }
        // Pause: B/Start = weiter (am Pad braucht es keinen Pointer Lock, Plan 011 §2.2.6).
        if (this.current === 'pause') {
          menuSound('back');
          this.emit('resume', undefined);
          return true;
        }
      }
    }
    switch (this.current) {
      case 'title':
        if (this.menuStyle !== 'classic') {
          // Front Door: Enter/Esc/R gehen an den Stil (er lauscht nicht selbst darauf, sonst doppelt).
          const fa = a === 'confirm' ? 'confirm' : a === 'pause' ? 'back' : a === 'restart' ? 'restart' : null;
          if (fa !== null) this.door?.inst.onAction?.(fa);
        } else if (a === 'confirm') this.playSelected();
        return true;
      case 'lab':
        if (a === 'pause' || a === 'confirm') this.leaveLab();
        return true;
      case 'profile':
        if (a === 'pause' || a === 'confirm') this.leaveProfile();
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
        else if (a === 'confirm') {
          // Trainings-Tipp ist der Primärknopf: Enter führt dorthin, nicht ins nächste Level.
          const tip = r ? this.trainingTip(r) : null;
          if (tip) this.emit('play', { levelId: tip.id });
          else this.emit(r?.hasNext ? 'nextLevel' : 'restart', undefined);
        } else if (a === 'pause') this.emit('toTitle', undefined);
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
      case 'leaderboard':
        if (a === 'pause' || a === 'confirm') this.leaveBoard();
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
    this.unmountDoor();
    this.stopPreview();
    this.unsubscribe();
    this.padUnsub?.();
    this.endPadCapture();
    this.nav.dispose();
    this.doorNav.dispose();
    this.endCapture();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keydown', this.onCaptureKey, true);
    window.removeEventListener('mousedown', this.onCaptureMouse, true);
    window.removeEventListener('mouseup', this.onSuppressMouse, true);
    window.removeEventListener('auxclick', this.onSuppressMouse, true);
    window.removeEventListener('contextmenu', this.onSuppressMouse, true);
    document.removeEventListener('fullscreenerror', this.onFullscreenError);
    this.modeUnsub?.();
    this.modeUnsub = null;
    window.clearTimeout(this.noticeTimer);
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
    this.endPadCapture();
    for (const c of this.screenCleanups) c();
    this.screenCleanups = this.nextCleanups;
    this.nextCleanups = [];
    this.padRefreshers = this.nextPadRefreshers;
    this.nextPadRefreshers = [];
    // Derselbe Screen neu gebaut (Daten) → Pad-Fokus wiederfinden statt auf den Start zu springen.
    const same = id === this.current;
    if (id !== 'admin') this.adminRefresh = null;
    // Jeder andere Screen (auch ein neuer Titel) baut die Front Door ab.
    if (this.door && this.door.root !== screen) this.unmountDoor();
    this.current = id;
    this.el.dataset.screen = id;
    this.el.replaceChildren(screen);
    this.el.hidden = false;
    this.applyLockStatus();
    if (pending) this.previewStop = pending();
    // Fokus nicht automatisch auf Buttons: eine Leertaste aus dem Spiel würde sie sonst auslösen.
    const active = document.activeElement;
    if (active instanceof HTMLElement && !this.el.contains(active) && active !== document.body) active.blur();
    // Pad-Fokus: Front Door bekommt ihren eigenen Bereich (renderDoor), Bestands-Screens den Screen — außer während eines
    // wartenden Logins: dann bleibt er im Hinweis (der Screen darunter ist inert).
    const isDoor = screen.classList.contains('vel-frontdoor');
    const wait = this.loginWait;
    this.nav.setRoot(wait ?? (isDoor ? null : screen), wait !== null || same);
    if (!isDoor) refreshGlyphs(screen, (p) => this.glyphs(p));
    this.attachLayers();
    if (this.padMode && (wait !== null || !isDoor)) this.nav.ensure();
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

  /** Ziel eines Menü-Klangs: bedienbarer Knopf/Feld im Menü, sonst null. */
  private soundTarget(t: EventTarget | null): HTMLElement | null {
    if (!(t instanceof Element)) return null;
    const el = t.closest<HTMLElement>('button, a[href], input, select, [role="button"], [tabindex]:not([tabindex="-1"])');
    if (el === null || !this.el.contains(el)) return null;
    if (el instanceof HTMLButtonElement && el.disabled) return null;
    return el;
  }

  private soundHover: HTMLElement | null = null;

  private readonly onSoundFocus = (e: FocusEvent): void => {
    const el = this.soundTarget(e.target);
    if (el === null || el === this.soundHover) return;
    this.soundHover = el;
    menuSound('move');
  };

  private readonly onSoundHover = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    const el = this.soundTarget(e.target);
    if (el === null || el === this.soundHover) return;
    this.soundHover = el;
    menuSound('move');
  };

  private readonly onSoundClick = (e: MouseEvent): void => {
    const el = this.soundTarget(e.target);
    if (el === null || (el instanceof HTMLInputElement && el.type === 'range')) return;
    const back = el.querySelector('[data-glyph="back"]') !== null || /^\s*Zurück/.test(el.textContent ?? '');
    menuSound(back ? 'back' : 'confirm');
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // F8: Admin-Menü aus Titel/Pause auf und wieder zu. Hier statt als InputAction: reine
    // Menü-Navigation; im Spiel (Pointer Lock) ist das Menü unsichtbar und F8 tut nichts.
    if (e.code === 'F8' && this.visible && !e.repeat && this.capture === null && this.adminAllowed) {
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
    // Front Door: Pfeiltasten gehören dem Stil.
    if (this.current === 'title' && this.menuStyle !== 'classic') return;
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
    if (this.loginWait !== null && this.visible) {
      // Wartender Login ist modal: Pfeile/Buchstaben/Ziffern nicht an Front Door, Titel-Liste oder Engine.
      // Leertaste/Enter nur auf Knöpfen IM Hinweis: arcade löst sie sonst selbst aus (click() wirkt auch auf inert).
      const t = e.target;
      const activates = e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter';
      if (!LOGIN_WAIT_KEYS.test(e.code) || (activates && !(t instanceof Node && this.loginWait.contains(t)))) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (this.padCapture && !this.capture && e.code === 'Escape') {
      // Pad-Belegung per Tastatur abbrechen — Esc darf dann nicht noch "Zurück" auslösen.
      e.preventDefault();
      e.stopImmediatePropagation();
      this.endPadCapture();
      return;
    }
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

  // ------------------------------------------------------------------ Controller (Plan 011 §1.7)

  /** Familie für Pad-Anzeigen (Belegung, Steuerung) — auch wenn gerade die Tastatur benutzt wird. */
  private padFamily(): 'xbox' | 'playstation' {
    const f = this.family;
    if (f !== 'keyboard') return f;
    return this.pad?.get().glyphs === 'playstation' ? 'playstation' : 'xbox';
  }

  private startPadCapture(action: PadBindAction, slot: number, b: HTMLButtonElement): void {
    const same = this.padCapture?.button === b;
    this.endPadCapture();
    this.endCapture();
    if (same) return; // zweiter Druck auf dasselbe Feld = abbrechen
    const dev = this.padDevice;
    // Ohne Pad wartete das Feld auf einen Knopf, den es nicht gibt (Review B1) — die Felder sind dann gesperrt
    // (padTest), das hier fängt einen Klick vor dem nächsten Frame ab.
    if (!dev || !dev.connected) return;
    b.textContent = 'Knopf …';
    b.setAttribute('aria-pressed', 'true');
    let stop: () => void = () => undefined;
    this.padCapture = { button: b, stop: () => stop() };
    stop = dev.captureButton((code) => {
      // Abbruch/Zeit (null) oder Knopf: Aufnahme ist im InputManager schon vorbei.
      stop = () => undefined;
      this.endPadCapture();
      // Start/Menu bleibt Pause, Home gehört dem System.
      if (code !== null && isBindablePadCode(code) && code !== 'PadMenu') this.assignPadBind(action, slot, code);
    });
  }

  private endPadCapture(): void {
    const c = this.padCapture;
    if (!c) return;
    this.padCapture = null;
    c.stop();
    for (const r of this.padRefreshers) r();
  }

  /** Knopf einer Aktion zuweisen (null = Platz leeren); derselbe Knopf verschwindet aus den anderen Aktionen. */
  private assignPadBind(action: PadBindAction, slot: number, code: PadButtonCode | null): void {
    const store = this.pad;
    if (!store) return;
    const b = store.get().binds;
    const next: Record<PadBindAction, PadButtonCode[]> = {
      jump: [...b.jump],
      crouch: [...b.crouch],
      sprint: [...b.sprint],
      respawn: [...b.respawn],
      demo: [...b.demo],
      restart: [...b.restart],
      pause: [...b.pause],
    };
    if (code !== null) for (const a of PAD_BIND_ROWS) next[a] = next[a].filter((c) => c !== code);
    const list = next[action];
    if (code === null) {
      if (slot < list.length) list.splice(slot, 1);
    } else if (slot < list.length) list[slot] = code;
    else list.push(code);
    store.update({ binds: next });
    for (const r of this.padRefreshers) r();
  }

  /** Belegungszeile "Springen: [LB] [A]" — Feld drücken, dann Pad-Knopf. */
  private padBindRow(action: PadBindAction, label: () => string): HTMLElement {
    const wrap = h('div', 'vel-seg vel-bind vel-pad-bind');
    const buttons = [0, 1].map((slot) => {
      const b = h('button', 'vel-btn', '');
      b.type = 'button';
      b.dataset.padBind = `${action}.${slot}`;
      b.addEventListener('click', () => this.startPadCapture(action, slot, b));
      wrap.append(b);
      return b;
    });
    const r = row(label(), wrap, null);
    const labelEl = r.querySelector('.vel-setting-label');
    const refresh = (): void => {
      const list = this.pad?.get().binds[action] ?? [];
      const fam = this.padFamily();
      buttons.forEach((b, i) => {
        if (this.padCapture?.button === b) return;
        const c = list[i];
        b.replaceChildren(c !== undefined ? glyphNode(padCodeGlyph(c, fam)) : '—');
        b.title = c !== undefined ? padCodeGlyph(c, fam).name : 'frei';
        b.setAttribute('aria-pressed', 'false');
      });
      if (labelEl) labelEl.textContent = label();
    };
    refresh();
    this.nextPadRefreshers.push(refresh);
    return r;
  }

  /** Regler für eine Pad-Zahl (Grenzen aus PAD_LIMITS, der Store klemmt). */
  private padRange(label: string, key: PadNumKey, step: number, fmt: (v: number) => string): HTMLElement {
    const [min, max] = PAD_LIMITS[key];
    const input = h('input', 'vel-range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', label);
    input.dataset.pad = key;
    const value = h('span', 'vel-setting-value');
    const refresh = (): void => {
      const v = this.pad?.get()[key] ?? min;
      input.value = String(v);
      input.style.setProperty('--fill', `${((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100}%`);
      value.textContent = fmt(v);
    };
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) this.pad?.update(numPatch(key, v));
    });
    refresh();
    this.nextPadRefreshers.push(refresh);
    return row(label, input, value);
  }

  private padToggle(label: string, get: (s: PadSettings) => boolean, set: (v: boolean) => PadSettingsPatch): HTMLElement {
    const b = h('button', 'vel-btn vel-toggle');
    b.type = 'button';
    const refresh = (): void => {
      const on = this.pad ? get(this.pad.get()) : false;
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? 'An' : 'Aus';
    };
    b.addEventListener('click', () => {
      if (this.pad) this.pad.update(set(!get(this.pad.get())));
    });
    refresh();
    this.nextPadRefreshers.push(refresh);
    return row(label, b, null);
  }

  private padSegmented<T extends string>(label: string, options: readonly { readonly value: T; readonly label: string }[], get: () => T | null, set: (v: T) => void): HTMLElement {
    const wrap = h('div', 'vel-seg');
    const buttons = options.map((opt) => {
      const b = h('button', 'vel-btn', opt.label);
      b.type = 'button';
      b.addEventListener('click', () => set(opt.value));
      wrap.append(b);
      return b;
    });
    const refresh = (): void => {
      const v = get();
      options.forEach((opt, i) => buttons[i].setAttribute('aria-pressed', String(opt.value === v)));
    };
    refresh();
    this.nextPadRefreshers.push(refresh);
    return row(label, wrap, null);
  }

  /**
   * Stick-Test (Plan 011 §1.7): beide Sticks als 24×24-Pixel-Raster (ganzzahlig ×2 hoch), Ringe = Deadzone innen/außen,
   * Punkt = Rohwert, cyan sobald er die Deadzone verlässt. Läuft nur, solange Einstellungen offen sind; meldet dabei
   * jeden Wechsel "Pad verbunden" ⇄ "keins" an onConnected (auch einmal zu Beginn).
   */
  private padTest(onConnected: (connected: boolean) => void): HTMLElement {
    const S = 24;
    const canvas = h('canvas', 'vel-pad-test');
    canvas.width = S * 2 + 4;
    canvas.height = S;
    const state = h('span', 'vel-pad-state', '');
    const g = canvas.getContext('2d');
    let bg: ImageData | null = null;
    let bgSig = '';
    const ringBg = (inner: number, outer: number): ImageData | null => {
      if (!g) return null;
      const img = g.createImageData(canvas.width, canvas.height);
      const put = (x: number, y: number, r: number, gg: number, b: number): void => {
        const i = (y * canvas.width + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = gg;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      };
      for (let k = 0; k < 2; k++) {
        const ox = k * (S + 4);
        for (let y = 0; y < S; y++) {
          for (let x = 0; x < S; x++) {
            const d = Math.hypot(x + 0.5 - S / 2, y + 0.5 - S / 2) / (S / 2 - 0.5);
            if (Math.abs(d - outer) < 0.06 || Math.abs(d - 1) < 0.05) put(ox + x, y, 0x6a, 0x72, 0xa8);
            else if (Math.abs(d - inner) < 0.07 && inner > 0.02) put(ox + x, y, 0xff, 0x3f, 0xd0);
            else if (d < 1) put(ox + x, y, 0x0b, 0x08, 0x20);
          }
        }
      }
      return img;
    };
    let raf = 0;
    let lastState = '';
    let lastConn: boolean | null = null;
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const p = this.pad?.get();
      const dev = this.padDevice;
      const conn = dev?.connected === true;
      if (conn !== lastConn) {
        lastConn = conn;
        onConnected(conn);
      }
      if (!g || !p) return;
      const sig = `${p.deadzoneInner}/${p.deadzoneOuter}`;
      if (sig !== bgSig) {
        bg = ringBg(p.deadzoneInner, p.deadzoneOuter);
        bgSig = sig;
      }
      if (bg) g.putImageData(bg, 0, 0);
      const st = dev?.connected ? 'Pad verbunden — Sticks bewegen' : 'Kein Controller — einstecken und eine Taste drücken';
      if (st !== lastState) {
        state.textContent = st;
        lastState = st;
      }
      if (!dev) return;
      const dot = (k: number, x: number, y: number, inner: number): void => {
        const m = Math.hypot(x, y);
        const cx = k * (S + 4) + Math.round(S / 2 - 0.5 + Math.max(-1, Math.min(1, x)) * (S / 2 - 1.5));
        const cy = Math.round(S / 2 - 0.5 + Math.max(-1, Math.min(1, y)) * (S / 2 - 1.5));
        g.fillStyle = m > inner ? '#33f0ff' : '#eef1ff';
        g.fillRect(cx - 1, cy - 1, 3, 3);
      };
      dot(0, dev.sticks.lx, dev.sticks.ly, p.moveDeadzone);
      dot(1, dev.sticks.rx, dev.sticks.ry, p.deadzoneInner);
    };
    raf = requestAnimationFrame(frame);
    this.nextCleanups.push(() => cancelAnimationFrame(raf));
    return h('div', 'vel-pad-test-row', canvas, h('span', 'vel-pad-test-text', h('small', '', 'Links Laufen · Rechts Blick'), state));
  }

  /** Einstellungen → Controller: Kamera, Deadzone, Kurve, Symbole, Belegung + Presets, Stick-Test. */
  private buildPadPanel(): HTMLElement {
    const store = this.pad;
    const panel = h('div', 'vel-panel vel-pad-panel', h('h2', 'vel-h2', 'Controller'));
    if (!store) {
      panel.append(h('p', 'vel-hint', 'Controller-Unterstützung fehlt in diesem Build.'));
      return panel;
    }
    const deg = (v: number): string => `${Math.round(v)}°/s`;
    const yaw = this.padRange('Kamera X', 'yawRate', 10, deg);
    yaw.querySelector('input')?.setAttribute('data-pad-initial', '');
    // Belegen geht nur mit verbundenem Pad (Review B1): Felder sperren und sagen, warum. Chrome zeigt ein Pad erst nach
    // dem ersten Druck — darum "eine Taste drücken".
    const noPad = h('p', 'vel-setting-hint vel-pad-bind-state', 'Kein Controller verbunden — einstecken und eine Taste am Pad drücken, dann lässt sich belegen.');
    noPad.setAttribute('role', 'status');
    const onConnected = (conn: boolean): void => {
      noPad.hidden = conn;
      for (const b of panel.querySelectorAll<HTMLButtonElement>('button[data-pad-bind]')) {
        b.disabled = !conn;
        if (!conn && this.padCapture?.button === b) this.endPadCapture();
      }
    };
    panel.append(
      this.padTest(onConnected),
      yaw,
      this.padRange('Kamera Y', 'pitchRate', 10, deg),
      h('div', 'vel-setting-hint', 'Drehrate (links/rechts, hoch/runter) bei vollem Ausschlag. Zum Strafen hoch lassen — langsames Drehen kostet in der Luft Tempo.'),
      this.padToggle('Y invertieren', (p) => p.invertY, (v) => ({ invertY: v })),
      this.padRange('Deadzone innen', 'deadzoneInner', 0.01, PERCENT),
      this.padRange('Deadzone Rand', 'deadzoneOuter', 0.01, PERCENT),
      this.padRange('Antwortkurve', 'curve', 0.1, (v) => `^${v.toFixed(1)}`),
      h('div', 'vel-setting-hint', '1.0 = linear. Höher = feiner um die Mitte, schnell am Rand. Keine Glättung, keine Verzögerung. Deadzone Rand: ab hier zählt voller Ausschlag.'),
      this.padRange('Dreh-Boost', 'boost', 0.05, (v) => (v > 0 ? `+${Math.round(v * 100)}%` : 'aus')),
      h('div', 'vel-setting-hint', 'Dreh-Boost: Stick am Rand gehalten dreht nach kurzer Zeit schneller (für 180°-Wenden).'),
      this.padRange('Diagonal-Band', 'diagonalBand', 1, (v) => `${Math.round(v)}°`),
      h('div', 'vel-setting-hint', 'Der Bewegungs-Stick ist digital wie ', mono('WASD'), ' (immer volles Tempo). Schräg nur in diesem Winkel — kleiner = sauberes ', mono('A'), '/', mono('D'), '.'),
      this.padSegmented<GlyphStyle>(
        'Tasten-Symbole',
        [
          { value: 'auto', label: 'Auto' },
          { value: 'xbox', label: 'Xbox' },
          { value: 'playstation', label: 'PlayStation' },
        ],
        () => store.get().glyphs,
        (v) => store.update({ glyphs: v }),
      ),
      h('div', 'vel-setting-hint', 'Auto erkennt das Pad. Unter Steam Input meldet sich oft jedes Pad als Xbox — dann hier festlegen.'),
      h('h3', 'vel-h3', 'Belegung'),
      noPad,
      this.padSegmented<'bumper' | 'classic'>(
        'Vorlage',
        [
          { value: 'bumper', label: 'Bumper-Sprung' },
          { value: 'classic', label: 'Klassisch' },
        ],
        () => padPresetOf(store.get().binds),
        (v) => store.applyPreset(v),
      ),
      this.padBindRow('jump', () => 'Springen'),
      this.padBindRow('crouch', () => 'Ducken'),
      this.padBindRow('sprint', () => (this.settings.get().autoSprint ? 'Langsamer' : 'Sprint')),
      this.padBindRow('respawn', () => 'Checkpoint'),
      this.padBindRow('demo', () => 'Vorführung'),
      this.padBindRow('restart', () => 'Neustart'),
      h(
        'div',
        'vel-setting-hint',
        // Frist aus dem Pad-Kern (PadInput zählt sie herunter) — nie als Zahl hier, sonst läuft der Text davon.
        `Feld wählen, dann Knopf drücken (${PAD_CAPTURE_TIMEOUT} s; B halten, Start oder Esc bricht ab). `,
        'Neustart: Knopf kurz halten. Bumper-Sprung: Sprung auf der Schulter, der Daumen bleibt am Kamera-Stick. Start = Pause.',
      ),
      h('div', 'vel-row', this.btn('Controller-Standard', 'vel-btn--small', () => store.reset())),
    );
    // Sofort richtig (nicht erst im ersten Frame des Stick-Tests): sonst ginge ein Klick in dieses Fenster durch.
    onConnected(this.padDevice?.connected === true);
    return panel;
  }

  /** Steuerung: Pad-Belegung als Glyphen-Liste (folgt Familie und Belegung). */
  private buildPadControls(): HTMLElement {
    const dl = h('dl', 'vel-keys vel-pad-keys');
    const fill = (): void => {
      const fam = this.padFamily();
      const binds = this.pad?.get().binds ?? PAD_PRESETS.bumper;
      const caps = (codes: readonly PadButtonCode[]): HTMLElement[] => codes.map((c) => glyphNode(padCodeGlyph(c, fam)));
      const auto = this.settings.get().autoSprint;
      const rows: [HTMLElement[], string][] = [
        [[glyphNode(stickGlyph('L', fam))], 'Laufen und Strafen — 8 Richtungen, immer volles Tempo'],
        [[glyphNode(stickGlyph('R', fam))], 'Blick — Drehrate, einstellbar unter Einstellungen → Controller'],
        [caps(binds.jump), 'Springen — halten = Auto-Hop'],
        [caps(binds.crouch), 'Ducken'],
        [caps(binds.sprint), auto ? 'Langsamer laufen' : 'Sprint'],
        [caps(binds.respawn), 'Zurück zum letzten Checkpoint'],
        [caps(binds.demo), 'Training: Vorführung'],
        [caps(binds.restart), 'Neustart — kurz halten'],
        [caps(binds.pause), 'Pause'],
        [[...promptGlyphs('nav', fam, { demoKey: this.demoKey, padBinds: binds }).map(glyphNode), glyphNode(padCodeGlyph('PadA', fam)), glyphNode(padCodeGlyph('PadB', fam))], 'Menü: wählen, OK, zurück'],
        [[glyphNode(padCodeGlyph('PadLB', fam)), glyphNode(padCodeGlyph('PadRB', fam))], 'Menü: Reiter / Abschnitt wechseln'],
      ];
      dl.replaceChildren();
      for (const [ks, what] of rows) dl.append(h('dt', '', ...(ks.length > 0 ? ks : [h('span', 'vel-dim', '—')])), h('dd', 'vel-text', what));
    };
    fill();
    this.nextPadRefreshers.push(fill);
    return h(
      'div',
      'vel-panel vel-pad-controls',
      h('h2', 'vel-h2', 'Controller'),
      dl,
      h('p', 'vel-hint', 'Mit Pad braucht das Spiel keine gefangene Maus. Ein Mausklick ins Spiel schaltet zurück auf Maus.'),
    );
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

  /**
   * Tasten-Kappe eines Knopfs. Bekannte Kürzel werden zum Hinweis (data-glyph) und wechseln mit dem Gerät zu A/B bzw.
   * ✕/○ — dieselbe Kappe, damit Stil-CSS wie ps2s Prompt-Leiste (`.vel-btn:has(> .vel-kbd)`) weiter greift.
   */
  private kbd(label: string): HTMLElement {
    const p: FrontDoorPrompt | null =
      label === 'Esc' ? 'back' : label === 'Enter' ? 'confirm' : label === 'R' ? 'restart' : label === 'F' ? 'respawn' : label === this.demoKey ? 'demo' : null;
    const s = h('span', 'vel-kbd', label);
    if (p !== null) {
      s.dataset.glyph = p;
      fillGlyphs(s, this.glyphs(p));
    } else s.dataset.kbdOnly = '1'; // F8 & Co.: gibt es am Pad nicht (CSS blendet aus)
    return s;
  }

  private btn(label: Child, cls: string, onClick: () => void, kbd?: string): HTMLButtonElement {
    const b = h('button', `vel-btn ${cls}`.trim(), h('span', '', label), kbd ? this.kbd(kbd) : null);
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
      const prep = this.prepText(lv);
      const b = h(
        'button',
        `vel-btn vel-level${i === this.selected ? ' is-selected' : ''}`,
        h('span', 'vel-level-num', String(i + 1).padStart(2, '0')),
        h(
          'span',
          'vel-level-name',
          listName(lv.name),
          lv.subtitle ? h('span', 'vel-level-sub', lv.subtitle) : null,
          prep ? h('span', 'vel-level-prep', prep) : null,
        ),
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
      h('span', 'vel-start-main', this.startMain()),
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
      this.accountBlock(),
      trainingBtn,
      this.btn('Bestenliste', 'vel-board-btn', () => this.showLeaderboard(this.selectedLevelId ?? undefined)),
      this.btn('Einstellungen', '', () => this.showSettings()),
      this.btn('Kosmetik', 'vel-cosmetics-btn', () => this.showCosmetics()),
      this.btn('Steuerung', '', () => this.showControls()),
      this.btn('Vollbild', '', () => this.requestFullscreen()),
      h(
        'p',
        'vel-tip',
        h('strong', '', 'Tipp: '),
        'In der Luft W loslassen, A oder D halten und die Maus flüssig in dieselbe Richtung ziehen.',
      ),
      // Bewusst unauffällig: klein, gedämpft, ganz unten — ein Werkzeug, kein Spielinhalt.
      h(
        'div',
        'vel-row vel-side-tools',
        this.adminAllowed ? this.btn('Admin', 'vel-btn--small vel-admin-btn', () => this.showAdmin(), 'F8') : null,
        this.btn('Menü-Labor', 'vel-btn--small vel-lab-btn', () => this.showLab()),
      ),
      this.platform.caps.quit ? this.quitBtn('Beenden', '') : null,
    );

    return h(
      'section',
      'vel-screen vel-title-screen',
      h('div', '', h('h1', 'vel-logo', 'VELOCITY'), h('div', 'vel-logo-bar'), h('p', 'vel-subtitle', 'Bunnyhop · Air-Strafe · Surf — Neon-Parcours mit 128 Tick')),
      h('div', 'vel-title-grid', h('div', 'vel-col', band, levelPanel, start, this.lockHint('')), side),
    );
  }

  /**
   * "Empfohlen: T7/T8" (Plan 007 I3, LevelIndexEntry.prepLessons): Lektionen, die das Level voraussetzt
   * (L3 Surfen, L4 Crouch-Jump + Surfen) — nur solange eine davon noch keinen Stern hat, danach null.
   */
  private prepText(lv: LevelIndexEntry): string | null {
    const ids = lv.prepLessons ?? [];
    if (ids.length === 0) return null;
    const lessons = this.training?.lessons() ?? [];
    const open = ids.filter((id) => (this.training?.stars(id) ?? 0) === 0);
    if (open.length === 0) return null;
    const short = (id: string): string => lessons.find((l) => l.id === id)?.short ?? id.toUpperCase();
    return `Empfohlen: ${open.map(short).join('/')}`;
  }

  /**
   * Trainings-Tipp im Ergebnis (E2E-Review v2final): Wer ein Level ohne jede Medaille beendet (auch die Bestzeit hat
   * keine), bekommt die erste Lektion ohne Stern angeboten — erst die Vorbereitung des Levels (prepLessons, L3/L4),
   * dann Air-Strafe und Speed. Ein Neuling mit W + Leertaste kam auf L1 in 50–58 s an (Bronze 33) und landete per
   * Enter im nächsten Level; der einzige Hinweis aufs Training war ein Coach-Satz 5 s nach dem Start.
   */
  private trainingTip(r: FinishResult): TrainingIndexEntry | null {
    const t = this.training;
    if (!t?.playable || !r.medals) return null;
    const best = r.isBest || r.previousBest === null ? r.time : Math.min(r.time, r.previousBest);
    if (medalFor(best, r.medals) !== null) return null;
    const prep = this.levels.find((l) => l.id === r.levelId)?.prepLessons ?? [];
    const lessons = t.lessons();
    for (const id of [...prep, ...TIP_LESSONS]) {
      const e = lessons.find((l) => l.id === id);
      if (e && t.stars(id) === 0) return e;
    }
    return null;
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
      h('span', 'vel-start-main', this.startMain()),
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
        group('basics', 'Grundlagen', 'bestanden → Fidget-Spinner'),
        group('advanced', 'Fortgeschritten', 'alles bestanden → Roboter-Hand'),
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
        this.platform.caps.quit ? this.quitBtn('Spiel beenden', '') : null,
      ),
      this.lockHint('Die Maus ist frei. Klick auf „Weiter“, um zurück ins Spiel zu kommen.'),
    );
    return screen;
  }

  // ------------------------------------------------------------------ Ergebnis

  private buildFinish(r: FinishResult): HTMLElement {
    const tip = this.trainingTip(r);
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
      if (tip) box.append(h('div', 'vel-hint vel-train-tip', `Mehr Tempo: Training ${tip.short} · ${tip.name}`));
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
    // Trainings-Tipp (ohne Medaille, Lektion ohne Stern): das Training ist der Primärknopf, der Rest bleibt erreichbar.
    const train = tip ? this.btn(`Training ${tip.short}`, 'vel-btn--primary vel-train-go', () => this.emit('play', { levelId: tip.id }), 'Enter') : null;
    if (train) train.dataset.lock = '1';
    const next = r.hasNext ? this.btn('Nächstes Level', tip ? '' : 'vel-btn--primary', () => this.emit('nextLevel', undefined), tip ? undefined : 'Enter') : null;
    if (next) next.dataset.lock = '1';
    const again = r.hasNext || tip
      ? this.btn('Nochmal', '', () => this.emit('restart', undefined), 'R')
      : this.btn('Nochmal', 'vel-btn--primary vel-again', () => this.emit('restart', undefined), 'Enter');
    again.dataset.lock = '1';

    const head = [
      h('h1', 'vel-h1', 'Ziel', h('span', 'vel-dim', `· ${r.levelName}`)),
      h('p', 'vel-finish-time', formatTime(r.time)),
      r.isBest ? h('div', 'vel-record', 'NEUE BESTZEIT!') : null,
      // Online-Status im Kopf (neben dem Freischalt-Banner ist dort Platz) — eine eigene Zeile schob die Knöpfe bei 720p aus dem Bild.
      r.online ? this.onlineLine(r.online) : null,
    ];
    // Ziel-Foto (Handy, Plan 007 I3): Polaroid rechts neben der Zeit, sonst wie bisher.
    const headBlock = r.photo ? h('div', 'vel-finish-head', h('div', 'vel-finish-head-main', ...head), polaroid(r, r.photo)) : h('div', 'vel-finish-headcol', ...head);
    return h(
      'section',
      ((r.unlocked ?? []).length > 0 ? 'vel-screen vel-finish-screen vel-finish-screen--unlock' : 'vel-screen vel-finish-screen') +
        (r.photo ? ' vel-finish-screen--photo' : ''),
      // Kopf und Freischalt-Banner in einer Hülle: sonst `display: contents` (Layout wie bisher), in niedrigen Fenstern
      // nebeneinander — bei 1280×720 lagen die Knöpfe sonst bis 340 px unter dem Rand (menu.css, max-height 800px).
      h('div', 'vel-finish-top', headBlock, this.unlockBanner(r.unlocked ?? [])),
      stats,
      splits,
      h(
        'div',
        'vel-row',
        train,
        again,
        next,
        r.online ? this.btn('Bestenliste', 'vel-board-btn', () => this.showLeaderboard(r.levelId)) : null,
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
  /** Handschuhe + Gegenstände für Front Doors — dieselben Regeln wie die Kacheln in buildCosmetics. */
  private cosmeticLists(): { readonly gloves: readonly FrontDoorCosmetic[]; readonly items: readonly FrontDoorCosmetic[] } {
    const eff = this.effectiveCosmetics(this.settings.get());
    const byLadder = (id: UnlockId | null): number => (id === null ? -1 : UNLOCKS.findIndex((u) => u.id === id));
    const one = (kind: 'glove' | 'item', id: string, lock: UnlockId | null, fallback: string, implemented: boolean, equipped: boolean): FrontDoorCosmetic => {
      const unlocked = lock === null || this.unlocks.has(lock);
      const cond = !unlocked && lock !== null ? this.unlockCompact(lock) : null;
      return {
        kind,
        id,
        name: lock === null ? fallback : unlockDef(lock).name,
        unlocked,
        implemented,
        condition: cond ? (cond.el.textContent ?? '') : null,
        conditionLong: !unlocked && lock !== null ? this.unlockCondition(lock) : null,
        progress: cond?.progress ?? null,
        equipped: unlocked && implemented && equipped,
      };
    };
    const gloves = [...GLOVE_IDS].sort((a, b) => byLadder(gloveUnlock(a)) - byLadder(gloveUnlock(b))).map((g) => one('glove', g, gloveUnlock(g), 'Standard', hasSkin(g), eff.glove === g));
    const items = [...HELD_ITEM_IDS]
      .sort((a, b) => byLadder(itemUnlock(a)) - byLadder(itemUnlock(b)))
      .map((i) => one('item', i, itemUnlock(i), 'Nichts', i === 'none' || (hasItemView(i) && hasPropTricks(i)), eff.item === i));
    return { gloves, items };
  }

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

    // --- Training (Plan 007): Sterne je Lektion setzen (0 … ★★★, auch senken); Freischaltungen über die Ableitung.
    const t = this.training;
    const STAR_OPTS: readonly LessonStars[] = [0, 1, 2, 3];
    const setLesson = (id: string, n: LessonStars, note: HTMLElement): boolean => {
      if (!t || !t.setStars(id, n)) {
        note.textContent = 'nicht geladen';
        return false;
      }
      return true;
    };
    const lessonRows = (t ? t.lessons() : []).map((lv) => {
      const stars = h('span', 'vel-admin-time vel-stars', '');
      const wrap = h('div', 'vel-seg vel-admin-seg vel-admin-stars');
      const buttons = STAR_OPTS.map((n) => {
        const b = h('button', 'vel-btn vel-admin-star', n === 0 ? 'keine' : STAR_ON.repeat(n));
        b.type = 'button';
        b.dataset.lesson = lv.id;
        b.dataset.stars = String(n);
        b.title = n === 0 ? 'Lektion zurücksetzen' : n === 3 ? 'Abhaken: alle Stufen' : n === 2 ? 'Pflicht + Bonus' : 'Pflichtstufen';
        b.addEventListener('click', () => {
          if (!setLesson(lv.id, n, stars)) return;
          this.grantTraining();
          refreshAll();
        });
        wrap.append(b);
        return b;
      });
      refreshers.push(() => {
        const n = t ? t.stars(lv.id) : 0;
        stars.textContent = starText(n);
        stars.className = `vel-admin-time vel-stars vel-stars--${n}`;
        STAR_OPTS.forEach((m, i) => buttons[i].setAttribute('aria-pressed', String(m === n)));
      });
      return h(
        'div',
        'vel-admin-level vel-admin-lesson',
        h('div', 'vel-admin-level-head', h('span', 'vel-admin-name', `${lv.short} ${lessonName(lv)}`), stars),
        h('div', 'vel-admin-level-ctl', wrap),
      );
    });
    // Alle Lektionen auf einmal (Admin "kann alles"): ★★★ bzw. zurücksetzen.
    const allNote = h('span', 'vel-hint', '');
    const allLessons = (n: LessonStars): void => {
      if (!t) return;
      let ok = true;
      for (const lv of t.lessons()) ok = setLesson(lv.id, n, allNote) && ok;
      if (ok) allNote.textContent = '';
      this.grantTraining();
      refreshAll();
    };
    const trainingPanel = h(
      'div',
      'vel-panel',
      h('h2', 'vel-h2', 'Training'),
      lessonRows.length > 0
        ? h(
            'div',
            'vel-row vel-admin-actions',
            this.btn('Alle ★★★', 'vel-btn--small vel-admin-all-lessons', () => allLessons(3)),
            this.btn('Alle zurücksetzen', 'vel-btn--small', () => allLessons(0)),
            allNote,
          )
        : h('div', 'vel-hint', t ? 'Keine Lektionen gefunden.' : 'Lektionen werden geladen …'),
      ...lessonRows,
      h('p', 'vel-hint', '★ = Pflichtstufen, ★★ + Bonus, ★★★ + Meister. Freischaltungen aus dem Training (Spinner, Roboter) folgen sofort; Zurücksetzen nimmt keine Freischaltung weg.'),
    );

    refreshAll();
    return h(
      'section',
      'vel-screen vel-admin-screen',
      h(
        'div',
        'vel-head-row',
        h('h1', 'vel-h1', 'Admin'),
        h('div', 'vel-row', this.btn('Menü-Labor', 'vel-btn--small vel-lab-btn', () => this.showLab()), this.btn('Zurück', 'vel-btn--small', () => this.leaveAdmin(), 'Esc')),
      ),
      h('p', 'vel-hint vel-admin-note', 'Admin-Freischaltungen gelten wie echte.'),
      h('div', 'vel-admin-grid', unlockPanel, h('div', 'vel-col', levelPanel, trainingPanel)),
    );
  }

  /**
   * Admin hat Training abgehakt: alles, was laut Ableitung (deriveUnlocks mit Trainings-Fortschritt)
   * am Training hängt und jetzt erfüllt ist, freischalten — sofort, wie ein echter Lektions-Abschluss
   * (Game.sync holt es sonst erst beim nächsten Ziel/Start nach).
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
      [['M'], 'Ton an/aus'],
    ];
    // F1 wirkt nur mit Dev-Werkzeugen (Web immer, Desktop nur --dev) — die Hilfe soll nichts Totes anbieten.
    if (devToolsAllowed(this.platform)) keys.splice(keys.length - 1, 0, [['F1'], 'Tuning-Panel (Movement live einstellen)']);
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
          this.platform.kind === 'desktop'
            ? h('p', 'vel-hint', mono('Strg'), ' duckt immer (keine Browser-Kürzel am Desktop). Belegung: Einstellungen → Tasten.')
            : h(
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
          this.buildPadControls(),
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
      ...(this.platform.window
        ? [
            this.displayModeRow(),
            h('div', 'vel-setting-hint', 'Gilt sofort und beim nächsten Start. ', mono('Strg'), ' duckt in beiden Modi.'),
          ]
        : [
            this.toggle('Vollbild beim Start', (v) => v.fullscreenOnStart, (v) => ({ fullscreenOnStart: v })),
            h('div', 'vel-setting-hint', 'Mit Vollbild duckt ', mono('Strg'), ' sofort, und ', mono('Strg'), '+', mono('W'), ' schließt nicht den Tab.'),
          ]),
    );

    const online = h(
      'div',
      'vel-panel vel-online-panel',
      h('h2', 'vel-h2', 'Online'),
      this.online?.loginRequired ? (this.accountBlock() ?? h('div', 'vel-account')) : null,
      this.textField('Spielername', (v) => v.playerName, (v) => ({ playerName: v })),
      this.nameHint(),
      h(
        'div',
        'vel-setting-hint vel-online-backend',
        !this.online
          ? 'Offline — Läufe werden nicht eingereicht.'
          : this.online.backend === 'mock'
            ? 'Bestenliste: lokal (Mock, nur dieser Browser). Jeder Lauf ins Ziel wird geprüft und eingereicht.'
            : 'Bestenliste: online. Jeder Lauf ins Ziel wird auf dem Server nachgespielt — gewertet wird nur die nachgerechnete Zeit.',
      ),
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
      h('div', 'vel-settings-grid', h('div', 'vel-col', mouse, movement, keys, online), h('div', 'vel-col', this.buildPadPanel(), camera, audio, gfx)),
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

  /** Textfeld (Spielername): übernimmt beim Verlassen/Enter, bereinigt über sanitizeName. */
  private textField(label: string, get: (s: GameSettings) => string, set: (v: string) => SettingsPatch): HTMLElement {
    const input = h('input', 'vel-text-input');
    input.type = 'text';
    input.maxLength = NAME_MAX;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'SPIELER-…';
    input.setAttribute('aria-label', label);
    const refresh = (s: GameSettings): void => {
      if (document.activeElement !== input) input.value = get(s);
    };
    input.addEventListener('change', () => {
      this.settings.update(set(sanitizeName(input.value)));
      input.value = get(this.settings.get());
    });
    refresh(this.settings.get());
    this.refreshers.push(refresh);
    return row(label, input, null);
  }

  // ------------------------------------------------------------------ Bestenliste (Plan 009)

  private leaveBoard(): void {
    this.boardSeq++;
    if (this.boardReturn === 'finish' && this.finishResult) this.render('finish', this.buildFinish(this.finishResult));
    else this.showTitle();
  }

  private boardMedals(levelId: string): LevelMedals | null {
    return this.levels.find((l) => l.id === levelId)?.medals ?? null;
  }

  /** Gerüst: Level-Reiter, zwei Tabellen (gefüllt von loadBoard), Ghost-Knöpfe. */
  private buildLeaderboard(): HTMLElement {
    const id = this.boardLevel;
    const tabs = h('div', 'vel-seg vel-board-tabs');
    for (const lv of this.levels) {
      const b = h('button', 'vel-btn', lv.name);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(lv.id === id));
      b.addEventListener('click', () => this.showLeaderboard(lv.id));
      tabs.append(b);
    }
    const on = this.online;
    const me = on?.myName() ?? null;
    const signedIn = on !== null && on.myUid() !== null && me !== null;
    let who: HTMLElement;
    if (!on) who = h('p', 'vel-hint vel-board-who', 'Offline — keine Bestenliste.');
    else if (on.loginRequired && !signedIn) who = h('div', 'vel-hint vel-board-who vel-board-who--out', h('span', '', 'Nicht angemeldet — lesen und Ghosts gehen ohne Konto.'), this.discordButton());
    else
      who = h(
        'p',
        'vel-hint vel-board-who',
        on.loginRequired ? pixelAvatar(on.myAvatar(), me ?? '?', 16) : null,
        'Du: ',
        playerName(me ?? '—', on.myDev(), 'vel-mono', 'b'),
        ` · ${on.backend === 'mock' ? 'lokale Bestenliste (Mock)' : 'Online-Bestenliste'}`,
      );
    const top = h('div', 'vel-panel vel-board-panel', h('h2', 'vel-h2', 'Top 10'), h('div', 'vel-board-top', h('p', 'vel-hint', this.online ? 'Lade …' : 'Offline.')));
    const around = h('div', 'vel-panel vel-board-panel', h('h2', 'vel-h2', 'Um dich herum'), h('div', 'vel-board-around', h('p', 'vel-hint', this.online ? 'Lade …' : '—')));
    const wr = this.btn('Gegen Weltrekord', 'vel-btn--primary vel-board-wr', () => undefined);
    wr.dataset.lock = '1';
    wr.dataset.off = '1';
    wr.disabled = true;
    const own = this.btn('Gegen eigene Bestzeit', 'vel-board-own', () => {
      if (id) this.emit('raceGhost', { levelId: id, runId: null, label: 'Eigene Bestzeit' });
    });
    own.dataset.lock = '1';
    return h(
      'section',
      'vel-screen vel-leaderboard-screen',
      h('div', 'vel-head-row', h('h1', 'vel-h1', 'Bestenliste'), this.btn('Zurück', 'vel-btn--small', () => this.leaveBoard(), 'Esc')),
      tabs,
      who,
      h('div', 'vel-board-grid', top, around),
      h('div', 'vel-row', wr, own),
      this.lockHint(''),
    );
  }

  private async loadBoard(): Promise<void> {
    const seq = ++this.boardSeq;
    const id = this.boardLevel;
    const on = this.online;
    if (!on) return;
    if (!id) {
      this.el.querySelector('.vel-board-top')?.replaceChildren(h('p', 'vel-hint', 'Level werden geladen …'));
      return;
    }
    try {
      const data = await on.board(id);
      if (seq !== this.boardSeq || this.current !== 'leaderboard') return;
      this.fillBoard(id, data.top, data.around, on.myUid());
    } catch (err) {
      if (seq !== this.boardSeq || this.current !== 'leaderboard') return;
      const msg = err instanceof Error ? err.message : String(err);
      for (const sel of ['.vel-board-top', '.vel-board-around']) {
        this.el.querySelector(sel)?.replaceChildren(h('p', 'vel-hint vel-bad', `Offline — ${msg}`));
      }
    }
  }

  private fillBoard(levelId: string, top: LeaderboardPage, around: LeaderboardPage, meUid: string | null): void {
    const medals = this.boardMedals(levelId);
    const table = (rows: readonly LeaderboardEntry[]): HTMLElement =>
      h(
        'table',
        'vel-splits vel-board',
        h('thead', '', h('tr', '', h('th', '', '#'), h('th', '', 'Name'), h('th', '', 'Zeit'), h('th', '', 'Medaille'), h('th', '', 'Ghost'))),
        h('tbody', '', ...rows.map((e) => this.boardRow(levelId, e, meUid, medals))),
      );
    const topEl = this.el.querySelector('.vel-board-top');
    topEl?.replaceChildren(
      top.entries.length > 0 ? table(top.entries) : h('p', 'vel-hint', 'Noch niemand im Ziel.'),
      h('p', 'vel-hint vel-board-total', `${top.total} ${top.total === 1 ? 'Spieler' : 'Spieler'} in der Wertung`),
    );
    const aroundEl = this.el.querySelector('.vel-board-around');
    aroundEl?.replaceChildren(
      around.me
        ? table(around.entries)
        : this.online?.loginRequired && this.online.myUid() === null
          ? h('p', 'vel-hint', 'Melde dich mit Discord an, um mitzufahren — jeder Lauf ins Ziel wird dann geprüft und eingereicht.')
          : h('p', 'vel-hint', 'Noch kein Lauf von dir. Fahr das Level bis ins Ziel — der Lauf wird geprüft und automatisch eingereicht.'),
    );
    const wrEntry = top.entries[0];
    const wr = this.el.querySelector<HTMLButtonElement>('.vel-board-wr');
    if (wr && wrEntry) {
      const label = `Weltrekord · ${wrEntry.name} ${formatTime(wrEntry.time)}`;
      wr.dataset.off = '0';
      wr.disabled = this.lockStatus.pending;
      const fresh = this.btn('Gegen Weltrekord', 'vel-btn--primary vel-board-wr', () => this.emit('raceGhost', { levelId, runId: wrEntry.runId, label }));
      fresh.dataset.lock = '1';
      fresh.title = label;
      wr.replaceWith(fresh);
    }
  }

  private boardRow(levelId: string, e: LeaderboardEntry, meUid: string | null, medals: LevelMedals | null): HTMLElement {
    const mine = e.uid === meUid;
    const medal = medals ? medalFor(e.time, medals) : null;
    const ghost = this.btn('Ghost', 'vel-btn--small vel-board-ghost', () =>
      this.emit('raceGhost', { levelId, runId: e.runId, label: `Rang ${e.rank} · ${e.name} ${formatTime(e.time)}` }),
    );
    ghost.dataset.lock = '1';
    ghost.dataset.rank = String(e.rank);
    return h(
      'tr',
      mine ? 'is-me' : '',
      h('td', '', `${e.rank}.`),
      h(
        'td',
        'vel-board-name',
        e.avatarUrl !== null || this.online?.loginRequired ? pixelAvatar(e.avatarUrl, e.name, 16) : null,
        boardNameButton(playerName(e.name, e.dev, 'vel-board-nm'), () => this.showProfile(e.uid)),
        e.bot ? h('small', 'vel-board-tag', 'BOT') : null,
        mine ? h('small', 'vel-board-tag vel-board-tag--me', 'DU') : null,
      ),
      h('td', '', formatTime(e.time)),
      h('td', '', medal !== null ? medalBadge(medal) : h('span', 'vel-dim', '—')),
      h('td', '', ghost),
    );
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

  /** Desktop: "Anzeigemodus" statt "Vollbild beim Start" (Hauptprozess-Fenster, keine Geste nötig). */
  private displayModeRow(): HTMLElement {
    const wrap = h('div', 'vel-seg');
    const opts: readonly { readonly value: DisplayMode; readonly label: string }[] = [
      { value: 'fullscreen', label: 'Vollbild' },
      { value: 'windowed', label: 'Fenster' },
    ];
    const buttons = opts.map((o) => {
      const b = h('button', 'vel-btn', o.label);
      b.type = 'button';
      b.dataset.displayMode = o.value;
      b.addEventListener('click', () => this.setDisplayMode(o.value));
      wrap.append(b);
      return b;
    });
    const refresh = (): void => opts.forEach((o, i) => buttons[i].setAttribute('aria-pressed', String(o.value === this.displayMode)));
    refresh();
    this.refreshers.push(refresh);
    // Vollbild kann auch über System → Vollbild umgeschaltet worden sein: beim Öffnen frisch lesen.
    this.platform.window
      ?.getMode()
      .then((m) => {
        this.displayMode = m;
        refresh();
      })
      .catch(() => undefined);
    return row('Anzeigemodus', wrap, null);
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
    k === 'quit' ||
    k === 'adminBest' ||
    k === 'demo' ||
    k === 'skipStage' ||
    k === 'raceGhost'
  );
}

/**
 * Polaroid des Ziel-Fotos (Plan 007 I3): das Selfie (96×54, schon gedithert) ganzzahlig ×3 hochskaliert
 * (image-rendering: pixelated, nie gedreht — gedrehte Pixel wären verschmiert), darunter Zeit und Medaille
 * dieses Laufs wie auf einem beschrifteten Sofortbild.
 */
function polaroid(r: FinishResult, photo: HTMLCanvasElement): HTMLElement {
  photo.classList.add('vel-polaroid-img');
  const got = r.medals ? medalFor(r.time, r.medals) : null;
  return h(
    'figure',
    'vel-polaroid',
    photo,
    h(
      'figcaption',
      'vel-polaroid-cap',
      h('span', 'vel-polaroid-time', formatTime(r.time)),
      got !== null ? h('span', `vel-medal vel-medal--${got}`, MEDAL_NAMES[got]) : h('span', 'vel-polaroid-level', listName(r.levelName)),
    ),
  );
}

/**
 * Spielername; Entwickler (profiles.role = 'dev', nur per SQL vergeben) bekommen den Neon-Effekt in harten
 * Stufen wie die VELOCITY-Medaille plus ein DEV-Abzeichen. Name als data-text für die Glitch-Ebenen.
 */
function playerName(name: string, dev: boolean, cls: string, tag: 'span' | 'b' = 'span'): HTMLElement {
  if (!dev) return h(tag, cls, name);
  const n = h('span', 'vel-name-dev-text', name);
  n.dataset.text = name;
  const badge = h('small', 'vel-dev-badge', 'DEV');
  badge.title = 'Entwickler von VELOCITY';
  return h(tag, `${cls} vel-name-dev`, n, badge);
}

/**
 * Avatar im Pixel-Look: Discord liefert ihn in 16 px (size=16), angezeigt 1× oder ganzzahlig 2× vergrößert mit
 * Nearest-Neighbor — Blockpixel wie die Welt. Ohne/kaputte URL: Initiale im Kästchen.
 */
function pixelAvatar(url: string | null, name: string, px: 16 | 32): HTMLElement {
  const initial = (): HTMLElement => h('span', `vel-avatar vel-avatar--${px} vel-avatar--none`, px === 32 ? name.slice(0, 1).toUpperCase() : '');
  if (!url) return initial();
  let src: string;
  try {
    const u = new URL(url);
    u.searchParams.set('size', '16'); // immer 16 px holen — 1× in Tabellen, 2× in der Konto-Zeile
    src = u.toString();
  } catch {
    return initial();
  }
  const img = h('img', `vel-avatar vel-avatar--${px}`);
  img.alt = '';
  img.decoding = 'async';
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  img.draggable = false;
  img.addEventListener('error', () => img.replaceWith(initial()), { once: true });
  img.src = src;
  return img;
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


/** Name in der Bestenliste als Knopf zum Profil (null = nur Text). */
function boardNameButton(name: HTMLElement, onClick: (() => void) | null): HTMLElement {
  if (onClick === null) return name;
  const b = h('button', 'vel-board-profile', name);
  b.type = 'button';
  b.title = 'Profil ansehen';
  b.addEventListener('click', onClick);
  return b;
}

/** Zahlenfelder der Pad-Einstellungen mit Regler im Menü. */
type PadNumKey = 'yawRate' | 'pitchRate' | 'deadzoneInner' | 'deadzoneOuter' | 'curve' | 'boost' | 'diagonalBand';

function numPatch(key: PadNumKey, v: number): PadSettingsPatch {
  switch (key) {
    case 'yawRate':
      return { yawRate: v };
    case 'pitchRate':
      return { pitchRate: v };
    case 'deadzoneInner':
      return { deadzoneInner: v };
    case 'deadzoneOuter':
      return { deadzoneOuter: v };
    case 'curve':
      return { curve: v };
    case 'boost':
      return { boost: v };
    case 'diagonalBand':
      return { diagonalBand: v };
  }
}
