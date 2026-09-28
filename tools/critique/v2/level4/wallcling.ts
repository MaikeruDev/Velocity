/**
 * Level 4 — Befund-Repro: "Luft-Hänger" an nicht achsparallelen Wänden.
 * Eine senkrechte Wand (Box mit rotY), Spieler in der Luft davor, W (und optional Ducken)
 * gedrückt in die Wand. Fällt er (wie erwartet) oder klebt er in der Luft?
 *   npx tsx tools/critique/v2/level4/wallcling.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../../src/world/level/LevelFormat';

const cfg = VELOCITY_DEFAULT;
const ENV = { skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1, sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -3000 };
const rows: string[] = ['| Wand-Drehung | Ducken | Blick relativ zur Wandnormalen | nach 1 s gefallen (u) | hängt? |', '|---|---|---|---|---|'];
for (const rot of [0, 2, 5, 10, 20, 45]) {
  for (const duck of [false, true]) {
    for (const lookOff of [0, 20, 60]) {
      const def: LevelFile = {
        version: 1, id: 'wc', name: 'wc', spawn: { pos: [0, 0, 0], yaw: 0 }, killY: -4000, environment: ENV,
        brushes: [
          { type: 'box', min: [-2000, -64, -2000], max: [2000, 0, 2000], mat: 'floor' },
          // Wand: 512 breit, 400 hoch, Stirn bei z = −100 (vor dem Spieler, Blick −Z), um rot gedreht.
          { type: 'box', min: [-256, 0, -164], max: [256, 400, -100], mat: 'wall', rotY: rot, pivot: [0, 0, -100] },
        ],
        triggers: [],
      };
      const lv = compileLevel(def);
      const pm = new PlayerMovement(lv.world, cfg);
      pm.teleport(new Vector3(0, 200, -40));
      const inp = makeBotInput();
      // Wandnormale zeigt nach +Z, gedreht um rot → Blick gegen die Normale.
      const yawWall = (rot * Math.PI) / 180;
      const y0 = pm.state.pos.y;
      let minVy = 0;
      for (let k = 0; k < cfg.tickRate; k++) {
        inp.yaw = yawWall + (lookOff * Math.PI) / 180;
        inp.forward = 1;
        inp.crouch = duck;
        pm.tick(inp);
        minVy = Math.min(minVy, pm.state.vel.y);
      }
      const fell = y0 - pm.state.pos.y;
      rows.push(`| ${rot}° | ${duck ? 'ja' : 'nein'} | ${lookOff}° | ${fell.toFixed(0)} | ${fell < 100 ? '**JA**' : 'nein'} (min vy ${minVy.toFixed(0)}) |`);
    }
  }
}
console.log(rows.join('\n'));
