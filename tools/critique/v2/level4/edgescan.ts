/** Level 4 — Crouch-Kante: Fehlschläge klassifizieren (Hänger in der Luft / Anprall-Schleife / zu langsam). */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { buildLevel4, level4Info } from './level4';

const cfg = VELOCITY_DEFAULT;
const def = buildLevel4({ measure: false });
const info = level4Info();
const lv = compileLevel(def);
const h = info.helix;
const stats: Record<string, number> = {};
let total = 0;
for (const [ei, wall] of info.crouchWalls.entries()) {
  for (const v of [250, 400, 550, 700, 900]) {
    for (const r of [680, 790, 900, 1010, 1110]) {
      for (const phase of [0, 1, 2, 3]) {
        total++;
        const start = wall - 45 - phase * 2;
        const pm = new PlayerMovement(lv.world, cfg);
        const [x, z] = h.xz(start, r);
        pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
        const inp = makeBotInput();
        const th = (): number => { let t = (Math.atan2(-pm.state.pos.z, pm.state.pos.x) * 180) / Math.PI - 270; while (t < start - 180) t += 360; while (t > start + 180) t -= 360; return t; };
        const upper = h.yAt(wall + 0.5, true);
        let hangTicks = 0;
        let maxHang = 0;
        let outcome = 'zu langsam (4 s)';
        for (let k = 0; k < 4 * cfg.tickRate; k++) {
          const yaw = (h.yawAt(th()) * Math.PI) / 180;
          if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
          inp.yaw = yaw; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = k === 0; inp.crouch = !pm.state.onGround;
          pm.tick(inp);
          const s = pm.state;
          if (!s.onGround && Math.abs(s.vel.y) < 12 && s.speed < 40) hangTicks++;
          else hangTicks = 0;
          maxHang = Math.max(maxHang, hangTicks);
          if (s.onGround && s.pos.y >= upper - 4 && th() > wall) { outcome = 'oben'; break; }
        }
        const key = `Kante ${ei + 1}: ${outcome}${maxHang > 32 ? ` (Luft-Hänger ${(maxHang / 128).toFixed(1)} s)` : ''}`;
        const k2 = outcome === 'oben' ? (maxHang > 32 ? 'oben, nach Hänger' : 'oben') : maxHang > 32 ? 'Luft-Hänger' : 'zu langsam (4 s)';
        stats[`Kante ${ei + 1}: ${k2}`] = (stats[`Kante ${ei + 1}: ${k2}`] ?? 0) + 1;
        void key;
      }
    }
  }
}
console.log(process.env.L4_OLD_BOARD === '1' ? 'ALTE Bande (Segmentgrenze auf der Stufe)' : 'NEUE Bande (Segmentmitte auf der Stufe)', `— ${total} Läufe`);
for (const [k, n] of Object.entries(stats).sort()) console.log(`  ${k}: ${n}`);
