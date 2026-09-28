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

/** Hop-Kette bleibt bestehen, wenn so viele Boden-Ticks zwischen Landung und Sprung liegen (ohne Lande-Gnade). */
export const CHAIN_GRACE_TICKS = 3;
/** Lande-Gnade nur nach so viel Luftzeit (s): Stufen und Kanten-Holpern sind keine Landung. */
const LAND_GRACE_MIN_AIR = 0.1;
/** Hang-Landung: flacher als ~0.8° ist flach (bitgleich zu Source). */
const FLAT_NORMAL_Y = 0.9999;
/** Kanten-Assist: nur ab diesem Anlauf (u/s) und bei mehr als 1 u/s Verlust im Move. */
const LEDGE_MIN_SPEED = 50;
/** Kanten-Assist: Wand = fast senkrecht (|n.y| darunter). */
const LEDGE_WALL_MAX_NY = 0.1;
/** Kanten-Assist: nur frontale Anpraller (cos 45° zur Wandnormalen). */
const LEDGE_MIN_INCIDENCE = Math.SQRT1_2;
/** Gedächtnis: greift, solange v_h unter diesem Anteil des gemerkten liegt … */
const LEDGE_RESTORE_SHARE = 0.9;
/** … und die Füße mindestens so viel (u) über der Anprallhöhe sind. */
const LEDGE_RESTORE_RISE = 0.5;
/**
 * Lip-Step im Steigen nur, wenn der Rest-Aufstieg die Kante nicht um mindestens so viel (u) selbst
 * überragt — sonst verschluckte er den Sprung (Absprung direkt vor einer Stufe: 8 ms Luft statt 0.7 s);
 * das Gedächtnis gibt das Tempo zurück, sobald die Hull oben frei ist.
 */
const LEDGE_RISE_CLEAR = 2;
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
/** Rampbug-Fix: Anhebungen (u) entlang der Surf-Normale für den Nachtrace, kleinste zuerst. */
const SEAM_RETRACE: readonly number[] = [0.25, 1, 2];
/** Rampbug-Fix: Gegen-Ebene = horizontale Normale mehr als 120° gegen die Fahrt … */
const SEAM_OPPOSE_COS = -0.5;
/** … und nur mit echter Fahrt (sonst kein Phantom, sondern Stehen an der Flanke). */
const SEAM_MIN_SPEED = 100;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type JumpEvent = Mutable<Extract<MovementEvent, { type: 'jump' }>>;
type LandEvent = Mutable<Extract<MovementEvent, { type: 'land' }>>;
type FootstepEvent = Mutable<Extract<MovementEvent, { type: 'footstep' }>>;
type LedgeEvent = Mutable<Extract<MovementEvent, { type: 'ledge' }>>;
type SlideStartEvent = Mutable<Extract<MovementEvent, { type: 'slideStart' }>>;
type SlideEndEvent = Mutable<Extract<MovementEvent, { type: 'slideEnd' }>>;

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

/**
 * Horizontale Länge für die Arcade-Pfade. Nicht Math.hypot: V8 inlinet es nicht, jeder Aufruf boxt das
 * Ergebnis als Heap-Zahl (gemessen +200 B/Tick Müll). Die Source-Pfade behalten hypot (bitgleich zu CS2).
 */
function hLen(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

/** Zeigt die Ebene (horizontal) gegen die Fahrt? Rampbug-Fix: nur solche Treffer sind Fugen-Verdacht. */
function opposesFlight(n: Vector3, v: Vector3): boolean {
  const nh = hLen(n.x, n.z);
  const vh = hLen(v.x, v.z);
  return nh > 1e-6 && vh > SEAM_MIN_SPEED && (n.x * v.x + n.z * v.z) / (nh * vh) < SEAM_OPPOSE_COS;
}

/**
 * Dreht v_h um höchstens maxRad zur Blickrichtung (forward = (−sin yaw, −cos yaw)); der Betrag
 * bleibt. Nur wenn der Blick höchstens 90° neben der Flugrichtung liegt — nach hinten schauen ist
 * keine Kurve (Rutschen, Luftlenkung). Rückgabe: gedrehter Winkel (rad).
 */
function turnTowardYaw(v: Vector3, yaw: number, maxRad: number): number {
  const sp = hLen(v.x, v.z);
  if (sp < 1e-3 || !(maxRad > 0)) return 0;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  if (fx * v.x + fz * v.z <= 0) return 0;
  let d = Math.atan2(fx, fz) - Math.atan2(v.x, v.z);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  const step = clamp(d, -maxRad, maxRad);
  if (step === 0) return 0;
  const a = Math.atan2(v.x, v.z) + step;
  v.x = Math.sin(a) * sp;
  v.z = Math.cos(a) * sp;
  return Math.abs(step);
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
    type: 'jump', speed: 0, gain: 0, perfect: false, clean: false, chain: 0, sync: 0, crouched: false, coyote: false,
  }));
  private readonly landPool = new EventRing<LandEvent>(() => ({ type: 'land', impact: 0, speed: 0, airTime: 0, jumpQueued: false }));
  private readonly stepPool = new EventRing<FootstepEvent>(() => ({ type: 'footstep', speed: 0, left: false }));
  private readonly ledgePool = new EventRing<LedgeEvent>(() => ({ type: 'ledge', kind: 'step', speed: 0, dy: 0 }));
  private readonly slideStartPool = new EventRing<SlideStartEvent>(() => ({ type: 'slideStart', speed: 0, boost: false }));
  private readonly slideEndPool = new EventRing<SlideEndEvent>(() => ({ type: 'slideEnd', speed: 0 }));

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
  /** Boden-Ticks seit der letzten Landung (in der Lande-Gnade ohne Friction). */
  private frictionTicks = NO_LANDING;
  /** Lande-Gnade in Ticks (aus cfg.landGraceTime) und ob die letzte Landung sie bekommt. */
  private graceTicks = 0;
  private graceArmed = false;
  /** Hang-Landung: Anflug-Geschwindigkeit dieses Ticks vor dem ersten Boden-Clip. */
  private readonly landRefVel = new Vector3();
  private landRefSet = false;
  /**
   * Hang-Landung: gestundeter Bergauf-Verlust (u/s). Bergauf verliert man nichts, der erlassene
   * Clip-Verlust wird aber mit dem nächsten Bergab-Gewinn verrechnet — sonst erntete jede Talfahrt
   * den Sprungimpuls, den der Aufstieg gratis bekam (W+Leertaste über 10°-Wellen 320 → 785 u/s).
   * Nie mehr als das Tempo über dem Lauftempo: darunter holt der Boden es ohnehin zurück.
   */
  private slopeDebt = 0;
  /** Kanten-Assist: Tempo vor dem letzten frontalen Anprall, Fußhöhe dabei, Rest-Luftticks. */
  private readonly memVel = new Vector3();
  private memY = 0;
  private memTicks = 0;
  /** Rutschen: Tick des letzten Schubs (Abklingzeit). */
  private lastBoostTick = -NO_LANDING;
  /**
   * Rutsch-Physik läuft (Reibung, Lenken, Hangabtrieb, keine Schritte). `state.sliding` und slideStart
   * folgen erst nach der Lande-Gnade: ein Sprung darin ist ein Crouch-Hop, keine Rutsche — sonst
   * kratzte jeder 1–8 Ticks späte Crouch-Hop (slideStart + slideEnd), während er als clean gelobt wird.
   */
  private slideOn = false;
  /** Schub der noch nicht gemeldeten Rutsche (für slideStart.boost am Ende der Gnade). */
  private slideBoostUnsaid = false;
  /**
   * Rutschen: die Rutsche hat den Boden ohne Sprung verlassen (Kante, Mulde, Kuppe). Bei der
   * nächsten Landung geht sie weiter, solange die Hull geduckt ist und das Tempo ≥ slideExitSpeed —
   * sonst würgte jede Bodenwelle sie unter slideMinSpeed zum Duck-Walk ab (270 → 85 u/s in 0.2 s).
   */
  private slideCarry = false;
  /** Luftlenkung: Sekunden seit dem letzten Kontakt mit einer steilen Fläche (Surf-Pause). */
  private steepAgo = Number.POSITIVE_INFINITY;
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
  private readonly seamNormal = new Vector3();
  private readonly seamStart = new Vector3();
  private readonly seamEnd = new Vector3();
  private readonly lsP0 = new Vector3();
  private readonly lsV0 = new Vector3();
  private readonly lsPos = new Vector3();
  private readonly lsVel = new Vector3();
  private readonly lsEnd = new Vector3();
  private readonly lsRef = new Vector3();
  private readonly trLedge: TraceResult = makeTraceResult();
  private readonly trMove: TraceResult = makeTraceResult();
  private readonly trAux: TraceResult = makeTraceResult();
  private readonly trGround: TraceResult = makeTraceResult();
  private readonly trSeam: TraceResult = makeTraceResult();

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
    this.applyArcadeConfig();
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
      sliding: false,
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
    this.applyArcadeConfig();
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
    out.sliding = s.sliding;
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
    this.graceArmed = false;
    this.slopeDebt = 0;
    this.memTicks = 0;
    this.lastBoostTick = -NO_LANDING;
    this.steepAgo = Number.POSITIVE_INFINITY;
    s.sliding = false;
    this.slideOn = false;
    this.slideBoostUnsaid = false;
    this.slideCarry = false;
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
    this.landRefSet = false;
    if (s.onGround) {
      s.vel.y = 0;
      this.updateSlide();
      this.friction();
      if (this.frictionTicks < NO_LANDING) this.frictionTicks++;
      if (this.frictionTicks > this.chainGraceTicks()) {
        s.hopChain = 0;
        // Kette gerissen: der nächste Sprung hat keinen "vorigen Luftabschnitt".
        this.lastAirSync = 0;
      }
      const x0 = s.pos.x;
      const z0 = s.pos.z;
      this.walkMove(this.wishdir, wishspeed);
      // Rutschen hat keine Schritte (kein Head-Bob, keine Schritt-Events).
      if (!this.slideOn) this.advanceStride(Math.hypot(s.pos.x - x0, s.pos.z - z0));
    } else {
      this.airMove(this.wishdir, wishspeed);
    }

    // 5) Kategorisieren (Boden/Luft, Landung)
    const groundMove = wasOnGround && !jumped;
    // Hang-Landung, Sonden-Fall: der Move hat den Boden nicht berührt, die 2-u-Sonde findet ihn gleich.
    if (!wasOnGround && !jumped && !this.landRefSet) this.landRefVel.copy(s.vel);
    this.categorize(jumped, groundMove);
    if (!wasOnGround && s.onGround && !jumped) {
      this.slopeLand();
      if (s.onGround) this.onLand(preMoveVelY);
    } else if (groundMove && !s.onGround) this.onLeaveGround();

    // Rutschen endet mit dem Boden (Sprung, Kante, Rampslide); ohne Sprung geht es nach der Landung weiter.
    if (this.slideOn && !s.onGround) {
      this.endSlide();
      this.slideCarry = !jumped;
    }

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
    // Surf-Pause der Luftlenkung: jeder Kontakt mit einer steilen Fläche startet sie neu.
    this.steepAgo = s.surfing || this.steepBelow || this.surfTouch ? 0 : this.steepAgo + this.dt;
    this.updateSurf();
    this.pushSync(this.syncSample);
    s.speed = Math.hypot(s.vel.x, s.vel.z);
    // Gestundeter Hang-Verlust verfällt, soweit das Tempo aufs Lauftempo fällt (Reibung, Wand).
    if (this.slopeDebt > 0) this.slopeDebt = Math.min(this.slopeDebt, Math.max(0, s.speed - this.maxGroundSpeed()));

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

  /** Abgeleitete Tick-Werte des Arcade-Passes (Plan 007). */
  private applyArcadeConfig(): void {
    const cfg = this.cfg;
    this.graceTicks = cfg.landGraceTime > 0 ? Math.max(0, Math.round(cfg.landGraceTime * cfg.tickRate)) : 0;
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
    const cfg = this.cfg;
    const h = cfg.hull;
    const delta = h.standHeight - h.duckHeight;
    let rate = ((h.standEye - h.duckEye) / Math.max(cfg.duckTime, 1e-3)) * this.dt;

    if (this.inCrouch) {
      // Rutsch-Eintritt (Plan 007 A7): mit Tempo am Boden sofort ducken — Hull schrumpft von oben,
      // Origin bleibt (kein Clip-Risiko). Sonst träfe man einen Duck-Tunnel mit der Stand-Hull,
      // weil die Boden-Duck-Hull erst nach duckTime kommt. Das Auge folgt in slideEyeTime.
      if (cfg.slideMinSpeed > 0 && s.onGround && (this.slideOn || hLen(s.vel.x, s.vel.z) >= cfg.slideMinSpeed)) {
        if (!this.hullDucked) {
          if (!this.duckIntent) {
            this.duckIntent = true;
            this.events.push(DUCK_DOWN);
          }
          this.setHull(true);
        }
        rate = ((h.standEye - h.duckEye) / Math.max(cfg.slideEyeTime, 1e-3)) * this.dt;
      }
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
    // Verlustfrei: jeder Bodentick davor lag in der Lande-Gnade (keine Reibung).
    const clean = perfect || (!coyote && this.graceArmed && this.frictionTicks <= this.graceTicks);
    s.hopChain = this.frictionTicks <= this.chainGraceTicks() ? s.hopChain + 1 : 1;
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
    // Ein Sprung beendet die Rutsche bewusst (auch per Coyote nach einer Kante): kein Weiterrutschen.
    this.slideCarry = false;
    this.beginAirSegment();

    const e = this.jumpPool.next();
    e.speed = speed;
    e.gain = gain;
    e.perfect = perfect;
    e.clean = clean;
    e.chain = s.hopChain;
    e.sync = this.lastAirSync;
    e.crouched = this.hullDucked || this.inCrouch;
    e.coyote = coyote;
    this.events.push(e);
  }

  // --- Rutschen (Plan 007 A7) ----------------------------------------------------

  /**
   * Zustandsmaschine, läuft am Boden vor friction(). Eintritt geduckt ab slideMinSpeed (checkDuck
   * hat die Hull schon sofort geduckt), Schub nur aus dem Lauf (Bodenzeit, Abklingzeit, Kappe) —
   * Landen + Ducken ist Verzeihen, kein Schub-Farmen. Ende unter slideExitSpeed oder aufgestanden
   * (im Tunnel ohne Platz rutscht man weiter). Kein Rutschen im Landetick mit Sprung: der Sprung
   * kommt vorher (Bhop mit Ducken bleibt bitgleich). Hat die Rutsche den Boden ohne Sprung verlassen
   * (slideCarry), geht sie im ersten Bodentick weiter wie eine laufende (ab slideExitSpeed, ohne Schub).
   * Gemeldet (state.sliding, slideStart) wird sie erst nach der Lande-Gnade (siehe slideOn).
   */
  private updateSlide(): void {
    const cfg = this.cfg;
    const s = this.s;
    const v = s.vel;
    const carry = this.slideCarry;
    this.slideCarry = false;
    if (!(cfg.slideMinSpeed > 0)) {
      if (this.slideOn) this.endSlide();
      return;
    }
    if (!this.slideOn && !this.hullDucked) return;
    const sp = hLen(v.x, v.z);
    if (this.slideOn) {
      if (!this.hullDucked || sp < cfg.slideExitSpeed) this.endSlide();
      else if (!s.sliding && !this.inLandGrace()) this.announceSlide(this.slideBoostUnsaid);
      return;
    }
    if (carry ? sp < cfg.slideExitSpeed : !this.inCrouch || sp < cfg.slideMinSpeed) return;
    this.slideOn = true;
    let boost = false;
    const cooled = (this.tickCount - this.lastBoostTick) * this.dt >= cfg.slideBoostCooldown - 1e-9;
    if (!carry && cfg.slideBoost > 0 && cooled && this.groundTicks * this.dt >= cfg.slideBoostMinGround - 1e-9 && sp < cfg.slideBoostCap) {
      const add = Math.min(cfg.slideBoost, cfg.slideBoostCap - sp);
      v.x += (v.x / sp) * add;
      v.z += (v.z / sp) * add;
      this.lastBoostTick = this.tickCount;
      boost = true;
    }
    // Mit Preset-Werten nie Schub in der Gnade (Bodenzeit ≥ slideBoostMinGround) — im Panel möglich.
    this.slideBoostUnsaid = boost;
    if (!this.inLandGrace()) this.announceSlide(boost);
  }

  /** Lande-Gnade läuft (keine Reibung in diesem Bodentick) — gleiche Bedingung wie in friction(). */
  private inLandGrace(): boolean {
    return this.graceArmed && this.frictionTicks < this.graceTicks;
  }

  private announceSlide(boost: boolean): void {
    const s = this.s;
    s.sliding = true;
    this.slideBoostUnsaid = false;
    const e = this.slideStartPool.next();
    e.speed = hLen(s.vel.x, s.vel.z);
    e.boost = boost;
    this.events.push(e);
  }

  private endSlide(): void {
    const s = this.s;
    this.slideOn = false;
    if (!s.sliding) return;
    s.sliding = false;
    const e = this.slideEndPool.next();
    e.speed = hLen(s.vel.x, s.vel.z);
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
    // Nur echte Luftphasen: Treppen-Holpern und Kanten-Abrollen bekommen keine reibungsfreie Zeit.
    this.graceArmed = this.graceTicks > 0 && this.landAirTime >= LAND_GRACE_MIN_AIR - 1e-9;
    e.jumpQueued = this.jumpWillQueue();
    this.events.push(e);
  }

  /**
   * Deterministische Hang-Landung (Abweichung, Plan 007 A4). In Source hängt es an der Tick-Phase,
   * ob der Luft-Trace die Schräge trifft (Clip: bergab Gewinn, bergauf Verlust, evtl. Rampslide)
   * oder die 2-u-Sonde sie vorher findet (kein Clip) — Lotterie. Hier zählt immer die Anflug-
   * Geschwindigkeit vor dem Boden-Clip: geklippt nach oben schneller als nonJumpVelocity →
   * Rampslide (in der Luft bleiben), sonst Landung in alter Richtung mit
   * h1 = h0 + slopeLandGain · max(0, Clip-Anteil entlang der Flugrichtung − h0).
   * Bergab gewinnt man in jeder Phase, bergauf verliert man nie, Landungen lenken nie. Der erlassene
   * Bergauf-Verlust wird gestundet (slopeDebt) und vom nächsten Bergab-Gewinn abgezogen: auf
   * gleichförmigem Gefälle ändert das nichts, auf Hügeln pumpt der Sprungimpuls kein Tempo mehr.
   * Flacher Boden bleibt bitgleich.
   */
  private slopeLand(): void {
    const k = this.cfg.slopeLandGain;
    const s = this.s;
    const n = s.groundNormal;
    if (!(k > 0) || n.y >= FLAT_NORMAL_Y) return;
    const vr = this.landRefVel;
    const d = vr.x * n.x + vr.y * n.y + vr.z * n.z;
    if (d >= 0) return;
    const px = vr.x - n.x * d;
    const py = vr.y - n.y * d;
    const pz = vr.z - n.z * d;
    if (py > this.cfg.nonJumpVelocity) {
      s.vel.set(px, py, pz);
      s.onGround = false;
      s.groundNormal.set(0, 1, 0);
      return;
    }
    const h0 = hLen(vr.x, vr.z);
    if (h0 < 1e-3) {
      // Senkrechter Fall: keine Flugrichtung, kein Gewinn — und kein Zufalls-Rutschen aus dem Clip.
      s.vel.x = vr.x;
      s.vel.z = vr.z;
      return;
    }
    const dx = vr.x / h0;
    const dz = vr.z / h0;
    const along = px * dx + pz * dz;
    let h1 = h0;
    if (along < h0) {
      // Kappung aufs Tempo über dem Lauftempo am Tick-Ende (tick), dort auch für Reibung und Wände.
      this.slopeDebt += k * (h0 - along);
    } else if (along > h0) {
      const gain = k * (along - h0);
      const pay = Math.min(gain, this.slopeDebt);
      this.slopeDebt -= pay;
      h1 = h0 + gain - pay;
    }
    s.vel.x = dx * h1;
    s.vel.z = dz * h1;
  }

  /** Höchstes Boden-Wunschtempo (Laufen oder Sprint). */
  private maxGroundSpeed(): number {
    return Math.max(this.cfg.runSpeed, this.cfg.sprintSpeed);
  }

  /**
   * Würde ein Sprung im nächsten Tick ausgelöst, wenn man jetzt am Boden
   * steht? Gleiche Bedingung wie in checkJump — beide zusammen ändern. Im
   * nächsten Tick steht groundTicks auf 1 (der Lande-Tick zählt mit).
   */
  private jumpWillQueue(): boolean {
    return this.jumpBuffered() || (this.cfg.autoHop && this.inJumpHeld && this.heldHopReady(1));
  }

  /** Kette und Sync reißen erst nach der Lande-Gnade (sonst hieße ein verlustfreier Hop "Kette weg"). */
  private chainGraceTicks(): number {
    return this.graceArmed && this.graceTicks > CHAIN_GRACE_TICKS ? this.graceTicks : CHAIN_GRACE_TICKS;
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
    return Math.max(cfg.nonJumpVelocity, (cfg.nonJumpVelocity * this.maxGroundSpeed()) / SOURCE_MAX_GROUND_SPEED);
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
    // Lande-Gnade (Abweichung, Plan 007 A3): keine Reibung in den ersten Bodenticks nach einer
    // echten Landung — ein paar ms zu spät springen kostet kein Tempo. Läuft vor frictionTicks++.
    if (this.inLandGrace()) return;
    const v = this.s.vel;
    const speed = v.length();
    if (speed < 0.1) return;
    const cfg = this.cfg;
    if (this.slideOn) {
      // Rutsch-Reibung (Plan 007 A7): proportional + konstant, ohne stopSpeed — trägt Tempo über
      // kurze Bodenstücke, endet aber sicher (unter slideExitSpeed wird es Duck-Walk).
      const next = Math.max(speed - (speed * cfg.slideFriction + cfg.slideDecel) * this.dt, 0);
      v.multiplyScalar(next / speed);
      return;
    }
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
    if (this.slideOn) {
      // Rutschen: Hangabtrieb (horizontale Komponente von g·sinθ entlang der Falllinie), Lenken
      // mit der Maus, keine Bodenbeschleunigung.
      const n = s.groundNormal;
      const g = this.cfg.gravity * this.cfg.slideSlopeGravity * this.dt;
      vel.x += g * n.x * n.y;
      vel.z += g * n.z * n.y;
      turnTowardYaw(vel, this.inYaw, this.cfg.slideSteerRate * this.dt);
      wishspeed = 0;
    }
    // Schub-Kappe der Lande-Gnade: Boden-Accelerate ist ungekappt — ohne Kappe wäre die reibungsfreie
    // Zeit Ground-Strafe (+18 % in 8 Ticks gemessen). Läuft nach frictionTicks++ (Gnade = 1…graceTicks).
    const grace = this.graceArmed && this.frictionTicks <= this.graceTicks;
    const h0 = grace ? hLen(vel.x, vel.z) : 0;
    this.accelerate(wishdir, wishspeed, this.cfg.accelerate);
    if (grace) {
      const cap = Math.max(h0, wishspeed);
      const h1 = hLen(vel.x, vel.z);
      if (h1 > cap + 1e-9) {
        vel.x *= cap / h1;
        vel.z *= cap / h1;
      }
    }
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
    this.airControl();
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
    this.airSlideMove();
  }

  /**
   * Luftlenkung mit W (Abweichung, Plan 007 A8, CPMA-artig): nur W, kein A/D, nicht an Surf-Flanken
   * und erst airControlSurfGrace nach dem letzten steilen Kontakt (sonst kippen Auffang-Designs:
   * L2-S0 1/12 tot). v_h dreht zur Blickrichtung, der Betrag bleibt — kein Gewinn, kein Strafe-
   * Ersatz (W-Lenken 32° in 0.3 s gegen 98° perfekter Strafe bei 320 u/s). Vor airAccelerate.
   */
  private airControl(): void {
    const cfg = this.cfg;
    const low = cfg.airControl;
    if (!(low > 0) || this.inSide !== 0 || !(this.inForward > 0)) return;
    const s = this.s;
    if (s.surfing || this.steepBelow || this.steepAgo < cfg.airControlSurfGrace - 1e-9) return;
    const sp = hLen(s.vel.x, s.vel.z);
    const t = clamp((sp - cfg.airControlFadeFrom) / Math.max(1, cfg.airControlFadeTo - cfg.airControlFadeFrom), 0, 1);
    turnTowardYaw(s.vel, this.inYaw, (low + (cfg.airControlHigh - low) * t) * this.dt);
  }

  /**
   * Luft-Move mit Kanten-Assist (Abweichung, Plan 007 A6). Der schlechteste Parkour-Moment ist der
   * Bonk: die Hull trifft knapp unter der Oberkante, der Clip nullt das Tempo, man kriecht auf die
   * Kante. Nur bei frontalem Anprall (≤ 45°) an eine senkrechte Wand:
   *  - Lip-Step: liegt begehbarer Boden höchstens ledgeStep über den Füßen, Q3-StepSlideMove in
   *    der Luft und Landung auf der Kante (vel.y = 0, auch knapp vor dem Scheitel — reicht der Scheitel
   *    nicht über die Kante, prallte man sonst ab). Nicht, solange der Rest-Aufstieg die Kante klar
   *    selbst überragt und das Gedächtnis an ist: sonst bliebe vom Sprung direkt vor einer Stufe nichts
   *    übrig; das Gedächtnis gibt das Tempo zurück, sobald die Hull oben frei ist.
   *  - sonst Tempo-Gedächtnis: v_h vor dem Anprall kommt innerhalb ledgeMemory zurück, sobald die
   *    Hull HÖHER frei ist (Steigen/Ducken) und auf der alten Höhe weiter blockiert wäre.
   * Kein Impuls von Wänden, höchstens ledgeStep Hub, nur auf begehbare Oberkanten: kein Walljump.
   */
  private airSlideMove(): void {
    const cfg = this.cfg;
    const lipStep = cfg.ledgeStep;
    const memory = cfg.ledgeMemory;
    if (!(lipStep > 0) && !(memory > 0)) {
      this.tryPlayerMove();
      return;
    }
    const s = this.s;
    const pos = s.pos;
    const vel = s.vel;
    const dt = this.dt;
    const mins = this.mins;
    const maxs = this.maxs;

    if (this.memTicks > 0) {
      this.memTicks--;
      const hv = hLen(vel.x, vel.z);
      const hm = hLen(this.memVel.x, this.memVel.z);
      if (hv < hm * LEDGE_RESTORE_SHARE && pos.y > this.memY + LEDGE_RESTORE_RISE) {
        this.lsEnd.set(pos.x + this.memVel.x * dt, pos.y, pos.z + this.memVel.z * dt);
        const free = this.world.traceBox(pos, this.lsEnd, mins, maxs, this.trLedge);
        if (free.fraction === 1 && !free.startSolid) {
          this.lsPos.set(pos.x, this.memY, pos.z);
          this.lsEnd.set(pos.x + this.memVel.x * dt, this.memY, pos.z + this.memVel.z * dt);
          const low = this.world.traceBox(this.lsPos, this.lsEnd, mins, maxs, this.trLedge);
          if (low.fraction < 1 || low.startSolid) {
            vel.x = this.memVel.x;
            vel.z = this.memVel.z;
            this.memTicks = 0;
            this.pushLedge('vault', 0);
          }
        }
      } else if (hv >= hm * LEDGE_RESTORE_SHARE) {
        this.memTicks = 0;
      }
    }

    const p0 = this.lsP0.copy(pos);
    const v0 = this.lsV0.copy(vel);
    this.tryPlayerMove();
    const h0 = hLen(v0.x, v0.z);
    const h1 = hLen(vel.x, vel.z);
    if (!(h0 > LEDGE_MIN_SPEED && h1 < h0 - 1)) return;

    // Senkrechte Wand in alter Richtung, frontal getroffen?
    this.lsEnd.set(p0.x + v0.x * dt, p0.y, p0.z + v0.z * dt);
    const wt = this.world.traceBox(p0, this.lsEnd, mins, maxs, this.trLedge);
    if (!(wt.fraction < 1) || wt.startSolid || Math.abs(wt.normal.y) >= LEDGE_WALL_MAX_NY) return;
    // Nur frontal: wer eine Bande längs streift und sie dann überfliegt, bekäme sonst den
    // Queranteil zurück und flöge seitlich aus der Bahn (L1-Rutsche).
    const incidence = -(v0.x * wt.normal.x + v0.z * wt.normal.z) / h0;
    if (incidence < LEDGE_MIN_INCIDENCE) return;

    if (lipStep > 0) {
      const dPos = this.lsPos.copy(pos);
      const dVel = this.lsVel.copy(vel);
      // Der Versuch darf die Hang-Landungs-Referenz nicht verstellen, falls er verworfen wird.
      const refSet = this.landRefSet;
      this.lsRef.copy(this.landRefVel);
      pos.copy(p0);
      vel.copy(v0);
      this.lsEnd.set(p0.x, p0.y + lipStep + DIST_EPSILON, p0.z);
      const up = this.world.traceBox(p0, this.lsEnd, mins, maxs, this.trLedge);
      let stepped = false;
      if (!up.startSolid && !up.allSolid) {
        pos.copy(up.endPos);
        const raised = pos.y - p0.y;
        this.tryPlayerMove();
        this.lsEnd.set(pos.x, pos.y - raised - DIST_EPSILON, pos.z);
        const dn = this.world.traceBox(pos, this.lsEnd, mins, maxs, this.trLedge);
        if (!dn.startSolid && !dn.allSolid && dn.fraction < 1 && dn.normal.y >= MIN_GROUND_NORMAL_Y) {
          const travelled = hLen(dn.endPos.x - p0.x, dn.endPos.z - p0.z);
          const travelledDown = hLen(dPos.x - p0.x, dPos.z - p0.z);
          // Steigt man noch klar über die Kante, bleibt der Sprung; das Gedächtnis gibt das Tempo oben zurück.
          const riseClears = memory > 0 && v0.y > 0 && (v0.y * v0.y) / (2 * cfg.gravity) >= dn.endPos.y - p0.y + LEDGE_RISE_CLEAR;
          if (!riseClears && travelled > travelledDown + 0.5 && dn.endPos.y > p0.y - 1e-6) {
            pos.copy(dn.endPos);
            vel.y = 0;
            stepped = true;
          }
        }
      }
      if (stepped) {
        // Landung auf der Kante: Hang-Landung nimmt dieses Tempo als Anflug (kein Nachschlag).
        this.landRefVel.copy(vel);
        this.landRefSet = true;
        this.memTicks = 0;
        this.pushLedge('step', pos.y - p0.y);
        return;
      }
      pos.copy(dPos);
      vel.copy(dVel);
      this.landRefSet = refSet;
      this.landRefVel.copy(this.lsRef);
    }
    // Ein schwächerer Folge-Anprall (Luft-Schub drückt weiter gegen die Wand, mit Cap 40 über
    // LEDGE_MIN_SPEED) überschreibt das gemerkte Tempo nicht — sonst wäre es nach einem Tick weg.
    if (memory > 0 && (this.memTicks <= 0 || h0 > hLen(this.memVel.x, this.memVel.z))) {
      this.memVel.set(v0.x, 0, v0.z);
      this.memY = p0.y;
      this.memTicks = Math.max(1, Math.round(memory / dt));
    }
  }

  private pushLedge(kind: 'step' | 'vault', dy: number): void {
    const e = this.ledgePool.next();
    e.kind = kind;
    e.speed = hLen(this.s.vel.x, this.s.vel.z);
    e.dy = dy;
    this.events.push(e);
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
    /** Alle Treffer dieses Moves waren senkrechte Wände (Wand-Tasche, siehe unten). */
    let wallsOnly = true;
    // Rampbug-Fix nur, wenn der Move an einer Surf-Fläche beginnt (Plan 007 A2).
    const seamFix = this.cfg.surfSeamFix && !s.onGround && (s.surfing || this.steepBelow) && this.lastSurfNormal.lengthSq() > 0.5;
    if (seamFix) this.seamNormal.copy(this.lastSurfNormal);

    for (let bump = 0; bump < MAX_BUMPS; bump++) {
      if (vel.x === 0 && vel.y === 0 && vel.z === 0) break;
      this.end.copy(pos).addScaledVector(vel, timeLeft);
      this.world.traceBox(pos, this.end, this.mins, this.maxs, tr);
      if (seamFix && tr.fraction < 1 && !tr.startSolid && opposesFlight(tr.normal, vel)) this.seamRetrace(pos, tr);
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
      if (Math.abs(tr.normal.y) >= LEDGE_WALL_MAX_NY) wallsOnly = false;
      // Hang-Landung: Anflug-Tempo vor dem ersten Clip an begehbarem Boden (Wand-Clips davor zählen mit).
      if (!s.onGround && !this.landRefSet && tr.normal.y >= MIN_GROUND_NORMAL_Y) {
        this.landRefVel.copy(original);
        this.landRefSet = true;
      }
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
          // Source: d = dir·vel VOR dem Kopieren. Nach copy war |v| = 1 → Luft-Hänger in
          // konkaven Ecken (Plan 007 A1, gilt in jedem Preset).
          const along = dir.dot(vel);
          vel.copy(dir).multiplyScalar(along);
        }
        // Gegen die Ursprungsrichtung → stehen bleiben (kein Zittern in Ecken).
        if (vel.dot(primal) <= 0) {
          vel.set(0, 0, 0);
          break;
        }
      }
    }

    if (allFraction === 0) {
      vel.set(0, 0, 0);
      // Kanten-Assist (Abweichung, Plan 007 A6): in einer Wand-Tasche aus fast parallelen Wänden
      // (Gehrungsfuge einer Bande, Doppelebenen-Regel greift) kommt kein Bump vom Fleck — Source nullt
      // die Geschwindigkeit, und solange W hineindrückt, schwebt man (fixcheck L4: 2 s Luft-Hänger).
      // Keine Wand bremst nach unten: nur die Abwärtskomponente behalten und fallen.
      if ((this.cfg.ledgeStep > 0 || this.cfg.ledgeMemory > 0) && !s.onGround && wallsOnly && numPlanes > 0 && primal.y < 0) {
        this.dropInPocket(primal.y);
      }
    }
  }

  /** Wand-Tasche: senkrecht mit vy fallen (ein Trace, kein Luft-Schub). */
  private dropInPocket(vy: number): void {
    const s = this.s;
    s.vel.set(0, vy, 0);
    this.end.copy(s.pos);
    this.end.y += vy * this.dt;
    const tr = this.world.traceBox(s.pos, this.end, this.mins, this.maxs, this.trLedge);
    if (tr.startSolid || tr.allSolid) {
      s.vel.set(0, 0, 0);
      return;
    }
    s.pos.copy(tr.endPos);
    if (tr.fraction < 1) s.vel.y = 0;
  }

  /**
   * Rampbug-Fix (Abweichung, Plan 007 A2, Momentum-Mod-Stil): beim Surfen trifft der Trace an
   * Gehrungsfugen eine Ebene gegen die Fahrt — Kappe/Bevel des Nachbarstücks, das die Fuge in
   * Wahrheit deckt. Derselbe Weg um 0.25/1/2 u entlang der Surf-Normale angehoben: kommt er
   * weiter und trifft keine Gegen-Ebene, gilt der angehobene Trace. Echte Stirnwände treffen
   * auch angehoben → unverändert. `this.end` ist das Ziel des aktuellen Bumps.
   */
  private seamRetrace(pos: Vector3, tr: TraceResult): void {
    for (let i = 0; i < SEAM_RETRACE.length; i++) {
      const d = SEAM_RETRACE[i];
      this.seamStart.copy(pos).addScaledVector(this.seamNormal, d);
      if (this.world.testBox(this.seamStart, this.mins, this.maxs)) continue;
      this.seamEnd.copy(this.end).addScaledVector(this.seamNormal, d);
      const r = this.world.traceBox(this.seamStart, this.seamEnd, this.mins, this.maxs, this.trSeam);
      if (r.startSolid || r.allSolid || r.fraction <= tr.fraction + 1e-4) continue;
      if (r.fraction < 1 && opposesFlight(r.normal, this.s.vel)) continue;
      tr.fraction = r.fraction;
      tr.endPos.copy(r.endPos);
      tr.normal.copy(r.normal);
      tr.brushIndex = r.brushIndex;
      return;
    }
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
