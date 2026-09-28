/**
 * Arcade-Pass (Plan 007, A1–A8): Abnahme-Messungen gegen die echte Engine — je Mechanik
 * "aus" (Schalter 0) gegen "an" (Preset). Teil von `npm run sim` (Abschnitt "Arcade"),
 * einzeln: `npm run sim -- --section arcade`.
 *
 * Die Zahlen entsprechen den Abnahmen des Strangs movement in Plan 007 §6; movement-tuning.md
 * ("Arcade-Pass") zitiert sie. Kein Bot baut eine Mechanik nach (fallen.md #21) — alles läuft
 * durch PlayerMovement.
 */
import { Box3, Vector3 } from 'three';
import { withMovement, type MovementConfig } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { StrafeBot, mulberry32 } from '../../src/player/bots';
import { gaussian } from '../../src/player/bots/Bot';
import type { MovementEvent, PlayerInput } from '../../src/player/types';
import type { BrushDef } from '../../src/world/level/LevelFormat';
import { compileLevel, type CompiledLevel } from '../../src/world/level/compileLevel';
import { makeInput } from './harness';
import { box, makeLevel, readLevelFile } from './levels';
import { flatWorld, surfWorld } from './scenarios';

const DEG = Math.PI / 180;
const f0 = (v: number): string => (Number.isFinite(v) ? v.toFixed(0) : '–');
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '–');
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '–');
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '–');

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return Number.NaN;
  return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

function level(brushes: BrushDef[], killY = -4000): CompiledLevel {
  return compileLevel(makeLevel(brushes, { killY }));
}

function pmAt(lv: CompiledLevel, cfg: MovementConfig, pos: Vector3, vel?: Vector3): PlayerMovement {
  const pm = new PlayerMovement(lv.world, cfg);
  if (vel) pm.state.vel.copy(vel);
  pm.teleport(pos, { keepVelocity: vel !== undefined });
  return pm;
}

// ================================================================== Lande-Gnade (A3)

/** Knapp über dem Boden hochgeworfen (≥ 0.1 s Luft), landet mit v Richtung −z. */
function lander(cfg: MovementConfig, v: number): PlayerMovement {
  return pmAt(flatWorld(), cfg, new Vector3(0, 30, 0), new Vector3(0, 200, -v));
}

/** Absprungtempo, wenn der Sprung k Ticks nach dem Lande-Tick gedrückt wird (k = 0: perfekt). */
export function lateJump(cfg: MovementConfig, v: number, k: number): { speed: number; clean: boolean } {
  const pm = lander(cfg, v);
  let landTick = -1;
  for (let t = 0; t < 3 * cfg.tickRate; t++) {
    const press = landTick >= 0 && t === landTick + 1 + k;
    for (const e of pm.tick(makeInput({ yaw: 0, jumpPressed: press, jumpHeld: press }))) {
      if (e.type === 'land' && landTick < 0) landTick = t;
      if (e.type === 'jump') return { speed: e.speed, clean: e.clean };
    }
  }
  return { speed: Number.NaN, clean: false };
}

/** Landung mit 500, n Bodenticks optimaler Ground-Strafe (W+D, Sprint), dann Sprung. */
export function groundStrafeExploit(cfg: MovementConfig, v: number, n: number): number {
  const pm = lander(cfg, v);
  const tr = cfg.tickRate;
  const wish = cfg.sprintSpeed;
  const a = (cfg.accelerate * wish) / tr;
  let landTick = -1;
  for (let t = 0; t < 3 * tr; t++) {
    const s = pm.state;
    const onG = s.onGround && landTick >= 0;
    const jump = onG && t - landTick - 1 >= n;
    // Winkel θ zwischen v und wishdir mit v·cosθ = wish − a; Blick = wishdir + 45° (W+D).
    const velYaw = Math.atan2(-s.vel.x, -s.vel.z);
    const theta = Math.acos(Math.min(1, Math.max(-1, (wish - a) / Math.max(s.speed, 1))));
    const yaw = velYaw - theta + Math.PI / 4;
    const inp = landTick < 0 ? makeInput({ yaw: 0 }) : makeInput({ yaw, forward: 1, side: 1, sprint: true, jumpPressed: jump, jumpHeld: jump });
    for (const e of pm.tick(inp)) {
      if (e.type === 'land' && landTick < 0) landTick = t;
      if (e.type === 'jump') return e.speed;
    }
  }
  return Number.NaN;
}

/** Tipp-Hand: perfekter Luft-Strafe, Sprung mit Timing-Rauschen μ ± σ ms um die Landung. Landetempo je Hop. */
export function tapHand(cfg: MovementConfig, muMs: number, sigmaMs: number, seed: number, hops: number): number[] {
  const tr = cfg.tickRate;
  const pm = pmAt(flatWorld(), cfg, new Vector3(0, 0, 15000), new Vector3(0, 0, -320));
  const bot = new StrafeBot(cfg, { heading: 0 });
  const rand = mulberry32(seed);
  let pressAt = 0;
  const lands: number[] = [];
  for (let t = 0; t < (hops + 2) * 1.2 * tr && lands.length < hops; t++) {
    const inp = bot.next(pm.state);
    for (const e of pm.tick({ ...inp, jumpHeld: false, jumpPressed: t === pressAt })) {
      if (e.type === 'jump') {
        // Flach: Luftzeit ≈ 0.75 s → Lande-Tick ≈ Absprung + 96.
        const land = t + Math.round(0.7505 * tr);
        pressAt = Math.max(t + 1, land + 1 + Math.round(((muMs + sigmaMs * gaussian(rand)) / 1000) * tr));
      }
      if (e.type === 'land') lands.push(e.speed);
    }
    // Zu früh gedrückt, Puffer abgelaufen: nächster Druck nach Reaktionszeit.
    if (pm.state.onGround && t > pressAt) pressAt = t + 1 + Math.round(((muMs + 60) / 1000) * tr);
  }
  return lands;
}

function graceSection(cfg: MovementConfig): string {
  const off = withMovement(cfg, { landGraceTime: 0 });
  const ks = [0, 1, 2, 4, 8, 9, 12];
  const rows: string[][] = [];
  let maxDev = 0;
  let k9Err = 0;
  for (const v of [400, 700, 1000]) {
    for (const [name, c] of [['aus', off], ['an', cfg]] as const) {
      rows.push([String(v), name, ...ks.map((k) => f0(lateJump(c, v, k).speed))]);
    }
    for (let k = 1; k <= 8; k++) maxDev = Math.max(maxDev, Math.abs(lateJump(cfg, v, k).speed - v));
    const k9 = lateJump(cfg, v, 9).speed;
    k9Err = Math.max(k9Err, Math.abs(v - k9 - (v * cfg.friction) / cfg.tickRate));
  }
  const tap = (c: MovementConfig): string => {
    const h: number[][] = [[], [], []];
    for (let seed = 1; seed <= 8; seed++) {
      const l = tapHand(c, 0, 20, seed * 101, 20);
      h[0].push(l[4] ?? 0);
      h[1].push(l[9] ?? 0);
      h[2].push(l[19] ?? 0);
    }
    return h.map((xs) => f0(median(xs))).join(' / ');
  };
  const out: string[] = [];
  out.push('### Lande-Gnade (A3, landGraceTime)\n');
  out.push(`Später Sprung: Absprungtempo, wenn der Druck k Ticks nach dem Lande-Tick kommt (k = 0 perfekt). Gnade: k = 1…8 max. Abweichung ${f3(maxDev)} u/s vom Landetempo; k = 9 weicht ${f3(k9Err)} u/s von genau einem Friction-Tick (v·${cfg.friction}/${cfg.tickRate}) ab.\n`);
  out.push(table(['v', 'Gnade', ...ks.map((k) => `k=${k}`)], rows));
  out.push('');
  out.push(table(['Messung', 'aus', 'an'], [
    ['Tipp-Hand ±20 ms (perfekter Strafe): H5 / H10 / H20, Median 8 Seeds', tap(off), tap(cfg)],
    ['Exploit: Landung 500, 8 Ticks Ground-Strafe W+D, Sprung', f1(groundStrafeExploit(off, 500, 8)), f1(groundStrafeExploit(cfg, 500, 8))],
    ['dto. 16 Ticks', f1(groundStrafeExploit(off, 500, 16)), f1(groundStrafeExploit(cfg, 500, 16))],
  ]));
  return out.join('\n');
}

// ================================================================== Hang-Landung (A4)

const slopeCache = new Map<string, CompiledLevel>();
/** Gefälle: y(z) = z·tanθ für z ∈ [−len, 0] (bergab Richtung −z), davor/dahinter flach. */
function slopeWorld(deg: number, len = 12000): CompiledLevel {
  const key = `${deg}|${len}`;
  let c = slopeCache.get(key);
  if (!c) {
    const low = -len * Math.tan(deg * DEG);
    c = level([
      { type: 'wedge', min: [-4096, low - 64, -len], max: [4096, 0, 0], rise: '+z', lowY: low, mat: 'floor' },
      box([-4096, low - 64, -len - 16384], [4096, low, -len]),
      box([-4096, -64, 0], [4096, 0, 16384]),
    ], low - 4000);
    slopeCache.set(key, c);
  }
  return c;
}

function slopeY(deg: number, z: number, len = 12000): number {
  if (z >= 0) return 0;
  if (z <= -len) return -len * Math.tan(deg * DEG);
  return z * Math.tan(deg * DEG);
}

/** Einzel-Landung: h u über der Fläche, horizontal v (dir −1 bergab, +1 bergauf), Phase 0..1 eines Fall-Ticks. */
export function slopeLanding(cfg: MovementConfig, deg: number, v: number, h: number, dir: -1 | 1, phase: number): number {
  const lv = slopeWorld(deg);
  const z0 = -3000;
  const step = Math.sqrt(2 * cfg.gravity * h) / cfg.tickRate;
  const pm = pmAt(lv, cfg, new Vector3(0, slopeY(deg, z0) + h + phase * step, z0), new Vector3(0, 0, dir * v));
  const inp = makeInput({ yaw: dir < 0 ? 0 : Math.PI });
  for (let t = 0; t < 5 * cfg.tickRate; t++) for (const e of pm.tick(inp)) if (e.type === 'land') return e.speed;
  return Number.NaN;
}

/** Hop-Kette bergab (W + Leertaste gehalten), Tempo nach `dist` u Hangstrecke. */
export function slopeChain(cfg: MovementConfig, deg: number, v0: number, dist: number): number {
  const lv = slopeWorld(deg);
  const z0 = -200;
  const pm = pmAt(lv, cfg, new Vector3(0, slopeY(deg, z0) + 2, z0), new Vector3(0, 0, -v0));
  for (let t = 0; t < 30 * cfg.tickRate; t++) {
    pm.tick(makeInput({ forward: 1, sprint: true, jumpHeld: true, jumpPressed: t === 0, yaw: 0 }));
    if (pm.state.pos.z < z0 - dist) break;
  }
  return pm.state.speed;
}

const hillCache = new Map<string, CompiledLevel>();
/** Wellen quer zur Laufrichtung (−z): Prismen deg° steil, `period` u lang, dazwischen `flat` u eben, genug für `dist` u. */
function hillWorld(deg: number, period: number, flat: number, dist: number): CompiledLevel {
  const n = Math.ceil(dist / (period + flat)) + 2;
  const key = `${deg}|${period}|${flat}|${n}`;
  let c = hillCache.get(key);
  if (!c) {
    const h = (period / 2) * Math.tan(deg * DEG);
    const brushes: BrushDef[] = [box([-4096, -64, -(period + flat) * n - 4096], [4096, 0, 4096])];
    for (let i = 0; i < n; i++) {
      const z0 = -i * (period + flat) - 200;
      brushes.push({ type: 'prism', axis: 'x', from: -4096, to: 4096, profile: [[z0, 0], [z0 - period, 0], [z0 - period / 2, h]], mat: 'floor' });
    }
    c = level(brushes);
    hillCache.set(key, c);
  }
  return c;
}

/**
 * Hügel-Pumpe: W + Leertaste gehalten (kein Strafen, kein Ducken) über Wellen ab 320 u/s — Tempo nach
 * je 10 s. Bergauf verlustfrei + bergab Gewinn ohne Verrechnung erntete hier den Sprungimpuls:
 * 10°/1024 320 → 785 u/s in 30 s (Review 28.09.).
 */
export function hillRun(cfg: MovementConfig, deg: number, period: number, seconds = 30, flat = 0): number[] {
  const lv = hillWorld(deg, period, flat, seconds * 1100);
  const pm = pmAt(lv, cfg, new Vector3(0, 0.03125, 0), new Vector3(0, 0, -320));
  const out: number[] = [];
  for (let k = 1; k <= seconds * cfg.tickRate; k++) {
    pm.tick(makeInput({ yaw: 0, forward: 1, sprint: true, jumpHeld: true, jumpPressed: k === 1 }));
    if (k % (10 * cfg.tickRate) === 0) out.push(pm.state.speed);
  }
  return out;
}

function slopeSection(cfg: MovementConfig): string {
  const off = withMovement(cfg, { slopeLandGain: 0 });
  const spread = (c: MovementConfig): { down: number; up: number; slide: number; upLoss: number } => {
    let down = 0;
    let up = 0;
    let slide = 0;
    let upLoss = 0;
    for (const deg of [5, 10, 16, 25, 35]) {
      for (const dir of [-1, 1] as const) {
        for (const v of [320, 600, 1000]) {
          for (const h of [57, 192]) {
            const xs: number[] = [];
            for (let p = 0; p < 16; p++) xs.push(slopeLanding(c, deg, v, h, dir, p / 16));
            const d = Math.max(...xs) - Math.min(...xs);
            const slid = Math.min(...xs) < 0.9 * v;
            if (dir < 0) down = Math.max(down, d);
            else if (slid) slide = Math.max(slide, d);
            else {
              up = Math.max(up, d);
              upLoss = Math.max(upLoss, v - Math.min(...xs));
            }
          }
        }
      }
    }
    return { down, up, slide, upLoss };
  };
  const a = spread(off);
  const b = spread(cfg);
  const chainRows = [5, 10, 16, 25].map((deg) => {
    const cap = Math.hypot(320, Math.sqrt(2 * cfg.gravity * 1500 * Math.tan(deg * DEG)));
    return [`${deg}°`, f0(slopeChain(off, deg, 320, 1500)), f0(slopeChain(cfg, deg, 320, 1500)), f0(cap)];
  });
  const out: string[] = [];
  out.push('### Hang-Landung (A4, slopeLandGain)\n');
  out.push('Einzel-Landungen 5–35°, 320/600/1000 u/s, Fall 57/192 u, je 16 Tick-Phasen: größte Spreizung max − min (u/s). Bergauf-Landungen: größter Verlust gegenüber dem Anflug. Rampslide = Landungen unter 90 % des Anflugs (Fläche zu steil für das Tempo).\n');
  out.push(table(['Messung', 'aus', 'an'], [
    ['bergab: Spreizung über 16 Phasen', f2(a.down), f2(b.down)],
    ['bergauf ohne Rampslide: Spreizung', f2(a.up), f2(b.up)],
    ['bergauf ohne Rampslide: größter Verlust', f1(a.upLoss), f1(b.upLoss)],
    ['Rampslide-Fälle: Spreizung', f2(a.slide), f2(b.slide)],
  ]));
  out.push('\nW + Leertaste gehalten, 1500 u Hang ab 320 u/s (Tempo danach; Energie-Decke √(v0² + 2gΔh)):\n');
  out.push(table(['Gefälle', 'aus', 'an', 'Energie-Decke'], chainRows));
  const hillRows = ([[5, 512, 0], [10, 512, 0], [10, 1024, 0], [15, 768, 0], [10, 1024, 512]] as const).map(([deg, per, flat]) => [
    `${deg}°, Periode ${per} u${flat ? ` + ${flat} u eben` : ''}`,
    hillRun(off, deg, per, 30, flat).map(f0).join(' → '),
    hillRun(cfg, deg, per, 30, flat).map(f0).join(' → '),
  ]);
  out.push('\nHügel-Pumpe: W + Leertaste (kein Strafen) über Wellen ab 320 u/s, Tempo nach 10 / 20 / 30 s. Der erlassene Bergauf-Verlust wird mit dem nächsten Bergab-Gewinn verrechnet (gestundet, höchstens das Tempo über dem Lauftempo) — ohne das stieg es stetig (10°/1024: 785 nach 30 s):\n');
  out.push(table(['Wellen', 'aus', 'an'], hillRows));
  return out.join('\n');
}

// ================================================================== Anfänger-Cap (A5)

/** StrafeBot mit Zielfehler (0 = perfekt) ab v0 flach: Landetempi und Zeit bis 500 u/s. */
export function feelRun(cfg: MovementConfig, aim: number, seed: number, v0: number): { lands: number[]; t500: number } {
  const pm = pmAt(flatWorld(), cfg, new Vector3(0, 0, 14000), new Vector3(0, 0, -v0));
  const bot = new StrafeBot(cfg, aim > 0 ? { heading: 0, aimNoiseDeg: aim, seed: seed * 7919 } : { heading: 0 });
  const lands: number[] = [];
  let t500 = Number.NaN;
  for (let t = 0; t < 30 * cfg.tickRate && lands.length < 20; t++) {
    for (const e of pm.tick(bot.next(pm.state))) if (e.type === 'land') lands.push(e.speed);
    if (Number.isNaN(t500) && pm.state.speed >= 500) t500 = t / cfg.tickRate;
  }
  return { lands, t500 };
}

function capSection(cfg: MovementConfig): string {
  const off = withMovement(cfg, { airSpeedCapLow: 32 });
  const hand = (c: MovementConfig, aim: number): string => {
    const h10: number[] = [];
    const t5: number[] = [];
    let reach = 0;
    for (let s = 1; s <= 8; s++) {
      const r = feelRun(c, aim, s, 320);
      h10.push(r.lands[9] ?? Number.NaN);
      t5.push(Number.isNaN(r.t500) ? 99 : r.t500);
      if (!Number.isNaN(r.t500)) reach++;
    }
    const tm = median(t5);
    return `H10 ${f0(median(h10))} · 500 u/s nach ${tm >= 50 ? '–' : f1(tm)} s (${reach}/8)`;
  };
  const perfect = (c: MovementConfig): string => {
    const l = feelRun(c, 0, 1, c.runSpeed).lands;
    return `${f0(l[4])} / ${f0(l[9])} / ${f0(l[19])}`;
  };
  const out: string[] = [];
  out.push(`### Anfänger-Cap (A5, airSpeedCapLow ${off.airSpeedCapLow} → ${cfg.airSpeedCapLow})\n`);
  out.push('StrafeBot mit Zielfehler, Start 320 u/s flach, 8 Seeds: Landetempo Hop 10 (Median), Zeit bis 500 u/s (Median), Seeds, die 500 in 20 Hops erreichen. Perfekt ab runSpeed: H5 / H10 / H20.\n');
  out.push(table([`Hand`, `Cap ${off.airSpeedCapLow}`, `Cap ${cfg.airSpeedCapLow}`], [
    ['3°', hand(off, 3), hand(cfg, 3)],
    ['4°', hand(off, 4), hand(cfg, 4)],
    ['5°', hand(off, 5), hand(cfg, 5)],
    ['perfekt ab runSpeed H5 / H10 / H20', perfect(off), perfect(cfg)],
  ]));
  return out.join('\n');
}

// ================================================================== Rutschen (A7)

/** Auf flachem Boden absetzen und 0.3 s mit Tempo v sprinten (Füße exakt am Boden). */
function settle(pm: PlayerMovement, pos: Vector3, v: number): void {
  pm.teleport(pos);
  for (let k = 0; k < 40; k++) {
    pm.state.vel.set(0, pm.state.vel.y, -v);
    pm.tick(makeInput({ forward: 1, sprint: true }));
  }
}

/** Sprint 320, dann Ducken gehalten (W gehalten): Tempo nach 0.1 s und Dauer bis < 160 u/s. */
export function slideFromSprint(cfg: MovementConfig): { at01: number; dur: number; steps: number; eyeT: number } {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  settle(pm, new Vector3(0, 1, 0), 320);
  let at01 = Number.NaN;
  let dur = Number.NaN;
  let steps = 0;
  let eyeT = Number.NaN;
  const duckEye = cfg.hull.duckEye;
  for (let k = 1; k <= 3 * cfg.tickRate; k++) {
    for (const e of pm.tick(makeInput({ forward: 1, sprint: true, crouch: true }))) if (e.type === 'footstep' && pm.state.sliding) steps++;
    if (k === Math.round(0.1 * cfg.tickRate)) at01 = pm.state.speed;
    if (Number.isNaN(eyeT) && pm.state.eyeHeight <= duckEye + 1e-6) eyeT = k / cfg.tickRate;
    if (Number.isNaN(dur) && pm.state.speed < 160) dur = k / cfg.tickRate;
  }
  return { at01, dur, steps, eyeT };
}

/** Landung mit v, Ducken gehalten, Sprung nach g s Bodenzeit: Absprungtempo. */
export function slideHopAfterLanding(cfg: MovementConfig, v: number, g: number): number {
  const pm = pmAt(flatWorld(), cfg, new Vector3(0, 40, 0), new Vector3(0, -200, -v));
  let landed = -1;
  const gt = Math.round(g * cfg.tickRate);
  for (let k = 0; k < 3 * cfg.tickRate; k++) {
    if (pm.state.onGround && landed < 0) landed = k;
    const jump = landed >= 0 && k - landed >= gt;
    for (const e of pm.tick(makeInput({ crouch: true, jumpPressed: jump, jumpHeld: jump }))) if (e.type === 'jump') return e.speed;
  }
  return Number.NaN;
}

function tunnelLevel(): CompiledLevel {
  return level([
    box([-4096, -64, -8192], [4096, 0, 2048]),
    box([-256, 60, -600 - 768], [256, 60 + 128, -600]),
    box([-400, 0, -600 - 768], [-256, 60 + 128, -600]),
    box([256, 0, -600 - 768], [400, 60 + 128, -600]),
  ]);
}

/** Duck-Tunnel (Decke 60 u, 768 u lang): Anflug aus dem Bhop mit v, Landung 150 u davor, Ducken gehalten. */
export function slideTunnel(cfg: MovementConfig, v: number): { time: number; exit: number } {
  const lv = tunnelLevel();
  const tFall = (-200 + Math.sqrt(200 * 200 + 2 * cfg.gravity * 40)) / cfg.gravity;
  const pm = pmAt(lv, cfg, new Vector3(0, 41, -600 + 16 + 150 + v * tFall), new Vector3(0, -200, -v));
  let tin = -1;
  for (let k = 0; k < 20 * cfg.tickRate; k++) {
    pm.tick(makeInput({ forward: 1, sprint: true, crouch: true }));
    const s = pm.state;
    if (tin < 0 && s.pos.z - 16 < -600) tin = k;
    if (s.pos.z + 16 < -600 - 768) return { time: (k - tin) / cfg.tickRate, exit: s.speed };
  }
  return { time: Number.NaN, exit: Number.NaN };
}

/** Begehbarer Hang deg°, 1024 u lang, Anlauf 320 oben, Ducken gehalten: Tempo am Hangfuß. */
export function slideSlope(cfg: MovementConfig, deg: number): number {
  const h = Math.tan(deg * DEG) * 1024;
  const lv = level([
    box([-512, -64, 0], [512, 0, 1024]),
    { type: 'wedge', min: [-512, -h - 64, -1024], max: [512, 0, 0], rise: '+z', lowY: -h, mat: 'floor' },
    box([-512, -h - 64, -1024 - 4096], [512, -h, -1024]),
  ], -h - 2000);
  const pm = new PlayerMovement(lv.world, cfg);
  settle(pm, new Vector3(0, 1, 300), 320);
  for (let k = 0; k < 8 * cfg.tickRate; k++) {
    pm.tick(makeInput({ forward: 1, sprint: true, crouch: true }));
    if (pm.state.pos.z < -1024) return pm.state.speed;
  }
  return Number.NaN;
}

/**
 * Rutsche über eine Kante (drop u tiefer, > stepSize → Luft): Sprint 320, C `runup` u vor der Kante, W + C
 * gehalten. Tempo an der Kante, bei der Landung und 0.3 s danach; ob unten weitergerutscht wird.
 * `release`: C in der Luft loslassen. `jump`: an der Kante abspringen (Crouch-Jump).
 */
export function slideOverDrop(
  cfg: MovementConfig,
  opts: { readonly drop?: number; readonly runup?: number; readonly release?: boolean; readonly jump?: boolean } = {},
): { edge: number; land: number; after03: number; resumed: boolean; boost: boolean } {
  const drop = opts.drop ?? 24;
  const runup = opts.runup ?? 230;
  const lv = level([box([-512, -64, 0], [512, 0, 2048]), box([-512, -drop - 64, -4096], [512, -drop, 0])], -drop - 2000);
  const pm = new PlayerMovement(lv.world, cfg);
  settle(pm, new Vector3(0, 1, runup + 100), 320);
  let edge = Number.NaN;
  let land = Number.NaN;
  let landTick = -1;
  let resumed = false;
  let boost = false;
  let released = false;
  for (let k = 0; k < 6 * cfg.tickRate; k++) {
    const s = pm.state;
    if (opts.release === true && !s.onGround && s.pos.z < -16) released = true;
    const crouch = s.pos.z < runup + 16 && !released;
    const jump = opts.jump === true && s.onGround && s.pos.z < 20 && Number.isNaN(edge);
    for (const e of pm.tick(makeInput({ forward: 1, sprint: true, crouch, jumpPressed: jump, jumpHeld: jump }))) {
      if (e.type === 'land' && landTick < 0) {
        landTick = k;
        land = e.speed;
      }
      if (e.type === 'slideStart' && landTick >= 0) {
        resumed = true;
        boost = e.boost;
      }
    }
    if (Number.isNaN(edge) && !pm.state.onGround) edge = pm.state.speed;
    if (landTick >= 0 && k - landTick === Math.round(0.3 * cfg.tickRate)) return { edge, land, after03: pm.state.speed, resumed, boost };
  }
  return { edge, land, after03: Number.NaN, resumed, boost };
}

type Strategy = (pm: PlayerMovement, k: number, land: number) => Partial<PlayerInput>;

/** Missbrauch ohne Strafen, 12 s flach: mittleres Tempo der letzten 6 s. */
export function slideAbuse(cfg: MovementConfig, fn: Strategy): number {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  settle(pm, new Vector3(0, 1, 0), 320);
  let land = 0;
  let wasG = true;
  let sum = 0;
  let n = 0;
  for (let k = 0; k < 12 * cfg.tickRate; k++) {
    const g = pm.state.onGround;
    if (g && !wasG) land = k;
    wasG = g;
    pm.tick(makeInput({ sprint: true, ...fn(pm, k, land) }));
    if (k > 6 * cfg.tickRate) {
      sum += pm.state.speed;
      n++;
    }
  }
  return sum / n;
}

/** Schub-Farmer: 0.26 s laufen → Ducken (Schub) → nach 2 Ticks springen. */
export const FARMER: Strategy = (pm, k, land) => {
  const t = (k - land) / pm.config.tickRate;
  const g = pm.state.onGround;
  const jump = g && t >= 0.26 + 2 / pm.config.tickRate;
  return { forward: 1, crouch: g && t >= 0.26, jumpPressed: jump, jumpHeld: jump };
};
/** Slide-Hop ohne Schub: nach der Landung rutschen, bis < 300 u/s, dann springen. */
export const SLIDE_HOP: Strategy = (pm) => {
  const jump = pm.state.onGround && pm.state.speed < 300;
  return { forward: 1, crouch: !jump, jumpPressed: jump, jumpHeld: jump };
};

/**
 * Landung mit 700 u/s, C gehalten, Sprung k Ticks nach dem Lande-Tick: gemeldete Rutsch-Events
 * (slideStart/slideEnd) bis einschließlich Sprung-Tick (slideEnd kommt nach dem jump). In der
 * Lande-Gnade ist ein Sprung ein Crouch-Hop, keine Rutsche: 0. Danach Rutsche + Ende: 2.
 */
export function lateCrouchHopSlideEvents(cfg: MovementConfig, k: number): number {
  const pm = pmAt(flatWorld(), cfg, new Vector3(0, 30, 0), new Vector3(0, 200, -700));
  let land = -1;
  let n = 0;
  for (let t = 0; t < 3 * cfg.tickRate; t++) {
    const press = land >= 0 && t === land + 1 + k;
    let jumped = false;
    for (const e of pm.tick(makeInput({ yaw: 0, crouch: true, jumpPressed: press, jumpHeld: press }))) {
      if (e.type === 'land' && land < 0) land = t;
      if (e.type === 'slideStart' || e.type === 'slideEnd') n++;
      if (e.type === 'jump') jumped = true;
    }
    if (jumped) return n;
  }
  return n;
}

/** Bhop mit gehaltenem Ducken (Sprung im Landetick): Rutsch-Ticks und Tempo nach 10 s. */
export function crouchBhop(cfg: MovementConfig, aim: number): { speed: number; slideTicks: number; slideEvents: number } {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  settle(pm, new Vector3(0, 1, 0), 320);
  const bot = new StrafeBot(cfg, { aimNoiseDeg: aim, seed: 5, heading: 0 });
  let slideTicks = 0;
  let slideEvents = 0;
  for (let k = 0; k < 10 * cfg.tickRate; k++) {
    const ev = pm.tick({ ...bot.next(pm.state), crouch: true });
    for (const e of ev) if (e.type === 'slideStart') slideEvents++;
    if (pm.state.sliding) slideTicks++;
  }
  return { speed: pm.state.speed, slideTicks, slideEvents };
}

function slideSection(cfg: MovementConfig): string {
  const off = withMovement(cfg, { slideMinSpeed: 0 });
  const sa = slideFromSprint(off);
  const sb = slideFromSprint(cfg);
  const ta = slideTunnel(off, 900);
  const tb = slideTunnel(cfg, 900);
  const cb0 = crouchBhop(cfg, 0);
  const cb3 = crouchBhop(cfg, 3);
  const dropA = slideOverDrop(off);
  const dropB = slideOverDrop(cfg);
  const dropJ = slideOverDrop(cfg, { jump: true });
  const out: string[] = [];
  out.push('### Rutschen (A7, slide*)\n');
  out.push(table(['Messung', 'aus', 'an'], [
    ['Sprint 320 + C (W gehalten): Tempo nach 0.1 s', f0(sa.at01), f0(sb.at01)],
    ['dto. Dauer bis < 160 u/s', `${f2(sa.dur)} s`, `${f2(sb.dur)} s`],
    ['dto. Auge auf duckEye nach', `${f3(sa.eyeT)} s`, `${f3(sb.eyeT)} s`],
    ['dto. Schritt-Events beim Rutschen', String(sa.steps), String(sb.steps)],
    ['Landung 800 + Ducken, Sprung nach 0.2 s', f0(slideHopAfterLanding(off, 800, 0.2)), f0(slideHopAfterLanding(cfg, 800, 0.2))],
    ['dto. nach 0.1 s / 0.4 s', `${f0(slideHopAfterLanding(off, 800, 0.1))} / ${f0(slideHopAfterLanding(off, 800, 0.4))}`, `${f0(slideHopAfterLanding(cfg, 800, 0.1))} / ${f0(slideHopAfterLanding(cfg, 800, 0.4))}`],
    ['Duck-Tunnel 60 × 768 bei 900: Zeit · Ausgang', `${f2(ta.time)} s · ${f0(ta.exit)}`, `${f2(tb.time)} s · ${f0(tb.exit)}`],
    ['Hang 25°/1024 u ab 320, geduckt: Tempo am Fuß', f0(slideSlope(off, 25)), f0(slideSlope(cfg, 25))],
    ['Hang 15°/1024 u', f0(slideSlope(off, 15)), f0(slideSlope(cfg, 15))],
    [
      'Über eine 24-u-Kante (ohne Sprung): Tempo an der Kante → 0.3 s nach der Landung',
      `${f0(dropA.edge)} → ${f0(dropA.after03)}`,
      `${f0(dropB.edge)} → ${f0(dropB.after03)}${dropB.resumed ? ' (rutscht weiter)' : ''}`,
    ],
    ['dto. mit Crouch-Jump an der Kante (bremst wie Source)', '', `${f0(dropJ.edge)} → ${f0(dropJ.after03)}`],
    ['Schub-Farmer (nur W, 12 s): Ø Tempo der letzten 6 s', f0(slideAbuse(off, FARMER)), f0(slideAbuse(cfg, FARMER))],
    ['Slide-Hop ohne Schub (rutschen bis < 300, springen): Ø', f0(slideAbuse(off, SLIDE_HOP)), f0(slideAbuse(cfg, SLIDE_HOP))],
    [
      'Landung 700 + C, Sprung k = 1 / 4 / 8 / 12 Ticks später: gemeldete Rutsch-Events (Gnade = 8 Ticks)',
      '',
      [1, 4, 8, 12].map((k) => String(lateCrouchHopSlideEvents(cfg, k))).join(' / '),
    ],
    ['Bhop mit gehaltenem Ducken, perfekt 10 s: Tempo · Rutsch-Ticks', `${f3(crouchBhop(off, 0).speed)}`, `${f3(cb0.speed)} · ${cb0.slideTicks}`],
    ['dto. Hand 3°', `${f3(crouchBhop(off, 3).speed)}`, `${f3(cb3.speed)} · ${cb3.slideTicks}`],
  ]));
  return out.join('\n');
}

// ================================================================== Kanten-Assist (A6)

interface EdgeProbe {
  readonly lv: CompiledLevel;
  readonly x: number;
  readonly top: number;
  readonly zs: number[];
  readonly onLedge: Box3;
}

function l1Edge(): EdgeProbe | null {
  let lv: CompiledLevel;
  try {
    lv = compileLevel(readLevelFile('public/levels/level1.json'));
  } catch {
    return null;
  }
  const h7 = lv.brushes.find((b) => b.tag === 'hop7');
  const ledge = lv.brushes.find((b) => b.tag === 'ledge');
  if (!h7 || !ledge) return null;
  const zs: number[] = [];
  for (let z = h7.bounds.max.z - 16; z >= h7.bounds.min.z + 16.5; z -= 8) zs.push(z);
  const onLedge = new Box3(new Vector3(ledge.bounds.min.x, ledge.bounds.max.y - 2, ledge.bounds.min.z), ledge.bounds.max.clone().setY(ledge.bounds.max.y + 4));
  return { lv, x: (h7.bounds.min.x + h7.bounds.max.x) / 2, top: h7.bounds.max.y, zs, onLedge };
}

/** Hop von H7 an die L1-Crouch-Kante (W gehalten); Ankunftstempo oder NaN. duck(k, bonkTick). */
function edgeHop(p: EdgeProbe, cfg: MovementConfig, z: number, v: number, duck: (k: number, bonk: number) => boolean): number {
  const pm = pmAt(p.lv, cfg, new Vector3(p.x, p.top + 0.03125, z), new Vector3(0, 0, -v));
  let bonk = -1;
  let prev = v;
  const hmin = new Vector3();
  const hmax = new Vector3();
  const hull = new Box3();
  for (let k = 0; k < 1.5 * cfg.tickRate; k++) {
    pm.tick(makeInput({ forward: 1, sprint: true, jumpPressed: k === 0, jumpHeld: k === 0, crouch: duck(k, bonk) }));
    const s = pm.state;
    if (bonk < 0 && !s.onGround && s.speed < prev * 0.5) bonk = k;
    prev = s.speed;
    hull.set(hmin.copy(s.pos).add(pm.hullMins), hmax.copy(s.pos).add(pm.hullMaxs));
    if (p.onLedge.intersectsBox(hull)) return s.speed;
    if (s.onGround && k > 10 && s.pos.y < p.top + 1) return Number.NaN;
  }
  return Number.NaN;
}

const EDGE_SPEEDS = [320, 450, 600, 761, 900];

function edgeStats(p: EdgeProbe, cfg: MovementConfig): { noDuck: number; n: number; crawl: string; late: string } {
  let noDuck = 0;
  let n = 0;
  for (const v of EDGE_SPEEDS) {
    for (const z of p.zs) {
      n++;
      if (!Number.isNaN(edgeHop(p, cfg, z, v, () => false))) noDuck++;
    }
  }
  const crawl = EDGE_SPEEDS.filter((v) => v >= 600).map((v) => {
    let slow = 0;
    let ok = 0;
    for (const z of p.zs) {
      const a = edgeHop(p, cfg, z, v, (k) => k >= 1);
      if (!Number.isNaN(a)) {
        ok++;
        if (a < 0.5 * v) slow++;
      }
    }
    return `${v}: ${slow}/${ok}`;
  }).join(', ');
  let share = 0;
  let got = 0;
  for (const ms of [0, 16, 31, 63, 102, 148]) {
    const dk = Math.round((ms / 1000) * cfg.tickRate);
    for (const v of EDGE_SPEEDS) {
      for (const z of p.zs) {
        const a = edgeHop(p, cfg, z, v, (k, bonk) => bonk >= 0 && k >= bonk + dk);
        if (!Number.isNaN(a)) {
          share += a / v;
          got++;
        }
      }
    }
  }
  return { noDuck, n, crawl, late: `${f0((100 * share) / Math.max(1, got))} % (${got} Ankünfte)` };
}

/** Treppe rise/depth: Zeit bis 384 u Höhe (perfekter StrafeBot, Leertaste gehalten). */
export function stairClimb(cfg: MovementConfig, rise: number, depth: number, v0: number): number {
  const brushes: BrushDef[] = [box([-256, -64, 0], [256, 0, 1024])];
  for (let i = 1; i <= 20; i++) brushes.push(box([-256, -64, -depth * i], [256, rise * i, -depth * (i - 1)]));
  const lv = level(brushes, -500);
  const pm = new PlayerMovement(lv.world, cfg);
  pm.teleport(new Vector3(0, 1, 200));
  for (let k = 0; k < 20; k++) {
    pm.state.vel.set(0, pm.state.vel.y, -Math.min(v0, 320));
    pm.tick(makeInput({ forward: 1, sprint: true }));
  }
  pm.state.vel.set(0, 0, -v0);
  const bot = new StrafeBot(cfg, { heading: 0 });
  for (let k = 0; k < 20 * cfg.tickRate; k++) {
    pm.tick({ ...bot.next(pm.state), jumpHeld: true, jumpPressed: k === 0 });
    if (pm.state.onGround && pm.state.pos.y >= 384 - 1) return k / cfg.tickRate;
  }
  return Number.NaN;
}

/**
 * Sprung (frischer Druck, keine Taste danach) d u vor der Stirnseite einer Stufe der Höhe h, mit v:
 * Luftzeit (s) und Landetempo. Ein Lip-Step im Steigen verschluckte hier den Sprung (8 ms Luft).
 */
export function curbJump(cfg: MovementConfig, h: number, d: number, v: number): { air: number; land: number } {
  const lv = level([box([-2048, -64, -2048], [2048, 0, 2048]), box([-2048, 0, -3072], [2048, h, -1024])]);
  const pm = pmAt(lv, cfg, new Vector3(0, 0.03125, -1024 + 16 + d), new Vector3(0, 0, -v));
  let air = 0;
  let land = Number.NaN;
  for (let k = 0; k < 2 * cfg.tickRate; k++) {
    for (const e of pm.tick(makeInput({ yaw: 0, jumpPressed: k === 0, jumpHeld: k === 0 }))) if (e.type === 'land') land = e.speed;
    if (!pm.state.onGround) air++;
    else if (k > 0) break;
  }
  return { air: air / cfg.tickRate, land };
}

/**
 * Kante der Höhe h OHNE Ducken aus dem Auto-Hop-Rhythmus: Anflug aus der Luft, Leertaste gehalten,
 * `phases` Startpunkte je Modus (perfekter Strafer 450–900 u/s bzw. nur W 250–310 u/s). Zählt, wie oft
 * man oben steht. Die Auto-Hop-Landung schwebt bis 1.5 u über dem Boden (2-u-Sonde, fallen.md) — der
 * Sprung startet von dort, deshalb reicht es höher als aus dem Stand.
 */
export function noDuckEdge(cfg: MovementConfig, h: number, phases = 40): { strafe: number; w: number; n: number } {
  const lv = level([box([-4096, -64, -6144], [4096, 0, 4096]), box([-4096, 0, -6144], [4096, h, -1024])]);
  let strafe = 0;
  let w = 0;
  for (let i = 0; i < phases; i++) {
    const z0 = -1024 + 200 + (i * 444) / phases;
    for (const mode of ['strafe', 'w'] as const) {
      const v = mode === 'strafe' ? 450 + (i % 4) * 150 : 250 + (i % 3) * 30;
      const pm = pmAt(lv, cfg, new Vector3(0, 20, z0), new Vector3(0, 0, -v));
      const bot = new StrafeBot(cfg, { heading: 0 });
      for (let k = 0; k < 5 * cfg.tickRate; k++) {
        pm.tick(mode === 'strafe' ? { ...bot.next(pm.state), jumpHeld: true, jumpPressed: false } : makeInput({ yaw: 0, forward: 1, sprint: true, jumpHeld: true }));
        const s = pm.state;
        if (s.onGround && s.pos.y > h - 0.5) {
          if (mode === 'strafe') strafe++;
          else w++;
          break;
        }
        if (s.pos.z < -1400) break;
      }
    }
  }
  return { strafe, w, n: phases };
}

/** L1-Rutsche ab Knoten 31, 840 u/s, 48 u seitlich, nur Leertaste gehalten (dbg-chute): Ziel erreicht? */
function chuteSideExit(cfg: MovementConfig): string {
  let lv: CompiledLevel;
  try {
    lv = compileLevel(readLevelFile('public/levels/level1.json'));
  } catch {
    return 'L1 fehlt';
  }
  const route = lv.def.route ?? [];
  const fin = lv.triggers.find((t) => t.kind === 'finish');
  if (route.length < 33 || !fin) return 'Route passt nicht';
  let ok = 0;
  let n = 0;
  for (const lat of [-48, 0, 48]) {
    for (const v of [600, 840, 1100]) {
      n++;
      const A = route[31].pos;
      const B = route[32].pos;
      const dir = new Vector3(B[0] - A[0], 0, B[2] - A[2]).normalize();
      const yaw = Math.atan2(-dir.x, -dir.z);
      const p = new Vector3(A[0] - dir.z * lat, A[1] + 48, A[2] + dir.x * lat);
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(p);
      pm.state.vel.set(dir.x * v, 0, dir.z * v);
      for (let k = 0; k < 14 * cfg.tickRate; k++) {
        pm.tick(makeInput({ yaw, jumpHeld: true, jumpPressed: k === 0 }));
        const s = pm.state;
        if (fin.bounds.containsPoint(s.pos)) {
          ok++;
          break;
        }
        if (s.pos.y < lv.def.killY || lv.triggers.some((t) => t.kind === 'kill' && t.bounds.containsPoint(s.pos))) break;
      }
    }
  }
  return `${ok}/${n} im Ziel`;
}

function ledgeSection(cfg: MovementConfig): string {
  const off = withMovement(cfg, { ledgeStep: 0, ledgeMemory: 0 });
  const out: string[] = [];
  out.push('### Kanten-Assist (A6, ledgeStep / ledgeMemory)\n');
  const p = l1Edge();
  const rows: string[][] = [];
  if (p) {
    const a = edgeStats(p, off);
    const b = edgeStats(p, cfg);
    rows.push(['L1-Crouch-Kante OHNE Ducken (H7, 40 Startpunkte × 5 Tempi): oben', `${a.noDuck}/${a.n}`, `${b.noDuck}/${b.n}`]);
    rows.push(['MIT Ducken ab 600 u/s: gekrochen (< 50 % Tempo) / oben', a.crawl, b.crawl]);
    rows.push(['zu spät geduckt (0–148 ms nach dem Anprall): Ø Ankunftstempo', a.late, b.late]);
  } else {
    rows.push(['L1-Crouch-Kante', 'übersprungen (Tags hop7/ledge fehlen)', '']);
  }
  rows.push(['Treppe 48/192, perfekt ab 320: Zeit bis 384 u', `${f2(stairClimb(off, 48, 192, 320))} s`, `${f2(stairClimb(cfg, 48, 192, 320))} s`]);
  rows.push(['Treppe 32/192, perfekt ab 320', `${f2(stairClimb(off, 32, 192, 320))} s`, `${f2(stairClimb(cfg, 32, 192, 320))} s`]);
  rows.push(['Treppe 24/192, perfekt ab 320', `${f2(stairClimb(off, 24, 192, 320))} s`, `${f2(stairClimb(cfg, 24, 192, 320))} s`]);
  rows.push(['L1-Rutsche seitlich (Knoten 31, ±48, 600–1100 u/s, nur Leertaste)', chuteSideExit(off), chuteSideExit(cfg)]);
  const curb = (c: MovementConfig): string =>
    ([[4, 1], [8, 6], [16, 25]] as const).map(([h, d]) => {
      const r = curbJump(c, h, d, 600);
      return `${f2(r.air)} s · ${f0(r.land)}`;
    }).join(' / ');
  rows.push(['Sprung direkt vor einer Stufe 4 / 8 / 16 u (1 / 6 / 25 u davor, 600 u/s): Luftzeit · Landetempo', curb(off), curb(cfg)]);
  const edge = (c: MovementConfig): string =>
    [62, 63, 64, 66].map((h) => {
      const r = noDuckEdge(c, h);
      return `${h}: ${r.strafe + r.w}/${2 * r.n}`;
    }).join(', ');
  rows.push(['Kante OHNE Ducken aus dem Auto-Hop-Rhythmus (Strafer + nur W, je 40 Phasen): oben', edge(off), edge(cfg)]);
  out.push(table(['Messung', 'aus', 'an'], rows));
  out.push('\nLevel-Regeln daraus (movement.md §5): Crouch-Kanten ≥ 66 u (ohne Ducken bis 63.5 u: 57 Sprung + bis 1.5 u Auto-Hop-Landehöhe + 5 Lip-Step); Treppen mit Setzstufe 32–40 u kosten mit dem Gedächtnis systematisch Zeit (Doppel-Anprall, +0.2 bis +1.0 s) — Auftritt ≥ Hop-Weite beim Zieltempo oder Stufen ≤ 18 u.');
  return out.join('\n');
}

// ================================================================== Luftlenkung (A8)

/** In der Luft mit v, Blick um lookDeg gedreht, W (und side) gehalten: Drehung der Flugrichtung und Tempo nach s Sekunden. */
export function airTurn(cfg: MovementConfig, v: number, lookDeg: number, seconds: number, side = 0): { turn: number; speed: number } {
  const pm = pmAt(flatWorld(), cfg, new Vector3(0, 4000, 0), new Vector3(0, 0, -v));
  const inp = makeInput({ forward: 1, side, yaw: lookDeg * DEG });
  for (let k = 0; k < Math.round(seconds * cfg.tickRate); k++) pm.tick(inp);
  const s = pm.state;
  return { turn: Math.atan2(-s.vel.x, -s.vel.z) / DEG, speed: s.speed };
}

/** Surf-Flanke mit W gehalten, Blick entlang: Zustand nach 2 s (Luftlenkung darf nichts ändern). */
function surfW(cfg: MovementConfig): Vector3 {
  const lv = surfWorld();
  // Rechte Flanke (Normale +x): über x = 200 liegt sie bei y ≈ −312; Blick 20° links = in die Rampe.
  // Erst 0.5 s mit A an der Flanke (Kontakt steht), dann 2 s nur W.
  const pm = pmAt(lv, cfg, new Vector3(200, -250, -200), new Vector3(0, 0, -600));
  for (let k = 0; k < cfg.tickRate / 2; k++) pm.tick(makeInput({ side: -1, yaw: 0 }));
  for (let k = 0; k < 2 * cfg.tickRate; k++) pm.tick(makeInput({ forward: 1, yaw: 20 * DEG }));
  return pm.state.pos.clone();
}

/** Nach steilem Kontakt: Luftlenkung ruht airControlSurfGrace. Drehung in den ersten 0.4 s nach dem Verlassen der Flanke. */
function afterSurfTurn(cfg: MovementConfig): number {
  const lv = surfWorld();
  const pm = pmAt(lv, cfg, new Vector3(200, -250, -200), new Vector3(0, 0, -600));
  for (let k = 0; k < cfg.tickRate; k++) pm.tick(makeInput({ side: -1, yaw: 0 }));
  // Von der Flanke weg (+x) abspringen lassen: Tempo seitlich weg, dann W mit Blick 60° daneben.
  pm.state.vel.set(500, 200, -300);
  pm.tick(makeInput());
  const a0 = Math.atan2(-pm.state.vel.x, -pm.state.vel.z);
  for (let k = 0; k < Math.round(0.4 * cfg.tickRate); k++) pm.tick(makeInput({ forward: 1, yaw: a0 + 60 * DEG }));
  return (Math.atan2(-pm.state.vel.x, -pm.state.vel.z) - a0) / DEG;
}

function strafeSame(cfg: MovementConfig, off: MovementConfig): string {
  const res: string[] = [];
  for (const aim of [0, 2, 3, 5]) {
    const run = (c: MovementConfig): number => {
      const pm = pmAt(flatWorld(), c, new Vector3(0, 0, 14000), new Vector3(0, 0, -320));
      const bot = new StrafeBot(c, aim > 0 ? { heading: 0, aimNoiseDeg: aim, seed: 11 } : { heading: 0 });
      for (let k = 0; k < 10 * c.tickRate; k++) pm.tick(bot.next(pm.state));
      return pm.state.speed;
    };
    const a = run(off);
    const b = run(cfg);
    res.push(`${aim}° ${a === b ? 'bitgleich' : `${f3(a)} ≠ ${f3(b)}`}`);
  }
  return res.join(', ');
}

function airSection(cfg: MovementConfig): string {
  const off = withMovement(cfg, { airControl: 0 });
  const t90a = airTurn(off, 320, 90, 0.3);
  const t90b = airTurn(cfg, 320, 90, 0.3);
  const t45a = airTurn(off, 320, 45, 0.3);
  const t45b = airTurn(cfg, 320, 45, 0.3);
  const t900 = airTurn(cfg, 900, 90, 0.3);
  const ad = airTurn(cfg, 320, 60, 0.3, 1);
  const adOff = airTurn(off, 320, 60, 0.3, 1);
  const out: string[] = [];
  out.push(`### Luftlenkung mit W (A8, airControl ${cfg.airControl} → ${cfg.airControlHigh} rad/s)\n`);
  out.push(table(['Messung', 'aus', 'an'], [
    ['320 u/s, Blick 90° daneben, nur W, 0.3 s: Drehung · Tempo', `${f1(t90a.turn)}° · ${f1(t90a.speed)}`, `${f1(t90b.turn)}° · ${f1(t90b.speed)}`],
    ['320 u/s, Blick 45° daneben (nur Drehung, kein Luft-Schub)', `${f1(t45a.turn)}° · ${f2(t45a.speed)}`, `${f1(t45b.turn)}° · ${f2(t45b.speed)}`],
    ['900 u/s, Blick 90° daneben', '', `${f1(t900.turn)}° · ${f1(t900.speed)}`],
    ['W+D, Blick 60°: Drehung (muss gleich "aus" sein)', `${f3(adOff.turn)}°`, `${f3(ad.turn)}°`],
    ['Surf-Flanke 2 s mit W: Endposition gleich?', '', surfW(off).equals(surfW(cfg)) ? 'bitgleich' : 'ABWEICHUNG'],
    ['0.4 s nach der Flanke, Blick 60° daneben: Drehung', `${f2(afterSurfTurn(off))}°`, `${f2(afterSurfTurn(cfg))}°`],
    ['StrafeBots 0/2/3/5° 10 s (A/D): Endtempo', '', strafeSame(cfg, off)],
  ]));
  return out.join('\n');
}

// ================================================================== Knick-Fix (A1) und Rampbug-Fix (A2)

/** Konkave Luft-Ecke (Front 5° gedreht, Seite 3°): W in die Front, Blick 10° zur Seite, 1 s — Fallhöhe. */
export function cornerFall(cfg: MovementConfig, duck: boolean): number {
  const lv = level([
    box([-2000, -64, -2000], [2000, 0, 2000]),
    { type: 'box', min: [-400, 0, -164], max: [100, 400, -100], mat: 'wall', rotY: 5, pivot: [100, 0, -100] },
    { type: 'box', min: [100, 0, -100], max: [132, 400, 400], mat: 'wall', rotY: 3, pivot: [100, 0, -100] },
  ]);
  const pm = pmAt(lv, cfg, new Vector3(70, 200, -70));
  const y0 = pm.state.pos.y;
  const inp = makeInput({ forward: 1, crouch: duck, yaw: -10 * DEG });
  for (let k = 0; k < cfg.tickRate; k++) pm.tick(inp);
  return y0 - pm.state.pos.y;
}

function fixSection(cfg: MovementConfig): string {
  const out: string[] = [];
  out.push('### Knick-Projektion (A1, immer) und Rampbug-Fix (A2, surfSeamFix)\n');
  out.push(`Konkave Luft-Ecke (Front 5°, Seite 3°, W in die Front): nach 1 s gefallen ${f0(cornerFall(cfg, false))} u, geduckt ${f0(cornerFall(cfg, true))} u (Hänger < 100 u; vor dem Fix blieb man kleben).`);
  out.push('Nahtstopps an Gehrungskurven misst `tools/critique/v2/level3/probeCurveSweep.ts` (Raster wie der Validator); Ergebnis in movement-tuning.md "Arcade-Pass".');
  return out.join('\n');
}

/** Abschnitt "Arcade" für `npm run sim`. */
export function arcadeSection(cfg: MovementConfig): string {
  const parts = ['## Arcade-Pass (Plan 007): jede Mechanik aus/an\n'];
  parts.push(fixSection(cfg));
  parts.push(graceSection(cfg));
  parts.push(slopeSection(cfg));
  parts.push(capSection(cfg));
  parts.push(slideSection(cfg));
  parts.push(ledgeSection(cfg));
  parts.push(airSection(cfg));
  return parts.join('\n\n');
}

/** Events eines Ticks kopieren (sie sind wiederverwendete Objekte). */
export function copyEvents(ev: readonly MovementEvent[], out: MovementEvent[]): void {
  for (const e of ev) out.push({ ...e });
}
