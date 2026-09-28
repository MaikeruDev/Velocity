/**
 * T5 KURVEN — Kurven in der Luft (Plan 007; Prototyp lessonCurve, entschärft).
 *
 * Feld mit sieben Luft-Toren (Zonen 576 breit, 20–400 hoch) auf einem 180°-Bogen mit R 1200, links herum.
 * Stufen: 380 aufbauen, dann im Flug durch alle Tore, nie unter 300 u/s; bis 0.3 s Bodenkontakt am Stück
 * sind erlaubt (Landung + Smart-Hop). Wer rausfällt, beginnt den Bogen einfach neu (kein Tod). Die
 * Prototyp-Fassung (Tore 320/220, R 900, 330 u/s, jeder Boden-Tick) schaffte der ordentliche Anfänger
 * nur 4/20 (Plan 007 §1); mit den Plan-Stellschrauben (Tore 384, R 1200, 300 u/s, 0.3 s Boden) 12/20, erst
 * breitere Tore tragen (T5_DEFAULT). Bonus/Meister: derselbe Bogen mit 450 bzw. 600 u/s.
 */
import { HAND_MODELS } from '../../../src/player/bots/BeginnerHand';
import type { HandModel } from '../../../src/player/bots/BeginnerHand';
import type { Point2 } from '../../../src/player/bots';
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { hand, naive, p2, routeHand } from './drivers';
import type { HandPlan } from './drivers';
import { ENV_ADVANCED, LessonBuilder, TC } from './lessonLib';
import type { DriverContext, LessonCheck } from './lessonLib';

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
 * Gemessen (ordentlicher Anfänger, 20 Seeds, 120 s): Tore 384 breit 12/20 (Median 51.8 s), 512 17/20 (51.8 s),
 * 576 19/20 (38.0 s); R 1500/1800 und mehr Rand ändern nichts (12/11 von 20), 5 statt 7 Tore 14/20, 9 Tore 6/20.
 * Der Anfänger scheitert nicht am Tempo, sondern am verfehlten Tor: er kreist dann um das nächste (Kurve mit
 * fester Rate ist enger als die Tordistanz) oder prallt an die Bande. Also breitere Tore, Bogen wie geplant.
 */
export const T5_DEFAULT: T5Params = { r: 1200, gate: 288, n: 7, minSpeed: 300, margin: 1400 };

/** Torzentren auf dem Bogen: φ = 0 … 180° gegen den Uhrzeigersinn (links herum), Tor 0 bei (0, CZ). */
export function gatesOf(p: T5Params): Point2[] {
  return Array.from({ length: p.n }, (_, k) => {
    const phi = (k * (180 / (p.n - 1)) * Math.PI) / 180;
    return p2(Math.round(-p.r + p.r * Math.cos(phi)), Math.round(CZ - p.r * Math.sin(phi)));
  });
}

export const GATES: readonly Point2[] = gatesOf(T5_DEFAULT);

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
  // Luft-Tore: Zonen + Leucht-Pfosten links/rechts (Deko ohne Kollision) und Chevrons auf dem Boden.
  gates.forEach((g, k) => {
    B.zone(`tor${k}`, [g.x - GATE, 20, g.z - GATE], [g.x + GATE, 400, g.z + GATE]);
    const phi = (k * (180 / (N - 1)) * Math.PI) / 180;
    // Radial innen/außen: Pfosten markieren die Torbreite quer zur Fahrt.
    for (const s of [-1, 1]) {
      const px = g.x + s * GATE * Math.cos(phi);
      const pz = g.z - s * GATE * Math.sin(phi);
      L.decoBox([px - 12, 0, pz - 12], [px + 12, 260, pz + 12], { mat: 'light', tint: k === 0 ? TC.lime : TC.magenta });
    }
    const yaw = (phi * 180) / Math.PI; // Fahrtrichtung: φ = 0 → −Z, dann links herum
    L.chevron([g.x, 0, g.z], yaw, { tint: TC.cyan, arm: 72 });
  });
  L.spawn([0, 0, 800], 0);

  // Route (Vorführung): Anlauf auf x = 0 nach Norden, dann die Torzentren, dann zur Tür.
  L.node([0, 0, 800]);
  L.node([0, 0, -1000], { note: 'anlauf', minSpeed: 380 }); // 1
  gates.forEach((g, k) => L.node([g.x, 0, g.z], { note: `tor${k}`, minSpeed: 380 })); // 2..8
  L.node([dx, 0, -600]); // 9
  L.node([dx, 0, Z1 + 480], { note: 'portal' }); // 10

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
    text: 'IM FLUG DURCH ALLE 7 TORE\nNIE LANGSAMER ALS 300',
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

export const T5_CHECK: LessonCheck = {
  rows: [
    { model: 'ordentlicher Anfänger', from: 'anlauf', to: 'bogen', make: arcHand(HAND_MODELS.anfaenger), expect: { min: 14 }, level: 'error', verdicts: true },
    { model: 'geübter Anfänger', from: 'anlauf', to: 'bogen', make: arcHand(HAND_MODELS.geuebt), expect: { min: 18 }, level: 'warning' },
    { model: 'RouteFollower 5°', from: 'bogen', make: routeHand({ from: 1, to: 8, noise: 5, retry: true }), expect: { min: 18 }, level: 'warning' },
    { model: 'RouteFollower 3°', from: 'bogen', make: routeHand({ from: 1, to: 8, noise: 3, retry: true }), expect: { min: 18 }, level: 'warning' },
    { model: 'Fehler: W + Leertaste', from: 'anlauf', to: 'bogen', make: naive(p2(0, -1800)), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'RouteFollower 3° (Bonus 450)', from: 'bogen450', make: routeHand({ from: 1, to: 8, noise: 3, retry: true }), expect: { min: 10 }, level: 'warning' },
    { model: 'geübter Anfänger (Bonus 450)', from: 'bogen450', make: arcHand(HAND_MODELS.geuebt), expect: { min: 0 }, level: 'info' },
    { model: 'RouteFollower 2° (Meister 600)', from: 'bogen600', make: routeHand({ from: 1, to: 8, noise: 2, retry: true }), expect: { min: 0 }, level: 'info' },
  ],
};
