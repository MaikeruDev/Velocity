import { Vector3 } from 'three';
import type { CollisionWorld, TraceResult } from '../../world/collision/types';
import { MIN_GROUND_NORMAL_Y, makeTraceResult } from '../../world/collision/types';
import type { CompiledLevel } from '../../world/level/compileLevel';
import type { RouteNode } from '../../world/level/LevelFormat';
import { airSpeedCapAt, type MovementConfig } from '../MovementConfig';
import { PlayerMovement } from '../PlayerMovement';
import type { MutablePlayerInput, PlayerInput, PlayerSnapshot } from '../types';
import type { Bot } from './Bot';
import { makeBotInput, yawOf } from './Bot';
import { StrafeController } from './StrafeController';

/** Erreich-Radius für jump/crouch-Knoten (u) — Absprungpunkte eng nehmen; sonst zählt das Passieren. */
const TAKEOFF_RADIUS = 12;
/** Knoten gilt nur als erreicht, wenn die Füße höchstens so weit darunter sind (u) — ehrlicher Fortschritt. */
const REACH_BELOW = 32;
/** So weit unter einem überflogenen Knoten (u) führt kein Sprung zurück (Crouch-Jump ~75). */
const DROP_PAST = 96;
/** Surfend passierte Surf-Knoten zählen bis zu diesem Seitversatz (u) — eine halbe Rampenbreite. */
const SURF_PASS_LATERAL = 400;
/** Landevorhersage: Zeitschritt und Horizont (s). */
const PREDICT_STEP = 1 / 64;
const PREDICT_HORIZON = 1.6;
/** Beim Laufen nur alle n Ticks neu vorhersagen (Traces sparen). */
const PREDICT_EVERY = 4;
/** Landung darf höchstens so weit unter Start- und Zielhöhe liegen (u). */
const PREDICT_MAX_DROP = 64;
/** Boden-Sonde: dünne Box, so weit unter den Füßen muss Boden sein (u). */
const PROBE_DEPTH = 24;
/** Kantensprung: so weit voraus wird geprüft, ob der Boden endet (u). */
const EDGE_LOOKAHEAD = 20;

/**
 * Surf-Regler: gewünschte Steig-/Sinkrate (u/s senkrecht) = SURF_GAIN · Höhenfehler
 * zur Knotenlinie, gekappt auf ±SURF_MAX_VY. Liegt die Falllinien-Speed darunter
 * (rutscht zu schnell ab) → voll in die Rampe drücken; im Band → Gewinn-Strafe;
 * darüber → gleiten.
 */
const SURF_GAIN = 4;
const SURF_MAX_VY = 250;
const SURF_BAND = 40;
/** Ziel etwas über der Knotenlinie: unten ist die Flanke zu Ende, oben ist Reserve. */
const SURF_LINE_LIFT = 24;

/** Luftbremse: diese Speed-Faktoren werden probiert, wenn die aktuelle Bahn nicht sicher landet. */
const BRAKE_FACTORS = [0.92, 0.84, 0.76, 0.68, 0.6, 0.5];
/** Absprungknoten näher als dieser Anteil der Flugweite liegt auf "meiner" Plattform → darf übersprungen werden. */
const SKIP_FRACTION = 0.5;

type Landing = 'ground' | 'blocked' | 'fall';

export interface RouteFollowerOptions {
  /** 1 = perfekter Strafer (fensterrelatives Fehlermodell, siehe StrafeController). */
  readonly sync?: number;
  /** Menschenmodell: absoluter Zielfehler der Hand beim Strafen (Grad, 1σ). Default 0. */
  readonly aimNoiseDeg?: number;
  readonly seed?: number;
  /** Knoten gilt als erreicht, wenn horizontal so nah (u). Default 48. */
  readonly reachRadius?: number;
  /** Unter dieser Fußhöhe gilt der Lauf als gescheitert. Default: kein Limit. */
  readonly killY?: number;
  /** Gesamtzeit-Limit in s. Default 180. */
  readonly timeout?: number;
  /** So lange ohne neuen Knoten → gescheitert (s). Default 20. */
  readonly stallTimeout?: number;
  /** Am Boden sprinten. Default true. */
  readonly sprint?: boolean;
  /** Blick-Drehrate in Grad/s (menschlich ~ 200–400). Default unbegrenzt. */
  readonly maxTurnRate?: number;
  /** Hysterese beim Kurshalten in Grad. Default 8. */
  readonly band?: number;
  /** Startposition (für das "Passieren" des ersten Knotens). Default: Position im ersten next(). */
  readonly start?: { readonly x: number; readonly z: number };
  /**
   * Kollisionswelt für die Landevorhersage ("lande ich, wenn ich jetzt springe?").
   * Ohne Welt hüpft der Bot nur an jump-Knoten und bei Landungen, wenn der
   * Sprung ballistisch den Knoten nach dem Absprungpunkt erreicht.
   */
  readonly world?: CollisionWorld;
  /** Lenk-Vorrang der Menschenmodelle (StrafeControllerOptions.steerPriority). Default true. */
  readonly steerPriority?: boolean;
}

export type RouteStatus = 'running' | 'finished' | 'failed';
export type RouteFailReason = 'fell' | 'kill' | 'timeout' | 'stall';

export interface RouteNodeResult {
  readonly index: number;
  /** Sekunden seit Start. */
  readonly time: number;
  /** Horizontal-Speed beim Erreichen. */
  readonly speed: number;
  readonly minSpeed: number | null;
  readonly belowMinSpeed: boolean;
  readonly note: string | null;
}

export interface RouteReport {
  readonly status: RouteStatus;
  readonly reason: RouteFailReason | null;
  readonly time: number;
  /** Anzahl erreichter Knoten (= Index des nächsten). */
  readonly reached: number;
  readonly total: number;
  readonly nodes: readonly RouteNodeResult[];
  readonly maxSpeed: number;
  readonly jumps: number;
  /** Position beim Ende (Erfolg oder Scheitern). */
  readonly endPos: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * Fährt eine Level-Route (RouteNode[]) ab — so, wie ein guter Spieler sie
 * fahren würde, mit der Konvention des Level-Strangs
 * ("jump: an diesem Knoten abspringen, Flug bis zum nächsten Knoten").
 *
 * - Erreicht = horizontal innerhalb reachRadius (jump/crouch: 12 u) ODER in
 *   Anflugrichtung passiert (seitlich nicht zu weit daneben) — am Boden wie
 *   in der Luft.
 * - `jump`/`crouch`-Knoten am Boden erreicht → dort abspringen (crouch: in der
 *   Luft ducken bis zur Landung). In der Luft überflogen → kein Pflichtsprung.
 * - In der Luft: landet die aktuelle Bahn nicht sicher, eine gebremste aber
 *   schon → mit S bremsen (in Source sehr wirksam). Sonst weiter strafen.
 * - Bei jeder Landung (und beim Laufen zu Nicht-Absprungknoten) prüft er per
 *   Landevorhersage, ob ein Sprung jetzt sicher auf Boden Richtung Ziel endet —
 *   dann hüpft er weiter (Bhop-Reihen, Ringe, Korridore). Sonst läuft er
 *   (Sprint) zum Knoten.
 * - In der Luft: optimal strafen Richtung Knoten, vor starken Knicks schon
 *   Richtung Folgeknoten eindrehen (Rennlinie).
 * - Surf: sagt die Bahn eine Flanke voraus, schon im Fall in die Rampe
 *   drücken; auf der Flanke die Falllinien-Speed gegen den Höhenfehler zur
 *   Knotenlinie regeln (drücken / Gewinn-Strafe / gleiten).
 * - Fortschritt ist ehrlich: Knoten weit unter den Füßen (> 32 u) zählen nie.
 */
export class RouteFollower implements Bot {
  private readonly route: readonly RouteNode[];
  private readonly ctl: StrafeController;
  private readonly out = makeBotInput();
  private readonly reachRadius: number;
  private readonly killY: number;
  private readonly timeout: number;
  private readonly stallTimeout: number;
  private readonly world: CollisionWorld | null;
  private cfg: MovementConfig;

  private idx = 0;
  /** Absprungknoten am Boden erreicht → in diesem/nächsten Bodentick springen. */
  private pendingJump = false;
  private crouching = false;
  private ticks = 0;
  private lastProgressTick = 0;
  private prevX = Number.NaN;
  private prevZ = Number.NaN;
  private prevY = Number.NaN;
  private wasOnGround = true;
  /** Fußhöhe beim letzten Bodenkontakt — Maßstab für "zu tief gelandet". */
  private lastGroundY = Number.NaN;
  private jumps = 0;
  private maxSpeed = 0;
  private _status: RouteStatus = 'running';
  private reason: RouteFailReason | null = null;
  private readonly results: RouteNodeResult[] = [];
  private readonly endPos = { x: 0, y: 0, z: 0 };

  // Scratch für die Landevorhersage
  private readonly pA = new Vector3();
  private readonly pB = new Vector3();
  private readonly mins = new Vector3();
  private readonly maxs = new Vector3();
  private readonly tr: TraceResult = makeTraceResult();
  private readonly probeMins = new Vector3(-4, 0, -4);
  private readonly probeMaxs = new Vector3(4, 4, 4);
  private readonly landing = new Vector3();
  /** Normale der Fläche, an der die letzte Vorhersage endete. */
  private readonly landingNormal = new Vector3();
  /** Letzte positive Sprung-Vorhersage brauchte einen Crouch-Jump. */
  private predictedCrouch = false;
  private surfAheadTick = Number.NEGATIVE_INFINITY;
  private surfAheadHit = false;
  private readonly surfAheadNormal = new Vector3();
  /** Vorhergesagter Aufprallpunkt auf der Surf-Flanke (gültig, wenn surfAheadHit). */
  private readonly surfAheadPoint = new Vector3();

  constructor(route: readonly RouteNode[], config: MovementConfig, opts: RouteFollowerOptions = {}) {
    this.route = route;
    this.cfg = config;
    this.ctl = new StrafeController(config, {
      sync: opts.sync,
      aimNoiseDeg: opts.aimNoiseDeg,
      seed: opts.seed,
      band: opts.band ?? 8,
      maxTurnRate: opts.maxTurnRate,
      sprint: opts.sprint ?? true,
      steerPriority: opts.steerPriority ?? true,
    });
    this.reachRadius = opts.reachRadius ?? 48;
    this.killY = opts.killY ?? Number.NEGATIVE_INFINITY;
    this.timeout = opts.timeout ?? 180;
    this.stallTimeout = opts.stallTimeout ?? 20;
    this.world = opts.world ?? null;
    if (opts.start) {
      this.prevX = opts.start.x;
      this.prevZ = opts.start.z;
    }
    if (route.length === 0) this._status = 'finished';
  }

  setConfig(config: MovementConfig): void {
    this.cfg = config;
    this.ctl.setConfig(config);
  }

  get status(): RouteStatus {
    return this._status;
  }

  /** Index des Knotens, der gerade angesteuert wird. */
  get nextIndex(): number {
    return this.idx;
  }

  get time(): number {
    return this.ticks / this.cfg.tickRate;
  }

  get report(): RouteReport {
    return {
      status: this._status,
      reason: this.reason,
      time: this.time,
      reached: this.idx,
      total: this.route.length,
      nodes: this.results.slice(),
      maxSpeed: this.maxSpeed,
      jumps: this.jumps,
      endPos: { ...this.endPos },
    };
  }

  /** Von außen scheitern lassen (z. B. Kill-Trigger). */
  fail(reason: RouteFailReason, state: PlayerSnapshot): void {
    if (this._status !== 'running') return;
    this._status = 'failed';
    this.reason = reason;
    this.endPos.x = state.pos.x;
    this.endPos.y = state.pos.y;
    this.endPos.z = state.pos.z;
  }

  /**
   * surfNormal: Normale der Surf-Fläche (PlayerMovement.surfNormal). Ohne sie
   * strafet der Bot auch an Rampen nur Richtung Knoten und rutscht eher ab.
   */
  next(state: PlayerSnapshot, surfNormal?: Vector3): PlayerInput {
    const out = this.out;
    if (Number.isNaN(this.prevY)) {
      if (Number.isNaN(this.prevX)) {
        this.prevX = state.pos.x;
        this.prevZ = state.pos.z;
      }
      this.prevY = state.pos.y;
      this.ctl.yaw = this.route.length > 0 ? yawOf(this.route[0].pos[0] - state.pos.x, this.route[0].pos[2] - state.pos.z) : 0;
    }
    if (this._status !== 'running') return this.idle(out);

    this.ticks++;
    if (state.speed > this.maxSpeed) this.maxSpeed = state.speed;
    const justLanded = state.onGround && !this.wasOnGround;
    if (state.onGround || Number.isNaN(this.lastGroundY)) this.lastGroundY = state.pos.y;
    if (!state.onGround && this.wasOnGround && state.vel.y > 0) this.jumps++;
    this.wasOnGround = state.onGround;

    this.advance(state);
    if (this._status !== 'running') return this.idle(out);

    if (state.pos.y < this.killY) {
      this.fail('fell', state);
      return this.idle(out);
    }
    if (this.time > this.timeout) {
      this.fail('timeout', state);
      return this.idle(out);
    }
    if ((this.ticks - this.lastProgressTick) / this.cfg.tickRate > this.stallTimeout) {
      this.fail('stall', state);
      return this.idle(out);
    }

    let node = this.route[this.idx];
    const takeoffAhead = node.jump === true || node.crouch === true;

    let willJump = false;
    if (state.onGround) {
      if (this.pendingJump) {
        willJump = true;
      } else if (justLanded || (!takeoffAhead && this.ticks % PREDICT_EVERY === 0)) {
        // Weiterhüpfen, wenn der Sprung sicher landet (Bhop-Reihe, Ring,
        // Korridor). Auf dem Weg zu einem Absprungpunkt nur direkt bei der
        // Landung prüfen — sonst springt er vor der Kante statt an ihr.
        const decision = this.world ? this.decideJump(state, node, takeoffAhead) : takeoffAhead && justLanded && this.reachesBeyond(state, node) ? 'skip' : 'none';
        willJump = decision !== 'none';
        if (willJump) this.crouching = this.predictedCrouch || (takeoffAhead && node.crouch === true);
        if (decision === 'skip') {
          // Absprungpunkt liegt auf dieser Plattform und wird überflogen → erledigt.
          this.markReached(state, node);
          if (this._status !== 'running') return this.idle(out);
          node = this.route[this.idx];
        }
      }
      if (!willJump && !this.pendingJump && this.world) {
        // Kantensprung: endet der Boden direkt voraus, springen statt runterlaufen.
        const dx = node.pos[0] - state.pos.x;
        const dz = node.pos[2] - state.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > EDGE_LOOKAHEAD && !this.groundAt(state.pos, dx / d, dz / d, EDGE_LOOKAHEAD)) {
          willJump = true;
          this.crouching = node.pos[1] > state.pos.y + 40;
        }
      }
    }
    const heading = yawOf(node.pos[0] - state.pos.x, node.pos[2] - state.pos.z);
    const airHeading = this.raceLine(state, node, heading);
    if (willJump) this.pendingJump = false;
    if (state.onGround && !willJump && !this.pendingJump) this.crouching = false;

    const n = surfNormal;
    if (!state.onGround && state.surfing && n && (n.x !== 0 || n.z !== 0)) {
      this.surf(state, n, node, out);
    } else if (!state.onGround && this.world && state.vel.y < 0 && this.surfAhead(state) && this.surfAheadPoint.y < this.lineY(state, node) + SURF_LINE_LIFT) {
      // Anflug auf eine Surf-Flanke unterhalb der Knotenlinie: schon vorher in
      // die Rampe drücken — trifft höher (weniger Fallhöhe) und die Quer-Speed
      // wird beim Aufsetzen zu Steig-Speed statt dass man die Flanke
      // hinunterrutscht. Trifft die Bahn ohnehin oberhalb der Linie, nicht
      // drücken: bei langen Falls (Drop, Respawn-Pad) schöbe das den Fahrer
      // bis auf den Grat (mit Kanten-Bevels begehbar → Bodenkontakt, Abflug).
      this.pushInto(state, this.surfAheadNormal, out);
    } else if (!state.onGround && this.world && node.surf !== true && this.shouldBrake(state, node)) {
      // Luftbremse: S gegen die Flugrichtung (AirAccelerate mit voller Wirkung).
      this.ctl.brake(state, out);
    } else if (!state.onGround || willJump) {
      // Luft (oder Absprung in diesem Tick): Richtung Knoten strafen, kurz davor schon zum Folgeknoten eindrehen.
      this.ctl.air(state, airHeading, out);
    } else {
      this.ctl.ground(heading, out);
    }
    // Nur im Absprung-Tick halten: sonst hüpft autoHop auf dem Weg zum Absprungpunkt.
    out.jumpHeld = willJump;
    out.jumpPressed = willJump;
    out.crouch = this.crouching && !state.onGround;
    out.pitch = 0;
    return out;
  }

  /**
   * Rennlinie: die Flugrichtung dreht in der Luft höchstens um cap/|v| pro Tick.
   * Muss sie am Knoten stark abknicken (Slalom bei Tempo), wird schon vorher
   * eingedreht — Zielpunkt wandert ab LEAD vor dem Knoten auf die Folgestrecke.
   */
  private raceLine(state: PlayerSnapshot, node: RouteNode, direct: number): number {
    const next = this.route[this.idx + 1];
    if (!next) return direct;
    const dx = node.pos[0] - state.pos.x;
    const dz = node.pos[2] - state.pos.z;
    const d = Math.hypot(dx, dz);
    const sx = next.pos[0] - node.pos[0];
    const sz = next.pos[2] - node.pos[2];
    const sl = Math.hypot(sx, sz);
    if (d < 1 || sl < 1) return direct;
    const turn = Math.acos(Math.max(-1, Math.min(1, (dx * sx + dz * sz) / (d * sl))));
    const sp = Math.max(state.speed, 1);
    const turnRate = (airSpeedCapAt(this.cfg, sp) / sp) * this.cfg.tickRate; // rad/s
    // Hälfte der Drehung vor dem Knoten, Hälfte danach.
    const lead = 0.5 * sp * (turn / turnRate);
    const beyond = Math.min(lead - d, 0.5 * sl);
    if (beyond <= 0) return direct;
    return yawOf(node.pos[0] + (sx / sl) * beyond - state.pos.x, node.pos[2] + (sz / sl) * beyond - state.pos.z);
  }

  /**
   * Sprung jetzt? 'jump' = Richtung Knoten, er bleibt Ziel (Landeziel).
   * 'skip' = nächster Knoten ist ein naher Absprungpunkt auf dieser Plattform:
   * Richtung Folgeknoten, Landung muss hinter dem Absprungpunkt liegen.
   */
  private decideJump(state: PlayerSnapshot, node: RouteNode, takeoff: boolean): 'none' | 'jump' | 'skip' {
    if (takeoff) {
      const j = this.cfg.jumpImpulse;
      const disc = j * j - 2 * this.cfg.gravity * (node.pos[1] - state.pos.y);
      const flight = disc > 0 ? (state.speed * (j + Math.sqrt(disc))) / this.cfg.gravity : 0;
      const dist = Math.hypot(node.pos[0] - state.pos.x, node.pos[2] - state.pos.z);
      if (dist < SKIP_FRACTION * flight) return this.safeJumpNow(state, node, true) ? 'skip' : 'none';
    }
    // Unter Sprint-Tempo ist Laufen schneller als Hüpfen (Boden beschleunigt in
    // 0.2 s auf Sprint) — sofern bis zum Knoten durchgehend Boden ist.
    const runSpeed = this.ctl.sprint ? this.cfg.sprintSpeed : this.cfg.runSpeed;
    if (state.speed < runSpeed * 0.95 && this.floorTo(state, node)) return 'none';
    return this.safeJumpNow(state, node, false) ? 'jump' : 'none';
  }

  /** Boden unter der Stelle `dist` voraus (Richtung ux/uz)? Dünne Sonde, bis PROBE_DEPTH tief. */
  private groundAt(pos: Vector3, ux: number, uz: number, dist: number): boolean {
    const world = this.world;
    if (!world) return true;
    const a = this.pA.set(pos.x + ux * dist, pos.y + 8, pos.z + uz * dist);
    const b = this.pB.set(a.x, pos.y - PROBE_DEPTH, a.z);
    const tr = world.traceBox(a, b, this.probeMins, this.probeMaxs, this.tr);
    return !tr.startSolid && tr.fraction < 1 && tr.normal.y >= MIN_GROUND_NORMAL_Y;
  }

  /** Durchgehend Boden bis zum Knoten (Stichproben alle 32 u)? */
  private floorTo(state: PlayerSnapshot, node: RouteNode): boolean {
    const dx = node.pos[0] - state.pos.x;
    const dz = node.pos[2] - state.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1) return true;
    if (Math.abs(node.pos[1] - state.pos.y) > this.cfg.stepSize * 4) return false;
    for (let t = 32; t < d; t += 32) {
      if (!this.groundAt(state.pos, dx / d, dz / d, t)) return false;
    }
    return true;
  }

  /**
   * Landevorhersage für einen Sprung jetzt: Wurfparabel mit aktuellem
   * Horizontal-Speed Richtung Ziel, Hull-Traces Schritt für Schritt. Sicher =
   * begehbarer Boden, nicht tiefer als PREDICT_MAX_DROP unter Start und Ziel,
   * mit Fortschritt. Probiert normal, dann Crouch-Jump, jeweils auch mit
   * Luftbremse (BRAKE_FACTORS). skip: Ziel ist der Knoten nach dem nahen
   * Absprungpunkt `node`, Landung muss hinter `node` liegen.
   */
  private safeJumpNow(state: PlayerSnapshot, node: RouteNode, skip: boolean): boolean {
    const aim = skip ? this.route[this.idx + 1] : node;
    if (!aim) return false;
    const dx = aim.pos[0] - state.pos.x;
    const dz = aim.pos[2] - state.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1) return false;
    const ux = dx / dist;
    const uz = dz / dist;
    const speed = Math.max(state.speed, 1);
    const minY = Math.min(state.pos.y, aim.pos[1]) - PREDICT_MAX_DROP;
    const vx = ux * speed;
    const vz = uz * speed;
    const j = this.cfg.jumpImpulse;
    // Liegt das Ziel höher, zählt nur eine Landung oben (sonst "gelingt" ein
    // Sprung gegen die Kante, der zurück auf die eigene Plattform fällt) —
    // aber nur, wenn dieser Sprung das Ziel erreichen soll (≤ ~1.2 Flugweiten).
    const flatFlight = (speed * 2 * j) / this.cfg.gravity;
    const needY = aim.pos[1] > state.pos.y + 24 && dist < 1.2 * flatFlight ? aim.pos[1] - 24 : Number.NEGATIVE_INFINITY;
    // Surf-Ziel: eine Landung auf einer Surf-Flanke ist so gut wie Boden (Auto-Hop auf die Rampe).
    const good = (r: Landing): boolean => (r === 'ground' && this.landing.y >= needY) || (aim.surf === true && this.onSurfFlank(r));
    // Lieber springen und in der Luft dosiert bremsen, als am Boden hinzulaufen —
    // Friction frisst jedes Bhop-Tempo. Crouch-Jump, wenn normal nicht reicht.
    const forced = skip && node.crouch === true;
    // Zum Absprungpunkt hin nie mit Luftbremse hüpfen: das Tempo fehlt dann genau
    // dort, wo es gebraucht wird — lieber hinsprinten.
    const brakes = !skip && (node.jump === true || node.crouch === true) ? 0 : BRAKE_FACTORS.length;
    let ok = false;
    for (let i = -1; i < brakes && !ok; i++) {
      const f = i < 0 ? 1 : BRAKE_FACTORS[i];
      ok = good(this.predict(state.pos, vx * f, vz * f, j, forced, !forced, minY));
      let short = !ok && this.landedShort(state.pos, ux, uz, dist);
      this.predictedCrouch = forced;
      if (!ok && !forced) {
        ok = good(this.predict(state.pos, vx * f, vz * f, j, true, false, minY));
        short = short && !ok && this.landedShort(state.pos, ux, uz, dist);
        this.predictedCrouch = ok;
      }
      // Ungebremst zu kurz → gebremst erst recht: nicht springen, sondern
      // vorlaufen (Stop-and-Go). Ein gebremster Hüpfer entlang der eigenen
      // Plattform kostet mehr Tempo als der Lauf zur Kante.
      if (!ok && i < 0 && short) return false;
    }
    if (!ok) return false;
    const land = this.landing;
    if (skip) {
      const tx = aim.pos[0] - node.pos[0];
      const tz = aim.pos[2] - node.pos[2];
      if ((land.x - node.pos[0]) * tx + (land.z - node.pos[2]) * tz <= 0) return false;
    }
    // Fortschritt: Landung näher am Ziel oder schon drüber hinaus (in Richtung).
    return (land.x - state.pos.x) * ux + (land.z - state.pos.z) * uz > 16;
  }

  /** Endete die letzte Vorhersage vor dem Ziel (in Richtung ux/uz, Ziel `dist` entfernt)? */
  private landedShort(from: Vector3, ux: number, uz: number, dist: number): boolean {
    return (this.landing.x - from.x) * ux + (this.landing.z - from.z) * uz < dist - 16;
  }

  /** Endete die letzte Vorhersage an einer Surf-Flanke (0.05 < n.y < 0.7)? */
  private onSurfFlank(r: Landing): boolean {
    const n = this.landingNormal;
    return r === 'blocked' && n.y > 0.05 && n.y < MIN_GROUND_NORMAL_Y;
  }

  /**
   * Am erreichten Absprungknoten: trägt ein Sprung von hier (ungebremst, bei
   * crouch geduckt) bis zum Folgeknoten? Zu kurz → nicht hier springen, sondern
   * weiterlaufen und an der Kante springen (Stop-and-Go, Kantensprung-Logik).
   * Überschießen ist kein Grund zu warten — dafür gibt es die Luftbremse.
   */
  private jumpFallsShort(state: PlayerSnapshot, takeoff: RouteNode): boolean {
    const aim = this.route[this.idx + 1];
    if (!aim || !this.world || aim.surf === true || aim.air === true) return false;
    const dx = aim.pos[0] - state.pos.x;
    const dz = aim.pos[2] - state.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1) return false;
    const ux = dx / dist;
    const uz = dz / dist;
    const speed = Math.max(state.speed, 1);
    const minY = Math.min(state.pos.y, aim.pos[1]) - PREDICT_MAX_DROP;
    const crouch = takeoff.crouch === true;
    const r = this.predict(state.pos, ux * speed, uz * speed, this.cfg.jumpImpulse, crouch, !crouch, minY);
    if (r === 'ground' && this.landing.y >= aim.pos[1] - 24) return false;
    return this.landedShort(state.pos, ux, uz, dist);
  }

  /**
   * Luftbremse nötig? Nur wenn die aktuelle Bahn nicht sicher landet, eine
   * langsamere aber schon (sonst lieber weiter strafen und Tempo gewinnen).
   */
  private shouldBrake(state: PlayerSnapshot, node: RouteNode): boolean {
    if (state.speed < 50) return false;
    const minY = Math.min(this.lastGroundY, node.pos[1]) - PREDICT_MAX_DROP;
    const vx = state.vel.x;
    const vz = state.vel.z;
    const vy = state.vel.y;
    if (this.predict(state.pos, vx, vz, vy, state.ducked, true, minY) === 'ground') return false;
    const nx = node.pos[0];
    const nz = node.pos[2];
    const now = Math.hypot(nx - state.pos.x, nz - state.pos.z);
    if (now < 1) return false;
    // Luft-Strafe lenkt schnell (bei 350 u/s ~360°/s): landet die Bahn mit
    // gleichem Tempo, aber Richtung Knoten, wird gelenkt statt gebremst.
    const sp = Math.hypot(vx, vz);
    const ax = ((nx - state.pos.x) / now) * sp;
    const az = ((nz - state.pos.z) / now) * sp;
    if (this.predict(state.pos, ax, az, vy, state.ducked, true, minY) === 'ground') return false;
    // Nur bremsen, wenn die gebremste Landung dem Knoten näher kommt — nicht, um
    // auf die Absprung-Plattform zurückzufallen.
    for (const f of BRAKE_FACTORS) {
      if (this.predict(state.pos, ax * f, az * f, vy, state.ducked, true, minY) !== 'ground') continue;
      if (Math.hypot(nx - this.landing.x, nz - this.landing.z) < now - 32) return true;
    }
    return false;
  }

  /**
   * Wurfparabel mit Hull-Traces. lifted = false: Crouch-Jump-Hub (18 u) im
   * ersten Schritt anwenden. Der Landepunkt steht danach in this.landing.
   */
  private predict(start: Vector3, vx: number, vz: number, vy0: number, ducked: boolean, lifted: boolean, minY: number): Landing {
    const world = this.world;
    if (!world) return 'fall';
    const cfg = this.cfg;
    const hw = cfg.hull.halfWidth;
    this.mins.set(-hw, 0, -hw);
    this.maxs.set(hw, ducked ? cfg.hull.duckHeight : cfg.hull.standHeight, hw);
    const a = this.pA.copy(start);
    const b = this.pB;
    const g = cfg.gravity;
    const h = PREDICT_STEP;
    let vy = vy0;
    let didLift = lifted;
    let wallHits = 0;
    for (let t = 0; t < PREDICT_HORIZON; t += h) {
      b.set(a.x + vx * h, a.y + vy * h - 0.5 * g * h * h, a.z + vz * h);
      vy -= g * h;
      if (!didLift) {
        b.y += cfg.hull.standHeight - cfg.hull.duckHeight;
        didLift = true;
      }
      const tr = world.traceBox(a, b, this.mins, this.maxs, this.tr);
      if (tr.startSolid || tr.allSolid) {
        this.landingNormal.set(0, 0, 0);
        return 'blocked';
      }
      if (tr.fraction < 1) {
        this.landing.copy(tr.endPos);
        const n = tr.normal;
        this.landingNormal.copy(n);
        if (Math.abs(n.y) < 0.1 && wallHits < 4) {
          // Senkrechte Wand: wie TryPlayerMove horizontal abgleiten und weiterfliegen.
          wallHits++;
          const into = vx * n.x + vz * n.z;
          vx -= n.x * into;
          vz -= n.z * into;
          a.copy(tr.endPos);
          continue;
        }
        if (n.y < MIN_GROUND_NORMAL_Y || vy > 0) return 'blocked';
        return tr.endPos.y < minY ? 'fall' : 'ground';
      }
      a.copy(b);
      if (a.y < minY) {
        this.landing.copy(a);
        this.landingNormal.set(0, 0, 0);
        return 'fall';
      }
    }
    this.landing.copy(a);
    this.landingNormal.set(0, 0, 0);
    return 'fall';
  }

  /**
   * Fliegt die aktuelle Bahn auf eine Surf-Flanke (0.05 < n.y < 0.7)? Normale
   * danach in landingNormal. Nur alle PREDICT_EVERY Ticks neu gerechnet.
   */
  private surfAhead(state: PlayerSnapshot): boolean {
    if (this.ticks - this.surfAheadTick < PREDICT_EVERY) return this.surfAheadHit;
    this.surfAheadTick = this.ticks;
    const r = this.predict(state.pos, state.vel.x, state.vel.z, state.vel.y, state.ducked, true, state.pos.y - 4096);
    const n = this.landingNormal;
    // Nur echte Flanken: an konvexen Kanten liefert der Trace die Bevel-Normale
    // (z. B. Stirnkante einer Insel, ~0.6 steil). Zeigt sie in Flugrichtung,
    // streift man die Kante nur im Vorbeifallen — dort "hineinzudrücken" hieße
    // gegen die Flugrichtung bremsen.
    const nh = Math.hypot(n.x, n.z);
    const vh = Math.hypot(state.vel.x, state.vel.z);
    const along = nh > 1e-6 && vh > 1 ? (n.x * state.vel.x + n.z * state.vel.z) / (nh * vh) : 0;
    this.surfAheadHit = r === 'blocked' && n.y > 0.05 && n.y < MIN_GROUND_NORMAL_Y && along < 0.5;
    if (this.surfAheadHit) {
      this.surfAheadNormal.copy(n);
      this.surfAheadPoint.copy(this.landing);
    }
    return this.surfAheadHit;
  }

  /**
   * Auf der Flanke: Regler auf die Falllinien-Speed u (positiv = hoch). Ziel ist
   * die Knotenlinie (+Reserve); rutscht man schneller ab als gewünscht → voll in
   * die Rampe drücken (wishdir = −n_h, quer zur Flugrichtung, bis
   * airAccel·wishspeed·dt pro Tick), im Band → Gewinn-Strafe in die Rampe,
   * darüber → gleiten (Schwerkraft zieht runter).
   */
  private surf(state: PlayerSnapshot, n: Vector3, node: RouteNode, out: MutablePlayerInput): void {
    const ny = n.y;
    let tx = -n.x * ny;
    let ty = 1 - ny * ny;
    let tz = -n.z * ny;
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const u = state.vel.x * tx + state.vel.y * ty + state.vel.z * tz;
    const err = this.lineY(state, node) + SURF_LINE_LIFT - state.pos.y;
    const vyDes = Math.max(-SURF_MAX_VY, Math.min(SURF_MAX_VY, SURF_GAIN * err));
    const uDes = vyDes / Math.max(ty, 0.1);
    if (u < uDes - SURF_BAND) {
      this.pushInto(state, n, out);
    } else if (u > uDes + SURF_BAND) {
      this.ctl.glide(state, out);
    } else {
      // Links der Flugrichtung liegt (vz, -vx); zeigt das in die Rampe → Linkskurve (A).
      this.ctl.turnDir = state.vel.z * n.x - state.vel.x * n.z < 0 ? 1 : -1;
      this.ctl.air(state, null, out);
    }
  }

  /** In die Flanke drücken: A/D Richtung −n_h (horizontal). */
  private pushInto(state: PlayerSnapshot, n: Vector3, out: MutablePlayerInput): void {
    const hl = Math.hypot(n.x, n.z);
    this.ctl.push(state, -n.x / hl, -n.z / hl, out);
  }

  /** Höhe der Linie vorheriger Knoten → Ziel an der Stelle des Bots (Projektion, geklemmt). */
  private lineY(state: PlayerSnapshot, node: RouteNode): number {
    if (Number.isNaN(this.prevY)) return node.pos[1];
    const sx = node.pos[0] - this.prevX;
    const sz = node.pos[2] - this.prevZ;
    const l2 = sx * sx + sz * sz;
    if (l2 < 1) return node.pos[1];
    const t = Math.min(1, Math.max(0, ((state.pos.x - this.prevX) * sx + (state.pos.z - this.prevZ) * sz) / l2));
    return this.prevY + t * (node.pos[1] - this.prevY);
  }

  /**
   * Ohne Welt: trägt ein Sprung von hier (flach geflogen) bis zum Knoten nach
   * dem Absprungpunkt? Strafe-Gewinn im Flug ist Reserve.
   */
  private reachesBeyond(state: PlayerSnapshot, takeoff: RouteNode): boolean {
    const after = this.route[this.idx + 1];
    if (!after) return false;
    const needed = Math.hypot(after.pos[0] - state.pos.x, after.pos[2] - state.pos.z);
    const lift = takeoff.crouch ? this.cfg.hull.standHeight - this.cfg.hull.duckHeight : 0;
    const h = after.pos[1] - state.pos.y - lift;
    const j = this.cfg.jumpImpulse;
    const g = this.cfg.gravity;
    const disc = j * j - 2 * g * h;
    if (disc < 0) return false;
    const airTime = (j + Math.sqrt(disc)) / g;
    return state.speed * airTime >= needed;
  }

  private advance(state: PlayerSnapshot): void {
    while (this.idx < this.route.length) {
      const node = this.route[this.idx];
      const isTakeoff = node.jump === true || node.crouch === true;
      const radius = isTakeoff ? Math.min(TAKEOFF_RADIUS, this.reachRadius) : this.reachRadius;
      const nx = node.pos[0];
      const nz = node.pos[2];
      const dx = state.pos.x - nx;
      const dz = state.pos.z - nz;
      let reached = dx * dx + dz * dz <= radius * radius;
      // Surf-Knoten, den er an der Flanke surfend passiert — auch tiefer bzw. weiter
      // außen: zählt. Sonst dreht er zum verpassten Knoten um und bleibt an der
      // Flanke stehen (Stall, E2E-Review). Im freien Fall zählt weiter nichts.
      const surfPass = node.surf === true && state.surfing;
      if (!reached) {
        // Passiert? Projektion auf die Anflugrichtung (vorheriger Knoten → dieser).
        const sx = nx - this.prevX;
        const sz = nz - this.prevZ;
        const len = Math.hypot(sx, sz);
        if (len > 1e-3) {
          const along = (dx * sx + dz * sz) / len;
          const lateral = Math.abs(dx * sz - dz * sx) / len;
          // Seitlich großzügig (auf der Surf-Flanke heißt seitlich nur höher/tiefer),
          // dafür zählt Passieren weit UNTER dem Knoten nie (REACH_BELOW, unten).
          reached = along >= 0 && lateral <= (surfPass ? SURF_PASS_LATERAL : Math.max(96, 2 * this.reachRadius));
        }
      }
      // Im freien Fall weit unter dem Knoten zählt nichts (ehrlicher Fortschritt) —
      // außer man ist über ihn hinaus auf den tieferen Folgeabschnitt gefallen.
      if (!reached || (state.pos.y < node.pos[1] - REACH_BELOW && !surfPass)) {
        if (!this.droppedPast(state, node)) return;
        this.markReached(state, node);
        if (this._status !== 'running') return;
        continue;
      }

      // Absprungpunkt am Boden erreicht (auch überlaufen) → hier springen —
      // außer der Sprung wäre zu kurz: dann weiter zur Kante (Stop-and-Go).
      if (isTakeoff && state.onGround && !this.jumpFallsShort(state, node)) {
        this.pendingJump = true;
        this.crouching = node.crouch === true;
      }
      this.markReached(state, node);
      if (this._status !== 'running') return;
    }
  }

  /**
   * Über den Knoten hinaus (Anflugrichtung) auf tieferem Boden gelandet, höher als
   * jeder Sprung zurück, und die Route geht ohnehin tiefer weiter (Slalom-Ende →
   * Rutsche): abhaken statt umkehren. Früher lief der Bot zur letzten Slalom-Insel
   * zurück und fiel (4 von 11 Toden guter Hände in L1, Prüfung 27.09.).
   */
  private droppedPast(state: PlayerSnapshot, node: RouteNode): boolean {
    const next = this.route[this.idx + 1];
    if (!next || next.pos[1] > node.pos[1] - REACH_BELOW) return false;
    if (!state.onGround && !state.surfing) return false;
    if (node.pos[1] - state.pos.y < DROP_PAST) return false;
    const sx = node.pos[0] - this.prevX;
    const sz = node.pos[2] - this.prevZ;
    const len = Math.hypot(sx, sz);
    if (len < 1e-3) return false;
    const dx = state.pos.x - node.pos[0];
    const dz = state.pos.z - node.pos[2];
    const along = (dx * sx + dz * sz) / len;
    const lateral = Math.abs(dx * sz - dz * sx) / len;
    return along >= 0 && lateral <= SURF_PASS_LATERAL;
  }

  private markReached(state: PlayerSnapshot, node: RouteNode): void {
    const minSpeed = node.minSpeed ?? null;
    this.results.push({
      index: this.idx,
      time: this.time,
      speed: state.speed,
      minSpeed,
      belowMinSpeed: minSpeed !== null && state.speed < minSpeed,
      note: node.note ?? null,
    });
    this.prevX = node.pos[0];
    this.prevZ = node.pos[2];
    this.prevY = node.pos[1];
    this.idx++;
    this.lastProgressTick = this.ticks;
    if (this.idx >= this.route.length) {
      this._status = 'finished';
      this.endPos.x = state.pos.x;
      this.endPos.y = state.pos.y;
      this.endPos.z = state.pos.z;
    }
  }

  private idle(out: MutablePlayerInput): PlayerInput {
    out.forward = 0;
    out.side = 0;
    out.jumpHeld = false;
    out.jumpPressed = false;
    out.crouch = false;
    out.sprint = false;
    out.yaw = this.ctl.yaw;
    return out;
  }
}

export interface RunRouteOptions extends RouteFollowerOptions {
  /** Route überschreiben (Default: level.def.route). */
  readonly route?: readonly RouteNode[];
  /** Hartes Tick-Limit (Default: timeout · tickRate + 1). */
  readonly maxTicks?: number;
}

export interface RunRouteResult extends RouteReport {
  /** Ziel-Trigger berührt. */
  readonly touchedFinish: boolean;
  readonly ticks: number;
}

/** Kompiliertes Level mit PlayerMovement + RouteFollower abfahren (Sim, Level-Check). */
export function runRoute(level: CompiledLevel, config: MovementConfig, opts: RunRouteOptions = {}): RunRouteResult {
  const route = opts.route ?? level.def.route ?? [];
  const pm = new PlayerMovement(level.world, config);
  pm.teleport(level.spawnPos);
  const follower = new RouteFollower(route, config, {
    killY: level.def.killY,
    start: { x: level.spawnPos.x, z: level.spawnPos.z },
    world: level.world,
    ...opts,
  });
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  const finishes = level.triggers.filter((t) => t.kind === 'finish');
  const maxTicks = opts.maxTicks ?? Math.ceil((opts.timeout ?? 180) * config.tickRate) + 1;
  const hullMin = new Vector3();
  const hullMax = new Vector3();
  let touchedFinish = false;
  let ticks = 0;
  while (follower.status === 'running' && ticks < maxTicks) {
    pm.tick(follower.next(pm.state, pm.surfNormal));
    ticks++;
    hullMin.copy(pm.state.pos).add(pm.hullMins);
    hullMax.copy(pm.state.pos).add(pm.hullMaxs);
    for (const t of finishes) {
      if (boxOverlap(t.bounds.min, t.bounds.max, hullMin, hullMax)) touchedFinish = true;
    }
    for (const t of kills) {
      if (boxOverlap(t.bounds.min, t.bounds.max, hullMin, hullMax)) follower.fail('kill', pm.state);
    }
  }
  if (follower.status === 'running') follower.fail('timeout', pm.state);
  return { ...follower.report, touchedFinish, ticks };
}

function boxOverlap(aMin: Vector3, aMax: Vector3, bMin: Vector3, bMax: Vector3): boolean {
  return aMin.x < bMax.x && aMax.x > bMin.x && aMin.y < bMax.y && aMax.y > bMin.y && aMin.z < bMax.z && aMax.z > bMin.z;
}
