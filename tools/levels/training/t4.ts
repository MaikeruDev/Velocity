/**
 * T4 SPEED — Tempo aufbauen und halten (Plan 007; Prototyp lessonSpeedOval, v2-Entwurf §3).
 *
 * Oval (Stadion), endlos: Bodenplatte 4400 × 7200, Mittelinsel 1400 × 4000 mit Bande, Bahn ~1500 breit;
 * gefahren wird links herum (Kurven = A + Maus links). Stufen: 400 erreichen, 5 Landungen in Folge über
 * 400; Bonus 500 und Prestrafe (≥ 350 u/s am Boden, ohne Sprung: W + A + Maus); Meister 600.
 * Das Ausgangstor in der Ostbande öffnet nach "Halten", dahinter das Portal.
 */
import { HAND_MODELS } from '../../../src/player/bots/BeginnerHand';
import type { HandModel } from '../../../src/player/bots/BeginnerHand';
import type { Point2 } from '../../../src/player/bots';
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { backStrafe, hand, naive, p2, prestrafe, prestrafeRate, waypointGoal } from './drivers';
import type { HandPlan } from './drivers';
import { ENV_BASICS, LessonBuilder, TC } from './lessonLib';
import type { LessonCheck } from './lessonLib';

const X = 2200;
const Z = 3600;
const IX = 700;
const IZ = 2000;
const WALL = 192;
const DOOR = 384;
const ALCOVE = 640;
/** Mittellinie der Bahn (x = ±1450), Kurven um die Inselenden. */
const MID = 1450;
/** Stufe HALTEN: Landungen in Folge über diesem Tempo (u/s). */
const HOLD_MIN = 400;
/** Vorführung PRESTRAFE: Mausrate wie der Tipp der Stufe ("Vierteldrehung in 0.5 s"). */
export const PRESTRAFE_DEMO_RATE = 180;

export function buildT4(): LevelFile {
  const B = new LessonBuilder({ id: 't4', name: 'SPEED', subtitle: 'Tempo aufbauen und halten.', lesson: 4, group: 'basics', killY: -600, environment: ENV_BASICS, turnBand: true });
  const L = B.L;
  const t = 64;
  L.box([-X, -64, -Z], [X, 0, Z], { mat: 'floor', tag: 'bahn' });
  L.box([-IX, 0, -IZ], [IX, WALL, IZ], { mat: 'wall', tag: 'insel' });
  L.box([-X - t, 0, -Z - t], [X + t, WALL, -Z], { mat: 'wall', tag: 'bande-n' });
  L.box([-X - t, 0, Z], [X + t, WALL, Z + t], { mat: 'wall', tag: 'bande-s' });
  L.box([-X - t, 0, -Z], [-X, WALL, Z], { mat: 'wall', tag: 'bande-w' });
  // Ostbande mit Tür bei z = 0.
  L.box([X, 0, -Z], [X + t, WALL, -DOOR / 2], { mat: 'wall', tag: 'bande-o1' });
  L.box([X, 0, DOOR / 2], [X + t, WALL, Z], { mat: 'wall', tag: 'bande-o2' });
  L.box([X, -64, -DOOR / 2], [X + ALCOVE, 0, DOOR / 2], { mat: 'floor', tag: 'nische' });
  L.box([X + t, 0, -DOOR / 2 - t], [X + ALCOVE, WALL, -DOOR / 2], { mat: 'wall', tag: 'nische-n' });
  L.box([X + t, 0, DOOR / 2], [X + ALCOVE, WALL, DOOR / 2 + t], { mat: 'wall', tag: 'nische-s' });
  L.box([X + ALCOVE, 0, -DOOR / 2 - t], [X + ALCOVE + t, WALL, DOOR / 2 + t], { mat: 'wall', tag: 'nische-o' });
  B.gate('ausgang', [X, 0, -DOOR / 2], [X + 24, WALL, DOOR / 2], TC.amber);
  // Portal quer zur Nische: Trigger über die ganze Breite am Ende.
  L.finishZone([X + ALCOVE - 200, 0, -DOOR / 2], [X + ALCOVE, 200, DOOR / 2]);
  L.decoBox([X + ALCOVE - 32, 0, -DOOR / 2], [X + ALCOVE, 256, DOOR / 2], { mat: 'light', tint: TC.lime });
  // Leitlinien: Chevrons links herum auf der Mittellinie.
  for (const [x, z, yaw] of [
    [MID, 0, 0],
    [-MID, 0, 180],
    [0, -IZ - 800, 90],
    [0, IZ + 800, -90],
  ] as const)
    L.chevron([x, 0, z], yaw, { tint: TC.cyan, arm: 96 });
  L.spawn([MID, 0, 1800], 0);

  const demo = { kind: 'hand', rateDeg: 120, pattern: 'circle', side: 'left', seconds: 15 } as const;
  B.stage({
    id: 'v400',
    title: 'TEMPO 400',
    text: 'HÜPFEN UND STRAFEN BIS 400\nIN DEN KURVEN IMMER DIESELBE SEITE',
    task: { kind: 'speed', min: 400 },
    spawn: { pos: [MID, 0, 1800], yaw: 0 },
    demo,
  });
  B.stage({
    id: 'halten',
    title: 'HALTEN',
    text: 'LANDE 5-MAL IN FOLGE\nSCHNELLER ALS 400',
    task: { kind: 'speed', min: HOLD_MIN, holdHops: 5 },
    opens: ['ausgang'],
    demo,
    // Zwei Ursachen, zwei Tipps: wer steht, bekommt "Leertaste halten" (Zustand); wer dauernd hüpft und trotzdem
    // festhängt, landet unter 400 — der Stuck-Tipp nannte ihm vorher auch "nicht auf dem Boden bleiben" (Review rv-tc3).
    tips: [
      { on: 'land', after: 0.5, text: 'NICHT STEHEN BLEIBEN:\nLEERTASTE GEDRÜCKT HALTEN' },
      { on: 'stuck', after: 15, text: `UNTER ${HOLD_MIN} GELANDET = VON VORN\nIN JEDEM SPRUNG A + MAUS ZIEHEN` },
    ],
  });
  // Bonus 500 mit 3 Landungen in Folge: nur 'min 500' war im selben Frame wie HALTEN erfüllt (Tempo ≥ 500 kam schon
  // während der Serie) — zwei Stufen-Akkorde übereinander, die Bonusstufe ohne eigenen Moment (Review training-ui).
  B.stage({ id: 'v500', title: 'BONUS 500', text: 'BONUS: 3 LANDUNGEN IN FOLGE ÜBER 500', task: { kind: 'speed', min: 500, holdHops: 3 }, rank: 'bonus', demo });
  B.stage({
    id: 'prestrafe',
    title: 'PRESTRAFE',
    // Ohne Sprint bleibt man bei 250 u/s, die Prestrafe trägt nicht (0/20) — Lektionen erzwingen Auto-Sprint.
    text: 'W + A HALTEN, MAUS ZÜGIG LINKS:\nAM BODEN, OHNE SPRUNG ÜBER 350',
    task: { kind: 'speed', min: 350, ground: true },
    rank: 'bonus',
    // Vorführung = der Tipp: Anlauf mit W, dann W + A und 180 °/s (Vierteldrehung in 0.5 s) — Training.createDemo spielt
    // in einer Prestrafe-Stufe die PrestrafeHand (am Boden, nie ein Sprung). Vorher: nur Text, H meldete "keine Vorführung".
    demo: { kind: 'hand', rateDeg: PRESTRAFE_DEMO_RATE, pattern: 'circle', side: 'left', seconds: 6 },
    // Gemessen tragen 150–300 °/s (prestrafeRate), 45–90 °/s nie: "zügig", nicht "langsam" (Drehbalken: Band 150–300).
    tips: [{ on: 'stuck', after: 12, text: 'LEERTASTE LOS, W + A, MAUS ZÜGIG LINKS\nEINE VIERTELDREHUNG IN 0.5 SEKUNDEN' }],
  });
  B.stage({ id: 'v600', title: 'MEISTER 600', text: 'MEISTER: ERREICHE 600', task: { kind: 'speed', min: 600 }, rank: 'master', demo });
  return B.build();
}

/** Wegpunkte links herum auf der Mittellinie (24 Stück). */
export const OVAL: readonly Point2[] = (() => {
  const wps: Point2[] = [];
  for (let k = 0; k < 24; k++) {
    const t = k / 24;
    if (t < 0.25) wps.push(p2(MID, IZ - t * 4 * 2 * IZ));
    else if (t < 0.5) {
      const b = ((t - 0.25) / 0.25) * Math.PI;
      wps.push(p2(MID * Math.cos(b), -IZ - MID * Math.sin(b)));
    } else if (t < 0.75) wps.push(p2(-MID, -IZ + (t - 0.5) * 4 * 2 * IZ));
    else {
      const b = ((t - 0.75) / 0.25) * Math.PI;
      wps.push(p2(-MID * Math.cos(b), IZ + MID * Math.sin(b)));
    }
  }
  return wps;
})();

/** Hand im Zickzack entlang der Wegpunkte (Mensch korrigiert die Drift zum nächsten Punkt). */
const ovalHand = (model: HandModel) => {
  return (ctx: Parameters<ReturnType<typeof hand>>[0]) => {
    const goal = waypointGoal(OVAL, 700);
    return hand(model, (_si, s): HandPlan => ({ pattern: 'zigzag', goal: goal(s) }))(ctx);
  };
};
const ovalNaive = (ctx: Parameters<ReturnType<typeof naive>>[0]) => naive(waypointGoal(OVAL, 700))(ctx);

export const T4_CHECK: LessonCheck = {
  rows: [
    { model: 'ordentlicher Anfänger', from: 'v400', to: 'halten', make: ovalHand(HAND_MODELS.anfaenger), expect: { min: 18 }, level: 'error', verdicts: true },
    { model: 'geübter Anfänger', from: 'v400', to: 'halten', make: ovalHand(HAND_MODELS.geuebt), expect: { min: 19 }, level: 'warning' },
    { model: 'zaghaft 30 °/s', from: 'v400', to: 'halten', make: ovalHand(HAND_MODELS.zaghaft), expect: { min: 0 }, level: 'info' },
    { model: 'Fehler: nur W + Maus', from: 'v400', make: ovalHand(HAND_MODELS.nurW), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    { model: 'Fehler: gegen die Maus', from: 'v400', make: ovalHand(HAND_MODELS.gegen), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    { model: 'Fehler: ohne Maus', from: 'v400', make: ovalHand(HAND_MODELS.keineMaus), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    { model: 'Fehler: W + Leertaste', from: 'v400', make: ovalNaive, expect: { max: 0 }, level: 'error', seconds: 60 },
    // Schnelle Maus ohne A/D (W-Strafe, Blick quer zur Fahrt) gewinnt Tempo — zählt aber nicht (A/D-Pflicht der Session).
    // Vorher: 180 °/s 11/20, 360 °/s 20/20 in 8.5 s (schneller als der ordentliche Anfänger mit A/D).
    { model: 'Fehler: nur W + Maus 180 °/s', from: 'v400', to: 'halten', make: ovalHand({ ...HAND_MODELS.nurW, name: 'nur W 180', rateDeg: 180 }), expect: { max: 0 }, level: 'error', seconds: 90, verdicts: true },
    { model: 'Fehler: nur W + schnelle Maus 360 °/s', from: 'v400', to: 'halten', make: ovalHand(HAND_MODELS.nurWSchnell), expect: { max: 0 }, level: 'error', seconds: 90, verdicts: true },
    { model: 'Fehler: nur W + schnelle Maus 360 °/s (Halten)', from: 'halten', make: ovalHand(HAND_MODELS.nurWSchnell), expect: { max: 0 }, level: 'error', seconds: 60 },
    { model: 'Fehler: gegen die schnelle Maus 360 °/s', from: 'v400', to: 'halten', make: ovalHand(HAND_MODELS.gegenSchnell), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    // Rückwärts-Strafer (A + Maus rechts, fliegt rückwärts und gewinnt Tempo): vorher 5/5 in 3.2 s, jeder Hop "FALSCHE SEITE".
    { model: 'Fehler: Rückwärts-Strafer A + Maus rechts 90 °/s', from: 'v400', to: 'halten', make: backStrafe(90), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    { model: 'Fehler: Rückwärts-Strafer A + Maus rechts 240 °/s', from: 'v400', to: 'halten', make: backStrafe(240), expect: { max: 0 }, level: 'error', seconds: 60, verdicts: true },
    // Richtige Technik mit schneller Maus (Neulinge ziehen oft 180–360 °/s): darf nicht scheitern.
    { model: 'Anfänger mit schneller Maus 240 °/s', from: 'v400', to: 'halten', make: ovalHand({ ...HAND_MODELS.anfaenger, name: 'Anfänger 240', rateDeg: 240 }), expect: { min: 18 }, level: 'warning', verdicts: true },
    { model: 'geübter Anfänger (Bonus 500)', from: 'v500', make: ovalHand(HAND_MODELS.geuebt), expect: { min: 15 }, level: 'warning' },
    { model: 'ordentlicher Anfänger (Bonus 500)', from: 'v500', make: ovalHand(HAND_MODELS.anfaenger), expect: { min: 0 }, level: 'info' },
    { model: 'Prestrafe-Hand 220 °/s', from: 'prestrafe', make: prestrafeRate(220), expect: { min: 18 }, level: 'warning', seconds: 20 },
    { model: 'Prestrafe-Hand 160 °/s', from: 'prestrafe', make: prestrafeRate(160), expect: { min: 0 }, level: 'info', seconds: 20 },
    // Der Tipp der Stufe ("Vierteldrehung in 0.5 s" = 180 °/s) muss tragen.
    { model: 'Prestrafe nach dem Tipp 180 °/s', from: 'prestrafe', make: prestrafeRate(180), expect: { min: 18 }, level: 'warning', seconds: 20 },
    { model: 'Fehler: Prestrafe zu langsam 90 °/s', from: 'prestrafe', make: prestrafeRate(90, 0.1), expect: { max: 0 }, level: 'warning', seconds: 20 },
    { model: 'Prestrafe-Bot (Optimum, 5° Zielfehler)', from: 'prestrafe', make: prestrafe(5), expect: { min: 20 }, level: 'info', seconds: 20 },
    { model: 'Fehler: nur W (Prestrafe)', from: 'prestrafe', make: ovalNaive, expect: { max: 0 }, level: 'error', seconds: 30 },
    { model: 'geübter Anfänger (Meister 600)', from: 'v600', make: ovalHand(HAND_MODELS.geuebt), expect: { min: 0 }, level: 'info' },
  ],
};
