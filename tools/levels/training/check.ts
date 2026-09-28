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
import { TrainingSession } from '../../../src/engine/Training';
import type { RunEvent } from '../../../src/engine/events';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import type { MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { GatedWorld } from '../../../src/world/collision/GatedWorld';
import { compileLevel } from '../../../src/world/level/compileLevel';
import type { CompiledLevel } from '../../../src/world/level/compileLevel';
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

/** Vorführungen jeder Stufe mit DemoDef: DEMO_RUNS Läufe, alle bestanden und gleich schnell. */
export function checkDemos(level: CompiledLevel, cfg: MovementConfig, r: DesignReport): void {
  const stages = level.def.training?.stages ?? [];
  stages.forEach((st, i) => {
    if (!st.demo) {
      if ((st.rank ?? 'required') === 'required') r.info.push(`Vorführung ${st.id}: keine (DemoDef fehlt)`);
      return;
    }
    const outs = Array.from({ length: DEMO_RUNS }, () => runStages(level, cfg, i, i, demo(), 1, st.demo?.seconds ?? LIMIT));
    const pass = outs.filter((o) => o.passed).length;
    const same = outs.every((o) => o.time === outs[0].time);
    const good = outs[0].verdicts.good ?? 0;
    const judged = Object.values(outs[0].verdicts).reduce((a, b) => a + b, 0);
    const line = `Vorführung ${st.id} (${st.demo.kind}): ${pass}/${DEMO_RUNS} in ${f1(outs[0].time)} s${same ? ', deterministisch' : ', NICHT deterministisch'}${judged ? `, gute Hops ${good}/${judged}` : ''}`;
    const required = (st.rank ?? 'required') === 'required';
    if (pass === DEMO_RUNS && same && (st.demo.kind !== 'hand' || good === judged)) r.info.push(line);
    else if (required) r.errors.push(line);
    else r.warnings.push(line);
  });
}

export function checkTrainingLevel(level: CompiledLevel, cfg: MovementConfig): DesignReport {
  const r: DesignReport = { errors: [], warnings: [], info: [] };
  const t = level.def.training;
  if (!t) return r;
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
    const rep = checkTrainingLevel(level, VELOCITY_DEFAULT);
    console.log(`\n${e.id} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    for (const l of rep.errors) console.log(`  ✗ ${l}`);
    for (const l of rep.warnings) console.log(`  ! ${l}`);
    for (const l of rep.info) console.log(`    ${l}`);
  }
}
