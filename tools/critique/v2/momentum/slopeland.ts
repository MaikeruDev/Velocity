/**
 * Landung auf Gefällen: Was bleibt vom Tempo? Vorher (Source-Port) vs. Variante "slope".
 * npx tsx tools/critique/v2/momentum/slopeland.ts
 *
 * A) Einzel-Landung: Spieler in der Luft (vy = 0) h u über der Fläche, horizontal v Richtung −z
 *    (bergab) bzw. +z (bergauf). 16 Phasen (Starthöhe + δ·Fallweg/Tick) → Landetempo min/med/max.
 * B) Hop-Kette bergab: W + Leertaste gehalten (keine Strafes) bzw. perfekter Strafer auf 10°/16°,
 *    Tempo nach 1500 u Hangstrecke; Energie-Obergrenze √(v0² + 2gΔh) zum Vergleich.
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../../src/player/bots';
import { makeInput } from '../../../sim/harness';
import { MOM, MOM_STATS, setMomentum } from './patch';
import { DEG, f, slopeWorld, slopeY, stats } from './common';

const cfg = VELOCITY_DEFAULT;
const dt = 1 / cfg.tickRate;

function singleLanding(deg: number, v: number, h: number, dir: -1 | 1, phase: number): { speed: number; impact: number } {
  const lvl = slopeWorld(deg);
  const pm = new PlayerMovement(lvl.world, cfg);
  const z0 = -3000;
  // Fallweg pro Tick beim Aufprall ~ √(2gh)·dt → Phase als Bruchteil davon.
  const step = Math.sqrt(2 * cfg.gravity * h) * dt;
  pm.teleport(new Vector3(0, slopeY(deg, z0) + h + phase * step, z0));
  pm.state.vel.set(0, 0, dir * v);
  for (let t = 0; t < 5 * cfg.tickRate; t++) {
    for (const e of pm.tick(makeInput({ yaw: dir < 0 ? 0 : Math.PI }))) {
      if (e.type === 'land') return { speed: e.speed, impact: e.impact };
    }
  }
  return { speed: Number.NaN, impact: Number.NaN };
}

function tableA(): void {
  console.log('\n## A) Einzel-Landung auf Gefälle (Tempo nach dem Lande-Tick, 16 Phasen: min / med / max)\n');
  console.log('| Gefälle | Richtung | v | Fallhöhe | Aufprall vy | vorher (Source) | slope k=1 | k=1 Richtung+Slide | slope k=1.5 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const deg of [5, 10, 16, 25, 35]) {
    for (const dir of [-1, 1] as const) {
      for (const v of [320, 600, 1000]) {
        for (const h of [57, 192]) {
          const cols: string[] = [];
          let impact = 0;
          for (const variant of [{ slope: false }, { slope: true, slopeK: 1 }, { slope: true, slopeK: 1, slopeKeepDir: true, slopeSlide: true }, { slope: true, slopeK: 1.5 }]) {
            setMomentum('off');
            setMomentum(variant);
            const xs: number[] = [];
            for (let p = 0; p < 16; p++) {
              const r = singleLanding(deg, v, h, dir, p / 16);
              xs.push(r.speed);
              impact = r.impact;
            }
            const s = stats(xs);
            cols.push(s.max - s.min < 0.5 ? f(s.med) : `${f(s.min)} / ${f(s.med)} / ${f(s.max)}`);
          }
          console.log(`| ${deg}° | ${dir < 0 ? 'bergab' : 'bergauf'} | ${v} | ${h} | ${f(impact)} | ${cols.join(' | ')} |`);
        }
      }
    }
  }
  setMomentum('off');
}

function chain(deg: number, v0: number, strafe: boolean, dist: number): { speed: number; lands: number; land: number[] } {
  const lvl = slopeWorld(deg, 12000);
  const pm = new PlayerMovement(lvl.world, cfg);
  const z0 = -200;
  pm.teleport(new Vector3(0, slopeY(deg, z0, 12000) + 2, z0));
  pm.state.vel.set(0, 0, -v0);
  const bot = strafe ? new StrafeBot(cfg, { heading: 0 }) : null;
  const land: number[] = [];
  let lands = 0;
  for (let t = 0; t < 30 * cfg.tickRate; t++) {
    const inp = bot ? bot.next(pm.state) : makeInput({ forward: 1, sprint: true, jumpHeld: true, jumpPressed: t === 0, yaw: 0 });
    for (const e of pm.tick(inp)) if (e.type === 'land') { lands++; land.push(e.speed); }
    if (pm.state.pos.z < z0 - dist) break;
  }
  return { speed: pm.state.speed, lands, land };
}

function tableB(): void {
  console.log('\n## B) Hop-Kette bergab, Tempo nach 1500 u Hang (Δh = 1500·tanθ), Start 320 u/s\n');
  console.log('| Gefälle | Δh | Hand | vorher | slope k=1 | k=1 Richtung+Slide | slope k=1.5 | Energie-Decke √(v0²+2gΔh) |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const deg of [5, 10, 16, 25]) {
    const dh = 1500 * Math.tan(deg * DEG);
    for (const strafe of [false, true]) {
      const cols: string[] = [];
      for (const variant of [{ slope: false }, { slope: true, slopeK: 1 }, { slope: true, slopeK: 1, slopeKeepDir: true, slopeSlide: true }, { slope: true, slopeK: 1.5 }]) {
        setMomentum('off');
        setMomentum(variant);
        const r = chain(deg, 320, strafe, 1500);
        cols.push(`${f(r.speed)} (${r.lands} Ldg.)`);
      }
      console.log(`| ${deg}° | ${f(dh)} | ${strafe ? 'perfekter Strafer' : 'W+Space gehalten'} | ${cols.join(' | ')} | ${f(Math.hypot(320, Math.sqrt(2 * cfg.gravity * dh)))} |`);
    }
  }
  setMomentum('off');
  // Gleiche Kette auf flachem Boden als Referenz für den Strafer.
  const flat = chain(0, 320, true, 1500);
  console.log(`\nReferenz flach, perfekter Strafer nach 1500 u: ${f(flat.speed)} u/s (${flat.lands} Landungen)`);
  void MOM;
  void MOM_STATS;
}

tableA();
tableB();
