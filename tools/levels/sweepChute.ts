/**
 * Mess-Sweep für die Surf-Rutsche in Level 1 (Plan 003, L8): baut level1 mit
 * den Umgebungsvariablen CHUTE (Stücke als JSON), CHUTE_LINE, CHUTE_DIVE und
 * fährt die Bots darüber — Tempo am Launch, Höchsttempo, Zielzeit.
 *
 *   CHUTE='[{"length":1600,"slopeDeg":10},{"length":256,"slopeDeg":3},{"length":256,"slopeDeg":-8}]' npx tsx tools/levels/sweepChute.ts
 */
import { VELOCITY_DEFAULT } from '../../src/player/MovementConfig';
import { runRoute } from '../../src/player/bots';
import { compileLevel } from '../../src/world/level/compileLevel';
import { buildLevel1 } from './level1';

const level = compileLevel(buildLevel1());
const route = level.def.route ?? [];
const launchIdx = route.findIndex((n) => n.note === 'Launch');
const fmt = (n: number): string => n.toFixed(0);
const models: Array<{ name: string; sync?: number; aimNoiseDeg?: number; seeds: number[] }> = [
  { name: 'sync 1.0', sync: 1, seeds: [1] },
  { name: 'sync 0.8', sync: 0.8, seeds: [1, 2, 3, 4] },
  { name: 'Hand 2°', aimNoiseDeg: 2, seeds: [1, 2, 3, 4] },
  { name: 'Hand 3°', aimNoiseDeg: 3, seeds: [1, 2, 3, 4] },
];
for (const m of models) {
  const cells: string[] = [];
  for (const seed of m.seeds) {
    const res = runRoute(level, VELOCITY_DEFAULT, { sync: m.sync, aimNoiseDeg: m.aimNoiseDeg, seed });
    const atLaunch = res.nodes.find((r) => r.index === launchIdx);
    cells.push(`${res.touchedFinish ? (Math.round(res.time * 10) / 10).toFixed(1) : 'x'}s max ${fmt(res.maxSpeed)} launch ${atLaunch ? fmt(atLaunch.speed) : '-'}`);
  }
  console.log(`${m.name.padEnd(9)} ${cells.join(' | ')}`);
}
