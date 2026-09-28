/**
 * Prototyp-Probe: Ist eine Gehrungs-Kurve (surfPath.ts) surfbar?
 *   npx tsx tools/critique/v2/level3/probeCurve.ts
 *
 * Testlevel: Startplatte → R1 gerade 1024 @10° → Drop → R2 Kurve (Winkel, Gefälle, Stücke
 * variiert) → Drop → R3 gerade 1024 @10° → Ziel-Trigger am Ende von R3. Gemessen je
 * Variante und Flanke (innen/außen): Grundtechnik-Surfer aus dem Stand (Blick −2/0/+2°),
 * RouteFollower (sync 1.0/0.8, Hand 2°/3°), Surf-Raster (6 Tempi × 6 Tiefen × 3 Blicke)
 * mit Nahtstopp-Erkennung, Tempo am Ziel.
 */
import { writeFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { RouteFollower } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { Frame, LevelBuilder } from '../../../levels/lib';
import { FollowerController, SURF_GRID, SurfRider, routeAxis, simulate, surfGrid } from '../../../levels/physics';
import { SurfPath, dropFrom } from './surfPath';

const cfg = VELOCITY_DEFAULT;
const ENV = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -9000,
};

interface Variant {
  readonly turn: number;
  readonly slope: number;
  readonly length: number;
  readonly pieces?: number;
}

function build(v: Variant, side: 1 | -1) {
  const L = new LevelBuilder({ id: 'probe', name: 'probe', killY: -8000, environment: ENV });
  const r1 = new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: 768, segs: [{ length: 1024, slopeDeg: 10 }], tag: 'r1' });
  const r2 = dropFrom(r1, { overlap: 96, drop: 128, segs: [{ length: 256, slopeDeg: v.slope }, { length: v.length, slopeDeg: v.slope, turnDeg: v.turn, pieces: v.pieces }, { length: 256, slopeDeg: v.slope }], tag: 'r2' });
  const r3 = dropFrom(r2, { overlap: 96, drop: 128, segs: [{ length: 1024, slopeDeg: 10 }], tag: 'r3' });
  for (const p of [r1, r2, r3]) L.add(...p.brushes);
  // Startplatte über dem Anfang von R1, Spawn auf der gewählten Seite.
  const f = new Frame(0, 0, 0);
  L.platform(f, [-320, 48], [-192, 192], 40, { mat: 'start' });
  L.spawn(f.p(-64, side * 56, 40), 0);
  L.startZone([-192, 40, 0], [192, 200, 320]);
  const depth = 320;
  L.node(f.p(-64, side * 56, 40), { note: 'start' });
  for (const s of [300, 700, 980]) L.node(r1.riderPos(s, side, depth), { surf: true });
  for (let s = 200; s < r2.length - 60; s += 300) L.node(r2.riderPos(s, side, depth), { surf: true });
  L.node(r2.riderPos(r2.length - 40, side, depth), { surf: true });
  for (const s of [200, 600, 1000]) L.node(r3.riderPos(s, side, depth), { surf: true });
  // Ziel: Scheibe quer über das Ende von R3.
  const e = r3.at(r3.length - 64);
  L.finishZone([e.x - 800, e.apex - 1400, e.z - 800], [e.x + 800, e.apex + 600, e.z + 800]);
  return { def: L.build(), r2 };
}

const variants: Variant[] = [
  { turn: 45, slope: 0, length: 1536 },
  { turn: 45, slope: 6, length: 1536 },
  { turn: 45, slope: 10, length: 1536 },
  { turn: 90, slope: 6, length: 2304 },
  { turn: 45, slope: 6, length: 1024 },
  { turn: -45, slope: 6, length: 1536 },
];

const lines: string[] = [];
const log = (s: string): void => {
  lines.push(s);
  console.log(s);
};

for (const v of variants) {
  for (const side of [-1, 1] as const) {
    const { def, r2 } = build(v, side);
    const lv = compileLevel(def);
    const inner = (v.turn > 0 && side === -1) || (v.turn < 0 && side === 1);
    const tag = `Kurve ${v.turn}° über ${v.length} u, Gefälle ${v.slope}°, ${inner ? 'Innenflanke' : 'Außenflanke'} (${side < 0 ? 'links' : 'rechts'}), Faltung ${r2.maxFold().toFixed(1)} u, Radius ${((v.length / (Math.abs(v.turn) * Math.PI / 180))).toFixed(0)}`;
    log(`\n${tag}`);
    const fin = lv.triggers.find((t) => t.kind === 'finish');
    if (!fin) throw new Error('kein Ziel');
    const axis = routeAxis(def.route ?? []);
    const surfer: string[] = [];
    for (const look of [-2, 0, 2]) {
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(lv.spawnPos);
      const res = simulate(lv, pm, new SurfRider(cfg, lv.world, axis, (look * Math.PI) / 180), { cfg, goal: fin.bounds, timeout: 30 });
      surfer.push(`${look}°: ${res.ok ? `${res.time.toFixed(2)} s, ${res.goalSpeed.toFixed(0)} u/s` : `${res.reason} @ ${res.end.toArray().map((n) => n.toFixed(0)).join(',')}`}${res.seam ? ' NAHT' : ''}`);
    }
    log(`  Surfer aus dem Stand: ${surfer.join(' | ')}`);
    const bots: string[] = [];
    for (const m of [{ sync: 1 }, { sync: 0.8 }, { aimNoiseDeg: 2 }, { aimNoiseDeg: 3 }]) {
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(lv.spawnPos);
      const bot = new RouteFollower(def.route ?? [], cfg, { ...m, seed: 11, killY: def.killY, world: lv.world, start: { x: lv.spawnPos.x, z: lv.spawnPos.z }, stallTimeout: 12 });
      const res = simulate(lv, pm, new FollowerController(bot), { cfg, goal: fin.bounds, timeout: 40, botStatus: () => bot.status });
      bots.push(`${JSON.stringify(m)}: ${res.ok ? `${res.time.toFixed(2)} s, ${res.goalSpeed.toFixed(0)} u/s, max ${res.maxSpeed.toFixed(0)}` : `${res.reason}`}${res.seam ? ' NAHT' : ''}`);
    }
    log(`  RouteFollower: ${bots.join(' | ')}`);
    for (const g of surfGrid(lv, { ...SURF_GRID, cfg })) {
      const fails = g.failures.slice(0, 3).map((f) => `${f.speed}/${f.lateral}/${f.lookDeg}° ${f.outcome.reason}`);
      log(`  Raster ab ${g.note}: ${g.runs - g.failures.length}/${g.runs} ok, ${g.seams.length} Nähte, Ziel ${g.goalSpeed[0].toFixed(0)}–${g.goalSpeed[1].toFixed(0)} u/s${fails.length ? ` — ${fails.join('; ')}` : ''}`);
    }
  }
}
writeFileSync('shots/v2/level3/probeCurve.txt', `${lines.join('\n')}\n`);
void Box3;
void Vector3;
