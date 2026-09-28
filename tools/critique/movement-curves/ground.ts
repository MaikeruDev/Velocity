/**
 * Kritiker-Linse "Movement-Kurven": Boden-Dynamik VELOCITY vs. CS2.
 * npx tsx tools/critique/movement-curves/ground.ts
 * Misst: Antritt-Kurve, Gegenlenken (Counter-Strafe), 90°-Richtungswechsel,
 * Sprint loslassen, Ducken aus dem Sprint, Duck-Übergang, Stopp.
 */
import { Vector3 } from 'three';
import { CS2_CLASSIC, VELOCITY_DEFAULT, withMovement, type MovementConfig } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import { flatWorld } from '../../sim/scenarios';
import { makeInput } from '../../sim/harness';

const cfgs: Array<[string, MovementConfig]> = [
  ['VELOCITY', VELOCITY_DEFAULT],
  ['CS2', CS2_CLASSIC],
  ['VEL accel 10', withMovement(VELOCITY_DEFAULT, { accelerate: 10 })],
  ['VEL accel 6.5', withMovement(VELOCITY_DEFAULT, { accelerate: 6.5 })],
];

function spawn(cfg: MovementConfig): PlayerMovement {
  const pm = new PlayerMovement(flatWorld().world, cfg);
  pm.teleport(new Vector3(0, 0, 0));
  return pm;
}

function run(pm: PlayerMovement, input: ReturnType<typeof makeInput>, seconds: number): void {
  const n = Math.round(seconds * pm.config.tickRate);
  for (let i = 0; i < n; i++) pm.tick(input);
}

const f = (v: number, d = 0): string => (Number.isFinite(v) ? v.toFixed(d) : '–');

for (const [name, cfg] of cfgs) {
  const dt = 1 / cfg.tickRate;
  const out: string[] = [`### ${name}`];
  // Antrittskurve (Sprint, W): Speed nach 50/100/150/250 ms und Weg nach 0.5 s
  for (const sprint of [false, true]) {
    const pm = spawn(cfg);
    const inp = makeInput({ forward: 1, sprint });
    const marks = [0.05, 0.1, 0.15, 0.25];
    const vals: string[] = [];
    let t = 0;
    for (const m of marks) {
      while (t < m - 1e-9) { pm.tick(inp); t += dt; }
      vals.push(f(pm.state.speed));
    }
    while (t < 0.5 - 1e-9) { pm.tick(inp); t += dt; }
    out.push(`antritt ${sprint ? 'sprint' : 'run  '}: v@50/100/150/250ms = ${vals.join('/')}  weg@0.5s = ${f(-pm.state.pos.z)} u`);
  }
  // Counter-Strafe: mit D auf Top-Speed, dann A: Zeit bis v_x < 0 (Umkehr) und bis |v| < 10 wenn losgelassen
  for (const sprint of [false, true]) {
    const pm = spawn(cfg);
    run(pm, makeInput({ side: 1, sprint }), 1);
    const v0 = pm.state.speed;
    let t = 0;
    while (pm.state.vel.x > 0 && t < 2) { pm.tick(makeInput({ side: -1, sprint })); t += dt; }
    const tRev = t;
    while (pm.state.vel.x > -0.9 * (sprint ? cfg.sprintSpeed : cfg.runSpeed) && t < 3) { pm.tick(makeInput({ side: -1, sprint })); t += dt; }
    out.push(`counter ${sprint ? 'sprint' : 'run  '} (${f(v0)}): Umkehr nach ${f(tRev * 1000)} ms, 90% Gegenrichtung nach ${f(t * 1000)} ms`);
    // Counter-Strafe-Stopp: gegenlenken bis |v|<~0 -> loslassen
    const pm2 = spawn(cfg);
    run(pm2, makeInput({ side: 1, sprint }), 1);
    let t2 = 0;
    while (pm2.state.vel.x > 0 && t2 < 2) { pm2.tick(makeInput({ side: -1, sprint })); t2 += dt; }
    const x0 = pm2.state.pos.x;
    out.push(`   Stopp per Gegenlenken: ${f(t2 * 1000)} ms  vs. loslassen (s.u.)`);
    void x0;
  }
  // Loslassen: Zeit bis < 10 u/s, Bremsweg
  for (const sprint of [false, true]) {
    const pm = spawn(cfg);
    run(pm, makeInput({ forward: 1, sprint }), 1);
    const z0 = pm.state.pos.z;
    let t = 0;
    while (pm.state.speed >= 10 && t < 3) { pm.tick(makeInput()); t += dt; }
    out.push(`loslassen ${sprint ? 'sprint' : 'run  '}: <10 u/s nach ${f(t * 1000)} ms, Bremsweg ${f(Math.abs(pm.state.pos.z - z0))} u`);
  }
  // 90°-Kurve am Boden: mit W Richtung -Z bei Sprint, Blick schlagartig 90° links: Zeit bis Geschwindigkeit innerhalb 10° der neuen Richtung, Speed-Minimum
  {
    const pm = spawn(cfg);
    run(pm, makeInput({ forward: 1, sprint: true }), 1);
    let t = 0;
    let vmin = Infinity;
    const inp = makeInput({ forward: 1, sprint: true, yaw: Math.PI / 2 });
    for (;;) {
      pm.tick(inp); t += dt;
      vmin = Math.min(vmin, pm.state.speed);
      const ang = Math.abs(Math.atan2(pm.state.vel.z, -pm.state.vel.x)) * 180 / Math.PI; // Winkel zu -X
      if (ang < 10 || t > 2) break;
    }
    out.push(`90°-Schwenk (Sprint): Bahn auf <10° nach ${f(t * 1000)} ms, Speed-Minimum ${f(vmin)} u/s, Wendekreis ~ ${f(pm.state.pos.z === 0 ? 0 : Math.abs(pm.state.pos.z))} u Überschuss in alter Richtung`);
  }
  // Ducken aus dem Sprint: Zeit bis Speed <= Duck-Speed+5
  {
    const pm = spawn(cfg);
    run(pm, makeInput({ forward: 1, sprint: true }), 1);
    let t = 0;
    // Geduckt gilt runSpeed × duckSpeedScale, unabhängig von Sprint (rules/movement.md §4).
    const target = cfg.runSpeed * cfg.duckSpeedScale;
    let tHull = Number.NaN;
    while (pm.state.speed > target + 5 && t < 3) {
      pm.tick(makeInput({ forward: 1, sprint: true, crouch: true })); t += dt;
      if (Number.isNaN(tHull) && pm.state.ducked) tHull = t;
    }
    out.push(`Ducken aus Sprint (${f(cfg.sprintSpeed)}): Hull klein nach ${f(tHull * 1000)} ms, Speed <= ${f(target + 5)} nach ${f(t * 1000)} ms; Duck-Walk gemessen ${f(pm.state.speed)} (Soll ${f(target)}, mit und ohne Sprint)`);
  }
  // Sprint loslassen: 320 -> 255
  if (cfg.sprintSpeed > cfg.runSpeed) {
    const pm = spawn(cfg);
    run(pm, makeInput({ forward: 1, sprint: true }), 1);
    let t = 0;
    while (pm.state.speed > cfg.runSpeed + 5 && t < 3) { pm.tick(makeInput({ forward: 1 })); t += dt; }
    out.push(`Sprint loslassen: ${f(cfg.sprintSpeed)} -> ${f(cfg.runSpeed + 5)} nach ${f(t * 1000)} ms`);
  }
  console.log(out.join('\n') + '\n');
}

// Crouch-Jump-Timing: Ducken x ms VOR dem Sprung gedrückt (am Boden) — wie hoch kommen die Füße?
console.log('### Duck vor dem Sprung (Füße-Max, VELOCITY)');
{
  const cfg = VELOCITY_DEFAULT;
  const rows: string[] = [];
  for (const preMs of [0, 50, 100, 140, 160, 250, 500]) {
    const pm = spawn(cfg);
    const pre = Math.round(preMs / 1000 * cfg.tickRate);
    for (let i = 0; i < pre; i++) pm.tick(makeInput({ crouch: true }));
    const y0 = pm.state.pos.y;
    pm.tick(makeInput({ crouch: true, jumpPressed: true, jumpHeld: true }));
    let top = 0;
    for (let i = 0; i < cfg.tickRate; i++) { pm.tick(makeInput({ crouch: true })); top = Math.max(top, pm.state.pos.y - y0); }
    rows.push(`duck ${preMs} ms vor Sprung -> Füße max ${top.toFixed(1)} u`);
  }
  // Duck NACH dem Sprung: x ms später
  for (const postMs of [0, 100, 200, 300, 380, 450]) {
    const pm = spawn(cfg);
    const y0 = pm.state.pos.y;
    pm.tick(makeInput({ jumpPressed: true, jumpHeld: true }));
    const post = Math.round(postMs / 1000 * cfg.tickRate);
    let top = 0;
    for (let i = 0; i < cfg.tickRate; i++) { pm.tick(makeInput({ crouch: i >= post })); top = Math.max(top, pm.state.pos.y - y0); }
    rows.push(`duck ${postMs} ms nach Sprung -> Füße max ${top.toFixed(1)} u`);
  }
  console.log(rows.join('\n'));
}
