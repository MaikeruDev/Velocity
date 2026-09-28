/**
 * Vorbeizieh-Whoosh offline messen: dieselbe Probe wie Game.probeNear (±160 u quer
 * zur Flugrichtung, Box ±4 u in Rumpfhöhe Füße +20…+56, alle 2 Ticks ab 200 u/s,
 * die Seite der eigenen Surf-Rampe ausgeblendet) entlang eines RouteFollower-Laufs.
 * Die Probe sieht nur Kollisions-Geometrie — Deko (collide:false) zählt nicht
 * (fallen.md #74).
 *
 *   npx tsx tools/levels/whoosh.ts [level=level1] [sync=1] [seed=11]
 *
 * Ausgabe: Anteil der Proben mit Geometrie < 160 u, je Abschnitt (Route-Notiz)
 * Treffer/Proben und kleinster Abstand.
 */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../src/player/MovementConfig';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { RouteFollower } from '../../src/player/bots';
import { makeTraceResult } from '../../src/world/collision/types';
import { compileLevel } from '../../src/world/level/compileLevel';

// Wie Game.ts (NEAR_*); bei Änderungen dort hier nachziehen.
const RANGE = 160;
const EVERY = 2;
const MIN_SPEED = 200;
const SURF_SIDE = 0.3;

const [lvId = 'level1', syncArg = '1', seedArg = '11'] = process.argv.slice(2);
const lv = compileLevel(JSON.parse(readFileSync(`public/levels/${lvId}.json`, 'utf8')));
const cfg = VELOCITY_DEFAULT;
const pm = new PlayerMovement(lv.world, cfg);
pm.teleport(lv.spawnPos);
const route = lv.def.route ?? [];
const bot = new RouteFollower(route, cfg, { sync: Number(syncArg), seed: Number(seedArg), killY: lv.def.killY, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z } });
const tr = makeTraceResult();
const mins = new Vector3(-4, 20, -4);
const maxs = new Vector3(4, 56, 4);
const end = new Vector3();
const fin = lv.triggers.find((t) => t.kind === 'finish');
const dist = (dx: number, dz: number): number => {
  const p = pm.state.pos;
  end.set(p.x + dx * RANGE, p.y, p.z + dz * RANGE);
  lv.world.traceBox(p, end, mins, maxs, tr);
  return tr.startSolid || tr.fraction >= 1 ? Infinity : tr.fraction * RANGE + 4;
};
let probes = 0;
let hits = 0;
const bySec = new Map<string, { probes: number; hits: number; min: number }>();
let sec = 'Start';
for (let t = 0; t < cfg.tickRate * 120 && bot.status === 'running'; t++) {
  pm.tick(bot.next(pm.state, pm.surfNormal));
  const s = pm.state;
  for (let k = Math.min(bot.nextIndex, route.length - 1); k >= 0; k--) {
    const note = route[k].note;
    if (note) {
      sec = note;
      break;
    }
  }
  if (fin?.bounds.containsPoint(s.pos)) break;
  if (t % EVERY || s.speed < MIN_SPEED) continue;
  const rx = -s.vel.z / s.speed;
  const rz = s.vel.x / s.speed;
  let r = dist(rx, rz);
  let l = dist(-rx, -rz);
  if (s.surfing) {
    const side = rx * pm.surfNormal.x + rz * pm.surfNormal.z;
    if (side < -SURF_SIDE) r = Infinity;
    else if (side > SURF_SIDE) l = Infinity;
  }
  const m = Math.min(l, r);
  probes++;
  let b = bySec.get(sec);
  if (!b) bySec.set(sec, (b = { probes: 0, hits: 0, min: Infinity }));
  b.probes++;
  if (m < RANGE) {
    hits++;
    b.hits++;
    b.min = Math.min(b.min, m);
  }
}
console.log(`${lvId} sync ${syncArg} Seed ${seedArg}: ${probes} Proben, ${hits} mit Geometrie < ${RANGE} u (${((100 * hits) / Math.max(1, probes)).toFixed(1)} %)`);
for (const [k, b] of bySec) console.log(`  ${k.padEnd(14)} ${String(b.hits).padStart(4)}/${String(b.probes).padEnd(5)} min ${Number.isFinite(b.min) ? b.min.toFixed(0) : '-'} u`);
