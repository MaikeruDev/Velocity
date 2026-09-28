/**
 * Kanten-Assist im Turm-Baustein (Level 4, vertikal): gerade Treppe aus Blöcken, je Stufe +rise u
 * und depth u tief. Hüpfen mit gehaltener Leertaste (Auto-Hop), verschiedene Hände.
 * Messung: Zeit bis 384 u Höhe, Luft-Anpraller (Tempo −40 % in einem Luft-Tick), Mindesttempo.
 *   npx tsx tools/critique/v2/arcade-mechanics/climb-assist.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../../src/player/bots';
import type { PlayerInput } from '../../../../src/player/types';
import { NO_INPUT } from '../../../../src/player/types';
import type { CollisionWorld } from '../../../../src/world/collision/types';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { BrushDef } from '../../../../src/world/level/LevelFormat';
import { box, makeLevel } from '../../../sim/levels';
import { LEDGE_DEFAULT, arcadeClass } from './ArcadeMovement';

const OUT = 'shots/v2/arcade-mechanics';
mkdirSync(OUT, { recursive: true });
const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;
const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');
type Ctor = new (w: CollisionWorld, c: MovementConfig) => PlayerMovement;
const VARIANTS: Array<[string, Ctor]> = [['Original', PlayerMovement], ['Kanten-Assist (Default)', arcadeClass({ ledge: LEDGE_DEFAULT })], ['Lip-Step nur fallend', arcadeClass({ ledge: { ...LEDGE_DEFAULT, stepRising: false } })], ['nur Gedächtnis', arcadeClass({ ledge: { height: 0, memory: 0.2 } })]];
const rows: unknown[] = [];
console.log('| Treppe (Stufe/Tiefe) | Fahrer | v0 | Original: Zeit · Anpraller · min. Tempo | Kanten-Assist (Default: Lip-Step auch steigend) | Lip-Step nur fallend | nur Gedächtnis |');
console.log('|---|---|---|---|---|---|---|');
for (const [rise, depth] of [[32, 192], [48, 192], [32, 256], [48, 256]] as Array<[number, number]>) {
  const brushes: BrushDef[] = [box([-256, -64, 0], [256, 0, 1024], 'start')];
  for (let i = 1; i <= 20; i++) brushes.push(box([-256, -64, -depth * i], [256, rise * i, -depth * (i - 1)], `s${i}`));
  const lv = compileLevel(makeLevel(brushes, { killY: -500 }));
  for (const who of ['perfekt', 'Hand 3°', 'W+Space'] as const) {
    for (const v0 of [320, 500]) {
      const cells: string[] = [];
      for (const [, K] of VARIANTS) {
        const pm = new K(lv.world, cfg);
        pm.teleport(new Vector3(0, 1, 200));
        for (let k = 0; k < 20; k++) {
          pm.state.vel.set(0, pm.state.vel.y, -Math.min(v0, 320));
          pm.tick({ ...NO_INPUT, forward: 1, sprint: true });
        }
        pm.state.vel.set(0, 0, -v0);
        const bot = who === 'W+Space' ? null : new StrafeBot(cfg, { aimNoiseDeg: who === 'Hand 3°' ? 3 : 0, seed: 6, heading: 0 });
        let bonks = 0;
        let prev = pm.state.speed;
        let minV = Infinity;
        let res = NaN;
        for (let k = 0; k < 20 * cfg.tickRate; k++) {
          const wasAir = !pm.state.onGround;
          let inp: PlayerInput;
          if (bot) {
            const b = bot.next(pm.state);
            inp = { ...b, jumpHeld: true, jumpPressed: k === 0 };
          } else inp = { ...NO_INPUT, forward: 1, sprint: true, jumpHeld: true, jumpPressed: k === 0 };
          pm.tick(inp);
          const s = pm.state;
          if (wasAir && !s.onGround && prev > 150 && s.speed < prev * 0.6) bonks++;
          prev = s.speed;
          if (k > 64) minV = Math.min(minV, s.speed);
          if (s.onGround && s.pos.y >= 384 - 1) { res = k * DT; break; }
        }
        cells.push(`${f(res, 2)} s · ${bonks} · ${f(minV)}`);
      }
      rows.push({ rise, depth, who, v0, cells });
      console.log(`| ${rise}/${depth} | ${who} | ${v0} | ${cells.join(' | ')} |`);
    }
  }
}
writeFileSync(`${OUT}/climb-assist.json`, JSON.stringify(rows, null, 2));
