/**
 * Level 3 "03 BRANDUNG — Halt die Linie." (Plan 007, Phase 2: Strang level3).
 *
 * Reine Surf-Map, nach dem Startbrett kein Pflicht-Bodenkontakt. Draufsicht (Norden = −Z oben, Maße u):
 *
 *                    KEHRE 180° links, Grat-R 2000, 4 Viertel à 45° (Drop 64 je Viertel)
 *              .-~~~~~~~~~~~~~~~~~~~~~ ◆ CP2 ~~~~~~~~~~~~~~~~~~~~~-.
 *            /  KORALLE innen (links): schmal, kein Netz, kurz       \
 *           |   TÜRKIS außen (rechts): Bande am Grat, Auffang-Band,   |
 *           |   lang — man stirbt nicht                                |
 *     CP3 ◆ R1 (breit, 50°)                                    CP1 ◆ W1 (volles Profil: Seite wählen)
 *           |                                                      |
 *           Z                                                   ▣ START
 *           ▼  FINALE-KICKER → Flug → STRAND (Ziel)
 *
 * Die Gabel ist die Kehre selbst: zwei Halbrampen Rücken an Rücken mit gemeinsamem Grat. Innen (Koralle) trägt
 * die konkave Flanke um die Kurve, die Linie liegt ~R−160 — kurz, aber wer absinkt, fällt ins Kurveninnere.
 * Außen (Türkis) ist die Flanke konvex (man muss drücken), die Linie liegt ~R+200; wer nicht drückt, rutscht aufs
 * Auffang-Band und hüpft darauf bis R1 weiter. Eine schnelle Surf-Linie spart WEG, nicht Höhe (Prototyp: Sprung
 * über eine Welle war langsamer als durch). `route` = Koralle, `safeRoute` = Türkis (Bronze/Silber, Raster-Pflicht).
 *
 * Aus dem Prototyp tools/critique/v2/level3/level3.ts (DEFAULT_L3) auf lib-Bausteinen, mit Endtangente
 * (dropFrom 'tangent': Kehre 180° statt 174°) und gegen die finale Physik von Plan 007 neu gemessen
 * (Zahlen: .docs/research/levels/level3.md).
 */
import type { HullDef, LevelFile, RouteNode, Vec3Tuple } from '../../src/world/level/LevelFormat';
import { Frame, LevelBuilder, SurfPath, aabbOf, catchBand, dropFrom, type CatchBandOpts, type DropOpts, type V2, type V3 } from './lib';
import { measureSurfSpeeds, SURF_GRID, withRoute } from './physics';

const DEG = Math.PI / 180;

export interface L3Params {
  /** W1 (Einstieg, volles Profil): Länge, Gefälle. */
  readonly w1: number;
  readonly slope: number;
  /** Gefälle von R1 und Z. */
  readonly slopeTail: number;
  /** Kehre: Grat-Radius, Gefälle, Drop zwischen den Vierteln. */
  readonly rK: number;
  readonly slopeK: number;
  readonly dropK: number;
  /** Gerades Stück vor dem ersten und nach dem letzten Viertel. */
  readonly lead: number;
  readonly tail: number;
  /** Grat-Bande der Außenbahn (Höhe). */
  readonly rail: number;
  /** Erstes Viertel (0–3) mit Grat-Bande. */
  readonly railFrom: number;
  /** Inset der Grat-Bande im ersten Viertel; jedes Folgeviertel 2 u weniger (zurückgesetzt, keine Kerbe). */
  readonly railInset0: number;
  /** Auffang-Band unter der Außenbahn: Breite (0 = keins) und Höhe der Außenbande. */
  readonly catchWidth: number;
  readonly catchBank: number;
  readonly r1: number;
  readonly z: number;
  /** Strand so tief unter dem Kickerende. */
  readonly beachBelow: number;
  /** Unteres Tempo-Band am Launch — bestimmt die Strand-Lücke. Default nur für den ersten Bau (buildLevel3With misst). */
  readonly launchLow: number;
  /** Größter Gehrungs-Knick je Fuge (Grad). */
  readonly knick: number;
  /** Innenbahn (Koralle): Profilbreite der schmalen Halbrampe, Linientiefe. */
  readonly innerWidth: number;
  /**
   * Viertel 4 der Innenbahn (Ausfahrt): Profilbreite und Linientiefe am Ende (Rampe ab lineIn). Breiter und tiefer
   * als die Kehre (kleinerer Fall auf R1): sonst lohnt Koralle der 3°-Hand nicht (Quote 0.955 statt 0.896, 8 Seeds).
   */
  readonly innerWidth4: number;
  readonly lineIn4: number;
  /** Flankenwinkel der Innenbahn (Grad). */
  readonly innerFlank: number;
  readonly lineIn: number;
  /** Außenbahn (Türkis): Linientiefe in der Kehre. */
  readonly lineOut: number;
  /** Linientiefe auf R1/Z (breite 50°-Rampen). */
  readonly lineTail: number;
  /**
   * Finale: Linientiefe (inkl. Launch) und erster Knoten (Bogenlänge ab Finale-Beginn). 200 statt 320 (Prototyp):
   * mit 320 blieb der perfekte Bot nach CP3 stehen (Gate-Befund mit Cap 40; heute 3–4 von 49 Jitter-Starts).
   */
  readonly lineFin: number;
  readonly finFrom: number;
  /** Drop Kehre → R1 (Grat). Untergrenze (tan60 − tan50)·384 = 207 für den Außenfuß. */
  readonly dropR1: number;
  /** Seitversatz des R1-Grats (u, rechts positiv; negativ = zur Innenbahn). Grenze: Band-Außenkante 704 − Versatz ≤ 768. */
  readonly r1Lateral: number;
}

export const DEFAULT_L3: L3Params = {
  w1: 1536,
  slope: 10,
  slopeTail: 10,
  rK: 2000,
  slopeK: 12,
  dropK: 64,
  lead: 256,
  tail: 256,
  rail: 128,
  railFrom: 0,
  railInset0: 18,
  catchWidth: 320,
  catchBank: 448,
  r1: 1536,
  z: 1536,
  beachBelow: 1100,
  launchLow: 700,
  knick: 3.75,
  innerWidth: 384,
  innerWidth4: 576,
  lineIn4: 360,
  innerFlank: 60,
  lineIn: 240,
  lineOut: 320,
  lineTail: 200,
  lineFin: 200,
  finFrom: 300,
  dropR1: 256,
  r1Lateral: 0,
};

/** Finale-Kicker (wie L2 S4): steil fallen, abflachen, am Ende steigen — Abflug schräg nach oben. */
export const FINALE: ReadonlyArray<{ readonly length: number; readonly slopeDeg: number }> = [
  { length: 512, slopeDeg: 10 },
  { length: 768, slopeDeg: 24 },
  { length: 256, slopeDeg: 12 },
  { length: 256, slopeDeg: 4 },
  { length: 320, slopeDeg: -8 },
];

/** "Mondflut": Koralle/Sand als Gegenfarbe zur türkisen Welt (L1 Cyan, L2 Acid). */
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

export interface L3Layout {
  /** Level mit route (Koralle) und safeRoute (Türkis), minSpeed noch nicht gemessen. */
  readonly level: LevelFile;
  readonly paths: Readonly<Record<string, SurfPath>>;
  readonly notes: readonly string[];
}

/** Geometrie + beide Linien (ohne Messung). Für Sweeps und Proben einzeln aufrufbar. */
export function layoutLevel3(p: L3Params = DEFAULT_L3): L3Layout {
  const notes: string[] = [];
  const L = new LevelBuilder({
    id: 'level3',
    name: '03 BRANDUNG',
    subtitle: 'Halt die Linie.',
    killY: -12000,
    music: { root: 'F', bpm: 132 },
    environment: {
      // Mondflut: tiefes Meer-Türkis, blasser Mond im Südosten, 40° links neben der Finale-Achse, 20° hoch. Genau voraus
      // stand die Scheibe im Finale hinter Tacho und SURF-Label (HUD-Mitte); im Südwesten stünde sie beim Kehren-
      // Ausgang (Blick SW) wieder dahinter. Im Osten liegt keine Blickrichtung der Strecke: W1 Nord, Kehre N→W→S.
      skyTop: '#03141c',
      skyHorizon: '#0f5a66',
      skyBottom: '#010608',
      fogColor: '#0a3a48',
      fogNear: 1800,
      fogFar: 8000,
      sunDir: [0.84, 0.48, 1],
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
  const drop = (prev: SurfPath, o: DropOpts): SurfPath => dropFrom(prev, { ...o, yawFrom: 'tangent' });
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
  // Chevrons 152 u vor dem Spawn, beidseits des Grats (Koralle links, Türkis rechts), nah an der Blickachse: weiter außen
  // lagen sie unter der Tastenanzeige (unten links) und der Hand (unten rechts, beide Default an). Spitze ≤ 32 (Brettkante).
  L.chevron(S.p(-8, -22, 40), 12, { tint: COL.coral, arm: 40, thick: 16, tag: 'startChevron' });
  L.chevron(S.p(-8, 58, 40), -12, { tint: COL.teal, arm: 40, thick: 16, tag: 'startChevron' });

  // ── W1: volles Profil — hier wählt man die Seite ─────────────────────────
  const w1 = add('w1', new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: W, segs: [{ length: p.w1, slopeDeg: p.slope }], tag: 'w1', tint: COL.foam }));

  // ── KEHRE: außen (rechts) und innen (links) je 4 Viertel mit Drops ────────
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
    const o = add(
      `outer${k + 1}`,
      drop(prev, {
        overlap: OVERLAP,
        drop: first ? DROP : p.dropK,
        half: 'right',
        segs,
        tag: `outer${k + 1}`,
        tint: COL.teal,
        rail: k >= p.railFrom ? p.rail : 0,
        railTint: COL.teal,
        railInset: p.railInset0 - 2 * k,
        // Am Anfang (CP1) und in der Mitte (CP2, Viertel 3) liegt ein Pad auf dem Grat: Bande erst dahinter.
        ...(first || k === 2 ? { railRange: [360, Infinity] as const } : {}),
      }),
    );
    outer.push(o);
    // Auffang-Band unter dem Außenfuß (die Außenflanke trägt nicht um die Kurve: wer nicht drückt, rutscht hinaus).
    if (p.catchWidth > 0) L.add(...litBand(o, { below: 32, width: p.catchWidth, bank: p.catchBank, tint: COL.sand, tag: `outerCatch${k + 1}` }));
    // Innen: gleicher Grat (Rücken an Rücken), gleiche Drops, aber schmal — der Fuß liegt nah, wer absinkt, fällt.
    const i = add(
      `inner${k + 1}`,
      new SurfPath({ start: [o.o.start[0], o.o.start[1]], yaw: o.o.yaw, apex: o.o.apex, width: last ? p.innerWidth4 : p.innerWidth, flankDeg: p.innerFlank, half: 'left', segs, tag: `inner${k + 1}`, tint: COL.coral }),
    );
    inner.push(i);
  }
  L.surfPad(1, w1, outer[0], 40);
  // CP2 in der Kehrenmitte (Drop Viertel 2 → 3, in beiden Bahnen): Pad auf dem gemeinsamen Grat — Innenlinie
  // (~160 links) und Außenlinie (~200 rechts) fahren daneben vorbei. Respawn rechts (Türkis), links runter = Koralle.
  L.surfPad(2, outer[1], outer[2], 40, { span: [-W / 2 - 32, W / 2 + p.catchWidth + 64] });
  notes.push(
    `Kehre: Grat R ${p.rK}, 4 × 45° à ${Q.toFixed(0)} u, ${p.slopeK}°, Drops ${p.dropK}; Linie innen ≈ ${((p.rK - 160) * Math.PI).toFixed(0)} u, ` +
      `außen ≈ ${((p.rK + 200) * Math.PI).toFixed(0)} u; Enden Grat außen ${outer[3].end.apex.toFixed(0)} / innen ${inner[3].end.apex.toFixed(0)}`,
  );

  // ── R1: volles Profil unter beiden Hälften, breit und 50° flach ─────────
  // Fängt beide Hälften UND das Auffang-Band. Unter 60°-Flanken muss eine 50°-Flanke am Fuß tiefer liegen:
  // (tan60 − tan50)·384 = 207 → Drop 256.
  const r1 = add('r1', drop(outer[3], { overlap: OVERLAP, drop: p.dropR1, lateral: p.r1Lateral, width: 1536, flankDeg: 50, half: 'both', segs: [{ length: p.r1, slopeDeg: p.slopeTail }], tag: 'r1', tint: COL.foam }));
  L.surfPad(3, outer[3], r1, -40, { span: [-768 - 32, 768 + 32] });
  const z = add('z', drop(r1, { overlap: OVERLAP, drop: DROP, segs: [{ length: p.z, slopeDeg: p.slopeTail }], tag: 'z', tint: COL.foam }));

  // ── FINALE ──────────────────────────────────────────────────────────────
  const fin = add('finale', drop(z, { overlap: OVERLAP, drop: DROP, segs: FINALE, tag: 'finale', tint: COL.coral }));

  // ── STRAND (Ziel) ─────────────────────────────────────────────────────
  const launchL = fin.riderPos(fin.length - 8, -1, p.lineFin);
  const launchR = fin.riderPos(fin.length - 8, 1, p.lineFin);
  const BEACH_W = 2048;
  const goal = L.finishAfterLaunch(fin.end, launchL, p.launchLow, { drop: p.beachBelow, depth: 2400, v: [-BEACH_W / 2, BEACH_W / 2] });
  const fk = goal.frame;
  notes.push(`Strand: Oberseite ${goal.top} (${p.beachBelow} unter dem Kicker), Lücke ${goal.lip} u bei unterem Band ${p.launchLow} u/s, Flugzeit ${goal.flight.toFixed(2)} s`);

  notes.push(`Kill-Kacheln: ${L.killTiles()}`);
  deco(L, { outer, r1, z, fin, fk, beachTop: goal.top, beach: goal.fin, p });

  // ── ROUTEN ──────────────────────────────────────────────────────────────
  const nodesOn = (path: SurfPath, side: 1 | -1, step: number, from = 200, depth: number | ((s: number) => number) = LINE_DEPTH, to = path.length - 32): V3[] => {
    const d = typeof depth === 'number' ? (): number => depth : depth;
    const out: V3[] = [];
    for (let s = from; s < to - 60; s += step) out.push(path.riderPos(s, side, d(s)));
    out.push(path.riderPos(to, side, d(to)));
    return out;
  };
  const line = (fast: boolean): RouteNode[] => {
    L.route.length = 0;
    const side: 1 | -1 = fast ? -1 : 1;
    L.node(spawn, { note: 'Start' });
    for (const q of nodesOn(w1, side, 400, 300)) L.node(q, { surf: true });
    const lanes = fast ? inner : outer;
    lanes.forEach((path, k) => {
      // Kurvenknoten alle 120 u (bei 240 hinkt die Routen-Achse nach, der Surfer blickt in die Rampe).
      // Folgeviertel erst hinter dem Überlappungsstück (dort liegt noch die Flanke des Vorgängers darüber).
      // Innen im letzten Viertel: Linie gleitet zur Ausfahrt auf lineIn4 (tiefer = kleinerer Fall auf R1).
      const depth = !fast ? p.lineOut : k < 3 ? p.lineIn : (s: number): number => p.lineIn + ((p.lineIn4 - p.lineIn) * Math.min(1, s / path.length));
      for (const q of nodesOn(path, side, 120, k === 0 ? 200 : OVERLAP + 48, depth)) L.node(q, { surf: true, note: fast ? 'innen' : 'außen' });
    });
    // R1-Knoten erst hinter der Landezone des Drops (256 u tiefer): überflogene Knoten lassen den Bot umkehren (fallen.md #32).
    for (const q of nodesOn(r1, side, 320, 700, p.lineTail)) L.node(q, { surf: true });
    for (const q of nodesOn(z, side, 320, 200, p.lineTail)) L.node(q, { surf: true });
    for (const q of nodesOn(fin, side, 400, p.finFrom, p.lineFin).slice(0, -1)) L.node(q, { surf: true });
    L.node(fast ? launchL : launchR, { surf: true, note: 'Launch' });
    L.node(fk.p(goal.fin.u0 + 1400, side * (LINE_DEPTH / Math.tan(60 * DEG) + 16), goal.top), { minSpeed: 250, note: 'Ziel' });
    // LevelBuilder hält EIN route-Array — kopieren, sonst überschreibt die zweite Linie die erste.
    return [...L.route];
  };
  const fast = line(true);
  const safe = line(false);
  L.route.length = 0;
  L.route.push(...fast);
  const def = L.build();
  // Reine Surf-Map: vorher die Surf-Lektionen (Menü "Empfohlen: T7/T8", build.ts kopiert es in den Index).
  const prepLessons = ['t7', 't8'];
  return { level: { ...def, prepLessons, route: fast, safeRoute: safe, brushes: [...def.brushes], triggers: [...def.triggers] }, paths, notes };
}

/** Tempo-Band einer Linie: minSpeed = 90 % des langsamsten Fahrers aus dem Stand + Surf-Raster (wie L2). */
function measured(def: LevelFile): { readonly nodes: RouteNode[]; readonly launchLow: number; readonly missing: readonly number[] } {
  const v = measureSurfSpeeds(def, [{ surfer: 0 }, { surfer: 2 }, { bot: { aimNoiseDeg: 3 } }], { grid: SURF_GRID });
  const route = def.route ?? [];
  const nodes = route.map((n, i) => (n.surf && Number.isFinite(v[i]) ? { ...n, minSpeed: Math.round(0.9 * v[i]) } : n));
  const missing = route.map((n, i) => (n.surf && !Number.isFinite(v[i]) ? i : -1)).filter((i) => i >= 0);
  const li = nodes.findIndex((n) => n.note === 'Launch');
  return { nodes, launchLow: li >= 0 ? nodes[li].minSpeed ?? 0 : 0, missing };
}

/**
 * Zwei Durchgänge wie L2: (1) Tempo-Band am Launch auf BEIDEN Linien messen → Strand-Lücke aus dem
 * langsameren (−5 %: der zweite Bau verschiebt das Band leicht); (2) neu bauen und minSpeed je Surf-Knoten
 * beider Linien messen. Jedes Movement-Tuning zieht Lücke und Band über die Messung mit.
 */
export function buildLevel3With(p: L3Params = DEFAULT_L3): { readonly level: LevelFile; readonly notes: readonly string[] } {
  const first = layoutLevel3(p).level;
  const low = Math.min(measured(first).launchLow, measured(withRoute(first, 'safeRoute')).launchLow);
  const lay = low > 0 ? layoutLevel3({ ...p, launchLow: Math.round(low * 0.95) }) : layoutLevel3(p);
  const fast = measured(lay.level);
  const safe = measured(withRoute(lay.level, 'safeRoute'));
  const miss = [...fast.missing.map((i) => `route ${i}`), ...safe.missing.map((i) => `safeRoute ${i}`)];
  if (miss.length) throw new Error(`level3: Surf-Knoten aus dem Stand nicht erreicht: ${miss.join(', ')}`);
  // Die Lücke ist mit dem Band des ersten Baus geplant: fällt es im zweiten unter den Planwert, fehlt Reserve.
  const planned = low > 0 ? Math.round(low * 0.95) : p.launchLow;
  const band = Math.min(fast.launchLow, safe.launchLow);
  if (band < planned) throw new Error(`level3: Tempo-Band am Launch ${band} u/s unter dem Planwert der Strand-Lücke ${planned} u/s`);
  return {
    level: { ...lay.level, route: fast.nodes, safeRoute: safe.nodes },
    notes: [...lay.notes, `Tempo-Band Launch: route ${fast.launchLow} u/s, safeRoute ${safe.launchLow} u/s (erster Bau ${low})`],
  };
}

export function buildLevel3(): LevelFile {
  return buildLevel3With().level;
}

/** Leuchtbalken der Außenbande: Höhe (u), Abstand zu den Clip-Flächen (u); Pfosten an jeder zweiten Fuge. */
const BAR_H = 12;
const BAR_INSET = 6;
const POST_EVERY = 2;

/**
 * Auffang-Band (lib.catchBand) mit der Außenbande als schlankem LEUCHTBALKEN statt Vollwand (Look-Pass):
 * die 448-u-Bande kollidiert unverändert, ist aber ein unsichtbarer Clip. Sichtbar sind ein Balken an ihrer
 * Oberkante (die echte Grenze) und Pfosten an jeder zweiten Fuge — beide ganz IN der Clip-Hülle: nichts ragt
 * in die Flugbahn, keine Fläche liegt koplanar zu einer sichtbaren. Als Vollwand versperrte sie auf der
 * Außenbahn den Blick aus der Kehre (Mond, Leuchtturm). Kollision und Brush-Reihenfolge bleiben gleich.
 */
function litBand(path: SurfPath, o: CatchBandOpts): HullDef[] {
  const out: HullDef[] = [];
  const lerp = (a: Vec3Tuple, b: Vec3Tuple, t: number, dy = 0): Vec3Tuple => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + dy, a[2] + (b[2] - a[2]) * t];
  let joint = 0;
  for (const h of catchBand(path, o)) {
    if (!h.tag?.endsWith('Bank')) {
      out.push(h);
      continue;
    }
    out.push({ ...h, visible: false });
    // catchBand-Punkte je Fugenende: Oberkante innen/außen, Unterkante innen/außen (Fuge a: 0–3, Fuge b: 4–7).
    const P = h.points;
    const depth = Math.hypot(P[3][0] - P[2][0], P[3][2] - P[2][2]);
    const t0 = BAR_INSET / depth;
    const t1 = 1 - BAR_INSET / depth;
    const bar: Vec3Tuple[] = [];
    for (const e of [0, 4]) {
      for (const t of [t0, t1]) bar.push(lerp(P[e], P[e + 1], t, -2), lerp(P[e], P[e + 1], t, -2 - BAR_H));
    }
    out.push({ type: 'hull', points: bar, mat: 'light', tint: o.tint ?? COL.sand, collide: false, tag: `${o.tag ?? 'catch'}Bar` });
    if (joint++ % POST_EVERY === 0) {
      // Pfosten 8 × 8 u in der Mitte der Bande, von der Unterkante des Bands bis in den Balken; 4 u hinter
      // der Fuge (auf der Fuge läge seine Stirn koplanar zur Stirn des Balkens).
      const [ux, uz] = [P[6][0] - P[2][0], P[6][2] - P[2][2]];
      const ul = Math.hypot(ux, uz);
      const [dx, dz] = [ux / ul, uz / ul];
      const post: Vec3Tuple[] = [];
      for (const t of [0.5 - 4 / depth, 0.5 + 4 / depth]) {
        const lo = lerp(P[2], P[3], t);
        const hi = lerp(P[0], P[1], t, -2 - BAR_H + 4);
        for (const u of [4, 12]) post.push([lo[0] + dx * u, lo[1], lo[2] + dz * u], [hi[0] + dx * u, hi[1], hi[2] + dz * u]);
      }
      out.push({ type: 'hull', points: post, mat: 'dark', collide: false, tag: `${o.tag ?? 'catch'}Post` });
    }
  }
  return out;
}

/** Leuchtturm: dunkler Schaft mit Leuchtringen, Laterne (selbstleuchtend), Kappe. */
function lighthouse(L: LevelBuilder, c: V2, w: number, base: number, h: number, lamp: string, rings: string): void {
  const [x, z] = c;
  const sq = (half: number, y0: number, y1: number, mat: 'dark' | 'light', tint?: string): void =>
    L.decoBox([x - half, y0, z - half], [x + half, y1, z + half], { mat, ...(tint ? { tint } : {}) });
  sq(w / 2, base, base + h, 'dark');
  // Ringe 8 u breiter als der Schaft: keine koplanaren Seitenflächen.
  for (const f of [0.55, 0.7, 0.85]) sq(w / 2 + 8, base + h * f, base + h * f + w * 0.3, 'light', rings);
  sq(w * 0.4, base + h, base + h + w * 0.7, 'light', lamp);
  sq(w * 0.55, base + h + w * 0.7, base + h + w * 0.85, 'dark');
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
    // Kehren-Leuchtturm: Blickanker in der Kehrenmitte, um den man 180° kreist. Die Laterne steht knapp
    // über der Fahrlinie der Einfahrt (dort links auf Augenhöhe, am Kehrenende 1600 u darüber).
    const fr = c.outer[0].frameAt(c.p.lead);
    const [x, zz] = fr.xz(0, -c.p.rK);
    const base = c.outer[3].footAt(c.outer[3].length) - 2400;
    lighthouse(L, [x, zz], 200, base, c.outer[0].apexAt(0) - 200 - base, COL.moon, COL.coral);
  }
  const towers: Array<[number, number, number, number, string]> = [
    [4200, -4200, 320, 5200, COL.teal],
    [-9800, -2600, 360, 5600, COL.coral],
    [3600, 6400, 300, 6000, COL.sand],
    [-9200, 9800, 380, 6400, COL.coral],
    [800, 13200, 420, 6800, COL.teal],
  ];
  for (const [x, zz, w, h, lamp] of towers) lighthouse(L, [x, zz], w, -12800, h + 8000, lamp, COL.sand);
  // Strandbojen im Wechsel Koralle/Sand (Index, nicht u: die u-Werte sind alle gerade).
  for (const [i, u] of [c.beach.u0 + 300, c.beach.u0 + 1100, c.beach.u0 + 1900].entries()) {
    for (const [k, v] of [-1150, 1150].entries()) {
      const [x, zz] = c.fk.xz(u, v);
      L.pylon([x, zz], c.beachTop - 800, 1100, (i + k) % 2 ? COL.coral : COL.sand, 22);
    }
  }
}
