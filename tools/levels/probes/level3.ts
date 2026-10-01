/**
 * Design-Proben Level 3 "03 BRANDUNG" (Plan 007, Phase 2: Strang level3) — designProbes.ts ruft sie für id 'level3'.
 *
 * Die Behauptungen der Gabel (tools/levels/level3.ts, .docs/research/levels/level3.md), mit echter Physik:
 * 1. Innenvorteil: Koralle (route) ist spürbar schneller als Türkis (safeRoute) — für den perfekten Bot UND die
 *    3°-Hand. Gemessen mit wenig Rauschen: sync 1.0 als Median über die 49 Start-Jitter (wie die Medaillen),
 *    Hand 3° über 24 Seeds (die 8 Validator-Seeds streuen auf Türkis um ±1.5 s, Zahl steht mit im Bericht).
 * 2. Außenbahn fängt Nicht-Drücker: W-Halter ab dem Start (rechts der Finne, W1-Band) und ab CP1/CP2 (Blick auf einen
 *    Türkis-Knoten ≥ 320 u voraus ±15/±30° oder in Flugrichtung, mit und ohne Leertaste) erreichen den nächsten
 *    Checkpoint ohne Tod; mit Blick auf den nächsten Knoten stirbt keiner (Stau erlaubt).
 * 3. Kein Checkpoint-Pad liegt näher als 64 u an einer der beiden Linien (Pads in der Fahrlinie stoppen, #47).
 * 4. Grundtechnik-Surfer (Blick 0°) ist an jedem folgenden Checkpoint ≥ 700 u/s schnell — auf beiden Linien, und
 *    zwar auf der EIGENEN Bahn (Bahnprüfung über den Grat, sonst Fehler).
 * 5. Finale aus dem CP3-Respawn landet mit ≥ 10 % Weitenreserve (beide Linien).
 * 6. Risiko nur innen: Aussetzer-Modell (Hand 2°, A/D beim Surfen periodisch losgelassen) stirbt auf Koralle,
 *    auf Türkis nie. Die Gabel ist für jeden, der die Kurve HÄLT, keine Zeitfrage (Abnahme: Hand 1–3° 0 Tode,
 *    Quote ≤ 0.90) — sie trennt, wer sie hält, von dem, der zwischendurch loslässt.
 * 7. Medaillen-Stichprobe: Bronze/Silber (build.ts: Hand 3°/2° auf safeRoute, schnellere Technik aus RouteFollower und
 *    Surfer, Median über 48 Seeds) gegen 24 Seeds —
 *    schafft die Hand, für die die Medaille steht, sie in weniger als der Hälfte der Läufe, warnt die Probe.
 * 8. Bande-Gleiter: wer auf dem Band an der unsichtbaren Außenbande entlanggleitet oder -hüpft, kommt über jede
 *    Fuge (W1 → Viertel 1 … Viertel 3 → 4) mit ≤ 10 % Tempoverlust (Review Phase 3: Lippe 1.5 u, 943 → 0 u/s).
 * 9. Mensch-Band: Grundtechnik-Surfer mit Blickversatz, Blick-Verzug und Rauschen ab dem Brett, ab CP1/CP2 und quer
 *    über W1 berührt kein Checkpoint-Pad (Luftticks ≥ PAD_AIR_GAP daneben) und bricht nie in einem Tick ein (Review
 *    Phase 3: Pads im Flugband); ab CP3 kommt jeder ins Ziel (Türkis-Bandfahrer sterben nach CP3 am Rand von R1 — der
 *    Respawn muss sie tragen). Dazu die Zeiten gegen die Medaillen (build.ts misst jede Stufe mit derselben Hand auch an
 *    derselben Grundtechnik, `level3Reference`): Warnung, wenn sie den Autor deutlich unterbietet oder Türkis VELOCITY schafft.
 *    Info: Koralle-Wähler, die vom Spawn schräg links um die Finne laufen (bekannte Falle am Drop W1 → Viertel 1).
 * 10. Blickfehler (E2E-Review v2final): ab CP3 kommt jeder mit festem Blickversatz −6…+10° ins Ziel (Fehler sonst);
 *    die Bronze-Hand auf Türkis mit Versatz −4…+4° gegen Bronze (Warnung, wenn sie im Band ±2° Bronze verfehlt).
 * Geometrie über Tags (cp<n>pad, outer<k><a–z>), Linien über route/safeRoute — nie über Notizen.
 */
import { Box3, Vector3 } from 'three';
import type { RunEvent } from '../../../src/engine/events';
import { RunState } from '../../../src/engine/runState';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import type { PlayerInput, PlayerSnapshot } from '../../../src/player/types';
import { RouteFollower, makeBotInput, mulberry32 } from '../../../src/player/bots';
import { BrushWorld } from '../../../src/world/collision/BrushWorld';
import type { CollisionWorld, CompiledBrush } from '../../../src/world/collision/types';
import type { CompiledLevel, CompiledTrigger } from '../../../src/world/level/compileLevel';
import type { LevelFile, RouteNode } from '../../../src/world/level/LevelFormat';
import { finaleReserve, passedNode, type DesignReport } from '../designProbes';
import {
  SurfRider,
  jitterMedian,
  nextGoal,
  medianOf,
  resumeIndex,
  routeAxis,
  simulate,
  timedMedian,
  withRoute,
  type Controller,
  type MedalReference,
  type ProbeOutcome,
  type ReferenceRuns,
  type StrafeModel,
  surfSigma,
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
  bankGliders(level, cfg, r);
  humanBand(level, cfg, r);
  lookBias(level, cfg, r);
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

/** Surf-Stücke der Strecke: W1, beide Kehren-Bahnen, R1, Z, Finale (lib.SurfPath-Tags). */
const RAMP_TAG = /^(w1|outer[1-4][a-z]|inner[1-4][a-z]|r1|z|finale[a-z])$/;

/**
 * Fahrtrichtung der nächsten Surf-Rampe (yaw, rad) an (x, z) — so blickt, wer "entlang der Rampe" schaut. Aus den
 * Fugen-Querschnitten der Stücke (lib.SurfPath: je Fuge [Grat, links, rechts] bzw. [Grat, Fuß, Innenwand]).
 * Statt der Route-Achse: die zog zwischen W1 und Viertel 1 schräg über die Bahn, ein Fahrer an der Finne blickte
 * dort 18° in die Rampe und bremste sich selbst (Mess-Artefakt).
 */
export function rampAxis(def: LevelFile): (x: number, z: number) => number {
  const segs: Array<{ ax: number; az: number; bx: number; bz: number; yaw: number }> = [];
  for (const b of def.brushes) {
    if (b.type !== 'hull' || b.tag === undefined || !RAMP_TAG.test(b.tag)) continue;
    const P = b.points;
    if (P.length !== 6) continue;
    const both = !/^(outer|inner)/.test(b.tag);
    const sign = b.tag.startsWith('inner') ? -1 : 1;
    const rx = sign * (P[both ? 2 : 1][0] - P[0][0]);
    const rz = sign * (P[both ? 2 : 1][2] - P[0][2]);
    segs.push({ ax: P[0][0], az: P[0][2], bx: P[3][0], bz: P[3][2], yaw: Math.atan2(-rz, rx) });
  }
  return (x, z) => {
    let best = Infinity;
    let yaw = 0;
    for (const s of segs) {
      const sx = s.bx - s.ax;
      const sz = s.bz - s.az;
      const l2 = sx * sx + sz * sz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * sx + (z - s.az) * sz) / l2)) : 0;
      const d = (x - s.ax - sx * t) ** 2 + (z - s.az - sz * t) ** 2;
      if (d < best) {
        best = d;
        yaw = s.yaw;
      }
    }
    return yaw;
  };
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
 * 7. Bronze/Silber stehen für die 3°/2°-Hand auf der sicheren Linie (build.ts, Median über 48 Seeds × 1.05) — mit der
 * schnelleren Technik derselben Hand: RouteFollower oder Grundtechnik-Surfer (`level3Reference`, Türkis). Gemessen wird,
 * wie viele von 24 Läufen der Medaillen-Hand die Medaille wirklich schaffen. Weniger als die Hälfte = die Medaille hängt
 * an einer glücklichen Stichprobe (Warnung; die Messung selbst gehört build.ts).
 */
function medalSample(level: CompiledLevel, safe: CompiledLevel, hand3: readonly TimedRun[], cfg: MovementConfig, r: DesignReport): void {
  const m = level.def.medals;
  if (!m) return;
  const hand2 = timedMedian(safe, { aimNoiseDeg: 2 }, HAND_SEEDS, cfg).runs;
  const ref = level3Reference();
  const parts: string[] = [];
  const short: string[] = [];
  for (const [name, limit, bot, deg] of [
    ['Bronze', m.bronze, hand3, 3],
    ['Silber', m.silver, hand2, 2],
  ] as const) {
    // Wie build.ts: die schnellere Technik (Median) zählt.
    // Blick wie build.ts: Bronze wie gelehrt (0°), Silber der beste Versatz.
    const surf = ref.runs(safe, { aimNoiseDeg: deg }, 'safeRoute', false, HAND_SEEDS, { cfg, look: deg === 3 ? 'lesson' : 'best' });
    const bm = medianOf(bot);
    const sm = surf ? medianOf(surf.runs) : null;
    const useSurf = sm !== null && (bm === null || sm < bm);
    const runs = useSurf && surf ? surf.runs : bot;
    const ok = runs.filter((x) => x.time !== null && x.time <= limit).length;
    const med = useSurf ? sm : bm;
    const would = med !== null ? Math.ceil(med * 1.05 * 10 - 1e-6) / 10 : NaN;
    parts.push(
      `${name} ${limit} s: Hand ${deg}° auf Türkis ${useSurf ? `surfend (${surf?.detail ?? ''})` : 'RouteFollower'} ${ok}/${runs.length} ` +
        `(24-Seed-Median ${med?.toFixed(2) ?? '–'} → ${would.toFixed(1)} s; RouteFollower ${bm?.toFixed(2) ?? '–'} s)`,
    );
    if (ok < MEDAL_SHARE * runs.length) short.push(name);
  }
  const text = `Medaillen-Stichprobe — ${parts.join('; ')}`;
  if (short.length) r.warnings.push(`Design L3: ${short.join('/')} zu streng für die Medaillen-Hand (build.ts misst über 48 Seeds) — ${text}`);
  else r.info.push(`Design L3: ${text}`);
}

// ---------------------------------------------------------------------------
// 2. W-Halter auf Türkis

/** Blickmodelle der W-Halter: erster Türkis-Knoten mindestens so weit voraus (u); 0 = der nächste. */
const HOLDER_AHEAD = [LOOK_AHEAD, 200, 120, 0] as const;

/**
 * 2. W-Halter auf Türkis ab dem Start (Spawn rechts der Finne, W1-Band) und ab CP1/CP2: 5 Blicke (Knoten ±15/±30/0°) ×
 * mit/ohne Leertaste je Blickmodell, dazu Blick in Flugrichtung. Abnahme (Fehler): mit Blick ≥ LOOK_AHEAD voraus
 * erreicht jeder den nächsten Checkpoint, und in KEINEM Modell stirbt einer. Mit kürzerem Blickziel steht mancher
 * (Bericht, kein Fehler): auf dem Band liegt der nächste Knoten oft direkt NEBEN einem an der Flanke, W drückt senkrecht
 * hinein (Stau, fallen.md #73/#123) — wer schaut, wohin er will, hüpft weiter. Alle vier Modelle stehen im Bericht
 * (Review: das 320-u-Modell war nachträglich gewählt). Bis zum W1-Band starben W-Halter ab dem Start 12/12 auf W1.
 */
function outerCatchesHolders(level: CompiledLevel, safe: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const route = safe.def.route ?? [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint' && (t.order === 1 || t.order === 2));
  if (cps.length !== 2) {
    r.errors.push('Design L3: W-Halter-Probe findet CP1/CP2 nicht');
    return;
  }
  // Start = "CP0": Spawn auf dem Brett, Route ab Knoten 1.
  const starts = [{ order: 0, spawn: level.spawnPos, from: 1 }, ...cps.map((cp) => ({ order: cp.order, spawn: cp.spawnPos, from: resumeIndex(route, cp) }))];
  const fails: string[] = [];
  const dead: string[] = [];
  const per: string[] = [];
  let slow = 0;
  for (const ahead of HOLDER_AHEAD) {
    let runs = 0;
    let ok = 0;
    let stuck = 0;
    for (const st of starts) {
      const goal = nextGoal(level, st.order);
      const at = st.order === 0 ? 'Start' : `CP${st.order}`;
      if (!goal || st.from < 1) {
        r.errors.push(`Design L3: W-Halter-Probe — kein Ziel oder Wiedereinstieg ab ${at}`);
        return;
      }
      // Blick: auf den Türkis-Knoten + Versatz (Grad) oder in Flugrichtung (NaN, nur einmal) — wie ein Anfänger, der schaut, wohin er will.
      for (const look of ahead === LOOK_AHEAD ? [-30, -15, 0, 15, 30, Number.NaN] : [-30, -15, 0, 15, 30]) {
        for (const hold of [false, true]) {
          const name = `${at} ${Number.isNaN(look) ? 'Blick Flugrichtung' : `Blick Knoten ${look > 0 ? '+' : ''}${look}°`}${hold ? ' + Leertaste' : ''} (${ahead} u voraus)`;
          const res = wHolder(level, route, st.from, st.spawn, look, hold, goal.bounds, cfg, ahead);
          runs++;
          const where = `${res.reason} nach ${res.time.toFixed(1)} s bei ${f0(res.end.x)},${f0(res.end.y)},${f0(res.end.z)}`;
          if (res.ok) {
            ok++;
            if (ahead === LOOK_AHEAD) slow = Math.max(slow, res.time);
          } else if (res.reason === 'kill' || res.reason === 'fell') dead.push(`${name}: ${where}`);
          else {
            stuck++;
            if (ahead === LOOK_AHEAD) fails.push(`${name}: ${where}`);
          }
        }
      }
    }
    per.push(`${ahead} u voraus ${ok}/${runs} am CP${stuck ? `, ${stuck} Stau` : ''}`);
  }
  const text = per.join('; ');
  if (dead.length) r.errors.push(`Design L3: W-Halter auf Türkis sterben — ${dead.length} Läufe (${dead.slice(0, 3).join('; ')}); ${text}`);
  if (fails.length) r.errors.push(`Design L3: Außenbahn fängt Nicht-Drücker nicht — ${fails.length} W-Halter mit Blick ≥ ${LOOK_AHEAD} u voraus hängen (${fails.slice(0, 3).join('; ')})`);
  if (!dead.length && !fails.length)
    r.info.push(
      `Design L3: Außenbahn fängt Nicht-Drücker — W-Halter ab Start/CP1/CP2 (Blick auf einen Türkis-Knoten ±15/±30°/0°, mit/ohne Leertaste; Flugrichtung), ` +
        `0 Tode: ${text}; langsamster ${slow.toFixed(1)} s`,
    );
}

/** W-Halter ab `spawn` bis `goal`: Blick auf den ersten Knoten ≥ `ahead` u voraus (+ `look` Grad; NaN = Flugrichtung), W, optional Leertaste. */
export function wHolder(level: CompiledLevel, route: readonly RouteNode[], from: number, spawn: Vector3, look: number, hold: boolean, goal: Box3, cfg: MovementConfig, ahead: number): ProbeOutcome {
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
// Bande-Gleiter an den Viertel-Fugen des Auffang-Bands

/** Fugen-Fall: Fuge Viertel `joint` → `joint`+1 (0 = W1-Band), Abstand Hull ↔ Bande (u), Tempo entlang (u/s), Eingabe. */
export interface GlideCase {
  readonly joint: number;
  readonly d: number;
  readonly v: number;
  /** 'hop': W + Leertaste gehalten, auf dem Band; 'air': ohne Eingabe, 64 u über dem Band, 60 u vor dem Bankende. */
  readonly input: 'hop' | 'air';
}

export interface GlideResult {
  /** Kleinstes Tempo zwischen 40 u vor und 160 u hinter dem Ende der Bank (u/s). */
  readonly min: number;
  /** Größter Einbruch in einem Tick (Anteil). */
  readonly worstTick: number;
  readonly passed: boolean;
}

const GLIDE_DOWN = new Vector3(-16, 0, -16);
const GLIDE_UP = new Vector3(16, 72, 16);

/**
 * Wer die konvexe Türkis-Flanke verliert, gleitet oder hüpft auf dem Band an der unsichtbaren Außenbande entlang —
 * über die Fugen der Viertel. Dort stand die erste Bank des Folgeviertels 1.5 u vor der Innenfläche der vorigen (943 →
 * 0 u/s, Review Phase 3). Start vor dem Ende der letzten Bank von Viertel `joint`, Hull-Kante `d` vor ihrer Innenfläche
 * (Ausdehnung der achsparallelen Hull quer zur Fläche mitgerechnet), Tempo `v` entlang.
 */
export function bankGlide(level: CompiledLevel, c: GlideCase, cfg: MovementConfig): GlideResult {
  const hulls = level.def.brushes.filter((b) => b.type === 'hull' && b.tag === `outerCatch${c.joint}Bank`);
  const last = hulls[hulls.length - 1];
  if (last?.type !== 'hull') return { min: 0, worstTick: 1, passed: false };
  // catchBand-Punkte je Fuge: oben innen, oben außen, unten innen, unten außen (Fuge a 0–3, Fuge b 4–7).
  const P = last.points;
  const ul = Math.hypot(P[4][0] - P[0][0], P[4][2] - P[0][2]);
  const ux = (P[4][0] - P[0][0]) / ul;
  const uz = (P[4][2] - P[0][2]) / ul;
  const ol = Math.hypot(P[0][0] - P[1][0], P[0][2] - P[1][2]);
  const nx = (P[0][0] - P[1][0]) / ol;
  const nz = (P[0][2] - P[1][2]) / ol;
  const back = c.input === 'hop' ? 160 : 60;
  const reach = 16 * (Math.abs(nx) + Math.abs(nz)) + c.d;
  const x = P[4][0] - ux * back + nx * reach;
  const z = P[4][2] - uz * back + nz * reach;
  const tr = level.world.traceBox(new Vector3(x, P[0][1], z), new Vector3(x, P[0][1] - 1200, z), GLIDE_DOWN, GLIDE_UP);
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(new Vector3(x, tr.endPos.y + (c.input === 'hop' ? 2 : 64), z));
  pm.state.vel.set(ux * c.v, 0, uz * c.v);
  const out = makeBotInput();
  out.yaw = Math.atan2(-ux, -uz);
  out.sprint = true;
  let min = Infinity;
  let worst = 0;
  let prev = c.v;
  let passed = false;
  for (let i = 0; i < 1.5 * cfg.tickRate; i++) {
    const hop = c.input === 'hop';
    out.forward = hop ? 1 : 0;
    out.jumpHeld = hop;
    out.jumpPressed = hop && i === 0;
    pm.tick(out);
    const s = pm.state;
    const along = (s.pos.x - P[4][0]) * ux + (s.pos.z - P[4][2]) * uz;
    if (along > -40 && along < 160) {
      min = Math.min(min, s.speed);
      if (prev > 100) worst = Math.max(worst, (prev - s.speed) / prev);
    }
    prev = s.speed;
    if (along >= 160) {
      passed = true;
      break;
    }
    // Ohne Eingabe nur die Luftphase: am Boden bremst die Reibung, nicht die Bande.
    if (!hop && s.onGround) break;
  }
  return { min: Number.isFinite(min) ? min : c.v, worstTick: worst, passed: passed || c.input === 'air' };
}

/** Bande-Gleiter: höchstens so viel Tempoverlust über eine Fuge. */
export const GLIDE_LOSS = 0.1;

/** Fugen des Auffang-Bands: 0 = W1 → Viertel 1 (das W1-Band endet 128 u über dem nächsten), 1–3 = Viertel k → k+1. */
export const GLIDE_JOINTS = [0, 1, 2, 3] as const;

/** 8. Bande-Gleiter über alle Fugen: Abstand 0.5/4/16 u, 400/900 u/s, hüpfend und frei fliegend. */
function bankGliders(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const bad: string[] = [];
  let runs = 0;
  let worst = 0;
  for (const input of ['hop', 'air'] as const) {
    for (const joint of GLIDE_JOINTS) {
      for (const d of [0.5, 4, 16]) {
        for (const v of [400, 900]) {
          const g = bankGlide(level, { joint, d, v, input }, cfg);
          runs++;
          const loss = 1 - g.min / v;
          worst = Math.max(worst, loss);
          if (loss > GLIDE_LOSS || !g.passed) bad.push(`${input} ${joint === 0 ? 'W1' : `Viertel ${joint}`}→${joint + 1}, ${d} u, ${v} u/s: min ${f0(g.min)} u/s${g.passed ? '' : ', hängt'}`);
        }
      }
    }
  }
  const text = `${runs} Gleiter (hüpfend/frei, 0.5/4/16 u vor der Bande, 400/900 u/s) über die Fugen W1 → Viertel 1 → … → 4`;
  if (bad.length) r.errors.push(`Design L3: Außenbande bremst an den Fugen (Soll ≤ ${f0(100 * GLIDE_LOSS)} % Verlust) — ${bad.length}/${text}: ${bad.slice(0, 3).join('; ')}`);
  else r.info.push(`Design L3: Außenbande glatt — ${text}, größter Verlust ${(100 * worst).toFixed(1)} %`);
}


// ---------------------------------------------------------------------------
// 9. Mensch-Band: Grundtechnik mit Blickversatz, Verzug und Rauschen

/** Mensch mit Grundtechnik: Blickversatz zur Rampe (Grad, + = hinein), Blick-Verzug (Tiefpass, s), Rauschen (Grad), Seed. */
export interface HumanModel {
  readonly look: number;
  readonly lag: number;
  readonly sigma: number;
  readonly seed: number;
}

const DEG = Math.PI / 180;
/** Zeitkonstante des Blickrauschens (AR(1), s) — wie rv2-l3/novice.ts. */
const NOISE_TAU = 0.15;

/**
 * Grundtechnik-Surfer als Mensch (Review Phase 3, Modell aus rv2-l3/novice.ts): physics.SurfRider — Taste in die Rampe,
 * Blick entlang der Rampe + Versatz, frei in der Luft keine Eingabe; auf dem Startbrett Blick in Spawn-Richtung und an
 * der Kante springen — dazu Blick-Verzug (Tiefpass τ auf den Soll-Yaw: der Blick hinkt Kurven nach, in der Linkskurve
 * drückt das Koralle-Fahrer in die Rampe) und Rauschen (AR(1)). Achse = Richtung der Rampe (`rampAxis`), nicht die
 * Route: die Koralle-Linie zieht zwischen W1 und Viertel 1 schräg über die Bahn. Mit `walkYaw` läuft er zuerst von
 * einer Plattform (CP-Respawn), bis er fällt.
 */
export class HumanSurfer implements Controller {
  private readonly rider: SurfRider;
  private readonly out = makeBotInput();
  private readonly rand: () => number;
  private readonly k: number;
  private readonly lagK: number;
  private yaw = Number.NaN;
  private aim = 0;
  private walking: boolean;

  constructor(
    cfg: MovementConfig,
    world: CollisionWorld,
    axis: (x: number, z: number) => number,
    private readonly m: HumanModel,
    private readonly walkYaw: number | null,
  ) {
    this.rider = new SurfRider(cfg, world, axis, m.look * DEG);
    this.rand = mulberry32(m.seed * 7919 + 13);
    this.k = Math.exp(-1 / cfg.tickRate / NOISE_TAU);
    this.lagK = m.lag > 0 ? 1 - Math.exp(-1 / cfg.tickRate / m.lag) : 1;
    this.walking = walkYaw !== null;
  }

  next(s: PlayerSnapshot, n: Vector3): PlayerInput {
    const out = this.out;
    if (this.walking && this.walkYaw !== null) {
      if (s.onGround || s.vel.y > -50) {
        out.forward = 1;
        out.side = 0;
        out.jumpHeld = false;
        out.jumpPressed = false;
        out.crouch = false;
        out.sprint = true;
        out.pitch = 0;
        out.yaw = this.walkYaw;
        this.yaw = this.walkYaw;
        return out;
      }
      this.walking = false;
    }
    Object.assign(out, this.rider.next(s, n));
    if (Number.isNaN(this.yaw)) this.yaw = out.yaw;
    else {
      let d = out.yaw - this.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.yaw += d * this.lagK;
    }
    if (this.m.sigma > 0) {
      const g = Math.sqrt(-2 * Math.log(this.rand() || 1e-9)) * Math.cos(2 * Math.PI * this.rand());
      this.aim = this.aim * this.k + g * this.m.sigma * DEG * Math.sqrt(1 - this.k * this.k);
    }
    out.yaw = this.yaw + this.aim;
    return out;
  }
}

/** Gemeinsames für alle Läufe des Mensch-Bands. */
export interface HumanCtx {
  readonly pads: readonly CompiledBrush[];
  readonly padWorlds: readonly BrushWorld[];
  readonly axis: (x: number, z: number) => number;
  readonly start: Box3 | null;
  readonly kills: readonly CompiledTrigger[];
}

export interface HumanRun {
  /** Ziel bzw. Checkpoint erreicht: Spiel-Uhr (Brett) bzw. Zeit ab Start (s); sonst null. */
  readonly time: number | null;
  readonly reason: 'ziel' | 'tod' | 'stau';
  /** Abschnitt beim Tod (RunState.checkpoint: 0 = vor CP1 … 3 = nach CP3), sonst −1. */
  readonly deathAt: number;
  /** Berührte Checkpoint-Pads (Tags). */
  readonly pads: readonly string[];
  /** Erster Einbruch > 30 % in einem Tick (nicht im Ziel, nicht in den 2 s vor einem Tod), sonst null. */
  readonly collapse: string | null;
  /** Stau, während man auf dem Auffang-Band steht. */
  readonly bandStop: boolean;
  /** Kleinster Abstand Hull ↔ Pad in der Luft (u), je Pad. */
  readonly padGap: readonly number[];
}

const COLLAPSE = 0.3;
const HUMAN_TIMEOUT = 40;

export function humanCtx(level: CompiledLevel): HumanCtx {
  const pads = level.brushes.filter((b) => b.tag !== null && /^cp\d+pad$/.test(b.tag));
  return {
    pads,
    padWorlds: pads.map((p) => new BrushWorld([p])),
    axis: rampAxis(level.def),
    start: level.brushes.find((b) => b.tag === 'start')?.bounds ?? null,
    kills: level.triggers.filter((t) => t.kind === 'kill'),
  };
}

/**
 * Ein Lauf des Mensch-Modells: vom Brett (`goal` null, Spiel-Uhr bis ins Ziel, ohne Respawn) oder ab einem Punkt bis
 * zum Trigger `goal`. Auf dem Brett blickt er in Spawn-Richtung (Achse), von einer Plattform läuft er in `walkYaw`.
 */
export function humanRun(
  level: CompiledLevel,
  ctx: HumanCtx,
  pos: Vector3,
  walkYaw: number | null,
  goal: CompiledTrigger | null,
  m: HumanModel,
  cfg: MovementConfig,
): HumanRun {
  const sb = ctx.start;
  const onStart = (x: number, z: number): boolean => sb !== null && x > sb.min.x - 40 && x < sb.max.x + 40 && z > sb.min.z - 40 && z < sb.max.z + 40;
  const axis = (x: number, z: number): number => (onStart(x, z) ? level.spawnYaw * DEG : ctx.axis(x, z));
  const ctl = new HumanSurfer(cfg, level.world, axis, m, walkYaw);
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(pos);
  const run = new RunState(level);
  run.reset(null);
  const events: RunEvent[] = [];
  const dt = 1 / cfg.tickRate;
  const lo = new Vector3();
  const hi = new Vector3();
  const gMin = new Vector3();
  const gMax = new Vector3();
  const hit = (b: Box3): boolean => lo.x < b.max.x && hi.x > b.min.x && lo.y < b.max.y && hi.y > b.min.y && lo.z < b.max.z && hi.z > b.min.z;
  const hull = new Box3();
  const pads: string[] = [];
  const padGap = ctx.pads.map(() => Infinity);
  let collapse: string | null = null;
  let collapseT = -1;
  let prev = pm.state.speed;
  const done = (time: number | null, reason: HumanRun['reason'], t: number, bandStop = false): HumanRun => ({
    time,
    reason,
    deathAt: reason === 'tod' ? run.checkpoint : -1,
    pads,
    // Ein Einbruch kurz vor dem Tod gehört zum Absturz (Fuß der Flanke verlassen), nicht zur Bahn.
    collapse: reason === 'tod' && collapseT >= 0 && t - collapseT < 2 ? null : collapse,
    bandStop,
    padGap,
  });
  for (let i = 1; i <= HUMAN_TIMEOUT * cfg.tickRate; i++) {
    pm.tick(ctl.next(pm.state, pm.surfNormal));
    const s = pm.state;
    const t = i * dt;
    lo.copy(s.pos).add(pm.hullMins);
    hi.copy(s.pos).add(pm.hullMaxs);
    gMin.copy(pm.hullMins).addScalar(-1);
    gMax.copy(pm.hullMaxs).addScalar(1);
    for (let k = 0; k < ctx.pads.length; k++) {
      const tag = ctx.pads[k].tag ?? '';
      // Der eigene Respawn-Pad zählt nicht, solange man darauf steht.
      if (walkYaw !== null && t < 2 && ctx.padWorlds[k].testBox(pos, gMin, gMax)) continue;
      if (!pads.includes(tag) && ctx.padWorlds[k].testBox(s.pos, gMin, gMax)) pads.push(tag);
      if (!s.onGround) {
        hull.min.copy(lo);
        hull.max.copy(hi);
        padGap[k] = Math.min(padGap[k], boxGap(hull, ctx.pads[k].bounds));
      }
    }
    if (collapse === null && prev > 300 && s.speed < (1 - COLLAPSE) * prev) {
      collapse = `${f0(prev)} → ${f0(s.speed)} u/s bei ${f0(s.pos.x)},${f0(s.pos.y)},${f0(s.pos.z)}`;
      collapseT = t;
    }
    prev = s.speed;
    if (goal === null) {
      const o = run.tick(dt, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, events);
      if (o === 'finish') return done(run.time, 'ziel', t);
      if (o === 'fall' || o === 'kill') return done(null, 'tod', t);
    } else {
      if (hit(goal.bounds)) return done(t, 'ziel', t);
      if (s.pos.y < level.def.killY || ctx.kills.some((k) => hit(k.bounds))) return done(null, 'tod', t);
    }
  }
  // Stau: steht er auf dem Auffang-Band?
  const s = pm.state;
  const tr = level.world.traceBox(s.pos, new Vector3(s.pos.x, s.pos.y - 8, s.pos.z), pm.hullMins, pm.hullMaxs);
  const onBand = tr.fraction < 1 && /^outerCatch\d$/.test(level.brushes[tr.brushIndex]?.tag ?? '');
  return done(null, 'stau', HUMAN_TIMEOUT, onBand);
}

/** Seeds der Medaillen-Referenz je Blickversatz, wenn der Aufrufer keine vorgibt (die Probe fährt 4). */
export const REFERENCE_SEEDS: readonly number[] = Array.from({ length: 16 }, (_, i) => i + 1);
/**
 * Ein Blickversatz zählt für die Referenz nur, wenn so viele Läufe ins Ziel kommen. Der Median allein (Tod = langsamster)
 * nahm mit 48 Seeds Koralle −3° bei 25/48 im Ziel — eine Münze, keine Technik, die ein Mensch wählt.
 */
export const REFERENCE_FINISH = 0.8;

/** Bester Blickversatz der Grundtechnik vom Brett auf einer Spur: Läufe, Blick, Median (null = kein Blick trägt). */
export function bestLook(
  level: CompiledLevel,
  x: number,
  sigma: number,
  seeds: readonly number[],
  cfg: MovementConfig = VELOCITY_DEFAULT,
  looks: readonly number[] = HUMAN_LOOKS,
): { readonly runs: TimedRun[]; readonly look: number; readonly median: number } | null {
  const ctx = humanCtx(level);
  const pos = new Vector3(x, level.spawnPos.y + 1, level.spawnPos.z);
  let best: { runs: TimedRun[]; look: number; median: number } | null = null;
  for (const look of looks) {
    const runs = seeds.map((seed): TimedRun => {
      const h = humanRun(level, ctx, pos, null, null, { look, lag: 0, sigma, seed }, cfg);
      return { time: h.time, deaths: h.reason === 'tod' ? 1 : 0, reason: h.reason === 'ziel' ? null : h.reason, splits: [] };
    });
    if (runs.filter((r) => r.time !== null).length < REFERENCE_FINISH * runs.length) continue;
    const med = medianOf(runs);
    if (med !== null && (best === null || med < best.median)) best = { runs, look, median: med };
  }
  return best;
}

/**
 * Medaillen-Referenz L3 (build.ts, Freischalt-Leiter, Validator-Par): der Grundtechnik-Surfer (Taste in die Rampe, Blick
 * entlang, ohne Verzug) vom Brett — für JEDES Medaillen-Modell mit dessen Hand (`surfSigma`: Rauschen = aimNoiseDeg,
 * perfekt PERFECT_SURF_SIGMA), über Seeds. Blick `opts.look`: 'lesson' = 0° (T8 wörtlich, Bronze), 'best' = der beste Versatz aus −3…+1°, der
 * ≥ REFERENCE_FINISH ins Ziel bringt. Linie route = Koralle
 * (x −160), safeRoute = Türkis (x +160). Der RouteFollower strafet an jedem Drop zum nächsten Knoten und verliert
 * 150–190 u/s; seine 3°-Hand brauchte auf Türkis 26 s, dieselbe Hand surfend wie gelehrt 15.8 s — Bronze 27.3 s war
 * damit keine Aussage über Menschen, die T7/T8 bestanden haben.
 */
export function level3Reference(): MedalReference {
  return {
    name: 'L3-Grundtechnik (Hand-Rauschen, Blick je Stufe)',
    runs(level, model, line, _jitter, seeds, opts): ReferenceRuns | null {
      const x = line === 'route' ? HUMAN_XS[0] : HUMAN_XS[1];
      const sigma = surfSigma(model);
      const looks = opts?.look === 'lesson' ? [0] : HUMAN_LOOKS;
      const best = bestLook(level, x, sigma, seeds.length ? seeds : REFERENCE_SEEDS, opts?.cfg ?? VELOCITY_DEFAULT, looks);
      if (!best) return null;
      const n = best.runs.filter((r) => r.time !== null).length;
      // Seeds statt Start-Jitter: Tode sind hier das Risiko des Blickversatzes, keine Chaos-Zweige (Rauschen σ > 0 immer).
      return {
        runs: best.runs,
        detail: `${line === 'route' ? 'Koralle' : 'Türkis'} x ${x}, σ ${sigma}°, Blick ${best.look}°, ${n}/${best.runs.length} im Ziel`,
        overJitter: false,
      };
    },
  };
}

/** Abstand zweier achsparalleler Boxen (0 = berühren/überlappen). */
function boxGap(a: Box3, b: Box3): number {
  const dx = Math.max(0, b.min.x - a.max.x, a.min.x - b.max.x);
  const dy = Math.max(0, b.min.y - a.max.y, a.min.y - b.max.y);
  const dz = Math.max(0, b.min.z - a.max.z, a.min.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

/** Mensch-Band: Blickversatz (Grad, + = in die Rampe), Verzug (s), Seeds; σ 1°. */
export const HUMAN_LOOKS = [-3, -2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1];
export const HUMAN_LAGS = [0, 0.1, 0.2];
const HUMAN_SEEDS = [1, 2, 3, 4];
const HUMAN_CP_SEEDS = [1, 2];
/** Brett-Starts quer (u): Koralle links, der Spawn, Türkis rechts (Review: x ±160). */
const HUMAN_XS = [-160, 160];
/** Abgang von einer CP-Plattform: Türkis geradeaus, Koralle 20° nach links. */
const HUMAN_EXITS: ReadonlyArray<readonly [string, number]> = [
  ['Türkis', 0],
  ['Koralle', 20],
];

/** Luftticks des Mensch-Bands bleiben so weit von jedem Checkpoint-Pad weg (u): Kontakt allein wäre knapp an der Kante. */
export const PAD_AIR_GAP = 32;
/**
 * Höchstens so viele Türkis-Brettläufe sterben nach CP3 (Warnung darüber). Bandfahrer kommen tief neben R1 an und
 * driften nach außen; ohne die Finale-Schürze (level3.finSkirt) starben 91/216, mit ihr 4 (Strandstirn).
 */
export const TURKIS_TAIL_DEATHS = 0.1;
/** Abgang von der CP3-Plattform (Grad zur Spawn-Richtung): geradeaus, 20° links, 20° rechts. */
const HUMAN_CP3_EXITS = [0, 20, -20];

/**
 * 9. Mensch-Band (Review Phase 3): ~750 Läufe des Mensch-Modells — vom Brett (x ±160 und Spawn, Blick −3…+1°, Verzug
 * 0/0.1/0.2 s, 4 Seeds), ab CP1/CP2 (Türkis geradeaus, Koralle 20° links vom Pad), ab CP3 (0/±20°) bis ins Ziel und
 * quer über W1 (−340…+340 u, Blick −2…+1°, bis CP2). Fehler: ein Checkpoint-Pad berührt oder ein Luftick näher als
 * PAD_AIR_GAP, ein Einbruch > 30 % in einem Tick, ein Stau auf dem Band, ein Tod auf Türkis in der Kehre, ein Lauf ab
 * CP3 ohne Ziel. Warnung: die Grundtechnik (bester Blickversatz ohne Verzug, Median) passt nicht zu den Medaillen.
 */
function humanBand(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const ctx = humanCtx(level);
  if (ctx.pads.length !== 3) {
    r.errors.push(`Design L3: Mensch-Band findet ${ctx.pads.length} statt 3 Checkpoint-Pads`);
    return;
  }
  const padHits: string[] = [];
  const collapses: string[] = [];
  const bandStops: string[] = [];
  const turkisKehre: string[] = [];
  const gap = ctx.pads.map(() => Infinity);
  const stats = { runs: 0, dead: 0, stau: 0 };
  // Tode vom Brett je Spur und Abschnitt (0 = W1 … 3 = R1/Z/Finale).
  const deaths: Record<'Koralle' | 'Türkis', number[]> = { Koralle: [0, 0, 0, 0], Türkis: [0, 0, 0, 0] };
  const boardRuns: Record<'Koralle' | 'Türkis', number> = { Koralle: 0, Türkis: 0 };
  const note = (name: string, h: HumanRun, lane: 'Koralle' | 'Türkis' | null): void => {
    stats.runs++;
    if (h.pads.length) padHits.push(`${name}: ${h.pads.join('/')}`);
    if (h.collapse) collapses.push(`${name}: ${h.collapse}`);
    if (h.bandStop) bandStops.push(name);
    if (h.reason === 'tod') stats.dead++;
    if (h.reason === 'stau') stats.stau++;
    if (h.deathAt === 1 || h.deathAt === 2) {
      if (lane === 'Türkis') turkisKehre.push(name);
    }
    if (lane && h.deathAt >= 0) deaths[lane][h.deathAt]++;
    h.padGap.forEach((g, k) => (gap[k] = Math.min(gap[k], g)));
  };
  // Brett: Zeiten je Spur und Blick (Verzug 0) für die Medaillen-Frage.
  const xs = [...HUMAN_XS, level.spawnPos.x];
  const times = new Map<string, number[]>();
  for (const x of xs) {
    const lane = x < 0 ? 'Koralle' : 'Türkis';
    for (const look of HUMAN_LOOKS) {
      for (const lag of HUMAN_LAGS) {
        for (const seed of HUMAN_SEEDS) {
          const h = humanRun(level, ctx, new Vector3(x, level.spawnPos.y + 1, level.spawnPos.z), null, null, { look, lag, sigma: 1, seed }, cfg);
          note(`Brett x ${f0(x)} Blick ${look}° τ ${lag} s Seed ${seed}`, h, lane);
          boardRuns[lane]++;
          if (lag === 0) {
            const key = `${lane}|${look}`;
            const list = times.get(key) ?? [];
            list.push(h.time ?? Infinity);
            times.set(key, list);
          }
        }
      }
    }
  }
  // Ab CP1/CP2: vom Pad geradeaus (Türkis) oder 20° links (Koralle) bis zum nächsten Checkpoint.
  for (const cp of level.triggers.filter((t) => t.kind === 'checkpoint' && t.order <= 2)) {
    const goal = nextGoal(level, cp.order);
    for (const [lane, turn] of HUMAN_EXITS) {
      for (const look of HUMAN_LOOKS) {
        for (const lag of HUMAN_LAGS) {
          for (const seed of HUMAN_CP_SEEDS) {
            const h = humanRun(level, ctx, new Vector3(cp.spawnPos.x, cp.spawnPos.y + 1, cp.spawnPos.z), (cp.spawnYaw + turn) * DEG, goal, { look, lag, sigma: 1, seed }, cfg);
            note(`CP${cp.order} ${lane} Blick ${look}° τ ${lag} s Seed ${seed}`, h, null);
          }
        }
      }
    }
  }
  // Ab CP3 bis ins Ziel: Türkis-Bandfahrer kommen mit ~1250 u/s tief neben R1 an und sterben danach oft (Blick weg von der
  // Rampe drückt ab ~1000 u/s nicht mehr) — der Respawn auf der CP3-Plattform muss sie tragen, sonst ist es eine Falle.
  const cp3 = level.triggers.find((t) => t.kind === 'checkpoint' && t.order === 3) ?? null;
  const finish = level.triggers.find((t) => t.kind === 'finish') ?? null;
  const fromCp3: string[] = [];
  let cp3Runs = 0;
  let cp3Slow = 0;
  if (cp3 && finish) {
    for (const turn of HUMAN_CP3_EXITS) {
      for (const look of HUMAN_LOOKS) {
        for (const lag of HUMAN_LAGS) {
          for (const seed of HUMAN_CP_SEEDS) {
            const name = `CP3 ${turn}° Blick ${look}° τ ${lag} s Seed ${seed}`;
            const h = humanRun(level, ctx, new Vector3(cp3.spawnPos.x, cp3.spawnPos.y + 1, cp3.spawnPos.z), (cp3.spawnYaw + turn) * DEG, finish, { look, lag, sigma: 1, seed }, cfg);
            note(name, h, null);
            cp3Runs++;
            if (h.reason !== 'ziel') fromCp3.push(`${name}: ${h.reason}`);
            else cp3Slow = Math.max(cp3Slow, h.time ?? 0);
          }
        }
      }
    }
  } else fromCp3.push('CP3 oder Ziel fehlt');
  // Quer über W1 (Review w1lat): Start bei s 300, ~160 u über der Flanke, bis CP2. |Querlage| < 40 läge in der Finne.
  const cp2 = level.triggers.find((t) => t.kind === 'checkpoint' && t.order === 2) ?? null;
  const w1 = level.brushes.find((b) => b.tag === 'w1');
  if (cp2 && w1) {
    const top = w1.bounds.max.y;
    for (const look of [-2, -1, 0, 1]) {
      for (let lat = -340; lat <= 340; lat += 60) {
        if (Math.abs(lat) < 40) continue;
        const y = top - 300 * Math.tan(10 * DEG) - Math.abs(lat) * Math.tan(60 * DEG) + 160;
        const h = humanRun(level, ctx, new Vector3(lat, y, -300), null, cp2, { look, lag: 0, sigma: 0, seed: 1 }, cfg);
        note(`W1 quer ${lat} Blick ${look}°`, h, null);
      }
    }
  }
  const head = `${stats.runs} Läufe (Brett x ${xs.map(f0).join('/')} × Blick −3…+1° × Verzug 0/0.1/0.2 s × ${HUMAN_SEEDS.length} Seeds, σ 1°; ab CP1/CP2 Türkis/Koralle; ab CP3 0/±20°; quer über W1)`;
  const gaps = ctx.pads.map((p, k) => `${p.tag} ${Number.isFinite(gap[k]) ? f0(gap[k]) : '–'}`).join(', ');
  const near = ctx.pads.flatMap((p, k) => (gap[k] < PAD_AIR_GAP ? [`${p.tag} ${f0(gap[k])} u`] : []));
  const errs: string[] = [];
  if (padHits.length) errs.push(`${padHits.length} berühren ein Checkpoint-Pad (${padHits.slice(0, 3).join('; ')})`);
  if (near.length) errs.push(`Luftticks näher als ${PAD_AIR_GAP} u an einem Pad (${near.join(', ')})`);
  if (fromCp3.length) errs.push(`${fromCp3.length}/${cp3Runs} ab CP3 ohne Ziel (${fromCp3.slice(0, 3).join('; ')})`);
  if (collapses.length) errs.push(`${collapses.length} brechen in einem Tick um > ${f0(100 * COLLAPSE)} % ein (${collapses.slice(0, 3).join('; ')})`);
  if (bandStops.length) errs.push(`${bandStops.length} stehen auf dem Band (${bandStops.slice(0, 3).join('; ')})`);
  if (turkisKehre.length) errs.push(`${turkisKehre.length} sterben auf Türkis in der Kehre (${turkisKehre.slice(0, 3).join('; ')})`);
  const turkisRuns = boardRuns.Türkis;
  const tail = deaths.Türkis[3];
  const tailText = `Türkis vom Brett nach CP3 tot ${tail}/${turkisRuns} (Soll ≤ ${f0(100 * TURKIS_TAIL_DEATHS)} %)`;
  if (errs.length) r.errors.push(`Design L3: Mensch-Band — ${head}: ${errs.join('; ')}`);
  else
    r.info.push(
      `Design L3: Mensch-Band — ${head}: 0 Pad-Kontakte, 0 Einbrüche, 0 Stau auf dem Band, 0 Tode auf Türkis in der Kehre, ` +
        `ab CP3 ${cp3Runs}/${cp3Runs} im Ziel (langsamster ${cp3Slow.toFixed(1)} s); ${stats.dead} Tode, ${stats.stau} Stau; vom Brett je Abschnitt ` +
        `W1/CP1–2/CP2–3/nach CP3: Koralle ${deaths.Koralle.join('/')}, Türkis ${deaths.Türkis.join('/')}; Pad-Abstand der Luftticks ${gaps} u (Soll ≥ ${PAD_AIR_GAP})`,
    );
  // Bandfahrer sterben nach CP3 am Rand von R1/Finale: der Respawn trägt sie (oben), aber ein Viertel davon wäre die
  // sichere Linie nicht mehr.
  if (turkisRuns > 0 && tail > TURKIS_TAIL_DEATHS * turkisRuns) r.warnings.push(`Design L3: Türkis-Bandfahrer sterben nach CP3 — ${tailText} (Finale-Schürze level3.finSkirt?)`);
  else r.info.push(`Design L3: ${tailText}`);
  r.info.push(`Design L3: ${koralleDiagonal(level, ctx, cfg)}`);
  medalsVsHuman(level, times, r);
}

/** Blickversätze der Blickfehler-Probe ab CP3 (Grad, + = in die Rampe) — weit über das Mensch-Band (−3…+1°) hinaus. */
export const LOOK_BIAS_CP3 = [-6, -3, 0, 3, 6, 10] as const;
/** Blickversätze der Bronze-Hand vom Brett auf Türkis. */
export const LOOK_BIAS_BOARD = [-4, -2, 0, 2, 4] as const;
const LOOK_BIAS_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * 10. Blickfehler (E2E-Review v2final: L3-Medaillen kommen nur aus der Surf-Referenz, deren Blick `rampAxis` exakt
 * trifft; ein naiver Browser-Surfer starb nach CP3). Ein Mensch sieht die Rampe, trifft ihre Achse aber nicht genau:
 * - ab CP3 (0/±20° vom Pad) mit festem Versatz −6…+10°, σ 3°, Verzug 0.4 s → jeder Lauf im Ziel (Fehler sonst);
 * - Bronze-Hand (σ 3°, Verzug 0.2 s) vom Brett auf Türkis mit Versatz −4…+4° → Median (Tod = ∞) gegen Bronze;
 *   Warnung, wenn sie im Band ±2° Bronze verfehlt.
 * Nicht geprüft: Fahrer ohne Blickziel. Der Blick entlang der Höhenlinie (Tangente aus der Flächennormale) liegt auf
 * Rampen mit Achsgefälle 6–8° neben der Achse und hängt auf W1 fest; der Blick entlang der Flugrichtung driftet ohne
 * Rückführung von R1 (fallen.md). Beides ist kein Mensch, der die Rampe vor sich sieht.
 */
function lookBias(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const ctx = humanCtx(level);
  const cp3 = level.triggers.find((t) => t.kind === 'checkpoint' && t.order === 3) ?? null;
  const finish = level.triggers.find((t) => t.kind === 'finish') ?? null;
  const bronze = level.def.medals?.bronze;
  if (!cp3 || !finish || bronze === undefined) {
    r.errors.push('Design L3: Blickfehler — CP3, Ziel oder Medaillen fehlen');
    return;
  }
  const lost: string[] = [];
  let runs = 0;
  let slow = 0;
  for (const turn of HUMAN_CP3_EXITS) {
    for (const look of LOOK_BIAS_CP3) {
      for (const seed of [1, 2]) {
        const h = humanRun(level, ctx, new Vector3(cp3.spawnPos.x, cp3.spawnPos.y + 1, cp3.spawnPos.z), (cp3.spawnYaw + turn) * DEG, finish, { look, lag: 0.4, sigma: 3, seed }, cfg);
        runs++;
        if (h.reason !== 'ziel') lost.push(`${turn}° Blick ${look}° Seed ${seed}: ${h.reason}`);
        else slow = Math.max(slow, h.time ?? 0);
      }
    }
  }
  const cp3Line = `ab CP3 mit Blickversatz ${LOOK_BIAS_CP3[0]}…+${LOOK_BIAS_CP3[LOOK_BIAS_CP3.length - 1]}°, σ 3°, Verzug 0.4 s: ${runs - lost.length}/${runs} im Ziel`;
  if (lost.length) r.errors.push(`Design L3: Blickfehler — ${cp3Line} (${lost.slice(0, 3).join('; ')})`);
  const parts: string[] = [];
  const miss: string[] = [];
  const pos = new Vector3(HUMAN_XS[1], level.spawnPos.y + 1, level.spawnPos.z);
  for (const look of LOOK_BIAS_BOARD) {
    const ts = LOOK_BIAS_SEEDS.map((seed) => humanRun(level, ctx, pos, null, null, { look, lag: 0.2, sigma: 3, seed }, cfg).time ?? Infinity).sort((a, b) => a - b);
    const med = ts[Math.floor((ts.length - 1) / 2)];
    parts.push(`${look > 0 ? '+' : ''}${look}° ${Number.isFinite(med) ? med.toFixed(1) : '–'} s (${ts.filter((t) => t <= bronze).length}/${ts.length} ≤ Bronze)`);
    if (Math.abs(look) <= 2 && !(med <= bronze)) miss.push(`${look}°`);
  }
  const boardLine = `Bronze-Hand (σ 3°, Verzug 0.2 s) vom Brett auf Türkis, ${LOOK_BIAS_SEEDS.length} Seeds, Tod = ∞: ${parts.join(', ')}; Bronze ${bronze} s`;
  if (miss.length) r.warnings.push(`Design L3: Blickfehler — ${boardLine} — verfehlt Bronze im Band ±2° (${miss.join(', ')})`);
  if (!lost.length) r.info.push(`Design L3: Blickfehler — ${cp3Line} (langsamster ${slow.toFixed(1)} s)${miss.length ? '' : `; ${boardLine}`}`);
}

/** Koralle-Wähler, die vom Spawn (rechts der Finne) schräg links um die Finne laufen: Winkel zur Blickachse (Grad). */
export const KORALLE_DIAGONALS = [24, 28, 32] as const;

/**
 * Koralle-Einstieg (Info, bekannte Falle): wer vom Spawn schräg links um die Finne läuft, landet auf W1 bei Querlage
 * −260…−300 — W1 trägt links bis 384, die Innenbahn von Viertel 1 nur bis 192, am Drop fällt er ins Leere. Der Hebel
 * (level3.q1Skirt) ist medaillenwirksam und bleibt dem Medaillen-Neubau vorbehalten (level3.md, Fix-Runde 2).
 */
function koralleDiagonal(level: CompiledLevel, ctx: HumanCtx, cfg: MovementConfig): string {
  const sp = level.spawnPos;
  const parts: string[] = [];
  let ok = 0;
  let n = 0;
  for (const ang of KORALLE_DIAGONALS) {
    let k = 0;
    let m = 0;
    for (const look of [-2.5, -2, -1, 0, 1]) {
      for (const seed of [1, 2]) {
        const h = humanRun(level, ctx, new Vector3(sp.x, sp.y + 1, sp.z), (level.spawnYaw + ang) * DEG, null, { look, lag: 0, sigma: 1, seed }, cfg);
        m++;
        if (h.reason === 'ziel') k++;
      }
    }
    parts.push(`${ang}° ${k}/${m}`);
    ok += k;
    n += m;
  }
  return `Koralle-Einstieg schräg vom Spawn (bekannte Falle, level3.q1Skirt): ${ok}/${n} im Ziel (${parts.join(', ')}; Blick −2.5…+1°)`;
}

/** Toleranz der Probe gegen die Medaillen-Referenz (4 statt 16 Seeds). */
export const REFERENCE_TOLERANCE = 0.03;

/**
 * Grundtechnik gegen die Medaillen: je Spur der beste Blickversatz (Verzug 0, Median der Seeds, ohne Ziel = ∞). Seit
 * Phase 3 misst build.ts Gold/VELOCITY/Autor aus dem schnelleren von RouteFollower (verliert an jedem Surf-Drop
 * 150–190 u/s) und `level3Reference` (dieselbe Grundtechnik auf Koralle über 48 Seeds, perfekt mit σ 0.5°): Koralle mit
 * bestem Blick ≈ Autor.
 * Warnung, wenn (a) die Probe den Autor um mehr als REFERENCE_TOLERANCE unterbietet (Medaillen veraltet — levels:build)
 * oder (b) Türkis VELOCITY schafft (VELOCITY/Gold sollen nur innen gehen, sonst lohnt die Gabel nicht).
 */
function medalsVsHuman(level: CompiledLevel, times: ReadonlyMap<string, readonly number[]>, r: DesignReport): void {
  const m = level.def.medals;
  if (!m) return;
  const best = (lane: string): { look: number; median: number; under: number; n: number } => {
    let out = { look: 0, median: Infinity, under: 0, n: 0 };
    for (const look of HUMAN_LOOKS) {
      const list = [...(times.get(`${lane}|${look}`) ?? [])].sort((a, b) => a - b);
      if (!list.length) continue;
      const med = list[Math.floor((list.length - 1) / 2)];
      if (med < out.median) out = { look, median: med, under: list.filter((t) => t < m.velocity).length, n: list.length };
    }
    return out;
  };
  const k = best('Koralle');
  const t = best('Türkis');
  const all = [...times.values()].flat();
  const under = all.filter((x) => x < m.velocity).length;
  const text =
    `Grundtechnik (bester Blickversatz, Verzug 0, Median): Koralle ${f2(k.median)} s (${k.look}°), Türkis ${f2(t.median)} s (${t.look}°); ` +
    `${under}/${all.length} Brett-Läufe ohne Verzug unter VELOCITY ${m.velocity} s (Gold ${m.gold}, Autor ${m.author})`;
  if (k.median < (1 - REFERENCE_TOLERANCE) * m.author)
    r.warnings.push(`Design L3: Grundtechnik auf Koralle unterbietet den Autor um > ${f0(100 * REFERENCE_TOLERANCE)} % — Medaillen passen nicht zur Referenz (levels:build, level3Reference) — ${text}`);
  else if (t.median < m.velocity) r.warnings.push(`Design L3: Grundtechnik auf Türkis schafft VELOCITY — die Gabel lohnt nicht — ${text}`);
  else r.info.push(`Design L3: ${text}`);
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
