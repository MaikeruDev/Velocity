/**
 * Kicker / Rampen-Launch: flacher Boden → begehbare Rampe θ (Höhe h) → Kante → 128 u tiefer flach.
 * npx tsx tools/critique/v2/momentum/kicker.ts
 *
 * Start direkt am Rampenfuß (z = +8) mit Tempo v, damit die Anlauf-Reibung nicht alles auf 320 drückt.
 * Eingaben: (roll) W+Sprint ohne Sprung — über die Kante abrollen; (edge) Sprung im letzten Bodentick
 * vor der Kante; (hopin) als Bhopper im Flug auf die Rampe (vy −250 beim Aufsetzen), Leertaste gehalten.
 * Gemessen: vy beim Abheben (erster Tick ohne Boden nach Rampenkontakt), Scheitel über der Kante,
 * Flugweite ab Kante bis zur Landung (Median über 12 Phasen).
 */
import { Vector3 } from 'three';
import { VELOCITY_DEFAULT } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { makeInput } from '../../../sim/harness';
import { setMomentum } from './patch';
import { f, kickerWorld, stats } from './common';

const cfg = VELOCITY_DEFAULT;
const TR = cfg.tickRate;

interface Flight { vy: number; vh: number; apex: number; dist: number }

function run(deg: number, h: number, v: number, mode: 'roll' | 'edge' | 'coyote' | 'hopin', phase: number): Flight {
  const { level, edgeZ, landY } = kickerWorld(deg, h);
  const pm = new PlayerMovement(level.world, cfg);
  if (mode === 'hopin') {
    // Im Flug knapp vor/über dem Rampenfuß, fällt auf die Rampe.
    pm.teleport(new Vector3(0, 40 + phase, 40 + phase * 3));
    pm.state.vel.set(0, -250, -v);
  } else {
    pm.teleport(new Vector3(0, 1, 8 + phase));
    pm.state.vel.set(0, 0, -v);
  }
  let vy = Number.NaN;
  let vh = Number.NaN;
  let apex = -Infinity;
  let touchedRamp = false;
  let leftAt = -1;
  let coyoteDone = false;
  for (let t = 0; t < 6 * TR; t++) {
    const s = pm.state;
    const nextZ = s.pos.z + (s.vel.z / TR) * 2;
    const edgeJump = mode === 'edge' && s.onGround && nextZ - 16 < edgeZ;
    const hold = mode === 'hopin';
    const coyoteJump = mode === 'coyote' && touchedRamp && !s.onGround && !coyoteDone;
    if (coyoteJump) coyoteDone = true;
    pm.tick(makeInput({ yaw: 0, forward: mode === 'hopin' ? 0 : 1, sprint: true, jumpHeld: hold || edgeJump || coyoteJump, jumpPressed: edgeJump || coyoteJump || (hold && t === 0) }));
    if (s.pos.z < 0 && s.pos.z > edgeZ - 16 && (s.onGround || s.pos.y > 0)) touchedRamp = true;
    if (touchedRamp && leftAt < 0 && (mode !== 'coyote' || coyoteDone) && !s.onGround && s.pos.z - 16 < edgeZ + 1) {
      leftAt = t;
      vy = s.vel.y;
      vh = s.speed;
    }
    if (leftAt >= 0) apex = Math.max(apex, s.pos.y - h);
    if (leftAt >= 0 && s.onGround && s.pos.y < h - 1) return { vy, vh, apex, dist: edgeZ - s.pos.z };
    if (s.pos.y < landY - 50) break;
  }
  return { vy, vh, apex, dist: Number.NaN };
}

const VARS: Array<[string, Parameters<typeof setMomentum>[0]]> = [
  ['vorher', 'off'],
  ['kicker k=1', { kicker: true, kickK: 1 }],
  ['kickjump k=1', { kickJump: true, kickJumpK: 1 }],
  ['kickjump k=0.5', { kickJump: true, kickJumpK: 0.5 }],
];

function use(v: Parameters<typeof setMomentum>[0]): void {
  setMomentum('off');
  if (v !== 'off') setMomentum(v);
}

console.log('\n## Kicker: Rampe θ, Höhe h, Kante, Landefläche 128 u unter dem Rampenfuß\n');
console.log('Je Variante: vy beim Abheben / Scheitel über Kante / Flugweite ab Kante (Median 12 Phasen)\n');
console.log(`| θ | h | v | Eingabe | ${VARS.map(([n]) => n).join(' | ')} |`);
console.log(`|---|---|---|---|${VARS.map(() => '---').join('|')}|`);
for (const deg of [10, 16, 25, 35]) {
  for (const h of [32, 64]) {
    for (const v of [320, 600, 900]) {
      for (const mode of ['roll', 'edge', 'coyote', 'hopin'] as const) {
        const cols: string[] = [];
        for (const [, opt] of VARS) {
          use(opt);
          const rs: Flight[] = [];
          for (let p = 0; p < 12; p++) rs.push(run(deg, h, v, mode, p * 2.7));
          const ok = rs.filter((r) => Number.isFinite(r.vy));
          const vy = stats(ok.map((r) => r.vy)).med;
          const ap = stats(ok.map((r) => r.apex)).med;
          const di = stats(ok.map((r) => r.dist).filter(Number.isFinite));
          cols.push(`${f(vy)} / ${f(ap)} / ${f(di.med)}`);
        }
        const label = mode === 'roll' ? 'abrollen' : mode === 'edge' ? 'Sprung 2 Ticks vor Kante' : mode === 'coyote' ? 'Sprung an der Lippe (Coyote)' : 'Hop auf Rampe (gehalten)';
        console.log(`| ${deg}° | ${h} | ${v} | ${label} | ${cols.join(' | ')} |`);
      }
    }
  }
}
use('off');
