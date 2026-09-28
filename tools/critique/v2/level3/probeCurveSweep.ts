/**
 * Sweep: Nahtstopps an Gehrungs-Kurven in Abhängigkeit von Knick pro Fuge und Gefälle.
 *   npx tsx tools/critique/v2/level3/probeCurveSweep.ts
 * Raster wie der Validator (6 Tempi × Tiefen × Blick) direkt auf der Kurve, beide Flanken.
 */
import { writeFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { LevelBuilder } from '../../../levels/lib';
import { SurfRider, routeAxis, simulate } from '../../../levels/physics';
import { SurfPath } from './surfPath';

const cfg = VELOCITY_DEFAULT;
const ENV = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -9000,
};
const out: string[] = [];
const turn = Number(process.env.TURN ?? 45);
const arc = Number(process.env.ARC ?? 1536);
for (const slope of [0, 6, 10]) {
  for (const pieces of [2, 3, 4, 6, 12, 24]) {
    for (const side of [-1, 1] as const) {
      const L = new LevelBuilder({ id: 'd', name: 'd', killY: -8000, environment: ENV });
      const r = new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: 768, segs: [{ length: 512, slopeDeg: slope }, { length: arc, slopeDeg: slope, turnDeg: turn, pieces }, { length: 768, slopeDeg: slope }], tag: 'c' });
      L.add(...r.brushes);
      L.spawn([0, 100, 0], 0);
      for (let s = 100; s < r.length; s += 150) L.node(r.riderPos(s, side, 320), { surf: true });
      const def = L.build();
      const lv = compileLevel(def);
      const axis = routeAxis(def.route ?? []);
      const e = r.at(r.length - 100);
      const goal = new Box3(new Vector3(e.x - 700, e.apex - 2000, e.z - 700), new Vector3(e.x + 700, e.apex + 400, e.z + 700));
      let seams = 0;
      let ok = 0;
      let runs = 0;
      let lossSum = 0;
      let lossN = 0;
      for (const depth of [80, 160, 240, 320, 400, 480]) {
        for (const v0 of [400, 550, 700, 850, 1000, 1400]) {
          for (const look of [-2, 0, 2]) {
            const p = r.riderPos(200, side, depth);
            const pm = new PlayerMovement(lv.world, cfg);
            pm.teleport(new Vector3(p[0], p[1] + 2, p[2]));
            pm.state.vel.set(0, 0, -v0);
            const res = simulate(lv, pm, new SurfRider(cfg, lv.world, axis, (look * Math.PI) / 180), { cfg, goal, timeout: 12 });
            runs++;
            if (res.seam) seams++;
            if (res.ok) {
              ok++;
              // Energie-Bilanz: erwartetes Tempo aus Höhe gegen gemessenes (Verlust durch Knicke + Druck).
              const drop = p[1] - res.end.y;
              const ideal = Math.sqrt(v0 * v0 + 2 * cfg.gravity * Math.max(0, drop));
              lossSum += 1 - Math.hypot(res.goalSpeed, 0) / ideal;
              lossN++;
            }
          }
        }
      }
      const inner = (turn > 0 && side < 0) || (turn < 0 && side > 0);
      const line = `turn ${turn}° arc ${arc} slope ${slope}° pieces ${pieces} (Knick ${(turn / pieces).toFixed(1)}°) ${inner ? 'innen' : 'außen'}: ${ok}/${runs} ok, ${seams} Nähte, Fold ${r.maxFold().toFixed(1)} u, mittlerer Energieverlust ${lossN ? ((100 * lossSum) / lossN).toFixed(0) : '–'} %`;
      out.push(line);
      console.log(line);
    }
  }
}
writeFileSync(`shots/v2/level3/probeCurveSweep-${turn}-${arc}${process.env.PMFIX && process.env.PMFIX !== "0" ? "-fix" : ""}.txt`, `${out.join('\n')}\n`);
