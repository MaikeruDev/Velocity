/**
 * Level 4 — Option B "Sprung-Pad" gemessen, ohne Projektcode: eigener Tick-Loop, der ein
 * trigger_catapult-artiges Pad nachbildet (Hull berührt Pad-Volumen und vy < V → vy = V,
 * horizontal bleibt). Zwei Einsätze:
 *  1) Graben-Pad: Boden der Innenbahn-Gräben. Zeitverlust eines "zu kurz" mit/ohne Pad.
 *  2) Etagen-Lift (Gedankenexperiment): Pad am Podest P3 statt E4-Rampe (+256 u). Zeit.
 *   npx tsx tools/critique/v2/level4/pads.ts
 */
import { writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { buildLevel4, level4Info, R_E2_IN } from './level4';

const cfg = VELOCITY_DEFAULT;
const def = buildLevel4({ measure: false });
const info = level4Info();
const lv = compileLevel(def);
const h = info.helix;
const lines: string[] = [];
const log = (s: string): void => { lines.push(s); console.log(s); };
const thetaOf = (x: number, z: number, near: number): number => {
  let t = (Math.atan2(-z, x) * 180) / Math.PI - 270;
  while (t < near - 180) t += 360;
  while (t > near + 180) t -= 360;
  return t;
};

log('## Graben-Pad (Option B) — Start im Graben am Rücken, W+Leertaste gehalten, Blick tangential\n');
log('| Pad vy | Tempo beim Fall | Zeit bis zurück auf der Bahn hinter dem Graben (Ø über 3 Gräben × 3 Radien, s) | max |');
log('|---|---|---|---|');
for (const V of [0, 380, 480]) {
  for (const v of [0, 250, 450, 650]) {
    let sum = 0;
    let max = 0;
    let n = 0;
    for (const [ta, tb] of info.trenches) {
      for (const r of [700, R_E2_IN, 820]) {
        const pm = new PlayerMovement(lv.world, cfg);
        const t0 = ta + 1.5;
        const [x, z] = h.xz(t0, r);
        const floor = h.yAt(t0, true);
        pm.teleport(new Vector3(x, floor + 2, z));
        const inp = makeBotInput();
        let t = NaN;
        for (let k = 0; k < 6 * cfg.tickRate; k++) {
          const th = thetaOf(pm.state.pos.x, pm.state.pos.z, t0);
          const yaw = (h.yawAt(th) * Math.PI) / 180;
          if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
          inp.yaw = yaw; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = k === 0;
          pm.tick(inp);
          const th2 = thetaOf(pm.state.pos.x, pm.state.pos.z, t0);
          // Pad: im Graben (θ, r) und Füße ≤ 12 u über dem Grabenboden.
          const rr = Math.hypot(pm.state.pos.x, pm.state.pos.z);
          if (V > 0 && th2 > ta && th2 < tb && rr < 864 && pm.state.pos.y < h.yAt(th2, true) + 12 && pm.state.vel.y < V) pm.state.vel.y = V;
          if (th2 > tb + 1 && pm.state.onGround && pm.state.pos.y > h.yAt(th2) - 6) { t = (k + 1) / cfg.tickRate; break; }
        }
        n++;
        sum += Number.isFinite(t) ? t : 6;
        max = Math.max(max, Number.isFinite(t) ? t : 6);
      }
    }
    log(`| ${V || 'ohne'} | ${v} | ${(sum / n).toFixed(2)} | ${max.toFixed(2)} |`);
  }
}
writeFileSync('shots/v2/level4/pads.md', lines.join('\n') + '\n');
