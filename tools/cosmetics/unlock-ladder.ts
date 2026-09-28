/**
 * Abnahme-Werkzeug (Plan 007 §7, Phase 3 I2): Freischalt-Leiter über Bot-Spielertypen — dieselben
 * Modelle, aus denen die Medaillen-Grenzen gemessen sind (level-design.md Regel 10). Nutzt die
 * ECHTE Tabelle (engine/Unlocks UNLOCKS, deriveUnlocks) samt Trainings-Anforderung
 * (TrainingProgressView: Grundlagen T1–T4, komplett T1–T8, je ★).
 *   npx tsx tools/cosmetics/unlock-ladder.ts            → shots/v2/kosmetik/unlock-ladder-core.json
 * Level ohne gebaute Medaillen (L3/L4 bis Phase 3) bekommen die SCHLECHTERE Medaille aus L1/L2
 * (Annahme wie im Prototyp tools/critique/v2/kosmetik/unlock-ladder.ts). Erwartung (Prototyp):
 * 2 → 3 → 7 → 8 → 9 → 9 → 14, jeder Spielertyp unter Top hat ein nächstes Ziel.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compileLevel } from '../../src/world/level/compileLevel';
import { UNLOCKS, deriveUnlocks } from '../../src/engine/Unlocks';
import type { MedalSource, UnlockId } from '../../src/engine/Unlocks';
import type { LessonStars, TrainingProgressView } from '../../src/engine/trainingTypes';
import type { LevelMedals, TrainingIndexEntry } from '../../src/world/level/LevelFormat';
import { medalFor } from '../../src/ui/medals';
import type { MedalId } from '../../src/ui/medals';
import { timedMedian } from '../levels/physics';
import type { StrafeModel } from '../levels/physics';
import { buildLevel1 } from '../levels/level1';
import { buildLevel2 } from '../levels/level2';

interface Arche {
  readonly name: string;
  readonly model: StrafeModel;
  /** Training ganz / nur Grundlagen / gar nicht. */
  readonly training: 'all' | 'basics' | 'none';
}

const ARCHES: readonly Arche[] = [
  { name: 'Einsteiger (3°-Hand, nur Grundlagen-Training)', model: { aimNoiseDeg: 3 }, training: 'basics' },
  { name: 'Solide (2.5°-Hand, Training komplett)', model: { aimNoiseDeg: 2.5 }, training: 'all' },
  { name: 'Ordentlich (2°-Hand)', model: { aimNoiseDeg: 2 }, training: 'all' },
  { name: 'Gut (1.5°-Hand)', model: { aimNoiseDeg: 1.5 }, training: 'all' },
  { name: 'Sehr gut (1°-Hand)', model: { aimNoiseDeg: 1 }, training: 'all' },
  { name: 'Elite (sync 0.95)', model: { sync: 0.95 }, training: 'all' },
  { name: 'Top (sync 1.0)', model: { sync: 1 }, training: 'all' },
];
const SEEDS = [1, 2, 3, 4];
const ORDER: readonly (MedalId | null)[] = ['velocity', 'gold', 'silver', 'bronze', null];

/** Trainings-Fortschritt als Sicht: 8 Lektionen, T1–T4 Grundlagen. */
function trainingView(done: 'all' | 'basics' | 'none'): TrainingProgressView {
  const lessons: TrainingIndexEntry[] = [];
  for (let i = 1; i <= 8; i++) lessons.push({ id: `t${i}`, name: `T${i}`, file: `t${i}.json`, lesson: i, short: `T${i}`, group: i <= 4 ? 'basics' : 'advanced' });
  const stars = (id: string): LessonStars => {
    const n = Number(id.slice(1));
    return done === 'all' || (done === 'basics' && n <= 4) ? 1 : 0;
  };
  return { stars, lessons: () => lessons };
}

const levels = [buildLevel1(), buildLevel2()];
const compiled = levels.map((l) => compileLevel(l));
// Medaillen stehen im gebauten Index (build.ts misst sie), nicht im LevelFile des Builders.
const index: unknown = JSON.parse(readFileSync('public/levels/index.json', 'utf8'));
const medals = new Map<string, LevelMedals>();
if (Array.isArray(index)) for (const e of index as { id: string; medals?: LevelMedals }[]) if (e.medals) medals.set(e.id, e.medals);

const rows: Record<string, unknown> = {};
const ladder: number[] = [];
for (const a of ARCHES) {
  const times = new Map<string, number | null>();
  const got: string[] = [];
  let worst: MedalId | null = 'velocity';
  compiled.forEach((c, i) => {
    const id = levels[i].id;
    const r = timedMedian(c, a.model, SEEDS);
    times.set(id, r.median);
    const m = medalFor(r.median, medals.get(id));
    got.push(`${id} ${r.median?.toFixed(2) ?? '–'} s → ${m ?? 'keine'}`);
    if (ORDER.indexOf(m) > ORDER.indexOf(worst)) worst = m;
  });
  // L3/L4 ohne Medaillen im Index: schlechtere Medaille aus L1/L2 (Zeit knapp unter deren Grenze).
  const fake: LevelMedals = { bronze: 40, silver: 30, gold: 20, velocity: 10, author: 9 };
  const src: MedalSource[] = [...levels.map((l) => ({ id: l.id, medals: medals.get(l.id) ?? null }))];
  for (const id of ['level3', 'level4']) {
    const real = medals.get(id);
    src.push({ id, medals: real ?? fake });
    if (!real) times.set(id, worst === null ? 50 : fake[worst] - 0.01);
  }
  const ids: UnlockId[] = deriveUnlocks(src, (id) => times.get(id) ?? null, trainingView(a.training));
  const next = UNLOCKS.find((u) => !ids.includes(u.id));
  rows[a.name] = {
    medals: got,
    'L3/L4 angenommen': medals.has('level3') ? 'echt' : (worst ?? 'keine'),
    count: ids.length,
    hands: ids.filter((id) => id.startsWith('glove.')).length,
    unlocked: ids.map((id) => UNLOCKS.find((u) => u.id === id)?.name ?? id),
    nextGoal: next ? next.name : '— alles',
  };
  ladder.push(ids.length);
  console.log(`${a.name}: ${ids.length} (${ids.join(', ')})`);
}
const monotone = ladder.every((n, i) => i === 0 || n >= ladder[i - 1]);
console.log(`Leiter ${ladder.join(' → ')} · monoton ${monotone}`);
mkdirSync('shots/v2/kosmetik', { recursive: true });
writeFileSync('shots/v2/kosmetik/unlock-ladder-core.json', JSON.stringify({ ladder, monotone, rows }, null, 2));
