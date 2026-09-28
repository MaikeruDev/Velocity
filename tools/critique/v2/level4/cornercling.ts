/**
 * Level 4 — Befund-Repro 2: Luft-Hänger in einer Ecke aus zwei senkrechten Wänden,
 * die nicht rechtwinklig aufeinandertreffen (Crouch-Kante an der Wendel-Bande: ~96°).
 * Spieler in der Luft in der Ecke, W in die Frontwand, Blick leicht zur Seitenwand.
 *   npx tsx tools/critique/v2/level4/cornercling.ts
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../../src/world/level/LevelFormat';

const cfg = VELOCITY_DEFAULT;
const ENV = { skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1, sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -3000 };
const rows: string[] = ['| Front gedreht | Seite gedreht | Blick zur Seite | Ducken | nach 1 s gefallen (u) |', '|---|---|---|---|---|'];
let hangs = 0;
let total = 0;
for (const rotF of [0, 3, 5, 8]) {
  for (const rotS of [0, 3, 7]) {
    for (const look of [0, 10, 30]) {
      for (const duck of [false, true]) {
        const def: LevelFile = {
          version: 1, id: 'cc', name: 'cc', spawn: { pos: [0, 0, 0], yaw: 0 }, killY: -4000, environment: ENV,
          brushes: [
            { type: 'box', min: [-2000, -64, -2000], max: [2000, 0, 2000], mat: 'floor' },
            // Frontwand (vor dem Spieler, Stirn z = −100), um rotF gedreht (Drehpunkt rechte Ecke x = 100).
            { type: 'box', min: [-400, 0, -164], max: [100, 400, -100], mat: 'wall', rotY: rotF, pivot: [100, 0, -100] },
            // Seitenwand rechts (Stirn x = 100), um rotS gedreht (Drehpunkt an der Ecke).
            { type: 'box', min: [100, 0, -100], max: [132, 400, 400], mat: 'wall', rotY: rotS, pivot: [100, 0, -100] },
          ],
          triggers: [],
        };
        const lv = compileLevel(def);
        const pm = new PlayerMovement(lv.world, cfg);
        pm.teleport(new Vector3(70, 200, -70));
        const inp = makeBotInput();
        const y0 = pm.state.pos.y;
        for (let k = 0; k < cfg.tickRate; k++) {
          inp.yaw = (-look * Math.PI) / 180; // negativ = nach rechts zur Seitenwand
          inp.forward = 1;
          inp.crouch = duck;
          pm.tick(inp);
        }
        const fell = y0 - pm.state.pos.y;
        total++;
        if (fell < 100) hangs++;
        if (fell < 100) rows.push(`| ${rotF}° | ${rotS}° | ${look}° | ${duck ? 'ja' : 'nein'} | **${fell.toFixed(0)}** |`);
      }
    }
  }
}
console.log(rows.join('\n'));
console.log(`Hänger: ${hangs}/${total}`);
