/**
 * Diagnose einzelner Surf-Raster-Fälle im Level-3-Prototyp (mit Bump-Protokoll bei Nahtstopps).
 *   PMFIX=retrace node --import tsx --import ./tools/critique/v2/level3/pmFix/hook.mjs tools/critique/v2/level3/gridDiag.ts <safe|fast> <tag> <speed> <lateral> <look>
 */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../../src/world/level/LevelFormat';
import { SurfRider, flankTag, routeAxis } from '../../../levels/physics';
import { PM_DEBUG, PlayerMovement } from './pmFix/PlayerMovementFix';

const [variant = 'fast', tag = 'forkFast', sp = '400', lat = '-30', lk = '-2'] = process.argv.slice(2);
const def = JSON.parse(readFileSync(`shots/v2/level3/level3-${variant}.json`, 'utf8')) as LevelFile;
const lv = compileLevel(def);
const route = def.route ?? [];
const i = route.findIndex((n) => n.surf && flankTag(lv, n).startsWith(tag));
if (i < 0) throw new Error(`kein Knoten auf ${tag}`);
const n = route[i];
const next = route[i + 1];
const cfg = VELOCITY_DEFAULT;
const p = new Vector3(...n.pos);
const MINS = new Vector3(-16, 0, -16);
const MAXS = new Vector3(16, 72, 16);
const tr0 = lv.world.traceBox(new Vector3(p.x, p.y + 8, p.z), new Vector3(p.x, p.y - 200, p.z), MINS, MAXS);
const out = new Vector3(tr0.normal.x, 0, tr0.normal.z).normalize();
const x = p.x + out.x * Number(lat);
const z = p.z + out.z * Number(lat);
const tr = lv.world.traceBox(new Vector3(x, p.y + 600, z), new Vector3(x, p.y - 1200, z), MINS, MAXS);
const start = new Vector3(x, tr.endPos.y + 2, z);
const dir = new Vector3(next.pos[0] - p.x, 0, next.pos[2] - p.z).normalize();
const pm = new PlayerMovement(lv.world, cfg);
pm.teleport(start);
pm.state.vel.set(dir.x * Number(sp), 0, dir.z * Number(sp));
const rider = new SurfRider(cfg, lv.world, routeAxis(route), (Number(lk) * Math.PI) / 180);
const cps = lv.triggers.filter((t) => t.kind === 'checkpoint');
let prev = pm.state.vel.length();
let prevSurf = false;
let lastTag = "";
const touched = new Set<number>();
for (let t = 0; t < 128 * 25; t++) {
  PM_DEBUG.log = [];
  PM_DEBUG.on = true;
  pm.tick(rider.next(pm.state, pm.surfNormal));
  PM_DEBUG.on = false;
  const s = pm.state;
  const v = s.vel.length();
  // Rampe unter dem Fahrer (Tag) — Wechsel protokollieren.
  const d = lv.world.traceBox(new Vector3(s.pos.x, s.pos.y + 2, s.pos.z), new Vector3(s.pos.x, s.pos.y - 900, s.pos.z), MINS, MAXS);
  const under = d.fraction < 1 ? lv.brushes[d.brushIndex]?.tag ?? '?' : '-';
  if (under !== lastTag) {
    console.log(`t ${(t / 128).toFixed(2)} über ${under} pos ${s.pos.toArray().map((q) => q.toFixed(0)).join(',')} v ${v.toFixed(0)} surfing ${s.surfing}`);
    lastTag = under;
  }
  if (prevSurf && !s.onGround && prev > 250 && v < 0.5 * prev) {
    console.log(`NAHT t ${(t / 128).toFixed(2)} ${prev.toFixed(0)}→${v.toFixed(0)} pos ${s.pos.toArray().map((q) => q.toFixed(1)).join(',')}`);
    for (const l of PM_DEBUG.log) console.log(`   ${l}`);
    console.log(`   ${[...new Set(PM_DEBUG.log.map((l) => /brush=(-?\d+)/.exec(l)?.[1]).filter(Boolean))].map((b) => `${b}=${lv.brushes[Number(b)]?.tag}`).join(' ')}`);
  }
  for (const c of cps) if (c.bounds.containsPoint(s.pos) && !touched.has(c.order)) { touched.add(c.order); console.log(`   CP${c.order} berührt t ${(t / 128).toFixed(2)}`); }
  prev = v;
  prevSurf = s.surfing;
  if (s.pos.y < def.killY) break;
}
