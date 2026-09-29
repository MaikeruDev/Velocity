/**
 * Eingabe-Modelle der Lektions-Validierung (Plan 007, TC5). Jede Hand arbeitet wie ein Mensch ohne
 * Formel (Verzug, Streuung, Fehler) — die Schwellen der Lektionen sollen für Menschen stimmen, nicht
 * für den perfekten Bot. Alle deterministisch (Seed), Werkzeug-Code (Allokation erlaubt).
 */
import { createDemo } from '../../../src/engine/Training';
import type { TrainingSession } from '../../../src/engine/Training';
import { BeginnerHand, SurfHand } from '../../../src/player/bots/BeginnerHand';
import type { HandModel, SurfMode } from '../../../src/player/bots/BeginnerHand';
import { NaiveBot, RouteFollower, mulberry32, wrapAngle, yawOf } from '../../../src/player/bots';
import { gaussian } from '../../../src/player/bots/Bot';
import type { Point2 } from '../../../src/player/bots';
import type { MovementConfig } from '../../../src/player/MovementConfig';
import type { MutablePlayerInput, PlayerSnapshot } from '../../../src/player/types';
import { NO_INPUT } from '../../../src/player/types';
import type { RouteNode } from '../../../src/world/level/LevelFormat';
import type { Driver, DriverContext } from './lessonLib';

const DEG = Math.PI / 180;

/** Treiber, die um einen Neustart an der Stufe bitten (Taste F), z. B. nach dem Fall in die Grube. */
export interface RespawningDriver extends Driver {
  wantsRespawn(): boolean;
  onRespawn(): void;
}

export function isRespawning(d: Driver): d is RespawningDriver {
  return 'wantsRespawn' in d;
}

/** Neuling: W + Leertaste gehalten (Sprint wie im Spiel), Blick aufs Ziel. */
export function naive(target: Point2 | ((s: PlayerSnapshot) => Point2), press: 'hold' | 'spam' = 'hold') {
  return (ctx: DriverContext): Driver => {
    let bot: NaiveBot | null = null;
    let last: Point2 | null = null;
    return {
      next: (s) => {
        const t = typeof target === 'function' ? target(s) : target;
        if (!bot || t !== last) {
          bot = new NaiveBot(ctx.cfg, { target: t, press, sprint: true });
          last = t;
        }
        return bot.next(s);
      },
    };
  };
}

export interface RouteDriverOptions {
  readonly from: number;
  readonly to: number;
  readonly noise: number;
  /** Nach Scheitern (Stall, Ende ohne Stufe) neu anlaufen — ein Mensch versucht es nochmal. */
  readonly retry?: boolean;
  readonly stallTimeout?: number;
}

/** RouteFollower (Menschenmodell mit Zielfehler) auf LevelFile.route[from..to] ab dem Stufen-Spawn. */
export function routeHand(o: RouteDriverOptions) {
  return (ctx: DriverContext): Driver => {
    const nodes: readonly RouteNode[] = (ctx.level.def.route ?? []).slice(o.from, o.to + 1);
    let attempt = 0;
    let rf: RouteFollower | null = null;
    const w = ctx.world;
    return {
      next: (s, n, session) => {
        if (!rf || (o.retry && rf.status !== 'running' && !sessionDone(session))) {
          attempt++;
          rf = new RouteFollower(nodes, ctx.cfg, {
            aimNoiseDeg: o.noise,
            seed: ctx.seed * 17 + attempt,
            world: w,
            killY: ctx.level.def.killY,
            start: { x: s.pos.x, z: s.pos.z },
            stallTimeout: o.stallTimeout ?? 12,
          });
        }
        return rf.next(s, n);
      },
    };
  };
}

function sessionDone(session: TrainingSession): boolean {
  return session.stage === null;
}

/** Plan einer Hand je Stufe: Muster, Startseite, Ziel (dynamisch möglich). */
export interface HandPlan {
  readonly pattern: HandModel['pattern'];
  readonly side?: 'left' | 'right';
  readonly goal?: Point2 | null;
}

/** BeginnerHand, deren Muster je Stufe wechselt (z. B. T3: links → rechts → Wechsel). */
export function hand(model: HandModel, plan: (stageIndex: number, s: PlayerSnapshot, session: TrainingSession) => HandPlan) {
  return (ctx: DriverContext): Driver => {
    let h: BeginnerHand | null = null;
    let stage = -1;
    return {
      next: (s, _n, session) => {
        const si = session.stageIndex;
        const p = plan(si, s, session);
        if (!h || si !== stage) {
          const yaw = h?.yaw ?? (ctx.spawn.yaw * Math.PI) / 180;
          h = new BeginnerHand(ctx.cfg, { ...model, pattern: p.pattern }, { seed: ctx.seed * 31 + Math.max(0, si), heading: yaw, side: p.side, goal: p.goal ?? null });
          h.yaw = yaw;
          stage = si;
        }
        else if (h.handModel.pattern !== p.pattern) h.setModel({ ...model, pattern: p.pattern });
        if (p.goal !== undefined) h.goal = p.goal;
        return h.next(s);
      },
    };
  };
}

/** Wegpunkte im Kreis abfahren (Oval): Ziel wechselt, sobald man näher als `reach` ist. */
export function waypointGoal(points: readonly Point2[], reach: number): (s: PlayerSnapshot) => Point2 {
  let i = 0;
  let started = false;
  return (s) => {
    if (!started) {
      // Nächsten Wegpunkt vor dem Start wählen.
      let best = 0;
      let bd = Infinity;
      points.forEach((p, k) => {
        const d = Math.hypot(p.x - s.pos.x, p.z - s.pos.z);
        if (d < bd) {
          bd = d;
          best = k;
        }
      });
      i = best + 1;
      started = true;
    }
    const g = points[i % points.length];
    if (Math.hypot(g.x - s.pos.x, g.z - s.pos.z) < reach) i++;
    return points[i % points.length];
  };
}

/** Vorführung der Stufe (DemoDef) — dieselbe Fabrik wie im Spiel (engine/Training.createDemo). */
export function demo() {
  return (ctx: DriverContext): Driver => {
    let runner: ReturnType<typeof createDemo> | null = null;
    let stage = -1;
    return {
      next: (s, n, session) => {
        const st = session.stage;
        if (!st?.demo) return NO_INPUT;
        if (!runner || session.stageIndex !== stage) {
          runner = createDemo(st.demo, ctx.level, ctx.cfg, ctx.world, session.respawnPoint());
          stage = session.stageIndex;
        }
        return runner.next(s, n);
      },
    };
  };
}

/**
 * Rutscher (T1): läuft mit Sprint aufs Ziel zu und hält C ab `duck` u vor dem Tunnel-Eingang
 * (gleichverteilt im Band, ein Mensch drückt mal früh, mal spät), bis er durch ist.
 */
export function slider(target: Point2, entrance: Point2, band: readonly [number, number], releaseAfter: Point2 | null = null) {
  return (ctx: DriverContext): Driver => {
    const rand = mulberry32(ctx.seed * 131 + 5);
    const at = band[0] + rand() * (band[1] - band[0]);
    const out: MutablePlayerInput = { ...NO_INPUT };
    let ducking = false;
    return {
      next: (s) => {
        out.yaw = yawOf(target.x - s.pos.x, target.z - s.pos.z);
        out.forward = 1;
        out.sprint = true;
        out.jumpHeld = false;
        out.jumpPressed = false;
        const d = Math.hypot(entrance.x - s.pos.x, entrance.z - s.pos.z);
        if (!ducking && d <= at) ducking = true;
        if (ducking && releaseAfter && Math.hypot(releaseAfter.x - s.pos.x, releaseAfter.z - s.pos.z) < 48) ducking = false;
        out.crouch = ducking;
        return out;
      },
    };
  };
}

/**
 * Mensch an Crouch-Kanten (T6): läuft mit Sprint Richtung −Z auf die nächste Wand zu, springt irgendwo im
 * Absprung-Band davor und duckt nach `duck` s in der Luft (null = nie; preDuck = C schon am Boden). Nach
 * einem Fehlversuch (unten gelandet) läuft er zurück (höchstens `backDist` u vor die Wand, auf einer Treppe
 * nicht über die Stufe hinaus) und versucht es neu. `walls` aufsteigend: jede Wand mit der Oberkante dahinter.
 */
export function crouchHand(walls: readonly { readonly z: number; readonly top: number }[], backDist: number, band: readonly [number, number], duck: readonly [number, number] | null, preDuck = false) {
  return (ctx: DriverContext): Driver => {
    const rand = mulberry32(ctx.seed * 101 + 7);
    const out: MutablePlayerInput = { ...NO_INPUT };
    let jumpAt = 0;
    let duckAfter = 0;
    let airT = 0;
    let phase: 'run' | 'air' | 'back' = 'run';
    let backT = 0;
    let takeoffY = 0;
    const plan = (): void => {
      jumpAt = band[0] + rand() * (band[1] - band[0]);
      duckAfter = duck ? duck[0] + rand() * (duck[1] - duck[0]) : Infinity;
    };
    plan();
    return {
      next: (s) => {
        out.pitch = 0;
        out.sprint = true;
        out.side = 0;
        // Nächste Wand = die erste, deren Oberkante über den Füßen liegt (auch nach einem Sturz eine Stufe tiefer).
        let wall = walls.length - 1;
        for (let i = 0; i < walls.length; i++) {
          if (s.pos.y < walls[i].top - 1) {
            wall = i;
            break;
          }
        }
        const w = walls[wall];
        const dist = s.pos.z - w.z;
        if (phase === 'back') {
          backT += 1 / ctx.cfg.tickRate;
          out.yaw = Math.PI;
          out.forward = 1;
          out.jumpHeld = false;
          out.jumpPressed = false;
          out.crouch = false;
          if (dist > backDist || backT > 6) {
            phase = 'run';
            plan();
          }
          return out;
        }
        out.yaw = 0;
        out.forward = 1;
        if (phase === 'run') {
          out.crouch = preDuck && dist < jumpAt + 80;
          const jump = s.onGround && dist > 0 && dist <= jumpAt;
          out.jumpHeld = jump;
          out.jumpPressed = jump;
          if (jump) {
            phase = 'air';
            airT = 0;
            takeoffY = s.pos.y;
          }
        } else {
          airT += 1 / ctx.cfg.tickRate;
          out.jumpHeld = false;
          out.jumpPressed = false;
          out.crouch = preDuck || airT >= duckAfter;
          if (s.onGround && airT > 0.1) {
            if (s.pos.y >= takeoffY + 20) {
              phase = 'run';
              plan();
            } else {
              phase = 'back';
              backT = 0;
            }
          }
        }
        return out;
      },
    };
  };
}

/**
 * Surfer (T7/T8): die SurfHand aus src/player/bots/BeginnerHand (dieselbe wie in der Vorführung) mit Zielfehler
 * σ `noiseDeg`, Reaktion `react` s nach dem ersten Kontakt und festem Blickfehler `biasDeg` (> 0 = in die Rampe).
 * Steht er unten in der Grube (Füße unter `pitY`, 0.5 s am Boden), drückt er F.
 */
export function surfHand(mode: SurfMode, noiseDeg: number, react: number, pitY: number, biasDeg = 0) {
  return (ctx: DriverContext): RespawningDriver => {
    const hand = new SurfHand(ctx.cfg, { seed: ctx.seed, mode, noiseDeg, react, biasDeg, heading: (ctx.spawn.yaw * Math.PI) / 180 });
    const dt = 1 / ctx.cfg.tickRate;
    let pit = 0;
    return {
      wantsRespawn: () => pit > 0.5,
      onRespawn: () => {
        pit = 0;
        hand.reset();
      },
      next: (s, n) => {
        if (s.onGround && s.pos.y < pitY) pit += dt;
        return hand.next(s, n);
      },
    };
  };
}

/**
 * Prestrafe (T4-Bonus): am Boden W + A, Blick so nachgeführt, dass die Wunschrichtung (45° links vom
 * Blick) im Beschleunigungs-Optimum zur Fahrt liegt — mit Zielrauschen σ `noiseDeg` wie eine Hand.
 * `startTurnAfter` s geradeaus anlaufen, dann einlenken. Springt nie.
 */
export function prestrafe(noiseDeg: number, startTurnAfter = 0.4) {
  return (ctx: DriverContext): Driver => {
    const rand = mulberry32(ctx.seed * 613 + 11);
    const out: MutablePlayerInput = { ...NO_INPUT };
    const cfg: MovementConfig = ctx.cfg;
    const dt = 1 / cfg.tickRate;
    let t = 0;
    let aim = 0;
    let yaw = (ctx.spawn.yaw * Math.PI) / 180;
    return {
      next: (s) => {
        t += dt;
        out.pitch = 0;
        out.sprint = true;
        out.crouch = false;
        out.jumpHeld = false;
        out.jumpPressed = false;
        out.forward = 1;
        const k = Math.exp(-dt / 0.15);
        aim = aim * k + gaussian(rand) * noiseDeg * DEG * Math.sqrt(1 - k * k);
        if (t < startTurnAfter || s.speed < 200) {
          out.side = 0;
          out.yaw = yaw;
          return out;
        }
        out.side = -1;
        // Wunschrichtung θ links von der Fahrt: cos θ = wish·(1 − accel·dt)/|v| (Boden-Accelerate-Optimum).
        const wish = cfg.sprintSpeed;
        const c = Math.min(1, (wish * (1 - cfg.accelerate * dt)) / Math.max(1, s.speed));
        const theta = Math.acos(c);
        const velYaw = Math.atan2(-s.vel.x, -s.vel.z);
        yaw = velYaw + theta - 45 * DEG + aim;
        out.yaw = yaw;
        return out;
      },
    };
  };
}

/**
 * Prestrafe wie ein Mensch (T4-Bonus): läuft `runUp` s mit W an, dann W + A und dreht die Maus mit
 * konstanter Rate nach links (lognormal gestreut je Versuch). Gemessen (flach, finale Physik): 150–300 °/s
 * tragen über 350 u/s, 120 °/s knapp nicht, ab 360 °/s überdreht.
 */
export function prestrafeRate(rateDeg: number, jitter = 0.15, runUp = 0.5) {
  return (ctx: DriverContext): Driver => {
    const rand = mulberry32(ctx.seed * 389 + 13);
    const rate = rateDeg * DEG * Math.exp(gaussian(rand) * jitter);
    const out: MutablePlayerInput = { ...NO_INPUT };
    const dt = 1 / ctx.cfg.tickRate;
    let t = 0;
    let yaw = (ctx.spawn.yaw * Math.PI) / 180;
    return {
      next: () => {
        t += dt;
        out.pitch = 0;
        out.sprint = true;
        out.crouch = false;
        out.jumpHeld = false;
        out.jumpPressed = false;
        out.forward = 1;
        out.side = t > runUp ? -1 : 0;
        if (t > runUp) yaw += rate * dt;
        out.yaw = yaw;
        return out;
      },
    };
  };
}

/**
 * Rückwärts-Strafer (Fehlerbild "Taste gegen die Maus", konsequent durchgezogen): hält A (key −1) bzw. D und die
 * Leertaste, dreht die Maus mit konstanter Rate GEGEN die Taste, W nur am Boden. Der Flug dreht sich dabei nach hinten —
 * er gewinnt Tempo rückwärts (T4 v400 in 3 s, jeder Hop "FALSCHE SEITE"). Die BeginnerHand 'gegen' blickt am Boden
 * wieder nach vorn und zeigt das nie. Rate je Seed lognormal gestreut (σ 0.2), Anfangsblick ±15°.
 */
export function backStrafe(rateDeg: number, key: -1 | 1 = -1) {
  return (ctx: DriverContext): Driver => {
    const rand = mulberry32(ctx.seed * 211 + 3);
    const rate = key * rateDeg * DEG * Math.exp(gaussian(rand) * 0.2);
    const out: MutablePlayerInput = { ...NO_INPUT };
    const dt = 1 / ctx.cfg.tickRate;
    let yaw = (ctx.spawn.yaw * Math.PI) / 180 + (rand() - 0.5) * 30 * DEG;
    let first = true;
    return {
      next: (s) => {
        yaw += rate * dt;
        out.yaw = yaw;
        out.pitch = 0;
        out.side = key;
        out.forward = s.onGround ? 1 : 0;
        out.sprint = true;
        out.crouch = false;
        out.jumpHeld = true;
        out.jumpPressed = first;
        first = false;
        return out;
      },
    };
  };
}

/** Punkt (XZ) aus Weltkoordinaten. */
export function p2(x: number, z: number): Point2 {
  return { x, z };
}

/** Kursabweichung (Grad) zwischen Flugrichtung und Ziel — für Berichte. */
export function headingError(s: PlayerSnapshot, target: Point2): number {
  const psi = Math.atan2(-s.vel.x, -s.vel.z);
  return wrapAngle(psi - yawOf(target.x - s.pos.x, target.z - s.pos.z)) / DEG;
}

