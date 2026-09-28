/**
 * KANTEN-ASSIST (Lip-Step + Momentum-Gedächtnis) — Messung gegen die echte Engine.
 *   npx tsx tools/critique/v2/arcade-mechanics/ledge.ts [A B C D E F G H]
 * Ausgabe: shots/v2/arcade-mechanics/ledge.json + Konsole.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { RunState } from '../../../../src/engine/runState';
import type { RunEvent } from '../../../../src/engine/events';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { RouteFollower, StrafeBot } from '../../../../src/player/bots';
import type { MutablePlayerInput, PlayerInput } from '../../../../src/player/types';
import { NO_INPUT } from '../../../../src/player/types';
import type { CollisionWorld } from '../../../../src/world/collision/types';
import { compileLevel, type CompiledLevel } from '../../../../src/world/level/compileLevel';
import { box, makeLevel, readLevelFile } from '../../../sim/levels';
import { SurfRider, resumeIndex, routeAxis } from '../../../levels/physics';
import { designProbes } from '../../../levels/designProbes';
import { LEDGE_DEFAULT, arcadeClass, arcadeStats, installGlobal, type ArcadeOpts } from './ArcadeMovement';

const OUT = 'shots/v2/arcade-mechanics';
mkdirSync(OUT, { recursive: true });
const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;
const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');
const result: Record<string, unknown> = {};
const only = new Set(process.argv.slice(2));
const want = (k: string): boolean => only.size === 0 || only.has(k);

type Ctor = new (w: CollisionWorld, c: MovementConfig) => PlayerMovement;
const V = (name: string, opts: ArcadeOpts | null): [string, Ctor] => [name, opts ? arcadeClass(opts) : PlayerMovement];
const VARIANTS: Array<[string, Ctor]> = [
  V('Original', null),
  V('Lip 4', { ledge: { height: 4, memory: 0 } }),
  V('Lip 6', { ledge: { height: 6, memory: 0 } }),
  V('Lip 8', { ledge: { height: 8, memory: 0 } }),
  V('Lip 12', { ledge: { height: 12, memory: 0 } }),
  V('Lip 18 (Q3-AirStep)', { ledge: { height: 18, memory: 0 } }),
  V('Gedächtnis 0.2 s', { ledge: { height: 0, memory: 0.2 } }),
  V('Gedächtnis + Lip 5', { ledge: LEDGE_DEFAULT }),
];
const MAIN: Array<[string, Ctor]> = [VARIANTS[0], VARIANTS[7]];

function inp(p: Partial<PlayerInput>): MutablePlayerInput {
  return { ...NO_INPUT, sprint: true, ...p };
}

const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
const L2 = compileLevel(readLevelFile('public/levels/level2.json'));
const tagged = (lv: CompiledLevel, tag: string) => {
  const b = lv.brushes.find((x) => x.tag === tag);
  if (!b) throw new Error(`Tag ${tag} fehlt`);
  return b;
};

// ---------------------------------------------------------------- A/B/C Crouch-Kante L1
const h7 = tagged(L1, 'hop7');
const ledge = tagged(L1, 'ledge');
const H7X = (h7.bounds.min.x + h7.bounds.max.x) / 2;
const H7TOP = h7.bounds.max.y;
const onLedge = new Box3(new Vector3(ledge.bounds.min.x, ledge.bounds.max.y - 2, ledge.bounds.min.z), ledge.bounds.max.clone().setY(ledge.bounds.max.y + 4));
const zs: number[] = [];
for (let z = h7.bounds.max.z - 16; z >= h7.bounds.min.z + 16.5; z -= 8) zs.push(z);
const speeds = [320, 450, 600, 761, 900];

/** Tempo beim Erreichen der Kante (letzter hopH7-Aufruf), NaN bei Fehlschlag. */
let lastArrive = NaN;
/** Hop von H7 nach Norden (W gehalten); crouchAt(k, bonkTick) entscheidet das Ducken. */
function hopH7(K: Ctor, z: number, v: number, crouchAt: (k: number, bonk: number) => boolean): boolean {
  const pm = new K(L1.world, cfg);
  pm.teleport(new Vector3(H7X, H7TOP + 0.03125, z));
  pm.state.vel.set(0, 0, -v);
  let bonk = -1;
  let prev = v;
  lastArrive = NaN;
  const hmin = new Vector3();
  const hmax = new Vector3();
  for (let k = 0; k < 1.5 * cfg.tickRate; k++) {
    pm.tick(inp({ forward: 1, jumpPressed: k === 0, jumpHeld: k === 0, crouch: crouchAt(k, bonk) }));
    const s = pm.state;
    if (bonk < 0 && !s.onGround && s.speed < prev * 0.5) bonk = k;
    prev = s.speed;
    hmin.copy(s.pos).add(pm.hullMins);
    hmax.copy(s.pos).add(pm.hullMaxs);
    if (onLedge.intersectsBox(new Box3(hmin, hmax))) {
      lastArrive = s.speed;
      return true;
    }
    if (s.onGround && k > 10 && s.pos.y < H7TOP + 1) return false;
  }
  return false;
}

function secA(): void {
  console.log('\n## A Crouch-Kante L1 (64 u) OHNE Ducken: W, Sprung an jeder Stelle von H7, 5 Tempi — Erfolge\n');
  const rows: unknown[] = [];
  for (const [name, K] of VARIANTS) {
    let ok = 0;
    let n = 0;
    for (const v of speeds) for (const z of zs) {
      n++;
      if (hopH7(K, z, v, () => false)) ok++;
    }
    rows.push({ name, ok, n });
    console.log(`- ${name.padEnd(22)} ${ok}/${n}`);
  }
  result.A = rows;
}

function secB(): void {
  console.log('\n## B Crouch-Kante MIT Ducken (sofort nach Absprung): längste Absprungzone je Tempo (u) — wird sie breiter?\n');
  const rows: unknown[] = [];
  for (const [name, K] of MAIN) {
    const cells: string[] = [];
    for (const v of speeds) {
      let best = 0;
      let streak = 0;
      let okAll = 0;
      let slow = 0;
      for (const z of zs) {
        const ok = hopH7(K, z, v, (k) => k >= 1);
        if (ok) okAll++;
        if (ok && lastArrive < 0.5 * v) slow++;
        streak = ok ? streak + 8 : 0;
        best = Math.max(best, streak);
      }
      cells.push(`${v}: ${best} u (${okAll}/${zs.length}, ${slow} gekrochen)`);
    }
    rows.push({ name, cells });
    console.log(`- ${name.padEnd(22)} ${cells.join(' · ')}`);
  }
  result.B = rows;
}

function secC(): void {
  console.log('\n## C Zu spät geduckt: Ducken erst X ms NACH dem Stirnwand-Anprall — Erfolge (alle Startpunkte × 5 Tempi)\n');
  const rows: unknown[] = [];
  const delays = [0, 16, 31, 63, 102, 148];
  console.log(`| Variante | ${delays.map((d) => `+${d} ms`).join(' | ')} |`);
  console.log(`|---|${delays.map(() => '---').join('|')}|`);
  for (const [name, K] of MAIN) {
    const cells: string[] = [];
    for (const ms of delays) {
      const dk = Math.round((ms / 1000) * cfg.tickRate);
      let ok = 0;
      let n = 0;
      let vs = 0;
      let slow = 0;
      for (const v of speeds) for (const z of zs) {
        n++;
        if (hopH7(K, z, v, (k, bonk) => bonk >= 0 && k >= bonk + dk)) {
          ok++;
          vs += lastArrive / v;
          if (lastArrive < 0.5 * v) slow++;
        }
      }
      cells.push(`${ok}/${n}, Ø ${f((100 * vs) / Math.max(1, ok))} % Tempo, ${slow}× < 50 %`);
    }
    rows.push({ name, cells });
    console.log(`| ${name} | ${cells.join(' | ')} |`);
  }
  result.C = rows;
}

// ---------------------------------------------------------------- D Stufen-Lücke (synthetisch)
function secD(): void {
  console.log('\n## D Sprung über 128-u-Lücke auf höhere Plattform (senkrechte Stirn), W gehalten, kein Strafen, kein Ducken');
  console.log('Raster: Tempo 250…800 (Δ50) × Absprung 0…420 u vor der Kante (Δ4). "Reichweite" = weitester Absprung, der noch oben ankommt.\n');
  const rows: unknown[] = [];
  const hs = [0, 32, 48, 56];
  console.log(`| Variante | ${hs.map((h) => `+${h}: ok / Δ-Reichweite Ø`).join(' | ')} |`);
  console.log(`|---|${hs.map(() => '---').join('|')}|`);
  const base: Record<number, Map<number, number>> = {};
  for (const [name, K] of VARIANTS) {
    const cells: string[] = [];
    for (const h of hs) {
      const lv = compileLevel(makeLevel([box([-512, -64, 0], [512, 0, 2048], 'A'), box([-512, -64, -2048 - 128], [512, h, -128], 'B')], { killY: -300 }));
      let ok = 0;
      let n = 0;
      const reach = new Map<number, number>();
      for (let v = 250; v <= 800; v += 50) {
        let far = -1;
        for (let d = 0; d <= 420; d += 4) {
          n++;
          const pm = new K(lv.world, cfg);
          pm.teleport(new Vector3(0, 0.03125, d + 16));
          pm.state.vel.set(0, 0, -v);
          let made = false;
          for (let k = 0; k < 3 * cfg.tickRate; k++) {
            pm.tick(inp({ forward: 1, jumpPressed: k === 0, jumpHeld: false }));
            const s = pm.state;
            if (s.onGround && s.pos.z < -128 - 16 && s.pos.y > h - 1) { made = true; break; }
            if (s.pos.y < -250) break;
            if (s.onGround && k > 4 && s.pos.z > -64 && s.pos.y < 1) break;
          }
          if (made) { ok++; far = Math.max(far, d); }
        }
        reach.set(v, far);
      }
      if (name === 'Original') base[h] = reach;
      let dsum = 0;
      let dn = 0;
      for (const [v, far] of reach) {
        const b = base[h]?.get(v) ?? -1;
        if (far >= 0 && b >= 0) { dsum += far - b; dn++; }
      }
      cells.push(`${ok}/${n} / ${dn ? f(dsum / dn, 1) : '–'} u`);
    }
    rows.push({ name, cells });
    console.log(`| ${name} | ${cells.join(' | ')} |`);
  }
  result.D = rows;
}

// ---------------------------------------------------------------- E Hop-Reihe L1 (W+Leertaste, ohne Strafen) und 3°-Hand
function secE(): void {
  console.log('\n## E L1 Hop-Reihe ab Knoten "Hop-Reihe": W + Leertaste gehalten (320–800 × 20 Startpunkte) und 3°-Hand ohne Zielen (8 Seeds × 3 Tempi): bis H7 / tot\n');
  const route = L1.def.route ?? [];
  const i0 = route.findIndex((n) => n.note === 'Hop-Reihe');
  const i1 = route.findIndex((n) => n.crouch === true);
  const start = route[i0].pos;
  const goalZ = route[i1].pos[2] + 64;
  const rows: unknown[] = [];
  for (const [name, K] of MAIN) {
    let reached = 0;
    let dead = 0;
    let runs = 0;
    for (let v0 = 320; v0 <= 800; v0 += 40) {
      for (let off = 0; off < 240; off += 12) {
        runs++;
        const pm = new K(L1.world, cfg);
        pm.teleport(new Vector3(start[0], start[1] + 0.03125, start[2] - off));
        pm.state.vel.set(0, 0, -v0);
        for (let t = 0; t < 10 * cfg.tickRate; t++) {
          pm.tick(inp({ forward: 1, jumpHeld: true, jumpPressed: t === 0 }));
          if (pm.state.pos.y < start[1] - 40) { dead++; break; }
          if (pm.state.pos.z < goalZ) { reached++; break; }
        }
      }
    }
    let ok3 = 0;
    let n3 = 0;
    for (let seed = 1; seed <= 8; seed++) for (const v0 of [320, 400, 480]) {
      n3++;
      const pm = new K(L1.world, cfg);
      pm.teleport(new Vector3(start[0], start[1] + 0.03125, start[2]));
      pm.state.vel.set(0, 0, -v0);
      const bot = new StrafeBot(cfg, { aimNoiseDeg: 3, seed: seed * 17, heading: 0 });
      for (let t = 0; t < 12 * cfg.tickRate; t++) {
        pm.tick(bot.next(pm.state));
        if (pm.state.pos.y < start[1] - 40) break;
        if (pm.state.pos.z < goalZ) { ok3++; break; }
      }
    }
    rows.push({ name, reached, dead, runs, ok3, n3 });
    console.log(`- ${name.padEnd(22)} W+Space: ${reached}/${runs} bis H7, ${dead} in den Graben | 3°-Hand: ${ok3}/${n3}`);
  }
  result.E = rows;
}

// ---------------------------------------------------------------- F Surf-Kette L2 bitgleich?
function secF(): void {
  console.log('\n## F L2 Surf ab CP2, Grundtechnik-Surfer mit Blickversatz — Ankunft (u/s @ s)\n');
  const axisAt = routeAxis(L2.def.route ?? []);
  const cp2 = L2.triggers.find((t) => t.kind === 'checkpoint' && t.order === 2);
  if (!cp2) throw new Error('cp2');
  const rows: unknown[] = [];
  for (const [name, K] of MAIN) {
    const cells: string[] = [];
    for (const o of [-2, 0, 2, 3, 5]) {
      const pm = new K(L2.world, cfg);
      pm.teleport(cp2.spawnPos.clone().add(new Vector3(0, 1, 0)));
      const r = new SurfRider(cfg, L2.world, axisAt, (o * Math.PI) / 180);
      let res = 'STALL';
      for (let t = 0; t < 25 * cfg.tickRate; t++) {
        pm.tick(r.next(pm.state, pm.surfNormal));
        if (pm.state.pos.z < -7300) { res = `${pm.state.speed.toFixed(2)}@${(t * DT).toFixed(2)}s`; break; }
        if (pm.state.pos.y < -2500) { res = 'fällt'; break; }
      }
      cells.push(`${o}°: ${res}`);
    }
    rows.push({ name, cells });
    console.log(`- ${name.padEnd(22)} ${cells.join(' · ')}`);
  }
  result.F = rows;
}

// ---------------------------------------------------------------- G Volle Läufe (Spiel-Uhr) + Zählung
function timedRunK(K: Ctor, level: CompiledLevel, model: { sync?: number; aimNoiseDeg?: number }, seed: number) {
  const route = level.def.route ?? [];
  const pm = new K(level.world, cfg);
  const run = new RunState(level);
  run.reset(null);
  const events: RunEvent[] = [];
  const cps = level.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
  const place = (p: Vector3): void => pm.teleport(new Vector3(p.x, p.y + 1, p.z));
  const follower = (from: number, start: Vector3): RouteFollower =>
    new RouteFollower(route.slice(from), cfg, { sync: model.sync, aimNoiseDeg: model.aimNoiseDeg, seed, killY: level.def.killY, world: level.world, start: { x: start.x, z: start.z }, stallTimeout: 12, timeout: 181 });
  place(level.spawnPos);
  let bot = follower(0, level.spawnPos);
  let deaths = 0;
  let bonks = 0;
  let prev = 0;
  for (let t = 0; t < 180 * cfg.tickRate; t++) {
    const wasAir = !pm.state.onGround;
    pm.tick(bot.next(pm.state, pm.surfNormal));
    const s = pm.state;
    if (wasAir && !s.onGround && !s.surfing && prev > 200 && s.speed < prev * 0.6) bonks++;
    prev = s.speed;
    const out = run.tick(DT, s.pos, pm.hullMins, pm.hullMaxs, s.speed, s.onGround, events);
    if (out === 'finish') return { time: run.time, deaths, bonks, st: pm instanceof PlayerMovement && K !== PlayerMovement ? { ...arcadeStats(pm) } : null };
    if (out === 'fall' || out === 'kill') {
      deaths++;
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      place(sp.pos);
      const from = run.checkpoint > 0 ? Math.max(0, resumeIndex(route, cps[run.checkpoint - 1])) : 0;
      bot = follower(from, sp.pos);
      continue;
    }
    if (bot.status === 'failed') return { time: null, deaths, bonks, st: null };
  }
  return { time: null, deaths, bonks, st: null };
}

function secG(): void {
  console.log('\n## G Volle Läufe (RouteFollower, Spiel-Uhr, Seeds 1–8): Median-Zeit, Ziel, Tode, Luft-Anpraller (Tempo −40 % in einem Luft-Tick), Lip-Steps/Restores\n');
  const rows: unknown[] = [];
  for (const [id, lv] of [['level1', L1], ['level2', L2]] as Array<[string, CompiledLevel]>) {
    for (const model of [{ sync: 1 }, { aimNoiseDeg: 2 }, { aimNoiseDeg: 3 }]) {
      const cells: string[] = [];
      for (const [name, K] of MAIN) {
        const rs = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => timedRunK(K, lv, model, s));
        const times = rs.map((r) => r.time ?? Infinity).sort((a, b) => a - b);
        const fin = rs.filter((r) => r.time !== null).length;
        const d = rs.reduce((a, r) => a + r.deaths, 0);
        const b = rs.reduce((a, r) => a + r.bonks, 0);
        const lip = rs.reduce((a, r) => a + (r.st?.lipSteps ?? 0), 0);
        const rest = rs.reduce((a, r) => a + (r.st?.restores ?? 0), 0);
        cells.push(`${name}: ${f(times[3], 3)} s, ${fin}/8, Tode ${d}, Anpraller ${b}${K === PlayerMovement ? '' : `, Lip ${lip}, Restore ${rest}`}`);
        rows.push({ id, model, name, times, fin, deaths: d, bonks: b, lip, rest });
      }
      console.log(`- ${id} ${JSON.stringify(model)}: ${cells.join(' | ')}`);
    }
  }
  result.G = rows;
}

// ---------------------------------------------------------------- H Design-Proben mit Assist
function secH(): void {
  console.log('\n## H designProbes (Validator) mit global installiertem Assist (Gedächtnis + Lip 5)\n');
  const rows: unknown[] = [];
  for (const lv of [L1, L2]) {
    const a = designProbes(lv, cfg);
    const undo = installGlobal({ ledge: LEDGE_DEFAULT });
    let b;
    try {
      b = designProbes(lv, cfg);
    } finally {
      undo();
    }
    rows.push({ id: lv.def.id, base: a, arc: b });
    console.log(`- ${lv.def.id}: Original Fehler ${a.errors.length} / Warnungen ${a.warnings.length} → Assist Fehler ${b.errors.length} / Warnungen ${b.warnings.length}`);
    for (const e of b.errors) if (!a.errors.includes(e)) console.log(`    NEU Fehler: ${e}`);
    for (const e of b.warnings) if (!a.warnings.includes(e)) console.log(`    NEU Warnung: ${e}`);
    for (const e of a.errors) if (!b.errors.includes(e)) console.log(`    WEG Fehler: ${e}`);
    for (const i of b.info) if (!a.info.includes(i)) console.log(`    Info neu: ${i}`);
  }
  result.H = rows;
}

if (want('A')) secA();
if (want('B')) secB();
if (want('C')) secC();
if (want('D')) secD();
if (want('E')) secE();
if (want('F')) secF();
if (want('H')) secH();
if (want('G')) secG();
writeFileSync(`${OUT}/ledge${only.size ? '-' + [...only].join('') : ''}.json`, JSON.stringify(result, null, 2));
console.log(`\n→ ${OUT}/ledge.json`);
