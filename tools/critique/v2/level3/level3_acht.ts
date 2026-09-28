/**
 * PROTOTYP (verworfen, Stand Variante "Acht") — 03 BRANDUNG. Nachfolger: level3.ts (v3).
 *
 * Reine Surf-Map, nach dem Startbrett kein Pflicht-Bodenkontakt. Ablauf:
 *   Startbrett → W1 → Drop → W2 (Einstieg, beide Flanken) → CP1 (Gabel-Pad)
 *   → GABEL F = zwei Halbrampen mit gemeinsamem Grat (volles Profil, keine neue Kante)
 *   → links KORALLE: Schleife 360° links, Radius klein (schnell, kurz, eng)
 *   → rechts TÜRKIS: Schleife 360° rechts, Radius groß (sicher, lang, weit)
 *   → beide kommen UNTER der Gabel spiegelbildlich zurück (die "Acht") und fallen auf die
 *     Sammelrampe M (volles Profil, gleiche Seite = Standard-Drop) → CP2 → Finale-Kicker
 *   → Flug auf den Strand (Ziel).
 * Kurven werden immer an der INNENflanke gefahren (die Rampe trägt um die Kurve). Das setzt
 * den Rampbug-Fix voraus (pmFix/, probeCurveSweep): ohne ihn Nahtstopps an jeder Fuge.
 *
 * Zwei Linien für Bots: route = schnelle Linie (Gold/VELOCITY/Autor), safeRoute = sichere
 * Linie (Bronze/Silber) — Vorschlag LevelFile.safeRoute im Entwurf.
 */
import type { LevelFile } from '../../../../src/world/level/LevelFormat';
import { airTime, RESERVE } from '../../../levels/ballistics';
import { Frame, LevelBuilder, aabbOf, r3, type V2, type V3 } from '../../../levels/lib';
import { SurfPath, dropFrom } from './surfPath';

const DEG = Math.PI / 180;

export interface L3Params {
  readonly w1: number;
  readonly w2: number;
  readonly entrySlope: number;
  readonly fork: number;
  readonly forkSlope: number;
  /** Schleifen: Radius und Achsgefälle, schnell (links) / sicher (rechts). */
  readonly rFast: number;
  readonly slopeFast: number;
  readonly rSafe: number;
  readonly slopeSafe: number;
  /** Gerade vor/nach der Schleife (gleich für beide Bahnen → Enden fluchten). */
  readonly lead: number;
  readonly tail: number;
  /** Knick je Fuge (Grad). */
  readonly knick: number;
  /** Viertel-Drops in den Schleifen (0 = eine durchgehende Rampe). */
  readonly loopDrops: number;
  /** Sammelrampe M. */
  readonly mLen: number;
  readonly mSlope: number;
  readonly finale: ReadonlyArray<{ readonly length: number; readonly slopeDeg: number }>;
  /** Strand: so weit unter dem Kicker-Ende. */
  readonly beachBelow: number;
  /** Unteres Tempo-Band am Launch (für die Lücke zum Strand; gemessen in run.ts). */
  readonly launchLow: number;
  /** Bande auf dem Grat der Schleifen (Höhe, 0 = keine). */
  readonly railFast: number;
  readonly railSafe: number;
}

export const DEFAULT_L3: L3Params = {
  w1: 1536,
  w2: 1280,
  entrySlope: 10,
  fork: 896,
  forkSlope: 8,
  rFast: 1600,
  slopeFast: 6,
  rSafe: 2048,
  slopeSafe: 4.5,
  lead: 256,
  tail: 320,
  knick: 3.75,
  loopDrops: 0,
  mLen: 1024,
  mSlope: 10,
  finale: [
    { length: 512, slopeDeg: 10 },
    { length: 768, slopeDeg: 24 },
    { length: 256, slopeDeg: 12 },
    { length: 256, slopeDeg: 4 },
    { length: 320, slopeDeg: -8 },
  ],
  beachBelow: 1100,
  launchLow: 700,
  railFast: 96,
  railSafe: 96,
};

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
/** Knotenabstand in Kurven: der Grundtechnik-Surfer blickt entlang des nächsten Routen-Segments — bei 240 u hinkt der Blick der Kurve bis ~5° nach und bremst ihn (Taste nicht mehr quer zur Fahrt). */
const LOOP_NODE_STEP = Number(process.env.L3_NODE_STEP ?? 96);

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
      // Mondflut: tiefes Meer-Türkis, großer blasser Mond tief im Norden (Richtung Finale),
      // Trims Koralle / Sand (Gegenfarbe zur Welt; L1 Cyan, L2 Acid).
      skyTop: '#03141c',
      skyHorizon: '#0f5a66',
      skyBottom: '#010608',
      fogColor: '#0a3a48',
      fogNear: 1800,
      fogFar: 8000,
      sunDir: [-0.2, 0.3, -1],
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

  // ── START ───────────────────────────────────────────────────────────────
  const S = new Frame(0, 0, 0);
  L.platform(S, [-384, 32], [-224, 224], 40, { mat: 'start', tag: 'start' });
  // Spawn leicht rechts: wer geradeaus läuft, landet auf der rechten Flanke (→ sichere Bahn).
  const spawn = S.p(-160, 40, 40);
  L.spawn(spawn, 0);
  {
    const [a, b] = aabbOf(S, [-384, 32], [-224, 224], [40, 200]);
    L.startZone(a, b);
  }
  // Wegweiser: links Koralle (schnell), rechts Türkis (sicher).
  L.chevron(S.p(-40, -120, 40), 16, { tint: COL.coral, arm: 64, thick: 20, tag: 'startChevron' });
  L.chevron(S.p(-40, 120, 40), -16, { tint: COL.teal, arm: 64, thick: 20, tag: 'startChevron' });

  // ── EINSTIEG ────────────────────────────────────────────────────────────
  const w1 = add('w1', new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: W, segs: [{ length: p.w1, slopeDeg: p.entrySlope }], tag: 'w1', tint: COL.foam }));
  const w2 = add('w2', dropFrom(w1, { overlap: OVERLAP, drop: DROP, segs: [{ length: p.w2, slopeDeg: p.entrySlope }], tag: 'w2', tint: COL.foam }));

  // ── GABEL: zwei Halbrampen mit gemeinsamem Grat ────────────────────────
  const fL = add('forkFast', dropFrom(w2, { overlap: OVERLAP, drop: DROP, half: 'left', segs: [{ length: p.fork, slopeDeg: p.forkSlope }], tag: 'forkFast', tint: COL.coral }));
  const fR = add('forkSafe', dropFrom(w2, { overlap: OVERLAP, drop: DROP, half: 'right', segs: [{ length: p.fork, slopeDeg: p.forkSlope }], tag: 'forkSafe', tint: COL.teal }));
  surfPad(L, 1, w2, fR);

  // ── DIE ACHT: zwei Schleifen à 360°, links (schnell) und rechts (sicher) ──
  const loopSegs = (r: number, slope: number, turn: number): Array<{ length: number; slopeDeg: number; turnDeg?: number; pieces?: number }> => {
    const arc = r * Math.abs(turn) * DEG;
    const pieces = Math.round(Math.abs(turn) / p.knick);
    return [{ length: p.lead, slopeDeg: slope }, { length: arc, slopeDeg: slope, turnDeg: turn, pieces }, { length: p.tail, slopeDeg: slope }];
  };
  const loopFast = add('loopFast', dropFrom(fL, { overlap: OVERLAP, drop: DROP, half: 'left', segs: loopSegs(p.rFast, p.slopeFast, 360), tag: 'loopFast', tint: COL.coral, rail: p.railFast, railTint: COL.coral, railRange: [p.lead, p.lead + p.rFast * 2 * Math.PI] }));
  const loopSafe = add('loopSafe', dropFrom(fR, { overlap: OVERLAP, drop: DROP, half: 'right', segs: loopSegs(p.rSafe, p.slopeSafe, -360), tag: 'loopSafe', tint: COL.teal, rail: p.railSafe, railTint: COL.teal, railRange: [p.lead, p.lead + p.rSafe * 2 * Math.PI] }));
  const eF = loopFast.end;
  const eS = loopSafe.end;
  notes.push(
    `Acht: schnell R ${p.rFast} (${loopFast.length.toFixed(0)} u, ${p.slopeFast}°, fällt ${(fL.end.apex - DROP - eF.apex).toFixed(0)} u), ` +
      `sicher R ${p.rSafe} (${loopSafe.length.toFixed(0)} u, ${p.slopeSafe}°, fällt ${(fR.end.apex - DROP - eS.apex).toFixed(0)} u); ` +
      `Enden (${eF.x.toFixed(1)}, ${eF.z.toFixed(0)}) / (${eS.x.toFixed(1)}, ${eS.z.toFixed(0)}), Grat ${eF.apex.toFixed(0)} / ${eS.apex.toFixed(0)}`,
  );
  // Freiraum: die Schleifenenden liegen unter Gabel/Einstieg (Füße von W2/F über dem Grat der Enden).
  notes.push(`Freiraum unter der Gabel: F-Fuß ${(fL.footAt(0)).toFixed(0)} über Schleifen-Grat ${Math.max(eF.apex, eS.apex).toFixed(0)} → ${(fL.footAt(fL.length) - Math.max(eF.apex, eS.apex)).toFixed(0)} u`);

  // ── SAMMELRAMPE M: volles Profil unter beiden Enden (gleiche Seite → Standard-Drop) ──
  const mApex = Math.min(eF.apex, eS.apex) - DROP;
  const fm = new Frame(0, eF.z, 0);
  const m = add('merge', new SurfPath({ start: fm.xz(-OVERLAP), yaw: 0, apex: mApex, width: W, segs: [{ length: p.mLen, slopeDeg: p.mSlope }], tag: 'merge', tint: COL.foam }));
  notes.push(`M: Grat ${mApex.toFixed(0)}; Drop schnell ${(eF.apex - mApex).toFixed(0)} u, sicher ${(eS.apex - mApex).toFixed(0)} u`);

  // ── FINALE ──────────────────────────────────────────────────────────────
  const fin = add('finale', dropFrom(m, { overlap: OVERLAP, drop: DROP, segs: p.finale, tag: 'finale', tint: COL.coral }));
  surfPad(L, 2, m, fin);

  // ── STRAND (Ziel) ─────────────────────────────────────────────────────
  const kick = fin.end;
  const fk = new Frame(kick.x, kick.z, kick.yaw);
  const launchL = fin.riderPos(fin.length - 8, -1, LINE_DEPTH);
  const launchR = fin.riderPos(fin.length - 8, 1, LINE_DEPTH);
  const beachTop = Math.round(kick.apex - p.beachBelow);
  const tFly = airTime(launchL[1] - beachTop, false, 0);
  // Flug bis zur Kante = lip − 8 (Knoten 8 u vor dem Kickerende), Hull trägt 16 u über die Kante.
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

  // ── KILL-ZONEN ──────────────────────────────────────────────────────────
  killTiles(L, notes);

  // ── DEKO ────────────────────────────────────────────────────────────────
  deco(L, { w2, m, fin, fk, beachTop, beach, loopFast, loopSafe, p });

  // ── ROUTEN ──────────────────────────────────────────────────────────────
  const nodesOn = (path: SurfPath, side: 1 | -1, step: number, from = 200, depth = LINE_DEPTH): V3[] => {
    const out: V3[] = [];
    for (let s = from; s < path.length - 60; s += step) out.push(path.riderPos(s, side, depth));
    out.push(path.riderPos(path.length - 32, side, depth));
    return out;
  };
  const build = (fast: boolean): LevelFile => {
    L.route.length = 0;
    const side: 1 | -1 = fast ? -1 : 1;
    L.node(spawn, { note: 'Start' });
    for (const q of nodesOn(w1, side, 400, 360)) L.node(q, { surf: true });
    for (const q of nodesOn(w2, side, 400, 300)) L.node(q, { surf: true });
    for (const q of nodesOn(fast ? fL : fR, side, 320, 240)) L.node(q, { surf: true, note: fast ? 'Gabel schnell' : 'Gabel sicher' });
    for (const q of nodesOn(fast ? loopFast : loopSafe, side, LOOP_NODE_STEP)) L.node(q, { surf: true });
    for (const q of nodesOn(m, side, 320, 260)) L.node(q, { surf: true });
    for (const q of nodesOn(fin, side, 400, 300).slice(0, -1)) L.node(q, { surf: true });
    const launch = fast ? launchL : launchR;
    L.node(launch, { surf: true, note: 'Launch' });
    // Ziel-Knoten geradeaus hinter dem Launch, weit hinter dem schnellsten Aufsetzpunkt (fallen.md #62).
    L.node(fk.p(beach.u0 + 1400, side * (LINE_DEPTH / Math.tan(60 * DEG) + 16), beachTop), { minSpeed: 250, note: 'Ziel' });
    const def = L.build();
    // LevelBuilder.build() gibt sein eigenes route-Array zurück — kopieren, sonst überschreibt die zweite Variante die erste.
    return { ...def, route: [...(def.route ?? [])], brushes: [...def.brushes], triggers: [...def.triggers] };
  };
  return { fast: build(true), safe: build(false), paths, notes };
}

/**
 * Checkpoint am Drop a → b (wie level2.surfCheckpoint, jede Richtung): Keil-Pad auf dem Grat von b,
 * bündig ab dem Ende von a, Spawn 24 u rechts vom Grat. Luft-Trigger um den Übergang.
 */
function surfPad(L: LevelBuilder, order: number, a: SurfPath, b: SurfPath): V3 {
  const PAD_RISE = 40;
  const s0 = OVERLAP;
  const s1 = s0 + 96;
  const s2 = s1 + 128;
  const fb = b.frameAt(0);
  const base = b.apexAt(s0);
  const padTop = r3(base + PAD_RISE);
  const v: V2 = [-48, 72];
  const pts: V3[] = [];
  for (const vv of v) pts.push(fb.p(s0, vv, base), fb.p(s1, vv, padTop), fb.p(s2, vv, padTop), fb.p(s2, vv, base));
  L.add({ type: 'hull', points: pts, mat: 'checkpoint', tag: `cp${order}pad` });
  const sp = fb.p(s1 + 64, 24, padTop);
  const fa = a.frameAt(a.length);
  const uN = 360;
  const footN = b.apexAt(s0 + uN) - b.height;
  const [lo, hi] = aabbOf(fa, [-420, uN], [-b.o.width / 2, b.o.width / 2], [footN + 40, padTop + CP_TALL / 2]);
  L.checkpoint(order, lo, hi, sp, fb.yaw);
  return sp;
}

/**
 * Kill-Kacheln 1024² über dem ganzen Grundriss: je 250 u unter der tiefsten kollidierenden
 * Fläche, die die Kachel (±64) überdeckt, 600 u hoch. Die Acht stapelt Rampen übereinander
 * (Schleifenende unter Gabel und Einstieg) — die Kachel richtet sich nach der tiefsten.
 */
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
  readonly w2: SurfPath;
  readonly m: SurfPath;
  readonly fin: SurfPath;
  readonly fk: Frame;
  readonly beachTop: number;
  readonly beach: { readonly u0: number; readonly u1: number };
  readonly loopFast: SurfPath;
  readonly loopSafe: SurfPath;
  readonly p: L3Params;
}

/** Deko: Leuchttürme (fern), Leuchtbojen in den Schleifenmitten, Tore über den Geraden, Strandbojen. */
function deco(L: LevelBuilder, c: DecoCtx): void {
  const archOver = (path: SurfPath, s: number, tint: string): void => {
    const f = path.frameAt(s);
    const base = path.footAt(s) - 200;
    L.arch(f, 0, [-path.o.width / 2 - 96, path.o.width / 2 + 96], base, path.height + 200 + 420, tint, 48, 'surfArch');
  };
  archOver(c.w2, 600, COL.foam);
  archOver(c.fin, 300, COL.coral);
  // Leuchtboje in jeder Schleifenmitte: Blickanker, um den man kreist (Farbe der Bahn).
  const center = (path: SurfPath, side: 1 | -1, r: number): V2 => {
    const f = path.frameAt(c.p.lead);
    return f.xz(0, side * r);
  };
  const cf = center(c.loopFast, -1, c.p.rFast);
  const cs = center(c.loopSafe, 1, c.p.rSafe);
  L.tower(cf, 160, c.loopFast.end.apex - 2600, 2600 + 900, { crown: COL.coral });
  L.tower(cs, 160, c.loopSafe.end.apex - 2600, 2600 + 900, { crown: COL.teal });
  // Leuchttürme, fern.
  const towers: Array<[number, number, number, number, string]> = [
    [5200, -3200, 320, 5200, COL.sand],
    [-6400, -2400, 360, 5600, COL.coral],
    [-2600, -10400, 300, 6000, COL.teal],
    [3600, -12400, 380, 6400, COL.coral],
    [-7600, -9200, 420, 6800, COL.sand],
    [6800, 3200, 300, 4400, COL.teal],
  ];
  for (const [x, z, w, h, crown] of towers) L.tower([x, z], w, -12800, h + 8000, { crown });
  for (const u of [c.beach.u0 + 300, c.beach.u0 + 1100, c.beach.u0 + 1900]) {
    for (const v of [-1150, 1150]) {
      const [x, z] = c.fk.xz(u, v);
      L.pylon([x, z], c.beachTop - 800, 1100, u % 2 ? COL.coral : COL.sand, 22);
    }
  }
}
