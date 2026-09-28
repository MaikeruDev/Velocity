/**
 * PROTOTYP (Kosmetik v2): Freischalt-Schema für alle Kosmetik über Training + L1–L4 und
 * Prüfung der Motivations-Kurve an Bot-Modellen (dieselben Modelle, aus denen die Medaillen-
 * Grenzen gemessen sind — level-design.md Regel 10).
 *   npx tsx tools/critique/v2/kosmetik/unlock-ladder.ts
 * Ausgabe: shots/v2/kosmetik/unlock-ladder.json
 *
 * Neu gegenüber engine/Unlocks.ts: Anforderung als Union mit `kind` — 'medal' (wie bisher) und
 * 'finish' (Level einmal beendet = BestTimes-Eintrag; für die Trainings-Lektionen). "Sammelziele"
 * sind einfach Listen (alle Einträge nötig) — das kann `requires` schon.
 * L3/L4 gibt es noch nicht: für sie nimmt die Probe die SCHLECHTERE Medaille aus L1/L2 an.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { medalAtLeast, medalFor } from '../../../../src/ui/medals';
import type { MedalId } from '../../../../src/ui/medals';
import type { LevelMedals } from '../../../../src/world/level/LevelFormat';
import { timedMedian } from '../../../levels/physics';
import type { StrafeModel } from '../../../levels/physics';
import { buildLevel1 } from '../../../levels/level1';
import { buildLevel2 } from '../../../levels/level2';

export type UnlockRequirement = { readonly kind: 'medal'; readonly levelId: string; readonly medal: MedalId } | { readonly kind: 'finish'; readonly levelId: string };

export interface UnlockDefV2 {
  readonly id: string;
  readonly name: string;
  readonly slot: 'hand' | 'item';
  readonly requires: readonly UnlockRequirement[];
}

const med = (levelId: string, medal: MedalId): UnlockRequirement => ({ kind: 'medal', levelId, medal });
const fin = (levelId: string): UnlockRequirement => ({ kind: 'finish', levelId });
const MAIN = ['level1', 'level2', 'level3', 'level4'] as const;
/** Platzhalter — die Lektions-IDs legt das Trainings-Thema fest. */
const TRAINING_BASICS = ['training1', 'training2', 'training3'] as const;
const TRAINING_ALL = ['training1', 'training2', 'training3', 'training4', 'training5'] as const;

/** Reihenfolge = Anzeige im Admin-Menü und "späteres gewinnt" beim Sofort-Anlegen. */
export const UNLOCKS_V2: readonly UnlockDefV2[] = [
  { id: 'item.spinner', name: 'Fidget-Spinner', slot: 'item', requires: TRAINING_BASICS.map(fin) },
  { id: 'glove.robot', name: 'Roboter-Hand', slot: 'hand', requires: TRAINING_ALL.map(fin) },
  { id: 'item.coin', name: 'Münze', slot: 'item', requires: MAIN.map((l) => med(l, 'bronze')) },
  { id: 'item.yoyo', name: 'Jo-Jo', slot: 'item', requires: [med('level1', 'silver')] },
  { id: 'item.lighter', name: 'Sturmfeuerzeug', slot: 'item', requires: [med('level2', 'silver')] },
  { id: 'item.kendama', name: 'Kendama', slot: 'item', requires: [med('level3', 'silver')] },
  { id: 'item.phone', name: 'Handy', slot: 'item', requires: [med('level4', 'silver')] },
  { id: 'glove.skeleton', name: 'Skelett-Hand', slot: 'hand', requires: [med('level2', 'gold')] },
  { id: 'glove.neon', name: 'Neon-Handschuh', slot: 'hand', requires: [med('level1', 'gold')] },
  { id: 'glove.gold', name: 'Gold-Handschuh', slot: 'hand', requires: MAIN.map((l) => med(l, 'gold')) },
  { id: 'item.card', name: 'Sammelkarte', slot: 'item', requires: [med('level1', 'velocity')] },
  { id: 'item.can', name: 'Dose', slot: 'item', requires: [med('level2', 'velocity')] },
  { id: 'item.knife', name: 'Butterfly-Messer', slot: 'item', requires: [med('level1', 'velocity'), med('level2', 'velocity')] },
  { id: 'glove.cat', name: 'Katzenpfote', slot: 'hand', requires: MAIN.map((l) => med(l, 'velocity')) },
];

/** Ableitung wie engine/Unlocks.deriveUnlocks, mit 'finish'. */
export function deriveV2(medalsOf: (id: string) => LevelMedals | null, best: (id: string) => number | null): string[] {
  return UNLOCKS_V2.filter((u) =>
    u.requires.every((r) => {
      if (r.kind === 'finish') return best(r.levelId) !== null;
      const m = medalsOf(r.levelId);
      return m ? medalAtLeast(medalFor(best(r.levelId), m), r.medal) : false;
    }),
  ).map((u) => u.id);
}

/** Fortschritt eines Sammelziels für das Menü: "Gold 2/4". */
export function progressOf(u: UnlockDefV2, ok: (r: UnlockRequirement) => boolean): string | null {
  if (u.requires.length < 2) return null;
  const n = u.requires.filter(ok).length;
  return `${n}/${u.requires.length}`;
}

// ---------------------------------------------------------------- Probe
interface Arche {
  readonly name: string;
  readonly model: StrafeModel;
  /** Hat das Training ganz / nur die Grundlagen / gar nicht gemacht. */
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

const levels = [buildLevel1(), buildLevel2()];
const compiled = levels.map((l) => compileLevel(l));
const medalsByLevel = new Map<string, LevelMedals>();
// Medaillen stehen erst im gebauten Index (build.ts misst sie), nicht im LevelFile des Builders.
const index: unknown = JSON.parse(readFileSync('public/levels/index.json', 'utf8'));
if (Array.isArray(index)) {
  for (const e of index as { id: string; medals?: LevelMedals }[]) if (e.medals) medalsByLevel.set(e.id, e.medals);
}
const out: Record<string, unknown> = { table: UNLOCKS_V2.map((u) => `${u.name}: ${u.requires.map((r) => (r.kind === 'finish' ? `fertig ${r.levelId}` : `${r.medal} ${r.levelId}`)).join(' + ')}`) };
const rows: Record<string, unknown> = {};
let prev = 0;
for (const a of ARCHES) {
  const times = new Map<string, number | null>();
  const medals: string[] = [];
  let worst: MedalId | null = 'velocity';
  const order: readonly (MedalId | null)[] = ['velocity', 'gold', 'silver', 'bronze', null];
  compiled.forEach((c, i) => {
    const r = timedMedian(c, a.model, SEEDS);
    const id = levels[i].id;
    times.set(id, r.median);
    const m = medalFor(r.median, medalsByLevel.get(id));
    medals.push(`${id} ${r.median?.toFixed(2) ?? '–'} s → ${m ?? 'keine'}`);
    if (order.indexOf(m) > order.indexOf(worst)) worst = m;
  });
  // L3/L4: schlechtere Medaille aus L1/L2 als Zeit knapp unter deren Grenze.
  const fake: LevelMedals = { bronze: 40, silver: 30, gold: 20, velocity: 10, author: 9 };
  for (const id of ['level3', 'level4']) {
    medalsByLevel.set(id, fake);
    times.set(id, worst === null ? 50 : fake[worst] - 0.01);
  }
  const train = a.training === 'all' ? TRAINING_ALL : a.training === 'basics' ? TRAINING_BASICS : [];
  for (const t of train) times.set(t, 60);
  const got = deriveV2(
    (id) => medalsByLevel.get(id) ?? null,
    (id) => times.get(id) ?? null,
  );
  const names = got.map((id) => UNLOCKS_V2.find((u) => u.id === id)?.name ?? id);
  const next = UNLOCKS_V2.filter((u) => !got.includes(u.id))[0];
  rows[a.name] = {
    medals,
    'L3/L4 angenommen': worst ?? 'keine',
    count: got.length,
    new: got.length - prev,
    hands: got.filter((id) => id.startsWith('glove.')).length,
    unlocked: names,
    nextGoal: next ? next.name : '— alles',
  };
  prev = got.length;
}
out.ladder = rows;
mkdirSync('shots/v2/kosmetik', { recursive: true });
writeFileSync('shots/v2/kosmetik/unlock-ladder.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
