/** Level 4 — erste Luft-Hänger-Stelle an Kante 1 finden und die Ebenen ringsum ausgeben. */
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
let shown = 0;
outer: for (const [ei, wall] of info.crouchWalls.entries()) {
  for (const v of [250, 400, 550, 700, 900]) {
    for (const r of [680, 790, 900, 1010, 1110]) {
      for (const phase of [0, 1, 2, 3]) {
        const start = wall - 45 - phase * 2;
        const pm = new PlayerMovement(lv.world, cfg);
        const [x, z] = h.xz(start, r);
        pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
        const inp = makeBotInput();
        const th = (): number => { let t = (Math.atan2(-pm.state.pos.z, pm.state.pos.x) * 180) / Math.PI - 270; while (t < start - 180) t += 360; while (t > start + 180) t -= 360; return t; };
        let hang = 0;
        for (let k = 0; k < 4 * cfg.tickRate; k++) {
          const yaw = (h.yawAt(th()) * Math.PI) / 180;
          if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
          inp.yaw = yaw; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = k === 0; inp.crouch = !pm.state.onGround;
          pm.tick(inp);
          const s = pm.state;
          hang = !s.onGround && Math.abs(s.vel.y) < 12 && s.speed < 40 ? hang + 1 : 0;
          if (hang === 64) {
            const p = s.pos.clone();
            const rr = Math.hypot(p.x, p.z);
            console.log(`Kante ${ei + 1} v ${v} r0 ${r} Phase ${phase}: hängt bei θ ${th().toFixed(2)} (Stufe ${wall}) r ${rr.toFixed(0)} y ${p.y.toFixed(1)} (Stufe oben ${h.yAt(wall + 0.5, true)}), ducked ${s.ducked}`);
            const mins = pm.hullMins.clone();
            const maxs = pm.hullMaxs.clone();
            const f = new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
            const rgt = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
            for (const [name, d] of [['vor', f], ['links', rgt.clone().negate()], ['rechts', rgt], ['runter', new Vector3(0, -1, 0)], ['vor+runter', f.clone().add(new Vector3(0, -1, 0)).normalize()]] as const) {
              const rt = lv.world.traceBox(p, p.clone().addScaledVector(d, 3), mins, maxs);
              console.log(`   ${name.padEnd(10)} frac ${rt.fraction.toFixed(3)} n ${rt.normal.toArray().map((q) => q.toFixed(3)).join(',')} ${lv.brushes[rt.brushIndex]?.tag ?? ''}`);
            }
            if (++shown >= 4) break outer;
            break;
          }
        }
      }
    }
  }
}
