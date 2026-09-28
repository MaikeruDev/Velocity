/**
 * Design-Proben Level 3 "03 BRANDUNG" (Plan 007, Phase 2: Strang level3) — designProbes.ts ruft sie für id 'level3'.
 *
 * Die Behauptungen der Gabel (tools/levels/level3.ts, .docs/research/levels/level3.md), mit echter Physik:
 * 1. Innenvorteil: Koralle (route) ist spürbar schneller als Türkis (safeRoute) — für den perfekten Bot UND die
 *    3°-Hand. Gemessen mit wenig Rauschen: sync 1.0 als Median über die 49 Start-Jitter (wie die Medaillen),
 *    Hand 3° über 24 Seeds (die 8 Validator-Seeds streuen auf Türkis um ±1.5 s, Zahl steht mit im Bericht).
 * 2. Außenbahn fängt Nicht-Drücker: W-Halter ab CP1/CP2 (Blick auf einen Türkis-Knoten ≥ 320 u voraus ±15/±30°
 *    oder in Flugrichtung, mit und ohne Leertaste) erreichen den nächsten Checkpoint ohne Tod; mit Blick auf den
 *    nächsten Knoten stirbt keiner (Stau erlaubt).
 * 3. Kein Checkpoint-Pad liegt näher als 64 u an einer der beiden Linien (Pads in der Fahrlinie stoppen, #47).
 * 4. Grundtechnik-Surfer (Blick 0°) ist an jedem folgenden Checkpoint ≥ 700 u/s schnell — auf beiden Linien, und
 *    zwar auf der EIGENEN Bahn (Bahnprüfung über den Grat, sonst Fehler).
 * 5. Finale aus dem CP3-Respawn landet mit ≥ 10 % Weitenreserve (beide Linien).
 * 6. Risiko nur innen: Aussetzer-Modell (Hand 2°, A/D beim Surfen periodisch losgelassen) stirbt auf Koralle,
 *    auf Türkis nie. Die Gabel ist für jeden, der die Kurve HÄLT, keine Zeitfrage (Abnahme: Hand 1–3° 0 Tode,
 *    Quote ≤ 0.90) — sie trennt, wer sie hält, von dem, der zwischendurch loslässt.
 * 7. Medaillen-Stichprobe: Bronze/Silber (build.ts: Hand 3°/2° auf safeRoute über die 8 Validator-Seeds) gegen
 *    24 Seeds — schafft die Hand, für die die Medaille steht, sie in weniger als der Hälfte der Läufe, warnt die Probe.
 * Geometrie über Tags (cp<n>pad, outer<k><a–z>), Linien über route/safeRoute — nie über Notizen.
 */
import { Box3, Vector3 } from 'three';
import type { RunEvent } from '../../../src/engine/events';
import { RunState } from '../../../src/engine/runState';
import type { MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { RouteFollower, makeBotInput } from '../../../src/player/bots';
import type { CompiledLevel, CompiledTrigger } from '../../../src/world/level/compileLevel';
import type { LevelFile, RouteNode } from '../../../src/world/level/LevelFormat';
import { finaleReserve, passedNode, type DesignReport } from '../designProbes';
import {
  SurfRider,
  jitterMedian,
  nextGoal,
  resumeIndex,
  routeAxis,
  simulate,
  timedMedian,
  withRoute,
  type Controller,
  type ProbeOutcome,
  type StrafeModel,
  type TimedRun,
} from '../physics';

/** Gabel-Nutzen: route ≤ Anteil × safeRoute (Plan 007, Strang level3). */
export const FORK_SYNC1 = 0.93;
export const FORK_HAND3 = 0.9;
/** Seeds der Hände für Gabel-Vergleich und Medaillen-Stichprobe. */
const HAND_SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const VALIDATOR_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
/** Mindestabstand Checkpoint-Pad ↔ Linie (u). */
export const PAD_CLEARANCE = 64;
/** Grundtechnik-Surfer: Tempo am nächsten Checkpoint (u/s). */
export const SURFER_MIN_SPEED = 700;
/** Bahnprüfung: so viele Luftticks in der Kehre müssen auf der Sollseite des Grats liegen. */
export const LANE_SHARE = 0.9;
/** W-Halter blicken auf den ersten Knoten mindestens so weit voraus (u, horizontal). */
const LOOK_AHEAD = 320;
/**
 * Aussetzer-Modell der Risiko-Probe: Hand, Aussetzer (s) je Periode (s), Seeds. 0.5 s alle 2 s: über 48 Seeds
 * sterben 46 % der Koralle-Läufe in der Kehre, 0 % der Türkis-Läufe (0.4 s: 10 % — zu selten für 16 Seeds).
 */
export const LAPSE: LapseModel = { aimNoiseDeg: 2, lapse: 0.5, period: 2 };
const LAPSE_SEEDS = Array.from({ length: 16 }, (_, i) => i + 1);
/** Risiko innen: so viele Koralle-Läufe des Aussetzer-Modells mit einem Tod in der Kehre (Türkis: keiner). */
export const LAPSE_RISK = 0.25;
/** Medaillen-Stichprobe: so viele Läufe der Medaillen-Hand müssen die Medaille schaffen. */
export const MEDAL_SHARE = 0.5;
/** Brushes der Gabel: Halbrampen beider Bahnen (lib.SurfPath-Stücke) und das Auffang-Band der Außenbahn. */
const FORK_TAG = /^(outer|inner)[1-4][a-z]$|^outerCatch[1-4]$/;
const DOWN_MINS = new Vector3(-4, 0, -4);
const DOWN_MAXS = new Vector3(4, 4, 4);

const f0 = (n: number): string => n.toFixed(0);
const f2 = (n: number): string => n.toFixed(2);

export function level3Probes(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  if (!level.def.safeRoute) {
    r.errors.push('Design L3: keine safeRoute — die Gabel braucht zwei Linien');
    return;
  }
  const safe = withRoute(level, 'safeRoute');
  const ridge = kehreRidge(level.def);
  if (ridge.length < 8) {
    r.errors.push(`Design L3: Grat der Kehre nicht gefunden (${ridge.length} Fugen mit Tag outer<k><a–z>)`);
    return;
  }
  forkAdvantage(level, safe, cfg, r);
  outerCatchesHolders(level, safe, cfg, r);
  padClearance(level, r);
  surferSpeed(level, safe, ridge, cfg, r);
  // 5. Finale-Reserve je Linie (Launch-Knoten und Surfer-Achse kommen aus der jeweiligen Route).
  finaleReserve(level, cfg, r, finaleYaw(level.def.route ?? []));
  const s: DesignReport = { errors: [], warnings: [], info: [] };
  finaleReserve(safe, cfg, s, finaleYaw(safe.def.route ?? []));
  r.errors.push(...s.errors.map((x) => `[safeRoute] ${x}`));
  r.warnings.push(...s.warnings.map((x) => `[safeRoute] ${x}`));
  r.info.push(...s.info.map((x) => `[safeRoute] ${x}`));
  lapseRisk(level, safe, cfg, r);
}

// ---------------------------------------------------------------------------
// Grat der Kehre (Seite einer Linie)

/** Grat der Kehre an einer Fuge: Punkt und waagrechte Rechts-Richtung (zur Außenflanke = Türkis). */
export interface RidgePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rx: number;
  readonly rz: number;
}

/**
 * Grat aus den Stücken der Außenbahn (Tags outer<1–4><a–z>): lib.SurfPath baut eine Halbrampe 'right' je Fuge als
 * [Grat, Fuß außen, Innenwand]; Grat → Fuß außen ist die Rechts-Richtung. Aus der Geometrie, nicht aus dem Builder —
 * so gilt die Seite auch für Varianten-JSONs. Der Grat ist kein Kreis (jedes Viertel beginnt per Überlappung früher).
 */
export function kehreRidge(def: LevelFile): RidgePoint[] {
  const out: RidgePoint[] = [];
  for (const b of def.brushes) {
    if (b.type !== 'hull' || b.tag === undefined || !/^outer[1-4][a-z]$/.test(b.tag)) continue;
    for (const k of [0, 3]) {
      const a = b.points[k];
      const f = b.points[k + 1];
      const l = Math.hypot(f[0] - a[0], f[2] - a[2]);
      if (l > 0) out.push({ x: a[0], y: a[1], z: a[2], rx: (f[0] - a[0]) / l, rz: (f[2] - a[2]) / l });
    }
  }
  return out;
}

/** Querabstand zum nächsten Gratpunkt (u): > 0 außen (Türkis), < 0 innen (Koralle); `dist` waagrecht. */
export function ridgeSide(ridge: readonly RidgePoint[], x: number, z: number): { readonly lateral: number; readonly dist: number } {
  let best = Infinity;
  let lateral = 0;
  for (const p of ridge) {
    const d = (x - p.x) ** 2 + (z - p.z) ** 2;
    if (d < best) {
      best = d;
      lateral = (x - p.x) * p.rx + (z - p.z) * p.rz;
    }
  }
  return { lateral, dist: Math.sqrt(best) };
}

/** Liegt unter (x, y, z) ein Brush der Gabel (Kehre beider Bahnen, Band)? R1, Pads und Luft darunter zählen nicht. */
function overFork(level: CompiledLevel, x: number, y: number, z: number): boolean {
  const tr = level.world.traceBox(new Vector3(x, y + 8, z), new Vector3(x, y - 1400, z), DOWN_MINS, DOWN_MAXS);
  if (tr.startSolid || tr.fraction >= 1) return false;
  return FORK_TAG.test(level.brushes[tr.brushIndex]?.tag ?? '');
}

/** Seite einer Linie in der Kehre (+1 außen, −1 innen): Mehrheit ihrer Surf-Knoten über der Gabel. */
function lineSide(level: CompiledLevel, route: readonly RouteNode[], ridge: readonly RidgePoint[]): 1 | -1 {
  let sum = 0;
  for (const n of route) {
    if (n.surf === true && overFork(level, n.pos[0], n.pos[1], n.pos[2])) sum += Math.sign(ridgeSide(ridge, n.pos[0], n.pos[2]).lateral);
  }
  return sum >= 0 ? 1 : -1;
}

/** Zählt die Luftticks über der Gabel und wie viele davon auf der Sollseite des Grats liegen. */
class LaneTracker implements Controller {
  ticks = 0;
  onSide = 0;
  constructor(
    private readonly inner: Controller,
    private readonly level: CompiledLevel,
    private readonly ridge: readonly RidgePoint[],
    private readonly side: 1 | -1,
  ) {}
  next(s: Parameters<Controller['next']>[0], n: Vector3): ReturnType<Controller['next']> {
    if (!s.onGround && overFork(this.level, s.pos.x, s.pos.y, s.pos.z)) {
      this.ticks++;
      if (Math.sign(ridgeSide(this.ridge, s.pos.x, s.pos.z).lateral) === this.side) this.onSide++;
    }
    return this.inner.next(s, n);
  }
  get share(): number {
    return this.ticks > 0 ? this.onSide / this.ticks : 1;
  }
}

// ---------------------------------------------------------------------------
// 1. Gabel-Nutzen und 7. Medaillen-Stichprobe

/** Flugrichtung des Kickers (Grad, forwardOf-Konvention) aus den letzten beiden Surf-Knoten vor dem Launch. */
function finaleYaw(route: readonly RouteNode[]): number {
  const surf = route.filter((n) => n.surf === true);
  const a = surf[surf.length - 3]?.pos;
  const b = surf[surf.length - 2]?.pos;
  if (!a || !b) return 0;
  return (Math.atan2(-(b[0] - a[0]), -(b[2] - a[2])) * 180) / Math.PI;
}

/** 1. Koralle schneller als Türkis — perfekter Bot (49 Start-Jitter) und 3°-Hand (24 Seeds). Dazu 7. (Bronze/Silber). */
function forkAdvantage(level: CompiledLevel, safe: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const jr = jitterMedian(level, { sync: 1 }, cfg).median;
  const js = jitterMedian(safe, { sync: 1 }, cfg).median;
  const hand: StrafeModel = { aimNoiseDeg: 3 };
  const hr = timedMedian(level, hand, HAND_SEEDS, cfg).median;
  const hsr = timedMedian(safe, hand, HAND_SEEDS, cfg);
  const hs = hsr.median;
  const h8 = [timedMedian(level, hand, VALIDATOR_SEEDS, cfg).median, timedMedian(safe, hand, VALIDATOR_SEEDS, cfg).median];
  medalSample(level, safe, hsr.runs, cfg, r);
  if (jr === null || js === null || hr === null || hs === null) {
    const t = (x: number | null): string => x?.toFixed(2) ?? '–';
    r.errors.push(`Design L3: Gabel-Vergleich — ein Modell kommt mehrheitlich nicht ins Ziel (sync 1.0 ${t(jr)}/${t(js)}, Hand 3° ${t(hr)}/${t(hs)})`);
    return;
  }
  const q1 = jr / js;
  const q3 = hr / hs;
  const q8 = h8[0] !== null && h8[1] !== null ? `; 8 Validator-Seeds ${f2(h8[0])}/${f2(h8[1])} = ${f2(h8[0] / h8[1])}` : '';
  const text = `sync 1.0 (49 Starts) ${f2(jr)}/${f2(js)} s = ${f2(q1)} (Soll ≤ ${FORK_SYNC1}), Hand 3° (24 Seeds) ${f2(hr)}/${f2(hs)} s = ${f2(q3)} (Soll ≤ ${FORK_HAND3}${q8})`;
  if (q1 > FORK_SYNC1 || q3 > FORK_HAND3) r.warnings.push(`Design L3: Innenvorteil zu klein — ${text}`);
  else r.info.push(`Design L3: Innenvorteil Koralle/Türkis — ${text}`);
}

/**
 * 7. Bronze/Silber stehen für die 3°/2°-Hand auf der sicheren Linie (build.ts, Median der 8 Validator-Seeds × 1.05).
 * Die 8 Seeds streuen auf Türkis stark (ein Fall aufs Band kostet 2–4 s): gemessen wird, wie viele von 24 Läufen der
 * Medaillen-Hand die Medaille wirklich schaffen. Weniger als die Hälfte = die Medaille hängt an einer glücklichen
 * Stichprobe (Warnung; die Messung selbst gehört build.ts).
 */
function medalSample(level: CompiledLevel, safe: CompiledLevel, hand3: readonly TimedRun[], cfg: MovementConfig, r: DesignReport): void {
  const m = level.def.medals;
  if (!m) return;
  const hand2 = timedMedian(safe, { aimNoiseDeg: 2 }, HAND_SEEDS, cfg).runs;
  const parts: string[] = [];
  const short: string[] = [];
  for (const [name, limit, runs, deg] of [
    ['Bronze', m.bronze, hand3, 3],
    ['Silber', m.silver, hand2, 2],
  ] as const) {
    const ok = runs.filter((x) => x.time !== null && x.time <= limit).length;
    const times = runs.flatMap((x) => (x.time === null ? [] : [x.time])).sort((a, b) => a - b);
    const med = times[Math.floor((runs.length - 1) / 2)];
    const would = med !== undefined ? Math.ceil(med * 1.05 * 10 - 1e-6) / 10 : NaN;
    parts.push(`${name} ${limit} s: Hand ${deg}° auf Türkis ${ok}/${runs.length} (24-Seed-Median ${med?.toFixed(2) ?? '–'} → ${would.toFixed(1)} s)`);
    if (ok < MEDAL_SHARE * runs.length) short.push(name);
  }
  const text = `Medaillen-Stichprobe — ${parts.join('; ')}`;
  if (short.length) r.warnings.push(`Design L3: ${short.join('/')} zu streng für die Medaillen-Hand (build.ts misst über 8 Seeds) — ${text}`);
  else r.info.push(`Design L3: ${text}`);
}

// ---------------------------------------------------------------------------
// 2. W-Halter auf Türkis

/**
 * 2. W-Halter ab CP1/CP2 auf Türkis: 6 Blicke × mit/ohne Leertaste. Blickziel = erster Türkis-Knoten ≥ LOOK_AHEAD
 * voraus (+ Versatz) oder die Flugrichtung: jeder erreicht den nächsten Checkpoint ohne Tod. Zweites Blickmodell
 * "nächster Knoten" (wie novice.ts): nur Tod ist ein Fehler — auf dem Band liegt der nächste Knoten oft direkt
 * NEBEN einem an der Flanke, wer darauf blickt, drückt W senkrecht in die Flanke und steht (Stau, fallen.md #73;
 * gemessen: 1/24 Stau, 0 Tode). Wer schaut, wohin er will, hüpft weiter.
 */
function outerCatchesHolders(level: CompiledLevel, safe: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const route = safe.def.route ?? [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint' && (t.order === 1 || t.order === 2));
  if (cps.length !== 2) {
    r.errors.push('Design L3: W-Halter-Probe findet CP1/CP2 nicht');
    return;
  }
  const fails: string[] = [];
  const dead: string[] = [];
  let runs = 0;
  let slow = 0;
  let stuck = 0;
  for (const cp of cps) {
    const goal = nextGoal(level, cp.order);
    const from = resumeIndex(route, cp);
    if (!goal || from < 1) {
      r.errors.push(`Design L3: W-Halter-Probe — kein Ziel oder Wiedereinstieg ab CP${cp.order}`);
      return;
    }
    // Blick: auf den Türkis-Knoten + Versatz (Grad) oder in Flugrichtung (NaN) — wie ein Anfänger, der schaut, wohin er will.
    for (const look of [-30, -15, 0, 15, 30, Number.NaN]) {
      for (const hold of [false, true]) {
        const name = `CP${cp.order} ${Number.isNaN(look) ? 'Blick Flugrichtung' : `Blick Knoten ${look > 0 ? '+' : ''}${look}°`}${hold ? ' + Leertaste' : ''}`;
        const res = wHolder(level, route, from, cp.spawnPos, look, hold, goal.bounds, cfg, LOOK_AHEAD);
        runs++;
        if (!res.ok) fails.push(`${name}: ${res.reason} nach ${res.time.toFixed(1)} s bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)}`);
        else slow = Math.max(slow, res.time);
        if (Number.isNaN(look)) continue;
        const near = wHolder(level, route, from, cp.spawnPos, look, hold, goal.bounds, cfg, 0);
        if (near.reason === 'kill' || near.reason === 'fell') dead.push(`${name} (nächster Knoten): ${near.reason} nach ${near.time.toFixed(1)} s bei ${f0(near.end.x)},${f0(near.end.y)},${f0(near.end.z)}`);
        else if (!near.ok) stuck++;
      }
    }
  }
  if (fails.length) r.errors.push(`Design L3: Außenbahn fängt Nicht-Drücker nicht — ${fails.length}/${runs} W-Halter tot oder hängen (${fails.slice(0, 3).join('; ')})`);
  else r.info.push(`Design L3: Außenbahn fängt Nicht-Drücker — ${runs}/${runs} W-Halter ab CP1/CP2 (Blick ≥ ${LOOK_AHEAD} u voraus ±15/±30°/0°, Flugrichtung; mit/ohne Leertaste) am nächsten Checkpoint, langsamster ${slow.toFixed(1)} s`);
  const nearRuns = (runs * 5) / 6;
  if (dead.length) r.errors.push(`Design L3: W-Halter mit Blick auf den nächsten Knoten sterben — ${dead.length}/${nearRuns} (${dead.slice(0, 3).join('; ')})`);
  else r.info.push(`Design L3: W-Halter mit Blick auf den nächsten Knoten — 0/${nearRuns} Tode, ${stuck} Stau (drücken senkrecht in die Flanke)`);
}

function wHolder(level: CompiledLevel, route: readonly RouteNode[], from: number, spawn: Vector3, look: number, hold: boolean, goal: Box3, cfg: MovementConfig, ahead: number): ProbeOutcome {
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(spawn);
  const out = makeBotInput();
  let node = from;
  let first = true;
  const off = (look * Math.PI) / 180;
  const ctl: Controller = {
    next: (s) => {
      while (node < route.length - 1) {
        const n = route[node].pos;
        if (Math.hypot(n[0] - s.pos.x, n[2] - s.pos.z) < 80 || (node > 0 && passedNode(route, node, s.pos))) node++;
        else break;
      }
      // Blickziel: erster Knoten ≥ `ahead` voraus (0 = der nächste; Stau-Fall siehe outerCatchesHolders).
      let aim = node;
      while (aim < route.length - 1 && Math.hypot(route[aim].pos[0] - s.pos.x, route[aim].pos[2] - s.pos.z) < ahead) aim++;
      const n = route[aim].pos;
      const toNode = Math.atan2(-(n[0] - s.pos.x), -(n[2] - s.pos.z));
      out.yaw = Number.isNaN(look) ? (s.speed > 50 ? Math.atan2(-s.vel.x, -s.vel.z) : toNode) : toNode + off;
      out.pitch = 0;
      out.forward = 1;
      out.side = 0;
      out.sprint = true;
      out.crouch = false;
      out.jumpHeld = hold;
      out.jumpPressed = hold && first;
      first = false;
      return out;
    },
  };
  return simulate(level, pm, ctl, { cfg, goal, timeout: 40 });
}

// ---------------------------------------------------------------------------
// 3. Pads

/** 3. Abstand jedes Checkpoint-Pads zu beiden Linien (Knoten-Segmente, alle 8 u abgetastet; Füße gegen Pad-Bounds). */
function padClearance(level: CompiledLevel, r: DesignReport): void {
  const pads = level.brushes.filter((b) => b.tag !== null && /^cp\d+pad$/.test(b.tag));
  if (pads.length !== 3) {
    r.errors.push(`Design L3: Pad-Probe findet ${pads.length} statt 3 Checkpoint-Pads (cp<n>pad)`);
    return;
  }
  const lines: Array<[string, readonly RouteNode[]]> = [
    ['route', level.def.route ?? []],
    ['safeRoute', level.def.safeRoute ?? []],
  ];
  const p = new Vector3();
  const parts: string[] = [];
  const bad: string[] = [];
  for (const pad of pads) {
    for (const [name, route] of lines) {
      let best = Infinity;
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1].pos;
        const b = route[i].pos;
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 8));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          p.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
          best = Math.min(best, pad.bounds.distanceToPoint(p));
        }
      }
      parts.push(`${pad.tag} ${name} ${f0(best)}`);
      if (best < PAD_CLEARANCE) bad.push(`${pad.tag} ↔ ${name}: ${f0(best)} u`);
    }
  }
  if (bad.length) r.errors.push(`Design L3: Checkpoint-Pad zu nah an einer Linie (Soll ≥ ${PAD_CLEARANCE} u): ${bad.join(', ')}`);
  else r.info.push(`Design L3: Pads frei von den Linien (≥ ${PAD_CLEARANCE} u) — ${parts.join(', ')} u`);
}

// ---------------------------------------------------------------------------
// 4. Grundtechnik-Surfer auf der eigenen Bahn

/**
 * Start des Grundtechnik-Surfers ab einem Checkpoint auf der Bahn einer Linie: der CP-Spawn, wenn er auf ihrer Seite
 * des Grats liegt; sonst der erste Surf-Knoten der Linie nach dem Wiedereinstieg auf ihrer Seite (Stand). Die Spawns
 * liegen rechts vom Grat (Türkis); wer innen will, tritt links vom Pad — der SurfRider selbst wechselt nie die Seite,
 * er drückt in die Flanke, auf der er landet (fallen.md #32: ein Bot-Fehler ist erst mit dem Grundtechnik-Surfer ein Level-Fehler).
 */
function surferStart(level: CompiledLevel, route: readonly RouteNode[], cp: CompiledTrigger, ridge: readonly RidgePoint[], side: 1 | -1): { readonly pos: Vector3; readonly where: string } | null {
  const from = resumeIndex(route, cp);
  if (from < 0) return null;
  // Erster Surf-Knoten nach dem Wiedereinstieg: liegt er nicht über der Gabel (CP3 → R1), gibt es keine Seite zu wählen.
  const first = route.findIndex((n, i) => i >= from && n.surf === true);
  if (first < 0) return null;
  const f = route[first].pos;
  if (!overFork(level, f[0], f[1], f[2]) || Math.sign(ridgeSide(ridge, cp.spawnPos.x, cp.spawnPos.z).lateral) === side) return { pos: cp.spawnPos, where: 'Spawn' };
  for (let i = first; i < route.length; i++) {
    const n = route[i].pos;
    if (route[i].surf === true && overFork(level, n[0], n[1], n[2]) && Math.sign(ridgeSide(ridge, n[0], n[2]).lateral) === side) return { pos: new Vector3(n[0], n[1] + 4, n[2]), where: `Knoten ${i}` };
  }
  return null;
}

/** 4. Grundtechnik-Surfer aus dem Stand je Checkpoint (Blick 0°, +2° als Info): Tempo am nächsten Checkpoint/Ziel. */
function surferSpeed(level: CompiledLevel, safe: CompiledLevel, ridge: readonly RidgePoint[], cfg: MovementConfig, r: DesignReport): void {
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const lines: Array<[string, CompiledLevel]> = [
    ['route', level],
    ['safeRoute', safe],
  ];
  for (const [name, lvl] of lines) {
    const route = lvl.def.route ?? [];
    const side = lineSide(lvl, route, ridge);
    const lane = side < 0 ? 'Koralle, innen' : 'Türkis, außen';
    const parts: string[] = [];
    const slow: string[] = [];
    const wrong: string[] = [];
    for (const cp of cps) {
      const goal = nextGoal(lvl, cp.order);
      const start = surferStart(lvl, route, cp, ridge, side);
      if (!goal || !start) {
        r.errors.push(`Design L3 [${name}]: Grundtechnik-Surfer ab CP${cp.order} — kein Ziel oder kein Start auf der eigenen Bahn`);
        continue;
      }
      const run = (look: number): { readonly res: ProbeOutcome; readonly share: number; readonly ticks: number } => {
        const pm = new PlayerMovement(lvl.world, cfg);
        pm.teleport(start.pos);
        const tr = new LaneTracker(new SurfRider(cfg, lvl.world, routeAxis(route), (look * Math.PI) / 180), lvl, ridge, side);
        return { res: simulate(lvl, pm, tr, { cfg, goal: goal.bounds, timeout: 30 }), share: tr.share, ticks: tr.ticks };
      };
      const a = run(0);
      const b = run(2);
      const v = a.res.ok ? a.res.goalSpeed : 0;
      const at = start.where === 'Spawn' ? '' : ` ab ${start.where}`;
      const laneText = a.ticks > 0 ? `, ${f0(100 * a.share)} % auf der Bahn` : ', Gabel vorbei';
      parts.push(`CP${cp.order}${at} ${a.res.ok ? f0(v) : a.res.reason}${laneText} (+2°: ${b.res.ok ? f0(b.res.goalSpeed) : b.res.reason})`);
      if (v < SURFER_MIN_SPEED) slow.push(`CP${cp.order} ${a.res.ok ? `${f0(v)} u/s` : a.res.reason}`);
      if (a.share < LANE_SHARE) wrong.push(`CP${cp.order}: ${f0(100 * a.share)} % der ${a.ticks} Luftticks über der Gabel auf der Sollseite`);
    }
    const text = `Grundtechnik-Surfer (Blick 0°) aus dem Stand auf ${lane}, Tempo am nächsten Checkpoint: ${parts.join(', ')} u/s`;
    if (wrong.length) r.errors.push(`Design L3 [${name}]: Probe fährt falsche Bahn (Soll ≥ ${f0(100 * LANE_SHARE)} % auf ${lane}) — ${wrong.join('; ')}`);
    if (slow.length) r.errors.push(`Design L3 [${name}]: ${text} — unter ${SURFER_MIN_SPEED}: ${slow.join(', ')}`);
    else r.info.push(`Design L3 [${name}]: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Risiko innen: Aussetzer-Modell

/** Mensch, der beim Surfen zwischendurch A/D loslässt: Hand (Grad), Aussetzer (s) je Periode (s). */
export interface LapseModel {
  readonly aimNoiseDeg: number;
  readonly lapse: number;
  readonly period: number;
}

/**
 * Ganzer Lauf wie physics.timedRun (RunState, Tode kosten Zeit, Respawn am letzten Checkpoint), aber die Hand lässt
 * beim Surfen periodisch A/D los (Phase je Seed verschieden). Der RouteFollower hält jede Kurve, die er hält, mit
 * Dauerdruck — Menschen setzen aus (Blick zur Seite, Umgreifen, zu früh losgelassen). Genau das trennt die Bahnen:
 * innen trägt die konkave Flanke, aber ohne Netz; außen rutscht man aufs Band.
 */
export function lapseRun(level: CompiledLevel, m: LapseModel, seed: number, cfg: MovementConfig, timeout = 120): LapseRun {
  const route = level.def.route ?? [];
  const pm = new PlayerMovement(level.world, cfg);
  const run = new RunState(level);
  run.reset(null);
  const events: RunEvent[] = [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const place = (p: Vector3): void => pm.teleport(new Vector3(p.x, p.y + 1, p.z));
  const follower = (from: number, start: Vector3): RouteFollower =>
    new RouteFollower(route.slice(from), cfg, {
      aimNoiseDeg: m.aimNoiseDeg,
      seed,
      killY: level.def.killY,
      world: level.world,
      start: { x: start.x, z: start.z },
      stallTimeout: 12,
      timeout: timeout + 1,
    });
  place(level.spawnPos);
  let bot = follower(0, level.spawnPos);
  const out = makeBotInput();
  const dt = 1 / cfg.tickRate;
  const phase = ((seed * 0.6180339887) % 1) * m.period;
  let deaths = 0;
  // Tode je Abschnitt (Index = letzter erreichter Checkpoint: 0 = Start → CP1 … cps.length = letzter CP → Ziel).
  const at = new Array<number>(cps.length + 1).fill(0);
  const done = (time: number | null, reason: string | null): LapseRun => ({ time, deaths, reason, splits: run.splits(), deathsAt: at });
  for (let t = 0; t < timeout * cfg.tickRate; t++) {
    Object.assign(out, bot.next(pm.state, pm.surfNormal));
    if (pm.state.surfing && (t * dt + phase) % m.period < m.lapse) out.side = 0;
    pm.tick(out);
    const s = pm.state;
    const o = run.tick(dt, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, events);
    if (o === 'finish') return done(run.time, null);
    if (o === 'fall' || o === 'kill') {
      deaths++;
      at[run.checkpoint]++;
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      place(sp.pos);
      const from = run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0;
      bot = follower(from, sp.pos);
      continue;
    }
    if (bot.status === 'failed') return done(null, bot.report.reason ?? 'bot');
  }
  return done(null, 'timeout');
}

/** Lauf des Aussetzer-Modells: wie TimedRun, dazu die Tode je Abschnitt. */
export interface LapseRun extends TimedRun {
  readonly deathsAt: readonly number[];
}

/** Kennzahlen des Aussetzer-Modells über Seeds: Läufe mit Tod, im Ziel, Median (gescheiterte zählen als langsamste). */
export function lapseStats(
  level: CompiledLevel,
  m: LapseModel,
  seeds: readonly number[],
  cfg: MovementConfig,
): { readonly withDeath: number; readonly forkDeath: number; readonly finished: number; readonly median: number | null; readonly runs: readonly LapseRun[] } {
  const runs = seeds.map((s) => lapseRun(level, m, s, cfg));
  const times = runs.flatMap((x) => (x.time === null ? [] : [x.time])).sort((a, b) => a - b);
  return {
    withDeath: runs.filter((x) => x.deaths > 0).length,
    // Gabel = CP1 → CP2 → CP3 (die Kehre); davor W1, danach R1/Z/Finale — dort teilen beide Linien die Rampen.
    forkDeath: runs.filter((x) => (x.deathsAt[1] ?? 0) + (x.deathsAt[2] ?? 0) > 0).length,
    finished: times.length,
    median: times.length * 2 > runs.length ? times[Math.floor((runs.length - 1) / 2)] : null,
    runs,
  };
}

/**
 * 6. Risiko nur innen: das Aussetzer-Modell stirbt in der Kehre auf Koralle in ≥ LAPSE_RISK der Läufe, auf Türkis nie.
 * Die Zeiten stehen nur im Bericht: auch mit Toden ist Koralle schneller (ein Tod kostet ~4 s ab dem nahen CP, jeder
 * Aussetzer auf der konvexen Außenflanke kostet Tempo beim Zurückklettern). Türkis-Läufe ohne Ziel sind Bot-Stau
 * (RouteFollower, fallen.md #73), keine Tode.
 */
function lapseRisk(level: CompiledLevel, safe: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const a = lapseStats(level, LAPSE, LAPSE_SEEDS, cfg);
  const b = lapseStats(safe, LAPSE, LAPSE_SEEDS, cfg);
  const n = LAPSE_SEEDS.length;
  const t = (x: number | null): string => x?.toFixed(2) ?? '–';
  const text =
    `Aussetzer-Modell (Hand ${LAPSE.aimNoiseDeg}°, A/D beim Surfen ${LAPSE.lapse} s alle ${LAPSE.period} s los, ${n} Seeds): ` +
    `Koralle ${a.forkDeath}/${n} Läufe mit Tod in der Kehre (${a.withDeath} insgesamt), ${a.finished}/${n} im Ziel, Median ${t(a.median)} s; ` +
    `Türkis ${b.forkDeath}/${n} mit Tod in der Kehre (${b.withDeath} insgesamt), ${b.finished}/${n} im Ziel, Median ${t(b.median)} s`;
  if (a.forkDeath < LAPSE_RISK * n || b.forkDeath > 0) r.warnings.push(`Design L3: Risiko der Innenbahn nicht wie behauptet (Soll: Koralle ≥ ${f0(100 * LAPSE_RISK)} % der Läufe mit Tod in der Kehre, Türkis keiner) — ${text}`);
  else r.info.push(`Design L3: Risiko nur innen — ${text}`);
}
