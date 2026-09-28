/**
 * 02 SCHLEIFE — "Speed ist eine Entscheidung."
 *
 * Ein überhöhter Bhop-Ring (Velodrom) als Speed-Maschine. Die Ausfahrt nach
 * Norden ist EINE Linie mit Tempo-Stufen (gemessen, geradeaus ohne Strafen):
 * mit jedem Tempo landet man auf dem Vorfeld bzw. der Insel E1 und hüpft auf
 * die Surf-Kette, ab ~600 fliegt man über E1 direkt auf S0/S1, ab ~1040 auf S2.
 * Wer eine Stufe verfehlt, landet auf der darunterliegenden —
 * nie vor einer Stirnwand (designProbes: exitTiers, mit Auto-Hop). Danach fällt
 * eine Surf-Kette ohne einen einzigen Bodenkontakt bis zum Launch über die
 * Lücke ins Ziel. Die erste Rampe (S0) ist verzeihend: darunter eine geschlossene
 * Grube mit Rückweg aufs Vorfeld (buildS0Catch). Absicht, Speeds und Draufsicht:
 * .docs/research/level-design.md.
 *
 * Regeln:
 * - Jeder Checkpoint geht aus dem Stand weiter (Speed aus Höhe oder Ring).
 * - Die Ausfahrt ist schon nach dem ersten Durchgang (~0,4 Runden) offen; jede
 *   weitere Runde ist eine Entscheidung für Tempo (höhere Stufe) gegen Zeit.
 * - Die Innenbahn des Rings ist kürzer, hat aber zwei Lücken: Linienwahl.
 * - Surf-Übergänge sind "Drops": die Folgerampe beginnt UNTER dem Ende der
 *   vorigen (lib.surfDrop) — keine Stirnfläche im Weg, egal wie tief/schnell.
 * - Checkpoints in der Surf-Kette sind Luft-Trigger; der Respawn-Pad sitzt auf
 *   dem Grat der Folgerampe, man läuft nach vorn ab und liegt ~100 u tiefer
 *   auf der Flanke, die man die ganze Zeit vor sich sieht.
 */
import type { LevelFile, MaterialId } from '../../src/world/level/LevelFormat';
import { airTime, PHYS, reach, RESERVE } from './ballistics';
import type { Style, V2, V3 } from './lib';
import { Frame, LevelBuilder, aabbOf, orientedBox, Ring, SurfRamp, r3, yawTo } from './lib';
import { measureSurfSpeeds, SpeedCurve, SURF_GRID } from './physics';

/** Luft-Checkpoints reichen hoch genug, dass jede Linie über dem Rampenfuß sie schneidet. */
const CP_TALL = 640;

/** Anlaufbahn: Breite und seitlicher Versatz der beiden Bahnen hinter dem Start. */
const RUNWAY_W = 320;
const RUNWAY_SHIFT = 0;
/** Linie von Start und Anlaufbahn (z). So weit nördlich, dass die 320 breite Bahn vor dem Ring endet. */
const SF_Z = 1344;
/** Tiefe der Auffangmulden unter den Anlauf-Lücken: ein normaler Sprung (57 u) kommt heraus. */
const CATCH_DEPTH = 40;

const COL = {
  acid: '#9dff2e',
  cyan: '#2ef0ff',
  violet: '#9a5cff',
  magenta: '#ff3fd0',
  ice: '#a8d8ff',
  gold: '#ffc23d',
} as const;

/**
 * Tempo-Stufen der Ausfahrt, farbcodiert (höhere Stufe = mehr Tempo): Vorfeld
 * (jedes Tempo) cyan, E1 gold (Checkpoint-Farbe), S0/S1 direkt magenta (ab ~600),
 * S2 direkt violett (ab ~1040), direkt in den CP3-Trigger weiß (ab ~1300).
 * Dieselben Farben tragen die Lichtbalken am Ausfahrt-Tor (Stufen-Lichter).
 */
const TIER = { apron: '#2ef0ff', e1: '#ffc23d', s1: '#ff3fd0', s2: '#9a5cff', direct: '#ffffff' } as const;
/** Außenbahn-Segmente (5,625° je Segment) um die Ausfahrt T0 (φ ≈ 23°): gold wie ein Checkpoint. */
const EXIT_SEGMENTS: ReadonlySet<number> = new Set([2, 3, 4, 5]);
/** Bande am Außenrand: Höhe über der Außenkante (höher als ein Sprung, 57 u) und Dicke. */
const BOARD_H = 80;
const BOARD_T = 32;
/**
 * Offene Sektoren der Bande (φ in Grad): der Anflug von der Anlaufbahn und die
 * Ausfahrt — von 11,25° (wer außen auf der Linie zu T0 fährt, verlässt den Ring
 * bei ~14°) bis 45° (wer geradeaus nach Norden fährt, verlässt ihn über dem
 * Vorfeld bis x = 1184 bei ~40°).
 */
const BOARD_OPEN: ReadonlyArray<readonly [number, number]> = [
  [225, 270],
  [11.25, 45],
];

const DEG = Math.PI / 180;

/** Farbe der Start-Markierungen (palette.KIND_COLORS.start). */
const START_GLOW = '#46ff9e';

/**
 * Planungstempo an der Ausfahrt (inkl. 10 % Reserve): 90 % dessen, was eine
 * 3°-Hand (Gelegenheitsspieler, CS2-Parität) auf Dauer erhüpft. Seit dem
 * Vorfeld ist es keine Pflicht mehr (E1 geht mit jedem Tempo), sondern das
 * Planungstempo der Route und die Kante, ab der E1 per Sprung erreicht wird.
 */
const TIER1 = Math.round(0.9 * SpeedCurve.hand(3).top);

/** Surf-Rampen: 60°-Flanken, breit genug für jede Linie zwischen Grat und Fuß. */
const SURF_W = 768;
const SURF_SLOPE = 10;
/** Übergang: Folgerampe beginnt so weit vor dem Ende und so viel tiefer. */
const DROP_OVERLAP = 96;
const DROP = 128;
/** Route-Knoten liegen so tief unter dem Grat an der Ostflanke. */
const LINE_DEPTH = 320;

/**
 * S0, die Einstiegsrampe vor S1: Länge hinter der E1-Kante; Profil wie die Kette
 * (768 breit, 60°), axial flach. Die Linie liegt wie auf S1 LINE_DEPTH unter dem
 * First, an derselben x-Position: ein seitlicher Versatz der Linien kippt die
 * Surf-Achse zwischen den Knoten (eine schmalere 50°-S0 schickte den Surfer im
 * Ausfahrt-Raster 11° schräg über die Flanke), und jede Stufe zwischen S0- und
 * S1-Flanke ist eine Kante, an der schnelle Einstiege abprallen.
 */
const S0_AFTER_E1 = 672;
/** Achsgefälle von S0 hinter E1 (unter E1 liegt sie mit dessen 10°): flacher, Zeit zum Ausprobieren; jedes Grad weniger hebt die Kette dahinter um ~12 u. */
const S0_SLOPE = 4;
/**
 * Auffangfläche: so weit unter dem Fuß, so weit seitlich über die Füße hinaus; Bande
 * darauf. Unter dem Fuß wie an der L1-Rutsche, nicht höher an der Flanke: eine
 * Fläche, die die Flanke schneidet, fängt auch tiefe, aber haltbare Surf-Linien ab
 * (Ausfahrt-Raster: 23–35 von 600 Läufen landeten auf ihr und fielen am Ende neben S1).
 */
const S0_FLOOR_BELOW = 32;
/**
 * Streifenbreiten neben den Füßen: Ost breiter — wer von E1 schräg nach Nordost
 * springt, landete bei 96 u oben auf der Bande und hüpfte auf ihr aus der Grube.
 */
const S0_SIDE_W = 96;
const S0_SIDE_E = 192;
/** Quergang vor der S0-Südkappe (verbindet die Streifen; der Rückweg liegt im Osten). */
const S0_CORRIDOR = 128;
/** So weit reicht die Grube hinter dem S0-Ende unter den Anfang von S1. */
const S0_PIT_EXTRA = 256;
const S0_RAIL_H = 128;
/** Rückweg von der Auffangfläche aufs Vorfeld: Breite und Durchgang in der Ostbande (am Nordende der Grube). */
const S0_BACK_W = 128;
/** Oberes Ende des Rückwegs (u): neben dem Vorfeld, weit genug südlich für ≤ 40° Steigung. */
const S0_BACK_TOP = 1000;
const S0_BACK_GAP = 128;

/** Ring: Velodrom, 10° nach außen überhöht, 64 Segmente, gegen den Uhrzeigersinn. */
const RING = { center: [0, 0], radius: 1280, width: 512, segments: 64, top: 0, bankDeg: 10, thick: 64 } as const;
/**
 * Lücken der Innenbahn (Segmentbereiche [von, bis), 5,625° je Segment) im ersten
 * Durchgang: die Innenlinie spart ~1 s pro Runde, verlangt aber zwei getimte
 * Hops über je ~200 u. Die Außenbahn ist lückenlos.
 */
const INNER_GAPS: ReadonlyArray<readonly [number, number]> = [
  [52, 54],
  [58, 60],
];

export function buildLevel2(): LevelFile {
  const XL = 1344; // Ausfahrt-Linie (x)
  const T0z = -560;
  // Unter der letzten Kill-Zone (Probe weiter unten wirft, falls nicht).
  const killY = -3700;
  const L = new LevelBuilder({
    id: 'level2',
    name: '02 SCHLEIFE',
    subtitle: 'Speed ist eine Entscheidung.',
    // Platzhalter: build.ts leitet Par aus der 3°-Hand ab (gemessen, nicht geschätzt).
    parTime: 60,
    killY,
    music: { root: 'D', bpm: 132 },
    environment: {
      skyTop: '#1d1650',
      // Heller als früher (#2a1466 / #160f33): 73 % des Spawn-Bildes lagen unter Luma 0.1,
      // Höhen und Abstände las man nur an dünnen Linien (Look-Kritik).
      skyHorizon: '#3a1f8a',
      skyBottom: '#0a0c20',
      fogColor: '#231a4d',
      fogNear: 1500,
      fogFar: 6000,
      // Kalter Mond tief im Norden: die Surf-Kette fällt auf ihn zu.
      sunDir: [-0.25, 0.5, -1],
      sunColor: '#bce2ff',
      ambientSky: '#5a4abc',
      ambientGround: '#0b2a20',
      trimColor: COL.acid,
      trimColorAlt: COL.cyan,
      voidY: -4400,
    },
  });

  // ── RING: zwei Bahnen à 256 u, koplanar (gemeinsame Sehne auf r = 1280) ──
  // `ring` ist nur Mathe (Punkte, Höhen) über die volle Breite; die Brushes
  // kommen aus den Bahnen. Jedes vierte Segment leuchtet: beim Kreisen zählt
  // das Auge die Fugen → Tempo.
  const ring = new Ring({ ...RING });
  const segStyle =
    (offset: number, exit = false) =>
    (k: number): Style => {
      const g = (offset + k) % RING.segments;
      // Ausfahrt-Sektor der Außenbahn in Checkpoint-Gold: Trims und Fläche sagen "hier raus".
      if (exit && EXIT_SEGMENTS.has(g)) return { mat: 'checkpoint' };
      return g % 4 === 0 ? { mat: 'accent', tint: COL.acid } : { mat: g % 2 ? 'metal' : 'floor' };
    };
  const lane = RING.width / 2;
  const dPhi = 360 / RING.segments;
  const innerOpts = { center: RING.center, radius: RING.radius - lane / 2, width: lane, top: RING.top, bankDeg: RING.bankDeg, thick: RING.thick };
  // Außenbahn beginnt auf der Höhe, auf der die Innenbahn endet; Unterseite bleibt bei top − thick.
  const innerProbe = new Ring({ ...innerOpts, segments: RING.segments });
  const midY = innerProbe.hOut;
  const outer = L.ring({
    center: RING.center,
    radius: RING.radius + lane / 2,
    width: lane,
    segments: RING.segments,
    top: midY,
    bankDeg: RING.bankDeg,
    thick: midY - (RING.top - RING.thick),
    tag: 'ring',
    segmentStyle: segStyle(0, true),
    underTrim: true,
  });
  // Bande am Außenrand (Velodrom): wer mit W + gehaltener Leertaste kreist, lenkt in
  // der Luft nicht (W entlang der Fahrt gibt keinen Schub) und flog tangential vom Ring
  // — novice.ts "W+Space": 54 Tode in 300 s, der erste nach 12 s. Die Bande fängt das
  // ab (Tempo quer zur Bande geht verloren, der Rest bleibt). Offen bleiben die
  // Ausfahrt (Gold-Sektor) und der Anflug von der Anlaufbahn: die Lücke in der
  // leuchtenden Bande markiert zugleich die Ausfahrt.
  {
    const open = (phi: number): boolean => BOARD_OPEN.some(([a, b]) => phi >= a - 1e-6 && phi < b - 1e-6);
    for (let k = 0; k < RING.segments; k++) {
      const pa = k * dPhi;
      const pb = (k + 1) * dPhi;
      if (open(pa)) continue;
      const pts: V3[] = [];
      for (const phi of [pa, pb]) {
        for (const r of [outer.rOut, outer.rOut + BOARD_T]) {
          const [x, z] = outer.point(phi, r);
          pts.push([x, outer.bottom, z], [x, outer.hOut + BOARD_H, z]);
        }
      }
      L.add({ type: 'hull', points: pts, mat: 'metal', underTrim: true, tag: `ringBoard#${k}` });
    }
  }
  // Innenbahn: Bögen zwischen den Lücken (Segmentgrenzen wie die Außenbahn → koplanare Facetten).
  const gaps = [...INNER_GAPS].sort((a, b) => a[0] - b[0]);
  gaps.forEach((g, i) => {
    const next = gaps[(i + 1) % gaps.length];
    const from = g[1];
    const to = next[0] + (next[0] <= g[1] ? RING.segments : 0);
    L.ring({ ...innerOpts, segments: to - from, arc: [from * dPhi, to * dPhi], tag: 'ringIn', segmentStyle: segStyle(from), underTrim: true });
  });

  // ── START: Startplatte + kurze Hop-Linie im Südwesten, Blick nach Osten, Sprung auf den Ring ──
  // Start, Bahnen und Route auf einer Linie (z = SF_Z): mit Auto-Hop steuert W in der
  // Luft nicht — wer seitlich versetzt startet, driftet Hop für Hop weiter. Bahnen
  // 320 breit und mittig auf der Route (vorher 224, Route 48 u neben der Mitte:
  // Erstkontakt-Läufe fielen seitlich von der Bahn).
  const SF = new Frame(-2432, SF_Z, -90);
  const START_U: readonly [number, number] = [64, 448];
  L.platform(SF, START_U, [-224, 224], 160, { mat: 'start', tag: 'start' });
  L.spawn(SF.p(160, 0, 160), -90);
  {
    const [a, b] = aabbOf(SF, START_U, [-224, 224], [160, 320]);
    L.startZone(a, b);
  }
  // Zwei Lücken bis zur Absprungplatte: statt 4,6 s gerader Sprint gleich die ersten Hops.
  // Bahn endet außerhalb des Rings (geprüft unten, Südecke r > rOut).
  // Die letzte Bahn reicht tiefer (128): ihre Stirn schließt ohne Schlitz an die Auffangfläche vor dem Ring an.
  const runway = L.gapLine(SF, START_U[1], [
    { gap: 144, depth: 256, width: RUNWAY_W, shift: RUNWAY_SHIFT, top: 160, tag: 'runway1' },
    { gap: 176, depth: 416, width: RUNWAY_W, shift: RUNWAY_SHIFT, top: 160, thick: 128, tag: 'runway' },
  ]);
  L.node(SF.p(160, 0, 160), { minSpeed: 250, note: 'Start' });
  // Drei Leucht-Chevrons vor dem Spawn Richtung Anlauf (statt Textur-Pfeilen).
  for (const u of [256, 328, 400]) L.chevron(SF.p(u, 0, 160), SF.yaw, { tint: START_GLOW, arm: 72, thick: 22, tag: 'startChevron' });
  let edge = START_U[1];
  runway.forEach((p, i) => {
    L.node(SF.p(edge - 24, 0, 160), { jump: true, minSpeed: i === 0 ? 250 : PHYS.sprintSpeed, note: i === 0 ? 'Anlauf' : undefined });
    L.node(p.center, { minSpeed: PHYS.sprintSpeed });
    // Auffangmulde statt Kill-Zone (Erstkontakt mit gehaltener Leertaste: 10 % ohne Tod, fallen.md #46).
    L.catchDip(SF, [edge, p.u0], [RUNWAY_SHIFT - RUNWAY_W / 2, RUNWAY_SHIFT + RUNWAY_W / 2], 160, CATCH_DEPTH, { tag: `catch-runway${i + 1}` });
    edge = p.u1;
  });
  L.node(SF.p(1416, 0, 160), { jump: true, minSpeed: PHYS.sprintSpeed, note: 'Auf den Ring' });
  // Auffangfläche zwischen Bahnende und Ringrand: wer mit Auto-Hop zu kurz auf den
  // Ring springt, landet hier (14 u unter dem Ringrand: hochlaufen oder hüpfen).
  // Zum Ring hin endet sie auf einer Sehne zwischen zwei Punkten des Außenkreises —
  // dazwischen liegt sie unter der Ringfläche (unsichtbar im Ring-Volumen).
  {
    const uEnd = runway[1].u1;
    const vs = [RUNWAY_SHIFT - RUNWAY_W / 2, RUNWAY_SHIFT + RUNWAY_W / 2];
    for (const v of vs) {
      const [x, z] = SF.xz(uEnd, v);
      if (Math.hypot(x - RING.center[0], z - RING.center[1]) < ring.rOut + 4) throw new Error(`level2: Bahnende (${x}, ${z}) ragt in den Ring`);
    }
    const onCircle = (v: number): V3 => {
      const [, z] = SF.xz(uEnd, v);
      const x = -Math.sqrt(ring.rOut * ring.rOut - (z - RING.center[1]) ** 2) + RING.center[0];
      return [x, 0, z];
    };
    const edgeY = ring.hOut;
    const apronTop = r3(edgeY - 14);
    // Unter der Sehne muss die Ringfläche über der Auffangfläche liegen (sonst ragte sie durch).
    const [a, b] = [onCircle(vs[0]), onCircle(vs[1])];
    for (let k = 1; k < 16; k++) {
      const t = k / 16;
      const y = ring.surfaceY(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t);
      if (y < apronTop + 2) throw new Error(`level2: Auffangfläche vor dem Ring ragt bei t=${t} durch die Ringfläche (${y.toFixed(1)})`);
    }
    const corners: V3[] = [SF.p(uEnd, vs[0], 0), a, b, SF.p(uEnd, vs[1], 0)];
    const pts: V3[] = [];
    for (const c of corners) pts.push([c[0], apronTop, c[2]], [c[0], apronTop - 64, c[2]]);
    L.add({ type: 'hull', points: pts, mat: 'metal', tag: 'catch-ring' });
  }

  // CP1 auf dem Ring direkt hinter der Landung: der Ring ist lückenlos (Außenbahn),
  // ein Respawn hier baut Tempo neu auf, ohne erst die Anlaufbahn zu laufen.
  {
    const pts: Array<readonly [number, number]> = [];
    for (const phi of [250, 265, 280]) for (const r of [ring.rIn, ring.rOut]) pts.push(ring.point(phi, r));
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    L.checkpoint(1, [Math.min(...xs), -16, Math.min(...zs)], [Math.max(...xs), 400, Math.max(...zs)], ring.at(265, 1360), 265 - 360);
  }

  // Ring-Route: Landung bei ~242°, ein Durchgang bis zur Ausfahrt (φ ≈ 23° → Nord),
  // an den Innenbahn-Lücken auf der Außenbahn (r 1400).
  // Landeknoten auf der Anlauf-Linie (r 1480): der Sprint-Sprung trägt bis auf den Ring,
  // kürzere Sprünge landen auf der Auffangfläche davor.
  const land = ring.phiOf(-Math.sqrt(1480 ** 2 - SF_Z ** 2), SF_Z);
  // Nach dem Sprint-Absprung auf den Ring: ein Hop des unteren Bands.
  const RING_V0 = SpeedCurve.of(0.85).after(PHYS.sprintSpeed, 1);
  L.node(ring.at(land, 1480), { jump: true, minSpeed: RING_V0, note: 'Ring' });
  const RING_FROM = 255;
  const RING_TO = 360;
  for (let phi = RING_FROM; phi <= RING_TO; phi += 15) {
    const t = (phi - RING_FROM) / (RING_TO - RING_FROM);
    const r = Math.min(1400, 1280 + (phi - RING_FROM) * 4);
    L.node(ring.at(phi % 360, r), { jump: true, minSpeed: RING_V0 + (TIER1 - RING_V0) * t, note: phi === 285 ? 'Außenbahn' : undefined });
  }

  // ── AUSFAHRT: T0 am Ring, Vorfeld, E1, dann Surf ─────────────────────────
  const N = new Frame(XL, 0, 0); // u = Nord (-Z)
  const T0: V3 = [XL, ring.restY(XL, T0z), T0z];
  L.node(T0, { jump: true, minSpeed: TIER1, note: 'Ausfahrt' });
  // Ausfahrt sichtbar machen (Look-Kritik: die Kernentscheidung war unsichtbar):
  // drei gold leuchtende Chevrons auf der Außenbahn vor T0, Richtung Ausfahrt,
  // jeder mittig in einer Facette (Facetten sind eben, die Figur liegt auf).
  {
    for (const k of [0, 1, 2]) {
      const phi = (k + 0.5) * dPhi;
      const [x, z] = ring.point(phi, 1440);
      L.chevron([x, 0, z], yawTo([x, z], [T0[0], T0[2]]), { tint: COL.gold, arm: 64, thick: 20, surface: (px, pz) => ring.surfaceY(px, pz), tag: 'exitChevron' });
    }
    // Lichtbogen am Beginn des Gold-Sektors (φ = 16,9°, kurz vor T0): radial über beide
    // Bahnen, Pfosten im Ring-Inneren und außen — weiter nördlich stünde der äußere im Vorfeld.
    const gate = Frame.at([RING.center[0], RING.center[1]], Math.min(...EXIT_SEGMENTS) * dPhi);
    L.arch(gate, 0, [ring.rIn - 40, ring.rOut + 80], -240, 700, COL.gold, 48, 'exitGate');
    // Stufen-Lichter unter dem Torbalken: drei Leuchtbalken in den Farben der
    // Tempo-Stufen (unten S0/S1 ab ~600, Mitte S2 ab ~1040, oben direkt in CP3 ab ~1300) —
    // "höher = mehr Tempo", dieselben Farben tragen die Landeflächen. Statisch; eine
    // Kopplung an das Live-Tempo braucht eine Uniform im Weltmaterial (Handoff).
    const tiers: ReadonlyArray<readonly [string, number]> = [
      [TIER.s1, 300],
      [TIER.s2, 350],
      [TIER.direct, 400],
    ];
    for (const [tint, y] of tiers) L.add(orientedBox(gate, [-12, 12], [ring.rIn - 40, ring.rOut + 80], [y, y + 20], { mat: 'light', tint, collide: false, tag: 'tierLight' }));
  }

  // E1: 10°-Gefälle-Insel, Kante dort, wo das Planungstempo mit 10 % Reserve landet.
  const E1_TOP = -40;
  const E1_LEN = 384;
  const E1_W = 256;
  const E1_FALL = E1_LEN * Math.tan(10 * DEG);
  const e1Lip = reach(TIER1, T0[1] - E1_TOP) / RESERVE;
  const e1u0 = Math.round(-T0z + e1Lip + 16);
  const e1u1 = e1u0 + E1_LEN;
  L.ramp(N, [e1u0, e1u1], [-E1_W / 2, E1_W / 2], E1_TOP, E1_TOP - E1_FALL, { tag: 'exit1', mat: 'checkpoint' });
  // Vorfeld: schließt die Lücke Ring → E1. Mit Auto-Hop springt man auf der
  // Ausfahrt je nach Hop-Phase bis zu einer Sprungweite früher ab — über einer
  // Lücke fiel dann immer irgendeine Phase vor die 131 u hohe Stirn von E1
  // (Todesband, fallen.md #43). Das Vorfeld reicht unter den Ringrand (dort
  // liegt es in dessen Volumen, unsichtbar) und ist breiter als E1, damit auch
  // schräge Abgänge vom Ring (Blick Richtung T0) auf Boden treffen.
  const APRON_V: readonly [number, number] = [-160, 160];
  L.platform(N, [256, e1u0], APRON_V, E1_TOP, { tag: 'apron', mat: 'metal', tint: TIER.apron });
  // Die Hull ruht am Gefälle auf ihrer Bergkante (16 u zurück).
  const e1Rest = (u: number): number => E1_TOP - ((u - 16 - e1u0) / E1_LEN) * E1_FALL + 0.25;
  L.node(N.p(e1u0 - 160, 0, E1_TOP), { jump: true, minSpeed: TIER1, note: 'Vorfeld' });
  const e1Node = e1u0 + 200;
  L.node(N.p(e1Node, 0, e1Rest(e1Node)), { jump: true, minSpeed: TIER1, note: 'E1' });
  {
    // Hoch: Stufe 2/3 überfliegen E1 und bekommen den Checkpoint trotzdem.
    const [a, b] = aabbOf(N, [e1u0, e1u1], [-E1_W / 2, E1_W / 2], [E1_TOP - E1_FALL, E1_TOP + CP_TALL]);
    const sp = e1u0 + 72;
    L.checkpoint(2, a, b, N.p(sp, 0, e1Rest(sp)), 0);
  }

  // ── SURF-KETTE: Ostflanke, Grat westlich der Linie, fallende Achsen ─────
  // S0 (Einstiegsrampe) beginnt schon unter der E1-Vorderkante (First 24 u unter
  // E1, gleiches Gefälle): ihre Südkappe liegt unter E1/Vorfeld statt als Wand
  // neben E1 — wer westlich an E1 vorbeifällt, landet auf einer Flanke.
  const ridgeX = XL - E1_W / 2 - 48;
  // S1 hinter S0: zusammen 1024 u ab der E1-Kante wie vorher S1 allein — S2 … Ziel bleiben an ihrer Stelle.
  const S1_AFTER_S0 = 1024 - S0_AFTER_E1;
  // 32 u hinter der E1-Stirn, sonst läge die Südkappe koplanar auf ihr (Z-Fighting).
  const S1_UNDER = E1_LEN - 32;
  // S0 — die verzeihende erste Surf-Berührung (Polish-Runde 2). Vorher fiel man
  // von E1 ~420 u tief auf die S1-Flanke; wer nicht in die Rampe drückt, rutschte
  // ab und war nach ~3 s tot (novice.ts: 55–114 Tode in 300 s, alle an S1). Unter
  // S0 liegt jetzt eine geschlossene Grube (buildS0Catch): abrutschen kostet Zeit,
  // nie das Leben, und ein Rückweg führt aufs Vorfeld zum nächsten Versuch.
  // S0 und S1 sind EINE Kette im selben Profil, Stoß an Stoß (lib.surfChain): unter E1
  // mit dessen 10° (S0 muss unter E1 bleiben), hinter E1 flacher (S0_SLOPE) — dort
  // liegt die Auffangfläche —, dann S1 wieder mit 10°. Keine neue Kante: jede
  // Variante mit Drop oder Stufe zwischen S0 und S1 (50°- oder schmalere S0,
  // Übergangsstück 50° → 60°, Drop 64–128 u, S0-Längen 544–800) ließ im Ausfahrt-
  // Raster 1–45 von 600 Direktflügen an der Kante abprallen und neben S1/S2 fallen.
  const s0 = L.surfChain({
    start: [ridgeX, -(e1u1 - S1_UNDER)],
    yaw: 0,
    apex: E1_TOP - E1_FALL * (1 - S1_UNDER / E1_LEN) - 24,
    width: SURF_W,
    tag: 'surf0',
    tint: TIER.s1,
    pieces: [
      { length: S1_UNDER, slopeDeg: SURF_SLOPE },
      { length: S0_AFTER_E1, slopeDeg: S0_SLOPE },
    ],
  });
  const s0End = s0[s0.length - 1];
  const s1Apex = s0End.apexAt(s0End.o.length);
  const s1 = L.surfRamp({
    start: s0End.frame.xz(s0End.o.length),
    yaw: 0,
    length: S1_AFTER_S0,
    apex: s1Apex,
    apexEnd: s1Apex - S1_AFTER_S0 * Math.tan(SURF_SLOPE * DEG),
    width: SURF_W,
    tag: 'surf1',
    tint: TIER.s1,
  });
  const s0Catch = buildS0Catch(L, N, s0, s1, ridgeX - XL, e1u0);
  const s2 = L.surfDrop(s1, { overlap: DROP_OVERLAP, drop: DROP, length: 1280, slopeDeg: SURF_SLOPE, tag: 'surf2', tint: TIER.s2 });
  const s3 = L.surfDrop(s2, { overlap: DROP_OVERLAP, drop: DROP, length: 1280, slopeDeg: SURF_SLOPE, tag: 'surf3' });

  // S4 + FINALE: Surf-Kicker. Fällt steil (Speed aus Höhe), flacht in Knicken
  // ab und steigt am Ende an: Abflug schräg nach oben, ohne Bodenkontakt —
  // keine Reibungsfalle, kein Sprung-Timing. Stücke Stoß an Stoß (Kanten-Bevels machen die Fugen exakt).
  const s4Start = s3.o.length - DROP_OVERLAP;
  const s4 = L.surfChain({
    start: s3.frame.xz(s4Start),
    yaw: 0,
    apex: s3.apexAt(s4Start) - DROP,
    width: SURF_W,
    tag: 'surf4',
    pieces: [
      { length: 384, slopeDeg: SURF_SLOPE },
      { length: 768, slopeDeg: 25 },
      { length: 256, slopeDeg: 12 },
      { length: 256, slopeDeg: 4 },
      { length: 320, slopeDeg: -8 },
    ],
  });

  // Route: Surf-Knoten an der Ostflanke (Flag surf; Abschnitte bildet der Validator an den Drops).
  // minSpeed wird unten gemessen (unteres Band aus dem Stand), nicht geschätzt.
  const surfNodes: number[] = [];
  const surfNode = (r: SurfRamp, s: number, depth = LINE_DEPTH): void => {
    surfNodes.push(L.route.length);
    L.node(r.riderPos(s, 1, depth), { surf: true, note: r.o.tag });
  };
  // S0-Linie wie auf S1 LINE_DEPTH unter dem First (gleiche x-Linie).
  surfNode(s0End, 200);
  surfNode(s0End, 420);
  surfNode(s0End, S0_AFTER_E1 - 32);
  surfNode(s1, 240);
  surfNode(s2, 300);
  surfNode(s2, 760);
  surfNode(s2, 1200);
  surfNode(s3, 300);
  surfNode(s3, 760);
  surfNode(s3, 1200);
  surfNode(s4[0], 220);
  surfNode(s4[1], 300);
  surfNode(s4[1], 720);
  const kick = s4[s4.length - 1];
  const launch = kick.riderPos(kick.o.length - 8, 1, LINE_DEPTH);
  surfNodes.push(L.route.length);
  L.node(launch, { surf: true, note: 'Launch' });

  // Checkpoints der Surf-Kette: Luft-Trigger um den Übergang, Pad auf dem Grat der Folgerampe.
  surfCheckpoint(L, 3, s2, s3);
  surfCheckpoint(L, 4, s3, s4[0]);

  // ── Tempo-Band der Surf-Kette messen: aus dem Stand ab jedem Checkpoint
  // (Grundtechnik-Surfer mit Blick 0°/+2° und die 3°-Hand, die die Linie hält)
  // und jeder Einstieg des Surf-Rasters. minSpeed = 90 % des Langsamsten — das
  // untere Band, gegen das der Validator die Bahnen prüft.
  const measured = measureSurfSpeeds(L.build(), [{ surfer: 0 }, { surfer: 2 }, { bot: { aimNoiseDeg: 3 } }], { grid: SURF_GRID });
  for (const i of surfNodes) {
    const v = measured[i];
    if (!Number.isFinite(v)) throw new Error(`level2: Surf-Knoten ${i} wird aus dem Stand nicht erreicht`);
    L.route[i] = { ...L.route[i], minSpeed: Math.round(0.9 * v) };
  }
  const launchMin = Math.round(0.9 * measured[surfNodes[surfNodes.length - 1]]);

  // ── ZIEL: 1000 u unter dem Grat am Abflug, Lücke, Prallwand am Ende ──────
  // Mittig unter dem Grat: die Kette ist symmetrisch, beide Flanken führen hierher.
  // Lücke abgeleitet: mit dem unteren Band am Launch (minSpeed = 90 % des
  // langsamsten Abflugs aus dem Stand) bleiben 10 % Weitenreserve bis zur Kante
  // — konservativ ohne den Steigwinkel des Kickers gerechnet. Mit mehr Tempo
  // fliegt man weiter auf die 1700 u tiefe Plattform (Prallwand am Ende).
  const kickEndU = -kick.frame.xz(kick.o.length)[1];
  const lineV = ridgeX - XL;
  const kickSlope = Math.tan(8 * DEG);
  const launchTime = airTime(launch[1] - Math.round(kick.apexAt(kick.o.length) - 1000), false, 0);
  // Flug bis zur Kante = FIN_LIP − 8 (Knoten 8 u vor Kickerende, Hull trägt 16 u über die Kante).
  const FIN_LIP = Math.floor(((launchMin * launchTime) / RESERVE + 8) / 16) * 16;
  const FIN_DEPTH = 1700;
  const finTop = Math.round(kick.apexAt(kick.o.length) - 1000);
  const fin = L.platform(N, [kickEndU + FIN_LIP, kickEndU + FIN_LIP + FIN_DEPTH], [lineV - 448, lineV + 448], finTop, {
    tag: 'finish',
    mat: 'finish',
    thick: 128,
  });
  {
    // Hoch: wer mit Überspeed drüberfliegt, hat trotzdem gewonnen.
    const [a, b] = aabbOf(N, [fin.u0, fin.u1], [lineV - 448, lineV + 448], [finTop, finTop + 900]);
    L.finishZone(a, b);
  }
  // Prallwand: fängt Überflieger ab, statt sie ins Void zu schicken.
  L.platform(N, [fin.u1, fin.u1 + 64], [lineV - 448, lineV + 448], finTop + 900, { tag: 'backstop', mat: 'wall', thick: 1028, trim: false });
  // Ziel-Knoten geradeaus hinter dem Launch: der lange Flug braucht keine Kurve.
  L.node(fin.on(fin.u0 + 320, launch[0] - (XL + lineV)), { minSpeed: 250, note: 'Ziel' });

  // ── KILL-ZONEN: ~300–450 u unter jedem Abschnitt, statt 4000 u Void ─────
  const W = 2600; // seitliche Ausdehnung um die Linie
  // 32 u neben dem Rampenfuß: die Hull (±16) ist dann ganz draußen — keine Rettung mehr.
  const surfWest = ridgeX - SURF_W / 2 - 32;
  const surfEast = ridgeX + SURF_W / 2 + 32;
  // Ring (Fahrflächen ≥ 0) + Vorfeld (−40) bis zur E1-Vorderkante.
  // Nordgrenze vor der S0-Grube (deren Quergang reicht unter das Vorfeld).
  L.killZone([-4200, -720, -(s0Catch.start - 8)], [XL + W, -320, 2900], 'kill-ring');
  // Nordhälfte des Rings westlich der Surf-Kette (dort unten liegt S1 nicht).
  // Ostgrenze vor der Westbande der S0-Auffangfläche (die liegt in dieser Höhe).
  L.killZone([-4200, -720, -2000], [Math.min(surfWest, XL + s0Catch.v[0] - 32 - 64), -320, -(s0Catch.start - 8)], 'kill-ring-n');
  // Start und Anlaufbahn (y 160).
  L.killZone([-2800, -460, 1000], [-1000, -140, 1700], 'kill-runway');
  // Unter den Rampen (dort kommt nur hin, wer seitlich vorbeigefallen ist).
  const rampBase = (r: SurfRamp): number => Math.min(r.apexAt(0), r.apexAt(r.o.length)) - r.height;
  const rampKill = (r: SurfRamp, zFrom: number, zTo: number, tag: string): void => {
    const base = rampBase(r);
    L.killZone([XL - W, base - 700, zTo], [XL + W, base - 250, zFrom], tag);
  };
  const zAt = (r: SurfRamp, s: number): number => r.frame.xz(s)[1];
  rampKill(s1, -e1u0 + 8, zAt(s2, 0), 'kill-s1');
  rampKill(s2, zAt(s2, 0), zAt(s3, 0), 'kill-s2');
  rampKill(s3, zAt(s3, 0), zAt(s4[0], 0), 'kill-s3');
  // Neben den Rampen, knapp unter ihrem Fuß: wer seitlich vom Fuß rutscht, kommt nie
  // zurück — statt 1,4–1,7 s Fall bis unter die Kette sofort raus. In Stücken ≤ 512 u,
  // jedes 64 u unter dem tiefsten Fuß seines Stücks (die Achsen fallen, S1 um 250 u).
  const SIDE_SEG = 512;
  for (const r of [s1, s2, s3, ...s4]) {
    // Neben S1 erst hinter der S0-Auffangfläche (die liegt dort 32 u unter dem Fuß).
    const s0 = r === s1 ? s0Catch.end + 32 - -s1.frame.z : 0;
    const n = Math.ceil((r.o.length - s0) / SIDE_SEG);
    for (let k = 0; k < n; k++) {
      const sa = s0 + ((r.o.length - s0) * k) / n;
      const sb = s0 + ((r.o.length - s0) * (k + 1)) / n;
      const top = Math.min(r.apexAt(sa), r.apexAt(sb)) - r.height - 64;
      const zs: readonly [number, number] = [zAt(r, sb), zAt(r, sa)];
      const tag = `${r.o.tag ?? ''}${n > 1 ? `.${k + 1}` : ''}`;
      L.killZone([XL - W, killY, zs[0]], [surfWest, top, zs[1]], `kill-side-w-${tag}`);
      L.killZone([surfEast, killY, zs[0]], [XL + W, top, zs[1]], `kill-side-e-${tag}`);
    }
  }
  {
    const lowS4 = Math.min(...s4.map(rampBase));
    const low = Math.min(lowS4, finTop);
    L.killZone([XL - W, low - 700, -(fin.u1 + 600)], [XL + W, low - 300, zAt(s4[0], 0)], 'kill-final');
    if (low - 700 < killY) throw new Error(`level2: killY ${killY} über der letzten Kill-Zone (${low - 700})`);
    // Zu kurz geflogen: knapp unter der Zielkante statt 300 u tiefer.
    const [a, b] = aabbOf(N, [kickEndU + 8, fin.u0 - 8], [lineV - 448 - 200, lineV + 448 + 200], [low - 700, finTop - 160]);
    L.killZone(a, b, 'kill-gap');
  }

  // ── DEKO ────────────────────────────────────────────────────────────────
  // Nabe: Monolith in der Ringmitte, Blickanker beim Kreisen.
  L.tower([0, 0], 220, -1800, 2600, { crown: COL.acid });
  // Pylonen außen am Ring: vorbeifliegende Marken (nicht auf der Ausfahrt-Linie).
  for (let k = 0; k < 16; k++) {
    const phi = k * 22.5 + 11.25;
    // Nicht auf der Ausfahrt-Linie, nicht über S1 (reicht unter E1 bis an den Ring)
    // und nicht durch die Auffangfläche zwischen Anlaufbahn und Ring.
    if (phi < 60 || phi > 340 || (phi > 225 && phi < 250)) continue;
    const [x, z] = ring.point(phi, 1700);
    L.pylon([x, z], -900, 1150 + (k % 2) * 180, k % 2 ? COL.cyan : COL.acid, 20);
  }
  // Lautsprecher-Türme um den Ring (auf eigenen Sockeln im Nichts).
  for (let k = 0; k < 6; k++) {
    // φ 70 → 77: der Sockel schnitt sonst die Westbande der S0-Auffangfläche.
    const phi = k * 60 + (k === 1 ? 17 : 10);
    const [x, z] = ring.point(phi, 2150);
    L.decoBox([x - 90, -700, z - 90], [x + 90, -100, z + 90], { mat: 'dark' });
    L.speakerStack(Frame.at([x, z], phi + 90), 4, 150, -100);
  }
  // Tore über der Surf-Kette: Pfosten außerhalb der Rampenfüße, Balken hoch über dem Grat.
  const archOver = (r: SurfRamp, s: number, tint: string): void => {
    const f = new Frame(r.frame.x, 0, 0);
    const base = r.apexAt(s) - r.height - 200;
    L.arch(f, s - r.frame.z, [-r.o.width / 2 - 96, r.o.width / 2 + 96], base, r.height + 200 + 420, tint, 48);
  };
  // Ausfahrt-Tor über dem Nordende von E1: Pfosten außerhalb der S0-Bande und des Rückwegs.
  {
    const u = e1u1 + 32;
    const base = s0Catch.top(u) - 200;
    L.arch(N, u, [s0Catch.v[0] - 64, s0Catch.v[1] + 32 + S0_BACK_W + 64], base, E1_TOP + 420 - base, COL.magenta, 48);
  }
  archOver(s1, 300, COL.cyan);
  archOver(s2, 640, COL.violet);
  archOver(s3, 640, COL.cyan);
  archOver(s4[0], 500, COL.violet);
  // Ziel-Tor weit hinten: es rahmt die Landung, statt im Launch-Flug zu liegen (bei
  // fin.u0 + 96 flog die Kamera durch den Sturz, das Ziel war ~0.25 s verdeckt).
  // Validator: "Deko auf der Flugbahn".
  L.arch(N, fin.u0 + 500, [lineV - 420, lineV + 420], finTop, 560, COL.acid, 56, 'finishArch');
  // Ferne Türme links und rechts der Surf-Kette.
  const towers: Array<[number, number, number, number, string]> = [
    [-2400, -2400, 300, 3200, COL.violet],
    [4200, -2200, 260, 3600, COL.cyan],
    [-1800, -4600, 340, 4200, COL.acid],
    [4400, -5200, 300, 4400, COL.magenta],
    [-1600, -7600, 380, 4800, COL.cyan],
    [3800, -8600, 320, 5000, COL.acid],
    [3400, 2600, 260, 2400, COL.magenta],
    [-4200, 600, 300, 2800, COL.cyan],
  ];
  // Aus dem Void-Grid herauswachsend: sichtbar vom Ring (y 0) bis zum Ziel.
  for (const [x, z, w, h, crown] of towers) L.tower([x, z], w, -4500, h + 3600, { crown });

  // ── Planungszahlen ──────────────────────────────────────────────────────
  // Stufe 3 fliegt auf der Ausfahrt-Linie (x = XL): Flankenhöhe dort am Ende von S1.
  const s1End: V3 = [XL, s1.apexAt(s1.o.length) - (XL - ridgeX - 16) * Math.tan(60 * DEG), s1.frame.xz(s1.o.length)[1]];
  reportDesign({
    e1From: reach(PHYS.sprintSpeed, T0[1] - E1_TOP),
    tier3: solveSpeed((v) => {
      // Über S1 hinweg: am Ende von S1 noch über der Flanke (Linientiefe).
      const d = Math.abs(s1End[2] - T0z);
      const t = d / v;
      return T0[1] + PHYS.jumpImpulse * t - 0.5 * PHYS.gravity * t * t - s1End[1];
    }),
    launchNeed: solveSpeed((v) => v * airTime(launch[1] - finTop, false, v * kickSlope) - (FIN_LIP + 8 - 16)),
    finTop,
    length: fin.u1,
    finLip: FIN_LIP,
  });

  return L.build();
}

/**
 * Checkpoint am Drop-Übergang `a` → `b`: Luft-Trigger, den jede Linie über dem
 * Rampenfuß schneidet (auf der Flanke von a oder im Fall auf b), und ein
 * Respawn-Pad auf dem Grat von b, kurz hinter dem Ende von a. Vom Pad läuft man
 * nach vorn ab und liegt ~100 u tiefer auf der Ostflanke von b — die Rampe liegt
 * die ganze Zeit sichtbar vor einem (früher schwebte der Pad über der Flanke
 * von a, verdeckte sie und der Drop-In fiel ~600 u blind).
 */
function surfCheckpoint(L: LevelBuilder, order: number, a: SurfRamp, b: SurfRamp): void {
  const fb = new Frame(b.frame.x, b.frame.z, 0);
  // Pad als Keil auf dem Grat von b, bündig ab dem Ende von a (b-Koordinate
  // DROP_OVERLAP): Spitze auf Grathöhe, steigt über 96 u um PAD_RISE (22°,
  // begehbar), dann 128 u flach. Keine senkrechte Stirn nach Süden — wer hoch
  // an der Flanke von a fährt, rollt über den Keil statt anzustoßen (ein Pad mit
  // Stirn und Spalt zum Ende von a klemmte die 3°-Hand ein). Unterseite auf
  // Grathöhe: wer tiefer als ~40 u unter dem Grat surft, fährt darunter durch.
  const PAD_RISE = 40;
  const s0 = DROP_OVERLAP;
  const s1 = s0 + 96;
  const s2 = s1 + 128;
  const base = b.apexAt(s0);
  const padTop = r3(base + PAD_RISE);
  const v: readonly [number, number] = [-24, 72];
  const pts: Array<readonly [number, number, number]> = [];
  for (const vv of v) pts.push(fb.p(s0, vv, base), fb.p(s1, vv, padTop), fb.p(s2, vv, padTop), fb.p(s2, vv, base));
  L.add({ type: 'hull', points: pts, mat: 'checkpoint', tag: `cp${order}pad` });
  // Spawn 24 u östlich des Grats: wer geradeaus abläuft, hat die Hull ganz über
  // der Ostflanke (nicht auf dem First) und liegt ~100 u tiefer auf ihr.
  const sp = fb.p(s1 + 64, 24, padTop);
  // Trigger: um den Übergang, quer genau über den Rampen (wer daneben fällt, ist raus),
  // unten bis knapp über den Fuß von b am Nordende des Triggers. Gezählt wird die
  // Hull (Füße bis Kopf): wer mehr als ~30 u unter dem tiefsten Fuß ist, ist schon
  // abgestürzt und bekommt den Checkpoint nicht mehr (kein Jubel beim Sturz).
  const fa = new Frame(a.frame.x, a.frame.z, 0);
  const sEnd = a.o.length;
  const uN = sEnd + 360;
  const footN = b.apexAt(uN - (sEnd - DROP_OVERLAP)) - b.height;
  const [lo, hi] = aabbOf(fa, [sEnd - 420, uN], [-SURF_W / 2, SURF_W / 2], [footN + 40, padTop + CP_TALL / 2]);
  L.checkpoint(order, lo, hi, sp, 0);
}

/**
 * Auffangfläche unter S0 (Frame N: u nach Norden, v = x − XL): eine geschlossene
 * Grube mit Bande, Sockel und Rückweg aufs Vorfeld. Wer von S0 abrutscht, fällt
 * S0_FLOOR_BELOW tief neben den Fuß auf einen der beiden Streifen, statt ins Void;
 * ein Quergang vor der S0-Südkappe verbindet sie. Einziger Ausgang ist der Rückweg:
 * durch einen Durchgang in der Ostbande auf eine begehbare Rampe (≤ 40°) hinauf
 * auf Vorfeld-Höhe, gleich neben E1 — der Einstieg ist nochmal probierbar, ohne
 * Respawn und ohne Tod. Offene Nordenden waren tödlich: man lief vom Ende neben S1
 * ins Void (novice.ts "Edge" 65 Tode in 300 s).
 */
function buildS0Catch(L: LevelBuilder, N: Frame, s0: readonly SurfRamp[], s1: SurfRamp, ridgeV: number, apronEnd: number): { readonly top: (u: number) => number; readonly v: V2; readonly start: number; readonly end: number } {
  const u0 = -s0[0].frame.z;
  // Fußlinie der Kette (Knickzug über die Stöße), Fläche S0_FLOOR_BELOW darunter;
  // Knicke der Fläche 16 u hinter den Stößen (sonst lägen Stirnflächen von Fläche und
  // Sockel koplanar). Vorn ein Quergang (S0_CORRIDOR) vor der Südkappe, hinten 16 u Rand.
  // Fußlinie über S0 und den Anfang von S1 (Stoß an Stoß, gleiches Profil).
  const chain = [...s0, s1];
  const starts: number[] = [];
  let acc = u0;
  for (const r of chain) {
    starts.push(acc);
    acc += r.o.length;
  }
  const uEnd = starts[s0.length];
  const foot = (u: number): number => {
    let k = 0;
    while (k < chain.length - 1 && u > starts[k + 1]) k++;
    return chain[k].apexAt(u - starts[k]) - chain[k].height;
  };
  const fu0 = u0 - S0_CORRIDOR;
  // Die Grube reicht S0_PIT_EXTRA unter den Anfang von S1: wer spät auf S0 landet,
  // rutscht am Fuß entlang über das S0-Ende hinaus (novice.ts "Edge": Sprung an der
  // E1-Kante, 65 Tode in 300 s knapp hinter dem Ende der Fläche).
  const fu1 = uEnd + S0_PIT_EXTRA;
  if (fu1 > starts[chain.length - 1] + s1.o.length) throw new Error('level2: S0-Grube reicht über S1 hinaus');
  const slope0 = (foot(u0) - foot(u0 + 32)) / 32;
  const knots: Array<readonly [number, number]> = [[fu0, foot(u0) + slope0 * (u0 - fu0) - S0_FLOOR_BELOW]];
  for (let k = 1; k < chain.length && starts[k] + 16 < fu1; k++) knots.push([starts[k] + 16, foot(starts[k] + 16) - S0_FLOOR_BELOW]);
  knots.push([fu1, foot(fu1) - S0_FLOOR_BELOW]);
  const top = (u: number): number => {
    let k = 1;
    while (k < knots.length - 1 && u > knots[k][0]) k++;
    const [a, ya] = knots[k - 1];
    const [b, yb] = knots[k];
    return ya + ((yb - ya) * (u - a)) / (b - a);
  };
  const halfW = SURF_W / 2;
  const fv: V2 = [ridgeV - halfW, ridgeV + halfW];
  const wv: V2 = [fv[0] - S0_SIDE_W, fv[0]];
  const ev: V2 = [fv[1], fv[1] + S0_SIDE_E];
  const floor = (uu: V2, vv: V2, tag = 's0Catch'): void => {
    L.ramp(N, uu, vv, r3(top(uu[0])), r3(top(uu[1])), { mat: 'metal', tint: TIER.s1, thick: 32, tag });
  };
  // Streifen neben den Füßen (nicht unter der Rampe: am Nordende liegt dort S1, deren
  // Flanke eine durchgehende Platte anschneiden würde), Quergang vor der Südkappe.
  for (let k = 1; k < knots.length; k++) for (const vv of [wv, ev]) floor([knots[k - 1][0], knots[k][0]], vv);
  if (u0 > knots[1][0]) throw new Error('level2: S0-Quergang muss vor dem ersten Knick liegen');
  floor([fu0, u0], fv);
  // Sockel je Rampenstück: vom Fuß bis in die Fläche — kein Schlitz unter der Rampe.
  s0.forEach((r, k) => {
    const a = starts[k];
    const b = a + r.o.length;
    L.ramp(N, [a, b], fv, r3(foot(a)), r3(foot(b)), { mat: 'wall', trim: false, thick: S0_FLOOR_BELOW + 24, tag: 's0Base' });
  });
  // Bande, in Stücken je Knick. `sink`: so tief reicht sie unter die Fläche — Querbanden
  // stehen AUF den Streifen (16), Längsbanden daneben (32); gleich tiefe Unterkanten
  // oder bündige Enden wären koplanare Flächen (Z-Fighting).
  const rail = (uu: V2, vv: V2, sink: number): void => {
    const cuts = [uu[0], ...knots.map((q) => q[0]).filter((q) => q > uu[0] && q < uu[1]), uu[1]];
    for (let k = 1; k < cuts.length; k++) {
      L.ramp(N, [cuts[k - 1], cuts[k]], vv, r3(top(cuts[k - 1]) + S0_RAIL_H), r3(top(cuts[k]) + S0_RAIL_H), { mat: 'accent', tint: COL.magenta, thick: S0_RAIL_H + sink, tag: 's0Rail' });
    }
  };
  const backFoot = fu1 - 48 - S0_BACK_GAP;
  if (backFoot < knots[knots.length - 2][0]) throw new Error('level2: Rückweg-Fuß muss auf dem letzten Stück der S0-Fläche liegen');
  const bv: V2 = [ev[1] + 32, ev[1] + 32 + S0_BACK_W];
  rail([fu0 + 16, fu0 + 48], [wv[0] - 32, ev[1] + 32], 16);
  rail([fu0 + 48, fu1 - 48], [wv[0] - 32, wv[0]], 32);
  rail([fu0 + 48, backFoot], [ev[1], ev[1] + 32], 32);
  // Nord-Querbanden knapp über den Streifen (sink −6, flache Unterkante über schräger
  // Fläche: kein koplanarer Rest) und bündig am Rampenfuß: mit 16 u Spalt
  // rutschte man am Fuß entlang an ihnen vorbei.
  rail([fu1 - 48, fu1 - 16], [wv[0] - 32, wv[1]], -6);
  // Ost-Querbande über Streifen und Fuß-Plattform bis außen an deren Bande.
  rail([fu1 - 48, fu1 - 16], [ev[0], bv[1] + 32], -6);
  // Rückweg: Fuß-Plattform auf Flächenhöhe im Durchgang, Rampe nach Süden hinauf auf
  // Vorfeld-Höhe, oben ein Absatz, der bündig an die Ostkante des Vorfelds anschließt.
  floor([backFoot, fu1 - 48], [ev[1], bv[1]], 's0BackFoot');
  const backTop = -40; // Vorfeld (E1_TOP)
  const slope = Math.atan((backTop - top(backFoot)) / (backFoot - S0_BACK_TOP)) / DEG;
  if (slope > 40) throw new Error(`level2: Rückweg S0 zu steil (${slope.toFixed(1)}°)`);
  if (S0_BACK_TOP > fu0 - 8) throw new Error('level2: Rückweg muss südlich der S0-Grube (und von kill-ring) beginnen');
  // Schräge Platte (Hülle) statt Keil: ein Keil hat einen flachen Boden auf Fußhöhe und
  // ragte mit ~800 u Körper in kill-ring unter dem Vorfeld. Geteilt an der Nordkante
  // von kill-ring: der Validator misst den Abstand zur ganzen Fläche über der Zone.
  const slab = (uu: V2, vv: V2, y0: number, y1: number, thick: number, style: Style & { readonly mat: MaterialId }): void => {
    const pts: V3[] = [];
    for (const [u, y] of [[uu[0], y0], [uu[1], y1]] as const) for (const w of vv) pts.push(N.p(u, w, y), N.p(u, w, y - thick));
    L.add({ type: 'hull', points: pts, ...style });
  };
  const backY = (u: number): number => r3(backTop + ((top(backFoot) - backTop) * (u - S0_BACK_TOP)) / (backFoot - S0_BACK_TOP));
  for (const uu of [[S0_BACK_TOP, fu0 - 8], [fu0 - 8, backFoot]] as const) {
    slab(uu, bv, backY(uu[0]), backY(uu[1]), 64, { mat: 'metal', tint: TIER.s1, tag: 's0Back' });
    slab(uu, [bv[1], bv[1] + 32], backY(uu[0]) + 64, backY(uu[1]) + 64, 128, { mat: 'accent', tint: COL.magenta, tag: 's0BackRail' });
  }
  // Den Weg zeigen: der Durchgang liegt am Nordost-Ende, aus der Grube sieht man ihn
  // nicht. Chevrons in Vorfeld-Farbe ("zurück aufs Vorfeld") auf dem Oststreifen nach
  // Norden, auf der Fuß-Plattform nach Süden die Rampe hinauf.
  const stripV = (ev[0] + ev[1]) / 2;
  for (const du of [480, 320, 160]) {
    const [x, z] = N.xz(backFoot - du, stripV);
    L.chevron([x, 0, z], N.yaw, { tint: TIER.apron, arm: 64, thick: 20, surface: (px, pz) => top(-pz), tag: 's0BackMark' });
  }
  {
    const [x, z] = N.xz((backFoot + fu1 - 48) / 2, (bv[0] + bv[1]) / 2);
    L.chevron([x, 0, z], N.yaw + 180, { tint: TIER.apron, arm: 64, thick: 20, surface: (px, pz) => top(-pz), tag: 's0BackMark' });
  }
  // Fuß-Plattform: außen 64 u Bande (nach Norden schließt die Ost-Querbande).
  L.ramp(N, [backFoot, fu1 - 48], [bv[1], bv[1] + 32], r3(top(backFoot)) + 64, r3(top(fu1 - 48)) + 64, { mat: 'accent', tint: COL.magenta, thick: 128, tag: 's0BackRail' });
  // Oben ein Absatz bündig an der Ostkante des Vorfelds (v 160), dazwischen bis an die
  // Grube aufgefüllt; Süd- und Ostkante mit niedriger Bande (mit gehaltener Leertaste
  // hüpfte man sonst über den Absatz hinaus in kill-ring).
  L.platform(N, [S0_BACK_TOP - 128, S0_BACK_TOP], [160, bv[1]], backTop, { mat: 'metal', tint: TIER.apron, tag: 's0BackTop' });
  L.platform(N, [S0_BACK_TOP, apronEnd], [160, bv[0]], backTop, { mat: 'metal', tint: TIER.apron, tag: 's0BackTop' });
  L.platform(N, [S0_BACK_TOP - 160, S0_BACK_TOP - 128], [160, bv[1] + 32], backTop + 64, { mat: 'accent', tint: COL.magenta, thick: 96, tag: 's0BackRail' });
  L.platform(N, [S0_BACK_TOP - 128, S0_BACK_TOP], [bv[1], bv[1] + 32], backTop + 64, { mat: 'accent', tint: COL.magenta, thick: 96, tag: 's0BackRail' });
  return { top, v: [wv[0], ev[1]], start: fu0, end: fu1 };
}

interface DesignNumbers {
  readonly e1From: number;
  readonly tier3: number;
  readonly launchNeed: number;
  readonly finTop: number;
  readonly length: number;
  readonly finLip: number;
}

/** Kleinste Geschwindigkeit, für die f(v) ≥ 0 (Bisektion, f steigt mit v). */
function solveSpeed(f: (v: number) => number): number {
  let lo = 1;
  let hi = 6000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) >= 0) hi = mid;
    else lo = mid;
  }
  return hi;
}

function reportDesign(d: DesignNumbers): void {
  const f = (n: number): string => n.toFixed(0);
  console.log('  level2 Planung:');
  console.log(`    Ausfahrt: Vorfeld schließt die Lücke Ring → E1 (Sprint-Sprung von T0 trägt ${f(d.e1From)} u); Stufe 3 (über S1 auf S2): ab ${f(d.tier3)} u/s, mit Reserve ${f(d.tier3 * RESERVE)}`);
  console.log(`    Launch braucht ${f(d.launchNeed)} u/s (ohne Reserve); Lücke ${f(d.finLip)} u; Ziel auf y=${f(d.finTop)}, Strecke ${f(d.length)} u nach Norden`);
}
