/**
 * Bot-Durchlauf Tick für Tick verfolgen — für Level-Debugging.
 *
 *   npx tsx tools/sim/traceRoute.ts public/levels/level1.json [vonKnoten] [bisKnoten] [sync]
 *
 * Gibt alle 8 Ticks (und bei jedem Event) Position, Geschwindigkeit, Boden/Surf
 * und die Bot-Eingabe aus, solange der angesteuerte Knoten im Bereich liegt.
 */
import { VELOCITY_DEFAULT } from '../../src/player/MovementConfig';
import { RouteFollower } from '../../src/player/bots';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { compileLevel } from '../../src/world/level/compileLevel';
import { readLevelFile } from './levels';

const [pathArg = 'level1', fromArg = '0', toArg = '9999', syncArg = '1'] = process.argv.slice(2);
// Level-ID (level1) oder Dateipfad.
const path = pathArg.endsWith('.json') ? pathArg : `public/levels/${pathArg}.json`;
const lvl = compileLevel(readLevelFile(path));
const from = Number(fromArg);
const to = Number(toArg);
const cfg = VELOCITY_DEFAULT;
const pm = new PlayerMovement(lvl.world, cfg);
pm.teleport(lvl.spawnPos);
const bot = new RouteFollower(lvl.def.route ?? [], cfg, {
  sync: Number(syncArg),
  seed: 11,
  killY: lvl.def.killY,
  world: lvl.world,
  start: { x: lvl.spawnPos.x, z: lvl.spawnPos.z },
});
const f0 = (v: number): string => v.toFixed(0);
for (let t = 0; t < cfg.tickRate * 180 && bot.status === 'running'; t++) {
  const inp = bot.next(pm.state, pm.surfNormal);
  const ev = pm.tick(inp);
  const s = pm.state;
  if (bot.nextIndex >= from && bot.nextIndex <= to && (ev.length > 0 || t % 8 === 0)) {
    console.log(
      `${t} → ${bot.nextIndex}  pos ${f0(s.pos.x)},${f0(s.pos.y)},${f0(s.pos.z)}  vel ${f0(s.vel.x)},${f0(s.vel.y)},${f0(s.vel.z)}  ${s.onGround ? 'G' : 'A'}${s.surfing ? 'S' : ' '}  ` +
        `in f${inp.forward} s${inp.side} j${inp.jumpHeld ? 1 : 0} c${inp.crouch ? 1 : 0} yaw ${f0((inp.yaw * 180) / Math.PI)}  ${ev.map((e) => e.type).join(' ')}`,
    );
  }
  if (bot.nextIndex > to) break;
}
const r = bot.report;
console.log(`${r.status}${r.reason ? ` (${r.reason})` : ''} — ${r.reached}/${r.total} Knoten, ${r.time.toFixed(2)} s`);
