/**
 * Lande-Gnade (keine Friction in den ersten N Bodenticks nach einer Landung) — Nutzen und Exploits.
 * npx tsx tools/critique/v2/momentum/grace.ts
 *
 * A) Später Sprung: Landung mit v, Sprung k Ticks nach dem Lande-Tick (frischer Druck, keine Taste gehalten).
 * B) Tipp-Hand: perfekter Luft-Strafe, aber der Sprung kommt mit menschlichem Timing-Rauschen
 *    (σ ms um die Landung, früh = Puffer = perfekt, spät = Bodenticks). Tempo nach Hop 5/10/20.
 * C) Exploit-Probe: Landung mit 500 u/s, dann im Boden-Fenster optimal "ground-strafen" (W+D,
 *    Blick so, dass v·wishdir = wish − a), danach springen. Mit/ohne Schub-Kappe.
 * D) Landung ohne Sprung (Drop in einen Lauf, W gehalten): Tempo nach 0.1/0.25/0.5 s.
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { StrafeBot } from '../../../../src/player/bots';
import { gaussian } from '../../../../src/player/bots/Bot';
import { flatWorld } from '../../../sim/scenarios';
import { makeInput, rng } from '../../../sim/harness';
import { setMomentum, MOM_STATS } from './patch';
import { f, stats } from './common';

const cfg = VELOCITY_DEFAULT;
const TR = cfg.tickRate;
const VARIANTS: Array<[string, Parameters<typeof setMomentum>[0]]> = [
  ['vorher', 'off'],
  ['Gnade 4', { grace: true, graceTicks: 4 }],
  ['Gnade 8', { grace: true, graceTicks: 8 }],
  ['Gnade 12', { grace: true, graceTicks: 12 }],
  ['Gnade 16', { grace: true, graceTicks: 16 }],
];

function use(v: Parameters<typeof setMomentum>[0]): void {
  setMomentum('off');
  if (v !== 'off') setMomentum(v);
}

/** Spieler knapp über dem Boden, fällt mit Hop-Aufprall (vy −302) und v horizontal. */
function lander(v: number): PlayerMovement {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 30, 0));
  pm.state.vel.set(0, -250, -v);
  // Eine echte Luftphase simulieren (landAirTime ≥ 0.25 s): kurz hochwerfen.
  pm.state.vel.y = 200;
  return pm;
}

function lateJump(v: number, k: number): number {
  const pm = lander(v);
  let landTick = -1;
  for (let t = 0; t < 3 * TR; t++) {
    const press = landTick >= 0 && t === landTick + 1 + k;
    const ev = pm.tick(makeInput({ yaw: 0, jumpPressed: press, jumpHeld: press }));
    for (const e of ev) {
      if (e.type === 'land' && landTick < 0) landTick = t;
      if (e.type === 'jump') return e.speed;
    }
  }
  return Number.NaN;
}

function tableA(): void {
  console.log('\n## A) Später Sprung: Absprungtempo, wenn der Druck k Ticks nach dem Lande-Tick kommt\n');
  const ks = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24];
  console.log(`| v | Variante | ${ks.map((k) => `k=${k} (${f((k * 1000) / TR)} ms)`).join(' | ')} |`);
  console.log(`|---|---|${ks.map(() => '---').join('|')}|`);
  for (const v of [400, 700, 1000]) {
    for (const [name, opt] of VARIANTS) {
      use(opt);
      console.log(`| ${v} | ${name} | ${ks.map((k) => f(lateJump(v, k))).join(' | ')} |`);
    }
  }
  use('off');
}

/** Tipp-Hand: σ ms Timing-Rauschen um den Lande-Tick (Mittel μ ms, positiv = spät). */
function tapHand(muMs: number, sigmaMs: number, seed: number, hops: number): number[] {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 15000));
  pm.state.vel.set(0, 0, -320);
  const bot = new StrafeBot(cfg, { heading: 0 });
  const rand = rng(seed);
  // Der Bot springt sonst sofort; wir übernehmen den Sprung.
  let pressAt = 0; // Tick des nächsten Drucks (absolut)
  let airborneSince = -1;
  let predictedLand = -1;
  const lands: number[] = [];
  let t = 0;
  // Landezeitpunkt vorhersagen: flach, Luftzeit ≈ 0.75 s → Lande-Tick = Absprung + 96.
  for (; t < (hops + 2) * 1.2 * TR && lands.length < hops; t++) {
    const inp = bot.next(pm.state);
    const out = { ...inp, jumpHeld: false, jumpPressed: t === pressAt };
    for (const e of pm.tick(out)) {
      if (e.type === 'jump') {
        airborneSince = t;
        predictedLand = t + Math.round(0.7505 * TR);
        const offMs = muMs + sigmaMs * gaussian(rand);
        pressAt = predictedLand + 1 + Math.round((offMs / 1000) * TR);
        if (pressAt <= airborneSince) pressAt = airborneSince + 1;
      }
      if (e.type === 'land') lands.push(e.speed);
    }
    // Liegt man am Boden, ohne dass ein Druck kommt (zu früh gedrückt, Puffer abgelaufen): nächster Druck = jetzt + Reaktion.
    if (pm.state.onGround && t > pressAt) pressAt = t + 1 + Math.round(((muMs + 60) / 1000) * TR);
  }
  return lands;
}

function tableB(): void {
  console.log('\n## B) Tipp-Hand (perfekter Strafe, menschliches Sprung-Timing): Landetempo H5 / H10 / H20, Median 8 Seeds\n');
  console.log('| Timing (μ ± σ ms, + = spät) | vorher | Gnade 4 | Gnade 8 | Gnade 12 | Gnade 16 |');
  console.log('|---|---|---|---|---|---|');
  for (const [mu, sigma] of [[0, 10], [0, 20], [10, 20], [20, 30], [30, 40]] as const) {
    const cols: string[] = [];
    for (const [, opt] of VARIANTS) {
      use(opt);
      const h: number[][] = [[], [], []];
      for (let seed = 1; seed <= 8; seed++) {
        const l = tapHand(mu, sigma, seed * 101, 20);
        h[0].push(l[4] ?? 0);
        h[1].push(l[9] ?? 0);
        h[2].push(l[19] ?? 0);
      }
      cols.push(h.map((xs) => f(stats(xs).med)).join(' / '));
    }
    console.log(`| ${mu} ± ${sigma} | ${cols.join(' | ')} |`);
  }
  use('off');
  const perfect = tapHand(-20, 0, 1, 20);
  console.log(`\nReferenz: immer im Puffer (−20 ms, σ 0): H5/H10/H20 ${f(perfect[4])} / ${f(perfect[9])} / ${f(perfect[19])}`);
}

/** Ground-Strafe mit optimalem Winkel für n Bodenticks nach einer 500er-Landung, dann Sprung. */
function groundStrafe(nTicks: number): { takeoff: number; best: number } {
  const pm = lander(500);
  let landTick = -1;
  let best = 0;
  const wish = cfg.sprintSpeed;
  const a = (cfg.accelerate * wish) / TR;
  for (let t = 0; t < 3 * TR; t++) {
    const s = pm.state;
    const onG = s.onGround && landTick >= 0;
    const groundTick = onG ? t - landTick - 1 : -1;
    const jump = onG && groundTick >= nTicks;
    // W+D: wishdir = Blick + 45° nach rechts. Ziel: Winkel θ zwischen v und wishdir mit v cosθ = wish − a.
    const v = s.speed;
    const velYaw = Math.atan2(-s.vel.x, -s.vel.z);
    const cosT = Math.min(1, Math.max(-1, (wish - a) / Math.max(v, 1)));
    const theta = Math.acos(cosT);
    // wishdir-Yaw = velYaw − θ (nach rechts drehen); Blick = wishdir-Yaw + 45°.
    const yaw = velYaw - theta + Math.PI / 4;
    // Vor der Landung keine Eingabe (sonst bremst der Luft-Schub schon im Anflug).
    const inp = landTick < 0 ? makeInput({ yaw: 0 }) : makeInput({ yaw, forward: 1, side: 1, sprint: true, jumpPressed: jump, jumpHeld: jump });
    for (const e of pm.tick(inp)) {
      if (e.type === 'land' && landTick < 0) landTick = t;
      if (e.type === 'jump') return { takeoff: e.speed, best };
    }
    if (landTick >= 0) best = Math.max(best, pm.state.speed);
  }
  return { takeoff: Number.NaN, best };
}

function tableC(): void {
  console.log('\n## C) Exploit-Probe: Landung 500 u/s, n Bodenticks optimaler Ground-Strafe (W+D, Sprint), dann Sprung — Absprungtempo\n');
  const ns = [0, 2, 4, 8, 12, 16, 32, 64];
  console.log(`| Variante | ${ns.map((n) => `n=${n}`).join(' | ')} |`);
  console.log(`|---|${ns.map(() => '---').join('|')}|`);
  const rows: Array<[string, Parameters<typeof setMomentum>[0]]> = [
    ['vorher', 'off'],
    ['Gnade 8 OHNE Kappe', { grace: true, graceTicks: 8, graceClamp: false }],
    ['Gnade 16 OHNE Kappe', { grace: true, graceTicks: 16, graceClamp: false }],
    ['Gnade 8 mit Kappe', { grace: true, graceTicks: 8, graceClamp: true }],
    ['Gnade 16 mit Kappe', { grace: true, graceTicks: 16, graceClamp: true }],
  ];
  for (const [name, opt] of rows) {
    use(opt);
    console.log(`| ${name} | ${ns.map((n) => f(groundStrafe(n).takeoff)).join(' | ')} |`);
  }
  use('off');
}

function runAfterDrop(v: number, secs: number[]): number[] {
  const pm = lander(v);
  const out: number[] = [];
  let landTick = -1;
  for (let t = 0; t < 2 * TR; t++) {
    for (const e of pm.tick(makeInput({ yaw: 0, forward: 1, sprint: true }))) if (e.type === 'land' && landTick < 0) landTick = t;
    if (landTick >= 0) for (const s of secs) if (t - landTick === Math.round(s * TR)) out.push(pm.state.speed);
  }
  return out;
}

function tableD(): void {
  console.log('\n## D) Landung ohne Sprung, W+Sprint gehalten: Tempo nach 0.05 / 0.1 / 0.25 / 0.5 s\n');
  console.log('| v | vorher | Gnade 4 | Gnade 8 | Gnade 12 | Gnade 16 |');
  console.log('|---|---|---|---|---|---|');
  for (const v of [500, 800]) {
    const cols: string[] = [];
    for (const [, opt] of VARIANTS) {
      use(opt);
      cols.push(runAfterDrop(v, [0.05, 0.1, 0.25, 0.5]).map((x) => f(x)).join(' / '));
    }
    console.log(`| ${v} | ${cols.join(' | ')} |`);
  }
  use('off');
}

tableA();
tableB();
tableC();
tableD();
void MOM_STATS;
