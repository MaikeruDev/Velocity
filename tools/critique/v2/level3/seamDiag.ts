/**
 * Diagnose: Wo und mit welcher Normale entstehen die Nahtstopps an der Innenflanke
 * einer Gehrungs-Kurve? Und hilft eine Überlappung (Folgestück beginnt `back` u früher)?
 *   npx tsx tools/critique/v2/level3/seamDiag.ts
 */
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { LevelBuilder } from '../../../levels/lib';
import { SurfRider, routeAxis, simulate, type Controller } from '../../../levels/physics';
import { SurfPath } from './surfPath';

const cfg = VELOCITY_DEFAULT;
const ENV = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -9000,
};

const L = new LevelBuilder({ id: 'd', name: 'd', killY: -8000, environment: ENV });
const r = new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: 768, segs: [{ length: 512, slopeDeg: 6 }, { length: 1536, slopeDeg: 6, turnDeg: 45 }, { length: 512, slopeDeg: 6 }], tag: 'c' });
L.add(...r.brushes);
L.spawn([0, 100, 0], 0);
for (let s = 100; s < r.length; s += 200) L.node(r.riderPos(s, -1, 320), { surf: true });
const def = L.build();
const lv = compileLevel(def);
const axis = routeAxis(def.route ?? []);
const never = { min: new Vector3(1e9, 1e9, 1e9), max: new Vector3(1e9 + 1, 1e9 + 1, 1e9 + 1) };
let seams = 0;
let runs = 0;
for (const depth of [120, 200, 320, 420, 520]) {
  for (const v0 of [400, 700, 1000, 1400]) {
    for (const look of [-2, 0, 2]) {
      const p = r.riderPos(200, -1, depth);
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(new Vector3(p[0], p[1] + 2, p[2]));
      pm.state.vel.set(0, 0, -v0);
      const rider = new SurfRider(cfg, lv.world, axis, (look * Math.PI) / 180);
      let prev = v0;
      let prevSurf = false;
      const ctl: Controller = {
        next: (s, n) => {
          const sp = s.vel.length();
          if (prevSurf && !s.onGround && prev > 250 && sp < 0.5 * prev) {
            // Welche Fuge? Nächste Gelenkstelle entlang der Bogenlänge.
            let best = Infinity;
            let bj = -1;
            r.joints.forEach((j, k) => {
              const d = Math.hypot(j.x - s.pos.x, j.z - s.pos.z);
              if (d < best) {
                best = d;
                bj = k;
              }
            });
            seams++;
            if (seams <= 12) console.log(`Naht depth ${depth} v0 ${v0} look ${look}: pos ${s.pos.toArray().map((q) => q.toFixed(0)).join(',')} ${prev.toFixed(0)}→${sp.toFixed(0)}, nächste Fuge #${bj} (${best.toFixed(0)} u horizontal), Normale ${n.toArray().map((q) => q.toFixed(2)).join(',')}`);
          }
          prev = sp;
          prevSurf = s.surfing;
          return rider.next(s, n);
        },
      };
      simulate(lv, pm, ctl, { cfg, goal: new Box3(never.min, never.max), timeout: 6 });
      runs++;
    }
  }
}
console.log(`${seams} Nähte in ${runs} Läufen`);
