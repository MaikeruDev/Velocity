/** Level von der Platte für Replay-Werkzeuge (public/levels, index.json) — kompiliert wie im Spiel. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileLevel } from '../../src/world/level/compileLevel';
import type { CompiledLevel } from '../../src/world/level/compileLevel';
import type { LevelFile } from '../../src/world/level/LevelFormat';

const LEVEL_DIR = join(process.cwd(), 'public', 'levels');

export function loadLevelById(id: string): CompiledLevel {
  const index = JSON.parse(readFileSync(join(LEVEL_DIR, 'index.json'), 'utf8')) as { id: string; file: string }[];
  const entry = index.find((e) => e.id === id);
  const file = entry ? entry.file : `${id}.json`;
  return compileLevel(JSON.parse(readFileSync(join(LEVEL_DIR, file), 'utf8')) as LevelFile);
}
