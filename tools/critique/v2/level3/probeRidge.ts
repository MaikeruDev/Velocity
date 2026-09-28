/**
 * Probe: Kann der RouteFollower (und wie leicht ein Mensch) auf einer geraden Surf-Rampe über den Grat
 * auf die andere Flanke wechseln ("Gratsprung")? Und die Alternative: Gabel-Drop auf einen Grat unter der Linie.
 *   npx tsx tools/critique/v2/level3/probeRidge.ts
 */
import { writeFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { Frame, LevelBuilder } from '../../../levels/lib';
import { FollowerController, simulate } from '../../../levels/physics';
import { SurfPath, dropFrom } from './surfPath';

const cfg = VELOCITY_DEFAULT;
const ENV = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -9000,
};
const out: string[] = [];
const log = (s: string): void => {
  out.push(s);
  console.log(s);
};

// A) Gratsprung auf einer langen geraden Rampe: Knoten erst links, ab s = 1200 rechts.
for (const depth of [120, 220, 320]) {
  const L = new LevelBuilder({ id: 'r', name: 'r', killY: -8000, environment: ENV });
  const a = new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: 768, segs: [{ length: 3000, slopeDeg: 10 }], tag: 'a' });
  L.add(...a.brushes);
  const f = new Frame(0, 0, 0);
  L.platform(f, [-320, 48], [-192, 192], 40, { mat: 'start' });
  L.spawn(f.p(-64, -56, 40), 0);
  L.node(f.p(-64, -56, 40), {});
  for (const s of [300, 700, 1100]) L.node(a.riderPos(s, -1, 320), { surf: true });
  for (const s of [1400, 1800, 2200, 2600, 2940]) L.node(a.riderPos(s, 1, depth), { surf: true });
  const def = L.build();
  const lv = compileLevel(def);
  const e = a.at(2900);
  const goalRight = new Box3(new Vector3(e.x + 16, e.apex - 700, e.z - 100), new Vector3(e.x + 500, e.apex + 100, e.z + 100));
  const res: string[] = [];
  for (const m of [{ sync: 1 }, { sync: 0.8 }, { aimNoiseDeg: 2 }, { aimNoiseDeg: 3 }]) {
    let ok = 0;
    for (const seed of [1, 2, 3, 4]) {
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(lv.spawnPos);
      const bot = new RouteFollower(def.route ?? [], cfg, { ...m, seed, killY: def.killY, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z }, stallTimeout: 12 });
      const r = simulate(lv, pm, new FollowerController(bot), { cfg, goal: goalRight, timeout: 20, botStatus: () => bot.status });
      if (r.ok) ok++;
    }
    res.push(`${JSON.stringify(m)} ${ok}/4`);
  }
  log(`Gratsprung (Ziellinie rechts, Tiefe ${depth}): ${res.join(' | ')}`);
}

// B) Gabel-Drop: Folgerampe mit dem Grat UNTER der Linie (seitlich versetzt), Drop variiert.
for (const drop of [256, 384, 448, 512]) {
  const L = new LevelBuilder({ id: 'g', name: 'g', killY: -8000, environment: ENV });
  const a = new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: 768, segs: [{ length: 1500, slopeDeg: 10 }], tag: 'a' });
  const lateral = -(320 / Math.tan((60 * Math.PI) / 180) + 16);
  const b = dropFrom(a, { overlap: 96, drop, lateral, segs: [{ length: 1500, slopeDeg: 10 }], tag: 'b' });
  L.add(...a.brushes, ...b.brushes);
  const f = new Frame(0, 0, 0);
  L.platform(f, [-320, 48], [-192, 192], 40, { mat: 'start' });
  L.spawn(f.p(-64, -56, 40), 0);
  L.node(f.p(-64, -56, 40), {});
  for (const s of [300, 700, 1100, 1460]) L.node(a.riderPos(s, -1, 320), { surf: true });
  const def0 = L.build();
  const res: string[] = [];
  for (const side of [-1, 1] as const) {
    const route = [...(def0.route ?? []), ...[300, 700, 1100, 1440].map((s) => ({ pos: b.riderPos(s, side, 320) as unknown as readonly [number, number, number], surf: true }))];
    const def = { ...def0, route };
    const lv = compileLevel(def);
    const e = b.at(1400);
    const fb = b.frameAt(1400);
    const [gx, gz] = fb.xz(0, side * 250);
    const goal = new Box3(new Vector3(gx - 230, e.apex - 700, gz - 100), new Vector3(gx + 230, e.apex + 50, gz + 100));
    let ok = 0;
    let n = 0;
    for (const m of [{ sync: 1 }, { sync: 0.8 }, { aimNoiseDeg: 2 }, { aimNoiseDeg: 3 }]) {
      for (const seed of [1, 2, 3]) {
        const pm = new PlayerMovement(lv.world, cfg);
        pm.teleport(lv.spawnPos);
        const bot = new RouteFollower(route, cfg, { ...m, seed, killY: def.killY, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z }, stallTimeout: 12 });
        const r = simulate(lv, pm, new FollowerController(bot), { cfg, goal, timeout: 20, botStatus: () => bot.status });
        n++;
        if (r.ok && !r.seam) ok++;
      }
    }
    res.push(`${side < 0 ? 'links' : 'rechts'} ${ok}/${n}`);
  }
  log(`Gabel-Drop ${drop} u auf einen Grat unter der Linie: ${res.join(' | ')}`);
}
writeFileSync('shots/v2/level3/probeRidge.txt', `${out.join('\n')}\n`);
