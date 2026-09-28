/**
 * Prototyp (Level 3, Entwurf): Surf-Pfade mit Kurven und Halbrampen.
 *
 * `lib.SurfRamp`/`surfChain` bauen nur gerade Prismen. Level 3 braucht
 * Richtungswechsel und eine Gabelung. Beides ohne neue Kanten in der Fahrlinie
 * (fallen.md #31, #72):
 *
 * - Kurve = Kette gerader Stücke mit kleinem Knick (≤ 7.5°), Stoß an Stoß mit
 *   GEHRUNG: jede Fuge liegt auf der Winkelhalbierenden, beide Stücke teilen exakt
 *   dasselbe Fugen-Dreieck (Apex, zwei Füße, Querabstand × 1/cos(Δ/2)). Keine
 *   Lücke außen, keine Überlappung innen. Innenflanke = konkaver Knick (die Rampe
 *   trägt einen um die Kurve), Außenflanke = konvexer Knick (man muss reindrücken).
 *   Mit Achsgefälle sind die Flanken eines Stücks nicht mehr exakt eben (Fuß
 *   ±(W/2)·tan(Δ/2)·tanα, bei 768/7.5°/8° ≈ 3.5 u) — die Hülle faltet sie konvex.
 * - Halbrampe ('left'/'right') = nur eine Flanke, senkrechte Innenwand unter dem
 *   Grat. Zwei Halbrampen mit gemeinsamem Grat ergeben am Anfang exakt das volle
 *   Profil (Gabelung ohne Stirnfläche) und laufen danach auseinander.
 */
import type { HullDef, Vec3Tuple } from '../../../../src/world/level/LevelFormat';
import { Frame, forwardOf, rightOf, type Style, type V2, type V3 } from '../../../levels/lib';

const DEG = Math.PI / 180;
/** Neigung der Halbrampen-Innenwand (u am Fuß). */
const WALL_LEAN = 6;
/** Drehung der Banden-Fugen gegen die Rampen-Fugen (Grad). */
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

export type RampHalf = 'both' | 'left' | 'right';

export interface SurfPathOpts extends Style {
  readonly start: V2;
  readonly yaw: number;
  readonly apex: number;
  readonly width: number;
  readonly flankDeg?: number;
  readonly segs: readonly PathSeg[];
  readonly half?: RampHalf;
  /**
   * Bande auf dem Grat einer Halbrampe (Höhe u, 0 = keine): senkrechte Leuchtleiste über der Innenwand,
   * auf Gehrung wie die Rampe. In Steilkurven fängt sie, wer zu schnell ist und über den Grat stiege.
   */
  readonly rail?: number;
  readonly railTint?: string;
  /** Bogenlängen-Fenster der Bande (Default: ganzer Pfad). */
  readonly railRange?: readonly [number, number];
  /**
   * Innenkante der Bande so weit vor dem Grat (u, Default 12). Aufeinanderfolgende Rampen (Drop) im Wechsel
   * 12/14: die Banden laufen dann ohne Lücke durch (die neue beginnt unter der alten), ihre Flächen liegen
   * aber nicht koplanar (Z-Fighting).
   */
  readonly railInset?: number;
  /**
   * Fuß-Bande (Höhe u über dem Fuß, 0 = keine) an der Flankenseite einer Halbrampe: Leitplanke unten. In der
   * Außenbahn einer Kurve fängt sie, wen die Fliehkraft die Flanke hinunterdrückt — die Kehle zwischen Flanke
   * und Planke trägt dann um die Kurve (konkav wie eine Innenflanke).
   */
  readonly footRail?: number;
  readonly footRailTint?: string;
  /** Innenkante der Fuß-Bande so weit über dem Fuß (horizontal zur Mitte hin, u, Default 10). */
  readonly footRailInset?: number;
}

interface Joint {
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

export class SurfPath {
  readonly joints: Joint[] = [];
  readonly pieces: PathPiece[] = [];
  readonly rails: HullDef[] = [];
  readonly flankDeg: number;
  readonly height: number;
  readonly half: RampHalf;
  readonly length: number;

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
  private section(j: Joint): Vec3Tuple[] {
    const [rx, rz] = rightOf(j.miter);
    const w = (this.o.width / 2) * j.stretch;
    const foot = j.apex - this.height;
    const apex: Vec3Tuple = [j.x, j.apex, j.z];
    const right: Vec3Tuple = [j.x + rx * w, foot, j.z + rz * w];
    const left: Vec3Tuple = [j.x - rx * w, foot, j.z - rz * w];
    // Innenwand der Halbrampe am Fuß um WALL_LEAN u zur Flanke hin eingezogen (leichter Überhang, n.y ≈ −0.01):
    // zwei Halbrampen mit gemeinsamem Grat überlappen so nicht, und die Wände aufeinanderfolgender Halbrampen
    // (Drop) liegen nicht koplanar übereinander (Z-Fighting im Überlappungsstück).
    const lean = this.half === 'left' ? -WALL_LEAN : WALL_LEAN;
    const under: Vec3Tuple = [j.x + rx * lean, foot, j.z + rz * lean];
    if (this.half === 'right') return [apex, right, under];
    if (this.half === 'left') return [apex, left, under];
    return [apex, left, right];
  }

  /**
   * Bande: Innenseite 12 u VOR dem Grat (über der Flanke), außen 16 u über die Wand hinaus, unten 28 u unter
   * dem Grat (in der Rampe vergraben). Stünde sie genau auf dem Grat, erreichte die Hull dessen Kanten-Bevel
   * (n.y ≈ 0.97, begehbar) → Bodenkontakt, Reibung, der Fahrer bleibt an der Bande stehen (gridDiag).
   */
  private railSection(j: Joint, skew: number): Vec3Tuple[] {
    // Fuge der Bande um `skew` Grad gegen die Rampenfuge gedreht: sonst lägen Banden- und Rampenkappe
    // koplanar übereinander (Z-Fighting-Prüfung); beide Bandenstücke teilen weiter exakt dieselbe Fläche.
    const [rx, rz] = rightOf(j.miter + skew);
    const sgn = this.half === 'left' ? 1 : -1;
    const inner = -sgn * (this.o.railInset ?? 12) * j.stretch;
    const out = sgn * ((this.o.railInset ?? 12) + 4) * j.stretch;
    const top = j.apex + (this.o.rail ?? 0);
    const bot = j.apex - 28;
    // Oberseite fällt NACH INNEN mit 60° ab (zur Flanke): nicht begehbar, und wer auf ihr landet, rutscht
    // zurück auf die Rampe. Flach war sie ein Laufsteg (Respawn-Surfer lief aus der Kurve), nach außen
    // geneigt ein Rutsch ins Aus (surferTrace).
    const innerTop = top - Math.abs(out - inner) * Math.tan((60 * Math.PI) / 180);
    return [
      [j.x + rx * inner, innerTop, j.z + rz * inner], [j.x + rx * inner, bot, j.z + rz * inner],
      [j.x + rx * out, top, j.z + rz * out], [j.x + rx * out, bot, j.z + rz * out],
    ];
  }

  /** Fuß-Bande: Innenkante footRailInset über dem Fuß (zur Mitte), 16 u dick nach außen, Oberseite fällt nach innen. */
  private footRailSection(j: Joint, skew: number): Vec3Tuple[] {
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

  /** Mittellinie (Grat) bei Bogenlänge s. */
  at(s: number): { readonly x: number; readonly z: number; readonly yaw: number; readonly apex: number } {
    const p = this.pieceAt(s);
    const [x, z] = p.frame.xz(Math.max(0, Math.min(this.length, s)) - p.s0);
    return { x, z, yaw: p.yaw, apex: this.apexAt(s) };
  }

  /** Lokaler Frame bei s (u vorwärts entlang des Stücks, v rechts). */
  frameAt(s: number): Frame {
    const a = this.at(s);
    return new Frame(a.x, a.z, a.yaw);
  }

  get end(): { readonly x: number; readonly z: number; readonly yaw: number; readonly apex: number } {
    return this.at(this.length);
  }

  /** Füße einer Stand-Hull an der Flanke (wie SurfRamp.riderPos): side +1 rechts, −1 links. */
  riderPos(s: number, side: 1 | -1, depth: number): V3 {
    const t = Math.tan(this.flankDeg * DEG);
    const f = this.frameAt(s);
    // Die Hull ist achsparallel: an einer schrägen Flanke (Kurve) ragt ihre Ecke bis 16·(|cos|+|sin|)
    // in Normalenrichtung — mit 16 wie bei SurfRamp stäke der Knoten bis 11 u in der Flanke.
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

/** Folgepfad als Drop (wie LevelBuilder.surfDrop): beginnt `overlap` vor dem Ende von `prev`, `drop` tiefer, gleiche Richtung. */
export function dropFrom(prev: SurfPath, o: Omit<SurfPathOpts, 'start' | 'yaw' | 'apex' | 'width'> & { readonly overlap: number; readonly drop: number; readonly width?: number; readonly lateral?: number }): SurfPath {
  const s0 = prev.length - o.overlap;
  const a = prev.at(s0);
  const f = new Frame(a.x, a.z, a.yaw);
  return new SurfPath({ ...o, start: f.xz(0, o.lateral ?? 0), yaw: a.yaw, apex: a.apex - o.drop, width: o.width ?? prev.o.width, flankDeg: o.flankDeg ?? prev.flankDeg });
}

/**
 * Auffang-Band unter dem Fuß einer Halbrampe (folgt Kurven auf Gehrung): Fläche `below` unter dem Fuß, `width` u
 * breit nach außen, 32 u dick, mit Bande (`bank` u hoch, 24 u dick) am Außenrand. Wer die Außenflanke einer Kurve
 * hinunterrutscht, landet hier, hüpft weiter und fällt am Ende auf die Folgerampe — langsamer, nie tot.
 * Kein Leitplanken-Kehle an der Flanke: Flanke + Planke + Fuge = drei Ebenen → Stillstand (probe, gridDiag).
 */
export function catchBand(path: SurfPath, o: { readonly below: number; readonly width: number; readonly bank: number; readonly tint?: string; readonly tag?: string }): HullDef[] {
  const out: HullDef[] = [];
  const sgn = path.half === 'left' ? -1 : 1;
  const js = path.joints;
  const at = (j: (typeof js)[number], lateral: number, y: number): Vec3Tuple => {
    const [rx, rz] = rightOf(j.miter);
    const l = sgn * lateral * j.stretch;
    return [j.x + rx * l, y, j.z + rz * l];
  };
  const W2 = path.o.width / 2;
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
    const bank: Vec3Tuple[] = [at(a, outer, ya + o.bank - 24 * Math.tan((60 * Math.PI) / 180)), at(a, bOut, ya + o.bank), at(a, outer, ya - 32), at(a, bOut, ya - 32), at(b, outer, yb + o.bank - 24 * Math.tan((60 * Math.PI) / 180)), at(b, bOut, yb + o.bank), at(b, outer, yb - 32), at(b, bOut, yb - 32)];
    out.push({ type: 'hull', points: bank, mat: 'accent', ...(o.tint ? { tint: o.tint } : {}), tag: `${o.tag ?? 'catch'}Bank` });
  }
  return out;
}
