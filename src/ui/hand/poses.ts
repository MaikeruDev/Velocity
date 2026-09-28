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

/** Plan 007 hängt an (Indizes der alten Posen bleiben): coin, phone, peace, phoneTap. */
export const HAND_POSES = ['relaxed', 'open', 'fist', 'run', 'grip', 'pinch', 'knife', 'thumbsUp', 'point', 'flat', 'crack', 'coin', 'phone', 'peace', 'phoneTap'] as const;
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
  // Dose seitlich im Griff (Achse quer zur Hand, Daumen oben).
  grip: { wrist: [0, 0, 0], thumb: [-2, 40, 24, 22], fingers: [[0, 34, 78, 46], [0, 36, 82, 48], [-1, 38, 82, 46], [-3, 40, 80, 44]] },
  // Karte zwischen Daumen und Zeigefinger (Seitgriff), Rest eingerollt.
  pinch: { wrist: [0, 0, 0], thumb: [2, 26, 16, 12], fingers: [[4, 30, 48, 24], [0, 66, 88, 52], [-1, 74, 92, 54], [-3, 78, 94, 54]] },
  // Messer: Faust um den Griff, etwas offener als die Faust.
  knife: { wrist: [0, 0, 0], thumb: [-4, 42, 26, 26], fingers: [[0, 70, 90, 56], [0, 74, 94, 56], [0, 76, 94, 56], [-2, 76, 92, 54]] },
  thumbsUp: { wrist: [0, 0, 0], thumb: [30, -14, -4, -4], fingers: [[0, 86, 100, 62], [0, 88, 102, 62], [0, 88, 100, 60], [-2, 86, 96, 58]] },
  point: { wrist: [0, 0, 0], thumb: [-4, 44, 30, 30], fingers: [[2, 0, 2, 0], [0, 84, 100, 60], [0, 86, 100, 60], [-2, 84, 96, 58]] },
  // Zauber-Wisch: flache Hand, Finger geschlossen.
  flat: { wrist: [-4, 0, 0], thumb: [-6, 6, 4, 4], fingers: [[-2, 2, 4, 2], [0, 2, 4, 2], [2, 2, 4, 2], [3, 4, 6, 2]] },
  // Dose öffnen: Griff, Daumen hakt unter die Lasche.
  crack: { wrist: [0, 0, 0], thumb: [8, 30, 44, 50], fingers: [[0, 34, 78, 46], [0, 36, 82, 48], [-1, 38, 82, 46], [-3, 40, 80, 44]] },
  // Münze (Plan 007): lockere Faust, Daumen eingezogen — die Knöchel bilden eine Treppe für den Knöchel-Lauf.
  coin: { wrist: [0, 0, 0], thumb: [-10, 58, 40, 46], fingers: [[0, 64, 86, 50], [0, 66, 88, 50], [0, 68, 88, 50], [-2, 70, 86, 48]] },
  // Handy (Plan 007): Finger um den Rücken, Daumen gestreckt über dem Display (scrollt).
  phone: { wrist: [0, 0, 0], thumb: [20, 12, 17, 12], fingers: [[0, 30, 70, 40], [0, 34, 74, 42], [-1, 38, 76, 42], [-3, 42, 76, 40]] },
  // Peace-Zeichen (Selfie): Zeige- und Mittelfinger gestreckt und weit gespreizt (bei 96×54 las sich ±10°
  // als zwei aneinanderliegende Finger), Rest eingerollt, Daumen darüber.
  peace: { wrist: [0, 0, 0], thumb: [-6, 50, 36, 40], fingers: [[17, 0, 4, 0], [-16, 0, 4, 0], [0, 86, 100, 60], [-2, 84, 96, 58]] },
  // Handy: Daumen tippt/wischt aufs Display (Wechsel phone ↔ phoneTap = Daumen bewegt sich).
  phoneTap: { wrist: [0, 0, 0], thumb: [8, 34, 42, 38], fingers: [[0, 30, 70, 40], [0, 34, 74, 42], [-1, 38, 76, 42], [-3, 42, 76, 40]] },
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
