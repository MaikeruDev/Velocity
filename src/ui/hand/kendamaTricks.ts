import { VM_JOINT, VM_JOINT_COUNT, VM_STRING_POINTS } from '../../render/types';
import { arc, bell, clamp, smooth } from './anim';
import { Track, quadIn } from './curves';
import { GRIP_FINGERS, GRIP_THUMB, GripSolver } from './fingerContact';
import { POSE, POSE_JOINTS } from './poses';
import { Prim, PropShape } from './propShape';
import { PropOut, PropTricks } from './propTricks';
import type { PropFrameInput } from './propTricks';
import { VIEW_ALIGNED, VIEW_AXES, axisAngleQ, fromEulerXYZ, mat3, mul, toEulerXYZ } from './rot';
import type { Mat3 } from './rot';
import { Toss, settle } from './rigid';
import { Rope, RopeDrive, RopeHandGuard } from './rope';
import { socketOf, viewRot } from './view';
import type { V3 } from './view';

/**
 * Kendama (Plan 007 KI6, Plan 008 Schritt 2): Ken im Hammergriff, Kugel (tama) an 9 Einheiten Schnur als zweiter
 * Körper. In Ruhe hängt die Kugel als freies Pendel (Verlet-Schnur, RopeDrive) — und liegt seit Plan 008 an der
 * Hand an statt im Daumen zu stecken: Schnur, Sehnen und hängende Kugel werden aus dem Hand-Modell geschoben
 * (RopeHandGuard, reine Abbildung — keine Rückwirkung auf die Pendel-Physik).
 * Kippen der Becher: halb Unterarm-Rolle, halb Handgelenk um dieselbe Bild-Tiefenachse (Ken fest im Griff).
 * Takt (event-probe, Band 25–45 %): Fänge kurz gehalten (Loslassen 0.5 s, Einschwingen 0.18 + 0.18 s).
 *
 * Plan 008 — echte Ballistik statt Bahn-Kurven: jeder Fang beginnt mit "Knie beugen" (Hand sinkt, das Pendel
 * spürt es über die Scheinkraft), dann reißt die Hand hoch, die Kugel fliegt als geschlossene Parabel
 * (`rigid.Toss`, Schwerkraft "unten im Bild") vom Pendel-Punkt zum Becher, wo der Becher zur Fangzeit stehen WIRD
 * (Ken-Zeitleiste vorausgerechnet, Rest-Versatz durch Wackeln klingt mit u³ ein). Fang = "Klack": Hand-Impuls,
 * der Becher federt zurück (`settle`), die Kugel ruckelt im Becher nach. Ab der Fang-Marke steht die Kugel-Mitte
 * EXAKT auf dem Fangpunkt (gleiche Sockel-Transformation wie der Renderer) — bei jeder Framerate.
 *
 * Tricks: großer/kleiner Becher, Spike (Kugel dreht das Loch nach unten, landet auf der Spitze und WACKELT, die Hand
 * balanciert gegen), Around Japan (klein → groß → Spitze, Hüpfer als echte Parabeln von Becher zu Becher), Airplane
 * (Overdrive: Griffwechsel auf die Kugel, der Ken fällt, schwingt an der Schnur über die Hand und landet mit der Spitze
 * im Loch, zurück per Ken-Wurf mit halber Drehung), cupRide (Surf-Zustand, Kugel liegt im großen Becher).
 * Auswahl: Stand groß/klein, jedes 3. Mal Around Japan; Lauf groß/klein; Flow klein/Around Japan/groß; Overdrive
 * Spike/Around Japan/groß/Airplane, guter Hop Spike, Spike, Around Japan; Ziel Spike.
 * Abwechslung (Review Phase 2): vorher machte bigCup 55–100 % der Starts — Zähler je Stufe, Checkpoint/Meilenstein im
 * Wechsel.
 */

export const KENDAMA_TRICKS = ['none', 'bigCup', 'smallCup', 'aroundJapan', 'spike', 'airplane', 'cupRide'] as const;
export type KendamaTrick = Exclude<(typeof KENDAMA_TRICKS)[number], 'none'>;
const KENDAMA_NAMES: readonly string[] = KENDAMA_TRICKS.filter((t) => t !== 'none');

/** Tricks je Tempo-Stufe bei Sprüngen (Tests prüfen genau diese Zuordnung). Airplane hinten (Reihenfolge davor bleibt). */
export const KENDAMA_TIER_TRICKS: readonly (readonly KendamaTrick[])[] = [[], ['bigCup', 'smallCup'], ['smallCup', 'aroundJapan', 'bigCup'], ['spike', 'aroundJapan', 'bigCup', 'airplane']];

/** Schnur (Hand-Einheiten): hängend bleibt die Kugel so im Bild (11 war zu lang). */
export const KEN_STRING = 9;
/**
 * Plan 008 (Griff-Audit): Ken 1.5×, Kugel Ø 5 cm. Fangpunkte KEN_* im Ken-Raum (skaliert mit o.scale über
 * socketOf), Schnur bleibt 9 (hängend im Bild).
 */
export const KEN_SCALE = 1.5;
export const TAMA_R = 2.5;
/** Punkte im Ken-Raum (items/kendama: großer Becher +x, kleiner −x, Spitze oben). Kugel-Mitte beim Fang. */
export const KEN_BIG_CUP: V3 = [3.75, 0.3, 0];
export const KEN_SMALL_CUP: V3 = [-4.35, 0.3, 0];
export const KEN_SPIKE: V3 = [0, 3.5, 0];
/**
 * Schnur-Ansatz: hinten links am Querstück (Plan 008). Vorn in der Mitte hing die Kugel gerade nach unten 1.5 tief im
 * Daumen; hinten links hängt sie frei neben der Faust (0.6 Luft, tools/critique-Suche über die Hängelage).
 */
export const KEN_STRING_AT: V3 = [-1.0, 0.3, -0.9];

/**
 * Griff: Handgriff-Mitte im Faust-Tunnel der Pose ken, Spitze oben, leicht nach links. Plan 008 Schritt 2: 0.45
 * Einheiten aus der Handfläche heraus (Suche gegen das Hand-Modell: Handfläche −0.34 → −0.16, Glove-Polster), dazu
 * Zeigefinger-Endglied und Daumen-Opposition minimal nachgestellt (KEN_GRIP_ADD, sonst steckten sie danach im Griff).
 */
const KEN_TILT = 0.25;
export const KEN_HOLD_ROT: V3 = viewRot([[2, KEN_TILT]]);
export const KEN_HOLD_POS: V3 = [-5.9953, 8.4101, -3.4876];
const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
/** Gelenk-Versatz zur Pose ken (VM_JOINT-Layout), in afterPose ungeskaliert (statischer Griff, auch bei motionFx < 1). */
export const KEN_GRIP_ADD = ((): Float32Array => {
  const a = new Float32Array(VM_JOINT_COUNT);
  a[VM_JOINT.finger + 2] = -2 * DEG;
  a[VM_JOINT.finger + 3] = -4 * DEG;
  a[VM_JOINT.thumbOpp] = 4 * DEG;
  return a;
})();

/**
 * Airplane: Kugel im Griff (Pose grip, Finger per Kontakt an die Kugel gelegt — Ladezeit, GripSolver.close). Mitte
 * vor der Handfläche (deren Fläche liegt bei z ≈ −2.2), so liegt die Kugel am Ballen an. Plan 008: BALL_LIFT Einheiten
 * höher im Bild — die Finger halten die untere Hälfte, das Loch oben bleibt frei; tiefer griffen Zeige-/Mittelfinger
 * über die Kugel und der kopfüber landende Ken stieß mit dem Querstück 1.4 in sie (Rastersuche Höhe × Ken-Drehung).
 */
const BALL_LIFT = 4;
export const BALL_HOLD: V3 = [0.6 + VIEW_AXES.up[0] * BALL_LIFT, 10.2 + VIEW_AXES.up[1] * BALL_LIFT, -5.1 + VIEW_AXES.up[2] * BALL_LIFT];
export const BALL_GRIP_ADD = ((): Float32Array => {
  const shape = new PropShape([{ kind: Prim.Sphere, at: [BALL_HOLD[0], BALL_HOLD[1], BALL_HOLD[2]], size: [TAMA_R] }]);
  const g = POSE_JOINTS[POSE.grip];
  const j = new Float32Array(g);
  new GripSolver().close(j, POSE_JOINTS[POSE.open], POSE_JOINTS[POSE.fist], shape, GRIP_FINGERS | GRIP_THUMB, 0.05);
  for (let k = 0; k < j.length; k++) j[k] -= g[k];
  return j;
})();

/** Kippwinkel (Bild, gegen den Uhrzeigersinn positiv): großer Becher nach oben (+), kleiner (−); Anteil Hand. */
const CUP_TILT = 1.0;
/**
 * Plan 008: der Ken kippt mit der Hand, nie im Griff (im Hammergriff kann er sich in der Faust nicht drehen; zu 55 % im
 * Griff gedreht stach er 2.4 cm in die Handfläche). Aufgeteilt wie beim Menschen: HAND_SHARE als Unterarm-Rolle
 * (hroll), der Rest als Handgelenk-Drehung um dieselbe Bild-Tiefenachse (Gelenk-Versatz, Ken fest im Handgelenk-Raum).
 * Ganz über den Unterarm (1.2 rad) lag der Arm quer im Bild. Würfe rechnen im ungerollten Arm-Raum (Gesamtrolle,
 * armRot), Schwerkraft bleibt "unten im Bild"; alle Drehpunkte (Bewegung, Arm, Handgelenk) liegen im selben Ursprung.
 */
const HAND_SHARE = 0.5;
/** Wurf-Schwerkraft (Einheiten/s²): etwas unter echt — Würfe von 0.3–0.4 s bleiben so in der Bild-Hülle. */
const KEN_G = 820;
/** Loch nach unten auf der Spitze: halbe Drehung plus eine volle, ausgerichtet auf die Ken-Achse. */
const SPIKE_TURN = Math.PI * 3 + KEN_TILT;

/** Abklingzeiten: um das Einschwingen nach dem Loslassen (+0.4 s Trick-Dauer) gekürzt — der Takt bleibt (event-probe). */
const COOLDOWN: { readonly [K in KendamaTrick]: number } = { bigCup: 1.35, smallCup: 1.35, aroundJapan: 2.0, spike: 1.5, airplane: 1.7, cupRide: 0.5 };

// ---------------------------------------------------------------- Becher-Fang (groß/klein)
/** Knie beugen bis C_LAUNCH, dann Riss: Kugel fliegt bis C_CATCH, liegt bis C_REL, Ken kippt zurück bis C_END. */
const C_LAUNCH = 0.13;
const C_CATCH = 0.43;
const C_REL = 0.5;
/**
 * Einschwingen nach dem Loslassen (s): Schnipp zur freien Seite, dann kritisch gedämpft, danach freies Pendel. Plan 008:
 * 0.22 + 0.42 machten jeden Fang 0.66 s länger — Kendama lag bei 54–60 % Trick-Anteil (Band 25–45, event-probe; Raster
 * über Loslassen × Einschwingen × Abklingzeit). cupRide (Surf-Zustand, zählt nicht zum Takt) behält das lange
 * Einschwingen RIDE_SET_*: kurz lief die Kugel aus dem schräg gehaltenen Becher durch den Zeigefinger (−1.0).
 */
const SET_T1 = 0.18;
const SET_T2 = 0.18;
const RIDE_SET_T1 = 0.22;
const RIDE_SET_T2 = 0.42;
const C_END = C_REL + SET_T1 + SET_T2 + 0.02;
const TILT_IN = 0.24;
const TILT_OUT = 0.24;
/** Hand (Bildhöhen, + = unten): Knie beugen, hochreißen, mitgehen bis zum Fang (der Klack-Ruck kommt per Impuls). */
const HY_PULL = new Track(
  [
    [0, 0],
    [C_LAUNCH, 0.024],
    [0.2, -0.016],
    [0.32, -0.006],
    [C_CATCH, 0],
  ],
  { smooth: true },
);

// ---------------------------------------------------------------- Spike
const S_LAUNCH = 0.12;
const S_CATCH = 0.44;
const S_REL = 0.7;
const S_END = S_REL + SET_T1 + SET_T2 + 0.02;
const HY_SPIKE = new Track(
  [
    [0, 0],
    [S_LAUNCH, 0.026],
    [0.2, -0.02],
    [0.34, -0.008],
    [S_CATCH, 0],
  ],
  { smooth: true },
);

// ---------------------------------------------------------------- Around Japan
const AJ_SMALL = C_CATCH;
const AJ_HOP1 = 0.56;
/** Hüpfer kurz (0.26/0.28 s): mit 0.36/0.40 s stiegen sie bis −0.44 Bildhöhen (Hülle −0.338). */
const AJ_BIG = 0.82;
const AJ_HOP2 = 0.94;
const AJ_SPIKE = 1.22;
const AJ_REL = 1.42;
/** Kippen zwischen den Fängen (s) — vor dem nächsten Fang auf dem Plateau. */
const AJ_TURN = 0.22;
const AJ_END = AJ_REL + SET_T1 + SET_T2 + 0.02;
const HY_AJ = new Track(
  [
    [0, 0],
    [C_LAUNCH, 0.024],
    [0.2, -0.016],
    [0.32, -0.006],
    [AJ_SMALL, 0],
    [0.51, 0.006],
    [0.58, -0.012],
    [0.68, 0],
    [0.88, 0.006],
    [0.96, -0.014],
    [1.1, -0.004],
    [AJ_SPIKE, 0],
    [1.36, -0.02],
    [1.56, 0],
  ],
  { smooth: true },
);

// ---------------------------------------------------------------- Airplane
const A_LAUNCH = 0.12;
/** Zeigefinger gestreckt auf der Kugel (rad, Grund-/Mittelgelenk) und Einblendzeit vor der Landung (s). */
const IDX_LIFT_MCP = 1.3;
const IDX_LIFT_PIP = 1.2;
const IDX_LIFT_IN = 0.15;
/** Faust schließt sich so lange vor dem Ken-Fang (s). */
const A_CLOSE = 0.02;
const CLOSE_TAU = 0.05;
/** Daumen beim Ken-Fang gespreizt (rad, Buckel) und Zeit bis zum Höchstwert (s, Höhepunkt am Fang). */
const THUMB_OPEN = 0.4;
const THUMB_OPEN_T = 0.1;
/** Mittelfinger beim Ken-Fang voraus (rad) und Zeit bis zum Höchstwert (s). */
const MID_LEAD = 0.3;
const MID_LEAD_T = 0.06;
/** Faust öffnet sich so lange vor dem Ken-Abwurf (s). */
const A_OPEN = 0.07;
/** Finger geben die Kugel so lange vor dem Ken-Rückwurf frei (s). */
const A_FREE = 0.12;
/**
 * Bogen der Ken-Würfe (Bildrichtungen, Scheitel in der Mitte des Flugs): hinaus nach links und von der Kamera weg (der
 * alte Bogen zur Kamera lief durch den Daumen, −1.35), zurück über die Kugel nach oben.
 */
const OB_C = -3;
const OB_R = -5;
const OB_U = 0;
const RB_C = 0;
const RB_R = 0;
const RB_U = 3;
const A_KEN_OUT = 0.14;
const A_BALL_IN = 0.4;
const A_SWING = 0.52;
const A_LAND = 1.06;
const A_FLIP = 1.4;
const A_KEN_IN = 1.72;
const A_END = 2.0;
/** Kugel kommt unter dem gefangenen Ken zur Ruhe, dann freies Pendel. */
const A_DROP = A_KEN_IN + 0.16;
/** Schwung: Winkel der Ken-Lage um die Kugel (rad, 0 = rechts, π/2 = oben), Start links unten. */
const A_PHI0 = -Math.PI / 2 - 0.7;
/** Ende des Schwungs: oben über der Kugel — im Uhrzeigersinn über die linke, freie Seite (rechts liegt der Unterarm). */
const A_PHI1 = -Math.PI * 1.5;
/** Abstand Ken-Ursprung ↔ Kugel bei gespannter Schnur (Schnur 9 vom Querstück, 0.45 darüber, 1.35 zur Kamera). */
const A_R0 = 0.45 + Math.sqrt(KEN_STRING * KEN_STRING - 1.35 * 1.35);
/** Auf der Kugel: Ken-Ursprung über der Kugel-Mitte (Spitze im Loch). */
const A_R1 = KEN_SPIKE[1] * KEN_SCALE;
/** Bühne des Airplane nach unten (Bildhöhen): der schwingende Ken blieb sonst nicht in der Hülle (−0.368 / −0.314). */
const AIR_STAGE_DOWN = 0.11;
const AIR_STAGE = new Track(
  [
    [0, 0],
    [0.45, 1],
    [1.45, 1],
    [1.95, 0],
  ],
  { smooth: true },
);
const SWING = new Track(
  [
    [0, 0],
    [0.5, 0.56],
    [1, 1],
  ],
  { smooth: true },
);
/** Ken wackelt auf der Kugel (rad um die Kugel-Mitte): Anfangsrate, Kreisfrequenz, Dämpfung. */
const A_WOB_V = -1.4;
const A_WOB_W = Math.PI * 2 * 2.6;
const A_WOB_Z = 0.22;
const HY_AIR = new Track(
  [
    [0, 0],
    [A_LAUNCH, 0.02],
    [0.2, -0.018],
    [A_BALL_IN, 0],
    [0.62, -0.028],
    [0.86, -0.012],
    [A_LAND, 0],
    [1.32, 0.012],
    [1.44, -0.022],
    [1.62, 0],
  ],
  { smooth: true },
);

/** Ausholpunkt (rad aus dem Lot): links und zur Kamera — frei von der Faust (tools/critique-Suche). */
const SWA = -0.7;
const SWB = 0.3;
/** Airplane-Rückweg: die fallende Kugel vor den Fingern vorbei (Einheiten zur Kamera). */
const DROP_FRONT = 2;
const SURF_FROM = 500;
const SURF_MIN = 0.5;
/** Abklingen der Kugel-Drehung nach dem Loslassen (s). */
const TURN_TAU = 0.25;
/** Projektion der Kugel aus der Hand blendet nach dem Loslassen so lange ein (s, Trick-Zeit). */
const RELEASE_FADE = 0.15;
/** cupRide (Surf): Kugel springt zum Becher (alte Bahn: Gerade + Bogen), hüpft als Einlage. */
const TURN = 0.15;
const FLIGHT = 0.34;
const BACK = 0.22;
const RIDE_HOP = 4.5;
/** Ruckeln der Kugel im Becher nach einem Fang (rad/s Anfangsrate der gedämpften Schwingung). */
const JIG = 7;
const JIG_W = Math.PI * 2 * 5;
const JIG_Z = 0.3;

const enum Ball {
  /** Freies Pendel. */
  Free = 0,
  /** Alte Bahn (Gerade + Bogen, `fly`/`hop`) — nur cupRide. */
  Arc = 1,
  /** Wurf-Parabel (Toss) seit `tossAt`. */
  Toss = 2,
  /** Liegt im Ziel (exakt). */
  Caught = 3,
  /** In der Hand (Airplane), BALL_HOLD. */
  Held = 4,
  /** Ausholen vor dem Wurf: auf der Schnur-Kugelschale vom Pendel zum Ausholpunkt (geschlossen). */
  Swing = 7,
  /** Fällt aus der Hand, die Schnur hält sie am fliegenden Ken (Airplane-Rückweg, geschlossen in der Zeit). */
  Drop = 5,
  /** Nach dem Loslassen: Schnipp zur freien Seite, dann kritisch gedämpft ins Hängen (geschlossen in der Zeit). */
  Settle = 6,
}

type V = Float64Array;

/** Winkel auf (−π, π]. */
function wrapPi(a: number): number {
  const t = Math.PI * 2;
  return a - t * Math.floor((a + Math.PI) / t);
}

/** Ken-Lage beim Airplane-Schwung (Ursprung um die Kugel, Spitze zur Kugel) → pos; Rückgabe: Winkel um die Bild-Tiefenachse. */
function swingPos(phi: number, r: number, out: V | Float32Array): number {
  const A = VIEW_AXES;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  for (let k = 0; k < 3; k++) out[k] = BALL_HOLD[k] + (A.right[k] * c + A.up[k] * s) * r;
  return phi + Math.PI / 2;
}

/** Ken-Würfe des Airplane (Ladezeit, fest): raus aus der Faust zum Schwung-Start, zurück von der Kugel in den Griff. */
const A_TOSS_OUT = ((): Toss => {
  const t = new Toss(KEN_G);
  const to = new Float64Array(3);
  const a1 = swingPos(A_PHI0, A_R0, to);
  t.plan(KEN_HOLD_POS, to, A_SWING - A_KEN_OUT, KEN_TILT, a1);
  return t;
})();
/**
 * Loslassen ohne Fall durch die Hand (Plan 008): rechts neben der Hängelage liegt die Hand — ein freies Pendel aus
 * dem Becher schwang tief durch sie hindurch (und ein Kontakt in der Kette war chaotisch: Frameraten liefen um
 * Einheiten auseinander). Stattdessen schnippt der Ken die Kugel in setT1 s über sich hinweg zur FREIEN Seite
 * (SET_A0 links der Senkrechten, gespannte Schnur), von dort schwingt sie kritisch gedämpft (kein Überschwingen in die
 * Hand) zur Senkrechten und ist nach setT2 s wieder ein freies Pendel — mit der exakten Geschwindigkeit der Bahn.
 */
const SET_A0 = -0.95;
const SET_W = Math.sqrt(KEN_G / KEN_STRING);
/** Schnur-Ansatz am Ken in Ruhe. */
const S_REST = ((): Float64Array => {
  const o = { pos: KEN_HOLD_POS, rot: Float32Array.from(KEN_HOLD_ROT), spin: 0, scale: KEN_SCALE };
  const p = new Float64Array(3);
  socketOf(o, KEN_STRING_AT, p);
  return p;
})();

/** Ruhe-Hängelage unter dem gehaltenen Ken (Schnur gerade nach unten). */
const A_HANG = ((): Float64Array => {
  const o = { pos: KEN_HOLD_POS, rot: Float32Array.from(KEN_HOLD_ROT), spin: 0, scale: KEN_SCALE };
  const p = new Float64Array(3);
  socketOf(o, KEN_STRING_AT, p);
  for (let k = 0; k < 3; k++) p[k] -= VIEW_AXES.up[k] * KEN_STRING;
  return p;
})();
const A_WOB_FLIP = settle(A_WOB_V, A_FLIP - A_LAND, A_WOB_W, A_WOB_Z);
const A_TOSS_BACK = ((): Toss => {
  const t = new Toss(KEN_G);
  const from = new Float64Array(3);
  const a0 = swingPos(A_PHI1 + A_WOB_FLIP, A_R1, from);
  // Halbe Drehung VORWÄRTS zurück in den Griff: rückwärts (−2π) fegte das Griff-Ende kurz vor dem Fang durch die
  // Handfläche (−2.3).
  t.plan(from, KEN_HOLD_POS, A_KEN_IN - A_FLIP, a0, KEN_TILT);
  return t;
})();

export class KendamaTricks extends PropTricks<KendamaTrick> {
  readonly rope = new Rope({ segments: VM_STRING_POINTS - 1, length: KEN_STRING, substep: 1 / 240, iterations: 4, endWeight: 0.15 });
  readonly drive = new RopeDrive();
  /** Gezeigte Schnur und hängende Kugel aus der Hand geschoben (Plan 008: vorher lag die Kugel 0.57 im Daumen). */
  readonly guard = new RopeHandGuard();
  /** Reihum je Tempo-Stufe (ein gemeinsamer Zähler ließ bei wechselnden Stufen einen Trick überwiegen: 52 % bigCup). */
  private readonly picks = [0, 0, 0, 0];
  private goodCount = 0;
  private milestoneCount = 0;
  private cpCount = 0;
  private idleCount = 0;
  // Zeitleisten-Ergebnis → Aufbau in afterPose (braucht die Ken-Lage dieses Frames).
  private ball: Ball = Ball.Free;
  private target: V3 = KEN_BIG_CUP;
  /** Start der Bahn: Kugel-Mitte (Handgelenk-Raum), einmal beim Abwurf eingefangen. */
  private readonly from: V = new Float64Array(3);
  private fromTarget: V3 | null = null;
  // Kommazahl-Felder des Frame-Pfads mit Double-Startwert, der Konstruktor setzt sie (fallen.md #107.4).
  private fly = 0.5;
  private hop = 3.5;
  /** Kugel-Drehung um die Bild-Tiefenachse (Loch nach unten beim Spitzen-Fang). */
  private ballTurn = 0.5;
  /** Zuletzt in subRot geschriebene Drehung (NaN = noch nie). */
  private shownTurn = Number.NaN;
  private launched = -1.5;
  /** Trick-Zeit, ab der die Kugel wieder frei ist (Loslassen nach dem Fang), −1 = noch nicht. */
  private releaseAt = -1.5;
  private surfOut = -1.5;
  /** cupRide: Landezeit des letzten Hüpfers im Becher (Trick-Zeit), −1 = keiner. */
  private landAt = -1.5;
  /** Ziel bricht ab, während die Kugel geführt ist (Flug/Becher): die Spitze startet von dort, ohne loszulassen. */
  private carry = false;
  // Wurf (Toss): Start, Dauer, geplante Ziel-/Start-Lage, Drehung von/bis, Ziel = Hand (Airplane).
  private readonly toss = new Toss(KEN_G);
  private tossAt = 0.5;
  private tossT = 0.5;
  private planned = false;
  private toHand = false;
  /** Ziel-Abbruch während geführter Kugel → Spike fliegt von dort (statt Ausholen aus dem Pendel). */
  private carrySpike = false;
  /** Ausholen: Start-Lage aus dem Pendel eingefangen; Ausholpunkt (Handgelenk-Raum) und dessen Zeit. */
  private swung = false;
  private readonly swW: V = new Float64Array(3);
  private swT = 0.5;
  /** Modus vor dem Loslassen (Caught/Drop) und: die Zeitleiste hat die Drehung dieses Frames gesetzt. */
  private relMode: Ball = Ball.Caught;
  private turnFixed = false;
  /** Freie Drehung: Wert und absolute Zeit (now) beim Loslassen — Abklingen geschlossen, auch nach dem Trick-Ende. */
  private turnVal0 = 0.5;
  private turnNow0 = 0.5;
  private readonly g0: V = new Float64Array(3);
  /** Unterarm-Rolle (rollAt) und Puffer im Arm-Raum. */
  private rho = 0.5;
  /** Handgelenk-Anteil der Kippung (rad, tilt) der zuletzt gerechneten Zeitleiste und des gezeigten Frames. */
  private wroll = 0.5;
  private wrollShown = 0.5;
  private readonly armA: V = new Float64Array(3);
  private readonly armB: V = new Float64Array(3);
  private readonly armS: V = new Float64Array(3);
  /** Eingang für die Schnur-Kräfte: Hand-Bewegung + eigene Rolle/Versatz dieses Tricks (Pendel bleibt im Lot). */
  private readonly drv = { handX: 0.5, handY: 0.5, handTilt: 0.5 };
  /** Einschwingen: Loslass-Zeit (Trick-Zeit), Wurf zur freien Seite, Winkelgeschwindigkeit dort, Start-Lage. */
  private setAt = -1.5;
  private setV0 = 0.5;
  /** Einschwingen: Dauer Schnipp zur Seite und gedämpftes Schwingen (s), je Trick in settleBall gesetzt. */
  private setT1 = 0.5;
  private setT2 = 0.5;
  private setPlanned = false;
  private readonly setToss = new Toss(KEN_G);
  private readonly setFrom: V = new Float64Array(3);
  /** Absolute Zeit (now), ab der das Ende frei ist — Projektion aus der Hand blendet von dort ein. */
  private fadeNow0 = 0.5;
  private readonly g1: V = new Float64Array(3);
  private readonly vel: V = new Float64Array(3);
  private readonly tossTo: V = new Float64Array(3);
  private readonly tossFrom: V = new Float64Array(3);
  private turnFrom = 0.5;
  /** Bogen des Wurfs zur Seite (Einheiten, Bildrichtung rechts; − = links um die Faust herum). */
  private bulge = 0.5;
  private bulgeC = 0.5;
  private turnTo = 0.5;
  /** Ganzer Griff: Gewicht des Ken-Griff-Versatzes und des Kugel-Griffs (Airplane). */
  private kenGrip = 0.5;
  private ballGrip = 0.5;
  // Scratch
  private readonly tmp: V = new Float64Array(3);
  private readonly tmp2: V = new Float64Array(3);
  private readonly tmp3: V = new Float64Array(3);
  private readonly rA: Mat3 = mat3();
  private readonly rB: Mat3 = mat3();
  /** Ken-Lage zu einer anderen Trick-Zeit (Fangpunkt zur Fangzeit vorausrechnen) — eigene Ausgabe, nie gezeigt. */
  private readonly ghost = new PropOut();
  private readonly jj = new Float32Array(VM_JOINT_COUNT);
  /**
   * Hand-Pose für die Schnur-Projektion, selbst überblendet wie in der ViewHand (gleiche Formel, gleiche Ziele aus
   * out.pose): im Spiel dieselbe Hand wie gezeigt; Proben ohne ViewHand (Tests mit fester Lauf-Pose) bekommen so die
   * Hand, die den Ken wirklich hält — nicht Finger, die quer durch Ken und Becher liegen.
   */
  private readonly poseJ = new Float32Array(POSE_JOINTS[POSE.ken]);
  /** Anker (unbenutzt) + Pendel-Ende für die Projektion eines einzelnen Punkts. */
  private readonly endBuf = new Float64Array(6);
  /** Kugel-Lage: Bild-Ausrichtung (einmal) und Achse Kamera + Winkel für axisAngleQ (Frame-Pfad ohne Argumente). */
  private readonly aligned: Mat3 = fromEulerXYZ(mat3(), VIEW_ALIGNED[0], VIEW_ALIGNED[1], VIEW_ALIGNED[2]);
  private readonly turnQ = new Float64Array(4);

  constructor() {
    super();
    this.fly = 0;
    this.hop = 3;
    this.launched = -1;
    this.releaseAt = -1;
    this.surfOut = -1;
    this.landAt = -1;
    this.tossAt = 0;
    this.tossT = 0.3;
    this.turnFrom = 0;
    this.turnTo = 0;
    this.bulge = 0;
    this.bulgeC = 0;
    this.swT = 0.13;
    this.rho = 0;
    this.wroll = 0;
    this.wrollShown = 0;
    this.drv.handX = 0;
    this.drv.handY = 0;
    this.drv.handTilt = 0;
    this.kenGrip = 1;
    this.ballGrip = 0;
    this.turnVal0 = 0;
    this.turnNow0 = 0;
    this.setAt = -1;
    this.setV0 = 0;
    this.setT1 = SET_T1;
    this.setT2 = SET_T2;
    this.fadeNow0 = -1;
    const c = VIEW_AXES.cam;
    this.turnQ[0] = c[0];
    this.turnQ[1] = c[1];
    this.turnQ[2] = c[2];
    this.rope.drive = this.drive;
    this.guard.cfg[0] = 0.25;
    this.guard.cfg[1] = TAMA_R;
    this.guard.hand.update(this.restJoints());
    this.hangAtRest();
  }

  /** Gelenke der Ruhe-Pose samt Griff-Versatz (Kollision vor dem ersten afterPose). */
  private restJoints(): Float32Array {
    const j = this.jj;
    const p = POSE_JOINTS[POSE.ken];
    for (let i = 0; i < j.length; i++) j[i] = p[i] + KEN_GRIP_ADD[i];
    return j;
  }

  /** Kugel hängt ruhig unter dem Ken in Ruhelage (Start, Respawn, Tools). */
  private hangAtRest(): void {
    this.writeRest(this.out);
    const o = this.out;
    socketOf(o, KEN_STRING_AT, this.tmp);
    const A = VIEW_AXES;
    for (let k = 0; k < 3; k++) this.tmp2[k] = this.tmp[k] - A.up[k] * KEN_STRING;
    this.rope.freeEnd = true;
    this.rope.reset(this.tmp[0], this.tmp[1], this.tmp[2], this.tmp2[0], this.tmp2[1], this.tmp2[2]);
    o.sub[0] = this.tmp2[0];
    o.sub[1] = this.tmp2[1];
    o.sub[2] = this.tmp2[2];
    this.ballTurn = 0;
    this.turnVal0 = 0;
  }

  /**
   * Tools: ein FESTGEHALTENER Start (at ≥ 0, Kontaktblätter) beginnt mit ruhig hängender Kugel —
   * reproduzierbar, auch wenn die Dev-Seite den Trick jeden Frame neu setzt. Frei laufend (at < 0,
   * __vel.forceTrick, Tests) startet er aus dem laufenden Pendel wie im Spiel.
   */
  override debugPlayName(name: string, at: number): boolean {
    if (at >= 0 && name !== 'none' && this.isTrick(name)) this.hangAtRest();
    return super.debugPlayName(name, at);
  }

  override get trickNames(): readonly string[] {
    return KENDAMA_NAMES;
  }

  protected override isState(id: KendamaTrick): boolean {
    return id === 'cupRide';
  }

  protected resetRun(): void {
    this.drive.reset();
    this.poseJ.set(POSE_JOINTS[POSE.ken]);
    this.hangAtRest();
  }

  protected override start(id: KendamaTrick): void {
    super.start(id);
    this.launched = -1;
    this.releaseAt = -1;
    this.surfOut = -1;
    this.landAt = -1;
    this.fromTarget = null;
    this.planned = false;
    this.toHand = false;
    this.setPlanned = false;
    // Abgebrochener Fang (Ziel): Abwurf gilt ab jetzt, von der gezeigten Lage (from aus onInterrupt) — losgelassen
    // fiel die Kugel im ersten Frame 0.2–0.6 Einheiten (Verlet-Rest), ein sichtbarer Ruck.
    this.carrySpike = this.carry && id === 'spike';
    if (this.carrySpike) this.launched = 0;
    this.swung = false;
    this.carry = false;
  }

  /**
   * Ziel bricht ab (Frame-Ende): geführte Kugel (Flug/Becher/Hand) aus der Zeitleiste des alten Tricks und der
   * Ken-Lage dieses Frames — genau dort, wo afterPose sie zeigen würde; die Spitze fliegt von dort.
   */
  protected override onInterrupt(): void {
    this.carry = this.ball !== Ball.Free && this.motionFx > 0;
    if (!this.carry) return;
    const s = this.out.sub;
    this.placeBall(s);
    this.from[0] = s[0];
    this.from[1] = s[1];
    this.from[2] = s[2];
    this.turnFrom = this.ballTurn;
  }

  /** Ken in Ruhe (Sockel, Hand) — ohne Zustand der Kugel; auch für die Vorausrechnung (ghost). */
  private writeKen(o: PropOut): void {
    o.pose = POSE.ken;
    o.poseTau = 0.08;
    o.hx = 0;
    o.hy = 0;
    o.hz = 0;
    o.hpitch = 0;
    o.hyaw = 0;
    o.hroll = 0;
    o.pos[0] = KEN_HOLD_POS[0];
    o.pos[1] = KEN_HOLD_POS[1];
    o.pos[2] = KEN_HOLD_POS[2];
    o.rot[0] = KEN_HOLD_ROT[0];
    o.rot[1] = KEN_HOLD_ROT[1];
    o.rot[2] = KEN_HOLD_ROT[2];
    o.spin = 0;
    o.visible = 1;
    o.scale = KEN_SCALE;
    o.poof = -1;
  }

  protected writeRest(o: PropOut): void {
    this.writeKen(o);
    this.wrollShown = 0;
    o.subVisible = 1;
    this.ball = Ball.Free;
    this.kenGrip = 1;
    this.ballGrip = 0;
    this.turnFixed = false;
  }

  protected cooldownOf(id: KendamaTrick): number {
    return COOLDOWN[id];
  }

  protected onJump(tier: number, good: boolean): void {
    if (tier === 0) return;
    const list = KENDAMA_TIER_TRICKS[tier];
    // Guter Hop im Overdrive: Spitze, Spitze, Around Japan (immer Spitze war zu eintönig, jedes zweite Mal Around
    // Japan zu lang — L1 sync 1.0 lag bei 52 % Trick-Anteil).
    if (tier === 3 && good) this.start(this.overdrive());
    else this.start(list[this.picks[tier]++ % list.length]);
  }

  /** Overdrive-Belohnung (guter Hop, Meilenstein): jedes dritte Mal Around Japan, sonst die Spitze. */
  private overdrive(): KendamaTrick {
    return this.goodCount++ % 3 === 2 ? 'aroundJapan' : 'spike';
  }

  protected onMilestone(tier: number): void {
    // Meilensteine achten auf die Abklingzeit (event-probe: sonst L1 bei sync 1.0 über 45 % Trick-Anteil).
    if (this.now < this.cooldownUntil) return;
    if (tier >= 3) this.start(this.milestoneCount++ % 3 === 2 ? 'airplane' : this.overdrive());
    else if (tier === 2) this.start(this.milestoneCount++ % 2 === 0 ? 'smallCup' : 'bigCup');
  }

  protected onIdle(): number {
    const k = this.idleCount++ % 3;
    this.start(k === 2 ? 'aroundJapan' : k === 1 ? 'smallCup' : 'bigCup');
    return 3 + 2 * this.rand();
  }

  protected override onFinish(): void {
    this.start('spike');
  }

  /** Checkpoint vor der Bestzeit: die große Figur (wie die Jo-Jo-Wiege), sonst kleiner und großer Becher im Wechsel. */
  protected override onCheckpoint(split: number | null): void {
    if (split !== null && split < 0) this.start('aroundJapan');
    else this.start(this.cpCount++ % 2 === 0 ? 'smallCup' : 'bigCup');
  }

  protected override onSurfStart(speed: number): void {
    if (speed >= SURF_FROM) this.start('cupRide');
  }

  protected override onFree(inp: PropFrameInput, speed: number): void {
    if (inp.surfing && speed >= SURF_FROM) this.start('cupRide');
  }

  /**
   * Ken kippen um `camTurn` (vorher setzen): Anteil Hand (hroll), Rest im Griff (Drehung um die Bild-Tiefenachse).
   * Winkel als Feld statt Argument (Frame-Pfad, fallen.md #107.3).
   */
  private tilt(o: PropOut): void {
    o.hroll += this.camTurn * HAND_SHARE;
    const w = this.camTurn * (1 - HAND_SHARE);
    this.wroll = w;
    if (o === this.ghost) return;
    // Drehung um die Bild-Tiefenachse c als Handgelenk-Euler (Reihenfolge ZXY wie ViewModel.applyJoints:
    // x = −Beugen, y = Drehen, z = Seitneigen): R = cos·I + (1 − cos)·c·cᵀ + sin·[c]×, Zerlegung wie three (ZXY).
    const c = VIEW_AXES.cam;
    const co = Math.cos(w);
    const si = Math.sin(w);
    const k = 1 - co;
    const m32 = k * c[2] * c[1] + si * c[0];
    const m31 = k * c[2] * c[0] - si * c[1];
    const m33 = co + k * c[2] * c[2];
    const m12 = k * c[0] * c[1] - si * c[2];
    const m22 = co + k * c[1] * c[1];
    const ex = Math.asin(m32 < -1 ? -1 : m32 > 1 ? 1 : m32);
    const ja = o.jointAdd;
    ja[VM_JOINT.wristFlex] -= ex;
    ja[VM_JOINT.wristTwist] += Math.atan2(-m31, m33);
    ja[VM_JOINT.wristDev] += Math.atan2(-m12, m22);
  }

  /** Unterarm-Rolle (rad, hroll × motionFx wie scaleOut) zur Trick-Zeit `time` aus der Zeitleiste → this.rho. */
  private rollAt(id: KendamaTrick, time: number): void {
    const g = this.ghost;
    this.writeKen(g);
    this.kenMotion(id, time, g);
    const m = this.motionFx;
    this.rho = (g.hroll + this.wroll) * (m > 0 ? (m < 1 ? m : 1) : 0);
  }

  /**
   * Punkt src um die Bild-Tiefenachse durch das Handgelenk um `rho` drehen → out (Rodrigues). +rho: Handgelenk-Raum →
   * ungerollter Arm-Raum (die Hand rollt im Bild um ihren Anker, ViewModel.motion), −rho zurück.
   */
  private armRot(src: ArrayLike<number>, sign: number, out: V | Float32Array): void {
    const c = VIEW_AXES.cam;
    const a = this.rho * sign;
    const co = Math.cos(a);
    const si = Math.sin(a);
    const x = src[0];
    const y = src[1];
    const z = src[2];
    const d = (c[0] * x + c[1] * y + c[2] * z) * (1 - co);
    out[0] = x * co + (c[1] * z - c[2] * y) * si + c[0] * d;
    out[1] = y * co + (c[2] * x - c[0] * z) * si + c[1] * d;
    out[2] = z * co + (c[0] * y - c[1] * x) * si + c[2] * d;
  }

  /** Wurf von `from` (Zeit at0) nach `to` (Zeit at1), beide im Handgelenk-Raum, gerechnet im ungerollten Arm-Raum. */
  private planArm(id: KendamaTrick, from: V, at0: number, to: V, at1: number, toss: Toss): void {
    const fa = this.armA;
    const ta = this.armB;
    this.rollAt(id, at0);
    this.armRot(from, 1, fa);
    this.rollAt(id, at1);
    this.armRot(to, 1, ta);
    toss.plan(fa, ta, at1 - at0, 0, 0);
  }

  /** Tests/Tools: Kugel liegt gerade exakt auf diesem Fangpunkt (KEN_BIG_CUP, KEN_SMALL_CUP, KEN_SPIKE). */
  caughtOn(target: V3): boolean {
    return this.ball === Ball.Caught && this.target === target;
  }

  /** Tests/Tools: Kugel in der Hand (Airplane). */
  get ballInHand(): boolean {
    return this.ball === Ball.Held;
  }

  private klack(o: PropOut): void {
    this.kick(o, 0.35, -0.8);
    this.spinKick(0.5);
  }

  // ---------------------------------------------------------------- Ken-Zeitleisten (rein, auch für ghost)

  /**
   * Ken-Lage und Hand zur Trick-Zeit t (nach writeKen): reine Funktion der Zeit — evaluate schreibt so das Bild,
   * die Vorausrechnung der Fangpunkte (ghost) dieselbe Lage zu einer anderen Zeit.
   */
  private kenMotion(id: KendamaTrick, t: number, o: PropOut): void {
    this.wroll = 0;
    if (id === 'bigCup' || id === 'smallCup') {
      const sign = id === 'bigCup' ? 1 : -1;
      const e = smooth(t / TILT_IN) * (1 - smooth((t - C_REL) / TILT_OUT));
      // Becher federt nach dem Klack zurück (Kugel drückt ihn nach unten).
      this.camTurn = sign * (CUP_TILT * e + settle(-1.6, t - C_CATCH, Math.PI * 2 * 4, 0.4));
      this.tilt(o);
      o.hy += HY_PULL.value(t);
      return;
    }
    if (id === 'spike') {
      // Bis zum Trick-Ende ganz aus (sonst spränge die Rolle beim Übergang in die Ruhe, je Framerate anders).
      const wob = settle(5.5, t - S_CATCH, Math.PI * 2 * 2.4, 0.16) * (1 - smooth((t - S_END + 0.25) / 0.25));
      // Balancieren gegen das Wackeln, dann kurz kippen: die Kugel rutscht von der Spitze.
      this.camTurn = -0.35 * wob + 0.45 * smooth((t - S_REL) / 0.1) * (1 - smooth((t - S_REL - 0.1) / 0.12));
      this.tilt(o);
      o.hy += HY_SPIKE.value(t) - 0.024 * bell(clamp((t - S_CATCH) / 0.4, 0, 1));
      return;
    }
    if (id === 'aroundJapan') {
      let a: number;
      if (t < AJ_HOP1) a = -CUP_TILT * smooth(t / TILT_IN);
      else if (t < AJ_HOP2) a = -CUP_TILT + 2 * CUP_TILT * smooth((t - AJ_HOP1) / AJ_TURN);
      else if (t < AJ_SPIKE) a = CUP_TILT * (1 - smooth((t - AJ_HOP2) / AJ_TURN));
      else a = 0.45 * smooth((t - AJ_REL) / 0.1) * (1 - smooth((t - AJ_REL - 0.1) / 0.12));
      // Nachfedern der Fänge (klein −, groß +) und Balancieren auf der Spitze — durchgehend, stetig über die Phasen.
      const k = Math.PI * 2 * 4;
      a += settle(1.6, t - AJ_SMALL, k, 0.4) - settle(1.6, t - AJ_BIG, k, 0.4) - 0.35 * settle(5.5, t - AJ_SPIKE, Math.PI * 2 * 2.4, 0.16) * (1 - smooth((t - AJ_END + 0.25) / 0.25));
      this.camTurn = a;
      this.tilt(o);
      o.hy += HY_AJ.value(t);
      return;
    }
    if (id === 'airplane') {
      this.airplaneKen(t, o);
      // Bühne: die Hand rückt nach rechts unten, damit der schwingende Ken nicht in die Bildmitte kommt (Hülle).
      const st = AIR_STAGE.value(t);
      o.hx += 0.13 * st;
      o.hy += HY_AIR.value(t) + AIR_STAGE_DOWN * st;
      return;
    }
  }

  /** Airplane: Ken fliegt aus der Faust, schwingt an der Schnur um die Kugel, wackelt auf ihr, fliegt zurück. */
  private airplaneKen(t: number, o: PropOut): void {
    let ang = KEN_TILT;
    const p = this.tmp3;
    if (t < A_KEN_OUT) return;
    if (t < A_SWING) {
      ang = A_TOSS_OUT.at(t - A_KEN_OUT, p);
      // Seitlich vor der Hand vorbei (die Kugel steigt durch dieselbe Gegend).
      const b = arc((t - A_KEN_OUT) / (A_SWING - A_KEN_OUT));
      for (let k = 0; k < 3; k++) p[k] += (VIEW_AXES.cam[k] * OB_C + VIEW_AXES.right[k] * OB_R + VIEW_AXES.up[k] * OB_U) * b;
    } else if (t < A_LAND) {
      const u = (t - A_SWING) / (A_LAND - A_SWING);
      const phi = A_PHI0 + (A_PHI1 - A_PHI0) * SWING.value(u);
      const k = clamp((u - 0.55) / 0.45, 0, 1);
      ang = swingPos(phi, A_R0 + (A_R1 - A_R0) * quadIn(k), p);
      o.hroll -= 0.12 * bell(u);
    } else if (t < A_FLIP) {
      ang = swingPos(A_PHI1 + settle(A_WOB_V, t - A_LAND, A_WOB_W, A_WOB_Z), A_R1, p);
    } else if (t < A_KEN_IN) {
      ang = A_TOSS_BACK.at(t - A_FLIP, p);
      const b = arc((t - A_FLIP) / (A_KEN_IN - A_FLIP));
      for (let k = 0; k < 3; k++) p[k] += (VIEW_AXES.cam[k] * RB_C + VIEW_AXES.right[k] * RB_R + VIEW_AXES.up[k] * RB_U) * b;
    } else return;
    o.pos[0] = p[0];
    o.pos[1] = p[1];
    o.pos[2] = p[2];
    o.rot[0] = VIEW_ALIGNED[0];
    o.rot[1] = VIEW_ALIGNED[1];
    o.rot[2] = VIEW_ALIGNED[2];
    this.camTurn = ang;
    this.rotateCam(o);
  }

  /** Fangpunkt `tg` zur Trick-Zeit `at` (Ken-Zeitleiste vorausgerechnet) → out. */
  private pointAt(id: KendamaTrick, at: number, tg: V3, out: V): void {
    const g = this.ghost;
    this.writeKen(g);
    this.kenMotion(id, at, g);
    socketOf(g, tg, out);
  }

  // ---------------------------------------------------------------- Kugel-Steuerung

  /**
   * Abwurf aus dem Pendel zur Zeit `at`, Fang bei `to` (Ziel `tg`, oder die Hand bei tg = null). Einmal geplant:
   * Ziel-Lage zur Fangzeit; der Start (Pendel-Lage zur Marke) kommt in afterPose (switchFrame).
   */
  private throwBall(id: KendamaTrick, t: number, at: number, to: number, tg: V3 | null, turnTo: number, bulgeR: number, bulgeC: number, swA: number, swB: number): void {
    if (this.launched < 0) {
      // Ab Trick-Beginn geführt: erst Ausholen (Swing), dann der Wurf ab dem Ausholpunkt.
      this.launched = 0;
      this.planned = false;
      this.swung = false;
      this.fromTarget = null;
      this.turnFrom = this.ballTurn;
    }
    // Ausholpunkt: auf der gespannten Schnur, seitlich (swA, + = rechts) und zur Kamera (swB) aus dem Lot — dort ist
    // die Faust nicht im Weg (direkt über der Hängelage liegt die Zeigefinger-Kuppe).
    const A = VIEW_AXES;
    const ca = Math.cos(swA);
    const sb = Math.sin(swB);
    const cb = Math.cos(swB);
    for (let k = 0; k < 3; k++) this.swW[k] = S_REST[k] + (A.right[k] * Math.sin(swA) * cb - A.up[k] * ca * cb + A.cam[k] * sb) * KEN_STRING;
    this.swT = at;
    this.bulge = bulgeR;
    this.bulgeC = bulgeC;
    this.toHand = tg === null;
    if (tg) this.target = tg;
    this.turnTo = turnTo;
    this.tossAt = at;
    this.tossT = to - at;
    if (t < at) {
      this.ball = Ball.Swing;
      return;
    }
    if (!this.planned) {
      // Ziel: Fangpunkt zur Fangzeit, ohne Ziel die Hand (Airplane).
      if (tg) this.pointAt(id, to, tg, this.tossTo);
      else for (let k = 0; k < 3; k++) this.tossTo[k] = BALL_HOLD[k];
      this.planArm(id, this.swW, at, this.tossTo, to, this.toss);
      this.tossFrom.set(this.swW);
      this.planned = true;
    }
    this.ball = t >= to ? (tg ? Ball.Caught : Ball.Held) : Ball.Toss;
  }

  /** Ausholen zur Trick-Zeit `time`: vom eingefangenen Pendel-Punkt (from) auf der Schnur-Schale zum Ausholpunkt. */
  private swingAt(time: number, out: V | Float32Array): void {
    const u = smooth(time / this.swT);
    const f = this.from;
    const W = this.swW;
    let r0 = 0;
    for (let k = 0; k < 3; k++) r0 += (f[k] - S_REST[k]) * (f[k] - S_REST[k]);
    r0 = Math.sqrt(r0) || 1;
    const d = this.armS;
    let l = 0;
    for (let k = 0; k < 3; k++) {
      d[k] = (f[k] - S_REST[k]) / r0 + ((W[k] - S_REST[k]) / KEN_STRING - (f[k] - S_REST[k]) / r0) * u;
      l += d[k] * d[k];
    }
    l = Math.sqrt(l) || 1;
    const r = r0 + (KEN_STRING - r0) * u;
    for (let k = 0; k < 3; k++) out[k] = S_REST[k] + (d[k] / l) * r;
  }

  /** Hüpfer von Fangpunkt `a` (zur Zeit at) nach `b` (zur Zeit to), Drehung bis turnTo — Start/Ziel aus der Zeitleiste. */
  private hopBall(id: KendamaTrick, t: number, at: number, to: number, a: V3, b: V3, turnFrom: number, turnTo: number): void {
    this.target = b;
    if (t >= to) {
      this.ball = Ball.Caught;
      return;
    }
    if (this.tossAt !== at || !this.planned) {
      this.pointAt(id, at, a, this.tossFrom);
      this.pointAt(id, to, b, this.tossTo);
      this.from[0] = this.tossFrom[0];
      this.from[1] = this.tossFrom[1];
      this.from[2] = this.tossFrom[2];
      this.tossAt = at;
      this.tossT = to - at;
      this.planArm(id, this.tossFrom, at, this.tossTo, to, this.toss);
      this.planned = true;
    }
    this.fromTarget = a;
    this.toHand = false;
    this.turnFrom = turnFrom;
    this.turnTo = turnTo;
    this.ball = Ball.Toss;
  }

  /** Loslassen zur Trick-Zeit `at` aus dem geführten Modus `mode` (für Lage/Geschwindigkeit zur Marke). */
  private release(at: number, mode: Ball): void {
    this.releaseAt = at;
    this.relMode = mode;
  }

  /** Nach dem Loslassen: Drehung klingt geschlossen ab (Wert zur Marke, auf ±π gefaltet) — framerate-unabhängig. */
  private releasedTurn(t: number, from: number, at: number): void {
    const age = t - from;
    this.turnVal0 = wrapPi(at);
    this.turnNow0 = this.now - age;
    this.ballTurn = this.turnVal0 * Math.exp(-age / TURN_TAU);
    this.turnFixed = true;
  }

  /**
   * Geführte Kugel-Lage zur Trick-Zeit `time` aus der Ken-Zeitleiste (ghost, ohne Wackeln) im Modus relMode — für
   * Lage und Geschwindigkeit genau zur Loslass-Marke.
   */
  private guidedAt(time: number, out: V): void {
    const id = this.trick;
    if (id === 'none') return;
    if (this.relMode === Ball.Drop) {
      this.dropAt(time, out);
      return;
    }
    if (this.relMode === Ball.Settle) {
      this.settleAt(time, out);
      return;
    }
    this.pointAt(id, time, this.target, out);
  }

  /** Loslassen aus Fangpunkt `tg` zur Zeit `at`: Einschwingen (Settle), frei ab at + setT1 + setT2. */
  private settleBall(id: KendamaTrick, t: number, at: number, tg: V3): void {
    this.target = tg;
    if (!this.setPlanned || this.setAt !== at) {
      const Q = this.g1;
      this.pointAt(id, at, tg, this.setFrom);
      const A = VIEW_AXES;
      const sa = Math.sin(SET_A0);
      const ca = Math.cos(SET_A0);
      for (let k = 0; k < 3; k++) Q[k] = S_REST[k] + (A.right[k] * sa - A.up[k] * ca) * KEN_STRING;
      // Q im Arm-Raum (zum Zeitpunkt ohne Rolle gedacht): Start drehen, Ziel als Arm-Lage übernehmen.
      this.rollAt(id, at);
      this.armRot(this.setFrom, 1, this.armA);
      // Dauer der beiden Phasen je Trick (Felder: settleAt liest sie im Frame-Pfad ohne Argumente).
      if (id === 'cupRide') {
        this.setT1 = RIDE_SET_T1;
        this.setT2 = RIDE_SET_T2;
      } else {
        this.setT1 = SET_T1;
        this.setT2 = SET_T2;
      }
      this.setToss.plan(this.armA, Q, this.setT1, 0, 0);
      const v = this.vel;
      this.setToss.velocity(this.setT1, v);
      // Winkelgeschwindigkeit an der Seite: Bahn-Geschwindigkeit entlang der Tangente der Schnur-Kreisbahn.
      let vt = 0;
      for (let k = 0; k < 3; k++) vt += v[k] * (A.right[k] * ca + A.up[k] * sa);
      this.setV0 = vt / KEN_STRING;
      this.setAt = at;
      this.setPlanned = true;
    }
    const end = at + this.setT1 + this.setT2;
    if (t < end) this.ball = Ball.Settle;
    else this.release(end, Ball.Settle);
  }

  /** Einschwingen zur Trick-Zeit `time`: Wurf zur Seite (Schnur hält, ≤ KEN_STRING), dann kritisch gedämpft zur Senkrechten. */
  private settleAt(time: number, out: V | Float32Array): void {
    const tau = time - this.setAt;
    const L = KEN_STRING;
    const p = this.armB;
    // Rolle der Hand zu dieser Zeit: der Schnur-Ansatz rollt mit (im Arm-Raum gedreht), die Bahn nicht.
    const id = this.trick;
    if (id === 'none') this.rho = 0;
    else this.rollAt(id, time);
    const S = this.armS;
    this.armRot(S_REST, 1, S);
    if (tau < this.setT1) {
      this.setToss.at(tau, p);
      // Der Schnur-Ansatz rollt mit der zurückkippenden Hand weiter; die Phase-2-Bahn hängt am Ansatz DIESER Zeit —
      // dessen Versatz zur Ruhe (S − S_REST) stetig einführen (sonst Sprung am Phasenwechsel, 2.1 je 240-Hz-Frame).
      const e = smooth(tau / this.setT1);
      for (let k = 0; k < 3; k++) p[k] += (S[k] - S_REST[k]) * e;
      let d2 = 0;
      for (let k = 0; k < 3; k++) d2 += (p[k] - S[k]) * (p[k] - S[k]);
      const d = Math.sqrt(d2);
      if (d > L) for (let k = 0; k < 3; k++) p[k] = S[k] + ((p[k] - S[k]) * L) / d;
    } else {
      const s2 = tau - this.setT1;
      const w = SET_W;
      const a = (SET_A0 + (this.setV0 + w * SET_A0) * s2) * Math.exp(-w * s2);
      const A = VIEW_AXES;
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      for (let k = 0; k < 3; k++) p[k] = S[k] + (A.right[k] * sa - A.up[k] * ca) * L;
    }
    // Arm-Raum → Handgelenk-Raum.
    this.armRot(p, -1, out);
  }

  /**
   * Airplane-Rückweg: Kugel fällt ab A_FLIP aus der offenen Hand und kommt unter dem gefangenen Ken zur Ruhe (Ruhe-
   * Hängelage A_HANG, Ankunft mit Geschwindigkeit 0 → ruhiges Pendel ab A_DROP); unterwegs hält die Schnur sie am
   * fliegenden Ken (Abstand zum Schnur-Punkt des Kens zur selben Zeit ≤ KEN_STRING). Geschlossen in der Zeit.
   */
  private dropAt(time: number, out: V | Float32Array): void {
    const g = this.ghost;
    this.writeKen(g);
    this.kenMotion('airplane', time, g);
    const a = this.tmp3;
    socketOf(g, KEN_STRING_AT, a);
    const u = clamp((time - A_FLIP) / (A_DROP - A_FLIP), 0, 1);
    // Die Schnur reißt sie aus der offenen Hand (schneller Start — sonst schlossen sich die Finger um die Kugel), unter
    // dem gefangenen Ken kommt sie flach zur Ruhe.
    const v = 1 - u;
    const e = 1 - v * v * v;
    let d2 = 0;
    for (let k = 0; k < 3; k++) {
      // Vor den Fingern vorbei (zur Kamera), nicht durch kleinen und Ringfinger.
      out[k] = BALL_HOLD[k] + (A_HANG[k] - BALL_HOLD[k]) * e + VIEW_AXES.cam[k] * DROP_FRONT * Math.sin(Math.PI * e);
      const d = out[k] - a[k];
      d2 += d * d;
    }
    const d = Math.sqrt(d2);
    if (d > KEN_STRING) for (let k = 0; k < 3; k++) out[k] = a[k] + ((out[k] - a[k]) * KEN_STRING) / d;
  }

  /** Kugel-Drehung: im Flug gleichmäßig (Toss), danach Ruckeln seit dem letzten Fang. */
  private turnAt(t: number, caughtAt: number): void {
    if (this.ball === Ball.Swing) this.ballTurn = this.turnFrom;
    else if (this.ball === Ball.Toss) {
      const u = clamp((t - this.tossAt) / this.tossT, 0, 1);
      this.ballTurn = this.turnFrom + (this.turnTo - this.turnFrom) * u;
    } else this.ballTurn = this.turnTo + settle(JIG, t - caughtAt, JIG_W, JIG_Z);
  }

  protected evaluate(id: KendamaTrick, t: number, _dt: number, inp: PropFrameInput, _m: number, o: PropOut): boolean {
    if (id === 'cupRide') return this.cupRide(t, inp, o);
    this.kenMotion(id, t, o);
    this.wrollShown = this.wroll;
    if (id === 'bigCup' || id === 'smallCup') return this.cupCatch(id, t, o);
    if (id === 'spike') return this.spike(t, o);
    if (id === 'aroundJapan') return this.aroundJapan(t, o);
    return this.airplane(t, o);
  }

  /** Becher-Fang: Knie beugen, Riss, Parabel in den Becher, Klack, liegen lassen, zurückkippen — Kugel fällt frei. */
  private cupCatch(id: KendamaTrick, t: number, o: PropOut): boolean {
    const big = id === 'bigCup';
    if (this.mark(0, 0, t)) this.kick(o, 0.12, 0);
    if (t >= C_LAUNCH && this.mark(1, C_LAUNCH, t)) this.kick(o, -0.3, 0);
    if (t < C_REL) {
      // Großer Becher liegt rechts über der Faust: die Kugel schwingt links und vor der Hand herum (gerade lief sie
      // durch Mittel-/Ringfinger, 1.45 tief am Mesh); der kleine Becher links ist frei erreichbar.
      if (big) this.throwBall(id, t, C_LAUNCH, C_CATCH, KEN_BIG_CUP, -1.4, -2, 2, SWA, SWB);
      else this.throwBall(id, t, C_LAUNCH, C_CATCH, KEN_SMALL_CUP, 1.4, 0, 0, SWA, SWB);
      this.turnAt(t, C_CATCH);
      if (this.mark(2, C_CATCH, t)) this.klack(o);
      return false;
    }
    // Zurückkippen: Kugel frei (rollt aus dem Becher, schwingt ins Pendel).
    this.target = big ? KEN_BIG_CUP : KEN_SMALL_CUP;
    this.settleBall(id, t, C_REL, big ? KEN_BIG_CUP : KEN_SMALL_CUP);
    this.releasedTurn(t, C_REL, (big ? -1.4 : 1.4) + settle(JIG, C_REL - C_CATCH, JIG_W, JIG_Z));
    return t >= C_END;
  }

  /** Spitze: Kugel dreht das Loch nach unten, landet auf der Spitze, wackelt; Hand balanciert, kippt, Kugel fällt. */
  private spike(t: number, o: PropOut): boolean {
    if (t < S_LAUNCH) {
      if (this.mark(0, 0, t)) this.kick(o, 0.15, 0);
      // Nach einem Abbruch mit geführter Kugel bleibt sie bis zum Abwurf, wo sie war (Bahn-Anfang).
      if (this.carrySpike) {
        this.ball = Ball.Toss;
        this.target = KEN_SPIKE;
        this.turnTo = SPIKE_TURN;
        if (!this.planned) this.planCarry();
        this.turnAt(t, S_CATCH);
      } else {
        this.throwBall('spike', t, S_LAUNCH, S_CATCH, KEN_SPIKE, SPIKE_TURN, 0, 0, SWA, SWB);
        this.turnAt(t, S_CATCH);
      }
      return false;
    }
    if (this.mark(1, S_LAUNCH, t)) this.kick(o, -0.45, 0);
    if (t < S_REL) {
      if (this.carrySpike) {
        this.ball = t >= S_CATCH ? Ball.Caught : Ball.Toss;
        this.target = KEN_SPIKE;
        this.turnTo = SPIKE_TURN;
        if (!this.planned) this.planCarry();
      } else this.throwBall('spike', t, S_LAUNCH, S_CATCH, KEN_SPIKE, SPIKE_TURN, 0, 0, SWA, SWB);
      // Kugel wackelt auf der Spitze (Drehung um ihre Mitte), die Hand balanciert dagegen (kenMotion).
      if (this.ball === Ball.Toss) this.turnAt(t, S_CATCH);
      else this.ballTurn = SPIKE_TURN + settle(5.5, t - S_CATCH, Math.PI * 2 * 2.4, 0.16);
      if (this.mark(2, S_CATCH, t)) this.klack(o);
      return false;
    }
    this.target = KEN_SPIKE;
    this.settleBall('spike', t, S_REL, KEN_SPIKE);
    this.releasedTurn(t, S_REL, SPIKE_TURN + settle(5.5, S_REL - S_CATCH, Math.PI * 2 * 2.4, 0.16));
    if (this.mark(3, S_REL, t)) this.kick(o, -0.15, 0);
    return t >= S_END;
  }

  /** Nach einem Ziel-Abbruch mit geführter Kugel: Wurf von der gezeigten Lage auf die Spitze (Start = Trick-Zeit 0). */
  private planCarry(): void {
    this.pointAt('spike', S_CATCH, KEN_SPIKE, this.tossTo);
    this.tossAt = 0;
    this.tossT = S_CATCH;
    this.planArm('spike', this.from, 0, this.tossTo, S_CATCH, this.toss);
    this.planned = true;
    this.toHand = false;
    this.fromTarget = null;
  }

  /** Around Japan: kleiner Becher → großer Becher → Spitze (Hüpfer als Parabeln), dann frei. */
  private aroundJapan(t: number, o: PropOut): boolean {
    if (this.mark(0, 0, t)) this.kick(o, 0.12, 0);
    if (t >= C_LAUNCH && this.mark(1, C_LAUNCH, t)) this.kick(o, -0.3, 0);
    if (t < AJ_HOP1) {
      this.throwBall('aroundJapan', t, C_LAUNCH, AJ_SMALL, KEN_SMALL_CUP, 1.4, 0, 0, SWA, SWB);
      this.turnAt(t, AJ_SMALL);
      if (this.mark(2, AJ_SMALL, t)) this.klack(o);
    } else if (t < AJ_HOP2) {
      if (this.mark(5, AJ_HOP1, t)) this.kick(o, -0.18, 0);
      this.hopBall('aroundJapan', t, AJ_HOP1, AJ_BIG, KEN_SMALL_CUP, KEN_BIG_CUP, 1.4, 1.4 - Math.PI * 2);
      this.turnAt(t, AJ_BIG);
      if (this.mark(3, AJ_BIG, t)) this.klack(o);
    } else if (t < AJ_REL) {
      if (this.mark(6, AJ_HOP2, t)) this.kick(o, -0.22, 0);
      this.hopBall('aroundJapan', t, AJ_HOP2, AJ_SPIKE, KEN_BIG_CUP, KEN_SPIKE, 1.4 - Math.PI * 2, SPIKE_TURN);
      if (this.ball === Ball.Toss) this.turnAt(t, AJ_SPIKE);
      else this.ballTurn = SPIKE_TURN + settle(5.5, t - AJ_SPIKE, Math.PI * 2 * 2.4, 0.16);
      if (this.mark(4, AJ_SPIKE, t)) this.klack(o);
    } else {
      this.target = KEN_SPIKE;
      this.settleBall('aroundJapan', t, AJ_REL, KEN_SPIKE);
      this.releasedTurn(t, AJ_REL, SPIKE_TURN + settle(5.5, AJ_REL - AJ_SPIKE, Math.PI * 2 * 2.4, 0.16));
    }
    return t >= AJ_END;
  }

  /**
   * Airplane (Overdrive): Riss, die Kugel fliegt in die Hand (Griffwechsel, der Ken fällt aus der Faust), der Ken
   * schwingt an der Schnur über die Hand und landet mit der Spitze im Loch, wackelt, dann Ken-Wurf mit halber
   * Drehung zurück in den Griff, die Kugel fällt ins Pendel.
   */
  private airplane(t: number, o: PropOut): boolean {
    if (this.mark(0, 0, t)) this.kick(o, 0.12, 0);
    // Griff: Ken bis zum Loslassen, Hand offen, Kugel im Griff, offen, Ken wieder.
    const kIn = smooth((t - (A_KEN_IN - A_CLOSE)) / 0.08);
    // Die Faust öffnet sich A_OPEN vor dem Ken-Abwurf (sonst fegte der Mittelfinger durch den Griff), Griff-Versatz
    // stetig aus und zum Fang wieder ein.
    this.kenGrip = 1 - smooth((t - A_KEN_OUT + A_OPEN) / A_OPEN) + kIn;
    // Kugel-Griff im Gleichschritt mit dem Überblenden zur Pose grip (gleiche Zeitkonstante): sonst griffen die Finger
    // halb in der Pose grip (Dose), halb im Versatz und stachen kurz in die ankommende Kugel.
    const gIn = t - A_BALL_IN;
    // Die Finger geben die Kugel frei, während die Hand den Ken abwirft (A_FREE vor dem Abwurf): sonst fegte der
    // abhebende Becher durch die Zeigefinger-Kuppe, die die Kugel noch hielt.
    this.ballGrip = (gIn > 0 ? 1 - Math.exp(-gIn / 0.05) : 0) * (1 - smooth((t - A_FLIP + A_FREE) / A_FREE));
    o.pose = t < A_KEN_OUT - A_OPEN ? POSE.ken : t < A_BALL_IN ? POSE.open : t < A_FLIP - A_FREE ? POSE.grip : t < A_KEN_IN - A_CLOSE ? POSE.open : POSE.ken;
    o.poseTau = t < A_KEN_IN - A_CLOSE ? 0.05 : CLOSE_TAU;
    // Mittelfinger rollt beim Schließen voraus ein (Mittel-/Endglied eilen vor): linear überblendet fegte seine Kuppe
    // 0.44 durch den ankommenden Griff. Buckel x·e^(1−x), stetig ab dem Schließen. Verzweigungsfrei (Faktor), #107.2.
    const cx = Math.max(0, (t - A_KEN_IN + A_CLOSE) / MID_LEAD_T);
    // Bis zum Trick-Ende ganz aus (sonst spränge der Gelenk-Versatz beim Übergang in die Ruhe).
    const endFade = 1 - smooth((t - A_END + 0.2) / 0.2);
    const lead = MID_LEAD * cx * Math.exp(1 - cx) * endFade;
    o.jointAdd[VM_JOINT.finger + 6] += lead;
    o.jointAdd[VM_JOINT.finger + 7] += lead * 0.7;
    // Daumen spreizt sich dem ankommenden Griff entgegen (Buckel um den Fang), sonst stand seine Kuppe im Weg (−0.36).
    // Ebenso beim Öffnen der Faust zum Ken-Abwurf (Buckel ab A_OPEN davor).
    const tx = Math.max(0, (t - A_KEN_IN + THUMB_OPEN_T) / THUMB_OPEN_T);
    const tr = Math.max(0, (t - A_KEN_OUT + A_OPEN) / THUMB_OPEN_T);
    const th = THUMB_OPEN * (tx * Math.exp(1 - tx) + tr * Math.exp(1 - tr)) * endFade;
    o.jointAdd[VM_JOINT.thumbAbd] += th;
    if (t >= A_LAUNCH && this.mark(1, A_LAUNCH, t)) this.kick(o, -0.3, 0);
    // Zeigefinger streckt sich, solange der Ken auf der Kugel steht und abhebt: die übrigen Finger halten die Kugel,
    // gekrümmt lag die Kuppe am Becher (−0.9).
    const ix = smooth((t - A_LAND + IDX_LIFT_IN) / IDX_LIFT_IN) * (1 - smooth((t - A_FLIP - 0.12) / 0.12));
    o.jointAdd[VM_JOINT.finger + 1] -= IDX_LIFT_MCP * ix;
    o.jointAdd[VM_JOINT.finger + 2] -= IDX_LIFT_PIP * ix;
    o.jointAdd[VM_JOINT.finger + 3] -= IDX_LIFT_PIP * 0.5 * ix;
    if (t < A_FLIP) {
      // Bogen nach links: gerade lief die Kugel durch den Zeigefinger der offenen Hand (−0.6).
      this.throwBall('airplane', t, A_LAUNCH, A_BALL_IN, null, 0, -2, 0, SWA, SWB);
      this.turnAt(t, A_BALL_IN);
      if (this.mark(2, A_BALL_IN, t)) this.kick(o, 0.25, -0.5);
      if (this.mark(3, A_LAND, t)) this.klack(o);
      return false;
    }
    if (this.mark(4, A_FLIP, t)) this.kick(o, -0.3, 0);
    // Kugel fällt aus der offenen Hand und hängt am fliegenden Ken (geschlossen), frei ab dem Ken-Fang.
    if (t < A_DROP) {
      this.ball = Ball.Drop;
      this.toHand = false;
      this.ballTurn = settle(JIG, t - A_BALL_IN, JIG_W, JIG_Z);
    } else {
      this.release(A_DROP, Ball.Drop);
      this.releasedTurn(t, A_DROP, settle(JIG, A_DROP - A_BALL_IN, JIG_W, JIG_Z));
    }
    if (this.mark(5, A_KEN_IN, t)) this.klack(o);
    return t >= A_END;
  }

  /**
   * Surf: Kugel in den großen Becher, liegt dort und rollt mit der Rampe; Surf-Ende → frei. Einlage (beatU):
   * die Kugel hüpft aus dem Becher und fällt exakt zurück (Klack) — Becher bleibt Fangpunkt. Endet der Surf mitten
   * im Hüpfer, landet sie erst und wird dann losgelassen (Loslassen zur Landezeit, exakt: framerate-unabhängig).
   */
  private cupRide(t: number, inp: PropFrameInput, o: PropOut): boolean {
    if (this.surfOut < 0 && !inp.surfing && t >= SURF_MIN) this.surfOut = t;
    const out = this.surfOut < 0 ? 0 : smooth((t - this.surfOut) / BACK);
    const e = smooth(t / TURN) * (1 - out);
    const u = this.beatU;
    // Einlage: Ken schnippt kurz hoch (gegen die Kippung), die Kugel steigt.
    this.camTurn = (CUP_TILT - 0.25 * this.surfLean - 0.35 * bell(u)) * e;
    this.tilt(o);
    this.wrollShown = this.wroll;
    // Plan 008: kein Versatz des Kens im Griff mehr (+0.4/+1.0/+0.8 schob den Griff 1.05 in den Daumen) — die Hand
    // kippt (Unterarm-Rolle), der Ken bleibt in der Faust.
    o.hy -= 0.02 * bell(u * 2) * e;
    if (this.beatEnd()) {
      this.klack(o);
      this.landAt = t - this.lateness;
    }
    if (t >= TURN && this.mark(0, TURN, t)) this.kick(o, -0.3, 0);
    const hopping = u < 1 && t >= TURN + FLIGHT;
    if (this.surfOut < 0 || t < this.surfOut || hopping) {
      this.target = KEN_BIG_CUP;
      if (hopping) {
        // Hüpfer im Becher: vom Becher zum Becher (Bahn mitbewegt), am Ende exakt drin.
        this.fly = u;
        this.hop = RIDE_HOP;
        this.fromTarget = KEN_BIG_CUP;
        this.ball = u >= 1 ? Ball.Caught : Ball.Arc;
        return false;
      }
      // Erst ausholen (nach links, flacher als die Becher-Fänge: Bild-Hülle beim Surfen), dann Wurf in den großen Becher.
      this.throwBall('cupRide', t, TURN, TURN + FLIGHT, KEN_BIG_CUP, 0, 0, 0, -0.55, 0);
      if (t >= TURN + FLIGHT && this.mark(1, TURN + FLIGHT, t)) this.klack(o);
      return false;
    }
    // Loslassen mit dem Surf-Ende — lief da gerade ein Hüpfer, erst zu seiner Landung.
    const rel = this.landAt > this.surfOut ? this.landAt : this.surfOut;
    if (t >= rel) this.settleBall('cupRide', t, rel, KEN_BIG_CUP);
    return t >= rel + RIDE_SET_T1 + RIDE_SET_T2 + 0.02;
  }

  /**
   * Nach dem Überblenden: Griff-Versatz auf die Gelenke (ungeskaliert, statisch), Hand-Modell für die Schnur-
   * Kollision, Kugel aus Ken-Lage (o.pos/o.rot, wie der Renderer) und Zeitleiste; Schnur vom Ken zur Kugel (frei =
   * Pendel, sonst geführt, Länge fest — locker durchhängend).
   */
  override afterPose(_joints: ArrayLike<number>, inp: PropFrameInput, dtRaw: number): void {
    const dt = dtRaw - dtRaw === 0 ? clamp(dtRaw, 0, 0.1) : 0;
    const o = this.out;
    this.applyGrip(dt);
    const rope = this.rope;
    const st = this.tmp;
    socketOf(o, KEN_STRING_AT, st);
    const s = o.sub;
    const free = this.ball === Ball.Free || this.motionFx <= 0;
    // Schnur-Kräfte aus der ganzen Hand-Bewegung: HandMotion + Knie-Wippen/Riss (hx/hy) + Rolle (hroll) dieses Tricks
    // — das hängende Pendel bleibt im Lot, wenn die Hand kippt, und spürt den Ruck vor dem Abwurf.
    const dv = this.drv;
    dv.handX = (inp.handX ?? 0) + o.hx;
    dv.handY = (inp.handY ?? 0) + o.hy;
    dv.handTilt = (inp.handTilt ?? 0) - (o.hroll + this.wrollShown * this.motionFx) * RAD2DEG;
    this.drive.setFrameFrom(dv, this.motionFx);
    // Wechsel frei ↔ geführt mitten im Frame (Abwurf, Loslassen): Schnur bis zur Marke im alten Modus.
    const sw = free === rope.freeEnd || this.motionFx <= 0 ? -1 : free ? this.releaseAt : this.launched;
    const back = sw >= 0 ? this.t - sw : -1;
    if (back >= 0 && back < dt) this.switchFrame(dt, back, free, st);
    else {
      if (!free) {
        if (rope.freeEnd && !this.planned && this.ball === Ball.Toss) this.planFromRope();
        if (rope.freeEnd && !this.swung && this.ball === Ball.Swing) {
          this.captureFrom();
          this.swung = true;
        }
        this.placeBall(s);
      }
      if (free && !rope.freeEnd) this.fadeNow0 = this.now;
      rope.freeEnd = free;
      rope.updateV(dt, st, s);
    }
    if (free) {
      s[0] = rope.endX;
      s[1] = rope.endY;
      s[2] = rope.endZ;
      // Loch-Drehung klingt ab dem Loslassen ab (auf ±π gefaltet: keine drei Rückwärts-Drehungen); in Tricks mit
      // fester Loslass-Marke rechnet die Zeitleiste sie geschlossen (releasedTurn).
      if (!this.turnFixed) {
        if (back >= 0 && back < dt) {
          this.turnVal0 = wrapPi(this.ballTurn);
          this.turnNow0 = this.now - back;
        }
        this.ballTurn = this.turnVal0 * Math.exp(-(this.now - this.turnNow0) / TURN_TAU);
      }
    }
    this.writeBallRot(o);
    o.stringCount = rope.n;
    o.string.set(rope.out);
    // Gezeigt: Schnur (und das freie Ende) aus der Hand geschoben — geführt bleibt die Kugel exakt.
    this.guard.project(o.string, rope.n, free ? rope.n - 1 : rope.n - 2);
    // Sehnen auf die Hand legen (zwischen zwei freien Punkten lief die Schnur sonst quer durch Finger, rope.ts).
    this.guard.projectChords(o.string, rope.n, rope.n - 2, 0);
    if (free) {
      // Nach dem Loslassen blendet die Projektion über RELEASE_FADE ein (die Kugel verlässt den Becher ohne Sprung).
      const w = smooth((this.now - this.fadeNow0) / RELEASE_FADE);
      const e = (rope.n - 1) * 3;
      const S = o.string;
      S[e] = s[0] + (S[e] - s[0]) * w;
      S[e + 1] = s[1] + (S[e + 1] - s[1]) * w;
      S[e + 2] = s[2] + (S[e + 2] - s[2]) * w;
      s[0] = S[e];
      s[1] = S[e + 1];
      s[2] = S[e + 2];
    }
  }

  /**
   * Griff-Versatz (Ken: KEN_GRIP_ADD, Kugel: BALL_GRIP_ADD) in jointAdd, dann das Hand-Modell aus Pose + Versatz
   * (Schnur-Kollision mit der gezeigten Hand).
   */
  private applyGrip(dt: number): void {
    const o = this.out;
    const ja = o.jointAdd;
    const kg = this.kenGrip;
    const bg = this.ballGrip;
    const j = this.jj;
    const pj = this.poseJ;
    const target = POSE_JOINTS[o.pose] ?? POSE_JOINTS[POSE.ken];
    // Wie ViewHand: exponentiell zur Ziel-Pose (exakt für feste Ziele, framerate-unabhängig), bei motionFx 0 sofort.
    const k = this.motionFx <= 0 ? 1 : 1 - Math.exp(-dt / Math.max(0.01, o.poseTau));
    for (let i = 0; i < ja.length; i++) {
      pj[i] += (target[i] - pj[i]) * k;
      ja[i] += KEN_GRIP_ADD[i] * kg + BALL_GRIP_ADD[i] * bg;
      j[i] = pj[i] + ja[i];
    }
    this.guard.setJoints(j);
  }

  /** Festgehaltener Start (Tools) oder verpasster Wechsel: Wurf ab der aktuellen Pendel-Lage planen. */
  private planFromRope(): void {
    this.captureFrom();
    const id = this.trick;
    if (id !== 'none') this.planArm(id, this.from, this.tossAt, this.tossTo, this.tossAt + this.tossT, this.toss);
    this.tossFrom.set(this.from);
    this.planned = true;
  }

  /** Start = gezeigte Lage (Pendel-Ende aus der Hand geschoben), sonst spränge die Kugel beim Abwurf. */
  private captureFrom(): void {
    const b = this.endBuf;
    b[3] = this.rope.endX;
    b[4] = this.rope.endY;
    b[5] = this.rope.endZ;
    this.guard.project(b, 2, 1);
    this.from[0] = b[3];
    this.from[1] = b[4];
    this.from[2] = b[5];
  }

  /**
   * Frame mit Moduswechsel `back` s vor seinem Ende. Loslassen: bis dahin geführt (Lage zwischen der letzten
   * und dieser), dann frei. Abwurf: bis dahin Pendel, der Wurf beginnt EXAKT an der Pendel-Lage zur Marke.
   */
  private switchFrame(dt: number, back: number, free: boolean, st: V): void {
    const rope = this.rope;
    const s = this.out.sub;
    const k = 1 - back / dt;
    if (free) {
      const m = this.endBuf;
      const e = this.tmp2;
      const was = this.ball;
      this.ball = this.relMode;
      this.placeInto(e);
      this.ball = was;
      if (this.relMode === Ball.Caught) {
        // cupRide (Loslassen am Surf-Ende): geführte Lage am Frame-Ende, linear zur Marke (wie Plan 007).
        for (let i = 0; i < 3; i++) m[i] = s[i] + (e[i] - s[i]) * k;
        rope.updatePart(dt, k, st, m);
      } else {
        // Lage und Geschwindigkeit GENAU zur Marke aus der Zeitleiste (+ Wackel-Rest des gezeigten Kens).
        const rel = this.releaseAt;
        this.guidedAt(this.t, this.g1);
        this.guidedAt(rel, this.g0);
        for (let i = 0; i < 3; i++) m[i] = this.g0[i] + (e[i] - this.g1[i]);
        rope.updatePart(dt, k, st, m);
        // Airplane: die Schnur flatterte vom Ken-Wurf (Innenpunkte je Framerate anders) — zur Marke ruhig neu auslegen.
        if (this.relMode === Ball.Drop) rope.reset(rope.out[0], rope.out[1], rope.out[2], m[0], m[1], m[2]);
        this.guidedAt(rel - 0.002, this.g1);
        for (let i = 0; i < 3; i++) this.vel[i] = (this.g0[i] - this.g1[i]) / 0.002;
        rope.setEndVelocity(this.vel);
      }
      rope.freeEnd = true;
      this.fadeNow0 = this.now - back;
      if (back > 0) rope.updateRest(dt, k, st, st);
      return;
    }
    rope.updatePart(dt, k, st, s);
    if (this.ball === Ball.Arc) {
      this.captureFrom();
      this.fromTarget = null;
    } else if (this.ball === Ball.Swing) {
      this.captureFrom();
      this.swung = true;
    } else if (!this.planned) this.planFromRope();
    rope.freeEnd = false;
    this.placeBall(s);
    if (back > 0) rope.updateRest(dt, k, st, s);
  }

  private placeBall(s: Float32Array): void {
    this.placeInto(s);
  }

  /** Kugel-Mitte für Flug/Fang aus der aktuellen Ken-Lage. */
  private placeInto(s: Float32Array | Float64Array): void {
    const o = this.out;
    const b = this.ball;
    if (b === Ball.Held) {
      s[0] = BALL_HOLD[0];
      s[1] = BALL_HOLD[1];
      s[2] = BALL_HOLD[2];
      return;
    }
    if (b === Ball.Drop) {
      this.dropAt(this.t, s);
      return;
    }
    if (b === Ball.Settle) {
      this.settleAt(this.t, s);
      return;
    }
    if (b === Ball.Swing) {
      this.swingAt(this.t, s);
      return;
    }
    const tg = this.target;
    const end = this.tmp2;
    socketOf(o, tg, end);
    if (b === Ball.Caught || b === Ball.Free) {
      // Exakt im Becher/auf der Spitze (gleiche Transformation wie der Renderer).
      s[0] = end[0];
      s[1] = end[1];
      s[2] = end[2];
      return;
    }
    if (b === Ball.Toss) {
      const tau = this.t - this.tossAt;
      const u = clamp(tau / this.tossT, 0, 1);
      // Parabel im Arm-Raum (Schwerkraft unten im Bild, auch wenn die Hand dabei rollt) → Handgelenk-Raum.
      this.toss.at(tau, this.armB);
      const id = this.trick;
      if (id === 'none') this.rho = 0;
      else this.rollAt(id, this.t);
      this.armRot(this.armB, -1, s);
      // Rest-Versatz Ziel (Wackeln, Abbruch-Überblenden) klingt mit u³ ein, Start-Versatz (mitbewegter Becher) aus.
      const wIn = u * u * u;
      const f = this.fromTarget;
      const wOut = (1 - u) * (1 - u) * (1 - u);
      if (f) socketOf(o, f, this.tmp3);
      // Abwurf aus dem Pendel: Bogen um die Faust herum (die gerade Parabel lief durch den Zeigefinger).
      const A = VIEW_AXES;
      const bw = f ? 0 : Math.sin(Math.PI * u);
      for (let k = 0; k < 3; k++) {
        if (!this.toHand) s[k] += (end[k] - this.tossTo[k]) * wIn;
        if (f) s[k] += (this.tmp3[k] - this.tossFrom[k]) * wOut;
        s[k] += (A.right[k] * this.bulge + A.cam[k] * this.bulgeC) * bw;
      }
      return;
    }
    // Arc (cupRide): Gerade + Bogen, mitbewegt.
    const f = this.fromTarget;
    const from = this.from;
    if (f) socketOf(o, f, from);
    const u = this.fly;
    const e = smooth(u);
    const h = this.hop * arc(u);
    const A = VIEW_AXES;
    for (let k = 0; k < 3; k++) s[k] = from[k] + (end[k] - from[k]) * e + A.up[k] * h;
  }

  /**
   * Kugel-Lage: aufrecht (Loch oben) im Bild, um die Tiefenachse gedreht (ballTurn). Nur bei Änderung. Achse und
   * Winkel über turnQ, Bild-Ausrichtung einmal im Konstruktor — mit sieben Kommazahl-Argumenten boxte das im Spiel
   * nach 60 s noch 2.1 KiB/s (Review Phase 2). Gleiche Rechnung wie axisAngle/fromEulerXYZ (bitgleich).
   */
  private writeBallRot(o: PropOut): void {
    if (Math.abs(this.ballTurn) < 1e-4) this.ballTurn = 0;
    if (this.ballTurn === this.shownTurn) return;
    this.shownTurn = this.ballTurn;
    this.turnQ[3] = this.ballTurn;
    axisAngleQ(this.rA, this.turnQ);
    mul(this.rB, this.rA, this.aligned);
    toEulerXYZ(this.rB, o.subRot);
  }
}
