/** Level 4 — Luft-Hänger aus Probe B lokalisieren: welche Flächen halten den Spieler? */
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
const byTag: Record<string, number> = {};
const byAim: Record<string, number> = {};
let shown = 0;
for (let theta = 10; theta < 530; theta += 20) {
  for (const r of [700, 900, 1100]) {
    for (const v of [320, 600, 900]) {
      for (const aim of [0, -25, 25]) {
        const pm = new PlayerMovement(lv.world, cfg);
        const [x, z] = h.xz(theta, r);
        pm.teleport(new Vector3(x, h.yAt(theta, true) + 80, z));
        const yaw0 = (h.yawAt(theta) * Math.PI) / 180;
        const yaw = yaw0 + (aim * Math.PI) / 180;
        pm.state.vel.set(-Math.sin(yaw0) * v, 0, -Math.cos(yaw0) * v);
        const inp = makeBotInput();
        let hang = 0;
        for (let k = 0; k < 3 * cfg.tickRate; k++) {
          inp.yaw = yaw; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = k === 0;
          pm.tick(inp);
          const s = pm.state;
          hang = !s.onGround && Math.abs(s.vel.y) < 12 && s.speed < 40 ? hang + 1 : 0;
          if (hang === 33) {
            const p = s.pos.clone();
            const tags: string[] = [];
            for (const d of [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1), new Vector3(0, -1, 0)]) {
              const t = lv.world.traceBox(p, p.clone().addScaledVector(d, 2), pm.hullMins, pm.hullMaxs);
              if (t.fraction < 1) tags.push(`${(lv.brushes[t.brushIndex]?.tag ?? '?').replace(/#\d+/, '')}(${t.normal.toArray().map((q) => q.toFixed(2)).join(',')})`);
            }
            const key = [...new Set(tags.map((q) => q.split('(')[0]))].sort().join('+') || 'nichts';
            byTag[key] = (byTag[key] ?? 0) + 1;
            byAim[`Blick ${aim}`] = (byAim[`Blick ${aim}`] ?? 0) + 1;
            if (shown++ < 3) console.log(`θ ${theta} r ${r} v ${v} aim ${aim}: y ${p.y.toFixed(1)} Boden ${h.yAt(theta, true).toFixed(0)} r ${Math.hypot(p.x, p.z).toFixed(0)} → ${[...new Set(tags)].join(' ')}`);
            break;
          }
        }
      }
    }
  }
}
console.log(byTag, byAim);
