/**
 * `npm run levels:build [-- <id> …]`: tools/levels/level*.ts → public/levels/*.json + index.json,
 * Lektionen (tools/levels/training) → public/levels/training/*.json + training/index.json.
 * sandbox.json bleibt unangetastet und steht bewusst nicht im Index.
 *
 * Registry (Plan 007): LEVELS in Index-Reihenfolge. Ein Builder, der null liefert (Stub), wird
 * übersprungen — auch im Index. Filter: `-- level3` baut nur level3.json, `-- training` alle
 * Lektionen samt training/index.json, `-- <Lektions-id>` nur diese Lektion. Mit Filter wird
 * public/levels/index.json NIE geschrieben (den baut nur der volle Lauf, Plan 007 Phase 3).
 * Geschrieben wird erst, wenn alle ids aufgelöst und alle Level gemessen sind — ein Tippfehler
 * oder ein scheiternder Bot hinterlässt keinen halben Build im gemeinsamen Arbeitsbaum.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compileLevel, type CompiledLevel } from '../../src/world/level/compileLevel';
import type { LevelFile, LevelIndexEntry, LevelMedals, TrainingIndexEntry } from '../../src/world/level/LevelFormat';
import { buildLevel1 } from './level1';
import { buildLevel2 } from './level2';
import { buildLevel3 } from './level3';
import { buildLevel4 } from './level4';
import { describeBranches, jitterBranches, jitterMedian, medianOf, timedMedian, withRoute, type MedalReference, type RouteChoice, type StrafeModel } from './physics';
import { level3Reference } from './probes/level3';
import { level4Reference } from './probes/level4';
import { buildTraining } from './training/index';

const OUT = 'public/levels';

/** Ein Level der Registry: id (= Dateiname ohne .json), Builder (null = noch Stub), optional ein zweites Medaillen-Modell. */
export interface LevelEntry {
  readonly id: string;
  readonly build: () => LevelFile | null;
  /** Referenz-Modell (physics.MedalReference): je Medaille zählt der schnellere Median aus RouteFollower und Referenz. */
  readonly reference?: () => MedalReference;
}

/** Alle Level in Index-Reihenfolge. L3/L4: Surf-Referenz, weil der RouteFollower langsamer surft als die Grundtechnik. */
export const LEVELS: readonly LevelEntry[] = [
  { id: 'level1', build: buildLevel1 },
  { id: 'level2', build: buildLevel2 },
  { id: 'level3', build: buildLevel3, reference: level3Reference },
  { id: 'level4', build: buildLevel4, reference: level4Reference },
];

/**
 * Seeds der Hände für Bronze/Silber (Plan 007 Phase 3): 48 statt der 8 Validator-Seeds. Auf einer Linie mit
 * Netz hat die 3°-Hand zwei Zeit-Moden (Fall aufs Band ja/nein, 2–4 s) — L3-Türkis Seeds 1–8 24.55 s, 48 Seeds
 * 25.99 s: Bronze aus 8 Seeds schaffte die Bronze-Hand nur in 21/48 Läufen (fallen.md, Medaillen-Stichprobe).
 */
export const MEDAL_SEEDS: readonly number[] = Array.from({ length: 48 }, (_, i) => i + 1);

/**
 * Medaillen: Bot-Modell, Aufschlag (LevelFormat.LevelMedals), gemessene Linie und Messart.
 * Bronze/Silber auf der sicheren Linie einer Gabel (safeRoute, sonst route) als Median über MEDAL_SEEDS:
 * Gelegenheitsspieler schaffen sie ohne Risiko. Gold/VELOCITY/Autor auf der Ideallinie, als Median über 49 Start-Jitter
 * (physics.START_JITTERS): der perfekte Bot ist deterministisch, aber chaotisch — ein Einzellauf hängt
 * an Zehntelgrad. Der Median trägt nur, solange der Bot EINEN Zweig fährt; zerfällt er in Zweige
 * (physics.jitterBranches, L1: Bonk an der Crouch-Kante), warnt der Build laut (BuildResult.warnings,
 * levels:check ebenso) — dann ist das Level zu reparieren, nicht die Kennzahl zu wechseln.
 * Hat ein Level eine Referenz (LevelEntry.reference, L3/L4: Surf-Grundtechnik), zählt je Modell der schnellere
 * Median — der RouteFollower surft fallende Rampen langsamer als ein Mensch mit der Technik aus T7/T8.
 */
const MEDAL_MODELS: Record<keyof LevelMedals, { readonly model: StrafeModel; readonly factor: number; readonly line: RouteChoice; readonly jitter: boolean }> = {
  bronze: { model: { aimNoiseDeg: 3 }, factor: 1.05, line: 'safeRoute', jitter: false },
  silver: { model: { aimNoiseDeg: 2 }, factor: 1.05, line: 'safeRoute', jitter: false },
  gold: { model: { sync: 1 }, factor: 1.1, line: 'route', jitter: true },
  // VELOCITY: halber Weg zwischen Gold und Autor. 1°/0.5°-Hand und sync 0.9/0.95 streuen
  // zu stark (L1-Median 25.8–27.6 s, langsamer als Gold), taugen also nicht als Maß —
  // die Ideallinie + 5 % ist die Zahl, die ein sehr guter Mensch mit sauberer Linie schafft
  // (level-design.md Regel 10, npx tsx tools/levels/medalProbe.ts).
  velocity: { model: { sync: 1 }, factor: 1.05, line: 'route', jitter: true },
  author: { model: { sync: 1 }, factor: 1, line: 'route', jitter: true },
};

/** Auf 0.1 s aufrunden (die Anzeige hat zwei Nachkommastellen, die Ziele sollen glatt sein). */
function up01(t: number): number {
  return Number((Math.ceil(t * 10 - 1e-6) / 10).toFixed(1));
}

/**
 * Par und Medaillen, gemessen wie der RunState-Timer (physics.timedRun: ab
 * Verlassen der Startzone, Tode inklusive): Hände als Median über MEDAL_SEEDS,
 * der perfekte Bot als Median über Start-Jitter (physics.jitterMedian).
 * Par = Bronze auf ganze Sekunden — die Ansage für Gelegenheitsspieler (3°-Hand,
 * CS2-Parität). Früher Par ab Spawn und nur aus Läufen ohne Tod: ~1.3 s zu lasch,
 * und nach dem ersten Lauf gab es kein Ziel mehr (Level-Flow-Kritik).
 */
function withTimes(level: LevelFile, log: (line: string) => void, warn: (line: string) => void, reference: MedalReference | null = null): LevelFile {
  const c = compileLevel(level);
  const lines: Record<RouteChoice, CompiledLevel> = { route: c, safeRoute: withRoute(c, 'safeRoute') };
  const median = new Map<string, number>();
  const time = (key: keyof LevelMedals): number => {
    const { model, factor, line, jitter } = MEDAL_MODELS[key];
    const id = `${JSON.stringify(model)}|${line}|${jitter}`;
    let m = median.get(id);
    if (m === undefined) {
      const j = jitter ? jitterMedian(lines[line], model) : null;
      const r = j ?? timedMedian(lines[line], model, MEDAL_SEEDS);
      if (r.median === null) throw new Error(`${level.id}: Bot ${JSON.stringify(model)} (${line}) kommt in der Mehrheit der Läufe nicht ins Ziel — keine Medaille ${key}`);
      const mm = r.median;
      m = mm;
      median.set(id, mm);
      if (j) log(`  ${level.id}: ${JSON.stringify(model)} über ${j.runs.length} Start-Jitter [${j.runs.map((x) => (x.time === null ? 'x' : x.time.toFixed(2))).join(' ')}] → Median ${mm.toFixed(2)} s`);
      else log(`  ${level.id}: ${JSON.stringify(model)} (${line}) über ${r.runs.length} Seeds, ${r.runs.filter((x) => x.time === null).length} ohne Ziel → Median ${mm.toFixed(2)} s`);
      if (j?.branches) {
        const side = j.branches.fast.some((x) => x.time === mm) ? 'schnellen' : 'langsamen';
        warn(
          `${level.id}: perfekter Bot zerfällt über den Start-Kasten in zwei Zweige — ${describeBranches(j.branches)}. Der Median ${mm.toFixed(2)} s ` +
            `liegt im ${side} Zweig und hängt davon ab, wie viele Starts dort landen: Gold/VELOCITY/Autor nicht belastbar — Chaos-Stelle im Level entschärfen`,
        );
      }
      // Zweites Modell (Surf-Grundtechnik): zählt, wenn es schneller ist — die Medaille steht für die Technik, nicht den Bot.
      const ref = reference?.runs(lines[line], model, line, jitter, MEDAL_SEEDS) ?? null;
      const rm = ref ? medianOf(ref.runs) : null;
      if (ref && reference) {
        log(`  ${level.id}: Referenz ${reference.name}, ${JSON.stringify(model)}: ${ref.detail} → Median ${rm === null ? '–' : rm.toFixed(2)} s${rm !== null && rm < mm ? ` < RouteFollower ${mm.toFixed(2)} s → zählt` : ''}`);
        const rb = ref.overJitter ? jitterBranches(ref.runs) : null;
        if (rb && rm !== null && rm < mm) warn(`${level.id}: Referenz ${reference.name} zerfällt über den Start-Kasten in zwei Zweige — ${describeBranches(rb)}`);
      }
      if (rm !== null && rm < mm) {
        m = rm;
        median.set(id, rm);
      }
    }
    // Autor-Zeit auf 0.01 s (die Zahl, die man schlagen will), die anderen glatt auf 0.1 s.
    return key === 'author' ? Number((Math.ceil(m * 100 - 1e-6) / 100).toFixed(2)) : up01(factor * m);
  };
  const medals: LevelMedals = { bronze: time('bronze'), silver: time('silver'), gold: time('gold'), velocity: time('velocity'), author: time('author') };
  if (!(medals.bronze > medals.silver && medals.silver > medals.gold && medals.gold > medals.velocity && medals.velocity >= medals.author))
    throw new Error(`${level.id}: Medaillen nicht streng fallend: ${JSON.stringify(medals)}`);
  if (level.safeRoute) {
    // Die Gabel soll sich lohnen: VELOCITY nur über die schnelle Linie.
    const s = jitterMedian(lines.safeRoute, { sync: 1 }).median;
    if (s !== null && s <= medals.velocity) warn(`${level.id}: perfekter Bot auf safeRoute ${s.toFixed(2)} s ≤ VELOCITY ${medals.velocity} s — die schnelle Linie lohnt nicht`);
    else if (s !== null) log(`  ${level.id}: safeRoute sync 1.0 ${s.toFixed(2)} s > VELOCITY ${medals.velocity} s`);
  }
  return { ...level, parTime: Math.ceil(medals.bronze), medals };
}

/**
 * JSON mit einer Zeile pro Brush/Trigger/Knoten: bleibt diff- und
 * handeditierbar, ohne dass Zahlen-Arrays über zig Zeilen laufen.
 */
export function formatLevel(level: LevelFile): string {
  const lines: string[] = ['{'];
  const entries = Object.entries(level);
  entries.forEach(([key, value], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    if (Array.isArray(value)) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      value.forEach((item, k) => lines.push(`    ${JSON.stringify(item)}${k < value.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
    } else if (value !== null && typeof value === 'object') {
      const inner = Object.entries(value as Record<string, unknown>);
      lines.push(`  ${JSON.stringify(key)}: {`);
      inner.forEach(([k2, v2], k) => lines.push(`    ${JSON.stringify(k2)}: ${JSON.stringify(v2)}${k < inner.length - 1 ? ',' : ''}`));
      lines.push(`  }${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
    }
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export interface BuildOptions {
  /** Zielordner (Default public/levels); Lektionen landen in <out>/training. */
  readonly out?: string;
  /** Filter: Level-ids, 'training' (alle Lektionen + training/index.json) oder Lektions-ids. Leer = alles + index.json. */
  readonly only?: readonly string[];
  /** Registry (Default LEVELS) und Lektionen (Default buildTraining) — Tests setzen eigene ein. */
  readonly levels?: readonly LevelEntry[];
  readonly training?: () => readonly LevelFile[] | null;
  readonly log?: (line: string) => void;
}

export interface BuildResult {
  /** Geschriebene Dateien (Pfade relativ zu out). */
  readonly written: readonly string[];
  /** Registry-Einträge, deren Builder null lieferte (Stub). */
  readonly stubs: readonly string[];
  /** Befunde, die der Build nicht selbst lösen kann (Zweige des perfekten Bots, Gabel ohne Nutzen). */
  readonly warnings: readonly string[];
}

export function runBuild(o: BuildOptions = {}): BuildResult {
  const out = o.out ?? OUT;
  const log = o.log ?? ((l: string): void => console.log(l));
  const registry = o.levels ?? LEVELS;
  const only = o.only ?? [];
  const full = only.length === 0;
  const written: string[] = [];
  const stubs: string[] = [];
  const warnings: string[] = [];
  const warn = (l: string): void => {
    warnings.push(l);
    log(`  ! ${l}`);
  };

  // 1) Alle ids auflösen, bevor irgendetwas gemessen oder geschrieben wird.
  const levelIds = new Set(registry.map((e) => e.id));
  const allLessons = full || only.includes('training');
  const lessonIds = only.filter((id) => id !== 'training' && !levelIds.has(id));
  const lessons = allLessons || lessonIds.length ? (o.training ?? buildTraining)() : null;
  const unknown = lessonIds.filter((id) => !lessons?.some((l) => l.id === id));
  if (unknown.length)
    throw new Error(`Unbekannte id(s): ${unknown.join(', ')} (Level: ${registry.map((e) => e.id).join(', ')}; Lektionen: ${lessons?.map((l) => l.id).join(', ') || 'noch keine'}) — nichts geschrieben`);
  const pickedLessons = lessons ? (allLessons ? lessons : lessons.filter((l) => lessonIds.includes(l.id))) : [];
  for (const l of pickedLessons) {
    if (!l.training) throw new Error(`Lektion ${l.id}: ohne training — nichts geschrieben`);
    if (l.medals !== undefined || l.parTime !== undefined) throw new Error(`Lektion ${l.id}: training schließt medals/parTime aus — nichts geschrieben`);
  }

  // 2) Level bauen und messen (kann werfen: Bot scheitert, Medaillen nicht fallend).
  const built: LevelFile[] = [];
  for (const e of full ? registry : registry.filter((x) => only.includes(x.id))) {
    const raw = e.build();
    if (!raw) {
      stubs.push(e.id);
      log(`– ${e.id}: noch kein Builder (Stub) — übersprungen`);
      continue;
    }
    if (raw.id !== e.id) throw new Error(`Registry "${e.id}" baut ein Level mit id "${raw.id}"`);
    built.push(withTimes(raw, log, warn, e.reference ? e.reference() : null));
  }

  // 3) Schreiben.
  const write = (file: string, text: string): void => {
    writeFileSync(`${out}/${file}`, text);
    written.push(file);
  };
  const index: LevelIndexEntry[] = [];
  for (const level of built) {
    const file = `${level.id}.json`;
    write(file, formatLevel(level));
    index.push({
      id: level.id,
      name: level.name,
      ...(level.subtitle ? { subtitle: level.subtitle } : {}),
      file,
      // Medaillen auch im Index: die Titel-Liste zeigt sie, ohne jedes Level zu laden.
      ...(level.medals ? { medals: level.medals } : {}),
      ...(level.prepLessons ? { prepLessons: level.prepLessons } : {}),
    });
    log(`✓ ${out}/${file}: ${level.name} — ${level.brushes.length} Brushes, ${level.triggers.length} Trigger, ${level.route?.length ?? 0} Route-Knoten${level.safeRoute ? ` (safeRoute ${level.safeRoute.length})` : ''}, Par ${level.parTime ?? '–'} s, Medaillen ${level.medals ? `${level.medals.bronze}/${level.medals.silver}/${level.medals.gold}/${level.medals.velocity}/${level.medals.author}` : '–'} s`);
  }
  if (full) {
    write('index.json', `${JSON.stringify(index, null, 2)}\n`);
    log(`✓ ${out}/index.json: ${index.length} Level`);
  }

  // Lektionen: ohne Filter alle + Index, mit 'training' ebenso, mit Lektions-ids nur diese Dateien.
  if ((allLessons || lessonIds.length) && !lessons) log('– training: noch keine Lektionen (Stub) — übersprungen');
  if (lessons) {
    mkdirSync(`${out}/training`, { recursive: true });
    const entries: TrainingIndexEntry[] = [];
    for (const l of pickedLessons) {
      const t = l.training;
      if (!t) continue;
      write(`training/${l.id}.json`, formatLevel(l));
      entries.push({ id: l.id, name: l.name, ...(l.subtitle ? { subtitle: l.subtitle } : {}), file: `${l.id}.json`, lesson: t.lesson, short: t.short, group: t.group });
      log(`✓ ${out}/training/${l.id}.json: ${t.short} ${l.name} — ${t.stages.length} Stufen, ${l.brushes.length} Brushes`);
    }
    if (allLessons) {
      write('training/index.json', `${JSON.stringify(entries, null, 2)}\n`);
      log(`✓ ${out}/training/index.json: ${entries.length} Lektionen`);
    }
  }
  return { written, stubs, warnings };
}

// Nur als CLI laufen, nicht beim Import (Tests, andere Tools).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = runBuild({ only: process.argv.slice(2) });
  // Warnungen am Ende wiederholen — zwischen den Messzeilen gehen sie sonst unter.
  if (res.warnings.length) {
    console.log(`\n! ${res.warnings.length} Warnung${res.warnings.length > 1 ? 'en' : ''} (geschrieben wurde trotzdem):`);
    for (const w of res.warnings) console.log(`  ! ${w}`);
  }
}
