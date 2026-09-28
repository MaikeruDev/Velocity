// Prüfer: Smart-Hop mit NUR gehaltener Taste (kein frischer Druck je Landung) und A/D am Boden.
// StrafeBot drückt sonst bei jeder Bodenberührung frisch (umgeht den Smart-Hop).
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../src/player/bots';
import { flatWorld } from '../../sim/scenarios';
function run(cfg: MovementConfig, aim: number, seed: number, v0: number, held: boolean, sprint: boolean) {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 12000));
  pm.state.vel.set(0, 0, -v0);
  const bot = new StrafeBot(cfg, aim > 0 ? { aimNoiseDeg: aim, seed, heading: 0 } : { heading: 0 });
  const lands: number[] = [];
  let waits = 0, waitTicks = 0, g = 0;
  for (let t = 0; t < 40 * cfg.tickRate && lands.length < 20; t++) {
    const inp = bot.next(pm.state) as { jumpPressed: boolean; sprint: boolean };
    if (held && t > 0) inp.jumpPressed = false;
    inp.sprint = sprint;
    const wasG = pm.state.onGround;
    for (const e of pm.tick(inp as never)) { if (e.type === 'land') { lands.push(e.speed); if (!e.jumpQueued) waits++; } }
    if (pm.state.onGround) { g++; } else { if (wasG && g > 1) waitTicks += g - 1; g = 0; }
  }
  return { lands, waits, waitTicks };
}
const OLD = withMovement(VELOCITY_DEFAULT, { autoHopSpeedShare: 0, autoHopGroundTime: 0 });
for (const v0 of [320, 250]) for (const sprint of [true, false]) {
  console.log(`\n### Start ${v0} u/s, sprint=${sprint}  (H1/H3/H5/H10/H20, Mittel 8 Seeds; Wartende Landungen Σ)`);
  for (const aim of [0, 3, 5, 6]) {
    const row: string[] = [];
    for (const [name, cfg, held] of [['frisch', VELOCITY_DEFAULT, false], ['gehalten', VELOCITY_DEFAULT, true], ['gehalten alt', OLD, true]] as Array<[string, MovementConfig, boolean]>) {
      const acc = new Array(20).fill(0); let w = 0, wt = 0; const S = aim ? 8 : 1;
      for (let s = 1; s <= S; s++) { const r = run(cfg, aim, s * 997, v0, held, sprint); for (let i = 0; i < 20; i++) acc[i] += (r.lands[i] ?? NaN) / S; w += r.waits; wt += r.waitTicks; }
      row.push(`${name}: ${[0, 2, 4, 9, 19].map((i) => acc[i].toFixed(0)).join('/')} (wartend ${w}, Bodenticks ${wt})`);
    }
    console.log(`${aim ? aim + '°' : 'perfekt'}  | ${row.join(' | ')}`);
  }
}
