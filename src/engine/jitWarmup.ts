import { PerspectiveCamera, Vector3 } from 'three';
import { CameraRig, cameraViewFromSnapshot, makeCameraView } from '../player/CameraRig';
import { lerpSnapshot } from '../player/interpolate';
import type { MovementConfig } from '../player/MovementConfig';
import { PlayerMovement } from '../player/PlayerMovement';
import { StrafeBot } from '../player/bots';
import type { CollisionWorld } from '../world/collision/types';

/**
 * JIT-Vorwärmen der heißen Pfade (Plan 003, S9): Movement-Tick, Box-Traces,
 * Interpolation und Kamera-Rig laufen einmal auf Wegwerf-Instanzen im Leerlauf
 * des Titelbildschirms. Ohne das laufen sie in den ersten ~10 s im Interpreter bzw.
 * Baseline-Code — der boxt jede Gleitkommazahl (Level 2 ohne Bot: ~355 KiB/s aus src/
 * nach 2.5 s, ~42 KiB/s nach 60 s; fallen.md #65) und ist langsamer, genau in den
 * ersten Sekunden, in denen sich das Spiel beweisen muss.
 *
 * Nur Typ-Feedback, kein Zustand: eigene PlayerMovement/CameraRig-Instanzen, die
 * Welt wird nur gelesen. Gleiche Klassen → gleiche Feedback-Vektoren wie im Spiel.
 */

/** Ticks Vorwärmen (bei 128 Hz = 64 s Spielzeit). */
const WARM_TICKS = 8192;
/** Alle so viele Ticks zurück an den Spawn — der Bot soll über Boden, nicht ins Leere. */
const RESPAWN_EVERY = 384;

export function warmHotPaths(world: CollisionWorld, cfg: MovementConfig, spawn: Vector3, yawDeg: number): number {
  const t0 = performance.now();
  const pm = new PlayerMovement(world, cfg);
  const rig = new CameraRig(new PerspectiveCamera(74, 16 / 9, 2, 30000));
  rig.setMovement(cfg);
  const prev = PlayerMovement.createSnapshot();
  const cur = PlayerMovement.createSnapshot();
  const interp = PlayerMovement.createSnapshot();
  const view = makeCameraView();
  const start = new Vector3(spawn.x, spawn.y + 1, spawn.z);
  const yaw = (yawDeg * Math.PI) / 180;
  let bot = new StrafeBot(cfg, { sync: 1, heading: yaw, mode: 'zigzag' });
  pm.teleport(start);
  for (let i = 0; i < WARM_TICKS; i++) {
    if (i % RESPAWN_EVERY === 0) {
      pm.teleport(start);
      bot = new StrafeBot(cfg, { sync: 0.9, heading: yaw + (i / RESPAWN_EVERY) * 0.4, mode: i % 2 === 0 ? 'zigzag' : 'steer' });
      rig.reset();
    }
    pm.copySnapshot(prev);
    const cmd = bot.next(pm.state);
    const events = pm.tick(cmd);
    for (let k = 0; k < events.length; k++) rig.onEvent(events[k]);
    pm.copySnapshot(cur);
    // Kamera wie bei ~64 fps: jeder zweite Tick ein Frame.
    if (i % 2 === 1) {
      lerpSnapshot(prev, cur, 0.5, interp);
      cameraViewFromSnapshot(interp, cmd.sprint, cmd.side, view);
      rig.update(1 / 64, view, cmd.yaw, cmd.pitch);
    }
  }
  return performance.now() - t0;
}
