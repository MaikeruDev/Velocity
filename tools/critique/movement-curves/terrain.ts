/**
 * Kritiker-Linse "Movement-Kurven": Gelände — Treppe vs. Rampe hochhüpfen,
 * Terrassen runterhüpfen, Stirnwand-Bonks (Hop-Reihe L1), Surf-Kette L2.
 * npx tsx tools/critique/movement-curves/terrain.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../src/player/bots';
import { compileLevel, type CompiledLevel } from '../../../src/world/level/compileLevel';
import { readLevelFile } from '../../sim/levels';
import { makeInput } from '../../sim/harness';
import { makeTraceResult } from '../../../src/world/collision/types';
import { SurfRider, routeAxis } from '../../levels/physics';

const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');
const cfg: MovementConfig = VELOCITY_DEFAULT;
const L1: CompiledLevel = compileLevel(readLevelFile('public/levels/level1.json'));
const L2: CompiledLevel = compileLevel(readLevelFile('public/levels/level2.json'));

const tr = makeTraceResult();
const pMin = new Vector3(-2, 0, -2);
const pMax = new Vector3(2, 2, 2);
/** Oberkante der Fläche direkt vor dem Spieler (für Bonk-Defizit). */
function topAhead(level: CompiledLevel, pos: Vector3, vx: number, vz: number): number {
  const l = Math.hypot(vx, vz) || 1;
  const x = pos.x + (vx / l) * 20;
  const z = pos.z + (vz / l) * 20;
  const a = new Vector3(x, pos.y + 200, z);
  const b = new Vector3(x, pos.y - 50, z);
  level.world.traceBox(a, b, pMin, pMax, tr);
  return tr.fraction < 1 ? tr.endPos.y : Number.NaN;
}

// ---------------------------------------------------------------------------
console.log('## A) L1 Treppe (x=-96, 8×16 u) vs. Rampe (x=+96, 26.6°) — W + Sprung gehalten, Blick Nord\n');
console.log('| Anlauf u/s | Weg | Speed oben (Plateau) | Bonks (Tempo −25 % in 1 Luft-Tick) | Boden-Ticks | Zeit bis z<−1600 |');
console.log('|---|---|---|---|---|---|');
for (const x of [-96, 96]) {
  for (const v0 of [250, 320, 400, 500, 650]) {
    for (const phase of [0, 60, 120]) {
      const pm = new PlayerMovement(L1.world, cfg);
      pm.teleport(new Vector3(x, 1, -1030 - phase));
      pm.state.vel.set(0, 0, -v0);
      let bonks = 0;
      let groundTicks = 0;
      let prev = pm.state.speed;
      let prevGround = pm.state.onGround;
      let t = 0;
      for (; t < 4 * cfg.tickRate; t++) {
        pm.tick(makeInput({ forward: 1, sprint: true, jumpHeld: true, jumpPressed: t === 0, yaw: 0 }));
        const s = pm.state;
        if (!s.onGround && !prevGround && s.speed < 0.75 * prev) bonks++;
        if (s.onGround) groundTicks++;
        prev = s.speed;
        prevGround = s.onGround;
        if (s.pos.z < -1600) break;
      }
      console.log(`| ${v0} (+${phase} u) | ${x < 0 ? 'Treppe' : 'Rampe'} | ${f(pm.state.speed)} | ${bonks} | ${groundTicks} | ${f(t / cfg.tickRate, 2)} s |`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n## B) L1 Terrassen (8° + 40-u-Stufen) runterhüpfen ab Slalom-Ende, Kurs Süd\n');
for (const [label, v0, strafe] of [['W+Sprung', 807, false], ['perfekter Strafer', 807, true], ['W+Sprung', 450, false], ['Hand 3°', 450, true]] as const) {
  const pm = new PlayerMovement(L1.world, cfg);
  pm.teleport(new Vector3(-2403, 193, -520));
  pm.state.vel.set(0, 0, v0);
  const bot = strafe ? new StrafeBot(cfg, { heading: Math.PI, ...(label === 'Hand 3°' ? { aimNoiseDeg: 3, seed: 5 } : {}) }) : null;
  const lands: string[] = [];
  for (let t = 0; t < 8 * cfg.tickRate; t++) {
    const inp = bot ? bot.next(pm.state) : makeInput({ forward: 1, jumpHeld: true, jumpPressed: t === 0, yaw: Math.PI });
    const ev = pm.tick(inp);
    for (const e of ev) if (e.type === 'land') lands.push(`${f(e.speed)}@z${f(pm.state.pos.z)}`);
    if (pm.state.pos.z > 3740 || pm.state.pos.y < -900) break;
  }
  console.log(`${label} ab ${v0}: Landungen ${lands.join(' → ')}`);
}

// ---------------------------------------------------------------------------
console.log('\n## C) Stirnwand-Bonks in der L1-Hop-Reihe (W+Sprung gehalten, ohne Strafen, Start Plateau)\n');
{
  let runs = 0;
  let deaths = 0;
  let bonkDeaths = 0;
  const deficits: number[] = [];
  for (let v0 = 320; v0 <= 800; v0 += 20) {
    for (let off = 0; off < 240; off += 12) {
      runs++;
      const pm = new PlayerMovement(L1.world, cfg);
      pm.teleport(new Vector3(0, 129, -1600 - off));
      pm.state.vel.set(0, 0, -v0);
      let prev = pm.state.speed;
      let prevGround = pm.state.onGround;
      let bonkDef: number | null = null;
      for (let t = 0; t < 8 * cfg.tickRate; t++) {
        const vz = pm.state.vel.z;
        pm.tick(makeInput({ forward: 1, jumpHeld: true, jumpPressed: t === 0, yaw: 0 }));
        const s = pm.state;
        if (!s.onGround && !prevGround && s.speed < 0.5 * prev && bonkDef === null) {
          bonkDef = topAhead(L1, s.pos, 0, vz) - s.pos.y;
        }
        prev = s.speed;
        prevGround = s.onGround;
        if (s.pos.y < 40) { deaths++; if (bonkDef !== null) { bonkDeaths++; deficits.push(bonkDef); } break; }
        if (s.pos.z < -4430) break; // bis H7
      }
    }
  }
  deficits.sort((a, b) => a - b);
  const le = (x: number): number => deficits.filter((d) => d <= x).length;
  console.log(`Läufe ${runs}, Tode ${deaths}, davon nach Stirnwand-Bonk ${bonkDeaths} (${f(100 * bonkDeaths / Math.max(1, deaths))} %)`);
  console.log(`Defizit (Plattform-Oberkante − Füße beim Bonk): ≤4 u ${le(4)}, ≤8 u ${le(8)}, ≤12 u ${le(12)}, ≤18 u ${le(18)}, Median ${f(deficits[Math.floor(deficits.length / 2)] ?? NaN, 1)} u`);
}

// ---------------------------------------------------------------------------
console.log('\n## D) L2 Surf-Kette ab CP2 (Grundtechnik-Surfer, Blick entlang Achse + Offset)\n');
{
  const route = L2.def.route ?? [];
  const axisAt = routeAxis(route);
  const cp2 = L2.triggers.find((t) => t.kind === 'checkpoint' && t.order === 2);
  if (!cp2) throw new Error('cp2 fehlt');
  for (const offDeg of [0, 5, -5, 10]) {
    const pm = new PlayerMovement(L2.world, cfg);
    pm.teleport(cp2.spawnPos.clone().add(new Vector3(0, 1, 0)));
    const rider = new SurfRider(cfg, L2.world, axisAt, (offDeg * Math.PI) / 180);
    let surfTicks = 0;
    let groundTicksSurf = 0;
    let maxDrop = 0;
    let dropAt = '';
    let prev3 = 0;
    let prevG = true;
    let started = false;
    const marks = [-1700, -2440, -2688, -3588, -3872, -4772, -4976, -5860, -6732];
    let mi = 0;
    const at: string[] = [];
    let end = '';
    for (let t = 0; t < 20 * cfg.tickRate; t++) {
      pm.tick(rider.next(pm.state, pm.surfNormal));
      const s = pm.state;
      const sp3 = s.vel.length();
      if (s.surfing) { surfTicks++; started = true; }
      if (started && s.onGround) groundTicksSurf++;
      if (started && !s.onGround && !prevG && prev3 > 200 && prev3 - sp3 > maxDrop) { maxDrop = prev3 - sp3; dropAt = `z${f(s.pos.z)}`; }
      prev3 = sp3;
      prevG = s.onGround;
      while (mi < marks.length && s.pos.z < marks[mi]) { at.push(`${f(s.speed)}`); mi++; }
      if (s.pos.y < -2600 || s.pos.z < -7300) { end = s.pos.z < -7300 ? 'Launch erreicht' : `gefallen bei z${f(s.pos.z)} y${f(s.pos.y)}`; break; }
    }
    console.log(`Blick-Offset ${offDeg}°: Horizontal-Speed an Knoten z=${marks.slice(0, at.length).join('/')}: ${at.join(' → ')}; Surf-Ticks ${surfTicks}, Boden-Ticks im Surf ${groundTicksSurf}, größter 1-Tick-Einbruch (3D) ${f(maxDrop, 1)} u/s ${dropAt}; ${end}`);
  }
}
