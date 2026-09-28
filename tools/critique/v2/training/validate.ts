/**
 * Trainingsmodus-Entwurf (v2/training) — Messung 3: Sind die Lektionen mit einem
 * "ordentlichen Anfänger" schaffbar, und bestehen die Fehlerbilder NICHT? Trifft die Diagnose?
 *
 *   npx tsx tools/critique/v2/training/validate.ts [lesson…]
 *
 * Echte PlayerMovement + Prototyp-Lektionen (lessons.ts) + Prototyp-Lektionslogik
 * (trainingProto.ts: StrafeJudge, LessonRun). Bot-Hände aus hands.ts, Surf-/Crouch-Hände hier.
 * 20 Seeds je Modell. Ausgabe: shots/v2/training/validate.json + Tabellen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import type { MovementConfig } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { NaiveBot, RouteFollower, mulberry32, yawOf } from '../../../../src/player/bots';
import type { MutablePlayerInput, MutablePlayerSnapshot, PlayerInput, PlayerSnapshot } from '../../../../src/player/types';
import { NO_INPUT } from '../../../../src/player/types';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { CompiledLevel } from '../../../../src/world/level/compileLevel';
import { HANDS, HumanHand } from './hands';
import type { HandModel } from './hands';
import { lessonArena, lessonAutoHop, lessonCrouch, lessonCurve, lessonSpeed, lessonSpeedOval, lessonSurf } from './lessons';
import type { LessonProto } from './lessons';
import { LessonRun } from './trainingProto';
import type { HopReport, Verdict } from './trainingProto';

const OUT = 'shots/v2/training';
mkdirSync(OUT, { recursive: true });
const CFG: MovementConfig = VELOCITY_DEFAULT;
const DT = 1 / CFG.tickRate;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const report: Record<string, unknown> = {};
const only = process.argv.slice(2);
const want = (id: string): boolean => only.length === 0 || only.includes(id);

interface Driver {
  next(s: PlayerSnapshot, run: LessonRun, pm: PlayerMovement): PlayerInput;
}

interface Outcome {
  readonly stageTimes: number[];
  readonly done: boolean;
  readonly verdicts: Record<string, number>;
  readonly time: number;
}

function play(lesson: LessonProto, level: CompiledLevel, driver: Driver, seconds: number, spawn?: Vector3, vel?: Vector3): Outcome {
  const pm = new PlayerMovement(level.world, CFG);
  if (vel) pm.state.vel.copy(vel);
  pm.teleport(spawn ?? level.spawnPos, { keepVelocity: vel !== undefined });
  const run = new LessonRun(lesson.stages, lesson.zones);
  const stageTimes: number[] = [];
  const verdicts: Record<string, number> = {};
  run.judge.onHop = ((orig) => (r: HopReport) => {
    verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    orig(r);
  })(run.judge.onHop);
  let t = 0;
  let lastStage = 0;
  const prev: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  const cur: MutablePlayerSnapshot = PlayerMovement.createSnapshot();
  pm.copySnapshot(cur);
  for (let i = 0; i < seconds * CFG.tickRate && !run.progress.done; i++) {
    const cmd = driver.next(pm.state, run, pm);
    pm.copySnapshot(prev);
    pm.tick(cmd);
    pm.copySnapshot(cur);
    t += DT;
    run.tick(DT, prev, cur, cmd, pm.hullMaxs.y);
    if (run.progress.stage !== lastStage) {
      stageTimes.push(t);
      lastStage = run.progress.stage;
    }
    if (pm.state.pos.y < level.def.killY) break;
  }
  return { stageTimes, done: run.progress.done, verdicts, time: t };
}

const med = (a: number[]): number => {
  const b = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return b.length === 0 ? NaN : b[Math.floor(b.length / 2)];
};
const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '–');

function summarize(name: string, lesson: LessonProto, outs: Outcome[]): Record<string, unknown> {
  const nSt = lesson.stages.filter((s) => !s.bonus).length;
  const passed = outs.filter((o) => o.stageTimes.length >= nSt).length;
  const perStage = lesson.stages.map((st, k) => {
    const ts = outs.map((o) => o.stageTimes[k] ?? Infinity);
    return { stage: st.id, median: med(ts), share: ts.filter(Number.isFinite).length / outs.length, max: Math.max(...ts.filter(Number.isFinite)) };
  });
  const verdicts: Record<string, number> = {};
  for (const o of outs) for (const [k, v] of Object.entries(o.verdicts)) verdicts[k] = (verdicts[k] ?? 0) + v;
  const total = Object.values(verdicts).reduce((a, b) => a + b, 0);
  const vtxt = Object.entries(verdicts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${Math.round((v / Math.max(1, total)) * 100)}%`)
    .join(', ');
  console.log(
    `  ${name.padEnd(34)} bestanden ${passed}/${outs.length} · ${perStage.map((p) => `${p.stage} ${f1(p.median)} s (${Math.round(p.share * 100)} %, max ${f1(p.max)})`).join(' · ')}${total ? ` · Urteile: ${vtxt}` : ''}`,
  );
  return { name, passed, of: outs.length, perStage, verdicts };
}

// ------------------------------------------------------------------ Hand-Treiber

/** HumanHand, deren Muster je Stufe wechselt (z. B. Arena: links → rechts → Wechsel). */
class StagedHand implements Driver {
  private hand: HumanHand | null = null;
  private stage = -1;
  constructor(
    private readonly model: HandModel,
    private readonly seed: number,
    private readonly perStage: (stage: number, run: LessonRun) => { pattern: HandModel['pattern']; side?: number; goal?: { x: number; z: number } | null },
  ) {}
  next(s: PlayerSnapshot, run: LessonRun): PlayerInput {
    const st = run.progress.stage;
    const plan = this.perStage(st, run);
    if (st !== this.stage || !this.hand) {
      const yaw = this.hand?.yaw ?? 0;
      this.hand = new HumanHand(CFG, { ...this.model, pattern: plan.pattern }, this.seed * 31 + st, plan.goal ?? null, yaw);
      this.hand.yaw = yaw;
      if (plan.side !== undefined) this.hand.side = plan.side;
      this.stage = st;
    }
    if (plan.goal !== undefined) this.hand.goal = plan.goal;
    return this.hand.next(s);
  }
}

// ------------------------------------------------------------------ T2 Auto-Hop

if (want('t2')) {
  const L = lessonAutoHop();
  const lv = compileLevel(L.level);
  console.log('\nT2 AUTO-HOP (Stufen: Kette ×6, Gräben bis ans Ende)');
  const rows: unknown[] = [];
  for (const [name, mk] of [
    ['W+Space gehalten (Sprint)', () => new NaiveBot(CFG, { heading: 0, press: 'hold', sprint: true })],
    ['W+Space gehalten (ohne Sprint)', () => new NaiveBot(CFG, { heading: 0, press: 'hold', sprint: false })],
    ['Mausrad-Spam je Landung', () => new NaiveBot(CFG, { heading: 0, press: 'spam', sprint: true })],
  ] as const) {
    const outs = SEEDS.slice(0, 1).map(() => {
      const b = mk();
      return play(L, lv, { next: (s) => b.next(s) }, 60);
    });
    rows.push(summarize(name, L, outs));
  }
  report.t2 = rows;
}

// ------------------------------------------------------------------ T3 Arena

const CENTER = { x: 0, z: 0 };
if (want('t3')) {
  const L = lessonArena();
  const lv = compileLevel(L.level);
  console.log('\nT3 AIR-STRAFE Arena (Stufen: 5 links, 5 rechts, 6 im Wechsel; gut = +8 u/s mit ≥ 50 % A/D)');
  const plan = (st: number): { pattern: HandModel['pattern']; side?: number; goal?: { x: number; z: number } | null } =>
    st === 0 ? { pattern: 'circle', side: 1, goal: null } : st === 1 ? { pattern: 'circle', side: -1, goal: null } : { pattern: 'zigzag', goal: CENTER };
  const models: Array<[string, HandModel]> = [
    ['Demo-Hand (120 °/s, 0.1 s, fehlerfrei)', { ...HANDS.geuebt, rateDeg: 120, rateJitter: 0, delay: 0.1, delayJitter: 0, pAgainst: 0, pNoMouse: 0, pWOnly: 0 }],
    ['ordentlicher Anfänger (60 °/s)', HANDS.anfaenger],
    ['geübter Anfänger (100 °/s)', HANDS.geuebt],
    ['zaghaft (30 °/s)', { ...HANDS.anfaenger, rateDeg: 30 }],
    ['sehr zaghaft (20 °/s, 0.3 s spät)', { ...HANDS.anfaenger, rateDeg: 20, delay: 0.3 }],
    ['Fehler: nur W + Maus', HANDS.nurW],
    ['Fehler: Taste gegen Maus', HANDS.gegen],
    ['Fehler: A/D ohne Maus', HANDS.keineMaus],
    ['Neuling W+Space', HANDS.neuling],
  ];
  const rows: unknown[] = [];
  for (const [name, m] of models) {
    const outs = SEEDS.map((seed) => play(L, lv, new StagedHand(m, seed, plan), 120));
    rows.push(summarize(name, L, outs));
  }
  report.t3 = rows;

  // Diagnose-Treffsicherheit: jede Fehlerhand 20 Seeds × 60 s, Anteil der Hops mit "ihrer" Diagnose.
  console.log('\n  Diagnose-Treffsicherheit (Fehlerhände, zigzag, nur nicht-gute Hops):');
  const expect: Array<[string, HandModel, Verdict[]]> = [
    ['nur W + Maus', HANDS.nurW, ['wOnly', 'noSide']],
    ['gegen die Maus', HANDS.gegen, ['against']],
    ['A/D ohne Maus', HANDS.keineMaus, ['noMouse']],
    ['zu spät (0.45 s)', { ...HANDS.anfaenger, delay: 0.45, delayJitter: 0.05, pAgainst: 0, pNoMouse: 0, pWOnly: 0, rateDeg: 25 }, ['late', 'tooSlow']],
    ['zu langsam (12–20 °/s)', { ...HANDS.anfaenger, rateDeg: 16, rateJitter: 0.15, delay: 0.1, delayJitter: 0.05, pAgainst: 0, pNoMouse: 0, pWOnly: 0 }, ['tooSlow', 'noMouse']],
  ];
  const diag: unknown[] = [];
  for (const [name, m, hits] of expect) {
    const counts: Record<string, number> = {};
    for (const seed of SEEDS) {
      const run = new LessonRun([{ id: 'x', title: '', text: '', task: { kind: 'goodHops', count: 9999, side: 'any' } }], []);
      const pm = new PlayerMovement(lv.world, CFG);
      pm.teleport(lv.spawnPos);
      const hand = new HumanHand(CFG, { ...m, pattern: 'zigzag' }, seed, CENTER, 0);
      run.judge.onHop = (r) => {
        if (r.verdict !== 'good') counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
        else counts.good = (counts.good ?? 0) + 1;
      };
      const prev = PlayerMovement.createSnapshot();
      const cur = PlayerMovement.createSnapshot();
      for (let i = 0; i < 60 * CFG.tickRate; i++) {
        const cmd = hand.next(pm.state);
        pm.copySnapshot(prev);
        pm.tick(cmd);
        pm.copySnapshot(cur);
        run.tick(DT, prev, cur, cmd, 72);
      }
    }
    const bad = Object.entries(counts).filter(([k]) => k !== 'good').reduce((a, [, v]) => a + v, 0);
    const hit = hits.reduce((a, k) => a + (counts[k] ?? 0), 0);
    const txt = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    console.log(`    ${name.padEnd(26)} erwartet ${hits.join('/')}: ${Math.round((hit / Math.max(1, bad)) * 100)} % der Fehl-Hops (${txt})`);
    diag.push({ name, hits, counts, accuracy: hit / Math.max(1, bad) });
  }
  report.t3diag = diag;
}

// ------------------------------------------------------------------ T4 Speed

if (want('t4')) {
  const L = lessonSpeed();
  const lv = compileLevel(L.level);
  console.log('\nT4 SPEED (Stufen: 400 erreichen, 5 Landungen ≥ 400 in Folge, Bonus 500)');
  const goal = { x: 0, z: -30000 };
  const rows: unknown[] = [];
  for (const [name, m] of [
    ['ordentlicher Anfänger', HANDS.anfaenger],
    ['geübter Anfänger', HANDS.geuebt],
    ['zaghaft (30 °/s)', { ...HANDS.anfaenger, rateDeg: 30 }],
    ['Neuling W+Space', HANDS.neuling],
  ] as const) {
    const outs = SEEDS.map((seed) => play(L, lv, new StagedHand(m, seed, () => ({ pattern: m.strafe ? 'zigzag' : 'steer', goal })), 90));
    rows.push(summarize(name, L, outs));
  }
  report.t4 = rows;
}

if (want('t4o')) {
  const L = lessonSpeedOval();
  const lv = compileLevel(L.level);
  console.log('\nT4 SPEED OVAL (Mittelinsel, gegen den Uhrzeigersinn; Wegpunkte auf der Mittellinie)');
  // Mittellinie: Geraden bei x = ±1450, Kurven um die Inselenden (z = ±2000) mit Radius 1450.
  const wps: { x: number; z: number }[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * 2 * Math.PI;
    // Stadion: Geraden z ∈ [−2000, 2000], Halbkreise R 1450 um (0, ±2000).
    const t = k / 24;
    if (t < 0.25) wps.push({ x: 1450, z: 2000 - t * 4 * 4000 });
    else if (t < 0.5) { const b = ((t - 0.25) / 0.25) * Math.PI; wps.push({ x: 1450 * Math.cos(b), z: -2000 - 1450 * Math.sin(b) }); }
    else if (t < 0.75) wps.push({ x: -1450, z: -2000 + (t - 0.5) * 4 * 4000 });
    else { const b = ((t - 0.75) / 0.25) * Math.PI; wps.push({ x: -1450 * Math.cos(b), z: 2000 + 1450 * Math.sin(b) }); }
    void a;
  }
  const rows: unknown[] = [];
  for (const [name, m] of [
    ['ordentlicher Anfänger', HANDS.anfaenger],
    ['geübter Anfänger', HANDS.geuebt],
    ['zaghaft (30 °/s)', { ...HANDS.anfaenger, rateDeg: 30 }],
  ] as const) {
    const outs = SEEDS.map((seed) => {
      let wi = 1;
      const hand = new StagedHand(m, seed, (_st, _run) => ({ pattern: 'zigzag', goal: wps[wi % wps.length] }));
      return play(L, lv, { next: (s, run, pm) => { const g = wps[wi % wps.length]; if (Math.hypot(g.x - s.pos.x, g.z - s.pos.z) < 700) wi++; return hand.next(s, run); } }, 90);
    });
    rows.push(summarize(name, L, outs));
  }
  report.t4o = rows;
}

// ------------------------------------------------------------------ T5 Kurven

if (want('t5')) {
  const L = lessonCurve();
  const lv = compileLevel(L.level);
  console.log('\nT5 KURVEN (Stufen: 380 aufbauen, 7 Luft-Tore auf 180°-Bogen R 900, nie unter 330)');
  const centers = L.zones.map((z) => ({ x: (z.min[0] + z.max[0]) / 2, z: (z.min[2] + z.max[2]) / 2 }));
  // Route für den RouteFollower: Anlauf + Torzentren.
  const route = [{ pos: [0, 0, 0] as const }, ...centers.map((c) => ({ pos: [c.x, 0, c.z] as const }))];
  const rows: unknown[] = [];
  const handPlan = (st: number, run: LessonRun): { pattern: HandModel['pattern']; goal: { x: number; z: number } } =>
    st === 0 ? { pattern: 'zigzag', goal: centers[0] } : { pattern: 'steer', goal: centers[Math.min(centers.length - 1, run.progress.count + (run.progress.count > 0 ? 0 : 0))] };
  for (const [name, m] of [
    ['ordentlicher Anfänger (Hand)', HANDS.anfaenger],
    ['geübter Anfänger (Hand)', HANDS.geuebt],
  ] as const) {
    const outs = SEEDS.map((seed) => play(L, lv, new StagedHand(m, seed, handPlan), 120));
    rows.push(summarize(name, L, outs));
  }
  for (const noise of [3, 4, 5]) {
    const outs = SEEDS.map((seed) => {
      let rf: RouteFollower | null = null;
      let attempt = 0;
      return play(
        L,
        lv,
        {
          next: (s, run, pm) => {
            // Kurs gerissen/geschafft → neuer Anlauf ab Knoten 1 (ein Mensch fliegt den Bogen nochmal).
            if (!rf || (rf.report.status !== 'running' && !run.progress.done)) {
              attempt++;
              rf = new RouteFollower(route, CFG, { aimNoiseDeg: noise, seed: seed * 17 + attempt, world: lv.world, start: { x: s.pos.x, z: s.pos.z }, stallTimeout: 8 });
            }
            return rf.next(s, pm.surfNormal);
          },
        },
        120,
      );
    });
    rows.push(summarize(`RouteFollower Hand ${noise}°`, L, outs));
  }
  report.t5 = rows;
}

// ------------------------------------------------------------------ T6 Crouch

/** Mensch an der Kante: Anlauf Sprint, springt irgendwo im Absprungband, duckt nach t_c in der Luft (oder gar nicht). */
class CrouchHand implements Driver {
  private readonly rand: () => number;
  private readonly out: MutablePlayerInput = { ...NO_INPUT };
  private jumpAt = 0;
  private duckAfter = 0;
  private airT = 0;
  private wasGround = true;
  private phase: 'run' | 'air' | 'back' = 'run';
  private backT = 0;
  constructor(
    seed: number,
    private readonly wallZ: number,
    private readonly band: readonly [number, number],
    private readonly duck: readonly [number, number] | null,
    private readonly preDuck = false,
  ) {
    this.rand = mulberry32(seed * 101 + 7);
    this.plan();
  }
  private plan(): void {
    this.jumpAt = this.band[0] + this.rand() * (this.band[1] - this.band[0]);
    this.duckAfter = this.duck ? this.duck[0] + this.rand() * (this.duck[1] - this.duck[0]) : Infinity;
  }
  next(s: PlayerSnapshot): PlayerInput {
    const o = this.out;
    o.pitch = 0;
    o.sprint = true;
    o.side = 0;
    const dist = s.pos.z - this.wallZ; // > 0 vor der Wand
    if (this.phase === 'back') {
      // Nach dem Versuch (oben oder abgeprallt): zurück auf 700 u Anlauf (Mensch läuft zurück / F).
      this.backT += DT;
      o.yaw = Math.PI;
      o.forward = 1;
      o.jumpHeld = false;
      o.jumpPressed = false;
      o.crouch = false;
      if (s.pos.z > this.wallZ + 900 || this.backT > 6) {
        this.phase = 'run';
        this.plan();
      }
      return o;
    }
    o.yaw = 0;
    o.forward = 1;
    if (this.phase === 'run') {
      o.crouch = this.preDuck && dist < this.jumpAt + 80;
      const jump = s.onGround && dist <= this.jumpAt;
      o.jumpHeld = jump;
      o.jumpPressed = jump;
      if (!s.onGround && !this.wasGround) {
        /* noop */
      }
      if (jump) {
        this.phase = 'air';
        this.airT = 0;
      }
    } else {
      this.airT += DT;
      o.jumpHeld = false;
      o.jumpPressed = false;
      o.crouch = this.preDuck || this.airT >= this.duckAfter;
      if (s.onGround && this.airT > 0.1) {
        this.phase = 'back';
        this.backT = 0;
      }
    }
    this.wasGround = s.onGround;
    return o;
  }
}

if (want('t6')) {
  console.log('\nT6 CROUCH (Stufe: 3× oben auf dem Block landen, geduckt aus der Luft)');
  const rows: unknown[] = [];
  for (const h of [48, 64, 72]) {
    const L = lessonCrouch(h);
    const lv = compileLevel(L.level);
    const wallZ = L.meta.wallZ;
    // Einzelversuch-Erfolgsrate über ein Raster: Absprungabstand × Duck-Zeitpunkt
    const grid: string[] = [];
    const dists = [20, 60, 100, 140, 180, 220, 260, 300];
    const ducks = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55];
    grid.push(`    h ${h}: Abstand\\Duck ${ducks.map((d) => d.toFixed(2).padStart(5)).join('')}   | ohne Ducken`);
    for (const d of dists) {
      const row: string[] = [];
      for (const dk of ducks) {
        const drv = new CrouchHand(1, wallZ, [d, d], [dk, dk]);
        const run = play(L, lv, drv, 3.2);
        row.push((run.stageTimes.length > 0 || runTopOnce(L, lv, d, dk) ? '  ✓  ' : '  ·  '));
      }
      const no = runTopOnce(L, lv, d, null);
      grid.push(`    ${String(d).padStart(15)} ${row.join('')}   | ${no ? '✓' : '·'}`);
    }
    console.log(grid.join('\n'));
    // Mensch: Absprung irgendwo 40–260 u vor der Wand, Ducken 0.05–0.45 s nach Absprung
    for (const [name, band, duck, pre] of [
      ['Anfänger (Absprung 40–260, Duck 0.05–0.45 s)', [40, 260], [0.05, 0.45], false],
      ['Anfänger mit Markierung (80–200, Duck 0.05–0.35)', [80, 200], [0.05, 0.35], false],
      ['Vor-Ducken (C vor dem Sprung halten)', [40, 260], null, true],
      ['ohne Ducken', [40, 260], null, false],
    ] as const) {
      const outs = SEEDS.map((seed) => play(L, lv, new CrouchHand(seed, wallZ, band, duck, pre), 60));
      rows.push({ h, ...summarize(`h ${h}: ${name}`, L, outs) });
    }
  }
  report.t6 = rows;
}

/** Ein Versuch: landet die Hull oben (unabhängig von der Stufenlogik)? */
function runTopOnce(L: LessonProto, lv: CompiledLevel, dist: number, duck: number | null): boolean {
  const pm = new PlayerMovement(lv.world, CFG);
  pm.teleport(new Vector3(0, 0.01, L.meta.wallZ + 900));
  const drv = new CrouchHand(1, L.meta.wallZ, [dist, dist], duck === null ? null : [duck, duck]);
  const run = new LessonRun(L.stages, L.zones);
  let top = false;
  for (let i = 0; i < 3.2 * CFG.tickRate; i++) {
    const cmd = drv.next(pm.state);
    pm.tick(cmd);
    if (pm.state.onGround && pm.state.pos.y > L.meta.height - 1) top = true;
  }
  void run;
  return top;
}

// ------------------------------------------------------------------ T7 Surf

/**
 * Surf-Hand: springt vom Spawn (über dem First) nach rechts auf die Ostflanke, danach je
 * nach Modell: 'grund' = A/D in die Rampe, Blick entlang der Achse + Zielrauschen σ,
 * Reaktion nach `react` s Kontakt; 'w' = W gehalten, Blick entlang; 'nichts'; 'weg' = Taste von der Rampe weg.
 */
export class SurfHand implements Driver {
  private readonly rand: () => number;
  private readonly out: MutablePlayerInput = { ...NO_INPUT };
  private contact = 0;
  private aim = 0;
  private t = 0;
  private jumpT = -1;
  /** Zuletzt gesehene Rampenseite: Mensch hält die Taste, auch wenn der Kontakt einen Tick aussetzt. */
  private rampSide = 0;
  constructor(
    seed: number,
    private readonly mode: 'grund' | 'w' | 'nichts' | 'weg' | 'wa',
    private readonly noiseDeg: number,
    private readonly react: number,
  ) {
    this.rand = mulberry32(seed * 977 + 3);
  }
  next(s: PlayerSnapshot, _run: LessonRun, pm: PlayerMovement): PlayerInput {
    const o = this.out;
    this.t += DT;
    o.pitch = 0;
    o.sprint = true;
    o.crouch = false;
    o.jumpHeld = false;
    o.jumpPressed = false;
    // Anlauf auf der Startplattform (Blick −Z), hinter dem Rampenanfang Sprung nach rechts (+X) auf die Flanke.
    if (this.jumpT < 0) {
      o.yaw = 0;
      o.forward = 1;
      o.side = 0;
      // Plattform-Ende (z = 0) abgelaufen: ab jetzt Flug/Flanke.
      if (!s.onGround && s.pos.z < 0) this.jumpT = 0;
      return o;
    }
    this.jumpT += DT;
    const n = pm.surfNormal;
    if (s.surfing || n.x !== 0 || n.z !== 0) this.contact += DT;
    if (n.x !== 0) this.rampSide = n.x < 0 ? 1 : -1; // Normale −X (Rampe rechts) → D
    const into = this.rampSide !== 0 ? this.rampSide : 1;
    const k = Math.exp(-DT / 0.15);
    const g = Math.sqrt(-2 * Math.log(Math.max(this.rand(), 1e-12))) * Math.cos(2 * Math.PI * this.rand());
    this.aim = this.aim * k + g * ((this.noiseDeg * Math.PI) / 180) * Math.sqrt(1 - k * k);
    o.yaw = 0 + this.aim;
    o.forward = 0;
    o.side = 0;
    if (this.contact < this.react) return o;
    switch (this.mode) {
      case 'grund':
        o.side = into;
        break;
      case 'wa':
        o.side = into;
        o.forward = 1;
        break;
      case 'w':
        o.forward = 1;
        break;
      case 'weg':
        o.side = -into;
        break;
      case 'nichts':
        break;
    }
    return o;
  }
}

if (want('t8')) {
  console.log('\nT8 SURF-SPEED (10°-Rampe: 800 u/s surfend, dann 1000 u/s surfend)');
  const rows: unknown[] = [];
  const base = lessonSurf(10);
  const L: LessonProto = {
    ...base,
    id: 't8',
    stages: [
      { id: 'v800', title: '800', text: 'IN DIE RAMPE DRÜCKEN, BERGAB SURFEN', task: { kind: 'surfSpeed', min: 800 } },
      { id: 'v1000', title: '1000', text: 'TIEFER SURFEN = SCHNELLER', task: { kind: 'surfSpeed', min: 1000 } },
    ],
  };
  const lv = compileLevel(L.level);
  for (const [name, mode, noise, react] of [
    ['Grundtechnik (Blick ±3°, 0.3 s Reaktion)', 'grund', 3, 0.3],
    ['Grundtechnik (Blick ±6°, 0.6 s Reaktion)', 'grund', 6, 0.6],
    ['Fehler: nur W', 'w', 3, 0.3],
    ['Fehler: nichts drücken', 'nichts', 3, 0.3],
  ] as const) {
    const outs = SEEDS.map((seed) => play(L, lv, new SurfHand(seed, mode, noise, react), 25));
    rows.push(summarize(name, L, outs));
  }
  report.t8 = rows;
}

if (want('t7')) {
  console.log('\nT7 SURF (Stufen: 3 s halten, 6 s halten) — Rampe 60°, 768 breit, Achsgefälle 3° bzw. 0°/10°');
  const rows: unknown[] = [];
  for (const slope of [3, 0, 10]) {
    const L = lessonSurf(slope);
    const lv = compileLevel(L.level);
    for (const [name, mode, noise, react] of [
      ['Grundtechnik (Blick ±3°, 0.3 s Reaktion)', 'grund', 3, 0.3],
      ['Grundtechnik (Blick ±6°, 0.6 s Reaktion)', 'grund', 6, 0.6],
      ['W + D (Strafe-Assist)', 'wa', 3, 0.3],
      ['Fehler: nur W', 'w', 3, 0.3],
      ['Fehler: nichts drücken', 'nichts', 3, 0.3],
      ['Fehler: Taste von der Rampe weg', 'weg', 3, 0.3],
    ] as const) {
      const outs = SEEDS.map((seed) => play(L, lv, new SurfHand(seed, mode, noise, react), 25));
      rows.push({ slope, ...summarize(`${slope}°: ${name}`, L, outs) });
    }
  }
  report.t7 = rows;
}

writeFileSync(`${OUT}/validate.json`, JSON.stringify(report, null, 1));
void yawOf;
