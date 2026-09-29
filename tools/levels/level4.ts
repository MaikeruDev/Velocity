/**
 * Level 4 "04 TURM — Tempo ist Höhe." (Plan 007, Phase 2: Strang level4).
 *
 * Ein Funkturm bei Nacht. Um den Kern (r 640) läuft eine breite Wendel (512 u, Bande außen)
 * 1,5 Umdrehungen nach oben; vier Abschnitte, jeder fragt eine Kletter-Fähigkeit ab,
 * dazwischen flache Podeste = Checkpoints:
 *
 *   E1 WENDEL   θ   0–135  Rampe 0 → 384      bergauf hüpfen + einseitig Kurven-Strafen
 *   P1          θ 135–155  384                CP1
 *   E2 GRÄBEN   θ 155–290  384 → 768          außen lückenlos (Tempo-Bahn); innen kürzer, steiler, drei flache
 *                                             Gräben — schneller bis ~550 u/s, darüber höchstens ~0.2 s langsamer
 *   P2          θ 290–310  768                CP2
 *   E3 KANTEN   θ 310–450  768 → 1088         zwei Crouch-Kanten (66 u) mit Terrasse davor
 *   P3          θ 450–470  1088               CP3
 *   E4 AUSLAUF  θ 470–540  1088 → 1344        Tempo holen
 *   STEG        gerade nach Westen hinaus, 1344 → 1536 (Geländer beidseitig)
 *   KRONE       1536, Sprungbrett            CP4
 *   ABFAHRT     Surf-Kette nach Westen, 4 Drops (CP5), Kicker → Ziel
 *
 * Im Aufstieg stirbt man nicht: innen der Kern, außen die sichtbare 80-u-Bande plus unsichtbarer Clip bis 256 u
 * (CLIP_H; die Bande allein hielt nicht — Crouch-Jump + Kanten-Assist reichen bis 80 u, bergab mehr), dahinter ein
 * Kill-Ring als Rückfallebene. Gräben mit Auffang-Mulde und Warnstreifen, Crouch-Kanten prallen auf die eigene
 * Terrasse zurück (das Absprungband davor zeigt, wo man springen muss). Keine Pads (Plan 007 §4: gemessen schlechter),
 * kein Route-Knoten auf dem Sprungbrett (der Bot bremste dort). Vorlage: Prototyp
 * tools/critique/v2/level4 — hier gegen die finale Physik (Hang-Landung mit Schuld, Kanten-Assist, Cap 40) neu
 * gemessen; Zahlen in .docs/research/levels/level4.md.
 */
import { Vector3 } from 'three';
import { BrushWorld } from '../../src/world/collision/BrushWorld';
import { compileBrush } from '../../src/world/level/compileLevel';
import type { BrushDef, HullDef, LevelFile, Vec3Tuple } from '../../src/world/level/LevelFormat';
import { PHYS, riseWindow } from './ballistics';
import { Frame, Helix, LevelBuilder, aabbOf, type HelixSection, type SurfRamp, type V2, type V3 } from './lib';
import { SURF_GRID, measureSurfSpeeds } from './physics';

const COL = {
  red: '#ff3848',
  ice: '#8fe3ff',
  amber: '#ffb347',
  sodium: '#c8843c',
  violet: '#8a6cff',
  board: '#2b3350',
  core: '#262b40',
} as const;

// ── Maße ───────────────────────────────────────────────────────────────────
export const CENTER: V2 = [0, 0];
export const R_IN = 640;
export const R_OUT = 1152;
/** Planlinie (Route) — Mitte der Bahn. */
export const R_LINE = 896;
/** θ = 0 am Südpunkt, Fahrt nach Osten, Kern links (φ = PHI0 + θ wie lib.Ring). */
const PHI0 = 270;
const SEG = 4;
const THICK = 128;
/** Sichtbare Bande außen (Wendel) bzw. Geländer-Höhe (Steg); die Kollision reicht höher, siehe CLIP_H. */
export const BOARD_H = 80;
/**
 * Unsichtbarer Clip bis CLIP_H über der Bahn außen an Wendel, Steg und Krone, Dach nach innen geneigt (n.y ≈ 0.62:
 * kein Stehen, kein Lip-Step, wer darauf fällt, rutscht auf die Bahn). Die 80-u-Bande allein hielt nicht:
 * Crouch-Jump + Kanten-Assist reichen bis 80 u, am Hang trifft die Hull die Bande mit der Talecke, bergab kommt der
 * Höhenverlust des Hangs dazu, von der Terrasse einer Crouch-Kante weitere 66 u. Messung und Raster: level4.md, "Bande".
 */
export const CLIP_H = 256;
const CLIP_ROOF = 40;
/** Kill-Ring: so weit außerhalb der Bande, so tief unter der Bahn (u) — Rückfallebene, falls doch jemand hinauskommt. */
const KILL_OUT = 64;
const KILL_BELOW = 150;
/** Höhe je Abschnitt E1/E2. */
const RISE = 384;
/** Podest und Abschnitt (Grad). */
const P_W = 20;
const SEC = 135;
/**
 * E2: die Bahn teilt sich bei R_SPLIT. Innen (224 u breit) 25 % kürzer, aber steiler und mit drei Gräben
 * [Beginn relativ zum Abschnitt, Breite] (Grad); außen lückenlos. Auf dem 12°-Hang ist ein Hop tempo-unabhängig
 * ~250 u lang: die Gräben trifft man fast immer (fallen.md #166) — die Tiefe bestimmt, was das kostet. 72 u (Sohle
 * 26–33° steil, Landung wirft hoch) machte die Innenlinie ab 450 u/s zur Falle (W + Leertaste bis +1.33 s); 24 u
 * (Sohle ~18°): innen schneller bis ~550 u/s, darüber höchstens +0.2 s — eine Wahl nach Tempo, keine Falle
 * (level4.md "Innenbahn"). Die Route läuft außen; die Innenlinie misst nur die Probe (`inner`).
 */
export const R_SPLIT = 864;
const TRENCHES: ReadonlyArray<readonly [number, number]> = [
  [24, 16],
  [62, 18],
  [100, 20],
];
export const TRENCH_DEPTH = 24;
/** Route-Radius in E2 (Außenbahn, weit weg von der Grabenkante) und die Innenlinie der Proben. */
export const R_E2_OUT = 1000;
export const R_E2_IN = 752;
/**
 * Crouch-Kanten: ≥ 66 u (movement.md §5: ohne Ducken reicht es aus der Auto-Hop-Landung bis 63.5 u,
 * + 2 Reserve). Mit Crouch-Jump + Kanten-Assist reicht es bis ~80 u.
 */
export const CROUCH_H = 66;
/** Rampen in E3: vor Kante 1 und zwischen den Kanten; zusammen mit 2 × CROUCH_H = 320 (P2 → P3). */
const E3_RAMP0 = 62;
const E3_RAMP1 = 126;
/** Lippe (mat duck, ↑C) oben an jeder Kante, Grad. */
const LIP = 3;
/**
 * Terrasse vor jeder Kante (Grad): 391 u auf der Planlinie. Bis ~650 u/s liegt das ganze Crouch-Fenster darauf (Wandkontakt
 * ≤ 0.56 s nach dem Absprung), darüber reicht es auf die Rampe davor — von dort (tiefer) prallt man öfter ab.
 */
const E3_TERRACE = 25;
/** Himmelssteg: Länge nach Westen, Anstieg bis zur Krone. */
const STEG_LEN = 1100;
const STEG_RISE = 192;
/** Krone: flaches Podest (CP4), dahinter Absprung-Keil 10° abwärts (wie L2 E1 vor S0). */
const KRONE_LEN = 200;
const KICK_LEN = 256;
/** Trichter an der Kronen-Westkante: so lang (u) läuft die Schrägwand von der Bande zum Brettrand. */
const FUNNEL_LEN = 120;
const KICK_DEG = 10;
/** Die erste Abfahrt-Rampe beginnt so weit vor dem Ende des Absprung-Keils (darunter). */
const UNDER = 100;
/**
 * Grat der Abfahrt liegt so weit SÜDLICH der Kronen-Mitte: wer geradeaus vom Sprungbrett läuft, fällt
 * auf die Nordflanke (Linie), nicht auf den begehbaren Grat (dort hüpfte der perfekte Bot und tauchte
 * steil auf die nächste Rampe: 370 u/s an CP5).
 */
const RIDGE_OFF = 128;
/**
 * Sprungbrett quer, nördlich des Grats (u): über der Nordflanke. Der Prototyp (32–320) warf am Nordrand tief an den
 * Fuß; 48–288 hielt vom CP4-Spawn 80/80. Wer wie ein Mensch vom Steg anhüpft und nach Norden driftet (Kurs −8°), traf
 * die Flanke dort zu tief: Anlauf vom Steg (Probe dropIn) 144/150 → mit 16–256 148/150, Spawn weiter 80/80. Grat-Hänger
 * (Blick bis +14° zur Rampe) unabhängig von der Brettlage — der Blick bremst, nicht das Brett.
 */
const BOARD: V2 = [16, 256];
const LANE_HALF = (R_OUT - R_IN) / 2;
/** Surf-Kette. */
const SURF_W = 768;
const LINE_DEPTH = 320;
const DROP_OVERLAP = 96;
const DROP = 128;

/**
 * Radiale Teilung der Wendel-Fläche (siehe ringSurface): die Planlinie (r 896, E2 r 1000) liegt in Ringen mit
 * 9–10.6° statt auf Dreiecken mit 14.3° und 8.1° im Wechsel. Mit der deterministischen Hang-Landung (Plan 007
 * A4) wird jede steile Bergauf-Landung ab ~650 u/s zum Rampslide (Clip, Tempo weg) — auf den 14°-Dreiecken
 * verlor der perfekte Bot so 2 s (Wendel-Abschnitte 6.1/3.9 s statt 5.5/3.3 s). Innen bleibt es steiler:
 * die kurze Linie kostet Tempo.
 */
const RINGS: readonly number[] = [R_SPLIT, 1008];

/** Stellschrauben für Mess-Sweeps (Default = gebautes Level). */
export interface Level4Options {
  /** Surf-minSpeed, Launch-Band und Ziel-Lücke messen (Default an; aus = Platzhalter, nur für Proben). */
  readonly measure?: boolean;
  /** E2-Route über die Innenlinie: 'jump' mit Absprungknoten vor jedem Graben, 'free' ohne. */
  readonly inner?: 'jump' | 'free';
  /** Plan-Tempo der E2-Knoten (u/s). */
  readonly vHelix?: number;
  /** Plan-Tempo am Crouch-Knoten (u/s): legt die Absprungstelle ins Crouch-Fenster. */
  readonly vCrouch?: number;
  /** Erste Abfahrt-Rampe: Länge nach dem Keil und Tiefe/Lage des ersten Surf-Knotens. */
  readonly d1?: number;
  readonly n1s?: number;
  readonly n1Depth?: number;
  /** Achsgefälle d2 (Grad). */
  readonly s2?: number;
  /** Radien, an denen die Wendel-Fläche zusätzlich radial geteilt wird (Mess-Sweep). */
  readonly rings?: readonly number[];
  /** Gräben der Innenbahn [Beginn relativ zu E2, Breite] (Grad; Mess-Sweep) und ihre Tiefe an der Absprungseite (u). */
  readonly trenches?: ReadonlyArray<readonly [number, number]>;
  readonly trenchDepth?: number;
  /** Grabensohle: 'ramp' steigt bündig zur Landekante (Default), 'flat' liegt überall trenchDepth unter der Bahn. */
  readonly trenchShape?: 'ramp' | 'flat';
  /** Segmentwinkel der Wendel (Grad). */
  readonly seg?: number;
  /** E3: Terrasse vor Kante 1/2 (Grad) und Anstieg der Rampe vor Kante 1 (u; Rest geht an die Rampe vor Kante 2). */
  readonly t1?: number;
  readonly t2?: number;
  readonly r0?: number;
  /** Crouch-Knoten so weit vor der Kante (u); Default aus vCrouch und dem Crouch-Fenster. */
  readonly crouchBack?: number;
  /** Mess-Sweep: zusätzlicher Knoten ohne Sprung so weit vor jeder Kante (u; Default keiner). */
  readonly terraceNode?: number;
  /** Grat der Abfahrt südlich der Kronen-Mitte (u) und Länge des Trichters (u). */
  readonly ridgeOff?: number;
  readonly funnelLen?: number;
  /** Sprungbrett quer, gemessen nördlich des Grats (u). */
  readonly board?: V2;
  /** Leuchtbänder unter der Wendel (Default an) und ihre Farbe; Umgebungslicht von unten (Mess-Sweep Look). */
  readonly underLights?: boolean;
  readonly underTint?: string;
  readonly ambientGround?: string;
  /** Clip-Höhe über der Bahn (u; Default CLIP_H); BOARD_H = nur die sichtbare Bande wie vor dem Review (Mess-Sweep). */
  readonly clipH?: number;
  /** Kill-Ring außen um die Wendel und neben dem Steg (Default an; Mess-Sweep). */
  readonly killRing?: boolean;
}

/** Wendel-Geometrie ohne Builder — die Proben (probes/level4.ts) lesen dieselben Zahlen. */
export interface Level4Layout {
  readonly helix: Helix;
  readonly sections: readonly HelixSection[];
  /** θ der Crouch-Kanten (Stirn) und Länge der Terrasse davor (Grad). */
  readonly crouchWalls: readonly number[];
  readonly terraces: readonly number[];
  readonly e1: readonly [number, number];
  readonly e2: readonly [number, number];
  readonly e3: readonly [number, number];
  readonly e4: readonly [number, number];
  /** Gräben der Innenbahn als [θa, θb]. */
  readonly trenches: ReadonlyArray<readonly [number, number]>;
  readonly podests: ReadonlyArray<{ readonly order: number; readonly from: number; readonly to: number; readonly y: number }>;
  readonly yE4: number;
  readonly coreTop: number;
  /** Steg + Krone: Frame (u nach Westen ab dem Nordpunkt, v nach Norden), Längen, halbe Breite, Bodenhöhe. */
  readonly steg: {
    readonly frame: Frame;
    readonly len: number;
    readonly krone: number;
    readonly half: number;
    readonly top: number;
    floorAt(u: number): number;
  };
}

export function level4Layout(o: Level4Options = {}): Level4Layout {
  const y0 = 0;
  const e1 = [0, SEC] as const;
  const p1 = [SEC, SEC + P_W] as const;
  const e2 = [p1[1], p1[1] + SEC] as const;
  const p2 = [e2[1], e2[1] + P_W] as const;
  // E3 endet genau am Ostpunkt (θ 450 = φ 0): beide Crouch-Kanten liegen auf Achsrichtungen — dort sind
  // Stufe, Bande-Segment (Box) und Kern-Pilaster achsparallel (Hüllen-Normalen sind nie exakt achsparallel).
  const e3 = [p2[1], 450] as const;
  const p3 = [e3[1], e3[1] + P_W] as const;
  const e4 = [p3[1], 540] as const;
  const yP1 = y0 + RISE;
  const yP2 = yP1 + RISE;
  const yP3 = yP2 + E3_RAMP0 + E3_RAMP1 + 2 * CROUCH_H;
  const t1 = o.t1 ?? E3_TERRACE;
  const t2 = o.t2 ?? E3_TERRACE;
  const r0 = o.r0 ?? E3_RAMP0;
  const r1 = E3_RAMP0 + E3_RAMP1 - r0;
  const yE4 = yP3 + 256;
  const kroneTop = yE4 + STEG_RISE;
  const sections: HelixSection[] = [];
  sections.push({ from: e1[0], to: e1[1], y0, y1: yP1, tag: 'w1' });
  sections.push({ from: p1[0], to: p1[1], y0: yP1, y1: yP1, mat: 'checkpoint', tag: 'p1' });
  // E2: Außen- und Innenbahn mit denselben θ-Grenzen (sonst Z-Fighting an der Trennkante). Gräben mit
  // Auffang-Mulde: TRENCH_DEPTH tief an der Absprungseite, bündig an der Landekante — wer zu kurz springt, hüpft heraus.
  const base2 = (t: number): number => yP1 + ((t - e2[0]) * RISE) / SEC;
  const trenches = o.trenches ?? TRENCHES;
  const cuts: number[] = [e2[0]];
  for (const [at, w] of trenches) cuts.push(e2[0] + at, e2[0] + at + w);
  cuts.push(e2[1]);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    sections.push({ from: a, to: b, y0: base2(a), y1: base2(b), rIn: R_SPLIT, tag: `w2out${i}` });
    sections.push(
      i % 2 === 1
        ? // Grabensohle ohne Trims: sie steigt steiler als die Bahn und ist verwunden — jede Dreiecksfuge bekäme ein Leuchtband (Zickzack
          // quer durch die Grube). Die Absprungkante trägt die Bahn davor, die Sohle bleibt dunkles Metall.
          { from: a, to: b, y0: base2(a) - (o.trenchDepth ?? TRENCH_DEPTH), y1: base2(b) - (o.trenchShape === 'flat' ? (o.trenchDepth ?? TRENCH_DEPTH) : 0), rOut: R_SPLIT, noBoard: true, mat: 'metal', trim: false, tag: `trench${(i + 1) / 2}` }
        : { from: a, to: b, y0: base2(a), y1: base2(b), rOut: R_SPLIT, noBoard: true, tint: '#c8d0ff', tag: `w2in${i / 2}` },
    );
  }
  sections.push({ from: p2[0], to: p2[1], y0: yP2, y1: yP2, mat: 'checkpoint', tag: 'p2' });
  // E3: Kante 1 am Südpunkt (θ 360), Kante 2 am Ostpunkt (θ 450).
  const crouchWalls = [360, 450];
  {
    let y = yP2;
    if (360 - t1 > e3[0] + 1e-6) sections.push({ from: e3[0], to: 360 - t1, y0: y, y1: y + r0, tag: 'w3r0' });
    y += r0;
    sections.push({ from: 360 - t1, to: 360, y0: y, y1: y, mat: 'accent', tint: '#3a3f66', tag: 'terrace1' });
    y += CROUCH_H;
    sections.push({ from: 360, to: 360 + LIP, y0: y, y1: y, mat: 'duck', tint: COL.ice, tag: 'lip1' });
    sections.push({ from: 360 + LIP, to: 450 - t2, y0: y, y1: y + r1, tag: 'w3r1' });
    y += r1;
    sections.push({ from: 450 - t2, to: 450, y0: y, y1: y, mat: 'accent', tint: '#3a3f66', tag: 'terrace2' });
    y += CROUCH_H;
    if (Math.abs(y - yP3) > 1e-6) throw new Error(`level4: E3 geht nicht auf (y ${y} statt ${yP3})`);
  }
  sections.push({ from: p3[0], to: p3[0] + LIP, y0: yP3, y1: yP3, mat: 'duck', tint: COL.ice, tag: 'lip2' });
  sections.push({ from: p3[0] + LIP, to: p3[1], y0: yP3, y1: yP3, mat: 'checkpoint', tag: 'p3' });
  sections.push({ from: e4[0], to: e4[1], y0: yP3, y1: yE4, tag: 'w4' });

  const helix = new Helix({
    center: CENTER,
    rIn: R_IN,
    rOut: R_OUT,
    phi0: PHI0,
    seg: o.seg ?? SEG,
    thick: THICK,
    underTrim: true,
    board: { h: BOARD_H, t: 32, style: { mat: 'wall', tint: COL.board } },
    boardRisers: crouchWalls,
    sections,
  });
  return {
    helix,
    sections,
    crouchWalls,
    terraces: [t1, t2],
    e1,
    e2,
    e3,
    e4,
    trenches: trenches.map(([at, w]) => [e2[0] + at, e2[0] + at + w] as const),
    podests: [
      { order: 1, from: p1[0], to: p1[1], y: yP1 },
      { order: 2, from: p2[0], to: p2[1], y: yP2 },
      { order: 3, from: p3[0] + LIP, to: p3[1], y: yP3 },
    ],
    yE4,
    coreTop: yE4 + 160,
    steg: {
      // Am Nordpunkt (θ 540) gerade nach Westen hinaus.
      frame: Frame.at(helix.xz(540, R_LINE), 90),
      len: STEG_LEN,
      krone: KRONE_LEN,
      half: LANE_HALF,
      top: kroneTop,
      floorAt: (u: number): number => (u <= STEG_LEN ? yE4 + (u / STEG_LEN) * (kroneTop - yE4) : kroneTop),
    },
  };
}

/**
 * Wendel-Fläche wie lib.Helix, aber zusätzlich an `rings` radial geteilt: ein Segment-Viereck zerfällt in
 * zwei Dreiecke mit der Steigung der Innen- bzw. Außenkante (14.3° / 8.1° bei 640/1152) — schmale Ringe
 * gleichen die Steigung auf jeder Linie an.
 */
function ringSurface(helix: Helix, rings: readonly number[]): HullDef[] {
  const o = helix.o;
  const out: HullDef[] = [];
  for (const s of o.sections) {
    const n = Math.max(1, Math.ceil((s.to - s.from) / o.seg - 1e-9));
    const rIn = s.rIn ?? o.rIn;
    const rOut = s.rOut ?? o.rOut;
    const radii = [rIn, ...rings.filter((r) => r > rIn + 1 && r < rOut - 1), rOut];
    for (let k = 0; k < n; k++) {
      const ta = s.from + ((s.to - s.from) * k) / n;
      const tb = s.from + ((s.to - s.from) * (k + 1)) / n;
      const ya = s.y0 + ((s.y1 - s.y0) * k) / n;
      const yb = s.y0 + ((s.y1 - s.y0) * (k + 1)) / n;
      for (let j = 0; j + 1 < radii.length; j++) {
        const A = helix.p3(ta, radii[j], ya);
        const B = helix.p3(ta, radii[j + 1], ya);
        const C = helix.p3(tb, radii[j + 1], yb);
        const D = helix.p3(tb, radii[j], yb);
        for (const tri of [[A, B, C], [A, C, D]] as const) {
          const pts: Vec3Tuple[] = [];
          for (const p of tri) pts.push([p[0], p[1], p[2]], [p[0], p[1] - o.thick, p[2]]);
          out.push({
            type: 'hull',
            points: pts,
            mat: s.mat ?? 'floor',
            ...(s.tint ? { tint: s.tint } : {}),
            ...(s.trim !== undefined ? { trim: s.trim } : {}),
            ...(o.underTrim ? { underTrim: true } : {}),
            ...(s.tag ? { tag: `${s.tag}#${k}.${j}` } : {}),
          });
        }
      }
    }
  }
  return out;
}

/**
 * Service-Lichter unter der Wendel (nur Optik): vom Start aus war die Unterseite eine dunkle Scheibe (Umgebungs-
 * licht von unten × Fake-AO 0.42). Zwei Lichtleisten je Abschnitt folgen der Unterkante, ein Stück je Wendel-
 * Segment — die Wendel liest sich von unten als Spirale. Jedes Stück hängt so tief, dass seine Hüllbox die Fläche
 * nicht schneidet (dieselbe Prüfung wie der Validator: Hüllbox gegen die Wendel, 1 u Schritte): an steilen
 * Stücken bis ~20 u, auf Podesten 1 u.
 */
function undersideLights(helix: Helix, surface: BrushWorld, radii: readonly number[], tint: string): BrushDef[] {
  const o = helix.o;
  const out: BrushDef[] = [];
  const WIDE = 16;
  const THIN = 5;
  const c = new Vector3();
  const mins = new Vector3();
  const maxs = new Vector3();
  for (const s of o.sections) {
    const rIn = s.rIn ?? o.rIn;
    const rOut = s.rOut ?? o.rOut;
    const n = Math.max(1, Math.ceil((s.to - s.from) / o.seg - 1e-9));
    for (const r of radii) {
      if (r - WIDE < rIn || r + WIDE > rOut) continue;
      for (let k = 0; k < n; k++) {
        const ta = s.from + ((s.to - s.from) * k) / n;
        const tb = s.from + ((s.to - s.from) * (k + 1)) / n;
        const ya = s.y0 + ((s.y1 - s.y0) * k) / n - o.thick;
        const yb = s.y0 + ((s.y1 - s.y0) * (k + 1)) / n - o.thick;
        const piece = (hang: number): HullDef => {
          const pts: Vec3Tuple[] = [];
          for (const [t, y] of [[ta, ya], [tb, yb]] as const) {
            for (const rr of [r - WIDE / 2, r + WIDE / 2]) {
              const [x, z] = helix.xz(t, rr);
              pts.push([x, y - hang, z], [x, y - hang - THIN, z]);
            }
          }
          return { type: 'hull', points: pts, mat: 'light', tint, collide: false, trim: false, tag: 'unterlicht' };
        };
        let hang = 1;
        for (; hang <= 32; hang++) {
          const b = compileBrush(piece(hang), 0).bounds;
          b.getCenter(c);
          const half = b.getSize(maxs).multiplyScalar(0.5).subScalar(0.5);
          mins.set(-half.x, 0, -half.z);
          maxs.set(half.x, b.max.y - b.min.y - 1, half.z);
          if (!surface.testBox(c.setY(b.min.y + 0.5), mins, maxs)) break;
        }
        if (hang <= 32) out.push(piece(hang));
      }
    }
  }
  return out;
}

/**
 * Absprungband vor einer Crouch-Kante (Semantik wie T6: "am Band springen"), parallel zur Wand — der Abstand zur Wand
 * ist auf jedem Radius derselbe. Hull-Front-Abstand (u) zur Wand:
 * - TAKEOFF_NEAR, durchgehend eisblau: dort kommt jeder Crouch-Jump ohne Tempoverlust hoch, von 250 bis 950 u/s
 *   (Raster 5 Radien × 8-u-Schritte: sauber bei 250 u/s ab 16 bis 104 u, bei 700–950 u/s ab 32 u);
 * - TAKEOFF_FAR, drei dunklere Streifen davor: erst ab 450 u/s sauber (400 u/s bis 168 u, 250 u/s nur bis 104 u).
 * Vorher lag ein ↑C-Glyph Hull-Front 32–238 u vor der Wand: seine wandferne Hälfte ließ genau die Langsamen abprallen
 * (Wiederholer nach Anprall, Neulinge ~320 u/s, Respawn an CP2; Review 29.09.). Das ↑C steht weiter an der Wand.
 */
export const TAKEOFF_NEAR: V2 = [32, 104];
export const TAKEOFF_FAR: V2 = [112, 208];
const TAKEOFF_TINT = COL.ice;
const TAKEOFF_FAR_TINT = '#3f7fa0';

function takeoffBands(L: LevelBuilder, helix: Helix, wall: number, y: number): void {
  // Frame an der Wand: u = Fahrtrichtung (senkrecht zur radialen Wand), v = radial nach außen.
  const F = Frame.at(helix.xz(wall, R_LINE), helix.yawAt(wall));
  // Quer über die Bahn, innen frei vom Kern-Pilaster (20 u), außen frei von der Bande.
  const v: V2 = [R_IN + 40 - R_LINE, R_OUT - 44 - R_LINE];
  const hw = PHYS.hullHalf;
  const band = (front: V2, tint: string, tag: string): void => {
    const [u0, u1] = [-(front[1] + hw), -(front[0] + hw)];
    L.marking(F, [[u0, v[0]], [u1, v[0]], [u1, v[1]], [u0, v[1]]], y, tint, tag);
  };
  band(TAKEOFF_NEAR, TAKEOFF_TINT, 'duckMark');
  const [a, b] = TAKEOFF_FAR;
  const n = 3;
  const w = (b - a) / (n + (n - 1) / 2); // Streifen und halb so breite Lücken
  for (let i = 0; i < n; i++) band([a + i * 1.5 * w, a + i * 1.5 * w + w], TAKEOFF_FAR_TINT, 'duckMarkFar');
}

/**
 * Warnstreifen (Bernstein, schräg) auf der Innenbahn direkt vor jedem Graben: die Innenlinie ist kürzer, aber holprig —
 * schneller nur bis ~550 u/s (W + Leertaste, level4.md "Innenbahn"); sie darf sich nicht wie eine freie Abkürzung lesen
 * (Review 29.09.). Nur Optik (mat marking, ohne Kollision). Jeder Streifen liegt
 * auf der schrägen, verwundenen Bahn: drei Ecken per Trace auf die Fläche, die vierte als Parallelogramm-Ergänzung.
 */
function trenchWarnings(L: LevelBuilder, helix: Helix, surface: BrushWorld, trenches: ReadonlyArray<readonly [number, number]>): void {
  const DEPTH: V2 = [-56, -10]; // u vor der Grabenkante
  const W = 20;
  const SLANT = 28;
  const PERIOD = 44;
  const v: V2 = [R_IN + 20 - R_E2_IN, R_SPLIT - 16 - R_E2_IN];
  const a = new Vector3();
  const b = new Vector3();
  const mins = new Vector3(-0.25, 0, -0.25);
  const maxs = new Vector3(0.25, 0.25, 0.25);
  // Nur lokal suchen (± 80 u um die Bahnhöhe): über E2 liegen weitere Etagen.
  const yAt = (x: number, z: number, y0: number): number => {
    const tr = surface.traceBox(a.set(x, y0 + 80, z), b.set(x, y0 - 80, z), mins, maxs);
    if (tr.fraction >= 1 || tr.startSolid) throw new Error(`level4: Warnstreifen ohne Boden bei ${x.toFixed(0)}, ${z.toFixed(0)}`);
    return tr.endPos.y;
  };
  for (const [ta] of trenches) {
    const F = Frame.at(helix.xz(ta, R_E2_IN), helix.yawAt(ta));
    const y0 = helix.yAt(ta);
    const at = (u: number, vv: number): Vec3Tuple => {
      const [x, z] = F.xz(u, vv);
      return [x, yAt(x, z, y0), z];
    };
    for (let v0 = v[0]; v0 + W + SLANT <= v[1] + 1e-6; v0 += PERIOD) {
      const A = at(DEPTH[0], v0);
      const B = at(DEPTH[1], v0 + SLANT);
      const D = at(DEPTH[0], v0 + W);
      // Die verwundene Bahn wölbt sich zwischen B und D bis ~0.7 u über die Sehne: die Mitte 0.35 u über die Fläche
      // heben (Validator: Mitte ± 0.5 u; die Ecken liegen dann −0.03…0.7 u darüber, Marken-LIFT 0.35 hält sie sichtbar).
      const cx = (B[0] + D[0]) / 2;
      const cz = (B[2] + D[2]) / 2;
      const lift = yAt(cx, cz, y0) + 0.35 - (B[1] + D[1]) / 2;
      const C: Vec3Tuple = [B[0] + D[0] - A[0], B[1] + D[1] - A[1], B[2] + D[2] - A[2]];
      const pts: Vec3Tuple[] = [];
      for (const p of [A, B, C, D]) pts.push([p[0], p[1] + lift, p[2]], [p[0], p[1] + lift - 4, p[2]]);
      L.add({ type: 'hull', points: pts, mat: 'marking', tint: COL.amber, collide: false, tag: 'trenchWarn' });
    }
  }
}

/**
 * Unsichtbarer Clip auf jedem Stück der Wendel-Bande: gleiche Säulen (x, z) wie das Bandenstück, von 16 u unter
 * seiner Oberkante bis `extra` darüber, innen CLIP_ROOF tiefer (Dach nach innen geneigt). Die Innenfläche liegt
 * koplanar über der Bande (keine neue Ecke), an den Stufen bleibt der achsparallele Kasten achsparallel.
 */
function boardClips(boards: readonly BrushDef[], extra: number): HullDef[] {
  const out: HullDef[] = [];
  boards.forEach((b, i) => {
    const cols: Array<[number, number, number]> = [];
    if (b.type === 'box') {
      for (const x of [b.min[0], b.max[0]]) for (const z of [b.min[2], b.max[2]]) cols.push([x, z, b.max[1]]);
    } else if (b.type === 'hull') {
      for (const [x, y, z] of b.points) {
        const c = cols.find((q) => Math.abs(q[0] - x) < 1e-3 && Math.abs(q[1] - z) < 1e-3);
        if (c) c[2] = Math.max(c[2], y);
        else cols.push([x, z, y]);
      }
    } else throw new Error(`level4: Bandenstück ${b.tag ?? i} ist ${b.type}`);
    const rad = cols.map(([x, z]) => Math.hypot(x - CENTER[0], z - CENTER[1]));
    const mid = (Math.min(...rad) + Math.max(...rad)) / 2;
    const roof = Math.min(CLIP_ROOF, extra);
    const pts: Vec3Tuple[] = [];
    cols.forEach(([x, z, top], k) => pts.push([x, top - 16, z], [x, top + extra - (rad[k] < mid ? roof : 0), z]));
    out.push({ type: 'hull', points: pts, mat: 'wall', visible: false, tag: `clip#${i}` });
  });
  return out;
}

/** Clip längs eines geraden Stücks (Steg, Krone) im Frame f: Boden bis clipH, Dach nach innen (vIn) geneigt. */
function straightClip(f: Frame, u: V2, vIn: number, vOut: number, floorAt: (u: number) => number, clipH: number, tag: string): HullDef {
  const pts: Vec3Tuple[] = [];
  // Mess-Varianten bis BOARD_H: flach wie die alte 80-u-Wand.
  const roofIn = Math.max(0, Math.min(CLIP_ROOF, clipH - BOARD_H));
  for (const uu of u) {
    const y = floorAt(uu);
    for (const [v, roof] of [[vIn, roofIn], [vOut, 0]] as const) {
      const [x, z] = f.xz(uu, v);
      pts.push([x, y - THICK, z], [x, y + clipH - roof, z]);
    }
  }
  return { type: 'hull', points: pts, mat: 'wall', visible: false, tag };
}

const KILL_DEPTH = 300;

/**
 * Kill-Zone, die keiner Wendel-Etage zu nahe kommt: die Hüllbox eines schrägen Ring-Stücks ragt unter Bahnen (die
 * eigene liegt darüber, die Umdrehung darunter ≥ 790 u tiefer). Pro Etage belegt sind Platte (128 u) + 16 u darunter
 * bis 229 u darüber (Crouch-Jump: Füße +75, geduckte Hull 54, + 100 u Luft).
 */
function safeKill(L: LevelBuilder, helix: Helix, min: V3, max: V3, tag: string): void {
  for (let t = 0; t <= 540; t += 1) {
    for (let r = R_IN; r <= R_OUT; r += 32) {
      const [x, z] = helix.xz(t, r);
      if (x < min[0] || x > max[0] || z < min[2] || z > max[2]) continue;
      for (const y of [helix.yAt(t), helix.yAt(t, true)]) {
        if (y - THICK - 16 < max[1] && y + 229 > min[1]) throw new Error(`level4: Kill-Zone ${tag} (y ${min[1].toFixed(0)}…${max[1].toFixed(0)}) trifft die Wendel bei θ ${t}, r ${r} (y ${y.toFixed(0)})`);
      }
    }
  }
  L.killZone(min, max, tag);
}

/**
 * Kill-Ring außen um die Wendel: Stücke à 15° (≤ 512 u Bogen), KILL_OUT außerhalb der Bande, Oberkante KILL_BELOW
 * unter der tiefsten Bahn des Stücks. Rückfallebene — mit Clip kommt niemand hinaus (Probe bandeEscape). Gemessen an
 * der Variante ohne Clip (clipH 80): Tod ≈ 1 s nach dem Austritt (Median 1.0, p90 1.3 s) statt 2.9 s freiem Fall.
 */
function killRing(L: LevelBuilder, helix: Helix): void {
  const DT = 15;
  const r0 = R_OUT + KILL_OUT;
  const r1 = r0 + 640;
  for (let ta = 0; ta < 540 - 1e-6; ta += DT) {
    const tb = Math.min(540, ta + DT);
    let yMin = Infinity;
    const xs: number[] = [];
    const zs: number[] = [];
    for (let t = ta; t <= tb + 1e-6; t += 0.5) {
      yMin = Math.min(yMin, helix.yAt(t), helix.yAt(t, true));
      for (const r of [r0, r1]) {
        const [x, z] = helix.xz(t, r);
        xs.push(x);
        zs.push(z);
      }
    }
    const top = yMin - KILL_BELOW;
    safeKill(L, helix, [Math.min(...xs), top - KILL_DEPTH, Math.min(...zs)], [Math.max(...xs), top, Math.max(...zs)], `kill-ring.${ta}`);
  }
}

/**
 * Was Mess-Skripte über das zuletzt gebaute Level wissen müssen (Knoten-Indizes, Surf-Kette, Ziel) — die
 * Proben selbst lesen nur level4Layout(), damit sie auch gegen ein geladenes JSON messen.
 */
export interface Level4Info {
  readonly layout: Level4Layout;
  readonly crouchNodes: readonly number[];
  readonly trenchJumpNodes: readonly number[];
  readonly surfNodes: readonly number[];
  readonly kroneTop: number;
  readonly chain: readonly SurfRamp[];
  readonly finTop: number;
  readonly finLip: number;
  readonly launchMin: number;
  /** Flugrichtung des Launchs (yaw, Grad; die Probe misst finaleReserve entlang 90° = Westen). */
  readonly launchYaw: number;
}

let lastInfo: Level4Info | null = null;
export function level4Info(): Level4Info {
  if (!lastInfo) throw new Error('level4Info: erst buildLevel4()');
  return lastInfo;
}

export function buildLevel4(o: Level4Options = {}): LevelFile {
  const lay = level4Layout(o);
  const L = new LevelBuilder({
    id: 'level4',
    name: '04 TURM',
    subtitle: 'Tempo ist Höhe.',
    parTime: 60,
    killY: -2600,
    // G statt F: L3 BRANDUNG ist in F (root liest heute niemand, Plan 007 §1 — Daten für später).
    music: { root: 'G', bpm: 132 },
    environment: {
      // Funkturm bei Nacht: tintenblauer Himmel, stahlblauer Dunst am Horizont, von unten warmes
      // Natriumlicht der Stadt; Trims in Flugwarn-Rot, Zweitfarbe Eisblau.
      skyTop: '#050814',
      skyHorizon: '#2a4a7a',
      skyBottom: '#1a0f1f',
      fogColor: '#1c2640',
      fogNear: 1800,
      fogFar: 8200,
      sunDir: [-0.35, 0.6, -0.5],
      sunColor: '#cfe0ff',
      ambientSky: '#5a70b8',
      // Natriumlicht der Stadt von unten, gegenüber dem Prototyp (#7a3a20) angehoben: Unterseiten lesen sich.
      ambientGround: o.ambientGround ?? '#94462a',
      trimColor: COL.red,
      trimColorAlt: COL.ice,
      voidY: -3000,
    },
  });
  const { helix, crouchWalls, e1, e2, e3, e4, yE4, coreTop } = lay;
  const surface = ringSurface(helix, o.rings ?? RINGS);
  L.add(...surface, ...helix.boards);
  const clipH = o.clipH ?? CLIP_H;
  if (clipH > BOARD_H) L.add(...boardClips(helix.boards, clipH - BOARD_H));
  // Natriumgelb statt Trim-Farben: die Linien unter der nächsten Etage dürfen nicht wie begehbare Kanten aussehen.
  const surfaceWorld = new BrushWorld(surface.map((b, i) => compileBrush(b, i)));
  if (o.underLights !== false) L.add(...undersideLights(helix, surfaceWorld, [760, 1024], o.underTint ?? COL.sodium));
  trenchWarnings(L, helix, surfaceWorld, lay.trenches);
  const y0 = 0;

  // ── Kern (Innenwand der Wendel) ─────────────────────────────────────────
  // 32-Eck: Flächenmitten genau an der Wendel-Innenkante.
  const CORE_N = 32;
  const coreR = R_IN / Math.cos(Math.PI / CORE_N);
  {
    const pts: Vec3Tuple[] = [];
    for (let k = 0; k < CORE_N; k++) {
      const a = ((k + 0.5) * 2 * Math.PI) / CORE_N;
      const x = CENTER[0] + coreR * Math.cos(a);
      const z = CENTER[1] - coreR * Math.sin(a);
      pts.push([x, -1800, z], [x, coreTop, z]);
    }
    L.add({ type: 'hull', points: pts, mat: 'wall', tint: COL.core, trim: false, tag: 'core' });
  }
  // Pilaster am Kern an beiden Crouch-Kanten: achsparallele Box 1 u vor der Kernfläche, damit auch die
  // innere Ecke (Stufe × Kern) exakte Normalen hat (32-Eck-Hülle: 0.99999…, Luft-Hänger in der Ecke).
  for (const wall of crouchWalls) {
    const yLow = helix.yAt(wall - 0.5);
    const [cx, cz] = helix.xz(wall, R_IN);
    const [dx, dz] = [Math.round(cx / R_IN), Math.round(cz / R_IN)];
    const lo: V3 = [dx !== 0 ? cx - dx * 20 : cx - 48, yLow - THICK - 24, dz !== 0 ? cz - dz * 20 : cz - 48];
    const hi: V3 = [dx !== 0 ? cx + dx * 1 : cx + 48, yLow + CROUCH_H + 240, dz !== 0 ? cz + dz * 1 : cz + 48];
    L.box([Math.min(lo[0], hi[0]), lo[1], Math.min(lo[2], hi[2])], [Math.max(lo[0], hi[0]), hi[1], Math.max(lo[2], hi[2])], { mat: 'wall', tint: COL.core, trim: false, tag: 'pilaster' });
  }

  // Absprungband auf beiden Terrassen (T6-Semantik): das ↑C an der Wand steht dort, wo es zu spät ist.
  for (const wall of crouchWalls) takeoffBands(L, helix, wall, helix.yAt(wall - 0.5));

  // ── Anlauf (y 0): Start, eine Lücke mit Auffang-Mulde, dann Wendel-Fuß ───
  const FA = new Frame(CENTER[0], CENTER[1] + R_LINE, 270); // u nach Osten, v nach Süden
  const vL: V2 = [R_IN - R_LINE, R_OUT - R_LINE];
  const START_U: V2 = [-1500, -1180];
  L.platform(FA, START_U, vL, y0, { mat: 'start', tag: 'start' });
  const spawn = FA.p(-1400, 0, y0);
  L.spawn(spawn, 270);
  {
    const [a, b] = aabbOf(FA, START_U, vL, [y0, y0 + 160]);
    L.startZone(a, b);
  }
  for (const u of [-1320, -1250]) L.chevron(FA.p(u, 0, y0), 270, { tint: '#46ff9e', arm: 72, thick: 22, tag: 'startChevron' });
  const GAP: V2 = [-760, -632];
  L.platform(FA, [START_U[1], GAP[0]], vL, y0, { tag: 'run1' });
  L.catchDip(FA, GAP, vL, y0, 40, { tag: 'catch-run' });
  L.platform(FA, [GAP[1], 0], vL, y0, { tag: 'run2' });

  // ── Steg + Krone ────────────────────────────────────────────────────────
  const FS = lay.steg.frame; // u nach Westen, v nach Norden
  const vS: V2 = [-LANE_HALF, LANE_HALF];
  const kroneTop = lay.steg.top;
  const ridgeOff = o.ridgeOff ?? RIDGE_OFF;
  // Sprungbrett quer (v, Norden positiv) relativ zur Kronen-Mitte: ganz über der Nordflanke.
  const BOARD_V: V2 = [-ridgeOff + (o.board ?? BOARD)[0], -ridgeOff + (o.board ?? BOARD)[1]];
  const stegY = lay.steg.floorAt;
  L.ramp(FS, [0, STEG_LEN], vS, yE4, kroneTop, { tag: 'steg', thick: THICK });
  L.platform(FS, [STEG_LEN, STEG_LEN + KRONE_LEN], vS, kroneTop, { mat: 'checkpoint', tag: 'krone', thick: THICK });
  const kickTan = Math.tan((KICK_DEG * Math.PI) / 180);
  L.ramp(FS, [STEG_LEN + KRONE_LEN, STEG_LEN + KRONE_LEN + KICK_LEN], BOARD_V, kroneTop, kroneTop - KICK_LEN * kickTan, { mat: 'accent', tint: COL.red, tag: 'absprung', thick: THICK });
  // Trichter: die Kronen-Westkante neben dem Sprungbrett ist zu (man läuft aufs Brett, nicht ins Leere), aber
  // schräg — wer seitlich versetzt anläuft, gleitet an der Wand aufs Brett. An den geraden Zinnen des Prototyps
  // blieb er stehen (Probe funnel: 8/8; mit Trichter 0/8, mit 8 u Schräge 5/8).
  {
    // Auf der Krone stehend (keine koplanaren Flächen mit ihr); die Schräge endet genau am Brettrand, wo die
    // Bande des Keils beginnt — deren Stirn darf nicht frei in der Fahrlinie liegen (Surfer bleiben daran hängen).
    const uEnd = STEG_LEN + KRONE_LEN;
    const u0 = uEnd - (o.funnelLen ?? FUNNEL_LEN);
    const hi = kroneTop + BOARD_H + 16;
    for (const [edge, board] of [[-LANE_HALF + 2, BOARD_V[0]], [LANE_HALF - 2, BOARD_V[1]]] as const) {
      const pts: Vec3Tuple[] = [];
      for (const [u, v] of [[u0, edge], [uEnd, edge], [uEnd, board]] as const) {
        const [x, z] = FS.xz(u, v);
        pts.push([x, kroneTop, z], [x, hi, z]);
      }
      L.add({ type: 'hull', points: pts, mat: 'wall', tint: COL.board, tag: 'trichter' });
    }
  }
  // Bande am Absprung-Keil bis 100 u vor sein Ende (dort liegt die erste Rampe schon darunter).
  for (const side of [-1, 1]) {
    const v: V2 = side > 0 ? [BOARD_V[1], BOARD_V[1] + 32] : [BOARD_V[0] - 32, BOARD_V[0]];
    const u1 = KICK_LEN - UNDER;
    L.ramp(FS, [STEG_LEN + KRONE_LEN, STEG_LEN + KRONE_LEN + u1], v, kroneTop + BOARD_H, kroneTop + BOARD_H - u1 * kickTan, { mat: 'wall', tint: COL.board, tag: `kickBoard${side}`, thick: THICK + BOARD_H });
  }
  // Steg und Krone: statt Mauer ein unsichtbarer Clip (bis clipH, Dach nach innen) mit sichtbarem Geländer —
  // der Blick in die Tiefe bleibt frei, die Kante bleibt lesbar (Pfosten alle 96 u, Leucht-Handlauf).
  for (const side of [-1, 1]) {
    const [vIn, vOut] = side > 0 ? [LANE_HALF, LANE_HALF + 32] : [-LANE_HALF, -LANE_HALF - 32];
    const u0 = side < 0 ? 96 : 0; // Süd: erst außerhalb der Kern-Nordfläche (sonst koplanar)
    L.add(straightClip(FS, [u0, STEG_LEN], vIn, vOut, stegY, clipH, `stegBoard${side}`));
    L.add(straightClip(FS, [STEG_LEN, STEG_LEN + KRONE_LEN], vIn, vOut, stegY, clipH, `kroneBoard${side}`));
    L.railing(FS, side < 0 ? 260 : u0, STEG_LEN + KRONE_LEN, side > 0 ? LANE_HALF + 16 : -LANE_HALF - 16, stegY, { tint: COL.red });
  }

  // ── Abfahrt: Surf-Kette nach Westen ─────────────────────────────────────
  // Beginnt 100 u UNTER der Krone (Grat 24 u unter dem Keil): wer vorn abläuft, fällt auf eine Flanke,
  // nie gegen eine Stirn. Vier Rampen mit Drops (128 u, Folgerampe 96 u vor dem Ende): jeder Drop setzt
  // die Linie höher auf die nächste Flanke — auf einer 3000-u-Rampe ohne Drop rutschte der
  // Grundtechnik-Surfer mit 1400 u/s Einstieg vom Fuß (Surf-Raster 80/90).
  const endU = STEG_LEN + KRONE_LEN + KICK_LEN;
  const d1 = L.surfChain({
    start: FS.xz(endU - UNDER, -ridgeOff),
    yaw: 90,
    apex: kroneTop - (KICK_LEN - UNDER) * kickTan - 24,
    width: SURF_W,
    tag: 'abf1',
    tint: COL.ice,
    pieces: [{ length: UNDER + (o.d1 ?? 750), slopeDeg: KICK_DEG }],
  })[0];
  const d2 = L.surfDrop(d1, { overlap: DROP_OVERLAP, drop: DROP, length: 1152, slopeDeg: o.s2 ?? 10, tag: 'abf2', tint: COL.violet });
  const d3 = L.surfDrop(d2, { overlap: DROP_OVERLAP, drop: DROP, length: 1152, slopeDeg: 14, tag: 'abf3', tint: COL.ice });
  const d4 = L.surfDrop(d3, { overlap: DROP_OVERLAP, drop: DROP, length: 1024, slopeDeg: 16, tag: 'abf4', tint: COL.violet });
  const k0 = d4.o.length - DROP_OVERLAP;
  const c5 = L.surfChain({
    start: d4.frame.xz(k0),
    yaw: 90,
    apex: d4.apexAt(k0) - DROP,
    width: SURF_W,
    tag: 'abf5',
    pieces: [
      { length: 384, slopeDeg: 16 },
      { length: 768, slopeDeg: 25 },
      { length: 256, slopeDeg: 12 },
      { length: 256, slopeDeg: 4 },
      { length: 320, slopeDeg: -8 },
    ],
  });
  const chain = [d1, d2, d3, d4, ...c5];
  L.surfCheckpoint(5, d2, d3);

  // ── Checkpoints auf den Podesten (Trigger nur 160 u hoch: die Etage darunter liegt nicht darin) ──
  for (const p of lay.podests) {
    const pts: V2[] = [];
    for (let t = p.from; t <= p.to + 1e-6; t += 2) for (const r of [R_IN, R_OUT]) pts.push(helix.xz(t, r));
    const xs = pts.map((q) => q[0]);
    const zs = pts.map((q) => q[1]);
    const mid = (p.from + p.to) / 2;
    L.checkpoint(p.order, [Math.min(...xs), p.y, Math.min(...zs)], [Math.max(...xs), p.y + 160, Math.max(...zs)], helix.p3(mid, R_LINE, p.y), helix.yawAt(mid) % 360);
  }
  {
    const [a, b] = aabbOf(FS, [STEG_LEN, STEG_LEN + KRONE_LEN], vS, [kroneTop, kroneTop + 160]);
    // Spawn mittig vor dem Sprungbrett: wer hier startet, drückt nur W.
    L.checkpoint(4, a, b, FS.p(STEG_LEN + 100, (BOARD_V[0] + BOARD_V[1]) / 2, kroneTop), 90);
  }

  const kick = c5[c5.length - 1];
  const kickEnd = kick.frame.xz(kick.o.length);

  // ── Deko ────────────────────────────────────────────────────────────────
  // Mast auf dem Kern mit roter Krone, Flugwarnlichter am Kern-Dach und auf der Bande.
  L.tower(CENTER, 96, coreTop, 1400, { crown: COL.red });
  for (let k = 0; k < 8; k++) {
    const a = (k * 45 * Math.PI) / 180;
    const x = CENTER[0] + (R_IN - 40) * Math.cos(a);
    const z = CENTER[1] - (R_IN - 40) * Math.sin(a);
    L.decoBox([x - 20, coreTop, z - 20], [x + 20, coreTop + 40, z + 20], { mat: 'light', tint: COL.red });
  }
  for (let t = 20; t < 540; t += 40) {
    const y = helix.yAt(t);
    const [x, z] = helix.xz(t, R_OUT + 16);
    L.decoBox([x - 12, y + BOARD_H + 3, z - 12], [x + 12, y + BOARD_H + 23, z + 12], { mat: 'light', tint: t % 80 === 20 ? COL.red : COL.ice });
  }
  // Ferne Stadt: Türme aus dem Void.
  const towers: ReadonlyArray<readonly [number, number, number, number, string]> = [
    [3200, 2600, 300, 2600, COL.amber],
    [4200, -1800, 260, 3400, COL.red],
    [2400, -4200, 340, 3000, COL.ice],
    [-2600, 3400, 300, 2400, COL.amber],
    [-4200, 3000, 260, 2800, COL.red],
    [-5200, -3600, 340, 3200, COL.ice],
    [-8200, 1800, 380, 3000, COL.amber],
    [-9800, -3200, 300, 3600, COL.red],
  ];
  for (const [x, z, w, h, crown] of towers) L.tower([x, z], w, -3200, h + 2400, { crown });

  // ── Route ───────────────────────────────────────────────────────────────
  // Erst ohne Route kompilieren, dann jeden Knoten per Hull-Trace auf die Fläche legen (am Hang ruht die
  // Hull auf ihrer Bergkante, fallen.md #15). Checkpoint-Trigger sind in der Höhe begrenzt — kein
  // Schatten-Knoten-Workaround nötig (physics.resumeIndex prüft y).
  const crouchNodes: number[] = [];
  const trenchJumpNodes: number[] = [];
  const vHelix = o.vHelix ?? 400;
  L.placeNodes((rest) => {
    const onHelix = (t: number, r = R_LINE, after = false): V3 => {
      const [x, z] = helix.xz(t, r);
      return rest(x, z, helix.yAt(t, after));
    };
    const onSteg = (u: number, v = 0): V3 => {
      const [x, z] = FS.xz(u, v);
      return rest(x, z, stegY(u));
    };
    L.node(spawn, { minSpeed: 250, note: 'Start' });
    L.node(FA.p(GAP[0] - 24, 0, y0), { jump: true, minSpeed: 300, note: 'Lücke' });
    L.node(FA.p(GAP[1] + 160, 0, y0), { minSpeed: 300 });
    const STEP = 12;
    for (let t = e1[0]; t < e1[1]; t += STEP) L.node(onHelix(t), { minSpeed: 320, note: t === 0 ? 'E1 Wendel' : undefined });
    const [p1, p2, p3] = lay.podests;
    L.node(onHelix(p1.from + 4), { minSpeed: 320 });
    L.node(onHelix((p1.from + p1.to) / 2), { minSpeed: 320, note: 'CP1' });
    // E2: Route auf der Außenbahn (Pflichtweg, lückenlos); die Innenlinie ist eine Variante für Proben.
    if (!o.inner) {
      for (let q = e2[0] + STEP / 2; q < e2[1]; q += STEP) L.node(onHelix(q, R_E2_OUT), { minSpeed: vHelix, note: q === e2[0] + STEP / 2 ? 'E2 Außenbahn' : undefined });
    } else {
      let t = e2[0];
      for (const [a, b] of lay.trenches) {
        for (let q = t + STEP; q < a - STEP / 2; q += STEP) L.node(onHelix(q, R_E2_IN), { minSpeed: vHelix });
        trenchJumpNodes.push(L.route.length);
        L.node(onHelix(a - helix.dTheta(24, R_E2_IN), R_E2_IN), { jump: o.inner === 'jump', minSpeed: vHelix, note: `Graben ${trenchJumpNodes.length}` });
        const land = b + helix.dTheta(96, R_E2_IN);
        L.node(onHelix(land, R_E2_IN, true), { minSpeed: vHelix });
        t = land;
      }
      for (let q = t + STEP; q < e2[1]; q += STEP) L.node(onHelix(q, R_E2_IN), { minSpeed: vHelix });
    }
    L.node(onHelix((p2.from + p2.to) / 2), { minSpeed: 320, note: 'CP2' });
    // E3: Crouch-Knoten mitten im Absprungfenster beim Plan-Tempo (wie L1 H7), Landeknoten 72 u hinter der Kante.
    {
      const [ra, rb] = riseWindow(CROUCH_H, true);
      const vPlan = o.vCrouch ?? 360;
      let prev = e3[0];
      crouchWalls.forEach((wall, i) => {
        const start = i === 0 ? e3[0] : prev + LIP;
        for (let q = start + 8; q < wall - lay.terraces[i]; q += 8) L.node(onHelix(q), { minSpeed: 320 });
        if (o.terraceNode !== undefined) L.node(onHelix(wall - helix.dTheta(o.terraceNode, R_LINE)), { minSpeed: 320 });
        const back = o.crouchBack ?? PHYS.hullHalf + 0.5 * (ra + rb) * vPlan; // Hull-Front im Fenster an der Wand
        crouchNodes.push(L.route.length);
        L.node(onHelix(wall - helix.dTheta(back, R_LINE)), { jump: true, crouch: true, minSpeed: vPlan, note: `Kante ${i + 1}` });
        L.node(onHelix(wall + helix.dTheta(72, R_LINE), R_LINE, true), { minSpeed: 250 });
        prev = wall;
      });
    }
    L.node(onHelix((p3.from + p3.to) / 2), { minSpeed: 250, note: 'CP3' });
    for (let t = e4[0] + STEP; t < e4[1]; t += STEP) L.node(onHelix(t), { minSpeed: 320, note: t === e4[0] + STEP ? 'E4 Auslauf' : undefined });
    L.node(onHelix(e4[1] - 0.5), { minSpeed: 320 });
    for (const u of [300, 700]) L.node(onSteg(u), { minSpeed: 320, note: u === 300 ? 'Steg' : undefined });
    // Kein Knoten auf dem Sprungbrett: der Bot bremste nach dem Kronen-Hop 4 Ticks per S (745 → 436 u/s), um dort zu
    // landen (kein Surf-Knoten → Luftbremse), und alle Bots waren in der Abfahrt ~1.1 s langsamer (Review 29.09.).
    // Krone (v 0) → erster Surf-Knoten (v ≈ 3) läuft ohnehin über das Brett (v −112…128).
    L.node(onSteg(STEG_LEN + 100), { minSpeed: 320, note: 'Krone' });
  });

  // Surf-Knoten an der Nordflanke (rechts in Fahrtrichtung), LINE_DEPTH unter dem Grat. Die ersten zwei
  // flacher: bei s 340 drehte die 1°-Hand in der Luft um (Prototyp).
  const surfNodes: number[] = [];
  const surfNode = (r: SurfRamp, s: number, depth = LINE_DEPTH): void => {
    surfNodes.push(L.route.length);
    L.node(r.riderPos(s, 1, depth), { surf: true, note: r.o.tag });
  };
  surfNode(d1, UNDER + (o.n1s ?? 460), o.n1Depth ?? 200);
  surfNode(d1, UNDER + 700, 260);
  surfNode(d2, 300);
  surfNode(d2, 800);
  surfNode(d3, 300);
  surfNode(d3, 800);
  surfNode(d4, 300);
  surfNode(d4, 760);
  surfNode(c5[0], 220);
  surfNode(c5[1], 300);
  surfNode(c5[1], 720);
  const launch = kick.riderPos(kick.o.length - 8, 1, LINE_DEPTH);
  surfNodes.push(L.route.length);
  L.node(launch, { surf: true, note: 'Launch' });

  // Tempo-Band der Kette messen (aus dem Stand ab CP4/CP5: Surfer 0°/+2°, 3°-Hand; Surf-Raster). minSpeed
  // = 90 % des Langsamsten; die Ziel-Lücke hängt am unteren Band des Launchs und zieht mit jedem Tuning mit.
  let launchMin = 900;
  if (o.measure !== false) {
    const measured = measureSurfSpeeds(L.build(), [{ surfer: 0 }, { surfer: 2 }, { bot: { aimNoiseDeg: 3 } }], { grid: SURF_GRID });
    for (const i of surfNodes) {
      const v = measured[i];
      if (!Number.isFinite(v)) throw new Error(`level4: Surf-Knoten ${i} wird aus dem Stand nicht erreicht`);
      L.route[i] = { ...L.route[i], minSpeed: Math.round(0.9 * v) };
    }
    launchMin = Math.round(0.9 * measured[surfNodes[surfNodes.length - 1]]);
  }
  const lineV = -(launch[2] - kickEnd[1]); // quer, Norden positiv
  const goal = L.finishAfterLaunch(kick.end, launch, launchMin, { drop: 1000, depth: 1900, v: [lineV - 448, lineV + 448] });
  const fin = goal.fin;
  L.node(fin.on(fin.u0 + 360, 0), { minSpeed: 250, note: 'Ziel' });
  L.arch(goal.frame, fin.u0 + 560, [lineV - 420, lineV + 420], goal.top, 560, COL.red, 56, 'finishArch');

  // ── Kill-Zonen ──────────────────────────────────────────────────────────
  // Anlauf: 400 u darunter.
  {
    const [a, b] = aabbOf(FA, [START_U[0] - 400, 0], [vL[0] - 800, vL[1] + 800], [y0 - 800, y0 - 400]);
    L.killZone(a, b, 'kill-start');
  }
  // Unter Krone und Absprung (außerhalb der Wendel): wer seitlich abspringt, fällt nicht 4000 u.
  L.killZone([-(STEG_LEN + KRONE_LEN + KICK_LEN - UNDER - 8), kroneTop - 1400, FS.z - 1400], [-1180, kroneTop - 900, FS.z + 1400], 'kill-krone');
  // Neben/unter der Kette (wie L2): 32 u außerhalb des Fußes, in Stücken ≤ 512 u, nie unter der Wendel.
  L.chainKillZones(chain, {
    reach: 2400,
    bottom: -2500,
    keep: (lo, hi) => {
      const h = Math.min(hi, -1450);
      return h > lo ? [lo, h] : null;
    },
    tag: (side, r, k) => `kill-${side === 'right' ? 'n' : 's'}-${r.o.tag ?? ''}.${k}`,
  });
  // Rückfallebene für den Aufstieg (der Clip hält; gemessen in probes/level4.ts bandeEscape): Kill-Ring um die Wendel,
  // Kill-Zonen neben Steg und Krone, je KILL_BELOW unter der Bahn.
  if (o.killRing !== false) {
    killRing(L, helix);
    const U = STEG_LEN + KRONE_LEN;
    const n = Math.ceil(U / 400);
    for (let k = 0; k < n; k++) {
      const [ua, ub] = [(U * k) / n, (U * (k + 1)) / n];
      const top = stegY(ua) - KILL_BELOW;
      for (const side of [-1, 1]) {
        const near = LANE_HALF + 32 + KILL_OUT;
        const v: V2 = side > 0 ? [near, near + 480] : [-near - 480, -near];
        const [a, b] = aabbOf(FS, [ua, ub], v, [top - KILL_DEPTH, top]);
        safeKill(L, helix, a, b, `kill-steg-${side > 0 ? 'n' : 's'}.${k}`);
      }
    }
  }
  {
    const low = Math.min(goal.top, ...chain.map((r) => Math.min(r.apexAt(0), r.apexAt(r.o.length)) - r.height));
    const [a, b] = aabbOf(goal.frame, [8, fin.u0 - 8], [lineV - 448 - 200, lineV + 448 + 200], [low - 700, goal.top - 160]);
    L.killZone(a, b, 'kill-gap');
  }

  lastInfo = { layout: lay, crouchNodes, trenchJumpNodes, surfNodes, kroneTop, chain, finTop: goal.top, finLip: goal.lip, launchMin, launchYaw: kick.o.yaw };
  return { ...L.build(), prepLessons: PREP_LESSONS };
}

/**
 * Empfohlene Lektionen (Menü "Empfohlen: …"): L4 sperrt zweimal hart — K1/K2 verlangen den Crouch-Jump (W und
 * W + Leertaste stauen an K1), die Abfahrt verlangt Surfen (ohne Technik Tod in der Abfahrt).
 */
export const PREP_LESSONS: readonly string[] = ['t6', 't7', 't8'];
