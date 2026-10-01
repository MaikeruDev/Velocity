import { VM_JOINT, VM_JOINT_COUNT } from '../../render/types';

/**
 * Posen der 3D-View-Hand (Plan 006) als Gelenkwinkel-Sätze. DOM- und three-frei (Vitest).
 * Werte in GRAD (lesbar beim Tunen), umgerechnet in Radiant für den ViewModelFrame.
 * Layout: siehe VM_JOINT in render/types.ts.
 *
 *   wrist: [Beugen, Seitneigung (+ = Daumen), Drehen]
 *   thumb: [Abspreizen, Opposition, Grundgelenk, Endgelenk]
 *   finger: [Spreizen (+ = Richtung Daumen), Grund-, Mittel-, Endgelenk] × Zeige/Mittel/Ring/Klein
 */

/**
 * Plan 007 hängt an (Indizes der alten Posen bleiben): coin, phone, peace, phoneTap, cradle. Plan 008 (Griff-Audit):
 * spin (Spinner zwischen Daumen und Mittelfinger), balisong (Messer im Safe-Handle-Griff), lighter (Sturmfeuerzeug
 * in der Faust, Daumen am Deckel), ken (Kendama am Griff), flick (Feuerzeug: Daumen schnippt den Deckel), yoyo (Jo-Jo in der lockeren Faust), roll (Butterfly-Rollover: Daumen gibt frei, das Messer rollt über den Zeigefinger).
 */
export const HAND_POSES = ['relaxed', 'open', 'fist', 'run', 'grip', 'pinch', 'knife', 'thumbsUp', 'point', 'flat', 'crack', 'coin', 'phone', 'peace', 'phoneTap', 'cradle', 'spin', 'balisong', 'lighter', 'ken', 'flick', 'yoyo', 'roll'] as const;
export type HandPose = (typeof HAND_POSES)[number];

export const POSE: { readonly [K in HandPose]: number } = {
  relaxed: 0,
  open: 1,
  fist: 2,
  run: 3,
  grip: 4,
  pinch: 5,
  knife: 6,
  thumbsUp: 7,
  point: 8,
  flat: 9,
  crack: 10,
  coin: 11,
  phone: 12,
  peace: 13,
  phoneTap: 14,
  cradle: 15,
  spin: 16,
  balisong: 17,
  lighter: 18,
  ken: 19,
  flick: 20,
  yoyo: 21,
  roll: 22,
};

type F4 = readonly [number, number, number, number];

interface PoseDef {
  readonly wrist: readonly [number, number, number];
  readonly thumb: F4;
  readonly fingers: readonly [F4, F4, F4, F4];
}

const DEFS: { readonly [K in HandPose]: PoseDef } = {
  // Stand/Gehen: locker, leicht gekrümmt, Finger nach außen zunehmend eingerollt.
  relaxed: { wrist: [4, 0, 0], thumb: [4, 14, 12, 12], fingers: [[3, 14, 20, 12], [0, 18, 26, 14], [-2, 24, 32, 16], [-5, 30, 36, 18]] },
  // Luft: gespreizt, Finger fast gestreckt (Cartoon "Wuiii").
  open: { wrist: [-6, 0, 0], thumb: [24, -4, 0, 0], fingers: [[11, 2, 6, 2], [3, 0, 5, 2], [-5, 2, 6, 2], [-14, 4, 8, 4]] },
  fist: { wrist: [6, 0, 0], thumb: [-6, 48, 34, 38], fingers: [[0, 86, 100, 62], [0, 88, 102, 62], [0, 88, 100, 60], [-2, 86, 96, 58]] },
  // Rennen: lockere Faust.
  run: { wrist: [2, 0, 0], thumb: [0, 30, 20, 22], fingers: [[2, 48, 62, 34], [0, 52, 66, 36], [-2, 56, 68, 36], [-4, 58, 70, 36]] },
  // Dose seitlich im Griff (Achse quer zur Hand, Daumen oben). Plan 008: mit Finger-Kontakt gebacken
  // (tools/hand-grips.ts can --from grip) — jedes Fingerglied liegt an der Dose, keins steckt darin.
  grip: { wrist: [0, 0, 0], thumb: [21, 1, 17, 38], fingers: [[0, 36, 15, 29], [0, 40, 20, 32], [-1, 36, 20, 22], [-3, 29, 12, 15]] },
  // Karte zwischen Daumen und Zeigefinger: lehnt am stark gebeugten Zeigefinger, Rest eingerollt.
  // Plan 008: Daumen flach auf der Kartenvorderseite (Daumen-Gittersuche gegen den Kontakt-Körper).
  pinch: { wrist: [0, 0, 0], thumb: [-20, 0, 20, 20], fingers: [[4, 83, 48, 62], [0, 70, 102, 62], [-1, 74, 92, 54], [-3, 78, 94, 54]] },
  // Messer: Faust um den Griff, etwas offener als die Faust.
  knife: { wrist: [0, 0, 0], thumb: [-4, 42, 26, 26], fingers: [[0, 70, 90, 56], [0, 74, 94, 56], [0, 76, 94, 56], [-2, 76, 92, 54]] },
  thumbsUp: { wrist: [0, 0, 0], thumb: [30, -14, -4, -4], fingers: [[0, 86, 100, 62], [0, 88, 102, 62], [0, 88, 100, 60], [-2, 86, 96, 58]] },
  point: { wrist: [0, 0, 0], thumb: [-4, 44, 30, 30], fingers: [[2, 0, 2, 0], [0, 84, 100, 60], [0, 86, 100, 60], [-2, 84, 96, 58]] },
  // Zauber-Wisch: flache Hand, Finger geschlossen.
  flat: { wrist: [-4, 0, 0], thumb: [-6, 6, 4, 4], fingers: [[-2, 2, 4, 2], [0, 2, 4, 2], [2, 2, 4, 2], [3, 4, 6, 2]] },
  // Dose öffnen: Griff, Daumen hakt unter die Lasche.
  crack: { wrist: [0, 0, 0], thumb: [8, 30, 44, 50], fingers: [[0, 36, 15, 29], [0, 40, 20, 32], [-1, 36, 20, 22], [-3, 29, 12, 15]] },
  // Münze (Plan 007): lockere Faust, Daumen eingezogen — die Knöchel bilden eine Treppe für den Knöchel-Lauf.
  coin: { wrist: [0, 0, 0], thumb: [-10, 58, 40, 46], fingers: [[0, 64, 86, 50], [0, 66, 88, 50], [0, 68, 88, 50], [-2, 70, 86, 48]] },
  // Handy (Plan 007): Finger um den Rücken, Daumen gestreckt über dem Display (scrollt).
  // Plan 008: Handy liegt mit dem Rücken an Zeige-/Mittelfinger, Ring/klein stützen die Kante, Daumen auf dem Display
  // (gebacken, tools/hand-grips.ts phone; vorher steckte der Zeigefinger 1 cm im Gerät, der Daumen schwebte).
  phone: { wrist: [0, 0, 0], thumb: [25, 45, 25, 25], fingers: [[0, 30, 71, 41], [0, 50, 74, 42], [-1, 88, 98, 58], [-3, 86, 77, 41]] },
  // Peace-Zeichen (Selfie): Zeige- und Mittelfinger gestreckt und weit gespreizt (bei 96×54 las sich ±10°
  // als zwei aneinanderliegende Finger), Rest eingerollt, Daumen darüber.
  peace: { wrist: [0, 0, 0], thumb: [-6, 50, 36, 40], fingers: [[17, 0, 4, 0], [-16, 0, 4, 0], [0, 86, 100, 60], [-2, 84, 96, 58]] },
  // Handy: Daumen tippt/wischt aufs Display (Wechsel phone ↔ phoneTap = Daumen bewegt sich).
  phoneTap: { wrist: [0, 0, 0], thumb: [22, 40, 38, 36], fingers: [[0, 30, 71, 41], [0, 50, 74, 42], [-1, 88, 98, 58], [-3, 86, 77, 41]] },
  // Jo-Jo "Rock the Baby" (Plan 007): Daumen und Zeigefinger gespreizt und gestreckt — zwischen ihren
  // Spitzen spannt die Schnur das Dreieck (Wiege); Mittelfinger hält die Schlaufe, Rest eingerollt.
  cradle: { wrist: [4, 0, 0], thumb: [30, -8, 0, 0], fingers: [[12, 8, 10, 4], [0, 42, 52, 30], [-2, 62, 72, 40], [-5, 68, 76, 40]] },
  // Plan 008: Spinner am Mittellager zwischen Daumen- und Mittelfinger-Kuppe (Pinch-Suche: Verbindung der Kuppen
  // zeigt zur Kamera und nach oben, Abstand = Lager + Kuppen), Zeigefinger frei zum Anschnippen, Rest eingerollt.
  spin: { wrist: [0, 0, 0], thumb: [-15, 40, 0, 0], fingers: [[6, 25, 35, 15], [0, 90, 16, 0], [-1, 84, 96, 58], [-3, 82, 92, 56]] },
  // Plan 008: Butterfly am Safe Handle, gekniffen am Drehpunkt: Daumenkuppe vorn, Zeigefinger-Endglied hinten
  // (Pinch-Suche: Verbindung der Kuppen = Normale der Messer-Ebene, zur Kamera); Mittel-/Ring-/kleiner Finger eingerollt,
  // damit Bite Handle und Klinge frei vor der Faust schwingen.
  balisong: { wrist: [0, 0, 0], thumb: [-15, 10, 0, 0], fingers: [[2, 6, 48, 70], [0, 80, 96, 60], [0, 84, 98, 60], [-2, 84, 94, 58]] },
  // Plan 008: Sturmfeuerzeug flach an der Handfläche, Zeige-/Mittelfinger um den Körper, Ring/klein darunter
  // eingerollt (das Feuerzeug ist kürzer als die Hand breit), Daumen am Deckel (gebacken, tools/hand-grips.ts).
  lighter: { wrist: [0, 0, 0], thumb: [5, -25, 20, 15], fingers: [[0, 36, 30, 53], [0, 40, 49, 32], [-1, 79, 91, 54], [-3, 74, 78, 47]] },
  // Plan 008: Kendama am Ken-Griff, diagonal durch die Faust (Hammergriff), Zeigefinger unter dem Querstück,
  // Daumen seitlich am Griff (gebacken, tools/hand-grips.ts kendama --open run).
  ken: { wrist: [0, 0, 0], thumb: [-15, 50, 20, 20], fingers: [[0, 48, 62, 34], [0, 61, 102, 62], [0, 64, 100, 60], [-2, 86, 74, 39]] },
  // Feuerzeug-Schnipp: wie lighter, Daumen beugt sich und schiebt den Deckel auf (vorher crack = Dosen-Finger).
  // Plan 008: Jo-Jo in der lockeren Faust — Finger liegen am Rand, Daumen auf der Flanke (vorher run: Daumen 0.76 cm
  // im Jo-Jo). Gebacken mit tools/hand-grips.ts yoyo --open run.
  yoyo: { wrist: [2, 0, 0], thumb: [45, 50, 20, 25], fingers: [[2, 69, 100, 62], [0, 52, 102, 62], [-2, 88, 84, 48], [-4, 86, 70, 36]] },
  // Plan 008: Rollover — Daumen weggespreizt (gibt das Messer frei), Zeigefinger als Achse, Rest eingerollt.
  roll: { wrist: [0, 0, 0], thumb: [30, 30, 0, 0], fingers: [[2, 6, 48, 70], [0, 80, 96, 60], [0, 84, 98, 60], [-2, 84, 94, 58]] },
  flick: { wrist: [0, 0, 0], thumb: [8, 30, 44, 50], fingers: [[0, 36, 30, 53], [0, 40, 49, 32], [-1, 79, 91, 54], [-3, 74, 78, 47]] },
};

const DEG = Math.PI / 180;

/** Posen als Radiant-Arrays (einmal beim Laden gebaut). */
export const POSE_JOINTS: readonly Float32Array[] = HAND_POSES.map((name) => {
  const d = DEFS[name];
  const a = new Float32Array(VM_JOINT_COUNT);
  a[VM_JOINT.wristFlex] = d.wrist[0] * DEG;
  a[VM_JOINT.wristDev] = d.wrist[1] * DEG;
  a[VM_JOINT.wristTwist] = d.wrist[2] * DEG;
  a[VM_JOINT.thumbAbd] = d.thumb[0] * DEG;
  a[VM_JOINT.thumbOpp] = d.thumb[1] * DEG;
  a[VM_JOINT.thumbMcp] = d.thumb[2] * DEG;
  a[VM_JOINT.thumbIp] = d.thumb[3] * DEG;
  for (let f = 0; f < 4; f++) for (let k = 0; k < 4; k++) a[VM_JOINT.finger + f * 4 + k] = d.fingers[f][k] * DEG;
  return a;
});
