/**
 * Level 4 (Turm) — Design-Proben mit echter Physik (ändert keinen Projektcode).
 *
 *   npx tsx tools/critique/v2/level4/probes.ts
 *
 * A) Anfänger (wie level-flow/novice.ts, aber y-bewusster Knoten-Tracker): W, W+Space,
 *    W+Space+Ducken-in-der-Luft; 150 s mit Respawn am Checkpoint. Wo stirbt/staut er?
 * B) Bande: Geradeaus-Hüpfer (Blick fest, W+Space) von jedem Wendel-Abschnitt — fällt
 *    irgendwer von der Wendel? (Soll: nie.)
 * C) Crouch-Kanten: gerader Crouch-Hüpfer (Auto-Hop, in der Luft geduckt) ab Terrassenanfang,
 *    Tempo 250–900 × Radius über die Bahnbreite → oben in ≤ 3 s? Zeitverlust, Tode.
 * D) Gräben (Innenbahn): gerader Hüpfer auf der Innenlinie, 300–900 u/s × Phase → Zeit bis
 *    hinter Graben 3, Graben-Landungen, Tode — ohne und mit Sprung-Pad im Grabenboden (Option B).
 * E) Drop-In an der Krone: W-Halter ohne Surf-Technik und Grundtechnik-Surfer (Blick −2…+5°)
 *    aus dem Stand / mit Anlauf 300–800 → CP5 erreicht? Tode?
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { RunState } from '../../../../src/engine/runState';
import type { RunEvent } from '../../../../src/engine/events';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput, yawOf } from '../../../../src/player/bots';
import type { PlayerInput, PlayerSnapshot } from '../../../../src/player/types';
import { compileLevel, type CompiledLevel } from '../../../../src/world/level/compileLevel';
import type { RouteNode } from '../../../../src/world/level/LevelFormat';
import { SurfRider, routeAxis } from '../../../levels/physics';
import { buildLevel4, level4Info, R_E2_IN, R_LINE } from './level4';

const OUT = 'shots/v2/level4';
mkdirSync(OUT, { recursive: true });
const cfg = VELOCITY_DEFAULT;
const DT = 1 / cfg.tickRate;
const def = buildLevel4({ measure: true });
const info = level4Info();
const lv = compileLevel(def);
const route = def.route ?? [];
const cps = lv.triggers.filter((t) => t.kind === 'checkpoint').sort((a, b) => a.order - b.order);
const kills = lv.triggers.filter((t) => t.kind === 'kill');
const out: string[] = [];
const log = (s: string): void => {
  out.push(s);
  console.log(s);
};
const hmin = new Vector3();
const hmax = new Vector3();
function dead(pm: PlayerMovement, level: CompiledLevel = lv): boolean {
  const s = pm.state;
  if (s.pos.y < level.def.killY) return true;
  hmin.copy(s.pos).add(pm.hullMins);
  hmax.copy(s.pos).add(pm.hullMaxs);
  return kills.some((k) => k.bounds.intersectsBox(new Box3(hmin, hmax)));
}

// ---------------------------------------------------------------------------
// A) Anfänger

/** Knoten-Tracker mit Höhe: erreicht = horizontal < 96 und Füße nicht tiefer als 48 u darunter, oder passiert. */
class Tracker {
  i: number;
  constructor(from: number) {
    this.i = from;
  }
  update(p: Vector3): RouteNode {
    for (;;) {
      const n = route[this.i];
      const nx = route[this.i + 1];
      if (!nx) return n;
      const dx = p.x - n.pos[0];
      const dz = p.z - n.pos[2];
      const near = Math.hypot(dx, dz) < 96 && p.y > n.pos[1] - 48;
      const prev = route[Math.max(0, this.i - 1)];
      const sx = n.pos[0] - prev.pos[0];
      const sz = n.pos[2] - prev.pos[2];
      const len = Math.hypot(sx, sz);
      const passed = len > 1 && (dx * sx + dz * sz) / len > 0 && Math.abs(dx * sz - dz * sx) / len < 300 && p.y > n.pos[1] - 48;
      if (near || passed) this.i++;
      else return n;
    }
  }
}

/** Erster Knoten, der WIRKLICH (3D) im Checkpoint-Trigger liegt — was resumeIndex tun sollte. */
function resume3D(order: number): number {
  const b = cps[order - 1].bounds;
  const i = route.findIndex((n) => n.pos[0] >= b.min.x - 1 && n.pos[0] <= b.max.x + 1 && n.pos[2] >= b.min.z - 1 && n.pos[2] <= b.max.z + 1 && n.pos[1] >= b.min.y - 8 && n.pos[1] <= b.max.y);
  return Math.max(0, i);
}

type Novice = 'W' | 'W+Space' | 'W+Space+Duck';
function novice(kind: Novice, seconds: number): string {
  const pm = new PlayerMovement(lv.world, cfg);
  const run = new RunState(lv);
  run.reset(null);
  const ev: RunEvent[] = [];
  pm.teleport(new Vector3(lv.spawnPos.x, lv.spawnPos.y + 1, lv.spawnPos.z));
  let tr = new Tracker(0);
  const inp = makeBotInput();
  let deaths = 0;
  const deathAt: Record<string, number> = {};
  const cpAt: number[] = [];
  let lastCpT = 0;
  let stuck: string | null = null;
  let fin: number | null = null;
  let pressed = false;
  for (let k = 0; k < seconds * cfg.tickRate; k++) {
    const t = k * DT;
    const n = tr.update(pm.state.pos);
    inp.yaw = yawOf(n.pos[0] - pm.state.pos.x, n.pos[2] - pm.state.pos.z);
    inp.pitch = 0;
    inp.forward = 1;
    inp.side = 0;
    inp.sprint = true;
    inp.jumpHeld = kind !== 'W';
    inp.jumpPressed = inp.jumpHeld && !pressed;
    pressed = inp.jumpHeld;
    inp.crouch = kind === 'W+Space+Duck' && !pm.state.onGround;
    pm.tick(inp);
    const before = run.checkpoint;
    const r = run.tick(DT, pm.state.pos, pm.hullMins, pm.hullMaxs, pm.state.speed, pm.state.onGround, ev);
    if (run.checkpoint > before) {
      cpAt[run.checkpoint - 1] = t;
      lastCpT = t;
    }
    if (r === 'finish') {
      fin = t;
      break;
    }
    if (r === 'fall' || r === 'kill') {
      deaths++;
      const key = `nach CP${run.checkpoint}`;
      deathAt[key] = (deathAt[key] ?? 0) + 1;
      if (run.checkpoint === 0) run.reset(null);
      const sp = run.respawnPoint();
      pm.teleport(new Vector3(sp.pos.x, sp.pos.y + 1, sp.pos.z));
      tr = new Tracker(run.checkpoint > 0 ? resume3D(run.checkpoint) : 0);
      pressed = false;
    }
    if (!stuck && t - lastCpT > 40) {
      const p = pm.state.pos;
      stuck = `STAU nach CP${run.checkpoint} bei (${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}) vor Knoten ${tr.i} [${route[tr.i]?.note ?? noteBefore(tr.i)}]`;
    }
  }
  return `| ${kind} | ${cpAt.map((x, i) => `CP${i + 1} ${x.toFixed(1)}`).join(', ') || '—'} | ${fin === null ? '—' : `${fin.toFixed(1)} s`} | ${deaths} ${Object.keys(deathAt).length ? `(${Object.entries(deathAt).map(([a, b]) => `${a}: ${b}`).join(', ')})` : ''} | ${stuck ?? '—'} |`;
}

function noteBefore(i: number): string {
  for (let k = Math.min(i, route.length - 1); k >= 0; k--) if (route[k].note) return route[k].note ?? '';
  return 'Start';
}

log('## A) Anfänger (150 s, Respawn am Checkpoint, Blick auf den nächsten Knoten)\n');
log('| Typ | Checkpoints (s) | Ziel | Tode | Stau |');
log('|---|---|---|---|---|');
for (const k of ['W', 'W+Space', 'W+Space+Duck'] as const) log(novice(k, 150));

// ---------------------------------------------------------------------------
// B) Bande: gerade Hüpfer quer über die Wendel

log('\n## B) Bande — Geradeaus-Hüpfer (Blick fest in Fahrtrichtung, W+Space, kein Lenken)\n');
{
  const h = info.helix;
  let runs = 0;
  let deaths = 0;
  let fellOff = 0;
  let worstDrop = 0;
  let hangs = 0;
  let hangRuns = 0;
  for (let theta = 10; theta < 530; theta += 20) {
    for (const r of [700, 900, 1100]) {
      for (const v of [320, 600, 900]) {
       for (const aim of [0, -25, 25]) {
        const pm = new PlayerMovement(lv.world, cfg);
        const [x, z] = h.xz(theta, r);
        const y0 = h.yAt(theta, true);
        pm.teleport(new Vector3(x, y0 + 80, z));
        const yaw0 = (h.yawAt(theta) * Math.PI) / 180;
        // aim: Blick fest 25° nach innen (Kern) / außen (Bande) — drückt in die gedrehten Wände.
        const yaw = yaw0 + (aim * Math.PI) / 180;
        pm.state.vel.set(-Math.sin(yaw0) * v, 0, -Math.cos(yaw0) * v);
        const inp = makeBotInput();
        let minY = Infinity;
        let hang = 0;
        let maxHang = 0;
        for (let k = 0; k < 3 * cfg.tickRate; k++) {
          inp.yaw = yaw;
          inp.forward = 1;
          inp.sprint = true;
          inp.jumpHeld = true;
          inp.jumpPressed = k === 0;
          pm.tick(inp);
          if (pm.state.onGround) minY = Math.min(minY, pm.state.pos.y);
          hang = !pm.state.onGround && Math.abs(pm.state.vel.y) < 12 && pm.state.speed < 40 ? hang + 1 : 0;
          maxHang = Math.max(maxHang, hang);
          if (dead(pm)) {
            deaths++;
            break;
          }
        }
        runs++;
        if (maxHang > 32) hangs++;
        hangRuns++;
        const drop = y0 - minY;
        if (drop > 150) fellOff++;
        worstDrop = Math.max(worstDrop, drop);
       }
      }
    }
  }
  log(`${runs} Läufe (θ 10–530 alle 20°, r 700/900/1100, 320/600/900 u/s, Blick 0/±25°, 3 s): Tode ${deaths}, tiefer als 150 u gelandet ${fellOff}, größter Höhenverlust ${worstDrop.toFixed(0)} u, Luft-Hänger > 0.25 s: ${hangs}/${hangRuns}`);
}

// ---------------------------------------------------------------------------
// C) Crouch-Kanten

log('\n## C) Crouch-Kanten — gerader Crouch-Hüpfer ab Rampenanfang vor der Kante\n');
log('| Kante | Tempo | oben (von 5 Radien × 4 Phasen) | Ø Zeit bis oben (s) | Anpraller Ø | Tode |');
log('|---|---|---|---|---|---|');
{
  const h = info.helix;
  const walls = info.crouchWalls;
  walls.forEach((wall, i) => {
    const upper = h.yAt(wall + 0.5, true);
    for (const v of [250, 400, 550, 700, 900]) {
      let ok = 0;
      let n = 0;
      let tSum = 0;
      let bonks = 0;
      let deaths = 0;
      for (const r of [680, 790, 900, 1010, 1110]) {
        for (const phase of [0, 1, 2, 3]) {
          n++;
          const pm = new PlayerMovement(lv.world, cfg);
          const start = wall - 45 - phase * 2; // Rampenanfang der Einheit (± Phase)
          const [x, z] = h.xz(start, r);
          pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
          const inp = makeBotInput();
          let prev = v;
          let up = false;
          for (let k = 0; k < 4 * cfg.tickRate; k++) {
            // Blick tangential an der aktuellen Stelle (folgt der Kurve, wie ein Mensch).
            const th = thetaOf(pm.state.pos.x, pm.state.pos.z, start);
            const yaw = (h.yawAt(th) * Math.PI) / 180;
            if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
            inp.yaw = yaw;
            inp.forward = 1;
            inp.sprint = true;
            inp.jumpHeld = true;
            inp.jumpPressed = k === 0; // gehalten (Smart-Auto-Hop), wie ein Mensch mit gedrückter Leertaste
            inp.crouch = !pm.state.onGround;
            pm.tick(inp);
            if (prev > 150 && pm.state.speed < 0.6 * prev) bonks++;
            prev = pm.state.speed;
            if (dead(pm)) {
              deaths++;
              break;
            }
            if (pm.state.onGround && pm.state.pos.y >= upper - 4 && thetaOf(pm.state.pos.x, pm.state.pos.z, start) > wall) {
              up = true;
              tSum += k * DT;
              break;
            }
          }
          if (up) ok++;
        }
      }
      log(`| ${i + 1} | ${v} | ${ok}/${n} | ${ok ? (tSum / ok).toFixed(2) : '—'} | ${(bonks / n).toFixed(1)} | ${deaths} |`);
    }
  });
}

/** θ eines Weltpunkts, nahe `near` (Wendel mehrdeutig um 360°). */
function thetaOf(x: number, z: number, near: number): number {
  const phi = (Math.atan2(-(z - 0), x - 0) * 180) / Math.PI;
  let th = phi - 270;
  while (th < near - 180) th += 360;
  while (th > near + 180) th -= 360;
  return th;
}

// ---------------------------------------------------------------------------
// D) Gräben auf der Innenbahn — ohne / mit Sprung-Pad im Grabenboden (Option B)

log('\n## D) Innenbahn-Gräben — gerader Hüpfer auf der Innenlinie (r 752), Kurve per Blick tangential\n');
log('| Pad | Tempo | Läufe | Graben-Landungen Ø | Zeit bis hinter Graben 3 (Ø / max, s) | Tode |');
log('|---|---|---|---|---|---|');
{
  const h = info.helix;
  const [e2a] = info.e2;
  const trenches = info.trenches;
  const goalTheta = trenches[2][1] + 4;
  // Pad-Variante (Option B) misst pads.ts sauber (eigenes Pad-Volumen); hier nur ohne Pad.
  for (const pad of [false]) {
    for (const v of [320, 450, 600, 750, 900]) {
      let runs = 0;
      let inTrench = 0;
      let tSum = 0;
      let tMax = 0;
      let deaths = 0;
      for (let ph = 0; ph < 8; ph++) {
        runs++;
        const pm = new PlayerMovement(lv.world, cfg);
        const start = e2a + 4 + ph * 1.5;
        const [x, z] = h.xz(start, R_E2_IN);
        pm.teleport(new Vector3(x, h.yAt(start, true) + 2, z));
        const inp = makeBotInput();
        let wasIn = false;
        for (let k = 0; k < 12 * cfg.tickRate; k++) {
          const th = thetaOf(pm.state.pos.x, pm.state.pos.z, start + 60);
          const yaw = (h.yawAt(th) * Math.PI) / 180;
          if (k === 0) pm.state.vel.set(-Math.sin(yaw) * v, 0, -Math.cos(yaw) * v);
          inp.yaw = yaw;
          inp.forward = 1;
          inp.sprint = true;
          inp.jumpHeld = true;
          inp.jumpPressed = k === 0;
          pm.tick(inp);
          const inside = trenches.some(([a, b]) => th > a && th < b) && pm.state.onGround && pm.state.pos.y < h.yAt(th) - 8;
          if (inside && !wasIn) inTrench++;
          wasIn = inside;
          // Option B: Sprung-Pad im Grabenboden — wer im Graben Boden berührt, bekommt vy = 420 (≈ 110 u Hub).
          if (pad && inside && pm.state.vel.y < 420) pm.state.vel.y = 420;
          if (dead(pm)) {
            deaths++;
            break;
          }
          if (th > goalTheta && pm.state.pos.y > h.yAt(goalTheta) - 40) {
            const t = k * DT;
            tSum += t;
            tMax = Math.max(tMax, t);
            break;
          }
        }
      }
      log(`| ${pad ? 'ja' : 'nein'} | ${v} | ${runs} | ${(inTrench / runs).toFixed(2)} | ${(tSum / runs).toFixed(2)} / ${tMax.toFixed(2)} | ${deaths} |`);
    }
  }
  const arcIn = h.arc(info.e2[1] - info.e2[0], R_E2_IN);
  const arcOut = h.arc(info.e2[1] - info.e2[0], 1000);
  log(`\nWeglänge E2: Innenlinie r ${R_E2_IN} = ${arcIn.toFixed(0)} u, Außenroute r 1000 = ${arcOut.toFixed(0)} u (−${(100 * (1 - arcIn / arcOut)).toFixed(0)} %); Planlinie E1/E3 r ${R_LINE}.`);
}

// ---------------------------------------------------------------------------
// E) Drop-In an der Krone

log('\n## E) Drop-In an der Krone (CP4 → CP5)\n');
log('| Fahrer | Anlauf u/s | Läufe | CP5 erreicht | Tode | Ø Zeit bis CP5 (s) |');
log('|---|---|---|---|---|---|');
{
  const cp4 = cps[3];
  const cp5 = cps[4];
  const axis = routeAxis(route);
  const riders: Array<[string, (pm: PlayerMovement) => { next: (s: PlayerSnapshot, n: Vector3) => PlayerInput }]> = [
    ['W-Halter (kein Surf)', () => {
      const inp = makeBotInput();
      return { next: (s) => { inp.yaw = Math.PI / 2; inp.forward = 1; inp.sprint = true; inp.jumpHeld = false; inp.jumpPressed = false; inp.side = 0; void s; return inp; } };
    }],
    ['W+Space (kein Surf)', () => {
      const inp = makeBotInput();
      let first = true;
      return { next: () => { inp.yaw = Math.PI / 2; inp.forward = 1; inp.sprint = true; inp.jumpHeld = true; inp.jumpPressed = first; first = false; inp.side = 0; return inp; } };
    }],
    ...[-2, 0, 2, 5].map((look) => [`Surfer Blick ${look}°`, () => new SurfRider(cfg, lv.world, axis, (look * Math.PI) / 180)] as [string, () => SurfRider]),
  ];
  for (const [name, make] of riders) {
    for (const v of [0, 300, 550, 800]) {
      let ok = 0;
      let deaths = 0;
      let tSum = 0;
      let runs = 0;
      for (const lateral of (process.env.L4_E_LAT ?? '-160,-80,0,80,160').split(',').map(Number)) {
        runs++;
        const pm = new PlayerMovement(lv.world, cfg);
        const sp = cp4.spawnPos;
        pm.teleport(new Vector3(sp.x, sp.y + 1, sp.z - lateral));
        pm.state.vel.set(-v, 0, 0);
        const ctl = make(pm);
        for (let k = 0; k < 12 * cfg.tickRate; k++) {
          pm.tick(ctl.next(pm.state, pm.surfNormal));
          hmin.copy(pm.state.pos).add(pm.hullMins);
          hmax.copy(pm.state.pos).add(pm.hullMaxs);
          if (cp5.bounds.intersectsBox(new Box3(hmin, hmax))) {
            ok++;
            tSum += k * DT;
            break;
          }
          if (dead(pm)) {
            deaths++;
            break;
          }
        }
      }
      log(`| ${name} | ${v} | ${runs} | ${ok} | ${deaths} | ${ok ? (tSum / ok).toFixed(2) : '—'} |`);
    }
  }
}

writeFileSync(`${OUT}/probes.md`, out.join('\n') + '\n');
