/**
 * PROTOTYP (verworfen: Gabel per Gratsprung, Bots queren den Grat nicht zuverlässig) — Nachfolger level3.ts (v4).
 *
 * Reine Surf-Map, nach dem Startbrett kein Pflicht-Bodenkontakt. Draufsicht (Norden oben):
 *
 *        KEHRE K (180° links, Bande)
 *      .-~~~~~~~~-.
 *     /            \          Start (0,0), Blick Nord; W1 und K sind Halbrampen (nur linke
 *    |              |         Flanke, Bande auf dem Grat) — alle kommen links an.
 *    F  CP1         W1        F = Entscheidungsrampe (volles Profil): links bleiben (Türkis) oder
 *    |              |           über den Grat springen (Koralle).
 *   S|X (Gabel)     ▣ START   S = sichere Bahn (Halbrampe, flach, Bande, Auffang-Rinne unter dem Fuß)
 *   S|X  X: Kicker + Lücke    X = schnelle Bahn (Halbrampe, steil, ohne Bande, mit Lücke, ohne Netz)
 *   S| X                       beide fallen auf die breite Sammelrampe M → CP2 → Finale → Strand
 *    M  CP2
 *    ▼  Finale-Kicker → Flug → STRAND (Ziel)
 *
 * Kurven werden an der INNENflanke gefahren (die Rampe trägt). Voraussetzung: Rampbug-Fix
 * (pmFix/, probeCurveSweep) — ohne ihn Nahtstopps an jeder Gehrungsfuge.
 * Zwei Linien für Bots: route = schnell (Gold/VELOCITY/Autor), safeRoute = sicher (Bronze/Silber).
 */
import type { LevelFile } from '../../../../src/world/level/LevelFormat';
import { airTime, RESERVE } from '../../../levels/ballistics';
import { Frame, LevelBuilder, aabbOf, r3, type V2, type V3 } from '../../../levels/lib';
import { SurfPath, dropFrom } from './surfPath';

const DEG = Math.PI / 180;

export interface L3Params {
  readonly w1: number;
  readonly slope: number;
  /** Kehre: Radius, Gefälle. */
  readonly rK: number;
  readonly slopeK: number;
  /** Entscheidungsrampe F. */
  readonly fLen: number;
  readonly fSlope: number;
  /** Bahnen: Länge (beide gleich), Gefälle sicher / schnell. */
  readonly lane: number;
  readonly slopeSafe: number;
  readonly slopeFast: number;
  /** Lücke in der schnellen Bahn: Position (Anteil der Bahn), Kicker-Winkel, Weite, Drop. */
  readonly gapAt: number;
  readonly gapKick: number;
  readonly gap: number;
  readonly gapDrop: number;
  /** Bande (Höhe) auf Halbrampen. */
  readonly rail: number;
  /** Sammelrampe M. */
  readonly mLen: number;
  readonly mSlope: number;
  readonly beachBelow: number;
  readonly launchLow: number;
  readonly knick: number;
}

export const DEFAULT_L3: L3Params = {
  w1: 1536,
  slope: 10,
  rK: 2000,
  slopeK: 10,
  fLen: 1152,
  fSlope: 8,
  lane: 2560,
  slopeSafe: 5,
  slopeFast: 13,
  gapAt: 0.45,
  gapKick: 6,
  gap: 448,
  gapDrop: 192,
  rail: 96,
  mLen: 1024,
  mSlope: 10,
  beachBelow: 1100,
  launchLow: 700,
  knick: 3.75,
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
/** Sammelrampe: breit und flacher (50°), damit Auffang-Rinne UND beide Bahnen auf ihr landen. */
const M_W = 1536;
const M_FLANK = 50;
/** Auffang-Rinne der sicheren Bahn: so tief unter dem Fuß, so breit, Bande außen. */
const CATCH_BELOW = 32;
const CATCH_W = 256;
const CATCH_RAIL = 128;

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
  // Nur links vom Grat (die rechte Seite von W1 ist Wand): Brett bis an die Bande.
  L.platform(S, [-384, 32], [-256, -12], 40, { mat: 'start', tag: 'start' });
  // Bande am rechten Rand des Bretts, in Flucht mit der Bande von W1 (gleicher Querschnitt, stößt an ihre Kappe).
  L.platform(S, [-384, 0], [-12, 16], 40 + p.rail, { mat: 'accent', tint: COL.teal, thick: p.rail + 64, tag: 'startRail' });
  const spawn = S.p(-160, -96, 40);
  L.spawn(spawn, 0);
  {
    const [a, b] = aabbOf(S, [-384, 32], [-256, -12], [40, 200]);
    L.startZone(a, b);
  }
  for (const u of [-120, -40]) L.chevron(S.p(u, -96, 40), 0, { tint: COL.teal, arm: 64, thick: 20, tag: 'startChevron' });

  // ── W1: Halbrampe links, Bande ───────────────────────────────────────────
  const w1 = add('w1', new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: W, half: 'left', segs: [{ length: p.w1, slopeDeg: p.slope }], tag: 'w1', tint: COL.foam, rail: p.rail, railTint: COL.teal }));

  // ── KEHRE: 180° links, Innenflanke trägt, Bande oben ─────────────────────
  const arcK = p.rK * Math.PI;
  const kehre = add('kehre', dropFrom(w1, {
    overlap: OVERLAP,
    drop: DROP,
    half: 'left',
    segs: [{ length: 256, slopeDeg: p.slopeK }, { length: arcK, slopeDeg: p.slopeK, turnDeg: 180, pieces: knickPieces(180) }, { length: 256, slopeDeg: p.slopeK }],
    tag: 'kehre',
    tint: COL.foam,
    rail: p.rail,
    railTint: COL.sand,
  }));

  // ── F: Entscheidungsrampe (volles Profil, keine Bande — Gratsprung möglich) ──
  const f = add('decide', dropFrom(kehre, { overlap: OVERLAP, drop: DROP, segs: [{ length: p.fLen, slopeDeg: p.fSlope }], tag: 'decide', tint: COL.foam }));
  const cp1 = surfPad(L, 1, kehre, f, -24);
  {
    const fb = f.frameAt(0);
    L.chevron(fb.p(OVERLAP + 200, -34, cp1.top), fb.yaw + 14, { tint: COL.teal, arm: 40, thick: 14, tag: 'forkChevron' });
    L.chevron(fb.p(OVERLAP + 200, 34, cp1.top), fb.yaw - 14, { tint: COL.coral, arm: 40, thick: 14, tag: 'forkChevron' });
  }

  // ── BAHNEN: Halbrampen mit gemeinsamem Grat, verschieden steil ───────────
  const safe = add('laneSafe', dropFrom(f, { overlap: OVERLAP, drop: DROP, half: 'left', segs: [{ length: p.lane, slopeDeg: p.slopeSafe }], tag: 'laneSafe', tint: COL.teal, rail: p.rail, railTint: COL.teal }));
  // Schnelle Bahn in zwei Teilen: bis zur Lücke steil, Kicker, Lücke, Rest um gapDrop tiefer.
  const x1Len = Math.round(p.lane * p.gapAt);
  const kickLen = 256;
  const fast1 = add('laneFast1', dropFrom(f, { overlap: OVERLAP, drop: DROP, half: 'right', segs: [{ length: x1Len, slopeDeg: p.slopeFast }, { length: kickLen, slopeDeg: -p.gapKick }], tag: 'laneFast1', tint: COL.coral }));
  const x2Len = Math.round(p.lane - (x1Len + kickLen + p.gap));
  const e1 = fast1.end;
  const fe1 = new Frame(e1.x, e1.z, e1.yaw);
  const fast2 = add('laneFast2', new SurfPath({ start: fe1.xz(p.gap), yaw: e1.yaw, apex: e1.apex - p.gapDrop, width: W, half: 'right', segs: [{ length: x2Len, slopeDeg: p.slopeFast }], tag: 'laneFast2', tint: COL.coral }));
  notes.push(`Bahnen: sicher ${p.lane} u @ ${p.slopeSafe}° (Ende Grat ${safe.end.apex.toFixed(0)}), schnell ${x1Len}+${kickLen} Kicker ${p.gapKick}° + Lücke ${p.gap} (Drop ${p.gapDrop}) + ${x2Len} @ ${p.slopeFast}° (Ende Grat ${fast2.end.apex.toFixed(0)})`);
  const catchInfo = catchGutter(L, safe);

  // ── SAMMELRAMPE M: 1536 breit, 50°; unter beiden Bahn-Enden (volles Profil) ──
  // Flanke 50° unter Flanke 60°: M muss am Bahnfuß (384 u vom Grat) tiefer liegen als die Bahn —
  // (tan60 − tan50) · 384 = 207 u plus Luft.
  const mApex = Math.min(fast2.end.apex - DROP - 220, safe.end.apex - DROP - 220);
  const fm = safe.frameAt(safe.length);
  const m = add('merge', new SurfPath({ start: fm.xz(-OVERLAP), yaw: fm.yaw, apex: mApex, width: M_W, flankDeg: M_FLANK, segs: [{ length: p.mLen, slopeDeg: p.mSlope }], tag: 'merge', tint: COL.foam }));
  notes.push(`M: Grat ${mApex.toFixed(0)}; Drop sicher ${(safe.end.apex - mApex).toFixed(0)} u, schnell ${(fast2.end.apex - mApex).toFixed(0)} u; Rinne endet auf ${catchInfo.endY.toFixed(0)}, M-Flanke darunter ${(m.apexAt(OVERLAP) - (W / 2 + CATCH_W / 2) * Math.tan(M_FLANK * DEG)).toFixed(0)}`);

  // ── FINALE ──────────────────────────────────────────────────────────────
  const fin = add('finale', dropFrom(m, { overlap: OVERLAP, drop: DROP, segs: FINALE, tag: 'finale', tint: COL.coral }));
  surfPad(L, 2, m, fin, -24);

  // ── STRAND (Ziel) ─────────────────────────────────────────────────────
  const kick = fin.end;
  const fk = new Frame(kick.x, kick.z, kick.yaw);
  const beachTop = Math.round(kick.apex - p.beachBelow);
  const lineFin = LINE_DEPTH + 120;
  const launchL = fin.riderPos(fin.length - 8, -1, lineFin);
  const launchR = fin.riderPos(fin.length - 8, 1, lineFin);
  const tFly = airTime(launchL[1] - beachTop, false, 0);
  const lip = Math.floor(((p.launchLow * tFly) / RESERVE + 8) / 16) * 16;
  const BEACH_DEPTH = 2400;
  const BEACH_W = 2560;
  const beach = L.platform(fk, [lip, lip + BEACH_DEPTH], [-BEACH_W / 2, BEACH_W / 2], beachTop, { mat: 'finish', tag: 'finish', thick: 128 });
  {
    const [a, b] = aabbOf(fk, [beach.u0, beach.u1], [-BEACH_W / 2, BEACH_W / 2], [beachTop, beachTop + 900]);
    L.finishZone(a, b);
  }
  L.platform(fk, [beach.u1, beach.u1 + 64], [-BEACH_W / 2, BEACH_W / 2], beachTop + 900, { tag: 'backstop', mat: 'wall', thick: 1028, trim: false });
  notes.push(`Strand: Oberseite ${beachTop} (${p.beachBelow} unter dem Kicker), Lücke ${lip} u bei unterem Band ${p.launchLow} u/s, Flugzeit ${tFly.toFixed(2)} s`);

  killTiles(L, notes);
  deco(L, { kehre, f, fin, fk, beachTop, beach, p });

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
    for (const q of nodesOn(kehre, -1, 120, 200)) L.node(q, { surf: true });
    if (fast) {
      // Über den Grat: erst links landen, dann rechts (Gratsprung auf F).
      L.node(f.riderPos(260, -1, LINE_DEPTH), { surf: true, note: 'F links' });
      for (const q of nodesOn(f, 1, 280, 620)) L.node(q, { surf: true, note: 'F rechts' });
      for (const q of nodesOn(fast1, 1, 280, 200, LINE_DEPTH - 80, fast1.length - 16)) L.node(q, { surf: true, note: 'schnell' });
      for (const q of nodesOn(fast2, 1, 280, 160)) L.node(q, { surf: true, note: 'schnell' });
    } else {
      for (const q of nodesOn(f, -1, 300, 260)) L.node(q, { surf: true, note: 'F links' });
      for (const q of nodesOn(safe, -1, 320, 200)) L.node(q, { surf: true, note: 'sicher' });
    }
    const side: 1 | -1 = fast ? 1 : -1;
    for (const q of nodesOn(m, side, 320, 260, 420)) L.node(q, { surf: true });
    for (const q of nodesOn(fin, side, 400, 300, lineFin).slice(0, -1)) L.node(q, { surf: true });
    L.node(fast ? launchR : launchL, { surf: true, note: 'Launch' });
    L.node(fk.p(beach.u0 + 1400, side * (lineFin / Math.tan(60 * DEG) + 16), beachTop), { minSpeed: 250, note: 'Ziel' });
    const def = L.build();
    // LevelBuilder.build() gibt sein eigenes route-Array zurück — kopieren, sonst überschreibt die zweite Variante die erste.
    return { ...def, route: [...(def.route ?? [])], brushes: [...def.brushes], triggers: [...def.triggers] };
  };
  return { fast: build(true), safe: build(false), paths, notes };
}

/**
 * Checkpoint am Drop a → b: Keil-Pad auf dem Grat von b, bündig ab dem Ende von a; Spawn `spawnV`
 * vom Grat (negativ = links). Luft-Trigger um den Übergang.
 */
function surfPad(L: LevelBuilder, order: number, a: SurfPath, b: SurfPath, spawnV: number): { spawn: V3; top: number } {
  const PAD_RISE = 40;
  const s0 = OVERLAP;
  const s1 = s0 + 96;
  const s2 = s1 + 128;
  const fb = b.frameAt(0);
  const base = b.apexAt(s0);
  const padTop = r3(base + PAD_RISE);
  const v: V2 = [-72, 72];
  const pts: V3[] = [];
  for (const vv of v) pts.push(fb.p(s0, vv, base), fb.p(s1, vv, padTop), fb.p(s2, vv, padTop), fb.p(s2, vv, base));
  L.add({ type: 'hull', points: pts, mat: 'checkpoint', tag: `cp${order}pad` });
  const sp = fb.p(s1 + 64, spawnV, padTop);
  const fa = a.frameAt(a.length);
  const uN = 360;
  const footN = b.apexAt(s0 + uN) - b.height;
  const half = Math.max(a.o.width, b.o.width) / 2;
  const [lo, hi] = aabbOf(fa, [-420, uN], [-half, half], [footN + 40, padTop + CP_TALL / 2]);
  L.checkpoint(order, lo, hi, sp, fb.yaw);
  return { spawn: sp, top: padTop };
}

/**
 * Auffang-Rinne unter der sicheren Bahn (wie L1-Rutsche/L2-S0): Fläche CATCH_BELOW unter dem Fuß,
 * CATCH_W breit, Bande außen; folgt dem Gefälle und endet mit der Bahn — wer abrutscht, hüpft auf ihr
 * weiter und fällt am Ende auf die breite Sammelrampe M. Langsamer, nie tot.
 */
function catchGutter(L: LevelBuilder, lane: SurfPath): { endY: number } {
  const f = lane.frameAt(0);
  const len = lane.length;
  const y0 = lane.footAt(0) - CATCH_BELOW;
  const y1 = lane.footAt(len) - CATCH_BELOW;
  const v0 = -W / 2 - CATCH_W;
  const v1 = -W / 2 + 8;
  const pre = 96;
  const yPre = y0 + ((y0 - y1) * pre) / len;
  L.ramp(f, [-pre, len], [v0, v1], yPre, y1, { mat: 'metal', tint: COL.teal, thick: 32, tag: 'safeCatch' });
  L.ramp(f, [-pre, len], [v0 - 32, v0], yPre + CATCH_RAIL, y1 + CATCH_RAIL, { mat: 'accent', tint: COL.teal, thick: CATCH_RAIL + 32, tag: 'safeCatchRail' });
  return { endY: y1 };
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
      for (const [x, y, z] of ps) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
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
    for (let z = Math.floor(Z0 / T) * T; z < Z1; z += T) {
      let low = Infinity;
      for (const b of boxes) if (b.x1 > x - 64 && b.x0 < x + T + 64 && b.z1 > z - 64 && b.z0 < z + T + 64) low = Math.min(low, b.y0);
      if (!Number.isFinite(low)) continue;
      L.killZone([x, low - 850, z], [x + T, low - 250, z + T], 'kill-tile');
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
      for (const z of [min[2], max[2]]) {
        const dx = x - cx;
        const dz = z - cz;
        out.push([cx + dx * Math.cos(a) + dz * Math.sin(a), y, cz - dx * Math.sin(a) + dz * Math.cos(a)]);
      }
  return out;
}

interface DecoCtx {
  readonly kehre: SurfPath;
  readonly f: SurfPath;
  readonly fin: SurfPath;
  readonly fk: Frame;
  readonly beachTop: number;
  readonly beach: { readonly u0: number; readonly u1: number };
  readonly p: L3Params;
}

/** Deko: Leuchtturm in der Kehre, Brandungs-Tore über F und Finale, ferne Leuchttürme, Strandbojen. */
function deco(L: LevelBuilder, c: DecoCtx): void {
  const archOver = (path: SurfPath, s: number, tint: string): void => {
    const fr = path.frameAt(s);
    const base = path.footAt(s) - 200;
    L.arch(fr, 0, [-path.o.width / 2 - 96, path.o.width / 2 + 96], base, path.height + 200 + 420, tint, 48, 'surfArch');
  };
  archOver(c.f, 700, COL.sand);
  archOver(c.fin, 300, COL.coral);
  // Leuchtturm in der Kehrenmitte: der Blickanker, um den man 180° kreist.
  {
    const fr = c.kehre.frameAt(256);
    const [x, z] = fr.xz(0, -c.p.rK);
    L.tower([x, z], 200, c.kehre.footAt(c.kehre.length) - 2400, 2400 + 1400, { crown: COL.sand });
  }
  const towers: Array<[number, number, number, number, string]> = [
    [4200, -4200, 320, 5200, COL.teal],
    [-9800, -2600, 360, 5600, COL.coral],
    [3600, 6400, 300, 6000, COL.sand],
    [-9200, 9800, 380, 6400, COL.coral],
    [800, 13200, 420, 6800, COL.teal],
  ];
  for (const [x, z, w, h, crown] of towers) L.tower([x, z], w, -12800, h + 8000, { crown });
  for (const u of [c.beach.u0 + 300, c.beach.u0 + 1100, c.beach.u0 + 1900]) {
    for (const v of [-1400, 1400]) {
      const [x, z] = c.fk.xz(u, v);
      L.pylon([x, z], c.beachTop - 800, 1100, u % 2 ? COL.coral : COL.sand, 22);
    }
  }
}
