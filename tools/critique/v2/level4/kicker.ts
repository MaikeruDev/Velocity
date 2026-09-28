/**
 * Level 4 — Mess-Skript 2: Schanze (Tempo → Höhe) isoliert.
 *
 *   npx tsx tools/critique/v2/level4/kicker.ts
 *
 * Flacher Anlauf, dann ein Kicker aus Keil-Stücken (Neigung steigt stückweise),
 * dahinter nichts. Gemessen: größte Fußhöhe über dem Anlauf und die Weite bis
 * zum Scheitel je Anlauftempo — daraus folgt, wie hoch/weit eine Lande-Kante
 * hinter der Schanze liegen darf ("ab welchem Tempo kommt man hoch").
 * Fahrer: Geradeaus mit gehaltener Leertaste (Auto-Hop, kein Strafen) — das
 * ist der Fall, in dem die Anfahrt NICHT beschleunigt, also die ehrliche Zahl.
 * Zusätzlich: Anlauf nur W+Sprint ohne Sprung (Boden) — kommt man zu Fuß hoch?
 */
import { writeFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeBotInput } from '../../../../src/player/bots';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import { Frame, LevelBuilder } from '../../../levels/lib';

const cfg = VELOCITY_DEFAULT;
const ENV = {
  skyTop: '#000000', skyHorizon: '#000000', skyBottom: '#000000', fogColor: '#000000', fogNear: 0, fogFar: 1,
  sunDir: [0, 1, 0] as const, sunColor: '#ffffff', ambientSky: '#ffffff', ambientGround: '#000000', trimColor: '#ffffff', voidY: -3000,
};
const DEG = Math.PI / 180;

/** Kicker aus Stücken [Länge, Neigung°]; liefert Endhöhe und Ende (u). */
function build(pieces: ReadonlyArray<readonly [number, number]>): { level: ReturnType<typeof compileLevel>; lipU: number; lipY: number } {
  const L = new LevelBuilder({ id: 'kick', name: 'kick', killY: -4000, environment: ENV });
  const F = new Frame(0, 0, 0);
  L.platform(F, [-3000, 0], [-300, 300], 0, { tag: 'runup' });
  let u = 0;
  let y = 0;
  for (const [len, deg] of pieces) {
    const y1 = y + len * Math.tan(deg * DEG);
    L.ramp(F, [u, u + len], [-300, 300], y, y1, { tag: `k${deg}`, thick: y + 64 });
    u += len;
    y = y1;
  }
  L.spawn([0, 0, 2000], 0);
  return { level: compileLevel(L.build()), lipU: u, lipY: y };
}

interface Out { apex: number; apexU: number; lipSpeed: number; vyLip: number; t: number }

function shoot(level: ReturnType<typeof compileLevel>, lipU: number, v0: number, mode: 'hop' | 'walk' | 'hopCrouch'): Out {
  const pm = new PlayerMovement(level.world, cfg);
  pm.teleport(new Vector3(0, 1, 900));
  pm.state.vel.set(0, 0, -v0);
  const inp = makeBotInput();
  let apex = 0;
  let apexU = 0;
  let lipSpeed = 0;
  let vyLip = 0;
  let passed = false;
  for (let k = 0; k < 6 * cfg.tickRate; k++) {
    inp.yaw = 0;
    inp.forward = mode === 'walk' ? 1 : 0;
    inp.sprint = true;
    inp.jumpHeld = mode !== 'walk' && pm.state.pos.z > 0; // nur im Anlauf hüpfen
    inp.jumpPressed = inp.jumpHeld && pm.state.onGround;
    inp.crouch = mode === 'hopCrouch' && !pm.state.onGround && -pm.state.pos.z > lipU - 200;
    pm.tick(inp);
    const u = -pm.state.pos.z;
    if (!passed && u >= lipU) {
      passed = true;
      lipSpeed = Math.hypot(pm.state.vel.x, pm.state.vel.y, pm.state.vel.z);
      vyLip = pm.state.vel.y;
    }
    if (pm.state.pos.y > apex) {
      apex = pm.state.pos.y;
      apexU = u;
    }
    if (passed && pm.state.vel.y < 0 && pm.state.pos.y < apex - 400) break;
  }
  return { apex, apexU, lipSpeed, vyLip, t: 0 };
}

const KICKERS: Record<string, ReadonlyArray<readonly [number, number]>> = {
  'K30 (10/20/30, je 96)': [[96, 10], [96, 20], [96, 30]],
  'K40 (10/20/30/40, je 80)': [[80, 10], [80, 20], [80, 30], [80, 40]],
  'K40 lang (10/20/30/40, je 128)': [[128, 10], [128, 20], [128, 30], [128, 40]],
  'K50 (10…50, je 80)': [[80, 10], [80, 20], [80, 30], [80, 40], [80, 50]],
  'K35 glatt (5°-Schritte, je 48)': [[48, 5], [48, 10], [48, 15], [48, 20], [48, 25], [48, 30], [48, 35]],
};
const lines: string[] = [];
lines.push('| Kicker | Lippe (u hoch) | Fahrer | v0 | Tempo an der Lippe | vy an der Lippe | Scheitel über Anlauf | Scheitel über Lippe | Weite Lippe→Scheitel |');
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const [name, pieces] of Object.entries(KICKERS)) {
  const { level, lipU, lipY } = build(pieces);
  for (const mode of ['hop', 'walk'] as const) {
    for (const v0 of mode === 'walk' ? [320] : [320, 450, 600, 750, 900, 1100]) {
      const o = shoot(level, lipU, v0, mode);
      lines.push(`| ${name} | ${lipY.toFixed(0)} | ${mode === 'hop' ? 'Auto-Hop' : 'Lauf W+Sprint'} | ${v0} | ${o.lipSpeed.toFixed(0)} | ${o.vyLip.toFixed(0)} | ${o.apex.toFixed(0)} | ${(o.apex - lipY).toFixed(0)} | ${(o.apexU - lipU).toFixed(0)} |`);
    }
  }
}
writeFileSync('shots/v2/level4/kicker.md', lines.join('\n') + '\n');
console.log(lines.join('\n'));
