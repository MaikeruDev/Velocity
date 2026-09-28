/**
 * Nahtdiagnose mit Bump-Protokoll (Kopie von PlayerMovement, Fix per PMFIX schaltbar).
 *   PMFIX=0 npx tsx tools/critique/v2/level3/pmFix/seamTrace.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../../src/player/MovementConfig';
import { compileLevel } from '../../../../../src/world/level/compileLevel';
import { LevelBuilder } from '../../../../levels/lib';
import { SurfRider, routeAxis } from '../../../../levels/physics';
import { SurfPath } from '../surfPath';
import { PM_DEBUG, PlayerMovement } from './PlayerMovementFix';

const cfg = VELOCITY_DEFAULT;
const ENV = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -9000,
};
const pieces = Number(process.env.PIECES ?? 24);
const L = new LevelBuilder({ id: 'd', name: 'd', killY: -8000, environment: ENV });
const r = new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: 768, segs: [{ length: 512, slopeDeg: 6 }, { length: 1536, slopeDeg: 6, turnDeg: 45, pieces }, { length: 768, slopeDeg: 6 }], tag: 'c' });
L.add(...r.brushes);
L.spawn([0, 100, 0], 0);
for (let s = 100; s < r.length; s += 150) L.node(r.riderPos(s, -1, 320), { surf: true });
const def = L.build();
const lv = compileLevel(def);
const axis = routeAxis(def.route ?? []);
let shown = 0;
let seams = 0;
for (const depth of [80, 160, 240, 320, 400, 480]) {
  for (const v0 of [400, 700, 1000]) {
    const p = r.riderPos(200, -1, depth);
    const pm = new PlayerMovement(lv.world, cfg);
    pm.teleport(new Vector3(p[0], p[1] + 2, p[2]));
    pm.state.vel.set(0, 0, -v0);
    const rider = new SurfRider(cfg, lv.world, axis, 0);
    let prev = v0;
    let prevSurf = false;
    for (let t = 0; t < 128 * 5; t++) {
      PM_DEBUG.log = [];
      PM_DEBUG.on = true;
      pm.tick(rider.next(pm.state, pm.surfNormal));
      PM_DEBUG.on = false;
      const s = pm.state;
      const sp = s.vel.length();
      if (prevSurf && !s.onGround && prev > 250 && sp < 0.5 * prev) {
        seams++;
        if (shown < 4) {
          shown++;
          console.log(`\nNaht depth ${depth} v0 ${v0} tick ${t}: ${prev.toFixed(0)} → ${sp.toFixed(0)} bei ${s.pos.toArray().map((q) => q.toFixed(1)).join(',')}`);
          for (const l of PM_DEBUG.log) console.log(`   ${l}`);
          console.log(`   Brushes: ${[...new Set(PM_DEBUG.log.map((l) => /brush=(-?\d+)/.exec(l)?.[1]).filter(Boolean))].map((i) => `${i}=${lv.brushes[Number(i)]?.tag}`).join(' ')}`);
        }
      }
      prev = sp;
      prevSurf = s.surfing;
      if (s.pos.y < -4000) break;
    }
  }
}
console.log(`\n${seams} Nähte (PMFIX=${process.env.PMFIX ?? '1'}, ${pieces} Stücke)`);
