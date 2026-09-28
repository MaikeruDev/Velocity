/**
 * Spur des Grundtechnik-Surfers ab einem Checkpoint-Spawn (wie validate: respawnSurf).
 *   PMFIX=retrace node --import tsx --import ./tools/critique/v2/level3/pmFix/hook.mjs tools/critique/v2/level3/surferTrace.ts <safe|fast> <cp> <lookDeg>
 */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../../src/world/level/LevelFormat';
import { SurfRider, routeAxis } from '../../../levels/physics';

const [variant = 'safe', cpS = '1', lookS = '0'] = process.argv.slice(2);
const def = JSON.parse(readFileSync(`shots/v2/level3/level3-${variant}.json`, 'utf8')) as LevelFile;
const lv = compileLevel(def);
const cfg = VELOCITY_DEFAULT;
const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
const cp = cps[Number(cpS) - 1];
const pm = new PlayerMovement(lv.world, cfg);
pm.teleport(cp.spawnPos);
const rider = new SurfRider(cfg, lv.world, routeAxis(def.route ?? []), (Number(lookS) * Math.PI) / 180);
const MINS = new Vector3(-16, 0, -16);
const MAXS = new Vector3(16, 72, 16);
const kills = lv.triggers.filter((t) => t.kind === 'kill');
let last = '';
for (let t = 0; t < 128 * 30; t++) {
  pm.tick(rider.next(pm.state, pm.surfNormal));
  const s = pm.state;
  const d = lv.world.traceBox(new Vector3(s.pos.x, s.pos.y + 2, s.pos.z), new Vector3(s.pos.x, s.pos.y - 2000, s.pos.z), MINS, MAXS);
  const tag = d.fraction < 1 ? lv.brushes[d.brushIndex]?.tag ?? '?' : '-';
  if (tag !== last || t % 64 === 0) {
    console.log(`t ${(t / 128).toFixed(2)} pos ${s.pos.toArray().map((q) => q.toFixed(0)).join(',')} v ${s.speed.toFixed(0)} vy ${s.vel.y.toFixed(0)} ${s.onGround ? 'BODEN' : s.surfing ? 'surf' : 'luft'} über ${tag} (${(s.pos.y - d.endPos.y).toFixed(0)})`);
    last = tag;
  }
  if (kills.some((k) => k.bounds.containsPoint(s.pos)) || s.pos.y < def.killY) {
    console.log(`TOT t ${(t / 128).toFixed(2)}`);
    break;
  }
}
