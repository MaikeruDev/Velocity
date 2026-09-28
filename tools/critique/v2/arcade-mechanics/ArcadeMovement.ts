/**
 * Prototyp (KEIN Projektcode): arcadige Zusatz-Mechaniken als Unterklasse von PlayerMovement.
 * Thema "Arcade-Movement, Linse neue Mechaniken & Verzeihung" (2026-09-28).
 *
 * - slide:   Ducken am Boden ab minSpeed → Rutschen (eigene Reibung, Hangabtrieb, Lenken zur
 *            Blickrichtung, Schub nur aus dem Lauf). Sprung aus der Rutsche = Crouch-Jump (M6).
 * - ledge:   Lip-Step (Luft-Stufe ≤ height u an SENKRECHTEN Wänden, nur auf begehbare Oberkante)
 *            und Momentum-Gedächtnis (Horizontaltempo vor dem Wand-Anprall kommt zurück, wenn
 *            die Hull die Kante innerhalb `memory` s nach OBEN überwindet — Steigen oder Ducken).
 * - air:     Luftkontrolle nur mit W (ohne A/D, nicht an Surf-Flanken): dreht die Horizontal-
 *            geschwindigkeit zur Blickrichtung, Betrag bleibt (CPMA-artig, kein Gewinn).
 * - pads:    Jump-Pads (vy setzen) und Boost-Pads (Mindesttempo entlang Richtung), Tick-genau.
 * - rings:   Speed-Ringe (Scheibe; Durchflug einmal pro Leben → +add u/s entlang der Flugrichtung).
 *
 * Zugriff auf private Felder von PlayerMovement per `any` (nur Messwerkzeug). Alle Overrides rufen
 * die Original-Methoden; `installGlobal(opts)` hängt dieselben Overrides an PlayerMovement.prototype,
 * damit unveränderte Werkzeuge (timedRun, designProbes, SurfRider) mit der Mechanik laufen.
 */
import { Box3, Vector3 } from 'three';
import type { MovementConfig } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import type { CollisionWorld, TraceResult } from '../../../../src/world/collision/types';
import { DIST_EPSILON, MIN_GROUND_NORMAL_Y, makeTraceResult } from '../../../../src/world/collision/types';

export interface SlideOpts {
  /** Eintritt ab diesem Horizontal-Tempo (u/s). */
  readonly minSpeed: number;
  /** Darunter endet die Rutsche (weiter geduckt = Duck-Walk). */
  readonly exitSpeed: number;
  /** Reibungskoeffizient in der Rutsche (1/s, proportional), statt cfg.friction. */
  readonly friction: number;
  /** Zusätzliche konstante Verzögerung (u/s²). */
  readonly decel: number;
  /** Schub beim Eintritt aus dem LAUF (u/s). */
  readonly boost: number;
  /** Schub hebt höchstens bis zu diesem Tempo. */
  readonly boostCap: number;
  /** So lange (s) muss man vor dem Eintritt am Boden sein (Landung → Rutsche: kein Schub). */
  readonly boostMinGround: number;
  /** Abstand zwischen zwei Schüben (s). */
  readonly boostCooldown: number;
  /** Lenken: Drehrate der Geschwindigkeit zur Blickrichtung (rad/s). */
  readonly steerRate: number;
  /** Hangabtrieb auf begehbaren Schrägen (g · n.xz · n.y). */
  readonly slopeGravity: boolean;
  /** Kamera: Zeit bis duckEye in der Rutsche (s). */
  readonly eyeTime: number;
}

export interface LedgeOpts {
  /** Lip-Step: höchstens so weit über den Füßen darf die Oberkante liegen (u). 0 = aus. */
  readonly height: number;
  /** Lip-Step auch steigend (vy > 0)? Default false: steigend übernimmt das Gedächtnis (kein erzwungenes Landen). */
  readonly stepRising?: boolean;
  /** Momentum-Gedächtnis (s). 0 = aus. */
  readonly memory: number;
}

export interface AirControlOpts {
  /** Drehrate (rad/s) bei Tempo ≤ fadeFrom. */
  readonly rate: number;
  /** Ab hier fällt die Rate linear auf rateHigh (bei fadeTo). */
  readonly fadeFrom: number;
  readonly fadeTo: number;
  readonly rateHigh: number;
  /** So lange (s) nach dem letzten Kontakt mit einer steilen Fläche keine Luftkontrolle (Surf bleibt Surf). */
  readonly surfGrace?: number;
}

export interface PadDef {
  readonly kind: 'jump' | 'boost';
  readonly bounds: Box3;
  /** jump: gesetzte Vertikalgeschwindigkeit (u/s). */
  readonly vy?: number;
  /** boost: Richtung (horizontal, normiert). */
  readonly dir?: Vector3;
  /** boost: Mindesttempo entlang dir (floor) bzw. Zuschlag (add). */
  readonly speed?: number;
  readonly mode?: 'floor' | 'add';
}

export interface RingDef {
  readonly center: Vector3;
  /** Normale der Ringebene (horizontal). */
  readonly normal: Vector3;
  readonly radius: number;
  readonly add: number;
  /** Zuschlag nur bis zu diesem Tempo. */
  readonly cap: number;
}

export interface ArcadeOpts {
  readonly slide?: SlideOpts;
  readonly ledge?: LedgeOpts;
  readonly air?: AirControlOpts;
  readonly pads?: readonly PadDef[];
  readonly rings?: readonly RingDef[];
}

export interface ArcadeStats {
  slides: number;
  slideTicks: number;
  boosts: number;
  lipSteps: number;
  restores: number;
  airCtlTicks: number;
  airCtlRad: number;
  padHits: number;
  ringHits: number;
  /** Letztes Ereignis dieses Ticks (für Tests/Logs). */
  last: string;
}

export const SLIDE_DEFAULT: SlideOpts = {
  minSpeed: 280,
  exitSpeed: 160,
  friction: 0.3,
  decel: 80,
  boost: 50,
  boostCap: 380,
  boostMinGround: 0.25,
  boostCooldown: 2.0,
  steerRate: 1.4,
  slopeGravity: true,
  eyeTime: 0.06,
};

export const LEDGE_DEFAULT: LedgeOpts = { height: 5, memory: 0.2, stepRising: true };
/** cos 45°: Lip-Step/Gedächtnis nur bei frontalen Anprallern. */
const LEDGE_MIN_INCIDENCE = Math.SQRT1_2;

export const AIR_DEFAULT: AirControlOpts = { rate: 1.6, fadeFrom: 350, fadeTo: 700, rateHigh: 0.8, surfGrace: 0.5 };

interface ArcState {
  opts: ArcadeOpts;
  stats: ArcadeStats;
  sliding: boolean;
  lastBoostTick: number;
  airPhase: boolean;
  steepAgo: number;
  memTicks: number;
  memY: number;
  readonly mem: Vector3;
  readonly p0: Vector3;
  readonly v0: Vector3;
  readonly dPos: Vector3;
  readonly dVel: Vector3;
  readonly end: Vector3;
  readonly tmp: Vector3;
  readonly tr: TraceResult;
  readonly prevPos: Vector3;
  padCooldown: number;
  readonly ringsUsed: Set<number>;
}

export function newStats(): ArcadeStats {
  return { slides: 0, slideTicks: 0, boosts: 0, lipSteps: 0, restores: 0, airCtlTicks: 0, airCtlRad: 0, padHits: 0, ringHits: 0, last: '' };
}

function makeState(opts: ArcadeOpts): ArcState {
  return {
    opts,
    stats: newStats(),
    sliding: false,
    lastBoostTick: -1e9,
    airPhase: false,
    steepAgo: 1e9,
    memTicks: 0,
    memY: 0,
    mem: new Vector3(),
    p0: new Vector3(),
    v0: new Vector3(),
    dPos: new Vector3(),
    dVel: new Vector3(),
    end: new Vector3(),
    tmp: new Vector3(),
    tr: makeTraceResult(),
    prevPos: new Vector3(),
    padCooldown: 0,
    ringsUsed: new Set<number>(),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type PM = any;
const B: any = PlayerMovement.prototype;
const base = {
  checkDuck: B.checkDuck as (this: PM) => void,
  friction: B.friction as (this: PM) => void,
  walkMove: B.walkMove as (this: PM, w: Vector3, ws: number) => void,
  airMove: B.airMove as (this: PM, w: Vector3, ws: number) => void,
  tryPlayerMove: B.tryPlayerMove as (this: PM) => void,
  tick: B.tick as (this: PM, input: unknown) => unknown[],
  teleport: B.teleport as (this: PM, pos: Vector3, opts?: { keepVelocity?: boolean }) => void,
};

let GLOBAL_OPTS: ArcadeOpts | null = null;

function arcOf(pm: PM): ArcState {
  if (!pm.__arc) pm.__arc = makeState(GLOBAL_OPTS ?? {});
  return pm.__arc as ArcState;
}

/** Horizontalgeschwindigkeit um höchstens maxRad zur Richtung (fx, fz) drehen, Betrag bleibt. */
function rotateToward(v: Vector3, fx: number, fz: number, maxRad: number): number {
  const sp = Math.hypot(v.x, v.z);
  if (sp < 1e-3 || maxRad <= 0) return 0;
  const cur = Math.atan2(v.x, v.z);
  const tgt = Math.atan2(fx, fz);
  let d = tgt - cur;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const step = Math.max(-maxRad, Math.min(maxRad, d));
  const a = cur + step;
  v.x = Math.sin(a) * sp;
  v.z = Math.cos(a) * sp;
  return Math.abs(step);
}

function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(target, v + step);
  if (v > target) return Math.max(target, v - step);
  return v;
}

const DUCK_DOWN_EV = Object.freeze({ type: 'duck', down: true });

const overrides = {
  checkDuck(this: PM): void {
    const a = arcOf(this);
    const sl = a.opts.slide;
    const s = this.s;
    if (sl && this.inCrouch && s.onGround && !this.hullDucked && Math.hypot(s.vel.x, s.vel.z) >= sl.minSpeed) {
      // Rutsch-Eintritt: Hull sofort geduckt (schrumpft von oben, Origin bleibt) — sonst träfe
      // man einen Duck-Tunnel mit Stand-Hull, weil die Boden-Duck-Hull erst nach duckTime kommt.
      if (!this.duckIntent) {
        this.duckIntent = true;
        this.events.push(DUCK_DOWN_EV);
      }
      this.setHull(true);
    }
    base.checkDuck.call(this);
    if (sl && this.hullDucked && s.onGround && this.inCrouch && (a.sliding || Math.hypot(s.vel.x, s.vel.z) >= sl.minSpeed)) {
      const h = this.cfg.hull;
      s.eyeHeight = approach(s.eyeHeight, h.duckEye, ((h.standEye - h.duckEye) / Math.max(1e-3, sl.eyeTime)) * this.dt);
    }
  },

  friction(this: PM): void {
    const a = arcOf(this);
    const sl = a.opts.slide;
    if (!sl) {
      base.friction.call(this);
      return;
    }
    const v: Vector3 = this.s.vel;
    const sp = Math.hypot(v.x, v.z);
    if (a.sliding) {
      if (!this.inCrouch || !this.hullDucked || sp < sl.exitSpeed) a.sliding = false;
    } else if (this.inCrouch && this.hullDucked && sp >= sl.minSpeed) {
      a.sliding = true;
      a.stats.slides++;
      a.stats.last = 'slide';
      const groundT = this.groundTicks * this.dt;
      if (sl.boost > 0 && groundT >= sl.boostMinGround - 1e-9 && (this.tickCount - a.lastBoostTick) * this.dt >= sl.boostCooldown && sp < sl.boostCap) {
        const add = Math.min(sl.boost, sl.boostCap - sp);
        v.x += (v.x / sp) * add;
        v.z += (v.z / sp) * add;
        a.lastBoostTick = this.tickCount;
        a.stats.boosts++;
        a.stats.last = 'slideBoost';
      }
    }
    if (!a.sliding) {
      base.friction.call(this);
      return;
    }
    const speed = v.length();
    if (speed < 0.1) return;
    const drop = (speed * sl.friction + sl.decel) * this.dt;
    const ns = Math.max(speed - drop, 0);
    v.multiplyScalar(ns / speed);
    a.stats.slideTicks++;
  },

  walkMove(this: PM, wishdir: Vector3, wishspeed: number): void {
    const a = arcOf(this);
    const sl = a.opts.slide;
    if (!sl || !a.sliding) {
      base.walkMove.call(this, wishdir, wishspeed);
      return;
    }
    const s = this.s;
    const v: Vector3 = s.vel;
    if (sl.slopeGravity) {
      const n: Vector3 = s.groundNormal;
      const g = this.cfg.gravity;
      v.x += g * n.x * n.y * this.dt;
      v.z += g * n.z * n.y * this.dt;
    }
    // Lenken mit der Maus: forward = (-sin yaw, -cos yaw).
    rotateToward(v, -Math.sin(this.inYaw), -Math.cos(this.inYaw), sl.steerRate * this.dt);
    base.walkMove.call(this, wishdir, 0);
  },

  airMove(this: PM, wishdir: Vector3, wishspeed: number): void {
    const a = arcOf(this);
    const ac = a.opts.air;
    const s = this.s;
    // Nur wenn der Blick höchstens 90° neben der Flugrichtung liegt (CPMA: dot > 0) — W mit Blick
    // nach hinten ist Bremsen (AirAccelerate), keine Kurve.
    const fwdDot = -Math.sin(this.inYaw) * s.vel.x - Math.cos(this.inYaw) * s.vel.z;
    if (s.surfing || this.steepBelow) a.steepAgo = 0;

    if (ac && this.inSide === 0 && this.inForward > 0 && !s.surfing && !this.steepBelow && fwdDot > 0 && a.steepAgo >= (ac.surfGrace ?? 0)) {
      const sp = Math.hypot(s.vel.x, s.vel.z);
      const t = Math.max(0, Math.min(1, (sp - ac.fadeFrom) / Math.max(1, ac.fadeTo - ac.fadeFrom)));
      const rate = ac.rate + (ac.rateHigh - ac.rate) * t;
      const turned = rotateToward(s.vel, -Math.sin(this.inYaw), -Math.cos(this.inYaw), rate * this.dt);
      if (turned > 1e-6) {
        a.stats.airCtlTicks++;
        a.stats.airCtlRad += turned;
      }
    }
    a.airPhase = a.opts.ledge !== undefined;
    try {
      base.airMove.call(this, wishdir, wishspeed);
    } finally {
      a.airPhase = false;
    }
  },

  tryPlayerMove(this: PM): void {
    const a = arcOf(this);
    const lg = a.opts.ledge;
    if (!a.airPhase || !lg) {
      base.tryPlayerMove.call(this);
      return;
    }
    a.airPhase = false;
    const s = this.s;
    const pos: Vector3 = s.pos;
    const vel: Vector3 = s.vel;
    const world: CollisionWorld = this.world;
    const dt: number = this.dt;

    // Momentum-Gedächtnis: nach einem Wand-Anprall die alte Horizontalgeschwindigkeit zurück,
    // sobald die Hull in alter Richtung frei ist — aber nur, weil sie jetzt HÖHER ist (auf alter
    // Höhe wäre sie weiter blockiert). Seitliches Abgleiten an Säulen bekommt nichts zurück.
    if (a.memTicks > 0) {
      a.memTicks--;
      const hv = Math.hypot(vel.x, vel.z);
      const hm = Math.hypot(a.mem.x, a.mem.z);
      if (hv < hm * 0.9 && pos.y > a.memY + 0.5) {
        a.end.set(pos.x + a.mem.x * dt, pos.y, pos.z + a.mem.z * dt);
        const free = world.traceBox(pos, a.end, this.mins, this.maxs, a.tr);
        if (free.fraction === 1 && !free.startSolid) {
          a.tmp.set(pos.x, a.memY, pos.z);
          a.end.set(pos.x + a.mem.x * dt, a.memY, pos.z + a.mem.z * dt);
          const low = world.traceBox(a.tmp, a.end, this.mins, this.maxs, a.tr);
          if (low.fraction < 1 || low.startSolid) {
            vel.x = a.mem.x;
            vel.z = a.mem.z;
            a.memTicks = 0;
            a.stats.restores++;
            a.stats.last = 'restore';
          }
        }
      } else if (hv >= hm * 0.9) a.memTicks = 0;
    }

    const p0 = a.p0.copy(pos);
    const v0 = a.v0.copy(vel);
    base.tryPlayerMove.call(this);
    const h0 = Math.hypot(v0.x, v0.z);
    const h1 = Math.hypot(vel.x, vel.z);
    if (!(h0 > 50 && h1 < h0 - 1)) return;

    // War es eine senkrechte Wand? Eigener Trace in alter Richtung.
    a.end.set(p0.x + v0.x * dt, p0.y, p0.z + v0.z * dt);
    const wt = world.traceBox(p0, a.end, this.mins, this.maxs, a.tr);
    const wall = wt.fraction < 1 && !wt.startSolid && Math.abs(wt.normal.y) < 0.1;
    if (!wall) return;
    // Nur frontale Anpraller (≤ 45° zur Wandnormalen): wer eine Bande längs streift und sie dann
    // überfliegt, bekäme sonst den Queranteil zurück und flöge seitlich aus der Bahn (L1-Rutsche).
    const incidence = -(v0.x * wt.normal.x + v0.z * wt.normal.z) / h0;
    if (incidence < LEDGE_MIN_INCIDENCE) return;

    let stepped = false;
    if (lg.height > 0 && (v0.y <= 0 || lg.stepRising === true)) {
      const dPos = a.dPos.copy(pos);
      const dVel = a.dVel.copy(vel);
      pos.copy(p0);
      vel.copy(v0);
      a.end.set(p0.x, p0.y + lg.height + DIST_EPSILON, p0.z);
      const up = world.traceBox(p0, a.end, this.mins, this.maxs, a.tr);
      if (!up.startSolid && !up.allSolid) {
        pos.copy(up.endPos);
        const raised = pos.y - p0.y;
        base.tryPlayerMove.call(this);
        a.end.set(pos.x, pos.y - raised - DIST_EPSILON, pos.z);
        const dn = world.traceBox(pos, a.end, this.mins, this.maxs, a.tr);
        if (!dn.startSolid && !dn.allSolid && dn.fraction < 1 && dn.normal.y >= MIN_GROUND_NORMAL_Y) {
          const travelled = Math.hypot(dn.endPos.x - p0.x, dn.endPos.z - p0.z);
          const travelledDown = Math.hypot(dPos.x - p0.x, dPos.z - p0.z);
          if (travelled > travelledDown + 0.5 && dn.endPos.y > p0.y - 1e-6) {
            pos.copy(dn.endPos);
            // Lip-Step = Landung auf der Oberkante (auch steigend): sonst trüge der Rest-Aufstieg
            // mit vollem Tempo über schmale Kanten hinaus (L1-Ledge 256 u tief, 900 u/s → Tod dahinter).
            vel.y = 0;
            stepped = true;
            a.stats.lipSteps++;
            a.stats.last = 'lipStep';
          }
        }
      }
      if (!stepped) {
        pos.copy(dPos);
        vel.copy(dVel);
      }
    }
    if (!stepped && lg.memory > 0) {
      a.mem.set(v0.x, 0, v0.z);
      a.memY = p0.y;
      a.memTicks = Math.max(1, Math.round(lg.memory / dt));
    }
  },

  tick(this: PM, input: unknown): unknown[] {
    const a = arcOf(this);
    a.stats.last = '';
    a.prevPos.copy(this.s.pos);
    const ev = base.tick.call(this, input);
    const s = this.s;
    if (!s.onGround) a.sliding = false;
    if (!s.surfing && !this.steepBelow) a.steepAgo += this.dt;
    if (a.padCooldown > 0) a.padCooldown--;
    const pads = a.opts.pads;
    if (pads && a.padCooldown === 0) {
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        const lo = a.tmp.copy(s.pos).add(this.mins);
        const b = p.bounds;
        const hi = a.end.copy(s.pos).add(this.maxs);
        if (!(lo.x < b.max.x && hi.x > b.min.x && lo.y < b.max.y && hi.y > b.min.y && lo.z < b.max.z && hi.z > b.min.z)) continue;
        if (p.kind === 'jump') {
          s.vel.y = p.vy ?? 600;
          s.onGround = false;
          s.groundNormal.set(0, 1, 0);
          this.coyoteOk = false;
          this.frictionTicks = 1 << 30;
          this.airStrafeTicks = 0;
          this.airGainTicks = 0;
        } else {
          const d = p.dir ?? new Vector3(0, 0, -1);
          const along = s.vel.x * d.x + s.vel.z * d.z;
          const target = p.speed ?? 600;
          const add = p.mode === 'add' ? target : Math.max(0, target - along);
          s.vel.x += d.x * add;
          s.vel.z += d.z * add;
        }
        a.stats.padHits++;
        a.stats.last = `pad:${p.kind}`;
        a.padCooldown = Math.round(0.25 / this.dt);
        s.speed = Math.hypot(s.vel.x, s.vel.z);
        break;
      }
    }
    const rings = a.opts.rings;
    if (rings) {
      for (let i = 0; i < rings.length; i++) {
        if (a.ringsUsed.has(i)) continue;
        const r = rings[i];
        const n = r.normal;
        // Mitte der Hull (Füße + 36) kreuzt die Ringebene innerhalb des Radius.
        const d0 = (a.prevPos.x - r.center.x) * n.x + (a.prevPos.y + 36 - r.center.y) * n.y + (a.prevPos.z - r.center.z) * n.z;
        const d1 = (s.pos.x - r.center.x) * n.x + (s.pos.y + 36 - r.center.y) * n.y + (s.pos.z - r.center.z) * n.z;
        if (d0 * d1 > 0 || d0 === d1) continue;
        const t = d0 / (d0 - d1);
        const cx = a.prevPos.x + (s.pos.x - a.prevPos.x) * t - r.center.x;
        const cy = a.prevPos.y + 36 + (s.pos.y - a.prevPos.y) * t - r.center.y;
        const cz = a.prevPos.z + (s.pos.z - a.prevPos.z) * t - r.center.z;
        if (cx * cx + cy * cy + cz * cz > r.radius * r.radius) continue;
        const sp = Math.hypot(s.vel.x, s.vel.z);
        const add = Math.max(0, Math.min(r.add, r.cap - sp));
        if (sp > 1 && add > 0) {
          s.vel.x += (s.vel.x / sp) * add;
          s.vel.z += (s.vel.z / sp) * add;
        }
        a.ringsUsed.add(i);
        a.stats.ringHits++;
        a.stats.last = 'ring';
        s.speed = Math.hypot(s.vel.x, s.vel.z);
      }
    }
    return ev;
  },

  teleport(this: PM, pos: Vector3, opts?: { keepVelocity?: boolean }): void {
    const a = arcOf(this);
    a.sliding = false;
    a.memTicks = 0;
    a.padCooldown = 0;
    a.ringsUsed.clear();
    base.teleport.call(this, pos, opts);
  },
};

export class ArcadeMovement extends PlayerMovement {
  constructor(world: CollisionWorld, config: MovementConfig, opts: ArcadeOpts) {
    super(world, config);
    (this as PM).__arc = makeState(opts);
  }

  get arcade(): ArcadeStats {
    return arcOf(this).stats;
  }

  /** Rutscht gerade (für Tests/Logs). */
  get sliding(): boolean {
    return arcOf(this).sliding;
  }
}
Object.assign(ArcadeMovement.prototype as PM, overrides);

/** Statistik einer beliebigen PlayerMovement-Instanz (auch global gepatcht). */
export function arcadeStats(pm: PlayerMovement): ArcadeStats {
  return arcOf(pm).stats;
}

/**
 * Hängt die Overrides an PlayerMovement.prototype (für unveränderte Werkzeuge wie timedRun).
 * Rückgabe: Funktion zum Zurücksetzen.
 */
export function installGlobal(opts: ArcadeOpts): () => void {
  GLOBAL_OPTS = opts;
  const saved: Record<string, unknown> = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = B[k];
    B[k] = (overrides as Record<string, unknown>)[k];
  }
  return () => {
    for (const k of Object.keys(saved)) B[k] = saved[k];
    GLOBAL_OPTS = null;
  };
}

export type ArcadeCtor = new (world: CollisionWorld, config: MovementConfig) => PlayerMovement;

/** Konstruktor mit festen Optionen (für Werkzeuge, die `new K(world, cfg)` erwarten). */
export function arcadeClass(opts: ArcadeOpts): ArcadeCtor {
  return class extends ArcadeMovement {
    constructor(world: CollisionWorld, config: MovementConfig) {
      super(world, config, opts);
    }
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
