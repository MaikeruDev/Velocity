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
import { Vector3 } from 'three';
import { compileBrush, compileLevel } from '../../src/world/level/compileLevel';
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
import { PHYS, RESERVE, airTime } from './ballistics';

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

  /** Grat am Ende (Position, Richtung, Höhe) — Anker für finishAfterLaunch. */
  get end(): TrackEnd {
    const [x, z] = this.frame.xz(this.o.length);
    return { x, z, yaw: this.o.yaw, apex: this.apexAt(this.o.length) };
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

/** Grat-Endpunkt einer Surf-Strecke: Position, Richtung (yaw, Grad), Firsthöhe. */
export interface TrackEnd {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly apex: number;
}

// ---------------------------------------------------------------------------
// Surf-Pfad: Kurven (Gehrung), Halbrampen, Banden (Plan 007, aus dem L3-Prototyp)

/** Innenwand einer Halbrampe am Fuß so weit (u) zur Flanke eingezogen. */
const WALL_LEAN = 6;
/** Banden-Fugen so weit (Grad) gegen die Rampen-Fugen gedreht. */
const RAIL_SKEW = 1;

export interface PathSeg {
  readonly length: number;
  /** Achsgefälle (Grad, positiv = fällt in Fahrtrichtung). */
  readonly slopeDeg: number;
  /** Richtungsänderung über das Segment (Grad, positiv = links). */
  readonly turnDeg?: number;
  /** Anzahl Stücke; Default: gerade 1, Kurve ceil(|turn| / 7.5). */
  readonly pieces?: number;
}

/** 'both' = volles Dreiecksprofil, 'left'/'right' = nur diese Flanke (senkrechte Innenwand unter dem Grat). */
export type RampHalf = 'both' | 'left' | 'right';

export interface SurfPathOpts extends Style {
  readonly start: V2;
  readonly yaw: number;
  readonly apex: number;
  readonly width: number;
  readonly flankDeg?: number;
  readonly segs: readonly PathSeg[];
  readonly half?: RampHalf;
  /** Bande auf dem Grat einer Halbrampe (Höhe u, 0 = keine): fängt in Steilkurven, wer über den Grat stiege. */
  readonly rail?: number;
  readonly railTint?: string;
  /** Bogenlängen-Fenster der Bande (Default: ganzer Pfad), z. B. frei für ein Checkpoint-Pad. */
  readonly railRange?: readonly [number, number];
  /**
   * Innenkante der Bande so weit vor dem Grat (u, Default 12). Aufeinanderfolgende Rampen (Drop) im Wechsel
   * 12/14: die Banden laufen ohne Lücke durch, ihre Flächen liegen aber nicht koplanar (Z-Fighting).
   */
  readonly railInset?: number;
  /**
   * Fuß-Bande (Höhe über dem Fuß, 0 = keine). Achtung: an Gehrungsfugen ergeben Flanke + Planke + Fuge drei
   * Clip-Ebenen → Stillstand (L3-Prototyp gridDiag). In Kurven stattdessen `catchBand`.
   */
  readonly footRail?: number;
  readonly footRailTint?: string;
  /** Innenkante der Fuß-Bande so weit über dem Fuß (horizontal zur Mitte, u, Default 10). */
  readonly footRailInset?: number;
}

interface PathJoint {
  readonly x: number;
  readonly z: number;
  readonly apex: number;
  /** Gehrungsrichtung (yaw der Winkelhalbierenden) und Streckung quer. */
  readonly miter: number;
  readonly stretch: number;
  readonly s: number;
}

export interface PathPiece {
  readonly yaw: number;
  readonly length: number;
  readonly s0: number;
  readonly apex0: number;
  readonly apex1: number;
  readonly frame: Frame;
  readonly brush: HullDef;
}

/**
 * Surf-Strecke mit Kurven: Kette gerader Stücke, Stoß an Stoß auf GEHRUNG. Jede Fuge liegt auf der
 * Winkelhalbierenden, beide Nachbarn teilen exakt dasselbe Fugen-Dreieck (Querabstand × 1/cos(Δ/2)) —
 * keine Lücke außen, keine Überlappung innen. Die Innenflanke einer Kurve ist ein konkaver Knick (trägt
 * um die Kurve), die Außenflanke ein konvexer (man muss hineindrücken). Knicke ≤ 3.75° halten (L3).
 * Kurven brauchen den Rampbug-Fix (MovementConfig.surfSeamFix): ohne ihn Nahtstopps an jeder Fuge.
 *
 * Halbrampe: nur eine Flanke, Innenwand unter dem Grat. Zwei Halbrampen mit gemeinsamem Grat ergeben
 * das volle Profil (Gabel ohne Stirnfläche) und laufen danach auseinander.
 */
export class SurfPath {
  readonly joints: PathJoint[] = [];
  readonly pieces: PathPiece[] = [];
  readonly rails: HullDef[] = [];
  readonly flankDeg: number;
  readonly height: number;
  readonly half: RampHalf;
  readonly length: number;
  /** Fahrtrichtung am Ende (yaw + alle Kurven) — die Tangente, nicht das letzte Sehnenstück. */
  readonly endYaw: number;

  constructor(readonly o: SurfPathOpts) {
    this.flankDeg = o.flankDeg ?? 60;
    this.half = o.half ?? 'both';
    this.height = (o.width / 2) * Math.tan(this.flankDeg * DEG);
    // Stücke: Richtung jeweils in der Mitte ihres Kurvenanteils (Sehnenzug um den Bogen).
    const raw: Array<{ yaw: number; length: number; slope: number }> = [];
    let yaw = o.yaw;
    for (const sg of o.segs) {
      const turn = sg.turnDeg ?? 0;
      const n = sg.pieces ?? (turn === 0 ? 1 : Math.ceil(Math.abs(turn) / 7.5));
      for (let k = 0; k < n; k++) raw.push({ yaw: yaw + ((k + 0.5) * turn) / n, length: sg.length / n, slope: Math.tan(sg.slopeDeg * DEG) });
      yaw += turn;
    }
    this.endYaw = yaw;
    let x = o.start[0];
    let z = o.start[1];
    let apex = o.apex;
    let s = 0;
    for (let i = 0; i <= raw.length; i++) {
      const prev = raw[i - 1];
      const next = raw[i];
      const miter = prev && next ? (prev.yaw + next.yaw) / 2 : (next ?? prev).yaw;
      const d = prev && next ? next.yaw - prev.yaw : 0;
      this.joints.push({ x, z, apex, miter, stretch: 1 / Math.cos((d / 2) * DEG), s });
      if (next) {
        const [fx, fz] = forwardOf(next.yaw);
        x += fx * next.length;
        z += fz * next.length;
        apex -= next.length * next.slope;
        s += next.length;
      }
    }
    this.length = s;
    for (let i = 0; i < raw.length; i++) {
      const a = this.joints[i];
      const b = this.joints[i + 1];
      const pts: Vec3Tuple[] = [...this.section(a), ...this.section(b)];
      const tag = o.tag ? `${o.tag}${raw.length > 1 ? String.fromCharCode(97 + (i % 26)) : ''}` : undefined;
      const brush: HullDef = { type: 'hull', points: pts, mat: o.mat ?? 'surf', ...(o.tint ? { tint: o.tint } : {}), ...(tag ? { tag } : {}), ...(o.trim !== undefined ? { trim: o.trim } : {}) };
      this.pieces.push({ yaw: raw[i].yaw, length: raw[i].length, s0: a.s, apex0: a.apex, apex1: b.apex, frame: new Frame(a.x, a.z, raw[i].yaw), brush });
      const rr = o.railRange ?? [0, Infinity];
      if ((o.rail ?? 0) > 0 && this.half !== 'both' && a.s >= rr[0] - 1e-6 && b.s <= rr[1] + 1e-6) {
        const rp: Vec3Tuple[] = [...this.railSection(a, RAIL_SKEW), ...this.railSection(b, RAIL_SKEW)];
        this.rails.push({ type: 'hull', points: rp, mat: 'accent', ...(o.railTint ? { tint: o.railTint } : {}), underTrim: true, tag: tag ? `${tag}-rail` : 'rail' });
      }
      if ((o.footRail ?? 0) > 0 && this.half !== 'both') {
        const fp: Vec3Tuple[] = [...this.footRailSection(a, RAIL_SKEW), ...this.footRailSection(b, RAIL_SKEW)];
        this.rails.push({ type: 'hull', points: fp, mat: 'accent', ...(o.footRailTint ? { tint: o.footRailTint } : {}), tag: tag ? `${tag}-foot` : 'footRail' });
      }
    }
  }

  /** Fugen-Dreieck (bzw. Halbprofil) an einer Fuge. */
  private section(j: PathJoint): Vec3Tuple[] {
    const [rx, rz] = rightOf(j.miter);
    const w = (this.o.width / 2) * j.stretch;
    const foot = j.apex - this.height;
    const apex: Vec3Tuple = [j.x, j.apex, j.z];
    const right: Vec3Tuple = [j.x + rx * w, foot, j.z + rz * w];
    const left: Vec3Tuple = [j.x - rx * w, foot, j.z - rz * w];
    // Innenwand am Fuß um WALL_LEAN zur Flanke eingezogen (leichter Überhang): zwei Halbrampen mit gemeinsamem
    // Grat überlappen nicht, und Wände aufeinanderfolgender Halbrampen (Drop) liegen nicht koplanar (Z-Fighting).
    const lean = this.half === 'left' ? -WALL_LEAN : WALL_LEAN;
    const under: Vec3Tuple = [j.x + rx * lean, foot, j.z + rz * lean];
    if (this.half === 'right') return [apex, right, under];
    if (this.half === 'left') return [apex, left, under];
    return [apex, left, right];
  }

  /**
   * Bande: Innenseite railInset VOR dem Grat (über der Flanke), außen 4 u weiter, unten 28 u in der Rampe.
   * Genau auf dem Grat erreichte die Hull dessen Kanten-Bevel (begehbar) → Bodenkontakt, Stillstand.
   */
  private railSection(j: PathJoint, skew: number): Vec3Tuple[] {
    // Fuge um `skew` gedreht: sonst lägen Banden- und Rampenkappe koplanar (Z-Fighting).
    const [rx, rz] = rightOf(j.miter + skew);
    const sgn = this.half === 'left' ? 1 : -1;
    const inner = -sgn * (this.o.railInset ?? 12) * j.stretch;
    const out = sgn * ((this.o.railInset ?? 12) + 4) * j.stretch;
    const top = j.apex + (this.o.rail ?? 0);
    const bot = j.apex - 28;
    // Oberseite fällt mit 60° NACH INNEN (zur Flanke): flach war sie ein Laufsteg aus der Kurve,
    // nach außen geneigt ein Rutsch ins Aus.
    const innerTop = top - Math.abs(out - inner) * Math.tan((60 * Math.PI) / 180);
    return [
      [j.x + rx * inner, innerTop, j.z + rz * inner], [j.x + rx * inner, bot, j.z + rz * inner],
      [j.x + rx * out, top, j.z + rz * out], [j.x + rx * out, bot, j.z + rz * out],
    ];
  }

  /** Fuß-Bande: Innenkante footRailInset über dem Fuß (zur Mitte), 16 u dick nach außen, Oberseite fällt nach innen. */
  private footRailSection(j: PathJoint, skew: number): Vec3Tuple[] {
    const [rx, rz] = rightOf(j.miter + skew);
    const sgn = this.half === 'right' ? 1 : -1;
    const w = (this.o.width / 2) * j.stretch;
    const inset = (this.o.footRailInset ?? 10) * j.stretch;
    const inner = sgn * (w - inset);
    const out = sgn * (w + 16 * j.stretch);
    const foot = j.apex - this.height;
    const top = foot + (this.o.footRail ?? 0);
    const innerTop = top - Math.abs(out - inner) * Math.tan((60 * Math.PI) / 180);
    const bot = foot - 32;
    return [
      [j.x + rx * inner, innerTop, j.z + rz * inner], [j.x + rx * inner, bot, j.z + rz * inner],
      [j.x + rx * out, top, j.z + rz * out], [j.x + rx * out, bot, j.z + rz * out],
    ];
  }

  get brushes(): HullDef[] {
    return [...this.pieces.map((p) => p.brush), ...this.rails];
  }

  pieceAt(s: number): PathPiece {
    const c = Math.max(0, Math.min(this.length, s));
    for (const p of this.pieces) if (c <= p.s0 + p.length + 1e-9) return p;
    return this.pieces[this.pieces.length - 1];
  }

  apexAt(s: number): number {
    const p = this.pieceAt(s);
    const t = (Math.max(0, Math.min(this.length, s)) - p.s0) / p.length;
    return p.apex0 + (p.apex1 - p.apex0) * t;
  }

  /** Mittellinie (Grat) bei Bogenlänge s; yaw = Richtung des Stücks dort. */
  at(s: number): TrackEnd {
    const p = this.pieceAt(s);
    const [x, z] = p.frame.xz(Math.max(0, Math.min(this.length, s)) - p.s0);
    return { x, z, yaw: p.yaw, apex: this.apexAt(s) };
  }

  /** Lokaler Frame bei s (u vorwärts entlang des Stücks, v rechts). */
  frameAt(s: number): Frame {
    const a = this.at(s);
    return new Frame(a.x, a.z, a.yaw);
  }

  /** Ende des Grats; yaw = letztes Stück (bei geradem Auslauf gleich der Tangente `endYaw`). */
  get end(): TrackEnd {
    return this.at(this.length);
  }

  /** Füße einer Stand-Hull an der Flanke: side +1 rechts, −1 links, depth unter dem Grat. */
  riderPos(s: number, side: 1 | -1, depth: number): V3 {
    const t = Math.tan(this.flankDeg * DEG);
    const f = this.frameAt(s);
    // Die Hull ist achsparallel: an einer schrägen Flanke ragt ihre Ecke bis 16·(|cos|+|sin|) in
    // Normalenrichtung — mit 16 wie bei SurfRamp stäke der Knoten bis 11 u in der Flanke.
    const [rx, rz] = rightOf(f.yaw);
    const reachHull = 16 * (Math.abs(rx) + Math.abs(rz));
    const off = depth / t + reachHull;
    // Fugen einer konkaven Kurve liegen bis ~1 u über der Stückebene: 4 u Luft.
    const apex = Math.max(this.apexAt(Math.max(0, s - 24)), this.apexAt(Math.min(this.length, s + 24)));
    return f.p(0, side * off, apex - depth + 4);
  }

  footAt(s: number): number {
    return this.apexAt(s) - this.height;
  }

  /** Größte Abweichung einer Flanken-Ecke von der Ebene der anderen drei (u) — Faltung durch Gehrung + Gefälle. */
  maxFold(): number {
    let worst = 0;
    for (let i = 0; i + 1 < this.joints.length; i++) {
      const a = this.section(this.joints[i]);
      const b = this.section(this.joints[i + 1]);
      for (const k of [1, 2]) {
        const p0 = a[0];
        const p1 = a[k];
        const p2 = b[0];
        const q = b[k];
        const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const nl = Math.hypot(n[0], n[1], n[2]);
        const d = Math.abs((q[0] - p0[0]) * n[0] + (q[1] - p0[1]) * n[1] + (q[2] - p0[2]) * n[2]) / nl;
        worst = Math.max(worst, d);
      }
    }
    return worst;
  }
}

export interface DropOpts extends Omit<SurfPathOpts, 'start' | 'yaw' | 'apex' | 'width'> {
  readonly overlap: number;
  readonly drop: number;
  readonly width?: number;
  /** Seitlicher Versatz des neuen Grats (u, rechts positiv). */
  readonly lateral?: number;
  /**
   * Richtung des Folgepfads: 'tangent' (Default) = Fahrtrichtung am Ende von prev (endYaw);
   * 'piece' = Richtung des Stücks bei s0 (L3-Prototyp). 'piece' verlor pro Kurven-Ende einen halben
   * Knick — die 180°-Kehre wurde 174°.
   */
  readonly yawFrom?: 'tangent' | 'piece';
}

/** Folgepfad als Drop (wie LevelBuilder.surfDrop): beginnt `overlap` vor dem Ende von `prev`, `drop` tiefer. */
export function dropFrom(prev: SurfPath, o: DropOpts): SurfPath {
  const s0 = prev.length - o.overlap;
  const a = prev.at(s0);
  const yaw = (o.yawFrom ?? 'tangent') === 'tangent' ? prev.endYaw : a.yaw;
  // Position auf der Sehne des Stücks bei s0; Richtung (und Seitenversatz) folgen der Tangente.
  const f = new Frame(a.x, a.z, yaw);
  return new SurfPath({ ...o, start: f.xz(0, o.lateral ?? 0), yaw, apex: a.apex - o.drop, width: o.width ?? prev.o.width, flankDeg: o.flankDeg ?? prev.flankDeg });
}

export interface CatchBandOpts {
  /** Fläche so tief unter dem Fuß (u). */
  readonly below: number;
  /** Breite nach außen (u). */
  readonly width: number;
  /** Bande am Außenrand (Höhe über der Fläche, u). */
  readonly bank: number;
  readonly tint?: string;
  readonly tag?: string;
}

/**
 * Auffang-Band unter dem Fuß einer Halbrampe (folgt Kurven auf Gehrung): Fläche `below` unter dem Fuß,
 * `width` breit nach außen, 32 u dick, Bande (`bank` hoch, 24 u dick) am Außenrand. Wer die Außenflanke einer
 * Kurve hinunterrutscht, landet hier und hüpft weiter — langsamer, nie tot. Keine Leitplanke an der Flanke
 * (Kehle): Flanke + Planke + Fuge = drei Clip-Ebenen → Stillstand.
 */
export function catchBand(path: SurfPath, o: CatchBandOpts): HullDef[] {
  const out: HullDef[] = [];
  const sgn = path.half === 'left' ? -1 : 1;
  const js = path.joints;
  const at = (j: PathJoint, lateral: number, y: number): Vec3Tuple => {
    const [rx, rz] = rightOf(j.miter);
    const l = sgn * lateral * j.stretch;
    return [j.x + rx * l, y, j.z + rz * l];
  };
  const W2 = path.o.width / 2;
  const lift = 24 * Math.tan((60 * Math.PI) / 180);
  for (let i = 0; i + 1 < js.length; i++) {
    const a = js[i];
    const b = js[i + 1];
    const ya = a.apex - path.height - o.below;
    const yb = b.apex - path.height - o.below;
    const inner = W2 - 12;
    const outer = W2 + o.width;
    const floor: Vec3Tuple[] = [at(a, inner, ya), at(a, outer, ya), at(b, inner, yb), at(b, outer, yb), at(a, inner, ya - 32), at(a, outer, ya - 32), at(b, inner, yb - 32), at(b, outer, yb - 32)];
    out.push({ type: 'hull', points: floor, mat: 'metal', ...(o.tint ? { tint: o.tint } : {}), tag: `${o.tag ?? 'catch'}` });
    const bOut = outer + 24;
    const bank: Vec3Tuple[] = [at(a, outer, ya + o.bank - lift), at(a, bOut, ya + o.bank), at(a, outer, ya - 32), at(a, bOut, ya - 32), at(b, outer, yb + o.bank - lift), at(b, bOut, yb + o.bank), at(b, outer, yb - 32), at(b, bOut, yb - 32)];
    out.push({ type: 'hull', points: bank, mat: 'accent', ...(o.tint ? { tint: o.tint } : {}), tag: `${o.tag ?? 'catch'}Bank` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wendel (Plan 007, aus dem L4-Prototyp)

export interface HelixSection extends Style {
  /** θ-Bereich (Grad). */
  readonly from: number;
  readonly to: number;
  /** Höhe der Oberseite am Anfang/Ende (linear dazwischen). */
  readonly y0: number;
  readonly y1: number;
  /** Anderer Innen-/Außenradius nur für diesen Abschnitt (z. B. Innen-/Außenbahn). */
  readonly rIn?: number;
  readonly rOut?: number;
  /** Keine Bande außen (z. B. Innenbahn, Übergang zum Steg). */
  readonly noBoard?: boolean;
}

export interface HelixOpts {
  readonly center: V2;
  readonly rIn: number;
  readonly rOut: number;
  /** φ bei θ = 0 (φ wie Ring: gegen den Uhrzeigersinn von +X). */
  readonly phi0: number;
  /** Segmentwinkel (Grad), teilt jeden Abschnitt in gleiche Stücke ≤ seg. */
  readonly seg: number;
  /** Dicke unter der Oberseite (muss jede Stufe decken). */
  readonly thick: number;
  /** Leuchtband an der Unterkante: die Wendel liest sich von unten als Band. */
  readonly underTrim?: boolean;
  /** Bande am Außenrand: Höhe über der Oberseite und Dicke. */
  readonly board?: { readonly h: number; readonly t: number; readonly style?: Style };
  /**
   * θ der Stufen (Crouch-Kanten), an denen die Bande EIGENE Segmente bekommt, deren Mitte genau auf der
   * Stufe liegt (Stufe radial, Bande als Sehne → rechter Winkel). Liegt die Stufe auf einer Achsrichtung,
   * wird das Segment eine achsparallele BOX: Hüllen-Normalen sind nie exakt achsparallel
   * (−0.9999999999999999), das reichte für einen Luft-Hänger in der Ecke.
   */
  readonly boardRisers?: readonly number[];
  readonly sections: readonly HelixSection[];
}

/**
 * Wendel: steigende Spiralrampe um einen Kern, fugenlos wie `Ring`. θ = Fahrwinkel ab dem Anfang
 * (φ = phi0 + θ, darf > 360: die zweite Umdrehung liegt über der ersten). Die Oberseite ist eine
 * Wendelfläche (Höhe hängt nur von θ ab) — vier Segment-Ecken sind nicht koplanar, deshalb zwei
 * Dreiecks-Prismen je Segment; Nachbarn teilen exakt dieselben Eckpunkte. Das Profil ist stückweise
 * linear in θ; zwischen Abschnitten darf es springen (Stufe = Stirn, die Hülle reicht `thick` tief).
 */
export class Helix {
  readonly brushes: HullDef[] = [];
  readonly boards: BrushDef[] = [];

  constructor(readonly o: HelixOpts) {
    this.buildBoards();
    for (const s of o.sections) {
      const n = Math.max(1, Math.ceil((s.to - s.from) / o.seg - 1e-9));
      const rIn = s.rIn ?? o.rIn;
      const rOut = s.rOut ?? o.rOut;
      for (let k = 0; k < n; k++) {
        const ta = s.from + ((s.to - s.from) * k) / n;
        const tb = s.from + ((s.to - s.from) * (k + 1)) / n;
        const ya = s.y0 + ((s.y1 - s.y0) * k) / n;
        const yb = s.y0 + ((s.y1 - s.y0) * (k + 1)) / n;
        const A = this.p3(ta, rIn, ya);
        const B = this.p3(ta, rOut, ya);
        const C = this.p3(tb, rOut, yb);
        const D = this.p3(tb, rIn, yb);
        const tag = s.tag ? `${s.tag}#${k}` : undefined;
        for (const tri of [[A, B, C], [A, C, D]] as const) {
          const pts: Vec3Tuple[] = [];
          for (const p of tri) pts.push(p, [p[0], p[1] - o.thick, p[2]]);
          this.brushes.push({ type: 'hull', points: pts, mat: s.mat ?? 'floor', ...(s.tint ? { tint: s.tint } : {}), ...(s.trim !== undefined ? { trim: s.trim } : {}), ...(o.underTrim ? { underTrim: true } : {}), ...(tag ? { tag } : {}) });
        }
        const bd = o.board;
        if (bd && bd.h > 0 && !s.noBoard && !o.boardRisers) {
          const pts: Vec3Tuple[] = [];
          for (const [t, y] of [[ta, ya], [tb, yb]] as const) {
            for (const r of [rOut, rOut + bd.t]) pts.push(this.p3(t, r, y - o.thick), this.p3(t, r, y + bd.h));
          }
          const st = bd.style ?? {};
          this.boards.push({ type: 'hull', points: pts, mat: st.mat ?? 'wall', ...(st.tint ? { tint: st.tint } : {}), trim: st.trim ?? true, tag: `board${s.tag ? `-${s.tag}` : ''}#${k}` });
        }
      }
    }
  }

  /** Bande separat segmentiert (boardRisers): Segmente mittig auf jeder Stufe. */
  private buildBoards(): void {
    const o = this.o;
    const bd = o.board;
    if (!bd || !o.boardRisers) return;
    const outer = o.sections.filter((s) => !s.noBoard && (s.rOut ?? o.rOut) === o.rOut);
    const t0 = Math.min(...outer.map((s) => s.from));
    const t1 = Math.max(...outer.map((s) => s.to));
    const half = o.seg / 2;
    const breaks = new Set<number>([t0, t1]);
    for (const s of outer) {
      const n = Math.max(1, Math.ceil((s.to - s.from) / o.seg - 1e-9));
      for (let k = 0; k <= n; k++) breaks.add(s.from + ((s.to - s.from) * k) / n);
    }
    for (const r of o.boardRisers) {
      for (const b of [...breaks]) if (Math.abs(b - r) < half + 1e-6 && b !== t0 && b !== t1) breaks.delete(b);
      breaks.add(r - half);
      breaks.add(r + half);
    }
    const list = [...breaks].sort((a, b) => a - b);
    const yOuter = (t: number, after: boolean): number => {
      const hit = after ? [...outer].reverse().find((s) => t >= s.from - 1e-9 && t <= s.to + 1e-9) : outer.find((s) => t >= s.from - 1e-9 && t <= s.to + 1e-9);
      if (!hit) throw new Error(`Bande: θ ${t} ohne Abschnitt`);
      return hit.y0 + ((hit.y1 - hit.y0) * (t - hit.from)) / (hit.to - hit.from);
    };
    const st = bd.style ?? {};
    for (let i = 0; i + 1 < list.length; i++) {
      const ta = list[i];
      const tb = list[i + 1];
      if (tb - ta < 1e-6) continue;
      const ya = yOuter(ta, true);
      const yb = yOuter(tb, false);
      const lo = Math.min(ya, yb) - o.thick - 16; // tiefer als jede Boden-Unterseite (sonst koplanar)
      const pts: Vec3Tuple[] = [];
      for (const [t, y] of [[ta, ya], [tb, yb]] as const) for (const r of [o.rOut, o.rOut + bd.t]) pts.push(this.p3(t, r, lo), this.p3(t, r, y + bd.h));
      const style = { mat: st.mat ?? 'wall', ...(st.tint ? { tint: st.tint } : {}), trim: st.trim ?? true, tag: `board#${i}` } as const;
      const mid = (ta + tb) / 2;
      const phiMid = (((o.phi0 + mid) % 90) + 90) % 90;
      const onRiser = o.boardRisers.some((r) => Math.abs(r - mid) < 1e-6) && (phiMid < 1e-6 || 90 - phiMid < 1e-6);
      if (onRiser) {
        const xs = pts.map((q) => q[0]);
        const zs = pts.map((q) => q[2]);
        const top = Math.max(ya, yb) + bd.h + 4; // +4/−4: nicht koplanar mit den Nachbar-Segmenten
        this.boards.push({ type: 'box', min: [Math.min(...xs), lo - 4, Math.min(...zs)], max: [Math.max(...xs), top, Math.max(...zs)], ...style });
      } else {
        this.boards.push({ type: 'hull', points: pts, ...style });
      }
    }
  }

  /** Weltpunkt (x, z) bei Fahrwinkel θ und Radius r. */
  xz(theta: number, r: number): V2 {
    const phi = (this.o.phi0 + theta) * DEG;
    return [this.o.center[0] + r * Math.cos(phi), this.o.center[1] - r * Math.sin(phi)];
  }

  p3(theta: number, r: number, y: number): V3 {
    const [x, z] = this.xz(theta, r);
    return [x, y, z];
  }

  /** Fahrtrichtung (yaw, Grad) bei θ. */
  yawAt(theta: number): number {
    return this.o.phi0 + theta;
  }

  /** Profilhöhe bei θ (erster Abschnitt, der θ enthält; an Stufen mit `after` der spätere). */
  yAt(theta: number, after = false): number {
    const secs = this.o.sections;
    const hit = after ? [...secs].reverse().find((s) => theta >= s.from - 1e-9 && theta <= s.to + 1e-9) : secs.find((s) => theta >= s.from - 1e-9 && theta <= s.to + 1e-9);
    if (!hit) throw new Error(`Helix: θ ${theta} liegt in keinem Abschnitt`);
    return hit.y0 + ((hit.y1 - hit.y0) * (theta - hit.from)) / (hit.to - hit.from);
  }

  /** θ eines Weltpunkts, eindeutig gemacht nahe `near` (die Wendel wiederholt sich alle 360°). */
  thetaOf(x: number, z: number, near: number): number {
    let th = Math.atan2(-(z - this.o.center[1]), x - this.o.center[0]) / DEG - this.o.phi0;
    while (th < near - 180) th += 360;
    while (th > near + 180) th -= 360;
    return th;
  }

  /** Bogenlänge (u) für Δθ bei Radius r. */
  arc(dTheta: number, r: number): number {
    return Math.abs(dTheta) * DEG * r;
  }

  /** Δθ (Grad) für eine Bogenlänge bei Radius r. */
  dTheta(arc: number, r: number): number {
    return arc / r / DEG;
  }

  addTo(L: LevelBuilder): void {
    L.add(...this.brushes, ...this.boards);
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

  /** Surf-Pfad (Kurven, Halbrampen, Banden) bauen und hinzufügen. */
  surfPath(o: SurfPathOpts): SurfPath {
    const p = new SurfPath(o);
    this.add(...p.brushes);
    return p;
  }

  /** Folgepfad als Drop hinter `prev` (dropFrom) bauen und hinzufügen. */
  surfPathDrop(prev: SurfPath, o: DropOpts): SurfPath {
    const p = dropFrom(prev, o);
    this.add(...p.brushes);
    return p;
  }

  /** Auffang-Band unter dem Fuß einer Halbrampe (siehe catchBand). */
  catchBand(path: SurfPath, o: CatchBandOpts): void {
    this.add(...catchBand(path, o));
  }

  /** Wendel bauen und hinzufügen (Segmente, dann Bande). */
  helix(o: HelixOpts): Helix {
    const h = new Helix(o);
    h.addTo(this);
    return h;
  }

  /**
   * Geländer (nur Optik) entlang u bei v: Pfosten alle 96 u, Leucht-Handlauf 66–74 u über `floorAt(u)`
   * in 128-u-Stücken. Gehört zu einem unsichtbaren Clip (visible:false), der die Kollision trägt —
   * der Blick in die Tiefe bleibt frei (L4-Steg).
   */
  railing(f: Frame, u0: number, u1: number, v: number, floorAt: (u: number) => number, o: { readonly tint: string }): void {
    for (let u = u0 + 24; u < u1; u += 96) {
      const y = floorAt(u);
      this.add({ ...orientedBox(f, [u - 6, u + 6], [v - 6, v + 6], [y, y + 76], { mat: 'dark', collide: false, tag: 'rail-post' }), trim: false });
    }
    for (let u = u0; u < u1; u += 128) {
      const ua = u;
      const ub = Math.min(u1, u + 128);
      const pts: Vec3Tuple[] = [];
      for (const [uu, yy] of [[ua, floorAt(ua) + 66], [ub, floorAt(ub) + 66]] as const) for (const vv of [v - 5, v + 5]) pts.push(f.p(uu, vv, yy), f.p(uu, vv, yy + 8));
      this.add({ type: 'hull', points: pts, mat: 'light', tint: o.tint, collide: false, trim: false, tag: 'rail' });
    }
  }

  /**
   * Zweiphasige Knoten: kompiliert den bisherigen Bau und reicht `rest(x, z, yHint)` durch — die Füße einer
   * ruhenden Stand-Hull per Trace (von yHint + 90 bis yHint − 200). Am Hang ruht die Hull auf ihrer
   * Bergkante (fallen.md #15); `Ring.restY` gilt nur für flache Ringe. Für Wendel, Hänge, Stufen.
   */
  placeNodes<T>(fn: (rest: (x: number, z: number, yHint: number) => V3) => T): T {
    const probe = compileLevel(this.build());
    const mins = new Vector3(-PHYS.hullHalf, 0, -PHYS.hullHalf);
    const maxs = new Vector3(PHYS.hullHalf, PHYS.standHeight, PHYS.hullHalf);
    const rest = (x: number, z: number, yHint: number): V3 => {
      const tr = probe.world.traceBox(new Vector3(x, yHint + 90, z), new Vector3(x, yHint - 200, z), mins, maxs);
      if (tr.startSolid || tr.fraction >= 1) throw new Error(`${this.meta.id}: kein Boden bei ${x.toFixed(0)}, ${z.toFixed(0)} (y ~${yHint.toFixed(0)})`);
      return [x, r3(tr.endPos.y + 0.05), z];
    };
    return fn(rest);
  }

  /**
   * Checkpoint am Drop a → b zweier Surf-Pfade (beliebige Richtung, auch in Kurven): Keil-Pad auf dem Grat
   * von b ab `padS0` (steigt über 96 u um 40 — begehbar, keine Stirn —, dann 128 flach; quer `padV`), Spawn
   * `spawnV` vom Grat (negativ = links). Luft-Trigger um den Übergang (quer `span`, Default halbe Breite),
   * unten 40 u über dem Fuß von b, oben bis `topY` (Default Pad + 320). Lehren aus L2/L3: kein Pad in einer
   * Landezone, neben Banden nur auf der Flankenseite, Spawn zur sicheren Seite.
   */
  surfPad(order: number, a: SurfPath, b: SurfPath, spawnV: number, o: SurfPadOpts = {}): { readonly spawn: V3; readonly top: number } {
    const overlap = o.overlap ?? 96;
    const s0 = o.padS0 ?? overlap;
    const s1 = s0 + 96;
    const s2 = s1 + 128;
    const fb = b.frameAt(0);
    const base = b.apexAt(s0);
    const padTop = r3(base + PAD_RISE);
    const pts: V3[] = [];
    for (const vv of o.padV ?? [-72, 72]) pts.push(fb.p(s0, vv, base), fb.p(s1, vv, padTop), fb.p(s2, vv, padTop), fb.p(s2, vv, base));
    this.add({ type: 'hull', points: pts, mat: 'checkpoint', tag: `cp${order}pad` });
    const sp = fb.p(s1 + 64, spawnV, padTop);
    const fa = a.frameAt(a.length);
    const uN = Math.max(360, s0 + 330);
    const footN = b.apexAt(overlap + uN) - b.height;
    const half = Math.max(a.o.width, b.o.width) / 2;
    const [lo, hi] = aabbOf(fa, [-420, uN], o.span ?? [-half, half], [footN + 40, o.topY ?? padTop + CP_TALL / 2]);
    this.checkpoint(order, lo, hi, sp, fb.yaw);
    return { spawn: sp, top: padTop };
  }

  /**
   * Checkpoint am Drop a → b einer geraden Surf-Kette (SurfRamp, L2/L4), Achse `axis` (Default: Richtung
   * von b): Keil-Pad auf dem Grat von b bündig ab dem Ende von a (quer −24…72), Spawn 24 u rechts vom Grat
   * (wer geradeaus abläuft, hat die Hull über der rechten Flanke, nicht auf dem First). Trigger 420 u vor
   * bis 360 u hinter dem Ende von a, quer genau über den Rampen, unten 40 u über dem Fuß von b.
   */
  surfCheckpoint(order: number, a: SurfRamp, b: SurfRamp, o: SurfCheckpointOpts = {}): { readonly spawn: V3; readonly top: number } {
    const axis = o.axis ?? b.o.yaw;
    const overlap = o.overlap ?? 96;
    const fb = new Frame(b.frame.x, b.frame.z, axis);
    const s0 = overlap;
    const s1 = s0 + 96;
    const s2 = s1 + 128;
    const base = b.apexAt(s0);
    const padTop = r3(base + PAD_RISE);
    const pts: V3[] = [];
    for (const vv of o.padV ?? [-24, 72]) pts.push(fb.p(s0, vv, base), fb.p(s1, vv, padTop), fb.p(s2, vv, padTop), fb.p(s2, vv, base));
    this.add({ type: 'hull', points: pts, mat: 'checkpoint', tag: `cp${order}pad` });
    const sp = fb.p(s1 + 64, o.spawnV ?? 24, padTop);
    const fa = new Frame(a.frame.x, a.frame.z, axis);
    const sEnd = a.o.length;
    const uN = sEnd + 360;
    const footN = b.apexAt(uN - (sEnd - overlap)) - b.height;
    const w = o.width ?? Math.max(a.o.width, b.o.width);
    const [lo, hi] = aabbOf(fa, [sEnd - 420, uN], [-w / 2, w / 2], [footN + 40, padTop + CP_TALL / 2]);
    this.checkpoint(order, lo, hi, sp, axis);
    return { spawn: sp, top: padTop };
  }

  /**
   * Kill-Zonen links und rechts neben einer achsparallelen Surf-Kette, knapp unter ihrem Fuß: wer seitlich
   * vom Fuß rutscht, kommt nie zurück — statt langem Fall sofort raus. In Stücken ≤ `seg` (512) u, jedes
   * `below` (64) u unter dem tiefsten Fuß seines Stücks, `gap` (32) u neben dem Fuß (die Hull ist dann ganz
   * draußen). `keep` kürzt/verwirft den Bereich entlang der Achse (z. B. unter einer Wendel). Liefert die Anzahl.
   */
  chainKillZones(chain: readonly SurfRamp[], o: ChainKillOpts): number {
    const seg = o.seg ?? 512;
    const gap = o.gap ?? 32;
    const below = o.below ?? 64;
    const keep = o.keep ?? ((lo: number, hi: number): V2 => [lo, hi]);
    const tagOf = o.tag ?? ((side: 'left' | 'right', r: SurfRamp, k: number): string => `kill-${side === 'right' ? 'r' : 'l'}-${r.o.tag ?? ''}.${k}`);
    let count = 0;
    for (const r of chain) {
      if (!isOrtho(r.o.yaw)) throw new Error(`chainKillZones: Rampe ${r.o.tag ?? ''} ist nicht achsparallel (yaw ${r.o.yaw})`);
      const [fx, fz] = forwardOf(r.o.yaw);
      const alongX = Math.abs(fx) > Math.abs(fz);
      const [rx, rz] = rightOf(r.o.yaw);
      const rightSign = Math.sign(alongX ? rz : rx);
      const line = alongX ? r.frame.z : r.frame.x;
      const half = r.o.width / 2 + gap;
      const n = Math.ceil(r.o.length / seg);
      for (let k = 0; k < n; k++) {
        const sa = (r.o.length * k) / n;
        const sb = (r.o.length * (k + 1)) / n;
        const top = Math.min(r.apexAt(sa), r.apexAt(sb)) - r.height - below;
        const pa = r.frame.xz(sa);
        const pb = r.frame.xz(sb);
        const ia = alongX ? pa[0] : pa[1];
        const ib = alongX ? pb[0] : pb[1];
        const range = keep(Math.min(ia, ib), Math.max(ia, ib));
        if (!range) continue;
        for (const side of ['right', 'left'] as const) {
          const s = side === 'right' ? rightSign : -rightSign;
          const lat: V2 = s > 0 ? [line + half, line + o.reach] : [line - o.reach, line - half];
          const min: V3 = alongX ? [range[0], o.bottom, lat[0]] : [lat[0], o.bottom, range[0]];
          const max: V3 = alongX ? [range[1], top, lat[1]] : [lat[1], top, range[1]];
          this.killZone(min, max, tagOf(side, r, k, n));
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Ziel hinter einem Launch (L2/L3/L4): Plattform `drop` u unter dem Grat-Ende, Lücke aus dem gemessenen
   * unteren Tempo-Band am Launch (`launchMin`, Flug ohne Steigwinkel) mit 10 % Weitenreserve bis zur Kante,
   * `depth` u tief, quer `v`. Ziel-Trigger 900 u hoch (wer mit Überspeed drüberfliegt, hat trotzdem gewonnen),
   * Prallwand am Ende. Jedes Movement-Tuning zieht die Lücke über die Messung mit.
   */
  finishAfterLaunch(end: TrackEnd, launch: V3, launchMin: number, o: { readonly drop: number; readonly depth: number; readonly v: V2 }): FinishAfterLaunch {
    const top = Math.round(end.apex - o.drop);
    const frame = new Frame(end.x, end.z, end.yaw);
    const flight = airTime(launch[1] - top, false, 0);
    // Flug bis zur Kante = lip − 8 (Knoten 8 u vor dem Kickerende, die Hull trägt 16 u über die Kante).
    const lip = Math.floor(((launchMin * flight) / RESERVE + 8) / 16) * 16;
    const fin = this.platform(frame, [lip, lip + o.depth], o.v, top, { tag: 'finish', mat: 'finish', thick: 128 });
    const [a, b] = aabbOf(frame, [fin.u0, fin.u1], o.v, [top, top + 900]);
    this.finishZone(a, b);
    this.platform(frame, [fin.u1, fin.u1 + 64], o.v, top + 900, { tag: 'backstop', mat: 'wall', thick: 1028, trim: false });
    return { fin, frame, top, lip, flight };
  }

  /**
   * Kill-Kacheln unter allen bisherigen Kollisions-Brushes (L3): Raster `tile`² (1024), jede Kachel `below`
   * (250) u unter der tiefsten Fläche, die in die Kachel reicht (± `reach` 64), `height` (600) u hoch. Für
   * weitläufige Surf-Maps, in denen seitliche Kill-Zonen je Rampe nicht passen (Kurven). Liefert die Anzahl.
   * Grundriss und Unterkante kommen aus compileBrush — dieselben Punkte wie im Spiel, samt Prismen und
   * rotY um pivot (der Prototyp ließ Prismen weg und drehte Hüllen nicht: Kachel über einem Prisma-Boden).
   */
  killTiles(o: { readonly tile?: number; readonly margin?: number; readonly reach?: number; readonly below?: number; readonly height?: number; readonly tag?: string } = {}): number {
    const T = o.tile ?? 1024;
    const margin = o.margin ?? 512;
    const reach = o.reach ?? 64;
    const below = o.below ?? 250;
    const drop = below + (o.height ?? 600);
    const boxes = this.brushes
      .filter((b) => b.collide !== false)
      .map((b, i) => {
        const bb = compileBrush(b, i).bounds;
        return { x0: bb.min.x, x1: bb.max.x, z0: bb.min.z, z1: bb.max.z, y0: bb.min.y };
      });
    const X0 = Math.min(...boxes.map((b) => b.x0)) - margin;
    const X1 = Math.max(...boxes.map((b) => b.x1)) + margin;
    const Z0 = Math.min(...boxes.map((b) => b.z0)) - margin;
    const Z1 = Math.max(...boxes.map((b) => b.z1)) + margin;
    let n = 0;
    for (let x = Math.floor(X0 / T) * T; x < X1; x += T) {
      for (let zz = Math.floor(Z0 / T) * T; zz < Z1; zz += T) {
        let low = Infinity;
        for (const b of boxes) if (b.x1 > x - reach && b.x0 < x + T + reach && b.z1 > zz - reach && b.z0 < zz + T + reach) low = Math.min(low, b.y0);
        if (!Number.isFinite(low)) continue;
        this.killZone([x, low - drop, zz], [x + T, low - below, zz + T], o.tag ?? 'kill-tile');
        n++;
      }
    }
    return n;
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
/** Checkpoint-Pad: Anstieg des Keils (u) und Höhe des Luft-Triggers über dem Pad (× ½). */
const PAD_RISE = 40;
const CP_TALL = 640;

export interface SurfPadOpts {
  /** Querbereich des Luft-Triggers (v, rechts positiv). Default ± halbe Profilbreite. */
  readonly span?: V2;
  /** Querbereich des Pads auf dem Grat (Default −72…72). */
  readonly padV?: V2;
  /** Pad-Anfang auf b (Bogenlänge, Default = overlap). */
  readonly padS0?: number;
  /** Oberkante des Triggers (Welt-y). Default Pad + 320. */
  readonly topY?: number;
  /** Überlappung des Drops (Default 96). */
  readonly overlap?: number;
}

export interface SurfCheckpointOpts {
  /** Achse der Kette (yaw, Grad). Default: Richtung von b. */
  readonly axis?: number;
  readonly overlap?: number;
  /** Pad quer (Default −24…72) und Spawn-Versatz rechts vom Grat (Default 24). */
  readonly padV?: V2;
  readonly spawnV?: number;
  /** Trigger-Breite quer (Default: breitere der beiden Rampen). */
  readonly width?: number;
}

export interface ChainKillOpts {
  /** Seitliche Ausdehnung ab der Achse (u). */
  readonly reach: number;
  /** Unterkante der Zonen (Welt-y). */
  readonly bottom: number;
  readonly seg?: number;
  readonly gap?: number;
  readonly below?: number;
  /** Bereich entlang der Achse (Weltkoordinate lo < hi) kürzen oder verwerfen (null). */
  readonly keep?: (lo: number, hi: number) => V2 | null;
  /** Tag je Zone; Default `kill-r-<Rampe>.<k>` / `kill-l-…`. */
  readonly tag?: (side: 'left' | 'right', ramp: SurfRamp, k: number, n: number) => string;
}

export interface FinishAfterLaunch {
  readonly fin: PlacedPlatform;
  /** Frame am Grat-Ende (u = Flugrichtung). */
  readonly frame: Frame;
  /** Oberseite der Zielplattform. */
  readonly top: number;
  /** Lücke (u) vom Grat-Ende bis zur Plattformkante. */
  readonly lip: number;
  /** Flugzeit (s) vom Launch-Knoten bis auf die Plattformhöhe. */
  readonly flight: number;
}

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
