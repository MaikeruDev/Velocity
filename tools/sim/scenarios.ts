import { Vector3 } from 'three';
import type { MovementConfig } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import type { Bot } from '../../src/player/bots';
import { NaiveBot, StrafeBot } from '../../src/player/bots';
import { compileLevel, type CompiledLevel } from '../../src/world/level/compileLevel';
import { box, flatLevel, makeLevel } from './levels';
import { makeInput } from './harness';

/** Welten werden einmal kompiliert und von allen Szenarien geteilt. */
let flat: CompiledLevel | null = null;
let pad: CompiledLevel | null = null;
let surf: CompiledLevel | null = null;

export function flatWorld(): CompiledLevel {
  return (flat ??= compileLevel(flatLevel()));
}

/** Kleiner Absprung-Klotz (Oberkante y = 0) über dem Nichts — für Sprungweiten. */
function padWorld(): CompiledLevel {
  return (pad ??= compileLevel(makeLevel([box([-24, -64, -24], [24, 0, 24], 'pad')])));
}

/**
 * Lange Surf-Rampe entlang -Z: Dreiecksprofil, Flanken mit normal.y ≈ 0.54
 * (wie die Sandbox), 4096 u hoch, 12000 u lang.
 */
export function surfWorld(): CompiledLevel {
  return (surf ??= compileLevel(makeLevel([
    { type: 'prism', axis: 'z', from: -12000, to: 0, profile: [[-2624, -4096], [2624, -4096], [0, 0]], mat: 'surf', tag: 'surf' },
  ])));
}

/**
 * sync85/sync70: Fehler relativ zum Gewinnfenster (HUD-Sync nachstellen).
 * aim1…aim4 / rate150 / rate250: absolutes Menschenmodell (Winkelfehler in
 * Grad bzw. konstante Drehrate) — nur damit lassen sich airSpeedCap-Werte
 * oder Presets fair vergleichen.
 */
export type BotKind = 'perfect' | 'sync85' | 'sync70' | 'human' | 'aim1' | 'aim2' | 'aim3' | 'aim4' | 'rate150' | 'rate250' | 'naive';

export const BOT_LABELS: Record<BotKind, string> = {
  perfect: 'Strafe 1.0',
  sync85: 'Strafe 0.85',
  sync70: 'Strafe 0.7',
  human: 'Strafe 1.0 @300°/s',
  aim1: 'Zielfehler 1°',
  aim2: 'Zielfehler 2°',
  aim3: 'Zielfehler 3°',
  aim4: 'Zielfehler 4°',
  rate150: 'konst. 150°/s',
  rate250: 'konst. 250°/s',
  naive: 'Naive (W)',
};

/** Bots mit Zufall — werden über mehrere Seeds gemittelt. */
const NOISY: ReadonlySet<BotKind> = new Set<BotKind>(['sync85', 'sync70', 'aim1', 'aim2', 'aim3', 'aim4']);

export function makeBot(kind: BotKind, cfg: MovementConfig, seed = 7): Bot {
  switch (kind) {
    case 'perfect':
      return new StrafeBot(cfg, { sync: 1, heading: 0 });
    case 'sync85':
      return new StrafeBot(cfg, { sync: 0.85, seed, heading: 0 });
    case 'sync70':
      return new StrafeBot(cfg, { sync: 0.7, seed, heading: 0 });
    case 'human':
      return new StrafeBot(cfg, { sync: 1, heading: 0, maxTurnRate: 300 });
    case 'aim1':
    case 'aim2':
    case 'aim3':
    case 'aim4':
      return new StrafeBot(cfg, { aimNoiseDeg: Number(kind.slice(3)), seed, heading: 0 });
    case 'rate150':
      return new StrafeBot(cfg, { turnRateDeg: 150, heading: 0 });
    case 'rate250':
      return new StrafeBot(cfg, { turnRateDeg: 250, heading: 0 });
    case 'naive':
      return new NaiveBot(cfg, { heading: 0 });
  }
}

export interface HopRun {
  /** Horizontal-Speed bei Landung nach Hop 1..n. */
  readonly landSpeeds: number[];
  /** Mittlerer Sync (Gewinn-Ticks / Strafe-Ticks) über alle Luftabschnitte. */
  readonly avgSync: number;
  /** Nach 10 s: Luftlinie, Weg, Endgeschwindigkeit. */
  readonly dist10: number;
  readonly path10: number;
  readonly speed10: number;
}

/**
 * Flacher Boden, Start mit runSpeed Richtung -Z am Boden, Sprung gehalten.
 * Mehrere Seeds für die unsauberen Bots, gemittelt.
 */
export function hopRun(cfg: MovementConfig, kind: BotKind, hops = 20, seeds = NOISY.has(kind) ? 5 : 1): HopRun {
  const acc: HopRun[] = [];
  for (let seed = 1; seed <= seeds; seed++) acc.push(hopRunOnce(cfg, makeBot(kind, cfg, seed * 7919), hops));
  const n = acc.length;
  const landSpeeds: number[] = [];
  for (let i = 0; i < hops; i++) landSpeeds.push(acc.reduce((s, r) => s + (r.landSpeeds[i] ?? Number.NaN), 0) / n);
  return {
    landSpeeds,
    avgSync: acc.reduce((s, r) => s + r.avgSync, 0) / n,
    dist10: acc.reduce((s, r) => s + r.dist10, 0) / n,
    path10: acc.reduce((s, r) => s + r.path10, 0) / n,
    speed10: acc.reduce((s, r) => s + r.speed10, 0) / n,
  };
}

function hopRunOnce(cfg: MovementConfig, bot: Bot, hops: number): HopRun {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  const start = new Vector3(0, 0, 12000);
  pm.teleport(start);
  pm.state.vel.set(0, 0, -cfg.runSpeed);
  const landSpeeds: number[] = [];
  let syncSum = 0;
  let syncN = 0;
  let dist10 = 0;
  let path10 = 0;
  let speed10 = 0;
  const tenSec = Math.round(10 * cfg.tickRate);
  const maxTicks = Math.max(tenSec, Math.round(hops * 1.2 * cfg.tickRate)) + 1;
  let px = start.x;
  let pz = start.z;
  for (let t = 1; t <= maxTicks; t++) {
    const ev = pm.tick(bot.next(pm.state));
    for (const e of ev) {
      if (e.type === 'land' && landSpeeds.length < hops) landSpeeds.push(e.speed);
      if (e.type === 'jump' && e.chain > 1) {
        syncSum += e.sync;
        syncN++;
      }
    }
    const s = pm.state.pos;
    if (t <= tenSec) path10 += Math.hypot(s.x - px, s.z - pz);
    px = s.x;
    pz = s.z;
    if (t === tenSec) {
      dist10 = Math.hypot(s.x - start.x, s.z - start.z);
      speed10 = pm.state.speed;
    }
    if (t >= tenSec && landSpeeds.length >= hops) break;
  }
  return { landSpeeds, avgSync: syncN > 0 ? syncSum / syncN : 0, dist10, path10, speed10 };
}

export interface JumpCell {
  /** Horizontale Flugweite (Origin) bis die Füße auf Höhe h sind; null = unerreichbar. */
  readonly dist: number | null;
}

/**
 * Ballistischer Sprung ohne Luft-Eingabe: Absprung mit `speed` am Boden,
 * Distanz bis die Füße beim Fallen die Höhe `h` (relativ zum Absprung) kreuzen.
 * `crouch`: im Absprung-Tick Ducken drücken und halten (Füße +18 u in der Luft).
 */
export function jumpDistance(cfg: MovementConfig, speed: number, h: number, crouch: boolean): number | null {
  const pm = new PlayerMovement(padWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 0));
  pm.state.vel.set(0, 0, -speed);
  const x0 = pm.state.pos.x;
  const z0 = pm.state.pos.z;
  const first = makeInput({ jumpPressed: true, jumpHeld: true, crouch });
  const rest = makeInput({ crouch });
  let prevY = pm.state.pos.y;
  let prevD = 0;
  let jumped = false;
  for (let t = 0; t < 10 * cfg.tickRate; t++) {
    const ev = pm.tick(t === 0 ? first : rest);
    for (const e of ev) if (e.type === 'jump') jumped = true;
    if (!jumped) return null;
    const y = pm.state.pos.y;
    const d = Math.hypot(pm.state.pos.x - x0, pm.state.pos.z - z0);
    if (pm.state.vel.y < 0 && prevY >= h && y < h) {
      const f = (prevY - h) / (prevY - y);
      return prevD + (d - prevD) * f;
    }
    if (y < h - 2000) return null;
    prevY = y;
    prevD = d;
  }
  return null;
}

export interface StandingHop {
  /** Luftlinie nach 2 s (u). */
  readonly dist2: number;
  /** Horizontal-Speed nach 2 s (Dauertempo der Hop-Kette). */
  readonly speed2: number;
  /** Zeitpunkt des ersten Sprungs (s). */
  readonly firstJump: number;
  readonly jumps: number;
}

/**
 * Naive aus dem Stand: W + Sprung ab t = 0 gehalten, flach, 2 s. `press`:
 * Sprung bei t = 0 frisch gedrückt (sonst Tasten schon gehalten, wie nach
 * einem Respawn). Deckt den blinden Fleck "Naive = 250 nur ab 250 u/s" ab.
 */
export function standingHop(cfg: MovementConfig, sprint: boolean, press: boolean): StandingHop {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 0));
  const held = makeInput({ forward: 1, jumpHeld: true, sprint });
  const first = makeInput({ forward: 1, jumpHeld: true, jumpPressed: press, sprint });
  const n = Math.round(2 * cfg.tickRate);
  let firstJump = Number.NaN;
  let jumps = 0;
  for (let t = 0; t < n; t++) {
    for (const e of pm.tick(t === 0 ? first : held)) {
      if (e.type !== 'jump') continue;
      jumps++;
      if (Number.isNaN(firstJump)) firstJump = t / cfg.tickRate;
    }
  }
  return { dist2: Math.hypot(pm.state.pos.x, pm.state.pos.z), speed2: pm.state.speed, firstJump, jumps };
}

export interface GroundStats {
  readonly toRun: number;
  readonly toSprint: number;
  readonly stopRunTo10: number;
  readonly stopRunTo0: number;
  readonly stopRunDist: number;
  readonly stopSprintTo10: number;
  readonly duckSpeed: number;
  readonly jumpHeight: number;
  readonly crouchJumpFeet: number;
  readonly airTime: number;
}

function timeUntil(pm: PlayerMovement, input: ReturnType<typeof makeInput>, pred: () => boolean, maxTicks: number): number {
  for (let t = 1; t <= maxTicks; t++) {
    pm.tick(input);
    if (pred()) return t / pm.config.tickRate;
  }
  return Number.NaN;
}

export function groundStats(cfg: MovementConfig): GroundStats {
  const world = flatWorld().world;
  const max = 5 * cfg.tickRate;
  const w = makeInput({ forward: 1 });
  const ws = makeInput({ forward: 1, sprint: true });
  const none = makeInput();

  const pm = new PlayerMovement(world, cfg);
  pm.teleport(new Vector3(0, 0, 0));
  const toRun = timeUntil(pm, w, () => pm.state.speed >= cfg.runSpeed - 0.5, max);
  for (let i = 0; i < cfg.tickRate; i++) pm.tick(w);
  const z0 = pm.state.pos.z;
  const stopRunTo10 = timeUntil(pm, none, () => pm.state.speed < 10, max);
  const rest = timeUntil(pm, none, () => pm.state.speed === 0, max);
  const stopRunTo0 = stopRunTo10 + rest;
  const stopRunDist = Math.abs(pm.state.pos.z - z0);

  const pm2 = new PlayerMovement(world, cfg);
  pm2.teleport(new Vector3(0, 0, 0));
  const toSprint = timeUntil(pm2, ws, () => pm2.state.speed >= cfg.sprintSpeed - 0.5, max);
  for (let i = 0; i < cfg.tickRate; i++) pm2.tick(ws);
  const stopSprintTo10 = timeUntil(pm2, none, () => pm2.state.speed < 10, max);

  const pm3 = new PlayerMovement(world, cfg);
  pm3.teleport(new Vector3(0, 0, 0));
  const duckW = makeInput({ forward: 1, crouch: true });
  for (let i = 0; i < 2 * cfg.tickRate; i++) pm3.tick(duckW);
  const duckSpeed = pm3.state.speed;

  // Sprunghöhe / Luftzeit / Crouch-Jump-Füße
  const pm4 = new PlayerMovement(world, cfg);
  pm4.teleport(new Vector3(0, 0, 0));
  const y0 = pm4.state.pos.y;
  let top = 0;
  let air = 0;
  pm4.tick(makeInput({ jumpPressed: true, jumpHeld: true }));
  for (let i = 0; i < 3 * cfg.tickRate; i++) {
    const ev = pm4.tick(none);
    top = Math.max(top, pm4.state.pos.y - y0);
    const land = ev.find((e) => e.type === 'land');
    if (land && land.type === 'land') {
      air = land.airTime;
      break;
    }
  }
  const pm5 = new PlayerMovement(padWorld().world, cfg);
  pm5.teleport(new Vector3(0, 0, 0));
  const y5 = pm5.state.pos.y;
  let feet = 0;
  pm5.tick(makeInput({ jumpPressed: true, jumpHeld: true, crouch: true }));
  for (let i = 0; i < cfg.tickRate; i++) {
    pm5.tick(makeInput({ crouch: true }));
    feet = Math.max(feet, pm5.state.pos.y - y5);
  }
  return { toRun, toSprint, stopRunTo10, stopRunTo0, stopRunDist, stopSprintTo10, duckSpeed, jumpHeight: top, crouchJumpFeet: feet, airTime: air };
}

export interface SurfRun {
  /** 3D-Speed nach 1/2/3 s. */
  readonly speeds: number[];
  readonly onRampAtEnd: boolean;
  /** Höhenverlust in u (positiv = runter). */
  readonly drop: number;
}

/**
 * Surf: über der rechten Flanke absetzen (in der Luft, 400 u/s entlang -Z).
 * holdKey: Taste in die Rampe (A), Blick entlang der Rampe — sonst ohne Eingabe gleiten.
 */
export function surfRun(cfg: MovementConfig, holdKey: boolean): SurfRun {
  const pm = new PlayerMovement(surfWorld().world, cfg);
  // Rechte Flanke: von (0,0) nach (2624,-4096) → über x = 200 liegt sie bei y ≈ -312.
  pm.teleport(new Vector3(200, -250, -200));
  pm.state.vel.set(0, 0, -400);
  const input = makeInput({ side: holdKey ? -1 : 0, yaw: 0 });
  const speeds: number[] = [];
  const y0 = pm.state.pos.y;
  for (let t = 1; t <= 3 * cfg.tickRate; t++) {
    pm.tick(input);
    if (t % cfg.tickRate === 0) speeds.push(Math.hypot(pm.state.vel.x, pm.state.vel.y, pm.state.vel.z));
  }
  return { speeds, onRampAtEnd: pm.state.surfing, drop: y0 - pm.state.pos.y };
}
