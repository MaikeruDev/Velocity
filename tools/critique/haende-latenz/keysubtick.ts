/**
 * Kritik-Linse HAENDE & LATENZ — Sim: Tasten werden pro FRAME uebernommen (alle Ticks des
 * Frames sehen die neue Taste, auch die, deren Zeit VOR dem Druck liegt), die Maus dagegen
 * nach Tick-Zeit interpoliert. Was kostet das beim Air-Strafe gegenueber Tasten nach Tick-Zeit?
 *
 * Hand-Modell (offen, wie ein Mensch): Blick dreht mit konstanter Rate omega, Richtung wechselt
 * alle S Sekunden, A/D wechselt im SELBEN Moment wie die Maus. Leertaste gehalten (Auto-Hop).
 * Varianten:
 *   ideal   — Taste und Blick exakt zur Tick-Zeit (Referenz)
 *   frame   — wie das Spiel: Maus pro Frame (Subtick-interpoliert), Tasten ab Tick 0 des Frames
 *   subtick — Maus wie das Spiel, Tasten nach Tick-Zeit (Vorschlag)
 *
 *   npx tsx tools/critique/haende-latenz/keysubtick.ts
 */
import { Vector3 } from 'three';
import { FixedLoop } from '../../../src/engine/Loop';
import { InputState } from '../../../src/engine/InputState';
import { VELOCITY_DEFAULT } from '../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../src/player/PlayerMovement';
import type { MutablePlayerInput } from '../../../src/player/types';
import { compileLevel } from '../../../src/world/level/compileLevel';
import { flatLevel } from '../../sim/levels';

const DEG = Math.PI / 180;
const LOOK = { sensitivity: 1, mYaw: 0.022, invertY: false };
const RAD_PER_COUNT = LOOK.sensitivity * LOOK.mYaw * DEG;
const world = compileLevel(flatLevel()).world;

type Variant = 'ideal' | 'frame' | 'subtick';

function run(variant: Variant, hz: number, omegaDeg: number, S: number, phase: number, seconds: number): number {
  const cfg = VELOCITY_DEFAULT;
  const pm = new PlayerMovement(world, cfg);
  pm.teleport(new Vector3(0, 1, 0));
  // Ein paar Ticks absetzen
  const idle: MutablePlayerInput = { forward: 0, side: 0, jumpHeld: false, jumpPressed: false, crouch: false, sprint: false, yaw: 0, pitch: 0 };
  for (let i = 0; i < 8; i++) pm.tick(idle);
  pm.state.vel.set(0, 0, -250);

  const omega = omegaDeg * DEG;
  // Blick zentriert um die Anfangsrichtung: erste Halbperiode S/2.
  const dirAt = (t: number): number => {
    if (t < S / 2) return 1;
    return Math.floor((t - S / 2) / S) % 2 === 0 ? -1 : 1;
  };
  const yawAt = (t: number): number => {
    // Integral der stueckweise konstanten Drehrate
    if (t <= S / 2) return omega * t;
    let y = omega * (S / 2);
    let tt = S / 2;
    let d = -1;
    while (tt + S <= t) {
      y += d * omega * S;
      tt += S;
      d = -d;
    }
    return y + d * omega * (t - tt);
  };
  // yaw steigt = nach links drehen -> A (side -1)
  const keyAt = (t: number): number => (dirAt(t) > 0 ? -1 : 1);

  const input = new InputState();
  input.keyDown('Space', false);
  let frameT0 = 0;
  let frameT1 = 0;
  const out: MutablePlayerInput = { ...idle };
  const loop = new FixedLoop({
    tickRate: cfg.tickRate,
    maxFrameTime: 1,
    now: () => 0,
    onFrameStart: () => input.beginFrame(),
    onTick: (_dt, i, n, u) => {
      const cmd = input.tickInput(i, n, u);
      const tickT = frameT0 + u * (frameT1 - frameT0);
      out.forward = 0;
      out.jumpHeld = cmd.jumpHeld;
      out.jumpPressed = cmd.jumpPressed;
      out.crouch = false;
      out.sprint = false;
      out.pitch = 0;
      out.yaw = variant === 'ideal' ? yawAt(tickT) : cmd.yaw;
      out.side = variant === 'frame' ? cmd.side : keyAt(tickT);
      pm.tick(out);
    },
    onFrame: () => undefined,
  });
  // Phase: erster Frame bei phase/hz
  const frames = Math.floor(seconds * hz);
  let prevYaw = 0;
  let prevKey = keyAt(0);
  input.keyDown(prevKey < 0 ? 'KeyA' : 'KeyD', false);
  let lastT = 0;
  for (let k = 0; k < frames; k++) {
    const T = (k + phase) / hz;
    // Browser-Reihenfolge: Tasten-Events zwischen den Frames kommen sofort an, die Maus (rAF-aligned) direkt vor dem Frame.
    const kNow = keyAt(T);
    if (kNow !== prevKey) {
      input.keyUp(prevKey < 0 ? 'KeyA' : 'KeyD');
      input.keyDown(kNow < 0 ? 'KeyA' : 'KeyD', false);
      prevKey = kNow;
    }
    const y = yawAt(T);
    input.look(-(y - prevYaw) / RAD_PER_COUNT, 0, LOOK);
    prevYaw = y;
    frameT0 = lastT;
    frameT1 = T;
    loop.advance(T - lastT);
    lastT = T;
  }
  return Math.hypot(pm.state.vel.x, pm.state.vel.z);
}

const SECONDS = 6;
const PHASES = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
console.log(`Speed nach ${SECONDS} s Auto-Hop + Air-Strafe, Mittel ueber ${PHASES.length} Phasenlagen`);
console.log('omega  S     Hz  | ideal  frame (Verlust)  subtick (Verlust)');
for (const [omegaDeg, S] of [
  [200, 0.3],
  [300, 0.25],
  [400, 0.2],
  [500, 0.15],
] as const) {
  for (const hz of [60, 144, 240]) {
    const mean = (v: Variant): number => PHASES.reduce((a, p) => a + run(v, hz, omegaDeg, S, p, SECONDS), 0) / PHASES.length;
    const ideal = mean('ideal');
    const frame = mean('frame');
    const sub = mean('subtick');
    const pct = (x: number): string => `${(((x - ideal) / (ideal - 250)) * 100).toFixed(1)} %`;
    console.log(
      `${String(omegaDeg).padStart(5)}  ${S.toFixed(2)}  ${String(hz).padStart(3)} | ${ideal.toFixed(0).padStart(5)}  ${frame.toFixed(0).padStart(5)} (${pct(frame).padStart(7)})  ${sub.toFixed(0).padStart(5)} (${pct(sub).padStart(7)})`,
    );
  }
}
console.log('Verlust = Anteil am Speed-GEWINN (ueber 250) gegenueber ideal.');
