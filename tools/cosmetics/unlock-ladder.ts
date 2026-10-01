/**
 * Abnahme-Werkzeug (Plan 007 §7, Phase 3 I2): Freischalt-Leiter über Bot-Spielertypen — dieselben
 * Modelle, aus denen die Medaillen-Grenzen gemessen sind (level-design.md Regel 10). Nutzt die
 * ECHTE Tabelle (engine/Unlocks UNLOCKS, deriveUnlocks) samt Trainings-Anforderung
 * (TrainingProgressView: Grundlagen T1–T4, komplett T1–T8, je ★) und die GEBAUTEN Level L1–L4
 * (public/levels/*.json + Medaillen aus index.json, also nach `npm run levels:build`).
 *   npx tsx tools/cosmetics/unlock-ladder.ts [--seeds N]   → shots/v2/kosmetik/unlock-ladder-core.json
 * Level mit Gabel (safeRoute): der Spielertyp fährt die für ihn schnellere Linie (Median je Linie, das
 * kleinere) — so wählt ein Mensch, der beide kennt. Erwartung (Plan): monoton, jeder Spielertyp unter
 * sync 1.0 hat ein nächstes Ziel; Admin "Alles freischalten" = 14 (Test/Admin-Shots). Default = build.MEDAL_SEEDS (48),
 * dieselbe Stichprobe wie die Medaillen: mit 8 kippte die 1°-Hand auf L1 zwischen zwei Moden (22.05 ↔ 27.30 s) und die
 * Leiter war nicht monoton; mit 24 lag die 2°-Hand auf L3-Koralle bei 12.09 s (48 Seeds: 12.19 s) — unter VELOCITY.
 * Level mit Medaillen-Referenz (build.ts LEVELS[].reference, L3/L4: Surf-Grundtechnik): der Spielertyp surft wie die
 * Referenz mit SEINER Hand (physics.surfSigma), wenn das schneller ist — genau so misst build.ts die Grenzen (der
 * Einsteiger mit Blick 0° wie Bronze, alle anderen mit dem besten Blickversatz).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compileLevel } from '../../src/world/level/compileLevel';
import { UNLOCKS, deriveUnlocks } from '../../src/engine/Unlocks';
import type { MedalSource, UnlockId } from '../../src/engine/Unlocks';
import type { LessonStars, TrainingProgressView } from '../../src/engine/trainingTypes';
import type { LevelFile, LevelMedals, TrainingIndexEntry } from '../../src/world/level/LevelFormat';
import { medalFor } from '../../src/ui/medals';
import { LEVELS, MEDAL_SEEDS } from '../levels/build';
import { medianOf, timedMedian, withRoute } from '../levels/physics';
import type { StrafeModel, SurfLook } from '../levels/physics';

interface Arche {
  readonly name: string;
  readonly model: StrafeModel;
  /** Training ganz / nur Grundlagen / gar nicht. */
  readonly training: 'all' | 'basics' | 'none';
  /** Surf-Blick (wie build.ts: Bronze-Hand wie gelehrt, darüber der beste Versatz). */
  readonly look: SurfLook;
}

const ARCHES: readonly Arche[] = [
  { name: 'Einsteiger (3°-Hand, nur Grundlagen-Training)', model: { aimNoiseDeg: 3 }, training: 'basics', look: 'lesson' },
  { name: 'Solide (2.5°-Hand, Training komplett)', model: { aimNoiseDeg: 2.5 }, training: 'all', look: 'best' },
  { name: 'Ordentlich (2°-Hand)', model: { aimNoiseDeg: 2 }, training: 'all', look: 'best' },
  { name: 'Gut (1.5°-Hand)', model: { aimNoiseDeg: 1.5 }, training: 'all', look: 'best' },
  { name: 'Sehr gut (1°-Hand)', model: { aimNoiseDeg: 1 }, training: 'all', look: 'best' },
  { name: 'Elite (sync 0.95)', model: { sync: 0.95 }, training: 'all', look: 'best' },
  { name: 'Top (sync 1.0)', model: { sync: 1 }, training: 'all', look: 'best' },
];
const seedArg = process.argv.indexOf('--seeds');
const SEED_N = seedArg >= 0 ? Number(process.argv[seedArg + 1]) : MEDAL_SEEDS.length;
const SEEDS = Array.from({ length: SEED_N }, (_, i) => i + 1);
const LEVEL_IDS = ['level1', 'level2', 'level3', 'level4'];

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

// Medaillen aus dem gebauten Index (die Freischaltung im Spiel liest genau diese).
const index: unknown = JSON.parse(readFileSync('public/levels/index.json', 'utf8'));
const medals = new Map<string, LevelMedals>();
if (Array.isArray(index)) for (const e of index as { id: string; medals?: LevelMedals }[]) if (e.medals) medals.set(e.id, e.medals);
for (const id of LEVEL_IDS) if (!medals.has(id)) throw new Error(`${id}: keine Medaillen in public/levels/index.json — erst npm run levels:build`);
const levels = LEVEL_IDS.map((id) => {
  const def = JSON.parse(readFileSync(`public/levels/${id}.json`, 'utf8')) as LevelFile;
  const c = compileLevel(def);
  const entry = LEVELS.find((e) => e.id === id);
  return { id, c, safe: def.safeRoute ? withRoute(c, 'safeRoute') : null, ref: entry?.reference ? entry.reference() : null };
});
const src: MedalSource[] = LEVEL_IDS.map((id) => ({ id, medals: medals.get(id) ?? null }));

const rows: Record<string, unknown> = {};
const ladder: number[] = [];
const noNext: string[] = [];
for (const a of ARCHES) {
  const times = new Map<string, number | null>();
  const got: string[] = [];
  for (const lv of levels) {
    const r = timedMedian(lv.c, a.model, SEEDS).median;
    const s = lv.safe ? timedMedian(lv.safe, a.model, SEEDS).median : null;
    // Referenz je Linie mit derselben Hand (L3: Koralle/Türkis-Surfer, L4: Hybrid) — wie build.ts.
    const rr = lv.ref?.runs(lv.c, a.model, 'route', false, SEEDS, { look: a.look }) ?? null;
    const rs = lv.safe ? (lv.ref?.runs(lv.safe, a.model, 'safeRoute', false, SEEDS, { look: a.look }) ?? null) : null;
    // Schnellste Linie bzw. Technik (null = Mehrheit ohne Ziel).
    const cands = [r, s, rr ? medianOf(rr.runs) : null, rs ? medianOf(rs.runs) : null].filter((x): x is number => x !== null);
    const t = cands.length ? Math.min(...cands) : null;
    times.set(lv.id, t);
    const m = medalFor(t, medals.get(lv.id));
    const refT = [rr, rs].map((x) => (x ? medianOf(x.runs) : null)).filter((x): x is number => x !== null);
    const line =
      (lv.safe ? ` (route ${r?.toFixed(2) ?? '–'} / safe ${s?.toFixed(2) ?? '–'})` : '') +
      (refT.length ? ` [Referenz ${Math.min(...refT).toFixed(2)} gegen RouteFollower ${Math.min(...[r, s].filter((x): x is number => x !== null)).toFixed(2)}]` : '');
    got.push(`${lv.id} ${t?.toFixed(2) ?? '–'} s${line} → ${m ?? 'keine'}`);
  }
  const ids: UnlockId[] = deriveUnlocks(src, (id) => times.get(id) ?? null, trainingView(a.training));
  const next = UNLOCKS.find((u) => !ids.includes(u.id));
  if (!next && a.model.sync !== 1) noNext.push(a.name);
  rows[a.name] = {
    medals: got,
    count: ids.length,
    hands: ids.filter((id) => id.startsWith('glove.')).length,
    unlocked: ids.map((id) => UNLOCKS.find((u) => u.id === id)?.name ?? id),
    nextGoal: next ? next.name : '— alles',
  };
  ladder.push(ids.length);
  console.log(`${a.name}: ${ids.length} (${ids.join(', ')})`);
  for (const g of got) console.log(`    ${g}`);
  console.log(`    nächstes Ziel: ${next ? next.name : '— alles'}`);
}
const monotone = ladder.every((n, i) => i === 0 || n >= ladder[i - 1]);
console.log(`Leiter ${ladder.join(' → ')} · monoton ${monotone} · Seeds ${SEED_N}${noNext.length ? ` · OHNE nächstes Ziel: ${noNext.join(', ')}` : ''}`);
mkdirSync('shots/v2/kosmetik', { recursive: true });
writeFileSync('shots/v2/kosmetik/unlock-ladder-core.json', JSON.stringify({ seeds: SEED_N, ladder, monotone, noNext, rows }, null, 2));
if (!monotone || noNext.length) process.exit(1);
