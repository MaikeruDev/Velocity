/**
 * Befund-Gegenprobe: Luft-Hänger auch an der Bande des L2-Rings (gedrehte Segmente, ausgeliefert)?
 * Hüpfer auf der Außenbahn, Blick 25° nach außen in die Bande, W+Space, 3 s.
 *   npx tsx tools/critique/v2/level4/l2hang.ts
 */
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';

const cfg = VELOCITY_DEFAULT;
const lv = compileLevel(JSON.parse(readFileSync('public/levels/level2.json', 'utf8')));
let runs = 0;
let hangs = 0;
let hangTime = 0;
for (let phi = 50; phi < 220; phi += 10) {
  for (const r of [1450, 1500]) {
    for (const v of [320, 600, 900]) {
      for (const aim of [15, 25, 40]) {
        const a = (phi * Math.PI) / 180;
        const x = r * Math.cos(a);
        const z = -r * Math.sin(a);
        const pm = new PlayerMovement(lv.world, cfg);
        pm.teleport(new Vector3(x, 120, z));
        const yaw0 = a; // Fahrtrichtung = φ (gegen den Uhrzeigersinn)
        const yaw = yaw0 - (aim * Math.PI) / 180; // nach außen (rechts)
        pm.state.vel.set(-Math.sin(yaw0) * v, 0, -Math.cos(yaw0) * v);
        const inp = makeBotInput();
        let hang = 0;
        let maxHang = 0;
        for (let k = 0; k < 3 * cfg.tickRate; k++) {
          inp.yaw = yaw; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = k === 0;
          pm.tick(inp);
          hang = !pm.state.onGround && Math.abs(pm.state.vel.y) < 12 && pm.state.speed < 40 ? hang + 1 : 0;
          maxHang = Math.max(maxHang, hang);
        }
        runs++;
        if (maxHang > 32) { hangs++; hangTime += maxHang / cfg.tickRate; }
      }
    }
  }
}
console.log(`L2-Ring-Bande: Luft-Hänger > 0.25 s in ${hangs}/${runs} Läufen (Ø längster ${(hangTime / Math.max(1, hangs)).toFixed(2)} s)`);
