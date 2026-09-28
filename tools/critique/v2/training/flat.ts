/**
 * Trainingsmodus-Entwurf (v2/training) — Messung 2: Menschen-Hände auf flachem Boden.
 *
 *   npx tsx tools/critique/v2/training/flat.ts
 *
 * Jede Hand (hands.ts) startet im Stand (Auto-Sprint, Leertaste gehalten = Smart-Auto-Hop)
 * und hüpft 14 s — zigzag (Kurs im Mittel gerade), circle (immer dieselbe Seite = Kreis-Strafe)
 * und steer (Seite zum Ziel). 20 Seeds. Gemessen, was Lektions-Kriterien brauchen:
 *   - Tempo bei Landung nach Hop 3/5/10/15 (Median)
 *   - Hops bis 400 / 500 u/s (Median, Anteil der Seeds, die es in 20 Hops schaffen)
 *   - Anteil Hops mit Gewinn ≥ 8 u/s ("guter Hop" wie Coach STRAFE_GOOD_GAIN)
 *   - längste Serie guter Hops
 *   - seitliche Auslenkung (zigzag: halbe Korridorbreite, steer: Abweichung von der Linie)
 *   - Kreisradius (circle) — Größe einer Übungs-Arena
 * Ausgabe: shots/v2/training/flat.json + Tabelle.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { flatLevel } from '../../../sim/levels';
import { HANDS, HumanHand, withPattern } from './hands';
import type { HandModel } from './hands';

const OUT = 'shots/v2/training';
mkdirSync(OUT, { recursive: true });
const CFG = VELOCITY_DEFAULT;
const DT = 1 / CFG.tickRate;
const level = compileLevel(flatLevel(60000));
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const SECONDS = 14;
const GOOD_GAIN = 8;

interface Run {
  readonly landSpeeds: number[];
  readonly gains: number[];
  readonly lateral: number;
  readonly radius: number;
}

function run(m: HandModel, seed: number): Run {
  const pm = new PlayerMovement(level.world, CFG);
  pm.teleport(new Vector3(0, 0.01, 40000));
  // steer: Ziel weit voraus (−Z), zigzag/circle: Kurs −Z
  const hand = new HumanHand(CFG, m, seed, m.pattern === 'steer' ? { x: 0, z: -40000 } : null, 0);
  const landSpeeds: number[] = [];
  const gains: number[] = [];
  let wasGround = true;
  let takeoff = 0;
  let lateral = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let t = 0; t < SECONDS * CFG.tickRate; t++) {
    const before = pm.state.speed;
    pm.tick(hand.next(pm.state));
    const s = pm.state;
    if (wasGround && !s.onGround) takeoff = before;
    if (!wasGround && s.onGround) {
      landSpeeds.push(s.speed);
      gains.push(s.speed - takeoff);
    }
    wasGround = s.onGround;
    if (t > 3 * CFG.tickRate) {
      lateral = Math.max(lateral, Math.abs(s.pos.x));
      minX = Math.min(minX, s.pos.x);
      maxX = Math.max(maxX, s.pos.x);
      minZ = Math.min(minZ, s.pos.z);
      maxZ = Math.max(maxZ, s.pos.z);
    }
  }
  return { landSpeeds, gains, lateral, radius: Math.max(maxX - minX, maxZ - minZ) / 2 };
}

const med = (a: number[]): number => {
  const b = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return b.length === 0 ? NaN : b[Math.floor(b.length / 2)];
};

const rows: Record<string, unknown>[] = [];
const models: HandModel[] = [];
for (const key of ['neuling', 'anfaenger', 'geuebt', 'nurW', 'gegen', 'keineMaus']) {
  const m = HANDS[key];
  if (key === 'neuling') {
    models.push(m);
    continue;
  }
  models.push(m, withPattern(m, 'circle', { name: `${m.name} · circle` }), withPattern(m, 'steer', { name: `${m.name} · steer` }));
}
// Langsame Maus (30 °/s) — "zu zaghaft"
models.push({ ...HANDS.anfaenger, name: 'Anfänger, Maus 30 °/s', rateDeg: 30 });
models.push({ ...HANDS.anfaenger, name: 'Anfänger, Maus 150 °/s', rateDeg: 150 });
models.push({ ...HANDS.anfaenger, name: 'Anfänger ohne Strafe-Assist (W gehalten)', rateDeg: 60 });

console.log('Hand | H3 | H5 | H10 | H15 | Hops→400 (Anteil) | Hops→500 (Anteil) | gute Hops % | längste Serie (Median) | Auslenkung/Radius u');
for (const m of models) {
  const noAssist = m.name.includes('ohne Strafe-Assist');
  const runs = SEEDS.map((seed) => {
    if (!noAssist) return run(m, seed);
    // ohne Assist: eigene Config
    const saved = CFG;
    return runWith({ ...saved, strafeAssist: false }, m, seed);
  });
  const at = (k: number): number => med(runs.map((r) => r.landSpeeds[k - 1] ?? NaN));
  const hopsTo = (v: number): { med: number; share: number } => {
    const hs = runs.map((r) => {
      const i = r.landSpeeds.findIndex((x) => x >= v);
      return i >= 0 && i < 20 ? i + 1 : Infinity;
    });
    return { med: med(hs), share: hs.filter((h) => Number.isFinite(h)).length / hs.length };
  };
  const allGains = runs.flatMap((r) => r.gains.slice(1));
  const goodShare = allGains.filter((g) => g >= GOOD_GAIN).length / Math.max(1, allGains.length);
  const streaks = runs.map((r) => {
    let best = 0;
    let cur = 0;
    for (const g of r.gains.slice(1)) {
      cur = g >= GOOD_GAIN ? cur + 1 : 0;
      best = Math.max(best, cur);
    }
    return best;
  });
  const h4 = hopsTo(400);
  const h5 = hopsTo(500);
  const spread = m.pattern === 'circle' ? med(runs.map((r) => r.radius)) : med(runs.map((r) => r.lateral));
  const row = {
    hand: m.name,
    h3: at(3),
    h5: at(5),
    h10: at(10),
    h15: at(15),
    to400: h4,
    to500: h5,
    goodShare,
    streakMed: med(streaks),
    streakMin: Math.min(...streaks),
    spread,
  };
  rows.push(row);
  const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(0) : '–');
  console.log(
    `${m.name} | ${f(row.h3)} | ${f(row.h5)} | ${f(row.h10)} | ${f(row.h15)} | ${f(h4.med)} (${Math.round(h4.share * 100)} %) | ${f(h5.med)} (${Math.round(h5.share * 100)} %) | ${Math.round(goodShare * 100)} | ${row.streakMed} (min ${row.streakMin}) | ${f(spread)}`,
  );
}
writeFileSync(`${OUT}/flat.json`, JSON.stringify(rows, null, 1));

function runWith(cfg: typeof CFG, m: HandModel, seed: number): Run {
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(new Vector3(0, 0.01, 40000));
  const hand = new HumanHand(cfg, m, seed, null, 0);
  const landSpeeds: number[] = [];
  const gains: number[] = [];
  let wasGround = true;
  let takeoff = 0;
  let lateral = 0;
  for (let t = 0; t < SECONDS * cfg.tickRate; t++) {
    const before = pm.state.speed;
    pm.tick(hand.next(pm.state));
    const s = pm.state;
    if (wasGround && !s.onGround) takeoff = before;
    if (!wasGround && s.onGround) {
      landSpeeds.push(s.speed);
      gains.push(s.speed - takeoff);
    }
    wasGround = s.onGround;
    if (t > 3 * cfg.tickRate) lateral = Math.max(lateral, Math.abs(s.pos.x));
  }
  void DT;
  return { landSpeeds, gains, lateral, radius: 0 };
}
