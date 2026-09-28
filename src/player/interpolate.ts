import type { MutablePlayerSnapshot, PlayerSnapshot } from './types';

/**
 * Render-Interpolation zwischen zwei Physik-Ticks: pos, eyeHeight und vel
 * linear, alles andere vom neueren Snapshot `b`. `out` darf `a` oder `b` sein.
 */
export function lerpSnapshot(a: PlayerSnapshot, b: PlayerSnapshot, t: number, out: MutablePlayerSnapshot): void {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  const eye = a.eyeHeight + (b.eyeHeight - a.eyeHeight) * u;
  out.pos.set(
    a.pos.x + (b.pos.x - a.pos.x) * u,
    a.pos.y + (b.pos.y - a.pos.y) * u,
    a.pos.z + (b.pos.z - a.pos.z) * u,
  );
  out.vel.set(
    a.vel.x + (b.vel.x - a.vel.x) * u,
    a.vel.y + (b.vel.y - a.vel.y) * u,
    a.vel.z + (b.vel.z - a.vel.z) * u,
  );
  out.eyeHeight = eye;
  out.onGround = b.onGround;
  out.groundNormal.copy(b.groundNormal);
  out.ducked = b.ducked;
  out.speed = b.speed;
  out.hopChain = b.hopChain;
  out.stridePhase = b.stridePhase;
  out.strafeSync = b.strafeSync;
  out.airTime = b.airTime;
  out.surfing = b.surfing;
  out.surfNormal.copy(b.surfNormal);
}
