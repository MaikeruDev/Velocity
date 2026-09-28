/**
 * T6 CROUCH-JUMP — erst springen, dann ducken (Plan 007; Prototyp lessonCrouch, v2-Entwurf §3 T6).
 *
 * Gerade Halle Richtung −Z (768 breit), eine Treppe aus Kanten:
 *   STUFE      48 u: normal springen reicht (Sprung 57 + Kanten-Assist 5).
 *   KANTEN     drei Kanten à 66 u (Level-Regel "Crouch-Kanten ≥ 66", movement.md §5): ohne Ducken kommt
 *              man höchstens 63.5 u hoch, mit Ducken in der Luft 80. Jede Landung oben zählt (crouchLand).
 *              Leuchtband ↑C 100–180 u vor jeder Wand = Absprungfenster.
 *   Bonus HOCH zwei Kanten à 72 u: 3 u unter der Crouch-Reichweite aus dem Lauf, Fenster 20–140 statt 20–180
 *              (Band 60–140).
 *   Meister    FLUSS: die drei 66er-Kanten in einem Zug, ohne stehen zu bleiben, nie unter 250 u/s
 *              (Rhythmus: der letzte Hop jeder Stufe muss im Absprungfenster landen).
 * Das Ausgangstor (Nische Ost auf der obersten 66er-Stufe, dort das Portal) und das Tor zur Bonus-Treppe
 * öffnen mit den KANTEN. Kein Tod: wer an der Wand abprallt, landet unten und läuft neu an.
 */
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { Frame } from '../lib';
import { crouchHand, naive, p2, routeHand } from './drivers';
import { ENV_ADVANCED, LessonBuilder, TC } from './lessonLib';
import type { LessonCheck } from './lessonLib';

const W = 384;
/**
 * Kantenhöhe der Pflichtstufe (Regel ≥ 66) und der Bonus-Kanten. Gemessen aus vollem Lauf (320 u/s, Einzelversuch):
 * 66 u → Absprung 20–180 u vor der Wand, Ducken bis 0.45 s danach; 72 u → 20–140 u; 75 u → 60–130 u; 76 u → nie
 * (die Crouch-Reichweite aus dem Lauf ist 75 u, nicht 80: der Lip-Step greift nur knapp unter dem Scheitel).
 */
export const EDGE = 66;
export const EDGE_BONUS = 72;
/** Auftritt je Stufe (Anlauf bis zur nächsten Wand). */
const TREAD = 600;
/** Wände entlang u (z = −u) mit der Oberkante dahinter. */
const U48 = 900;
const TOR1 = 1150;
const K = [1700, 1700 + TREAD, 1700 + 2 * TREAD] as const;
const TOP = [48 + EDGE, 48 + 2 * EDGE, 48 + 3 * EDGE] as const;
const KB = [K[2] + TREAD, K[2] + 2 * TREAD] as const;
const TOPB = [TOP[2] + EDGE_BONUS, TOP[2] + 2 * EDGE_BONUS] as const;
const END = KB[1] + 900;
const WALL_TOP = TOPB[1] + 320;
/** Portal-Nische Ost auf der obersten 66er-Stufe. */
const NICHE_U: readonly [number, number] = [K[2] + 120, K[2] + 480];
const NICHE_X = 640;

/** Wände für die Crouch-Hand (Pflicht, dann Bonus). */
export const WALLS_REQUIRED = K.map((u, i) => ({ z: -u, top: TOP[i] }));
export const WALLS_BONUS = KB.map((u, i) => ({ z: -u, top: TOPB[i] }));

export function buildT6(): LevelFile {
  const B = new LessonBuilder({ id: 't6', name: 'CROUCH-JUMP', subtitle: 'Erst springen, dann ducken.', lesson: 6, group: 'advanced', killY: -400, environment: ENV_ADVANCED });
  const L = B.L;
  const z = (u: number): number => -u;
  const f = Frame.at([0, 0], 0);
  // Böden: jede Stufe ein massiver Block ab y = −64 (Stirnwand bis unten, keine Lücke unter der Kante).
  const step = (u0: number, u1: number, top: number, tag: string, mat?: 'accent' | 'duck'): void => {
    L.box([-W, -64, z(u1)], [W, top, z(u0)], { tag, ...(mat === 'accent' ? { mat, tint: '#3a2a6a' } : mat ? { mat } : {}) });
  };
  step(-256, U48, 0, 'boden');
  step(U48, K[0], 48, 'stufe48', 'accent');
  K.forEach((u, i) => step(u, i + 1 < K.length ? K[i + 1] : KB[0], TOP[i], `kante${i}`, 'duck'));
  KB.forEach((u, i) => step(u, i + 1 < KB.length ? KB[i + 1] : END, TOPB[i], `hoch${i}`, 'duck'));
  // Banden (Süd, Nord, West; Ost mit Portal-Nische auf der obersten 66er-Stufe).
  const t = 64;
  L.box([-W - t, -64, z(-256)], [W + t, WALL_TOP, z(-256 - t)], { mat: 'wall', tag: 'bande-s' });
  L.box([-W - t, -64, z(END + t)], [W + t, WALL_TOP, z(END)], { mat: 'wall', tag: 'bande-n' });
  L.box([-W - t, -64, z(END)], [-W, WALL_TOP, z(-256)], { mat: 'wall', tag: 'bande-w' });
  L.box([W, -64, z(NICHE_U[0])], [W + t, WALL_TOP, z(-256)], { mat: 'wall', tag: 'bande-o1' });
  L.box([W, -64, z(END)], [W + t, WALL_TOP, z(NICHE_U[1])], { mat: 'wall', tag: 'bande-o2' });
  // Nische: Boden auf Höhe der obersten 66er-Stufe, Wände, Portal quer zur Nische.
  L.box([W, -64, z(NICHE_U[1])], [NICHE_X, TOP[2], z(NICHE_U[0])], { tag: 'nische' });
  // Seitenwände der Nische ab der Außenkante der Bande (sonst überlappen sie sie mit koplanaren Flächen).
  L.box([W + t, TOP[2], z(NICHE_U[0])], [NICHE_X + t, WALL_TOP, z(NICHE_U[0] - t)], { mat: 'wall', tag: 'nische-s' });
  L.box([W + t, TOP[2], z(NICHE_U[1] + t)], [NICHE_X + t, WALL_TOP, z(NICHE_U[1])], { mat: 'wall', tag: 'nische-n' });
  L.box([NICHE_X, TOP[2], z(NICHE_U[1])], [NICHE_X + t, WALL_TOP, z(NICHE_U[0])], { mat: 'wall', tag: 'nische-o' });
  B.portalX(NICHE_X - 120, z((NICHE_U[0] + NICHE_U[1]) / 2), TOP[2], NICHE_U[1] - NICHE_U[0] - 64, TC.lime);
  // Tore: nach der 48er Stufe (zu den Kanten), Portal-Nische, Bonus-Treppe.
  B.gate('tor1', [-W, 48, z(TOR1 + 24)], [W, WALL_TOP, z(TOR1)], TC.amber);
  B.gate('ausgang', [W, TOP[2], z(NICHE_U[1])], [W + 24, WALL_TOP, z(NICHE_U[0])], TC.amber);
  B.gate('bonus', [-W, TOP[2], z(KB[0] - 200)], [W, WALL_TOP, z(KB[0] - 224)], TC.violet);
  // Zonen: oben auf der 48er Stufe; alle drei 66er-Stufen; die Bonus-Stufen; jede 66er-Stufe einzeln (Meister).
  B.zone('oben48', [-W, 48, z(U48 + 200)], [W, 248, z(U48 + 40)]);
  B.zone('kanten-oben', [-W, TOP[0] - 8, z(KB[0])], [W, TOP[2] + 200, z(K[0])]);
  B.zone('hoch-oben', [-W, TOPB[0] - 8, z(END)], [W, TOPB[1] + 200, z(KB[0])]);
  K.forEach((u, i) => B.zone(`k${i}`, [-W, TOP[i] - 8, z((i + 1 < K.length ? K[i + 1] : KB[0]) - 64)], [W, TOP[i] + 120, z(u)]));
  // Markierungen: Absprungband ↑C vor jeder Kante (Pflicht 100–180, Bonus 60–140), Chevrons voraus.
  const band = (u: number, y: number, lo: number, hi: number, tint: string): void => {
    L.marking(f, [[u - hi, -W + 48], [u - lo, -W + 48], [u - lo, W - 48], [u - hi, W - 48]], y, tint, 'crouch-band');
    L.chevron([0, y, z(u - hi - 90)], 0, { tint, arm: 64 });
  };
  band(U48, 0, 40, 120, TC.cyan);
  K.forEach((u, i) => band(u, i === 0 ? 48 : TOP[i - 1], 100, 180, TC.lime));
  KB.forEach((u, i) => band(u, i === 0 ? TOP[2] : TOPB[i - 1], 60, 140, TC.magenta));
  L.spawn([0, 0, 0], 0);

  // Route (Vorführungen und Validator): Absprung mitten im Band, crouch = in der Luft ducken.
  // Landeknoten dicht hinter der Kante: die Passbahn des Validators (exakt auf den Knoten) muss die Kante auch
  // bei 1.2 × Tempo überfliegen. Crouch-Absprünge mit Sprint-Tempo (320) geplant; die 72er sind Präzisionsziele.
  L.node([0, 0, 0]);
  L.node([0, 0, z(U48 - 110)], { jump: true }); // 1
  L.node([0, 48, z(U48 + 60)]); // 2
  L.node([0, 48, z(U48 + 140)], { note: 'oben48' }); // 3
  L.node([0, 48, z(K[0] - 140)], { jump: true, crouch: true, minSpeed: 320 }); // 4
  L.node([0, TOP[0], z(K[0] + 60)]); // 5
  L.node([0, TOP[0], z(K[1] - 140)], { jump: true, crouch: true, minSpeed: 320 }); // 6
  L.node([0, TOP[1], z(K[1] + 60)]); // 7
  L.node([0, TOP[1], z(K[2] - 140)], { jump: true, crouch: true, minSpeed: 320 }); // 8
  L.node([0, TOP[2], z(K[2] + 60)]); // 9
  L.node([0, TOP[2], z(K[2] + 200)], { note: 'k2' }); // 10
  // Portal (Nische Ost) und zurück an denselben Punkt — die Bonus-Vorführung beginnt dort (Knoten 12).
  L.node([NICHE_X - 120, TOP[2], z((NICHE_U[0] + NICHE_U[1]) / 2)], { note: 'portal' }); // 11
  L.node([0, TOP[2], z(K[2] + 200)]); // 12
  // 72er: Absprung 120 u davor (bei 320 u/s trifft die Kante das Fenster 0.29–0.46 s nach dem Absprung).
  L.node([0, TOP[2], z(KB[0] - 120)], { jump: true, crouch: true, minSpeed: 320 }); // 13
  L.node([0, TOPB[0], z(KB[0] + 30)], { precision: true }); // 14
  L.node([0, TOPB[0], z(KB[1] - 120)], { jump: true, crouch: true, minSpeed: 320 }); // 15
  L.node([0, TOPB[1], z(KB[1] + 30)], { precision: true }); // 16
  L.node([0, TOPB[1], z(KB[1] + 200)], { note: 'hoch1' }); // 17

  B.stage({
    id: 'stufe',
    title: 'STUFE 48',
    text: 'SPRING AUF DIE STUFE\nNORMAL SPRINGEN REICHT HIER',
    task: { kind: 'reach', zone: 'oben48' },
    opens: ['tor1'],
    spawn: { pos: [0, 0, 0], yaw: 0 },
    demo: { kind: 'route', from: 0, to: 3, seconds: 8 },
  });
  B.stage({
    id: 'kanten',
    title: 'KANTEN 66',
    text: 'AM GRÜNEN BAND SPRINGEN, DANN IN\nDER LUFT C DRÜCKEN: 3 KANTEN HOCH',
    task: { kind: 'crouchLand', zone: 'kanten-oben', count: 3 },
    opens: ['ausgang', 'bonus'],
    spawn: { pos: [0, 48, z(TOR1 + 150)], yaw: 0 },
    demo: { kind: 'route', from: 3, to: 10, seconds: 14 },
    tips: [
      { on: 'stuck', after: 15, text: 'ERST SPRINGEN, DANN C IN DER LUFT\nC HALTEN BIS DU OBEN STEHST' },
      { on: 'land', after: 0, zone: 'kanten-oben', text: 'GUT! DAS IST DER CROUCH-JUMP:\nDUCKEN ZIEHT DIE FÜSSE 18 u HÖHER' },
    ],
  });
  B.stage({
    id: 'hoch',
    title: 'BONUS 72',
    text: 'HÖHER: 2 KANTEN À 76\nSPÄTER SPRINGEN, SOFORT DUCKEN',
    task: { kind: 'crouchLand', zone: 'hoch-oben', count: 2 },
    rank: 'bonus',
    spawn: { pos: [0, TOP[2], z(K[2] + 200)], yaw: 0 },
    demo: { kind: 'route', from: 12, to: 17, seconds: 10 },
    tips: [{ on: 'stuck', after: 15, text: 'AM VIOLETTEN BAND ABSPRINGEN\nUND C GLEICH DANACH DRÜCKEN' }],
  });
  B.stage({
    id: 'fluss',
    title: 'MEISTER: FLUSS',
    text: 'DIE DREI 66er-KANTEN IN EINEM ZUG\nNIE STEHEN, NIE UNTER 250',
    task: { kind: 'course', zones: ['k0', 'k1', 'k2'], minSpeed: 250, airborne: true, groundGrace: 0.25 },
    rank: 'master',
    spawn: { pos: [0, 48, z(TOR1 + 150)], yaw: 0 },
    // Keine Vorführung: der RouteFollower 3° schafft den Fluss nur mit Anläufen (13/20) — eine Demo,
    // die scheitert, lehrt nichts.
  });
  return B.build();
}

export const T6_CHECK: LessonCheck = {
  rows: [
    { model: 'RouteFollower 5°', from: 'stufe', make: routeHand({ from: 0, to: 3, noise: 5 }), expect: { min: 20 }, level: 'error', seconds: 30 },
    { model: 'NaiveBot hold', from: 'stufe', make: naive(p2(0, -(U48 + 150))), expect: { min: 20 }, level: 'error', seconds: 30 },
    // Pflicht: Mensch springt irgendwo im Band, duckt 0.05–0.35 s nach dem Absprung, läuft nach Fehlversuch neu an.
    { model: 'Anfänger mit Markierung (Absprung 100–180, Duck 0.05–0.35 s)', from: 'kanten', make: crouchHand(WALLS_REQUIRED, TREAD - 160, [100, 180], [0.05, 0.35]), expect: { min: 18 }, level: 'error', seconds: 60 },
    { model: 'Anfänger ohne Markierung (40–260, 0.05–0.45 s)', from: 'kanten', make: crouchHand(WALLS_REQUIRED, TREAD - 160, [40, 260], [0.05, 0.45]), expect: { min: 14 }, level: 'warning', seconds: 60 },
    { model: 'Vor-Ducken (C vor dem Absprung)', from: 'kanten', make: crouchHand(WALLS_REQUIRED, TREAD - 160, [40, 260], null, true), expect: { min: 0 }, level: 'info', seconds: 60 },
    { model: 'Fehler: ohne Ducken', from: 'kanten', make: crouchHand(WALLS_REQUIRED, TREAD - 160, [40, 260], null), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: W + Leertaste', from: 'kanten', make: naive(p2(0, -(K[2] + 200))), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'RouteFollower 5°', from: 'kanten', make: routeHand({ from: 3, to: 10, noise: 5, retry: true }), expect: { min: 18 }, level: 'warning', seconds: 60 },
    // Bonus: Band 60–140, sofort ducken.
    { model: 'Könner mit Markierung (60–140, Duck 0.05–0.2 s)', from: 'hoch', make: crouchHand(WALLS_BONUS, TREAD - 160, [60, 140], [0.05, 0.2]), expect: { min: 15 }, level: 'warning', seconds: 60 },
    { model: 'Anfänger (100–180, Duck 0.05–0.35 s) am Bonus', from: 'hoch', make: crouchHand(WALLS_BONUS, TREAD - 160, [100, 180], [0.05, 0.35]), expect: { min: 0 }, level: 'info', seconds: 60 },
    { model: 'Fehler: ohne Ducken (Bonus)', from: 'hoch', make: crouchHand(WALLS_BONUS, TREAD - 160, [40, 260], null), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'RouteFollower 3° (Meister)', from: 'fluss', make: routeHand({ from: 3, to: 10, noise: 3, retry: true }), expect: { min: 0 }, level: 'info', seconds: 60 },
  ],
};
