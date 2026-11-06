// Stil 'hub' — Low-Poly-Baukasten: Quader/Prismen mit Vertex-Farbe in EINE Geometrie (wenige Draw Calls).
import { BufferAttribute, BufferGeometry } from 'three';
import type { Rgb } from './theme';

/** Fragment-Modus im Lit-Shader (aMeta.z). */
export const MODE = {
  plain: 0,
  /** Fensterraster der Stadt (Weltkoordinaten). */
  windows: 1,
  /** Bodenraster des Hubs. */
  floor: 2,
  /** Neon, das ab und zu flackert. */
  flicker: 3,
  /** Röhrenbildschirm (Zeilen laufen). */
  screen: 4,
  /** Warnstreifen (schräg, gelb/schwarz). */
  hazard: 5,
} as const;

/** Emission (aMeta.x): 0 = beleuchtet, 1 = leuchtet, 2 = leuchtet + pulst mit der Kick. */
export const EMIT = { lit: 0, glow: 1, pulse: 2 } as const;

/** Keine Station (Gruppe ohne Hervorhebung). */
export const NO_GROUP = 31;

interface Frame {
  ox: number;
  oy: number;
  oz: number;
  /** Basisvektoren der lokalen x/z-Achse (y bleibt oben). */
  xx: number;
  xz: number;
  zx: number;
  zz: number;
}

export class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly meta: number[] = [];
  private readonly idx: number[] = [];
  private f: Frame = { ox: 0, oy: 0, oz: 0, xx: 1, xz: 0, zx: 0, zz: 1 };
  /** Aktuelle Station (Gruppe) für alles, was jetzt gebaut wird. */
  group = NO_GROUP;

  /** Lokaler Rahmen: Ursprung + Drehung um y (gleiche Konvention wie layout.localToWorld). */
  setFrame(ox: number, oy: number, oz: number, yaw: number): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    this.f = { ox, oy, oz, xx: c, xz: s, zx: -s, zz: c };
  }

  resetFrame(): void {
    this.setFrame(0, 0, 0, 0);
  }

  private tx(x: number, z: number): number {
    return this.f.ox + this.f.xx * x + this.f.zx * z;
  }
  private tz(x: number, z: number): number {
    return this.f.oz + this.f.xz * x + this.f.zz * z;
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: Rgb, emit: number, mode: number): number {
    const i = this.pos.length / 3;
    this.pos.push(this.tx(x, z), this.f.oy + y, this.tz(x, z));
    this.nor.push(this.f.xx * nx + this.f.zx * nz, ny, this.f.xz * nx + this.f.zz * nz);
    this.col.push(c[0], c[1], c[2]);
    this.meta.push(emit, this.group, mode);
    return i;
  }

  /** Viereck a-b-c-d (gegen den Uhrzeigersinn von vorn), flach schattiert. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    c: Rgb, emit = 0, mode = 0, shadeTop = 1,
  ): void {
    // Normale aus (b-a)×(d-a)
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = dx - ax, vy = dy - ay, vz = dz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const top: Rgb = shadeTop === 1 ? c : [c[0] * shadeTop, c[1] * shadeTop, c[2] * shadeTop];
    const i0 = this.vert(ax, ay, az, nx, ny, nz, c, emit, mode);
    const i1 = this.vert(bx, by, bz, nx, ny, nz, c, emit, mode);
    const i2 = this.vert(cx, cy, cz, nx, ny, nz, top, emit, mode);
    const i3 = this.vert(dx, dy, dz, nx, ny, nz, top, emit, mode);
    this.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /**
   * Quader um (cx, cy, cz) lokal, Größe sx×sy×sz. `faces` blendet Seiten aus (Bitmaske: 1 +x, 2 −x, 4 +y, 8 −y,
   * 16 +z, 32 −z). `grad` dunkelt die Unterkante der Seiten ab (Fake-AO, PS2-typischer Verlauf).
   */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, c: Rgb, emit = 0, mode = 0, faces = 63, grad = 0.72): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    const lo: Rgb = emit > 0 ? c : [c[0] * grad, c[1] * grad, c[2] * grad];
    const side = (
      ax: number, ay: number, az: number, bx: number, by: number, bz: number,
      ccx: number, ccy: number, ccz: number, dx: number, dy: number, dz: number,
    ): void => {
      // Unten (a, b) dunkler, oben (c, d) volle Farbe.
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = dx - ax, vy = dy - ay, vz = dz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      const i0 = this.vert(ax, ay, az, nx, ny, nz, lo, emit, mode);
      const i1 = this.vert(bx, by, bz, nx, ny, nz, lo, emit, mode);
      const i2 = this.vert(ccx, ccy, ccz, nx, ny, nz, c, emit, mode);
      const i3 = this.vert(dx, dy, dz, nx, ny, nz, c, emit, mode);
      this.idx.push(i0, i1, i2, i0, i2, i3);
    };
    if (faces & 16) side(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
    if (faces & 32) side(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0);
    if (faces & 1) side(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1);
    if (faces & 2) side(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
    if (faces & 4) this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, c, emit, mode);
    if (faces & 8) this.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, lo, emit, mode);
  }

  /** Senkrechtes n-Prisma (Zylinder low-poly) um (cx, cz), von y0 bis y1. */
  prism(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, n: number, c: Rgb, emit = 0, mode = 0, caps = true, phase = 0): void {
    const lo: Rgb = emit > 0 ? c : [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7];
    for (let i = 0; i < n; i++) {
      const a0 = phase + (i / n) * Math.PI * 2;
      const a1 = phase + ((i + 1) / n) * Math.PI * 2;
      const s0 = Math.sin(a0), c0 = Math.cos(a0), s1 = Math.sin(a1), c1 = Math.cos(a1);
      const am = (a0 + a1) / 2;
      const nx = Math.sin(am), nz = Math.cos(am);
      const i0 = this.vert(cx + s0 * r0, y0, cz + c0 * r0, nx, 0, nz, lo, emit, mode);
      const i1 = this.vert(cx + s1 * r0, y0, cz + c1 * r0, nx, 0, nz, lo, emit, mode);
      const i2 = this.vert(cx + s1 * r1, y1, cz + c1 * r1, nx, 0, nz, c, emit, mode);
      const i3 = this.vert(cx + s0 * r1, y1, cz + c0 * r1, nx, 0, nz, c, emit, mode);
      this.idx.push(i0, i1, i2, i0, i2, i3);
      if (caps && r1 > 0) {
        const t0 = this.vert(cx, y1, cz, 0, 1, 0, c, emit, mode);
        const t1 = this.vert(cx + s0 * r1, y1, cz + c0 * r1, 0, 1, 0, c, emit, mode);
        const t2 = this.vert(cx + s1 * r1, y1, cz + c1 * r1, 0, 1, 0, c, emit, mode);
        this.idx.push(t0, t1, t2);
      }
    }
  }

  /** Flacher Ring (Kreisband) auf Höhe y, z. B. Neon-Kante des Dachs. */
  ring(cx: number, cz: number, y: number, r0: number, r1: number, n: number, c: Rgb, emit = 0, mode = 0, a0 = 0, a1 = Math.PI * 2): void {
    for (let i = 0; i < n; i++) {
      const u0 = a0 + ((a1 - a0) * i) / n;
      const u1 = a0 + ((a1 - a0) * (i + 1)) / n;
      const p = (r: number, u: number): [number, number] => [cx + Math.sin(u) * r, cz - Math.cos(u) * r];
      const [ax, az] = p(r0, u0);
      const [bx, bz] = p(r0, u1);
      const [qx, qz] = p(r1, u1);
      const [dx, dz] = p(r1, u0);
      const i0 = this.vert(ax, y, az, 0, 1, 0, c, emit, mode);
      const i1 = this.vert(dx, y, dz, 0, 1, 0, c, emit, mode);
      const i2 = this.vert(qx, y, qz, 0, 1, 0, c, emit, mode);
      const i3 = this.vert(bx, y, bz, 0, 1, 0, c, emit, mode);
      // Reihenfolge so, dass die Fläche von oben gegen den Uhrzeigersinn läuft (FrontSide).
      this.idx.push(i0, i2, i1, i0, i3, i2);
    }
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aMeta', new BufferAttribute(new Float32Array(this.meta), 3));
    const n = this.pos.length / 3;
    g.setIndex(new BufferAttribute(n > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}
