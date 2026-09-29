/**
 * T5 KURVEN — Kurven in der Luft (Plan 007; Prototyp lessonCurve, entschärft).
 *
 * Feld mit fünf Luft-Toren (alle 45°, 576 breit zwischen den Pfosten, 20–400 hoch) auf einem 180°-Bogen mit R 1200,
 * links herum. Stufen: 380 aufbauen, dann im Flug durch alle Tore, nie unter 300 u/s; bis 0.3 s Bodenkontakt am
 * Stück sind erlaubt (Landung + Smart-Hop). Wer rausfällt, beginnt den Bogen einfach neu (kein Tod). Die
 * Prototyp-Fassung (Tore 320/220, R 900, 330 u/s, jeder Boden-Tick) schaffte der ordentliche Anfänger nur 4/20
 * (Plan 007 §1). Bonus/Meister: derselbe Bogen mit 450 bzw. 600 u/s.
 */
import { HAND_MODELS } from '../../../src/player/bots/BeginnerHand';
import type { HandModel } from '../../../src/player/bots/BeginnerHand';
import type { Point2 } from '../../../src/player/bots';
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import type { PlayerSnapshot } from '../../../src/player/types';
import { Frame, orientedBox } from '../lib';
import { backStrafe, hand, naive, p2, routeHand } from './drivers';
import type { HandPlan } from './drivers';
import { ENV_ADVANCED, LessonBuilder, TC } from './lessonLib';
import type { Driver, DriverContext, LessonCheck } from './lessonLib';

const WALL_TOP = 320;
const Z1 = 1400;
const DOOR = 384;
/** Scheitel-Seite des Bogens: Mittelpunkt z (Tor 0 liegt bei (0, CZ)). */
const CZ = -2600;

/** Stellschrauben der Geometrie (Messung: tools/levels/training/check.ts t5). */
export interface T5Params {
  /** Bogenradius (u). */
  readonly r: number;
  /** Halbe Torbreite (Zone ±gate um das Torzentrum). */
  readonly gate: number;
  /** Anzahl Tore auf dem 180°-Bogen. */
  readonly n: number;
  /** Mindesttempo im Bogen (Pflicht). */
  readonly minSpeed: number;
  /** Abstand der Bande vom Bogen (x: links/rechts, z: hinter dem Scheitel). */
  readonly margin: number;
}

/**
 * Gemessen (ordentlicher Anfänger, 20 Seeds, 120 s; Tor-Zonen als Streifen = echte Breite zwischen den Pfosten,
 * s. gateStrip): 7 Tore (alle 30°) mit 384/512/576/640/704/768/896 u Breite 5/9/10/12/13/11/15 von 20 — er verfehlt
 * das Tor nach dem ersten Knick um 400–600 u (seine feste Drehrate zieht enger als der Bogen), die Breite hilft kaum.
 * R 900/1500/1800 bei 576: 10/7/14. **5 Tore (alle 45°) bei 576: 16/20** (640: 17), 4 Tore 18/20. Die frühere
 * Fassung (7 Tore, Quadrat-Zonen ±288) ergab 19/20 nur, weil ihre Zonen auf den Diagonalen bis 787 u breit waren und
 * sich die Zonen der Tore 1/2 und 4/5 überlappten — der Bogen war dort ein durchgehendes Band.
 */
export const T5_DEFAULT: T5Params = { r: 1200, gate: 288, n: 5, minSpeed: 300, margin: 1400 };

/** Torzentren auf dem Bogen: φ = 0 … 180° gegen den Uhrzeigersinn (links herum), Tor 0 bei (0, CZ). */
export function gatesOf(p: T5Params): Point2[] {
  return Array.from({ length: p.n }, (_, k) => {
    const phi = (k * (180 / (p.n - 1)) * Math.PI) / 180;
    return p2(Math.round(-p.r + p.r * Math.cos(phi)), Math.round(CZ - p.r * Math.sin(phi)));
  });
}

export const GATES: readonly Point2[] = gatesOf(T5_DEFAULT);

/** Halbe Dicke eines Tor-Streifens quer zur Linie (u): die Hull (±16) überlappt ihn bei jedem Tempo in einem Tick. */
const STRIP = 24;
/** Tor-Rahmen: Pfostenstärke (auch Sturzhöhe) und Oberkante der Pfosten (u). */
const GATE_POST = 24;
const GATE_TOP = 260;
/** Tor-Farben: Tor 0 lime (Start), dann Magenta mit sinkender Helligkeit — das hellste Tor im Blick ist das nächste. */
const GATE_TINTS = [TC.lime, '#ff3fd0', '#d634af', '#ad2a8e', '#85206d'] as const;
const gateTint = (k: number): string => GATE_TINTS[Math.min(k, GATE_TINTS.length - 1)];

/**
 * Zone eines Luft-Tors bei Bogenwinkel φ (Zonen sind achsparallel): ein dünner Streifen durch das Torzentrum quer zur
 * Hauptrichtung der Fahrt (Fahrt (−sin φ, −cos φ)) — entlang x, wenn sie eher entlang z geht, sonst entlang z. Halbe
 * Länge = halbe Torbreite / |cos| bzw. |sin|: wer parallel zur Tangente zwischen den Pfosten (radial ±gate) hindurch
 * fliegt, kreuzt den Streifen genau auf dieser Länge — jedes Tor ist quer zur Fahrt gleich breit wie der
 * Pfostenabstand. Die frühere Fassung (Quadrate ±gate) war auf den Diagonalen bis 576·(cos + sin) ≈ 787 u breit, und
 * die Nachbarzonen 1/2 und 4/5 überlappten sich (Mittenabstand 439 < 576).
 */
export function gateStrip(g: Point2, phi: number, gate: number): [[number, number, number], [number, number, number]] {
  const c = Math.abs(Math.cos(phi));
  const s = Math.abs(Math.sin(phi));
  if (c >= s) {
    const h = Math.round(gate / c);
    return [
      [g.x - h, 20, g.z - STRIP],
      [g.x + h, 400, g.z + STRIP],
    ];
  }
  const h = Math.round(gate / s);
  return [
    [g.x - STRIP, 20, g.z - h],
    [g.x + STRIP, 400, g.z + h],
  ];
}

export function buildT5(p: T5Params = T5_DEFAULT): LevelFile {
  const R = p.r;
  const CX = -R;
  const N = p.n;
  const GATE = p.gate;
  const gates = gatesOf(p);
  const X0 = CX - R - p.margin;
  const X1 = p.margin;
  const Z0 = CZ - R - p.margin;
  const B = new LessonBuilder({ id: 't5', name: 'KURVEN', subtitle: 'Im Flug um die Kurve.', lesson: 5, group: 'advanced', killY: -600, environment: ENV_ADVANCED, turnBand: true });
  const L = B.L;
  const t = 64;
  L.box([X0, -64, Z0], [X1, 0, Z1], { mat: 'floor', tag: 'feld' });
  L.box([X0 - t, 0, Z0 - t], [X1 + t, WALL_TOP, Z0], { mat: 'wall', tag: 'bande-n' });
  L.box([X1, 0, Z0], [X1 + t, WALL_TOP, Z1], { mat: 'wall', tag: 'bande-o' });
  L.box([X0 - t, 0, Z0], [X0, WALL_TOP, Z1], { mat: 'wall', tag: 'bande-w' });
  // Südbande mit Tür unter dem Bogen-Ende (x = −2R), dahinter die Portal-Nische.
  const dx = 2 * CX;
  L.box([X0 - t, 0, Z1], [dx - DOOR / 2, WALL_TOP, Z1 + t], { mat: 'wall', tag: 'bande-s1' });
  L.box([dx + DOOR / 2, 0, Z1], [X1 + t, WALL_TOP, Z1 + t], { mat: 'wall', tag: 'bande-s2' });
  L.box([dx - DOOR / 2, -64, Z1], [dx + DOOR / 2, 0, Z1 + 640], { mat: 'floor', tag: 'nische' });
  L.box([dx - DOOR / 2 - t, 0, Z1 + t], [dx - DOOR / 2, WALL_TOP, Z1 + 640], { mat: 'wall', tag: 'nische-w' });
  L.box([dx + DOOR / 2, 0, Z1 + t], [dx + DOOR / 2 + t, WALL_TOP, Z1 + 640], { mat: 'wall', tag: 'nische-o' });
  L.box([dx - DOOR / 2 - t, 0, Z1 + 640], [dx + DOOR / 2 + t, WALL_TOP, Z1 + 704], { mat: 'wall', tag: 'nische-s' });
  B.gate('ausgang', [dx - DOOR / 2, 0, Z1], [dx + DOOR / 2, WALL_TOP, Z1 + 24], TC.amber);
  B.portalZ(dx, Z1 + 480, 0, 256, TC.lime);
  // Luft-Tore als Tore (Review rv-tc3: zwei dünne Pfosten je Tor waren vom Tor 0 aus zehn gleiche pinke Striche, kein
  // Tor und kein Bogen lesbar): Rahmen aus zwei Pfosten und leuchtendem Sturz quer zur Fahrt, Schwelle als Leuchtlinie
  // auf dem Boden. Tor 0 lime (Start), danach Magenta von hell nach dunkel — das hellste Tor im Blick ist das nächste
  // (vorbei geflogene liegen hinter einem). Chevrons doppelt so groß ZWISCHEN den Toren auf dem Bogen: sie zeigen die
  // Kurve und liegen nicht koplanar auf der Schwelle.
  gates.forEach((g, k) => {
    const phi = (k * (180 / (N - 1)) * Math.PI) / 180;
    const [min, max] = gateStrip(g, phi, GATE);
    B.zone(`tor${k}`, min, max);
    const yaw = (phi * 180) / Math.PI; // Fahrtrichtung: φ = 0 → −Z, dann links herum
    const f = Frame.at([g.x, g.z], yaw); // u = Fahrt, v = radial nach außen
    const tint = gateTint(k);
    const hp = GATE_POST / 2;
    for (const s of [-1, 1]) L.add(orientedBox(f, [-hp, hp], [s * GATE - hp, s * GATE + hp], [0, GATE_TOP], { mat: 'light', tint, collide: false, tag: `tor${k}-pfosten` }));
    L.add(orientedBox(f, [-hp, hp], [-GATE - hp, GATE + hp], [GATE_TOP, GATE_TOP + GATE_POST], { mat: 'light', tint, collide: false, trim: false, tag: `tor${k}-sturz` }));
    L.marking(f, [[-8, -GATE], [8, -GATE], [8, GATE], [-8, GATE]], 0, tint, `tor${k}-schwelle`);
    if (k + 1 < N) {
      const m = ((k + 0.5) * (180 / (N - 1)) * Math.PI) / 180;
      L.chevron([Math.round(-R + R * Math.cos(m)), 0, Math.round(CZ - R * Math.sin(m))], (m * 180) / Math.PI, { tint: TC.cyan, arm: 144, thick: 32 });
    }
  });
  // Anflug: ein Chevron vor Tor 0 in Richtung Bogen.
  L.chevron([gates[0].x, 0, gates[0].z + 400], 0, { tint: TC.cyan, arm: 144, thick: 32 });
  L.spawn([0, 0, 800], 0);

  // Route (Vorführung): Anlauf auf x = 0 nach Norden, dann die Torzentren, dann zur Tür.
  L.node([0, 0, 800]);
  L.node([0, 0, -1000], { note: 'anlauf', minSpeed: 380 }); // 1
  gates.forEach((g, k) => L.node([g.x, 0, g.z], { note: `tor${k}`, minSpeed: 380 })); // 2..8
  L.node([dx, 0, -600]); // 9
  L.node([dx, 0, Z1 + 480], { note: 'portal' }); // 10

  // Vorführung (Training.SteerDemo): die Demo-Hand fliegt von Tor zu Tor, eine Seite je Hop, Rate aus der Kursabweichung —
  // wie ein Mensch, der das nächste Tor sieht. Der RouteFollower wechselte A/D ~20×/s (Showkeys flackerten, bis 940 u/s).
  const demo = { kind: 'route', from: 0, to: 1 + N, seconds: 25 } as const;
  B.stage({
    id: 'anlauf',
    title: 'ANLAUF',
    text: 'BAU TEMPO AUF: 380\nHÜPFEN UND STRAFEN WIE IN T3',
    task: { kind: 'speed', min: 380 },
    spawn: { pos: [0, 0, 800], yaw: 0 },
    demo,
  });
  B.stage({
    id: 'bogen',
    title: 'DER BOGEN',
    text: `IM FLUG DURCH ALLE ${N} TORE\nNIE LANGSAMER ALS ${p.minSpeed}`,
    task: { kind: 'course', zones: gates.map((_, k) => `tor${k}`), minSpeed: p.minSpeed, airborne: true, groundGrace: 0.3 },
    opens: ['ausgang'],
    demo,
    tips: [
      { on: 'stuck', after: 25, text: 'KURVE = EINE SEITE HALTEN:\nA + MAUS LINKS, SANFT WEITERZIEHEN' },
      { on: 'land', after: 0.5, text: 'NICHT STEHEN BLEIBEN:\nLEERTASTE GEDRÜCKT HALTEN' },
    ],
  });
  B.stage({
    id: 'bogen450',
    title: 'BONUS 450',
    text: 'DER BOGEN NOCHMAL\nNIE LANGSAMER ALS 450',
    task: { kind: 'course', zones: gates.map((_, k) => `tor${k}`), minSpeed: 450, airborne: true, groundGrace: 0.3 },
    rank: 'bonus',
    demo,
  });
  B.stage({
    id: 'bogen600',
    title: 'MEISTER 600',
    text: 'MEISTER: DER BOGEN MIT 600',
    task: { kind: 'course', zones: gates.map((_, k) => `tor${k}`), minSpeed: 600, airborne: true, groundGrace: 0.3 },
    rank: 'master',
    demo,
  });
  return B.build();
}

/**
 * Menschen-Hand für den Bogen: Tempo aufbauen im Zickzack Richtung Tor 0; vor dem ersten Tor aus dem
 * Süden direkt darauf zu, sonst erst zurück auf die Anlauflinie (1200 südlich). Im Kurs steuert sie je
 * Landung zur Seite des nächsten Tors (Muster 'steer') — so fliegt ein Mensch den Bogen: sieht das Tor,
 * zieht hin. Fähigkeiten (Rate, Verzug, Fehl-Hops) kommen unverändert aus dem Modell.
 */
export function arcHand(model: HandModel, p: T5Params = T5_DEFAULT) {
  const GATES = gatesOf(p);
  const approach = p2(GATES[0].x, GATES[0].z + 1200);
  return hand(model, (si, s, session): HandPlan => {
    if (si === 0) return { pattern: 'zigzag', goal: GATES[0] };
    const count = session.stageCount;
    if (count > 0) return { pattern: 'steer', goal: GATES[Math.min(GATES.length - 1, count)] };
    const south = s.pos.z > GATES[0].z + 250 && Math.abs(s.pos.x - GATES[0].x) < 600;
    return south ? { pattern: 'steer', goal: GATES[0] } : { pattern: 'steer', goal: approach };
  });
}

/**
 * W-Lenker (T2-Technik): W + Leertaste gehalten, Blick auf das nächste Tor — die Luftlenkung fliegt den Bogen mit
 * 315 u/s. Ohne die A/D-Pflicht der Session bestand er DER BOGEN 20/20 in 22 s, schneller als der Anfänger mit A/D.
 */
function wSteer(ctx: DriverContext): Driver {
  let i = 0;
  const goal = (s: PlayerSnapshot): Point2 => {
    if (i < GATES.length - 1 && Math.hypot(GATES[i].x - s.pos.x, GATES[i].z - s.pos.z) < 250) i++;
    return GATES[i];
  };
  return naive(goal)(ctx);
}

export const T5_CHECK: LessonCheck = {
  rows: [
    { model: 'ordentlicher Anfänger', from: 'anlauf', to: 'bogen', make: arcHand(HAND_MODELS.anfaenger), expect: { min: 14 }, level: 'error', verdicts: true },
    { model: 'geübter Anfänger', from: 'anlauf', to: 'bogen', make: arcHand(HAND_MODELS.geuebt), expect: { min: 18 }, level: 'warning' },
    { model: 'RouteFollower 5°', from: 'bogen', make: routeHand({ from: 1, to: 1 + T5_DEFAULT.n, noise: 5, retry: true }), expect: { min: 18 }, level: 'warning' },
    { model: 'RouteFollower 3°', from: 'bogen', make: routeHand({ from: 1, to: 1 + T5_DEFAULT.n, noise: 3, retry: true }), expect: { min: 18 }, level: 'warning' },
    { model: 'Fehler: W + Leertaste', from: 'anlauf', to: 'bogen', make: naive(p2(0, -1800)), expect: { max: 0 }, level: 'error', seconds: 60 },
    // Ohne A/D (A/D-Pflicht der Session): vorher bestanden nur W 180/360 °/s 20/20 bzw. 18/20 und der W-Lenker 20/20.
    { model: 'Fehler: nur W + Maus 180 °/s', from: 'anlauf', to: 'bogen', make: arcHand({ ...HAND_MODELS.nurW, name: 'nur W 180', rateDeg: 180 }), expect: { max: 0 }, level: 'error', verdicts: true },
    { model: 'Fehler: nur W + schnelle Maus 360 °/s (Bogen)', from: 'bogen', make: arcHand(HAND_MODELS.nurWSchnell), expect: { max: 0 }, level: 'error', verdicts: true },
    { model: 'Fehler: W-Lenker (T2-Technik, Bogen)', from: 'bogen', make: wSteer, expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: Rückwärts-Strafer A + Maus rechts 90 °/s', from: 'anlauf', to: 'bogen', make: backStrafe(90), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    { model: 'Fehler: gegen die Maus', from: 'anlauf', to: 'bogen', make: arcHand(HAND_MODELS.gegen), expect: { max: 0 }, level: 'error', verdicts: true },
    { model: 'Fehler: gegen die schnelle Maus 360 °/s', from: 'anlauf', to: 'bogen', make: arcHand(HAND_MODELS.gegenSchnell), expect: { max: 0 }, level: 'error', verdicts: true },
    { model: 'Fehler: ohne Maus', from: 'anlauf', to: 'bogen', make: arcHand(HAND_MODELS.keineMaus), expect: { max: 0 }, level: 'error', verdicts: true },
    { model: 'RouteFollower 3° (Bonus 450)', from: 'bogen450', make: routeHand({ from: 1, to: 1 + T5_DEFAULT.n, noise: 3, retry: true }), expect: { min: 10 }, level: 'warning' },
    { model: 'geübter Anfänger (Bonus 450)', from: 'bogen450', make: arcHand(HAND_MODELS.geuebt), expect: { min: 0 }, level: 'info' },
    { model: 'RouteFollower 2° (Meister 600)', from: 'bogen600', make: routeHand({ from: 1, to: 1 + T5_DEFAULT.n, noise: 2, retry: true }), expect: { min: 0 }, level: 'info' },
  ],
};
