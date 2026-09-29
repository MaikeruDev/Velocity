import { Vector3 } from 'three';
import type { AudioApi, BeatInfo } from '../audio/types';
import type { MovementConfig } from '../player/MovementConfig';
import type { PlayerInput, PlayerSnapshot } from '../player/types';
import type { RenderSettings } from '../render/types';
import { debugRenderer } from '../render/PS2Renderer';
import type { RenderStats } from '../render/PS2Renderer';
import type { FinishResult, HudData, HudKeys, LessonHud, LessonResult } from '../ui/types';
import { Hud } from '../ui/Hud';
import type { HudCardState } from '../ui/Hud';
import type { StageRank, TaskDef } from '../world/level/LevelFormat';
import type { ViewHandState } from '../ui/hand/ViewHand';
import type { AnyTrick } from '../ui/hand/ViewHand';
import { HAND_POSES } from '../ui/hand/poses';
import type { HandPose } from '../ui/hand/poses';
import type { GameEvent } from './events';
import type { BotInfo, BotKind, BotOptions, Game, GameState, GhostDebugInfo } from './Game';
import type { SettingsStore } from './Settings';
import type { UnlockId, UnlockStore } from './Unlocks';

/**
 * Debug-Handle `window.__vel` (AGENTS.md §3.6): Zustand lesen, teleportieren,
 * Config setzen, Eingaben injizieren, Ticks vorspulen. Playwright-Tools
 * (tools/shoot.mjs, tools/playtest.mjs) benutzen ausschließlich dieses Handle.
 * Winkel hier in Grad (lesbarer im Tool-Code), intern Radiant.
 */

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface VelState {
  readonly gameState: GameState;
  readonly levelId: string;
  readonly pos: Vec3Like;
  readonly vel: Vec3Like;
  readonly speed: number;
  readonly onGround: boolean;
  readonly surfing: boolean;
  readonly ducked: boolean;
  /** null = Timer noch nicht gestartet. */
  readonly runTime: number | null;
  readonly running: boolean;
  readonly checkpoint: { readonly index: number; readonly total: number };
  readonly hopChain: number;
  readonly strafeSync: number;
  readonly fps: number;
  readonly tickRate: number;
  readonly yawDeg: number;
  readonly pitchDeg: number;
  readonly locked: boolean;
  readonly lockless: boolean;
  readonly menu: string | null;
  readonly tuningVisible: boolean;
  readonly topSpeed: number;
  /** Ergebnis des letzten Ziels (ohne das Foto-Canvas — das steht als Größe in `photo`). */
  readonly finish: Omit<FinishResult, 'photo'> | null;
  /** Ziel-Foto des Handys (Plan 007 I3): Größe und mittlere Helligkeit (0..255), null = keins. */
  readonly photo: { readonly w: number; readonly h: number; readonly mean: number } | null;
  readonly bot: BotInfo | null;
  /** Knoten der Level-Route (0 = keine, useBot('route') geht dann nicht). */
  readonly routeNodes: number;
  /** Gerade sichtbarer HUD-Hinweis (Coach/Eingabe), sonst null. */
  readonly notice: string | null;
  /** Wie oft jeder Hinweis im Moment gezeigt wurde (Sitzung). */
  readonly hints: { readonly crouch: number; readonly surf: number; readonly strafe: number; readonly noStrafe: number };
  /** Dauer des JIT-Vorwärmens beim ersten Level (ms, −1 = noch nicht). */
  readonly jitWarmupMs: number;
  /** Laufende Lektion (Plan 007): id, sonst null. Details: training(). */
  readonly lesson: string | null;
}

/** Laufende Lektion für Tools (__vel.training, Plan 007). */
export interface TrainingDebugInfo {
  readonly lessonId: string;
  readonly name: string;
  /** Index der aktiven Stufe (= stageTotal nach der letzten). */
  readonly stageIndex: number;
  readonly stageTotal: number;
  readonly stageId: string | null;
  readonly stageTitle: string;
  readonly text: string;
  readonly count: number;
  readonly goal: number;
  readonly style: 'pips' | 'bar';
  readonly rank: StageRank;
  /** Alle Pflichtstufen erledigt. */
  readonly done: boolean;
  /** Sterne dieser Sitzung und gespeicherte Sterne. */
  readonly stars: number;
  readonly savedStars: number;
  readonly completed: readonly string[];
  /** Vorführung läuft; demoPlays = der Bot spielt wirklich (Tools). */
  readonly demo: boolean;
  readonly demoPlays: boolean;
  readonly demoLeft: number;
  readonly suspended: boolean;
  /** Optik je Tor (0 zu … 1 aufgelöst) und Kollision (true = blockiert). */
  readonly gateOpen: readonly number[];
  readonly gateBlocked: readonly boolean[];
  /** Tore der Lektion (CompiledLevel.gates-Reihenfolge) als Box. */
  readonly gates: readonly { readonly id: string; readonly min: Vec3Like; readonly max: Vec3Like }[];
  /** Zonen der Lektion (CompiledLevel.zones) als Box — Tools steuern Ersatz-Bots darauf zu. */
  readonly zones: readonly { readonly id: string; readonly min: Vec3Like; readonly max: Vec3Like }[];
  /** Die aktuelle Stufe hat eine Vorführung. */
  readonly hasDemo: boolean;
  /** Vorführung hat die Aufgabe der Stufe erfüllt (Band "SO GEHT'S!"); demoStill = Stillstand am Stück (s). */
  readonly demoGoal: boolean;
  readonly demoStill: number;
  /** Die aktive Stufe bewertet Strafen: Urteile am Gain-Popup, Urteils-Tipps, SYNC-Zeile. */
  readonly judge: boolean;
  /** Alle Stufen der Lektion (Reihenfolge der Def): Rang und ob es eine Vorführung gibt. */
  readonly stages: readonly { readonly id: string; readonly title: string; readonly rank: StageRank; readonly hasDemo: boolean }[];
  /** Aufgabe der aktiven Stufe (null nach der letzten) — Tools wählen danach einen Ersatz-Bot. */
  readonly task: TaskDef | null;
  /** Letzter Tipp der Lektion (null = noch keiner), seine Art und Zähler. */
  readonly tip: string | null;
  readonly tipKind: 'stage' | 'verdict' | 'demo' | null;
  readonly tipSerial: number;
  /** Gerade sichtbarer HUD-Hinweis (Coach-Band). */
  readonly notice: string | null;
  /** Start der aktuellen Stufe (Füße, yaw in Grad). */
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number };
  /** Ergebnis, sobald gezeigt; resultIn = s bis zum automatischen Ergebnis (−1 = keins). */
  readonly result: LessonResult | null;
  readonly resultIn: number;
}

export type RecordedEvent = GameEvent & { readonly t: number };

export interface TriggerInfo {
  readonly kind: string;
  readonly order: number;
  readonly min: Vec3Like;
  readonly max: Vec3Like;
  readonly spawn: Vec3Like;
  readonly spawnYaw: number;
  readonly tag: string | null;
}

/** Ein gerenderter Frame (Kamera nach rig.update) — für Glätte-Messungen der Interpolation. */
export interface FrameSample {
  /** rAF-Zeitstempel in ms — derselbe, mit dem der Loop diesen Frame simuliert hat. */
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yawDeg: number;
  /** Horizontal-Speed des Spielers (letzter Tick), u/s. */
  readonly speed: number;
  readonly onGround: boolean;
  /** Tatsächliche Kamera-Rotation (Euler YXZ, inkl. Bob/Roll/Shake) und vertikales FOV — für exakte Projektionen in Tools. */
  readonly camYawDeg: number;
  readonly camPitchDeg: number;
  readonly camRollDeg: number;
  readonly fovDeg: number;
  readonly aspect: number;
  /** Füße des Spielers (letzter Tick). */
  readonly feet: Vec3Like;
}

/** HUD-Geometrie im Low-Res-Raster (Tools prüfen damit, was das HUD verdeckt). */
export interface HudLayoutInfo {
  readonly width: number;
  readonly height: number;
  /** Speedometer-Block (Zahl + Ketten-/Sync-Zeile), Zeilen [top, bottom] und halbe Nennbreite um die Bildmitte. */
  readonly speedRows: readonly [number, number];
  readonly speedHalfWidth: number;
  /** Mittleres Band (Zeilen [top, bottom], 35–65 % der Höhe), das das Lektions-HUD frei lässt (Plan 007 TU2). */
  readonly centerBand: readonly [number, number];
  /**
   * Zuletzt gezeichnete Rechtecke [x, y, w, h] in HUD-Pixeln: card (Lektionskarte), verdict (Gain-Popups mit
   * Urteil), notice (Coach-/Info-Band), demo (Vorführungs-Band), speed (Speedometer-Zahl), photo (Stempel "FOTO"
   * des Ziel-Fotos, Plan 007 I3). w = 0: nicht gezeichnet.
   */
  readonly rects: Readonly<Record<string, readonly [number, number, number, number]>>;
  /** Gerade sichtbares Urteil am Gain-Popup ("GUT", "MAUS!"), sonst null. */
  readonly verdict: string | null;
  /**
   * Urteils-Zähler des HUD: verdictSerial = Urteile angenommen (je 'lessonHop' in einer Stufe mit Urteil +1),
   * verdictDrawn = höchste Nummer, die draw() schon sichtbar gezeichnet hat. Tools prüfen damit den Verzug je
   * Hop (Frames bis verdictDrawn ≥ Nummer des neuen Urteils).
   */
  readonly verdictSerial: number;
  readonly verdictDrawn: number;
  /** HUD zeigt Urteile (Lektion, Stufe mit Strafe-Aufgabe). */
  readonly judge: boolean;
  /**
   * Lektionskarte, wie zuletzt gezeichnet (null = keine): Titel, Zähler, Fortschritt (beim Geschafft-Blitz die
   * volle Reihe der erledigten Stufe), Hinweise rechts/links vom Fortschritt.
   */
  readonly card: HudCardState | null;
  /** W-Showkey in diesem Frame rot (Warnung "W in der Luft" — nur ohne Strafe-Assist, in Lektionen nie). */
  readonly wRed: boolean;
  /** Legende "MAUS-TEMPO / IM FLUG IM GRÜNEN HALTEN" am Drehbalken gezeichnet (Lektion, bis zum ersten guten Hop). */
  readonly turnLegend: boolean;
}

/** Geometrie-Eckdaten des geladenen Levels — Tools leiten Kamerapositionen daraus ab statt sie hart zu kodieren. */
export interface LevelInfo {
  readonly id: string;
  readonly name: string;
  readonly spawn: Vec3Like;
  readonly spawnYaw: number;
  readonly killY: number;
  readonly triggers: readonly TriggerInfo[];
  readonly route: readonly { readonly pos: Vec3Like; readonly note: string | null; readonly crouch: boolean; readonly surf: boolean }[];
}

/** Ziel-Foto (Plan 007 K7) für Tools: Größe, Anteil nicht-schwarzer Pixel und das Bild als PNG-Data-URL. */
export interface SnapshotInfo {
  readonly width: number;
  readonly height: number;
  readonly lowResWidth: number;
  readonly lowResHeight: number;
  /** Anteil der Pixel mit Helligkeit > 8/255 (0 = schwarz/leer). */
  readonly litShare: number;
  readonly dataUrl: string;
}

/** Eingabe-Funktion aus dem Tool: bekommt den Live-Zustand, liefert die gedrückten Tasten (Rest = los). */
export type OverrideFn = (state: PlayerSnapshot, tickIndex: number, ticks: number) => Partial<PlayerInput>;

export interface VelHandle {
  readonly ready: boolean;
  state(): VelState;
  /** null, solange kein Level geladen ist. */
  levelInfo(): LevelInfo | null;
  /** Level starten; lockless = ohne Pointer Lock (Playwright). Resolved, wenn gespielt wird. */
  start(levelId: string, opts?: { readonly lockless?: boolean }): Promise<boolean>;
  restart(): void;
  toTitle(): void;
  pause(): void;
  resume(): void;
  teleport(x: number, y: number, z: number, yawDeg?: number): void;
  setVelocity(x: number, y: number, z: number): void;
  setView(yawDeg: number, pitchDeg: number): void;
  setConfig(patch: Partial<MovementConfig>): MovementConfig;
  setInputOverride(fn: OverrideFn | null): void;
  useBot(kind: BotKind | null, opts?: BotOptions): void;
  /** Echtzeit-Ticks anhalten/fortsetzen (Rendern läuft weiter). */
  freeze(on: boolean): void;
  stepTicks(n: number): VelState;
  events(n?: number): RecordedEvent[];
  beat(): BeatInfo;
  setRenderSettings(patch: Partial<RenderSettings>): void;
  /** Kamera der nächsten n gerenderten Frames (rAF nach dem Spiel-Frame). */
  sampleFrames(n: number): Promise<FrameSample[]>;
  hudLayout(): HudLayoutInfo;
  /** Ghost der Bestzeit: Zustand und (mit t) Pose zur Laufzeit t in s. */
  ghost(t?: number): GhostDebugInfo;
  /** Vorbeizieh-Proben an/aus (Messung der Frame-Kosten) und letzte Abstände. */
  setNearProbe(on: boolean): void;
  near(): { readonly left: number; readonly right: number };
  /** View-Hand (Plan 004/006): Pose, Auslenkung, Gegenstand, Trick, Frame. */
  hand(): ViewHandState;
  /** Pose der View-Hand erzwingen ('relaxed' … 'crack'), null = normal (Screenshots). */
  forceHandPose(pose: HandPose | null): void;
  /** Freischaltungen (Plan 005): alle freischalten / alles sperren (dauerhaft gegen die Ableitung, wie "Alles sperren" im Admin-Menü) / Liste. */
  unlockAll(): UnlockId[];
  resetUnlocks(): UnlockId[];
  unlocks(): UnlockId[];
  /**
   * Trick des gehaltenen Gegenstands starten (Namen: hand().tricks, z. B. CAN_/CARD_/KNIFE_/
   * SPINNER_TRICKS), optional bei Trick-Zeit at (s) festhalten; 'none' = zurück. false = passt nicht.
   */
  forceTrick(name: AnyTrick | 'none', at?: number): boolean;
  /**
   * Ziel-Foto (Plan 007 K7): RendererApi.snapshot des letzten Bildes (ohne HUD), Standard = Low-Res-
   * Größe. null = kein Renderer/noch kein Bild.
   */
  snapshot(w?: number, h?: number): SnapshotInfo | null;
  /** Render-Kennzahlen (u. a. viewModelCalls/viewModelTriangles für das Kosmetik-Budget). */
  renderStats(): RenderStats | null;
  /** Trainingsmodus (Plan 007): laufende Lektion, null = keine. */
  training(): TrainingDebugInfo | null;
  /** Aktuelle Stufe überspringen (zählt nicht), Spieler an den Start der nächsten. */
  trainingSkip(): TrainingDebugInfo | null;
  /** Lektion neu (wie R). */
  trainingReset(): TrainingDebugInfo | null;
  /**
   * Vorführung der Stufe starten/stoppen (wie Taste H; on fehlt = umschalten). play = der Bot spielt die
   * Lektion wirklich (Stufe für Stufe, zählt). false = nicht möglich (keine Lektion/Vorführung).
   */
  demo(opts?: { readonly on?: boolean; readonly play?: boolean }): boolean;
  /** Messung: mittlere CPU-Zeit des Frame-Callbacks (ms) seit dem letzten Aufruf, davon updateLesson; lessonTickMs = Session-Ticks je Frame (ab dem 2. Aufruf). */
  frameCost(): { readonly ms: number; readonly lessonMs: number; readonly lessonTickMs: number; readonly frames: number };
  /**
   * Messung (Plan 007 TU2): HUD update+draw je Frame (ms) auf einem eigenen HUD in Spielgröße — normales
   * Level (Timer, Gain-Popups) gegen Lektion (Karte, Urteile, Zielband) und Lektion mit Vorführung
   * (+ Demo-Band). Alle 45 Frames eine Landung/ein Urteil. n Frames je Variante, abwechselnd in Blöcken.
   */
  benchHud(n?: number): { readonly normal: number; readonly lesson: number; readonly lessonDemo: number };
  /**
   * Mikro-Messung der Lektion (Plan 007 TU2): updateLesson n-mal am Stück (updateMs je Aufruf) und session.tick
   * n-mal mit synthetischen Hops auf einer Wegwerf-Session derselben Stufe (tickMs je Tick). null = keine Lektion.
   */
  benchLesson(n?: number): { readonly updateMs: number; readonly tickMs: number; readonly hops: number } | null;
  /** Lektionsliste mit gespeicherten Sternen; loaded = Lektion schon geladen (Admin-Abhaken möglich). */
  lessons(): { readonly id: string; readonly name: string; readonly short: string; readonly stars: number; readonly loaded: boolean }[];
}

declare global {
  interface Window {
    __vel?: VelHandle;
  }
}

const DEG = Math.PI / 180;
const EVENT_LOG_SIZE = 512;

export interface DebugDeps {
  readonly game: Game;
  readonly audio: AudioApi;
  readonly settings: SettingsStore;
  readonly unlocks: UnlockStore;
  /** Events von Anfang an mitschreiben (?debug). Sonst erst ab start()/events(). */
  readonly record: boolean;
}

export function installDebug(deps: DebugDeps): VelHandle {
  const { game, audio, settings, unlocks } = deps;
  const log: RecordedEvent[] = [];
  let recording = false;
  const record = (on: boolean): void => {
    if (on === recording) return;
    recording = on;
    // Kopie: Movement und Lauf-Logik verwenden ihre Event-Objekte wieder.
    game.eventRecorder = on
      ? (e) => {
          log.push({ ...e, t: round3(performance.now() / 1000) });
          if (log.length > EVENT_LOG_SIZE) log.splice(0, log.length - EVENT_LOG_SIZE);
        }
      : null;
  };
  record(deps.record);

  const state = (): VelState => {
    const s = game.player;
    const run = game.runState;
    return {
      gameState: game.state,
      levelId: game.currentLevelId,
      pos: vec(s.pos),
      vel: vec(s.vel),
      speed: round3(s.speed),
      onGround: s.onGround,
      surfing: s.surfing,
      ducked: s.ducked,
      runTime: run ? run.time : null,
      running: run ? run.running : false,
      checkpoint: { index: run ? run.checkpoint : 0, total: run ? run.total : 0 },
      hopChain: s.hopChain,
      strafeSync: round3(s.strafeSync),
      fps: Math.round(game.fps * 10) / 10,
      tickRate: game.tickRate,
      yawDeg: round3(game.viewYaw / DEG),
      pitchDeg: round3(game.viewPitch / DEG),
      locked: game.locked,
      lockless: game.isLockless,
      menu: game.menuScreen,
      tuningVisible: game.tuningVisible,
      topSpeed: run ? Math.round(run.topSpeed) : 0,
      finish: finishForTools(game.lastFinish),
      photo: photoInfo(game.lastFinish?.photo ?? null),
      bot: game.botInfo,
      routeNodes: game.currentLevel?.def.route?.length ?? 0,
      notice: game.hudNotice,
      hints: { crouch: game.hintsShown.crouch, surf: game.hintsShown.surf, strafe: game.hintsShown.strafe, noStrafe: game.hintsShown.noStrafe },
      jitWarmupMs: Math.round(game.jitWarmupMs * 10) / 10,
      lesson: game.lessonSession !== null ? game.currentLevelId : null,
    };
  };

  const handle: VelHandle = {
    ready: true,
    state,
    levelInfo: () => {
      const lv = game.currentLevel;
      if (!lv) return null;
      return {
        id: game.currentLevelId,
        name: lv.def.name,
        spawn: vec(lv.spawnPos),
        spawnYaw: lv.spawnYaw,
        killY: lv.def.killY,
        triggers: lv.triggers.map((t) => ({
          kind: t.kind,
          order: t.order,
          min: vec(t.bounds.min),
          max: vec(t.bounds.max),
          spawn: vec(t.spawnPos),
          spawnYaw: t.spawnYaw,
          tag: t.tag,
        })),
        route: (lv.def.route ?? []).map((n) => ({ pos: { x: n.pos[0], y: n.pos[1], z: n.pos[2] }, note: n.note ?? null, crouch: n.crouch ?? false, surf: n.surf ?? false })),
      };
    },
    start: (levelId, opts) => {
      record(true);
      log.length = 0;
      return game.startLevel(levelId, { lockless: opts?.lockless ?? false, gesture: false });
    },
    restart: () => game.restartRun(),
    toTitle: () => game.toTitle(),
    pause: () => game.pause('menu'),
    resume: () => game.requestResume(),
    teleport: (x, y, z, yawDeg) => game.teleport(new Vector3(x, y, z), yawDeg),
    setVelocity: (x, y, z) => game.setVelocity(new Vector3(x, y, z)),
    setView: (yawDeg, pitchDeg) => game.setView(yawDeg * DEG, pitchDeg * DEG),
    setConfig: (patch) => game.setConfigPatch(patch),
    setInputOverride: (fn) => game.setInputOverride(fn),
    useBot: (kind, opts) => game.useBot(kind, opts),
    freeze: (on) => game.freeze(on),
    stepTicks: (n) => {
      game.stepTicks(n);
      return state();
    },
    events: (n) => {
      record(true);
      const k = n === undefined ? log.length : Math.max(0, Math.floor(n));
      return log.slice(Math.max(0, log.length - k));
    },
    beat: () => ({ ...audio.beat() }),
    setRenderSettings: (patch) => {
      settings.update({ render: patch });
    },
    sampleFrames: (n) =>
      new Promise((resolve) => {
        const out: FrameSample[] = [];
        const cam = game.camera;
        // Erst im nächsten Frame anmelden: dann läuft dieser Callback in jedem Frame NACH dem
        // Loop-Callback (rAF-Reihenfolge = Anmeldereihenfolge), die Kamera ist also schon gesetzt.
        const grab = (ts: number): void => {
          const s = game.player;
          out.push({
            t: ts,
            x: cam.position.x,
            y: cam.position.y,
            z: cam.position.z,
            yawDeg: round3(game.viewYaw / DEG),
            speed: round3(s.speed),
            onGround: s.onGround,
            camYawDeg: round3(cam.rotation.y / DEG),
            camPitchDeg: round3(cam.rotation.x / DEG),
            camRollDeg: round3(cam.rotation.z / DEG),
            fovDeg: round3(cam.fov),
            aspect: round3(cam.aspect),
            feet: vec(s.pos),
          });
          if (out.length >= n) resolve(out);
          else requestAnimationFrame(grab);
        };
        requestAnimationFrame(() => requestAnimationFrame(grab));
      }),
    hudLayout: () => game.hudLayout(),
    ghost: (t) => game.ghostInfo(t),
    setNearProbe: (on) => {
      game.nearProbeEnabled = on;
    },
    near: () => game.near,
    hand: () => game.handState(),
    forceHandPose: (pose) => game.forceHandPose(pose === null ? -1 : HAND_POSES.indexOf(pose)),
    unlockAll: () => {
      unlocks.unlockAll();
      return unlocks.list();
    },
    resetUnlocks: () => {
      unlocks.reset();
      return unlocks.list();
    },
    unlocks: () => unlocks.list(),
    forceTrick: (name, at) => game.forceTrick(name, at ?? -1),
    snapshot: (w, h) => {
      const r = debugRenderer();
      if (!r) return null;
      const c = r.snapshot(w ?? r.lowResWidth, h ?? r.lowResHeight);
      if (!c) return null;
      const ctx = c.getContext('2d');
      let lit = 0;
      if (ctx) {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) lit++;
      }
      return { width: c.width, height: c.height, lowResWidth: r.lowResWidth, lowResHeight: r.lowResHeight, litShare: round3(lit / Math.max(1, c.width * c.height)), dataUrl: c.toDataURL('image/png') };
    },
    renderStats: () => debugRenderer()?.stats ?? null,
    training: () => game.trainingInfo(),
    trainingSkip: () => {
      game.skipStage();
      return game.trainingInfo();
    },
    trainingReset: () => {
      if (game.lessonSession !== null) game.restartRun();
      return game.trainingInfo();
    },
    demo: (opts) => {
      const on = opts?.on ?? !(game.trainingInfo()?.demo ?? false);
      return game.setDemo(on, opts?.play ?? false);
    },
    lessons: () => game.lessonList(),
    frameCost: () => game.takeFrameCost(),
    benchHud: (n) => benchHud(game, n ?? 3000),
    benchLesson: (n) => game.benchLesson(n ?? 20000),
  };
  window.__vel = handle;
  return handle;
}

/**
 * HUD-Messung (benchHud): drei Varianten, je ein eigenes HUD (sonst verwirft jeder Wechsel die
 * vorgerenderten Kacheln der anderen), in kurzen Blöcken reihum mit wechselnder Reihenfolge — so
 * verteilen sich GC, Takt und GPU-Rückstau gleich auf alle drei.
 */
function benchHud(game: Game, n: number): { normal: number; lesson: number; lessonDemo: number } {
  const live = game.hudLayout();
  const makeHud = (demo: boolean): Hud => {
    const hud = new Hud();
    hud.resize(live.width, live.height);
    hud.setMovement(game.movementConfig);
    hud.setDemoKey('H');
    hud.demoAvailable = true;
    hud.demo = demo;
    // Teurer Fall: Stufe mit Urteil (Urteil am Gain-Popup) — im normalen Level wirkungslos.
    hud.judge = true;
    hud.visible = true;
    return hud;
  };
  const makeKeys = (band: { lo: number; hi: number } | null): { -readonly [K in keyof HudKeys]-?: HudKeys[K] } => ({
    forward: 0,
    side: -1,
    jump: true,
    crouch: false,
    turnDeg: 120,
    inAir: true,
    strafe: 1,
    forwardInAirMs: 0,
    turnBand: band,
  });
  const lesson: LessonHud = game.lessonSession?.hud ?? {
    lessonTitle: 'T3 · AIR-STRAFE',
    stageTitle: 'LINKSKURVE',
    text: 'IN DER LUFT: A HALTEN\nUND DIE MAUS NACH LINKS ZIEHEN',
    count: 2,
    goal: 5,
    style: 'pips',
    rank: 'required',
    stageIndex: 0,
    stageTotal: 5,
    demo: false,
  };
  const base = {
    speed: 412,
    hopChain: 5,
    strafeSync: 0.9,
    onGround: false,
    surfing: false,
    runTime: 12.34,
    running: true,
    checkpoint: { index: 1, total: 3 },
    levelName: 'X',
    levelSubtitle: null,
    bestTime: 20.5,
    showSpeedometer: true,
    showKeys: true,
    paused: false,
    ghostDiff: null,
    ghostOverHud: false,
    nextMedal: null,
  };
  const band = { lo: 40, hi: 360 };
  const jump = { type: 'jump', speed: 412, gain: 23, perfect: true, clean: true, chain: 5, sync: 0.9, crouched: false, coyote: false } as const;
  const hop = { type: 'lessonHop', verdict: 'good', gain: 23, counted: true, count: 2, goal: 5 } as const;
  const variants = [
    { hud: makeHud(false), data: { ...base, keys: makeKeys(null), lesson: null } satisfies HudData, ev: jump, sum: 0, frame: 0 },
    { hud: makeHud(false), data: { ...base, keys: makeKeys(band), runTime: null, running: false, lesson } satisfies HudData, ev: hop, sum: 0, frame: 0 },
    { hud: makeHud(true), data: { ...base, keys: makeKeys(band), runTime: null, running: false, lesson } satisfies HudData, ev: hop, sum: 0, frame: 0 },
  ];
  const run = (v: (typeof variants)[number], frames: number): number => {
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      if (v.frame++ % 45 === 0) v.hud.onEvent(v.ev);
      v.hud.update(1 / 60, v.data);
      v.hud.draw();
    }
    return performance.now() - t0;
  };
  // Aufwärmen (Glyphen-Caches, Kacheln, JIT), dann kurze Blöcke reihum.
  for (const v of variants) run(v, 200);
  const block = 25;
  let frames = 0;
  for (let r = 0; frames < n; r++) {
    for (let k = 0; k < variants.length; k++) {
      const v = variants[(k + r) % variants.length];
      v.sum += run(v, block);
    }
    frames += block;
  }
  return { normal: variants[0].sum / frames, lesson: variants[1].sum / frames, lessonDemo: variants[2].sum / frames };
}

/** FPS-Anzeige für ?debug — per Intervall, nicht im Frame-Pfad. */
export function installFpsOverlay(game: Game, el: HTMLElement): void {
  el.hidden = false;
  window.setInterval(() => {
    const s = game.player;
    el.textContent = `${game.fps.toFixed(0)} fps · ${game.tickRate} Hz · ${Math.round(s.speed)} u/s · ${game.state}`;
  }, 250);
}

function vec(v: Vector3): Vec3Like {
  return { x: round3(v.x), y: round3(v.y), z: round3(v.z) };
}

/** Ergebnis für Tools ohne Canvas (page.evaluate serialisiert kein DOM-Element). */
function finishForTools(r: FinishResult | null): Omit<FinishResult, 'photo'> | null {
  if (!r) return null;
  const { photo: _photo, ...rest } = r;
  return rest;
}

/** Ziel-Foto für Tools: Größe und mittlere Helligkeit (0 = leer/schwarz). Debug-Pfad, darf allozieren. */
function photoInfo(c: HTMLCanvasElement | null): { readonly w: number; readonly h: number; readonly mean: number } | null {
  if (!c) return null;
  const ctx = c.getContext('2d');
  if (!ctx) return { w: c.width, h: c.height, mean: 0 };
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
  return { w: c.width, h: c.height, mean: Math.round((sum / (d.length / 4)) * 10) / 10 };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
