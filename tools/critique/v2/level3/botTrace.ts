/**
 * Bot-Spur im Level-3-Prototyp: RouteFollower ab Start (oder CP) mit Position, Tempo, Fläche darunter.
 *   PMFIX=retrace node --import tsx --import ./tools/critique/v2/level3/pmFix/hook.mjs tools/critique/v2/level3/botTrace.ts <safe|fast> <sync|hand> <wert> [seed] [cp]
 */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../../src/world/level/LevelFormat';
import { resumeIndex } from '../../../levels/physics';

const [variant = 'safe', kind = 'sync', val = '1', seedS = '1', cpS = '0'] = process.argv.slice(2);
const def = JSON.parse(readFileSync(`shots/v2/level3/level3-${variant}.json`, 'utf8')) as LevelFile;
const lv = compileLevel(def);
const cfg = VELOCITY_DEFAULT;
const route = def.route ?? [];
const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
const cp = Number(cpS);
const startPos = cp > 0 ? cps[cp - 1].spawnPos : lv.spawnPos;
const from = cp > 0 ? resumeIndex(route, cps[cp - 1]) : 0;
const pm = new PlayerMovement(lv.world, cfg);
pm.teleport(new Vector3(startPos.x, startPos.y + 1, startPos.z));
const model = kind === 'sync' ? { sync: Number(val) } : { aimNoiseDeg: Number(val) };
const bot = new RouteFollower(route.slice(from), cfg, { ...model, seed: Number(seedS), killY: def.killY, world: lv.world, start: { x: startPos.x, z: startPos.z }, stallTimeout: 12 });
const MINS = new Vector3(-16, 0, -16);
const MAXS = new Vector3(16, 72, 16);
const kills = lv.triggers.filter((t) => t.kind === 'kill');
let last = '';
for (let t = 0; t < 128 * 60; t++) {
  pm.tick(bot.next(pm.state, pm.surfNormal));
  const s = pm.state;
  const d = lv.world.traceBox(new Vector3(s.pos.x, s.pos.y + 2, s.pos.z), new Vector3(s.pos.x, s.pos.y - 2000, s.pos.z), MINS, MAXS);
  const under = d.fraction < 1 ? `${lv.brushes[d.brushIndex]?.tag ?? '?'}(${(s.pos.y - d.endPos.y).toFixed(0)} tief)` : '-';
  const tagOnly = under.split('(')[0];
  if (tagOnly !== last || t % 64 === 0) {
    console.log(`t ${(t / 128).toFixed(2)} pos ${s.pos.toArray().map((q) => q.toFixed(0)).join(',')} v ${s.speed.toFixed(0)} ${s.onGround ? 'BODEN' : s.surfing ? 'surf' : 'luft'} über ${under} Knoten ${from + bot.report.reached}/${route.length} ${route[from + bot.report.reached]?.note ?? ''}`);
    last = tagOnly;
  }
  if (kills.some((k) => k.bounds.containsPoint(s.pos)) || s.pos.y < def.killY) {
    console.log(`TOT t ${(t / 128).toFixed(2)} bei ${s.pos.toArray().map((q) => q.toFixed(0)).join(',')}`);
    break;
  }
  if (bot.status !== 'running') {
    console.log(`Bot ${bot.status} ${bot.report.reason ?? ''} t ${(t / 128).toFixed(2)}`);
    break;
  }
}
