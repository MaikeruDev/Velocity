import { VM_JOINT, VM_PARAM, VM_RIG } from '../../render/types';
import { bell, clamp, smooth } from './anim';
import { GRIP_THUMB, GripSolver, applyStages } from './fingerContact';
import { Track, cubicInOut, phase, smootherstep } from './curves';
import type { Key } from './curves';
import { fingerPoint, fingerTip, thumbPoint } from './fk';
import { HandShape } from './handShape';
import { KM, KnifeSim, TrackMotion, knifeLinks } from './knifeRig';
import { socketMatrix } from './propShape';
import type { PropShape } from './propShape';
import { propShapeFor } from './propShapes';
import type { KnifeMotion } from './knifeRig';
import { POSE, POSE_JOINTS } from './poses';
import { PropTricks } from './propTricks';
import type { PropFrameInput, PropOut } from './propTricks';
import { VIEW_AXES, fromEulerXYZ, mat3, toEulerXYZ } from './rot';
import type { Mat3 } from './rot';
import { settle } from './rigid';
import { relRot, viewPoint, viewRot } from './view';
import type { V3 } from './view';

/**
 * Butterfly-Messer (Balisong, stumpfer Trainer, rein kosmetisch — Plan 006; Plan 008 mit echter Mechanik).
 *
 * Griff (Plan 008, Griff-Audit): Safe Handle am Drehpunkt gekniffen — Daumenkuppe vorn, Zeigefinger-Endglied
 * hinten, die Messer-Ebene zeigt schräg zur Kamera, die Griffe hängen vor der Faust. Geschlossen liegt der Bite
 * Handle außen (Bild links, Schneide zu ihm), offen innen an der Handfläche; die Klinge steht offen nach oben.
 *
 * Bewegung: KEINE gescripteten Klingenwinkel. Jeder Trick ist eine Handbewegung (Keyframes: Handgelenk-Flicks
 * als Roll/Hub, beim Rollover die Drehung des Safe Handle um den Zeigefinger, beim Aerial die Wurfbahn), und die
 * Pendel-Physik (knifeRig.KnifeSim: zwei Glieder an zwei Stiften, Trägheit, Schwerkraft, Anschlag am Stopp-Stift,
 * Griff gegen Griff) rechnet daraus Klinge und Bite Handle. Zum Fang schließen die Finger (Führung zu offen/zu),
 * der Riegel klappt. Festes Rechenraster ab Trick-Start → jede Framerate zeigt dieselbe Bahn.
 *
 * Tricks je Tempo (unverändert seit Plan 006):
 * - Stand: Aufklappen/Zuklappen (Basic Opening/Closing) im Wechsel,
 * - Lauf: dasselbe an Sprüngen,
 * - Flow: Rollover (Safe Handle rollt über den Zeigefinger, Griffe schlagen um) oder Auf/Zu,
 * - Overdrive: Aerial (Loslassen, Drehung in der Luft, Fang wechselt offen/zu), Doppel-Aerial bei guten Hops.
 * - Plan 007 KI8, Surf ≥ 500 u/s: Zustand surfHeli ("Helikopter") — offen auf der Zeigefinger-Spitze, dreht flach
 *   wie ein Rotor. Surf-Ende: läuft auf eine volle Umdrehung aus und legt sich zurück in den Griff (bleibt offen).
 */

export const KNIFE_TRICKS = ['none', 'open', 'close', 'rollover', 'aerial', 'doubleAerial', 'surfHeli'] as const;
export type KnifeTrick = Exclude<(typeof KNIFE_TRICKS)[number], 'none'>;

const KNIFE_NAMES: readonly string[] = KNIFE_TRICKS.filter((t) => t !== 'none');

export const KNIFE_TIER_TRICKS: readonly (readonly KnifeTrick[])[] = [[], ['open', 'close'], ['rollover', 'open', 'close'], ['aerial', 'doubleAerial', 'rollover']];

/**
 * Abklingzeiten wie Plan 006; Aerials etwas länger — sie dauern mit Physik kürzer (0.69 statt 0.95 s), der Takt bleibt.
 * Plan 008 Schritt 2 (Takt, L1 1.5°-Hand vorher 33.8 Tricks/min, Band 20–32): Meilensteine achten auf die Abklingzeit, und im
 * Flow kommt der Rollover jeden zweiten statt jeden dritten Sprung. Der Bhop-Takt (~0.7 s) quantisiert: Auf/Zu (0.53 s) +
 * Abklingzeit < 1.4 s löst schon am übernächsten Sprung aus, Rollover (0.62 + 0.9 s) erst einen später — längere Auf/Zu-
 * Abklingzeiten hätten den Takt auch gesenkt, brechen aber den Plan-006-Ablauf (Zuklappen 1 s nach dem Aufklappen).
 */
const COOLDOWN = { open: 0.35, close: 0.35, rollover: 0.9, aerial: 1.0, doubleAerial: 1.1, surfHeli: 0.5 } as const;

// ------------------------------------------------------------------ Griff (Ladezeit)

/** Kniff am Safe Handle so weit unter dem Stift (Einheiten): am Griff-Ende — so schwingen Klinge und Bite Handle frei über der Faust (näher am Stift lag die Handfläche in der Schwungbahn, Plan 008). */
const PINCH_BELOW = 7.6;
/** Kippung der Messer-Ebene um die Klingenachse (rad), siehe HOLD. */
const KNIFE_TILT = 0;
/** Neigung des Messers im Bild nach links (rad von der Senkrechten). */
const KNIFE_LEAN = 0.55;

/**
 * Lage des Safe Handle aus der Pose balisong (FK): Messer-Normale = Verbindung Zeigefinger- → Daumenkuppe
 * (Daumen vorn), Klinge offen = Bild-oben in der Ebene, Stift PINCH_BELOW über der Mitte zwischen den Kuppen.
 */
const HOLD = ((): { pos: V3; rot: V3; x: V3; y: V3 } => {
  const j = POSE_JOINTS[POSE.balisong];
  const t: [number, number, number] = [0, 0, 0];
  const f: [number, number, number] = [0, 0, 0];
  thumbPoint(j, 2, 0, VM_RIG.thumb.len[2] + VM_RIG.thumb.r[2] * 0.6, 0, t);
  fingerTip(j, 0, f, 0.6);
  const z0 = norm3(t[0] - f[0], t[1] - f[1], t[2] - f[2]);
  // Klinge (offen) zeigt im Bild nach links oben (KNIFE_LEAN von der Senkrechten): das Messer steht aus der Faust
  // heraus, statt vor ihr zu hängen.
  const cl = Math.cos(KNIFE_LEAN);
  const sl = Math.sin(KNIFE_LEAN);
  const R0 = VIEW_AXES.right;
  const U0 = VIEW_AXES.up;
  const u: V3 = [U0[0] * cl - R0[0] * sl, U0[1] * cl - R0[1] * sl, U0[2] * cl - R0[2] * sl];
  const d = u[0] * z0[0] + u[1] * z0[1] + u[2] * z0[2];
  const y = norm3(u[0] - d * z0[0], u[1] - d * z0[1], u[2] - d * z0[2]);
  const x0: V3 = [y[1] * z0[2] - y[2] * z0[1], y[2] * z0[0] - y[0] * z0[2], y[0] * z0[1] - y[1] * z0[0]];
  // Ebene um die Klingenachse gekippt: die Bild-rechte Seite (lokal +x, zur Hand) kommt KNIFE_TILT zur Kamera —
  // dort liegen Daumen und Handballen in der ungekippten Ebene, der Bite Handle schwänge beim Öffnen hindurch.
  const ct = Math.cos(KNIFE_TILT);
  const st = Math.sin(KNIFE_TILT);
  const x: V3 = [x0[0] * ct + z0[0] * st, x0[1] * ct + z0[1] * st, x0[2] * ct + z0[2] * st];
  const z: V3 = [z0[0] * ct - x0[0] * st, z0[1] * ct - x0[1] * st, z0[2] * ct - x0[2] * st];
  const R = mat3();
  for (let k = 0; k < 3; k++) {
    R[k * 3] = x[k];
    R[k * 3 + 1] = y[k];
    R[k * 3 + 2] = z[k];
  }
  const e = new Float32Array(3);
  toEulerXYZ(R, e);
  const mid: V3 = [(t[0] + f[0]) / 2, (t[1] + f[1]) / 2, (t[2] + f[2]) / 2];
  return { pos: [mid[0] + y[0] * PINCH_BELOW, mid[1] + y[1] * PINCH_BELOW, mid[2] + y[2] * PINCH_BELOW], rot: [e[0], e[1], e[2]], x, y };
})();

/** Stift des Safe Handle im Handgelenk-Raum und Lage (Euler XYZ) in Ruhe. */
export const KNIFE_HOLD_POS: V3 = HOLD.pos;
export const KNIFE_HOLD_ROT: V3 = HOLD.rot;

function norm3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / l, y / l, z / l];
}

// ------------------------------------------------------------------ Bewegungen (Ladezeit)

/**
 * Bühne (look.md: Tricks nie im Blickzentrum): während eines Tricks rückt die Hand etwas nach rechts unten und
 * zurück — das ausgeklappte Messer ist 19 cm lang und schwingt sonst bis in die Bildmitte. Weich (C1) ein/aus,
 * Teil der Handbewegung (die Physik spürt die Beschleunigung).
 */
const STAGE_X = 0.18;
const STAGE_Y = 0.1;
function stageTracks(total: number, sx = STAGE_X, sy = STAGE_Y): { sx: Track; sy: Track } {
  const k = (v: number): Key[] => [
    [0, 0],
    [0.12, v],
    [Math.max(0.13, total - 0.16), v],
    [total, 0],
  ];
  return { sx: new Track(k(sx), { smooth: true }), sy: new Track(k(sy), { smooth: true }) };
}

/**
 * Basic Opening / Closing als Handbewegung: Handgelenk-Beugung (rad, die Achse liegt fast auf der Messer-
 * Normalen → der Flick dreht das Messer in seiner Ebene) an drei Keys, dazu ein Drittel davon als Unterarm-Roll
 * und ein Hub (Bildhöhen); Fangzeit tc (Finger greifen, Führung zum Ziel), danach Nachschwingen. Parameter
 * [f1, f2, f3, t1, t2, t3, tc, lift] — gefunden mit tools/knife-tune.ts (Physik-Suche: Ziel-Zustand am Fang,
 * ohne Griff-gegen-Griff-Kontakt, Klinge weg von der Hand).
 */
export const OPEN_P: readonly number[] = [-0.1978, -0.6725, -0.6475, 0.0744, 0.119, 0.2197, 0.2958, -0.0488];
export const CLOSE_P: readonly number[] = [-0.0071, -0.338, -0.0766, 0.093, 0.2019, 0.2315, 0.4787, -0.0077];
/** Nach der Fangzeit: Führung voll, Nachschwingen, Riegel zu (s). */
const SETTLE = 0.24;

export interface FlipTiming {
  readonly tc: number;
  readonly total: number;
}

/** Hand-Flick für Auf/Zu (Ziel-Klinge 0 = offen, π = zu). */
export function flipMotion(p: readonly number[], goalBlade: number): { motion: TrackMotion; timing: FlipTiming } {
  const t1 = p[3];
  const t2 = Math.max(p[4], t1 + 0.03);
  const t3 = Math.max(p[5], t2 + 0.03);
  // Der letzte Rückschwung braucht Zeit (sonst reißt er das gefangene Messer wieder auf).
  const tc = Math.max(p[6], t3 + 0.1);
  const total = tc + SETTLE;
  const flex: Key[] = [
    [0, 0],
    [t1, p[0]],
    [t2, p[1]],
    [t3, p[2]],
    [tc, 0],
    [total, 0],
  ];
  const hy: Key[] = [
    [0, 0],
    [t1, p[7]],
    [t3, -p[7] * 0.5],
    [tc, 0],
    [total, 0],
  ];
  const motion = new TrackMotion({
    ...stageTracks(total),
    flex: new Track(flex, { smooth: true }),
    // Der Unterarm rollt ein Drittel mit (ein Flick ist nie nur das Handgelenk).
    roll: new Track(flex.map(([t, v]) => [t, v * 0.33] as Key), { smooth: true }),
    hy: new Track(hy, { smooth: true }),
    grip: new Track([
      [0, 0],
      [Math.max(0.01, tc - 0.06), 0],
      [tc + 0.02, 1, smootherstep],
    ]),
    gripBlade: new Track([[0, goalBlade]]),
    latch: new Track([
      [0, 0],
      [0.06, 1, cubicInOut],
      [total - 0.1, 1],
      [total - 0.02, 0, cubicInOut],
    ]),
  });
  return { motion, timing: { tc, total } };
}

/**
 * Rollover über den Zeigefinger: der Daumen gibt frei, das Messer überschlägt sich einmal um den Zeigefinger
 * (Achse = Endglied des Zeigefingers durch dessen Kuppe, also AUS der Messer-Ebene: von der Kamera aus kippt es
 * nach vorn, über den Finger und zurück — die Hand liegt dabei hinter der Drehebene), Klinge und Bite Handle
 * schlagen frei (Physik mit Fliehkraft), am Ende greifen Daumen und Finger wieder zu.
 */
const ROLL_T = 0.62;
const ROLL_CATCH = 0.48;
/** Drehsinn des Überschlags (−1 / +1) und Vorziehen zur Kamera (Einheiten) während des Überschlags. */
const ROLL_DIR = 1;
/** −4.5 statt −4 (Plan 008 Schritt 2): Klinge–Handfläche im Rollover 0.06 → ≥ 0.15 (Zeigefinger-Wurzel 0.15, gemessen 60/144 Hz). */
const ROLL_FRONT = -4.5;
/** Endglied des Zeigefingers (Pose balisong) im Messer-Raum: Richtung und Kuppe (Ladezeit). */
const INDEX_AXIS = ((): { axis: V3; at: V3 } => {
  const j = POSE_JOINTS[POSE.balisong];
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  fingerPoint(j, 0, 2, 0, 0, 0, a);
  fingerTip(j, 0, b, 0);
  const R = fromEulerXYZ(mat3(), KNIFE_HOLD_ROT[0], KNIFE_HOLD_ROT[1], KNIFE_HOLD_ROT[2]);
  // in den Messer-Raum: Rᵀ·(p − Stift)
  const loc = (p: readonly number[], o: readonly number[]): V3 => {
    const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    return [R[0] * d[0] + R[3] * d[1] + R[6] * d[2], R[1] * d[0] + R[4] * d[1] + R[7] * d[2], R[2] * d[0] + R[5] * d[1] + R[8] * d[2]];
  };
  const dir = loc(b, a);
  const l = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
  // Drehpunkt etwas vor der Kuppe (60 % der Tiefe): das Messer kreist um den Finger, statt durch die Kuppe.
  return { axis: [dir[0] / l, dir[1] / l, dir[2] / l], at: ((p: V3): V3 => [p[0], p[1], p[2] * 0.6])(loc(b, KNIFE_HOLD_POS)) };
})();

export function rolloverMotion(goalBlade: number, dir = ROLL_DIR, front = ROLL_FRONT): TrackMotion {
  return new TrackMotion(
    {
      ...stageTracks(ROLL_T),
      flip: new Track(
        [
          [0, 0],
          [0.06, -dir * 0.15],
          [ROLL_CATCH - 0.03, dir * Math.PI * 2],
          [ROLL_T, dir * Math.PI * 2],
        ],
        { smooth: true },
      ),
      roll: new Track(
        [
          [0, 0],
          [0.06, 0.1],
          [0.24, -0.15],
          [ROLL_CATCH, 0.03],
          [ROLL_T, 0],
        ],
        { smooth: true },
      ),
      hy: new Track(
        [
          [0, 0],
          [0.08, 0.012],
          [0.25, -0.025],
          [ROLL_CATCH, 0.004],
          [ROLL_T, 0],
        ],
        { smooth: true },
      ),
      oz: new Track(
        [
          [0, 0],
          [0.1, front],
          [0.3, front],
          [0.42, 0],
          [ROLL_T, 0],
        ],
        { smooth: true },
      ),
      grip: new Track([
        [0, 0],
        [ROLL_CATCH - 0.05, 0],
        [ROLL_CATCH + 0.03, 1, smootherstep],
      ]),
      gripBlade: new Track([[0, goalBlade]]),
      latch: new Track([
        [0, 0],
        [0.05, 1, cubicInOut],
        [ROLL_T - 0.08, 1],
        [ROLL_T - 0.01, 0, cubicInOut],
      ]),
    },
    0,
    0,
    INDEX_AXIS.axis,
    INDEX_AXIS.at,
  );
}

/**
 * Aerial: Ausholen (Hand tief), Loslassen mit Schwung nach oben, das ganze Messer fliegt auf einer echten
 * Parabel in der Messer-Ebene (Schwerkraft "unten im Bild") und dreht `turns`-mal um den Schwerpunkt; die Kette
 * schlägt dabei frei (im freien Fall nur Fliehkraft) — Fang am Ausgangspunkt, Führung zum anderen Zustand.
 */
const AIR_WIND = 0.1;
const AIR_FLY = 0.35;
const DAIR_FLY = 0.36;
const AIR_SETTLE = 0.24;
/** Flugbahn vor den Fingern (Einheiten entlang der Messer-Normalen, + = Daumenseite). */
const AIR_FRONT = 2.5;
/** Schwerpunkt grob in der Griff-Mitte (Safe-Handle-Raum) — Drehpunkt der Flugdrehung. */
const AIR_CX = 0.4;
const AIR_CY = -4.2;
/**
 * Wurf-Schwerkraft (Einheiten/s²): etwas weicher als echt (981) — mit echter Schwerkraft wären 0.32 s Flug nur
 * 12 Einheiten hoch, die Bild-Hülle erlaubt ~10 über dem Griff (look.md); der Rest wirkt in der Kette als
 * leichtes Nachhängen der Griffe im Flug.
 */
const AIR_G = 780;
/** Schwerkraft in der Messer-Ebene (Messer-x/-y in Ruhe, Bild-unten projiziert), Ladezeit. */
const G_PLANE: readonly [number, number] = ((): [number, number] => {
  const u = VIEW_AXES.up;
  const gx = -(HOLD.x[0] * u[0] + HOLD.x[1] * u[1] + HOLD.x[2] * u[2]) * AIR_G;
  const gy = -(HOLD.y[0] * u[0] + HOLD.y[1] * u[1] + HOLD.y[2] * u[2]) * AIR_G;
  return [gx, gy];
})();

interface Aerial {
  readonly motion: TrackMotion;
  readonly catchTime: number;
  readonly total: number;
}

function aerialMotion(fly: number, turns: number, goalBlade: number): Aerial {
  const tc = AIR_WIND + fly;
  const total = tc + AIR_SETTLE;
  const motion = new TrackMotion(
    {
      // Doppel-Aerial fliegt höher: die Hand geht tiefer (Bild-Hülle).
      ...stageTracks(total, STAGE_X, turns > 1 ? STAGE_Y + 0.08 : STAGE_Y),
      // Die Flugbahn liegt etwas vor den Fingern (zur Daumenseite) und kommt erst zum Fang in den Kniff zurück —
      // das sich drehende Messer streift so nicht die Zeigefinger-Wurzel.
      oz: new Track(
        [
          [0, 0],
          [AIR_WIND + 0.08, AIR_FRONT],
          [tc - 0.05, AIR_FRONT],
          [tc, 0],
        ],
        { smooth: true },
      ),
      hy: new Track(
        [
          [0, 0],
          [AIR_WIND * 0.8, 0.03],
          [AIR_WIND + 0.08, -0.02],
          [tc - 0.06, -0.006],
          [tc + 0.05, 0.012],
          [total, 0],
        ],
        { smooth: true },
      ),
      roll: new Track(
        [
          [0, 0],
          [AIR_WIND, 0.16],
          [AIR_WIND + 0.1, -0.08],
          [tc, 0],
          [total, 0],
        ],
        { smooth: true },
      ),
      flex: new Track(
        [
          [0, 0],
          [AIR_WIND * 0.9, -0.3],
          [AIR_WIND + 0.06, 0.25],
          [AIR_WIND + 0.2, 0],
          [total, 0],
        ],
        { smooth: true },
      ),
      grip: new Track([
        [0, 0],
        [tc - 0.03, 0],
        [tc + 0.04, 1, smootherstep],
      ]),
      gripBlade: new Track([[0, goalBlade]]),
      latch: new Track([
        [0, 0],
        [0.05, 1, cubicInOut],
        [total - 0.08, 1],
        [total - 0.01, 0, cubicInOut],
      ]),
    },
    AIR_CX,
    AIR_CY,
    undefined,
    undefined,
    [AIR_WIND, fly, turns, G_PLANE[0], G_PLANE[1]],
  );
  return { motion, catchTime: tc, total };
}

// ------------------------------------------------------------------ Helikopter (Plan 007 KI8)

const SURF_FROM = 500;
const SURF_MIN = 0.5;
const HELI_UP = 0.35;
const HELI_STOP_MIN = 0.3;
const HELI_OUT = 0.3;
/** Drehzahl (rad/s): Grundwert + Anteil des Tempos beim Einstieg (einmal gelesen → Zeitleiste bleibt geschlossen). */
const HELI_W0 = 14;
const HELI_W_PER_SPEED = 0.012;
const HELI_W_MAX = 28;
const HELI_TILT = 0.55;
const HELI_POS: V3 = ((): V3 => {
  const t: [number, number, number] = [0, 0, 0];
  fingerTip(POSE_JOINTS[POSE.point], 0, t, 0.3);
  return viewPoint(t, 0, 0.8, 0);
})();
/** Griffe nach links/rechts, Klinge flach (Schneide nach unten weg): Stab entlang Bild-rechts. */
const HELI_BASE: V3 = viewRot([
  [2, -Math.PI / 2],
  [0, Math.PI / 2],
]);
const HELI_REL = relRot(KNIFE_HOLD_ROT, HELI_BASE);

const TAU = Math.PI * 2;
const P = VM_PARAM.knife;
const J = VM_JOINT;

export class KnifeTricks extends PropTricks<KnifeTrick> {
  /** Klinge offen (hält bis Respawn). */
  isOpen = false;
  private pick = 0;
  private surfOut = -1;
  private wasOpen = false;
  private heliW = HELI_W0;
  /** Auslauf ab surfOut: Winkel dort, Dauer bis zur vollen Umdrehung (einmal berechnet). */
  private stopFrom = 0;
  private stopTime = 0;
  /** Physik des laufenden Tricks (eine Instanz, je Trick neu gestartet). */
  readonly sim = new KnifeSim();
  private simTrick: KnifeTrick | 'none' = 'none';
  /** Zeit der Simulation (ein Rücksprung, z. B. festgehaltener Trick, startet sie neu). */
  private simT = -1;
  private catchAt = 0.5;
  private total = 0.5;
  // Bewegungen (Ladezeit, je Richtung)
  private readonly openM = flipMotion(OPEN_P, 0);
  private readonly closeM = flipMotion(CLOSE_P, Math.PI);
  private readonly rollOpen = rolloverMotion(0);
  private readonly rollClosed = rolloverMotion(Math.PI);
  private readonly airOpen = aerialMotion(AIR_FLY, 1, 0);
  private readonly airClose = aerialMotion(AIR_FLY, 1, Math.PI);
  private readonly dairOpen = aerialMotion(DAIR_FLY, 2, 0);
  private readonly dairClose = aerialMotion(DAIR_FLY, 2, Math.PI);
  /** Aufprall-Rate beim Fang (rad/s) für das Nachfedern der Hand. */
  private catchKick = 0.5;
  /**
   * Daumen gibt frei (Rollover, Aerial): Anteil 0..1 (geschlossen in der Trick-Zeit). afterPose schließt den Daumen
   * per GripSolver von der Pose roll Richtung balisong höchstens bis 1 − release und nur bis zum Kontakt mit dem
   * Messer — der Fang legt sich an, statt per Posenwechsel hineinzuspringen (Plan 008 Schritt 2).
   */
  private release = 0.5;
  private readonly grip = new GripSolver();
  private readonly shape: PropShape;
  private readonly gripJ = new Float32Array(23);
  private readonly gripC = new Float64Array(3);
  /** Kontakt-Grenze des Daumens (je Stufe, 1 = keine), einmal je Fang gesucht; Freigabe 0..1 (Trick-Zeit). */
  private readonly gripCap = new Float64Array(3).fill(1);
  private gripSolve = false;
  private gripFree = 0.5;
  private readonly sm: Mat3 = mat3();
  private readonly st: Mat3 = mat3();

  constructor() {
    super();
    // Hand als Hindernis der Physik (Ruhe-Griff): Bite Handle prallt an ihr ab, Klinge hält Abstand.
    const hand = new HandShape();
    hand.update(POSE_JOINTS[POSE.balisong]);
    this.sim.hand = hand;
    this.catchAt = 0;
    this.total = 0;
    this.catchKick = 0;
    this.release = 0;
    const sh = propShapeFor('knife');
    if (!sh) throw new Error('Messer ohne Kontakt-Körper (propShapes)');
    this.shape = sh;
  }

  override get trickNames(): readonly string[] {
    return KNIFE_NAMES;
  }

  protected override isState(id: KnifeTrick): boolean {
    return id === 'surfHeli';
  }

  protected override start(id: KnifeTrick): void {
    super.start(id);
    this.surfOut = -1;
    this.wasOpen = this.isOpen;
    this.heliW = clamp(HELI_W0 + HELI_W_PER_SPEED * this.lastSpeed, HELI_W0, HELI_W_MAX);
    this.simTrick = 'none';
    this.simT = -1;
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('surfHeli');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('surfHeli');
  }

  protected resetRun(): void {
    this.isOpen = false;
    this.writeRest(this.out);
  }

  protected writeRest(o: PropOut): void {
    o.pose = POSE.balisong;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = KNIFE_HOLD_POS[0];
    o.pos[1] = KNIFE_HOLD_POS[1];
    o.pos[2] = KNIFE_HOLD_POS[2];
    o.rot[0] = KNIFE_HOLD_ROT[0];
    o.rot[1] = KNIFE_HOLD_ROT[1];
    o.rot[2] = KNIFE_HOLD_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = 1;
    o.poof = -1;
    o.param[P.latch] = 0;
    this.release = 0;
    this.gripFree = 1;
    const b = this.isOpen ? 0 : Math.PI;
    o.knifeBlade = b;
    // Beide Griffe zusammen: absoluter Winkel des Bite Handle = 0.
    o.knifeBite = -b;
  }

  protected cooldownOf(id: KnifeTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    if (tier === 1) this.start(this.isOpen ? 'close' : 'open');
    else if (tier === 2) {
      // Plan 008 Schritt 2: Rollover jeder zweite statt jeder dritte (Takt, siehe COOLDOWN).
      const k = this.pick++ % 2;
      this.start(k === 0 ? 'rollover' : this.isOpen ? 'close' : 'open');
    } else this.start(good ? 'doubleAerial' : this.pick++ % 3 === 2 ? 'rollover' : 'aerial');
  }

  protected onMilestone(tier: number): void {
    // Meilensteine achten auf die Abklingzeit (wie die Münze, fallen.md #112): sonst folgte auf jeden Sprung-Trick ein
    // Meilenstein-Trick — L1 mit 1.5°-Hand 33.8 Tricks/min (Band 20–32).
    if (this.now < this.cooldownUntil) return;
    if (tier >= 3) this.start('doubleAerial');
    else if (tier === 2) this.start('rollover');
  }

  protected onIdle(): number {
    this.start(this.isOpen ? 'close' : 'open');
    return 2.2 + 1.6 * this.rand();
  }

  protected override onFinish(): void {
    this.start('doubleAerial');
  }

  /** Training (KI9): Stufe = auf- bzw. zuschnappen (Jubel), Lektion fertig = wie das Ziel. */
  protected override onLesson(done: boolean): void {
    if (done) this.onFinish();
    else this.start(this.isOpen ? 'close' : 'open');
  }

  /** Bewegung und Zeiten des Tricks (Zustand beim Start: wasOpen). */
  private motionFor(id: KnifeTrick): KnifeMotion {
    const open = this.wasOpen;
    if (id === 'open' || id === 'close') {
      const m = id === 'open' ? this.openM : this.closeM;
      this.catchAt = m.timing.tc;
      this.total = m.timing.total;
      return m.motion;
    }
    if (id === 'rollover') {
      this.catchAt = ROLL_CATCH;
      this.total = ROLL_T;
      return open ? this.rollOpen : this.rollClosed;
    }
    // Aerial: der Fang wechselt den Zustand.
    const a = id === 'doubleAerial' ? (open ? this.dairClose : this.dairOpen) : open ? this.airClose : this.airOpen;
    this.catchAt = a.catchTime;
    this.total = a.total;
    return a.motion;
  }

  protected evaluate(id: KnifeTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'surfHeli') return this.heli(t, inp, o);
    const sim = this.sim;
    if (this.simTrick !== id || t < this.simT) {
      // (Neu-)Start: auch ein festgehaltener Trick (Tools) rechnet ab 0 bis zur Haltezeit.
      const m = this.motionFor(id);
      const b = this.wasOpen ? 0 : Math.PI;
      sim.start(m, KNIFE_HOLD_POS, KNIFE_HOLD_ROT, b, -b);
      this.simTrick = id;
    }
    this.simT = t;
    sim.advanceTo(t);
    const ch = sim.channels(t);
    o.hx = ch[KM.hx] + ch[KM.sx];
    o.hy = ch[KM.hy] + ch[KM.sy];
    o.hz = ch[KM.hz];
    o.hpitch = ch[KM.pitch];
    o.hyaw = ch[KM.yaw];
    o.hroll = ch[KM.roll];
    o.jointAdd[J.wristFlex] += ch[KM.flex];
    o.jointAdd[J.wristDev] += ch[KM.dev];
    o.jointAdd[J.wristTwist] += ch[KM.twist];
    o.param[P.latch] = ch[KM.latch];
    sim.socketAt(t, o.pos, o.rot);
    o.knifeBlade = sim.bladeAt(t);
    o.knifeBite = sim.bite;
    const aerial = id === 'aerial' || id === 'doubleAerial';
    // Daumen gibt frei, solange das Messer rollt bzw. fliegt (sonst läge er in der Bahn); zum Fang schließt er sich
    // weich bis zum Kontakt (afterPose, GripSolver). Die Finger bleiben, wo die Physik sie als Hindernis kennt.
    this.release = 0;
    if (id === 'rollover') this.release = smooth(phase(t, 0, 0.08)) * (1 - smooth(phase(t, ROLL_CATCH - 0.09, ROLL_CATCH + 0.02)));
    if (aerial) {
      this.release = smooth(phase(t, AIR_WIND * 0.7 - 0.02, AIR_WIND * 0.7 + 0.03)) * (1 - smooth(phase(t, this.catchAt - 0.09, this.catchAt + 0.02)));
      if (this.mark(0, AIR_WIND, t)) this.kick(o, -0.6, 0);
    }
    // Fang beginnt: Daumen-Kontakt einmal suchen (afterPose); 0.12 s später gibt die Grenze frei.
    const closeAt = this.catchAt - 0.09;
    if ((id === 'rollover' || aerial) && this.mark(2, closeAt, t)) this.gripSolve = true;
    this.gripFree = smooth(phase(t, closeAt + 0.02, closeAt + 0.14));
    if (t < closeAt) this.gripCap.fill(1);
    if (this.mark(1, this.catchAt, t)) {
      // Fang: Ruck in die Hand, kurzes Nachfedern (Stärke aus der Relativ-Drehung beim Greifen).
      const w = Math.abs(sim.chain.outQd[1] - sim.chain.outQd[0]) + Math.abs(sim.chain.outQd[0]);
      this.catchKick = clamp(w * 0.04, 0.4, 2.2);
      this.kick(o, aerial ? 0.45 : 0.18, aerial ? -1.0 : -0.45);
      this.spinKick(aerial ? -2.2 : this.wasOpen ? 1.6 : -1.6);
    }
    // Nachfedern der Finger nach dem Fang (Mittel-/Ringfinger zucken mit, Overlap).
    const since = t - this.catchAt;
    if (since > 0) {
      const sp = settle(this.catchKick, since, Math.PI * 2 * 5, 0.4);
      o.jointAdd[J.finger + 4 + 1] += sp * 0.6;
      o.jointAdd[J.finger + 8 + 1] += sp * 0.8;
      // Der Daumen drückt beim Fang nach (Kniff federt), Zeigefinger hält dagegen.
      o.jointAdd[J.thumbIp] += sp * 0.5;
      o.jointAdd[J.finger + 3] += sp * 0.3;
    }
    if (t >= this.total) {
      this.release = 0;
      if (id !== 'rollover') this.isOpen = id === 'open' ? true : id === 'close' ? false : !this.wasOpen;
      this.writeRest(o);
      this.simTrick = 'none';
      return true;
    }
    return false;
  }

  /**
   * Daumen-Kniff beim Fang: von der Pose roll (frei) Richtung balisong, höchstens bis 1 − release. Zu Beginn des
   * Schließens sucht der GripSolver EINMAL (Ereignis), wo der Daumen das Messer dieses Frames berührt (Kontakt-Körper aus
   * Sockel, Klinge, Bite Handle); bis 0.12 s danach hält ihn diese Grenze, dann gibt sie auf den Ruhe-Griff frei (die
   * Physik führt das Messer dorthin). Je Frame gerechnet boxte GripSolver.close Kommazahlen (fingerContact intern,
   * 30–60 Scavenges je 30 000 Frames) — darum nur am Ereignis. Der Unterschied zur überblendeten Pose geht in jointAdd;
   * mit release → 0 blendet er auf 0 (Ruhe-Griff unverändert).
   */
  override afterPose(joints: ArrayLike<number>, _inp: PropFrameInput, _dt: number): void {
    const r = this.release;
    if (!(r > 0)) return;
    const o = this.out;
    const jw = this.gripJ;
    for (let i = 0; i < jw.length; i++) jw[i] = joints[i];
    const cap = this.gripCap;
    if (this.gripSolve) {
      this.gripSolve = false;
      const R = socketMatrix(o.rot, o.spin, this.sm, this.st);
      this.shape.setLink(0, R, o.pos[0], o.pos[1], o.pos[2], o.scale);
      knifeLinks(this.shape, R, o.pos, o.scale, o.knifeBlade, o.knifeBite);
      this.grip.close(jw, POSE_JOINTS[POSE.roll], POSE_JOINTS[POSE.balisong], this.shape, GRIP_THUMB, -0.1, 1);
      for (let k = 0; k < 3; k++) cap[k] = this.grip.curl[12 + k];
      for (let i = 0; i < jw.length; i++) jw[i] = joints[i];
    }
    // Grenze aus dem Kontakt: hält kurz, gibt dann frei (1 = keine Grenze).
    const free = this.gripFree;
    const c = this.gripC;
    const lim = 1 - r;
    for (let k = 0; k < 3; k++) {
      const g = cap[k] + (1 - cap[k]) * free;
      c[k] = g < lim ? g : lim;
    }
    applyStages(jw, 4, c, POSE_JOINTS[POSE.roll], POSE_JOINTS[POSE.balisong]);
    for (let k = J.thumbAbd; k <= J.thumbIp; k++) o.jointAdd[k] += jw[k] - joints[k];
  }

  /** Drehwinkel des Rotors bis Trick-Zeit t: linearer Hochlauf über HELI_UP, dann konstant (geschlossen). */
  private heliAngle(t: number): number {
    const w = this.heliW;
    return t < HELI_UP ? (w * t * t) / (2 * HELI_UP) : w * (t - HELI_UP / 2);
  }

  /**
   * Helikopter (KI8): aus dem Griff auf die Fingerspitze (Lage per Achse-Winkel), aufklappen falls zu,
   * flach um die Bild-Hochachse drehen. Surf-Ende: gleichmäßig abbremsen bis auf eine volle Umdrehung
   * (Rotor = Ausgangslage), dann zurück in den Griff. Alles geschlossene Funktionen der Trick-Zeit.
   */
  private heli(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) {
      this.surfOut = t;
      const w = this.heliW;
      const a = this.heliAngle(t);
      const k = Math.ceil((a + (w * HELI_STOP_MIN) / 2) / TAU);
      this.stopFrom = a;
      this.stopTime = (2 * (TAU * k - a)) / w;
    }
    let angle: number;
    let e = smooth(t / HELI_UP);
    if (this.surfOut < 0) angle = this.heliAngle(t);
    else {
      const s = clamp((t - this.surfOut) / this.stopTime, 0, 1);
      angle = this.stopFrom + this.heliW * this.stopTime * (s - (s * s) / 2);
      e *= 1 - smooth((t - this.surfOut - this.stopTime) / HELI_OUT);
    }
    this.rotateLocal(o, HELI_REL[0], HELI_REL[1], HELI_REL[2], HELI_REL[3] * e);
    this.rotateView(o, 0, 1, 0, angle % TAU);
    this.rotateView(o, 1, 0, 0, HELI_TILT * e);
    for (let k = 0; k < 3; k++) o.pos[k] += (HELI_POS[k] - o.pos[k]) * e;
    // Einlage (PropTricks.beatU): der Rotor springt von der Fingerspitze hoch, kippt kurz und landet wieder.
    const u = this.beatU;
    if (u < 1) {
      const a = 4 * u * (1 - u);
      this.offsetView(o, 0.3 * a * e, 2.6 * a * e, 0.6 * a * e);
      this.rotateView(o, 0, 0, 1, 0.35 * bell(u) * e);
    }
    if (this.beatEnd()) this.kick(o, 0.12, -0.3);
    // Aufklappen in den ersten HELI_UP s (war es zu), danach offen.
    const beta = this.wasOpen ? 0 : Math.PI * (1 - smooth(t / HELI_UP));
    o.knifeBlade = beta;
    o.knifeBite = -beta;
    if (t >= HELI_UP) this.isOpen = true;
    o.pose = e > 0.3 ? POSE.point : POSE.balisong;
    o.poseTau = 0.06;
    if (this.mark(0, HELI_UP, t)) this.kick(o, 0.1, -0.25);
    const end = this.surfOut >= 0 ? this.surfOut + this.stopTime + HELI_OUT : Infinity;
    if (t >= end) {
      this.writeRest(o);
      return true;
    }
    return false;
  }
}
