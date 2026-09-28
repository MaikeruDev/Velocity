/**
 * 04 TURM — "Tempo ist Höhe."  (PROTOTYP, Entwurf Level 4; ändert keinen Projektcode)
 *
 * Ein Funkturm bei Nacht. Um den Kern (r 640) läuft eine breite Wendel (512 u,
 * Bande außen) 1,5 Umdrehungen nach oben; vier Abschnitte, jeder fragt eine
 * Kletter-Fähigkeit ab, dazwischen flache Podeste = Checkpoints:
 *
 *   E1 WENDEL   θ   0–135  Rampe 0 → 384      bergauf hüpfen + einseitig Kurven-Strafen
 *   P1          θ 135–155  384                CP1
 *   E2 GRÄBEN   θ 155–290  384 → 768          drei Gräben quer (Sprung, Auffang-Mulde)
 *   P2          θ 290–310  768                CP2
 *   E3 KANTEN   θ 310–445  768 → 1152         drei Crouch-Kanten (64 u) mit Terrasse davor
 *   P3          θ 445–465  1152               CP3
 *   E4 AUSLAUF  θ 465–540  1152 → 1344        Speed holen
 *   STEG        gerade nach Westen hinaus, 1344 → 1536 (Bande beidseitig)
 *   KRONE       1536, Sprungbrett            CP4
 *   ABFAHRT     Surf-Kette nach Westen, ~1500 u Fall, Drop mit CP5, Kicker → Ziel
 *
 * Nichts im Aufstieg tötet: innen der Kern, außen die Bande (80 u > Crouch-Jump 75),
 * Gräben mit Auffang-Mulde, Crouch-Kanten prallen auf die eigene Terrasse zurück.
 * Aufruf über build.ts-Ersatz: tools/critique/v2/level4/check.ts.
 */
import { Vector3 } from 'three';
import { compileLevel } from '../../../../src/world/level/compileLevel';
import type { LevelFile, Vec3Tuple } from '../../../../src/world/level/LevelFormat';
import { airTime, riseWindow, PHYS, RESERVE } from '../../../levels/ballistics';
import type { SurfRamp, V2, V3 } from '../../../levels/lib';
import { Frame, LevelBuilder, aabbOf, orientedBox, r3 } from '../../../levels/lib';
import { measureSurfSpeeds, SURF_GRID } from '../../../levels/physics';
import { Helix, type HelixSection } from './helix';

const env = (k: string, d: number): number => (process.env[k] !== undefined ? Number(process.env[k]) : d);

const COL = {
  red: '#ff3848',
  ice: '#8fe3ff',
  amber: '#ffb347',
  white: '#f2f6ff',
  violet: '#8a6cff',
} as const;

// ── Maße ─────────────────────────────────────────────────────────────────
export const CENTER: V2 = [0, 0];
export const R_IN = 640;
export const R_OUT = 1152;
/** Planungslinie (Route) — Mitte der Bahn. */
export const R_LINE = env('L4_RLINE', 896);
/** θ = 0 am Südpunkt, Fahrt nach Osten, Kern links (φ wie lib.Ring). */
const PHI0 = 270;
const SEG = 4;
const THICK = 128;
const BOARD_H = 80;
/** Höhe pro Abschnitt. */
const RISE = env('L4_RISE', 384);
const P_W = 20; // Podest (Grad)
const SEC = 135; // Abschnitt (Grad)
/**
 * E2 "INNENBAHN": die Bahn teilt sich bei R_SPLIT. Innen (224 u) kürzer, aber mit
 * drei Gräben [Beginn relativ zum Abschnitt (Grad), Breite (Grad)]; außen lückenlos.
 * Tiefe 72 (> PREDICT_MAX_DROP 64: der Bot hüpft nicht absichtlich hinein, fallen.md #32).
 */
const R_SPLIT = env('L4_SPLIT', 864);
const TRENCHES: ReadonlyArray<readonly [number, number]> = [
  [24, env('L4_G1', 16)],
  [62, env('L4_G2', 18)],
  [100, env('L4_G3', 20)],
];
const TRENCH_DEPTH = 72;
/** Route-Radius in E2 (Außenbahn, weit weg von der Grabenkante) und die Innenlinie der Probe. */
const R_E2_OUT = 1000;
export const R_E2_IN = 752;
/** Innenlinie als Route (Ideallinie eines guten Spielers) statt Außenbahn — für Proben. */
const INNER_ROUTE = process.env.L4_INNER === '1' || process.env.L4_INNER === '2';
/** L4_INNER=2: Innenlinie ohne Absprungknoten — der Bot entscheidet per Landevorhersage. */
const INNER_FREE = process.env.L4_INNER === '2';
/** E3: Crouch-Kanten. Eine Einheit = Rampe (Grad) + Terrasse (Grad) + Stufe 64. */
const CROUCH_H = 64;
const LIP = 3; // Lippe (mat duck) oben an jeder Kante, Grad
const E3_RAMP = 20;
const E3_TERRACE = 25;
/** Himmelssteg: Länge nach Westen, Krone dahinter. */
const STEG_LEN = env('L4_STEG', 1100);
/** Krone: flaches Podest (Checkpoint), dahinter Absprung-Keil 10° abwärts (wie L2 E1 vor S0). */
const KRONE_LEN = 200;
const KICK_LEN = 256;
const KICK_DEG = 10;
/** Die erste Abfahrt-Rampe beginnt so weit vor dem Ende des Absprung-Keils (darunter). */
const UNDER = 100;
/**
 * Grat der Abfahrt liegt so weit SÜDLICH der Kronen-Mitte (v negativ): wer geradeaus vom
 * Sprungbrett läuft, fällt auf die Nordflanke (Linie), nicht auf den begehbaren Grat
 * (dort hüpfte der perfekte Bot, tauchte steil auf die nächste Rampe: 370 u/s an CP5).
 */
const RIDGE_OFF = env('L4_OFF', 128);
/** Sprungbrett (v-Bereich relativ zur Kronen-Mitte, v = Norden): ganz über der Nordflanke. */
const BOARD_V: V2 = [-RIDGE_OFF + 32, -RIDGE_OFF + 320];
const LANE_HALF = (R_OUT - R_IN) / 2;
/** Surf-Kette. */
const SURF_W = 768;
const LINE_DEPTH = 320;
const DROP_OVERLAP = 96;
const DROP = 128;
const CP_TALL = 640;

export interface L4Info {
  readonly helix: Helix;
  readonly crouchNodes: number[];
  /** θ der Crouch-Kanten (Stirn), E2-Bereich, Gräben als [θa, θb]. */
  readonly crouchWalls: readonly number[];
  readonly e2: readonly [number, number];
  readonly trenches: ReadonlyArray<readonly [number, number]>;
  readonly trenchJumpNodes: number[];
  readonly podests: ReadonlyArray<{ readonly order: number; readonly from: number; readonly to: number; readonly y: number }>;
  readonly kroneTop: number;
  readonly chain: SurfRamp[];
  readonly finTop: number;
  readonly finLip: number;
  readonly launchMin: number;
}

let lastInfo: L4Info | null = null;
export function level4Info(): L4Info {
  if (!lastInfo) throw new Error('erst buildLevel4()');
  return lastInfo;
}

export function buildLevel4(o: { measure?: boolean } = {}): LevelFile {
  const L = new LevelBuilder({
    id: 'level4',
    name: '04 TURM',
    subtitle: 'Tempo ist Höhe.',
    parTime: 60,
    killY: -2600,
    music: { root: 'F', bpm: 132 },
    environment: {
      // Funkturm bei Nacht: tintenblauer Himmel, stahlblauer Dunst am Horizont,
      // von unten warmes Natriumlicht der Stadt; Trims in Flugwarn-Rot, Zweitfarbe Eisblau.
      skyTop: '#050814',
      skyHorizon: '#2a4a7a',
      skyBottom: '#1a0f1f',
      fogColor: '#1c2640',
      fogNear: 1800,
      fogFar: 8200,
      sunDir: [-0.35, 0.6, -0.5],
      sunColor: '#cfe0ff',
      ambientSky: '#5a70b8',
      ambientGround: '#7a3a20',
      trimColor: COL.red,
      trimColorAlt: COL.ice,
      voidY: -3000,
    },
  });

  // ── Wendel ──────────────────────────────────────────────────────────────
  const y0 = 0;
  const e1 = [0, SEC] as const;
  const p1 = [SEC, SEC + P_W] as const;
  const e2 = [p1[1], p1[1] + SEC] as const;
  const p2 = [e2[1], e2[1] + P_W] as const;
  // E3 endet genau am Ostpunkt (θ 450 = φ 0): beide Crouch-Kanten liegen auf Achsen-Richtungen.
  const e3 = [p2[1], 450] as const;
  const p3 = [e3[1], e3[1] + P_W] as const;
  const e4 = [p3[1], 540] as const;
  const yP1 = y0 + RISE;
  const yP2 = yP1 + RISE;
  const yP3 = yP2 + 5 * CROUCH_H; // 2 Rampen (+64, +128) und 2 Kanten (+64, +64)
  const yE4 = yP3 + 4 * CROUCH_H;
  const sections: HelixSection[] = [];
  sections.push({ from: e1[0], to: e1[1], y0, y1: yP1, tag: 'w1' });
  sections.push({ from: p1[0], to: p1[1], y0: yP1, y1: yP1, mat: 'checkpoint', tag: 'p1' });
  // E2: Außenbahn lückenlos (mit Bande), Innenbahn mit drei Gräben (Auffang-Mulde:
  // 72 u tief an der Absprungseite, steigt bis bündig an die Landekante — wer zu kurz
  // springt, hüpft heraus). Die Innenlinie ist ~25 % kürzer: Linienwahl wie der L2-Ring.
  const base2 = (t: number): number => yP1 + ((t - e2[0]) * RISE) / SEC;
  {
    // Außen- und Innenbahn mit denselben θ-Grenzen: gleiche Segmentierung, die
    // Stoßflächen an R_SPLIT liegen dann nie koplanar übereinander (Z-Fighting).
    const cuts: number[] = [e2[0]];
    for (const [at, w] of TRENCHES) cuts.push(e2[0] + at, e2[0] + at + w);
    cuts.push(e2[1]);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [a, b] = [cuts[i], cuts[i + 1]];
      const trench = i % 2 === 1;
      sections.push({ from: a, to: b, y0: base2(a), y1: base2(b), rIn: R_SPLIT, tag: `w2out${i}` });
      sections.push(
        trench
          ? { from: a, to: b, y0: base2(a) - TRENCH_DEPTH, y1: base2(b), rOut: R_SPLIT, noBoard: true, mat: 'metal', tag: `trench${(i + 1) / 2}` }
          : { from: a, to: b, y0: base2(a), y1: base2(b), rOut: R_SPLIT, noBoard: true, tint: '#c8d0ff', tag: `w2in${i / 2}` },
      );
    }
  }
  sections.push({ from: p2[0], to: p2[1], y0: yP2, y1: yP2, mat: 'checkpoint', tag: 'p2' });
  // E3 "KANTEN": zwei Crouch-Kanten (64 u), GENAU am Süd- (θ 360, φ 270) und Ostpunkt (θ 450, φ 0).
  // Nur dort sind Stufe, Bande-Sehne und Kern-Fläche achsparallel. An gedrehten Ecken (Stufe ×
  // Bande/Kern) hing der Spieler mit W in der Luft fest (Probe B: 151/702 Läufe, alle an Kanten).
  const crouchWalls: number[] = [360, 450];
  {
    const T1 = 25; // Terrasse vor Kante 1 (Grad)
    const T2 = 25; // Terrasse vor Kante 2
    let y = yP2;
    sections.push({ from: e3[0], to: 360 - T1, y0: y, y1: y + CROUCH_H, tag: 'w3r0' });
    y += CROUCH_H;
    sections.push({ from: 360 - T1, to: 360, y0: y, y1: y, mat: 'accent', tint: '#3a3f66', tag: 'terrace1' });
    y += CROUCH_H;
    sections.push({ from: 360, to: 360 + LIP, y0: y, y1: y, mat: 'duck', tint: COL.ice, tag: 'lip1' });
    sections.push({ from: 360 + LIP, to: 450 - T2, y0: y, y1: y + 2 * CROUCH_H, tag: 'w3r1' });
    y += 2 * CROUCH_H;
    sections.push({ from: 450 - T2, to: 450, y0: y, y1: y, mat: 'accent', tint: '#3a3f66', tag: 'terrace2' });
    y += CROUCH_H;
    if (Math.abs(y - yP3) > 1e-6) throw new Error(`E3 geht nicht auf: y ${y}/${yP3}`);
  }
  sections.push({ from: p3[0], to: p3[0] + LIP, y0: yP3, y1: yP3, mat: 'duck', tint: COL.ice, tag: 'lip2' });
  sections.push({ from: p3[0] + LIP, to: p3[1], y0: yP3, y1: yP3, mat: 'checkpoint', tag: 'p3' });
  sections.push({ from: e4[0], to: e4[1], y0: yP3, y1: yE4, tag: 'w4' });

  const helix = new Helix({
    center: CENTER,
    rIn: R_IN,
    rOut: R_OUT,
    phi0: PHI0,
    seg: SEG,
    thick: THICK,
    underTrim: process.env.L4_LOOK !== '0',
    board: { h: BOARD_H, t: 32, style: { mat: 'wall', tint: '#2b3350' } },
    ...(process.env.L4_OLD_BOARD === '1' ? {} : { boardRisers: crouchWalls }),
    sections,
  });
  helix.addTo(L);

  // ── Kern (Innenwand der Wendel) ─────────────────────────────────────────
  // 32-Eck: Innenradius = R_IN (Flächenmitten liegen genau an der Wendel-Innenkante).
  const CORE_N = 32;
  const coreR = R_IN / Math.cos(Math.PI / CORE_N);
  const coreTop = yE4 + 160;
  {
    const pts: Vec3Tuple[] = [];
    for (let k = 0; k < CORE_N; k++) {
      const a = ((k + 0.5) * 2 * Math.PI) / CORE_N;
      const x = CENTER[0] + coreR * Math.cos(a);
      const z = CENTER[1] - coreR * Math.sin(a);
      pts.push([x, -1800, z], [x, coreTop, z]);
    }
    L.add({ type: 'hull', points: pts, mat: 'wall', tint: '#262b40', trim: false, tag: 'core' });
  }

  // Pilaster am Kern an beiden Crouch-Kanten: achsparallele Box 1 u vor der Kernfläche, damit
  // auch die innere Ecke (Stufe × Kern) exakte Normalen hat (32-Eck-Hülle: 0.99999…, Luft-Hänger).
  for (const wall of crouchWalls) {
    const yLow = helix.yAt(wall - 0.5);
    const [cx, cz] = helix.xz(wall, R_IN);
    const [dx, dz] = [Math.round(cx / R_IN), Math.round(cz / R_IN)]; // Achsrichtung (±1, 0) oder (0, ±1)
    const lo: V3 = [dx !== 0 ? cx - dx * 20 : cx - 48, yLow - THICK - 24, dz !== 0 ? cz - dz * 20 : cz - 48];
    const hi: V3 = [dx !== 0 ? cx + dx * 1 : cx + 48, yLow + CROUCH_H + 240, dz !== 0 ? cz + dz * 1 : cz + 48];
    L.box([Math.min(lo[0], hi[0]), lo[1], Math.min(lo[2], hi[2])], [Math.max(lo[0], hi[0]), hi[1], Math.max(lo[2], hi[2])], { mat: 'wall', tint: '#262b40', trim: false, tag: 'pilaster' });
  }

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
  // Am Nordpunkt (θ 540) gerade nach Westen hinaus, Bande beidseitig.
  const [sx, sz] = helix.xz(540, R_LINE);
  const FS = new Frame(sx, sz, 90); // u nach Westen, v nach Norden
  const vS: V2 = [-LANE_HALF, LANE_HALF];
  const kroneTop = yE4 + (env('L4_STEG_RISE', 192));
  L.ramp(FS, [0, STEG_LEN], vS, yE4, kroneTop, { tag: 'steg', thick: THICK });
  const krone = L.platform(FS, [STEG_LEN, STEG_LEN + KRONE_LEN], vS, kroneTop, { mat: 'checkpoint', tag: 'krone', thick: THICK });
  const kickDrop = KICK_LEN * Math.tan((KICK_DEG * Math.PI) / 180);
  L.ramp(FS, [STEG_LEN + KRONE_LEN, STEG_LEN + KRONE_LEN + KICK_LEN], BOARD_V, kroneTop, kroneTop - kickDrop, { mat: 'accent', tint: COL.red, tag: 'absprung', thick: THICK });
  // Zinnen: Kronen-Westkante neben dem Sprungbrett geschlossen (80 u hoch) — man läuft aufs Brett.
  for (const v of [[-LANE_HALF + 4, BOARD_V[0] - 32], [BOARD_V[1] + 32, LANE_HALF - 4]] as const) {
    if (v[1] - v[0] < 1) continue;
    L.platform(FS, [STEG_LEN + KRONE_LEN - 32, STEG_LEN + KRONE_LEN + 16], v, kroneTop + BOARD_H + 16, { mat: 'wall', tint: '#2b3350', tag: 'zinne', thick: 64 + BOARD_H + 16 });
  }
  // Bande auch am Absprung-Keil bis 100 u vor sein Ende (dort liegt die erste Rampe schon darunter).
  for (const side of [-1, 1]) {
    const v: V2 = side > 0 ? [BOARD_V[1], BOARD_V[1] + 32] : [BOARD_V[0] - 32, BOARD_V[0]];
    const u1 = KICK_LEN - UNDER;
    L.ramp(FS, [STEG_LEN + KRONE_LEN, STEG_LEN + KRONE_LEN + u1], v, kroneTop + BOARD_H, kroneTop + BOARD_H - u1 * Math.tan((KICK_DEG * Math.PI) / 180), { mat: 'wall', tint: '#2b3350', tag: `kickBoard${side}`, thick: THICK + BOARD_H });
  }
  for (const side of [-1, 1]) {
    const v: V2 = side > 0 ? [LANE_HALF, LANE_HALF + 32] : [-LANE_HALF - 32, -LANE_HALF];
    const u0 = side < 0 ? 96 : 0; // Süd: erst außerhalb der Kern-Nordfläche (sonst koplanar)
    // Geländer statt Mauer (L4_LOOK=0: alte Mauer): die Kollision bleibt eine 80-u-Bande, aber als
    // unsichtbarer Clip; sichtbar sind Pfosten und Handlauf — der Blick in die Tiefe bleibt frei.
    const clip = process.env.L4_LOOK !== '0' ? { visible: false } : {};
    L.ramp(FS, [u0, STEG_LEN], v, yE4 + BOARD_H + (u0 / STEG_LEN) * (kroneTop - yE4), kroneTop + BOARD_H, { mat: 'wall', tint: '#2b3350', tag: `stegBoard${side}`, thick: THICK + BOARD_H, ...clip });
    L.platform(FS, [STEG_LEN, STEG_LEN + KRONE_LEN], v, kroneTop + BOARD_H, { mat: 'wall', tint: '#2b3350', tag: `kroneBoard${side}`, thick: THICK + BOARD_H, ...clip });
    if (process.env.L4_LOOK !== '0') railing(L, FS, side < 0 ? 260 : u0, STEG_LEN + KRONE_LEN, side > 0 ? LANE_HALF + 16 : -LANE_HALF - 16, (u) => (u <= STEG_LEN ? yE4 + (u / STEG_LEN) * (kroneTop - yE4) : kroneTop));
  }

  // ── Abfahrt: Surf-Kette nach Westen ─────────────────────────────────────
  // Beginnt 100 u UNTER der Krone (Grat 24 u unter ihrer Oberseite): wer vorn
  // abläuft, fällt auf eine Flanke, nie gegen eine Stirn (wie L2 E1 → S0).
  // Vier Rampen mit Drops (128 u, Folgerampe beginnt 96 u vor dem Ende): jeder Drop setzt
  // die Linie höher auf die nächste Flanke — auf einer 3000-u-Rampe ohne Drop rutschte der
  // Grundtechnik-Surfer mit 1400 u/s Einstieg vom Fuß (Surf-Raster 80/90).
  const endU = STEG_LEN + KRONE_LEN + KICK_LEN;
  const d1 = L.surfChain({
    start: FS.xz(endU - UNDER, -RIDGE_OFF),
    yaw: 90,
    // Grat 24 u unter dem Absprung-Keil, parallel zu ihm (10°), unter seinen letzten 100 u.
    apex: kroneTop - (KICK_LEN - UNDER) * Math.tan((KICK_DEG * Math.PI) / 180) - 24,
    width: SURF_W,
    tag: 'abf1',
    tint: COL.ice,
    pieces: [{ length: UNDER + env('L4_D1', 750), slopeDeg: KICK_DEG }],
  })[0];
  const d2 = L.surfDrop(d1, { overlap: DROP_OVERLAP, drop: DROP, length: env('L4_D2', 1152), slopeDeg: env('L4_S2', 10), tag: 'abf2', tint: COL.violet });
  const d3 = L.surfDrop(d2, { overlap: DROP_OVERLAP, drop: DROP, length: env('L4_D3', 1152), slopeDeg: env('L4_S3', 14), tag: 'abf3', tint: COL.ice });
  const d4 = L.surfDrop(d3, { overlap: DROP_OVERLAP, drop: DROP, length: env('L4_D4', 1024), slopeDeg: env('L4_S4', 16), tag: 'abf4', tint: COL.violet });
  const k0 = d4.o.length - DROP_OVERLAP;
  const c3 = L.surfChain({
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
  const chain = [d1, d2, d3, d4, ...c3];
  surfCheckpoint(L, 5, d2, d3);


  // Route bis hierher (Knoten danach werden an Hand der Welt gesetzt).
  const podests = [
    { order: 1, from: p1[0], to: p1[1], y: yP1 },
    { order: 2, from: p2[0], to: p2[1], y: yP2 },
    { order: 3, from: p3[0] + LIP, to: p3[1], y: yP3 },
  ];
  for (const p of podests) {
    const pts: V2[] = [];
    for (let t = p.from; t <= p.to + 1e-6; t += 2) for (const r of [R_IN, R_OUT]) pts.push(helix.xz(t, r));
    const xs = pts.map((q) => q[0]);
    const zs = pts.map((q) => q[1]);
    const mid = (p.from + p.to) / 2;
    L.checkpoint(p.order, [Math.min(...xs), p.y, Math.min(...zs)], [Math.max(...xs), p.y + 160, Math.max(...zs)], helix.p3(mid, R_LINE, p.y), helix.yawAt(mid) % 360);
  }
  {
    const [a, b] = aabbOf(FS, [STEG_LEN, STEG_LEN + KRONE_LEN], vS, [kroneTop, kroneTop + 160]);
    L.checkpoint(4, a, b, FS.p(STEG_LEN + 100, 0, kroneTop), 90);
  }

  // ── Ziel (Lücke aus dem gemessenen Launch-Tempo, wie L2) ────────────────
  const kick = c3[c3.length - 1];
  const kickEnd = kick.frame.xz(kick.o.length);
  const kickApexEnd = kick.apexAt(kick.o.length);
  const finTop = Math.round(kickApexEnd - 1000);

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
    const s = sections.find((q) => t >= q.from && t < q.to);
    if (!s) continue;
    const y = helix.yAt(t);
    const [x, z] = helix.xz(t, R_OUT + 16);
    L.decoBox([x - 12, y + BOARD_H + 3, z - 12], [x + 12, y + BOARD_H + 23, z + 12], { mat: 'light', tint: t % 80 === 20 ? COL.red : COL.ice });
  }
  // Ferne Stadt: Türme aus dem Void.
  const towers: Array<[number, number, number, number, string]> = [
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
  // Erst ohne Route kompilieren, dann jeden Knoten per Hull-Trace auf die Fläche legen
  // (am Hang ruht die Hull auf ihrer Bergkante, fallen.md #15).
  const probe = compileLevel(L.build());
  const STAND_MIN = new Vector3(-PHYS.hullHalf, 0, -PHYS.hullHalf);
  const STAND_MAX = new Vector3(PHYS.hullHalf, PHYS.standHeight, PHYS.hullHalf);
  const rest = (x: number, z: number, yHint: number): V3 => {
    const tr = probe.world.traceBox(new Vector3(x, yHint + 90, z), new Vector3(x, yHint - 200, z), STAND_MIN, STAND_MAX);
    if (tr.startSolid || tr.fraction >= 1) throw new Error(`level4: kein Boden bei ${x.toFixed(0)}, ${z.toFixed(0)} (y ~${yHint.toFixed(0)})`);
    return [x, r3(tr.endPos.y + 0.05), z];
  };
  const onHelix = (t: number, r = R_LINE, after = false): V3 => {
    const [x, z] = helix.xz(t, r);
    return rest(x, z, helix.yAt(t, after));
  };

  // Tempo-Plan: gemessen aus dem ersten Prototyp-Lauf (3°-Hand hält auf der Wendel 430–520 u/s).
  const V_HELIX = env('L4_VPLAN', 400);
  L.node(spawn, { minSpeed: 250, note: 'Start' });
  L.node(FA.p(GAP[0] - 24, 0, y0), { jump: true, minSpeed: 300, note: 'Lücke' });
  L.node(FA.p(GAP[1] + 160, 0, y0), { minSpeed: 300 });
  const STEP = 12;
  for (let t = 0; t < e1[1]; t += STEP) L.node(onHelix(t), { minSpeed: 320, note: t === 0 ? 'E1 Wendel' : undefined });
  L.node(onHelix(p1[0] + 4), { minSpeed: 320 });
  L.node(onHelix((p1[0] + p1[1]) / 2), { minSpeed: 320, note: 'CP1' });
  // E2: Route auf der Außenbahn (Pflichtweg, lückenlos). Mit L4_INNER=1 die Innenlinie
  // mit Absprungknoten vor jedem Graben (Probe "Innenbahn lohnt sich?").
  const trenchJumpNodes: number[] = [];
  if (!INNER_ROUTE) {
    for (let q = e2[0] + STEP / 2; q < e2[1]; q += STEP) L.node(onHelix(q, R_E2_OUT), { minSpeed: V_HELIX, note: q === e2[0] + STEP / 2 ? 'E2 Außenbahn' : undefined });
  } else {
    let t = e2[0];
    for (const [at, w] of TRENCHES) {
      const a = e2[0] + at;
      for (let q = t + STEP; q < a - STEP / 2; q += STEP) L.node(onHelix(q, R_E2_IN), { minSpeed: V_HELIX });
      const lead = helix.dTheta(24, R_E2_IN);
      trenchJumpNodes.push(L.route.length);
      L.node(onHelix(a - lead, R_E2_IN), { jump: !INNER_FREE, minSpeed: V_HELIX, note: `Graben ${trenchJumpNodes.length}` });
      L.node(onHelix(a + w + helix.dTheta(96, R_E2_IN), R_E2_IN, true), { minSpeed: V_HELIX });
      t = a + w + helix.dTheta(96, R_E2_IN);
    }
    for (let q = t + STEP; q < e2[1]; q += STEP) L.node(onHelix(q, R_E2_IN), { minSpeed: V_HELIX });
  }
  L.node(onHelix((p2[0] + p2[1]) / 2), { minSpeed: 320, note: 'CP2' });
  // E3: Crouch-Knoten mitten im Absprungfenster beim Plan-Tempo (wie L1 H7).
  const crouchNodes: number[] = [];
  {
    const [ra, rb] = riseWindow(CROUCH_H, true);
    let prevWall = e3[0];
    crouchWalls.forEach((wall, i) => {
      const start = i === 0 ? e3[0] : prevWall + LIP;
      for (let q = start + 8; q < wall - E3_TERRACE; q += 8) L.node(onHelix(q), { minSpeed: 320 });
      const vPlan = 360;
      const back = PHYS.hullHalf + 0.5 * (ra + rb) * vPlan; // Hull-Front im Fenster an der Wand
      crouchNodes.push(L.route.length);
      L.node(onHelix(wall - helix.dTheta(back, R_LINE)), { jump: true, crouch: true, minSpeed: vPlan, note: `Kante ${i + 1}` });
      L.node(onHelix(wall + helix.dTheta(72, R_LINE), R_LINE, true), { minSpeed: 250 });
      prevWall = wall;
    });
  }
  L.node(onHelix((p3[0] + LIP + p3[1]) / 2), { minSpeed: 250, note: 'CP3' });
  for (let t = e4[0] + STEP; t < 540; t += STEP) L.node(onHelix(t), { minSpeed: 320, note: t === e4[0] + STEP ? 'E4 Auslauf' : undefined });
  L.node(onHelix(540 - 0.5), { minSpeed: 320 });
  for (const u of [300, 700]) L.node(rest(...xzPair(FS.xz(u)), yE4 + (u / STEG_LEN) * (kroneTop - yE4)), { minSpeed: 320, note: u === 300 ? 'Steg' : undefined });
  L.node(rest(...xzPair(FS.xz(STEG_LEN + 100)), kroneTop), { minSpeed: 320, note: 'Krone' });
  L.node(rest(...xzPair(FS.xz(STEG_LEN + KRONE_LEN + 128, (BOARD_V[0] + BOARD_V[1]) / 2)), kroneTop - 22), { minSpeed: 320, note: 'Absprung' });
  dropShadowNodes(L);
  // Surf-Knoten an der Nordflanke (rechts in Fahrtrichtung), LINE_DEPTH unter dem Grat.
  const surfNodes: number[] = [];
  const surfNode = (r: SurfRamp, s: number, depth = LINE_DEPTH): void => {
    surfNodes.push(L.route.length);
    L.node(r.riderPos(s, 1, depth), { surf: true, note: r.o.tag });
  };
  surfNode(d1, UNDER + env('L4_N1S', 460), env('L4_N1', 200));
  surfNode(d1, UNDER + 700, 260);
  surfNode(d2, 300);
  surfNode(d2, 800);
  surfNode(d3, 300);
  surfNode(d3, 800);
  surfNode(d4, 300);
  surfNode(d4, 760);
  surfNode(c3[0], 220);
  surfNode(c3[1], 300);
  surfNode(c3[1], 720);
  const launch = kick.riderPos(kick.o.length - 8, 1, LINE_DEPTH);
  surfNodes.push(L.route.length);
  L.node(launch, { surf: true, note: 'Launch' });

  // Tempo-Band der Kette messen (aus dem Stand ab CP4/CP5, Surfer 0°/+2°, 3°-Hand; Surf-Raster).
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
  const FK = new Frame(kickEnd[0], kickEnd[1], 90);
  const lineV = -(launch[2] - kickEnd[1]); // v nach Norden
  const launchTime = airTime(launch[1] - finTop, false, 0);
  const FIN_LIP = Math.floor(((launchMin * launchTime) / RESERVE + 8) / 16) * 16;
  const FIN_DEPTH = 1900;
  const fin = L.platform(FK, [FIN_LIP, FIN_LIP + FIN_DEPTH], [lineV - 448, lineV + 448], finTop, { tag: 'finish', mat: 'finish', thick: 128 });
  {
    const [a, b] = aabbOf(FK, [fin.u0, fin.u1], [lineV - 448, lineV + 448], [finTop, finTop + 900]);
    L.finishZone(a, b);
  }
  L.platform(FK, [fin.u1, fin.u1 + 64], [lineV - 448, lineV + 448], finTop + 900, { tag: 'backstop', mat: 'wall', thick: 1028, trim: false });
  L.node(fin.on(fin.u0 + 360, 0), { minSpeed: 250, note: 'Ziel' });
  L.arch(FK, fin.u0 + 560, [lineV - 420, lineV + 420], finTop, 560, COL.red, 56, 'finishArch');

  // ── Kill-Zonen ──────────────────────────────────────────────────────────
  // Anlauf: 400 u darunter.
  {
    const [a, b] = aabbOf(FA, [START_U[0] - 400, 0], [vL[0] - 800, vL[1] + 800], [y0 - 800, y0 - 400]);
    L.killZone(a, b, 'kill-start');
  }
  // Unter Krone und Absprung (außerhalb der Wendel): wer seitlich abspringt, fällt nicht 4000 u.
  L.killZone([-(STEG_LEN + KRONE_LEN + KICK_LEN - UNDER - 8), kroneTop - 1400, zLineOf(FS) - 1400], [-1180, kroneTop - 900, zLineOf(FS) + 1400], 'kill-krone');
  // Neben/unter der Kette (wie L2): 32 u außerhalb des Fußes, in Stücken ≤ 512 u.
  const W = 2400;
  const zLine = FS.z + RIDGE_OFF; // Achse der Kette (v = −RIDGE_OFF, v zeigt nach Norden = −z)
  const north = zLine - SURF_W / 2 - 32;
  const south = zLine + SURF_W / 2 + 32;
  for (const r of chain) {
    const n = Math.ceil(r.o.length / 512);
    for (let k = 0; k < n; k++) {
      const sa = (r.o.length * k) / n;
      const sb = (r.o.length * (k + 1)) / n;
      const top = Math.min(r.apexAt(sa), r.apexAt(sb)) - r.height - 64;
      const xa = r.frame.xz(sa)[0];
      const xb = r.frame.xz(sb)[0];
      // Unter dem Steg/Kern-Bereich (x > −1400) liegt die Wendel — dort keine Zone.
      const x0 = Math.min(xa, xb);
      const x1 = Math.min(Math.max(xa, xb), -1450);
      if (x1 <= x0) continue;
      L.killZone([x0, -2500, zLine - W], [x1, top, north], `kill-n-${r.o.tag}.${k}`);
      L.killZone([x0, -2500, south], [x1, top, zLine + W], `kill-s-${r.o.tag}.${k}`);
    }
  }
  {
    const low = Math.min(finTop, ...chain.map((r) => Math.min(r.apexAt(0), r.apexAt(r.o.length)) - r.height));
    const [a, b] = aabbOf(FK, [8, fin.u0 - 8], [lineV - 448 - 200, lineV + 448 + 200], [low - 700, finTop - 160]);
    L.killZone(a, b, 'kill-gap');
  }

  lastInfo = { helix, crouchWalls, e2: [e2[0], e2[1]], trenches: TRENCHES.map(([at, w]) => [e2[0] + at, e2[0] + at + w] as const), crouchNodes, trenchJumpNodes, podests, kroneTop, chain, finTop, finLip: FIN_LIP, launchMin };
  void krone;
  void orientedBox;
  return L.build();
}

function xzPair(p: V2): [number, number] {
  return [p[0], p[1]];
}

/** Checkpoint am Drop a → b (wie L2 surfCheckpoint, Achse nach Westen). */
function surfCheckpoint(L: LevelBuilder, order: number, a: SurfRamp, b: SurfRamp): void {
  const fb = new Frame(b.frame.x, b.frame.z, 90);
  const PAD_RISE = 40;
  const s0 = DROP_OVERLAP;
  const s1 = s0 + 96;
  const s2 = s1 + 128;
  const base = b.apexAt(s0);
  const padTop = r3(base + PAD_RISE);
  const pts: Array<readonly [number, number, number]> = [];
  for (const vv of [-24, 72]) pts.push(fb.p(s0, vv, base), fb.p(s1, vv, padTop), fb.p(s2, vv, padTop), fb.p(s2, vv, base));
  L.add({ type: 'hull', points: pts, mat: 'checkpoint', tag: `cp${order}pad` });
  const sp = fb.p(s1 + 64, 24, padTop);
  const fa = new Frame(a.frame.x, a.frame.z, 90);
  const sEnd = a.o.length;
  const uN = sEnd + 360;
  const footN = b.apexAt(uN - (sEnd - DROP_OVERLAP)) - b.height;
  const [lo, hi] = aabbOf(fa, [sEnd - 420, uN], [-SURF_W / 2, SURF_W / 2], [footN + 40, padTop + CP_TALL / 2]);
  L.checkpoint(order, lo, hi, sp, 90);
}

/**
 * WORKAROUND für physics.resumeIndex (prüft Checkpoint-Trigger nur in x/z): in einer
 * Wendel liegt unter jedem Podest die Bahn der vorigen Umdrehung. Knoten VOR dem
 * ersten echten (3D-)Treffer eines Checkpoints, die nur in x/z im Trigger liegen,
 * würden als Wiedereinstieg gewählt — der Bot fährt dann die untere Umdrehung ab.
 * Gehört als y-Prüfung in resumeIndex (Entwurf: "Was an lib/physics fehlt").
 */
function dropShadowNodes(L: LevelBuilder): void {
  const cps = L.triggers.filter((t) => t.kind === 'checkpoint');
  for (const t of cps) {
    const inXZ = (p: readonly number[]): boolean => p[0] >= t.min[0] - 1 && p[0] <= t.max[0] + 1 && p[2] >= t.min[2] - 1 && p[2] <= t.max[2] + 1;
    const in3D = (p: readonly number[]): boolean => inXZ(p) && p[1] >= t.min[1] - 8 && p[1] <= t.max[1];
    const first = L.route.findIndex((n) => in3D(n.pos));
    if (first < 0) continue; // Surf-Checkpoints: Knoten kommen später
    for (let i = first - 1; i >= 0; i--) {
      const n = L.route[i];
      if (!inXZ(n.pos)) continue;
      if (n.jump || n.crouch || n.surf || n.air) throw new Error(`Checkpoint ${t.order}: Schatten-Knoten ${i} ist ein Absprung-/Surf-Knoten`);
      L.route.splice(i, 1);
    }
  }
}

function zLineOf(f: Frame): number {
  return f.z;
}

/** Geländer (nur Optik): Pfosten alle 96 u und ein Handlauf 64–76 u über dem Boden, entlang u bei v. */
function railing(L: LevelBuilder, f: Frame, u0: number, u1: number, v: number, floorAt: (u: number) => number): void {
  for (let u = u0 + 24; u < u1; u += 96) {
    const y = floorAt(u);
    L.add({ ...orientedBox(f, [u - 6, u + 6], [v - 6, v + 6], [y, y + 76], { mat: 'dark', collide: false, tag: 'rail-post' }), trim: false });
  }
  // Handlauf in Stücken (folgt der Steigung stückweise), leuchtend in der Trim-Farbe.
  for (let u = u0; u < u1; u += 128) {
    const ua = u;
    const ub = Math.min(u1, u + 128);
    const ya = floorAt(ua);
    const yb = floorAt(ub);
    L.add({ ...orientedWedgeRail(f, [ua, ub], [v - 5, v + 5], ya + 66, yb + 66), collide: false, trim: false, tag: 'rail' });
  }
}

function orientedWedgeRail(f: Frame, u: V2, v: V2, yA: number, yB: number): import('../../../../src/world/level/LevelFormat').HullDef {
  const pts: Array<readonly [number, number, number]> = [];
  for (const [uu, yy] of [[u[0], yA], [u[1], yB]] as const) for (const vv of v) pts.push(f.p(uu, vv, yy), f.p(uu, vv, yy + 8));
  return { type: 'hull', points: pts, mat: 'light', tint: COL.red };
}
