import { Vector3 } from 'three';
import type { CollisionWorld, TraceResult } from '../world/collision/types';
import { DIST_EPSILON, MIN_GROUND_NORMAL_Y, makeTraceResult } from '../world/collision/types';
import { airSpeedCapAt, type MovementConfig } from './MovementConfig';
import type { MovementEvent, MutablePlayerSnapshot, PlayerInput, PlayerSnapshot } from './types';

/**
 * Port von Source `CGameMovement` (Source SDK 2013, gamemovement.cpp) für
 * einen Spieler auf dem Boden/in der Luft — Y oben, Source-Units.
 *
 * Tick-Reihenfolge wie `FullWalkMove` (siehe .docs/rules/movement.md §1).
 * Abweichungen von Source sind bewusst und hier markiert ("Abweichung:").
 * Keine Allokation im Tick-Pfad: alle Vektoren und Trace-Ergebnisse sind Scratch.
 */

// --- Source-Konstanten ------------------------------------------------------

/** TryPlayerMove: so oft wird pro Tick an Flächen abgelenkt. */
const MAX_BUMPS = 4;
/** TryPlayerMove: max. gesammelte Clip-Ebenen. */
const MAX_CLIP_PLANES = 5;
/** CategorizePosition: so weit nach unten wird Boden gesucht. */
const GROUND_PROBE = 2;
/** StayOnGround: Mindeständerung, damit gesnappt wird (0.5 * COORD_RESOLUTION). */
const SNAP_EPSILON = 0.5 / 32;
/**
 * CategorizePosition: m_surfaceFriction, solange man langsam steigt und unter
 * einem eine steile Fläche liegt (Source setzt es auch in freier Luft — hier
 * bewusst nur an steilen Flächen, siehe movement-tuning.md).
 */
const RISING_SURFACE_FRICTION = 0.25;
/** Source: NON_JUMP_VELOCITY 140 bei max. 250 u/s Laufgeschwindigkeit. */
const SOURCE_MAX_GROUND_SPEED = 250;

// --- VELOCITY-Konstanten ----------------------------------------------------

/** Hop-Kette bleibt bestehen, wenn so viele Boden-Ticks mit Friction zwischen Landung und Sprung liegen. */
export const CHAIN_GRACE_TICKS = 3;
/** Surf-Fläche: 0.05 < normal.y < MIN_GROUND_NORMAL_Y (wie compileLevel). */
const SURF_MIN_NORMAL_Y = 0.05;
/** Hysterese: so viele Ticks Kontakt bis surfStart / ohne Kontakt bis surfEnd. */
const SURF_ON_TICKS = 3;
const SURF_OFF_TICKS = 3;
/** Schrittlänge in u: langsam kurz, Sprint lang. */
const STRIDE_MIN = 64;
const STRIDE_MAX = 80;
/** Darunter gibt es keine Schritt-Events (Ausrollen soll nicht klappern). */
const FOOTSTEP_MIN_SPEED = 40;
/** Luft-Tick zählt als "Gewinn", wenn AirAccelerate den Horizontal-Speed um mehr als das erhöht. */
const GAIN_EPSILON = 1e-4;
/** Startwert für "Friction-Ticks seit Landung", wenn es keine Landung gab. */
const NO_LANDING = 1 << 30;
/** Strafe-Sync-Ring: pro Tick ein Slot. */
const SYNC_NONE = 0;
const SYNC_MISS = 1;
const SYNC_GAIN = 2;
/**
 * strafeSync = Gewinn-Ticks / max(Samples, Fenster · diesem Anteil): ohne
 * frische Samples klingt der Wert im letzten Viertel des Fensters weich auf 0 ab.
 */
const SYNC_MIN_SAMPLE_SHARE = 0.25;
/**
 * Unterhalb dieser Längsfahrt (entlang der Rampenachse) steht man an einer
 * steilen Fläche, statt zu surfen — dort darf Luft-Schub nicht hochklettern lassen.
 */
const CREEP_AXIS_SPEED = 100;
/** Stuck-Schutz: nach erfolgloser Suche erst nach so vielen Ticks neu suchen (Source: Zeitdrossel in CheckStuck). */
const STUCK_RETRY_TICKS = 16;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type JumpEvent = Mutable<Extract<MovementEvent, { type: 'jump' }>>;
type LandEvent = Mutable<Extract<MovementEvent, { type: 'land' }>>;
type FootstepEvent = Mutable<Extract<MovementEvent, { type: 'footstep' }>>;

const DUCK_DOWN: MovementEvent = Object.freeze({ type: 'duck', down: true });
const DUCK_UP: MovementEvent = Object.freeze({ type: 'duck', down: false });
const SURF_START: MovementEvent = Object.freeze({ type: 'surfStart' });
const SURF_END: MovementEvent = Object.freeze({ type: 'surfEnd' });

/**
 * Ring aus vorab angelegten Event-Objekten. Ein Objekt wird erst nach
 * EVENT_POOL_SIZE weiteren Events desselben Typs überschrieben — wer Events
 * länger aufhebt, kopiert sie.
 */
const EVENT_POOL_SIZE = 32;
class EventRing<T> {
  private readonly items: T[];
  private i = 0;
  constructor(make: () => T) {
    this.items = Array.from({ length: EVENT_POOL_SIZE }, make);
  }
  next(): T {
    const e = this.items[this.i];
    this.i = (this.i + 1) % this.items.length;
    return e;
  }
}

/**
 * Versatz-Tabelle für den Stuck-Schutz (Source CheckStuck-Idee): erst winzige
 * Schritte, zuerst nach oben, dann seitlich, dann größer. Einmal angelegt.
 * Je Radius alle 26 Richtungen: hoch, seitlich, runter, dann Diagonalen.
 */
const STUCK_DIRS: readonly Vector3[] = (() => {
  const dirs: Array<[number, number, number]> = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
  for (const y of [1, 0, -1]) {
    for (const x of [-1, 0, 1]) {
      for (const z of [-1, 0, 1]) {
        if ((x !== 0 ? 1 : 0) + (y !== 0 ? 1 : 0) + (z !== 0 ? 1 : 0) >= 2) dirs.push([x, y, z]);
      }
    }
  }
  return dirs.map(([x, y, z]) => new Vector3(x, y, z).normalize());
})();
const STUCK_RADII: readonly number[] = [0.125, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80];

function isFiniteVec(v: Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(target, v + step);
  if (v > target) return Math.max(target, v - step);
  return v;
}

/**
 * Source 2013 `ClipVelocity`: Geschwindigkeit an einer Ebene entlang lenken.
 * Danach einmal nachkorrigieren, falls Rundung noch in die Ebene zeigt.
 * (Quake/HL1 nullte stattdessen Komponenten < 0.1 — Source 2013 nicht.)
 * Alias-sicher: `inp` und `out` dürfen dasselbe Objekt sein.
 */
function clipVelocity(inp: Vector3, n: Vector3, out: Vector3, overbounce: number): void {
  const backoff = (inp.x * n.x + inp.y * n.y + inp.z * n.z) * overbounce;
  out.set(inp.x - n.x * backoff, inp.y - n.y * backoff, inp.z - n.z * backoff);
  const adjust = out.x * n.x + out.y * n.y + out.z * n.z;
  if (adjust < 0) out.addScaledVector(n, -adjust);
}

export class PlayerMovement {
  private world: CollisionWorld;
  private cfg: MovementConfig;
  private dt: number;

  private readonly s: MutablePlayerSnapshot;
  /** Live-Zustand, pro Tick mutiert. Nicht verändern — dafür gibt es teleport(). */
  readonly state: PlayerSnapshot;

  private readonly events: MovementEvent[] = [];
  private readonly jumpPool = new EventRing<JumpEvent>(() => ({
    type: 'jump', speed: 0, gain: 0, perfect: false, chain: 0, sync: 0, crouched: false, coyote: false,
  }));
  private readonly landPool = new EventRing<LandEvent>(() => ({ type: 'land', impact: 0, speed: 0, airTime: 0, jumpQueued: false }));
  private readonly stepPool = new EventRing<FootstepEvent>(() => ({ type: 'footstep', speed: 0, left: false }));

  // Hull
  private readonly standMins = new Vector3();
  private readonly standMaxs = new Vector3();
  private readonly duckMins = new Vector3();
  private readonly duckMaxs = new Vector3();
  private mins: Vector3;
  private maxs: Vector3;
  private hullDucked = false;
  /** Duck-Absicht wurde gemeldet (duck down), Gegenstück (duck up) steht noch aus. */
  private duckIntent = false;

  // Zeit / Sprung
  private tickCount = 0;
  private jumpPressTick = Number.NEGATIVE_INFINITY;
  private leftGroundTick = Number.NEGATIVE_INFINITY;
  /** Coyote nur nach Verlassen einer Kante ohne Sprung und ohne Rampen-Launch. */
  private coyoteOk = false;
  /** Boden-Ticks mit Friction seit der letzten Landung. */
  private frictionTicks = NO_LANDING;
  /**
   * Ticks am Stück am Boden (Lande-Tick zählt mit, Teleport = 0) — Smart-Auto-Hop.
   * Nicht frictionTicks: das steht nach dem Spawn auf NO_LANDING und würde die
   * Bodenzeit-Bedingung sofort erfüllen (erster Hop wieder im Stand).
   */
  private groundTicks = 0;
  /** Luftzeit (s) vor der letzten Landung — Smart-Auto-Hop (autoHopLandShare). Teleport = 0. */
  private landAirTime = 0;
  private prevHopSpeed = 0;

  // Strafe-Sync: Ring mit einem Slot pro Tick (SYNC_NONE/MISS/GAIN) über ~1 s.
  private airStrafeTicks = 0;
  private airGainTicks = 0;
  private lastAirSync = 0;
  private syncRing: Uint8Array;
  private syncRingPos = 0;
  private syncSamples = 0;
  private syncGains = 0;
  /** Sample dieses Ticks (von airMove gesetzt). */
  private syncSample = SYNC_NONE;

  // Steile Fläche unter einem (letzte Kategorisierung) — surfaceFriction und Kriech-Schutz.
  private steepBelow = false;
  private readonly steepNormal = new Vector3();
  private surfaceFriction = 1;

  // Stuck-Schutz: vor diesem Tick keine neue Suche (nach erfolgloser).
  private stuckRetryTick = 0;

  // Surf
  private surfTouch = false;
  /** Normale der zuletzt berührten Surf-Fläche (0-Vektor, wenn nicht gesurft wird). */
  private readonly lastSurfNormal = new Vector3();
  private surfOnTicks = 0;
  private surfOffTicks = 0;

  // Eingabe dieses Ticks (bereinigt)
  private inForward = 0;
  private inSide = 0;
  private inYaw = 0;
  private inCrouch = false;
  private inSprint = false;
  private inJumpHeld = false;
  private inJumpPressed = false;

  // Letzter gültiger Zustand (NaN-Schutz)
  private readonly validPos = new Vector3();
  private readonly validVel = new Vector3();
  private validEye = 0;
  private validDucked = false;
  private invalidStreak = 0;

  // Scratch
  private readonly wishdir = new Vector3();
  private wishspeed = 0;
  private readonly end = new Vector3();
  private readonly tmp = new Vector3();
  private readonly tpOriginal = new Vector3();
  private readonly tpPrimal = new Vector3();
  private readonly tpNew = new Vector3();
  private readonly tpDir = new Vector3();
  private readonly planes: Vector3[] = Array.from({ length: MAX_CLIP_PLANES }, () => new Vector3());
  private readonly smStartPos = new Vector3();
  private readonly smStartVel = new Vector3();
  private readonly smDownPos = new Vector3();
  private readonly smDownVel = new Vector3();
  private readonly soStart = new Vector3();
  private readonly clipN = new Vector3();
  private readonly qMins = new Vector3();
  private readonly qMaxs = new Vector3();
  private readonly trMove: TraceResult = makeTraceResult();
  private readonly trAux: TraceResult = makeTraceResult();
  private readonly trGround: TraceResult = makeTraceResult();

  constructor(world: CollisionWorld, config: MovementConfig) {
    this.world = world;
    this.cfg = config;
    this.dt = 1 / config.tickRate;
    this.s = PlayerMovement.createSnapshot();
    this.state = this.s;
    this.mins = this.standMins;
    this.maxs = this.standMaxs;
    this.syncRing = new Uint8Array(Math.max(1, Math.round(config.tickRate)));
    this.applyHullConfig();
    this.s.eyeHeight = config.hull.standEye;
    this.saveValid();
  }

  static createSnapshot(): MutablePlayerSnapshot {
    return {
      pos: new Vector3(),
      vel: new Vector3(),
      onGround: false,
      groundNormal: new Vector3(0, 1, 0),
      ducked: false,
      eyeHeight: 0,
      speed: 0,
      hopChain: 0,
      stridePhase: 0,
      strafeSync: 0,
      airTime: 0,
      surfing: false,
      surfNormal: new Vector3(),
    };
  }

  get config(): MovementConfig {
    return this.cfg;
  }

  /** Aktuelle Hull relativ zum Origin (Füße). Nicht mutieren. */
  get hullMins(): Vector3 {
    return this.mins;
  }

  get hullMaxs(): Vector3 {
    return this.maxs;
  }

  /** Normale der Surf-Fläche, an der man gerade surft (0-Vektor sonst) — für Bots. Nicht mutieren. */
  get surfNormal(): Vector3 {
    return this.lastSurfNormal;
  }

  setWorld(world: CollisionWorld): void {
    this.world = world;
  }

  /** Live umschaltbar (Tuning-Panel). Zustand bleibt erhalten. */
  setConfig(config: MovementConfig): void {
    const oldRate = this.cfg.tickRate;
    this.cfg = config;
    this.dt = 1 / config.tickRate;
    if (Math.round(config.tickRate) !== Math.round(oldRate)) {
      this.syncRing = new Uint8Array(Math.max(1, Math.round(config.tickRate)));
      this.resetSyncRing();
    }
    this.applyHullConfig();
    const h = config.hull;
    this.s.eyeHeight = clamp(this.s.eyeHeight, Math.min(h.duckEye, h.standEye) - (h.standHeight - h.duckHeight), h.standEye);
  }

  copySnapshot(out: MutablePlayerSnapshot): void {
    const s = this.s;
    out.pos.copy(s.pos);
    out.vel.copy(s.vel);
    out.onGround = s.onGround;
    out.groundNormal.copy(s.groundNormal);
    out.ducked = s.ducked;
    out.eyeHeight = s.eyeHeight;
    out.speed = s.speed;
    out.hopChain = s.hopChain;
    out.stridePhase = s.stridePhase;
    out.strafeSync = s.strafeSync;
    out.airTime = s.airTime;
    out.surfing = s.surfing;
    out.surfNormal.copy(this.lastSurfNormal);
  }

  /**
   * Setzt den Spieler an `pos` (Füße): Stand-Hull, Timer, Hop-Kette, Sync
   * und Surf-Zustand zurück. Bodenkontakt wird sofort bestimmt.
   */
  teleport(pos: Vector3, opts?: { keepVelocity?: boolean }): void {
    const s = this.s;
    s.pos.copy(pos);
    if (!opts?.keepVelocity) s.vel.set(0, 0, 0);
    this.setHull(false);
    this.duckIntent = false;
    s.eyeHeight = this.cfg.hull.standEye;
    this.jumpPressTick = Number.NEGATIVE_INFINITY;
    this.leftGroundTick = Number.NEGATIVE_INFINITY;
    this.coyoteOk = false;
    this.frictionTicks = NO_LANDING;
    this.groundTicks = 0;
    this.landAirTime = 0;
    this.prevHopSpeed = 0;
    s.hopChain = 0;
    s.airTime = 0;
    s.stridePhase = 0;
    s.surfing = false;
    this.surfOnTicks = 0;
    this.surfOffTicks = 0;
    this.lastSurfNormal.set(0, 0, 0);
    this.airStrafeTicks = 0;
    this.airGainTicks = 0;
    this.lastAirSync = 0;
    this.resetSyncRing();
    s.onGround = false;
    s.groundNormal.set(0, 1, 0);
    this.surfTouch = false;
    this.steepBelow = false;
    this.surfaceFriction = 1;
    // Spawns liegen exakt auf Bodenhöhe — Berührung zählt als Solid, also sofort freischieben.
    this.stuckRetryTick = 0;
    if (this.world.testBox(s.pos, this.mins, this.maxs)) this.unstick();
    this.categorize(false, false);
    s.speed = Math.hypot(s.vel.x, s.vel.z);
    this.invalidStreak = 0;
    this.saveValid();
  }

  /**
   * Ein Physik-Tick (dt = 1/tickRate). Das zurückgegebene Array wird beim
   * nächsten Aufruf geleert und wiederverwendet.
   */
  tick(input: PlayerInput): readonly MovementEvent[] {
    const ev = this.events;
    ev.length = 0;
    const s = this.s;
    const cfg = this.cfg;
    const halfGravity = cfg.gravity * 0.5 * this.dt;
    this.tickCount++;
    this.readInput(input);
    this.saveValid();
    this.surfTouch = false;
    this.syncSample = SYNC_NONE;

    // 0) Steckt die Hull (Teleport, Config-Wechsel, Rundung)? Erst befreien.
    if (this.tickCount >= this.stuckRetryTick && this.world.testBox(s.pos, this.mins, this.maxs)) this.unstick();

    if (this.inJumpPressed) this.jumpPressTick = this.tickCount;

    // 1) Ducken
    this.checkDuck();

    // 2) StartGravity (am Boden wird vel.y gleich wieder genullt)
    s.vel.y -= halfGravity;

    // 3) Sprung — vor der Friction: ein Sprung im Landetick verliert nichts.
    const jumped = this.checkJump();

    // 4) Bewegen
    this.computeWish();
    const wishspeed = this.wishspeed;
    const preMoveVelY = s.vel.y;
    const wasOnGround = s.onGround;
    if (s.onGround) {
      s.vel.y = 0;
      this.friction();
      if (this.frictionTicks < NO_LANDING) this.frictionTicks++;
      if (this.frictionTicks > CHAIN_GRACE_TICKS) {
        s.hopChain = 0;
        // Kette gerissen: der nächste Sprung hat keinen "vorigen Luftabschnitt".
        this.lastAirSync = 0;
      }
      const x0 = s.pos.x;
      const z0 = s.pos.z;
      this.walkMove(this.wishdir, wishspeed);
      this.advanceStride(Math.hypot(s.pos.x - x0, s.pos.z - z0));
    } else {
      this.airMove(this.wishdir, wishspeed);
    }

    // 5) Kategorisieren (Boden/Luft, Landung)
    const groundMove = wasOnGround && !jumped;
    this.categorize(jumped, groundMove);
    if (!wasOnGround && s.onGround && !jumped) this.onLand(preMoveVelY);
    else if (groundMove && !s.onGround) this.onLeaveGround();

    // 6) FinishGravity
    if (!s.onGround) s.vel.y -= halfGravity;
    else s.vel.y = 0;

    // 7) Achsen-Kappung
    const mv = cfg.maxVelocity;
    s.vel.set(clamp(s.vel.x, -mv, mv), clamp(s.vel.y, -mv, mv), clamp(s.vel.z, -mv, mv));

    // Buchhaltung
    if (s.onGround) s.airTime = 0;
    else s.airTime += this.dt;
    this.groundTicks = s.onGround ? this.groundTicks + 1 : 0;
    this.updateSurf();
    this.pushSync(this.syncSample);
    s.speed = Math.hypot(s.vel.x, s.vel.z);

    // NaN-Schutz: nicht endlich → letzter gültiger Zustand.
    if (!isFiniteVec(s.pos) || !isFiniteVec(s.vel) || !Number.isFinite(s.eyeHeight)) {
      this.restoreValid();
    } else {
      this.invalidStreak = 0;
    }
    return ev;
  }

  // --- Eingabe -----------------------------------------------------------------

  private readInput(input: PlayerInput): void {
    this.inForward = clamp(finiteOr(input.forward, 0), -1, 1);
    this.inSide = clamp(finiteOr(input.side, 0), -1, 1);
    this.inYaw = finiteOr(input.yaw, this.inYaw);
    this.inCrouch = input.crouch;
    this.inSprint = input.sprint;
    this.inJumpHeld = input.jumpHeld;
    this.inJumpPressed = input.jumpPressed;
  }

  /**
   * wishdir aus forward/side + yaw (Pitch spielt keine Rolle). Eingabevektor
   * wird auf Länge ≤ 1 normalisiert — diagonal ist nicht schneller (Source
   * erreicht das über die maxspeed-Kappung). Sprint wirkt nur am Boden: die
   * Luftphysik (Surf-Druck, Luftbremse) soll nicht an einer Bodentaste hängen.
   */
  private computeWish(): void {
    const sy = Math.sin(this.inYaw);
    const cy = Math.cos(this.inYaw);
    // Strafe-Assist (Abweichung, movement-tuning.md): in der Luft zählt W/S nicht,
    // solange A/D gedrückt ist — W dreht die wishdir zur Flugrichtung und frisst
    // zwei Drittel des Gewinns. Auch beim Surfen: dort nahm W+A sonst jeden Druck
    // in die Rampe (L2: Absturz an der ersten Rampe, mit Assist wie reines A).
    const fwd = this.cfg.strafeAssist && !this.s.onGround && this.inSide !== 0 ? 0 : this.inForward;
    // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    let wx = -sy * fwd + cy * this.inSide;
    let wz = -cy * fwd - sy * this.inSide;
    const len = Math.hypot(wx, wz);
    if (len < 1e-6) {
      this.wishdir.set(0, 0, 0);
      this.wishspeed = 0;
      return;
    }
    wx /= len;
    wz /= len;
    this.wishdir.set(wx, 0, wz);
    this.wishspeed = this.s.onGround ? this.groundWishSpeed(len) : this.cfg.runSpeed * Math.min(len, 1);
  }

  /** Wunschtempo am Boden bei Eingabelänge `len` (Sprint, Ducken). */
  private groundWishSpeed(len: number): number {
    const cfg = this.cfg;
    // Geduckt immer runSpeed-basiert (85), auch mit Sprint: Auto-Sprint hält
    // Sprint dauerhaft, Duck-Walk soll trotzdem Duck-Walk bleiben.
    const base = this.hullDucked ? cfg.runSpeed * cfg.duckSpeedScale : this.inSprint ? cfg.sprintSpeed : cfg.runSpeed;
    return base * Math.min(len, 1);
  }

  // --- Ducken (rules/movement.md §4) ------------------------------------------

  private applyHullConfig(): void {
    const h = this.cfg.hull;
    this.standMins.set(-h.halfWidth, 0, -h.halfWidth);
    this.standMaxs.set(h.halfWidth, h.standHeight, h.halfWidth);
    this.duckMins.set(-h.halfWidth, 0, -h.halfWidth);
    this.duckMaxs.set(h.halfWidth, h.duckHeight, h.halfWidth);
  }

  private setHull(ducked: boolean): void {
    this.hullDucked = ducked;
    this.s.ducked = ducked;
    this.mins = ducked ? this.duckMins : this.standMins;
    this.maxs = ducked ? this.duckMaxs : this.standMaxs;
  }

  /**
   * Am Boden sinkt erst das Auge über duckTime, die Hull schrumpft (von oben)
   * erst danach — wie Source (m_bDucking → FinishDuck). Dadurch bleibt
   * "Ducken + Springen im selben Tick" ein vollwertiger Crouch-Jump: im
   * nächsten Tick ist man in der Luft und die Füße gehen 18 u hoch.
   * In der Luft: sofort, Füße hoch, Auge bleibt in Weltkoordinaten.
   */
  private checkDuck(): void {
    const s = this.s;
    const h = this.cfg.hull;
    const delta = h.standHeight - h.duckHeight;
    const rate = ((h.standEye - h.duckEye) / Math.max(this.cfg.duckTime, 1e-3)) * this.dt;

    if (this.inCrouch) {
      if (!this.hullDucked) {
        if (!this.duckIntent) {
          this.duckIntent = true;
          this.events.push(DUCK_DOWN);
        }
        if (!s.onGround) {
          s.pos.y += delta;
          this.setHull(true);
          s.eyeHeight -= delta;
        } else {
          if (s.eyeHeight > h.duckEye) s.eyeHeight = Math.max(h.duckEye, s.eyeHeight - rate);
          if (s.eyeHeight <= h.duckEye + 1e-6) this.setHull(true);
        }
      }
      if (this.hullDucked) s.eyeHeight = approach(s.eyeHeight, h.duckEye, rate);
      return;
    }

    if (this.hullDucked) {
      if (s.onGround) {
        // Hull wächst nach oben, Origin bleibt.
        if (!this.world.testBox(s.pos, this.standMins, this.standMaxs)) this.setHull(false);
      } else {
        // Füße wieder runter; Auge bleibt in Weltkoordinaten.
        this.tmp.copy(s.pos);
        this.tmp.y -= delta;
        if (!this.world.testBox(this.tmp, this.standMins, this.standMaxs)) {
          s.pos.y -= delta;
          this.setHull(false);
          s.eyeHeight += delta;
        }
      }
    }
    if (!this.hullDucked) {
      if (this.duckIntent) {
        this.duckIntent = false;
        this.events.push(DUCK_UP);
      }
      s.eyeHeight = approach(s.eyeHeight, h.standEye, rate);
    }
  }

  // --- Sprung (rules/movement.md §5) ------------------------------------------

  private checkJump(): boolean {
    const cfg = this.cfg;
    const s = this.s;
    // Gehaltene Taste: am Boden erst mit Anlauf (Smart-Auto-Hop), in der Luft (Coyote) sofort.
    const held = cfg.autoHop && this.inJumpHeld && (!s.onGround || this.heldHopReady(this.groundTicks));
    const wants = this.inJumpPressed || this.jumpBuffered() || held;
    if (!wants) return false;
    let coyote = false;
    if (!s.onGround) {
      if (!this.coyoteOk) return false;
      if ((this.tickCount - this.leftGroundTick) * this.dt > cfg.coyoteTime + 1e-9) return false;
      coyote = true;
    }
    this.doJump(coyote);
    return true;
  }

  private doJump(coyote: boolean): void {
    const s = this.s;
    const cfg = this.cfg;
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const perfect = !coyote && this.frictionTicks === 0;
    s.hopChain = this.frictionTicks <= CHAIN_GRACE_TICKS ? s.hopChain + 1 : 1;
    const gain = s.hopChain > 1 ? speed - this.prevHopSpeed : 0;
    this.prevHopSpeed = speed;

    // Source CheckJumpButton: vel.z setzen, dann FinishGravity() — damit
    // liegt die Bahn exakt auf der Parabel mit v0 = jumpImpulse (57 u).
    s.vel.y = cfg.jumpImpulse - cfg.gravity * 0.5 * this.dt;
    // Abweichung (movement-tuning.md): wer schon am Boden geduckt ist (> duckTime vor dem
    // Sprung), bekäme sonst nie den Crouch-Jump — die Hull schrumpft nur in der Luft von
    // unten. Ist über ihr Platz, gleich in die Luft-Duck-Geometrie (Füße +18). Das
    // Welt-Auge bleibt stehen; eyeHeight läuft danach mit Duck-Rate auf duckEye.
    if (!coyote && this.hullDucked) {
      const lift = cfg.hull.standHeight - cfg.hull.duckHeight;
      this.tmp.copy(s.pos);
      this.tmp.y += lift;
      if (!this.world.testBox(this.tmp, this.duckMins, this.duckMaxs)) {
        s.pos.y += lift;
        s.eyeHeight -= lift;
      }
    }
    s.onGround = false;
    s.groundNormal.set(0, 1, 0);
    this.coyoteOk = false;
    this.jumpPressTick = Number.NEGATIVE_INFINITY;
    this.frictionTicks = NO_LANDING;
    this.beginAirSegment();

    const e = this.jumpPool.next();
    e.speed = speed;
    e.gain = gain;
    e.perfect = perfect;
    e.chain = s.hopChain;
    e.sync = this.lastAirSync;
    e.crouched = this.hullDucked || this.inCrouch;
    e.coyote = coyote;
    this.events.push(e);
  }

  // --- Boden-Übergänge ----------------------------------------------------------

  private onLand(preMoveVelY: number): void {
    const s = this.s;
    this.frictionTicks = 0;
    this.coyoteOk = false;
    this.lastAirSync = this.airStrafeTicks > 0 ? this.airGainTicks / this.airStrafeTicks : 0;
    const e = this.landPool.next();
    e.impact = Math.max(0, -preMoveVelY);
    e.speed = Math.hypot(s.vel.x, s.vel.z);
    e.airTime = s.airTime + this.dt;
    this.landAirTime = e.airTime;
    e.jumpQueued = this.jumpWillQueue();
    this.events.push(e);
  }

  /**
   * Würde ein Sprung im nächsten Tick ausgelöst, wenn man jetzt am Boden
   * steht? Gleiche Bedingung wie in checkJump — beide zusammen ändern. Im
   * nächsten Tick steht groundTicks auf 1 (der Lande-Tick zählt mit).
   */
  private jumpWillQueue(): boolean {
    return this.jumpBuffered() || (this.cfg.autoHop && this.inJumpHeld && this.heldHopReady(1));
  }

  private jumpBuffered(): boolean {
    return (this.tickCount - this.jumpPressTick) * this.dt <= this.cfg.jumpBufferTime + 1e-9;
  }

  /**
   * Smart-Auto-Hop (Abweichung, movement-tuning.md): eine NUR gehaltene Taste
   * springt am Boden erst, wenn keine Bewegungstaste gedrückt ist, das Tempo
   * nahe am Boden-Wunschtempo liegt oder man lange genug steht (Wand, Stufe).
   * Sonst fror jede langsame Landung ein: der Sprung kommt vor WalkMove, der
   * Boden beschleunigt nie, in der Luft deckelt der Cap bei 24 u/s. Frischer
   * Druck, Puffer und Mausrad springen weiter sofort; Bhop mit Tempo landet
   * immer über der Schwelle und bleibt unberührt.
   * Strafer (A/D gedrückt) landen aus echter Luftphase: im ersten Bodentick
   * reicht der lockere Anteil (autoHopLandShare) — sonst hing jede Strafe-Landung
   * knapp unter Lauftempo bis 0.2 s am Boden und die Reibung riss die Kette.
   * Reines W bleibt streng: wer nicht strafet, gewinnt in der Luft nichts, und
   * nach einem Teil-Anprall (Treppe) holt der Boden die 310 u/s zurück.
   * groundTicks ≤ 1 = Landetick.
   */
  private heldHopReady(groundTicks: number): boolean {
    const cfg = this.cfg;
    if (this.inForward === 0 && this.inSide === 0) return true;
    if (groundTicks * this.dt >= cfg.autoHopGroundTime - 1e-9) return true;
    const v = this.s.vel;
    const speed = Math.hypot(v.x, v.z);
    const wish = this.groundWishSpeed(Math.hypot(this.inForward, this.inSide));
    if (this.inSide !== 0 && groundTicks <= 1 && this.landAirTime >= cfg.autoHopLandAirTime - 1e-9 && speed >= cfg.autoHopLandShare * wish) return true;
    return speed >= cfg.autoHopSpeedShare * wish;
  }

  private onLeaveGround(): void {
    this.leftGroundTick = this.tickCount;
    // Rampen-Launch (schnell nach oben) ist kein Kante-Verlassen.
    this.coyoteOk = this.s.vel.y <= this.groundLaunchVelocity();
    this.beginAirSegment();
  }

  /**
   * Ab dieser Aufwärtsgeschwindigkeit hebt man nach einem Boden-Tick ab
   * (Ramp-Launch). Source: 140 bei max. 250 u/s — Laufen erzeugt auf
   * begehbaren Rampen (≤ 45.6°) höchstens v·sinθ·cosθ ≤ 0.5·v = 125, hebt also
   * nie ab. Mit Sprint 320 wären es 160: gleiche Garantie → Schwelle mit der
   * höchsten Bodengeschwindigkeit skalieren. In der Luft (Landung) gilt 140.
   */
  private groundLaunchVelocity(): number {
    const cfg = this.cfg;
    const maxGround = Math.max(cfg.runSpeed, cfg.sprintSpeed);
    return Math.max(cfg.nonJumpVelocity, (cfg.nonJumpVelocity * maxGround) / SOURCE_MAX_GROUND_SPEED);
  }

  private beginAirSegment(): void {
    this.airStrafeTicks = 0;
    this.airGainTicks = 0;
  }

  // --- Beschleunigung (rules/movement.md §2) -----------------------------------

  private accelerate(wishdir: Vector3, wishspeed: number, accel: number): void {
    const v = this.s.vel;
    const current = v.dot(wishdir);
    const add = wishspeed - current;
    if (add <= 0) return;
    let accelspd = accel * wishspeed * this.dt;
    if (accelspd > add) accelspd = add;
    v.addScaledVector(wishdir, accelspd);
  }

  private airAccelerate(wishdir: Vector3, wishspeed: number, accel: number): void {
    const v = this.s.vel;
    // Tempoabhängiger Cap (Abweichung, movement-tuning.md) aus dem Horizontal-Tempo VOR dem
    // Schub — nur in freier Luft. An Surf-Flanken gilt der Basis-Cap: Halten/Klettern ist auf
    // ihn abgestimmt (fallen.md #28), mit 32 drückte man langsam zu stark in die Rampe.
    const surf = this.steepBelow || this.s.surfing;
    const wishspd = Math.min(wishspeed, surf ? this.cfg.airSpeedCap : airSpeedCapAt(this.cfg, Math.hypot(v.x, v.z)));
    const current = v.dot(wishdir);
    const add = wishspd - current;
    if (add <= 0) return;
    // Voller wishspeed, nicht wishspd — daher kommt der Strafe-Gewinn.
    let accelspd = accel * wishspeed * this.dt * this.surfaceFriction;
    if (accelspd > add) accelspd = add;
    v.addScaledVector(wishdir, accelspd);
  }

  private friction(): void {
    const v = this.s.vel;
    const speed = v.length();
    if (speed < 0.1) return;
    const cfg = this.cfg;
    const control = speed < cfg.stopSpeed ? cfg.stopSpeed : speed;
    const drop = control * cfg.friction * this.dt;
    let newspeed = speed - drop;
    if (newspeed < 0) newspeed = 0;
    if (newspeed !== speed) v.multiplyScalar(newspeed / speed);
  }

  // --- Bewegung -------------------------------------------------------------

  private walkMove(wishdir: Vector3, wishspeed: number): void {
    const s = this.s;
    const vel = s.vel;
    vel.y = 0;
    this.accelerate(wishdir, wishspeed, this.cfg.accelerate);
    vel.y = 0;

    if (vel.length() < 1) {
      vel.set(0, 0, 0);
      return;
    }

    // Erst direkt versuchen (horizontal), sonst StepMove.
    const dest = this.end.set(s.pos.x + vel.x * this.dt, s.pos.y, s.pos.z + vel.z * this.dt);
    const tr = this.world.traceBox(s.pos, dest, this.mins, this.maxs, this.trMove);
    if (tr.fraction === 1) {
      s.pos.copy(tr.endPos);
      this.stayOnGround();
      return;
    }
    this.stepMove();
    this.stayOnGround();
  }

  private airMove(wishdir: Vector3, wishspeed: number): void {
    const vel = this.s.vel;
    const before = Math.hypot(vel.x, vel.z);
    // Kriech-Schutz, Teil 1: Falllinien-Speed vor dem Schub merken.
    let creepU = Number.NaN;
    const t = this.tmp;
    if (this.steepBelow) {
      const n = this.steepNormal;
      // t = Aufwärtsrichtung entlang der Falllinie der Fläche.
      t.set(-n.x * n.y, 1 - n.y * n.y, -n.z * n.y).normalize();
      const u = vel.dot(t);
      const vn = vel.dot(n);
      const ax = vel.x - t.x * u - n.x * vn;
      const ay = vel.y - t.y * u - n.y * vn;
      const az = vel.z - t.z * u - n.z * vn;
      if (ax * ax + ay * ay + az * az < CREEP_AXIS_SPEED * CREEP_AXIS_SPEED) creepU = u;
    }
    this.airAccelerate(wishdir, wishspeed, this.cfg.airAccelerate);
    if (!Number.isNaN(creepU)) {
      // Teil 2: ohne Längsfahrt steht man an der Flanke — Schub darf halten, aber
      // nicht klettern lassen (bei 128 Tick überträfe der Cap sonst g·dt·tanθ).
      const limit = Math.max(creepU, 0);
      const u = vel.dot(t);
      if (u > limit) vel.addScaledVector(t, limit - u);
    }
    if (this.inSide !== 0) {
      this.syncSample = Math.hypot(vel.x, vel.z) > before + GAIN_EPSILON ? SYNC_GAIN : SYNC_MISS;
    }
    this.tryPlayerMove();
  }

  /** Source `TryPlayerMove`: Slide-Move mit bis zu 4 Bumps und 5 Clip-Ebenen. */
  private tryPlayerMove(): void {
    const s = this.s;
    const pos = s.pos;
    const vel = s.vel;
    const original = this.tpOriginal.copy(vel);
    const primal = this.tpPrimal.copy(vel);
    const newVel = this.tpNew.set(0, 0, 0);
    const planes = this.planes;
    const tr = this.trMove;
    let numPlanes = 0;
    let allFraction = 0;
    let timeLeft = this.dt;

    for (let bump = 0; bump < MAX_BUMPS; bump++) {
      if (vel.x === 0 && vel.y === 0 && vel.z === 0) break;
      this.end.copy(pos).addScaledVector(vel, timeLeft);
      this.world.traceBox(pos, this.end, this.mins, this.maxs, tr);
      allFraction += tr.fraction;

      if (tr.allSolid) {
        vel.set(0, 0, 0);
        return;
      }

      if (tr.fraction > 0) {
        if (tr.fraction === 1 && this.world.testBox(tr.endPos, this.mins, this.maxs)) {
          // Source: Präzisionsschutz — Endpunkt würde stecken, also nicht bewegen.
          vel.set(0, 0, 0);
          break;
        }
        pos.copy(tr.endPos);
        original.copy(vel);
        numPlanes = 0;
      }

      if (tr.fraction === 1) break;

      this.noteContact(tr.normal);
      timeLeft -= timeLeft * tr.fraction;

      // Abweichung: am Boden wirkt eine steile Fläche (Surf-Rampe) wie eine
      // Wand. Source schiebt einen dort per Clip die Flanke hoch, bis die
      // 2-u-Bodensonde nichts mehr findet — man hüpft am Rampenfuß und der
      // Sprung wird verschluckt. Horizontal abgleiten hält einen am Boden.
      const n = this.clipN.copy(tr.normal);
      if (s.onGround && n.y > 0 && n.y < MIN_GROUND_NORMAL_Y) {
        n.y = 0;
        n.normalize();
      }

      // Abweichung (Quake 3 PM_SlideMove): dieselbe Ebene nochmal getroffen —
      // Rundung an schrägen Ebenen (Surf, Rampen) lässt die Box knapp unter
      // DIST_EPSILON stehen und der Trace liefert fraction 0. Ohne diesen Fix
      // entstünden zwei identische Clip-Ebenen, Kreuzprodukt 0 → Stillstand.
      let duplicate = false;
      for (let i = 0; i < numPlanes; i++) {
        if (n.dot(planes[i]) > 0.99) {
          vel.add(n);
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;

      if (numPlanes >= MAX_CLIP_PLANES) {
        vel.set(0, 0, 0);
        break;
      }
      planes[numPlanes].copy(n);
      numPlanes++;

      if (numPlanes === 1 && !s.onGround) {
        // Luft, erste Ebene: nur ablenken (overbounce 1). Kein primal-Check —
        // das ist der Surf-Fall.
        clipVelocity(original, planes[0], newVel, 1);
        vel.copy(newVel);
        original.copy(newVel);
      } else {
        let i = 0;
        for (; i < numPlanes; i++) {
          clipVelocity(original, planes[i], vel, 1);
          let j = 0;
          for (; j < numPlanes; j++) {
            if (j !== i && vel.dot(planes[j]) < 0) break;
          }
          if (j === numPlanes) break;
        }
        if (i === numPlanes) {
          // Keine einzelne Ebene reicht: entlang der Knick-Kante, bei 3+ stoppen.
          if (numPlanes !== 2) {
            vel.set(0, 0, 0);
            break;
          }
          const dir = this.tpDir.crossVectors(planes[0], planes[1]).normalize();
          vel.copy(dir).multiplyScalar(dir.dot(vel));
        }
        // Gegen die Ursprungsrichtung → stehen bleiben (kein Zittern in Ecken).
        if (vel.dot(primal) <= 0) {
          vel.set(0, 0, 0);
          break;
        }
      }
    }

    if (allFraction === 0) vel.set(0, 0, 0);
  }

  /** Source `StepMove`: unten vs. um stepSize angehoben — wer weiter kommt, gewinnt. */
  private stepMove(): void {
    const s = this.s;
    const pos = s.pos;
    const vel = s.vel;
    const step = this.cfg.stepSize;
    const startPos = this.smStartPos.copy(pos);
    const startVel = this.smStartVel.copy(vel);

    this.tryPlayerMove();
    const downPos = this.smDownPos.copy(pos);
    const downVel = this.smDownVel.copy(vel);

    pos.copy(startPos);
    vel.copy(startVel);

    this.end.copy(pos);
    this.end.y += step + DIST_EPSILON;
    let tr = this.world.traceBox(pos, this.end, this.mins, this.maxs, this.trAux);
    if (!tr.startSolid && !tr.allSolid) pos.copy(tr.endPos);

    this.tryPlayerMove();

    this.end.copy(pos);
    this.end.y -= step + DIST_EPSILON;
    tr = this.world.traceBox(pos, this.end, this.mins, this.maxs, this.trAux);

    // Nicht auf begehbarem Boden gelandet → normaler Versuch gilt.
    if (tr.normal.y < MIN_GROUND_NORMAL_Y) {
      pos.copy(downPos);
      vel.copy(downVel);
      return;
    }
    if (!tr.startSolid && !tr.allSolid) pos.copy(tr.endPos);

    const dxd = downPos.x - startPos.x;
    const dzd = downPos.z - startPos.z;
    const dxu = pos.x - startPos.x;
    const dzu = pos.z - startPos.z;
    if (dxd * dxd + dzd * dzd > dxu * dxu + dzu * dzu) {
      pos.copy(downPos);
      vel.copy(downVel);
    } else {
      vel.y = downVel.y;
    }
  }

  /** Source `StayOnGround`: Rampen/Stufen runter am Boden kleben statt abzuheben. */
  private stayOnGround(): void {
    const pos = this.s.pos;
    const start = this.soStart.copy(pos);
    start.y += 2;
    let tr = this.world.traceBox(pos, start, this.mins, this.maxs, this.trAux);
    start.copy(tr.endPos);
    this.end.copy(pos);
    this.end.y -= this.cfg.stepSize;
    tr = this.world.traceBox(start, this.end, this.mins, this.maxs, this.trAux);
    if (tr.fraction > 0 && tr.fraction < 1 && !tr.startSolid && tr.normal.y >= MIN_GROUND_NORMAL_Y) {
      if (Math.abs(pos.y - tr.endPos.y) > SNAP_EPSILON) pos.copy(tr.endPos);
    }
  }

  /**
   * Source `CategorizePosition`: 2 u nach unten; Boden nur bei begehbarer
   * Normale und wenn man nicht schnell nach oben fliegt (Ramp-Launch). Trifft
   * die volle Hull eine steile Fläche, prüfen vier Teil-Boxen, ob darunter
   * doch Boden liegt (`TryTouchGroundInQuadrants` — Rampenfuß, Kanten).
   * Liegt keiner darunter und man steigt langsam, gilt m_surfaceFriction 0.25.
   * Abweichung: im Sprung-Tick wird nie Boden erkannt — sonst könnte ein im
   * Tuning-Panel sehr kleiner jumpImpulse den Sprung sofort wieder schlucken.
   * `groundMove`: der Tick begann am Boden → Ramp-Launch erst ab groundLaunchVelocity.
   */
  private categorize(jumpedThisTick: boolean, groundMove: boolean): void {
    const s = this.s;
    const cfg = this.cfg;
    let ground = false;
    this.steepBelow = false;
    this.surfaceFriction = 1;
    const launch = groundMove ? this.groundLaunchVelocity() : cfg.nonJumpVelocity;
    if (!jumpedThisTick && s.vel.y <= launch) {
      this.end.copy(s.pos);
      this.end.y -= GROUND_PROBE;
      const tr = this.world.traceBox(s.pos, this.end, this.mins, this.maxs, this.trGround);
      if (tr.fraction < 1 && !tr.allSolid) {
        if (tr.normal.y >= MIN_GROUND_NORMAL_Y) {
          ground = true;
          s.groundNormal.copy(tr.normal);
        } else if (this.touchGroundInQuadrants(s.pos, this.end)) {
          ground = true;
          s.groundNormal.copy(this.trAux.normal);
        } else {
          this.noteContact(tr.normal);
          if (tr.normal.y > 0) {
            this.steepBelow = true;
            this.steepNormal.copy(tr.normal);
            if (s.vel.y > 0) this.surfaceFriction = RISING_SURFACE_FRICTION;
          }
        }
      }
    }
    if (ground) {
      s.onGround = true;
      s.vel.y = 0;
    } else {
      s.onGround = false;
      s.groundNormal.set(0, 1, 0);
    }
  }

  /** Source `TryTouchGroundInQuadrants`: je ein Viertel der Grundfläche nach unten tracen. Treffer steht in trAux. */
  private touchGroundInQuadrants(start: Vector3, end: Vector3): boolean {
    const mins = this.mins;
    const maxs = this.maxs;
    const qMin = this.qMins;
    const qMax = this.qMaxs;
    for (let q = 0; q < 4; q++) {
      // Reihenfolge wie Source: (−x,−z), (+x,+z), (−x,+z), (+x,−z).
      const posX = q === 1 || q === 3;
      const posZ = q === 1 || q === 2;
      qMin.set(posX ? Math.max(0, mins.x) : mins.x, mins.y, posZ ? Math.max(0, mins.z) : mins.z);
      qMax.set(posX ? maxs.x : Math.min(0, maxs.x), maxs.y, posZ ? maxs.z : Math.min(0, maxs.z));
      const tr = this.world.traceBox(start, end, qMin, qMax, this.trAux);
      if (tr.fraction < 1 && !tr.allSolid && tr.normal.y >= MIN_GROUND_NORMAL_Y) return true;
    }
    return false;
  }

  // --- Stuck-Schutz ---------------------------------------------------------

  /**
   * Je Radius erst mit aktueller Hull, dann geduckt — so landet ein Respawn im
   * Duck-Tunnel geduckt am Ort statt 80 u weiter auf dem Tunneldach. Findet
   * die Suche nichts, erst nach STUCK_RETRY_TICKS wieder (kein Frame-Spike
   * durch tausende Box-Tests pro Tick).
   */
  private unstick(): void {
    const pos = this.s.pos;
    const tryDuck = !this.hullDucked;
    const p = this.tmp;
    for (const r of STUCK_RADII) {
      for (const d of STUCK_DIRS) {
        p.copy(pos).addScaledVector(d, r);
        if (!this.world.testBox(p, this.mins, this.maxs)) {
          pos.copy(p);
          return;
        }
      }
      if (!tryDuck) continue;
      for (const d of STUCK_DIRS) {
        p.copy(pos).addScaledVector(d, r);
        if (!this.world.testBox(p, this.duckMins, this.duckMaxs)) {
          pos.copy(p);
          this.setHull(true);
          this.s.eyeHeight = this.cfg.hull.duckEye;
          return;
        }
      }
    }
    this.stuckRetryTick = this.tickCount + STUCK_RETRY_TICKS;
  }

  // --- Buchhaltung -----------------------------------------------------------

  private noteContact(n: Vector3): void {
    if (!this.s.onGround && n.y > SURF_MIN_NORMAL_Y && n.y < MIN_GROUND_NORMAL_Y) {
      this.surfTouch = true;
      this.lastSurfNormal.copy(n);
    }
  }

  private updateSurf(): void {
    const s = this.s;
    if (!s.onGround && this.surfTouch) {
      this.surfOnTicks++;
      this.surfOffTicks = 0;
    } else {
      this.surfOffTicks++;
      this.surfOnTicks = 0;
    }
    if (!s.surfing && this.surfOnTicks >= SURF_ON_TICKS) {
      s.surfing = true;
      this.events.push(SURF_START);
    } else if (s.surfing && (s.onGround || this.surfOffTicks >= SURF_OFF_TICKS)) {
      s.surfing = false;
      this.events.push(SURF_END);
    }
    if (!s.surfing && this.surfOnTicks === 0) this.lastSurfNormal.set(0, 0, 0);
  }

  /**
   * Ein Slot pro Tick (auch ohne Strafe-Eingabe), damit das Fenster echte ~1 s
   * Zeit abdeckt: nach dem Stehenbleiben fällt strafeSync auf 0.
   */
  private pushSync(sample: number): void {
    if (sample !== SYNC_NONE) {
      this.airStrafeTicks++;
      if (sample === SYNC_GAIN) this.airGainTicks++;
    }
    const ring = this.syncRing;
    const old = ring[this.syncRingPos];
    if (old !== SYNC_NONE) this.syncSamples--;
    if (old === SYNC_GAIN) this.syncGains--;
    ring[this.syncRingPos] = sample;
    if (sample !== SYNC_NONE) this.syncSamples++;
    if (sample === SYNC_GAIN) this.syncGains++;
    this.syncRingPos = (this.syncRingPos + 1) % ring.length;
    const denom = Math.max(this.syncSamples, ring.length * SYNC_MIN_SAMPLE_SHARE);
    this.s.strafeSync = this.syncGains / denom;
  }

  private resetSyncRing(): void {
    this.syncRing.fill(SYNC_NONE);
    this.syncRingPos = 0;
    this.syncSamples = 0;
    this.syncGains = 0;
    this.s.strafeSync = 0;
  }

  /** Schrittzyklus über die Bodenstrecke; Schritt-Events bei Phase 0.5 (links) und 1.0 (rechts). */
  private advanceStride(dist: number): void {
    if (dist <= 1e-6) return;
    const s = this.s;
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const t = clamp((speed - 150) / Math.max(1, this.cfg.sprintSpeed - 150), 0, 1);
    const stride = STRIDE_MIN + (STRIDE_MAX - STRIDE_MIN) * t;
    const prev = s.stridePhase;
    let p = prev + Math.min(dist / (2 * stride), 0.49);
    const audible = speed >= FOOTSTEP_MIN_SPEED;
    if (prev < 0.5 && p >= 0.5 && audible) this.pushStep(speed, true);
    if (p >= 1) {
      p -= 1;
      if (audible) this.pushStep(speed, false);
    }
    s.stridePhase = p;
  }

  private pushStep(speed: number, left: boolean): void {
    const e = this.stepPool.next();
    e.speed = speed;
    e.left = left;
    this.events.push(e);
  }

  private saveValid(): void {
    this.validPos.copy(this.s.pos);
    this.validVel.copy(this.s.vel);
    this.validEye = this.s.eyeHeight;
    this.validDucked = this.hullDucked;
  }

  private restoreValid(): void {
    const s = this.s;
    s.pos.copy(this.validPos);
    this.invalidStreak++;
    // Zweimal hintereinander ungültig: Geschwindigkeit war die Ursache → weg damit.
    if (this.invalidStreak > 1 || !isFiniteVec(this.validVel)) s.vel.set(0, 0, 0);
    else s.vel.copy(this.validVel);
    s.eyeHeight = this.validEye;
    this.setHull(this.validDucked);
    s.speed = Math.hypot(s.vel.x, s.vel.z);
  }
}
