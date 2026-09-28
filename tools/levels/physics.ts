/**
 * Physik-Proben für Level-Bau und Validator: echte PlayerMovement-Ticks statt
 * Ballistik. Ballistik (ballistics.ts) plant Lücken; ob ein Abschnitt sich
 * fahren lässt, entscheidet erst die Simulation — Rampbugs an Hüllenfugen,
 * Stirnflächen an Surf-Übergängen und Reibung auf Checkpoint-Plattformen
 * sieht man nur hier.
 *
 * Drei Bausteine:
 * - `SpeedCurve`: Speed pro Hop des Strafe-Bots (flach) — daraus planen die
 *   Level ihre Hop-Rhythmen, statt fester +20 u/s pro Hop.
 * - `SurfRider`: Grundtechnik-Surfer (Blick entlang der Achse, Taste in die
 *   Rampe, zwischen Rampen keine Eingabe) mit einstellbarem Blickfehler.
 * - `simulate`: ein Lauf bis Ziel-Trigger / Kill / Timeout, mit
 *   Nahtstopp-Erkennung (Geschwindigkeit bricht in der Luft in einem Tick ein).
 */
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { RouteFollower, StrafeBot, makeBotInput, yawOf } from '../../src/player/bots';
import type { CollisionWorld, TraceResult } from '../../src/world/collision/types';
import { MIN_GROUND_NORMAL_Y, makeTraceResult } from '../../src/world/collision/types';
import { compileLevel, type CompiledLevel, type CompiledTrigger } from '../../src/world/level/compileLevel';
import type { LevelFile, RouteNode } from '../../src/world/level/LevelFormat';
import type { MutablePlayerInput, PlayerInput, PlayerSnapshot } from '../../src/player/types';
import { RunState } from '../../src/engine/runState';
import type { RunEvent } from '../../src/engine/events';

// ---------------------------------------------------------------------------
// Speed-Kurve des Strafe-Bots

const FLAT: LevelFile = {
  version: 1,
  id: 'flat',
  name: 'flat',
  spawn: { pos: [0, 0, 0], yaw: 0 },
  killY: -2000,
  environment: {
    skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
    sunDir: [0, 1, 0], sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -3000,
  },
  brushes: [{ type: 'box', min: [-40000, -64, -40000], max: [40000, 0, 40000], mat: 'floor' }],
  triggers: [],
};
let flatLevel: CompiledLevel | null = null;

/**
 * Strafe-Modell eines Bots: `sync` = fensterrelatives Fehlermodell (1 =
 * perfekt), `aimNoiseDeg` = absoluter Zielfehler der Hand (Menschenmodell,
 * CS2-Parität: 2° ≈ geübt, 3° ≈ Gelegenheitsspieler).
 */
export interface StrafeModel {
  readonly sync?: number;
  readonly aimNoiseDeg?: number;
}

/**
 * Landegeschwindigkeit pro Hop eines Strafe-Bots auf flachem Boden, Start
 * mit runSpeed. `after(v0, k)`: Tempo nach k weiteren Hops, wenn man mit v0
 * abspringt — die Kurve wird dafür an der Stelle v0 "eingefädelt".
 * Gemessen mit der übergebenen Config (Default VELOCITY_DEFAULT): Level-Rhythmen
 * und Validator ziehen bei jedem Movement-Tuning automatisch mit.
 */
export class SpeedCurve {
  private static readonly cache = new Map<string, SpeedCurve>();

  private constructor(
    readonly model: StrafeModel,
    /** pts[0] = Start (runSpeed), pts[i] = Landetempo nach Hop i; monoton. */
    private readonly pts: readonly number[],
  ) {}

  /** Fensterrelatives Modell (1 = perfekter Strafer). */
  static of(sync: number, cfg: MovementConfig = VELOCITY_DEFAULT): SpeedCurve {
    return SpeedCurve.model({ sync }, cfg);
  }

  /** Menschenmodell: absoluter Zielfehler in Grad (1σ). */
  static hand(aimNoiseDeg: number, cfg: MovementConfig = VELOCITY_DEFAULT): SpeedCurve {
    return SpeedCurve.model({ aimNoiseDeg }, cfg);
  }

  static model(m: StrafeModel, cfg: MovementConfig = VELOCITY_DEFAULT): SpeedCurve {
    // Schlüssel über ALLE Config-Felder: die alte Auswahl (8 Felder) kannte weder den
    // Anfänger-Cap noch Assist/Sprint — zwei Configs in einem Prozess teilten sich eine Kurve.
    const key = `${m.sync ?? 1}|${m.aimNoiseDeg ?? 0}|${configKey(cfg)}`;
    let c = SpeedCurve.cache.get(key);
    if (!c) {
      c = new SpeedCurve(m, measureCurve(m, cfg));
      SpeedCurve.cache.set(key, c);
    }
    return c;
  }

  /** Größtes gemessenes Tempo (nach 40 Hops) — beim Menschenmodell ≈ Sättigung. */
  get top(): number {
    return this.pts[this.pts.length - 1];
  }

  after(v0: number, hops: number): number {
    return this.at(this.indexOf(v0) + hops);
  }

  private at(x: number): number {
    const p = this.pts;
    const n = p.length;
    if (x <= 0) return p[0] + (p[1] - p[0]) * x;
    if (x >= n - 1) return p[n - 1] + (p[n - 1] - p[n - 2]) * (x - (n - 1));
    const i = Math.floor(x);
    return p[i] + (p[i + 1] - p[i]) * (x - i);
  }

  private indexOf(v: number): number {
    const p = this.pts;
    const n = p.length;
    if (v <= p[0]) return (v - p[0]) / Math.max(1e-6, p[1] - p[0]);
    for (let i = 0; i + 1 < n; i++) {
      if (v <= p[i + 1]) return i + (v - p[i]) / Math.max(1e-6, p[i + 1] - p[i]);
    }
    return n - 1 + (v - p[n - 1]) / Math.max(1e-6, p[n - 1] - p[n - 2]);
  }
}

/**
 * Stabiler Schlüssel über alle Felder einer Config (sortiert, rekursiv, Zahlen per String —
 * JSON machte aus Infinity/NaN "null"). Neue MovementConfig-Felder zählen automatisch mit.
 */
export function configKey(cfg: MovementConfig): string {
  return stableKey(cfg);
}

function stableKey(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? String(v);
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${k}:${stableKey(o[k])}`)
    .join(',')}}`;
}

function measureCurve(m: StrafeModel, cfg: MovementConfig): number[] {
  const hops = 40;
  const noisy = (m.sync ?? 1) < 1 || (m.aimNoiseDeg ?? 0) > 0;
  // Zufallsmodelle über mehrere Hände mitteln (das Menschenmodell streut stärker).
  const seeds = !noisy ? [1] : (m.aimNoiseDeg ?? 0) > 0 ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5];
  const sums: number[] = new Array<number>(hops).fill(0);
  flatLevel ??= compileLevel(FLAT);
  for (const seed of seeds) {
    const pm = new PlayerMovement(flatLevel.world, cfg);
    pm.teleport(new Vector3(0, 0, 30000));
    pm.state.vel.set(0, 0, -cfg.runSpeed);
    const bot = new StrafeBot(cfg, { sync: m.sync, aimNoiseDeg: m.aimNoiseDeg, seed: seed * 7919, heading: 0 });
    let got = 0;
    for (let t = 0; t < hops * 1.3 * cfg.tickRate && got < hops; t++) {
      for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land' && got < hops) sums[got++] += e.speed;
    }
  }
  const out = [cfg.runSpeed];
  for (const s of sums) out.push(Math.max(out[out.length - 1], s / seeds.length));
  return out;
}

// ---------------------------------------------------------------------------
// Controller

export interface Controller {
  next(state: PlayerSnapshot, surfNormal: Vector3): PlayerInput;
}

const PROBE_MINS = new Vector3(-4, 0, -4);
const PROBE_MAXS = new Vector3(4, 4, 4);

/**
 * Grundtechnik-Surfer. Am Boden: sprinten in Achsrichtung, an der Kante
 * springen, schnell gelandet sofort weiterhüpfen. An einer Surf-Fläche: Blick
 * entlang der Achse (plus `lookOffset`), Strafe-Taste in die Rampe. Frei in
 * der Luft: keine Eingabe — Übergänge müssen ohne Luftsteuerung fangen.
 *
 * `lookOffset` (rad) > 0 dreht den Blick zur Rampe hin (drückt stärker,
 * bremst etwas), < 0 von ihr weg (drückt ab ~asin(cap/v) gar nicht mehr —
 * bei hohem Tempo rutscht man dann ab; das ist Physik, kein Leveldesign).
 */
export class SurfRider implements Controller {
  private readonly out: MutablePlayerInput = makeBotInput();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly tr: TraceResult = makeTraceResult();

  constructor(
    private readonly cfg: MovementConfig,
    private readonly world: CollisionWorld,
    /** Achsrichtung (yaw, rad) an einer Stelle. */
    private readonly axisAt: (x: number, z: number) => number,
    private readonly lookOffset = 0,
  ) {}

  next(s: PlayerSnapshot, n: Vector3): PlayerInput {
    const out = this.out;
    const axis = this.axisAt(s.pos.x, s.pos.z);
    out.pitch = 0;
    out.crouch = false;
    out.sprint = true;
    if (s.onGround) {
      out.yaw = axis;
      out.forward = 1;
      out.side = 0;
      const jump = s.speed > this.cfg.sprintSpeed * 1.05 || !this.groundAhead(s.pos, axis, 24);
      out.jumpHeld = jump;
      out.jumpPressed = jump;
      return out;
    }
    out.jumpHeld = false;
    out.jumpPressed = false;
    out.forward = 0;
    if (n.x !== 0 || n.z !== 0) {
      let yaw = axis;
      // Achse so orientieren, wie man fährt.
      if (-Math.sin(yaw) * s.vel.x - Math.cos(yaw) * s.vel.z < 0) yaw += Math.PI;
      // right(yaw) = (cos, -sin); "in die Rampe" = -n horizontal.
      const side = -Math.cos(yaw) * n.x + Math.sin(yaw) * n.z > 0 ? 1 : -1;
      // Rampe rechts (D): zur Rampe drehen = yaw verkleinern.
      out.yaw = yaw - side * this.lookOffset;
      out.side = side;
    } else {
      out.yaw = s.speed > 50 ? yawOf(s.vel.x, s.vel.z) : axis;
      out.side = 0;
    }
    return out;
  }

  private groundAhead(pos: Vector3, yaw: number, dist: number): boolean {
    const a = this.a.set(pos.x - Math.sin(yaw) * dist, pos.y + 8, pos.z - Math.cos(yaw) * dist);
    const b = this.b.set(a.x, pos.y - 24, a.z);
    const tr = this.world.traceBox(a, b, PROBE_MINS, PROBE_MAXS, this.tr);
    return !tr.startSolid && tr.fraction < 1 && tr.normal.y >= MIN_GROUND_NORMAL_Y;
  }
}

/** Adapter: RouteFollower als Controller (er nutzt die Surf-Normale selbst). */
export class FollowerController implements Controller {
  constructor(readonly follower: RouteFollower) {}
  next(state: PlayerSnapshot, surfNormal: Vector3): PlayerInput {
    return this.follower.next(state, surfNormal);
  }
}

// ---------------------------------------------------------------------------
// Simulation

export type ProbeReason = 'goal' | 'kill' | 'fell' | 'timeout' | 'bot';

export interface Seam {
  readonly pos: Vector3;
  readonly before: number;
  readonly after: number;
  readonly normal: Vector3;
  readonly time: number;
}

export interface ProbeOutcome {
  readonly ok: boolean;
  readonly reason: ProbeReason;
  readonly time: number;
  readonly end: Vector3;
  readonly maxSpeed: number;
  /** Speed beim Erreichen des Ziels (horizontal). */
  readonly goalSpeed: number;
  /** Erster Nahtstopp (Speed bricht in der Luft in einem Tick um > 50 % ein). */
  readonly seam: Seam | null;
}

export interface SimOptions {
  readonly cfg?: MovementConfig;
  /** Sekunden. */
  readonly timeout?: number;
  /** Ziel: Überlappung der Hull mit dieser Box. */
  readonly goal: Box3;
  /** Zusätzlich: Überlappung mit einer dieser Boxen (z. B. Ziel-Trigger) zählt auch. */
  readonly alsoGoal?: readonly Box3[];
  /** Bot meldet von sich aus Scheitern (RouteFollower). */
  readonly botStatus?: () => 'running' | 'finished' | 'failed';
}

const hullMin = new Vector3();
const hullMax = new Vector3();

function overlaps(b: Box3, lo: Vector3, hi: Vector3): boolean {
  return lo.x < b.max.x && hi.x > b.min.x && lo.y < b.max.y && hi.y > b.min.y && lo.z < b.max.z && hi.z > b.min.z;
}

/**
 * Spieler (schon teleportiert, Geschwindigkeit gesetzt) mit `ctl` fahren,
 * bis die Hull das Ziel berührt, stirbt (killY / Kill-Trigger) oder die Zeit
 * abläuft.
 */
export function simulate(level: CompiledLevel, pm: PlayerMovement, ctl: Controller, o: SimOptions): ProbeOutcome {
  const cfg = o.cfg ?? VELOCITY_DEFAULT;
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  const maxTicks = Math.ceil((o.timeout ?? 30) * cfg.tickRate);
  const killY = level.def.killY;
  let seam: Seam | null = null;
  let maxSpeed = 0;
  let prevSpeed = Math.hypot(pm.state.vel.x, pm.state.vel.y, pm.state.vel.z);
  let prevGround = pm.state.onGround;
  let prevSurf = pm.state.surfing;
  const finish = (ok: boolean, reason: ProbeReason, t: number): ProbeOutcome => ({
    ok,
    reason,
    time: t / cfg.tickRate,
    end: pm.state.pos.clone(),
    maxSpeed,
    goalSpeed: pm.state.speed,
    seam,
  });
  for (let t = 1; t <= maxTicks; t++) {
    pm.tick(ctl.next(pm.state, pm.surfNormal));
    const s = pm.state;
    const sp = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
    if (s.speed > maxSpeed) maxSpeed = s.speed;
    // Nahtstopp: surfend (vorher) und in der Luft, Tempo halbiert sich in einem Tick.
    // Nur beim Surfen: ein Stirnwand-Bonk im Hop (Crouch-Kante in Level 1) ist ein
    // gewollter Fehlversuch, keine Hüllenfuge (fallen.md #31).
    if (!seam && prevSurf && !prevGround && !s.onGround && prevSpeed > 250 && sp < 0.5 * prevSpeed) {
      seam = { pos: s.pos.clone(), before: prevSpeed, after: sp, normal: pm.surfNormal.clone(), time: t / cfg.tickRate };
    }
    prevSpeed = sp;
    prevGround = s.onGround;
    prevSurf = s.surfing;
    hullMin.copy(s.pos).add(pm.hullMins);
    hullMax.copy(s.pos).add(pm.hullMaxs);
    if (overlaps(o.goal, hullMin, hullMax) || (o.alsoGoal ?? []).some((g) => overlaps(g, hullMin, hullMax))) return finish(true, 'goal', t);
    if (s.pos.y < killY) return finish(false, 'fell', t);
    for (const k of kills) if (overlaps(k.bounds, hullMin, hullMax)) return finish(false, 'kill', t);
    if (o.botStatus && o.botStatus() === 'failed') return finish(false, 'bot', t);
  }
  return finish(false, 'timeout', maxTicks);
}

// ---------------------------------------------------------------------------
// Route-Hilfen

/** Knoten an einer Surf-Flanke (RouteNode.surf). */
export function isSurfNode(n: RouteNode): boolean {
  return n.surf === true;
}

/** Luftknoten ohne Boden (RouteNode.air). */
export function isAirNode(n: RouteNode): boolean {
  return n.air === true;
}

/** Höhensprung der Fahrfläche unter der Knotenlinie, ab dem zwei Surf-Knoten auf getrennten Rampen liegen (Drop). */
const DROP_STEP = 48;

/**
 * Surf-Abschnitte der Route: Index des ersten Knotens jedes Abschnitts. Ein
 * Abschnitt beginnt am ersten Surf-Knoten nach einem Nicht-Surf-Knoten und an
 * jedem Drop — die Fahrfläche unter der Linie zum Vorgänger springt dort um
 * mehr als DROP_STEP nach unten (Flugphase zwischen zwei Rampen). Stücke einer
 * lückenlosen Kette (surfChain) bleiben ein Abschnitt. Geometrisch statt über
 * Notizen: wer Rampen umbaut, bekommt die Abschnitte automatisch richtig.
 */
export function surfSectionStarts(world: CollisionWorld, route: readonly RouteNode[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < route.length; i++) {
    if (!isSurfNode(route[i])) continue;
    if (i === 0 || !isSurfNode(route[i - 1]) || hasDrop(world, route[i - 1], route[i])) out.push(i);
  }
  return out;
}

function hasDrop(world: CollisionWorld, A: RouteNode, B: RouteNode): boolean {
  const d = Math.hypot(B.pos[0] - A.pos[0], B.pos[2] - A.pos[2]);
  const steps = Math.max(2, Math.ceil(d / 16));
  let prev: number | null = null;
  const p = new Vector3();
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    p.set(A.pos[0] + (B.pos[0] - A.pos[0]) * t, A.pos[1] + (B.pos[1] - A.pos[1]) * t, A.pos[2] + (B.pos[2] - A.pos[2]) * t);
    // Von oberhalb der Linie (über konvexen Knicken liegt die Sehne unter der Fläche) bis tief darunter.
    const tr = world.traceBox(new Vector3(p.x, p.y + 160, p.z), new Vector3(p.x, p.y - 800, p.z), DOWN_MINS, DOWN_MAXS);
    if (tr.startSolid || tr.fraction >= 1) continue;
    const h = tr.endPos.y;
    if (prev !== null && prev - h > DROP_STEP) return true;
    prev = h;
  }
  return false;
}

/** Tag der Surf-Rampe unter einem Knoten (für Reports), sonst "?". */
export function flankTag(level: CompiledLevel, n: RouteNode): string {
  const p = new Vector3(...n.pos);
  const tr = level.world.traceBox(new Vector3(p.x, p.y + 8, p.z), new Vector3(p.x, p.y - 200, p.z), DOWN_MINS, DOWN_MAXS);
  if (tr.startSolid || tr.fraction >= 1) return '?';
  return level.brushes[tr.brushIndex]?.tag ?? `#${tr.brushIndex}`;
}

/** Achsrichtung (yaw) aus den Surf-Abschnitten der Route: Richtung des nächstgelegenen Surf-Segments. */
export function routeAxis(route: readonly RouteNode[]): (x: number, z: number) => number {
  const segs: Array<{ ax: number; az: number; bx: number; bz: number; yaw: number }> = [];
  for (let i = 0; i + 1 < route.length; i++) {
    const A = route[i];
    const B = route[i + 1];
    if (!isSurfNode(A) && !isSurfNode(B)) continue;
    const dx = B.pos[0] - A.pos[0];
    const dz = B.pos[2] - A.pos[2];
    if (Math.hypot(dx, dz) < 1) continue;
    segs.push({ ax: A.pos[0], az: A.pos[2], bx: B.pos[0], bz: B.pos[2], yaw: yawOf(dx, dz) });
  }
  return (x, z) => {
    let best = Infinity;
    let yaw = 0;
    for (const s of segs) {
      const sx = s.bx - s.ax;
      const sz = s.bz - s.az;
      const l2 = sx * sx + sz * sz;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * sx + (z - s.az) * sz) / l2));
      const d = Math.hypot(x - (s.ax + sx * t), z - (s.az + sz * t));
      if (d < best) {
        best = d;
        yaw = s.yaw;
      }
    }
    return yaw;
  };
}

/** So tief (u) unter der Trigger-Unterkante zählt ein Knoten noch als "im Checkpoint" (Füße am Hang, Pads). */
export const RESUME_BELOW = 8;

/**
 * Liegt ein Route-Knoten (Füße) im Checkpoint-Trigger? x/z mit 1 u Toleranz, y von
 * RESUME_BELOW unter der Unterkante bis zur Oberkante. Ohne die Höhe griff in gestapelten
 * Leveln (Wendel L4) ein Knoten der Etage darunter ("Schatten-Knoten").
 */
export function nodeInTrigger(p: readonly number[], trigger: CompiledTrigger): boolean {
  const b = trigger.bounds;
  return p[0] >= b.min.x - 1 && p[0] <= b.max.x + 1 && p[2] >= b.min.z - 1 && p[2] <= b.max.z + 1 && p[1] >= b.min.y - RESUME_BELOW && p[1] <= b.max.y;
}

/** Ab welchem Route-Knoten geht es nach einem Respawn an `spawn` weiter? */
export function resumeIndex(route: readonly RouteNode[], trigger: CompiledTrigger, from = 0): number {
  let first = -1;
  for (let i = from; i < route.length; i++) {
    if (nodeInTrigger(route[i].pos, trigger)) {
      first = i;
      break;
    }
  }
  if (first < 0) return -1;
  // Nächster Knoten zum Spawn ab dem Eintritt; liegt der Spawn schon dahinter, den folgenden nehmen.
  const sp = trigger.spawnPos;
  let best = first;
  let bestD = Infinity;
  for (let i = first; i < route.length && i < first + 12; i++) {
    const p = route[i].pos;
    const d = Math.hypot(p[0] - sp.x, p[1] - sp.y, p[2] - sp.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const n = route[best];
  const nx = route[best + 1];
  if (nx) {
    const ax = nx.pos[0] - n.pos[0];
    const az = nx.pos[2] - n.pos[2];
    if ((sp.x - n.pos[0]) * ax + (sp.z - n.pos[2]) * az > 0) return best + 1;
  }
  return best;
}

/** Welche Bot-Linie eines Levels: `route` (Ideallinie) oder `safeRoute` (sichere Linie einer Gabel). */
export type RouteChoice = 'route' | 'safeRoute';

/**
 * Level mit `safeRoute` als Route — alle Proben, die `def.route` lesen (Bots, Respawn,
 * Surf-Raster, Spiel-Uhr), fahren dann die sichere Linie. Ohne safeRoute bleibt das Level
 * unverändert (die Route IST dann die sichere Linie). Die Variante trägt selbst kein
 * safeRoute mehr, damit Prüfungen nicht rekursiv doppelt laufen.
 */
export function withRoute(level: CompiledLevel, which: RouteChoice): CompiledLevel;
export function withRoute(level: LevelFile, which: RouteChoice): LevelFile;
export function withRoute(level: CompiledLevel | LevelFile, which: RouteChoice): CompiledLevel | LevelFile {
  if ('world' in level) {
    const def = routeDef(level.def, which);
    return def === level.def ? level : { ...level, def };
  }
  return routeDef(level, which);
}

function routeDef(def: LevelFile, which: RouteChoice): LevelFile {
  if (which === 'route' || !def.safeRoute) return def;
  const { safeRoute, ...rest } = def;
  return { ...rest, route: safeRoute };
}

/** Trigger, die nach Checkpoint `order` kommen: der nächste Checkpoint, sonst das Ziel. */
export function nextGoal(level: CompiledLevel, order: number): CompiledTrigger | null {
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  return cps.find((t) => t.order > order) ?? level.triggers.find((t) => t.kind === 'finish') ?? null;
}

/** RouteFollower ab einem Checkpoint-Spawn (Stand, Tempo 0) bis zum nächsten Checkpoint/Ziel. */
export function respawnRun(level: CompiledLevel, cp: CompiledTrigger, model: StrafeModel, cfg: MovementConfig = VELOCITY_DEFAULT): ProbeOutcome & { readonly from: number } {
  const route = level.def.route ?? [];
  const goal = nextGoal(level, cp.order);
  const from = resumeIndex(route, cp);
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(cp.spawnPos);
  if (!goal || from < 0) return { ...failNow(pm), from };
  const bot = new RouteFollower(route.slice(from), cfg, {
    sync: model.sync,
    aimNoiseDeg: model.aimNoiseDeg,
    seed: 11,
    killY: level.def.killY,
    world: level.world,
    start: { x: cp.spawnPos.x, z: cp.spawnPos.z },
    stallTimeout: 12,
  });
  const res = simulate(level, pm, new FollowerController(bot), { cfg, goal: goal.bounds, timeout: 40, botStatus: () => bot.status });
  return { ...res, from };
}

/** RouteFollower vom Level-Spawn bis zum ersten Checkpoint (bzw. Ziel) — der erste Abschnitt. */
export function sectionFromStart(level: CompiledLevel, model: StrafeModel, cfg: MovementConfig = VELOCITY_DEFAULT): ProbeOutcome {
  const route = level.def.route ?? [];
  const goal = nextGoal(level, 0);
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(level.spawnPos);
  if (!goal) return failNow(pm);
  const bot = new RouteFollower(route, cfg, {
    sync: model.sync,
    aimNoiseDeg: model.aimNoiseDeg,
    seed: 11,
    killY: level.def.killY,
    world: level.world,
    start: { x: level.spawnPos.x, z: level.spawnPos.z },
    stallTimeout: 12,
  });
  return simulate(level, pm, new FollowerController(bot), { cfg, goal: goal.bounds, timeout: 60, botStatus: () => bot.status });
}

/**
 * Ganze Route mit dem RouteFollower (Spawn → Ziel) abfahren und die Bahn
 * mitschreiben: pro Tick Füße (x, y, z) und Augenhöhe. Für Prüfungen, die die
 * tatsächlich geflogene Linie brauchen (Deko im Weg, Sichtlinien).
 */
export function recordRoute(level: CompiledLevel, model: StrafeModel, seed: number, cfg: MovementConfig = VELOCITY_DEFAULT): { readonly path: Float32Array; readonly ticks: number; readonly ok: boolean } {
  const route = level.def.route ?? [];
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(level.spawnPos);
  const fin = level.triggers.find((t) => t.kind === 'finish');
  const bot = new RouteFollower(route, cfg, {
    sync: model.sync,
    aimNoiseDeg: model.aimNoiseDeg,
    seed,
    killY: level.def.killY,
    world: level.world,
    start: { x: level.spawnPos.x, z: level.spawnPos.z },
  });
  const maxTicks = 120 * cfg.tickRate;
  const path = new Float32Array(maxTicks * 4);
  let n = 0;
  const ctl: Controller = {
    next: (s, nrm) => {
      if (n < maxTicks) {
        path[n * 4] = s.pos.x;
        path[n * 4 + 1] = s.pos.y;
        path[n * 4 + 2] = s.pos.z;
        path[n * 4 + 3] = s.eyeHeight;
        n++;
      }
      return bot.next(s, nrm);
    },
  };
  if (!fin) return { path, ticks: 0, ok: false };
  // Ziel = Landung auf der Zielfläche (dünne Schicht an der Trigger-Unterkante), nicht
  // das Berühren des Triggers: der Flug über dem Ziel gehört zur Bahn (L2-Finale).
  const land = new Box3(fin.bounds.min.clone().setY(fin.bounds.min.y - 1), fin.bounds.max.clone().setY(fin.bounds.min.y + 2));
  const res = simulate(level, pm, ctl, { cfg, goal: land, timeout: 120, botStatus: () => bot.status });
  return { path: path.subarray(0, n * 4), ticks: n, ok: res.ok };
}

/** Grundtechnik-Surfer ab einem Checkpoint-Spawn bis zum nächsten Checkpoint/Ziel. */
export function respawnSurf(level: CompiledLevel, cp: CompiledTrigger, lookOffset: number, cfg: MovementConfig = VELOCITY_DEFAULT): ProbeOutcome {
  const goal = nextGoal(level, cp.order);
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(cp.spawnPos);
  if (!goal) return failNow(pm);
  const rider = new SurfRider(cfg, level.world, routeAxis(level.def.route ?? []), lookOffset);
  return simulate(level, pm, rider, { cfg, goal: goal.bounds, timeout: 30 });
}

function failNow(pm: PlayerMovement): ProbeOutcome {
  return { ok: false, reason: 'timeout', time: 0, end: pm.state.pos.clone(), maxSpeed: 0, goalSpeed: 0, seam: null };
}

/** Surf-Raster: Einstiegstempo (u/s), Seitversatz zur Linie (u, negativ = Richtung Grat), Blickfehler (Grad). */
export interface SurfGridSpec {
  readonly speeds: readonly number[];
  readonly laterals: readonly number[];
  readonly looksDeg: readonly number[];
}

/**
 * Das Raster des Validators — und des Level-Baus, der Lücken hinter einem
 * Launch daraus ableitet. Das Einstiegs-Band 400–1000 u/s ist dicht belegt
 * (vom Ring, aus Drops, aus dem Hop), 1400 ist Überspeed; ±150 u seitlich ≈
 * Tiefe ±260 u an der 60°-Flanke. Einstiege aus dem Stand prüft der
 * Respawn-Lauf ab jedem Checkpoint (Surfer und alle Bot-Modelle).
 */
export const SURF_GRID: SurfGridSpec = {
  speeds: [400, 550, 700, 850, 1000, 1400],
  laterals: [-150, -90, -30, 30, 90, 120],
  looksDeg: [-2, 0, 2],
};

/** Fahrer für die Tempo-Messung: Grundtechnik-Surfer mit Blickfehler oder RouteFollower mit Strafe-Modell. */
export type SurfProbeRider = { readonly surfer: number } | { readonly bot: StrafeModel };

/**
 * Unteres Tempo-Band an Surf-Knoten, gemessen statt geschätzt: jeder Fahrer
 * aus `riders` startet ab jedem Checkpoint-Spawn vor der Surf-Kette aus dem
 * Stand (der langsamste Fall — wer vom Ring oder aus dem Hop kommt, ist
 * schneller). Pro Knoten das kleinste horizontale Tempo beim Passieren in der
 * Luft bzw. an der Flanke (Projektion auf die Anflugrichtung; Knoten, die man
 * noch auf dem Respawn-Pad "passiert", zählen nicht); NaN, wenn kein Lauf ihn
 * erreicht. Der Surfer fährt tief und schnell, der RouteFollower hält die
 * Knotenlinie (höher, langsamer) — das Minimum ist das untere Band. Levels
 * leiten daraus minSpeed und Lücken hinter dem Launch ab: jedes
 * Movement-Tuning zieht die Planung mit.
 */
export function measureSurfSpeeds(
  def: LevelFile,
  riders: readonly SurfProbeRider[],
  opts: { readonly grid?: SurfGridSpec; readonly cfg?: MovementConfig } = {},
): number[] {
  const cfg = opts.cfg ?? VELOCITY_DEFAULT;
  const level = compileLevel(def);
  const route = def.route ?? [];
  const out = route.map(() => Number.NaN);
  const axis = routeAxis(route);
  const kills = level.triggers.filter((t) => t.kind === 'kill');
  // Fahrer ab Knoten `from` verfolgen und das Tempo an jedem passierten Surf-Knoten eintragen.
  const track = (pm: PlayerMovement, ctl: Controller, from: number): void => {
    let k = from;
    for (let t = 0; t < 30 * cfg.tickRate && k < route.length; t++) {
      pm.tick(ctl.next(pm.state, pm.surfNormal));
      const s = pm.state;
      if (s.pos.y < def.killY || kills.some((z) => z.bounds.containsPoint(s.pos))) return;
      // Alle Knoten, die jetzt hinter dem Fahrer liegen, sind passiert.
      while (k < route.length) {
        const n = route[k];
        const p = route[Math.max(0, k - 1)];
        let dx = n.pos[0] - p.pos[0];
        let dz = n.pos[2] - p.pos[2];
        if (Math.hypot(dx, dz) < 1) {
          dx = s.vel.x;
          dz = s.vel.z;
        }
        if ((s.pos.x - n.pos[0]) * dx + (s.pos.z - n.pos[2]) * dz < 0) break;
        if (isSurfNode(n) && !s.onGround) out[k] = Number.isNaN(out[k]) ? s.speed : Math.min(out[k], s.speed);
        k++;
      }
      // Ende der Surf-Kette erreicht.
      if (k < route.length && k > from && !isSurfNode(route[k]) && isSurfNode(route[k - 1])) return;
    }
  };
  // 1) Aus dem Stand ab jedem Checkpoint vor einer Surf-Kette.
  for (const cp of level.triggers.filter((t) => t.kind === 'checkpoint')) {
    const from = resumeIndex(route, cp);
    if (from < 0 || !route.slice(from, from + 3).some(isSurfNode)) continue;
    for (const r of riders) {
      const pm = new PlayerMovement(level.world, cfg);
      pm.teleport(cp.spawnPos);
      const ctl: Controller =
        'surfer' in r
          ? new SurfRider(cfg, level.world, axis, (r.surfer * Math.PI) / 180)
          : new FollowerController(
              new RouteFollower(route.slice(from), cfg, {
                sync: r.bot.sync,
                aimNoiseDeg: r.bot.aimNoiseDeg,
                seed: 11,
                killY: def.killY,
                world: level.world,
                start: { x: cp.spawnPos.x, z: cp.spawnPos.z },
              }),
            );
      track(pm, ctl, from);
    }
  }
  // 2) Surf-Raster: jeder Einstieg (Tempo × Tiefe × Blickfehler) an jedem Abschnittsbeginn.
  const g = opts.grid;
  if (g) {
    for (const i of surfSectionStarts(level.world, route)) {
      const n = route[i];
      const next = route[i + 1];
      if (!next) continue;
      const p = new Vector3(...n.pos);
      const flank = flankAt(level.world, p);
      if (!flank) continue;
      const dir = new Vector3(next.pos[0] - p.x, 0, next.pos[2] - p.z).normalize();
      for (const lateral of g.laterals) {
        const start = placeOnFlank(level.world, p, flank, lateral);
        if (!start) continue;
        for (const speed of g.speeds) {
          for (const lookDeg of g.looksDeg) {
            const pm = new PlayerMovement(level.world, cfg);
            pm.teleport(start);
            pm.state.vel.set(dir.x * speed, 0, dir.z * speed);
            track(pm, new SurfRider(cfg, level.world, axis, (lookDeg * Math.PI) / 180), i);
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Surf-Raster

export interface SurfEntry {
  readonly pos: Vector3;
  readonly speed: number;
  readonly lateral: number;
  readonly lookDeg: number;
}

export interface SurfGridResult {
  /** Index des ersten Surf-Knotens des Abschnitts. */
  readonly node: number;
  readonly note: string;
  readonly goal: string;
  readonly runs: number;
  readonly failures: ReadonlyArray<SurfEntry & { readonly outcome: ProbeOutcome }>;
  readonly seams: ReadonlyArray<SurfEntry & { readonly seam: Seam }>;
  /** Kleinstes/größtes Ziel-Tempo der erfolgreichen Läufe. */
  readonly goalSpeed: readonly [number, number];
}

const DOWN_MINS = new Vector3(-16, 0, -16);
const DOWN_MAXS = new Vector3(16, 72, 16);

/**
 * Jeder Surf-Abschnitt der Route (erster Knoten einer Folge von surf-Knoten):
 * Fahrer an diesem Knoten mit verschiedenen Tempi, Tiefen (seitlich entlang
 * der Flanke versetzt) und Blickfehlern absetzen; jeder muss den nächsten
 * Checkpoint (bzw. das Ziel) erreichen, ohne Nahtstopp.
 */
export function surfGrid(level: CompiledLevel, o: SurfGridSpec & { readonly cfg?: MovementConfig }): SurfGridResult[] {
  const cfg = o.cfg ?? VELOCITY_DEFAULT;
  const route = level.def.route ?? [];
  const axisAt = routeAxis(route);
  const out: SurfGridResult[] = [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const finish = level.triggers.find((t) => t.kind === 'finish');
  for (const i of surfSectionStarts(level.world, route)) {
    const n = route[i];
    const next = route[i + 1];
    if (!next) continue;
    // Ziel: der nächste Checkpoint, den die Route bis hier noch nicht berührt hat, sonst das Ziel.
    const done = reachedOrder(route, i, cps);
    const goalT = cps.find((t) => t.order > done) ?? finish;
    if (!goalT) continue;
    const p = new Vector3(...n.pos);
    const flank = flankAt(level.world, p);
    if (!flank) continue;
    const dir = new Vector3(next.pos[0] - p.x, 0, next.pos[2] - p.z).normalize();
    const failures: Array<SurfEntry & { outcome: ProbeOutcome }> = [];
    const seams: Array<SurfEntry & { seam: Seam }> = [];
    let runs = 0;
    let lo = Infinity;
    let hi = 0;
    for (const lateral of o.laterals) {
      const start = placeOnFlank(level.world, p, flank, lateral);
      if (!start) continue;
      for (const speed of o.speeds) {
        for (const lookDeg of o.looksDeg) {
          const pm = new PlayerMovement(level.world, cfg);
          pm.teleport(start);
          pm.state.vel.set(dir.x * speed, 0, dir.z * speed);
          const rider = new SurfRider(cfg, level.world, axisAt, (lookDeg * Math.PI) / 180);
          const res = simulate(level, pm, rider, { cfg, goal: goalT.bounds, timeout: 25 });
          runs++;
          const entry = { pos: start, speed, lateral, lookDeg };
          if (!res.ok) failures.push({ ...entry, outcome: res });
          else {
            lo = Math.min(lo, res.goalSpeed);
            hi = Math.max(hi, res.goalSpeed);
          }
          if (res.seam) seams.push({ ...entry, seam: res.seam });
        }
      }
    }
    out.push({
      node: i,
      note: flankTag(level, n),
      goal: goalT.kind === 'finish' ? 'Ziel' : `CP${goalT.order}`,
      runs,
      failures,
      seams,
      goalSpeed: [Number.isFinite(lo) ? lo : 0, hi],
    });
  }
  return out;
}

/** Höchster Checkpoint, den die Route bis Knoten i in Reihenfolge berührt hat (Segment-Stichproben). */
export function reachedOrder(route: readonly RouteNode[], i: number, cps: readonly CompiledTrigger[]): number {
  let order = 0;
  const q = new Vector3();
  const touches = (t: CompiledTrigger, a: readonly number[], b: readonly number[]): boolean => {
    for (let s = 0; s <= 16; s++) {
      q.set(a[0] + ((b[0] - a[0]) * s) / 16, a[1] + ((b[1] - a[1]) * s) / 16 + 1, a[2] + ((b[2] - a[2]) * s) / 16);
      if (t.bounds.containsPoint(q)) return true;
    }
    return false;
  };
  for (let k = 0; k <= i; k++) {
    const a = route[k].pos;
    const b = k < i ? route[k + 1].pos : a;
    for (;;) {
      const t = cps.find((c) => c.order === order + 1);
      if (!t || !touches(t, a, b)) break;
      order++;
    }
  }
  return order;
}

interface Flank {
  readonly normal: Vector3;
  /** Horizontale Richtung "nach außen" (hangabwärts). */
  readonly out: Vector3;
}

function flankAt(world: CollisionWorld, p: Vector3): Flank | null {
  const tr = world.traceBox(new Vector3(p.x, p.y + 8, p.z), new Vector3(p.x, p.y - 200, p.z), DOWN_MINS, DOWN_MAXS);
  const n = tr.normal;
  if (tr.startSolid || tr.fraction >= 1 || !(n.y > 0.05 && n.y < MIN_GROUND_NORMAL_Y)) return null;
  return { normal: n.clone(), out: new Vector3(n.x, 0, n.z).normalize() };
}

/** Fahrer `lateral` u nach außen (hangabwärts) versetzt, knapp über der Flanke. Null, wenn dort eine andere Fläche liegt. */
function placeOnFlank(world: CollisionWorld, p: Vector3, flank: Flank, lateral: number): Vector3 | null {
  const x = p.x + flank.out.x * lateral;
  const z = p.z + flank.out.z * lateral;
  const tr = world.traceBox(new Vector3(x, p.y + 600, z), new Vector3(x, p.y - 1200, z), DOWN_MINS, DOWN_MAXS);
  if (tr.startSolid || tr.fraction >= 1 || tr.normal.dot(flank.normal) < 0.999) return null;
  return new Vector3(x, tr.endPos.y + 2, z);
}

// ---------------------------------------------------------------------------
// Sonstige Proben

/**
 * Geradeaus-Hüpfer ohne Lenkung (Blick fest, nur Auto-Hop, keine Strafe-Taste)
 * ab `start` mit `speed` in Richtung `yaw`. Kommt er bis `goal`, braucht der
 * Abschnitt keine Lenkung.
 */
export function straightHop(level: CompiledLevel, start: Vector3, yaw: number, speed: number, goal: Box3, cfg: MovementConfig = VELOCITY_DEFAULT): ProbeOutcome {
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(start);
  pm.state.vel.set(-Math.sin(yaw) * speed, 0, -Math.cos(yaw) * speed);
  const out = makeBotInput();
  const ctl: Controller = {
    next: () => {
      out.yaw = yaw;
      out.forward = 0;
      out.side = 0;
      out.jumpHeld = true;
      out.jumpPressed = true;
      return out;
    },
  };
  return simulate(level, pm, ctl, { cfg, goal, timeout: 12 });
}

// ---------------------------------------------------------------------------
// Zeiten wie im Spiel (Par, Medaillen)

/** Ein Lauf mit Spiel-Uhr: Zeit (s) laut RunState oder null, dazu die Tode unterwegs. */
export interface TimedRun {
  readonly time: number | null;
  readonly deaths: number;
  /** Warum kein Ziel (Bot gescheitert, Zeitlimit). */
  readonly reason: string | null;
  /** Spiel-Uhr an jedem erreichten Checkpoint (RunState.splits) — verortet, wo Läufe auseinanderlaufen. */
  readonly splits: readonly number[];
}

const SPAWN_LIFT = 1;

/**
 * Ganzer Lauf wie im Spiel: RouteFollower steuert, RunState misst — Timer ab
 * Verlassen der Startzone bis zur Berührung des Ziel-Triggers, Tode kosten Zeit
 * (Respawn am letzten Checkpoint wie Game.respawn, vor CP1 zurück an den Start
 * mit neuem Timer). Die Bestzeit, die der Spieler sieht, ist genau diese Zahl —
 * build.ts maß Par früher ab Spawn (1.2–1.3 s zu lang) und nur Läufe ohne Tod.
 */
export function timedRun(level: CompiledLevel, model: StrafeModel, seed: number, cfg: MovementConfig = VELOCITY_DEFAULT, timeout = 180, jitter?: StartJitter): TimedRun {
  const route = level.def.route ?? [];
  const pm = new PlayerMovement(level.world, cfg);
  const run = new RunState(level);
  run.reset(null);
  const events: RunEvent[] = [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const place = (p: Vector3): void => pm.teleport(new Vector3(p.x, p.y + SPAWN_LIFT, p.z));
  const follower = (from: number, start: Vector3): RouteFollower =>
    new RouteFollower(route.slice(from), cfg, {
      sync: model.sync,
      aimNoiseDeg: model.aimNoiseDeg,
      seed,
      killY: level.def.killY,
      world: level.world,
      start: { x: start.x, z: start.z },
      stallTimeout: 12,
      timeout: timeout + 1,
    });
  const start = jitterStart(level.spawnPos, level.spawnYaw, jitter?.lateral ?? 0);
  place(start);
  let bot = follower(0, start);
  const aim = new StartAim(jitter?.yawDeg ?? 0);
  let deaths = 0;
  const dt = 1 / cfg.tickRate;
  for (let t = 0; t < timeout * cfg.tickRate; t++) {
    pm.tick(aim.apply(bot.next(pm.state, pm.surfNormal), pm.state.onGround));
    const s = pm.state;
    const out = run.tick(dt, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, events);
    if (out === 'finish') return { time: run.time, deaths, reason: null, splits: run.splits() };
    if (out === 'fall' || out === 'kill') {
      deaths++;
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      place(sp.pos);
      const from = run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0;
      bot = follower(from, sp.pos);
      continue;
    }
    // Bot fertig oder gescheitert, ohne dass das Ziel kam: noch kurz ausrollen lassen (Flug ins Ziel).
    if (bot.status === 'failed') return { time: null, deaths, reason: bot.report.reason ?? 'bot', splits: run.splits() };
  }
  return { time: null, deaths, reason: 'timeout', splits: run.splits() };
}

/** Median der Spiel-Zeiten eines Modells über die Seeds (null, wenn keiner ins Ziel kommt). */
export function timedMedian(level: CompiledLevel, model: StrafeModel, seeds: readonly number[], cfg: MovementConfig = VELOCITY_DEFAULT): { readonly median: number | null; readonly runs: readonly TimedRun[] } {
  const runs = seeds.map((seed) => timedRun(level, model, seed, cfg));
  return { median: medianOf(runs), runs };
}

/** Median über ALLE Läufe: ein gescheiterter zählt als langsamster; null ohne Mehrheit im Ziel. */
function medianOf(runs: readonly TimedRun[]): number | null {
  const times = runs.flatMap((r) => (r.time === null ? [] : [r.time])).sort((a, b) => a - b);
  if (times.length * 2 <= runs.length) return null;
  return times[Math.floor((runs.length - 1) / 2)];
}

// ---------------------------------------------------------------------------
// Start-Jitter (Medaillen des perfekten Bots)

/** Start-Störung eines Laufs: Versatz (u) rechts vom Spawn-Blick, Blickfehler (Grad, + = links) bis zum ersten Absprung. */
export interface StartJitter {
  readonly lateral: number;
  readonly yawDeg: number;
}

/** Startpunkt `lateral` u rechts vom Spawn-Blick (Blick = (−sin yaw, −cos yaw), rechts = (cos yaw, −sin yaw) wie Taste D). */
export function jitterStart(spawn: Vector3, spawnYawDeg: number, lateral: number): Vector3 {
  if (lateral === 0) return spawn;
  const a = (spawnYawDeg * Math.PI) / 180;
  return new Vector3(spawn.x + Math.cos(a) * lateral, spawn.y, spawn.z - Math.sin(a) * lateral);
}

/**
 * Blickfehler des Start-Jitters: verdreht die Bot-Eingabe um `yawDeg`, bis der Spieler nach dem ersten
 * Aufsetzen am Spawn wieder abhebt (erster Absprung) — danach nie wieder, auch nicht nach einem Respawn.
 * `apply` liefert die Bot-Eingabe selbst oder eine verdrehte Kopie (die Bot-Ausgabe bleibt unberührt).
 */
export class StartAim {
  private off: number;
  private grounded = false;
  private readonly out: MutablePlayerInput = makeBotInput();

  constructor(yawDeg: number) {
    this.off = (yawDeg * Math.PI) / 180;
  }

  /** true, solange der Blickfehler wirkt. */
  get active(): boolean {
    return this.off !== 0;
  }

  /** `onGround` = Zustand VOR dem Tick, der diese Eingabe bekommt. */
  apply(cmd: PlayerInput, onGround: boolean): PlayerInput {
    if (this.off !== 0) {
      if (onGround) this.grounded = true;
      else if (this.grounded) this.off = 0;
    }
    if (this.off === 0) return cmd;
    Object.assign(this.out, cmd);
    this.out.yaw = cmd.yaw + this.off;
    return this.out;
  }
}

/** Kasten des Start-Jitters: ±16 u quer × ±1° Blick. */
export const JITTER_LATERAL = 16;
export const JITTER_YAW_DEG = 1;
/** Kantenlänge des Rasters (ungerade: die mittlere Zelle ist der ungestörte Start). */
export const JITTER_GRID = 7;

/** Zellmitten eines n × n-Rasters im Kasten, Reihenfolge Versatz außen, Blick innen. */
export function jitterGrid(n = JITTER_GRID): StartJitter[] {
  const out: StartJitter[] = [];
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) out.push({ lateral: JITTER_LATERAL * ((2 * a + 1) / n - 1), yawDeg: JITTER_YAW_DEG * ((2 * b + 1) / n - 1) });
  return out;
}

/**
 * 49 Starts um den Spawn (7 × 7-Zellmitten). Der perfekte Bot ist deterministisch, aber chaotisch: schon
 * 0.1° oder 16 u verschieben seine Zeit. Plan 007 sah den Median über 5 Starts (Mitte + Ecken) vor — die
 * Ecken sind keine faire Stichprobe (L1, Phase-0-Physik: alle vier im langsamen Zweig, 26.72 s gegen
 * 23.02 s über 49 Starts); das gleichmäßige Raster ist es. 49 statt 25: auf dem ruhigen L2 schwankte der
 * Median über 5 × 5 / 7 × 7 / 9 × 9 noch um 0.19 s (16.01/16.20/16.15), 7 × 7 liegt bei 9 × 9; ≈ 0.4 s je Level.
 * Robust ist der Median nur, solange der Bot EINEN Zweig fährt — zerfallen die Läufe in Zweige
 * (L1: Bonk an der Crouch-Kante, `jitterBranches`), hängt jede Kennzahl davon ab, wie viele Starts in
 * welchem Zweig landen. Dann warnen build.ts und levels:check; zu reparieren ist das Level.
 */
export const START_JITTERS: readonly StartJitter[] = jitterGrid();

/** Ergebnis über die Start-Jitter: Median wie timedMedian, dazu die Zweige (null = ein Zweig). */
export interface JitterResult {
  readonly median: number | null;
  readonly runs: readonly TimedRun[];
  readonly branches: JitterBranches | null;
}

/** Median der Spiel-Zeiten eines Modells über Start-Jitter (build.ts: Gold/VELOCITY/Autor). */
export function jitterMedian(level: CompiledLevel, model: StrafeModel, cfg: MovementConfig = VELOCITY_DEFAULT, jitters: readonly StartJitter[] = START_JITTERS): JitterResult {
  const runs = jitters.map((j, i) => timedRun(level, model, i + 1, cfg, 180, j));
  return { median: medianOf(runs), runs, branches: jitterBranches(runs) };
}

/** Zweige: Lücke ≥ 4 % des Medians zwischen zwei benachbarten Zeiten … */
export const BRANCH_GAP = 0.04;
/** … mit je ≥ 10 % der Starts auf beiden Seiten (einzelne Ausreißer sind kein Zweig). */
export const BRANCH_SHARE = 0.1;

/**
 * Zwei Zweige des perfekten Bots über den Start-Kasten. Kalibriert (7 × 7, Phase-0- und Repo-Physik): L1
 * Lücke 2.0/2.1 s (9–10 % des Medians), L2 ≤ 0.2 s, L4-Prototyp ≤ 0.5 s (2 %), L3-Prototyp 1.2 s nur vor
 * 3 von 49 Läufen (Ausreißer, kein Zweig).
 */
export interface JitterBranches {
  /** Läufe des schnellen und des langsamen Zweigs, je aufsteigend; gescheiterte Läufe zählen als langsamste. */
  readonly fast: readonly TimedRun[];
  readonly slow: readonly TimedRun[];
  /** Lücke (s) zwischen dem langsamsten schnellen und dem schnellsten langsamen Lauf (Infinity = der Rest scheitert). */
  readonly gap: number;
  /**
   * Abschnitt mit dem größten Unterschied der Median-Abschnittszeiten (0 = Start → CP1, …), −1 ohne Splits. Das
   * ist, wo der langsame Zweig die Zeit verliert — meist direkt NACH der Chaos-Stelle (L1: Bonk an der
   * Crouch-Kante vor CP2, Verlust im Neustart CP2 → CP3).
   */
  readonly segment: number;
  /** Median-Unterschied (s) in diesem Abschnitt. */
  readonly segmentDiff: number;
  /** Anzahl Checkpoints (Abschnitte = checkpoints + 1). */
  readonly checkpoints: number;
}

export function jitterBranches(runs: readonly TimedRun[]): JitterBranches | null {
  const med = medianOf(runs);
  const n = runs.length;
  const k = Math.max(1, Math.ceil(BRANCH_SHARE * n));
  if (med === null || n < 2 * k) return null;
  const at = (r: TimedRun): number => r.time ?? Infinity;
  const sorted = [...runs].sort((a, b) => at(a) - at(b));
  let cut = -1;
  let gap = 0;
  for (let i = k; i <= n - k; i++) {
    const lo = at(sorted[i - 1]);
    const hi = at(sorted[i]);
    const g = hi === Infinity ? (lo === Infinity ? 0 : Infinity) : hi - lo;
    if (g > gap) {
      gap = g;
      cut = i;
    }
  }
  if (cut < 0 || gap < BRANCH_GAP * med) return null;
  const fast = sorted.slice(0, cut);
  const slow = sorted.slice(cut);
  // Abschnittszeiten aus den Splits (nur Läufe im Ziel mit allen Checkpoints).
  const cpCount = Math.max(0, ...runs.map((r) => r.splits.length));
  const segs = (r: TimedRun): number[] | null => {
    if (r.time === null || r.splits.length !== cpCount) return null;
    const marks = [0, ...r.splits, r.time];
    return marks.slice(1).map((m, i) => m - marks[i]);
  };
  const medianAt = (list: readonly TimedRun[], s: number): number | null => {
    const xs = list.flatMap((r) => {
      const x = segs(r);
      return x ? [x[s]] : [];
    });
    if (!xs.length) return null;
    xs.sort((a, b) => a - b);
    return xs[Math.floor((xs.length - 1) / 2)];
  };
  let segment = -1;
  let segmentDiff = 0;
  for (let s = 0; s <= cpCount; s++) {
    const f = medianAt(fast, s);
    const w = medianAt(slow, s);
    if (f === null || w === null) continue;
    if (segment < 0 || w - f > segmentDiff) {
      segment = s;
      segmentDiff = w - f;
    }
  }
  return { fast, slow, gap, segment, segmentDiff, checkpoints: cpCount };
}

/** Abschnittsname für Berichte: "Start → CP1", "CP2 → CP3", "CP4 → Ziel". */
export function segmentName(segment: number, checkpoints: number): string {
  const from = segment === 0 ? 'Start' : `CP${segment}`;
  const to = segment >= checkpoints ? 'Ziel' : `CP${segment + 1}`;
  return `${from} → ${to}`;
}

/** Eine Zeile für Build-Log und Validator: Größe und Zeiten der Zweige, Lücke, Abschnitt. */
export function describeBranches(b: JitterBranches): string {
  const n = b.fast.length + b.slow.length;
  const span = (list: readonly TimedRun[]): string => {
    const times = list.flatMap((r) => (r.time === null ? [] : [r.time]));
    const failed = list.length - times.length;
    const range = times.length ? `${times[0].toFixed(1)}–${times[times.length - 1].toFixed(1)} s` : '';
    return [range, failed ? `${failed} ohne Ziel` : ''].filter((x) => x !== '').join(', ');
  };
  const gap = Number.isFinite(b.gap) ? `Lücke ${b.gap.toFixed(1)} s` : 'der Rest scheitert';
  const where = b.segment >= 0 ? `; größter Verlust in ${segmentName(b.segment, b.checkpoints)} (+${b.segmentDiff.toFixed(1)} s)` : '';
  return `${b.fast.length}/${n} Starts bei ${span(b.fast)}, ${b.slow.length}/${n} bei ${span(b.slow)} (${gap})${where}`;
}
