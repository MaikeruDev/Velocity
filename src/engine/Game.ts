import { PerspectiveCamera, Vector3 } from 'three';
import type { AudioApi, MusicDrive } from '../audio/types';
import { CameraRig, cameraViewFromSnapshot, makeCameraView } from '../player/CameraRig';
import { lerpSnapshot } from '../player/interpolate';
import type { MovementConfig } from '../player/MovementConfig';
import { withMovement } from '../player/MovementConfig';
import { PlayerMovement } from '../player/PlayerMovement';
import { NaiveBot, RouteFollower, StrafeBot } from '../player/bots';
import type { RouteFailReason } from '../player/bots';
import type { MutablePlayerInput, MutablePlayerSnapshot, PlayerInput, PlayerSnapshot } from '../player/types';
import { NO_INPUT } from '../player/types';
import { hexToRgb } from '../render/util';
import type { RenderFx, RendererApi } from '../render/types';
import type { Hud } from '../ui/Hud';
import type { Menu } from '../ui/Menu';
import type { TuningPanel } from '../ui/TuningPanel';
import { ViewHand } from '../ui/hand/ViewHand';
import type { ViewHandState } from '../ui/hand/ViewHand';
import { makeHandInput } from '../ui/hand/handMotion';
import type { FinishResult, HudData, HudKeys, LessonResult } from '../ui/types';
import type { LessonPauseInfo, MenuTraining } from '../ui/Menu';
import { BrushWorld } from '../world/collision/BrushWorld';
import { GatedWorld } from '../world/collision/GatedWorld';
import { makeTraceResult } from '../world/collision/types';
import type { CollisionWorld } from '../world/collision/types';
import type { CompiledLevel } from '../world/level/compileLevel';
import { loadLevel } from '../world/level/compileLevel';
import type { LevelIndexEntry, LevelMedals, StageDef, TrainingDef, TrainingIndexEntry } from '../world/level/LevelFormat';
import { EventBus } from './events';
import type { GameEvent, RunEvent } from './events';
import type { HudLayoutInfo, TrainingDebugInfo } from './debug';
import { Coach, hintText } from './Coach';
import type { HintId } from './Coach';
import { TrainingSession, createDemo } from './Training';
import type { DemoRunner } from './Training';
import { TrainingProgress } from './TrainingProgress';
import type { TrainingSessionApi, Verdict } from './trainingTypes';
import { CENTER_BAND_BOTTOM, CENTER_BAND_TOP, stageLabel } from '../ui/hudLogic';
import { HUD_RECTS } from '../ui/Hud';
import { keyShortLabel } from './InputState';
import type { InputManager } from './Input';
import type { InputAction } from './InputState';
import { FixedLoop } from './Loop';
import { GhostRecorder, GhostStore, ghostDiff, ghostPoseAt, levelSignature } from './Ghost';
import { warmHotPaths } from './jitWarmup';
import type { GhostTrack } from './Ghost';
import { RunState } from './runState';
import type { BestTimes, SettingsPatch, SettingsStore } from './Settings';
import type { GameSettings } from './settingsTypes';
import type { UnlockStore } from './Unlocks';
import { gloveUnlock, itemUnlock, unlockDef, unlockPatch } from './Unlocks';
import { nextMedal } from '../ui/medals';

/**
 * Spielablauf: verbindet Loop, Input, Movement, Kamera, Lauf-Logik, Audio,
 * Renderer, HUD und Menüs. Zustände: title → loading → playing ⇄ paused → finished.
 *
 * Pro Tick: Eingabe (Subtick-Yaw) → Snapshot sichern → movement.tick → Events
 * auf den Bus → Lauf-Logik (Trigger, Timer, Respawn).
 * Pro Frame: Aktionen, Interpolation, Kamera mit dem AKTUELLEN Blick,
 * Musik, HUD, Renderer. Im Frame- und Tick-Pfad wird nichts allokiert.
 *
 * Trainingsmodus (Plan 007): ein Level mit `training` (Lektion aus levels/training/) läuft mit einer
 * TrainingSession und einer GatedWorld (Movement, Bots und Vorbeizieh-Proben teilen sie). Kein Timer,
 * keine Bestzeit, kein Ghost; F/Fall setzt an den Start der Stufe, R startet die Lektion neu. Taste H
 * spielt die Vorführung der Stufe (Bot in Ich-Perspektive, Session angehalten), jede Taste beendet sie.
 * Der Fortschritt (Sterne) liegt in TrainingProgress (velocity.training.v1) und schaltet über
 * deriveUnlocks Kosmetik frei.
 */

export type GameState = 'title' | 'loading' | 'playing' | 'paused' | 'finished';
export type BotKind = 'route' | 'strafe' | 'naive';

export interface BotOptions {
  /** 1 = perfekter Strafer. */
  readonly sync?: number;
  /** route/strafe: Menschenmodell, absoluter Zielfehler der Hand (Grad, 1σ). */
  readonly aimNoiseDeg?: number;
  /** naive: 'hold' (Default, Taste einmal gedrückt und gehalten) oder 'spam' (Mausrad). */
  readonly press?: 'hold' | 'spam';
  readonly seed?: number;
  /** strafe/naive: Kurs in Grad (Default: aktueller Blick). */
  readonly headingDeg?: number;
  /** route: Lauf vorher neu starten (Default true). */
  readonly restart?: boolean;
  readonly maxTurnRate?: number;
  readonly timeout?: number;
  readonly stallTimeout?: number;
}

export interface BotInfo {
  readonly kind: BotKind;
  readonly status: 'running' | 'finished' | 'failed';
  readonly reason: RouteFailReason | null;
  readonly nextIndex: number;
  readonly total: number;
}

export interface GameDeps {
  /** Canvas des Renderers — Klick ins Bild setzt ein pausiertes Spiel fort. */
  readonly canvas: HTMLCanvasElement;
  readonly renderer: RendererApi;
  readonly audio: AudioApi;
  readonly input: InputManager;
  readonly settings: SettingsStore;
  readonly best: BestTimes;
  /** Freischaltungen (Plan 005) — aus Medaillen abgeleitet, Kosmetik hängt daran. */
  readonly unlocks: UnlockStore;
  readonly hud: Hud;
  readonly menu: Menu;
  readonly tuning: TuningPanel;
  /** Kurze Meldung für die Spielerin (Ladefehler u. Ä.). */
  readonly notify: (message: string) => void;
  /** URL-Basis mit abschließendem Slash (import.meta.env.BASE_URL). */
  readonly baseUrl: string;
  /** Trainings-Fortschritt (Plan 007). Fehlt = Game legt ihn selbst an (localStorage). */
  readonly training?: TrainingProgress;
}

export interface GhostDebugInfo {
  readonly loaded: boolean;
  readonly enabled: boolean;
  /** Zielzeit des Ghosts (= Bestzeit, als er gespeichert wurde). */
  readonly time: number | null;
  readonly samples: number;
  readonly recording: boolean;
  readonly recorded: number;
  /** HUD-Abstand am letzten Checkpoint/Ziel. */
  readonly diff: number | null;
  /** Länge des gespeicherten Eintrags im localStorage (0 = keiner). */
  readonly storedChars: number;
  readonly pose: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number } | null;
  /** Ghost liegt gerade hinter dem Speedometer-Block (HUD dimmt ihn). */
  readonly overHud: boolean;
}

export interface StartOptions {
  /** Ohne Pointer Lock spielen (Playwright): Lock-Verlust pausiert nicht, Blick nur per setView/Bot. */
  readonly lockless?: boolean;
  /** Aufruf kommt aus einer User-Geste (Klick/Taste) — Lock und Audio sofort anfordern. */
  readonly gesture?: boolean;
}

type MutableHudData = { -readonly [K in keyof HudData]-?: HudData[K] };
type MutableDrive = { -readonly [K in keyof MusicDrive]: MusicDrive[K] };
type MutableFx = { -readonly [K in keyof RenderFx]: RenderFx[K] };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type FinishEvent = Mutable<Extract<RunEvent, { type: 'finish' }>>;

/**
 * Laufende Lektion aus Sicht von Game: der Vertrag (TrainingSessionApi) plus zwei Extras der
 * Implementierung (engine/Training, Strang training-core) — Tipps im Moment (Text + Zähler) und die
 * Config (Strafe-Assist ändert das Urteil 'wHeld'). Mehr nicht: Stufe/Stufen kommen aus dem Level
 * (LessonHud.stageIndex → TrainingDef.stages), damit Game gegen den Vertrag gebaut bleibt.
 */
interface LessonSession extends TrainingSessionApi {
  /** kind 'verdict' = wiederholtes Fehlurteil — nur in Stufen, die Strafen bewerten (siehe lessonJudge). */
  readonly tip: { readonly text: string; readonly kind: 'stage' | 'verdict' | 'demo'; readonly serial: number };
  setConfig(c: MovementConfig): void;
}

interface ActiveBot {
  readonly kind: BotKind;
  readonly route: RouteFollower | null;
  next(): PlayerInput;
  setConfig(c: MovementConfig): void;
}

const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Respawn: sofort teleportieren, dann aus fast Schwarz aufblenden. Kurz — Respawns müssen schnell sein. */
const FADE_TIME = 0.25;
const FADE_PEAK = 0.9;
/** Blitz beim Checkpoint (Trim-Farbe des Levels) und im Ziel (Magenta). */
const FLASH_CP = 0.45;
const FLASH_CP_TIME = 0.35;
const FLASH_FINISH = 0.85;
const FLASH_FINISH_TIME = 0.8;
const FINISH_RGB: readonly [number, number, number] = [1, 0.25, 0.82];
/** So lange nach dem Ziel fliegt man weiter und sieht die Zeit im HUD, bevor das Ergebnis-Menü kommt. */
const FINISH_MENU_DELAY = 1.1;
/** Lektion: nach der letzten Stufe so lange "ALLES GESCHAFFT!" im HUD, dann das Ergebnis (s). */
const LESSON_RESULT_DELAY = 1.4;
/** Lektion: durchs Portal (Ziel-Trigger der Lektion) → so lange Blitz, dann das Ergebnis (s). */
const PORTAL_RESULT_DELAY = 0.5;
/** Vorführung hat die Aufgabe der Stufe erfüllt → so lange "SO GEHT'S!", dann zurück an den Stufen-Spawn (s, Tick-Zeit). */
const DEMO_GOAL_HOLD = 1;
/**
 * Vorführung steht: nachdem der Bot einmal DEMO_STILL_SPEED erreicht hat, so lange (s) am Stück darunter → Ende.
 * Sonst stand er nach dem Stufenziel bis zum Ablauf von DemoDef.seconds vor dem geschlossenen Tor (51–64 %).
 */
const DEMO_STILL_END = 0.5;
const DEMO_STILL_SPEED = 40;
/** Tempo, mit dem lessonJudge die Session fragt (turnBand ist je Stufe null oder nicht; der Wert ist egal). */
const JUDGE_PROBE_SPEED = 300;
/** speed01 für Renderer: 0 bei Laufgeschwindigkeit, 1 bei sehr hohem Tempo. */
const SPEED01_LO = 250;
const SPEED01_HI = 1100;
/** Titel-Hintergrund: langsamer Schwenk um den Spawn des zuletzt geladenen Levels (rad/s). */
const BACKDROP_TURN = 0.05;
const BACKDROP_LIFT = 72;
/** Spawn anheben und per Trace absetzen: Füße exakt auf der Fläche gelten als "im Solid" (fallen.md #14). */
const SPAWN_LIFT = 1;
const FPS_WINDOW = 0.5;
/** Strafe-Spiegel: erst ab dieser Drehrate (rad/s) zählt die Maus als "dreht". */
const MIRROR_MIN_TURN = 5 * (Math.PI / 180);
/** Showkeys-Drehrate in °/s wird hierauf begrenzt (bleibt int32, der Balken ist ab 360 ohnehin voll). */
const TURN_RATE_LIMIT = 100000;
/** Landewelle (RenderFx.landPower): nur gute Hops — perfekt und Sync über dieser Schwelle; volle Stärke ab 30 u/s Gewinn. */
const WAVE_MIN_SYNC = 0.8;
const WAVE_FULL_GAIN = 30;
/** Tempostufen der Trims (= HUD-Meilensteine) und Hysterese beim Zurückschalten (u/s). */
const TIER_SPEEDS: readonly number[] = [500, 750, 1000];
const TIER_DOWN = 60;
/**
 * Vorbeizieh-Whoosh (MusicDrive.nearL/nearR): seitliche Proben so weit (u), alle
 * NEAR_EVERY Ticks, erst ab NEAR_MIN_SPEED — darunter ist der Whoosh ohnehin stumm.
 * Die Probe ist eine schmale Box in Rumpfhöhe (Füße +20 … +56), damit Boden und
 * Stufen nicht als "Wand daneben" zählen. Nur Distanz, keine Normale (fallen.md #41).
 */
const NEAR_RANGE = 160;
/** Ghost-Körpermitte über dem Ursprung (u) und halbe Höhe — für die HUD-Deckungsprobe. */
const GHOST_MID_Y = 36;
const GHOST_HALF_H = 36;
/** Weiter weg ist der Ghost ein paar Pixel groß — das Speedometer darf ihn verdecken. */
const GHOST_HUD_RANGE = 1500;
/** Halbe Breite des Speedometer-Blocks in HUD-Pixeln (auch __vel.hudLayout). */
const SPEED_BLOCK_HALF_W = 48;
const NEAR_EVERY = 2;
const NEAR_MIN_SPEED = 200;
const NEAR_HALF = 4;
const NEAR_BOTTOM = 20;
const NEAR_TOP = 56;
/** Ab diesem Seitenanteil der Surf-Normale gilt eine Seite als "die Rampe unter mir". */
const NEAR_SURF_SIDE = 0.3;

const RESPAWN_FALL: RunEvent = Object.freeze({ type: 'respawn', reason: 'fall' });
const RESPAWN_KILL: RunEvent = Object.freeze({ type: 'respawn', reason: 'kill' });
const RESPAWN_RESTART: RunEvent = Object.freeze({ type: 'respawn', reason: 'restart' });
const RESPAWN_MANUAL: RunEvent = Object.freeze({ type: 'respawn', reason: 'manual' });

export class Game {
  // --- Module
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: RendererApi;
  private readonly audio: AudioApi;
  private readonly input: InputManager;
  private readonly settings: SettingsStore;
  private readonly best: BestTimes;
  private readonly unlocks: UnlockStore;
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly tuning: TuningPanel;
  private readonly notify: (message: string) => void;
  private readonly baseUrl: string;

  readonly bus = new EventBus();
  readonly camera = new PerspectiveCamera(74, 16 / 9, 2, 30000);
  private readonly rig: CameraRig;
  private readonly movement: PlayerMovement;
  private readonly loop: FixedLoop;
  private config: MovementConfig;

  // --- Zustand
  private gameState: GameState = 'title';
  private pausedFor: 'menu' | 'tuning' = 'menu';
  private lockless = false;
  private muted = false;
  private levels: readonly LevelIndexEntry[] = [];
  private readonly levelCache = new Map<string, Promise<CompiledLevel>>();
  private level: CompiledLevel | null = null;
  private levelId = '';
  private renderedLevel: CompiledLevel | null = null;
  private loadToken = 0;
  private run: RunState | null = null;
  private bestTime: number | null = null;
  private bestSplitsAtStart: readonly number[] | null = null;
  /** Nach dem Ziel noch weiterfliegen (bis das Ergebnis-Menü kommt oder man in den Tod fällt). */
  private coasting = false;
  private finishElapsed = 0;
  private finishResult: FinishResult | null = null;
  private leaveGuard = false;

  // --- Tick-Puffer
  private readonly prev: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  private readonly cur: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  private readonly interp: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  private readonly view = makeCameraView();
  private readonly runEvents: RunEvent[] = [];
  private readonly finishEvent: FinishEvent = { type: 'finish', time: 0, best: false, previousBest: null };
  private lastYaw = 0;
  private lastPitch = 0;
  private lastSide = 0;
  private lastSprint = false;
  private lastForward = 0;
  private lastJump = false;
  private lastCrouch = false;
  // Strafe-Spiegel (Showkeys): Ticks seit dem letzten Frame, in denen A/D zur Maus passte und Tempo brachte bzw. gegen die Maus stand.
  private strafeGoodTicks = 0;
  private strafeBadTicks = 0;
  /** W zusammen mit A/D in der Luft gehalten, s. */
  private forwardAirTime = 0;
  private prevFrameYaw = 0;
  /** Im Konstruktor mit der echten Config gebaut (Strafe-Assist → Urteil 'wHeld'). */
  private readonly coach: Coach;
  private overrideActive = false;
  private bot: ActiveBot | null = null;
  private botOpts: BotOptions = {};
  private frozen = false;
  private stepping = false;
  private readonly tr = makeTraceResult();
  private readonly placeA = new Vector3();
  private readonly placeB = new Vector3();
  private readonly standMins = new Vector3();
  private readonly standMaxs = new Vector3();
  // Vorbeizieh-Proben (S8)
  private readonly nearMins = new Vector3(-NEAR_HALF, NEAR_BOTTOM, -NEAR_HALF);
  private readonly nearMaxs = new Vector3(NEAR_HALF, NEAR_TOP, NEAR_HALF);
  private readonly nearEnd = new Vector3();
  private nearTick = 0;
  private nearL = Infinity;
  private nearR = Infinity;
  /** Debug/Messung: Proben abschaltbar (__vel.setNearProbe). */
  nearProbeEnabled = true;
  // Ghost der Bestzeit (S7)
  private readonly ghostStore = new GhostStore();
  private readonly ghostRec = new GhostRecorder();
  private ghostTrack: GhostTrack | null = null;
  private ghostOn = true;
  private levelSig = '';
  private readonly ghostPos = new Vector3();
  /** Scratch: Ghost-Mitte in NDC (HUD-Deckungsprobe). */
  private readonly ghostNdc = new Vector3();
  // Flow-Feedback im Renderer (Landewelle, Tempostufe)
  private readonly landPos = new Vector3();
  private speedTier = 0;
  // Trainingsmodus (Plan 007)
  private readonly progress: TrainingProgress;
  private readonly menuTraining: MenuTraining;
  private lessons: readonly TrainingIndexEntry[] = [];
  private readonly lessonDefs = new Map<string, TrainingDef>();
  private session: LessonSession | null = null;
  /** Kollisionswelt des laufenden Levels (Lektion: GatedWorld) — Movement, Bots und Proben teilen sie. */
  private world: CollisionWorld = new BrushWorld([]);
  private readonly lessonEvents: RunEvent[] = [];
  /** Vorführung (Taste H): Bot der Stufe; null = keine. */
  private demo: DemoRunner | null = null;
  /** Rest der Vorführung (s, Tick-Zeit). */
  private demoLeft = 0;
  /** Tools: der Bot spielt die Lektion wirklich (Session läuft weiter, nächste Stufe → nächste Vorführung). */
  private demoPlays = false;
  private demoStage = -1;
  /** Vorführung nach dem Fortsetzen starten (Pause-Menü "Vorführung ansehen"). */
  private pendingDemo = false;
  /**
   * Schatten der Vorführung: eigene Session (ohne Welt, an der Stufe der Vorführung), die die Ticks des Bots
   * bewertet — die echte Session ist angehalten und zählt nichts. Wechselt ihre Stufe, hat der Bot die Aufgabe
   * erfüllt. null = keine Vorführung, Ziel schon erreicht oder Tools spielen wirklich (demoPlays).
   */
  private demoShadow: TrainingSessionApi | null = null;
  private readonly shadowEvents: RunEvent[] = [];
  /** Vorführung hat das Stufenziel erreicht; Rest der "SO GEHT'S"-Phase (s). */
  private demoGoal = false;
  private demoGoalLeft = 0;
  /** Stillstand der Vorführung: Bot fuhr schon; so lange steht er am Stück (s). */
  private demoMoved = false;
  private demoStill = 0;
  /**
   * Die aktive Stufe bewertet Strafen (Urteile am Gain-Popup, Urteils-Tipps, SYNC-Zeile). Kriterium der Session:
   * turnBand() ≠ null (Stufe mit Strafe-Aufgabe in einer Lektion mit Zielband) — T1/T2/T6/T7/T8 und Prestrafe
   * nicht: dort widersprach "W LOS" der Anweisung "W + LEERTASTE HALTEN". Je Stufe einmal bestimmt.
   */
  private lessonJudge = false;
  private judgeStage = -1;
  /**
   * Übersprungene Stufen, deren 'lessonStage' noch aussteht: so viele dieser Ereignisse gehen nicht auf den
   * Bus (kein Blitz/Akkord/Faust), siehe skipStage. Zähler statt Merker: zweimal Überspringen vor einem Tick
   * (Pause → Lock scheitert → zweiter Klick) schickt zwei Ereignisse in denselben Tick.
   */
  private skipPending = 0;
  /** Sekunden bis zum Lektions-Ergebnis (nach der letzten Stufe), −1 = keins. */
  private lessonEndIn = -1;
  private progressDirty = false;
  private tipSerial = 0;
  private lessonResult: LessonResult | null = null;
  private showKeysSetting = true;
  /** Lektion mit TrainingDef.hud.forceKeys (beim Laden gesetzt). */
  private lessonForceKeys = false;
  private demoKey: string | null = 'H';
  private readonly band = { lo: 0, hi: 0 };
  // View-Hand (Plan 004): Blick des letzten Frames für den Maus-Sway.
  private readonly hand = new ViewHand();
  private readonly handIn = makeHandInput();
  private handYaw = 0;
  private handPitch = 0;
  /** JIT-Vorwärmen einmal pro Sitzung (ms, −1 = noch nicht). */
  private warmMs = -1;

  // --- Frame
  private readonly hudCp = { index: 0, total: 0 };
  private readonly hudKeys: Mutable<HudKeys> = {
    forward: 0,
    side: 0,
    jump: false,
    crouch: false,
    turnDeg: 0,
    inAir: false,
    strafe: 0,
    forwardInAirMs: 0,
  };
  private readonly hudData: MutableHudData;
  private readonly drive: MutableDrive = {
    speed: 0,
    onGround: true,
    hopChain: 0,
    strafeSync: 0,
    airTime: 0,
    surfing: false,
    sliding: false,
    active: false,
    nearL: Infinity,
    nearR: Infinity,
  };
  private readonly flashRgb: [number, number, number] = [1, 1, 1];
  private readonly cpFlashRgb: [number, number, number] = [0.2, 0.94, 1];
  private readonly fx: MutableFx;
  private flashPeak = 0;
  private flashTime = 1;
  private flashDur = 1;
  private fadeT = FADE_TIME;
  private time = 0;
  private backdropT = 0;
  private fpsFrames = 0;
  private fpsStart = -1;
  private fpsValue = 0;
  private lastFrameDt = 0;
  /** Messung (Tools): CPU-Zeit des Frame-Callbacks (ms), Summe und Anzahl seit dem letzten Abruf. */
  private frameCpuSum = 0;
  private frameCpuN = 0;
  /** Messung (Tools): davon die Frame-Arbeit der Lektion (updateLesson), ms. */
  private lessonCpuSum = 0;
  /** Messung (Tools): Session-Ticks der Lektion (ms, Summe); nur nach dem ersten takeFrameCost() aktiv. */
  private lessonTickCpuSum = 0;
  private costProbe = false;

  /** Debug: letzte Events mitschreiben (nur wenn eingeschaltet — kopiert, allokiert also). */
  eventRecorder: ((e: GameEvent) => void) | null = null;

  constructor(deps: GameDeps) {
    this.canvas = deps.canvas;
    this.renderer = deps.renderer;
    this.audio = deps.audio;
    this.input = deps.input;
    this.settings = deps.settings;
    this.best = deps.best;
    this.unlocks = deps.unlocks;
    this.hud = deps.hud;
    this.menu = deps.menu;
    this.tuning = deps.tuning;
    this.notify = deps.notify;
    this.baseUrl = deps.baseUrl;

    this.config = deps.tuning.getConfig();
    this.coach = new Coach(this.config);
    this.progress = deps.training ?? new TrainingProgress();
    const progress = this.progress;
    // Was das Menü vom Training braucht; Admin-Abhaken kennt die Stufen erst, wenn die Lektion geladen ist.
    this.menuTraining = {
      lessons: () => progress.lessons(),
      stars: (id) => progress.stars(id),
      get started() {
        return progress.started;
      },
      playable: true,
      complete: (id) => {
        const def = this.lessonDefs.get(id);
        if (!def) return false;
        progress.complete(id, def.stages);
        return true;
      },
      reset: (id) => progress.reset(id),
    };
    this.rig = new CameraRig(this.camera);
    // Leere Welt bis zum ersten Level — Movement tickt vorher ohnehin nicht.
    this.movement = new PlayerMovement(new BrushWorld([]), this.config);
    this.updateStandHull();
    this.loop = new FixedLoop({
      tickRate: this.config.tickRate,
      onTick: this.onTick,
      onFrame: this.onFrame,
      onFrameStart: () => this.input.beginFrame(),
    });

    this.hudData = {
      speed: 0,
      hopChain: 0,
      strafeSync: 0,
      onGround: true,
      surfing: false,
      runTime: null,
      running: false,
      checkpoint: this.hudCp,
      levelName: '',
      levelSubtitle: null,
      bestTime: null,
      showSpeedometer: true,
      showKeys: true,
      keys: this.hudKeys,
      paused: false,
      ghostDiff: null,
      ghostOverHud: false,
      nextMedal: null,
      lesson: null,
    };
    this.fx = {
      time: 0,
      speed01: 0,
      kick: 0,
      energy: 0,
      flash: 0,
      flashColor: this.flashRgb,
      fade: 0,
      landPos: this.landPos,
      landTime: -1e9,
      landPower: 0,
      speedTier: 0,
    };

    // Ereignisse an alle Abnehmer. Reihenfolge egal — alle reagieren synchron und unabhängig.
    this.bus.on((e) => this.audio.emit(e));
    this.bus.on((e) => this.rig.onEvent(e));
    this.bus.on((e) => this.hud.onEvent(e));
    this.bus.on((e) => this.hand.onEvent(e));
    this.bus.on((e) => this.eventRecorder?.(e));
    this.bus.on((e) => this.coach.onEvent(e));
    this.bus.on((e) => this.onGameEvent(e));
    this.bus.on((e) => this.session?.onEvent(e));
    // Ereignis-Aufgaben (T1 Rutschen: slideStart) zählt der Schatten der Vorführung über denselben Weg.
    this.bus.on((e) => this.demoShadow?.onEvent(e));
    this.coach.onHint = (id, verdict) => this.showHint(id, verdict);
    this.menu.setRawStatusProvider(() => this.input.rawStatus);
    // Fortschritt geändert (Lektion, Admin): offene Menü-Screens nachziehen.
    this.progress.onChange(() => this.menu.setTraining(this.menuTraining));

    this.renderer.setHud(this.hud.canvas);
    this.hud.setMovement(this.config);
    this.rig.setMovement(this.config);
    this.hud.visible = false;
    this.applySettings(this.settings.get());
    this.settings.subscribe((s) => this.applySettings(s));
    this.unlocks.subscribe(() => this.applyCosmetics(this.settings.get()));
    this.tuning.onChange((c) => this.applyConfig(c));
    this.input.onNotice((n) => this.hud.onInputNotice(n));
    this.wireMenu();

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.canvas.addEventListener('click', this.onCanvasClick);
    this.onResize();
  }

  // ================================================================== Öffentlich

  get state(): GameState {
    return this.gameState;
  }

  get currentLevelId(): string {
    return this.levelId;
  }

  get currentLevel(): CompiledLevel | null {
    return this.level;
  }

  get player(): PlayerSnapshot {
    return this.movement.state;
  }

  get runState(): RunState | null {
    return this.run;
  }

  get fps(): number {
    return this.fpsValue;
  }

  get movementConfig(): MovementConfig {
    return this.config;
  }

  get locked(): boolean {
    return this.input.locked;
  }

  get isLockless(): boolean {
    return this.lockless;
  }

  get lastFinish(): FinishResult | null {
    return this.finishResult;
  }

  get menuScreen(): string | null {
    return this.menu.screen;
  }

  /** Gerade sichtbarer HUD-Hinweis (Tools/Tests). */
  get hudNotice(): string | null {
    return this.hud.currentNotice;
  }

  /** Wie oft jeder Hinweis im Moment kam (Tools/Tests). */
  get hintsShown(): Readonly<Record<HintId, number>> {
    return this.coach.shown;
  }

  get tuningVisible(): boolean {
    return this.tuning.visible;
  }

  get tickRate(): number {
    return this.loop.tickRate;
  }

  get frameDt(): number {
    return this.lastFrameDt;
  }

  get viewYaw(): number {
    return this.overrideActive ? this.lastYaw : this.input.yaw;
  }

  get viewPitch(): number {
    return this.overrideActive ? this.lastPitch : this.input.pitch;
  }

  /** Ghost-Zustand für Tools (window.__vel.ghost): geladen?, Zielzeit, Samples, HUD-Abstand, Pose zur Laufzeit t. */
  ghostInfo(t?: number): GhostDebugInfo {
    const g = this.ghostTrack;
    let pose: GhostDebugInfo['pose'] = null;
    if (g && t !== undefined) {
      const v = new Vector3();
      const yaw = ghostPoseAt(g, t, v);
      if (!Number.isNaN(yaw)) pose = { x: v.x, y: v.y, z: v.z, yaw };
    }
    return {
      loaded: g !== null,
      enabled: this.ghostOn,
      time: g ? g.time : null,
      samples: g ? g.count : 0,
      recording: this.ghostRec.recording,
      recorded: this.ghostRec.count,
      diff: this.hudData.ghostDiff ?? null,
      storedChars: this.ghostStore.storedChars(this.levelId),
      pose,
      overHud: this.hudData.ghostOverHud,
    };
  }

  /** Vorbeizieh-Abstände der letzten Probe (u, Infinity = frei). */
  get near(): { readonly left: number; readonly right: number } {
    return { left: this.nearL, right: this.nearR };
  }

  /** HUD-Geometrie für Mess-Tools (window.__vel.hudLayout). */
  hudLayout(): HudLayoutInfo {
    const h = this.hud.height;
    const rects: Record<string, readonly [number, number, number, number]> = {};
    for (const name of HUD_RECTS) rects[name] = this.hud.rect(name);
    return {
      width: this.hud.width,
      height: h,
      speedRows: this.hud.speedBlockRows(),
      speedHalfWidth: SPEED_BLOCK_HALF_W,
      centerBand: [Math.round(h * CENTER_BAND_TOP), Math.round(h * CENTER_BAND_BOTTOM)],
      rects,
      verdict: this.hud.currentVerdict,
      verdictSerial: this.hud.verdictSerial,
      verdictDrawn: this.hud.verdictDrawn,
      judge: this.hud.judge,
    };
  }

  /** Levelliste laden, Titel zeigen, Loop starten. Das Titel-Level lädt im Hintergrund. */
  async boot(): Promise<void> {
    this.loop.start();
    this.menu.showTitle();
    try {
      const res = await fetch(`${this.baseUrl}levels/index.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      this.levels = parseIndex(data);
    } catch (err) {
      this.levels = [];
      this.notify(`Levelliste konnte nicht geladen werden (${errorText(err)}).`);
    }
    // Freischaltungen aus den Bestzeiten nachtragen (verlorener Unlock-Stand kostet nichts).
    this.unlocks.sync(this.levels, (id) => this.best.get(id), this.progress);
    this.menu.setLevels(this.levels);
    const first = this.levels[0];
    if (first && this.gameState === 'title') void this.prepareBackdrop(first.id);
    await this.loadLessons();
  }

  /**
   * Lektionsliste (levels/training/index.json) laden; fehlt sie, gibt es eben kein Training. Danach die
   * Lektionen selbst im Hintergrund (klein; Admin-Abhaken und Sterne brauchen ihre Stufen) und die
   * Freischaltungen aus dem Training nachtragen.
   */
  private async loadLessons(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}levels/training/index.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      this.lessons = parseTrainingIndex(data);
    } catch {
      // Ohne Lektionen (z. B. Build ohne Training): das Menü zeigt "Keine Lektionen".
      this.lessons = [];
    }
    this.progress.setLessons(this.lessons);
    this.menu.setTraining(this.menuTraining);
    // Sterne liegen im Fortschritt — die Freischaltungen gehen schon ohne die Lektionen selbst.
    this.unlocks.sync(this.levels, (id) => this.best.get(id), this.progress);
    void this.preloadLessons();
  }

  /** Lektionen im Hintergrund laden (Admin-Abhaken braucht ihre Stufen); blockiert den Start nicht. */
  private async preloadLessons(): Promise<void> {
    for (const e of this.lessons) {
      try {
        const lv = await this.getLevel(e.id);
        if (lv.def.training) this.lessonDefs.set(e.id, lv.def.training);
      } catch {
        // Kaputte Lektion: sie fehlt beim Abhaken; der Start meldet den Fehler selbst.
      }
    }
  }

  /** Lektionen (Tools/Menü): Liste mit Sternen. */
  lessonList(): { readonly id: string; readonly name: string; readonly short: string; readonly stars: number; readonly loaded: boolean }[] {
    return this.lessons.map((l) => ({ id: l.id, name: l.name, short: l.short, stars: this.progress.stars(l.id), loaded: this.lessonDefs.has(l.id) }));
  }

  /** Laufende Lektion (null = normales Level). */
  get lessonSession(): TrainingSessionApi | null {
    return this.session;
  }

  /**
   * Level starten. Aus einer User-Geste (Menü-Klick): Pointer Lock und Audio
   * werden SOFORT angefordert — nach dem ersten await wäre die Geste verbraucht.
   * Resolved mit true, sobald gespielt (oder bei fehlendem Lock pausiert) wird.
   */
  async startLevel(id: string, opts: StartOptions = {}): Promise<boolean> {
    const gesture = opts.gesture ?? false;
    this.lockless = opts.lockless ?? false;
    let lock: Promise<boolean> | null = null;
    if (!this.lockless && gesture) {
      lock = this.requestLockTracked();
      this.fullscreenFromGesture(lock);
    }
    this.unlockAudio();

    const token = ++this.loadToken;
    this.clearBot();
    this.gameState = 'loading';
    this.coasting = false;
    this.menu.hide();
    this.tuning.hide();
    let level: CompiledLevel;
    try {
      level = await this.getLevel(id);
    } catch (err) {
      if (token !== this.loadToken) return false;
      this.input.exitLock();
      this.gameState = 'title';
      this.hud.visible = false;
      this.menu.showTitle();
      this.notify(`Level "${id}" konnte nicht geladen werden: ${errorText(err)}`);
      return false;
    }
    if (token !== this.loadToken) return false;

    try {
      this.applyLevel(id, level);
    } catch (err) {
      // Kaputte Lektion (TrainingSession wirft bei ungültiger Def): zurück ins Menü statt halb geladen.
      this.session = null;
      this.level = null;
      this.input.exitLock();
      this.gameState = 'title';
      this.hud.visible = false;
      if (this.lessons.some((l) => l.id === id)) this.menu.showTraining();
      else this.menu.showTitle();
      this.notify(`Level "${id}" konnte nicht gestartet werden: ${errorText(err)}`);
      return false;
    }
    this.gameState = 'playing';
    if (this.lockless) return true;
    if (lock === null) {
      // Ohne Geste (Dev-Direktstart per ?level=) gibt es keinen Lock — erst ein Klick auf "Weiter".
      this.pause('menu');
      return true;
    }
    void lock.then((ok) => {
      if (!ok && token === this.loadToken) this.lockFailed();
    });
    return true;
  }

  /** Lauf neu starten (R): Timer, Checkpoints, Position — alles auf Anfang. In einer Lektion: Lektion neu. */
  restartRun(): void {
    const level = this.level;
    const run = this.run;
    if (!level || !run) return;
    if (this.session) {
      this.restartLesson();
      return;
    }
    this.bestSplitsAtStart = this.best.getSplits(this.levelId);
    this.bestTime = this.best.get(this.levelId);
    run.reset(this.bestSplitsAtStart);
    this.finishResult = null;
    this.coasting = false;
    this.loadGhost();
    if (this.bot?.route) this.bot = this.makeBot(this.bot.kind, this.botOpts);
    this.placeAt(level.spawnPos, level.spawnYaw);
    this.bus.emit(RESPAWN_RESTART);
    this.startFade();
    this.gameState = 'playing';
    this.menu.hide();
  }

  /** Zurück ins Titelmenü — aus einer Lektion in die Lektionsliste. */
  toTitle(): void {
    const fromLesson = this.session !== null;
    if (fromLesson) {
      // Verdientes nachtragen (z. B. Lektion bestanden und über die Pause verlassen), still.
      this.saveProgress();
      this.unlocks.sync(this.levels, (id) => this.best.get(id), this.progress);
    }
    this.loadToken++;
    this.clearBot();
    this.gameState = 'title';
    this.coasting = false;
    this.lessonEndIn = -1;
    this.input.exitLock();
    this.tuning.hide();
    this.hud.visible = false;
    if (this.levelId && !fromLesson) this.menu.select(this.levelId);
    if (fromLesson) this.menu.showTraining();
    else this.menu.showTitle();
    this.backdropT = 0;
  }

  /** Spiel anhalten: 'menu' zeigt das Pause-Menü, 'tuning' nur das F1-Panel über dem stehenden Bild. */
  pause(kind: 'menu' | 'tuning'): void {
    if (this.gameState !== 'playing') return;
    this.gameState = 'paused';
    this.pausedFor = kind;
    // Sonst interpoliert der erste Frame nach dem Fortsetzen zwischen den letzten
    // beiden Ticks vor der Pause — die Kamera spränge einen Tick zurück.
    copySnap(this.cur, this.prev);
    // Vorführung endet mit der Pause (Esc ist auch "eine Taste"); der Spieler steht wieder am Stufen-Spawn.
    if (this.demo) this.endDemo(true);
    this.input.exitLock();
    if (kind === 'menu') {
      this.tuning.hide();
      this.menu.showPause(this.lessonPauseInfo());
    } else {
      this.menu.hide();
      this.tuning.show();
    }
  }

  /** Aus einer User-Geste weiter: erst Lock, dann spielen (Pause bleibt stehen, bis der Lock da ist). */
  requestResume(): void {
    if (this.gameState !== 'paused') return;
    if (this.lockless) {
      this.resume();
      return;
    }
    const p = this.requestLockTracked();
    this.fullscreenFromGesture(p);
    this.unlockAudio();
    void p.then((ok) => {
      if (this.gameState !== 'paused') return;
      if (ok) this.resume();
      else if (!this.menu.visible) this.lockFailedInPause();
    });
  }

  // --- Debug / Tools (window.__vel)

  /** Teleport an die Füße (x, y, z); yaw in Grad, optional. Geschwindigkeit 0. */
  teleport(pos: Vector3, yawDeg?: number): void {
    const yaw = yawDeg !== undefined ? yawDeg : this.viewYaw / DEG;
    this.placeAt(pos, yaw);
  }

  setVelocity(v: Vector3): void {
    // Snapshot ist der Live-Zustand; vel ist ein veränderbarer Vector3 (Debug-Zugriff, sonst nur über teleport).
    this.movement.state.vel.copy(v);
    this.movement.copySnapshot(this.cur);
    copySnap(this.cur, this.prev);
  }

  setView(yaw: number, pitch: number): void {
    this.input.setView(yaw, pitch);
    this.lastYaw = yaw;
    this.lastPitch = pitch;
  }

  setConfigPatch(patch: Partial<MovementConfig>): MovementConfig {
    const next = withMovement(this.config, patch);
    this.tuning.setConfig(next);
    this.applyConfig(next);
    return next;
  }

  /** Eingabe pro Tick ersetzen (Playwright). fn bekommt den Live-Zustand; fehlende Felder = keine Taste. */
  setInputOverride(fn: ((state: PlayerSnapshot, tickIndex: number, ticks: number) => Partial<PlayerInput>) | null): void {
    this.clearBot();
    if (fn === null) return;
    const out: MutablePlayerInput = { ...NO_INPUT };
    this.overrideActive = true;
    this.input.setOverride((i, n) => {
      const p = fn(this.movement.state, i, n);
      out.forward = p.forward ?? 0;
      out.side = p.side ?? 0;
      out.jumpHeld = p.jumpHeld ?? false;
      out.jumpPressed = p.jumpPressed ?? false;
      out.crouch = p.crouch ?? false;
      out.sprint = p.sprint ?? false;
      out.yaw = p.yaw ?? this.lastYaw;
      out.pitch = p.pitch ?? this.lastPitch;
      return out;
    });
  }

  // --- Training (Debug-Handle, Tools)

  /** Zustand der laufenden Lektion (null = keine) für __vel.training(). */
  trainingInfo(): TrainingDebugInfo | null {
    const s = this.session;
    if (!s) return null;
    const hud = s.hud;
    const world = this.world;
    const gates = this.level?.gates ?? [];
    return {
      lessonId: this.levelId,
      name: this.hudData.levelName,
      stageIndex: hud.stageIndex,
      stageTotal: hud.stageTotal,
      stageId: this.currentStage()?.id ?? null,
      stageTitle: hud.stageTitle,
      text: hud.text,
      count: hud.count,
      goal: hud.goal,
      style: hud.style,
      rank: hud.rank,
      done: s.done,
      stars: s.stars,
      completed: [...s.completedStageIds],
      savedStars: this.progress.stars(this.levelId),
      demo: this.demo !== null,
      demoPlays: this.demoPlays,
      demoLeft: Math.max(0, this.demoLeft),
      suspended: s.suspended,
      gateOpen: Array.from(s.gateOpen),
      gateBlocked: gates.map((_, i) => (world instanceof GatedWorld ? !world.isOpen(i) : false)),
      gates: gates.map((g) => ({ id: g.id, min: vecOf(g.bounds.min), max: vecOf(g.bounds.max) })),
      zones: this.level ? [...this.level.zones.entries()].map(([id, z]) => ({ id, min: vecOf(z.min), max: vecOf(z.max) })) : [],
      hasDemo: this.currentStage()?.demo !== undefined,
      demoGoal: this.demoGoal,
      demoStill: this.demoStill,
      judge: this.lessonJudge,
      task: this.currentStage()?.task ?? null,
      stages: (this.level?.def.training?.stages ?? []).map((st) => ({ id: st.id, title: st.title, rank: st.rank ?? 'required', hasDemo: st.demo !== undefined })),
      tip: s.tip.serial > 0 ? s.tip.text : null,
      tipKind: s.tip.serial > 0 ? s.tip.kind : null,
      tipSerial: s.tip.serial,
      notice: this.hud.currentNotice,
      spawn: { ...vecOf(s.respawnPoint().pos), yaw: s.respawnPoint().yaw },
      result: this.lessonResult,
      resultIn: this.lessonEndIn,
    };
  }

  /** Aktive Stufe der Lektion (aus LessonHud.stageIndex), null = keine Lektion oder alle durch. */
  private currentStage(): StageDef | null {
    const s = this.session;
    const def = this.level?.def.training;
    if (s === null || !def) return null;
    return def.stages[s.hud.stageIndex] ?? null;
  }

  /** Aktuelle Stufe überspringen (zählt nicht) und an ihren Nachfolger setzen. */
  skipStage(): void {
    const s = this.session;
    if (!s || this.currentStage() === null) return;
    this.endDemo(false);
    // Die Session meldet auch das Überspringen als 'lessonStage' (mit dem nächsten Tick) — das ist kein
    // "GESCHAFFT!": kein Blitz, kein Akkord, keine Faust. onTick fängt je Überspringen genau ein Ereignis ab.
    this.skipPending++;
    s.skipStage();
    this.respawn('manual');
  }

  /**
   * Vorführung starten/stoppen (Taste H). play = der Bot spielt die Lektion wirklich (Tools, TU6):
   * die Session läuft weiter, jede neue Stufe startet ihre eigene Vorführung. false = nicht möglich.
   */
  setDemo(on: boolean, play = false): boolean {
    if (!on) {
      this.endDemo(true);
      return true;
    }
    return this.startDemo(play);
  }

  /** Bot übernimmt die Eingabe (null = zurück zum Menschen). */
  useBot(kind: BotKind | null, opts: BotOptions = {}): void {
    this.clearBot();
    if (kind === null) return;
    this.botOpts = opts;
    if (kind === 'route' && (opts.restart ?? true)) this.restartRun();
    this.bot = this.makeBot(kind, opts);
    this.overrideActive = true;
    this.input.setOverride(() => (this.bot ? this.bot.next() : NO_INPUT));
  }

  get botInfo(): BotInfo | null {
    const b = this.bot;
    if (!b) return null;
    if (b.route) {
      const r = b.route.report;
      return { kind: b.kind, status: r.status, reason: r.reason, nextIndex: r.reached, total: r.total };
    }
    return { kind: b.kind, status: 'running', reason: null, nextIndex: 0, total: 0 };
  }

  /** Echtzeit-Ticks anhalten (Rendern läuft weiter); stepTicks spult dann deterministisch vor. */
  freeze(on: boolean): void {
    this.frozen = on;
  }

  stepTicks(n: number): void {
    this.stepping = true;
    try {
      this.loop.stepTicks(n);
    } finally {
      this.stepping = false;
    }
  }

  /** Alles abbauen (Tests, Einbettung). Danach ist die Instanz tot. */
  async dispose(): Promise<void> {
    this.loop.stop();
    this.loadToken++;
    this.clearBot();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('click', this.onCanvasClick);
    this.input.dispose();
    this.menu.dispose();
    this.tuning.dispose();
    this.renderer.dispose();
    await this.audio.dispose();
  }

  /** Aktuelles Level als Titel-Hintergrund vorbereiten (lädt und rendert, ohne zu spielen). */
  async prepareBackdrop(id: string): Promise<void> {
    try {
      const level = await this.getLevel(id);
      if (this.gameState !== 'title' || this.level !== null) return;
      this.setRenderedLevel(level);
      // Leerlauf im Titel: heiße Pfade vorwärmen, bevor jemand spielt.
      this.warmOnce(level);
    } catch {
      // Hintergrund ist Deko — ein Fehler zeigt sich spätestens beim Start des Levels.
    }
  }

  // ================================================================== Menü

  private wireMenu(): void {
    const m = this.menu;
    m.on('play', ({ levelId }) => void this.startLevel(levelId, { gesture: true, lockless: this.lockless }));
    m.on('resume', () => this.requestResume());
    m.on('restart', () => this.restartFromGesture());
    m.on('toTitle', () => this.toTitle());
    m.on('nextLevel', () => {
      const next = this.nextLevelId();
      if (next) void this.startLevel(next, { gesture: true, lockless: this.lockless });
      else this.restartFromGesture();
    });
    m.on('fullscreen', () => void this.input.toggleFullscreen());
    m.on('adminBest', ({ levelId }) => this.adminBestChanged(levelId));
    // Lektion (Pause-Menü): Vorführung erst nach dem Fortsetzen (Lock aus derselben Klick-Geste).
    m.on('demo', () => {
      if (!this.session) return;
      this.pendingDemo = true;
      this.requestResume();
    });
    m.on('skipStage', () => {
      if (!this.session) return;
      this.skipStage();
      this.requestResume();
    });
  }

  /** Pause-Info der laufenden Lektion (null = normales Level). */
  private lessonPauseInfo(): LessonPauseInfo | null {
    const s = this.session;
    if (!s) return null;
    const st = this.currentStage();
    const ranks = (this.level?.def.training?.stages ?? []).map((x) => x.rank ?? 'required');
    return {
      name: this.hudData.levelName,
      stageTitle: st?.title ?? 'ALLES GESCHAFFT',
      stageLabel: stageLabel(ranks, Math.min(s.hud.stageIndex, s.hud.stageTotal - 1)),
      demo: st?.demo !== undefined,
      done: s.done,
      respawnStage: () => {
        this.respawn('manual');
        this.requestResume();
      },
      showResult: () => this.showLessonResult(),
    };
  }

  /**
   * Admin-Menü hat die Bestzeit gesetzt/gelöscht: der alte Ghost gehört zu keiner Bestzeit mehr
   * (eine gesetzte Zeit hat keinen Lauf) → weg, auch aus dem Speicher-Cache des GhostStore.
   * Läuft das Level gerade (Pause), Bestzeit und Nächstes Ziel sofort nachziehen; die laufende
   * Ghost-Aufnahme bleibt unberührt — schlägt der Lauf die neue Zeit, wird er der neue Ghost.
   */
  private adminBestChanged(levelId: string): void {
    this.ghostStore.clear(levelId);
    if (levelId !== this.levelId) return;
    this.ghostTrack = null;
    this.hudData.ghostDiff = null;
    this.bestTime = this.best.get(levelId);
    this.bestSplitsAtStart = this.best.getSplits(levelId);
    const medals = this.level?.def.medals;
    this.hudData.nextMedal = medals ? nextMedal(this.bestTime, medals) : null;
  }

  private restartFromGesture(): void {
    if (!this.level) return;
    const lock = this.lockless ? null : this.requestLockTracked();
    if (lock) this.fullscreenFromGesture(lock);
    this.unlockAudio();
    this.restartRun();
    this.tuning.hide();
    if (lock) {
      const token = this.loadToken;
      void lock.then((ok) => {
        if (!ok && token === this.loadToken) this.lockFailed();
      });
    }
  }

  private requestLockTracked(): Promise<boolean> {
    const p = this.input.requestLock();
    this.menu.trackLock(p, () => this.input.lockError);
    return p;
  }

  /**
   * Einstellung "Vollbild beim Start": erst wenn der Lock-Versuch dieser Geste
   * entschieden ist. requestFullscreen VERBRAUCHT die Nutzeraktivierung, der Lock
   * prüft sie nur — und sein Rückfall ohne Raw (NotSupportedError) kommt erst nach
   * einem await. Vollbild sofort hinterher ließ genau diesen Rückfall scheitern
   * ("A user gesture is required", headless gemessen). Die Aktivierung hält
   * ~5 s, der Lock entscheidet in Millisekunden. Mit Keyboard Lock duckt dann
   * Strg, und Strg+W bleibt im Spiel.
   */
  private fullscreenFromGesture(lock: Promise<boolean>): void {
    if (!this.settings.get().fullscreenOnStart) return;
    void lock.then(() => {
      // Inzwischen zurück im Titel? Dann kein Vollbild mehr erzwingen.
      if (this.gameState !== 'title') void this.input.enterFullscreen();
    });
  }

  /** Lock nach play/restart/next abgelehnt → Pause mit lesbarem Hinweis ("Klicken zum Fortsetzen"). */
  private lockFailed(): void {
    if (this.gameState !== 'playing' || this.input.locked) return;
    this.pause('menu');
    this.menu.setLockStatus({ pending: false, error: this.input.lockError ?? 'pointerlockerror' });
  }

  private lockFailedInPause(): void {
    // "Vorführung ansehen" gilt nur für dieses Fortsetzen — wer danach "Weiter" klickt, will selbst spielen.
    this.pendingDemo = false;
    this.tuning.hide();
    this.pausedFor = 'menu';
    this.menu.showPause(this.lessonPauseInfo());
    this.menu.setLockStatus({ pending: false, error: this.input.lockError ?? 'pointerlockerror' });
  }

  private resume(): void {
    this.gameState = 'playing';
    this.menu.hide();
    this.tuning.hide();
    if (this.pendingDemo) {
      this.pendingDemo = false;
      this.startDemo(false);
    }
  }

  private unlockAudio(): void {
    // Audio ist Beiwerk: ohne Gerät/Geste läuft das Spiel stumm weiter.
    this.audio.unlock().catch(() => undefined);
  }

  private nextLevelId(): string | null {
    const i = this.levels.findIndex((l) => l.id === this.levelId);
    return i >= 0 && i + 1 < this.levels.length ? this.levels[i + 1].id : null;
  }

  // ================================================================== Level

  private getLevel(id: string): Promise<CompiledLevel> {
    let p = this.levelCache.get(id);
    if (!p) {
      const entry = this.levels.find((l) => l.id === id);
      const lesson = entry ? undefined : this.lessons.find((l) => l.id === id);
      // Lektionen liegen unter training/ (file relativ zu training/index.json); nicht im Index
      // (z. B. sandbox): Dateiname = id.
      const file = entry?.file ?? (lesson ? `training/${lesson.file}` : `${id}.json`);
      p = loadLevel(`${this.baseUrl}levels/${file}`);
      this.levelCache.set(id, p);
      // Fehlschlag nicht cachen — ein zweiter Versuch soll neu laden.
      p.catch(() => this.levelCache.delete(id));
    }
    return p;
  }

  private setRenderedLevel(level: CompiledLevel): void {
    if (this.renderedLevel === level) return;
    this.renderer.setLevel(level);
    this.renderedLevel = level;
    const env = level.def.environment;
    const rgb = hexToRgb(env.trimColor);
    this.cpFlashRgb[0] = rgb[0];
    this.cpFlashRgb[1] = rgb[1];
    this.cpFlashRgb[2] = rgb[2];
  }

  /** Movement/Kamera einmal vorwärmen (jitWarmup.ts) — im Titel, spätestens beim ersten Levelstart. */
  private warmOnce(level: CompiledLevel): void {
    if (this.warmMs >= 0) return;
    this.warmMs = warmHotPaths(level.world, this.config, level.spawnPos, level.spawnYaw);
  }

  /** Dauer des JIT-Vorwärmens (ms, −1 = noch nicht) — für Tools. */
  get jitWarmupMs(): number {
    return this.warmMs;
  }

  private applyLevel(id: string, level: CompiledLevel): void {
    this.warmOnce(level);
    this.setRenderedLevel(level);
    this.level = level;
    this.levelId = id;
    // Lektion: Session + GatedWorld (die Session öffnet die Tore darin); sonst die statische Welt.
    let session: LessonSession | null = null;
    let world: CollisionWorld = level.world;
    if (level.def.training) {
      const gated = new GatedWorld(level.world, level.gates);
      world = gated;
      session = new TrainingSession(level, this.config, { world: gated });
      this.lessonDefs.set(id, level.def.training);
    }
    this.session = session;
    this.lessonForceKeys = level.def.training?.hud?.forceKeys === true;
    this.world = world;
    this.demo = null;
    this.demoPlays = false;
    this.resetDemoWatch();
    // Vor dem ersten Frame gesetzt (Tools spulen Ticks auch ohne Frame vor).
    this.lessonJudge = session !== null && session.turnBand(JUDGE_PROBE_SPEED) !== null;
    this.judgeStage = session !== null ? session.hud.stageIndex : -1;
    this.hud.judge = this.lessonJudge;
    this.pendingDemo = false;
    this.skipPending = 0;
    this.lessonEndIn = -1;
    this.lessonResult = null;
    this.progressDirty = false;
    this.tipSerial = session ? session.tip.serial : 0;
    this.movement.setWorld(world);
    this.run = new RunState(level);
    // Lektionen: keine Bestzeit, kein Ghost (Plan 007).
    this.bestSplitsAtStart = session ? null : this.best.getSplits(id);
    this.bestTime = session ? null : this.best.get(id);
    this.run.reset(this.bestSplitsAtStart);
    this.finishResult = null;
    this.coasting = false;
    this.levelSig = levelSignature(level.def);
    if (session) this.clearGhost();
    else this.loadGhost();
    if (session) {
      const sp = session.respawnPoint();
      this.placeAt(sp.pos, sp.yaw);
    } else this.placeAt(level.spawnPos, level.spawnYaw);
    this.fadeT = FADE_TIME;
    this.flashTime = this.flashDur;

    const entry = this.levels.find((l) => l.id === id);
    const lesson = session ? this.lessons.find((l) => l.id === id) : undefined;
    const def = level.def;
    // Lektion: "T3 AIR-STRAFE" (Kürzel + Name) — Intro, Pause und Ergebnis.
    this.hudData.levelName = lesson ? (lesson.name.startsWith(lesson.short) ? lesson.name : `${lesson.short} ${lesson.name}`) : (entry?.name ?? def.name);
    this.hudData.levelSubtitle = lesson?.subtitle ?? entry?.subtitle ?? def.subtitle ?? null;
    this.hudData.nextMedal = def.medals && !session ? nextMedal(this.bestTime, def.medals) : null;
    this.hudData.lesson = session ? session.hud : null;
    this.hud.setLessonStages(def.training ? def.training.stages.map((st) => st.rank ?? 'required') : null);
    this.hudCp.total = this.run.total;
    this.hudCp.index = 0;
    this.coach.lesson = session !== null;
    this.coach.setLevel(def.route);
    this.hud.visible = true;
    this.syncLayout();
    this.prewarmHand();
    this.bus.emit({ type: 'levelLoaded', id, name: this.hudData.levelName, subtitle: this.hudData.levelSubtitle ?? undefined });
  }

  /**
   * Spieler an Fußposition setzen: 1 u anheben und per Trace absetzen (Fläche
   * berühren = startSolid), Blick = yaw (Grad), Pitch 0, Kamera-Effekte neu.
   */
  private placeAt(pos: Vector3, yawDeg: number): void {
    const world = this.level ? this.world : undefined;
    this.placeA.set(pos.x, pos.y + SPAWN_LIFT, pos.z);
    if (world) {
      this.placeB.set(pos.x, pos.y - SPAWN_LIFT, pos.z);
      const tr = world.traceBox(this.placeA, this.placeB, this.standMins, this.standMaxs, this.tr);
      if (!tr.startSolid && !tr.allSolid) this.placeA.copy(tr.endPos);
    }
    // teleport schiebt selbst frei, falls der Punkt doch im Solid liegt (fallen.md #17).
    this.movement.teleport(this.placeA);
    this.movement.copySnapshot(this.cur);
    copySnap(this.cur, this.prev);
    copySnap(this.cur, this.interp);
    const yaw = yawDeg * DEG;
    this.input.setView(yaw, 0);
    this.lastYaw = yaw;
    this.lastPitch = 0;
    this.lastSide = 0;
    this.lastSprint = false;
    this.lastForward = 0;
    this.lastJump = false;
    this.lastCrouch = false;
    this.forwardAirTime = 0;
    this.prevFrameYaw = yaw;
    this.handYaw = yaw;
    this.handPitch = 0;
    this.rig.reset();
  }

  private updateStandHull(): void {
    const h = this.config.hull;
    this.standMins.set(-h.halfWidth, 0, -h.halfWidth);
    this.standMaxs.set(h.halfWidth, h.standHeight, h.halfWidth);
  }

  // ================================================================== Tick

  /** Ticks laufen nur im Spiel — und nach dem Ziel, bis das Ergebnis-Menü kommt. */
  private get ticking(): boolean {
    return this.gameState === 'playing' || (this.gameState === 'finished' && this.coasting);
  }

  private readonly onTick = (dt: number, i: number, n: number, u: number): void => {
    if (!this.ticking || (this.frozen && !this.stepping)) return;
    const cmd = this.input.tickInput(i, n, u);
    const dYaw = cmd.yaw - this.lastYaw;
    this.lastYaw = cmd.yaw;
    this.lastPitch = cmd.pitch;
    this.lastSide = cmd.side;
    this.lastSprint = cmd.sprint;
    this.lastForward = cmd.forward;
    this.lastJump = cmd.jumpHeld;
    this.lastCrouch = cmd.crouch;

    copySnap(this.cur, this.prev);
    const events = this.movement.tick(cmd);
    // Kamera kennt die Tick-Grenze (Lip-Step-Versatz gegen die Interpolation), vor den Events des Ticks.
    this.rig.onTick();
    for (let k = 0; k < events.length; k++) this.bus.emit(events[k]);
    this.movement.copySnapshot(this.cur);
    this.mirrorStrafe(dt, dYaw, cmd);
    this.coach.tick(dt, this.prev, this.cur, cmd);
    const session = this.session;
    if (session !== null) {
      const hullH = this.movement.hullMaxs.y - this.movement.hullMins.y;
      const out = this.lessonEvents;
      out.length = 0;
      const t0 = this.costProbe ? performance.now() : 0;
      session.tick(dt, this.prev, this.cur, cmd, hullH, out);
      if (this.costProbe) this.lessonTickCpuSum += performance.now() - t0;
      for (let k = 0; k < out.length; k++) {
        const e = out[k];
        // Übersprungen-Ereignisse stehen vorn (Session-Warteschlange geht vor dem Tick raus).
        if (e.type === 'lessonStage' && this.skipPending > 0) this.stageSkipped();
        else this.bus.emit(e);
      }
      if (this.demo !== null) {
        this.demoLeft -= dt;
        if (!this.demoPlays) this.watchDemo(dt, cmd, hullH);
      }
    }
    this.runTick(dt);
    const run = this.run;
    if (session === null && run !== null && run.running) this.ghostRec.sample(run.time ?? 0, this.cur.pos, this.lastYaw);
    if (++this.nearTick >= NEAR_EVERY) {
      this.nearTick = 0;
      this.probeNear();
    }
  };

  /**
   * Zwei kurze seitliche Proben quer zur Flugrichtung: Abstand (u) zur nächsten
   * Geometrie links/rechts für den Vorbeizieh-Whoosh. Infinity = nichts in Reichweite.
   */
  private probeNear(): void {
    const world = this.level ? this.world : undefined;
    const s = this.cur;
    if (!world || !this.nearProbeEnabled || s.speed < NEAR_MIN_SPEED) {
      this.nearL = Infinity;
      this.nearR = Infinity;
      return;
    }
    // Rechts von der Flugrichtung: (−vz, 0, vx) / |v_h|.
    const inv = 1 / s.speed;
    const rx = -s.vel.z * inv;
    const rz = s.vel.x * inv;
    this.nearR = this.nearDist(world, rx, rz);
    this.nearL = this.nearDist(world, -rx, -rz);
    // Die Rampe, auf der man surft, zieht nicht vorbei — sonst rauschte der Whoosh den ganzen
    // Surf lang voll (Level 2: 3/4 aller Treffer). Ihre Normale zeigt von der Rampe weg.
    if (s.surfing) {
      const side = rx * s.surfNormal.x + rz * s.surfNormal.z;
      if (side < -NEAR_SURF_SIDE) this.nearR = Infinity;
      else if (side > NEAR_SURF_SIDE) this.nearL = Infinity;
    }
  }

  private nearDist(world: CollisionWorld, dx: number, dz: number): number {
    const p = this.cur.pos;
    this.nearEnd.set(p.x + dx * NEAR_RANGE, p.y, p.z + dz * NEAR_RANGE);
    const tr = world.traceBox(p, this.nearEnd, this.nearMins, this.nearMaxs, this.tr);
    if (tr.startSolid || tr.fraction >= 1) return Infinity;
    return tr.fraction * NEAR_RANGE + NEAR_HALF;
  }

  /** Spiel-Events, auf die Game selbst reagiert: Ghost-Aufnahme/-Abstand, Landewelle. Tick-Pfad — nichts allokieren. */
  private onGameEvent(e: GameEvent): void {
    switch (e.type) {
      case 'runStart':
        this.ghostRec.reset();
        this.hudData.ghostDiff = null;
        break;
      case 'checkpoint':
        if (this.ghostTrack && this.ghostOn) this.hudData.ghostDiff = ghostDiff(this.ghostTrack, e.index, e.time);
        break;
      case 'respawn':
        if (e.reason === 'restart') this.hudData.ghostDiff = null;
        break;
      case 'lessonStage': {
        // Tick-Pfad: nur Merker; Speichern und Ergebnis im Frame.
        this.progressDirty = true;
        this.startFlash(this.cpFlashRgb, FLASH_CP, FLASH_CP_TIME);
        const s = this.session;
        // Letzte Stufe geschafft → kurz feiern, dann das Ergebnis. Nach "bestanden" mit offenen
        // Bonus-/Meisterstufen geht es weiter (Enter zeigt das Ergebnis jederzeit).
        if (s !== null && s.hud.stageIndex >= s.hud.stageTotal) this.lessonEndIn = LESSON_RESULT_DELAY;
        break;
      }
      case 'jump':
        // Landewelle nur für gute Hops: verlustfrei (perfekt oder in der Lande-Gnade), synchron und mit Gewinn.
        // Ursprung = Füße beim Absprung.
        if (e.clean && e.sync > WAVE_MIN_SYNC && e.gain > 0) {
          this.landPos.copy(this.prev.pos);
          this.fx.landTime = this.time;
          this.fx.landPower = Math.min(1, e.sync * Math.min(1, e.gain / WAVE_FULL_GAIN));
        }
        break;
      default:
        break;
    }
  }

  /** Ghost des aktuellen Levels laden (Levelstart, Neustart — nach einer neuen Bestzeit ist es die neue). */
  private loadGhost(): void {
    this.ghostTrack = this.levelId ? this.ghostStore.load(this.levelId, this.levelSig) : null;
    this.ghostRec.stop();
    this.hudData.ghostDiff = null;
  }

  /**
   * Strafe-Spiegel für die Showkeys: in einem Luft-Tick mit A/D passt die Taste
   * zur Maus, wenn sie in Drehrichtung zeigt (D + nach rechts = yaw fällt).
   * Gezählt bis zum nächsten Frame; Surfen bleibt neutral (dort zählt die Rampe, nicht die Maus).
   */
  private mirrorStrafe(dt: number, dYaw: number, cmd: PlayerInput): void {
    const air = !this.prev.onGround && !this.cur.onGround && !this.cur.surfing;
    if (air && cmd.side !== 0 && cmd.forward > 0) this.forwardAirTime += dt;
    else this.forwardAirTime = 0;
    if (!air || cmd.side === 0 || Math.abs(dYaw) < MIRROR_MIN_TURN * dt) return;
    if (cmd.side * dYaw > 0) this.strafeBadTicks++;
    else if (this.cur.speed > this.prev.speed + 1e-3) this.strafeGoodTicks++;
  }

  private showHint(id: HintId, verdict: Verdict | null): void {
    const crouch = this.settings.get().keybinds.crouch[0];
    const key = crouch !== undefined ? keyShortLabel(crouch) : '?';
    this.hud.showNotice(hintText(id, verdict, key), 'coach');
  }

  private runTick(dt: number): void {
    const run = this.run;
    if (!run) return;
    const s = this.movement.state;
    const outcome = run.tick(dt, s.pos, this.movement.hullMins, this.movement.hullMaxs, s.speed, s.onGround, this.runEvents);
    const evs = this.runEvents;
    const session = this.session;
    if (session !== null) {
      // Lektion: kein Timer, keine Checkpoints — nur Tempo-Meilensteine, Absturz und das Portal.
      for (let k = 0; k < evs.length; k++) if (evs[k].type === 'speedMilestone') this.bus.emit(evs[k]);
      if (outcome === 'fall' || outcome === 'kill') {
        if (this.demo !== null) this.endDemo(false);
        this.respawn(outcome);
      } else if (outcome === 'finish') {
        // Ziel-Trigger = Portal hinter dem Ausgangstor: bestanden → Ergebnis (kurzer Blitz vorher).
        // Vorher (Tor zu, sollte nicht erreichbar sein) zählt es nicht und bleibt scharf.
        if (session.done && this.lessonEndIn < 0 && this.demo === null) {
          this.startFlash(FINISH_RGB, FLASH_FINISH, FLASH_FINISH_TIME);
          this.lessonEndIn = PORTAL_RESULT_DELAY;
        } else run.reset(null);
      }
      return;
    }
    for (let k = 0; k < evs.length; k++) {
      const e = evs[k];
      this.bus.emit(e);
      if (e.type === 'checkpoint') this.startFlash(this.cpFlashRgb, FLASH_CP, FLASH_CP_TIME);
    }
    if (outcome === 'finish') {
      this.finishRun();
    } else if (outcome === 'fall' || outcome === 'kill') {
      // Nach dem Ziel wird nicht mehr respawnt — der Flug endet einfach.
      if (this.gameState === 'finished') this.coasting = false;
      else this.respawn(outcome);
    }
  }

  private respawn(reason: 'fall' | 'kill' | 'manual'): void {
    const run = this.run;
    if (!run) return;
    const session = this.session;
    if (session !== null) {
      // Lektion: immer an den Start der aktuellen Stufe (kein Tod, kein Timer).
      const sp = session.respawnPoint();
      this.placeAt(sp.pos, sp.yaw);
      this.bus.emit(reason === 'kill' ? RESPAWN_KILL : reason === 'manual' ? RESPAWN_MANUAL : RESPAWN_FALL);
      this.startFade();
      return;
    }
    if (reason !== 'manual') this.bot?.route?.fail(reason === 'kill' ? 'kill' : 'fell', this.movement.state);
    // Vor dem ersten Checkpoint zurück an den Start = neuer Versuch, Timer aus.
    if (run.checkpoint === 0) run.reset(this.bestSplitsAtStart);
    const sp = run.respawnPoint();
    this.placeAt(sp.pos, sp.yaw);
    this.bus.emit(reason === 'kill' ? RESPAWN_KILL : reason === 'manual' ? RESPAWN_MANUAL : RESPAWN_FALL);
    this.startFade();
  }

  private finishRun(): void {
    const run = this.run;
    const level = this.level;
    if (!run || !level) return;
    const time = run.time ?? 0;
    const splits = run.splits();
    const bestSplits = this.bestSplitsAtStart;
    const res = this.best.submit(this.levelId, time, splits);
    this.bestTime = this.best.get(this.levelId);
    this.hudData.nextMedal = level.def.medals ? nextMedal(this.bestTime, level.def.medals) : null;
    // Neue Freischaltung? Groß im Ergebnis zeigen und gleich anlegen — das ist der Belohnungsmoment.
    const fresh = this.unlocks.sync(this.levels, (id) => this.best.get(id), this.progress);
    if (fresh.length > 0) {
      // Die neueste Freischaltung gleich anlegen (Reihenfolge wie UNLOCKS: späteres gewinnt).
      let patch: SettingsPatch = {};
      for (const id of fresh) patch = { ...patch, ...unlockPatch(id) };
      this.settings.update(patch);
    }
    // Ghost: Abstand im Ziel zum alten Ghost, dann bei neuer Bestzeit diesen Lauf als neuen Ghost ablegen.
    this.ghostRec.sample(time, this.cur.pos, this.lastYaw);
    if (this.ghostTrack && this.ghostOn) this.hudData.ghostDiff = ghostDiff(this.ghostTrack, 0, time);
    const track = this.ghostRec.finish(this.levelSig, time, splits);
    if (res.best && track) this.ghostStore.save(this.levelId, track);
    else if (res.best) this.ghostStore.clear(this.levelId);
    const e = this.finishEvent;
    e.time = time;
    e.best = res.best;
    e.previousBest = res.previous;
    this.bus.emit(e);
    this.startFlash(FINISH_RGB, FLASH_FINISH, FLASH_FINISH_TIME);
    this.gameState = 'finished';
    this.coasting = true;
    this.finishElapsed = 0;
    this.finishResult = {
      levelId: this.levelId,
      levelName: this.hudData.levelName,
      time,
      previousBest: res.previous,
      isBest: res.best,
      parTime: level.def.parTime ?? null,
      splits,
      bestSplits,
      hasNext: this.nextLevelId() !== null,
      topSpeed: run.topSpeed,
      medals: level.def.medals ?? null,
      unlocked: fresh.map((id) => unlockDef(id).name),
    };
  }

  private showFinishMenu(): void {
    if (!this.finishResult) return;
    this.coasting = false;
    this.input.exitLock();
    this.tuning.hide();
    this.menu.showFinish(this.finishResult);
  }

  // ================================================================== Frame

  private readonly onFrame = (alpha: number, frameDtRaw: number, now: number): void => {
    const cpu0 = performance.now();
    // Große Sprünge (stepTicks, Ruckler) nicht an Effekte und Musik weiterreichen.
    const frameDt = Math.min(Math.max(frameDtRaw, 0), 0.1);
    this.lastFrameDt = frameDt;
    this.time += frameDt;
    this.countFps(now);

    const actions = this.input.consumeActions();
    for (let k = 0; k < actions.length; k++) {
      const a = actions[k];
      if (this.menu.visible && this.menu.handleAction(a)) continue;
      this.handleAction(a);
    }
    if (this.session !== null) {
      const l0 = performance.now();
      this.updateLesson(frameDt);
      this.lessonCpuSum += performance.now() - l0;
    }

    if (this.gameState === 'finished' && this.coasting) {
      this.finishElapsed += frameDt;
      if (this.finishElapsed >= FINISH_MENU_DELAY) this.showFinishMenu();
    } else if (this.gameState === 'finished' && !this.menu.visible && this.finishResult) {
      // Flug im Ziel beendet (Tod nach dem Ziel) → Ergebnis sofort.
      this.showFinishMenu();
    }

    this.updateLeaveGuard();
    this.updateCamera(alpha, frameDt);
    this.updateGhost(alpha);
    this.updateAudio(frameDt);
    this.updateHud(frameDt);
    this.updateFx(frameDt);
    this.renderer.render(this.camera, this.fx);
    this.frameCpuSum += performance.now() - cpu0;
    this.frameCpuN++;
  };

  /**
   * Mittlere CPU-Zeit des Frame-Callbacks (ms) seit dem letzten Aufruf, davon die Frame-Arbeit der
   * Lektion (lessonMs), und Anzahl Frames; setzt zurück.
   */
  takeFrameCost(): { readonly ms: number; readonly lessonMs: number; readonly lessonTickMs: number; readonly frames: number } {
    const n = this.frameCpuN;
    // lessonTickMs = Session-Ticks je Frame (Tick-Pfad, läuft im selben rAF-Callback vor onFrame).
    const ticks = this.lessonTickCpuSum;
    const r = { ms: n > 0 ? this.frameCpuSum / n : 0, lessonMs: n > 0 ? this.lessonCpuSum / n : 0, lessonTickMs: n > 0 ? ticks / n : 0, frames: n };
    this.frameCpuSum = 0;
    this.lessonCpuSum = 0;
    this.lessonTickCpuSum = 0;
    this.costProbe = true;
    this.frameCpuN = 0;
    return r;
  }

  private handleAction(a: InputAction): void {
    const st = this.gameState;
    switch (a) {
      case 'pause':
        if (st === 'playing') this.pause('menu');
        else if (st === 'paused' && this.pausedFor === 'tuning') {
          this.tuning.hide();
          this.pausedFor = 'menu';
          this.menu.showPause(this.lessonPauseInfo());
        } else if (st === 'finished' && !this.menu.visible) this.showFinishMenu();
        break;
      case 'restart':
        if (st === 'playing' || (st === 'finished' && !this.menu.visible)) this.restartRun();
        else if (st === 'paused' && !this.menu.visible) this.restartFromGesture();
        break;
      case 'respawn':
        // Nur im laufenden Spiel; vor CP 1 ist es ein neuer Versuch vom Start (wie ein Absturz).
        if (st === 'playing') this.respawn('manual');
        break;
      case 'confirm':
        // Enter ist eine User-Geste: aus dem Tuning-Stand direkt weiter.
        if (st === 'paused' && this.pausedFor === 'tuning') this.requestResume();
        else if (st === 'finished' && this.coasting) this.showFinishMenu();
        // Lektion bestanden (Bonusstufen offen): Enter zeigt das Ergebnis.
        else if (st === 'playing' && this.session?.done === true && this.demo === null) this.showLessonResult();
        break;
      case 'toggleTuning':
        this.toggleTuning();
        break;
      case 'toggleMute':
        this.muted = !this.muted;
        this.applyVolumes(this.settings.get());
        this.hud.showNotice(this.muted ? 'Ton aus  [M]' : 'Ton an');
        break;
      case 'demo':
        // Vorführung im Training (Plan 007): H startet, H (oder jede andere Taste) beendet.
        if (st !== 'playing' || this.session === null) break;
        if (this.demo !== null) this.endDemo(true);
        else this.startDemo(false);
        break;
    }
  }

  // ================================================================== Training

  /**
   * Pro Frame in einer Lektion: Tore auflösen, Vorführung beenden (Zeit um / Taste), Tipp ins
   * Coach-Band, Fortschritt speichern, Ergebnis nach der letzten Stufe. Frame-Pfad: nur Zahlen,
   * gespeichert wird nur nach einer Stufe (selten).
   */
  private updateLesson(frameDt: number): void {
    const s = this.session;
    if (s === null) return;
    const live = this.gameState === 'playing' && !this.frozen;
    if (live) s.update(frameDt);
    if (s.hud.stageIndex !== this.judgeStage) {
      // Selten (Stufenwechsel): turnBand ist nur je Stufe null oder nicht, das Tempo zählt dafür nicht.
      this.judgeStage = s.hud.stageIndex;
      this.lessonJudge = s.turnBand(JUDGE_PROBE_SPEED) !== null;
    }
    if (this.demo !== null && this.gameState === 'playing') {
      const keyed = !this.demoPlays && this.input.anyKeyDown();
      // Zuschauen endet, sobald es nichts mehr zu sehen gibt: Ziel gezeigt (+ kurze Pause), Bot steht, Zeit um.
      const shown = this.demoGoal && this.demoGoalLeft <= 0;
      if (keyed || this.demoLeft <= 0 || shown || this.demoStill >= DEMO_STILL_END) this.endDemo(true);
      else if (this.demoPlays && s.hud.stageIndex !== this.demoStage) {
        // Bot spielt: neue Stufe → deren Vorführung (vom Stufen-Spawn), fertig → aus.
        if (this.currentStage()?.demo !== undefined) this.startDemo(true);
        else this.endDemo(false);
      }
    }
    if (s.tip.serial !== this.tipSerial) {
      this.tipSerial = s.tip.serial;
      // Tipps der Lektion im Coach-Band; "[H]" zeigt die echte Vorführungs-Taste. Ist keine belegt,
      // entfällt ein Tipp, der auf sie verweist (er würde auf eine tote Taste zeigen). Selten: darf bauen.
      const text = s.tip.text;
      const refersDemo = text.includes('[H]');
      // Urteils-Tipps nur, wo Strafen bewertet wird ("W LOSLASSEN" in T2 LENKEN widersprach dem Stufentext).
      const off = s.tip.kind === 'verdict' && !this.lessonJudge;
      if (!s.suspended && !off && !(refersDemo && this.demoKey === null)) {
        this.hud.showNotice(refersDemo && this.demoKey !== null && this.demoKey !== 'H' ? text.split('[H]').join(`[${this.demoKey}]`) : text, 'coach');
      }
    }
    if (this.progressDirty) {
      this.progressDirty = false;
      this.saveProgress();
    }
    if (this.lessonEndIn >= 0 && live) {
      this.lessonEndIn -= frameDt;
      if (this.lessonEndIn < 0) this.showLessonResult();
    }
    const hud = this.hud;
    hud.demo = this.demo !== null && !this.demoPlays;
    hud.demoGoal = hud.demo && this.demoGoal;
    hud.judge = this.lessonJudge;
    hud.lessonDone = s.done && s.hud.stageIndex < s.hud.stageTotal;
    hud.demoAvailable = this.currentStage()?.demo !== undefined && this.demoKey !== null;
    this.fx.gateOpen = s.gateOpen;
  }

  /**
   * Vorführung der aktuellen Stufe: an den Stufen-Spawn, Bot der Stufe (DemoDef) übernimmt die Eingabe,
   * die Session hält an (nichts zählt), HUD zeigt das Demo-Band und die Tasten des Bots.
   * play = Tools: der Bot spielt wirklich (Session läuft). false = Stufe ohne Vorführung.
   */
  private startDemo(play: boolean): boolean {
    const s = this.session;
    const level = this.level;
    const demo = this.currentStage()?.demo;
    if (!s || !level || !demo || this.gameState !== 'playing') {
      if (s && !demo && this.gameState === 'playing') this.hud.showNotice('FÜR DIESE STUFE GIBT ES KEINE VORFÜHRUNG');
      return false;
    }
    this.clearBot();
    const sp = s.respawnPoint();
    // Kopie: respawnPoint() liefert ein wiederverwendetes Objekt.
    const spawn = { pos: sp.pos.clone(), yaw: sp.yaw };
    this.placeAt(spawn.pos, spawn.yaw);
    // Tools: echte Läufe verwerfen Laufendes wie ein Respawn (Judge, Serien); die Vorführung
    // setzt dafür suspended (die Session räumt beim Umschalten selbst auf).
    if (play) this.bus.emit(RESPAWN_MANUAL);
    s.suspended = !play;
    const runner = createDemo(demo, level, this.config, this.world, spawn);
    this.demo = runner;
    this.demoLeft = runner.seconds;
    this.demoPlays = play;
    this.demoStage = s.hud.stageIndex;
    this.resetDemoWatch();
    // Zuschauen: der Schatten erkennt, wann der Bot die Stufe geschafft hätte (Tools spielen echt, ohne Schatten).
    if (!play) this.demoShadow = this.makeDemoShadow(level, s.hud.stageIndex);
    const pm = this.movement;
    this.overrideActive = true;
    this.input.setOverride(() => (this.demo !== null ? this.demo.next(pm.state, pm.surfNormal) : NO_INPUT));
    this.startFade();
    // Der Druck, der die Vorführung gestartet hat, beendet sie nicht gleich wieder.
    this.input.anyKeyDown();
    return true;
  }

  /**
   * Schatten-Session an Stufe `stage` (ohne Welt: Tore betreffen nur die Kollision, die die echte GatedWorld
   * trägt). Einmal je Vorführung, nicht im Tick-Pfad. null = Stufe nicht erreichbar (sollte nicht vorkommen).
   */
  private makeDemoShadow(level: CompiledLevel, stage: number): TrainingSessionApi | null {
    const sh = new TrainingSession(level, this.config, { world: null });
    // Über den Vertrag an die Stufe: Überspringen (die gemeldeten Ereignisse verwirft watchDemo).
    for (let i = 0; i < stage && sh.hud.stageIndex < stage; i++) sh.skipStage();
    return sh.hud.stageIndex === stage ? sh : null;
  }

  /**
   * Tick-Pfad während einer Vorführung (nicht demoPlays): Schatten mit den Ticks des Bots füttern — wechselt
   * seine Stufe, ist das Ziel erreicht ("SO GEHT'S!", nach DEMO_GOAL_HOLD zurück). Dazu Stillstand messen.
   */
  private watchDemo(dt: number, cmd: PlayerInput, hullH: number): void {
    const sh = this.demoShadow;
    if (sh !== null) {
      const out = this.shadowEvents;
      out.length = 0;
      sh.tick(dt, this.prev, this.cur, cmd, hullH, out);
      out.length = 0;
      if (sh.hud.stageIndex !== this.demoStage) {
        this.demoShadow = null;
        this.demoGoal = true;
        this.demoGoalLeft = DEMO_GOAL_HOLD;
      }
    } else if (this.demoGoal) this.demoGoalLeft -= dt;
    if (this.cur.speed >= DEMO_STILL_SPEED) {
      this.demoMoved = true;
      this.demoStill = 0;
    } else if (this.demoMoved) this.demoStill += dt;
  }

  /** Beobachtung der Vorführung zurücksetzen (Start, Ende, Levelwechsel). */
  private resetDemoWatch(): void {
    this.demoShadow = null;
    this.demoGoal = false;
    this.demoGoalLeft = 0;
    this.demoMoved = false;
    this.demoStill = 0;
    this.hud.demoGoal = false;
  }

  /** Vorführung beenden; teleport = zurück an den Stufen-Spawn (Fortschritt unverändert). */
  private endDemo(teleport: boolean): void {
    if (this.demo === null) return;
    this.demo = null;
    this.demoPlays = false;
    this.demoStage = -1;
    this.resetDemoWatch();
    if (this.overrideActive) {
      // Ohne Teleport dort weiterschauen, wo der Bot zuletzt hinsah (sonst springt der Blick zurück).
      this.input.setOverride(null);
      this.input.setView(this.lastYaw, this.lastPitch);
    }
    this.overrideActive = false;
    const s = this.session;
    if (s !== null) {
      s.suspended = false;
      if (teleport) {
        const sp = s.respawnPoint();
        this.placeAt(sp.pos, sp.yaw);
        this.startFade();
      }
    }
    this.hud.demo = false;
    this.input.anyKeyDown();
  }

  /** Übersprungene Stufe: nur die Buchführung von 'lessonStage' (ohne Feier) — Ergebnis nach der letzten. */
  private stageSkipped(): void {
    this.skipPending--;
    this.progressDirty = true;
    const s = this.session;
    if (s !== null && s.hud.stageIndex >= s.hud.stageTotal) this.lessonEndIn = LESSON_RESULT_DELAY;
  }

  /** Lektion von vorn (R): Fortschritt der Sitzung weg, Tore zu, Start der ersten Stufe. */
  private restartLesson(): void {
    const s = this.session;
    if (!s) return;
    this.endDemo(false);
    // skipPending bleibt: restartLesson leert die Warteschlange der Session nicht — ein vorher übersprungenes
    // 'lessonStage' kommt trotzdem mit dem nächsten Tick und darf nicht gefeiert werden.
    s.restartLesson();
    const sp = s.respawnPoint();
    this.placeAt(sp.pos, sp.yaw);
    this.bus.emit(RESPAWN_RESTART);
    this.startFade();
    this.lessonEndIn = -1;
    this.lessonResult = null;
    this.gameState = 'playing';
    this.menu.hide();
  }

  /** Erledigte Stufen der Sitzung in den Fortschritt (Vereinigung, Sterne nur nach oben). */
  private saveProgress(): void {
    const s = this.session;
    const def = this.level?.def.training;
    if (s === null || !def || s.completedStageIds.length === 0) return;
    this.progress.record(this.levelId, def.stages, s.completedStageIds);
  }

  /** Ergebnis der Lektion: speichern, Freischaltungen, Menü 'lessonDone'. */
  private showLessonResult(): void {
    const s = this.session;
    if (s === null) return;
    this.endDemo(false);
    this.saveProgress();
    const fresh = this.unlocks.sync(this.levels, (id) => this.best.get(id), this.progress);
    if (fresh.length > 0) {
      let patch: SettingsPatch = {};
      for (const id of fresh) patch = { ...patch, ...unlockPatch(id) };
      this.settings.update(patch);
    }
    const done = new Set(s.completedStageIds);
    const i = this.lessons.findIndex((l) => l.id === this.levelId);
    const r: LessonResult = {
      lessonId: this.levelId,
      name: this.hudData.levelName,
      stars: s.stars,
      stages: (this.level?.def.training?.stages ?? []).map((st) => ({ id: st.id, title: st.title, rank: st.rank ?? 'required', done: done.has(st.id) })),
      nextLessonId: i >= 0 && i + 1 < this.lessons.length ? this.lessons[i + 1].id : null,
      unlocked: fresh.map((id) => unlockDef(id).name),
    };
    this.lessonResult = r;
    this.lessonEndIn = -1;
    this.gameState = 'finished';
    this.coasting = false;
    this.input.exitLock();
    this.tuning.hide();
    this.menu.showLessonDone(r);
  }

  /** Normales Level ohne Ghost (Lektion): Anzeige und Aufnahme aus. */
  private clearGhost(): void {
    this.ghostTrack = null;
    this.ghostRec.stop();
    this.hudData.ghostDiff = null;
  }

  private toggleTuning(): void {
    if (this.tuning.visible) {
      this.tuning.hide();
      // F1 ist eine User-Geste — direkt zurück ins Spiel.
      if (this.gameState === 'paused' && this.pausedFor === 'tuning') this.requestResume();
      return;
    }
    if (this.gameState === 'playing') this.pause('tuning');
    else this.tuning.show();
  }

  private updateCamera(alpha: number, frameDt: number): void {
    if (this.gameState === 'title' || this.level === null) {
      this.updateBackdrop(frameDt);
      return;
    }
    const ticking = this.ticking && !this.frozen;
    if (ticking) lerpSnapshot(this.prev, this.cur, alpha, this.interp);
    else copySnap(this.cur, this.interp);
    cameraViewFromSnapshot(this.interp, this.lastSprint, this.lastSide, this.view, ticking ? alpha : 1);
    // Blick immer frisch aus der Maus — nie der des letzten Ticks (außer ein Bot/Override steuert).
    this.rig.update(ticking ? frameDt : 0, this.view, this.viewYaw, this.viewPitch);
  }

  /**
   * Ghost zeitsynchron zum Run-Timer: dieselbe Interpolation wie der Spieler (alpha
   * zwischen den letzten beiden Ticks). Vor dem Start steht er am Spawn (Sample 0).
   */
  private updateGhost(alpha: number): void {
    const track = this.ghostTrack;
    const run = this.run;
    if (!track || !run || !this.ghostOn || this.gameState === 'title' || this.gameState === 'loading') {
      this.renderer.setGhost(null, 0);
      this.hudData.ghostOverHud = false;
      return;
    }
    const rt = run.time;
    const ticking = this.ticking && !this.frozen && run.running;
    const t = rt === null ? -1 : ticking ? rt - (1 - alpha) / this.loop.tickRate : rt;
    const yaw = ghostPoseAt(track, t, this.ghostPos);
    this.renderer.setGhost(Number.isNaN(yaw) ? null : this.ghostPos, yaw);
    this.hudData.ghostOverHud = !Number.isNaN(yaw) && this.ghostBehindSpeedometer();
  }

  /**
   * Liegt der Ghost im Bild hinter dem Speedometer-Block? Dann dimmt das HUD den
   * Block — sonst verdeckten "536 / ×8 SYNC" genau den Ghost, an dem man sich misst
   * (Prüfung 27.09.). Box aus Hud.speedBlockRows, erweitert um die halbe Ghost-Größe.
   */
  private ghostBehindSpeedometer(): boolean {
    const cam = this.camera;
    const p = this.ghostNdc.copy(this.ghostPos);
    p.y += GHOST_MID_Y;
    const dist = p.distanceTo(cam.position);
    if (dist > GHOST_HUD_RANGE || dist < 1) return false;
    cam.updateMatrixWorld();
    p.project(cam);
    if (p.z < -1 || p.z > 1) return false;
    const h = this.hud.height;
    const w = this.hud.width;
    // Halbe Ghost-Höhe in HUD-Pixeln.
    const r = (GHOST_HALF_H / (dist * Math.tan((cam.fov * DEG) / 2))) * 0.5 * h;
    const sy = (1 - p.y) * 0.5 * h;
    const sx = p.x * 0.5 * w;
    return sy > this.hud.speedBlockTop() - r && sy < this.hud.speedBlockBottom() + r && Math.abs(sx) < SPEED_BLOCK_HALF_W + 0.5 * r;
  }

  private updateBackdrop(frameDt: number): void {
    const level = this.renderedLevel;
    this.backdropT += frameDt;
    if (!level) {
      this.camera.position.set(0, 200, 0);
      this.camera.rotation.set(0, this.backdropT * BACKDROP_TURN, 0, 'YXZ');
      return;
    }
    const sp = level.spawnPos;
    this.camera.position.set(sp.x, sp.y + BACKDROP_LIFT, sp.z);
    this.camera.rotation.set(-0.08, level.spawnYaw * DEG + this.backdropT * BACKDROP_TURN, 0, 'YXZ');
  }

  private updateAudio(frameDt: number): void {
    const d = this.drive;
    const s = this.interp;
    d.speed = s.speed;
    d.onGround = s.onGround;
    d.hopChain = s.hopChain;
    d.strafeSync = s.strafeSync;
    d.airTime = s.airTime;
    d.surfing = s.surfing;
    d.sliding = s.sliding;
    const live = this.ticking && !this.frozen;
    d.nearL = live ? this.nearL : Infinity;
    d.nearR = live ? this.nearR : Infinity;
    // Menü/Pause/Ergebnis: dumpf, nicht stumm.
    d.active = this.ticking && !this.menu.visible;
    this.audio.update(d, frameDt);
    const beat = this.audio.beat();
    this.fx.kick = beat.kick;
    this.fx.energy = beat.energy;
  }

  private updateHud(frameDt: number): void {
    const d = this.hudData;
    const s = this.interp;
    const run = this.run;
    // Lektion mit forceKeys: Showkeys immer an (sie sind dort Teil der Anleitung).
    d.showKeys = this.showKeysSetting || this.lessonForceKeys;

    d.speed = s.speed;
    d.hopChain = s.hopChain;
    d.strafeSync = s.strafeSync;
    d.onGround = s.onGround;
    d.surfing = s.surfing;
    d.runTime = run ? run.time : null;
    d.running = run ? run.running : false;
    this.hudCp.index = run ? run.checkpoint : 0;
    this.hudCp.total = run ? run.total : 0;
    d.bestTime = this.bestTime;
    d.paused = this.menu.visible || this.gameState === 'paused' || this.gameState === 'loading';
    this.updateHudKeys(frameDt);
    // HUD nur im Spiel und unter dem Pause-Menü — unter Titel/Einstellungen/Ergebnis schiene der Timer durch.
    const screen = this.menu.screen;
    this.hud.visible = this.level !== null && this.gameState !== 'title' && (screen === null || screen === 'pause');
    this.hud.update(frameDt, d);
    this.updateHand(frameDt);
    this.hud.draw();
  }

  /**
   * View-Hand füttern: interpolierter Snapshot, Blick-Delta dieses Frames, A/D und die
   * Surf-Normale quer zur Blickrichtung. Steht mit dem Spiel (Pause, Frieren) still.
   */
  private updateHand(frameDt: number): void {
    const inp = this.handIn;
    const s = this.interp;
    const yaw = this.viewYaw;
    const pitch = this.viewPitch;
    inp.yawDelta = yaw - this.handYaw;
    inp.pitchDelta = pitch - this.handPitch;
    this.handYaw = yaw;
    this.handPitch = pitch;
    inp.speed = s.speed;
    inp.onGround = s.onGround;
    inp.surfing = s.surfing;
    inp.ducked = s.ducked;
    inp.stridePhase = s.stridePhase;
    inp.airTime = s.airTime;
    inp.side = this.lastSide;
    // Rechts = (cos yaw, 0, −sin yaw) — Konvention aus player/types.
    inp.surfSide = s.surfing ? s.surfNormal.x * Math.cos(yaw) - s.surfNormal.z * Math.sin(yaw) : 0;
    const live = this.ticking && !this.frozen && !this.menu.visible;
    this.hand.update(live ? frameDt : 0, inp);
    // Wie früher im HUD: nur im Spiel sichtbar, nicht unter Pause/Titel/Ergebnis.
    this.fx.viewModel = this.hand.output(this.hud.visible && !this.hudData.paused);
  }

  /** View-Hand für Tools (__vel.hand). */
  handState(): ViewHandState {
    return this.hand.state();
  }

  /** Tools: Trick des gehaltenen Gegenstands starten/festhalten (__vel.forceTrick). false = unbekannt. */
  forceTrick(name: string, at: number): boolean {
    return this.hand.forceTrick(name, at);
  }

  /** Tools: Pose der View-Hand erzwingen (Index aus HAND_POSES), −1 = normal. */
  forceHandPose(pose: number): void {
    this.hand.force = pose;
  }

  private updateHudKeys(frameDt: number): void {
    const k = this.hudKeys;
    k.forward = this.lastForward;
    k.side = this.lastSide;
    k.jump = this.lastJump;
    k.crouch = this.lastCrouch;
    k.inAir = !this.interp.onGround && !this.interp.surfing;
    const yaw = this.viewYaw;
    // Anzeige-Wert, nicht der Blick: der Balken darf ruhig einen Frame alt sein.
    // `| 0` hält die Felder als Smi: Math.round liefert sonst einen Double, und der kalte
    // Leser (Hud.drawKeys) boxt ihn bei jedem Zugriff (alloc-probe: 1.2–1.9 KiB/s).
    if (frameDt > 0) k.turnDeg = clampInt(Math.round(((yaw - this.prevFrameYaw) / frameDt) * RAD2DEG), TURN_RATE_LIMIT);
    this.prevFrameYaw = yaw;
    k.strafe = this.strafeBadTicks > this.strafeGoodTicks ? -1 : this.strafeGoodTicks > 0 ? 1 : 0;
    this.strafeBadTicks = 0;
    this.strafeGoodTicks = 0;
    k.forwardInAirMs = clampInt(Math.round(this.forwardAirTime * 1000), 1e9);
    // Zielband der Lektion am Drehbalken (Ganzzahlen: kalter Leser, fallen.md #59).
    const band = this.session !== null ? this.session.turnBand(this.interp.speed) : null;
    if (band !== null) {
      this.band.lo = clampInt(Math.round(band.lo), TURN_RATE_LIMIT);
      this.band.hi = clampInt(Math.round(band.hi), TURN_RATE_LIMIT);
      k.turnBand = this.band;
    } else k.turnBand = null;
  }

  private updateFx(frameDt: number): void {
    const fx = this.fx;
    fx.time = this.time;
    if (this.session === null) fx.gateOpen = undefined;
    const sp = this.gameState === 'title' ? 0 : this.interp.speed;
    fx.speed01 = clamp01((sp - SPEED01_LO) / (SPEED01_HI - SPEED01_LO));
    // Tempostufe mit Hysterese: hoch an der Schwelle, runter erst TIER_DOWN darunter (kein Flackern am Rand).
    let tier = this.speedTier;
    while (tier < TIER_SPEEDS.length && sp >= TIER_SPEEDS[tier]) tier++;
    while (tier > 0 && sp < TIER_SPEEDS[tier - 1] - TIER_DOWN) tier--;
    this.speedTier = tier;
    fx.speedTier = tier;
    if (this.flashTime < this.flashDur) {
      this.flashTime += frameDt;
      const k = Math.max(0, 1 - this.flashTime / this.flashDur);
      fx.flash = this.flashPeak * k * k;
    } else fx.flash = 0;
    if (this.fadeT < FADE_TIME) {
      this.fadeT += frameDt;
      const k = Math.max(0, 1 - this.fadeT / FADE_TIME);
      fx.fade = FADE_PEAK * k * k;
    } else fx.fade = 0;
  }

  private startFlash(rgb: readonly [number, number, number], peak: number, dur: number): void {
    this.flashRgb[0] = rgb[0];
    this.flashRgb[1] = rgb[1];
    this.flashRgb[2] = rgb[2];
    this.flashPeak = peak;
    this.flashDur = dur;
    this.flashTime = 0;
  }

  private startFade(): void {
    this.fadeT = 0;
  }

  private countFps(now: number): void {
    if (this.fpsStart < 0) this.fpsStart = now;
    this.fpsFrames++;
    const span = now - this.fpsStart;
    if (span >= FPS_WINDOW) {
      this.fpsValue = this.fpsFrames / span;
      this.fpsFrames = 0;
      this.fpsStart = now;
    }
  }

  private updateLeaveGuard(): void {
    // "Seite verlassen?" nur, solange ein echter Lauf läuft — nie im Playwright-Betrieb ohne Lock.
    const on = !this.lockless && this.session === null && this.run !== null && this.run.running && this.gameState !== 'title';
    if (on !== this.leaveGuard) {
      this.leaveGuard = on;
      this.input.setLeaveGuard(on);
    }
  }

  // ================================================================== Einstellungen

  private applySettings(s: GameSettings): void {
    this.renderer.setSettings(s.render);
    this.rig.setSettings({ headBob: s.headBob, screenShake: s.screenShake, fovKick: s.fovKick, fov: s.fov, motionFx: s.motionFx });
    this.ghostOn = s.ghost;
    if (!s.ghost) this.hudData.ghostDiff = null;
    this.applyVolumes(s);
    this.hudData.showSpeedometer = s.showSpeedometer;
    this.hudData.showKeys = s.showKeys;
    this.showKeysSetting = s.showKeys;
    // Vorführungs-Taste (Plan 007) für HUD-Hinweis, Pause und Tipps.
    const demoCode = s.keybinds.demo[0];
    this.demoKey = demoCode !== undefined ? keyShortLabel(demoCode) : null;
    this.hud.setDemoKey(this.demoKey);
    this.menu.setDemoKey(this.demoKey ?? '—');
    this.hand.enabled = s.showHand;
    this.hand.motionFx = s.motionFx;
    this.applyCosmetics(s);
    this.input.configure(s.keybinds, s.autoSprint);
    const jumpKey = s.keybinds.jump[0];
    const crouchKey = s.keybinds.crouch[0];
    this.hud.setKeyLabels(jumpKey !== undefined ? keyShortLabel(jumpKey) : 'RAD', crouchKey !== undefined ? keyShortLabel(crouchKey) : '-');
    this.coach.enabled = s.showHints;
    // pixelHeight ändert die Low-Res-Größe → HUD und Kamera nachziehen.
    this.syncLayout();
  }

  /**
   * Kosmetik der Hand: die gespeicherte Wahl nur, wenn freigeschaltet — sonst Standard.
   * Die Wahl selbst bleibt stehen (nach unlockAll/erneutem Freischalten ist sie wieder da).
   */
  private applyCosmetics(s: GameSettings): void {
    const g = gloveUnlock(s.glove);
    const i = itemUnlock(s.heldItem);
    this.hand.setGlove(g === null || this.unlocks.has(g) ? s.glove : 'classic');
    this.hand.setItem(i === null || this.unlocks.has(i) ? s.heldItem : 'none');
    this.prewarmHand();
  }

  /** Viewmodel-Shader/Texturen des aktuellen Gegenstands anlegen (nicht im Frame-Pfad). */
  private prewarmHand(): void {
    this.renderer.prewarmViewModel(this.hand.currentItem, this.hand.currentGlove);
  }

  private applyVolumes(s: GameSettings): void {
    this.audio.setVolumes({ master: this.muted ? 0 : s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume });
  }

  private applyConfig(c: MovementConfig): void {
    this.config = c;
    this.movement.setConfig(c);
    this.coach.setConfig(c);
    this.session?.setConfig(c);
    this.hud.setMovement(c);
    this.rig.setMovement(c);
    this.bot?.setConfig(c);
    this.updateStandHull();
    if (c.tickRate !== this.loop.tickRate) this.loop.setTickRate(c.tickRate);
  }

  private syncLayout(): void {
    this.hud.resize(this.renderer.lowResWidth, this.renderer.lowResHeight);
    this.hand.setAspect(this.renderer.aspect);
    this.rig.setAspect(this.renderer.aspect);
  }

  // ================================================================== Bots

  private makeBot(kind: BotKind, opts: BotOptions): ActiveBot {
    const cfg = this.config;
    const heading = opts.headingDeg !== undefined ? opts.headingDeg * DEG : this.viewYaw;
    const pm = this.movement;
    switch (kind) {
      case 'route': {
        const level = this.level;
        const route = level?.def.route ?? [];
        if (!level || route.length === 0) throw new Error(`Level "${this.levelId}" hat keine Route`);
        const rf = new RouteFollower(route, cfg, {
          sync: opts.sync,
          aimNoiseDeg: opts.aimNoiseDeg,
          seed: opts.seed,
          killY: level.def.killY,
          start: { x: level.spawnPos.x, z: level.spawnPos.z },
          world: this.world,
          maxTurnRate: opts.maxTurnRate,
          timeout: opts.timeout,
          stallTimeout: opts.stallTimeout,
        });
        return { kind, route: rf, next: () => rf.next(pm.state, pm.surfNormal), setConfig: (c) => rf.setConfig(c) };
      }
      case 'strafe': {
        const b = new StrafeBot(cfg, { sync: opts.sync, aimNoiseDeg: opts.aimNoiseDeg, seed: opts.seed, heading });
        return { kind, route: null, next: () => b.next(pm.state), setConfig: (c) => b.setConfig(c) };
      }
      case 'naive': {
        const b = new NaiveBot(cfg, { heading, press: opts.press, sprint: this.settings.get().autoSprint });
        return { kind, route: null, next: () => b.next(pm.state), setConfig: () => undefined };
      }
    }
  }

  private clearBot(): void {
    // Eine laufende Vorführung endet mit (ohne Teleport — der Aufrufer setzt selbst).
    if (this.demo !== null) {
      this.demo = null;
      this.demoPlays = false;
      this.demoStage = -1;
      this.resetDemoWatch();
      if (this.session !== null) this.session.suspended = false;
      this.hud.demo = false;
    }
    if (this.overrideActive) {
      // Blick dort fortsetzen, wo Bot/Override zuletzt hinsah.
      this.input.setOverride(null);
      this.input.setView(this.lastYaw, this.lastPitch);
    }
    this.overrideActive = false;
    this.bot = null;
  }

  // ================================================================== Browser

  private readonly onResize = (): void => {
    this.renderer.resize(window.innerWidth, window.innerHeight);
    this.syncLayout();
  };

  private readonly onVisibility = (): void => {
    // Tab weg → Pause (auch ohne Lock). Der Loop holt die verpasste Zeit ohnehin nicht nach.
    if (document.visibilityState === 'hidden' && this.gameState === 'playing') this.pause('menu');
  };

  private readonly onCanvasClick = (): void => {
    if (this.gameState === 'paused' && !this.menu.visible) this.requestResume();
    else if (this.gameState === 'playing' && !this.lockless && !this.input.locked) {
      // Lock ging ohne Pause verloren (sollte nicht passieren) — Klick holt ihn zurück.
      void this.requestLockTracked();
    }
  };
}

// ================================================================== Helfer

function copySnap(a: PlayerSnapshot, out: MutablePlayerSnapshot): void {
  out.pos.copy(a.pos);
  out.vel.copy(a.vel);
  out.onGround = a.onGround;
  out.groundNormal.copy(a.groundNormal);
  out.ducked = a.ducked;
  out.eyeHeight = a.eyeHeight;
  out.speed = a.speed;
  out.hopChain = a.hopChain;
  out.stridePhase = a.stridePhase;
  out.strafeSync = a.strafeSync;
  out.airTime = a.airTime;
  out.surfing = a.surfing;
  out.surfNormal.copy(a.surfNormal);
  out.sliding = a.sliding;
}

/** Ganzzahl in ±limit als int32 (Smi) — für Felder, die ein kalter Leser liest. */
function clampInt(v: number, limit: number): number {
  return (v > limit ? limit : v < -limit ? -limit : v) | 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Medaillen aus index.json: endliche Zeiten, bronze > silver > gold > velocity ≥ author —
 * sonst keine (Anzeige fällt weg, nicht das Level). Stände vor der VELOCITY-Medaille
 * (ohne `velocity`) sind ungültig: index.json kommt immer frisch aus levels:build.
 */
export function parseMedals(v: unknown): LevelMedals | null {
  if (!isRecord(v)) return null;
  const { bronze, silver, gold, velocity, author } = v;
  if (typeof bronze !== 'number' || typeof silver !== 'number' || typeof gold !== 'number' || typeof velocity !== 'number' || typeof author !== 'number') return null;
  if (!(author > 0 && velocity >= author && gold > velocity && silver > gold && bronze > silver && Number.isFinite(bronze))) return null;
  return { bronze, silver, gold, velocity, author };
}

function vecOf(v: Vector3): { readonly x: number; readonly y: number; readonly z: number } {
  return { x: Math.round(v.x * 1000) / 1000, y: Math.round(v.y * 1000) / 1000, z: Math.round(v.z * 1000) / 1000 };
}

/** training/index.json prüfen (wie parseIndex): kaputte Einträge fallen raus, Reihenfolge = Liste. */
export function parseTrainingIndex(data: unknown): TrainingIndexEntry[] {
  if (!Array.isArray(data)) throw new Error('training/index.json ist keine Liste');
  const out: TrainingIndexEntry[] = [];
  for (const e of data) {
    if (!isRecord(e)) continue;
    const { id, name, subtitle, file, lesson, short, group } = e;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof file !== 'string' || typeof short !== 'string') continue;
    if (typeof lesson !== 'number' || (group !== 'basics' && group !== 'advanced')) continue;
    out.push({ id, name, file, lesson, short, group, ...(typeof subtitle === 'string' ? { subtitle } : {}) });
  }
  return out;
}

/** index.json prüfen statt blind zu casten — ein kaputter Eintrag fällt raus, der Rest bleibt spielbar. */
export function parseIndex(data: unknown): LevelIndexEntry[] {
  if (!Array.isArray(data)) throw new Error('index.json ist keine Liste');
  const out: LevelIndexEntry[] = [];
  for (const e of data) {
    if (!isRecord(e)) continue;
    const { id, name, subtitle, file } = e;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof file !== 'string') continue;
    const medals = parseMedals(e.medals);
    out.push({ id, name, file, ...(typeof subtitle === 'string' ? { subtitle } : {}), ...(medals ? { medals } : {}) });
  }
  return out;
}
