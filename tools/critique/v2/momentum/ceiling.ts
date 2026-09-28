/**
 * Obergrenzen: wie schnell wird man ohne Eingabe auf einer langen Surf-Flanke (surfWorld, n.y≈0.54)
 * und auf einer 45° gedrehten Rampe (Achs-Kappung maxVelocity 3500 je Achse verzerrt dort die Richtung)?
 * npx tsx tools/critique/v2/momentum/ceiling.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { makeLevel } from '../../../sim/levels';
import { makeInput } from '../../../sim/harness';
import { f } from './common';

const cfg = VELOCITY_DEFAULT;
for (const rot of [0, 45]) {
  const lv = compileLevel(makeLevel([
    { type: 'prism', axis: 'z', from: -60000, to: 0, profile: [[-40000, -60000], [40000, -60000], [0, 0]], mat: 'surf', rotY: rot, pivot: [0, 0, 0] },
  ]));
  const pm = new PlayerMovement(lv.world, cfg);
  // Über der rechten Flanke (Neigung 56°) absetzen, Tempo entlang der Achse.
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  const x0 = 200, z0 = -200;
  pm.teleport(new Vector3(x0 * c + z0 * s, -250, -x0 * s + z0 * c));
  pm.state.vel.set(-400 * s, 0, -400 * c);
  const out: string[] = [];
  for (let t = 1; t <= 12 * cfg.tickRate; t++) {
    pm.tick(makeInput({}));
    if (t % (2 * cfg.tickRate) === 0) {
      const v = pm.state.vel;
      out.push(`${t / cfg.tickRate}s: |v| ${f(v.length())} (h ${f(Math.hypot(v.x, v.z))}, Achsen ${f(v.x)}/${f(v.y)}/${f(v.z)})`);
    }
  }
  console.log(`Rampe um ${rot}° gedreht, ohne Eingabe:\n  ${out.join('\n  ')}`);
}
