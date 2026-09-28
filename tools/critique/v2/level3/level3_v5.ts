/**
 * PROTOTYP (verworfen als Gabel: Welle/Schanze auf einer Achse — Sprung ist in Surf langsamer, sweepWelle) — Nachfolger level3.ts (v6).
 *
 * Reine Surf-Map, nach dem Startbrett kein Pflicht-Bodenkontakt. Draufsicht (Norden oben):
 *
 *            KEHRE A (90°)   CP2   KEHRE B (90°)          alle Kurven links, Innenflanke trägt,
 *          .-~~~~~~~~~~~~~~~~◆~~~~~~~~~~~~-.             Bande (Leuchtleiste) auf dem Grat
 *         /                                 \
 *        |  CP1◆                              |  R1 (voll, 10°) → SCHANZE (−10°)
 *        |                                    ▼
 *       W1  (Halbrampe, Bande)             ~~~~~  WELLE (sicher: bergauf/bergab, man wird langsam)
 *        |                                   ◆ CP3   ÜBER DIE WELLE (schnell: Sprung, ab ~Plan-Tempo)
 *     ▣ START                                Z (voll, 10°)
 *                                            ▼  FINALE-KICKER → Flug → STRAND (Ziel)
 *
 * Kurven: Gehrungs-Kette (surfPath.ts), Innenflanke — setzt den Rampbug-Fix voraus (pmFix/).
 * Die Gabel ist eine Stufen-Gabel auf EINER Achse (wie L2-Ausfahrt): wer die Schanze mit Tempo und hoher
 * Linie verlässt, fliegt über die Welle auf Z; wer zu langsam ist, landet auf der Welle — nie tot.
 */
import type { LevelFile, RouteNode } from '../../../../src/world/level/LevelFormat';
import { airTime, RESERVE } from '../../../levels/ballistics';
import { Frame, LevelBuilder, aabbOf, r3, type V2, type V3 } from '../../../levels/lib';
import { SurfPath, dropFrom } from './surfPath';

const DEG = Math.PI / 180;

export interface L3Params {
  readonly w1: number;
  readonly slope: number;
  readonly rK: number;
  readonly slopeK: number;
  readonly kehreTail: number;
  readonly rail: number;
  /** R1 nach der Kehre und Schanze (Kicker-Stücke). */
  readonly r1: number;
  readonly schanze: ReadonlyArray<{ readonly length: number; readonly slopeDeg: number }>;
  /** Welle: so tief unter dem Schanzenende beginnt sie; Stücke (negativ = bergauf). */
  readonly welleDrop: number;
  /** Welle: bergauf (Länge, Steigung °), bergab (Länge, Gefälle °). */
  readonly welleUp: number;
  readonly welleUpDeg: number;
  readonly welleDown: number;
  readonly welleDownDeg: number;
  /** Z: Länge, Gefälle. */
  readonly z: number;
  readonly zSlope: number;
  readonly beachBelow: number;
  readonly launchLow: number;
  readonly knick: number;
  /** Linientiefe an der Schanze (schnelle Route). */
  readonly highLine: number;
}

export const DEFAULT_L3: L3Params = {
  w1: 1536,
  slope: 10,
  rK: 2000,
  slopeK: 10,
  kehreTail: 256,
  rail: 128,
  r1: 1024,
  schanze: [
    { length: 256, slopeDeg: 4 },
    { length: 320, slopeDeg: -10 },
  ],
  welleDrop: 256,
  welleUp: 512,
  welleUpDeg: 8,
  welleDown: 640,
  welleDownDeg: 14,
  z: 1792,
  zSlope: 10,
  beachBelow: 1100,
  launchLow: 700,
  knick: 3.75,
  highLine: 160,
};

/** Finale-Kicker (wie L2 S4): steil fallen, abflachen, am Ende steigen — Abflug schräg nach oben. */
export const FINALE: ReadonlyArray<{ readonly length: number; readonly slopeDeg: number }> = [
  { length: 512, slopeDeg: 10 },
  { length: 768, slopeDeg: 24 },
  { length: 256, slopeDeg: 12 },
  { length: 256, slopeDeg: 4 },
  { length: 320, slopeDeg: -8 },
];

export const COL = {
  coral: '#ff7a45',
  sand: '#ffd166',
  teal: '#35e6c8',
  foam: '#dff8ff',
  moon: '#d6fff5',
} as const;

const W = 768;
const LINE_DEPTH = 320;
const DROP = 128;
const OVERLAP = 96;
const CP_TALL = 640;

export interface L3Build {
  readonly fast: LevelFile;
  readonly safe: LevelFile;
  readonly paths: Record<string, SurfPath>;
  readonly notes: string[];
}

export function buildLevel3(p: L3Params = DEFAULT_L3): L3Build {
  const notes: string[] = [];
  const L = new LevelBuilder({
    id: 'level3',
    name: '03 BRANDUNG',
    subtitle: 'Halt die Linie.',
    parTime: 60,
    killY: -12000,
    music: { root: 'F', bpm: 132 },
    environment: {
      // Mondflut: tiefes Meer-Türkis, großer blasser Mond tief im Süden (Richtung Finale),
      // Trims Koralle / Sand (Gegenfarbe zur Welt; L1 Cyan, L2 Acid).
      skyTop: '#03141c',
      skyHorizon: '#0f5a66',
      skyBottom: '#010608',
      fogColor: '#0a3a48',
      fogNear: 1800,
      fogFar: 8000,
      sunDir: [-0.3, 0.3, 1],
      sunColor: COL.moon,
      ambientSky: '#3f8fa0',
      ambientGround: '#06222a',
      trimColor: COL.coral,
      trimColorAlt: COL.sand,
      voidY: -13000,
    },
  });
  const paths: Record<string, SurfPath> = {};
  const add = (name: string, path: SurfPath): SurfPath => {
    paths[name] = path;
    L.add(...path.brushes);
    return path;
  };
  const knickPieces = (turn: number): number => Math.max(2, Math.round(Math.abs(turn) / p.knick));

  // ── START: Startbrett links vom Grat, Blick Nord ─────────────────────────
  const S = new Frame(0, 0, 0);
  // Nur links vom Grat (die rechte Seite von W1 ist Wand); rechts in Flucht die Bande.
  L.platform(S, [-384, 32], [-256, -12], 40, { mat: 'start', tag: 'start' });
  L.platform(S, [-384, -2], [-12, 16], 40 + p.rail, { mat: 'accent', tint: COL.teal, thick: p.rail + 64, tag: 'startRail' });
  const spawn = S.p(-160, -96, 40);
  L.spawn(spawn, 0);
  {
    const [a, b] = aabbOf(S, [-384, 32], [-256, -12], [40, 200]);
    L.startZone(a, b);
  }
  for (const u of [-120, -40]) L.chevron(S.p(u, -96, 40), 0, { tint: COL.teal, arm: 64, thick: 20, tag: 'startChevron' });

  // ── W1: Halbrampe links, Bande ───────────────────────────────────────────
  const w1 = add('w1', new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: W, half: 'left', segs: [{ length: p.w1, slopeDeg: p.slope }], tag: 'w1', tint: COL.foam, rail: p.rail, railTint: COL.teal }));

  // ── KEHRE: 2 × 90° links, Drop dazwischen (Rhythmus + CP2), Innenflanke trägt, Bande oben ──
  const arcQ = (p.rK * Math.PI) / 2;
  const kehreA = add('kehreA', dropFrom(w1, {
    overlap: OVERLAP,
    drop: DROP,
    half: 'left',
    segs: [{ length: 256, slopeDeg: p.slopeK }, { length: arcQ, slopeDeg: p.slopeK, turnDeg: 90, pieces: knickPieces(90) }],
    tag: 'kehreA',
    tint: COL.foam,
    rail: p.rail,
    railTint: COL.sand,
    // Bande läuft durch (beginnt unter der von W1), Innenkante 2 u versetzt → nicht koplanar.
    railInset: 14,
  }));
  const kehreB = add('kehreB', dropFrom(kehreA, {
    overlap: OVERLAP,
    drop: DROP,
    half: 'left',
    segs: [{ length: arcQ, slopeDeg: p.slopeK, turnDeg: 90, pieces: knickPieces(90) }, { length: p.kehreTail, slopeDeg: p.slopeK }],
    tag: 'kehreB',
    tint: COL.foam,
    rail: p.rail,
    railTint: COL.sand,
    railInset: 12,
  }));
  surfPad(L, 1, w1, kehreA, -40, undefined, [-72, -16]);
  surfPad(L, 2, kehreA, kehreB, -40, undefined, [-72, -16]);

  // ── R1 + SCHANZE: volles Profil (ab hier beide Flanken frei), Kicker am Ende ──
  const r1 = add('r1', dropFrom(kehreB, { overlap: OVERLAP, drop: DROP, segs: [{ length: p.r1, slopeDeg: p.slope }, ...p.schanze], tag: 'r1', tint: COL.coral }));

  // ── WELLE (sichere Linie) und Z (Landung der schnellen, Fortsetzung der sicheren) ──
  const welle = add('welle', dropFrom(r1, { overlap: OVERLAP, drop: p.welleDrop, segs: [{ length: p.welleUp, slopeDeg: -p.welleUpDeg }, { length: p.welleDown, slopeDeg: p.welleDownDeg }], tag: 'welle', tint: COL.teal }));
  const z = add('z', dropFrom(welle, { overlap: OVERLAP, drop: DROP, segs: [{ length: p.z, slopeDeg: p.zSlope }], tag: 'z', tint: COL.foam }));
  const schanzeEnd = r1.end.apex;
  let crest = -Infinity;
  for (let s = 0; s <= welle.length; s += 16) crest = Math.max(crest, welle.apexAt(s));
  notes.push(`Schanze: Ende Grat ${schanzeEnd.toFixed(0)}; Welle ${welle.length.toFixed(0)} u, Kamm ${(schanzeEnd - crest).toFixed(0)} u unter dem Schanzenende; Z-Grat ${(schanzeEnd - z.apexAt(0)).toFixed(0)} u darunter`);
  // CP3: hoher Luft-Trigger am Übergang Welle → Z (Überflieger schneiden ihn auch), Pad auf dem Grat von Z.
  surfPad(L, 3, welle, z, -40, undefined, [-72, 72], OVERLAP, schanzeEnd + 360);

  // ── FINALE ──────────────────────────────────────────────────────────────
  const fin = add('finale', dropFrom(z, { overlap: OVERLAP, drop: DROP, segs: FINALE, tag: 'finale', tint: COL.coral }));

  // ── STRAND (Ziel) ─────────────────────────────────────────────────────
  const kick = fin.end;
  const fk = new Frame(kick.x, kick.z, kick.yaw);
  const beachTop = Math.round(kick.apex - p.beachBelow);
  const launch = fin.riderPos(fin.length - 8, -1, LINE_DEPTH);
  const tFly = airTime(launch[1] - beachTop, false, 0);
  const lip = Math.floor(((p.launchLow * tFly) / RESERVE + 8) / 16) * 16;
  const BEACH_DEPTH = 2400;
  const BEACH_W = 2048;
  const beach = L.platform(fk, [lip, lip + BEACH_DEPTH], [-BEACH_W / 2, BEACH_W / 2], beachTop, { mat: 'finish', tag: 'finish', thick: 128 });
  {
    const [a, b] = aabbOf(fk, [beach.u0, beach.u1], [-BEACH_W / 2, BEACH_W / 2], [beachTop, beachTop + 900]);
    L.finishZone(a, b);
  }
  L.platform(fk, [beach.u1, beach.u1 + 64], [-BEACH_W / 2, BEACH_W / 2], beachTop + 900, { tag: 'backstop', mat: 'wall', thick: 1028, trim: false });
  notes.push(`Strand: Oberseite ${beachTop} (${p.beachBelow} unter dem Kicker), Lücke ${lip} u bei unterem Band ${p.launchLow} u/s, Flugzeit ${tFly.toFixed(2)} s`);

  killTiles(L, notes);
  deco(L, { kehreA, r1, z, fin, fk, beachTop, beach, p });

  // ── ROUTEN ──────────────────────────────────────────────────────────────
  const nodesOn = (path: SurfPath, side: 1 | -1, step: number, from = 200, depth = LINE_DEPTH, to = path.length - 32): V3[] => {
    const out: V3[] = [];
    for (let s = from; s < to - 60; s += step) out.push(path.riderPos(s, side, depth));
    out.push(path.riderPos(to, side, depth));
    return out;
  };
  const build = (fast: boolean): LevelFile => {
    L.route.length = 0;
    L.node(spawn, { note: 'Start' });
    for (const q of nodesOn(w1, -1, 400, 300)) L.node(q, { surf: true });
    for (const q of nodesOn(kehreA, -1, 120, 200)) L.node(q, { surf: true });
    for (const q of nodesOn(kehreB, -1, 120, 200)) L.node(q, { surf: true });
    const r1Flat = p.r1;
    for (const q of nodesOn(r1, -1, 320, 240, LINE_DEPTH, r1Flat - 60)) L.node(q, { surf: true });
    // Schanze: schnell = hohe Linie, sicher = Grundlinie.
    for (const q of nodesOn(r1, -1, 200, r1Flat + 60, fast ? p.highLine : LINE_DEPTH, r1.length - 16)) L.node(q, { surf: true, note: fast ? 'Schanze hoch' : 'Schanze' });
    if (fast) {
      // Luftknoten über dem Wellenkamm, dann Z.
      let sc = 0;
      let best = -Infinity;
      for (let s = 0; s <= welle.length; s += 16) if (welle.apexAt(s) > best) [best, sc] = [welle.apexAt(s), s];
      // Querlage wie die übrigen Knoten (Linie 320): sonst kippt die Routenachse zwischen Luft- und Z-Knoten
      // um ~6° und der Grundtechnik-Surfer bremst auf der Welle (Raster r1a 53/108).
      const over = welle.riderPos(sc, -1, LINE_DEPTH);
      L.node([over[0], best + 120, over[2]], { air: true, note: 'über die Welle' });
      for (const q of nodesOn(z, -1, 320, 300)) L.node(q, { surf: true, note: 'Z' });
    } else {
      for (const q of nodesOn(welle, -1, 200, 200)) L.node(q, { surf: true, note: 'Welle' });
      for (const q of nodesOn(z, -1, 320, 200)) L.node(q, { surf: true, note: 'Z' });
    }
    for (const q of nodesOn(fin, -1, 400, 300).slice(0, -1)) L.node(q, { surf: true });
    L.node(launch, { surf: true, note: 'Launch' });
    L.node(fk.p(beach.u0 + 1400, -(LINE_DEPTH / Math.tan(60 * DEG) + 16), beachTop), { minSpeed: 250, note: 'Ziel' });
    const def = L.build();
    // LevelBuilder.build() gibt sein eigenes route-Array zurück — kopieren, sonst überschreibt die zweite Variante die erste.
    const route: RouteNode[] = [...(def.route ?? [])];
    return { ...def, route, brushes: [...def.brushes], triggers: [...def.triggers] };
  };
  return { fast: build(true), safe: build(false), paths, notes };
}

/**
 * Checkpoint am Drop a → b: Keil-Pad auf dem Grat von b (ab padS0, Querbereich padV), Spawn `spawnV` vom Grat
 * (negativ = links). Luft-Trigger um den Übergang, oben bis `topY` (Default Pad + CP_TALL/2).
 */
function surfPad(L: LevelBuilder, order: number, a: SurfPath, b: SurfPath, spawnV: number, span?: V2, padV: V2 = [-72, 72], padS0 = OVERLAP, topY?: number): { spawn: V3; top: number } {
  const PAD_RISE = 40;
  const s0 = padS0;
  const s1 = s0 + 96;
  const s2 = s1 + 128;
  const fb = b.frameAt(0);
  const base = b.apexAt(s0);
  const padTop = r3(base + PAD_RISE);
  const pts: V3[] = [];
  for (const vv of padV) pts.push(fb.p(s0, vv, base), fb.p(s1, vv, padTop), fb.p(s2, vv, padTop), fb.p(s2, vv, base));
  L.add({ type: 'hull', points: pts, mat: 'checkpoint', tag: `cp${order}pad` });
  const sp = fb.p(s1 + 64, spawnV, padTop);
  const fa = a.frameAt(a.length);
  const uN = Math.max(360, padS0 + 330);
  const footN = b.apexAt(OVERLAP + uN) - b.height;
  const half = Math.max(a.o.width, b.o.width) / 2;
  const [lo, hi] = aabbOf(fa, [-420, uN], span ?? [-half, half], [footN + 40, topY ?? padTop + CP_TALL / 2]);
  L.checkpoint(order, lo, hi, sp, fb.yaw);
  return { spawn: sp, top: padTop };
}

/** Kill-Kacheln 1024²: je 250 u unter der tiefsten Fläche in der Kachel (±64), 600 u hoch. */
function killTiles(L: LevelBuilder, notes: string[]): void {
  const T = 1024;
  const boxes = L.brushes
    .filter((b) => b.collide !== false && (b.type === 'hull' || b.type === 'box' || b.type === 'wedge'))
    .map((b) => {
      const ps: ReadonlyArray<readonly [number, number, number]> = b.type === 'hull' ? b.points : b.type === 'prism' ? [] : rotPts(b.min, b.max, b.rotY);
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      let y0 = Infinity;
      for (const [x, y, zz] of ps) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, zz);
        z1 = Math.max(z1, zz);
        y0 = Math.min(y0, y);
      }
      return { x0, x1, z0, z1, y0 };
    });
  const X0 = Math.min(...boxes.map((b) => b.x0)) - 512;
  const X1 = Math.max(...boxes.map((b) => b.x1)) + 512;
  const Z0 = Math.min(...boxes.map((b) => b.z0)) - 512;
  const Z1 = Math.max(...boxes.map((b) => b.z1)) + 512;
  let n = 0;
  for (let x = Math.floor(X0 / T) * T; x < X1; x += T) {
    for (let zz = Math.floor(Z0 / T) * T; zz < Z1; zz += T) {
      let low = Infinity;
      for (const b of boxes) if (b.x1 > x - 64 && b.x0 < x + T + 64 && b.z1 > zz - 64 && b.z0 < zz + T + 64) low = Math.min(low, b.y0);
      if (!Number.isFinite(low)) continue;
      L.killZone([x, low - 850, zz], [x + T, low - 250, zz + T], 'kill-tile');
      n++;
    }
  }
  notes.push(`Kill-Kacheln: ${n}`);
}

function rotPts(min: readonly number[], max: readonly number[], rotY?: number): Array<readonly [number, number, number]> {
  const out: Array<readonly [number, number, number]> = [];
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[2] + max[2]) / 2;
  const a = ((rotY ?? 0) * Math.PI) / 180;
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const zz of [min[2], max[2]]) {
        const dx = x - cx;
        const dz = zz - cz;
        out.push([cx + dx * Math.cos(a) + dz * Math.sin(a), y, cz - dx * Math.sin(a) + dz * Math.cos(a)]);
      }
  return out;
}

interface DecoCtx {
  readonly kehreA: SurfPath;
  readonly r1: SurfPath;
  readonly z: SurfPath;
  readonly fin: SurfPath;
  readonly fk: Frame;
  readonly beachTop: number;
  readonly beach: { readonly u0: number; readonly u1: number };
  readonly p: L3Params;
}

/** Deko: Leuchtturm in der Kehrenmitte, Tore über R1/Z/Finale, ferne Leuchttürme, Strandbojen. */
function deco(L: LevelBuilder, c: DecoCtx): void {
  const archOver = (path: SurfPath, s: number, tint: string): void => {
    const fr = path.frameAt(s);
    const base = path.footAt(s) - 200;
    L.arch(fr, 0, [-path.o.width / 2 - 96, path.o.width / 2 + 96], base, path.height + 200 + 420, tint, 48, 'surfArch');
  };
  archOver(c.r1, 500, COL.coral);
  archOver(c.z, 900, COL.teal);
  archOver(c.fin, 300, COL.coral);
  {
    const fr = c.kehreA.frameAt(256);
    const [x, zz] = fr.xz(0, -c.p.rK);
    L.tower([x, zz], 200, c.kehreA.footAt(c.kehreA.length) - 2400, 2400 + 1400, { crown: COL.sand });
  }
  const towers: Array<[number, number, number, number, string]> = [
    [4200, -4200, 320, 5200, COL.teal],
    [-9800, -2600, 360, 5600, COL.coral],
    [3600, 6400, 300, 6000, COL.sand],
    [-9200, 9800, 380, 6400, COL.coral],
    [800, 13200, 420, 6800, COL.teal],
  ];
  for (const [x, zz, w, h, crown] of towers) L.tower([x, zz], w, -12800, h + 8000, { crown });
  for (const u of [c.beach.u0 + 300, c.beach.u0 + 1100, c.beach.u0 + 1900]) {
    for (const v of [-1150, 1150]) {
      const [x, zz] = c.fk.xz(u, v);
      L.pylon([x, zz], c.beachTop - 800, 1100, u % 2 ? COL.coral : COL.sand, 22);
    }
  }
}
