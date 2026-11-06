// Stil 'hub' — Kamerafahrt zwischen Stationen. Zustand als Zahlen (keine Allokation je Frame).
import type { PerspectiveCamera } from 'three';
import { EASE } from './layout';
import type { Station } from './layout';

/** Pose = Polarkoordinaten um die Hub-Mitte. Augen auf (angle, dist), Ziel auf (angle, lookR) + Seitversatz. */
interface Pose {
  angle: number;
  dist: number;
  eyeY: number;
  lookR: number;
  lookY: number;
  /** Seitversatz des Ziels in m (Station steht links der Bildmitte, rechts ist Platz für die Karte). */
  side: number;
}

const BOOT_S = 3.0;
const VFOV = 50;

function copy(dst: Pose, src: Pose): void {
  dst.angle = src.angle;
  dst.dist = src.dist;
  dst.eyeY = src.eyeY;
  dst.lookR = src.lookR;
  dst.lookY = src.lookY;
  dst.side = src.side;
}

export class CameraRig {
  private readonly from: Pose = { angle: 0, dist: 0, eyeY: 1.6, lookR: 10, lookY: 1.6, side: 0 };
  private readonly to: Pose = { angle: 0, dist: 0, eyeY: 1.6, lookR: 10, lookY: 1.6, side: 0 };
  private readonly cur: Pose = { angle: 0, dist: 0, eyeY: 1.6, lookR: 10, lookY: 1.6, side: 0 };
  private flightT = 1;
  private flightDur = 0.6;
  private prevAngle = 0;
  private roll = 0;
  /** Anflug beim ersten Mount: 0..1, ≥ 1 = fertig. */
  private boot = 1;
  /** Maus-Parallaxe (−1..1), geglättet. */
  private mx = 0;
  private my = 0;
  targetMx = 0;
  targetMy = 0;
  /** Bildschirm-Seitenverhältnis des 16:9-Rahmens (für den Seitversatz). */
  safeAspect = 16 / 9;
  /** Plakatwand hinter dem Hub (world.ts BILLBOARD). */
  readonly bootTarget = { x: 0, y: 22, z: 86 };

  static readonly VFOV = VFOV;

  private pose(st: Station, out: Pose): void {
    out.angle = st.angle;
    out.dist = st.radius - st.view;
    out.eyeY = 1.75;
    out.lookR = st.radius;
    out.lookY = st.lookY;
    // Station etwa bei 33 % der Rahmenbreite: NDC −0.34 → Seitversatz = view · 0.3 · aspect · tan(vfov/2).
    out.side = st.view * 0.34 * this.safeAspect * Math.tan((VFOV * Math.PI) / 360);
  }

  /** Sofort dort sein (Rückkehr, reducedMotion). */
  jump(st: Station): void {
    this.pose(st, this.to);
    copy(this.from, this.to);
    copy(this.cur, this.to);
    this.flightT = 1;
    this.prevAngle = this.cur.angle;
  }

  startBoot(): void {
    this.boot = 0;
  }

  get booting(): boolean {
    return this.boot < 1;
  }

  skipBoot(): void {
    this.boot = 1;
  }

  /** Bootfortschritt 0..1 (für das Einblenden der Oberfläche). */
  get bootProgress(): number {
    return this.boot;
  }

  /** Neu zielen (Seitenverhältnis geändert): laufende Fahrt behält ihr Ziel. */
  refresh(st: Station): void {
    this.pose(st, this.to);
    if (this.flightT >= 1) copy(this.cur, this.to);
  }

  flyTo(st: Station, steps: number): void {
    copy(this.from, this.cur);
    this.pose(st, this.to);
    // Kürzester Weg um den Ring (Winkel liegen alle in −π..π, die Reihe ist offen hinten — kein Umweg nötig).
    this.flightT = 0;
    this.flightDur = Math.min(1.05, 0.5 + 0.12 * Math.max(1, Math.abs(steps)));
  }

  get flying(): boolean {
    return this.flightT < 1;
  }

  /** Augen- und Zielpunkt dieses Frames setzen. */
  update(cam: PerspectiveCamera, dt: number, t: number, motion: boolean): void {
    if (this.flightT < 1) {
      this.flightT = Math.min(1, this.flightT + dt / this.flightDur);
      const e = EASE.inOutCubic(this.flightT);
      const c = this.cur;
      const f = this.from;
      const o = this.to;
      c.angle = f.angle + (o.angle - f.angle) * e;
      c.dist = f.dist + (o.dist - f.dist) * e;
      // Bei der Fahrt kurz zurück und hoch (Schwung), mitten im Flug am stärksten.
      const arc = Math.sin(this.flightT * Math.PI) * Math.min(1, Math.abs(o.angle - f.angle) * 1.6);
      c.dist -= arc * 1.1;
      c.eyeY = f.eyeY + (o.eyeY - f.eyeY) * e + arc * 0.35;
      c.lookR = f.lookR + (o.lookR - f.lookR) * e;
      c.lookY = f.lookY + (o.lookY - f.lookY) * e;
      c.side = f.side + (o.side - f.side) * e;
    }
    const c = this.cur;
    // Leichte Neigung in die Kurve (aus der Winkelgeschwindigkeit), weich nachgezogen.
    const av = dt > 0 ? (c.angle - this.prevAngle) / dt : 0;
    this.prevAngle = c.angle;
    const rollTo = motion ? Math.max(-0.05, Math.min(0.05, -av * 0.03)) : 0;
    this.roll += (rollTo - this.roll) * Math.min(1, dt * 6);

    const k = Math.min(1, dt * 3);
    this.mx += ((motion ? this.targetMx : 0) - this.mx) * k;
    this.my += ((motion ? this.targetMy : 0) - this.my) * k;

    const bob = motion ? Math.sin(t * 1.1) * 0.025 : 0;
    const sway = motion ? Math.sin(t * 0.47) * 0.004 : 0;
    const a = c.angle + sway;
    const sa = Math.sin(a);
    const ca = Math.cos(a);
    let ex = sa * c.dist;
    let ey = c.eyeY + bob;
    let ez = -ca * c.dist;
    // Ziel: Station + Seitversatz entlang der Stations-x-Achse (cos a, 0, sin a) + Maus-Parallaxe.
    const side = c.side + this.mx * 0.35;
    let tx = sa * c.lookR + ca * side;
    let ty = c.lookY + bob * 0.4 - this.my * 0.22;
    let tz = -ca * c.lookR + sa * side;

    if (this.boot < 1) {
      this.boot = Math.min(1, this.boot + dt / BOOT_S);
      // Anflug: hoch über dem Dach, Blick zurück auf die Plakatwand; dann schwenkt die Kamera links herum
      // (an Ausweis, Spind, Training vorbei) und sinkt vor das Portal. Richtung als Gier/Nick interpoliert —
      // ein Ziel-Lerp über 180° liefe durch die Kamera hindurch.
      const p = this.boot;
      const eEye = EASE.inOutCubic(p);
      const eLook = EASE.inOutSine(Math.max(0, Math.min(1, (p - 0.2) / 0.8)));
      const fdx = tx - ex, fdy = ty - ey, fdz = tz - ez;
      const fyaw = Math.atan2(fdx, -fdz);
      const fpitch = Math.atan2(fdy, Math.hypot(fdx, fdz));
      const sx = 0, sy = 7.5, sz = -3.5;
      const bt = this.bootTarget;
      let syaw = Math.atan2(bt.x - sx, -(bt.z - sz));
      if (syaw > 0) syaw -= Math.PI * 2;
      const spitch = Math.atan2(bt.y - sy, Math.hypot(bt.x - sx, bt.z - sz));
      ex = sx + (ex - sx) * eEye;
      ey = sy + (ey - sy) * eEye;
      ez = sz + (ez - sz) * eEye;
      const yaw = syaw + (fyaw - syaw) * eLook;
      const pitch = spitch + (fpitch - spitch) * eLook;
      const cp = Math.cos(pitch);
      tx = ex + Math.sin(yaw) * cp * 10;
      ty = ey + Math.sin(pitch) * 10;
      tz = ez - Math.cos(yaw) * cp * 10;
    }

    cam.position.set(ex, ey, ez);
    cam.up.set(0, 1, 0);
    cam.lookAt(tx, ty, tz);
    if (this.roll !== 0) cam.rotateZ(this.roll);
  }
}
