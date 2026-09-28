/**
 * Level 4 (Turm) — Mess-Skript 1: Kletter-Bausteine isoliert (ändert keinen Projektcode).
 *
 *   npx tsx tools/critique/v2/level4/climb.ts
 *
 * Frage: Wie klettert man ohne Walljump am schnellsten UND verzeihendsten?
 *  A) Terrassen-Treppe (Stufe h, Tiefe D), Stirn senkrecht oder als 40°-Nase
 *  B) durchgehende Rampe (Neigung α), bergauf gehüpft
 *  C) Crouch-Stufen (64 u) — Präzision
 * Fahrer: StrafeBot perfekt / sync 0.8 / Hand 3°, Anfänger W+Space gehalten (Sprint),
 * je ab Einstiegstempo 320/500/700. Gemessen: Zeit für 384 u Höhe, Anpraller
 * (Horizontal-Tempo bricht in einem Tick um > 40 % ein), Tempo oben, Steigrate.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { NaiveBot, StrafeBot } from '../../../../src/player/bots';
import type { Bot } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile } from '../../../../src/world/level/LevelFormat';
import { Frame, LevelBuilder } from '../../../levels/lib';

const OUT = 'shots/v2/level4';
mkdirSync(OUT, { recursive: true });
const cfg = VELOCITY_DEFAULT;
const ENV = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -3000,
};
const GOAL_H = 384;

type Kind = 'terraces' | 'nose' | 'ramp';
interface Spec { readonly kind: Kind; readonly h: number; readonly d: number; readonly slope: number }

function world(s: Spec): LevelFile {
  const L = new LevelBuilder({ id: 'climb', name: 'climb', killY: -2000, environment: ENV });
  const F = new Frame(0, 0, 0);
  L.platform(F, [-1200, 0], [-400, 400], 0, { tag: 'runup' });
  if (s.kind === 'ramp') {
    const len = (GOAL_H + 256) / Math.tan((s.slope * Math.PI) / 180);
    L.ramp(F, [0, len], [-400, 400], 0, GOAL_H + 256, { tag: 'ramp' });
  } else {
    const n = Math.ceil((GOAL_H + 256) / s.h);
    for (let k = 1; k <= n; k++) {
      const u0 = (k - 1) * s.d;
      const u1 = k * s.d;
      if (s.kind === 'nose') {
        // 40°-Nase: begehbare Schräge statt senkrechter Stirn (wie L1-Slalom).
        const run = s.h / Math.tan((40 * Math.PI) / 180);
        L.ramp(F, [u0, u0 + run], [-400, 400], (k - 1) * s.h, k * s.h, { tag: `nose${k}` });
        L.platform(F, [u0 + run, u1], [-400, 400], k * s.h, { tag: `t${k}`, thick: k * s.h + 64 });
      } else L.platform(F, [u0, u1], [-400, 400], k * s.h, { tag: `t${k}`, thick: k * s.h + 64 });
    }
  }
  L.spawn([0, 0, 1000], 0);
  return L.build();
}

interface Res { t: number | null; bonks: number; vTop: number; vMin: number; climb: number }

function run(s: Spec, bot: Bot, v0: number): Res {
  const lv = compileLevel(world(s));
  const pm = new PlayerMovement(lv.world, cfg);
  pm.teleport(new Vector3(0, 1, 300));
  pm.state.vel.set(0, 0, -v0);
  let bonks = 0;
  let prev = v0;
  let vMin = Infinity;
  const T = 12 * cfg.tickRate;
  for (let k = 0; k < T; k++) {
    pm.tick(bot.next(pm.state));
    const sp = pm.state.speed;
    if (prev > 150 && sp < 0.6 * prev) bonks++;
    prev = sp;
    if (pm.state.pos.z < 0) vMin = Math.min(vMin, sp);
    if (pm.state.pos.y >= GOAL_H - 0.5 && pm.state.onGround) {
      const t = (k + 1) / cfg.tickRate;
      // Zeit ab Erreichen des Treppenfußes (z = 0) ist unabhängig vom Anlauf nicht exakt — Anlauf 300 u ist für alle gleich.
      return { t, bonks, vTop: sp, vMin, climb: GOAL_H / t };
    }
  }
  return { t: null, bonks, vTop: pm.state.speed, vMin, climb: 0 };
}

const BOTS: ReadonlyArray<{ name: string; make: (seed: number) => Bot }> = [
  { name: 'perfekt', make: () => new StrafeBot(cfg, { sync: 1, heading: 0 }) },
  { name: 'sync 0.8', make: (s) => new StrafeBot(cfg, { sync: 0.8, seed: s, heading: 0 }) },
  { name: 'Hand 3°', make: (s) => new StrafeBot(cfg, { aimNoiseDeg: 3, seed: s, heading: 0, steerPriority: true }) },
  { name: 'W+Space', make: () => new NaiveBot(cfg, { heading: 0, sprint: true }) },
];

const SPECS: Spec[] = [];
for (const h of [32, 48]) for (const d of [192, 256, 320, 448]) for (const kind of ['terraces', 'nose'] as const) SPECS.push({ kind, h, d, slope: 0 });
for (const slope of [10, 15, 20, 25, 30]) SPECS.push({ kind: 'ramp', h: 0, d: 0, slope });

const rows: string[] = [];
const json: unknown[] = [];
const name = (s: Spec): string => (s.kind === 'ramp' ? `Rampe ${s.slope}°` : `${s.kind === 'nose' ? 'Nase' : 'Stufe'} ${s.h}/${s.d}`);
rows.push(`| Baustein | Fahrer | v0 | Zeit 384 u (s) | Steigrate u/s | Anpraller | Tempo oben | Min. Tempo |`);
rows.push(`|---|---|---|---|---|---|---|---|`);
for (const s of SPECS) {
  for (const b of BOTS) {
    for (const v0 of [320, 500, 700]) {
      const seeds = b.name === 'perfekt' || b.name === 'W+Space' ? [1] : [1, 2, 3, 4];
      const rs = seeds.map((sd) => run(s, b.make(sd), v0));
      const ok = rs.filter((r) => r.t !== null);
      const med = (xs: number[]): number => xs.sort((a, c) => a - c)[Math.floor((xs.length - 1) / 2)] ?? NaN;
      const t = ok.length ? med(ok.map((r) => r.t as number)) : NaN;
      const bonks = rs.reduce((a, r) => a + r.bonks, 0) / rs.length;
      const vTop = ok.length ? med(ok.map((r) => r.vTop)) : NaN;
      const vMin = med(rs.map((r) => r.vMin));
      json.push({ spec: s, bot: b.name, v0, ok: ok.length, runs: rs.length, t, bonks, vTop, vMin });
      rows.push(`| ${name(s)} | ${b.name} | ${v0} | ${ok.length < rs.length ? `${ok.length}/${rs.length} ` : ''}${Number.isFinite(t) ? t.toFixed(2) : '—'} | ${Number.isFinite(t) ? (GOAL_H / t).toFixed(0) : '—'} | ${bonks.toFixed(1)} | ${Number.isFinite(vTop) ? vTop.toFixed(0) : '—'} | ${vMin.toFixed(0)} |`);
    }
  }
}
writeFileSync(`${OUT}/climb.md`, rows.join('\n') + '\n');
writeFileSync(`${OUT}/climb.json`, JSON.stringify(json, null, 1));
console.log(rows.join('\n'));
