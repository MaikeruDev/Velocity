/**
 * Physik-Prüfung einer Lektion (Plan 007, TC5): Bot-Matrix je Stufe, Vorführungen, Fehlerhände,
 * Zusatzproben (Diagnose-Treffsicherheit). validate-levels.ts ruft sie für jede Lektion STATT der
 * Routen-Physik (Start → Ziel gibt es in Lektionen nicht). Statisch prüft der Validator vorher: kein
 * medals/parTime, eindeutige IDs, Referenzen (opens/zone/tips/demo), Titel ≤ 16, Texte ≤ 2 × 40,
 * Stufen-Spawns. Hier zusätzlich: ≥ 1 Tor, keine Kill-Zone, Stufenfolge Pflicht → Bonus → Meister.
 *
 * Ein Lauf = echte PlayerMovement in der GatedWorld, echte TrainingSession (engine/Training): ab dem
 * Spawn der Stufe `from` (vorige Stufen übersprungen, ihre Tore offen), bis Stufe `to` erledigt ist
 * oder die Zeit (Default 120 s) um ist. Fällt die Hand unter killY (darf nie passieren), zählt das als
 * Tod und sie steht wieder am Stufen-Spawn.
 *
 *   npx tsx tools/levels/training/check.ts [lektion …]   Matrix aus den Buildern (ohne JSON) ausgeben
 */
import { Vector3 } from 'three';
import { TrainingSession, demoStyle, lessonMovementConfig } from '../../../src/engine/Training';
import type { RunEvent } from '../../../src/engine/events';
import { CS2_CLASSIC, withMovement } from '../../../src/player/MovementConfig';
import type { MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { GatedWorld } from '../../../src/world/collision/GatedWorld';
import { compileLevel } from '../../../src/world/level/compileLevel';
import type { CompiledLevel } from '../../../src/world/level/compileLevel';
import type { StageDef } from '../../../src/world/level/LevelFormat';
import type { DesignReport } from '../designProbes';
import { demo, isRespawning } from './drivers';
import type { Driver, DriverContext, MatrixRow } from './lessonLib';
import { LESSONS } from './index';

/** Seeds je Zeile (Plan 007: 20) und Zeitgrenze je Lauf (s). */
export const SEEDS = 20;
export const LIMIT = 120;
/** Vorführungen: so oft laufen lassen — gleiche Stufenzeiten = deterministisch. */
const DEMO_RUNS = 3;

export interface RunOutcome {
  readonly passed: boolean;
  /** Zeit bis `to` erledigt (s), sonst Laufzeit. */
  readonly time: number;
  /** Abschlusszeit je erledigter Stufe (s ab Laufbeginn). */
  readonly stageTimes: readonly number[];
  readonly verdicts: Readonly<Record<string, number>>;
  readonly falls: number;
  readonly respawns: number;
  /** Höchsttempo (u/s). */
  readonly maxSpeed: number;
}

/** Ein Lauf von Stufe `from` bis `to` (Indizes) mit dem Treiber aus `make`. */
export function runStages(level: CompiledLevel, cfg: MovementConfig, from: number, to: number, make: (ctx: DriverContext) => Driver, seed: number, seconds = LIMIT): RunOutcome {
  const world = new GatedWorld(level.world, level.gates);
  const pm = new PlayerMovement(world, cfg);
  const session = new TrainingSession(level, cfg, { world });
  session.jumpTo(from);
  const sp = session.respawnPoint();
  const spawn = { pos: sp.pos.clone(), yaw: sp.yaw };
  pm.teleport(spawn.pos);
  const driver = make({ level, cfg, world, seed, spawn });
  const dt = 1 / cfg.tickRate;
  const prev = PlayerMovement.createSnapshot();
  const cur = PlayerMovement.createSnapshot();
  pm.copySnapshot(cur);
  const out: RunEvent[] = [];
  const stageTimes: number[] = [];
  const verdicts: Record<string, number> = {};
  let falls = 0;
  let respawns = 0;
  let maxSpeed = 0;
  let t = 0;
  const respawn = (reason: 'fall' | 'manual'): void => {
    const p = session.respawnPoint();
    pm.teleport(new Vector3().copy(p.pos));
    pm.copySnapshot(cur);
    session.onEvent({ type: 'respawn', reason });
    if (isRespawning(driver)) driver.onRespawn();
  };
  const ticks = Math.ceil(seconds * cfg.tickRate);
  for (let i = 0; i < ticks; i++) {
    const cmd = driver.next(pm.state, pm.surfNormal, session);
    pm.copySnapshot(prev);
    const events = pm.tick(cmd);
    for (const e of events) session.onEvent(e);
    pm.copySnapshot(cur);
    t += dt;
    out.length = 0;
    session.tick(dt, prev, cur, cmd, pm.hullMaxs.y, out);
    for (const e of out) {
      if (e.type === 'lessonHop') verdicts[e.verdict] = (verdicts[e.verdict] ?? 0) + 1;
      else if (e.type === 'lessonStage') stageTimes.push(t);
    }
    if (cur.speed > maxSpeed) maxSpeed = cur.speed;
    if (session.stageIndex > to) return { passed: true, time: t, stageTimes, verdicts, falls, respawns, maxSpeed };
    if (cur.pos.y < level.def.killY) {
      falls++;
      respawn('fall');
    } else if (isRespawning(driver) && driver.wantsRespawn()) {
      respawns++;
      respawn('manual');
    }
  }
  return { passed: false, time: t, stageTimes, verdicts, falls, respawns, maxSpeed };
}

export interface RowResult {
  readonly row: MatrixRow;
  readonly passed: number;
  readonly runs: number;
  readonly ok: boolean;
  readonly median: number | null;
  readonly max: number | null;
  readonly falls: number;
  readonly respawns: number;
  readonly verdicts: Readonly<Record<string, number>>;
  readonly text: string;
}

const f1 = (x: number | null): string => (x === null || !Number.isFinite(x) ? '–' : x.toFixed(1));

function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function stageIndex(level: CompiledLevel, id: string): number {
  const i = (level.def.training?.stages ?? []).findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`${level.def.id}: Stufe "${id}" unbekannt`);
  return i;
}

export function verdictText(v: Readonly<Record<string, number>>): string {
  const total = Object.values(v).reduce((a, b) => a + b, 0);
  if (!total) return '';
  return Object.entries(v)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${Math.round((n / total) * 100)} %`)
    .join(', ');
}

export function runRow(level: CompiledLevel, cfg: MovementConfig, row: MatrixRow): RowResult {
  const from = stageIndex(level, row.from);
  const to = stageIndex(level, row.to ?? row.from);
  const n = row.seeds ?? SEEDS;
  const times: number[] = [];
  const verdicts: Record<string, number> = {};
  let falls = 0;
  let respawns = 0;
  for (let seed = 1; seed <= n; seed++) {
    const o = runStages(level, cfg, from, to, row.make, seed, row.seconds ?? LIMIT);
    if (o.passed) times.push(o.time);
    falls += o.falls;
    respawns += o.respawns;
    for (const [k, c] of Object.entries(o.verdicts)) verdicts[k] = (verdicts[k] ?? 0) + c;
  }
  const passed = times.length;
  const ok = 'min' in row.expect ? passed >= row.expect.min : passed <= row.expect.max;
  const want = 'min' in row.expect ? `≥ ${row.expect.min}` : `≤ ${row.expect.max}`;
  const span = row.to && row.to !== row.from ? `${row.from}→${row.to}` : row.from;
  const vt = row.verdicts ? verdictText(verdicts) : '';
  const text =
    `${row.model} [${span}]: ${passed}/${n} (Soll ${want})` +
    (passed ? `, Median ${f1(median(times))} s, max ${f1(Math.max(...times))} s` : '') +
    (falls ? `, ${falls} Tode` : '') +
    (respawns ? `, ${respawns}× F` : '') +
    (vt ? ` · Urteile: ${vt}` : '');
  return { row, passed, runs: n, ok, median: median(times), max: passed ? Math.max(...times) : null, falls, respawns, verdicts, text };
}

/**
 * Strafe-Vorführungen: höchstens so viele A↔D-Wechsel je Sekunde bis zum Ziel. Ein Mensch wechselt höchstens einmal je
 * Hop (~1.4 Hops/s); der RouteFollower als T5-Vorführung wechselte ~20×/s (Showkeys flackerten).
 */
export const DEMO_MAX_FLIPS = 2.5;

export interface DemoOutcome {
  /** Die Vorführung hat die Stufe geschafft (Schatten-Auswertung der suspendierten Session). */
  readonly passed: boolean;
  /** Zeitpunkt (s) des Schattens-Abschlusses, NaN = nie. */
  readonly passAt: number;
  /** A↔D-Wechsel bis zum Schatten-Abschluss (0 zwischen zwei Tasten zählt nicht als Wechsel). */
  readonly sideFlips: number;
  readonly verdicts: Readonly<Record<string, number>>;
  readonly falls: number;
  /** HUD-Zähler vor/nach der Vorführung gleich, Vorführungs-Tore danach wieder zu (die Vorführung zählt nie). */
  readonly restored: boolean;
  /** Füße am Ende der Vorführung. */
  readonly pos: Vector3;
  /** Ticks mit A/D bis zum Schatten-Abschluss (bzw. bis zum Ende) — was der Neuling in den Showkeys sieht. */
  readonly sideTicks: number;
  /** Höchsttempo bis zum Schatten-Abschluss (u/s). */
  readonly maxSpeed: number;
  /** Ticks mit gedrückter Sprungtaste bis zum Schatten-Abschluss (Prestrafe: 0 — die Stufe heißt "ohne Sprung"). */
  readonly jumpTicks: number;
}

/**
 * Vorführung so, wie der Spieler sie sieht (Taste H, Game.startDemo(false)): Session suspendiert — nichts zählt,
 * die Stufe wird nur im Schatten ausgewertet und öffnet ihre Tore nur für die Vorführung. `seconds` lang
 * (DemoDef.seconds). Früher lief die Prüfung mit zählender Session: die T1-Rutsch-Vorführung "bestand", im Spiel
 * fuhr sie ins geschlossene Tunneltor.
 */
export function runDemo(level: CompiledLevel, cfg: MovementConfig, stage: number): DemoOutcome {
  const st = level.def.training?.stages[stage];
  if (!st?.demo) throw new Error(`${level.def.id}: Stufe ${stage} ohne Vorführung`);
  const world = new GatedWorld(level.world, level.gates);
  const pm = new PlayerMovement(world, cfg);
  const session = new TrainingSession(level, cfg, { world });
  session.jumpTo(stage);
  const sp = session.respawnPoint();
  const spawn = { pos: sp.pos.clone(), yaw: sp.yaw };
  pm.teleport(spawn.pos);
  const hudBefore = session.hud.count;
  session.suspended = true;
  const driver = demo()({ level, cfg, world, seed: 1, spawn });
  const dt = 1 / cfg.tickRate;
  const prev = PlayerMovement.createSnapshot();
  const cur = PlayerMovement.createSnapshot();
  pm.copySnapshot(cur);
  const out: RunEvent[] = [];
  const verdicts: Record<string, number> = {};
  let passAt = Number.NaN;
  let falls = 0;
  let sideTicks = 0;
  let sideFlips = 0;
  let lastSide = 0;
  let jumpTicks = 0;
  let maxSpeed = 0;
  let t = 0;
  const ticks = Math.ceil(st.demo.seconds * cfg.tickRate);
  for (let i = 0; i < ticks; i++) {
    const cmd = driver.next(pm.state, pm.surfNormal, session);
    // Bis zum Ziel: danach hört Game nach DEMO_GOAL_HOLD auf, was dann kommt, sieht niemand lange.
    if (Number.isNaN(passAt)) {
      if (cmd.side !== 0) {
        sideTicks++;
        if (lastSide !== 0 && cmd.side !== lastSide) sideFlips++;
        lastSide = cmd.side;
      }
      if (cmd.jumpHeld || cmd.jumpPressed) jumpTicks++;
      if (pm.state.speed > maxSpeed) maxSpeed = pm.state.speed;
    }
    pm.copySnapshot(prev);
    for (const e of pm.tick(cmd)) session.onEvent(e);
    pm.copySnapshot(cur);
    t += dt;
    out.length = 0;
    session.tick(dt, prev, cur, cmd, pm.hullMaxs.y, out);
    for (const e of out) if (e.type === 'lessonHop') verdicts[e.verdict] = (verdicts[e.verdict] ?? 0) + 1;
    if (Number.isNaN(passAt) && session.demoPassed) passAt = t;
    if (cur.pos.y < level.def.killY) {
      falls++;
      break;
    }
  }
  session.suspended = false;
  // Die Tore dieser Stufe waren nur für die Vorführung offen: danach wieder zu (Kollision).
  let gatesClosed = true;
  for (let g = 0; g < level.gates.length; g++) if (world.isOpen(g) && (st.opens ?? []).includes(level.gates[g].id)) gatesClosed = false;
  const restored = session.hud.count === hudBefore && session.stageIndex === stage && gatesClosed;
  return { passed: !Number.isNaN(passAt), passAt, verdicts, falls, restored, pos: cur.pos.clone(), sideTicks, sideFlips, maxSpeed, jumpTicks };
}

/**
 * Zeigt die Vorführung die gelehrte Technik? Lektionen ohne Drehbalken (T1, T2, T6) lehren kein Strafen: dort nie A/D
 * und höchstens Sprint + Rutsch-Schub (DEMO_PLAIN_MAX) — oder so schnell, wie die Stufe selbst verlangt (+15 %: T1
 * RINNE fordert 450, der Hang gibt es ohne jede Taste). Surf-Vorführungen drücken A/D in die Rampe — das IST die
 * Technik. Prestrafe (T4-Bonus): A/D am Boden, nie die Sprungtaste.
 */
export const DEMO_PLAIN_MAX = 390;

/** Regel von demoTeachesStage in Worten (Bericht). */
function teachRule(style: string, st: StageDef): string {
  if (style === 'prestrafe') return 'Prestrafe: A/D am Boden, ohne Sprung';
  if (style === 'hand' || style === 'route') return `Strafen: höchstens ${DEMO_MAX_FLIPS} A/D-Wechsel je s`;
  return `Lektion ohne Drehbalken: kein A/D, ≤ ${demoSpeedCap(st).toFixed(0)} u/s`;
}

/** Höchsttempo einer Vorführung ohne Strafen in dieser Stufe (u/s). */
export function demoSpeedCap(st: StageDef): number {
  const t = st.task;
  const need = t.kind === 'course' ? t.minSpeed : t.kind === 'speed' || t.kind === 'surfSpeed' ? t.min : 0;
  return Math.max(DEMO_PLAIN_MAX, need * 1.15);
}

export function demoTeachesStage(level: CompiledLevel, style: string, o: DemoOutcome, st: StageDef): boolean {
  if (style === 'prestrafe') return o.jumpTicks === 0 && o.sideTicks > 0;
  // Strafe-Vorführungen: eine Seite je Hop, kein Flackern der Showkeys.
  if (style === 'hand' || style === 'route') return o.sideFlips <= Math.ceil(o.passAt * DEMO_MAX_FLIPS);
  if (level.def.training?.hud?.turnBand === true || style === 'surf') return true;
  return o.sideTicks === 0 && o.maxSpeed <= demoSpeedCap(st);
}

/** Vorführungen jeder Stufe mit DemoDef im Spielmodus: DEMO_RUNS Läufe, alle bestanden, gleich schnell, Route bis zum Ende frei. */
export function checkDemos(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const stages = level.def.training?.stages ?? [];
  stages.forEach((st, i) => {
    if (!st.demo) {
      if ((st.rank ?? 'required') === 'required') r.info.push(`Vorführung ${st.id}: keine (DemoDef fehlt)`);
      return;
    }
    const outs = Array.from({ length: DEMO_RUNS }, () => runDemo(level, cfg, i));
    const o = outs[0];
    const pass = outs.filter((x) => x.passed).length;
    const same = outs.every((x) => Object.is(x.passAt, o.passAt) && x.sideFlips === o.sideFlips);
    const good = o.verdicts.good ?? 0;
    const judged = Object.values(o.verdicts).reduce((a, b) => a + b, 0);
    const style = demoStyle(st.demo, level);
    const teaches = demoTeachesStage(level, style, o, st);
    const line =
      `Vorführung ${st.id} (${style}, Spielmodus): ${pass}/${DEMO_RUNS}, Stufe nach ${f1(o.passAt)} s` +
      (same ? ', deterministisch' : ', NICHT deterministisch') +
      (judged ? `, gute Hops ${good}/${judged}` : '') +
      `, A/D ${o.sideTicks} Ticks (${o.sideFlips} Wechsel), max ${o.maxSpeed.toFixed(0)} u/s` +
      (o.jumpTicks && style === 'prestrafe' ? `, Sprungtaste ${o.jumpTicks} Ticks` : '') +
      (teaches ? '' : ` — zeigt NICHT die Technik der Stufe (${teachRule(style, st)})`) +
      (o.falls ? `, ${o.falls} Tode` : '') +
      (o.restored ? '' : ', Stand danach NICHT wiederhergestellt');
    const required = (st.rank ?? 'required') === 'required';
    // Wo das HUD Urteile zeigt (Strafe-Lektionen mit Drehbalken) und bei der Strafe-Hand: nur gute Hops vorführen.
    const clean = (style !== 'hand' && !level.def.training?.hud?.turnBand) || good === judged;
    if (pass === DEMO_RUNS && same && o.falls === 0 && o.restored && clean && teaches) r.info.push(line);
    else if (required) r.errors.push(line);
    else r.warnings.push(line);
  });
}

/**
 * Nur Info: die Pflicht-Vorführungen mit Spieler-Einstellungen statt der Lehr-Config (Auto-Hop aus, Preset CS2 mit
 * Default-Schaltern). Lektionen laufen im Spiel nur mit lessonMovementConfig() — die Zeile zeigt, was sonst bricht.
 */
function playerConfigNote(level: CompiledLevel, r: DesignReport): void {
  const stages = level.def.training?.stages ?? [];
  const variants: readonly [string, MovementConfig][] = [
    ['Auto-Hop aus', withMovement(lessonMovementConfig(), { autoHop: false })],
    ['CS2 (Assist/Luftlenkung aus)', withMovement(CS2_CLASSIC, { autoHop: true, strafeAssist: false, airControl: 0 })],
  ];
  const parts: string[] = [];
  for (const [name, vc] of variants) {
    const fails: string[] = [];
    let n = 0;
    stages.forEach((st, i) => {
      if (!st.demo || (st.rank ?? 'required') !== 'required') return;
      n++;
      if (!runDemo(level, vc, i).passed) fails.push(st.id);
    });
    parts.push(`${name}: ${n - fails.length}/${n}${fails.length ? ` (✗ ${fails.join(', ')})` : ''}`);
  }
  r.info.push(`Pflicht-Vorführungen mit Spieler-Config statt Lehr-Config (nur Info): ${parts.join('; ')}`);
}

/** Zwei Movement-Configs gleich (alle Felder, auch die Hull)? */
function sameMovement(a: MovementConfig, b: MovementConfig): boolean {
  const ka = Object.keys(a) as (keyof MovementConfig)[];
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (typeof x === 'object' && typeof y === 'object') {
      if (JSON.stringify(x) !== JSON.stringify(y)) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/**
 * Physik einer Lektion. Gerechnet wird immer mit lessonMovementConfig() — der einzigen Config, mit der Lektionen im
 * Spiel laufen; `cfg` (der Validator übergibt VELOCITY_DEFAULT) muss ihr gleichen, sonst ist das ein Fehler.
 */
export function checkTrainingLevel(level: CompiledLevel, given: MovementConfig): DesignReport {
  const r: DesignReport = { errors: [], warnings: [], info: [] };
  const t = level.def.training;
  if (!t) return r;
  const cfg = lessonMovementConfig();
  if (!sameMovement(given, cfg)) r.errors.push('Prüf-Config weicht von lessonMovementConfig() ab — Lektionen laufen im Spiel nur mit der Lehr-Config');
  if (level.gates.length < 1) r.errors.push('Lektion ohne Tor (mindestens das Ausgangstor)');
  const kills = level.triggers.filter((x) => x.kind === 'kill').length;
  if (kills > 0) r.errors.push(`${kills} Kill-Zone(n) — in Lektionen gibt es keinen Tod`);
  const order: Record<string, number> = { required: 0, bonus: 1, master: 2 };
  let last = 0;
  for (const s of t.stages) {
    const k = order[s.rank ?? 'required'];
    if (k < last) r.errors.push(`Stufe "${s.id}" (${s.rank ?? 'required'}) nach einer höheren Stufe — Reihenfolge Pflicht → Bonus → Meister`);
    last = Math.max(last, k);
  }
  const entry = LESSONS.find((e) => e.id === level.def.id);
  if (!entry) {
    r.warnings.push(`Lektion ${t.short}: keine Bot-Matrix (tools/levels/training/index.ts)`);
    return r;
  }
  checkDemos(level, cfg, r);
  playerConfigNote(level, r);
  for (const row of entry.check.rows) {
    const res = runRow(level, cfg, row);
    if (res.falls > 0) r.errors.push(`${res.text} — Tod in einer Lektion`);
    else if (res.ok) r.info.push(res.text);
    else if (row.level === 'error') r.errors.push(res.text);
    else if (row.level === 'warning') r.warnings.push(res.text);
    else r.info.push(res.text);
  }
  if (entry.check.extra) {
    const x = entry.check.extra(level, cfg);
    r.errors.push(...x.errors);
    r.warnings.push(...x.warnings);
    r.info.push(...x.info);
  }
  return r;
}

// CLI: Matrix direkt aus den Buildern (ohne gebautes JSON), z. B. beim Entwerfen einer Lektion.
if (process.argv[1]?.replace(/\\/g, '/').endsWith('tools/levels/training/check.ts')) {
  const only = process.argv.slice(2);
  for (const e of LESSONS) {
    if (only.length && !only.includes(e.id)) continue;
    const t0 = Date.now();
    const level = compileLevel(e.build());
    const rep = checkTrainingLevel(level, lessonMovementConfig());
    console.log(`\n${e.id} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    for (const l of rep.errors) console.log(`  ✗ ${l}`);
    for (const l of rep.warnings) console.log(`  ! ${l}`);
    for (const l of rep.info) console.log(`    ${l}`);
  }
}
