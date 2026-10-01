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
import { describeBranches, jitterBranches, jitterMedian, medianOf, timedMedian, withRoute, type MedalReference, type RouteChoice, type StrafeModel, type SurfLook } from './physics';
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

/** Ein Medaillen-Modell: Hand, gemessene Linie, Messart (Seeds oder Start-Jitter). */
interface MedalModel {
  readonly model: StrafeModel;
  readonly line: RouteChoice;
  readonly jitter: boolean;
  /** Blick der Surf-Referenz (physics.SurfLook). */
  readonly look: SurfLook;
}
const HAND3: MedalModel = { model: { aimNoiseDeg: 3 }, line: 'safeRoute', jitter: false, look: 'lesson' };
const HAND2: MedalModel = { model: { aimNoiseDeg: 2 }, line: 'safeRoute', jitter: false, look: 'best' };
const HAND1: MedalModel = { model: { aimNoiseDeg: 1 }, line: 'route', jitter: false, look: 'best' };
const PERFECT: MedalModel = { model: { sync: 1 }, line: 'route', jitter: true, look: 'best' };

/**
 * Einheitliches Medaillen-Modell (level-design.md Regel 10, Plan 007 §10). Je Stufe ein Hand-Modell × Aufschlag; jedes
 * Modell zählt mit dem schnelleren Median aus RouteFollower und Level-Referenz (LevelEntry.reference, Surf-Grundtechnik
 * mit DERSELBEN Hand, physics.surfSigma) — für alle Stufen, nicht nur die oberen:
 * - Bronze = 3°-Hand × 1.05 auf der sicheren Linie (Gelegenheitsspieler, CS2-Parität; ohne Risiko), surfend wie
 *   gelehrt (Blick 0°, T8 wörtlich — den Blickversatz kennt ein Gelegenheitsspieler nicht).
 * - Silber = 2°-Hand × 1.05 auf der sicheren Linie (geübt), surfend mit dem besten Blickversatz.
 * - Gold = die LEICHTERE von 1°-Hand × 1.05 und perfekt × 1.10 auf der Ideallinie: Gold ist für sehr gute Hände
 *   erreichbar (L1 vorher perfekt × 1.10 = 20.7 s gegen 1°-Hand 24.8 s — Neon-Handschuh unerreichbar), und nie
 *   enger als 4.8 % über VELOCITY (L2: 1°-Hand × 1.05 = 16.9 s läge 2 % über VELOCITY 16.5 s).
 * - VELOCITY = perfekt × 1.05, Autor = perfekt (Median über 49 Start-Jitter). 1°/0.5°-Hand und sync 0.9/0.95 taugen
 *   hier nicht: sie zerfallen auf L1 in zwei Moden (fallen.md #70), der Median springt zwischen ihnen.
 * Hände als Median über MEDAL_SEEDS; der perfekte Bot über Start-Jitter (physics.START_JITTERS: deterministisch, aber
 * chaotisch — zerfällt er in Zweige, warnt der Build laut: dann ist das Level zu reparieren, nicht die Kennzahl).
 * Danach die Staffel (`staggerMedals`): jede Stufe mindestens MEDAL_MIN_STEP über der nächstbesseren.
 */
const MEDAL_RULES: Record<keyof LevelMedals, ReadonlyArray<{ readonly m: MedalModel; readonly factor: number }>> = {
  bronze: [{ m: HAND3, factor: 1.05 }],
  silver: [{ m: HAND2, factor: 1.05 }],
  gold: [
    { m: HAND1, factor: 1.05 },
    { m: PERFECT, factor: 1.1 },
  ],
  velocity: [{ m: PERFECT, factor: 1.05 }],
  author: [{ m: PERFECT, factor: 1 }],
};

/**
 * Mindestabstand benachbarter Medaillen (Faktor). Unter 4 % ist die bessere Stufe kein eigenes Ziel: Hand-Mediane über
 * 48 Seeds streuen um 1–3 % (L4: 1.5°-Hand 26.07 s langsamer als 2°-Hand 25.91 s), und die Surf-Referenz trennt die
 * Hände kaum (L3 Türkis: 3°-Hand 14.20 s, 2°-Hand 13.84 s — 2.6 %). Gelockert wird immer die LEICHTERE Stufe: das
 * nimmt keiner Hand ihre Medaille.
 */
export const MEDAL_MIN_STEP = 1.04;
/**
 * Größter sinnvoller Abstand Bronze → Silber → Gold (Faktor): darüber hat eine Spielergruppe zwischen zwei Händen kein
 * erreichbares nächstes Ziel mehr (L3 vorher Silber 25.1 → Gold 12.8 s, × 1.96). Warnung. Gold → VELOCITY ist ausgenommen
 * (nur Log): VELOCITY ist die Krone des perfekten Bots, der Abstand misst, wie viel Präzision das Level über der 1°-Hand
 * belohnt (L1: die 1°-Hand zerfällt in zwei Moden, 20.0–20.6 s ohne und 24.5–27.8 s mit Einbruch an der Crouch-Kante).
 */
export const MEDAL_MAX_STEP = 1.2;

/** Staffel: von oben (VELOCITY) nach unten jede Stufe ≥ MEDAL_MIN_STEP × die nächstbessere; Rückgabe samt Log-Zeilen. */
export function staggerMedals(raw: LevelMedals): { readonly medals: LevelMedals; readonly notes: readonly string[] } {
  const notes: string[] = [];
  const m = { ...raw };
  const pairs: ReadonlyArray<readonly [keyof LevelMedals, keyof LevelMedals]> = [
    ['gold', 'velocity'],
    ['silver', 'gold'],
    ['bronze', 'silver'],
  ];
  for (const [easy, hard] of pairs) {
    const min = up01(MEDAL_MIN_STEP * m[hard]);
    if (m[easy] < min) {
      notes.push(`${easy} ${m[easy]} s < ${MEDAL_MIN_STEP} × ${hard} ${m[hard]} s → ${min} s`);
      m[easy] = min;
    }
  }
  return { medals: m, notes };
}

/** Abstände benachbarter Medaillen als Faktoren (Bronze/Silber, Silber/Gold, Gold/VELOCITY, VELOCITY/Autor). */
export function medalSteps(m: LevelMedals): { readonly bs: number; readonly sg: number; readonly gv: number; readonly va: number } {
  return { bs: m.bronze / m.silver, sg: m.silver / m.gold, gv: m.gold / m.velocity, va: m.velocity / m.author };
}

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
  /** Median eines Medaillen-Modells: der schnellere aus RouteFollower und Referenz (gleiche Hand, gleiche Linie). */
  const measure = ({ model, line, jitter, look }: MedalModel, key: keyof LevelMedals): number => {
    const id = `${JSON.stringify(model)}|${line}|${jitter}|${look}`;
    const cached = median.get(id);
    if (cached !== undefined) return cached;
    const j = jitter ? jitterMedian(lines[line], model) : null;
    const r = j ?? timedMedian(lines[line], model, MEDAL_SEEDS);
    const tag = `${JSON.stringify(model)} (${line})`;
    if (j) log(`  ${level.id}: ${tag} über ${j.runs.length} Start-Jitter [${j.runs.map((x) => (x.time === null ? 'x' : x.time.toFixed(2))).join(' ')}] → Median ${j.median?.toFixed(2) ?? '–'} s`);
    else log(`  ${level.id}: ${tag} über ${r.runs.length} Seeds, ${r.runs.filter((x) => x.time === null).length} ohne Ziel → Median ${r.median?.toFixed(2) ?? '–'} s`);
    if (j?.branches && j.median !== null) {
      const mm = j.median;
      const side = j.branches.fast.some((x) => x.time === mm) ? 'schnellen' : 'langsamen';
      warn(
        `${level.id}: perfekter Bot zerfällt über den Start-Kasten in zwei Zweige — ${describeBranches(j.branches)}. Der Median ${mm.toFixed(2)} s ` +
          `liegt im ${side} Zweig und hängt davon ab, wie viele Starts dort landen: Gold/VELOCITY/Autor nicht belastbar — Chaos-Stelle im Level entschärfen`,
      );
    }
    // Referenz (Surf-Grundtechnik) mit derselben Hand: zählt, wenn sie schneller ist — die Medaille steht für die Technik, nicht den Bot.
    const ref = reference?.runs(lines[line], model, line, jitter, MEDAL_SEEDS, { look }) ?? null;
    const rm = ref ? medianOf(ref.runs) : null;
    const refWins = rm !== null && (r.median === null || rm < r.median);
    if (ref && reference) {
      log(`  ${level.id}: Referenz ${reference.name}, ${tag}: ${ref.detail} → Median ${rm === null ? '–' : rm.toFixed(2)} s${refWins ? ` < RouteFollower ${r.median?.toFixed(2) ?? '–'} s → zählt` : ''}`);
      const rb = ref.overJitter ? jitterBranches(ref.runs) : null;
      if (rb && refWins) warn(`${level.id}: Referenz ${reference.name} zerfällt über den Start-Kasten in zwei Zweige — ${describeBranches(rb)}`);
    }
    const m = refWins ? rm : r.median;
    if (m === null) throw new Error(`${level.id}: ${tag} kommt weder als RouteFollower noch als Referenz in der Mehrheit der Läufe ins Ziel — keine Medaille ${key}`);
    median.set(id, m);
    return m;
  };
  const time = (key: keyof LevelMedals): number => {
    // Mehrere Modelle (Gold): die leichtere Grenze zählt — erreichbar für jede der genannten Hände.
    const vals = MEDAL_RULES[key].map(({ m, factor }) => {
      const t = measure(m, key);
      // Autor-Zeit auf 0.01 s (die Zahl, die man schlagen will), die anderen glatt auf 0.1 s.
      return key === 'author' ? Number((Math.ceil(t * 100 - 1e-6) / 100).toFixed(2)) : up01(factor * t);
    });
    if (vals.length > 1) log(`  ${level.id}: ${key} = max(${MEDAL_RULES[key].map(({ m, factor }, i) => `${JSON.stringify(m.model)} × ${factor} → ${vals[i]}`).join(', ')}) s`);
    return Math.max(...vals);
  };
  const raw: LevelMedals = { bronze: time('bronze'), silver: time('silver'), gold: time('gold'), velocity: time('velocity'), author: time('author') };
  const { medals, notes } = staggerMedals(raw);
  for (const n of notes) log(`  ${level.id}: Staffel ${n}`);
  if (!(medals.bronze > medals.silver && medals.silver > medals.gold && medals.gold > medals.velocity && medals.velocity >= medals.author))
    throw new Error(`${level.id}: Medaillen nicht streng fallend: ${JSON.stringify(medals)}`);
  const st = medalSteps(medals);
  const pct = (f: number): string => `${((f - 1) * 100).toFixed(1)} %`;
  log(`  ${level.id}: Abstände Bronze→Silber ${pct(st.bs)}, Silber→Gold ${pct(st.sg)}, Gold→VELOCITY ${pct(st.gv)}, VELOCITY→Autor ${pct(st.va)}`);
  if (st.bs > MEDAL_MAX_STEP) warn(`${level.id}: Bronze → Silber ${pct(st.bs)} > ${pct(MEDAL_MAX_STEP)} — Spieler zwischen 3°- und 2°-Hand ohne erreichbares Ziel`);
  if (st.sg > MEDAL_MAX_STEP) warn(`${level.id}: Silber → Gold ${pct(st.sg)} > ${pct(MEDAL_MAX_STEP)} — Spieler zwischen 2°- und 1°-Hand ohne erreichbares Ziel`);
  if (level.safeRoute) {
    // Die Gabel soll sich lohnen: VELOCITY nur über die schnelle Linie — auch mit der Referenz-Technik.
    const bot = jitterMedian(lines.safeRoute, { sync: 1 }).median;
    const refRuns = reference?.runs(lines.safeRoute, { sync: 1 }, 'safeRoute', true, MEDAL_SEEDS) ?? null;
    const ref = refRuns ? medianOf(refRuns.runs) : null;
    const s = bot === null ? ref : ref === null ? bot : Math.min(bot, ref);
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
