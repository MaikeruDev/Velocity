/**
 * Lektionen des Trainingsmodus T1–T8 (Plan 007, Strang training-core).
 *
 * build.ts schreibt jede Lektion nach public/levels/training/<id>.json und die Liste nach
 * public/levels/training/index.json (TrainingIndexEntry aus LevelFile.training; Reihenfolge = diese
 * Liste). `npm run levels:build -- training` baut nur die Lektionen, `-- <id>` nur eine (ohne Index).
 * Lektionen tragen `training`, nie medals/parTime — build.ts misst keine Zeiten, der Validator prüft es.
 * Jede Lektion bringt ihre Bot-Matrix mit (check.ts, von levels:check gerufen).
 */
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import type { LessonEntry } from './lessonLib';
import { T1_CHECK, buildT1 } from './t1';
import { T2_CHECK, buildT2 } from './t2';
import { T3_CHECK, buildT3 } from './t3';
import { T4_CHECK, buildT4 } from './t4';
import { T5_CHECK, buildT5 } from './t5';
import { T6_CHECK, buildT6 } from './t6';
import { T7_CHECK, buildT7 } from './t7';
import { T8_CHECK, buildT8 } from './t8';

export const LESSONS: readonly LessonEntry[] = [
  { id: 't1', build: buildT1, check: T1_CHECK },
  { id: 't2', build: buildT2, check: T2_CHECK },
  { id: 't3', build: buildT3, check: T3_CHECK },
  { id: 't4', build: buildT4, check: T4_CHECK },
  { id: 't5', build: () => buildT5(), check: T5_CHECK },
  { id: 't6', build: buildT6, check: T6_CHECK },
  { id: 't7', build: buildT7, check: T7_CHECK },
  { id: 't8', build: buildT8, check: T8_CHECK },
];

export function buildTraining(): readonly LevelFile[] | null {
  return LESSONS.length ? LESSONS.map((e) => e.build()) : null;
}
