/**
 * Level 4 (Turm) — Prototyp eines Bausteins, der in tools/levels/lib.ts fehlt:
 * die WENDEL (steigende Spiralrampe um einen Kern), exakt fugenlos wie `Ring`.
 *
 * Geometrie: Winkel φ wie `Ring` (gegen den Uhrzeigersinn von oben, Punkt =
 * (cx + r·cosφ, cz − r·sinφ), Fahrtrichtung dort = yaw φ, Kern links). θ ist
 * der Fahrwinkel ab dem Wendel-Anfang (φ = phi0 + θ, kann > 360 werden: zweite
 * Umdrehung liegt über der ersten).
 *
 * Die Oberseite ist eine Wendelfläche (Höhe hängt nur von θ ab, radiale Linien
 * waagerecht). Vier Ecken eines Segments sind dann NICHT koplanar — deshalb wird
 * jedes Segment in zwei Dreiecks-Prismen zerlegt (konvexe Hüllen aus 3 Ober- und
 * 3 Unterpunkten). Nachbarsegmente teilen exakt dieselben Eckpunkte: keine
 * Stufe, keine Fuge; im Segment entsteht entlang der Diagonale nur ein flacher
 * Knick (bei 4° Segmentwinkel < 0,5°).
 *
 * Das Höhenprofil ist stückweise linear in θ ("Abschnitte"). Zwischen Abschnitten
 * darf es springen (Stufe = senkrechte Stirn, z. B. Crouch-Kante): die Hülle des
 * höheren Abschnitts reicht `thick` tief und bildet die Stirn.
 */
import type { BrushDef, HullDef, Vec3Tuple } from '../../../../src/world/level/LevelFormat';
import type { LevelBuilder, Style, V2, V3 } from '../../../levels/lib';

const DEG = Math.PI / 180;

export interface HelixSection extends Style {
  /** θ-Bereich (Grad). */
  readonly from: number;
  readonly to: number;
  /** Höhe der Oberseite am Anfang/Ende (linear dazwischen). */
  readonly y0: number;
  readonly y1: number;
  /** Anderer Innen-/Außenradius nur für diesen Abschnitt (z. B. schmaler Grat). */
  readonly rIn?: number;
  readonly rOut?: number;
  /** Keine Bande außen (z. B. Übergang zum Himmelssteg). */
  readonly noBoard?: boolean;
}

export interface HelixOpts {
  readonly center: V2;
  readonly rIn: number;
  readonly rOut: number;
  /** φ bei θ = 0. */
  readonly phi0: number;
  /** Segmentwinkel (Grad), teilt jeden Abschnitt in gleiche Stücke ≤ seg. */
  readonly seg: number;
  /** Dicke unter der Oberseite (muss jede Stufe decken). */
  readonly thick: number;
  /** Zweites Leuchtband an der Unterkante (LevelFormat.underTrim): die Wendel liest sich von unten als Band. */
  readonly underTrim?: boolean;
  /** Bande am Außenrand: Höhe über der Oberseite (0 = keine) und Dicke. */
  readonly board?: { readonly h: number; readonly t: number; readonly style?: Style };
  /**
   * θ der Stufen (Crouch-Kanten), an denen die Bande EIGENE Segmente bekommt, deren Mitte
   * genau auf der Stufe liegt: Stufe (radial) und Bande (Sehne) treffen sich dann im rechten
   * Winkel. An einer 88°-Ecke (Segmentgrenze auf der Stufe) hing der Spieler mit W in der
   * Luft fest (Befund, tools/critique/v2/level4/cornercling.ts).
   */
  readonly boardRisers?: readonly number[];
  readonly sections: readonly HelixSection[];
}

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
      // An einer Stufe auf einer Achsrichtung (φ Vielfaches von 90°) als achsparallele BOX: exakte
      // Normalen. Eine Hülle lieferte (0, 0, −0.9999999999999999) — das genügte, um den Knick-Fehler
      // in PlayerMovement.tryPlayerMove auszulösen (Luft-Hänger, fixcheck.ts).
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

  /** Profilhöhe bei θ (erster Abschnitt, der θ enthält; an Stufen der obere/spätere wenn `after`). */
  yAt(theta: number, after = false): number {
    const secs = this.o.sections;
    const hit = after ? [...secs].reverse().find((s) => theta >= s.from - 1e-9 && theta <= s.to + 1e-9) : secs.find((s) => theta >= s.from - 1e-9 && theta <= s.to + 1e-9);
    if (!hit) throw new Error(`Helix: θ ${theta} liegt in keinem Abschnitt`);
    return hit.y0 + ((hit.y1 - hit.y0) * (theta - hit.from)) / (hit.to - hit.from);
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
