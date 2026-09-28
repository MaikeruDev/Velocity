/**
 * Nachweis Engine-Befund: Luft-Hänger in konkaven Ecken — mit Original-PlayerMovement und mit
 * der Ein-Zeilen-Korrektur (PlayerMovementFixed.ts). Proben: Wendel-Bande-Hüpfer (wie probes B)
 * und gerader Crouch-Hüpfer an beiden Kanten (wie probes C), dazu die ALTE E3-Geometrie nicht mehr
 * nötig: gemessen wird die aktuelle.
 *   npx tsx tools/critique/v2/level4/fixcheck.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { PlayerMovement as PlayerMovementFixed } from './PlayerMovementFixed';
import { buildLevel4, level4Info } from './level4';

const cfg = VELOCITY_DEFAULT;
const def = buildLevel4({ measure: false });
const info = level4Info();
const lv = compileLevel(def);
const h = info.helix;
type PM = { tick: PlayerMovement['tick']; state: PlayerMovement['state']; teleport: PlayerMovement['teleport'] };
for (const [name, Make] of [['Original', PlayerMovement], ['Fix', PlayerMovementFixed]] as const) {
  let runs = 0;
  let hangs = 0;
  let up = 0;
  let upRuns = 0;
  // Bande-Hüpfer
  for (let theta = 10; theta < 530; theta += 20) for (const r of [700, 900, 1100]) for (const v of [320, 600, 900]) for (const aim of [0, -25, 25]) {
    const pm: PM = new Make(lv.world, cfg);
    const [x, z] = h.xz(theta, r);
    pm.teleport(new Vector3(x, h.yAt(theta, true) + 80, z));
    const yaw0 = (h.yawAt(theta) * Math.PI) / 180;
    const yaw = yaw0 + (aim * Math.PI) / 180;
    pm.state.vel.set(-Math.sin(yaw0) * v, 0, -Math.cos(yaw0) * v);
    const inp = makeBotInput();
    let hang = 0; let maxHang = 0;
    for (let k = 0; k < 3 * cfg.tickRate; k++) {
      inp.yaw = yaw; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = k === 0;
      pm.tick(inp);
      hang = !pm.state.onGround && Math.abs(pm.state.vel.y) < 12 && pm.state.speed < 40 ? hang + 1 : 0;
      maxHang = Math.max(maxHang, hang);
    }
    runs++;
    if (maxHang > 32) hangs++;
  }
  // Crouch-Kanten
  for (const wall of info.crouchWalls) for (const v of [250, 400, 550, 700, 900]) for (const r of [680, 790, 900, 1010, 1110]) for (const phase of [0, 1, 2, 3]) {
    const start = wall - 45 - phase * 2;
    const pm: PM = new Make(lv.world, cfg);
    const [x, z] = h.xz(start, r);
    pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
    const inp = makeBotInput();
    const th = (): number => { let t = (Math.atan2(-pm.state.pos.z, pm.state.pos.x) * 180) / Math.PI - 270; while (t < start - 180) t += 360; while (t > start + 180) t -= 360; return t; };
    const upper = h.yAt(wall + 0.5, true);
    upRuns++;
    for (let k = 0; k < 4 * cfg.tickRate; k++) {
      const yaw = (h.yawAt(th()) * Math.PI) / 180;
      if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
      inp.yaw = yaw; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = k === 0; inp.crouch = !pm.state.onGround;
      pm.tick(inp);
      if (pm.state.onGround && pm.state.pos.y >= upper - 4 && th() > wall) { up++; break; }
    }
  }
  console.log(`${name.padEnd(8)} Bande-Hüpfer: Luft-Hänger > 0.25 s ${hangs}/${runs} · Crouch-Kanten oben in ≤ 4 s: ${up}/${upRuns}`);
}
