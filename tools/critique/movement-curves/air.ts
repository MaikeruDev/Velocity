/**
 * Kritiker-Linse "Movement-Kurven": Luftsteuerung und Anfänger-Modelle.
 * npx tsx tools/critique/movement-curves/air.ts
 */
import { Vector3 } from 'three';
import { CS2_CLASSIC, VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { flatWorld } from '../../sim/scenarios';
import { makeInput } from '../../sim/harness';
import { mulberry32, gaussian } from '../../../src/player/bots/Bot';

const DEG = Math.PI / 180;
const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');

const CFGS: Array<[string, MovementConfig]> = [
  ['VELOCITY (aa40 cap24 128t)', VELOCITY_DEFAULT],
  ['CS2 (aa12 cap30 64t)', CS2_CLASSIC],
  ['VEL cap30', withMovement(VELOCITY_DEFAULT, { airSpeedCap: 30 })],
  ['VEL aa20', withMovement(VELOCITY_DEFAULT, { airAccelerate: 20 })],
  ['CS:GO-KZ (aa100 cap30 128t)', withMovement(CS2_CLASSIC, { tickRate: 128, airAccelerate: 100 })],
];

/** Analytisch pro Tick: Drehung der Flugbahn (Grad/s) für wishdir-Winkel θ zur Flugrichtung. */
function airTick(cfg: MovementConfig, v: number, theta: number): { dv: number; dpsi: number } {
  const ws = cfg.runSpeed;
  const cap = Math.min(ws, cfg.airSpeedCap);
  const current = v * Math.cos(theta);
  const add = cap - current;
  if (add <= 0) return { dv: 0, dpsi: 0 };
  const a = Math.min(cfg.airAccelerate * ws / cfg.tickRate, add);
  const vx = v + a * Math.cos(theta);
  const vy = a * Math.sin(theta);
  return { dv: Math.hypot(vx, vy) - v, dpsi: Math.atan2(vy, vx) };
}

console.log('## Luft-Drehrate (reines A/D, Bahn-Drehung in °/s)\n');
console.log('| Preset | v | Gewinn-Optimum: °/s, +u/s pro s | max. °/s ohne Verlust | max. °/s bei -5% Speed/s | Luftbremse S: u/s² |');
console.log('|---|---|---|---|---|---|');
for (const [name, cfg] of CFGS) {
  for (const v of [300, 600, 1000]) {
    let best = { dv: -Infinity, dpsi: 0 };
    let neutral = 0;
    let loss5 = 0;
    for (let th = 0; th <= Math.PI; th += 0.0005) {
      const r = airTick(cfg, v, th);
      if (r.dv > best.dv) best = r;
      if (r.dv >= -1e-9 && r.dpsi > neutral) neutral = r.dpsi;
      if (r.dv * cfg.tickRate >= -0.05 * v && r.dpsi > loss5) loss5 = r.dpsi;
    }
    const brake = airTick(cfg, v, Math.PI).dv * cfg.tickRate;
    console.log(`| ${name} | ${v} | ${f(best.dpsi / DEG * cfg.tickRate)}°/s, +${f(best.dv * cfg.tickRate)} | ${f(neutral / DEG * cfg.tickRate)} | ${f(loss5 / DEG * cfg.tickRate)} | ${f(brake)} |`);
  }
}

/**
 * Hand-Modell "Schwung": pro Luftabschnitt dreht die Maus mit konstanter Rate R
 * (Start: Blick = Flugrichtung + offsetDeg in Drehrichtung), A/D passend, optional W.
 * Richtung wechselt pro Hop (Zickzack). keyDelayMs: Taste kommt erst so spät nach
 * dem Absprung (typischer Anfänger), wrong: Taste gegen die Maus.
 */
interface Hand {
  rateDeg: number;
  holdW?: boolean;
  /** Keine A/D-Taste (reines W) — sonst drückte 'nur W' still A/D mit (Prüfung 27.09.: 322 → 336 war ein Artefakt). */
  noSide?: boolean;
  keyDelayMs?: number;
  offsetDeg?: number;
  wrong?: boolean;
  noiseDeg?: number;
  seed?: number;
  jumpDelayTicks?: number; // ohne AutoHop: Sprung erst n Ticks nach Landung
}

function handRun(cfg: MovementConfig, hand: Hand, v0: number, hops: number): number[] {
  const c = hand.jumpDelayTicks !== undefined ? withMovement(cfg, { autoHop: false, jumpBufferTime: 0 }) : cfg;
  const pm = new PlayerMovement(flatWorld().world, c);
  pm.teleport(new Vector3(0, 0, 12000));
  pm.state.vel.set(0, 0, -v0);
  const rand = mulberry32(hand.seed ?? 3);
  let dir = 1; // +1 links (A)
  let yaw = 0;
  let airT = 0;
  let wasGround = true;
  let groundTicks = 0;
  let aim = 0;
  const lands: number[] = [];
  const dt = 1 / c.tickRate;
  for (let t = 0; t < 60 * c.tickRate && lands.length < hops; t++) {
    const s = pm.state;
    if (s.onGround) {
      groundTicks++;
    }
    if (!s.onGround && wasGround) {
      // neuer Luftabschnitt
    }
    const psiV = Math.atan2(-s.vel.x, -s.vel.z);
    if (s.onGround || airT === 0) {
      // Absprung-Tick: Blick = Flugrichtung + Offset
      yaw = psiV + dir * (hand.offsetDeg ?? 0) * DEG;
    } else {
      yaw += dir * hand.rateDeg * DEG * dt;
    }
    if (hand.noiseDeg) {
      const k = Math.exp(-1 / (0.15 * c.tickRate));
      aim = aim * k + gaussian(rand) * hand.noiseDeg * DEG * Math.sqrt(1 - k * k);
    }
    const keyOn = airT * 1000 >= (hand.keyDelayMs ?? 0);
    const sideKey = (hand.wrong ? -1 : 1) * (dir > 0 ? -1 : 1);
    const jumpNow = hand.jumpDelayTicks === undefined ? true : s.onGround && groundTicks > hand.jumpDelayTicks;
    const inp = makeInput({
      yaw: yaw + aim,
      side: keyOn && !hand.noSide ? sideKey : 0,
      forward: hand.holdW ? 1 : 0,
      jumpHeld: hand.jumpDelayTicks === undefined,
      jumpPressed: jumpNow,
    });
    const ev = pm.tick(inp);
    for (const e of ev) {
      if (e.type === 'land') { lands.push(e.speed); dir = -dir; groundTicks = 0; }
    }
    if (pm.state.onGround) airT = 0; else airT += dt;
    wasGround = pm.state.onGround;
  }
  return lands;
}

function avgRun(cfg: MovementConfig, hand: Hand, v0: number, hops: number, seeds = 1): number[] {
  const acc: number[] = new Array(hops).fill(0);
  for (let s = 1; s <= seeds; s++) {
    const r = handRun(cfg, { ...hand, seed: s * 101 }, v0, hops);
    for (let i = 0; i < hops; i++) acc[i] += (r[i] ?? Number.NaN) / seeds;
  }
  return acc;
}

console.log('\n## Anfänger-Hände ab Sprint 320 (Zickzack, Richtung wechselt pro Hop, AutoHop)\n');
console.log('Speed bei Landung nach Hop 1/2/3/5/10. Blick startet auf der Flugrichtung (nicht am Optimum).\n');
const hands: Array<[string, Hand]> = [
  ['Maus 45°/s, A/D', { rateDeg: 45 }],
  ['Maus 90°/s, A/D', { rateDeg: 90 }],
  ['Maus 135°/s, A/D', { rateDeg: 135 }],
  ['Maus 180°/s, A/D', { rateDeg: 180 }],
  ['Maus 90°/s, A/D + W gehalten', { rateDeg: 90, holdW: true }],
  ['Maus 135°/s, A/D + W gehalten', { rateDeg: 135, holdW: true }],
  ['Maus 90°/s, Taste 150 ms zu spät', { rateDeg: 90, keyDelayMs: 150 }],
  ['Maus 90°/s, Taste GEGEN Maus', { rateDeg: 90, wrong: true }],
  ['Maus 90°/s + 3° Zitter', { rateDeg: 90, noiseDeg: 3 }],
  ['Maus 135°/s + 5° Zitter', { rateDeg: 135, noiseDeg: 5 }],
  ['nur W (Naive)', { rateDeg: 0, holdW: true, noSide: true }],
];
console.log('| Hand | Preset | H1 | H2 | H3 | H5 | H10 | Kurswinkel pro Hop |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [label, hand] of hands) {
  for (const [name, cfg] of CFGS.slice(0, 3)) {
    const r = avgRun(cfg, hand, 320, 10, hand.noiseDeg ? 5 : 1);
    console.log(`| ${label} | ${name} | ${f(r[0])} | ${f(r[1])} | ${f(r[2])} | ${f(r[4])} | ${f(r[9])} | ${f(hand.rateDeg * 0.75)}° |`);
  }
}

console.log('\n## Verpasstes Timing ohne AutoHop (Sprung n Ticks nach Landung), perfekte Hand 135°/s, ab 500\n');
console.log('| Verzögerung | VEL H1 | H3 | H5 | CS2 H1 | H3 | H5 |');
console.log('|---|---|---|---|---|---|---|');
for (const d of [0, 1, 2, 4, 8, 16]) {
  const a = handRun(VELOCITY_DEFAULT, { rateDeg: 135, jumpDelayTicks: d }, 500, 5);
  const b = handRun(CS2_CLASSIC, { rateDeg: 135, jumpDelayTicks: Math.round(d / 2) }, 500, 5);
  console.log(`| ${d} Ticks (${f(d / 128 * 1000)} ms) | ${f(a[0])} | ${f(a[2])} | ${f(a[4])} | ${f(b[0])} | ${f(b[2])} | ${f(b[4])} |`);
}
