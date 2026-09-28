/**
 * Autorenwerkzeug für Level: sammelt Brushes, Trigger und Route und baut
 * daraus ein `LevelFile`.
 *
 * Konventionen:
 * - Source-Units, Y oben. yaw in Grad wie im Spiel: 0 = Blick nach -Z,
 *   positiv = nach links drehen (gegen den Uhrzeigersinn von oben).
 * - `Frame` = lokales Koordinatensystem einer Strecke: u = vorwärts,
 *   v = rechts. Bei yaw-Vielfachen von 90° entstehen exakte AABBs (keine
 *   Rotation → keine Rundungsfugen), sonst rotY-Brushes.
 * - Plattformen werden über ihre OBERSEITE (`top`) definiert — die Höhe,
 *   auf der man steht, ist die Planungsgröße, nicht die Box-Mitte.
 * - Alle Zahlen werden auf 1/1000 gerundet: gemeinsame Kanten benachbarter
 *   Segmente sind damit bitgleich (lückenlos, keine Stufen).
 */
import type {
  BoxDef,
  BrushDef,
  EnvironmentDef,
  HullDef,
  LevelFile,
  MaterialId,
  RouteNode,
  TriggerDef,
  Vec3Tuple,
  WedgeDef,
} from '../../src/world/level/LevelFormat';
import { PHYS } from './ballistics';

export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Mathe-Helfer

/** Auf 1/1000 runden — hält das JSON frei von Float-Rauschen (1e-13 aus sin/cos). */
export function r3(n: number): number {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
}

export function forwardOf(yaw: number): V2 {
  const a = yaw * DEG;
  return [-Math.sin(a), -Math.cos(a)];
}

export function rightOf(yaw: number): V2 {
  const a = yaw * DEG;
  return [Math.cos(a), -Math.sin(a)];
}

/** yaw (Grad), mit dem man von `from` nach `to` schaut (nur XZ). */
export function yawTo(from: V2 | V3, to: V2 | V3): number {
  const [fx, fz] = xzOf(from);
  const [tx, tz] = xzOf(to);
  return Math.atan2(-(tx - fx), -(tz - fz)) / DEG;
}

export function xzOf(p: V2 | V3): V2 {
  return p.length === 3 ? [p[0], p[2]] : [p[0], p[1]];
}

export function dist2(a: V2 | V3, b: V2 | V3): number {
  const [ax, az] = xzOf(a);
  const [bx, bz] = xzOf(b);
  return Math.hypot(bx - ax, bz - az);
}

function isOrtho(yaw: number): boolean {
  const m = ((yaw % 90) + 90) % 90;
  return m < 1e-9 || 90 - m < 1e-9;
}

/** Achsbezeichnung für "steigt in Blickrichtung" bei Vielfachen von 90°. */
function axisOfForward(yaw: number): WedgeDef['rise'] {
  const [fx, fz] = forwardOf(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? '+x' : '-x';
  return fz > 0 ? '+z' : '-z';
}

function flipAxis(a: WedgeDef['rise']): WedgeDef['rise'] {
  const map: Record<WedgeDef['rise'], WedgeDef['rise']> = { '+x': '-x', '-x': '+x', '+z': '-z', '-z': '+z' };
  return map[a];
}

// ---------------------------------------------------------------------------
// Frame: lokales Koordinatensystem

export class Frame {
  constructor(
    readonly x: number,
    readonly z: number,
    readonly yaw: number,
  ) {}

  static at(p: V2 | V3, yaw: number): Frame {
    const [x, z] = xzOf(p);
    return new Frame(x, z, yaw);
  }

  /** Weltposition (x, z) des lokalen Punkts (u vorwärts, v rechts). */
  xz(u: number, v = 0): V2 {
    const [fx, fz] = forwardOf(this.yaw);
    const [rx, rz] = rightOf(this.yaw);
    return [this.x + fx * u + rx * v, this.z + fz * u + rz * v];
  }

  p(u: number, v: number, y: number): V3 {
    const [x, z] = this.xz(u, v);
    return [x, y, z];
  }

  move(u: number, v = 0): Frame {
    const [x, z] = this.xz(u, v);
    return new Frame(x, z, this.yaw);
  }

  turn(deg: number): Frame {
    return new Frame(this.x, this.z, this.yaw + deg);
  }
}

/** Achsparallele Hülle (min, max) eines lokalen Rechtecks — für Trigger über Plattformen. */
export function aabbOf(f: Frame, u: V2, v: V2, y: V2): [V3, V3] {
  const cs = [f.xz(u[0], v[0]), f.xz(u[1], v[0]), f.xz(u[0], v[1]), f.xz(u[1], v[1])];
  const xs = cs.map((c) => c[0]);
  const zs = cs.map((c) => c[1]);
  return [
    [Math.min(...xs), y[0], Math.min(...zs)],
    [Math.max(...xs), y[1], Math.max(...zs)],
  ];
}

/**
 * Bogenradius, bei dem Sehnen der Längen `chords` zusammen genau `totalDeg`
 * Grad überstreichen (Bisektion; Sehne c ↔ Winkel 2·asin(c/2R)).
 */
export function solveArcRadius(chords: readonly number[], totalDeg: number): number {
  const sweep = (r: number): number => chords.reduce((s, c) => s + 2 * Math.asin(Math.min(1, c / (2 * r))), 0) / DEG;
  let lo = Math.max(...chords) / 2 + 1e-6;
  let hi = 1e6;
  if (sweep(lo) < totalDeg) throw new Error(`Sehnen zu kurz für ${totalDeg}°`);
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sweep(mid) > totalDeg) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Punkt auf einem Kreis; φ gegen den Uhrzeigersinn von +X (wie Ring), Fahrtrichtung dort = yaw φ. */
export function arcPoint(center: V2, r: number, phiDeg: number): V2 {
  const a = phiDeg * DEG;
  return [center[0] + r * Math.cos(a), center[1] - r * Math.sin(a)];
}

/** Winkel (Grad), den eine Sehne c auf Radius r überstreicht. */
export function chordDeg(c: number, r: number): number {
  return (2 * Math.asin(Math.min(1, c / (2 * r)))) / DEG;
}

// ---------------------------------------------------------------------------
// Brush-Primitive (rein, ohne Builder)

export interface Style {
  readonly mat?: MaterialId;
  readonly tint?: string;
  readonly trim?: boolean;
  readonly tag?: string;
  readonly collide?: boolean;
  /** false = unsichtbarer Clip (kollidiert, wird nicht gerendert). */
  readonly visible?: boolean;
  /** Leuchtband an der Unterkante (LevelFormat.BrushCommon.underTrim). */
  readonly underTrim?: boolean;
}

function styleProps(s: Style, fallback: MaterialId): Pick<BoxDef, 'mat' | 'tint' | 'trim' | 'tag' | 'collide' | 'visible' | 'underTrim'> {
  const out: { mat: MaterialId; tint?: string; trim?: boolean; tag?: string; collide?: boolean; visible?: boolean; underTrim?: boolean } = { mat: s.mat ?? fallback };
  if (s.tint !== undefined) out.tint = s.tint;
  if (s.trim !== undefined) out.trim = s.trim;
  if (s.tag !== undefined) out.tag = s.tag;
  if (s.collide !== undefined) out.collide = s.collide;
  if (s.visible !== undefined) out.visible = s.visible;
  if (s.underTrim !== undefined) out.underTrim = s.underTrim;
  return out;
}

export function box(min: V3, max: V3, style: Style = {}): BoxDef {
  return { type: 'box', min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]], ...styleProps(style, 'floor') };
}

/** Quader im Frame: u ∈ [u0,u1] vorwärts, v ∈ [v0,v1] rechts, y ∈ [y0,y1]. */
export function orientedBox(f: Frame, u: V2, v: V2, y: V2, style: Style = {}): BoxDef {
  const [u0, u1] = u;
  const [v0, v1] = v;
  if (isOrtho(f.yaw)) {
    const a = f.xz(u0, v0);
    const b = f.xz(u1, v1);
    return box(
      [Math.min(a[0], b[0]), y[0], Math.min(a[1], b[1])],
      [Math.max(a[0], b[0]), y[1], Math.max(a[1], b[1])],
      style,
    );
  }
  const [cx, cz] = f.xz((u0 + u1) / 2, (v0 + v1) / 2);
  const hw = (v1 - v0) / 2;
  const hd = (u1 - u0) / 2;
  // Unrotiert zeigt "vorwärts" nach -Z und "rechts" nach +X; rotY = yaw dreht beides korrekt mit.
  return { ...box([cx - hw, y[0], cz - hd], [cx + hw, y[1], cz + hd], style), rotY: f.yaw };
}

/**
 * Rampe im Frame: Oberseite läuft linear von `topAtU0` (bei u0) nach
 * `topAtU1` (bei u1), Unterseite flach auf `bottom`.
 */
export function orientedWedge(f: Frame, u: V2, v: V2, bottom: number, topAtU0: number, topAtU1: number, style: Style = {}): WedgeDef {
  const risesForward = topAtU1 > topAtU0;
  const hi = Math.max(topAtU0, topAtU1);
  const lo = Math.min(topAtU0, topAtU1);
  if (lo < bottom) throw new Error(`Rampe ${style.tag ?? ''}: Unterkante ${bottom} über niedriger Oberkante ${lo}`);
  const lowY = lo > bottom ? { lowY: lo } : {};
  if (isOrtho(f.yaw)) {
    const b = orientedBox(f, u, v, [bottom, hi], style);
    const fwd = axisOfForward(f.yaw);
    return { type: 'wedge', min: b.min, max: b.max, rise: risesForward ? fwd : flipAxis(fwd), ...lowY, ...styleProps(style, 'floor') };
  }
  const b = orientedBox(f, u, v, [bottom, hi], style);
  return { type: 'wedge', min: b.min, max: b.max, rise: risesForward ? '-z' : '+z', ...lowY, ...styleProps(style, 'floor'), rotY: f.yaw };
}

// ---------------------------------------------------------------------------
// Surf-Rampe

export interface SurfRampOpts extends Style {
  /** Achsen-Startpunkt (XZ). */
  readonly start: V2;
  /** Achsrichtung (yaw). */
  readonly yaw: number;
  readonly length: number;
  /** Firsthöhe am Start. */
  readonly apex: number;
  /** Firsthöhe am Ende (Default = apex). Tiefer = die Rampe fällt entlang der Achse → Speed-Gewinn. */
  readonly apexEnd?: number;
  /** Basisbreite quer zur Achse. */
  readonly width: number;
  /** Flankenwinkel gegen die Horizontale (Grad). 55–65 = klassisches Surf. */
  readonly flankDeg?: number;
}

/** Dreiecksprisma mit zwei Surf-Flanken, als Hülle (erlaubt fallende Achse). */
export class SurfRamp {
  readonly brush: HullDef;
  readonly flankDeg: number;
  readonly height: number;
  readonly frame: Frame;

  constructor(readonly o: SurfRampOpts) {
    this.flankDeg = o.flankDeg ?? 60;
    this.height = (o.width / 2) * Math.tan(this.flankDeg * DEG);
    this.frame = Frame.at(o.start, o.yaw);
    const pts: Vec3Tuple[] = [];
    for (const s of [0, o.length]) {
      const ay = this.apexAt(s);
      const by = ay - this.height;
      pts.push(this.frame.p(s, 0, ay), this.frame.p(s, -o.width / 2, by), this.frame.p(s, o.width / 2, by));
    }
    this.brush = { type: 'hull', points: pts, ...styleProps(o, 'surf') };
  }

  apexAt(s: number): number {
    const end = this.o.apexEnd ?? this.o.apex;
    return this.o.apex + ((end - this.o.apex) * s) / this.o.length;
  }

  /** Achsgefälle in Grad (positiv = fällt in Fahrtrichtung). */
  get slopeDeg(): number {
    return Math.atan((this.o.apex - (this.o.apexEnd ?? this.o.apex)) / this.o.length) / DEG;
  }

  /**
   * Füße einer Stand-Hull, die an der Flanke anliegt: `s` entlang der Achse,
   * `side` +1 = rechte Flanke, -1 = linke, `depth` = wie tief unter dem First.
   */
  riderPos(s: number, side: 1 | -1, depth: number): V3 {
    const t = Math.tan(this.flankDeg * DEG);
    // Innere Unterkante der Hull (16 u Richtung First) liegt knapp über der Fläche;
    // bei fallender Achse ist der First an der Hull-Hinterkante (s − 16) höher.
    const off = depth / t + 16;
    const apex = Math.max(this.apexAt(Math.max(0, s - 16)), this.apexAt(Math.min(this.o.length, s + 16)));
    const y = apex - depth + 2;
    return this.frame.p(s, side * off, y);
  }
}

// ---------------------------------------------------------------------------
// Ring (Rundkurs)

export interface RingOpts extends Style {
  readonly center: V2;
  /** Radius der Mittellinie. */
  readonly radius: number;
  readonly width: number;
  readonly segments: number;
  /** Höhe der Oberseite an der Innenkante. */
  readonly top: number;
  /**
   * Überhöhung (Grad), außen höher. Nur nach außen steigend: dann liegen die
   * Ebenen der Nachbarsegmente unter der eigenen Fläche → keine Kanten-Buckel.
   */
  readonly bankDeg?: number;
  /** Dicke an der Innenkante; Unterseite ist flach. */
  readonly thick?: number;
  /** Teilring: Winkelbereich in Grad (φ gegen den Uhrzeigersinn von +X). Default voller Kreis. */
  readonly arc?: V2;
  /** Stil je Segment (überschreibt den Ring-Stil) — z. B. Farbrhythmus, der beim Kreisen Tempo zeigt. */
  readonly segmentStyle?: (k: number) => Style;
}

/**
 * Rundkurs aus konvexen Segment-Hüllen. Winkel φ läuft gegen den
 * Uhrzeigersinn von oben: Punkt = (cx + r·cosφ, cz − r·sinφ). Wer in
 * φ-Richtung fährt, hat yaw = φ.
 *
 * Benachbarte Segmente teilen exakt dieselben Eckpunkte: keine Lücke, keine
 * Stufe. Überhöhte Segmente sind trotzdem eben, weil Innen- und Außenkante je
 * waagerecht und parallel sind (gleichschenkliges Trapez).
 */
export class Ring {
  readonly brushes: HullDef[] = [];
  readonly rIn: number;
  readonly rOut: number;
  readonly dPhi: number;
  readonly hIn: number;
  readonly hOut: number;
  readonly bottom: number;
  readonly arcFrom: number;
  private readonly tanBank: number;

  constructor(readonly o: RingOpts) {
    this.rIn = o.radius - o.width / 2;
    this.rOut = o.radius + o.width / 2;
    const [a0, a1] = o.arc ?? [0, 360];
    this.arcFrom = a0;
    this.dPhi = (a1 - a0) / o.segments;
    this.tanBank = Math.tan((o.bankDeg ?? 0) * DEG);
    const half = (this.dPhi / 2) * DEG;
    this.hIn = o.top;
    // Exakte Facetten-Neigung: radialer Lauf auf der Winkelhalbierenden ist (rOut − rIn)·cos(Δ/2).
    this.hOut = o.top + this.tanBank * (this.rOut - this.rIn) * Math.cos(half);
    this.bottom = o.top - (o.thick ?? 64);
    for (let k = 0; k < o.segments; k++) {
      const pa = a0 + k * this.dPhi;
      const pb = a0 + (k + 1) * this.dPhi;
      const pts: Vec3Tuple[] = [];
      for (const phi of [pa, pb]) {
        const [ix, iz] = this.point(phi, this.rIn);
        const [ox, oz] = this.point(phi, this.rOut);
        pts.push([ix, this.hIn, iz], [ox, this.hOut, oz], [ix, this.bottom, iz], [ox, this.bottom, oz]);
      }
      const tag = o.tag ? `${o.tag}#${k}` : undefined;
      const seg: Style = { mat: o.mat, tint: o.tint, trim: o.trim, collide: o.collide, underTrim: o.underTrim, ...(o.segmentStyle ? o.segmentStyle(k) : {}), tag };
      this.brushes.push({ type: 'hull', points: pts, ...styleProps(seg, 'floor') });
    }
  }

  point(phiDeg: number, r: number = this.o.radius): V2 {
    const a = phiDeg * DEG;
    return [this.o.center[0] + r * Math.cos(a), this.o.center[1] - r * Math.sin(a)];
  }

  /** Winkel (Grad, 0..360) eines Weltpunkts. */
  phiOf(x: number, z: number): number {
    const a = Math.atan2(-(z - this.o.center[1]), x - this.o.center[0]) / DEG;
    return (a + 360) % 360;
  }

  /** Exakte Oberflächenhöhe (Facette) an (x, z). */
  surfaceY(x: number, z: number): number {
    const phi = this.phiOf(x, z);
    const rel = (((phi - this.arcFrom) % 360) + 360) % 360;
    const k = Math.min(this.o.segments - 1, Math.floor(rel / this.dPhi));
    const mid = (this.arcFrom + (k + 0.5) * this.dPhi) * DEG;
    const dx = x - this.o.center[0];
    const dz = z - this.o.center[1];
    const along = dx * Math.cos(mid) - dz * Math.sin(mid);
    return this.hIn + (along - this.rIn * Math.cos((this.dPhi / 2) * DEG)) * this.tanBank;
  }

  /** Fußhöhe einer ruhenden Stand-Hull: höchste Oberfläche unter ihren vier Ecken. */
  restY(x: number, z: number, half = PHYS.hullHalf): number {
    let y = -Infinity;
    for (const [dx, dz] of [[-half, -half], [half, -half], [-half, half], [half, half]] as const) y = Math.max(y, this.surfaceY(x + dx, z + dz));
    return y + 0.25;
  }

  /** Ruhende Füße auf der Oberfläche bei Winkel φ und Radius r. */
  at(phiDeg: number, r: number = this.o.radius): V3 {
    const [x, z] = this.point(phiDeg, r);
    return [x, this.restY(x, z), z];
  }
}

// ---------------------------------------------------------------------------
// Builder

export interface LevelMeta {
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly parTime?: number;
  readonly killY: number;
  readonly music?: { readonly root?: string; readonly bpm?: number };
  readonly environment: EnvironmentDef;
}

export interface PlatformOpts extends Style {
  /** Dicke unter der Oberseite (Default 64). */
  readonly thick?: number;
}

export interface GapItem extends PlatformOpts {
  /** Lücke vor dieser Plattform (Kante zu Kante, entlang u). */
  readonly gap: number;
  readonly depth: number;
  readonly width: number;
  readonly top: number;
  /** Seitlicher Versatz der Mitte (v). */
  readonly shift?: number;
}

export interface PlacedPlatform {
  readonly u0: number;
  readonly u1: number;
  readonly v: number;
  readonly top: number;
  /** Mitte der Oberseite (Welt). */
  readonly center: V3;
  /** Lokaler Punkt auf der Oberseite. */
  readonly on: (u: number, v?: number) => V3;
}

/** Route-Knoten-Optionen — Bedeutung siehe LevelFormat.RouteNode. */
export type NodeOpts = Omit<RouteNode, 'pos'>;

export class LevelBuilder {
  readonly brushes: BrushDef[] = [];
  readonly triggers: TriggerDef[] = [];
  readonly route: RouteNode[] = [];
  private spawnDef: { pos: Vec3Tuple; yaw: number } | null = null;

  constructor(readonly meta: LevelMeta) {}

  add(...brushes: BrushDef[]): void {
    for (const b of brushes) {
      // Trims markieren begehbare Kanten (look.md) — Deko bekommt keine, außer ausdrücklich.
      const d = b.collide === false && b.trim === undefined ? { ...b, trim: false } : b;
      this.brushes.push(roundBrush(d));
    }
  }

  box(min: V3, max: V3, style: Style = {}): BoxDef {
    const b = box(min, max, style);
    this.add(b);
    return b;
  }

  /** Plattform im Frame, definiert über ihre Oberseite. */
  platform(f: Frame, u: V2, v: V2, top: number, o: PlatformOpts = {}): PlacedPlatform {
    this.add(orientedBox(f, u, v, [top - (o.thick ?? 64), top], o));
    return placed(f, u[0], u[1], (v[0] + v[1]) / 2, top);
  }

  /** Zentrierte Plattform: Oberseiten-Mitte `c`, Tiefe entlang yaw, Breite quer. */
  pad(c: V3, depth: number, width: number, yaw: number, o: PlatformOpts = {}): PlacedPlatform {
    const f = Frame.at(c, yaw);
    return this.platform(f, [-depth / 2, depth / 2], [-width / 2, width / 2], c[1], o);
  }

  /** Rampe: Oberseite läuft von `fromTop` (u0) nach `toTop` (u1). */
  ramp(f: Frame, u: V2, v: V2, fromTop: number, toTop: number, o: PlatformOpts = {}): WedgeDef {
    const w = orientedWedge(f, u, v, Math.min(fromTop, toTop) - (o.thick ?? 64), fromTop, toTop, o);
    this.add(w);
    return w;
  }

  /** Treppe entlang u ab u0: Stufe k hat die Oberseite baseY + (k+1)·rise. */
  stairs(f: Frame, u0: number, v: V2, baseY: number, rise: number, run: number, count: number, o: PlatformOpts = {}): BoxDef[] {
    if (rise > PHYS_STEP) throw new Error(`Treppe ${o.tag ?? ''}: Stufe ${rise} > ${PHYS_STEP} u ist nicht laufbar`);
    const out: BoxDef[] = [];
    for (let k = 0; k < count; k++) {
      const b = orientedBox(f, [u0 + k * run, u0 + (k + 1) * run], v, [baseY - (o.thick ?? 64), baseY + (k + 1) * rise], {
        ...o,
        tag: o.tag ? `${o.tag}${k}` : undefined,
      });
      this.add(b);
      out.push(b);
    }
    return out;
  }

  pillar(c: V2, size: number, y0: number, y1: number, style: Style = {}): BoxDef {
    return this.box([c[0] - size / 2, y0, c[1] - size / 2], [c[0] + size / 2, y1, c[1] + size / 2], { mat: 'wall', ...style });
  }

  surfRamp(o: SurfRampOpts): SurfRamp {
    const r = new SurfRamp(o);
    this.add(r.brush);
    return r;
  }

  /**
   * Surf-Kette entlang einer Achse: Stücke mit eigenem Achsgefälle, Stoß an
   * Stoß (gleiches Querprofil an jedem Knick). Knicke klein halten — jeder
   * Knick clippt die Geschwindigkeit um ~(1 − cos Δ).
   *
   * Früher überlappten die Stücke (konvexe Knicke zusätzlich tiefer versetzt),
   * weil die Kollision an Hüllenfugen Phantom-Keile hatte (fallen.md #31).
   * Seit compileLevel Kanten-Bevels erzeugt, ist die Fuge exakt: das Surf-
   * Raster läuft Stoß an Stoß ohne Nahtstopp, und der konvexe Versatz (eine
   * ~20-u-Stufe, die Tempo kostete) entfällt. Hinweis: mit Kanten-Bevels ist
   * jeder Grat mit < 45° Achsgefälle begehbar wie in Source — wer auf dem First
   * landet, hat Bodenkontakt (Reibung, Sprung).
   */
  surfChain(o: Omit<SurfRampOpts, 'length' | 'apexEnd'> & { readonly pieces: readonly { length: number; slopeDeg: number }[] }): SurfRamp[] {
    const out: SurfRamp[] = [];
    let s = 0;
    let apex = o.apex;
    const f = Frame.at(o.start, o.yaw);
    o.pieces.forEach((p, i) => {
      const r = this.surfRamp({
        ...o,
        start: f.xz(s),
        length: p.length,
        apex,
        apexEnd: apex - p.length * Math.tan(p.slopeDeg * DEG),
        tag: o.tag ? `${o.tag}${String.fromCharCode(97 + i)}` : undefined,
      });
      out.push(r);
      s += p.length;
      apex = r.apexAt(r.o.length);
    });
    return out;
  }

  /**
   * Übergang ohne Stirnfläche: die Folgerampe liegt auf derselben Achse,
   * beginnt `overlap` u VOR dem Ende von `prev` und `drop` u tiefer. Im
   * Überlappungsstück liegt sie komplett unter den Flanken von `prev` — wer
   * (in beliebiger Tiefe, mit beliebigem Tempo) vom Ende abfliegt, fällt auf
   * ihre Flanke, nie gegen ihre Stirnseite.
   */
  surfDrop(prev: SurfRamp, o: Style & { readonly overlap: number; readonly drop: number; readonly length: number; readonly slopeDeg: number; readonly width?: number; readonly flankDeg?: number }): SurfRamp {
    const s0 = prev.o.length - o.overlap;
    const apex = prev.apexAt(s0) - o.drop;
    return this.surfRamp({
      ...o,
      start: prev.frame.xz(s0),
      yaw: prev.o.yaw,
      length: o.length,
      apex,
      apexEnd: apex - o.length * Math.tan(o.slopeDeg * DEG),
      width: o.width ?? prev.o.width,
      flankDeg: o.flankDeg ?? prev.flankDeg,
    });
  }

  ring(o: RingOpts): Ring {
    const r = new Ring(o);
    this.add(...r.brushes);
    return r;
  }

  /**
   * Auffangmulde unter einer Lücke (u0 = Absprungkante, u1 = Landekante): eine
   * begehbare Rampe von `depth` unter `top` an der Absprungseite bis bündig an
   * die Landekante. Wer mit Auto-Hop zu kurz springt, landet darauf und hüpft
   * oder läuft weiter — kein Tod, keine Stirnwand (fallen.md #46). Die Unterseite
   * liegt auf Plattform-Unterkante (64 u unter `top`): von der Seite eine Senke.
   */
  catchDip(f: Frame, u: V2, v: V2, top: number, depth: number, o: Style = {}): WedgeDef {
    return this.ramp(f, u, v, top - depth, top, { mat: 'metal', ...o, thick: 64 - depth });
  }

  /** Plattformreihe entlang u, jede mit eigener Lücke davor. Start = Kante bei uStart. */
  gapLine(f: Frame, uStart: number, items: readonly GapItem[]): PlacedPlatform[] {
    const out: PlacedPlatform[] = [];
    let u = uStart;
    for (const it of items) {
      const u0 = u + it.gap;
      const u1 = u0 + it.depth;
      const sh = it.shift ?? 0;
      out.push(this.platform(f, [u0, u1], [sh - it.width / 2, sh + it.width / 2], it.top, it));
      u = u1;
    }
    return out;
  }

  /** Deko ohne Kollision. */
  deco(...brushes: BrushDef[]): void {
    for (const b of brushes) this.add({ ...b, collide: false });
  }

  decoBox(min: V3, max: V3, style: Style = {}): void {
    this.add(box(min, max, { mat: 'dark', ...style, collide: false }));
  }

  /** Ferner Turm: schlanker Quader mit optionaler leuchtender Krone. */
  tower(c: V2, w: number, base: number, h: number, style: Style & { crown?: string } = {}): void {
    this.decoBox([c[0] - w / 2, base, c[1] - w / 2], [c[0] + w / 2, base + h, c[1] + w / 2], { mat: 'dark', ...style });
    if (style.crown) {
      const cw = w * 0.6;
      this.decoBox([c[0] - cw / 2, base + h, c[1] - cw / 2], [c[0] + cw / 2, base + h + w * 0.5, c[1] + cw / 2], {
        mat: 'accent',
        tint: style.crown,
      });
    }
  }

  /** Lautsprecher-Stack: gestapelte, nach oben schmaler werdende Boxen, gegen den Frame gedreht. */
  speakerStack(f: Frame, cabinets: number, size = 96, base = 0, style: Style = {}): void {
    for (let i = 0; i < cabinets; i++) {
      const s = size * (1 - i * 0.08);
      this.add(
        orientedBox(f, [-s / 2, s / 2], [-s / 2, s / 2], [base + i * size, base + (i + 1) * size], {
          mat: i % 2 ? 'dark' : 'metal',
          ...style,
          collide: false,
        }),
      );
    }
  }

  /**
   * Leucht-Chevron auf einer Fläche (mat 'marking', nur Optik): zwei
   * Parallelogramm-Arme, Spitze bei `c` + halbe Tiefe in Richtung `yaw`.
   * `surface(x, z)` liefert die Flächenhöhe unter jedem Eckpunkt (ebene Fläche,
   * z. B. eine Ring-Facette; Default: konstant c[1]). Der Renderer malt die
   * Oberseite als Leuchtfläche (trims.ts), der Validator prüft, dass sie aufliegt.
   */
  chevron(c: V3, yaw: number, o: { readonly tint: string; readonly arm?: number; readonly thick?: number; readonly surface?: (x: number, z: number) => number; readonly tag?: string }): void {
    const arm = o.arm ?? 56;
    const thick = o.thick ?? 18;
    const [fx, fz] = forwardOf(yaw);
    const [rx, rz] = rightOf(yaw);
    const reach = arm * Math.SQRT1_2;
    // Spitze vorn, Arme 45° nach hinten; Mitte der Figur bei c.
    const tipX = c[0] + fx * (reach / 2 + thick / 2);
    const tipZ = c[2] + fz * (reach / 2 + thick / 2);
    const surf = o.surface ?? ((): number => c[1]);
    for (const side of [-1, 1]) {
      const endX = tipX - fx * reach + side * rx * reach;
      const endZ = tipZ - fz * reach + side * rz * reach;
      const corners: Array<readonly [number, number]> = [
        [tipX, tipZ],
        [endX, endZ],
        [endX - fx * thick, endZ - fz * thick],
        [tipX - fx * thick, tipZ - fz * thick],
      ];
      const pts: Vec3Tuple[] = [];
      for (const [x, z] of corners) {
        const y = surf(x, z);
        pts.push([x, y, z], [x, y - 4, z]);
      }
      this.add({ type: 'hull', points: pts, mat: 'marking', tint: o.tint, collide: false, tag: o.tag ?? 'chevron' });
    }
  }

  /**
   * Konvexe Bodenmarkierung (mat 'marking', ohne Kollision): Polygon in lokalen
   * Koordinaten (u vorwärts, v rechts) des Frames, Oberseite auf Höhe `y`. trims.ts
   * malt die Oberseite als Leuchtfläche; der Validator prüft, dass sie aufliegt.
   */
  marking(f: Frame, poly: readonly V2[], y: number, tint: string, tag = 'marking'): void {
    const pts: Vec3Tuple[] = [];
    for (const [u, v] of poly) {
      const [x, z] = f.xz(u, v);
      pts.push([x, y, z], [x, y - 4, z]);
    }
    this.add({ type: 'hull', points: pts, mat: 'marking', tint, collide: false, tag });
  }

  /** Pylon: dünner Mast mit Leuchtkopf. */
  pylon(c: V2, base: number, h: number, tint: string, w = 24): void {
    this.decoBox([c[0] - w / 2, base, c[1] - w / 2], [c[0] + w / 2, base + h, c[1] + w / 2], { mat: 'dark' });
    this.decoBox([c[0] - w, base + h, c[1] - w], [c[0] + w, base + h + w * 2, c[1] + w], { mat: 'accent', tint });
  }

  /**
   * Tor/Bogen quer über die Strecke bei u: zwei Pfosten außerhalb von
   * [v0, v1] und ein Balken. Nur Deko — fliegt vorbei und macht Tempo spürbar.
   */
  arch(f: Frame, u: number, v: V2, base: number, height: number, tint: string, post = 32, tag = 'arch'): void {
    const [v0, v1] = v;
    const y1 = base + height;
    this.add(orientedBox(f, [u - post / 2, u + post / 2], [v0 - post, v0], [base, y1], { mat: 'dark', collide: false, tag: `${tag}-post` }));
    this.add(orientedBox(f, [u - post / 2, u + post / 2], [v1, v1 + post], [base, y1], { mat: 'dark', collide: false, tag: `${tag}-post` }));
    this.add(orientedBox(f, [u - post / 2, u + post / 2], [v0 - post, v1 + post], [y1, y1 + post], { mat: 'accent', tint, collide: false, tag: `${tag}-lintel` }));
  }

  spawn(pos: V3, yaw: number): void {
    this.spawnDef = { pos: [r3(pos[0]), r3(pos[1]), r3(pos[2])], yaw: r3(yaw) };
  }

  trigger(t: TriggerDef): void {
    this.triggers.push({ ...t, min: v3r(t.min), max: v3r(t.max) });
  }

  startZone(min: V3, max: V3): void {
    this.triggers.push({ kind: 'start', min: v3r(min), max: v3r(max), tag: 'start' });
  }

  finishZone(min: V3, max: V3): void {
    this.triggers.push({ kind: 'finish', min: v3r(min), max: v3r(max), tag: 'finish' });
  }

  /**
   * Kill-Zone unter einem Abschnitt: wer hier ankommt, ist raus — ohne erst
   * bis zum globalen killY durchs Void zu fallen (Totzeit pro Fehler).
   */
  killZone(min: V3, max: V3, tag: string): void {
    this.triggers.push({ kind: 'kill', min: v3r(min), max: v3r(max), tag });
  }

  /** Checkpoint-Trigger mit Respawn-Punkt (Füße) und Blickrichtung. */
  checkpoint(order: number, min: V3, max: V3, spawn: V3, yaw: number, tag?: string): void {
    this.triggers.push({
      kind: 'checkpoint',
      order,
      min: v3r(min),
      max: v3r(max),
      spawn: { pos: v3r(spawn), yaw: r3(yaw) },
      tag: tag ?? `cp${order}`,
    });
  }

  /** Checkpoint über einer platzierten Plattform (achsparallele Hülle ihrer Mitte). */
  checkpointOn(order: number, p: PlacedPlatform, half: V2, spawn: V3, yaw: number, height = 160): void {
    const [cx, , cz] = p.center;
    this.checkpoint(order, [cx - half[0], p.top, cz - half[1]], [cx + half[0], p.top + height, cz + half[1]], spawn, yaw);
  }

  node(pos: V3, o: NodeOpts = {}): void {
    if (o.surf && o.air) throw new Error(`${this.meta.id}: Knoten ${this.route.length} ist surf und air zugleich`);
    // Nur gesetzte Flags schreiben: das JSON bleibt knapp und diffbar.
    this.route.push({
      pos: v3r(pos),
      ...(o.jump ? { jump: true } : {}),
      ...(o.crouch ? { crouch: true } : {}),
      ...(o.minSpeed !== undefined ? { minSpeed: Math.round(o.minSpeed) } : {}),
      ...(o.surf ? { surf: true } : {}),
      ...(o.air ? { air: true } : {}),
      ...(o.precision ? { precision: true } : {}),
      ...(o.note ? { note: o.note } : {}),
    });
  }

  build(): LevelFile {
    if (!this.spawnDef) throw new Error(`${this.meta.id}: kein Spawn gesetzt`);
    const m = this.meta;
    const out: LevelFile = {
      version: 1,
      id: m.id,
      name: m.name,
      ...(m.subtitle ? { subtitle: m.subtitle } : {}),
      spawn: this.spawnDef,
      killY: m.killY,
      ...(m.music ? { music: m.music } : {}),
      ...(m.parTime !== undefined ? { parTime: m.parTime } : {}),
      environment: m.environment,
      brushes: this.brushes,
      triggers: this.triggers,
      route: this.route,
    };
    return out;
  }
}

const PHYS_STEP = PHYS.stepSize;

function v3r(p: V3): Vec3Tuple {
  return [r3(p[0]), r3(p[1]), r3(p[2])];
}

function placed(f: Frame, u0: number, u1: number, v: number, top: number): PlacedPlatform {
  return {
    u0,
    u1,
    v,
    top,
    center: f.p((u0 + u1) / 2, v, top),
    on: (u: number, dv = 0) => f.p(u, v + dv, top),
  };
}

function roundBrush(b: BrushDef): BrushDef {
  const common = { ...(b.rotY !== undefined ? { rotY: r3(b.rotY) } : {}), ...(b.pivot ? { pivot: v3r(b.pivot) } : {}) };
  switch (b.type) {
    case 'box':
      return { ...b, min: v3r(b.min), max: v3r(b.max), ...common };
    case 'wedge':
      return { ...b, min: v3r(b.min), max: v3r(b.max), ...(b.lowY !== undefined ? { lowY: r3(b.lowY) } : {}), ...common };
    case 'prism':
      return { ...b, from: r3(b.from), to: r3(b.to), profile: b.profile.map(([a, y]) => [r3(a), r3(y)] as const), ...common };
    case 'hull':
      return { ...b, points: b.points.map(v3r), ...common };
  }
}
