/**
 * SLIDE — Messung gegen die echte Engine (Prototyp ArcadeMovement, kein Projektcode).
 *   npx tsx tools/critique/v2/arcade-mechanics/slide.ts
 * Ausgabe: shots/v2/arcade-mechanics/slide.json + Konsole (Markdown-Tabellen).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT, withMovement } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../../src/player/bots';
import type { MutablePlayerInput, PlayerInput } from '../../../../src/player/types';
import { NO_INPUT } from '../../../../src/player/types';
import { compileLevel, type CompiledLevel } from '../../../../src/world/level/compileLevel';
import type { BrushDef } from '../../../../src/world/level/LevelFormat';
import { box, flatLevel, makeLevel, readLevelFile } from '../../../sim/levels';
import { timedRun } from '../../../levels/physics';
import { ArcadeMovement, SLIDE_DEFAULT, installGlobal, type SlideOpts } from './ArcadeMovement';

const OUT = 'shots/v2/arcade-mechanics';
mkdirSync(OUT, { recursive: true });
const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;
const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');
const result: Record<string, unknown> = {};

function inp(p: Partial<PlayerInput>): MutablePlayerInput {
  return { ...NO_INPUT, sprint: true, ...p };
}

type Make = (lv: CompiledLevel) => PlayerMovement;
const ORIG: Make = (lv) => new PlayerMovement(lv.world, cfg);
const SLIDE = (o: Partial<SlideOpts> = {}): Make => (lv) => new ArcadeMovement(lv.world, cfg, { slide: { ...SLIDE_DEFAULT, ...o } });

const flat = compileLevel(flatLevel());

/** Auf Boden absetzen und 0.3 s mit Tempo v geradeaus sprinten (Füße exakt auf dem Boden). */
function settle(pm: PlayerMovement, pos: Vector3, v: number): void {
  pm.teleport(pos);
  for (let k = 0; k < 40; k++) {
    pm.state.vel.set(0, pm.state.vel.y, -v);
    pm.tick(inp({ forward: 1 }));
  }
}

// ---------------------------------------------------------------- S1 flach: Sprint → Ducken
function s1(): void {
  console.log('\n## S1 Flach: Sprint (320) bzw. Bhop-Landung, dann Ducken gehalten, W gehalten — Tempo nach t (u/s), Strecke bis < 160 u/s\n');
  console.log('| Variante | Start | 0.1 s | 0.25 s | 0.5 s | 1.0 s | 1.5 s | Strecke bis <160 | Dauer bis <160 |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  const rows: unknown[] = [];
  for (const v0 of [320, 500, 800]) {
    for (const [name, mk] of [['Original (Duck-Walk)', ORIG], ['Slide', SLIDE()], ['Slide ohne Schub', SLIDE({ boost: 0 })]] as Array<[string, Make]>) {
      const pm = mk(flat);
      settle(pm, new Vector3(0, 1, 0), Math.min(v0, 320));
      pm.state.vel.set(0, 0, -v0);
      const z0 = pm.state.pos.z;
      const at: Record<string, number> = {};
      let dist = NaN;
      let dur = NaN;
      for (let k = 1; k <= 3 * cfg.tickRate; k++) {
        pm.tick(inp({ forward: 1, crouch: true }));
        const t = k * DT;
        for (const m of [0.1, 0.25, 0.5, 1.0, 1.5]) if (Math.abs(t - m) < DT / 2) at[m] = pm.state.speed;
        if (Number.isNaN(dist) && pm.state.speed < 160) {
          dist = z0 - pm.state.pos.z;
          dur = t;
        }
      }
      rows.push({ v0, name, at, dist, dur });
      console.log(`| ${name} | ${v0} | ${f(at[0.1])} | ${f(at[0.25])} | ${f(at[0.5])} | ${f(at[1])} | ${f(at[1.5])} | ${f(dist)} u | ${f(dur, 2)} s |`);
    }
  }
  result.s1 = rows;
}

// ---------------------------------------------------------------- S2 Bhop-Landung ohne Sprung, dann Slide-Hop
function s2(): void {
  console.log('\n## S2 Bhop-Landung mit Tempo v (Ducken gehalten, kein Sprung) — nach g s Bodenzeit springen: Absprungtempo\n');
  console.log('| Variante | v | g = 1 Tick | 0.1 s | 0.2 s | 0.4 s |');
  console.log('|---|---|---|---|---|---|');
  const rows: unknown[] = [];
  for (const v0 of [500, 800, 1100]) {
    for (const [name, mk, crouch] of [['Original, stehend', ORIG, false], ['Original, geduckt', ORIG, true], ['Slide', SLIDE(), true]] as Array<[string, Make, boolean]>) {
      const cells: string[] = [];
      for (const g of [1, Math.round(0.1 * cfg.tickRate), Math.round(0.2 * cfg.tickRate), Math.round(0.4 * cfg.tickRate)]) {
        const pm = mk(flat);
        pm.teleport(new Vector3(0, 40, 0));
        pm.state.vel.set(0, -200, -v0);
        let landed = -1;
        let take = NaN;
        for (let k = 0; k < 3 * cfg.tickRate; k++) {
          const ground = pm.state.onGround;
          if (ground && landed < 0) landed = k;
          const jump = landed >= 0 && k - landed >= g;
          const ev = pm.tick(inp({ forward: 0, crouch, jumpPressed: jump, jumpHeld: jump }));
          if (ev.some((e) => e.type === 'jump')) {
            take = (ev.find((e) => e.type === 'jump') as { speed: number }).speed;
            break;
          }
        }
        cells.push(f(take));
      }
      rows.push({ v0, name, cells });
      console.log(`| ${name} | ${v0} | ${cells.join(' | ')} |`);
    }
  }
  result.s2 = rows;
}

// ---------------------------------------------------------------- S3 Hang: Rutschen bergab/bergauf
function slopeLevel(deg: number, len: number): CompiledLevel {
  const h = Math.tan((deg * Math.PI) / 180) * len;
  const brushes: BrushDef[] = [
    box([-512, -64, 0], [512, 0, 1024], 'top'),
    { type: 'wedge', min: [-512, -h - 64, -len], max: [512, 0, 0], rise: '+z', lowY: -h, mat: 'floor', tag: 'slope' },
    box([-512, -h - 64, -len - 4096], [512, -h, -len], 'runout'),
  ];
  return compileLevel(makeLevel(brushes, { killY: -h - 2000 }));
}

function s3(): void {
  console.log('\n## S3 Begehbarer Hang 1024 u lang, Anlauf 320 oben: Tempo am Hangfuß und Zeit für den Hang (bergab); bergauf: Tempo oben\n');
  console.log('| Hang | Original W (Sprint) | Original geduckt | Slide | Slide bergauf (Start 600) | Original bergauf (Start 600, W) |');
  console.log('|---|---|---|---|---|---|');
  const rows: unknown[] = [];
  for (const deg of [8, 15, 25, 35, 44]) {
    const lv = slopeLevel(deg, 1024);
    const down = (mk: Make, crouch: boolean): string => {
      const pm = mk(lv);
      settle(pm, new Vector3(0, 1, 300), 320);
      let t0 = -1;
      for (let k = 0; k < 8 * cfg.tickRate; k++) {
        pm.tick(inp({ forward: 1, crouch }));
        if (t0 < 0 && pm.state.pos.z < 0) t0 = k;
        if (pm.state.pos.z < -1024) return `${f(pm.state.speed)} u/s · ${f((k - t0) * DT, 2)} s`;
      }
      return 'STALL';
    };
    const up = (mk: Make, crouch: boolean): string => {
      const pm = mk(lv);
      const h = Math.tan((deg * Math.PI) / 180) * 1024;
      settle(pm, new Vector3(0, -h + 1, -1400), 320);
      // Richtung +z (bergauf): Blick yaw = π.
      pm.state.vel.set(0, 0, 600);
      for (let k = 0; k < 6 * cfg.tickRate; k++) {
        pm.tick(inp({ forward: 1, crouch, yaw: Math.PI }));
        if (pm.state.pos.z > 0) return `oben ${f(pm.state.speed)}`;
        if (pm.state.speed < 5 && k > 20) return `bleibt stehen z ${f(pm.state.pos.z)}`;
      }
      return `z ${f(pm.state.pos.z)}`;
    };
    const r = { deg, origW: down(ORIG, false), origDuck: down(ORIG, true), slide: down(SLIDE(), true), slideUp: up(SLIDE(), true), origUp: up(ORIG, false) };
    rows.push(r);
    console.log(`| ${deg}° | ${r.origW} | ${r.origDuck} | ${r.slide} | ${r.slideUp} | ${r.origUp} |`);
  }
  result.s3 = rows;
}

// ---------------------------------------------------------------- S4 Duck-Tunnel
function tunnelLevel(ceil: number, len: number): CompiledLevel {
  const brushes: BrushDef[] = [box([-4096, -64, -8192], [4096, 0, 2048], 'floor'), box([-256, ceil, -600 - len], [256, ceil + 128, -600], 'ceiling'),
    box([-400, 0, -600 - len], [-256, ceil + 128, -600], 'wl'), box([256, 0, -600 - len], [400, ceil + 128, -600], 'wr')];
  return compileLevel(makeLevel(brushes));
}

function s4(): void {
  console.log('\n## S4 Duck-Tunnel (Decke 60 u, 768 u lang). Anflug aus dem Bhop mit v, Landung 150 u vor dem Tunnel, Ducken gehalten\n');
  console.log('| Anflug | Original (Duck-Walk) | Slide | Slide, Landung erst 40 u vorher | Original: Sprint 320 vom Boden, 0.2 s vorher ducken |');
  console.log('|---|---|---|---|---|');
  const lv = tunnelLevel(60, 768);
  const rows: unknown[] = [];
  for (const v0 of [320, 600, 900]) {
    const run = (mk: Make, landBefore: number, fromGround = false): string => {
      const pm = mk(lv);
      if (fromGround) {
        settle(pm, new Vector3(0, 1, -600 + 16 + 64 + 320), 320);
      } else {
        // Fall aus 40 u mit vy −200: Flugzeit ≈ 0.1 s.
        const tFall = (-200 + Math.sqrt(200 * 200 + 2 * 800 * 40)) / 800;
        pm.teleport(new Vector3(0, 41, -600 + 16 + landBefore + v0 * tFall));
        pm.state.vel.set(0, -200, -v0);
      }
      let tin = -1;
      for (let k = 0; k < 20 * cfg.tickRate; k++) {
        const z = pm.state.pos.z;
        const crouch = fromGround ? z < -600 + 16 + 64 : true;
        pm.tick(inp({ forward: 1, crouch }));
        const s = pm.state;
        if (tin < 0 && s.pos.z - 16 < -600) tin = k;
        if (s.pos.z + 16 < -600 - 768) return `${f((k - tin) * DT, 2)} s · raus mit ${f(s.speed)}`;
        if (tin < 0 && s.speed < 5 && k > 60) return `Bonk an der Stirn (z ${f(s.pos.z)})`;
      }
      return 'STALL';
    };
    const r = { v0, orig: run(ORIG, 150), slide: run(SLIDE(), 150), slideLate: run(SLIDE(), 40), origGround: v0 === 320 ? run(ORIG, 0, true) : '' };
    rows.push(r);
    console.log(`| ${v0} | ${r.orig} | ${r.slide} | ${r.slideLate} | ${r.origGround} |`);
  }
  result.s4 = rows;
}

// ---------------------------------------------------------------- S5 Missbrauch: Tempo ohne Strafen
function s5(): void {
  console.log('\n## S5 Missbrauch: nur W (+Maus geradeaus), 12 s flach — mittleres/max. Tempo der letzten 6 s\n');
  console.log('| Strategie | Original Ø / max | Slide Ø / max | Slide-Schübe |');
  console.log('|---|---|---|---|');
  const rows: unknown[] = [];
  const strategies: Array<[string, (pm: PlayerMovement, k: number, st: { land: number; ground: number }) => Partial<PlayerInput>]> = [
    ['Sprint, Leertaste gehalten (Auto-Hop)', () => ({ forward: 1, jumpHeld: true })],
    ['Landung → Rutschen 0.15 s → Sprung', (pm, k, st) => {
      const g = pm.state.onGround;
      const jump = g && k - st.land >= Math.round(0.15 * cfg.tickRate);
      return { forward: 1, crouch: !jump, jumpPressed: jump, jumpHeld: jump };
    }],
    ['Schub-Farmer: 0.26 s laufen → Ducken (Schub) → sofort springen', (pm, k, st) => {
      const g = pm.state.onGround;
      const t = (k - st.land) * DT;
      const crouch = g && t >= 0.26;
      const jump = g && t >= 0.26 + 2 * DT;
      return { forward: 1, crouch, jumpPressed: jump, jumpHeld: jump };
    }],
    ['Schub-Farmer + 1.0 s Rutschen', (pm, k, st) => {
      const g = pm.state.onGround;
      const t = (k - st.land) * DT;
      const crouch = g && t >= 0.26;
      const jump = g && t >= 1.26;
      return { forward: 1, crouch, jumpPressed: jump, jumpHeld: jump };
    }],
    ['Landung → rutschen bis < 300 → Sprung', (pm) => {
      const g = pm.state.onGround;
      const jump = g && pm.state.speed < 300;
      return { forward: 1, crouch: !jump, jumpPressed: jump, jumpHeld: jump };
    }],
  ];
  const variants: Array<[string, Make]> = [['Original', ORIG], ['Slide (50/380/2 s)', SLIDE()], ['Slide (70/400/1 s)', SLIDE({ boost: 70, boostCap: 400, boostCooldown: 1 })]];
  console.log(`(Spalten: ${variants.map((v) => v[0]).join(' | ')})\n`);
  for (const [name, fn] of strategies) {
    const cells: string[] = [];
    let boosts = 0;
    for (const [, mk] of variants) {
      const pm = mk(flat);
      settle(pm, new Vector3(0, 1, 0), 320);
      const st = { land: 0, ground: 0 };
      let sum = 0;
      let n = 0;
      let mx = 0;
      let wasG = true;
      for (let k = 0; k < 12 * cfg.tickRate; k++) {
        const g = pm.state.onGround;
        if (g && !wasG) st.land = k;
        wasG = g;
        pm.tick(inp({ ...fn(pm, k, st) }));
        if (k > 6 * cfg.tickRate) {
          sum += pm.state.speed;
          n++;
          mx = Math.max(mx, pm.state.speed);
        }
      }
      cells.push(`${f(sum / n)} / ${f(mx)}`);
      if (pm instanceof ArcadeMovement) boosts = pm.arcade.boosts;
    }
    rows.push({ name, cells, boosts });
    console.log(`| ${name} | ${cells[0]} | ${cells.slice(1).join(' · ')} | ${boosts} |`);
  }
  // Vergleich: 5°-Hand-Strafer
  const pm = new PlayerMovement(flat.world, cfg);
  settle(pm, new Vector3(0, 1, 0), 320);
  const bot = new StrafeBot(cfg, { aimNoiseDeg: 5, seed: 3, heading: 0 });
  let sum = 0;
  let n = 0;
  for (let k = 0; k < 12 * cfg.tickRate; k++) {
    pm.tick(bot.next(pm.state));
    if (k > 6 * cfg.tickRate) {
      sum += pm.state.speed;
      n++;
    }
  }
  console.log(`| (Referenz: 5°-Hand strafet, Original) | ${f(sum / n)} | | |`);
  result.s5 = rows;
}

// ---------------------------------------------------------------- S6 Bhop unberührt?
function s6(): void {
  console.log('\n## S6 Bhop unberührt? StrafeBot (Sprung im Landetick), 20 Hops ab 320 — Tempo nach 10 s, mit/ohne Ducken in der Luft\n');
  const rows: unknown[] = [];
  for (const crouchInAir of [false, true]) {
    for (const aim of [0, 3]) {
      const cells: string[] = [];
      for (const mk of [ORIG, SLIDE()]) {
        const pm = mk(flat);
        settle(pm, new Vector3(0, 1, 0), 320);
        const bot = new StrafeBot(cfg, { aimNoiseDeg: aim, seed: 5, heading: 0, crouchInAir });
        let slides = 0;
        for (let k = 0; k < 10 * cfg.tickRate; k++) pm.tick(bot.next(pm.state));
        if (pm instanceof ArcadeMovement) slides = pm.arcade.slideTicks;
        cells.push(`${pm.state.speed.toFixed(3)}${pm instanceof ArcadeMovement ? ` (Rutsch-Ticks ${slides})` : ''}`);
      }
      rows.push({ crouchInAir, aim, cells });
      console.log(`- aim ${aim}°, crouchInAir ${crouchInAir}: Original ${cells[0]} | Slide ${cells[1]}`);
    }
  }
  result.s6 = rows;
}

// ---------------------------------------------------------------- S7 Level-Zeiten (Bots rutschen nie)
function s7(): void {
  console.log('\n## S7 Medaillen-Instrument unverändert? timedRun (Spiel-Uhr), Seeds 1–4\n');
  const rows: unknown[] = [];
  for (const id of ['level1', 'level2']) {
    const lv = compileLevel(readLevelFile(`public/levels/${id}.json`));
    for (const model of [{ sync: 1 }, { aimNoiseDeg: 3 }]) {
      const base = [1, 2, 3, 4].map((s) => timedRun(lv, model, s, cfg).time);
      const undo = installGlobal({ slide: SLIDE_DEFAULT });
      const arc = [1, 2, 3, 4].map((s) => timedRun(lv, model, s, cfg).time);
      undo();
      rows.push({ id, model, base, arc });
      console.log(`- ${id} ${JSON.stringify(model)}: Original ${base.map((t) => (t === null ? '–' : t.toFixed(3))).join(' ')} | Slide ${arc.map((t) => (t === null ? '–' : t.toFixed(3))).join(' ')}`);
    }
  }
  result.s7 = rows;
}

// ---------------------------------------------------------------- S8 Kurve rutschen (Lenken)
function s8(): void {
  console.log('\n## S8 Lenken in der Rutsche: Blick 90° gedreht (in 0.3 s), Start 600 — Drehung der Flugrichtung nach 0.5 s / Tempo\n');
  const rows: unknown[] = [];
  for (const rate of [0.8, 1.4, 2.0]) {
    const pm = SLIDE({ steerRate: rate })(flat);
    settle(pm, new Vector3(0, 1, 0), 320);
    pm.state.vel.set(0, 0, -600);
    for (let k = 0; k < Math.round(0.5 * cfg.tickRate); k++) {
      const yaw = Math.min(1, (k * DT) / 0.3) * (Math.PI / 2);
      pm.tick(inp({ crouch: true, yaw }));
    }
    const dir = (Math.atan2(-pm.state.vel.x, -pm.state.vel.z) * 180) / Math.PI;
    rows.push({ rate, dir, speed: pm.state.speed });
    console.log(`- steerRate ${rate} rad/s (${f((rate * 180) / Math.PI)}°/s): Richtung ${f(dir)}°, Tempo ${f(pm.state.speed)}`);
  }
  result.s8 = rows;
}

void withMovement;
s1();
s2();
s3();
s4();
s5();
s6();
s8();
s7();
writeFileSync(`${OUT}/slide.json`, JSON.stringify(result, null, 2));
console.log(`\n→ ${OUT}/slide.json`);
