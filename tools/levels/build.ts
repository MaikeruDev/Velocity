/**
 * `npm run levels:build`: tools/levels/level*.ts → public/levels/*.json + index.json.
 * sandbox.json bleibt unangetastet und steht bewusst nicht im Index.
 */
import { writeFileSync } from 'node:fs';
import { compileLevel } from '../../src/world/level/compileLevel';
import type { LevelFile, LevelIndexEntry, LevelMedals } from '../../src/world/level/LevelFormat';
import { FULL_RUN_SEEDS } from '../validate-levels';
import { buildLevel1 } from './level1';
import { buildLevel2 } from './level2';
import { timedMedian, type StrafeModel } from './physics';

const OUT = 'public/levels';

/** Medaillen: Bot-Modell und Aufschlag (LevelFormat.LevelMedals). */
const MEDAL_MODELS: Record<keyof LevelMedals, { readonly model: StrafeModel; readonly factor: number }> = {
  bronze: { model: { aimNoiseDeg: 3 }, factor: 1.05 },
  silver: { model: { aimNoiseDeg: 2 }, factor: 1.05 },
  gold: { model: { sync: 1 }, factor: 1.1 },
  // VELOCITY: halber Weg zwischen Gold und Autor. 1°/0.5°-Hand und sync 0.9/0.95 streuen
  // zu stark (L1-Median 25.8–27.6 s, langsamer als Gold), taugen also nicht als Maß —
  // die Ideallinie + 5 % ist die Zahl, die ein sehr guter Mensch mit sauberer Linie schafft
  // (level-design.md Regel 10, npx tsx tools/levels/medalProbe.ts).
  velocity: { model: { sync: 1 }, factor: 1.05 },
  author: { model: { sync: 1 }, factor: 1 },
};

/** Auf 0.1 s aufrunden (die Anzeige hat zwei Nachkommastellen, die Ziele sollen glatt sein). */
function up01(t: number): number {
  return Number((Math.ceil(t * 10 - 1e-6) / 10).toFixed(1));
}

/**
 * Par und Medaillen, gemessen wie der RunState-Timer (physics.timedRun: ab
 * Verlassen der Startzone, Tode inklusive), Median über die Seeds des Validators.
 * Par = Bronze auf ganze Sekunden — die Ansage für Gelegenheitsspieler (3°-Hand,
 * CS2-Parität). Früher Par ab Spawn und nur aus Läufen ohne Tod: ~1.3 s zu lasch,
 * und nach dem ersten Lauf gab es kein Ziel mehr (Level-Flow-Kritik).
 */
function withTimes(level: LevelFile): LevelFile {
  const c = compileLevel(level);
  const median = new Map<string, number>();
  const time = (key: keyof LevelMedals): number => {
    const { model, factor } = MEDAL_MODELS[key];
    const id = JSON.stringify(model);
    let m = median.get(id);
    if (m === undefined) {
      const r = timedMedian(c, model, FULL_RUN_SEEDS);
      if (r.median === null) throw new Error(`${level.id}: Bot ${id} kommt in der Mehrheit der Seeds nicht ins Ziel — keine Medaille ${key}`);
      m = r.median;
      median.set(id, m);
    }
    // Autor-Zeit auf 0.01 s (die Zahl, die man schlagen will), die anderen glatt auf 0.1 s.
    return key === 'author' ? Number((Math.ceil(m * 100 - 1e-6) / 100).toFixed(2)) : up01(factor * m);
  };
  const medals: LevelMedals = { bronze: time('bronze'), silver: time('silver'), gold: time('gold'), velocity: time('velocity'), author: time('author') };
  if (!(medals.bronze > medals.silver && medals.silver > medals.gold && medals.gold > medals.velocity && medals.velocity >= medals.author))
    throw new Error(`${level.id}: Medaillen nicht streng fallend: ${JSON.stringify(medals)}`);
  return { ...level, parTime: Math.ceil(medals.bronze), medals };
}

/**
 * JSON mit einer Zeile pro Brush/Trigger/Knoten: bleibt diff- und
 * handeditierbar, ohne dass Zahlen-Arrays über zig Zeilen laufen.
 */
function formatLevel(level: LevelFile): string {
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

function main(): void {
  const levels: Array<{ file: string; level: LevelFile }> = [
    { file: 'level1.json', level: withTimes(buildLevel1()) },
    { file: 'level2.json', level: withTimes(buildLevel2()) },
  ];
  const index: LevelIndexEntry[] = [];
  for (const { file, level } of levels) {
    writeFileSync(`${OUT}/${file}`, formatLevel(level));
    index.push({
      id: level.id,
      name: level.name,
      ...(level.subtitle ? { subtitle: level.subtitle } : {}),
      file,
      // Medaillen auch im Index: die Titel-Liste zeigt sie, ohne jedes Level zu laden.
      ...(level.medals ? { medals: level.medals } : {}),
    });
    console.log(`✓ ${OUT}/${file}: ${level.name} — ${level.brushes.length} Brushes, ${level.triggers.length} Trigger, ${level.route?.length ?? 0} Route-Knoten, Par ${level.parTime ?? '–'} s, Medaillen ${level.medals ? `${level.medals.bronze}/${level.medals.silver}/${level.medals.gold}/${level.medals.velocity}/${level.medals.author}` : '–'} s`);
  }
  writeFileSync(`${OUT}/index.json`, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`✓ ${OUT}/index.json: ${index.length} Level`);
}

main();
