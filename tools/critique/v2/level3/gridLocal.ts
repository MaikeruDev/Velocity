/**
 * Surf-Raster wie physics.surfGrid, aber mit frei wählbarer Blickachse des Grundtechnik-Surfers.
 *
 * physics.surfGrid lässt den Surfer entlang des nächsten ROUTEN-Segments blicken. In Kurven hinkt
 * diese Achse der Rampe nach (Sehnen), der Blick zeigt dauerhaft etwas in die Rampe — das bremst
 * (Taste nicht mehr quer zur Fahrt) und addiert sich zum Blickfehler +2°. Ein Mensch blickt entlang
 * der Rampe VOR sich. `pathAxis` liefert die echte Richtung des Rampenstücks unter dem Fahrer.
 */
import { Box3, Vector3 } from 'three';
import { VELOCITY_DEFAULT, type MovementConfig } from '../../../../src/player/MovementConfig';
import { PlayerMovement } from '../../../../src/player/PlayerMovement';
import { MIN_GROUND_NORMAL_Y } from '../../../../src/world/collision/types';
import type { CompiledLevel } from '../../../../src/world/level/compileLevel';
import { SurfRider, simulate, type ProbeOutcome, type SurfGridSpec } from '../../../levels/physics';
import type { SurfPath } from './surfPath';

const DOWN_MINS = new Vector3(-16, 0, -16);
const DOWN_MAXS = new Vector3(16, 72, 16);

/** Blickachse (yaw, rad) = Richtung des Rampenstücks, dessen Grat dem Fahrer am nächsten liegt. */
export function pathAxis(paths: readonly SurfPath[]): (x: number, z: number) => number {
  const segs: Array<{ ax: number; az: number; bx: number; bz: number; yaw: number }> = [];
  for (const p of paths)
    for (const pc of p.pieces) {
      const [ax, az] = pc.frame.xz(0);
      const [bx, bz] = pc.frame.xz(pc.length);
      segs.push({ ax, az, bx, bz, yaw: (pc.yaw * Math.PI) / 180 });
    }
  return (x, z) => {
    let best = Infinity;
    let yaw = 0;
    for (const s of segs) {
      const sx = s.bx - s.ax;
      const sz = s.bz - s.az;
      const l2 = sx * sx + sz * sz;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * sx + (z - s.az) * sz) / l2));
      const d = Math.hypot(x - (s.ax + sx * t), z - (s.az + sz * t));
      if (d < best) {
        best = d;
        yaw = s.yaw;
      }
    }
    return yaw;
  };
}

export interface LocalGridResult {
  readonly runs: number;
  readonly fails: ReadonlyArray<{ speed: number; lateral: number; look: number; out: ProbeOutcome }>;
  readonly seams: number;
  readonly goal: readonly [number, number];
}

/** Raster ab einem Startpunkt auf einer Flanke (Knoten), Richtung `dir`, bis `goal`. */
export function localGrid(level: CompiledLevel, start: Vector3, dir: Vector3, goal: Box3, axis: (x: number, z: number) => number, spec: SurfGridSpec, cfg: MovementConfig = VELOCITY_DEFAULT, timeout = 25): LocalGridResult {
  const tr0 = level.world.traceBox(new Vector3(start.x, start.y + 8, start.z), new Vector3(start.x, start.y - 200, start.z), DOWN_MINS, DOWN_MAXS);
  const n = tr0.normal;
  const fails: Array<{ speed: number; lateral: number; look: number; out: ProbeOutcome }> = [];
  let runs = 0;
  let seams = 0;
  let lo = Infinity;
  let hi = 0;
  if (tr0.fraction >= 1 || !(n.y > 0.05 && n.y < MIN_GROUND_NORMAL_Y)) return { runs: 0, fails, seams, goal: [0, 0] };
  const out = new Vector3(n.x, 0, n.z).normalize();
  for (const lateral of spec.laterals) {
    const x = start.x + out.x * lateral;
    const z = start.z + out.z * lateral;
    const tr = level.world.traceBox(new Vector3(x, start.y + 600, z), new Vector3(x, start.y - 1200, z), DOWN_MINS, DOWN_MAXS);
    if (tr.startSolid || tr.fraction >= 1 || tr.normal.dot(n) < 0.999) continue;
    const p = new Vector3(x, tr.endPos.y + 2, z);
    for (const speed of spec.speeds) {
      for (const look of spec.looksDeg) {
        const pm = new PlayerMovement(level.world, cfg);
        pm.teleport(p);
        pm.state.vel.set(dir.x * speed, 0, dir.z * speed);
        const res = simulate(level, pm, new SurfRider(cfg, level.world, axis, (look * Math.PI) / 180), { cfg, goal, timeout });
        runs++;
        if (res.seam) seams++;
        if (!res.ok) fails.push({ speed, lateral, look, out: res });
        else {
          lo = Math.min(lo, res.goalSpeed);
          hi = Math.max(hi, res.goalSpeed);
        }
      }
    }
  }
  return { runs, fails, seams, goal: [Number.isFinite(lo) ? lo : 0, hi] };
}

/**
 * Vorschlag für physics.SurfRider: an der Flanke Blick in FLUGRICHTUNG (horizontal), Taste quer dazu in die Rampe —
 * so fährt ein Mensch. Die Routen-Achse hinkt in Kurven der Rampe nach (Sehnen) und dreht den Blick in die Rampe:
 * die Taste bekommt einen Anteil gegen die Fahrt und bremst (Stillstand in der Kehre bei 400 u/s + Blickfehler 2°).
 * Die Flankennormale taugt nicht als Achse: auf fallenden Rampen zeigt −n_h teils gegen die Fahrt (fallen.md #18).
 * Ohne Flankenkontakt: Routen-Achse wie bisher.
 */
export class RampRider {
  private readonly inner: SurfRider;
  private velAxis = Number.NaN;

  constructor(cfg: MovementConfig, world: CompiledLevel['world'], private readonly routeAxis: (x: number, z: number) => number, lookOffset = 0) {
    this.inner = new SurfRider(cfg, world, (x, z) => (Number.isNaN(this.velAxis) ? this.routeAxis(x, z) : this.velAxis), lookOffset);
  }

  next(s: Parameters<SurfRider['next']>[0], n: Vector3): ReturnType<SurfRider['next']> {
    const vh = Math.hypot(s.vel.x, s.vel.z);
    const onFlank = n.y > 0.05 && n.y < MIN_GROUND_NORMAL_Y && Math.hypot(n.x, n.z) > 0.2;
    this.velAxis = onFlank && !s.onGround && vh > 150 ? Math.atan2(-s.vel.x, -s.vel.z) : Number.NaN;
    return this.inner.next(s, n);
  }
}

/** Raster mit RampRider (Blick entlang der Rampe unter dem Fahrer). */
export function rampGrid(level: CompiledLevel, start: Vector3, dir: Vector3, goal: Box3, routeAxisFn: (x: number, z: number) => number, spec: SurfGridSpec, cfg: MovementConfig = VELOCITY_DEFAULT, timeout = 25): LocalGridResult {
  const tr0 = level.world.traceBox(new Vector3(start.x, start.y + 8, start.z), new Vector3(start.x, start.y - 200, start.z), DOWN_MINS, DOWN_MAXS);
  const n = tr0.normal;
  const fails: Array<{ speed: number; lateral: number; look: number; out: ProbeOutcome }> = [];
  let runs = 0;
  let seams = 0;
  let lo = Infinity;
  let hi = 0;
  if (tr0.fraction >= 1 || !(n.y > 0.05 && n.y < MIN_GROUND_NORMAL_Y)) return { runs: 0, fails, seams, goal: [0, 0] };
  const out = new Vector3(n.x, 0, n.z).normalize();
  for (const lateral of spec.laterals) {
    const x = start.x + out.x * lateral;
    const z = start.z + out.z * lateral;
    const tr = level.world.traceBox(new Vector3(x, start.y + 600, z), new Vector3(x, start.y - 1200, z), DOWN_MINS, DOWN_MAXS);
    if (tr.startSolid || tr.fraction >= 1 || tr.normal.dot(n) < 0.999) continue;
    const p = new Vector3(x, tr.endPos.y + 2, z);
    for (const speed of spec.speeds) {
      for (const look of spec.looksDeg) {
        const pm = new PlayerMovement(level.world, cfg);
        pm.teleport(p);
        pm.state.vel.set(dir.x * speed, 0, dir.z * speed);
        const res = simulate(level, pm, new RampRider(cfg, level.world, routeAxisFn, (look * Math.PI) / 180), { cfg, goal, timeout });
        runs++;
        if (res.seam) seams++;
        if (!res.ok) fails.push({ speed, lateral, look, out: res });
        else {
          lo = Math.min(lo, res.goalSpeed);
          hi = Math.max(hi, res.goalSpeed);
        }
      }
    }
  }
  return { runs, fails, seams, goal: [Number.isFinite(lo) ? lo : 0, hi] };
}
