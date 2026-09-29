/**
 * Level 3 "03 BRANDUNG — Halt die Linie." (Plan 007, Phase 2: Strang level3).
 *
 * Reine Surf-Map, nach dem Startbrett kein Pflicht-Bodenkontakt. Draufsicht (Norden = −Z oben, Maße u):
 *
 *                    KEHRE 180° links, Grat-R 2000, 4 Viertel à 45° (Drop 64 je Viertel)
 *              .-~~~~~~~~~~~~~~~~~~~~~ ◆ CP2 ~~~~~~~~~~~~~~~~~~~~~-.
 *            /  KORALLE innen (links): schmal, kein Netz, kurz       \
 *           |   TÜRKIS außen (rechts): Auffang-Band, lang —           |
 *           |   man stirbt nicht             ║ Grat-Bande             |
 *     CP3 ◆ R1 (breit, 50°)                                    CP1 ◆ W1 (volles Profil, Finne, Band rechts)
 *           |                                                      |
 *           Z                                                   ▣ START (Seite wählen)
 *           ▼  FINALE-KICKER (+ Schürze) → Flug → STRAND (Ziel)
 *
 * Eine Bande (Finne) läuft vom Brett bis R1 ohne Lücke auf dem Grat: jede folgende beginnt verdeckt hinter der vorigen,
 * die Checkpoint-Plattformen schweben darüber, hinter der Landezone ihres Drops (CP3 vor dem Drop auf R1). Früher lagen
 * Keil-Pads am Drop auf dem Grat und die Bande hatte dort Lücken — wer hoch fuhr, prallte ab (Review Phase 3).
 *
 * Die Gabel ist die Kehre selbst: zwei Halbrampen Rücken an Rücken mit gemeinsamem Grat. Innen (Koralle) trägt
 * die konkave Flanke um die Kurve, die Linie liegt ~R−160 — kurz, aber wer absinkt, fällt ins Kurveninnere.
 * Außen (Türkis) ist die Flanke konvex (man muss drücken), die Linie liegt ~R+200; wer nicht drückt, rutscht aufs
 * Auffang-Band (ab dem Brett: auch unter W1) und hüpft darauf bis R1 weiter. Bandfahrer kommen schnell und tief neben
 * R1 an — die Schürze am Finale-Kicker fängt sie. Eine schnelle Surf-Linie spart WEG, nicht Höhe (Prototyp: Sprung
 * über eine Welle war langsamer als durch). `route` = Koralle, `safeRoute` = Türkis (Bronze/Silber, Raster-Pflicht).
 *
 * Aus dem Prototyp tools/critique/v2/level3/level3.ts (DEFAULT_L3) auf lib-Bausteinen, mit Endtangente
 * (dropFrom 'tangent': Kehre 180° statt 174°) und gegen die finale Physik von Plan 007 neu gemessen
 * (Zahlen: .docs/research/levels/level3.md).
 */
import type { HullDef, LevelFile, RouteNode, Vec3Tuple } from '../../src/world/level/LevelFormat';
import { Frame, LevelBuilder, SurfPath, aabbOf, catchBand, dropFrom, rightOf, type CatchBandOpts, type DropOpts, type V2, type V3 } from './lib';
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
  /**
   * Finale-Kicker samt Schürze so breit (u; das Profil selbst bleibt 1536 wie R1/Z): Türkis-Bandfahrer kommen bei
   * Querlage ~690 auf R1 an (Fuß 768), driften mit Blick weg von der Rampe nach außen und flogen am Fuß des Finales
   * vorbei — 91 von 216 Grundtechnik-Läufen vom Brett starben nach CP3, mit 2048 noch 3.
   */
  readonly finSkirt: number;
  /**
   * Schürze der Innenbahn in Viertel 1: Profilbreite am Anfang (u; W1 = 768) und Bogenlänge, bei der sie auf innerWidth
   * verjüngt ist; Breite ≤ innerWidth = aus. W1 trägt links bis 384 u vom Grat, die Innenbahn nur bis 192: wer vom
   * Spawn schräg links um die Finne läuft (24–32°), landet bei Querlage −260…−300 und fällt am Drop ins Leere (Mensch-
   * Modell: 33/168 im Ziel). AUS, weil medaillenwirksam: ab Länge 1200 trägt der Referenz-Blick −3° (11.27 statt 11.59 s
   * → Gold/VELOCITY/Autor sinken, index.json veraltet); [768, 1600] → 122/168, [768, 1000] → 64/112 bei 24–28°, aber
   * 5 Raster-Warnungen (Starts auf der Schürze fallen an der Verjüngung). Hebel für den Medaillen-Neubau (level3.md).
   */
  readonly q1Skirt: V2;
  /**
   * Checkpoint-Plattformen, Bogenlänge ihres Anfangs: CP1 auf Viertel 1, CP2 auf Viertel 3, CP3 auf Viertel 4 (vor dem
   * Drop auf R1). Die Luft-Trigger bleiben an den Drops. Früher lag je ein Keil-Pad AUF dem Grat am Drop — genau im
   * Flugband der Grundtechnik (Hull-Oberkante über dem Grat): 1114 → 80 u/s oder hinüber auf die andere Bahn (Review
   * Phase 3). Hinter der Landezone des Drops fliegt niemand mehr so hoch.
   */
  readonly padAt: readonly [number, number, number];
  /**
   * Unterkante der Plattform über dem Grat an ihrem Anfang: über der Grat-Bande (128) — sie läuft darunter durch, ohne
   * Lücke und damit ohne Stirn, an der Grat-Reiter anschlagen. Bandenreiter reichen mit dem Kopf bis ~44 u über den Grat.
   */
  readonly padLift: number;
  /** Querbereich der Plattformen (u, rechts positiv) und Spawn darauf (Bogenlänge ab Anfang, quer; rechts = Türkis). */
  readonly padV: V2;
  readonly padSpawn: V2;
  /**
   * Finne auf dem Grat von W1 ab dieser Bogenlänge (kurz hinter dem Brett) bis kurz vor sein Ende; dort übernimmt die
   * Bande von Viertel 1, 2 u weiter innen (ihre Stirn liegt verdeckt). Die Seite wählt man auf dem Brett.
   */
  readonly w1Fin: number;
  /**
   * Unsichtbare Clips über Finne (W1) und Bande (Viertel 1) bis zu diesen Bogenlängen, Oberkante `clipTop` über dem
   * Grat: auf ihre schräge Oberseite (Surf-Fläche) flog, wer an der Brettkante absprang bzw. von W1 an der Finne entlang
   * über den 128-u-Drop abhob — und fuhr dann AUF der Bande.
   */
  readonly clipTo: readonly [number, number];
  readonly clipTop: number;
  /**
   * Koralle-Seite der Grat-Bande: Abstand ihrer Fläche vom Grat (u) auf W1 und in Viertel 1–4 (lib: inset + 4) und
   * Rücksprung am Anfang jedes Stücks. Wer an der Bande entlangfuhr, stand an jeder Gehrungsfuge still: Innenflanke +
   * zwei Banden-Facetten im konkaven Knick = drei Ebenen, Source nullt dann das Tempo (735 → 3 u/s, Surf-Raster). Mit
   * Rücksprung verlässt man eine Facette, bevor die nächste kommt; je Viertel liegt die Fläche ~6 u näher am Grat, damit
   * die Folge-Bande (3.75° gedreht, 96 u früher begonnen) nie vor der vorigen steht.
   */
  readonly railFace: readonly [number, number, number, number, number];
  readonly railSaw: number;
  /**
   * Erste Bank eines Folgeviertels an Fuge a so weit nach außen (u): ohne das stand ihre Stirn 1.5 u vor der
   * Innenfläche der vorigen Bank — wer an der unsichtbaren Bande entlangglitt, prallte frontal darauf (Review).
   */
  readonly bankLead: number;
  /** Alle weiteren Bänke an Fuge a so weit nach außen (u): Sägezahn statt konkavem Knick (siehe litBand). */
  readonly bankSaw: number;
  /** Spawn quer zum Grat von W1 (u, rechts positiv). */
  readonly spawnV: number;
  /**
   * Auffang-Band auch unter dem Türkis-Fuß von W1 (outerCatch0): das Netz der sicheren Seite beginnt am Brett, nicht
   * erst in der Kehre. Ohne es starben W-Halter rechts der Finne nach 2.7–3.3 s auf W1 (12/12, Review Phase 3).
   */
  readonly w1Catch: boolean;
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
  finSkirt: 2048,
  q1Skirt: [0, 0],
  padAt: [700, 480, 1340],
  padLift: 136,
  padV: [-72, 72],
  padSpawn: [112, 40],
  w1Fin: 40,
  clipTo: [640, 640],
  clipTop: 248,
  railFace: [24, 28, 22, 16, 10],
  railSaw: 10,
  bankLead: 8,
  bankSaw: 6,
  spawnV: 48,
  w1Catch: true,
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
/** Checkpoint-Plattform: Länge entlang des Grats, Dicke; Luft-Trigger bis Plattform + CP_TALL/2 (wie lib.surfPad). */
const PAD_LEN = 224;
const PAD_THICK = 16;
const CP_TALL = 640;

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
      // Scheibe als Mond in der Lichtfarbe (sky.ts färbte jede Scheibe warm — sie blieb gelb, Phase 3).
      moon: true,
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
  // Spawn rechts der Finne: geradeaus ablaufen = rechte Flanke an der Finne entlang = TÜRKIS (sicher, W1-Band darunter).
  const spawn = S.p(-160, p.spawnV, 40);
  L.spawn(spawn, 0);
  {
    const [a, b] = aabbOf(S, [-384, 32], [-224, 224], [40, 200]);
    L.startZone(a, b);
  }
  // Chevrons ~170 u vor dem Spawn beidseits der Finne (Koralle links, Türkis rechts), ≤ 25° neben der Blickachse: weiter
  // außen lägen sie unter Tastenanzeige (unten links) und Hand (unten rechts, beide Default an). Spitze ≤ 32 (Brettkante).
  // Koralle zeigt 25° nach links: wer ihr folgt, geht links an der Finnen-Stirn vorbei (13 u Luft).
  L.chevron(S.p(10, -30, 40), 25, { tint: COL.coral, arm: 40, thick: 16, tag: 'startChevron' });
  L.chevron(S.p(10, 64, 40), -8, { tint: COL.teal, arm: 40, thick: 16, tag: 'startChevron' });

  // ── W1: volles Profil, eine Finne auf dem Grat teilt es in die beiden Bahnen ─
  const w1 = add('w1', new SurfPath({ start: [0, 0], yaw: 0, apex: 0, width: W, segs: [{ length: p.w1, slopeDeg: p.slope }], tag: 'w1', tint: COL.foam }));
  // Finne von kurz hinter dem Brett bis kurz vor das Ende von W1; dort übernimmt die Bande von Viertel 1, 2 u weiter
  // innen — ihre Stirn liegt verdeckt, die Bahnen sind vom Brett bis R1 durchgehend getrennt. Ohne Finne fuhr, wer
  // Grat-nah startete, über den 128-u-Drop auf den Grat, ins Pad oder an die Stirn der Bande von Viertel 1.
  L.add(ridgeFin(w1, p.w1Fin, w1.length - 8, p.railInset0 + 2, p.railFace[0], p.rail, 'w1-rail'));
  L.add(railClip(w1, p.w1Fin, p.clipTo[0], p.railInset0 + 2, p.railFace[0], p.clipTop));

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
    const opts: DropOpts = {
      overlap: OVERLAP,
      drop: first ? DROP : p.dropK,
      half: 'right',
      segs,
      tag: `outer${k + 1}`,
      tint: COL.teal,
      rail: k >= p.railFrom ? p.rail : 0,
      railTint: COL.teal,
      railInset: p.railInset0 - 2 * k,
    };
    // Grat-Bande durchgehend (auch an den Checkpoints: die Plattformen schweben darüber) — jede Folge-Bande beginnt
    // verdeckt hinter der vorigen, nirgends steht eine Stirn in der Bahn der Grat-Reiter.
    const o = drop(prev, opts);
    paths[`outer${k + 1}`] = o;
    L.add(...o.pieces.map((pc) => pc.brush), ...o.rails.map((h) => shapeRail(h, p.rail, p.railFace[k + 1], p.railSaw)));
    // Viertel 1: Clip über der Bande in der Landezone des 128-u-Drops (wer an der W1-Finne entlang abhebt).
    if (first) for (const pc of o.pieces) if (pc.s0 < p.clipTo[1]) L.add(railClip(o, pc.s0 + 1, pc.s0 + pc.length - 1, opts.railInset ?? 12, p.railFace[1] - p.railSaw, p.clipTop));
    outer.push(o);
    // Auffang-Band unter dem Außenfuß (die Außenflanke trägt nicht um die Kurve: wer nicht drückt, rutscht hinaus).
    // Viertel 1 folgt dem W1-Band (outerCatch0), jedes Folgeviertel seinem Vorgänger: erste Bank um bankLead zurück.
    if (p.catchWidth > 0) L.add(...litBand(o, { below: 32, width: p.catchWidth, bank: p.catchBank, tint: COL.sand, tag: `outerCatch${k + 1}` }, first && !p.w1Catch ? 0 : p.bankLead, p.bankSaw));
    // Innen: gleicher Grat (Rücken an Rücken), gleiche Drops, aber schmal — der Fuß liegt nah, wer absinkt, fällt.
    const i = add(
      `inner${k + 1}`,
      new SurfPath({ start: [o.o.start[0], o.o.start[1]], yaw: o.o.yaw, apex: o.o.apex, width: last ? p.innerWidth4 : p.innerWidth, flankDeg: p.innerFlank, half: 'left', segs, tag: `inner${k + 1}`, tint: COL.coral }),
    );
    inner.push(i);
  }
  // CP1 (Drop W1 → Viertel 1) und CP2 in der Kehrenmitte (Drop Viertel 2 → 3): Luft-Trigger um den Drop, Plattform über
  // der Bande hinter der Landezone. Respawn rechts (Türkis, geradeaus hinunter), links hinunter = Koralle.
  // CP1 quer bis über das Band (wie CP2): RunState zählt nur den nächsten Checkpoint — wer vom W1-Band aus an CP1
  // vorbeiflöge, käme nie ins Ziel.
  padOver(L, 1, w1, outer[0], outer[0], p, 0, [-W / 2, W / 2 + (p.w1Catch ? p.catchWidth + 64 : 0)]);
  padOver(L, 2, outer[1], outer[2], outer[2], p, 1, [-W / 2 - 32, W / 2 + p.catchWidth + 64]);
  notes.push(
    `Kehre: Grat R ${p.rK}, 4 × 45° à ${Q.toFixed(0)} u, ${p.slopeK}°, Drops ${p.dropK}; Linie innen ≈ ${((p.rK - 160) * Math.PI).toFixed(0)} u, ` +
      `außen ≈ ${((p.rK + 200) * Math.PI).toFixed(0)} u; Enden Grat außen ${outer[3].end.apex.toFixed(0)} / innen ${inner[3].end.apex.toFixed(0)}`,
  );

  // ── R1: volles Profil unter beiden Hälften, breit und 50° flach ─────────
  // Fängt beide Hälften UND das Auffang-Band. Unter 60°-Flanken muss eine 50°-Flanke am Fuß tiefer liegen:
  // (tan60 − tan50)·384 = 207 → Drop 256.
  const r1 = add('r1', drop(outer[3], { overlap: OVERLAP, drop: p.dropR1, lateral: p.r1Lateral, width: 1536, flankDeg: 50, half: 'both', segs: [{ length: p.r1, slopeDeg: p.slopeTail }], tag: 'r1', tint: COL.foam }));
  // CP3 (Drop Viertel 4 → R1): Plattform über der Bande von Viertel 4 VOR dem Drop — auf dem Grat von R1 lag das Pad
  // dort, wo die Koralle-Fahrer vom hohen Innenrand herunterkommen.
  padOver(L, 3, outer[3], r1, outer[3], p, 2, [-768 - 32, 768 + 32]);
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

  // Netz ab dem Brett: Band unter dem Türkis-Fuß von W1, 128 u (Drop) über dem Band von Viertel 1 — wer darauf hüpft,
  // fällt am Ende von W1 auf das nächste. Erst hier angehängt (vor den Kill-Kacheln, die es berücksichtigen müssen):
  // alle früheren Brush-Indizes bleiben, die Routen-Physik ist bitgleich.
  if (p.w1Catch && p.catchWidth > 0) L.add(...litBand(w1, { below: 32, width: p.catchWidth, bank: p.catchBank, tint: COL.sand, tag: 'outerCatch0' }, 0, p.bankSaw));
  // Finale breiter über eine Schürze unter dem Fuß (gleiche Flankenebene), ebenfalls hinten angehängt.
  if (p.finSkirt > fin.o.width) L.add(...flankSkirt(fin, p.finSkirt, COL.coral, 'finale-skirt'));
  // Koralle-Einstieg: Schürze unter dem Fuß der Innenbahn in Viertel 1 (W1-Profil reicht links bis 384, die Innenbahn
  // nur bis 192), zur Kehre hin auf die Bahnbreite verjüngt. Default aus (medaillenwirksam, siehe L3Params.q1Skirt).
  if (p.q1Skirt[0] > p.innerWidth) {
    const [wide, to] = p.q1Skirt;
    const at = (s: number): number => wide - (wide - p.innerWidth) * Math.min(1, s / to);
    L.add(...halfSkirt(inner[0], at, COL.coral, 'inner1-skirt'));
  }
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

/**
 * Checkpoint am Drop a → b mit einer Plattform über der Grat-Bande von `on` (a oder b), Anfang `p.padAt[i]` (Bogenlänge),
 * dem gekrümmten Grat folgend: Unterkante `padLift` über dem Grat am Anfang, PAD_THICK dick, Querbereich `padV`. Der
 * Luft-Trigger bleibt um den Drop (wie lib.surfPad) und reicht bis hinter den Spawn (Wiedereinstieg der Proben).
 */
function padOver(L: LevelBuilder, order: number, a: SurfPath, b: SurfPath, on: SurfPath, p: L3Params, i: number, span: V2): void {
  const s0 = p.padAt[i];
  const y0 = on.apexAt(s0) + p.padLift;
  const top = y0 + PAD_THICK;
  const pts: V3[] = [];
  for (const s of [s0, s0 + PAD_LEN]) {
    const f = on.frameAt(s);
    for (const v of p.padV) pts.push(f.p(0, v, y0), f.p(0, v, top));
  }
  L.add({ type: 'hull', points: pts, mat: 'checkpoint', tag: `cp${order}pad` });
  const fs = on.frameAt(s0 + p.padSpawn[0]);
  const spawn = fs.p(0, p.padSpawn[1], top);
  const fa = a.frameAt(a.length);
  const uN = on === b ? Math.max(360, s0 + 330 - OVERLAP) : 360;
  const footN = b.apexAt(OVERLAP + uN) - b.height;
  const [lo, hi] = aabbOf(fa, [-420, uN], span, [footN + 40, top + CP_TALL / 2]);
  L.checkpoint(order, lo, hi, spawn, fs.yaw);
}

/**
 * Finne auf dem Grat eines geraden Pfads im Querschnitt der Grat-Bande: Türkis-Fläche `inset` rechts, Koralle-Fläche
 * `face` links vom Grat, oben `height` über dem Grat (Koralle-Kante), Oberseite zur Türkis-Seite geneigt wie bei lib
 * (Türkis-Kante (2·inset + 4)·tan60 tiefer — flach wäre sie ein Laufsteg), unten in der Rampe.
 */
function ridgeFin(path: SurfPath, s0: number, s1: number, inset: number, face: number, height: number, tag: string): HullDef {
  const pts: Vec3Tuple[] = [];
  for (const s of [s0, s1]) {
    const f = path.frameAt(s);
    const apex = path.apexAt(s);
    const bot = apex - railDepth(face);
    pts.push(f.p(0, inset, apex + height - (2 * inset + 4) * TAN60), f.p(0, inset, bot), f.p(0, -face, apex + height), f.p(0, -face, bot));
  }
  return { type: 'hull', points: pts, mat: 'accent', tint: COL.teal, underTrim: true, tag };
}

const TAN60 = Math.tan(60 * DEG);

/**
 * So tief unter dem Grat endet eine Bande mit der Koralle-Fläche `face` links vom Grat: 12 u unter der Flanke dort.
 * Die lib-Bande endete 28 u unter dem Grat, an der Koralle-Seite 7–10 u ÜBER der Flanke — in die Tasche darunter geriet
 * die Hull-Ecke eines Bandenreiters schräg zur Achse (Flanke + Bande + Unterseite → 776 → 0 u/s).
 */
function railDepth(face: number): number {
  return face * TAN60 + 12;
}

/**
 * lib-Grat-Bande (SurfPath.railSection, Punkte je Fuge: oben/unten innen = Türkis, oben/unten außen = Koralle) mit
 * eigener Koralle-Fläche: `face` u links vom Grat, an Fuge a um `saw` zurückgesetzt (L3Params.railFace), Unterkante in
 * der Flanke (railDepth). Türkis-Fläche und Oberkanten bleiben.
 */
function shapeRail(h: HullDef, height: number, face: number, saw: number): HullDef {
  const P = h.points;
  const pts: Vec3Tuple[] = [];
  for (const [e, back] of [
    [0, saw],
    [4, 0],
  ] as const) {
    const [iT, iB, oT, oB] = [P[e], P[e + 1], P[e + 2], P[e + 3]];
    const w = Math.hypot(oB[0] - iB[0], oB[2] - iB[2]);
    const ux = (oB[0] - iB[0]) / w;
    const uz = (oB[2] - iB[2]) / w;
    // Grat: von der Türkis-Kante (inset rechts) quer zur Koralle-Seite; lib-Breite = 2·inset + 4.
    const inset = (w - 4) / 2;
    const gx = iB[0] + ux * inset;
    const gz = iB[2] + uz * inset;
    const f = face - back;
    const bot = oT[1] - height - railDepth(f);
    pts.push([iT[0], iT[1], iT[2]], [iB[0], bot, iB[2]], [gx + ux * f, oT[1], gz + uz * f], [gx + ux * f, bot, gz + uz * f]);
  }
  return { ...h, points: pts };
}

/**
 * Unsichtbarer Clip über einem Banden-Stück (1 u innerhalb der Bande: Türkis-Fläche `inset`, Koralle-Fläche `face` —
 * wer an ihr entlangfährt, berührt ihn nie), von 96 u über dem Grat bis `top`, Oberseite zur Türkis-Seite geneigt.
 */
function railClip(path: SurfPath, s0: number, s1: number, inset: number, face: number, top: number): HullDef {
  const pts: Vec3Tuple[] = [];
  const inner = inset - 1;
  const out = -(face - 1);
  for (const s of [s0, s1]) {
    const f = path.frameAt(s);
    const apex = path.apexAt(s);
    pts.push(f.p(0, inner, apex + top - (inner - out) * TAN60), f.p(0, inner, apex + 96), f.p(0, out, apex + top), f.p(0, out, apex + 96));
  }
  return { type: 'hull', points: pts, mat: 'accent', visible: false, tag: `${path.o.tag ?? 'rail'}-clip` };
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
function litBand(path: SurfPath, o: CatchBandOpts, lead: number, saw: number): HullDef[] {
  const out: HullDef[] = [];
  const lerp = (a: Vec3Tuple, b: Vec3Tuple, t: number, dy = 0): Vec3Tuple => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + dy, a[2] + (b[2] - a[2]) * t];
  let joint = 0;
  for (const h of catchBand(path, o)) {
    if (!h.tag?.endsWith('Bank')) {
      out.push(h);
      continue;
    }
    // catchBand-Punkte je Fugenende: Oberkante innen/außen, Unterkante innen/außen (Fuge a: 0–3, Fuge b: 4–7).
    const P = [...h.points];
    // Fuge a innen nach außen (entlang der Oberseite, die Schräge bleibt eben): jede Bank beginnt HINTER der vorigen,
    // wer an ihr entlanggleitet, verlässt die eine, bevor die nächste (im Knick der Kurve ihm entgegen) kommt.
    // Folgeviertel (`lead`): der Pfad beginnt auf der Sehne des Vorgängers, 3.75° weiter gedreht — die Stirn der ersten
    // Bank stand 1.5 u VOR der Innenfläche der vorigen (Lippe, 943 → 0 u/s). Sonst (`saw`): im konkaven Knick zweier
    // Bänke fing der Achsen-Bevel der nächsten die Hull-Ecke ab, wo die Bande achsparallel läuft (Kehrenmitte, −92 %).
    const back = joint === 0 && lead > 0 ? lead : saw;
    if (back > 0) {
      for (const [i, j] of [
        [0, 1],
        [2, 3],
      ] as const) {
        const l = Math.hypot(P[j][0] - P[i][0], P[j][2] - P[i][2]);
        P[i] = lerp(P[i], P[j], back / l);
      }
    }
    out.push({ ...h, points: P, visible: false });
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

/**
 * Schürze unter dem Fuß eines vollen Profils ('both'): setzt beide Flanken in ihrer Ebene bis zur Breite `width` fort,
 * ein Trapez je Stück zwischen altem und neuem Fuß. Die Stücke selbst bleiben unberührt — breiter gebaut änderten sich
 * ihre Flankenebenen in der letzten Stelle, und chaotische Läufe (fallen.md #72) verschoben die Bronze-Messung der
 * 3°-Hand über eine Rundungsstufe (25.99 → 26.02 s), obwohl keiner je an den Fuß kam.
 */
function flankSkirt(path: SurfPath, width: number, tint: string, tag: string): HullDef[] {
  const tan = Math.tan(path.flankDeg * DEG);
  const section = (j: SurfPath['joints'][number]): Vec3Tuple[] => {
    const [rx, rz] = rightOf(j.miter);
    // Alter Fuß genau wie SurfPath.section (gleiche Rechnung → gleiche Punkte, keine Fuge in der Flanke).
    const w = (path.o.width / 2) * j.stretch;
    const foot = j.apex - path.height;
    const w2 = (width / 2) * j.stretch;
    const low = j.apex - (width / 2) * tan;
    return [
      [j.x - rx * w, foot, j.z - rz * w],
      [j.x + rx * w, foot, j.z + rz * w],
      [j.x - rx * w2, low, j.z - rz * w2],
      [j.x + rx * w2, low, j.z + rz * w2],
    ];
  };
  const out: HullDef[] = [];
  for (let i = 0; i + 1 < path.joints.length; i++) {
    out.push({ type: 'hull', points: [...section(path.joints[i]), ...section(path.joints[i + 1])], mat: 'surf', tint, tag });
  }
  return out;
}

/**
 * Schürze unter dem Fuß einer Halbrampe: setzt die Flanke in ihrer Ebene bis zur Profilbreite `widthAt(s)` fort (Dreieck
 * je Fuge: Fuß, neuer Fuß, senkrecht unter dem Fuß). Stücke, an deren beiden Fugen nichts übersteht, fallen weg.
 */
function halfSkirt(path: SurfPath, widthAt: (s: number) => number, tint: string, tag: string): HullDef[] {
  const tan = Math.tan(path.flankDeg * DEG);
  const sgn = path.half === 'left' ? -1 : 1;
  const W2 = path.o.width / 2;
  const section = (j: SurfPath['joints'][number]): Vec3Tuple[] => {
    const [rx, rz] = rightOf(j.miter);
    // Fuß genau wie SurfPath.section; mindestens 1 u Überstand (sonst entartet die Hülle).
    const w = W2 * j.stretch;
    const foot = j.apex - path.height;
    const half = Math.max(W2 + 1, widthAt(j.s) / 2);
    const w2 = half * j.stretch;
    const low = j.apex - half * tan;
    return [
      [j.x + sgn * rx * w, foot, j.z + sgn * rz * w],
      [j.x + sgn * rx * w2, low, j.z + sgn * rz * w2],
      [j.x + sgn * rx * w, low, j.z + sgn * rz * w],
    ];
  };
  const out: HullDef[] = [];
  for (let i = 0; i + 1 < path.joints.length; i++) {
    const [a, b] = [path.joints[i], path.joints[i + 1]];
    if (widthAt(a.s) / 2 <= W2 && widthAt(b.s) / 2 <= W2) continue;
    out.push({ type: 'hull', points: [...section(a), ...section(b)], mat: 'surf', tint, tag });
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
  // Pfosten 96 u neben dem Fuß (beim Finale neben der Schürze — sonst stünden sie in ihrer Flanke).
  const archOver = (path: SurfPath, s: number, tint: string, width = path.o.width): void => {
    const fr = path.frameAt(s);
    const low = path.apexAt(s) - (width / 2) * Math.tan(path.flankDeg * DEG);
    L.arch(fr, 0, [-width / 2 - 96, width / 2 + 96], low - 200, path.apexAt(s) - low + 200 + 420, tint, 48, 'surfArch');
  };
  archOver(c.r1, 700, COL.sand);
  archOver(c.z, 900, COL.teal);
  archOver(c.fin, 300, COL.coral, Math.max(c.fin.o.width, c.p.finSkirt));
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
