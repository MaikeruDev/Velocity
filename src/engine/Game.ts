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
import type { FinishResult, HudData, HudKeys } from '../ui/types';
import { BrushWorld } from '../world/collision/BrushWorld';
import { makeTraceResult } from '../world/collision/types';
import type { CompiledLevel } from '../world/level/compileLevel';
import { loadLevel } from '../world/level/compileLevel';
import type { LevelIndexEntry, LevelMedals } from '../world/level/LevelFormat';
import { EventBus } from './events';
import type { GameEvent, RunEvent } from './events';
import type { HudLayoutInfo } from './debug';
import { Coach } from './Coach';
import type { HintId } from './Coach';
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
  private readonly coach = new Coach();
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
    this.coach.onHint = (id) => this.showHint(id);
    this.menu.setRawStatusProvider(() => this.input.rawStatus);

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
    return { width: this.hud.width, height: this.hud.height, speedRows: this.hud.speedBlockRows(), speedHalfWidth: SPEED_BLOCK_HALF_W };
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
    this.unlocks.sync(this.levels, (id) => this.best.get(id));
    this.menu.setLevels(this.levels);
    const first = this.levels[0];
    if (first && this.gameState === 'title') void this.prepareBackdrop(first.id);
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

    this.applyLevel(id, level);
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

  /** Lauf neu starten (R): Timer, Checkpoints, Position — alles auf Anfang. */
  restartRun(): void {
    const level = this.level;
    const run = this.run;
    if (!level || !run) return;
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

  /** Zurück ins Titelmenü. */
  toTitle(): void {
    this.loadToken++;
    this.clearBot();
    this.gameState = 'title';
    this.coasting = false;
    this.input.exitLock();
    this.tuning.hide();
    this.hud.visible = false;
    if (this.levelId) this.menu.select(this.levelId);
    this.menu.showTitle();
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
    this.input.exitLock();
    if (kind === 'menu') {
      this.tuning.hide();
      this.menu.showPause();
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
    this.tuning.hide();
    this.pausedFor = 'menu';
    this.menu.showPause();
    this.menu.setLockStatus({ pending: false, error: this.input.lockError ?? 'pointerlockerror' });
  }

  private resume(): void {
    this.gameState = 'playing';
    this.menu.hide();
    this.tuning.hide();
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
      // Nicht im Index (z. B. sandbox): Dateiname = id.
      const file = entry?.file ?? `${id}.json`;
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
    this.movement.setWorld(level.world);
    this.run = new RunState(level);
    this.bestSplitsAtStart = this.best.getSplits(id);
    this.bestTime = this.best.get(id);
    this.run.reset(this.bestSplitsAtStart);
    this.finishResult = null;
    this.coasting = false;
    this.levelSig = levelSignature(level.def);
    this.loadGhost();
    this.placeAt(level.spawnPos, level.spawnYaw);
    this.fadeT = FADE_TIME;
    this.flashTime = this.flashDur;

    const entry = this.levels.find((l) => l.id === id);
    const def = level.def;
    this.hudData.levelName = entry?.name ?? def.name;
    this.hudData.levelSubtitle = entry?.subtitle ?? def.subtitle ?? null;
    this.hudData.nextMedal = def.medals ? nextMedal(this.bestTime, def.medals) : null;
    this.hudCp.total = this.run.total;
    this.hudCp.index = 0;
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
    const world = this.level?.world;
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
    for (let k = 0; k < events.length; k++) this.bus.emit(events[k]);
    this.movement.copySnapshot(this.cur);
    this.mirrorStrafe(dt, dYaw, cmd);
    this.coach.tick(dt, this.prev, this.cur, cmd);
    this.runTick(dt);
    const run = this.run;
    if (run !== null && run.running) this.ghostRec.sample(run.time ?? 0, this.cur.pos, this.lastYaw);
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
    const world = this.level?.world;
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

  private nearDist(world: CompiledLevel['world'], dx: number, dz: number): number {
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
      case 'jump':
        // Landewelle nur für gute Hops: perfekt, synchron und mit Gewinn. Ursprung = Füße beim Absprung.
        if (e.perfect && e.sync > WAVE_MIN_SYNC && e.gain > 0) {
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

  private showHint(id: HintId): void {
    const crouch = this.settings.get().keybinds.crouch[0];
    const key = crouch !== undefined ? keyShortLabel(crouch) : '?';
    const text =
      id === 'crouch'
        ? `IN DER LUFT DUCKEN [${key}]\nZIEHT DIE FÜSSE 18 u HÖHER`
        : id === 'surf'
          ? 'W LOS · A/D IN DIE RAMPE · MAUS ENTLANG'
          : 'MAUS UND A/D IN DIESELBE RICHTUNG\nA + MAUS LINKS · D + MAUS RECHTS';
    this.hud.showNotice(text, 'coach');
  }

  private runTick(dt: number): void {
    const run = this.run;
    if (!run) return;
    const s = this.movement.state;
    const outcome = run.tick(dt, s.pos, this.movement.hullMins, this.movement.hullMaxs, s.speed, s.onGround, this.runEvents);
    const evs = this.runEvents;
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
    const fresh = this.unlocks.sync(this.levels, (id) => this.best.get(id));
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
  };

  private handleAction(a: InputAction): void {
    const st = this.gameState;
    switch (a) {
      case 'pause':
        if (st === 'playing') this.pause('menu');
        else if (st === 'paused' && this.pausedFor === 'tuning') {
          this.tuning.hide();
          this.pausedFor = 'menu';
          this.menu.showPause();
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
        break;
      case 'toggleTuning':
        this.toggleTuning();
        break;
      case 'toggleMute':
        this.muted = !this.muted;
        this.applyVolumes(this.settings.get());
        this.hud.showNotice(this.muted ? 'Ton aus  [M]' : 'Ton an');
        break;
    }
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
    cameraViewFromSnapshot(this.interp, this.lastSprint, this.lastSide, this.view);
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
  }

  private updateFx(frameDt: number): void {
    const fx = this.fx;
    fx.time = this.time;
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
    const on = !this.lockless && this.run !== null && this.run.running && this.gameState !== 'title';
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
          world: level.world,
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
