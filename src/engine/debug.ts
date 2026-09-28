import { Vector3 } from 'three';
import type { AudioApi, BeatInfo } from '../audio/types';
import type { MovementConfig } from '../player/MovementConfig';
import type { PlayerInput, PlayerSnapshot } from '../player/types';
import type { RenderSettings } from '../render/types';
import type { FinishResult } from '../ui/types';
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
  readonly finish: FinishResult | null;
  readonly bot: BotInfo | null;
  /** Knoten der Level-Route (0 = keine, useBot('route') geht dann nicht). */
  readonly routeNodes: number;
  /** Gerade sichtbarer HUD-Hinweis (Coach/Eingabe), sonst null. */
  readonly notice: string | null;
  /** Wie oft jeder Hinweis im Moment gezeigt wurde (Sitzung). */
  readonly hints: { readonly crouch: number; readonly surf: number; readonly strafe: number };
  /** Dauer des JIT-Vorwärmens beim ersten Level (ms, −1 = noch nicht). */
  readonly jitWarmupMs: number;
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
   * Trick des gehaltenen Gegenstands starten (Namen aus CAN_/CARD_/KNIFE_TRICKS), optional bei
   * Trick-Zeit at (s) festhalten; 'none' = zurück. false = passt nicht zum Gegenstand.
   */
  forceTrick(name: AnyTrick | 'none', at?: number): boolean;
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
      finish: game.lastFinish,
      bot: game.botInfo,
      routeNodes: game.currentLevel?.def.route?.length ?? 0,
      notice: game.hudNotice,
      hints: { crouch: game.hintsShown.crouch, surf: game.hintsShown.surf, strafe: game.hintsShown.strafe },
      jitWarmupMs: Math.round(game.jitWarmupMs * 10) / 10,
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
  };
  window.__vel = handle;
  return handle;
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

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
