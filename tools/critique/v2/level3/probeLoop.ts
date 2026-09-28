/**
 * Sweep: 360°-Schleife (Halbrampe, Innenflanke, Bande) — Radius × Gefälle × Bande.
 *   PMFIX=retrace node --import tsx --import ./tools/critique/v2/level3/pmFix/hook.mjs tools/critique/v2/level3/probeLoop.ts
 * Grundtechnik-Surfer (Raster wie der Validator, ab der Einlauf-Rampe) und RouteFollower
 * (sync 1.0 / 0.8, Hand 3°) aus dem Stand vom Pad. Ausgabe shots/v2/level3/probeLoop*.txt.
 */
import { writeFileSync } from 'node:fs';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { Frame, LevelBuilder } from '../../../levels/lib';
import { FollowerController, SURF_GRID, simulate, surfGrid } from '../../../levels/physics';
import { SurfPath, dropFrom } from './surfPath';
import { localGrid, pathAxis } from './gridLocal';
import { Vector3 } from 'three';

const cfg = VELOCITY_DEFAULT;
const ENV = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -19000,
};
const DEG = Math.PI / 180;
const out: string[] = [];
const radii = (process.env.RADII ?? '1150,1500,2000,2500').split(',').map(Number);
const slopes = (process.env.SLOPES ?? '6,9,12').split(',').map(Number);
const rails = (process.env.RAILS ?? '0,96').split(',').map(Number);
const turn = Number(process.env.TURN ?? 360);
for (const R of radii) {
  for (const slope of slopes) {
    for (const rail of rails) {
      const L = new LevelBuilder({ id: 'loop', name: 'loop', killY: -18000, environment: ENV });
      const a = new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: 768, segs: [{ length: 1280, slopeDeg: 10 }], tag: 'in' });
      const arc = R * turn * DEG;
      const loop = dropFrom(a, { overlap: 96, drop: 128, half: 'left', segs: [{ length: 256, slopeDeg: slope }, { length: arc, slopeDeg: slope, turnDeg: turn, pieces: Math.round(turn / 3.75) }, { length: 320, slopeDeg: slope }], tag: 'loop', rail, railRange: [256, 256 + arc] });
      L.add(...a.brushes, ...loop.brushes);
      const f = new Frame(0, 0, 0);
      L.platform(f, [-320, 48], [-192, 192], 40, { mat: 'start' });
      L.spawn(f.p(-64, -56, 40), 0);
      L.startZone([-192, 40, 0], [192, 200, 320]);
      L.node(f.p(-64, -56, 40), {});
      for (const s of [300, 700, 1100, a.length - 40]) L.node(a.riderPos(s, -1, 320), { surf: true });
      for (let s = 200; s < loop.length - 60; s += 120) L.node(loop.riderPos(s, -1, 320), { surf: true });
      L.node(loop.riderPos(loop.length - 32, -1, 320), { surf: true });
      const e = loop.at(loop.length - 40);
      L.finishZone([e.x - 500, e.apex - 900, e.z - 60], [e.x + 500, e.apex + 300, e.z + 60]);
      const def = L.build();
      const lv = compileLevel(def);
      const fin = lv.triggers.find((t) => t.kind === 'finish');
      if (!fin) throw new Error('kein Ziel');
      let ok = 0;
      let runs = 0;
      let seams = 0;
      const fails = new Map<number, number>();
      let vmax = 0;
      for (const g of surfGrid(lv, { ...SURF_GRID, cfg })) {
        if (g.note !== 'in') continue;
        ok += g.runs - g.failures.length;
        runs += g.runs;
        seams += g.seams.length;
        for (const fl of g.failures) fails.set(fl.speed, (fails.get(fl.speed) ?? 0) + 1);
        if (process.env.DETAIL) for (const fl of g.failures) console.log(`   ✗ ${fl.speed}/${fl.lateral}/${fl.lookDeg}° ${fl.outcome.reason} t ${fl.outcome.time.toFixed(1)} bei ${fl.outcome.end.toArray().map((q) => q.toFixed(0)).join(',')}`);
        vmax = Math.max(vmax, g.goalSpeed[1]);
      }
      // Raster B: Blick entlang der echten Rampenrichtung (wie ein Mensch), gleiches Raster.
      const n0 = (def.route ?? [])[1];
      const n1 = (def.route ?? [])[2];
      const gB = localGrid(lv, new Vector3(...n0.pos), new Vector3(n1.pos[0] - n0.pos[0], 0, n1.pos[2] - n0.pos[2]).normalize(), fin.bounds, pathAxis([a, loop]), SURF_GRID, cfg, 40);
      if (process.env.DETAIL) for (const fl of gB.fails) console.log(`   B✗ ${fl.speed}/${fl.lateral}/${fl.look}° ${fl.out.reason} t ${fl.out.time.toFixed(1)} bei ${fl.out.end.toArray().map((q) => q.toFixed(0)).join(',')}`);
      const bots: string[] = [];
      for (const m of [{ sync: 1 }, { sync: 0.8 }, { aimNoiseDeg: 3 }]) {
        const pm = new PlayerMovement(lv.world, cfg);
        pm.teleport(lv.spawnPos);
        const bot = new RouteFollower(def.route ?? [], cfg, { ...m, seed: 11, killY: def.killY, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z }, stallTimeout: 12 });
        const res = simulate(lv, pm, new FollowerController(bot), { cfg, goal: fin.bounds, timeout: 60, botStatus: () => bot.status });
        bots.push(res.ok ? `${res.time.toFixed(1)}s/${res.goalSpeed.toFixed(0)}` : `✗${res.reason}`);
      }
      const vLimit = Math.sqrt(R * cfg.gravity * Math.tan(60 * DEG));
      const line = `R ${R} (${arc.toFixed(0)} u) ${slope}° Bande ${rail}: Raster(Route-Achse) ${ok}/${runs}, Raster(Rampen-Achse) ${gB.runs - gB.fails.length}/${gB.runs} (${seams}+${gB.seams} Nähte; Fehlschläge je Tempo ${[...fails].map(([k, v]) => `${k}:${v}`).join(' ') || '–'}), Ziel bis ${vmax.toFixed(0)} u/s, v_trag ${vLimit.toFixed(0)} | Bots ab Pad sync1/0.8/Hand3: ${bots.join(' ')}`;
      out.push(line);
      console.log(line);
    }
  }
}
writeFileSync(`shots/v2/level3/probeLoop-${turn}${process.env.PMFIX && process.env.PMFIX !== '0' ? '-fix' : ''}.txt`, `${out.join('\n')}\n`);
