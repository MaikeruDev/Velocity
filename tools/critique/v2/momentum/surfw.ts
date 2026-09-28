/**
 * Surf-Halten mit W (Variante "surfw"): Neuling hält W und schaut die Rampe entlang.
 * npx tsx tools/critique/v2/momentum/surfw.ts
 *
 * A) Synthetische Riesenrampe (surfWorld, Flanke n.y ≈ 0.54): 3 s ab 400 u/s in der Luft über der Flanke,
 *    Blick entlang der Achse ± Versatz. Höhenverlust / Tempo / noch auf der Rampe.
 * B) Echte Level: ab jedem Checkpoint vor einer Surf-Kette (L2) aus dem Stand bzw. ab dem ersten
 *    Rutschen-Knoten (L1, 400/700 u/s in der Luft) — "W-Surfer": am Boden W (+Sprung wie der
 *    Grundtechnik-Surfer), in der Luft NUR W, Blick = Routenachse + Versatz. Ziel = nächster CP.
 * C) Kontrolle: Grundtechnik-Surfer (A/D, wie levels:check) muss bitgleich bleiben.
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput, yawOf } from '../../../../src/player/bots';
import type { MutablePlayerInput, PlayerInput, PlayerSnapshot } from '../../../../src/player/types';
import { compileLevel, type CompiledLevel } from '../../../../src/world/level/compileLevel';
import { readLevelFile } from '../../../sim/levels';
import { surfWorld } from '../../../sim/scenarios';
import { makeInput } from '../../../sim/harness';
import { SurfRider, isSurfNode, nextGoal, resumeIndex, routeAxis, simulate, surfSectionStarts, type Controller, type ProbeOutcome } from '../../../levels/physics';
import { setMomentum } from './patch';
import { DEG, f } from './common';

const cfg = VELOCITY_DEFAULT;

const DIVES = [0, 150, 300];
function use(on: boolean | number): void {
  setMomentum('off');
  if (on !== false) setMomentum({ surfW: true, surfWDive: on === true ? 0 : on });
}

// ---------------------------------------------------------------- A
function synth(offDeg: number): { drop: number; speed: number; surfing: boolean } {
  const pm = new PlayerMovement(surfWorld().world, cfg);
  pm.teleport(new Vector3(200, -250, -200));
  pm.state.vel.set(0, 0, -400);
  const y0 = pm.state.pos.y;
  // Rechte Flanke liegt bei +x: "zur Rampe" = Blick nach rechts = yaw kleiner.
  const inp = makeInput({ forward: 1, yaw: -offDeg * DEG });
  for (let t = 0; t < 3 * cfg.tickRate; t++) pm.tick(inp);
  return { drop: y0 - pm.state.pos.y, speed: Math.hypot(pm.state.vel.x, pm.state.vel.y, pm.state.vel.z), surfing: pm.state.surfing };
}

console.log('\n## A) Riesenrampe, 3 s nur W (Start 400 u/s in der Luft über der Flanke)\n');
console.log('| Blick (+ = zur Rampe) | vorher: Höhenverlust / Tempo / surft | ' + DIVES.map((d) => 'surfw dive ' + d).join(' | ') + ' |');
console.log('|---|---|' + DIVES.map(() => '---').join('|') + '|');
for (const off of [-30, -15, 0, 15, 30]) {
  const cols: string[] = [];
  for (const on of [false, ...DIVES]) {
    use(on);
    const r = synth(off);
    cols.push(`${f(r.drop)} u / ${f(r.speed)} u/s / ${r.surfing ? 'ja' : 'nein'}`);
  }
  console.log(`| ${off}° | ${cols.join(' | ')} |`);
}
use(false);

// ---------------------------------------------------------------- B
/** Neuling: am Boden W (+ springen, wenn schnell oder Kante), in der Luft nur W, Blick = Achse + Versatz. */
class WSurfer implements Controller {
  private readonly out: MutablePlayerInput = makeBotInput();
  private readonly rider: SurfRider;
  constructor(level: CompiledLevel, private readonly axisAt: (x: number, z: number) => number, private readonly offset: number) {
    this.rider = new SurfRider(cfg, level.world, axisAt, 0);
  }
  next(s: PlayerSnapshot, n: Vector3): PlayerInput {
    if (s.onGround) return this.rider.next(s, n);
    const out = this.out;
    let yaw = this.axisAt(s.pos.x, s.pos.z);
    if (-Math.sin(yaw) * s.vel.x - Math.cos(yaw) * s.vel.z < 0) yaw += Math.PI;
    out.yaw = yaw + this.offset;
    out.forward = 1;
    out.side = 0;
    out.sprint = true;
    out.jumpHeld = false;
    out.jumpPressed = false;
    out.crouch = false;
    out.pitch = 0;
    return out;
  }
}

interface Case { level: string; label: string; run: (ctl: (lv: CompiledLevel, axis: (x: number, z: number) => number) => Controller) => ProbeOutcome }

function cases(): Case[] {
  const out: Case[] = [];
  const L2 = compileLevel(readLevelFile('public/levels/level2.json'));
  const route2 = L2.def.route ?? [];
  const axis2 = routeAxis(route2);
  for (const cp of L2.triggers.filter((t) => t.kind === 'checkpoint')) {
    const from = resumeIndex(route2, cp);
    if (from < 0 || !route2.slice(from, from + 3).some(isSurfNode)) continue;
    const goal = nextGoal(L2, cp.order);
    if (!goal) continue;
    out.push({
      level: 'L2',
      label: `CP${cp.order} → ${goal.kind === 'finish' ? 'Ziel' : `CP${goal.order}`} (Stand)`,
      run: (mk) => {
        const pm = new PlayerMovement(L2.world, cfg);
        pm.teleport(cp.spawnPos);
        return simulate(L2, pm, mk(L2, axis2), { cfg, goal: goal.bounds, timeout: 30 });
      },
    });
  }
  const L1 = compileLevel(readLevelFile('public/levels/level1.json'));
  const route1 = L1.def.route ?? [];
  const axis1 = routeAxis(route1);
  const fin = L1.triggers.find((t) => t.kind === 'finish');
  const starts = surfSectionStarts(L1.world, route1);
  if (fin && starts.length) {
    const i = starts[0];
    const n = route1[i];
    const nx = route1[i + 1];
    const dir = new Vector3(nx.pos[0] - n.pos[0], 0, nx.pos[2] - n.pos[2]).normalize();
    for (const v of [400, 700]) {
      out.push({
        level: 'L1',
        label: `Rutsche ab 1. Surf-Knoten, ${v} u/s`,
        run: (mk) => {
          const pm = new PlayerMovement(L1.world, cfg);
          pm.teleport(new Vector3(n.pos[0], n.pos[1] + 48, n.pos[2]));
          pm.state.vel.set(dir.x * v, 0, dir.z * v);
          return simulate(L1, pm, mk(L1, axis1), { cfg, goal: fin.bounds, timeout: 30 });
        },
      });
    }
  }
  return out;
}

console.log('\n## B) W-Surfer in den echten Leveln (Ziel erreicht / Zeit / Tempo am Ziel bzw. Grund), Blickversatz −10/−5/0/+5/+10°\n');
console.log('| Level | Abschnitt | Blick | vorher | ' + DIVES.map((d) => 'surfw dive ' + d).join(' | ') + ' |');
console.log('|---|---|---|---|' + DIVES.map(() => '---').join('|') + '|');
const fmt = (r: ProbeOutcome): string => (r.ok ? `✓ ${f(r.time, 1)} s, ${f(r.goalSpeed)} u/s` : `✗ ${r.reason} nach ${f(r.time, 1)} s`);
const tally: Record<string, number> = { n: 0 };
for (const c of cases()) {
  for (const off of [0]) {
    const cols: string[] = [];
    for (const on of [false, ...DIVES]) {
      use(on);
      const r = c.run((lv, axis) => new WSurfer(lv, axis, off * DEG));
      cols.push(fmt(r));
      const key = String(on);
      tally[key] = (tally[key] ?? 0) + (r.ok ? 1 : 0);
    }
    tally.n++;
    console.log(`| ${c.level} | ${c.label} | ${off}° | ${cols.join(' | ')} |`);
  }
}
console.log(`\nSumme im Ziel (false = vorher, Zahl = surfw mit dive): ${JSON.stringify(tally)}`);

// ---------------------------------------------------------------- C
console.log('\n## C) Kontrolle: Grundtechnik-Surfer (A/D) — vorher vs. surfw (muss identisch sein)\n');
let same = 0;
let total = 0;
for (const c of cases()) {
  for (const look of [-2, 0, 2, 5]) {
    const res: string[] = [];
    for (const on of [false, true]) {
      use(on);
      const r = c.run((lv, axis) => new SurfRider(cfg, lv.world, axis, look * DEG));
      res.push(`${r.ok}|${r.time.toFixed(4)}|${r.goalSpeed.toFixed(4)}|${r.end.x.toFixed(3)}`);
    }
    total++;
    if (res[0] === res[1]) same++;
  }
}
console.log(`bitgleich: ${same}/${total}`);
use(false);
void yawOf;
