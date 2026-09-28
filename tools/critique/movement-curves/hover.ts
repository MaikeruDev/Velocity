/**
 * "Klett-Effekt": Stillstand an einer Surf-Flanke (n.y ≈ 0.54), Taste in die Rampe.
 * Hängt man, rutscht man, kriecht man? VELOCITY vs. CS2 vs. Surf-Server (aa150, 66t).
 * npx tsx tools/critique/movement-curves/hover.ts
 */
import { Vector3 } from 'three';
import { CS2_CLASSIC, VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { surfWorld } from '../../sim/scenarios';
import { makeInput } from '../../sim/harness';

const presets: Array<[string, MovementConfig]> = [
  ['VELOCITY', VELOCITY_DEFAULT],
  ['CS2 64t aa12', CS2_CLASSIC],
  ['Surf-Server 66t aa150', withMovement(CS2_CLASSIC, { tickRate: 66, airAccelerate: 150 })],
];
for (const [name, cfg] of presets) {
  for (const [label, side, v0] of [['Stand, A in Rampe', -1, 0], ['Stand, keine Taste', 0, 0], ['80 u/s Achse, A in Rampe', -1, 80]] as const) {
    const pm = new PlayerMovement(surfWorld().world, cfg);
    pm.teleport(new Vector3(200, -250, -200));
    pm.state.vel.set(0, 0, -v0);
    // erst Kontakt herstellen
    const y0 = pm.state.pos.y;
    const rows: string[] = [];
    for (let t = 1; t <= 5 * cfg.tickRate; t++) {
      pm.tick(makeInput({ side, yaw: 0 }));
      if (t % cfg.tickRate === 0) rows.push(`${(t / cfg.tickRate).toFixed(0)}s: Δy ${(pm.state.pos.y - y0).toFixed(0)} v3 ${pm.state.vel.length().toFixed(0)}`);
    }
    console.log(`${name.padEnd(22)} ${label.padEnd(26)} ${rows.join(' | ')}`);
  }
}
