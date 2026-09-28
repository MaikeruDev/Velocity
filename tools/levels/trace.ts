/**
 * RouteFollower Tick für Tick verfolgen — ab Start oder ab einem Checkpoint-Spawn
 * (Respawn aus dem Stand), zum Level-Debugging:
 *
 *   npx tsx tools/levels/trace.ts <level> [cp=0] [sync=1] [abTick=0] [alleNTicks=8] [zielfehlerGrad=0] [seed=11]
 *
 * zielfehlerGrad > 0: Menschenmodell (absoluter Zielfehler der Hand, z. B. 3).
 *
 * Gibt Position, Geschwindigkeit, Boden/Surf, Surf-Normale, Bot-Eingabe und
 * Events aus; am Ende Status und erreichten Knoten. Stoppt an Kill-Zonen.
 */
import { readFileSync } from 'node:fs';
import { VELOCITY_DEFAULT } from '../../src/player/MovementConfig';
import { RouteFollower } from '../../src/player/bots';
import { PlayerMovement } from '../../src/player/PlayerMovement';
import { compileLevel } from '../../src/world/level/compileLevel';
import { resumeIndex } from './physics';

const [file = 'level2', cpArg = '0', syncArg = '1', fromTick = '0', every = '8', aimArg = '0', seedArg = '11'] = process.argv.slice(2);
const lvl = compileLevel(JSON.parse(readFileSync(`public/levels/${file}.json`, 'utf8')));
const cfg = VELOCITY_DEFAULT;
const pm = new PlayerMovement(lvl.world, cfg);
const cp = lvl.triggers.find((t) => t.kind === 'checkpoint' && t.order === Number(cpArg));
const route = lvl.def.route ?? [];
const from = cp ? Math.max(0, resumeIndex(route, cp)) : 0;
const start = cp ? cp.spawnPos : lvl.spawnPos;
pm.teleport(start);
const bot = new RouteFollower(route.slice(from), cfg, {
  sync: Number(syncArg),
  aimNoiseDeg: Number(aimArg),
  seed: Number(seedArg),
  killY: lvl.def.killY,
  world: lvl.world,
  start: { x: start.x, z: start.z },
});
const kills = lvl.triggers.filter((t) => t.kind === 'kill');
const f0 = (x: number): string => x.toFixed(0);
for (let t = 0; t < cfg.tickRate * 90 && bot.status === 'running'; t++) {
  const inp = bot.next(pm.state, pm.surfNormal);
  const ev = pm.tick(inp);
  const s = pm.state;
  if (t >= Number(fromTick) && (ev.length > 0 || t % Number(every) === 0))
    console.log(
      `${t} →${bot.nextIndex + from} pos ${f0(s.pos.x)},${f0(s.pos.y)},${f0(s.pos.z)} vel ${f0(s.vel.x)},${f0(s.vel.y)},${f0(s.vel.z)} ` +
        `${s.onGround ? 'G' : 'A'}${s.surfing ? 'S' : ' '} n ${pm.surfNormal.toArray().map((v) => v.toFixed(2)).join(',')} ` +
        `in f${inp.forward} s${inp.side} j${inp.jumpHeld ? 1 : 0} yaw ${f0((inp.yaw * 180) / Math.PI)} ${ev.map((e) => e.type).join(' ')}`,
    );
  const k = kills.find((z) => z.bounds.containsPoint(s.pos));
  if (k) {
    console.log(`KILL ${k.tag ?? ''} bei Tick ${t}`);
    break;
  }
}
console.log(`${bot.report.status}${bot.report.reason ? ` (${bot.report.reason})` : ''} — nächster Knoten ${bot.report.reached + from}`);
