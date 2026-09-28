/**
 * T4 SPEED — Tempo aufbauen und halten (Plan 007; Prototyp lessonSpeedOval, v2-Entwurf §3).
 *
 * Oval (Stadion), endlos: Bodenplatte 4400 × 7200, Mittelinsel 1400 × 4000 mit Bande, Bahn ~1500 breit;
 * gefahren wird links herum (Kurven = A + Maus links). Stufen: 400 erreichen, 5 Landungen in Folge über
 * 400; Bonus 500 und Prestrafe (≥ 350 u/s am Boden, ohne Sprung: W + A + Maus); Meister 600.
 * Das Ausgangstor in der Ostbande öffnet nach "Halten", dahinter das Portal.
 */
import { HAND_MODELS } from '../../../src/player/bots/BeginnerHand';
import type { Point2 } from '../../../src/player/bots';
import type { LevelFile } from '../../../src/world/level/LevelFormat';
import { hand, naive, p2, prestrafe, prestrafeRate, waypointGoal } from './drivers';
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
    task: { kind: 'speed', min: 400, holdHops: 5 },
    opens: ['ausgang'],
    demo,
    tips: [{ on: 'stuck', after: 15, text: 'NICHT AUF DEM BODEN BLEIBEN:\nLEERTASTE GEDRÜCKT HALTEN' }],
  });
  B.stage({ id: 'v500', title: 'BONUS 500', text: 'BONUS: ERREICHE 500', task: { kind: 'speed', min: 500 }, rank: 'bonus', demo });
  B.stage({
    id: 'prestrafe',
    title: 'PRESTRAFE',
    text: 'AM BODEN W + A HALTEN, MAUS LINKS\nOHNE SPRUNG ÜBER 350',
    task: { kind: 'speed', min: 350, ground: true },
    rank: 'bonus',
    tips: [{ on: 'stuck', after: 12, text: 'LEERTASTE LOSLASSEN, W + A HALTEN\nMAUS GANZ LANGSAM NACH LINKS' }],
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
const ovalHand = (model: (typeof HAND_MODELS)[keyof typeof HAND_MODELS]) => {
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
    { model: 'geübter Anfänger (Bonus 500)', from: 'v500', make: ovalHand(HAND_MODELS.geuebt), expect: { min: 15 }, level: 'warning' },
    { model: 'ordentlicher Anfänger (Bonus 500)', from: 'v500', make: ovalHand(HAND_MODELS.anfaenger), expect: { min: 0 }, level: 'info' },
    { model: 'Prestrafe-Hand 220 °/s', from: 'prestrafe', make: prestrafeRate(220), expect: { min: 18 }, level: 'warning', seconds: 20 },
    { model: 'Prestrafe-Hand 160 °/s', from: 'prestrafe', make: prestrafeRate(160), expect: { min: 0 }, level: 'info', seconds: 20 },
    { model: 'Fehler: Prestrafe zu langsam 90 °/s', from: 'prestrafe', make: prestrafeRate(90, 0.1), expect: { max: 0 }, level: 'warning', seconds: 20 },
    { model: 'Prestrafe-Bot (Optimum, 5° Zielfehler)', from: 'prestrafe', make: prestrafe(5), expect: { min: 20 }, level: 'info', seconds: 20 },
    { model: 'Fehler: nur W (Prestrafe)', from: 'prestrafe', make: ovalNaive, expect: { max: 0 }, level: 'error', seconds: 30 },
    { model: 'geübter Anfänger (Meister 600)', from: 'v600', make: ovalHand(HAND_MODELS.geuebt), expect: { min: 0 }, level: 'info' },
  ],
};
