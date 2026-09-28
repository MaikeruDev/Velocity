/**
 * PROTOTYP — 03 BRANDUNG "Halt die Linie." (Entwurf v6, nicht im Build).
 *
 * Reine Surf-Map, nach dem Startbrett kein Pflicht-Bodenkontakt. Draufsicht (Norden oben, Maße u):
 *
 *                    KEHRE 180° links, R 2000 (Grat), 4 Viertel à 45°
 *              .-~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~-.
 *            /  KORALLE innen (links): kurz, 3 Lücken     \
 *           |   TÜRKIS außen (rechts): lang, Bande am Grat  |
 *           |   und Leitplanke am Fuß, Drops statt Lücken   |
 *        R1 ▼ CP2                                      CP1 ▲ W1 (volles Profil: Seite wählen)
 *           |                                              |
 *        Z  |                                           ▣ START
 *           ▼  FINALE-KICKER → Flug → STRAND (Ziel)
 *
 * Die Gabel ist die Kehre selbst: zwei Halbrampen Rücken an Rücken mit gemeinsamem Grat. Links (Innenflanke,
 * trägt um die Kurve) liegt die Fahrlinie ~200 u innerhalb des Grats, rechts (Außenflanke) rutscht man in die
 * Kehle an der Leitplanke ~380 u außerhalb — Weg innen ≈ (R−200)·π, außen ≈ (R+380)·π. Beide Hälften enden auf
 * gleicher Höhe und fallen Seite für Seite auf das volle Profil von R1 (Standard-Drop, keine V-Stufe).
 * Kurven: Gehrungs-Kette (surfPath.ts) — setzt den Rampbug-Fix voraus (pmFix/).
 */
import type { LevelFile, RouteNode } from '../../../../src/world/level/LevelFormat';
import { airTime, RESERVE } from '../../../levels/ballistics';
import { Frame, LevelBuilder, aabbOf, r3, type V2, type V3 } from '../../../levels/lib';
import { SurfPath, catchBand, dropFrom } from './surfPath';

const DEG = Math.PI / 180;

export interface L3Params {
  readonly w1: number;
  readonly slope: number;
  /** Kehre: Grat-Radius, Gefälle, Drop zwischen den Vierteln, leere Strecke der Lücken innen (u Bogen). */
  readonly rK: number;
  readonly slopeK: number;
  readonly dropK: number;
  readonly gap: number;
  readonly lead: number;
  readonly tail: number;
  readonly rail: number;
  /** Auffang-Band unter der Außenbahn: Breite (0 = keins). */
  readonly catchWidth: number;
  /** Höhe der Bande am Außenrand des Auffang-Bands. */
  readonly catchBank: number;
  readonly r1: number;
  readonly z: number;
  readonly beachBelow: number;
  readonly launchLow: number;
  readonly knick: number;
  /** Linientiefe der Routen: innen (schnell) und außen (sicher, zur Leitplanke). */
  readonly lineIn: number;
  /** Innenbahn: 'gaps' = volle Breite mit 3 Lücken, 'narrow' = durchgehend, aber schmal (innerWidth = Profilbreite). */
  readonly innerMode: 'gaps' | 'narrow';
  readonly innerWidth: number;
  /** Linientiefe auf R1/Z (breite 50°-Rampen). */
  readonly lineTail: number;
  readonly lineOut: number;
}

export const DEFAULT_L3: L3Params = {
  w1: 1536,
  slope: 10,
  rK: 2000,
  slopeK: 12,
  dropK: 64,
  gap: 224,
  lead: 256,
  tail: 256,
  rail: 128,
  catchWidth: 320,
  catchBank: 448,
  r1: 1536,
  z: 1536,
  beachBelow: 1100,
  launchLow: 700,
  knick: 3.75,
  lineIn: 240,
  innerMode: 'narrow',
  innerWidth: 384,
  lineTail: 200,
  lineOut: 320,
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
  const pieces = (turn: number): number => Math.max(2, Math.round(Math.abs(turn) / p.knick));

  // ── START: Startbrett mittig über dem Grat von W1, Blick Nord ─────────────
  const S = new Frame(0, 0, 0);
  L.platform(S, [-384, 32], [-224, 224], 40, { mat: 'start', tag: 'start' });
  // Spawn rechts vom Grat: geradeaus ablaufen = rechte Flanke = TÜRKIS (sicher).
  const spawn = S.p(-160, 48, 40);
  L.spawn(spawn, 0);
  {
    const [a, b] = aabbOf(S, [-384, 32], [-224, 224], [40, 200]);
    L.startZone(a, b);
  }
  L.chevron(S.p(-40, -128, 40), 12, { tint: COL.coral, arm: 64, thick: 20, tag: 'startChevron' });
  L.chevron(S.p(-40, 128, 40), -12, { tint: COL.teal, arm: 64, thick: 20, tag: 'startChevron' });

  // ── W1: volles Profil — hier wählt man die Seite (oder springt später über den Grat) ──
  const w1 = add('w1', new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: W, segs: [{ length: p.w1, slopeDeg: p.slope }], tag: 'w1', tint: COL.foam }));

  // ── KEHRE: außen (rechts) 4 Viertel mit Drops, innen (links) dieselben Viertel mit Lücken ──
  const Q = (p.rK * Math.PI) / 4;
  const outer: SurfPath[] = [];
  const inner: SurfPath[] = [];
  for (let k = 0; k < 4; k++) {
    const first = k === 0;
    const last = k === 3;
    const segs = [
      ...(first ? [{ length: p.lead, slopeDeg: p.slopeK }] : []),
      { length: Q, slopeDeg: p.slopeK, turnDeg: 45, pieces: pieces(45) },
      ...(last ? [{ length: p.tail, slopeDeg: p.slopeK }] : []),
    ];
    const prev = first ? w1 : outer[k - 1];
    const drop = first ? DROP : p.dropK;
    const o = add(`outer${k + 1}`, dropFrom(prev, {
      overlap: OVERLAP,
      drop,
      half: 'right',
      segs,
      tag: `outer${k + 1}`,
      tint: COL.teal,
      rail: p.rail,
      railTint: COL.teal,
      railInset: k % 2 ? 14 : 12,
      // Am Anfang (CP1) und in der Mitte (CP2, Viertel 3) liegt ein Pad auf dem Grat: Bande erst dahinter.
      ...(first || k === 2 ? { railRange: [360, Infinity] as const } : {}),
    }));
    outer.push(o);
    // Auffang-Band unter dem Außenfuß (die Außenflanke trägt nicht um die Kurve: wer nicht drückt, rutscht hinaus).
    if (p.catchWidth > 0) L.add(...catchBand(o, { below: 32, width: p.catchWidth, bank: p.catchBank, tint: COL.sand, tag: `outerCatch${k + 1}` }));
    // Innen: gleicher Start (Grat Rücken an Rücken), Bogen um die Lücke gekürzt — die nächste Innenhälfte
    // beginnt erst dort, wo das nächste Außenviertel beginnt (96 u vor dessen Vorgängerende).
    const cut = last || p.innerMode === 'narrow' ? 0 : OVERLAP + p.gap;
    const turnIn = (45 * (Q - cut)) / Q;
    const segsIn = [
      ...(first ? [{ length: p.lead, slopeDeg: p.slopeK }] : []),
      { length: Q - cut, slopeDeg: p.slopeK, turnDeg: turnIn, pieces: pieces(turnIn) },
      ...(last ? [{ length: p.tail, slopeDeg: p.slopeK }] : []),
    ];
    // 'narrow': durchgehend wie außen (gleiche Drops), aber schmal — der Fuß liegt nah, wer absinkt, fällt ins Kurveninnere.
    const i = add(`inner${k + 1}`, new SurfPath({ start: [o.o.start[0], o.o.start[1]], yaw: o.o.yaw, apex: o.o.apex, width: p.innerMode === 'narrow' ? p.innerWidth : W, half: 'left', segs: segsIn, tag: `inner${k + 1}`, tint: COL.coral }));
    inner.push(i);
  }
  surfPad(L, 1, w1, outer[0], 40);
  // CP2 in der Kehrenmitte (Drop Viertel 2 → 3, in beiden Bahnen): Pad auf dem gemeinsamen Grat — Innenlinie
  // (~160 links) und Außenlinie (~200 rechts) fahren daneben vorbei. Respawn rechts (Türkis), links runter = Koralle.
  surfPad(L, 2, outer[1], outer[2], 40, [-W / 2 - 32, W / 2 + p.catchWidth + 64]);
  {
    const inLen = inner.reduce((s, x) => s + x.length, 0) - p.lead - p.tail;
    notes.push(
      `Kehre: Grat R ${p.rK}, 4 × 45° à ${Q.toFixed(0)} u, ${p.slopeK}°, Drops ${p.dropK}; innen 3 Lücken à ${p.gap} u (Bogen am Grat), ` +
        `Linie innen ≈ ${((p.rK - 200) * Math.PI).toFixed(0)} u, Kehle außen ≈ ${((p.rK + W / 2) * Math.PI).toFixed(0)} u; Innen-Rampe gesamt ${inLen.toFixed(0)} u; ` +
        `Enden Grat außen ${outer[3].end.apex.toFixed(0)} / innen ${inner[3].end.apex.toFixed(0)}`,
    );
  }

  // ── R1: volles Profil unter beiden Hälften (Standard-Drop je Seite) ──────
  // R1 breit und 50° flach: fängt beide Hälften UND das Auffang-Band (bis 384 + catchWidth neben dem Grat).
  // Unter 60°-Flanken muss eine 50°-Flanke am Fuß tiefer liegen: (tan60 − tan50)·384 = 207 → Drop 256.
  const r1 = add('r1', dropFrom(outer[3], { overlap: OVERLAP, drop: 256, width: 1536, flankDeg: 50, half: 'both', segs: [{ length: p.r1, slopeDeg: p.slope }], tag: 'r1', tint: COL.foam }));
  surfPad(L, 3, outer[3], r1, -40, [-768 - 32, 768 + 32]);
  const z = add('z', dropFrom(r1, { overlap: OVERLAP, drop: DROP, segs: [{ length: p.z, slopeDeg: p.slope }], tag: 'z', tint: COL.foam }));

  // ── FINALE ──────────────────────────────────────────────────────────────
  const fin = add('finale', dropFrom(z, { overlap: OVERLAP, drop: DROP, segs: FINALE, tag: 'finale', tint: COL.coral }));

  // ── STRAND (Ziel) ─────────────────────────────────────────────────────
  const kick = fin.end;
  const fk = new Frame(kick.x, kick.z, kick.yaw);
  const beachTop = Math.round(kick.apex - p.beachBelow);
  const launchL = fin.riderPos(fin.length - 8, -1, LINE_DEPTH);
  const launchR = fin.riderPos(fin.length - 8, 1, LINE_DEPTH);
  const tFly = airTime(launchL[1] - beachTop, false, 0);
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
  deco(L, { outer, r1, z, fin, fk, beachTop, beach, p });

  // ── ROUTEN ──────────────────────────────────────────────────────────────
  const nodesOn = (path: SurfPath, side: 1 | -1, step: number, from = 200, depth = LINE_DEPTH, to = path.length - 32): V3[] => {
    const out: V3[] = [];
    for (let s = from; s < to - 60; s += step) out.push(path.riderPos(s, side, depth));
    out.push(path.riderPos(to, side, depth));
    return out;
  };
  const build = (fast: boolean): LevelFile => {
    L.route.length = 0;
    const side: 1 | -1 = fast ? -1 : 1;
    L.node(spawn, { note: 'Start' });
    for (const q of nodesOn(w1, side, 400, 300)) L.node(q, { surf: true });
    const lanes = fast ? inner : outer;
    lanes.forEach((path, k) => {
      // Folgeviertel erst hinter dem Überlappungsstück (dort liegt noch die Flanke des Vorgängers darüber).
      for (const q of nodesOn(path, side, 120, k === 0 ? 200 : OVERLAP + 48, fast ? p.lineIn : p.lineOut)) L.node(q, { surf: true, note: fast ? 'innen' : 'außen' });
    });
    // R1-Knoten erst hinter der Landezone des Drops (256 u tiefer): überflogene Knoten lassen den Bot umkehren (fallen.md #32).
    for (const q of nodesOn(r1, side, 320, 700, p.lineTail)) L.node(q, { surf: true });
    for (const q of nodesOn(z, side, 320, 200, p.lineTail)) L.node(q, { surf: true });
    for (const q of nodesOn(fin, side, 400, 300).slice(0, -1)) L.node(q, { surf: true });
    L.node(fast ? launchL : launchR, { surf: true, note: 'Launch' });
    L.node(fk.p(beach.u0 + 1400, side * (LINE_DEPTH / Math.tan(60 * DEG) + 16), beachTop), { minSpeed: 250, note: 'Ziel' });
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
  readonly outer: readonly SurfPath[];
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
  archOver(c.r1, 700, COL.sand);
  archOver(c.z, 900, COL.teal);
  archOver(c.fin, 300, COL.coral);
  {
    const fr = c.outer[0].frameAt(c.p.lead);
    const [x, zz] = fr.xz(0, -c.p.rK);
    L.tower([x, zz], 200, c.outer[3].footAt(c.outer[3].length) - 2400, 2400 + 1400, { crown: COL.sand });
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
